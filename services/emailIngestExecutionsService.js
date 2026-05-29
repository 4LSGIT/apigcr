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
 * raw_input is included in the list response (already truncated to 16KB by
 * the pipeline; RAW_INPUT_LIMIT in emailIngestService).
 */

const VALID_STATUSES = new Set([
  'logged', 'duplicate', 'skipped_firm_to_firm', 'skipped_suppression',
  'auth_failed', 'validation_failed', 'error',
]);

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE     = 200;

const _EXEC_COLS =
  `e.id, e.source_id, e.message_id, e.status, e.log_id, e.email_log_id,
   e.error, e.metadata, e.raw_input, e.remote_ip, e.created_at,
   s.name AS source_name`;


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

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

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
    `SELECT ${_EXEC_COLS}
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