/**
 * Contact Service
 * services/contactService.js
 *
 * CRUD for the contacts table. The "get one" function returns the
 * contact plus all related entities (cases, appts, tasks, log, sequences).
 *
 * Important:
 *   - contact_name, contact_lfm_name, contact_rname are trigger-computed
 *     from fname/mname/lname — never write to them directly
 *   - contact_ssn is NEVER returned by any function in this service
 *   - The after_contact_update trigger auto-logs changes — don't double-log
 *   - contact_phone is char(10) — normalize input (strip formatting)
 *
 * Usage:
 *   const contactService = require('../services/contactService');
 *   const { contact, cases, appts, tasks, log } = await contactService.getContact(db, 123);
 */
const DEFAULT_LOG_LIMIT = 200;
const SSN_COLUMN = 'contact_ssn';

/**
 * Strip SSN from a contact row or array of rows.
 */
function stripSsn(row) {
  if (!row) return row;
  if (Array.isArray(row)) return row.map(r => stripSsn(r));
  const { [SSN_COLUMN]: _ssn, ...clean } = row;
  return clean;
}

/**
 * Normalize a phone number to 10 digits.
 * Strips +1 prefix, parentheses, dashes, dots, spaces.
 */
function normalizePhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}


// ─────────────────────────────────────────────────────────────
// listContacts
// ─────────────────────────────────────────────────────────────

/**
 * List contacts with search, filters, and pagination.
 *
 * Search uses FULLTEXT on contact_name for text queries,
 * with LIKE fallback for phone/email patterns.
 *
 * @param {object} db
 * @param {object} opts
 * @param {string}  [opts.query]       - search text
 * @param {string}  [opts.type]        - contact_type filter
 * @param {string}  [opts.tags]        - match against contact_tags (LIKE)
 * @param {number}  [opts.limit=50]
 * @param {number}  [opts.offset=0]
 * @returns {{ contacts: object[], total: number }}
 */
async function listContacts(db, {
  query  = '',
  type   = null,
  tags   = null,
  sort_by  = 'c.contact_lname',
  sort_dir = 'ASC',
  limit  = 50,
  offset = 0
} = {}) {
  const where = [];
  const params = [];

  if (query) {
    if (/^\d+$/.test(query)) {
      // Numeric — could be contact_id or phone
      const digits = query.replace(/\D/g, '');
      if (digits.length >= 7) {
        // Long enough to be a phone
        where.push(`(c.contact_phone LIKE ? OR c.contact_phone2 LIKE ?)`);
        params.push(`%${digits}%`, `%${digits}%`);
      } else {
        // Short numeric — treat as contact_id
        where.push(`c.contact_id = ?`);
        params.push(parseInt(query, 10));
      }
    } else if (query.includes('@')) {
      // Email search
      where.push(`(c.contact_email LIKE ? OR c.contact_email2 LIKE ?)`);
      const q = `%${query}%`;
      params.push(q, q);
    } else {
      // Name search — FULLTEXT for relevance, LIKE as fallback
      where.push(`(
        MATCH(c.contact_name) AGAINST(? IN BOOLEAN MODE)
        OR c.contact_name LIKE ?
        OR CONCAT(c.contact_fname, ' ', c.contact_lname) LIKE ?
        OR c.contact_fname LIKE ?
        OR c.contact_lname LIKE ?
      )`);
      const q = `%${query}%`;
      params.push(`${query}*`, q,q, q, q);
    }
  }

  if (type) {
    where.push('c.contact_type = ?');
    params.push(type);
  }

  if (tags) {
    where.push('c.contact_tags LIKE ?');
    params.push(`%${tags}%`);
  }

  const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const SORT_WHITELIST = {
    "contact_lname ASC": "c.contact_lname ASC",
    "contact_lname DESC": "c.contact_lname DESC",
    "contact_fname ASC": "c.contact_fname ASC",
    "contact_fname DESC": "c.contact_fname DESC",
  };
  const orderClause =
    SORT_WHITELIST[`${sort_by} ${sort_dir}`] ||
    SORT_WHITELIST[sort_by] || // if sort_dir already embedded in sort_by (legacy dropdown value)
    "c.contact_lname ASC";

  const [contacts] = await db.query(
    `SELECT
     c.contact_id, c.contact_type, c.contact_name,
     c.contact_fname, c.contact_mname, c.contact_lname,
     c.contact_phone, c.contact_email,
     c.contact_address, c.contact_city, c.contact_state, c.contact_zip,
     c.contact_tags,
     IFNULL(DATE_FORMAT(c.contact_dob, '%M %e, %Y'), '') AS dob,
     JSON_ARRAYAGG(
       JSON_OBJECT(
         'case_number', COALESCE(ca.case_number_full, ca.case_number, ca.case_id),
         'case_id',     ca.case_id,
         'case_type',   ca.case_type
       )
     ) AS cases
   FROM contacts c
   LEFT JOIN case_relate cr ON c.contact_id = cr.case_relate_client_id
   LEFT JOIN cases ca ON cr.case_relate_case_id = ca.case_id
   ${whereSQL}
   GROUP BY c.contact_id
   ORDER BY ${orderClause}
   LIMIT ? OFFSET ?`,
    [...params, parseInt(limit), parseInt(offset)],
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(DISTINCT c.contact_id) AS total
   FROM contacts c
   LEFT JOIN case_relate cr ON c.contact_id = cr.case_relate_client_id
   LEFT JOIN cases ca ON cr.case_relate_case_id = ca.case_id
   ${whereSQL}`,
    params,
  );

  return { contacts, total };
}


// ─────────────────────────────────────────────────────────────
// getContact — UPDATED to respect `include` parameter
// ─────────────────────────────────────────────────────────────
//
// Replace the existing getContact function in services/contactService.js
// with this version.
//
// CHANGE: The `include` parameter now controls which sub-entities are fetched.
//   - If omitted/empty → returns ONLY the contact row (no sub-entities)
//   - If provided → comma-separated list: 'cases,appts,tasks,log,sequences'
//
// This means GET /api/contacts/123 returns just { contact: {...} }
// and GET /api/contacts/123?include=cases,appts returns { contact, cases, appts }
//
// Previously: always fetched ALL sub-entities regardless of include param.

/**
 * Fetch a single contact, optionally with related entities.
 *
 * @param {object} db
 * @param {number} contactId
 * @param {string} [include] — comma-separated: 'cases,appts,tasks,log,sequences'
 * @returns {object|null} null if contact not found
 */
async function getContact(db, contactId, include = '', { logLimit = DEFAULT_LOG_LIMIT } = {}) {
  // 1) Contact record (always fetched)
  const [[raw]] = await db.query(
    'SELECT * FROM contacts WHERE contact_id = ?',
    [contactId]
  );
  if (!raw) return null;
  const contact = { ...raw };  // SSN exposed — authenticated staff only

  const result = { contact };

  // Parse include param
  const parts = include
    ? include.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : [];

  // 2) Cases via case_relate
  if (parts.includes('cases')) {
    const [cases] = await db.query(
      `SELECT
       ca.case_id, ca.case_number, ca.case_number_full,
       ca.case_type, ca.case_stage, ca.case_status,
       cr.case_relate_type AS relate_type,
       IFNULL(DATE_FORMAT(ca.case_open_date,  '%b. %e, %Y'), '') AS open,
       IFNULL(DATE_FORMAT(ca.case_file_date,  '%b. %e, %Y'), '') AS file,
       IFNULL(DATE_FORMAT(ca.case_close_date, '%b. %e, %Y'), '') AS close
      FROM case_relate cr
      JOIN cases ca ON cr.case_relate_case_id = ca.case_id
      WHERE cr.case_relate_client_id = ?
      ORDER BY ca.case_open_date DESC`,
      [contactId],
    );
    result.cases = cases;
  }

  // 3) Appointments
  if (parts.includes('appts')) {
    const [appts] = await db.query(
      `SELECT
         a.appt_id, a.appt_type, a.appt_status, a.appt_date, a.appt_end,
         a.appt_length, a.appt_platform, a.appt_case_id, a.appt_note,
         a.appt_with,
         DATE_FORMAT(a.appt_date, '%Y-%m-%dT%H:%i') AS appt_datetime_local,
         DATE_FORMAT(a.appt_date, '%b. %e, %Y') AS format_date,
         DATE_FORMAT(a.appt_date, '%h:%i %p')   AS time,
         u.user_name AS with_name
       FROM appts a
       LEFT JOIN users u ON a.appt_with = u.user
       WHERE a.appt_client_id = ?
       ORDER BY a.appt_date DESC`,
      [contactId],
    );
    result.appts = appts;
  }

  // 4) Tasks linked to this contact
  if (parts.includes('tasks')) {
    const [tasks] = await db.query(
      `SELECT
         t.task_id, t.task_status, t.task_title, t.task_desc,
         t.task_due, t.task_date,
         uf.user_name AS from_name,
         ut.user_name AS to_name
       FROM tasks t
       LEFT JOIN users uf ON t.task_from = uf.user
       LEFT JOIN users ut ON t.task_to   = ut.user
       WHERE (t.task_link_type = 'contact' AND t.task_link_id = ?)
          OR (t.task_link_type IS NULL AND t.task_link = ?)
       ORDER BY t.task_date DESC`,
      [String(contactId), String(contactId)]
    );
    result.tasks = tasks;
  }

  // 5) Log entries
  if (parts.includes('log')) {
    const [log] = await db.query(
      `SELECT
         l.log_id, l.log_type, l.log_date, l.log_data,
         l.log_from, l.log_to, l.log_subject, l.log_direction,
         u.user_name AS by_name
       FROM log l
       LEFT JOIN users u ON l.log_by = u.user
       WHERE (l.log_link_type = 'contact' AND l.log_link_id = ?)
          OR (l.log_link_type IS NULL AND l.log_link = ?)
       ORDER BY l.log_date DESC
       LIMIT ?`,
      [String(contactId), String(contactId), logLimit]
    );
    result.log = log;
  }

  // 6) Sequence enrollments
  if (parts.includes('sequences')) {
    const [sequences] = await db.query(
      `SELECT
         se.id, se.status, se.current_step, se.total_steps,
         se.cancel_reason, se.enrolled_at, se.completed_at,
         st.name AS template_name, st.type AS template_type
       FROM sequence_enrollments se
       JOIN sequence_templates st ON se.template_id = st.id
       WHERE se.contact_id = ?
       ORDER BY se.enrolled_at DESC`,
      [contactId]
    );
    result.sequences = sequences;
  }

  return result;
}


// ─────────────────────────────────────────────────────────────
// createContact
// ─────────────────────────────────────────────────────────────

/**
 * Create a new contact. Simple insert — no find-or-create logic.
 * (Use the intake routes for find-or-create.)
 *
 * DB triggers auto-compute contact_name, contact_lfm_name, contact_rname.
 *
 * @param {object} db
 * @param {object} opts
 * @returns {{ contact_id: number, contact_name: string }}
 */
async function createContact(db, {
  fname,
  mname  = '',
  lname,
  phone  = '',
  email  = '',
  type   = 'Client',
  pname  = '',
  address = '',
  city   = '',
  state  = '',
  zip    = '',
  dob    = null,
  marital_status = null,
  phone2 = '',
  email2 = '',
  tags   = '',
  notes  = ''
}) {
  if (!fname) throw new Error('createContact requires fname');
  if (!lname) throw new Error('createContact requires lname');

  const normalizedPhone  = normalizePhone(phone);
  const normalizedPhone2 = normalizePhone(phone2);

  const [result] = await db.query(
    `INSERT INTO contacts
       (contact_fname, contact_mname, contact_lname, contact_pname,
        contact_phone, contact_email, contact_type,
        contact_address, contact_city, contact_state, contact_zip,
        contact_dob, contact_marital_status,
        contact_phone2, contact_email2,
        contact_tags, contact_notes, contact_created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      fname, mname, lname, pname,
      normalizedPhone, email, type,
      address, city, state, zip,
      dob, marital_status,
      normalizedPhone2, email2,
      tags, notes
    ]
  );

  const newId = result.insertId;

  // Re-fetch to get trigger-computed name fields
  const [[created]] = await db.query(
    'SELECT contact_id, contact_name FROM contacts WHERE contact_id = ?',
    [newId]
  );

  return { contact_id: newId, contact_name: created.contact_name };
}


// ─────────────────────────────────────────────────────────────
// updateContact
// ─────────────────────────────────────────────────────────────

/**
 * Update one or more fields on a contact.
 *
 * Whitelist enforced — blocks PK, SSN, and trigger-computed fields.
 * DB trigger handles: recomputing name fields + logging changes.
 *
 * @param {object} db
 * @param {number} contactId
 * @param {object} fields - column: value pairs
 * @returns {{ contact_id: number, updated_fields: string[] }}
 */
async function updateContact(db, contactId, fields) {
  if (!fields || !Object.keys(fields).length) {
    throw new Error('updateContact requires at least one field');
  }

  const ALLOWED = new Set([
    'contact_type', 'contact_fname', 'contact_mname', 'contact_lname',
    'contact_pname', 'contact_phone', 'contact_email',
    'contact_address', 'contact_city', 'contact_state', 'contact_zip',
    'contact_dob', 'contact_marital_status', 'contact_ssn',
    'contact_tags', 'contact_notes', 'contact_clio_id',
    'contact_phone2', 'contact_email2'
  ]);

  const keys = Object.keys(fields);
  const blocked = keys.filter(k => !ALLOWED.has(k));
  if (blocked.length) {
    throw new Error(`updateContact: blocked columns: ${blocked.join(', ')}`);
  }

  // Normalize phone fields if present
  const normalized = { ...fields };
  if (normalized.contact_phone)  normalized.contact_phone  = normalizePhone(normalized.contact_phone);
  if (normalized.contact_phone2) normalized.contact_phone2 = normalizePhone(normalized.contact_phone2);

  const finalKeys = Object.keys(normalized);
  const setClauses = finalKeys.map(k => `\`${k}\` = ?`).join(', ');
  const values = [...finalKeys.map(k => normalized[k]), contactId];

  const [result] = await db.query(
    `UPDATE contacts SET ${setClauses}, contact_updated = NOW() WHERE contact_id = ?`,
    values
  );

  if (result.affectedRows === 0) {
    throw new Error(`Contact ${contactId} not found`);
  }

  return { contact_id: contactId, updated_fields: finalKeys };
}

/**
 * List sequence enrollments for a contact with pagination, status filter,
 * and active/all scope. Envelope-parity with Slices 1–2 ({success, ...}),
 * plus `active_total` so the UI header can read "N active of M total"
 * when `?scope=all`.
 *
 * @param {object} db
 * @param {number|string} contactId
 * @param {object}  [opts]
 * @param {number}  [opts.limit=50]      max 200
 * @param {number}  [opts.offset=0]
 * @param {string|null} [opts.status=null]  'active' | 'completed' | 'cancelled'
 * @param {string}  [opts.scope='active']  'active' (filter to active) or 'all'
 *                                         Ignored when `status` is supplied —
 *                                         explicit > defaulted.
 * @returns {Promise<{sequences, total, active_total} | null>}
 *          Returns null when the contact doesn't exist (route → 404).
 */
async function listContactSequences(db, contactId, {
  limit  = 50,
  offset = 0,
  status = null,
  scope  = 'active',
} = {}) {
  // Confirm the contact exists so the route can 404 vs returning an empty
  // list (which would mask "no such contact" as "no enrollments").
  const [[row]] = await db.query(
    `SELECT contact_id FROM contacts WHERE contact_id = ?`,
    [contactId]
  );
  if (!row) return null;
 
  // Explicit status overrides scope. scope='active' is the default filter.
  const effectiveStatus = status || (scope === 'active' ? 'active' : null);
 
  const whereParts  = ['se.contact_id = ?'];
  const whereParams = [contactId];
  if (effectiveStatus) {
    whereParts.push('se.status = ?');
    whereParams.push(effectiveStatus);
  }
  const whereSQL = whereParts.join(' AND ');
 
  // `se.id AS enrollment_id` — frontend reads enrollment_id; aliasing here
  // keeps the UI self-documenting and matches the label the old (broken)
  // putSeq was already reading.
  const [sequences] = await db.query(
    `SELECT
       se.id           AS enrollment_id,
       se.template_id,
       se.status,
       se.current_step,
       se.total_steps,
       se.cancel_reason,
       se.enrolled_at,
       se.completed_at,
       se.updated_at,
       st.name         AS template_name,
       st.type         AS template_type
     FROM sequence_enrollments se
     JOIN sequence_templates st ON st.id = se.template_id
     WHERE ${whereSQL}
     ORDER BY se.enrolled_at DESC
     LIMIT ? OFFSET ?`,
    [...whereParams, parseInt(limit, 10), parseInt(offset, 10)]
  );
 
  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM sequence_enrollments se WHERE ${whereSQL}`,
    whereParams
  );
 
  // Always compute active_total (regardless of current filter) so the UI
  // can render "N active of M total" when ?scope=all.
  const [[{ active_total }]] = await db.query(
    `SELECT COUNT(*) AS active_total
       FROM sequence_enrollments
      WHERE contact_id = ? AND status = 'active'`,
    [contactId]
  );
 
  return { sequences, total, active_total };
}
 
module.exports = {
  listContacts,
  getContact,
  createContact,
  updateContact,
  normalizePhone,
  listContactSequences,
  stripSsn
};