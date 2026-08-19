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
 * @param {boolean}[opts.has_match]      true → only rows with matched_rules
 * @param {boolean}[opts.has_failure]    true → only rows with a failed action
 *                                       outcome (see header — NOT the same as
 *                                       a failure `status`)
 * @param {boolean}[opts.slim]           true → omit raw_input from the rows
 * @returns {Promise<{rows:Array, total:number, page:number, page_size:number}>}
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
  if (opts.has_match === true) {
    where.push(`e.metadata->>'$.matched_rules' IS NOT NULL`);
  }
  // Indexed generated column (idx_action_failures) — a range read, not the
  // 528ms JSON scan the equivalent metadata predicate costs.
  if (opts.has_failure === true) {
    where.push('e.action_failure_count > 0');
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

  return { rows, total: Number(total), page, page_size: pageSize };
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
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
};