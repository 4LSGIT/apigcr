// services/courtRerun.js
//
// Re-run a single court_ai_log row through the court executor. Shared by
// routes/courtReview.js (manual re-run + adopt-rerun) and the
// court_review_retry internal_function (daily auto-retry sweep). Keeping the
// re-run mechanics in ONE place is the whole point — the two callers differ
// only in whether an extract_failed row may trigger a fresh AI call.
//
// ── raw_response IS A STRING ────────────────────────────────────────────────
// court_ai_log.raw_response is `mediumtext`, NOT a json column. The executor
// writes the payload with JSON.stringify, so mysql2 hands it back as a STRING
// here — parse it. (actions_json / citations_json ARE json columns and would
// auto-parse, but we re-run from raw_response, the full payload.)
//
// ── DRY-RUN FLAG ────────────────────────────────────────────────────────────
// Every re-run honors app_settings.court_ingest_live exactly like the ingest
// path: dryRun = !(getSetting==='1'). Absent/'0' ⇒ dryRun=true. We never flip
// the flag. (executeCourtActions additionally FORCES dry-run for -test- ids.)
//
// ── EXTRACT-FAILED ROWS ─────────────────────────────────────────────────────
// review_reason='extract_failed:*' rows have raw_response=NULL — there is no
// payload to replay. allowExtract=true (manual re-run) re-runs the FULL AI
// extract flow via the court_extract internal_function (which carries the v3
// subject-injection fix and reads court_ingest_live itself). allowExtract=false
// (the sweep) SKIPS such rows: auto-retrying a failed extraction would spend an
// AI call per row per day with no new information.

const { getSetting } = require('./settingsService');
const courtExecutor  = require('./courtExecutor');

/** true iff app_settings.court_ingest_live === '1' (fail-safe to false). */
async function isLive(db) {
  try {
    return String((await getSetting(db, 'court_ingest_live')) ?? '').trim() === '1';
  } catch (_) {
    return false;
  }
}

/**
 * Re-fetch trusted subject/body/from_email from email_log by message_id (latest
 * row). COLLATE: email_log.message_id is utf8mb4_general_ci while
 * court_ai_log.message_id is utf8mb4_unicode_ci — force a collation on the
 * cross-column compare or MySQL errors ER_CANT_AGGREGATE_2COLLATIONS.
 */
async function fetchEmail(db, messageId) {
  const blank = { subject: '', body: '', from_email: '' };
  if (!messageId) return blank;
  const [rows] = await db.query(
    `SELECT subject, body, from_email FROM email_log
      WHERE message_id = ? COLLATE utf8mb4_general_ci
      ORDER BY id DESC LIMIT 1`,
    [messageId]
  );
  if (!rows.length) return blank;
  return {
    subject:    rows[0].subject    || '',
    body:       rows[0].body       || '',
    from_email: rows[0].from_email || '',
  };
}

/** raw_response (mediumtext string) → payload object, or null. */
function parsePayload(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw; // defensive — column is text, shouldn't happen
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/**
 * Re-run one court_ai_log row.
 *
 * @param {object} db
 * @param {object} calRow  { id, message_id, classification, case_number, raw_response }
 * @param {object} [opts]
 * @param {boolean} [opts.allowExtract=true]  when raw_response is null, run the
 *        AI extract flow (true) or skip the row (false, used by the sweep).
 * @param {boolean} [opts.force=false]  human "approve & run": in the stored-
 *        payload branch ONLY, strip the model's soft needs_review flag so the
 *        executor's STEP 3 short-circuit no longer fires. The executor's HARD
 *        gates (STEP 4 citation check, 341 create_appointment dup-guard,
 *        update_event single-match, CASE_FIELD_POLICY) all run AFTER STEP 3 and
 *        are untouched — an approved row that citation-misses or maps to an
 *        ambiguous event STILL queues. force overrides the model's holistic
 *        "a human should look" judgment, NOT the structural safeties. No effect
 *        on the extract_failed branch (no payload to force).
 * @returns {Promise<{
 *   status:'reran'|'skipped',
 *   reason?:string,
 *   ai:boolean,
 *   dry_run?:boolean,
 *   new_court_ai_log_id?:(number|null),
 *   result?:object            // executor return (or a normalized extract result)
 * }>}
 */
async function rerunCalRow(db, calRow, { allowExtract = true, force = false } = {}) {
  const dryRun  = !(await isLive(db));
  const payload = parsePayload(calRow.raw_response);
  const { subject, body, from_email } = await fetchEmail(db, calRow.message_id);

  // ── Stored payload present → replay it, NO AI call. ──────────────────────
  if (payload) {
    payload.message_id = calRow.message_id; // trust our canonical id
    // ── APPROVE & RUN (force) ──────────────────────────────────────────────
    // Strip ONLY the model's soft needs_review flag — read solely at STEP 3 of
    // executeCourtActions. The executor's structural safeties (STEP 4 citation
    // gate, the 341 create_appointment dup-guard, update_event single-match,
    // CASE_FIELD_POLICY) run AFTER STEP 3 and are NOT affected here, so an
    // approved row that citation-misses or is ambiguous STILL queues. Approve
    // overrides the holistic "needs a human" judgment, not the hard gates.
    if (force && payload && typeof payload === 'object') delete payload.needs_review;
    const result = await courtExecutor.executeCourtActions(db, {
      payload, subject, body, dryRun,
    });
    return {
      status: 'reran',
      ai: false,
      dry_run: dryRun,
      new_court_ai_log_id: result.court_ai_log_id,
      result,
    };
  }

  // ── No payload (extract_failed). ─────────────────────────────────────────
  if (!allowExtract) {
    return { status: 'skipped', reason: 'extract_failed_no_payload', ai: false };
  }

  // Re-run the full AI extract flow. court_extract reads court_ingest_live
  // itself, applies the v3 subject-injection fix, and writes its own
  // court_ai_log row.
  const internalFunctions = require('../lib/internal_functions');
  const fnRes = await internalFunctions.court_extract(
    { message_id: calRow.message_id, subject, from_email, body },
    db
  );
  const out = (fnRes && fnRes.output) || {};
  return {
    status: 'reran',
    ai: true,
    dry_run: out.dry_run,
    new_court_ai_log_id: out.court_ai_log_id || null,
    result: {
      outcome:         out.outcome || null,
      court_ai_log_id: out.court_ai_log_id || null,
      applied:         [],
      skipped:         [],
      review_reason:   out.review_reason || null,
      dry_run:         out.dry_run,
      extract_failed:  out.skipped === 'extract_failed' || out.skipped === 'error' || false,
    },
  };
}

module.exports = { rerunCalRow, isLive, fetchEmail, parsePayload };