// services/emailIngestExecutionsService.js
//
/**
 * Email Ingest — Executions Read Service (Phase 3 Slice 3.1)
 * services/emailIngestExecutionsService.js
 *
 * READ-ONLY. The pipeline writes executions via emailIngestService._writeExecution;
 * this service only reads them for the management UI.
 *
 *   list(db, opts)     — paginated + filtered list, returns { rows, total }
 *   getById(db, id)    — single row + a `linked` block hydrating the
 *                        referenced email_log / log rows and expanding the
 *                        bare-ID arrays in metadata (matched_rules,
 *                        suppressed_by) to include rule/suppression names.
 *
 * source_name is denormalized via LEFT JOIN to email_ingest_sources (the FK
 * is ON DELETE SET NULL, so source_id can be NULL on auth_failed rows or
 * after a source is deleted — source_name is then null too).
 *
 * has_match filter keys off `metadata->>'$.matched_rules' IS NOT NULL`, per
 * the verified metadata shape: { matched_rules:[ids], suppressed_by:[ids],
 * action_outcomes:[...] }.
 *
 * raw_input is included in the list response by default (already truncated
 * to 16KB by the pipeline; RAW_INPUT_LIMIT in emailIngestService) — but see
 * `slim` below.
 *
 * ── T2 additions ────────────────────────────────────────────────────────
 *
 * opts.slim — drop raw_input from the LIST projection. Measured on live
 * data, raw_input averages 16.5 KB/row, so a 100-row list response carries
 * ~1.65 MB of payload the caller almost never reads. The Activity page
 * polls this endpoint every 60s; it must not pull megabytes to render a
 * status chip. getById() is unaffected — the detail drawer genuinely wants
 * the payload.
 *
 * opts.has_failure — rows whose Layer-3 rule actions failed. This is NOT
 * derivable from `status`: _buildMetadata records per-action results in
 * metadata.action_outcomes and never reflects them in the status column, so
 * an execution whose action failed still reads 'logged'. Backed by the
 * generated column + index from ref/2026-08-19_ingest_action_failure_count
 * .sql; without that migration this filter and the action_failure_count
 * projection both throw ER_BAD_FIELD_ERROR.
 *
 * action_failure_count is ALWAYS in the projection (both slim and full) so a
 * caller can chip a green-status row as degraded without a second query.
 *
 * ── T8 additions (rule-scoped filtering + name hydration) ───────────────
 *
 * opts.rule_id — executions whose Layer-3 evaluation MATCHED that rule id.
 * Backed by metadata.matched_rules (a JSON array of ints written by
 * emailIngestService._buildMetadata). Predicate is
 *   ? MEMBER OF (e.metadata->'$.matched_rules')
 * with the param bound as a NUMBER — see the load-bearing comment at the
 * predicate itself. MEMBER OF (not JSON_CONTAINS) is chosen because it is
 * the form the optimizer can satisfy from a multi-valued index; see
 * ref/2026-08-22_ingest_matched_rules_index.sql, which is OPTIONAL — without
 * it this is a full scan (~420ms at 16k rows, fine for an admin surface).
 *
 * opts.action_status — executions carrying an action_outcomes entry with
 * that status. SCOPED TO rule_id when rule_id is also supplied (i.e. "this
 * rule's action failed", not "some rule's action failed on a row where this
 * rule also matched") — that distinction is the whole point of the filter.
 * Note 'failed' alone is ALSO answerable via has_failure, which is indexed;
 * prefer has_failure when you don't need the rule scope.
 *
 * opts.has_match is now TRI-STATE (true / false / undefined). The false
 * branch — rows where NO rule matched — is what the route's T6/F-4 comment
 * said to add here first; it is now added, and the route parses accordingly.
 *
 * list() additionally returns a `names` block:
 *   { rules:{id:name}, rule_actions:{id:name}, suppressions:{id:name} }
 * covering every id referenced by the returned page's metadata. This is what
 * lets the UI render "which rule fired, and what did its actions do" inline
 * in the table instead of forcing a drawer open per row. It is 0–3 tiny
 * indexed lookups against tables in the tens of rows — NOT an N+1.
 */

// ── STATUS VOCABULARY CHECKLIST (T6/F-6) ────────────────────────────────
// The email execution status set is HAND-SYNCED across five places. Adding
// a status to the DB ENUM without chasing ALL of these recreates exactly
// the blindness T2/T3 removed (MTH-2's 'duplicate' already forced one
// manual chase). Checklist:
//   1. DB ENUM email_ingest_executions.status (ALTER TABLE;
//      ref/database.sql is a generated snapshot — do not hand-edit it)
//   2. THIS set (VALID_STATUSES below) — list() silently DROPS an
//      unrecognized filter value, so a missing entry returns EVERY row
//      while looking like it worked
//   3. emailIngestMetaService.EXECUTION_STATUSES — the /meta dropdown
//   4. public/automation/emailIngest.html STATUS_META — chip colors
//      (unknown falls to gray: cosmetic only)
//   5. public/automation/activity.html EMAIL_FAILURE_STATUSES — ONLY if
//      the new status is a failure class; miss it and Activity's failures
//      mode is blind to it
// Durable fix (separate slice): derive 4/5 from /meta. Not built here.
const VALID_STATUSES = new Set([
  'logged', 'duplicate', 'skipped_firm_to_firm', 'skipped_suppression',
  'auth_failed', 'validation_failed', 'error',
]);

// ── ACTION-OUTCOME STATUS VOCABULARY ────────────────────────────────────
// Written by emailIngestRuleService._dispatchAction. Unlike the execution
// `status` above this is NOT a DB enum — it is a plain JSON string — so the
// only defense against a typo'd filter value is this set. list() DROPS an
// unrecognized value (same convention as `status`); the ROUTE rejects one
// with 400 so a caller finds out.
//
//   success               — dispatcher returned success
//   failed                — dispatcher returned failure, or the transform /
//                           evaluator threw (synthetic outcomes, T6/F-3 and
//                           T7/F-8; those carry action_type 'transform' /
//                           'rule_evaluation' and a null rule_action_id)
//   skipped_test_envelope — workflow action suppressed on a "-test-" replay
//                           (TEST-ENVELOPE GATE in _dispatchAction). EMAIL
//                           ONLY: the phone pipeline has no replay path, so
//                           phoneIngestExecutionsService omits this value.
const VALID_ACTION_STATUSES = new Set([
  'success', 'failed', 'skipped_test_envelope',
]);

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE     = 200;

// Shared head of both projections. action_failure_count rides along in both:
// it is an indexed generated column, so it costs nothing and it is the only
// way a caller can tell a green-status row apart from a green-status row
// whose action blew up.
const _EXEC_COLS_BASE =
  `e.id, e.source_id, e.message_id, e.status, e.log_id, e.email_log_id,
   e.error, e.metadata, e.remote_ip, e.created_at,
   e.action_failure_count, s.name AS source_name`;

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
 * @param {string} [opts.source]         source NAME (not id)
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
  if (opts.source) {
    where.push('s.name = ?');
    params.push(opts.source);
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
  // Indexed generated column (idx_action_failures) — a range read, not the
  // 528ms JSON scan the equivalent metadata predicate costs.
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

  // total (separate count query; the join is needed only when filtering on
  // source name, but keeping it uniform is simpler and the table is small).
  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total
       FROM email_ingest_executions e
       LEFT JOIN email_ingest_sources s ON s.id = e.source_id
       ${whereSql}`,
    params
  );

  const offset = (page - 1) * pageSize;
  const [rows] = await db.query(
    `SELECT ${cols}
       FROM email_ingest_executions e
       LEFT JOIN email_ingest_sources s ON s.id = e.source_id
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
 * mysql2 hands back a parsed object for a JSON column, but every caller of
 * this file also has to survive a string (a row fetched through a driver
 * config without typeCast, or a hand-built fixture in a test). Parse
 * defensively and never throw.
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
 * execution rows and resolve them to names in ONE query each.
 *
 * Why a flat map rather than per-row detail arrays: a page of 200 rows
 * typically references the same handful of rules, so per-row expansion would
 * repeat the same {id,name} object hundreds of times on the wire for no gain.
 * The UI joins client-side.
 *
 * Rule-action `name` is nullable in the schema, and outcomes synthesized for
 * a failed transform / failed evaluator carry rule_action_id: null — both
 * simply produce no entry, and the UI falls back to action_type.
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
    fill(ruleIds,   'email_ingest_rules',            out.rules),
    fill(actionIds, 'email_ingest_rule_actions',     out.rule_actions),
    fill(suppIds,   'email_ingest_log_suppressions', out.suppressions),
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
       FROM email_ingest_executions e
       LEFT JOIN email_ingest_sources s ON s.id = e.source_id
      WHERE e.id = ?`,
    [id]
  );
  if (!execution) return null;

  const linked = {
    email_log:            null,
    log:                  null,
    matched_rule_details: [],
    suppressed_by_details: [],
    // T8 — same shape list() returns, so the drawer renderer that reads
    // `names` works identically whether it was reached from the table or
    // from a direct getById (the test-match panel's tmOpenExecution path).
    // matched_rule_details / suppressed_by_details are kept as-is: existing
    // callers read them, and `names` cannot express ORDER or a deleted-row
    // {id, name:null} placeholder.
    names: { rules: {}, rule_actions: {}, suppressions: {} },
  };

  // email_log (PK is `id`)
  if (execution.email_log_id != null) {
    const [[row]] = await db.query(
      `SELECT * FROM email_log WHERE id = ?`,
      [execution.email_log_id]
    );
    linked.email_log = row || null;
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
      `SELECT id, name FROM email_ingest_rules WHERE id IN (${ph})`,
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
      `SELECT id, name FROM email_ingest_log_suppressions WHERE id IN (${ph})`,
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