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
 *   - case_id is varchar(20), 8 opaque chars — new ids uppercase Base32,
 *     legacy ids mixed-case base64url; minted only by lib/caseId.js
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
const { assertNoteLengths } = require('../lib/noteLimits');
const domainEvents = require('../lib/domainEvents'); // Trigger T3
// Merge consolidation recomputes the survivor's docs-checklist status. Shared
// with routes/api.checklists.js — one copy of the rule, see the lib.
const { computeAndSaveStatus } = require('../lib/checklistStatus');


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
         l.log_link_type, l.log_link_id, l.log_about_type, l.log_about_id,
         l.log_by, l.log_data,
         l.log_from, l.log_to, l.log_subject, l.log_direction,
         u.user_name AS by_name,
         DATE_FORMAT(l.log_date, '%M %e, %Y at %h:%i %p') AS formatted_date,
         COALESCE(c.contact_name, c_phone.contact_name, c_email.contact_name) AS contact_name,
         COALESCE(c.contact_id,   c_phone.contact_id,   c_email.contact_id)   AS contact_id,
         ca.case_id,
         COALESCE(ca.case_number_full, ca.case_number) AS case_number,
         ab_ca.case_id AS about_case_id,
         COALESCE(ab_ca.case_number_full, ab_ca.case_number) AS about_case_number,
         ab_ct.contact_id AS about_contact_id,
         ab_ct.contact_name AS about_contact_name
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
       /* About-link S3.2 (N-d): hydration mirror of listLog/getLogEntry —
          log_about_type-gated in the ON clause, PK-only probes, proven
          eq_ref. Added so this payload never again carries the raw about
          columns without their labels. */
       LEFT JOIN cases    ab_ca ON l.log_about_type = 'case'
                               AND ab_ca.case_id    = l.log_about_id
       LEFT JOIN contacts ab_ct ON l.log_about_type = 'contact'
                               AND ab_ct.contact_id = l.log_about_id
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
 * @param {object} [opts]
 * @param {number|null} [opts.userId]  acting user for the case.updated event's
 *   actor (R4/S5). ADDITIVE + defaulted: callers that don't pass it behave
 *   exactly as before, with actor null rather than a fabricated user 0.
 * @param {string|null} [opts.source]  'automation' | 'court_review' | … —
 *   free-text provenance for the same event.
 * @returns {{ case_id: string, updated_fields: string[] }}
 */
async function updateCase(db, caseId, fields, { userId = null, source = null } = {}) {
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

  // Notes length. case_notes and 341_notes are TEXT, and this session's
  // sql_mode has no STRICT_TRANS_TABLES — an oversized value would be
  // truncated silently and reported as a success. Throws with status 400.
  // The merge concat further down is deliberately exempt; see lib/noteLimits.js.
  assertNoteLengths(fields);

  // Blank date -> NULL. This UPDATE writes caller values verbatim, and the
  // session sql_mode has no STRICT_TRANS_TABLES, so '' on a DATE column would
  // silently become '0000-00-00' — which reads back as 1899-11-30 and is then
  // indistinguishable from a real date. See lib/blankDateToNull.js.
  const safeFields = blankDatesToNull('cases', fields);

  // (Trigger T3) Pre-read the full row for the change diff + envelope
  // snapshot. One PK read — cheap; also upgrades the not-found detection.
  const [[priorRow]] = await db.query(
    `SELECT * FROM cases WHERE case_id = ?`, [caseId]
  );
  if (!priorRow) {
    throw new Error(`Case ${caseId} not found`);
  }

  const setClauses = keys.map(k => `\`${k}\` = ?`).join(', ');
  const values = [...keys.map(k => safeFields[k]), caseId];

  const [result] = await db.query(
    `UPDATE cases SET ${setClauses} WHERE case_id = ?`,
    values
  );

  if (result.affectedRows === 0) {
    throw new Error(`Case ${caseId} not found`);
  }

  // Trigger: case.updated (fire-and-forget) — only when something actually
  // changed after normalization. data = post-state approximation
  // (pre-row overlaid with the written values).
  //
  // actor/source are OMITTED (not nulled) when the caller passed nothing, so
  // an un-threaded caller leaves actor absent rather than claiming user 0 —
  // "system did it" and "we don't know who did it" must stay distinguishable
  // to a rule author. userId 0 IS meaningful when passed explicitly (the
  // automation convention).
  const changes = domainEvents.buildChanges(priorRow, safeFields, keys);
  if (Object.keys(changes).length) {
    domainEvents.emit(db, 'case.updated', {
      case_id: String(caseId),
      ...(userId != null ? { actor: { user_id: userId } } : {}),
      ...(source != null ? { source } : {}),
      data: { ...priorRow, ...safeFields },
      changes,
      extra: { updated_fields: keys },
    });
  }

  return { case_id: caseId, updated_fields: keys, changes };
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
 * @param {object} [opts]
 * @param {number|null} [opts.userId] acting user for the case.contact_linked
 *   actor (R4/S5). Additive + defaulted — existing callers are unaffected.
 * @returns {{ case_relate_id: number }}
 */
async function addCaseContact(db, caseId, contactId, relateType = 'Primary', { userId = null } = {}) {
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

    // Trigger: case.contact_linked (fire-and-forget). The intake/petition
    // routes' direct case_relate INSERTs at creation do NOT fire this —
    // case.created covers those.
    domainEvents.emit(db, 'case.contact_linked', {
      case_id: String(caseId),
      contact_id: parseInt(contactId, 10) || null,
      ...(userId != null ? { actor: { user_id: userId } } : {}),
      data: { relate_type: relateType, case_relate_id: result.insertId },
    });

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
 * @param {object} [opts]
 * @param {number|null} [opts.userId] acting user for the
 *   case.contact_unlinked actor (R4/S5). Additive + defaulted.
 * @returns {{ removed: boolean }}
 */
async function removeCaseContact(db, caseId, contactId, { userId = null } = {}) {
  const [result] = await db.query(
    `DELETE FROM case_relate
     WHERE case_relate_case_id = ? AND case_relate_client_id = ?`,
    [caseId, contactId]
  );

  // Trigger: case.contact_unlinked (fire-and-forget) — only when a row
  // was actually removed.
  if (result.affectedRows > 0) {
    domainEvents.emit(db, 'case.contact_unlinked', {
      case_id: String(caseId),
      contact_id: parseInt(contactId, 10) || null,
      ...(userId != null ? { actor: { user_id: userId } } : {}),
      data: { removed_rows: result.affectedRows },
    });
  }

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

  // ADOPT AN EXISTING FOLDER BEFORE CREATING ONE.
  //
  // The guard at the top of this function tests cases.case_dropbox — the DB
  // column — not Dropbox. A case whose folder was made by hand under the firm's
  // older naming convention therefore looks folderless, and we would build a
  // second folder beside a full one. That happened on 2026-07-15 to 16 cases
  // whose legacy folders held 114-340 documents apiece.
  //
  // getMetadata on the templated path is one cheap call and closes the common
  // case: the folder is already there (created by an earlier run of this
  // function that died before persisting, or by staff). Adopt it and take its
  // link rather than autorename a duplicate. This does NOT catch a legacy
  // folder under a DIFFERENT name — nothing here can, since the old convention
  // is not derivable from the case row — but it does stop this function from
  // being the thing that creates the duplicate.
  let existingLink = null;
  try {
    const meta = await dropboxService.getMetadata(db, { path });
    if (meta && (meta['.tag'] === 'folder' || meta.folderish || meta.id)) {
      existingLink = await dropboxService.getOrCreateSharedLink(db, { path });
      console.log(`[CASE_DROPBOX] adopted pre-existing folder for case ${caseId}: ${path}`);
    }
  } catch (err) {
    if (!dropboxService.isPathNotFoundError || !dropboxService.isPathNotFoundError(err)) {
      console.warn(`[CASE_DROPBOX] pre-existing folder probe failed for ${caseId}, creating: ${err.message}`);
    }
  }

  const result = existingLink
    ? { path, existed: true, subfolders_created: [], shared_link: existingLink }
    : await dropboxService.createFolderWithOptions(db, {
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
 *   log_about        — log_about_id WHERE log_about_type='case' AND
 *                      log_about_id = loser case_id (About-link S2). Same
 *                      docket rule as the primary link above: an about-link
 *                      written against a docket STRING follows the adopted
 *                      docket automatically, so only the case_id form needs
 *                      repointing. Without this the row keeps pointing at a
 *                      deleted case and silently vanishes from BOTH case
 *                      views — the loser is gone and the survivor's
 *                      identifier IN-list never contained the loser's id.
 *   form_submissions — link_id       WHERE link_type='case'
 *   signing_requests — linkable_id   WHERE linkable_type='case'
 *   sequences        — seq_case
 *   court_ai_log     — resolved_case_id
 *   video_views      — case_id
 *   ai_change_log    — entity_id     WHERE entity_type='case'
 *
 * (M1, 2026-08-28) — added after a live audit of every case-keyed column in
 * the schema found six tables three later arcs had introduced without ever
 * being added here. None of them carries a foreign key, so the loser's DELETE
 * would have stranded their rows silently rather than erroring:
 *   case_stage_log             — case_id. Append-only; no unique involves
 *                                case_id, so the loser's stage history joins
 *                                the survivor's and interleaves by entered_at.
 *   case_requirement_overrides — case_id, SURVIVOR-WINS. UNIQUE (case_id,
 *                                requirement_key): colliding loser rows are
 *                                DELETEd first, the rest UPDATEd. Counts are
 *                                reported as moved + `_dropped`.
 *   case_stage_aged_emitted    — case_id only. Its UNIQUE is (stage_log_id,
 *                                threshold_days), which the case_stage_log
 *                                repoint leaves intact (row ids don't change),
 *                                so no collision is possible. Deleting these
 *                                instead would re-arm already-emitted aged
 *                                thresholds.
 *   case_folder_cache          — DELETE-ONLY, never repointed. PK is case_id,
 *                                and it caches a Dropbox folder that
 *                                case_dropbox (survivor-wins) contradicts.
 *   portal_access_log          — case_id. Client-access audit follows the
 *                                surviving case.
 *   trigger_executions         — the case_id COLUMN ONLY. The stored event
 *                                envelope JSON is an immutable historical
 *                                record and is left byte-untouched.
 *
 * With these in place the repoint set covers every case-keyed table in the
 * schema, so the loser's children are preserved BY TRANSFER, not merely by
 * the snapshot below. (documents/document_links are deliberately excluded —
 * they link via document_links.link_type='case' AND link_id, but their
 * path-relation rows are machine-derived from the case's Dropbox folder and
 * would be retracted again by documentService.reconcileCaseFolderLinks on the
 * next sync. Flagged for a decision of its own, not merged in here.)
 *
 * LOSER DISPOSITION: full row JSON + move counts snapshotted via
 * logService.createLogEntry (type 'update', link_type 'case', link_id =
 * survivor; snapshot in log_extra) — THEN hard-deleted. This is the sanctioned
 * exception to the "no DELETE for cases" rule: the legal record survives in
 * the snapshot, attached to the case that absorbed it.
 *
 * The snapshot is the loser ROW's recovery record — it always was, and it
 * never claimed to cover the children. As of M1 the children do not need
 * covering: every case-keyed table is repointed (or, for the one cache table,
 * deliberately dropped), so they are preserved by TRANSFER onto the survivor.
 * What the snapshot's `children` block now records is therefore an account of
 * where each child WENT, per table, including the rows a survivor-wins
 * collision discarded (`<table>_dropped`).
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
 *   children: { table: rowCount, … , '<table>_dropped': rowCount,
 *               case_relate_deduped, checklists_consolidated }
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
  //   pipeline_phase (T8): system-managed lifecycle column, NOT NULL on both
  //   sides, so a cross-phase merge (the canonical one: a duplicate lead
  //   absorbed into a retained case) would otherwise land in `conflicts` and
  //   409 on a column the user cannot see or reason about. Resolved below.
  const SKIP = new Set(['case_id', ...DOCKET_COLS, 'case_notes', 'case_alerts', 'case_dropbox',
    'pipeline_phase']);
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

  // ── pipeline_phase (T8) ──
  // Lifecycle is MONOTONIC across a merge: once either participant has
  // retained, the merged case has retained. Survivor-wins would be wrong —
  // absorbing a retained case into a lead would silently demote it back into
  // the intake funnel.
  if (norm(loser.pipeline_phase) === 'case' && norm(survivor.pipeline_phase) !== 'case') {
    filled.pipeline_phase = 'case';
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

  // ── survivor-wins pre-delete: case_requirement_overrides (M1) ──
  // Declared ahead of CHILDREN because the array literal references them
  // (the DEDUPE_* pair below is declared after, and can be — it is read at
  // execution time, not at construction).
  //
  // Same JOIN idiom as DEDUPE_*_SQL, one clause shorter: the collision key is
  // (case_id, requirement_key) — verified live as UNIQUE `uq_case_reqkey` —
  // so a loser row collides exactly when the survivor already holds an
  // override on the same requirement_key. Both bound [survivorId, loserId].
  const OVERRIDE_COLLIDE_COUNT_SQL =
    `SELECT COUNT(*) AS c
       FROM case_requirement_overrides lo
       JOIN case_requirement_overrides so
         ON so.case_id = ? AND so.requirement_key = lo.requirement_key
      WHERE lo.case_id = ?`;
  const OVERRIDE_COLLIDE_DELETE_SQL =
    `DELETE lo
       FROM case_requirement_overrides lo
       JOIN case_requirement_overrides so
         ON so.case_id = ? AND so.requirement_key = lo.requirement_key
      WHERE lo.case_id = ?`;

  // ── child repoint spec ──
  // [label, countSql, moveSql, pre?]
  //   countSql — always [loserId].
  //   moveSql  — always [survivorId, loserId] (the 'log' label is the one
  //              special case: it binds three, see the repoint loop). NULL
  //              means "this table is never repointed" — the pre-statement is
  //              the whole operation (M1: case_folder_cache).
  //   pre      — OPTIONAL { countSql, sql }, both bound [survivorId, loserId].
  //              A DELETE run FIRST, inside the transaction, immediately
  //              before this entry's move. It exists for loser rows that
  //              CANNOT move: rows that would violate a UNIQUE key the
  //              survivor already occupies (survivor-wins), or rows in a table
  //              that is never repointed at all. affectedRows lands in
  //              plan.children[`${label}_dropped`], so the merge note reports
  //              kept AND dropped for every such table.
  //
  // WHY A DECLARATIVE 4th SLOT rather than more `label === '…'` branches (M1,
  // 2026-08-28): the 'log' special case already proves a label branch is
  // acceptable, but the two tables added below need branches in BOTH loops
  // (dry-run counts and the real repoint), which is four branches for two
  // tables — and the next UNIQUE-keyed case table would add two more. The
  // optional slot is the smaller diff today and the only one that does not
  // grow. Existing entries are untouched 3-tuples and keep binding exactly as
  // they always have.
  //
  // NOT folded in: step 1's case_relate dedupe-delete, which is the same
  // survivor-wins idea written out ad hoc. It runs before step 1b's checklist
  // consolidation for reasons of its own, and moving it would change ordering
  // that is pinned elsewhere. Left alone deliberately.
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
    // About-link S2. Label is deliberately NOT 'log' — the repoint loop
    // special-cases that label to bind three params (log_link_id + log_link).
    // This entry takes the standard two, [survivorId, loserId].
    ['log_about',
      `SELECT COUNT(*) AS c FROM log WHERE log_about_type = 'case' AND log_about_id = ?`,
      `UPDATE log SET log_about_id = ? WHERE log_about_type = 'case' AND log_about_id = ?`],
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

    // ── M1 (2026-08-28) — the tables three later arcs added ────────────────
    // This list predates the pipeline engine, the trigger engine, the client
    // portal and the documents sync. A live audit of every case-keyed column
    // in the schema found the six below missing from it. Orphan count is 0
    // TODAY only because no merge loser has yet held a row in any of them —
    // there are no foreign keys on any of these tables, so the loser's DELETE
    // in step 5 would simply have stranded them, silently. The risk grows
    // with pipeline and portal adoption, which is why they are here now.

    // Append-only stage history. No unique key involves case_id (verified:
    // PK id, idx_case_time non-unique), so the loser's history joins the
    // survivor's and interleaves by entered_at — which is the truthful merged
    // account of where the absorbed case had been.
    ['case_stage_log',
      `SELECT COUNT(*) AS c FROM case_stage_log WHERE case_id = ?`,
      `UPDATE case_stage_log SET case_id = ? WHERE case_id = ?`],

    // SURVIVOR-WINS. UNIQUE (case_id, requirement_key): a loser override on a
    // key the survivor has already ruled on cannot move, and the survivor's
    // ruling is the one about the case that continues to exist. Dropped
    // first, the rest repointed. The count above deliberately counts ALL
    // loser rows (the case_relate precedent) — `_dropped` carries the split.
    ['case_requirement_overrides',
      `SELECT COUNT(*) AS c FROM case_requirement_overrides WHERE case_id = ?`,
      `UPDATE case_requirement_overrides SET case_id = ? WHERE case_id = ?`,
      { countSql: OVERRIDE_COLLIDE_COUNT_SQL, sql: OVERRIDE_COLLIDE_DELETE_SQL }],

    // The aged-emission claim table. Its UNIQUE is (stage_log_id,
    // threshold_days) — NOT case_id — and the case_stage_log repoint above
    // changes no row ids, so those claims stay valid and no collision is
    // possible here. Repointing case_id keeps each claim consistent with the
    // (now survivor-owned) log row it claims. DELETING them instead would
    // re-arm every already-emitted threshold and replay the aged events.
    ['case_stage_aged_emitted',
      `SELECT COUNT(*) AS c FROM case_stage_aged_emitted WHERE case_id = ?`,
      `UPDATE case_stage_aged_emitted SET case_id = ? WHERE case_id = ?`],

    // DELETE-ONLY, never repointed. PRIMARY KEY = case_id, so a repoint
    // collides outright whenever the survivor has a row — but the deeper
    // reason is that this is a CACHE of a case's Dropbox folder, and
    // case_dropbox is survivor-wins (the loser's folder URL is preserved into
    // case_notes above, not adopted). Moving the loser's cache row would
    // hand the survivor a resolved folder its own case_dropbox contradicts.
    // The survivor keeps its own mapping; if it has none, the sync rebuilds
    // one. `case_id <> ?` is a structural guard that the survivor's row can
    // never be the one deleted.
    ['case_folder_cache',
      `SELECT COUNT(*) AS c FROM case_folder_cache WHERE case_id = ?`,
      null,
      { countSql: `SELECT COUNT(*) AS c FROM case_folder_cache WHERE case_id <> ? AND case_id = ?`,
        sql:      `DELETE FROM case_folder_cache WHERE case_id <> ? AND case_id = ?` }],

    // Client-access audit trail (plain id PK, no unique on case_id) — it
    // stays attached to the case that survives, or it stops being an audit
    // trail of anything.
    ['portal_access_log',
      `SELECT COUNT(*) AS c FROM portal_access_log WHERE case_id = ?`,
      `UPDATE portal_access_log SET case_id = ? WHERE case_id = ?`],

    // The case_id COLUMN ONLY — deliberately. trigger_executions also stores
    // the firing event's envelope as JSON, and that envelope contains ids
    // too; it is an immutable record of what the engine was handed at the
    // time and is left BYTE-UNTOUCHED. Do not "fix" it to match: rewriting
    // history to say a trigger fired for a case that did not exist yet would
    // make the execution log lie about the past. The indexed column is what
    // the case view queries; that is what moves.
    ['trigger_executions',
      `SELECT COUNT(*) AS c FROM trigger_executions WHERE case_id = ?`,
      `UPDATE trigger_executions SET case_id = ? WHERE case_id = ?`],
  ];

  // ── tagged-checklist consolidation ──
  // checklists.link used to carry a UNIQUE index, which made the repoint below
  // throw ER_DUP_ENTRY and roll the whole merge back whenever both cases had a
  // checklist. That index is gone. The repoint now SUCCEEDS — and leaves the
  // survivor holding two tag='docs_needed' lists, which silently breaks the
  // one-docs-checklist-per-case invariant that api.checklists upsert-items
  // (ORDER BY … LIMIT 1) and portalDocsService both assume.
  //
  // So: for every tag present on BOTH sides, fold the loser's items into the
  // survivor's same-tag list and drop the emptied loser list. UNTAGGED lists
  // are deliberately left alone — they're staff working lists and the survivor
  // legitimately ends up with both.
  //
  // s.kind = l.kind (S1) is load-bearing, not symmetry. uq_link_kind_tag now
  // keys on kind too, so a loser NOTE tagged 'docs_needed' repointing onto a
  // survivor that holds a same-tagged CHECKLIST no longer violates anything —
  // there is nothing to consolidate. Without this clause the join would still
  // match, fold zero items across (a note has none), and DELETE the note. A
  // silent loss of its body, with no error and no count to notice.
  //
  // It does NOT save a note↔NOTE pair, though (S2). Two notes sharing a tag
  // still match on kind, and the item fold below is a no-op on both sides — so
  // the loser would be deleted and its body lost exactly the same way.
  // Excluding notes from consolidation is not available: this runs at step 1b,
  // deliberately AHEAD of the step-2 repoint, and skipping it would carry a
  // same-(link_type, link, kind, tag) note onto the survivor, violate
  // uq_link_kind_tag, and roll the entire merge back. So the loop FOLDS THE
  // BODY instead — the same treatment case_notes already gets above. `l.kind`
  // rides along on the SELECT for that branch.
  const CONSOLIDATE_FIND_SQL =
    `SELECT l.id AS loser_list, s.id AS survivor_list, l.tag, l.kind
       FROM checklists l
       JOIN checklists s
         ON s.link_type = 'case' AND s.link = ? AND s.tag = l.tag
        AND s.kind = l.kind
      WHERE l.link_type = 'case' AND l.link = ? AND l.tag IS NOT NULL`;

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
    for (const [label, countSql, moveSql, pre] of CHILDREN) {
      const [[{ c }]] = await db.query(countSql, [loserId]);
      // A never-repointed table moves nothing, and the preview must say so
      // rather than promise a repoint the real merge will not perform. Its
      // rows are reported under `_dropped` below instead.
      plan.children[label] = moveSql ? c : 0;
      if (pre) {
        const [[{ c: dropped }]] = await db.query(pre.countSql, [survivorId, loserId]);
        plan.children[`${label}_dropped`] = dropped;
      }
    }
    const [[{ c: dedupeC }]] = await db.query(DEDUPE_COUNT_SQL, [survivorId, loserId]);
    plan.children.case_relate_deduped = dedupeC;
    const [dupTags] = await db.query(CONSOLIDATE_FIND_SQL, [survivorId, loserId]);
    plan.children.checklists_consolidated = dupTags.length;
    return plan;
  }

  // ── execute (single InnoDB transaction) ──
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. case_relate dedupe-delete (trigger would 45000 on the UPDATE otherwise)
    const [dedupeRes] = await conn.query(DEDUPE_DELETE_SQL, [survivorId, loserId]);
    plan.children.case_relate_deduped = dedupeRes.affectedRows;

    // 1b. tagged-checklist consolidation — MUST run before the repoint in step
    //     2, which would otherwise carry the loser's tagged list across intact.
    //     See CONSOLIDATE_FIND_SQL above for why.
    const [dupTags] = await conn.query(CONSOLIDATE_FIND_SQL, [survivorId, loserId]);
    for (const d of dupTags) {
      // NOTES: no items to fold — the payload is the body. Concatenated onto
      // the survivor's with the same visible separator case_notes uses, so a
      // merged note reads as two dated sections rather than one run-on blob.
      // The loser's `status` is dropped on purpose: a note's status is MANUAL
      // (S1) and the survivor's was set by a human about the survivor's text.
      if (d.kind === 'note') {
        const [[loserNote]] = await conn.query(
          'SELECT body FROM checklists WHERE id = ?', [d.loser_list]
        );
        // An empty-string body is a legitimate title-only note — nothing to
        // carry across, and appending a bare separator would be noise.
        if (loserNote && loserNote.body != null && loserNote.body !== '') {
          await conn.query(
            `UPDATE checklists SET body = CONCAT(IFNULL(body, ''), ?) WHERE id = ?`,
            [sep(`note "${d.tag}"`) + loserNote.body, d.survivor_list]
          );
        }
        await conn.query('DELETE FROM checklists WHERE id = ?', [d.loser_list]);
        // No computeAndSaveStatus: S1's lib guard makes it a no-op on a note,
        // and calling it anyway would imply this status is derived.
        continue;
      }

      // Append after the survivor's existing items. COALESCE because
      // checkitems.position is nullable, and NULL + n is NULL — which would
      // sort the folded-in items to the TOP under `ORDER BY position ASC`.
      const [[{ maxPos }]] = await conn.query(
        'SELECT COALESCE(MAX(position), 0) AS maxPos FROM checkitems WHERE checklist_id = ?',
        [d.survivor_list]
      );
      await conn.query(
        `UPDATE checkitems
            SET checklist_id = ?, position = COALESCE(position, 0) + ?
          WHERE checklist_id = ?`,
        [d.survivor_list, maxPos, d.loser_list]
      );
      // Emptied by the UPDATE above; the FK is ON DELETE CASCADE but there is
      // nothing left to cascade.
      await conn.query('DELETE FROM checklists WHERE id = ?', [d.loser_list]);
      // Folding items in can flip the survivor list incomplete — recompute on
      // `conn` so it rolls back with the rest of the merge.
      await computeAndSaveStatus(conn, d.survivor_list);
    }
    plan.children.checklists_consolidated = dupTags.length;

    // 2. child repoints
    for (const [label, , moveSql, pre] of CHILDREN) {
      // Pre-statement first: drop the loser rows that CANNOT move, so the
      // repoint that follows cannot collide on them. Reported separately —
      // "8 moved, 1 dropped" is the audit trail; "8 moved" alone would hide
      // the row that was discarded.
      if (pre) {
        const [d] = await conn.query(pre.sql, [survivorId, loserId]);
        plan.children[`${label}_dropped`] = d.affectedRows;
      }
      // Never-repointed table (case_folder_cache): the pre-statement above
      // WAS the operation. Still reported at 0 so the label appears in the
      // merge note like every other child table.
      if (!moveSql) { plan.children[label] = 0; continue; }
      const params = (label === 'log')
        ? [survivorId, survivorId, loserId]     // SET log_link_id=?, log_link=?
        : [survivorId, loserId];
      const [r] = await conn.query(moveSql, params);
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