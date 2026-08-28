// services/portalCaseService.js
//
/**
 * portalCaseService.js — Client Portal Slice 2 + E1: read-only case status.
 *
 * Backs routes/portal.cases.js. Owns:
 *   - listCases   — the contact's Primary/Secondary cases, list-shaped.
 *   - getCaseView — one case with the client-facing pipeline timeline plus
 *                   the configurable cards array (E1 card engine);
 *                   returns null when out of scope (route → uniform 404).
 *
 * E1 (card engine): the payload gains `cards` from
 * lib/portalCardEngine.renderCards — the configurable replacement for the
 * previously hardcoded payment + 341 cards. The 341 card's GATES (BK-only,
 * past-date suppression) now live SOLELY in the engine's conditions (the
 * seeded meeting341 row — ref/2026-08-07_portal_cards_e1.sql translates the
 * shipped gates exactly); this service no longer applies them. Double-gating
 * hides bugs — the engine decides whether the 341 card appears, and
 * formatMeeting341 below is a pure FORMATTER included when (and only when)
 * that card passed. Parity with pre-E1 output is pinned by
 * tests/portalCardEngine.test.js.
 *
 * HARD INVARIANTS (portal contract — violating any is a defect):
 *   - Hidden stages never leave the server. ALL client_visible filtering
 *     happens here; the payload carries no trace of hidden stages.
 *   - Client vocabulary only: client_label, never internal_label. Labels
 *     come from the resolved template at read time — staff edit them live
 *     in the admin UI, nothing is hardcoded.
 *   - Projection whitelists only. Never SELECT cases.* / contacts.*.
 *     The payload contains EXACTLY the specced fields — in particular NO
 *     case_status (internal vocabulary), NO internal_label, NO log-row
 *     note / entered_by / source / status_label, no stage_keys or ids,
 *     no internal user ids.
 *   - Docket values (case_number, case_number_full) are OPAQUE free-text:
 *     display-only passthrough — never parsed, validated, or split.
 *   - Out-of-scope is indistinguishable from nonexistent: getCaseView
 *     returns null for both (manage.js philosophy; route emits one 404).
 *
 * Visibility rules (ratified 2026-08-06 — fixed, not relaxable here):
 *   - Portal shows ONLY stages with client_visible = 1, labeled by
 *     client_label.
 *   - History rows whose stage is client_visible = 0 OR absent from the
 *     resolved template (e.g. branched-from-intake rows): skipped silently.
 *   - "Current" is the LATEST history row whose stage is visible in the
 *     resolved template; if none qualifies, the timeline has NO current
 *     marker — never a hidden-stage fallback.
 *
 * Pipeline source of truth: services/pipelineService.getPipeline — reused
 * per case (clients have 1–3 cases; N is small, one source of truth beats a
 * parallel query). Its `upcoming` is computed from the case's REAL latest
 * log row (hidden or not); the portal filters that list to visible stages
 * rather than recomputing from the visible current — this keeps upcoming
 * anchored to the case's true position without ever naming the hidden stage
 * (skipped stages stay skipped; no phantom "still coming" entries).
 *
 * Dates: case_stage_log.entered_at is real UTC (DEFAULT CURRENT_TIMESTAMP;
 * see services/timezoneService.js column reference — NOW() columns are UTC).
 * The portal emits firm-local DATE-ONLY strings (YYYY-MM-DD, FIRM_TIMEZONE)
 * — no times, no client-side timezone math.
 *
 * Conventions: every function takes the mysql2 pool (req.db) first; errors
 * carry `.status` where meaningful (pipelineService pattern).
 */

'use strict';

const pipelineService = require('./pipelineService');
const portalCardEngine = require('../lib/portalCardEngine');
const { utcToLocal } = require('./timezoneService');

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** entered_at (real-UTC Date/string from mysql2) → firm-local 'YYYY-MM-DD'. */
function toLocalIsoDate(enteredAt) {
  if (!enteredAt) return null;
  const local = utcToLocal(enteredAt);
  return local && local.isValid ? local.toISODate() : null;
}

/**
 * Client-facing title. S2-locked vocabulary:
 *   chapter non-empty → "Chapter {chapter} {case_type || 'Bankruptcy'}"
 *   else case_type; final fallback 'Your Case'.
 * (Live data 2026-08-06: chapter is only ever set alongside
 * case_type='Bankruptcy', so the concatenation reads "Chapter 7 Bankruptcy".)
 */
function deriveTitle(caseRow) {
  const chapter = String(caseRow.case_chapter == null ? '' : caseRow.case_chapter).trim();
  const type = String(caseRow.case_type == null ? '' : caseRow.case_type).trim();
  if (chapter) return `Chapter ${chapter} ${type || 'Bankruptcy'}`;
  if (type) return type;
  return 'Your Case';
}

/** Opaque docket passthrough — full form preferred, short fallback, else null.
 *  NEVER parsed / validated / split (case-number principle). */
function deriveDocket(caseRow) {
  return caseRow.case_number_full || caseRow.case_number || null;
}

/**
 * S2.1 (D8), reshaped by E1: the client-facing 341 block — now a pure
 * FORMATTER. The former gates (BK-exclusivity, past-date suppression) moved
 * VERBATIM onto the meeting341 card's engine conditions
 * (ref/2026-08-07_portal_cards_e1.sql — the single place they live;
 * double-gating hides bugs, per the E1 ruling). getCaseView calls this only
 * after the engine has passed the card; parity with the pre-E1 gated output
 * is pinned by tests/portalCardEngine.test.js.
 *
 * case_341_current is FIRM-LOCAL WALL TIME (apptService writes appt_date —
 * the local column — into it; live values sit at 8:30a–1:00p). mysql2
 * (timezone:'Z') hands it back as a fake-UTC Date whose naive components
 * ARE the firm-local wall clock — so this reads the components with NO
 * timezone conversion (formatLocal semantics), unlike the S2 timeline
 * dates, which are real UTC. The engine's date_future operator reads the
 * column the SAME naive way — the two stay in lockstep by design.
 *
 * Manager ruling 2026-08-06 (still binding):
 *   - NO status wording. Live `341_status` reads 'Continued' on 100% of
 *     rows (NOT-NULL enum, no default → first member is the de-facto unset
 *     state), so any mapping from it would put a false statement on nearly
 *     every card. When the write path becomes trustworthy, a server-side
 *     mapping drops in here with zero client change.
 *   - `link` (Fred ruling: link in): case_341_link passes through only when
 *     it is a real http(s) URL — staff-entered varchar; the scheme guard
 *     keeps '' and non-URL junk out of an href. The link only exists inside
 *     the card, so it is suppressed with the card.
 *
 * Formatting-integrity nulls remain (no 341 value / unparseable value →
 * null): those are "nothing safe to format", not gates. getCaseView treats a
 * null here on a PASSED card as a defect signal and drops the card
 * (fail-closed) rather than shipping an empty coded card.
 *
 * @returns {{ date:string, time:string, link:string|null } | null}
 *          date 'YYYY-MM-DD', time 'HH:mm' — both firm-local wall values.
 */
function formatMeeting341(caseRow) {
  if (!caseRow.case_341_current) return null;

  const d = caseRow.case_341_current instanceof Date
    ? caseRow.case_341_current
    : new Date(caseRow.case_341_current);
  if (isNaN(d.getTime())) return null;

  const naive = d.toISOString().slice(0, 19);   // firm-local wall clock
  const date = naive.slice(0, 10);
  const time = naive.slice(11, 16);

  const rawLink = String(caseRow.case_341_link == null ? '' : caseRow.case_341_link).trim();
  const link = /^https?:\/\//i.test(rawLink) ? rawLink : null;

  return { date, time, link };
}

/** True only for an explicit visible flag (tinyint 1 / boolean true). */
function isVisible(stage) {
  return stage.client_visible === 1 || stage.client_visible === true;
}

/**
 * THE shared visibility/label/current helper — the single place the ratified
 * rules are applied. Used by both listCases and getCaseView.
 *
 * @param {object} pipeline getPipeline payload
 *                          ({ template, current, history, upcoming, stages })
 * @returns {{ done: {label:string, date:string|null}[],
 *             current: {label:string, since:string|null} | null,
 *             upcoming: {label:string}[] }}
 */
function buildClientTimeline(pipeline) {
  const stages = Array.isArray(pipeline.stages) ? pipeline.stages : [];

  // Visible template stages, keyed by stage_key (history↔template matching
  // is by stage_key by design — history survives template edits).
  const visibleByKey = new Map();
  for (const s of stages) {
    if (isVisible(s)) visibleByKey.set(s.stage_key, s);
  }

  // History → visible rows only (client_visible=0 and absent-from-template
  // rows skip silently). getPipeline history is already ascending.
  const visibleHistory = [];
  for (const h of Array.isArray(pipeline.history) ? pipeline.history : []) {
    const stage = visibleByKey.get(h.stage_key);
    if (!stage) continue;
    visibleHistory.push({
      label: stage.client_label,
      date: toLocalIsoDate(h.entered_at),
    });
  }

  // Ratified current rule: latest VISIBLE history row, else no marker.
  let current = null;
  let done = visibleHistory;
  if (visibleHistory.length) {
    const latest = visibleHistory[visibleHistory.length - 1];
    current = { label: latest.label, since: latest.date };
    done = visibleHistory.slice(0, -1);
  }

  // Upcoming: getPipeline's real-position upcoming, filtered to visible.
  const upcoming = [];
  for (const s of Array.isArray(pipeline.upcoming) ? pipeline.upcoming : []) {
    if (visibleByKey.has(s.stage_key)) upcoming.push({ label: s.client_label });
  }

  return { done, current, upcoming };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCOPE
// ─────────────────────────────────────────────────────────────────────────────

// Portal scope = the contact's cases related as Primary or Secondary.
// (Other/Bystander are staff-side relations — excluded.) The join is by
// value equality — case_relate_case_id is varchar(8) vs cases.case_id
// varchar(20); that's historical, the join works, leave it alone.
// Projection whitelist ONLY — cases carries internal columns (case_status
// among them) that must never ride along.
const SCOPE_COLUMNS =
  `c.case_id, c.case_chapter, c.case_type, c.case_number, c.case_number_full`;

// getCaseView additionally reads the 341 columns (S2.1). List rows never
// need them — the list payload has no meeting341.
const VIEW_COLUMNS =
  `${SCOPE_COLUMNS}, c.case_341_current, c.case_341_link`;

/** Fetch the contact's in-scope case rows (whitelisted columns), newest
 *  case_open_date first (NULL dates last), deterministic tiebreak. */
async function _scopedCaseRows(db, contactId) {
  const [rows] = await db.query(
    `SELECT ${SCOPE_COLUMNS}, c.case_open_date
       FROM case_relate cr
       JOIN cases c ON c.case_id = cr.case_relate_case_id
      WHERE cr.case_relate_client_id = ?
        AND cr.case_relate_type IN ('Primary','Secondary')
      ORDER BY (c.case_open_date IS NULL), c.case_open_date DESC, c.case_id ASC`,
    [contactId]
  );
  // Dedupe by case_id in JS (a contact holding both Primary AND Secondary on
  // one case would otherwise duplicate; none exist today — cheap insurance
  // that avoids DISTINCT/GROUP BY sql_mode edge cases). case_open_date is
  // ORDER BY fuel only — it never enters the payload.
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.case_id)) continue;
    seen.add(r.case_id);
    out.push(r);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// listCases
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The contact's portal case list.
 *
 * Closed cases stay visible (ratified) — no status filtering.
 *
 * @param {object} db        mysql2 pool
 * @param {number} contactId authenticated portal contact
 * @returns {Promise<{case_id:string, title:string, docket:string|null,
 *                    current_stage_label:string|null}[]>}
 */
async function listCases(db, contactId) {
  const rows = await _scopedCaseRows(db, contactId);

  const out = [];
  for (const row of rows) {
    let currentLabel = null;
    try {
      const pipeline = await pipelineService.getPipeline(db, row.case_id);
      const timeline = buildClientTimeline(pipeline);
      currentLabel = timeline.current ? timeline.current.label : null;
    } catch (err) {
      // 404 = case vanished between the scope read and the pipeline read
      // (delete race) — degrade the label, keep the list alive. Anything
      // else is a real error and must surface.
      if (err.status !== 404) throw err;
    }
    out.push({
      case_id: row.case_id,
      title: deriveTitle(row),
      docket: deriveDocket(row),
      current_stage_label: currentLabel,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// getCaseView
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One case, portal-shaped. Scope check FIRST; out-of-scope and nonexistent
 * are both null — the route turns null into the uniform 404 (no oracle).
 *
 * E1: `cards` = portalCardEngine.renderCards for the case-view placements
 * ('case_top' above the timeline, 'case' below — the client splits by each
 * card's placement). `meeting341` is included when — and ONLY when — the
 * engine passed the coded meeting341 card; its gates live in that card's
 * conditions, not here. A card that passed but yields nothing formattable
 * (formatMeeting341 → null; a datetime column makes this near-impossible) is
 * dropped fail-closed rather than shipped empty.
 *
 * @param {object} db        mysql2 pool
 * @param {number} contactId authenticated portal contact
 * @param {string} caseId    requested cases.case_id
 * @returns {Promise<{case_id:string, title:string, docket:string|null,
 *   meeting341: { date:string, time:string, link:string|null } | null,
 *   timeline: { done: {label:string, date:string|null}[],
 *               current: {label:string, since:string|null} | null,
 *               upcoming: {label:string}[] },
 *   cards: Array<{key:string, title:string, body:string|null,
 *                 link:{url:string,label:string}|null,
 *                 coded_key:string|null, placement:string}>} | null>}
 */
async function getCaseView(db, contactId, caseId) {
  const [[row]] = await db.query(
    `SELECT ${VIEW_COLUMNS}
       FROM case_relate cr
       JOIN cases c ON c.case_id = cr.case_relate_case_id
      WHERE cr.case_relate_client_id = ?
        AND cr.case_relate_case_id = ?
        AND cr.case_relate_type IN ('Primary','Secondary')
      LIMIT 1`,
    [contactId, caseId]
  );
  if (!row) return null;

  let pipeline;
  try {
    // row.case_id (canonical casing from cases) — utf8mb4_general_ci means
    // the scope match is case-insensitive; downstream uses the DB's value.
    pipeline = await pipelineService.getPipeline(db, row.case_id);
  } catch (err) {
    if (err.status === 404) return null; // delete race → same uniform 404
    throw err;
  }

  // E1 card engine — fail-closed internally; never throws, never 500s the
  // view. Refs/params inside are pinned to (contactId, row.case_id).
  const cards = await portalCardEngine.renderCards(db, {
    caseId: row.case_id,
    contactId,
    placement: ['case_top', 'case'],
  });

  // 341 data rides ONLY behind the engine-passed coded card (dispatch is by
  // coded_key — the code binding; card_key is staff vocabulary).
  let meeting341 = null;
  const idx341 = cards.findIndex(c => c.coded_key === 'meeting341');
  if (idx341 !== -1) {
    meeting341 = formatMeeting341(row);
    if (!meeting341) {
      // Passed card with nothing formattable = misconfig/defect — drop the
      // card (fail-closed) instead of rendering an empty shell.
      console.warn('[portalCaseService] meeting341 card passed but formatter returned null — card dropped');
      cards.splice(idx341, 1);
    }
  }

  return {
    case_id: row.case_id,
    title: deriveTitle(row),
    docket: deriveDocket(row),
    meeting341,
    timeline: buildClientTimeline(pipeline),
    cards,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  listCases,
  getCaseView,
  // Exposed for tests (repo pattern: logService cross-exports its helpers).
  // E1: _buildMeeting341 → _formatMeeting341 (gates moved to the card
  // engine's conditions; this is the pure formatter).
  _buildClientTimeline: buildClientTimeline,
  _formatMeeting341: formatMeeting341,
  _deriveTitle: deriveTitle,
  _deriveDocket: deriveDocket,
};