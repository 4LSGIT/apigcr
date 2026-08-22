// services/phoneIngestExecutionsService.js
//
/**
 * Phone Ingest — Executions Read Service
 * services/phoneIngestExecutionsService.js
 *
 * Port of services/emailIngestExecutionsService.js against
 * `phone_ingest_executions`.
 *
 * READ-ONLY. The pipeline writes executions via
 * phoneIngestService._writeExecution (wired by the NEXT worker); this service
 * only reads them for the management UI.
 *
 *   list(db, opts)     — paginated + filtered list, returns { rows, total }
 *   getById(db, id)    — single row + a `linked` block hydrating the referenced
 *                        phone_event_log / log rows and expanding the bare-ID
 *                        arrays in metadata (matched_rules, suppressed_by) to
 *                        include rule/suppression names.
 *
 * Divergences from the email executions service (documented in worker report):
 *   * No `sources` table on the phone side, so there is no source_id /
 *     source_name join, no `source` filter, and no message_id / remote_ip
 *     columns.
 *   * The forensic catch-all is `phone_event_log` (referenced by the bare
 *     `event_log_id` column — NOT a FK, matching email's email_log_id), not
 *     `email_log` (`email_log_id`). linked hydrates phone_event_log + log.
 *   * Status set: logged | suppressed | error. (Phone never auto-skips on
 *     firm-to-firm — it's a matchable flag fed to the suppression layer, so it
 *     surfaces as `suppressed` or `logged`, never a distinct status.)
 *   * matched_rules hydrate from `phone_ingest_rules`; suppressed_by hydrate
 *     from `phone_log_suppressions` (the Layer-2 table, same as email's
 *     suppressed_by → email_ingest_log_suppressions).
 *
 * has_match filter keys off `metadata->>'$.matched_rules' IS NOT NULL`, per the
 * verified metadata shape: { matched_rules:[ids], suppressed_by:[ids],
 * action_outcomes:[...] } (identical to the email shape).
 *
 * raw_input is included in the list response by default (the pipeline is
 * responsible for any truncation before write, mirroring email's
 * RAW_INPUT_LIMIT) — but see `slim` below.
 *
 * ── T2 additions (mirror of the email service) ──────────────────────────
 *
 * opts.slim — drop raw_input from the LIST projection. Phone raw_input
 * averages ~2.9 KB/row against email's 16.5 KB, so the saving is smaller
 * here, but the Activity page polls both endpoints on the same 60s timer
 * and the two services must stay contract-identical. getById() unaffected.
 *
 * opts.has_failure — rows whose Layer-3 rule actions failed. NOT derivable
 * from `status`: _buildMetadata records per-action results in
 * metadata.action_outcomes and never reflects them in the status column.
 * The canonical proof case lives in THIS table — execution #4529 reads
 * status='suppressed' while carrying
 * action_outcomes[0].error = "internal_function delivery failed:
 * certificate has expired". Backed by the generated column + index from
 * ref/2026-08-19_ingest_action_failure_count.sql; without that migration
 * this filter and the action_failure_count projection both throw
 * ER_BAD_FIELD_ERROR.
 *
 * action_failure_count is ALWAYS in the projection (slim and full).
 *
 * ── T8 additions (rule-scoped filtering + name hydration) ───────────────
 *
 * Mirror of the email service — read that header for the full rationale.
 * Phone-specific divergences:
 *   * rule ids resolve against phone_ingest_rules, action ids against
 *     phone_ingest_rule_actions, suppression ids against
 *     phone_log_suppressions (the Layer-2 table).
 *   * VALID_ACTION_STATUSES OMITS 'skipped_test_envelope'. That value only
 *     exists on the email side: phoneIngestRuleService._dispatchAction is
 *     otherwise line-identical but deliberately carries no TEST-ENVELOPE
 *     GATE, because phone events have no "-test-" replay path. Adding it
 *     here would put a permanently-empty option in the phone UI.
 */

// ── STATUS VOCABULARY CHECKLIST (T6/F-6) ────────────────────────────────
// The phone execution status set is HAND-SYNCED across five places. Adding
// a status to the DB ENUM without chasing ALL of these recreates exactly
// the blindness T2/T3 removed. Checklist:
//   1. DB ENUM phone_ingest_executions.status (ALTER TABLE;
//      ref/database.sql is a generated snapshot — do not hand-edit it)
//   2. THIS set (VALID_STATUSES below) — see MTH-2 note
//   3. phoneIngestMetaService.EXECUTION_STATUSES — the /meta dropdown
//   4. public/automation/phoneIngest.html STATUS_META — chip colors
//      (unknown falls to gray: cosmetic only)
//   5. public/automation/activity.html PHONE_FAILURE_STATUSES — ONLY if
//      the new status is a failure class; miss it and Activity's failures
//      mode is blind to it
// Durable fix (separate slice): derive 4/5 from /meta. Not built here.
//
// MTH-2 added 'duplicate' (true provider redelivery — phoneIngestService step
// 1b). It MUST be listed here: list() silently DROPS an unrecognized status
// filter rather than rejecting it, so without this entry `?status=duplicate`
// would quietly return every row instead of the duplicates.
const VALID_STATUSES = new Set([
  'logged', 'suppressed', 'error', 'duplicate',
]);

// ── ACTION-OUTCOME STATUS VOCABULARY ────────────────────────────────────
// Written by phoneIngestRuleService._dispatchAction. Not a DB enum — a plain
// JSON string — so this set is the only defense against a typo'd filter
// value. list() DROPS an unrecognized value (same convention as `status`);
// the ROUTE rejects one with 400 so a caller finds out.
//
//   success — dispatcher returned success
//   failed  — dispatcher returned failure, or the transform / evaluator
//             threw (synthetic outcomes carrying action_type 'transform' /
//             'rule_evaluation' and a null rule_action_id)
//
// NO 'skipped_test_envelope' here — see the header note.
const VALID_ACTION_STATUSES = new Set([
  'success', 'failed',
]);

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE     = 200;

// Shared head of both projections. action_failure_count rides along in both:
// it is an indexed generated column, so it costs nothing and it is the only
// way a caller can tell a green-status row apart from a green-status row
// whose action blew up (#4529 is exactly that row).
const _EXEC_COLS_BASE =
  `e.id, e.event_log_id, e.status, e.log_id, e.error, e.metadata,
   e.created_at, e.action_failure_count`;

// Full projection — adds the payload. Used by getById() and by list() unless
// the caller asks for slim.
const _EXEC_COLS = `${_EXEC_COLS_BASE}, e.raw_input`;


// ─────────────────────────────────────────────────────────────
// LIST
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} db
 * @param {object} [opts]
 * @param {number} [opts.page=1]
 * @param {number} [opts.page_size=50]   capped at 200
 * @param {string} [opts.status]         one enum value
 * @param {string} [opts.since]          ISO datetime, inclusive lower bound
 * @param {string} [opts.until]          ISO datetime, inclusive upper bound
 * @param {boolean}[opts.has_match]      true → rows WITH matched_rules;
 *                                       false → rows WITHOUT; omit → no filter
 * @param {boolean}[opts.has_failure]    true → only rows with a failed action
 *                                       outcome (see header — NOT the same as
 *                                       a failure `status`)
 * @param {number} [opts.rule_id]        only rows where this rule matched
 * @param {string} [opts.action_status]  only rows with an action outcome of
 *                                       this status; scoped to opts.rule_id
 *                                       when that is also set
 * @param {boolean}[opts.slim]           true → omit raw_input from the rows
 * @returns {Promise<{rows:Array, total:number, page:number, page_size:number,
 *                    names:{rules:object, rule_actions:object,
 *                           suppressions:object}}>}
 */
async function list(db, opts = {}) {
  let page = parseInt(opts.page, 10);
  if (!Number.isInteger(page) || page < 1) page = 1;

  let pageSize = parseInt(opts.page_size, 10);
  if (!Number.isInteger(pageSize) || pageSize < 1) pageSize = DEFAULT_PAGE_SIZE;
  if (pageSize > MAX_PAGE_SIZE) pageSize = MAX_PAGE_SIZE;

  const where = [];
  const params = [];

  if (opts.status && VALID_STATUSES.has(opts.status)) {
    where.push('e.status = ?');
    params.push(opts.status);
  }
  if (opts.since) {
    where.push('e.created_at >= ?');
    params.push(opts.since);
  }
  if (opts.until) {
    where.push('e.created_at <= ?');
    params.push(opts.until);
  }
  // Tri-state (T8). false = "no rule matched" — the branch the route's
  // T6/F-4 comment reserved for whenever a caller needed it.
  if (opts.has_match === true) {
    where.push(`e.metadata->>'$.matched_rules' IS NOT NULL`);
  } else if (opts.has_match === false) {
    where.push(`e.metadata->>'$.matched_rules' IS NULL`);
  }
  // Indexed generated column (idx_action_failures) — a range read, not a
  // full JSON scan.
  if (opts.has_failure === true) {
    where.push('e.action_failure_count > 0');
  }

  // ── T8: rule-scoped filters ────────────────────────────────────────────
  //
  // `ruleId` MUST be pushed as a JS NUMBER, never a string. matched_rules
  // holds JSON *numbers*; mysql2 renders a numeric param as a bare literal
  // (21) but a string param as a quoted one ('21'), and '21' MEMBER OF (…)
  // compares string-to-number and matches ZERO rows while looking like it
  // worked — the same silent-drop family as the `status` note above.
  // Number() + Number.isInteger() below is what guarantees that; do not
  // relax it to a truthiness check.
  //
  // `? MEMBER OF (col->'$.path')` is deliberately the exact shape MySQL
  // documents as multi-valued-index-eligible, so the optional index in
  // ref/2026-08-22_ingest_matched_rules_index.sql is picked up with no code
  // change. A CAST(? AS UNSIGNED) wrapper would work too but is not needed
  // once the param is a number, and wrapping the probe is the kind of thing
  // that quietly costs you the index. Leave it bare.
  const ruleId = Number(opts.rule_id);
  const hasRuleId = Number.isInteger(ruleId) && ruleId > 0;
  if (hasRuleId) {
    where.push(`? MEMBER OF (e.metadata->'$.matched_rules')`);
    params.push(ruleId);
  }
  if (opts.action_status && VALID_ACTION_STATUSES.has(opts.action_status)) {
    if (hasRuleId) {
      // Partial object containment: an array target contains a non-array
      // candidate iff some element contains it, and object containment is
      // per-key. So this reads "some outcome FOR RULE N has status S" —
      // which is the whole point. The unscoped form below would instead
      // answer "some outcome on a row where rule N also matched", i.e. it
      // would blame rule N for another rule's failure.
      where.push(
        `JSON_CONTAINS(e.metadata->'$.action_outcomes',
                       JSON_OBJECT('rule_id', ?, 'status', ?))`
      );
      params.push(ruleId, opts.action_status);
    } else {
      where.push(
        `JSON_CONTAINS(e.metadata->'$.action_outcomes', JSON_OBJECT('status', ?))`
      );
      params.push(opts.action_status);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const cols     = opts.slim === true ? _EXEC_COLS_BASE : _EXEC_COLS;

  // total (separate count query).
  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total
       FROM phone_ingest_executions e
       ${whereSql}`,
    params
  );

  const offset = (page - 1) * pageSize;
  const [rows] = await db.query(
    `SELECT ${cols}
       FROM phone_ingest_executions e
       ${whereSql}
       ORDER BY e.id DESC
       LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  const names = await _hydrateNames(db, rows);

  return { rows, total: Number(total), page, page_size: pageSize, names };
}


// ─────────────────────────────────────────────────────────────
// SINGLE + LINKED HYDRATION
// ─────────────────────────────────────────────────────────────

/**
 * Coerce a metadata id-array (e.g. [1, 2]) into a clean number[] for an
 * IN (...) lookup. Tolerates nulls / non-arrays.
 */
function _idArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map(Number).filter(n => Number.isInteger(n));
}

/**
 * mysql2 hands back a parsed object for a JSON column, but parse defensively
 * anyway (fixtures / non-typeCast drivers) and never throw.
 */
function _meta(row) {
  const m = row && row.metadata;
  if (!m) return {};
  if (typeof m === 'object') return m;
  try { const p = JSON.parse(m); return (p && typeof p === 'object') ? p : {}; }
  catch { return {}; }
}

/**
 * Collect every rule / rule-action / suppression id referenced by a page of
 * execution rows and resolve them to names in ONE query each. Flat maps, not
 * per-row detail arrays: a page repeats the same handful of rules, so per-row
 * expansion would duplicate the same {id,name} hundreds of times on the wire.
 * The UI joins client-side.
 *
 * Rule-action `name` is nullable, and outcomes synthesized for a failed
 * transform / failed evaluator carry rule_action_id: null — both simply
 * produce no entry and the UI falls back to action_type.
 *
 * @returns {Promise<{rules:object, rule_actions:object, suppressions:object}>}
 */
async function _hydrateNames(db, rows) {
  const ruleIds = new Set();
  const actionIds = new Set();
  const suppIds = new Set();

  for (const row of (rows || [])) {
    const meta = _meta(row);
    for (const id of _idArray(meta.matched_rules)) ruleIds.add(id);
    for (const id of _idArray(meta.suppressed_by)) suppIds.add(id);
    if (Array.isArray(meta.action_outcomes)) {
      for (const o of meta.action_outcomes) {
        if (!o || typeof o !== 'object') continue;
        if (Number.isInteger(Number(o.rule_id)))        ruleIds.add(Number(o.rule_id));
        if (Number.isInteger(Number(o.rule_action_id))) actionIds.add(Number(o.rule_action_id));
      }
    }
  }

  const out = { rules: {}, rule_actions: {}, suppressions: {} };

  const fill = async (ids, table, bucket) => {
    if (!ids.size) return;
    const list = [...ids];
    const ph = list.map(() => '?').join(',');
    const [found] = await db.query(
      `SELECT id, name FROM ${table} WHERE id IN (${ph})`, list
    );
    for (const r of found) bucket[r.id] = r.name ?? null;
  };

  await Promise.all([
    fill(ruleIds,   'phone_ingest_rules',        out.rules),
    fill(actionIds, 'phone_ingest_rule_actions', out.rule_actions),
    fill(suppIds,   'phone_log_suppressions',    out.suppressions),
  ]);

  return out;
}

/**
 * @param {object} db
 * @param {number} id
 * @returns {Promise<{execution:object, linked:object}|null>}
 */
async function getById(db, id) {
  const [[execution]] = await db.query(
    `SELECT ${_EXEC_COLS}
       FROM phone_ingest_executions e
      WHERE e.id = ?`,
    [id]
  );
  if (!execution) return null;

  const linked = {
    phone_event_log:       null,
    log:                   null,
    matched_rule_details:  [],
    suppressed_by_details: [],
    // T8 — same shape list() returns, so the drawer renderer that reads
    // `names` works identically whether it was reached from the table or
    // from a direct getById. matched_rule_details / suppressed_by_details
    // are kept as-is: existing callers read them, and `names` cannot express
    // ORDER or a deleted-row {id, name:null} placeholder.
    names: { rules: {}, rule_actions: {}, suppressions: {} },
  };

  // phone_event_log (PK is `id`)
  if (execution.event_log_id != null) {
    const [[row]] = await db.query(
      `SELECT * FROM phone_event_log WHERE id = ?`,
      [execution.event_log_id]
    );
    linked.phone_event_log = row || null;
  }

  // log (PK is `log_id`)
  if (execution.log_id != null) {
    const [[row]] = await db.query(
      `SELECT * FROM log WHERE log_id = ?`,
      [execution.log_id]
    );
    linked.log = row || null;
  }

  // metadata is a parsed object (mysql2). Expand the bare-ID arrays to
  // {id, name}. Tolerates missing rows (deleted rule/suppression).
  const meta = execution.metadata && typeof execution.metadata === 'object'
    ? execution.metadata : {};

  linked.names = await _hydrateNames(db, [execution]);

  const matchedIds = _idArray(meta.matched_rules);
  if (matchedIds.length) {
    const ph = matchedIds.map(() => '?').join(',');
    const [rows] = await db.query(
      `SELECT id, name FROM phone_ingest_rules WHERE id IN (${ph})`,
      matchedIds
    );
    // preserve metadata order; missing ids fall through as {id, name:null}
    const byId = new Map(rows.map(r => [r.id, r.name]));
    linked.matched_rule_details = matchedIds.map(rid => ({
      id: rid, name: byId.has(rid) ? byId.get(rid) : null,
    }));
  }

  const suppressedIds = _idArray(meta.suppressed_by);
  if (suppressedIds.length) {
    const ph = suppressedIds.map(() => '?').join(',');
    const [rows] = await db.query(
      `SELECT id, name FROM phone_log_suppressions WHERE id IN (${ph})`,
      suppressedIds
    );
    const byId = new Map(rows.map(r => [r.id, r.name]));
    linked.suppressed_by_details = suppressedIds.map(sid => ({
      id: sid, name: byId.has(sid) ? byId.get(sid) : null,
    }));
  }

  return { execution, linked };
}


module.exports = {
  list,
  getById,
  VALID_STATUSES,
  VALID_ACTION_STATUSES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
};