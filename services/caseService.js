// services/caseService.js
//
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
 * Slice 1 (log reader semantic unification):
 *   - getCase's log block now delegates to logService._buildCaseLogWhere,
 *     which produces the same WHERE fragment used by
 *     /api/log?link_type=case&link_id=... The case log view includes
 *     case-typed rows (matched on case_id/case_number/case_number_full),
 *     legacy NULL-typed rows, and every related contact's contact-view
 *     fragment (contact-typed + NULL-typed + date-windowed phone/email),
 *     gated by `relateFilter`.
 *
 * Usage:
 *   const caseService = require('../services/caseService');
 *   const result = await caseService.getCase(db, 'uT7EU36v');
 */

const crypto = require('crypto');
const { stripSsn } = require('./contactService');
const logService = require('./logService');


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

const DEFAULT_LOG_LIMIT = 200;

/**
 * Fetch a single case, optionally with related entities.
 *
 * @param {object} db
 * @param {string} caseId
 * @param {string} [include] — comma-separated: 'contacts,appts,tasks,log'
 *                              If omitted/empty → returns ONLY the case row
 * @param {object} [opts]
 * @param {number} [opts.logLimit] — max log rows to return (default: DEFAULT_LOG_LIMIT)
 * @param {string} [opts.relateFilter='default']
 *   Controls which related contacts merge into the case log view.
 *   'default' = Primary/Secondary/Other; 'all' = include Bystander;
 *   'none' = case-scope only (no related-contact merge).
 *   Only meaningful when `include` contains 'log'.
 * @returns {object|null} null if case not found
 */
async function getCase(db, caseId, include = '', {
  logLimit = DEFAULT_LOG_LIMIT,
  relateFilter = 'default'
} = {}) {
  // 1) Case record (always fetched)
  const [[caseRow]] = await db.query(
    'SELECT * FROM cases WHERE case_id = ?',
    [caseId]
  );
  if (!caseRow) return null;

  const result = { case: caseRow };

  // Parse include param
  const parts = include
    ? include.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : [];

  // 2) Clients via case_relate
  //    Also fetched silently when tasks are requested (need clientIds for task lookup)
  const needClients = parts.includes('contacts') || parts.includes('clients');
  const needTasks   = parts.includes('tasks');

  let clients = [];
  if (needClients || needTasks) {
    const [clientsRaw] = await db.query(
      `SELECT
         co.*,
         IFNULL(DATE_FORMAT(co.contact_dob, '%b. %e, %Y'), '') AS dob,
         cr.case_relate_id AS relate_id, cr.case_relate_type AS relate_type
       FROM contacts co
       JOIN case_relate cr ON co.contact_id = cr.case_relate_client_id
       WHERE cr.case_relate_case_id = ?`,
      [caseId]
    );
    clients = clientsRaw;
    // Only include in response if explicitly requested
    if (needClients) {
      result.clients = clients;
    }
  }

  // 3) Appointments
  if (parts.includes('appts')) {
    const [appts] = await db.query(
      `SELECT
         a.*,
         DATE_FORMAT(a.appt_date, '%Y-%m-%dT%H:%i') AS appt_datetime_local,
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
    result.appts = appts;
  }

  // 4) Tasks linked to this case OR to any of its clients
  if (needTasks) {
    const clientIds = clients.map(c => c.contact_id);

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
      result.tasks = taskRows;
    } else {
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
      result.tasks = taskRows;
    }
  }

  // 5) Log entries — Slice 1: delegated to logService._buildCaseLogWhere
  //    so case view = case-scope + each related contact's contact view,
  //    consistent with /api/log?link_type=case.
  //
  //    Slice 4 (entity hydration): SELECT + JOIN tree brought up to
  //    listLog parity. Related-contact rows merged into the case view
  //    (especially phone/email-typed ones) now arrive with
  //    contact_id/contact_name populated. Renderers consuming this
  //    payload (currently dormant — entity-view log tabs hit /api/log
  //    directly) get the same fields the global feed gets.
  //
  //    Pre-existing dup-case-number caveat: the triple-OR cases JOIN
  //    can multiply rows when two cases share case_number_full (data
  //    debt — e.g., cM8YEx2y / oGr6rJN9 share '24-48600-tjt'). This
  //    JOIN existed in listLog already; bringing it into getCase makes
  //    the latent drift visible if a renderer consumes data.log. Today
  //    nothing does, so the drift is dormant. Surfacing for awareness.
  if (parts.includes('log')) {
    const { whereFragment, params: logWhereParams } =
      await logService._buildCaseLogWhere(db, caseId, { relateFilter });
    const [log] = await db.query(
      `SELECT
         l.log_id, l.log_type, l.log_date, l.log_link, l.log_extra,
         l.log_link_type, l.log_link_id, l.log_by, l.log_data,
         l.log_from, l.log_to, l.log_subject, l.log_direction,
         u.user_name AS by_name,
         DATE_FORMAT(l.log_date, '%M %e, %Y at %h:%i %p') AS formatted_date,
         COALESCE(c.contact_name, c_phone.contact_name, c_email.contact_name) AS contact_name,
         COALESCE(c.contact_id,   c_phone.contact_id,   c_email.contact_id)   AS contact_id,
         ca.case_id,
         COALESCE(ca.case_number_full, ca.case_number) AS case_number
       FROM log l
       LEFT JOIN users    u  ON l.log_by = u.user
       LEFT JOIN contacts c  ON l.log_link = c.contact_id
                            AND (l.log_link_type = 'contact' OR l.log_link_type IS NULL)
       LEFT JOIN cases    ca ON (l.log_link = ca.case_id
                                 OR l.log_link = ca.case_number
                                 OR l.log_link = ca.case_number_full)
                             AND l.log_link != ''
                             AND (l.log_link_type = 'case' OR l.log_link_type IS NULL)
       LEFT JOIN contact_phones cp ON l.log_link_type = 'phone'
                                  AND cp.phone        = l.log_link_id
                                  AND (cp.start_date IS NULL OR cp.start_date <= DATE(l.log_date))
                                  AND (cp.end_date   IS NULL OR cp.end_date   >= DATE(l.log_date))
       LEFT JOIN contacts c_phone  ON c_phone.contact_id = cp.contact_id
       LEFT JOIN contact_emails ce ON l.log_link_type = 'email'
                                  AND ce.email        = l.log_link_id
                                  AND (ce.start_date IS NULL OR ce.start_date <= DATE(l.log_date))
                                  AND (ce.end_date   IS NULL OR ce.end_date   >= DATE(l.log_date))
       LEFT JOIN contacts c_email  ON c_email.contact_id = ce.contact_id
       WHERE ${whereFragment}
       ORDER BY l.log_date DESC
       LIMIT ?`,
      [...logWhereParams, logLimit]
    );
    result.log = log;
  }

  return result;
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

/**
 * Fetch the contacts related to a case (via case_relate), in a minimal shape
 * suitable for pickers/selects. Mirrors getCase's "clients" include but as a
 * standalone, lightweight query — does NOT load the case row or other
 * sub-entities.
 *
 * Returns rows ordered Primary → Secondary → Other → Bystander, then by name,
 * so a "default to Primary" caller can just take the first row.
 *
 * @param {object} db
 * @param {string} caseId
 * @returns {Promise<Array<{contact_id, contact_name, contact_phone, contact_email, relate_type, relate_id}>>}
 */
async function getCaseContacts(db, caseId) {
  const [rows] = await db.query(
    `SELECT
       co.contact_id,
       co.contact_name,
       co.contact_phone,
       co.contact_email,
       cr.case_relate_type AS relate_type,
       cr.case_relate_id   AS relate_id
     FROM case_relate cr
     JOIN contacts co ON co.contact_id = cr.case_relate_client_id
     WHERE cr.case_relate_case_id = ?
     ORDER BY FIELD(cr.case_relate_type, 'Primary','Secondary','Other','Bystander'),
              co.contact_name`,
    [caseId]
  );
  return rows;
}


// ─────────────────────────────────────────────────────────────
// checkCaseNumberCollision  (Phase 4.1 — adopt-existing)
// ─────────────────────────────────────────────────────────────

/**
 * Collision check for the docket-adopt flow.
 *
 * SHAPE-AGNOSTIC. case_number / case_number_full are opaque free-text
 * varchar(20). This function never parses docket shape — it checks string
 * EQUALITY only. The ##-#####-@@@ docket shape is bankruptcy-specific domain
 * knowledge that lives client-side (splitDocket); the server treats both
 * columns as opaque strings.
 *
 * For each non-empty submitted value, looks for ANY OTHER case
 * (case_id <> :caseId) that already holds that value in EITHER the
 * case_number OR the case_number_full column. Returns the first conflicting
 * row, or null when the docket is free to adopt.
 *
 * NOTE: this is a separate, route-facing guard — it is deliberately NOT folded
 * into updateCase (a generic column setter used by many callers). The route
 * runs this first, then writes via updateCase only on a clean check.
 *
 * @param {object} db
 * @param {string} caseId            - the target case (excluded from the search)
 * @param {object} vals
 * @param {?string} vals.case_number
 * @param {?string} vals.case_number_full
 * @returns {Promise<?object>} conflicting row
 *   { case_id, case_number, case_number_full, case_type } or null
 */
async function checkCaseNumberCollision(db, caseId, { case_number = null, case_number_full = null } = {}) {
  // Normalize: trim, treat empty as absent. No shape parsing.
  const submitted = [case_number, case_number_full]
    .map(v => (v == null ? '' : String(v).trim()))
    .filter(v => v !== '');

  // De-dupe (full === short would otherwise produce 2 identical placeholders)
  const uniq = [...new Set(submitted)];
  if (!uniq.length) return null;

  const placeholders = uniq.map(() => '?').join(', ');

  const [rows] = await db.query(
    `SELECT case_id, case_number, case_number_full, case_type
       FROM cases
      WHERE case_id <> ?
        AND ( (case_number      IS NOT NULL AND case_number      <> '' AND case_number      IN (${placeholders}))
           OR (case_number_full IS NOT NULL AND case_number_full <> '' AND case_number_full IN (${placeholders})) )
      LIMIT 1`,
    [caseId, ...uniq, ...uniq]
  );

  return rows.length ? rows[0] : null;
}


// ─────────────────────────────────────────────────────────────
// searchCases
// ─────────────────────────────────────────────────────────────

/**
 * Typeahead case search for the CasePicker primitive (Phase 3).
 *
 * Deliberately SEPARATE from listCases — do not converge them later.
 * listCases is display-oriented: it coalesces case_number_full/case_number/
 * case_id into a single `case_number` alias and aggregates ALL related
 * contacts via JSON_ARRAYAGG. The picker needs neither — it needs the raw
 * case_number and case_number_full as distinct fields plus a single Primary
 * contact. Two different consumers, two different shapes.
 *
 * Search targets (combined with OR):
 *   - case_id           exact match on the typed query
 *   - case_number       LIKE %q%
 *   - case_number_full  LIKE %q%
 *   - Primary contact name LIKE %q% (EXISTS subquery)
 *
 * Primary contact is resolved via a pre-aggregated subquery picking
 * MIN(case_relate_client_id) among 'Primary' relations. This is
 * deterministic (lowest contact_id), stable across calls, and
 * ONLY_FULL_GROUP_BY-clean: every selected column is either a base column of
 * `cases` (functionally dependent on its PK), or comes from the pre-grouped
 * subquery `p`, or from `contacts pc` keyed on its PK via p.primary_contact_id.
 * No outer GROUP BY is needed because no join in the SELECT can multiply rows:
 *   - `p` is grouped by case_relate_case_id (one row per case)
 *   - `pc` joins on its PK (one row)
 * The name-match lives in an EXISTS subquery in the WHERE clause, so it never
 * contributes rows to the result set.
 *
 * Note on multiple Primaries: case_relate's UNIQUE KEY is
 * (case_id, contact_id, type), so a single contact can't be Primary twice on a
 * case — but two DIFFERENT contacts can both be Primary. MIN(contact_id) picks
 * deterministically among them. If the firm later needs "the actual lead
 * debtor" semantics, that's a data-model change (e.g. a case_relate.is_lead
 * flag), not a search-query change.
 *
 * @param {object} db
 * @param {object} opts
 * @param {string} [opts.q]       - search term; empty/blank → no fetch
 * @param {number} [opts.limit=20] - capped at 50
 * @returns {{ cases: object[], total: number }}
 */
async function searchCases(db, { q = '', limit = 20 } = {}) {
  q = (q == null ? '' : String(q)).trim();
  if (!q) return { cases: [], total: 0 };

  let lim = parseInt(limit, 10);
  if (!Number.isInteger(lim) || lim <= 0) lim = 20;
  if (lim > 50) lim = 50;

  const like = `%${q}%`;

  const [cases] = await db.query(
    `SELECT
       c.case_id,
       c.case_number,
       c.case_number_full,
       c.case_type,
       c.case_chapter,
       c.case_stage,
       pc.contact_id   AS primary_contact_id,
       pc.contact_name AS primary_contact_name
     FROM cases c
     LEFT JOIN (
       SELECT case_relate_case_id, MIN(case_relate_client_id) AS primary_contact_id
         FROM case_relate
        WHERE case_relate_type = 'Primary'
        GROUP BY case_relate_case_id
     ) p ON p.case_relate_case_id = c.case_id
     LEFT JOIN contacts pc ON pc.contact_id = p.primary_contact_id
     WHERE c.case_id = ?
        OR c.case_number      LIKE ?
        OR c.case_number_full LIKE ?
        OR EXISTS (
             SELECT 1
               FROM case_relate cr2
               JOIN contacts co2 ON co2.contact_id = cr2.case_relate_client_id
              WHERE cr2.case_relate_case_id = c.case_id
                AND cr2.case_relate_type = 'Primary'
                AND co2.contact_name LIKE ?
           )
     ORDER BY (c.case_stage = 'Open') DESC, c.case_open_date DESC, c.case_id DESC
     LIMIT ?`,
    [q, like, like, like, lim]
  );

  return { cases, total: cases.length };
}


module.exports = {
  listCases,
  getCase,
  updateCase,
  addCaseContact,
  removeCaseContact,
  getCaseContacts,
  searchCases,
  checkCaseNumberCollision
};