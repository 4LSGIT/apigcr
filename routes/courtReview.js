// routes/courtReview.js
//
// COURT REVIEW QUEUE — UI-facing endpoints over court_ai_log rows that landed
// outcome='queued' (the dry-run / needs-human pile produced by
// services/courtExecutor.js). Three resolutions: re-run as-is, adopt a docket
// onto a case then re-run, and dismiss. Auto-mounts via the server.js
// readdirSync loop. Normal jwtOrApiKey auth (req.auth.userId).
//
// NO schema changes. NO court_ingest_live flip. NO workflow triggering.
//
// ── OPENNESS RULE (no schema change) ────────────────────────────────────────
// A court_ai_log row is "open" (still needs review) iff:
//   outcome='queued'
//   AND no LATER row (id>) for the same message_id is a CLOSING row, where a
//       closing row is dry_run=0 AND outcome IN ('executed','none').
// The dry_run=0 requirement is load-bearing: a DRY re-run that "executes"
// intended-only writes a dry_run=1 row and must NOT close the queued row. This
// composes with executeCourtActions STEP 1 (the processed-marker), which also
// only fires on a prior dry_run=0 executed/none row, so a queued row is never
// blocked from re-run and a LIVE re-run that lands executed/none both
// short-circuits future double-runs AND closes the queued row here.
// The queue view additionally dedupes to the LATEST queued row per message_id
// (a dry re-run that stays queued writes a new queued row; we surface only the
// newest so the operator sees one card per message and re-running it replays
// the freshest payload).
//
// ── DISMISS CONVENTION (no schema change) ───────────────────────────────────
// Dismiss writes a NEW court_ai_log row: same message_id, outcome='none',
// dry_run=0, review_reason='dismissed:<note>' (sliced to 255), classification +
// case_number copied from the dismissed row, raw_response NULL. That row is a
// closing row under the openness rule, so the message drops out of the queue.
// (outcome='none' + dry_run=0 also trips executeCourtActions STEP 1, so a later
// LIVE re-run of a dismissed message short-circuits as already_processed —
// dismiss is intentionally terminal for live execution.)

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

const caseService          = require('../services/caseService');
const { resolveCase }      = require('../lib/courtResolve');
const courtRerun           = require('../services/courtRerun');

const DEFAULT_LIMIT = 200;
const MAX_LIMIT     = 1000;

// ─────────────────────────────────────────────────────────────────────────
// Openness SQL fragment. `cal` is the court_ai_log alias. Selects open queued
// rows deduped to the latest queued row per message_id. COLLATE not needed in
// the NOT EXISTS subqueries (court_ai_log vs court_ai_log, same collation).
// ─────────────────────────────────────────────────────────────────────────
const OPEN_QUEUE_WHERE = `
  cal.outcome = 'queued'
  AND NOT EXISTS (
    SELECT 1 FROM court_ai_log c2
     WHERE c2.message_id = cal.message_id
       AND c2.id > cal.id
       AND c2.dry_run = 0
       AND c2.outcome IN ('executed','none')
  )
  AND NOT EXISTS (
    SELECT 1 FROM court_ai_log c3
     WHERE c3.message_id = cal.message_id
       AND c3.id > cal.id
       AND c3.outcome = 'queued'
  )`;

// email_log.message_id is utf8mb4_general_ci, court_ai_log is utf8mb4_unicode_ci
// — force a collation on the cross-table compare. Correlated subquery (not a
// JOIN) so a duplicate email_log row can't fan out the queue.
const EMAIL_SUBJECT_SUBQ = `
  (SELECT el.subject FROM email_log el
    WHERE el.message_id = cal.message_id COLLATE utf8mb4_general_ci
    ORDER BY el.id DESC LIMIT 1)`;

/**
 * Map a reason-filter category to a SQL clause + params. Categories:
 *   case_not_found | citation_miss | extract_failed | model_flagged
 * Anything else (incl. '', 'all', undefined) → no filter.
 */
function reasonFilter(reason) {
  switch ((reason || '').trim()) {
    case 'case_not_found':
      return { clause: ` AND cal.review_reason = 'case_not_found'`, params: [] };
    case 'citation_miss':
      return { clause: ` AND cal.review_reason LIKE 'citation_miss:%'`, params: [] };
    case 'extract_failed':
      return { clause: ` AND cal.review_reason LIKE 'extract_failed:%'`, params: [] };
    case 'model_flagged':
      // Everything that isn't one of the deterministic categories above and
      // isn't null — i.e. the model's own free-text review_reason.
      return {
        clause: ` AND cal.review_reason IS NOT NULL
                  AND cal.review_reason <> 'case_not_found'
                  AND cal.review_reason NOT LIKE 'citation_miss:%'
                  AND cal.review_reason NOT LIKE 'extract_failed:%'`,
        params: [],
      };
    default:
      return { clause: '', params: [] };
  }
}

/** Load a single court_ai_log row by id (or null). */
async function loadRow(db, id) {
  const [rows] = await db.query(
    `SELECT id, created_at, message_id, ai_call_id, dry_run, classification,
            case_number, resolved_case_id, case_name, actions_json,
            citations_json, outcome, review_reason, raw_response
       FROM court_ai_log WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Server-side docket split — the parallel of scripts.js splitDocket(), kept
 * here because the queued row's case_number is whatever the email wrote (opaque
 * free-text) and adopt must derive both columns. Bankruptcy ##-#####-@@@ shape
 * is a client convenience, never a server gate; anything off-shape goes into
 * `short` with `full` null (we never persist a malformed "full").
 *   '25-47781-prh' → { short:'25-47781', full:'25-47781-prh' }
 *   '25-47781'     → { short:'25-47781', full:null }
 *   '(other)'      → { short:'(other)',  full:null }
 */
function splitDocket(raw) {
  const v = (raw == null ? '' : String(raw)).trim();
  if (!v) return { short: '', full: null };
  const m = /^(\d{2}-\d{5})(-[A-Za-z]+)$/.exec(v);
  if (m) return { short: m[1], full: v };
  if (/^\d{2}-\d{5}$/.test(v)) return { short: v, full: null };
  return { short: v, full: null };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/court-review/queue?reason=&limit=
//   → { rows:[{id, created_at, message_id, classification, case_number,
//             case_name, review_reason, dry_run, email_subject}],
//       groups:[{case_number, count, latest_subject}] }
// ─────────────────────────────────────────────────────────────────────────
router.get('/api/court-review/queue', jwtOrApiKey, async (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    const rf = reasonFilter(req.query.reason);

    const [rows] = await req.db.query(
      `SELECT cal.id, cal.created_at, cal.message_id, cal.classification,
              cal.case_number, cal.case_name, cal.review_reason, cal.dry_run,
              ${EMAIL_SUBJECT_SUBQ} AS email_subject
         FROM court_ai_log cal
        WHERE ${OPEN_QUEUE_WHERE}${rf.clause}
        ORDER BY cal.id DESC
        LIMIT ?`,
      [...rf.params, limit]
    );

    // Docket-grouped summary derived from the same open set. Null/empty
    // case_number rows group under the literal '(no docket)' bucket.
    const groupMap = new Map();
    for (const r of rows) {
      const key = (r.case_number && String(r.case_number).trim()) || '(no docket)';
      if (!groupMap.has(key)) {
        groupMap.set(key, { case_number: key, count: 0, latest_subject: r.email_subject || null });
      }
      groupMap.get(key).count += 1; // rows are id DESC, so the first seen IS the latest
    }
    const groups = [...groupMap.values()].sort((a, b) => b.count - a.count);

    res.json({ rows, groups });
  } catch (err) {
    console.error('[courtReview] /queue error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/court-review/item/:id
//   → full row + parsed payload + email subject/body/from + resolveCase hint
// ─────────────────────────────────────────────────────────────────────────
router.get('/api/court-review/item/:id', jwtOrApiKey, async (req, res) => {
  try {
    const row = await loadRow(req.db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'court_ai_log row not found' });

    const payload = courtRerun.parsePayload(row.raw_response);
    const email   = await courtRerun.fetchEmail(req.db, row.message_id);
    const resolved = await resolveCase(req.db, row.case_number);

    res.json({
      row: {
        id:            row.id,
        created_at:    row.created_at,
        message_id:    row.message_id,
        dry_run:       row.dry_run,
        classification: row.classification,
        case_number:   row.case_number,
        case_name:     row.case_name,
        review_reason: row.review_reason,
        outcome:       row.outcome,
        // actions_json / citations_json ARE json columns (auto-parsed); surface
        // them too for convenience, but the payload is the source of truth.
        actions:       row.actions_json || (payload && payload.actions) || [],
        citations:     row.citations_json || null,
      },
      payload,           // full court_extract payload (null for extract_failed)
      email: {           // re-fetched trusted text by message_id
        subject:    email.subject,
        body:       email.body,
        from_email: email.from_email,
      },
      resolve: {         // "now resolves" hint for the UI
        found:                resolved.found,
        case_id:              resolved.case_id,
        case_number:          resolved.case_number,
        case_number_full:     resolved.case_number_full,
        primary_contact_id:   resolved.primary_contact_id,
        primary_contact_name: resolved.primary_contact_name,
      },
    });
  } catch (err) {
    console.error('[courtReview] /item error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/court-review/rerun { court_ai_log_id }
//   Replay the stored payload (no AI) — or, for an extract_failed row, re-run
//   the full AI extract flow. Honors court_ingest_live for dry/live.
//   → { ok, status, ai, dry_run, new_court_ai_log_id, result }
// ─────────────────────────────────────────────────────────────────────────
router.post('/api/court-review/rerun', jwtOrApiKey, async (req, res) => {
  try {
    const id = Number((req.body || {}).court_ai_log_id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'court_ai_log_id required' });
    }
    const row = await loadRow(req.db, id);
    if (!row) return res.status(404).json({ ok: false, error: 'court_ai_log row not found' });

    const r = await courtRerun.rerunCalRow(req.db, row, { allowExtract: true });
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error('[courtReview] /rerun error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/court-review/reextract { court_ai_log_id }
//   FRESH AI PASS for a row whose MODEL OUTPUT was the problem (citation_miss,
//   event_title_mismatch, or model_flagged). IGNORES any stored payload and
//   re-runs the full court_extract flow over the re-fetched email — replaying
//   the stored actions cannot fix a bad extraction. Honors court_ingest_live for
//   dry/live exactly like /rerun. (case_not_found is NOT a re-extract case — the
//   model was fine, the docket just doesn't resolve; Adopt+replay is the path.)
//   → { ok, status:'reran', ai:true, dry_run, new_court_ai_log_id, result }
// ─────────────────────────────────────────────────────────────────────────
router.post('/api/court-review/reextract', jwtOrApiKey, async (req, res) => {
  try {
    const id = Number((req.body || {}).court_ai_log_id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'court_ai_log_id required' });
    }
    const row = await loadRow(req.db, id);
    if (!row) return res.status(404).json({ ok: false, error: 'court_ai_log row not found' });

    const r = await courtRerun.rerunCalRow(req.db, row, { forceExtract: true });
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error('[courtReview] /reextract error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/court-review/approve { court_ai_log_id }
//   HUMAN OVERRIDE for a MODEL-FLAGGED queued row. Replays the stored payload
//   exactly like /rerun, but with force:true — which strips ONLY the model's
//   soft needs_review flag (read solely at courtExecutor STEP 3). Every
//   structural safety stays in force: an approved row that fails the citation
//   gate, hits the 341 dup-guard, maps to an ambiguous (zero/many) update_event,
//   or violates CASE_FIELD_POLICY STILL queues/skips. Approve is "I, a human,
//   vouch for this reschedule" — NOT "execute no matter what".
//
//   allowExtract:false — approve is only meaningful for rows WITH a stored
//   payload. An extract_failed row has none, so rerunCalRow reports
//   status:'skipped' (reason extract_failed_no_payload) instead of spending a
//   fresh AI call. Honors court_ingest_live for dry/live exactly like /rerun.
//   → { ok, status, ai, dry_run, new_court_ai_log_id, result }
// ─────────────────────────────────────────────────────────────────────────
router.post('/api/court-review/approve', jwtOrApiKey, async (req, res) => {
  try {
    const id = Number((req.body || {}).court_ai_log_id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'court_ai_log_id required' });
    }
    const row = await loadRow(req.db, id);
    if (!row) return res.status(404).json({ ok: false, error: 'court_ai_log row not found' });

    const r = await courtRerun.rerunCalRow(req.db, row, { allowExtract: false, force: true });
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error('[courtReview] /approve error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/court-review/adopt-rerun { court_ai_log_id, case_id }
//   Write the queued row's docket onto the chosen case (ADDITIVE — mirrors
//   PATCH /api/cases/:id/docket guards), then re-run. 409 (no re-run) when the
//   target already holds a DIFFERENT non-empty docket, or another case holds
//   the docket.
//   → { ok, status:'reran', adopted:{...}, ... }   | 409 { ok:false, conflict }
// ─────────────────────────────────────────────────────────────────────────
router.post('/api/court-review/adopt-rerun', jwtOrApiKey, async (req, res) => {
  try {
    const body   = req.body || {};
    const id     = Number(body.court_ai_log_id);
    const caseId = body.case_id;
    if (!Number.isFinite(id) || !caseId) {
      return res.status(400).json({ ok: false, error: 'court_ai_log_id and case_id required' });
    }
    const row = await loadRow(req.db, id);
    if (!row) return res.status(404).json({ ok: false, error: 'court_ai_log row not found' });

    const docket = (row.case_number || '').trim();
    if (!docket) {
      return res.status(400).json({ ok: false, error: 'row has no docket to adopt' });
    }
    const { short, full } = splitDocket(docket);
    const caseNumber     = short || null;
    const caseNumberFull = full  || null;

    // Target must exist; fetch current docket for the same-vs-different guard.
    const [targetRows] = await req.db.query(
      `SELECT case_id, case_number, case_number_full, case_type
         FROM cases WHERE case_id = ? LIMIT 1`,
      [caseId]
    );
    if (!targetRows.length) {
      return res.status(404).json({ ok: false, error: 'Case not found' });
    }
    const target = targetRows[0];

    // Guard 2 — block an OVERWRITE of a non-empty value (additive-only adopt).
    const existingNum  = (target.case_number      || '').trim();
    const existingFull = (target.case_number_full || '').trim();
    const numConflict  = caseNumber     != null && existingNum  !== '' && existingNum  !== caseNumber;
    const fullConflict = caseNumberFull != null && existingFull !== '' && existingFull !== caseNumberFull;
    if (numConflict || fullConflict) {
      const which = numConflict ? 'case number' : 'full docket';
      const had   = numConflict ? existingNum : existingFull;
      return res.status(409).json({
        ok: false,
        error: `Case ${caseId} already has a ${which} (${had}). Replacing it is a ` +
               `case-detail-form operation, not an adopt.`,
        conflict: {
          kind: 'overwrite',
          case_id: target.case_id,
          case_number: target.case_number,
          case_number_full: target.case_number_full,
          case_type: target.case_type,
        },
      });
    }

    // Guard 1 — cross-case collision.
    const collision = await caseService.checkCaseNumberCollision(req.db, caseId, {
      case_number: caseNumber,
      case_number_full: caseNumberFull,
    });
    if (collision) {
      const label = collision.case_number_full || collision.case_number || collision.case_id;
      return res.status(409).json({
        ok: false,
        error: `That docket already belongs to case ${collision.case_id} (${label}).`,
        conflict: { kind: 'collision', ...collision },
      });
    }

    // Additive write — only the columns we actually have (non-null). Never null
    // out an existing value (consistent with the docket PATCH).
    const fields = {};
    if (caseNumber     != null) fields.case_number      = caseNumber;
    if (caseNumberFull != null) fields.case_number_full = caseNumberFull;
    if (Object.keys(fields).length) {
      await caseService.updateCase(req.db, caseId, fields);
    }

    // Re-run (stored payload; case now resolves). Honors court_ingest_live.
    const r = await courtRerun.rerunCalRow(req.db, row, { allowExtract: true });
    res.json({
      ok: true,
      adopted: { case_id: caseId, case_number: caseNumber, case_number_full: caseNumberFull },
      ...r,
    });
  } catch (err) {
    console.error('[courtReview] /adopt-rerun error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/court-review/dismiss { court_ai_log_id, note }
//   Close the row without action by writing a closing court_ai_log row
//   (see DISMISS CONVENTION in the header).
//   → { ok, court_ai_log_id }
// ─────────────────────────────────────────────────────────────────────────
router.post('/api/court-review/dismiss', jwtOrApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    const id   = Number(body.court_ai_log_id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'court_ai_log_id required' });
    }
    const row = await loadRow(req.db, id);
    if (!row) return res.status(404).json({ ok: false, error: 'court_ai_log row not found' });

    const note = (body.note == null ? '' : String(body.note)).trim();
    const reviewReason = ('dismissed:' + note).slice(0, 255);

    const [r] = await req.db.query(
      `INSERT INTO court_ai_log
         (message_id, ai_call_id, dry_run, classification, case_number,
          resolved_case_id, case_name, actions_json, citations_json,
          outcome, review_reason, raw_response)
       VALUES (?, NULL, 0, ?, ?, NULL, ?, NULL, NULL, 'none', ?, NULL)`,
      [row.message_id, row.classification, row.case_number, row.case_name, reviewReason]
    );

    res.json({ ok: true, court_ai_log_id: r.insertId });
  } catch (err) {
    console.error('[courtReview] /dismiss error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;