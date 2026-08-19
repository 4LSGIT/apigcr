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
  // Indexed generated column (idx_action_failures) — a range read, not a
  // full JSON scan.
  if (opts.has_failure === true) {
    where.push('e.action_failure_count > 0');
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