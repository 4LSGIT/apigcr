/**
 * Log Service
 * services/logService.js
 *
 * Read and create log entries. All log writes from routes and services
 * should go through this module (except the DB trigger on contacts,
 * which writes directly).
 *
 * Usage:
 *   const logService = require('../services/logService');
 *   const entries = await logService.listLog(db, { link_type: 'contact', link_id: 123 });
 *   const entry  = await logService.createLogEntry(db, { type: 'note', ... });
 */

// ─────────────────────────────────────────────────────────────
// listLog
// ─────────────────────────────────────────────────────────────

/**
 * List log entries with filters.
 *
 * Reads from the new link columns (log_link_type / log_link_id) first,
 * falls back to legacy log_link for old rows that haven't been backfilled.
 *
 * @param {object} db
 * @param {object} opts
 * @param {string}  [opts.link_type]   - 'contact','case','appt','bill'
 * @param {string}  [opts.link_id]     - the ID to filter by
 * @param {string}  [opts.type]        - log_type enum filter
 * @param {string}  [opts.direction]   - 'incoming' or 'outgoing'
 * @param {string}  [opts.from_date]   - ISO datetime lower bound
 * @param {string}  [opts.to_date]     - ISO datetime upper bound
 * @param {number}  [opts.limit=50]
 * @param {number}  [opts.offset=0]
 * @returns {{ entries: object[], total: number }}
 */
async function listLog(db, {
  link_type = null,
  link_id   = null,
  type      = null,
  direction = null,
  from_date = null,
  to_date   = null,
  limit     = 50,
  offset    = 0
} = {}) {
  const where = [];
  const params = [];

  if (link_type && link_id) {
    // Match on new columns OR legacy column for backward compat
    where.push(`(
      (l.log_link_type = ? AND l.log_link_id = ?)
      OR (l.log_link_type IS NULL AND l.log_link = ?)
    )`);
    params.push(link_type, String(link_id), String(link_id));
  }

  if (type) {
    where.push('l.log_type = ?');
    params.push(type);
  }

  if (direction) {
    where.push('l.log_direction = ?');
    params.push(direction);
  }

  if (from_date) {
    where.push('l.log_date >= ?');
    params.push(from_date);
  }

  if (to_date) {
    where.push('l.log_date <= ?');
    params.push(to_date);
  }

  const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [entries] = await db.query(
    `SELECT
       l.log_id,
       l.log_type,
       l.log_date,
       l.log_link,
       l.log_link_type,
       l.log_link_id,
       l.log_by,
       l.log_data,
       l.log_from,
       l.log_to,
       l.log_subject,
       l.log_direction,
       u.user_name AS by_name
     FROM log l
     LEFT JOIN users u ON l.log_by = u.user
     ${whereSQL}
     ORDER BY l.log_date DESC
     LIMIT ? OFFSET ?`,
    [...params, parseInt(limit), parseInt(offset)]
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM log l ${whereSQL}`,
    params
  );

  return { entries, total };
}


// ─────────────────────────────────────────────────────────────
// getLogEntry
// ─────────────────────────────────────────────────────────────

/**
 * Fetch a single log entry by ID.
 * @param {object} db
 * @param {number} logId
 * @returns {object|null}
 */
async function getLogEntry(db, logId) {
  const [[entry]] = await db.query(
    `SELECT
       l.*,
       u.user_name AS by_name
     FROM log l
     LEFT JOIN users u ON l.log_by = u.user
     WHERE l.log_id = ?`,
    [logId]
  );
  return entry || null;
}


// ─────────────────────────────────────────────────────────────
// createLogEntry
// ─────────────────────────────────────────────────────────────

/**
 * Insert a log entry.
 *
 * Writes all three link columns (legacy log_link + new log_link_type/log_link_id).
 * The contacts table has a DB trigger that writes 'update' logs automatically
 * on contact changes — don't call this for contact field updates.
 *
 * @param {object} db
 * @param {object} opts
 * @param {string}  opts.type        - log_type enum (required)
 * @param {string}  [opts.link_type] - 'contact','case','appt','bill'
 * @param {string}  [opts.link_id]   - the linked entity ID
 * @param {number}  [opts.by=0]      - user ID (0 = system/automation)
 * @param {string|object} [opts.data=''] - log_data (JSON string or object, auto-stringified)
 * @param {string}  [opts.from]      - log_from
 * @param {string}  [opts.to]        - log_to
 * @param {string}  [opts.subject]   - log_subject
 * @param {string}  [opts.message]   - log_message (legacy, still written)
 * @param {string}  [opts.direction] - 'incoming' or 'outgoing'
 * @returns {{ log_id: number }}
 */
async function createLogEntry(db, {
  type,
  link_type  = null,
  link_id    = null,
  by         = 0,
  data       = '',
  from       = null,
  to         = null,
  subject    = null,
  message    = null,
  direction  = null
}) {
  if (!type) throw new Error('createLogEntry requires type');

  const logData = typeof data === 'object' ? JSON.stringify(data) : data;
  const logLink = link_id != null ? String(link_id) : '';

  const [result] = await db.query(
    `INSERT INTO log
       (log_type, log_date, log_link, log_link_type, log_link_id,
        log_by, log_data, log_from, log_to, log_subject, log_message, log_direction)
     VALUES (?, CONVERT_TZ(NOW(), @@session.time_zone, 'EST5EDT'), ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?)`,
    [
      type,
      logLink,
      link_type,
      link_id != null ? String(link_id) : null,
      by,
      logData,
      from,
      to,
      subject,
      message || '',
      direction
    ]
  );

  return { log_id: result.insertId };
}


module.exports = {
  listLog,
  getLogEntry,
  createLogEntry
};