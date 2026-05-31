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
 * raw_input is included in the list response (the pipeline is responsible for
 * any truncation before write, mirroring email's RAW_INPUT_LIMIT).
 */

const VALID_STATUSES = new Set([
  'logged', 'suppressed', 'error',
]);

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE     = 200;

const _EXEC_COLS =
  `e.id, e.event_log_id, e.status, e.log_id, e.error, e.metadata,
   e.raw_input, e.created_at`;


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

  // total (separate count query).
  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total
       FROM phone_ingest_executions e
       ${whereSql}`,
    params
  );

  const offset = (page - 1) * pageSize;
  const [rows] = await db.query(
    `SELECT ${_EXEC_COLS}
       FROM phone_ingest_executions e
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
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
};