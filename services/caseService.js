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
 *   - No DELETE for cases (legal records). SANCTIONED EXCEPTION: mergeCases
 *     deletes the absorbed case AFTER snapshotting its full row into the
 *     survivor's log (log_extra) — the record survives, attached to the case
 *     that absorbed it.
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
const { blankDatesToNull } = require('../lib/blankDateToNull');


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
 * @param {string}  [opts.subtype]     - case_subtype filter (EXACT match;
 *                                       only applied when non-empty — there is
 *                                       deliberately no '%'-means-all here)
 * @param {string}  [opts.stage]       - case_stage filter (use '%' for all)
 * @param {string}  [opts.status]      - case_status filter (use '%' for all)
 * @param {number}  [opts.limit=50]
 * @param {number}  [opts.offset=0]
 * @returns {{ cases: object[], total: number }}
 */
async function listCases(db, {
  query  = '',
  type   = '%',
  subtype = '',
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
  // Subtype (2026-06 type/subtype split) is EXACT match, applied only when
  // present — values are opaque free text and may legitimately contain '%'.
  if (subtype != null && subtype !== '') {
    where.push('c.case_subtype = ?');
    params.push(subtype);
  }
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
     c.case_caption,
     c.case_type, c.case_subtype, c.case_stage, c.case_status,
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

  // Blank date -> NULL. This UPDATE writes caller values verbatim, and the
  // session sql_mode has no STRICT_TRANS_TABLES, so '' on a DATE column would
  // silently become '0000-00-00' — which reads back as 1899-11-30 and is then
  // indistinguishable from a real date. See lib/blankDateToNull.js.
  const safeFields = blankDatesToNull('cases', fields);

  const setClauses = keys.map(k => `\`${k}\` = ?`).join(', ');
  const values = [...keys.map(k => safeFields[k]), caseId];

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
 *   - case_caption      LIKE %q%
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
       c.case_caption,
       c.case_type,
       c.case_subtype,
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
        OR c.case_caption     LIKE ?
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
    [q, like, like, like, like, lim]
  );

  return { cases, total: cases.length };
}


// ─────────────────────────────────────────────────────────────
// Dropbox case-folder convention + ensure
// ─────────────────────────────────────────────────────────────
//
// One operation — ensureCaseDropboxFolder — guarantees a case has a Dropbox
// folder and a shared link saved in cases.case_dropbox. Called from:
//   - routes/api.intake.js        (post-response, after case creation)
//   - routes/internal/dropbox.js  (the case-page "Create Dropbox Folder"
//                                  repair button — shown when case_dropbox
//                                  is empty)
//   - internal function dropbox_ensure_case_folder (workflows; e.g. the
//     Voluntary Petition pipeline for filed cases that never got a folder)
//
// STAGE-AWARE: a case with a docket number (case_number or case_number_full,
// per filing convention short form lands first) is 'active' and gets the
// Active-tree convention + the four staff subfolders; otherwise 'potential'.
// This replaces the old Pabbly behavior of always creating in Potential-BK.
//
// Templates live in app_settings 'dropbox_case_folder_templates' — a JSON
// map keyed by stage, each stage holding per-case_type templates, a
// "default", and a "subfolders" array:
//   {
//     "potential": { "default": "...", "Bankruptcy": "...", "subfolders": [...] },
//     "active":    { "default": "...", "subfolders": [...] }
//   }
// Resolution per stage, most-specific first:
//   map[stage]["Type:Subtype"] ?? map[stage]["Type"] ?? map[stage].default ??
//   hardcoded default; subfolders: map[stage].subfolders ?? hardcoded.
// Composite keys use a colon, e.g. "Bankruptcy:Chapter 7". Note that within
// one template {{case_subtype}} already varies per case — composite keys are
// only needed when the path STRUCTURE differs by subtype.
// No settings row → the constants below. Convention changes are a settings
// edit, not a deploy.
//
// LEADING SPACES IN TEMPLATES ARE SIGNIFICANT (the firm's manual-sort
// convention, e.g. "/  Law Office/   Cases/") — never trim or "clean" them,
// in templates or in substituted values.
//
// Placeholders: {{case_id}} {{case_type}} {{case_subtype}} {{case_number}}
// {{case_number_full}} {{number}} (full ‖ short ‖ case_id) {{lfm_name}}
// {{contact_name}} {{date}} (firm-local YYYY-MM-DD). Unknown placeholders
// pass through literally (visible in the folder name — easy to spot).

const DEFAULT_CASE_FOLDER_TEMPLATES = {
  potential: {
    default: "/  Law Office/   Cases/  Potential Cases/  Potential - {{case_type}}/ {{lfm_name}} - {{case_id}} - {{date}}",
    subfolders: ["Client Uploads"],
  },
  active: {
    default: "/  Law Office/   Cases/  Active Cases/  Active - {{case_type}}/ {{case_id}} - {{lfm_name}} - {{number}} - {{case_subtype}}",
    subfolders: [
      "Docket - {{contact_name}} - {{case_subtype}} - {{case_number}}",
      "Drafts - {{contact_name}}",
      "Client Docs - {{contact_name}}",
      "Correspondence - {{contact_name}}",
    ],
  },
};

function _substituteTemplate(template, values) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (m, key) => (key in values ? values[key] : m));
}

async function _loadCaseFolderTemplates(db) {
  try {
    const [[row]] = await db.query(
      "SELECT `value` FROM app_settings WHERE `key` = 'dropbox_case_folder_templates' LIMIT 1"
    );
    if (row?.value) {
      const map = JSON.parse(row.value);
      if (map && typeof map === 'object') return map;
    }
  } catch (err) {
    console.warn(`[CASE_DROPBOX] dropbox_case_folder_templates lookup failed, using defaults: ${err.message}`);
  }
  return {};
}

/**
 * Ensure a case has a Dropbox folder + shared link in cases.case_dropbox.
 * Stage-aware (potential vs active by docket-number presence). Idempotent:
 * if case_dropbox is already set, returns it without touching Dropbox
 * (pass force: true to create anyway and overwrite the saved link).
 *
 * Names come from the case's PRIMARY contact (case_relate_type 'Primary',
 * falling back to the lowest contact id — the petition-intake convention).
 *
 * @param {object} db
 * @param {string} caseId
 * @param {object} [opts] — { force?: boolean }
 * @returns {Promise<{existed:boolean, stage:string|null, path:string|null,
 *                    shared_link:string|null, folder_existed?:boolean,
 *                    subfolders_created?:Array}>}
 * @throws on unknown case, Dropbox failure, or missing shared link
 */
async function ensureCaseDropboxFolder(db, caseId, { force = false } = {}) {
  const dropboxService = require('./dropboxService');     // deferred require (convention)
  const { nowLocal } = require('./timezoneService');

  const [[caseRow]] = await db.query(
    `SELECT case_id, case_type, case_subtype, case_number, case_number_full, case_dropbox
       FROM cases WHERE case_id = ?`,
    [caseId]
  );
  if (!caseRow) throw new Error(`ensureCaseDropboxFolder: case ${caseId} not found`);

  if (caseRow.case_dropbox && !force) {
    return { existed: true, stage: null, path: null, shared_link: caseRow.case_dropbox };
  }

  const [[contact]] = await db.query(
    `SELECT c.contact_name, c.contact_lfm_name
       FROM case_relate cr
       JOIN contacts c ON c.contact_id = cr.case_relate_client_id
      WHERE cr.case_relate_case_id = ?
      ORDER BY (cr.case_relate_type = 'Primary') DESC, cr.case_relate_client_id ASC
      LIMIT 1`,
    [caseId]
  );

  const shortNum = caseRow.case_number || '';
  const fullNum  = caseRow.case_number_full || '';
  const stage    = (shortNum || fullNum) ? 'active' : 'potential';

  const values = {
    case_id:          caseRow.case_id,
    case_type:        caseRow.case_type || 'Other',
    case_subtype:     caseRow.case_subtype || '',
    case_number:      shortNum,
    case_number_full: fullNum,
    number:           fullNum || shortNum || caseRow.case_id,
    lfm_name:         contact?.contact_lfm_name || 'Unknown',
    contact_name:     contact?.contact_name || 'Unknown',
    date:             nowLocal().toFormat('yyyy-LL-dd'),
  };

  const settingsMap = await _loadCaseFolderTemplates(db);
  const stageMap    = settingsMap[stage] || {};
  const template    = stageMap[`${values.case_type}:${values.case_subtype}`]
                   ?? stageMap[values.case_type]
                   ?? stageMap.default
                   ?? DEFAULT_CASE_FOLDER_TEMPLATES[stage].default;
  const subTemplates = Array.isArray(stageMap.subfolders)
    ? stageMap.subfolders
    : DEFAULT_CASE_FOLDER_TEMPLATES[stage].subfolders;

  const path       = _substituteTemplate(template, values);
  const subfolders = subTemplates.map((t) => _substituteTemplate(t, values));

  const result = await dropboxService.createFolderWithOptions(db, {
    path,
    subfolders,
    shareLink: true,
  });
  if (!result.shared_link) {
    throw new Error(`ensureCaseDropboxFolder: folder created at "${result.path}" but no shared link returned`);
  }

  await db.query(
    'UPDATE cases SET case_dropbox = ? WHERE case_id = ?',
    [result.shared_link, caseId]
  );

  console.log(`[CASE_DROPBOX] ${stage} folder ensured for case ${caseId}: ${result.path}${result.existed ? ' (folder pre-existed)' : ''}`);
  return {
    existed: false,
    stage,
    path: result.path,
    shared_link: result.shared_link,
    folder_existed: result.existed,
    subfolders_created: result.subfolders_created,
  };
}



// ─────────────────────────────────────────────────────────────
// listCaseSequences / listCaseWorkflows
// ─────────────────────────────────────────────────────────────
//
// Case-scoped automation lists. Neither sequence_enrollments nor
// workflow_executions carries a case_id — both are contact-scoped — so
// "the case's automations" is defined as the union of automations for the
// case's related contacts, resolved via case_relate. Same aggregation
// convention as the case log view (logService._buildCaseLogWhere, default
// relateFilter) and the tasks include in getCase step 4: relate types
// Primary/Secondary/Other, Bystander excluded.
//
// Row shapes mirror contactService.listContactSequences /
// listContactWorkflows exactly, plus contact_id + contact_name (a case can
// have several related contacts, so each row must say whose automation it
// is). Consumed by public/automation/automationsWidget.html in case mode;
// the contact-scoped twins in contactService stay untouched and serve the
// same widget in contact mode.

const CASE_AUTOMATION_RELATE_TYPES = ['Primary', 'Secondary', 'Other'];

/**
 * Resolve the contact ids whose automations count as "this case's".
 * @returns {number[]|null} null if the case doesn't exist (route 404s);
 *   [] if the case has no qualifying related contacts.
 */
async function _caseAutomationContactIds(db, caseId) {
  const [[caseRow]] = await db.query(
    'SELECT case_id FROM cases WHERE case_id = ?',
    [caseId]
  );
  if (!caseRow) return null;

  const [rels] = await db.query(
    `SELECT case_relate_client_id
       FROM case_relate
      WHERE case_relate_case_id = ?
        AND case_relate_type IN (?)`,
    [caseId, CASE_AUTOMATION_RELATE_TYPES]
  );
  return rels.map(r => r.case_relate_client_id);
}

/**
 * Sequence enrollments across the case's related contacts.
 * Params + envelope mirror contactService.listContactSequences:
 *   { sequences, total, active_total } — rows add contact_id, contact_name.
 */
async function listCaseSequences(db, caseId, {
  limit  = 50,
  offset = 0,
  status = null,
  scope  = 'active',
} = {}) {
  const clientIds = await _caseAutomationContactIds(db, caseId);
  if (clientIds === null) return null;
  if (!clientIds.length)  return { sequences: [], total: 0, active_total: 0 };

  const effectiveStatus = status || (scope === 'active' ? 'active' : null);

  const whereParts  = ['se.contact_id IN (?)'];
  const whereParams = [clientIds];
  if (effectiveStatus) {
    whereParts.push('se.status = ?');
    whereParams.push(effectiveStatus);
  }
  const whereSQL = whereParts.join(' AND ');

  const [sequences] = await db.query(
    `SELECT
       se.id           AS enrollment_id,
       se.template_id,
       se.contact_id,
       co.contact_name,
       se.status,
       se.current_step,
       se.total_steps,
       se.cancel_reason,
       se.enrolled_at,
       se.completed_at,
       se.updated_at,
       st.name         AS template_name,
       st.type         AS template_type,
       (SELECT MIN(sj.scheduled_time)
          FROM scheduled_jobs sj
         WHERE sj.sequence_enrollment_id = se.id
           AND sj.status = 'pending') AS next_step_at
     FROM sequence_enrollments se
     JOIN sequence_templates st ON st.id = se.template_id
     LEFT JOIN contacts co      ON co.contact_id = se.contact_id
     WHERE ${whereSQL}
     ORDER BY se.enrolled_at DESC
     LIMIT ? OFFSET ?`,
    [...whereParams, parseInt(limit, 10), parseInt(offset, 10)]
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM sequence_enrollments se WHERE ${whereSQL}`,
    whereParams
  );

  const [[{ active_total }]] = await db.query(
    `SELECT COUNT(*) AS active_total
       FROM sequence_enrollments
      WHERE contact_id IN (?) AND status = 'active'`,
    [clientIds]
  );

  return { sequences, total, active_total };
}

/**
 * Workflow executions across the case's related contacts.
 * Params + envelope mirror contactService.listContactWorkflows:
 *   { workflows, total, active_total } — rows add contact_id, contact_name.
 * Executions that were never contact-tied (contact_id NULL — see
 * lib/workflow_engine.js resolveExecutionContactId) don't appear here,
 * exactly as on the contact view.
 */
async function listCaseWorkflows(db, caseId, {
  limit  = 50,
  offset = 0,
  status = null,
  scope  = 'active',
} = {}) {
  const clientIds = await _caseAutomationContactIds(db, caseId);
  if (clientIds === null) return null;
  if (!clientIds.length)  return { workflows: [], total: 0, active_total: 0 };

  // 'held' (intercept-parked, capture slice) is excluded on purpose — it's an
  // operator diagnostic state, not client automation in flight.
  const NON_TERMINAL = ['active', 'processing', 'delayed'];

  const whereParts  = ['we.contact_id IN (?)'];
  const whereParams = [clientIds];
  if (status) {
    whereParts.push('we.status = ?');
    whereParams.push(status);
  } else if (scope === 'active') {
    whereParts.push('we.status IN (?)');
    whereParams.push(NON_TERMINAL);
  }
  const whereSQL = whereParts.join(' AND ');

  const [workflows] = await db.query(
    `SELECT
       we.id                     AS execution_id,
       we.workflow_id,
       we.contact_id,
       co.contact_name,
       we.status,
       we.current_step_number,
       we.steps_executed_count,
       we.cancel_reason,
       we.created_at,
       we.updated_at,
       we.completed_at,
       w.name                    AS workflow_name
     FROM workflow_executions we
     LEFT JOIN workflows w  ON w.id = we.workflow_id
     LEFT JOIN contacts  co ON co.contact_id = we.contact_id
     WHERE ${whereSQL}
     ORDER BY we.created_at DESC
     LIMIT ? OFFSET ?`,
    [...whereParams, parseInt(limit, 10), parseInt(offset, 10)]
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM workflow_executions we WHERE ${whereSQL}`,
    whereParams
  );

  const [[{ active_total }]] = await db.query(
    `SELECT COUNT(*) AS active_total
       FROM workflow_executions
      WHERE contact_id IN (?) AND status IN (?)`,
    [clientIds, NON_TERMINAL]
  );

  return { workflows, total, active_total };
}

// ─────────────────────────────────────────────────────────────
// mergeCases  (2026-08 — case merge)
// ─────────────────────────────────────────────────────────────

/**
 * Merge (absorb) case `loserId` into case `survivorId`.
 *
 * WHY THIS EXISTS: the recurring data shape is a docketless "lead" case
 * (intake info, dropbox, clio_matter) sitting beside the docketed case it
 * became. Merge repoints every child record, additively fills the survivor's
 * empty columns from the loser, snapshots the loser row into the survivor's
 * log, and deletes the loser.
 *
 * SURVIVOR RULE (docket identity is dual): app children link by case_id, but
 * log rows and 'case_number'-typed events resolve by DOCKET STRING at read
 * time — they cannot be repointed to a different case_id. Therefore:
 *   - If both cases carry a non-empty value in the SAME docket column
 *     (case_number or case_number_full) and the values differ → 409 refuse.
 *     Different dockets = different court cases. Never merged.
 *   - If the loser holds docket values the survivor lacks, they are adopted
 *     onto the survivor (collision-checked against all OTHER cases —
 *     excluding both participants). Docket-form log rows and case_number
 *     events then follow the string automatically.
 *
 * FIELD MERGE IS ADDITIVE (same principle as CaseAdoptDialog): fill
 * survivor's empty columns from loser; never overwrite non-empty.
 *   - Empty = NULL, '', or 0 for numeric columns.
 *   - Conflicts (both non-empty, different) BLOCK the merge (409 with the
 *     conflict list) unless `force` — force means survivor-wins, and the
 *     losing values are still preserved in the snapshot.
 *   - EXCEPT lifecycle columns case_stage / case_status / case_open_date:
 *     these differ on virtually every real merge pair (Open lead vs Filed
 *     case), so they are survivor-wins BY DESIGN — reported, never blocking.
 *   - case_notes / case_alerts: concatenated with a provenance separator.
 *   - case_dropbox: folders can't be merged server-side. Survivor keeps its
 *     own; a differing loser folder URL is appended to case_notes so the
 *     link is never lost.
 *
 * CHILD REPOINTS (loser case_id → survivor case_id), all in one InnoDB
 * transaction:
 *   case_relate      — uniqueness trigger (SQLSTATE 45000) blocks dupes, so
 *                      loser rows whose (client, type) already exist on the
 *                      survivor are DELETEd first, the rest UPDATEd.
 *   appts            — appt_case_id
 *   tasks            — task_link_id  WHERE task_link_type='case'
 *   checklists       — link          WHERE link_type='case'
 *   events           — event_link_id WHERE event_link_type='case'
 *                      ('case_number' rows follow the docket — no touch)
 *   log              — log_link_id + log_link WHERE log_link_type='case'
 *                      AND log_link_id = loser case_id
 *                      (docket-form rows follow the docket — no touch)
 *   form_submissions — link_id       WHERE link_type='case'
 *   signing_requests — linkable_id   WHERE linkable_type='case'
 *   sequences        — seq_case
 *   court_ai_log     — resolved_case_id
 *   video_views      — case_id
 *   ai_change_log    — entity_id     WHERE entity_type='case'
 *
 * LOSER DISPOSITION: full row JSON + move counts snapshotted via
 * logService.createLogEntry (type 'update', link_type 'case', link_id =
 * survivor; snapshot in log_extra) — THEN hard-deleted. This is the sanctioned
 * exception to the "no DELETE for cases" rule: the legal record survives in
 * the snapshot, attached to the case that absorbed it.
 *
 * @param {object} db          mysql2 promise pool
 * @param {string} survivorId  case that remains
 * @param {string} loserId     case that is absorbed and deleted
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]  compute the full plan, write nothing
 * @param {boolean} [opts.force=false]   proceed despite blocking conflicts
 *                                       (survivor-wins on those columns)
 * @param {number}  [opts.by=0]          user id for the snapshot log entry
 * @returns {object} {
 *   dry_run, survivor_id, loser_id,
 *   docket:   { adopted: {col: value} },
 *   fields:   { filled: [col…], survivor_wins: [{column,survivor,loser}…],
 *               conflicts: [{column,survivor,loser}…] },   // blocking set
 *   notes_appended, alerts_appended, dropbox_noted,
 *   children: { table: rowCount, … , case_relate_deduped }
 * }
 * Throws err with .code:
 *   'MERGE_NOT_FOUND'  — either case missing
 *   'MERGE_SELF'       — survivor === loser
 *   'MERGE_DOCKET'     — both hold differing non-empty values in the same
 *                        docket column, OR adopt collision with a third case
 *   'MERGE_CONFLICT'   — blocking field conflicts and !force
 *                        (err.conflicts carries the list)
 */
async function mergeCases(db, survivorId, loserId, { dryRun = false, force = false, by = 0 } = {}) {
  if (!survivorId || !loserId) throw new Error('mergeCases requires survivorId and loserId');
  if (survivorId === loserId) {
    const e = new Error('Cannot merge a case into itself');
    e.code = 'MERGE_SELF';
    throw e;
  }

  const [rows] = await db.query(
    'SELECT * FROM cases WHERE case_id IN (?, ?)',
    [survivorId, loserId]
  );
  const survivor = rows.find(r => r.case_id === survivorId);
  const loser    = rows.find(r => r.case_id === loserId);
  if (!survivor || !loser) {
    const e = new Error(`Case not found: ${!survivor ? survivorId : loserId}`);
    e.code = 'MERGE_NOT_FOUND';
    throw e;
  }

  // ── helpers ──
  const isEmpty = (v) => v === null || v === undefined || v === '' || v === 0;
  // Normalize for equality comparison. Date objects (mysql2 DATE/DATETIME)
  // compare by ISO string; everything else by String().
  const norm = (v) => {
    if (v instanceof Date) return v.toISOString();
    return String(v);
  };
  const same = (a, b) => norm(a) === norm(b);

  // ── docket guard + adopt plan ──
  // Column-wise, shape-agnostic: for each docket column, both non-empty and
  // different → refuse. Exactly one side non-empty (loser) → adopt.
  const DOCKET_COLS = ['case_number', 'case_number_full'];
  const adopt = {};   // {col: value} to copy loser → survivor
  for (const col of DOCKET_COLS) {
    const sv = isEmpty(survivor[col]) ? null : survivor[col];
    const lv = isEmpty(loser[col])    ? null : loser[col];
    if (sv !== null && lv !== null && !same(sv, lv)) {
      const e = new Error(
        `Docket mismatch on ${col}: survivor='${sv}' vs loser='${lv}'. ` +
        `Different dockets are different court cases — refusing to merge.`
      );
      e.code = 'MERGE_DOCKET';
      throw e;
    }
    if (sv === null && lv !== null) adopt[col] = lv;
  }

  // Adopt collision check against all OTHER cases. Mirrors
  // checkCaseNumberCollision but excludes BOTH participants (the loser
  // legitimately holds these values right now).
  const adoptVals = [...new Set(Object.values(adopt))];
  if (adoptVals.length) {
    const ph = adoptVals.map(() => '?').join(', ');
    const [clash] = await db.query(
      `SELECT case_id, case_number, case_number_full
         FROM cases
        WHERE case_id NOT IN (?, ?)
          AND ( (case_number      IS NOT NULL AND case_number      <> '' AND case_number      IN (${ph}))
             OR (case_number_full IS NOT NULL AND case_number_full <> '' AND case_number_full IN (${ph})) )
        LIMIT 1`,
      [survivorId, loserId, ...adoptVals, ...adoptVals]
    );
    if (clash.length) {
      const e = new Error(
        `Docket adopt collision: case ${clash[0].case_id} already holds one of ` +
        `[${adoptVals.join(', ')}].`
      );
      e.code = 'MERGE_DOCKET';
      throw e;
    }
  }

  // ── field merge plan (additive) ──
  // Special-cased out of the generic pass:
  //   case_id (PK), docket cols (above), notes/alerts (concat),
  //   dropbox (keep + note).
  const SKIP = new Set(['case_id', ...DOCKET_COLS, 'case_notes', 'case_alerts', 'case_dropbox']);
  // Survivor-wins BY DESIGN — differ on ~every real pair; never blocking.
  const SILENT_SURVIVOR_WINS = new Set(['case_stage', 'case_status', 'case_open_date']);

  const filled        = {};   // col → loser value to write onto survivor
  const survivorWins  = [];   // reported, non-blocking
  const conflicts     = [];   // blocking (unless force)
  for (const col of Object.keys(loser)) {
    if (SKIP.has(col)) continue;
    const sv = survivor[col];
    const lv = loser[col];
    if (isEmpty(lv)) continue;
    if (isEmpty(sv)) { filled[col] = lv; continue; }
    if (same(sv, lv)) continue;
    const rec = { column: col, survivor: sv, loser: lv };
    if (SILENT_SURVIVOR_WINS.has(col)) survivorWins.push(rec);
    else conflicts.push(rec);
  }

  // ── notes / alerts / dropbox plan ──
  const stamp = new Date().toISOString().slice(0, 10);
  const sep = (what) => `\n\n--- merged from case ${loserId} on ${stamp} (${what}) ---\n`;
  let notesAppend  = '';
  let alertsAppend = '';
  if (!isEmpty(loser.case_notes))  notesAppend  += sep('notes')  + loser.case_notes;
  if (!isEmpty(loser.case_alerts)) alertsAppend += sep('alerts') + loser.case_alerts;

  let dropboxNoted = false;
  if (!isEmpty(loser.case_dropbox)) {
    if (isEmpty(survivor.case_dropbox)) {
      filled.case_dropbox = loser.case_dropbox;
    } else if (!same(survivor.case_dropbox, loser.case_dropbox)) {
      notesAppend += sep('dropbox folder') + loser.case_dropbox;
      dropboxNoted = true;
    }
  }

  // ── child repoint spec ──
  // [label, countSql, updateSql, params-are-(survivorId, loserId) or (loserId)]
  // Every UPDATE takes [survivorId, loserId]; every COUNT takes [loserId].
  const CHILDREN = [
    ['case_relate',
      `SELECT COUNT(*) AS c FROM case_relate WHERE case_relate_case_id = ?`,
      `UPDATE case_relate SET case_relate_case_id = ? WHERE case_relate_case_id = ?`],
    ['appts',
      `SELECT COUNT(*) AS c FROM appts WHERE appt_case_id = ?`,
      `UPDATE appts SET appt_case_id = ? WHERE appt_case_id = ?`],
    ['tasks',
      `SELECT COUNT(*) AS c FROM tasks WHERE task_link_type = 'case' AND task_link_id = ?`,
      `UPDATE tasks SET task_link_id = ? WHERE task_link_type = 'case' AND task_link_id = ?`],
    ['checklists',
      `SELECT COUNT(*) AS c FROM checklists WHERE link_type = 'case' AND link = ?`,
      `UPDATE checklists SET link = ? WHERE link_type = 'case' AND link = ?`],
    ['events',
      `SELECT COUNT(*) AS c FROM events WHERE event_link_type = 'case' AND event_link_id = ?`,
      `UPDATE events SET event_link_id = ? WHERE event_link_type = 'case' AND event_link_id = ?`],
    ['log',
      `SELECT COUNT(*) AS c FROM log WHERE log_link_type = 'case' AND log_link_id = ?`,
      `UPDATE log SET log_link_id = ?, log_link = ? WHERE log_link_type = 'case' AND log_link_id = ?`],
    ['form_submissions',
      `SELECT COUNT(*) AS c FROM form_submissions WHERE link_type = 'case' AND link_id = ?`,
      `UPDATE form_submissions SET link_id = ? WHERE link_type = 'case' AND link_id = ?`],
    ['signing_requests',
      `SELECT COUNT(*) AS c FROM signing_requests WHERE linkable_type = 'case' AND linkable_id = ?`,
      `UPDATE signing_requests SET linkable_id = ? WHERE linkable_type = 'case' AND linkable_id = ?`],
    ['sequences',
      `SELECT COUNT(*) AS c FROM sequences WHERE seq_case = ?`,
      `UPDATE sequences SET seq_case = ? WHERE seq_case = ?`],
    ['court_ai_log',
      `SELECT COUNT(*) AS c FROM court_ai_log WHERE resolved_case_id = ?`,
      `UPDATE court_ai_log SET resolved_case_id = ? WHERE resolved_case_id = ?`],
    ['video_views',
      `SELECT COUNT(*) AS c FROM video_views WHERE case_id = ?`,
      `UPDATE video_views SET case_id = ? WHERE case_id = ?`],
    ['ai_change_log',
      `SELECT COUNT(*) AS c FROM ai_change_log WHERE entity_type = 'case' AND entity_id = ?`,
      `UPDATE ai_change_log SET entity_id = ? WHERE entity_type = 'case' AND entity_id = ?`],
  ];

  // case_relate dedupe count (rows that would violate the uniqueness trigger
  // and are therefore deleted, not moved).
  const DEDUPE_COUNT_SQL =
    `SELECT COUNT(*) AS c
       FROM case_relate lr
       JOIN case_relate sr
         ON sr.case_relate_case_id  = ?
        AND sr.case_relate_client_id = lr.case_relate_client_id
        AND sr.case_relate_type      = lr.case_relate_type
      WHERE lr.case_relate_case_id = ?`;
  const DEDUPE_DELETE_SQL =
    `DELETE lr
       FROM case_relate lr
       JOIN case_relate sr
         ON sr.case_relate_case_id  = ?
        AND sr.case_relate_client_id = lr.case_relate_client_id
        AND sr.case_relate_type      = lr.case_relate_type
      WHERE lr.case_relate_case_id = ?`;

  const plan = {
    dry_run: dryRun,
    survivor_id: survivorId,
    loser_id: loserId,
    docket: { adopted: adopt },
    fields: {
      filled: Object.keys(filled),
      survivor_wins: survivorWins,
      conflicts,
    },
    notes_appended:  notesAppend  !== '',
    alerts_appended: alertsAppend !== '',
    dropbox_noted:   dropboxNoted,
    children: {},
  };

  // ── conflicts gate ──
  if (conflicts.length && !force && !dryRun) {
    const e = new Error(
      `Merge blocked: ${conflicts.length} field conflict(s) ` +
      `(${conflicts.map(c => c.column).join(', ')}). Retry with force to keep survivor values.`
    );
    e.code = 'MERGE_CONFLICT';
    e.conflicts = conflicts;
    throw e;
  }

  // ── dry run: counts only, no writes ──
  if (dryRun) {
    for (const [label, countSql] of CHILDREN) {
      const [[{ c }]] = await db.query(countSql, [loserId]);
      plan.children[label] = c;
    }
    const [[{ c: dedupeC }]] = await db.query(DEDUPE_COUNT_SQL, [survivorId, loserId]);
    plan.children.case_relate_deduped = dedupeC;
    return plan;
  }

  // ── execute (single InnoDB transaction) ──
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. case_relate dedupe-delete (trigger would 45000 on the UPDATE otherwise)
    const [dedupeRes] = await conn.query(DEDUPE_DELETE_SQL, [survivorId, loserId]);
    plan.children.case_relate_deduped = dedupeRes.affectedRows;

    // 2. child repoints
    for (const [label, , updateSql] of CHILDREN) {
      const params = (label === 'log')
        ? [survivorId, survivorId, loserId]     // SET log_link_id=?, log_link=?
        : [survivorId, loserId];
      const [r] = await conn.query(updateSql, params);
      plan.children[label] = r.affectedRows;
    }

    // 3. survivor field updates (adopted dockets + additive fills + concats)
    const setParts = [];
    const setVals  = [];
    for (const [col, val] of Object.entries({ ...adopt, ...filled })) {
      setParts.push(`\`${col}\` = ?`);
      setVals.push(val);
    }
    if (notesAppend)  { setParts.push('`case_notes` = CONCAT(IFNULL(`case_notes`, \'\'), ?)');   setVals.push(notesAppend); }
    if (alertsAppend) { setParts.push('`case_alerts` = CONCAT(IFNULL(`case_alerts`, \'\'), ?)'); setVals.push(alertsAppend); }
    if (setParts.length) {
      await conn.query(
        `UPDATE cases SET ${setParts.join(', ')} WHERE case_id = ?`,
        [...setVals, survivorId]
      );
    }

    // 4. snapshot the loser onto the survivor's log (full row in log_extra —
    //    this is the recovery record that sanctions the DELETE below).
    await logService.createLogEntry(conn, {
      type: 'update',
      link_type: 'case',
      link_id: survivorId,
      by,
      subject: `Case merged: ${loserId} absorbed into ${survivorId}`,
      message:
        `Merged case ${loserId}` +
        `${loser.case_number_full || loser.case_number ? ` (${loser.case_number_full || loser.case_number})` : ''}` +
        ` into ${survivorId}. ` +
        `Moved: ${Object.entries(plan.children).map(([t, n]) => `${t}=${n}`).join(', ')}. ` +
        `Filled: ${Object.keys(filled).join(', ') || 'none'}.` +
        (conflicts.length ? ` Forced past conflicts on: ${conflicts.map(c => c.column).join(', ')}.` : ''),
      extra: {
        merge: {
          loser_snapshot: loser,        // full row — Date objects serialize as ISO
          adopted: adopt,
          filled: Object.keys(filled),
          survivor_wins: survivorWins,
          forced_conflicts: conflicts,
          children: plan.children,
        },
      },
    });

    // 5. delete the loser (+ any residual case_relate rows — there should be
    //    none after step 1+2, but belt-and-braces).
    await conn.query('DELETE FROM case_relate WHERE case_relate_case_id = ?', [loserId]);
    await conn.query('DELETE FROM cases WHERE case_id = ?', [loserId]);

    await conn.commit();
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }

  return plan;
}


module.exports = {
  listCases,
  getCase,
  updateCase,
  addCaseContact,
  removeCaseContact,
  getCaseContacts,
  searchCases,
  checkCaseNumberCollision,
  ensureCaseDropboxFolder,
  listCaseSequences,
  listCaseWorkflows,
  mergeCases
};