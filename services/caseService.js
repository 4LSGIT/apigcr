/**
 * Case Service
 * services/caseService.js
 *
 * CRUD for the cases table plus case_relate (contact-case linking).
 * The "get one" function follows the existing pattern: case + clients + appts,
 * extended with tasks and log.
 *
 * Important:
 *   - case_id is varchar(20), 8-char alphanumeric (e.g. "uT7EU36v")
 *   - case_judge / case_trustee are name strings, NOT FK IDs
 *     Join: cases.case_judge = judges.judge_name
 *     Join: cases.case_trustee = trustees.trustee_full_name
 *   - case_stage enum: 'Open','Pending','Filed','Concluded','Closed'
 *   - case_relate has a uniqueness trigger — catch SQLSTATE 45000
 *   - No DELETE for cases (legal records)
 *
 * Usage:
 *   const caseService = require('../services/caseService');
 *   const result = await caseService.getCase(db, 'uT7EU36v');
 */

const crypto = require('crypto');
const { stripSsn } = require('./contactService');


// ─────────────────────────────────────────────────────────────
// listCases
// ─────────────────────────────────────────────────────────────

/**
 * List cases with search, filters, and pagination.
 *
 * Search matches against: contact_name, case_id, case_number,
 * case_number_full, case_notes.
 *
 * @param {object} db
 * @param {object} opts
 * @param {string}  [opts.query]       - text search
 * @param {string}  [opts.type]        - case_type filter (use '%' for all)
 * @param {string}  [opts.stage]       - case_stage filter (use '%' for all)
 * @param {string}  [opts.status]      - case_status filter (use '%' for all)
 * @param {number}  [opts.limit=50]
 * @param {number}  [opts.offset=0]
 * @returns {{ cases: object[], total: number }}
 */
async function listCases(db, {
  query  = '',
  type   = '%',
  stage  = '%',
  status = '%',
  sort_by  = 'c.case_open_date',
  sort_dir = 'DESC',
  limit  = 50,
  offset = 0
} = {}) {
  const where = [];
  const params = [];

  if (query) {
    where.push(`(
      co.contact_name LIKE ?
      OR c.case_id LIKE ?
      OR c.case_number LIKE ?
      OR c.case_number_full LIKE ?
      OR c.case_notes LIKE ?
    )`);
    const q = `%${query}%`;
    params.push(q, q, q, q, q);
  }

  // Type/stage/status use LIKE so '%' means "all"
  where.push('c.case_type LIKE ?');
  params.push(type);
  where.push('c.case_stage LIKE ?');
  params.push(stage);
  where.push('c.case_status LIKE ?');
  params.push(status);

  const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const SORT_WHITELIST = {
    "c.case_id": "c.case_id",
    "co.contact_lname": "co.contact_lname",
    "co.contact_name": "co.contact_name",
    "c.case_number": "c.case_number",
    "c.case_open_date": "c.case_open_date",
    "c.case_file_date": "c.case_file_date",
    "c.case_close_date": "c.case_close_date",
    "c.case_type": "c.case_type",
    "c.case_stage": "c.case_stage",
    "c.case_status": "c.case_status",
  };
  const orderBy = SORT_WHITELIST[sort_by] || "c.case_open_date";
  const orderDir = sort_dir === "ASC" ? "ASC" : "DESC";

  const [cases] = await db.query(
    `SELECT
     c.case_id,
     COALESCE(c.case_number_full, c.case_number, c.case_id) AS case_number,
     c.case_type, c.case_stage, c.case_status,
     c.case_judge, c.case_trustee, c.case_chapter,
     IFNULL(DATE_FORMAT(c.case_open_date,  '%b. %e, %Y'), '') AS open,
     IFNULL(DATE_FORMAT(c.case_file_date,  '%b. %e, %Y'), '') AS file,
     IFNULL(DATE_FORMAT(c.case_close_date, '%b. %e, %Y'), '') AS close,
     JSON_ARRAYAGG(JSON_OBJECT(
       'contact_name',    co.contact_name,
       'contact_id',      co.contact_id,
       'contact_relate',  cr.case_relate_type
     )) AS contacts
   FROM cases c
   LEFT JOIN case_relate cr ON c.case_id = cr.case_relate_case_id
   LEFT JOIN contacts co ON cr.case_relate_client_id = co.contact_id
   ${whereSQL}
   GROUP BY c.case_id
   ORDER BY ${orderBy} ${orderDir}
   LIMIT ? OFFSET ?`,
    [...params, parseInt(limit), parseInt(offset)],
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total
     FROM cases c
     LEFT JOIN case_relate cr ON c.case_id = cr.case_relate_case_id
       AND cr.case_relate_type = 'Primary'
     LEFT JOIN contacts co ON cr.case_relate_client_id = co.contact_id
     ${whereSQL}`,
    params,
  );

  return { cases, total };
}


// ─────────────────────────────────────────────────────────────
// getCase
// ─────────────────────────────────────────────────────────────

/**
 * Fetch a single case with all related entities.
 *
 * Returns: { case, clients, appts, tasks, log }
 * Follows the existing pattern from GET /api/cases/:caseId.
 *
 * @param {object} db
 * @param {string} caseId
 * @returns {object|null}
 */
async function getCase(db, caseId) {
  // 1) Case record
  const [[caseRow]] = await db.query(
    'SELECT * FROM cases WHERE case_id = ?',
    [caseId]
  );
  if (!caseRow) return null;

  // 2) Clients via case_relate (strip SSN)
  const [clientsRaw] = await db.query(
    `SELECT
       co.*,
       IFNULL(DATE_FORMAT(co.contact_dob, '%b. %e, %Y'), '') AS dob,
       cr.case_relate_type AS relate_type
     FROM contacts co
     JOIN case_relate cr ON co.contact_id = cr.case_relate_client_id
     WHERE cr.case_relate_case_id = ?`,
    [caseId]
  );
  const clients = stripSsn(clientsRaw);

  // 3) Appointments
  const [appts] = await db.query(
    `SELECT
       a.*,
       DATE_FORMAT(a.appt_date, '%b. %e, %Y') AS format_date,
       DATE_FORMAT(a.appt_date, '%l:%i %p')    AS time,
       co.contact_name,
       co.contact_id
     FROM appts a
     LEFT JOIN contacts co ON a.appt_client_id = co.contact_id
     WHERE a.appt_case_id = ?
     ORDER BY a.appt_date DESC`,
    [caseId]
  );

  // 4) Tasks linked to this case OR to any of its clients
  const clientIds = clients.map(c => c.contact_id);
  let tasks = [];
  if (clientIds.length) {
    const [taskRows] = await db.query(
      `SELECT
         t.task_id, t.task_status, t.task_title, t.task_desc,
         t.task_due, t.task_date,
         uf.user_name AS from_name,
         ut.user_name AS to_name
       FROM tasks t
       LEFT JOIN users uf ON t.task_from = uf.user
       LEFT JOIN users ut ON t.task_to   = ut.user
       WHERE
         (t.task_link_type = 'case' AND t.task_link_id = ?)
         OR (t.task_link_type = 'contact' AND t.task_link_id IN (?))
         OR (t.task_link_type IS NULL AND (
           t.task_link = ?
           OR t.task_link IN (?)
         ))
       ORDER BY t.task_date DESC`,
      [caseId, clientIds, caseId, clientIds]
    );
    tasks = taskRows;
  } else {
    // No clients — just look for case-linked tasks
    const [taskRows] = await db.query(
      `SELECT
         t.task_id, t.task_status, t.task_title, t.task_desc,
         t.task_due, t.task_date,
         uf.user_name AS from_name,
         ut.user_name AS to_name
       FROM tasks t
       LEFT JOIN users uf ON t.task_from = uf.user
       LEFT JOIN users ut ON t.task_to   = ut.user
       WHERE (t.task_link_type = 'case' AND t.task_link_id = ?)
          OR (t.task_link_type IS NULL AND t.task_link = ?)
       ORDER BY t.task_date DESC`,
      [caseId, caseId]
    );
    tasks = taskRows;
  }

  // 5) Log entries linked to this case
  const [log] = await db.query(
    `SELECT
       l.log_id, l.log_type, l.log_date, l.log_data,
       l.log_from, l.log_to, l.log_subject, l.log_direction,
       u.user_name AS by_name
     FROM log l
     LEFT JOIN users u ON l.log_by = u.user
     WHERE (l.log_link_type = 'case' AND l.log_link_id = ?)
        OR (l.log_link_type IS NULL AND l.log_link = ?)
     ORDER BY l.log_date DESC
     LIMIT 200`,
    [caseId, caseId]
  );

  return { case: caseRow, clients, appts, tasks, log };
}


// ─────────────────────────────────────────────────────────────
// updateCase
// ─────────────────────────────────────────────────────────────

/**
 * Update one or more fields on a case.
 *
 * The cases table has many BK-specific columns — we allow most of them.
 * Only the PK is blocked.
 *
 * @param {object} db
 * @param {string} caseId
 * @param {object} fields
 * @returns {{ case_id: string, updated_fields: string[] }}
 */
async function updateCase(db, caseId, fields) {
  if (!fields || !Object.keys(fields).length) {
    throw new Error('updateCase requires at least one field');
  }

  // Block only the PK — everything else on this table is editable
  const BLOCKED = new Set(['case_id']);

  const keys = Object.keys(fields);
  const blocked = keys.filter(k => BLOCKED.has(k));
  if (blocked.length) {
    throw new Error(`updateCase: blocked columns: ${blocked.join(', ')}`);
  }

  // Validate all keys are actual column names (basic safety)
  for (const k of keys) {
    if (!/^[\w]+$/.test(k)) {
      throw new Error(`updateCase: invalid column name "${k}"`);
    }
  }

  const setClauses = keys.map(k => `\`${k}\` = ?`).join(', ');
  const values = [...keys.map(k => fields[k]), caseId];

  const [result] = await db.query(
    `UPDATE cases SET ${setClauses} WHERE case_id = ?`,
    values
  );

  if (result.affectedRows === 0) {
    throw new Error(`Case ${caseId} not found`);
  }

  return { case_id: caseId, updated_fields: keys };
}


// ─────────────────────────────────────────────────────────────
// Case-Contact Relations (case_relate)
// ─────────────────────────────────────────────────────────────

/**
 * Add a contact to a case.
 *
 * The case_relate table has a uniqueness trigger that throws
 * SQLSTATE 45000 on duplicate (case_id + client_id + type).
 *
 * @param {object} db
 * @param {string} caseId
 * @param {number} contactId
 * @param {string} relateType - 'Primary','Secondary','Other','Bystander'
 * @returns {{ case_relate_id: number }}
 */
async function addCaseContact(db, caseId, contactId, relateType = 'Primary') {
  const validTypes = ['Primary', 'Secondary', 'Other', 'Bystander'];
  if (!validTypes.includes(relateType)) {
    throw new Error(`addCaseContact: invalid type "${relateType}". Must be one of: ${validTypes.join(', ')}`);
  }

  try {
    const [result] = await db.query(
      `INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type)
       VALUES (?, ?, ?)`,
      [caseId, contactId, relateType]
    );
    return { case_relate_id: result.insertId };
  } catch (err) {
    // The uniqueness trigger throws SQLSTATE 45000
    if (err.sqlState === '45000' || err.message.includes('Duplicate entry')) {
      throw new Error(`Contact ${contactId} is already linked to case ${caseId} as ${relateType}`);
    }
    throw err;
  }
}

/**
 * Remove a contact from a case.
 *
 * @param {object} db
 * @param {string} caseId
 * @param {number} contactId
 * @returns {{ removed: boolean }}
 */
async function removeCaseContact(db, caseId, contactId) {
  const [result] = await db.query(
    `DELETE FROM case_relate
     WHERE case_relate_case_id = ? AND case_relate_client_id = ?`,
    [caseId, contactId]
  );
  return { removed: result.affectedRows > 0 };
}


module.exports = {
  listCases,
  getCase,
  updateCase,
  addCaseContact,
  removeCaseContact
};