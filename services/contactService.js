// services/contactService.js
//
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
 *   - contact_email is lowercased on write — equality is case-insensitive
 *
 * Slice-2 dual-write:
 *   - contact_phone   writes propagate to contact_phones
 *   - contact_email   writes propagate to contact_emails
 *   - contact_address/city/state/zip writes propagate to contact_addresses
 *   - contact_phone2 / contact_email2 are NOT propagated (vestigial; new
 *     code should use the child-table endpoints to add secondary numbers)
 *
 * Dual-write asymmetry vs. the new POST /api/contact-{phones,emails,addresses}
 * routes:
 *   - LEGACY propagation (via this service) for phones/emails always behaves
 *     as force=true for global active-uniqueness collisions — the legacy
 *     form has no UI surface to confirm a transfer, so silently transferring
 *     is the only workable default. Addresses have no collision logic in
 *     either path (multiple contacts may share an address).
 *   - NEW direct phone/email API defaults to force=false and returns 409
 *     with a conflict payload; caller opts in via ?force=true. This
 *     asymmetry is intentional and load-bearing.
 *
 * Address propagation shape diverges from phone/email: the legacy form
 * sends partial updates (e.g. {contact_city: 'Detroit'} alone), and
 * addresses are EDITED IN PLACE on the primary-active row rather than
 * ended-and-re-inserted. The "moved vs typo" ambiguity makes this the
 * right default; phone/email get end+insert because their values
 * function as identifiers.
 *
 * Usage:
 *   const contactService = require('../services/contactService');
 *   const { contact, cases, appts, tasks, log } = await contactService.getContact(db, 123);
 */
const {
  recomputePrimaryPhone,
  recomputePrimaryEmail,
  recomputePrimaryAddress,
} = require('../lib/contactMirror');

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

/**
 * Normalize an email: trim + lowercase. Matches contactEmailService's
 * normalization so the legacy column and the child row stay in sync.
 */
function normalizeEmail(email) {
  if (!email && email !== 0) return '';
  return String(email).trim().toLowerCase();
}


// ─────────────────────────────────────────────────────────────
// Internal dual-write helpers (Slice 2)
// ─────────────────────────────────────────────────────────────

/**
 * Propagate a contacts.contact_phone change into the contact_phones
 * child table within an open transaction connection.
 *
 * Behavior:
 *   - newPhone === current primary-active phone for this contact → no-op
 *   - newPhone is non-empty:
 *       * end existing primary-active row (if any) as 'replaced'
 *         (same-contact reason — reserve 'transferred' for cross-contact)
 *       * if newPhone is active on ANOTHER contact, end that row as
 *         'transferred' and recompute that contact's mirror (force=true
 *         semantics — legacy never asks for confirmation)
 *       * INSERT a new primary-active row with the new value
 *       * recompute this contact's mirror (safety net; should be no-op)
 *   - newPhone is '' (empty string):
 *       * end the existing primary-active row as 'ended'
 *       * recompute mirror (writes '' to contacts.contact_phone, but
 *         the outer UPDATE already did that — no-op)
 *
 * Constraint note: this propagator relies on the Slice 2 Stage 1
 * revision migration (contact_multivalue_relax_unique.up.sql) having
 * dropped uc_contact_phone. With that migration applied, a contact may
 * have multiple history rows for the same phone value, so "phone
 * returns" (re-adopting a previously-ended number) works correctly.
 *
 * @param {object} conn      - transaction connection
 * @param {number} contactId
 * @param {string} newPhone  - already normalized (10 digits) or '' to clear
 * @param {number} updatedBy
 * @returns {Promise<void>}
 */
async function _propagatePhone(conn, contactId, newPhone, updatedBy) {
  const cid = parseInt(contactId, 10);

  const [[primary]] = await conn.query(
    `SELECT id, phone FROM contact_phones
      WHERE contact_id = ? AND is_primary = 1 AND end_date IS NULL
      LIMIT 1`,
    [cid]
  );

  if (newPhone) {
    if (primary && primary.phone === newPhone) return;

    // End existing primary-active as 'replaced' (same-contact reason)
    if (primary) {
      await conn.query(
        `UPDATE contact_phones
            SET end_date = CURDATE(), is_primary = 0,
                end_reason = 'replaced', updated_by = ?
          WHERE id = ?`,
        [updatedBy, primary.id]
      );
    }

    // force=true: end any other contact's active claim on this phone
    const [[collision]] = await conn.query(
      `SELECT id, contact_id FROM contact_phones
        WHERE phone = ? AND end_date IS NULL AND contact_id <> ?`,
      [newPhone, cid]
    );
    if (collision) {
      await conn.query(
        `UPDATE contact_phones
            SET end_date = CURDATE(), is_primary = 0,
                end_reason = 'transferred', updated_by = ?
          WHERE id = ?`,
        [updatedBy, collision.id]
      );
      await recomputePrimaryPhone(conn, collision.contact_id);
    }

    try {
      await conn.query(
        `INSERT INTO contact_phones
           (contact_id, phone, is_primary, start_date, created_by, updated_by)
         VALUES (?, ?, 1, CURDATE(), ?, ?)`,
        [cid, newPhone, updatedBy, updatedBy]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new Error(
          `Cannot set contact_phone to ${newPhone}: a concurrent update ` +
          `claimed this number. Refresh and retry.`
        );
      }
      throw err;
    }

    await recomputePrimaryPhone(conn, cid);
  } else {
    if (primary) {
      await conn.query(
        `UPDATE contact_phones
            SET end_date = CURDATE(), is_primary = 0,
                end_reason = 'ended', updated_by = ?
          WHERE id = ?`,
        [updatedBy, primary.id]
      );
      await recomputePrimaryPhone(conn, cid);
    }
  }
}

/**
 * Propagate a contacts.contact_email change into the contact_emails
 * child table within an open transaction connection. Direct mirror of
 * _propagatePhone — see that JSDoc for behavior. Differences:
 *   - normalization is trim + lowercase (caller is expected to have
 *     pre-normalized via normalizeEmail; this fn does NOT re-normalize)
 *   - constraint relaxation note applies to uc_contact_email
 *
 * @param {object} conn
 * @param {number} contactId
 * @param {string} newEmail  - already normalized (trim+lowercased) or '' to clear
 * @param {number} updatedBy
 * @returns {Promise<void>}
 */
async function _propagateEmail(conn, contactId, newEmail, updatedBy) {
  const cid = parseInt(contactId, 10);

  const [[primary]] = await conn.query(
    `SELECT id, email FROM contact_emails
      WHERE contact_id = ? AND is_primary = 1 AND end_date IS NULL
      LIMIT 1`,
    [cid]
  );

  if (newEmail) {
    if (primary && primary.email === newEmail) return;

    if (primary) {
      await conn.query(
        `UPDATE contact_emails
            SET end_date = CURDATE(), is_primary = 0,
                end_reason = 'replaced', updated_by = ?
          WHERE id = ?`,
        [updatedBy, primary.id]
      );
    }

    const [[collision]] = await conn.query(
      `SELECT id, contact_id FROM contact_emails
        WHERE email = ? AND end_date IS NULL AND contact_id <> ?`,
      [newEmail, cid]
    );
    if (collision) {
      await conn.query(
        `UPDATE contact_emails
            SET end_date = CURDATE(), is_primary = 0,
                end_reason = 'transferred', updated_by = ?
          WHERE id = ?`,
        [updatedBy, collision.id]
      );
      await recomputePrimaryEmail(conn, collision.contact_id);
    }

    try {
      await conn.query(
        `INSERT INTO contact_emails
           (contact_id, email, is_primary, start_date, created_by, updated_by)
         VALUES (?, ?, 1, CURDATE(), ?, ?)`,
        [cid, newEmail, updatedBy, updatedBy]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new Error(
          `Cannot set contact_email to ${newEmail}: a concurrent update ` +
          `claimed this address. Refresh and retry.`
        );
      }
      throw err;
    }

    await recomputePrimaryEmail(conn, cid);
  } else {
    if (primary) {
      await conn.query(
        `UPDATE contact_emails
            SET end_date = CURDATE(), is_primary = 0,
                end_reason = 'ended', updated_by = ?
          WHERE id = ?`,
        [updatedBy, primary.id]
      );
      await recomputePrimaryEmail(conn, cid);
    }
  }
}

/**
 * Propagate a contacts.contact_address / city / state / zip change into
 * the contact_addresses child table. SHAPE DIVERGES from phone/email:
 * addresses are edited IN PLACE on the existing primary-active row
 * rather than ended-and-re-inserted. Rationale: legacy forms send
 * partial updates (e.g. only contact_city), and "moved vs typo" is
 * genuinely ambiguous.
 *
 * Behavior:
 *   1. Find primary-active row for contactId.
 *   2. Determine the target full state (address1/city/state/zip):
 *        for each, prefer normalized.contact_<field> if present,
 *        else fall back to the existing primary row's value (or ''
 *        if no row).
 *   3. If target is all-empty AND a primary-active row exists:
 *        end that row with end_reason='ended'. Recompute mirror.
 *   4. If target is all-empty AND no primary row: nothing to do.
 *   5. If a primary-active row exists: UPDATE in place with target
 *        values (address1/city/state/zip + updated_by). country is
 *        not touched — the legacy form doesn't write it. Recompute.
 *   6. If no primary row exists: INSERT a new primary-active row
 *        with target values, country='US', start_date=CURDATE(),
 *        created_by=updatedBy. Recompute.
 *
 * No collision check (addresses are not active-unique across contacts).
 * No `transferred` reason (no donor-end ever happens).
 *
 * @param {object} conn
 * @param {number} contactId
 * @param {object} normalized  - the full normalized fields obj from updateContact;
 *                               reads contact_address/city/state/zip keys
 * @param {number} updatedBy
 * @returns {Promise<void>}
 */
async function _propagateAddress(conn, contactId, normalized, updatedBy) {
  const cid = parseInt(contactId, 10);

  // Step 1. Find primary-active row.
  const [[primary]] = await conn.query(
    `SELECT id, address1, city, state, zip
       FROM contact_addresses
      WHERE contact_id = ? AND is_primary = 1 AND end_date IS NULL
      LIMIT 1`,
    [cid]
  );

  // Step 2. Determine target state.
  //   - For each of (address1, city, state, zip): use normalized.contact_<field>
  //     if that key is present in `normalized`, else use the existing
  //     primary row's value (or '' if no row).
  const target = {
    address1: 'contact_address' in normalized
      ? (normalized.contact_address || '')
      : (primary ? (primary.address1 || '') : ''),
    city: 'contact_city' in normalized
      ? (normalized.contact_city || '')
      : (primary ? (primary.city || '') : ''),
    state: 'contact_state' in normalized
      ? (normalized.contact_state || '')
      : (primary ? (primary.state || '') : ''),
    zip: 'contact_zip' in normalized
      ? (normalized.contact_zip || '')
      : (primary ? (primary.zip || '') : ''),
  };

  const targetAllEmpty = !target.address1 && !target.city
                      && !target.state    && !target.zip;

  // Step 3 / 4. All-empty target.
  if (targetAllEmpty) {
    if (primary) {
      await conn.query(
        `UPDATE contact_addresses
            SET end_date = CURDATE(), is_primary = 0,
                end_reason = 'ended', updated_by = ?
          WHERE id = ?`,
        [updatedBy, primary.id]
      );
      await recomputePrimaryAddress(conn, cid);
    }
    // No primary, target all-empty → nothing to do.
    return;
  }

  // Step 5. Primary exists → UPDATE in place.
  if (primary) {
    await conn.query(
      `UPDATE contact_addresses
          SET address1 = ?, city = ?, state = ?, zip = ?, updated_by = ?
        WHERE id = ?`,
      [target.address1, target.city, target.state, target.zip,
       updatedBy, primary.id]
    );
    await recomputePrimaryAddress(conn, cid);
    return;
  }

  // Step 6. No primary → INSERT new one.
  try {
    await conn.query(
      `INSERT INTO contact_addresses
         (contact_id, address1, address2, city, state, zip, country,
          label, is_primary, start_date, created_by, updated_by)
       VALUES (?, ?, '', ?, ?, ?, 'US', 'Other', 1, CURDATE(), ?, ?)`,
      [cid, target.address1, target.city, target.state, target.zip,
       updatedBy, updatedBy]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw new Error(
        'Concurrent promote on this contact — another primary-active ' +
        'address row was created. Refresh and retry.'
      );
    }
    throw err;
  }
  await recomputePrimaryAddress(conn, cid);
}


// ─────────────────────────────────────────────────────────────
// listContacts
// ─────────────────────────────────────────────────────────────

/**
 * List contacts with search, filters, and pagination.
 *
 * Search uses FULLTEXT on contact_name for text queries,
 * with LIKE fallback for phone/email patterns.
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
      const digits = query.replace(/\D/g, '');
      if (digits.length >= 7) {
        where.push(`(c.contact_phone LIKE ? OR c.contact_phone2 LIKE ?)`);
        params.push(`%${digits}%`, `%${digits}%`);
      } else {
        where.push(`c.contact_id = ?`);
        params.push(parseInt(query, 10));
      }
    } else if (query.includes('@')) {
      where.push(`(c.contact_email LIKE ? OR c.contact_email2 LIKE ?)`);
      const q = `%${query}%`;
      params.push(q, q);
    } else {
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
    SORT_WHITELIST[sort_by] ||
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
// getContact — respects `include` parameter
// ─────────────────────────────────────────────────────────────

/**
 * Fetch a single contact, optionally with related entities.
 *
 * @param {object} db
 * @param {number} contactId
 * @param {string} [include] — comma-separated: 'cases,appts,tasks,log,sequences'
 * @returns {object|null} null if contact not found
 */
async function getContact(db, contactId, include = '', { logLimit = DEFAULT_LOG_LIMIT } = {}) {
  const [[raw]] = await db.query(
    'SELECT * FROM contacts WHERE contact_id = ?',
    [contactId]
  );
  if (!raw) return null;
  const contact = { ...raw };

  const result = { contact };

  const parts = include
    ? include.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : [];

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
// createContact — wrapped in transaction; dual-write to all three children
// ─────────────────────────────────────────────────────────────

/**
 * Create a new contact. Simple insert — no find-or-create logic.
 * (Use the intake routes for find-or-create.)
 *
 * DB triggers auto-compute contact_name, contact_lfm_name, contact_rname.
 *
 * SLICE 2 DUAL-WRITE: after the contacts INSERT, propagate the primary
 * phone/email/address into the corresponding child tables as primary-
 * active rows. force=true semantics for phone/email on cross-contact
 * collisions (silently transfer). Addresses have no collision check.
 *
 * The whole operation runs in a transaction so that if a child INSERT
 * fails non-recoverably, the contacts INSERT is rolled back too —
 * avoiding a drifted-state contact with no child rows.
 *
 * `phone2` / `email2` write to the legacy columns only; they are NOT
 * propagated to child tables (vestigial).
 *
 * @param {object} db
 * @param {object} opts
 * @param {object} [opts2]
 * @param {number} [opts2.userId=0]
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
}, { userId = 0 } = {}) {
  if (!fname) throw new Error('createContact requires fname');
  if (!lname) throw new Error('createContact requires lname');

  const normalizedPhone   = normalizePhone(phone);
  const normalizedPhone2  = normalizePhone(phone2);
  const normalizedEmail   = normalizeEmail(email);
  const normalizedEmail2  = normalizeEmail(email2);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Insert the contacts row
    const [result] = await conn.query(
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
        normalizedPhone, normalizedEmail, type,
        address, city, state, zip,
        dob, marital_status,
        normalizedPhone2, normalizedEmail2,
        tags, notes
      ]
    );

    const newId = result.insertId;

    // 2. Propagate phone (force=true semantics on cross-contact collision)
    if (normalizedPhone) {
      const [[collision]] = await conn.query(
        `SELECT id, contact_id FROM contact_phones
          WHERE phone = ? AND end_date IS NULL`,
        [normalizedPhone]
      );
      if (collision) {
        await conn.query(
          `UPDATE contact_phones
              SET end_date = CURDATE(), is_primary = 0,
                  end_reason = 'transferred', updated_by = ?
            WHERE id = ?`,
          [userId, collision.id]
        );
        await recomputePrimaryPhone(conn, collision.contact_id);
      }

      await conn.query(
        `INSERT INTO contact_phones
           (contact_id, phone, is_primary, start_date, created_by, updated_by)
         VALUES (?, ?, 1, CURDATE(), ?, ?)`,
        [newId, normalizedPhone, userId, userId]
      );
      await recomputePrimaryPhone(conn, newId);
    }

    // 3. Propagate email (parallel to phone)
    if (normalizedEmail) {
      const [[collision]] = await conn.query(
        `SELECT id, contact_id FROM contact_emails
          WHERE email = ? AND end_date IS NULL`,
        [normalizedEmail]
      );
      if (collision) {
        await conn.query(
          `UPDATE contact_emails
              SET end_date = CURDATE(), is_primary = 0,
                  end_reason = 'transferred', updated_by = ?
            WHERE id = ?`,
          [userId, collision.id]
        );
        await recomputePrimaryEmail(conn, collision.contact_id);
      }

      await conn.query(
        `INSERT INTO contact_emails
           (contact_id, email, is_primary, start_date, created_by, updated_by)
         VALUES (?, ?, 1, CURDATE(), ?, ?)`,
        [newId, normalizedEmail, userId, userId]
      );
      await recomputePrimaryEmail(conn, newId);
    }

    // 4. Propagate address (no collision check)
    if (address || city || state || zip) {
      await conn.query(
        `INSERT INTO contact_addresses
           (contact_id, address1, address2, city, state, zip, country,
            label, is_primary, start_date, created_by, updated_by)
         VALUES (?, ?, '', ?, ?, ?, 'US', 'Other', 1, CURDATE(), ?, ?)`,
        [newId, address || '', city || '', state || '', zip || '',
         userId, userId]
      );
      await recomputePrimaryAddress(conn, newId);
    }

    // 5. Re-fetch to get trigger-computed name fields
    const [[created]] = await conn.query(
      'SELECT contact_id, contact_name FROM contacts WHERE contact_id = ?',
      [newId]
    );

    await conn.commit();
    return { contact_id: newId, contact_name: created.contact_name };
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}


// ─────────────────────────────────────────────────────────────
// updateContact — wrapped in transaction; dual-write on relevant fields
// ─────────────────────────────────────────────────────────────

/**
 * Update one or more fields on a contact.
 *
 * Whitelist enforced — blocks PK, SSN, and trigger-computed fields.
 * DB trigger handles: recomputing name fields + logging changes on the
 * contacts row.
 *
 * SLICE 2 DUAL-WRITE: when contact_phone / contact_email /
 * contact_address|city|state|zip appear in `fields`, the corresponding
 * child table is updated to keep the primary-active row in sync with
 * the legacy column. force=true semantics for phone/email on cross-
 * contact collisions. Addresses are edited in place (see
 * _propagateAddress).
 *
 * `contact_phone2` / `contact_email2` write to the legacy columns only;
 * they are NOT propagated to child tables (vestigial).
 *
 * The whole operation runs in a transaction so the contacts UPDATE and
 * child-table propagation land atomically.
 *
 * @param {object} db
 * @param {number} contactId
 * @param {object} fields - column: value pairs
 * @param {object} [opts]
 * @param {number} [opts.userId=0]
 * @returns {{ contact_id: number, updated_fields: string[] }}
 */
async function updateContact(db, contactId, fields, { userId = 0 } = {}) {
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

  // Normalize phone + email fields if present
  const normalized = { ...fields };
  if (normalized.contact_phone)  normalized.contact_phone  = normalizePhone(normalized.contact_phone);
  if (normalized.contact_phone2) normalized.contact_phone2 = normalizePhone(normalized.contact_phone2);
  if (normalized.contact_email)  normalized.contact_email  = normalizeEmail(normalized.contact_email);
  if (normalized.contact_email2) normalized.contact_email2 = normalizeEmail(normalized.contact_email2);

  const finalKeys = Object.keys(normalized);
  const setClauses = finalKeys.map(k => `\`${k}\` = ?`).join(', ');
  const values = [...finalKeys.map(k => normalized[k]), contactId];

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Existing UPDATE on contacts
    const [result] = await conn.query(
      `UPDATE contacts SET ${setClauses}, contact_updated = NOW() WHERE contact_id = ?`,
      values
    );

    if (result.affectedRows === 0) {
      throw new Error(`Contact ${contactId} not found`);
    }

    // 2. Propagate contact_phone
    if ('contact_phone' in normalized) {
      await _propagatePhone(conn, contactId, normalized.contact_phone || '', userId);
    }

    // 3. Propagate contact_email
    if ('contact_email' in normalized) {
      await _propagateEmail(conn, contactId, normalized.contact_email || '', userId);
    }

    // 4. Propagate contact_address / city / state / zip
    const addrKeys = ['contact_address', 'contact_city', 'contact_state', 'contact_zip'];
    if (addrKeys.some(k => k in normalized)) {
      await _propagateAddress(conn, contactId, normalized, userId);
    }

    await conn.commit();
    return { contact_id: contactId, updated_fields: finalKeys };
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * List sequence enrollments for a contact with pagination, status filter,
 * and active/all scope.
 */
async function listContactSequences(db, contactId, {
  limit  = 50,
  offset = 0,
  status = null,
  scope  = 'active',
} = {}) {
  const [[row]] = await db.query(
    `SELECT contact_id FROM contacts WHERE contact_id = ?`,
    [contactId]
  );
  if (!row) return null;

  const effectiveStatus = status || (scope === 'active' ? 'active' : null);

  const whereParts  = ['se.contact_id = ?'];
  const whereParams = [contactId];
  if (effectiveStatus) {
    whereParts.push('se.status = ?');
    whereParams.push(effectiveStatus);
  }
  const whereSQL = whereParts.join(' AND ');

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

  const [[{ active_total }]] = await db.query(
    `SELECT COUNT(*) AS active_total
       FROM sequence_enrollments
      WHERE contact_id = ? AND status = 'active'`,
    [contactId]
  );

  return { sequences, total, active_total };
}

/**
 * List workflow executions tied to a contact.
 */
async function listContactWorkflows(db, contactId, {
  limit  = 50,
  offset = 0,
  status = null,
  scope  = 'active',
} = {}) {
  const [[row]] = await db.query(
    `SELECT contact_id FROM contacts WHERE contact_id = ?`,
    [contactId]
  );
  if (!row) return null;

  const NON_TERMINAL = ['active', 'processing', 'delayed'];

  const whereParts  = ['we.contact_id = ?'];
  const whereParams = [contactId];
  if (status) {
    whereParts.push('we.status = ?');
    whereParams.push(status);
  } else if (scope === 'active') {
    whereParts.push(`we.status IN (${NON_TERMINAL.map(() => '?').join(',')})`);
    whereParams.push(...NON_TERMINAL);
  }
  const whereSQL = whereParts.join(' AND ');

  const [workflows] = await db.query(
    `SELECT
       we.id                     AS execution_id,
       we.workflow_id,
       we.status,
       we.current_step_number,
       we.steps_executed_count,
       we.cancel_reason,
       we.created_at,
       we.updated_at,
       we.completed_at,
       w.name                    AS workflow_name
     FROM workflow_executions we
     LEFT JOIN workflows w ON w.id = we.workflow_id
     WHERE ${whereSQL}
     ORDER BY we.created_at DESC
     LIMIT ? OFFSET ?`,
    [...whereParams, parseInt(limit, 10), parseInt(offset, 10)]
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM workflow_executions we WHERE ${whereSQL}`,
    whereParams
  );

  const placeholders = NON_TERMINAL.map(() => '?').join(',');
  const [[{ active_total }]] = await db.query(
    `SELECT COUNT(*) AS active_total
       FROM workflow_executions
      WHERE contact_id = ? AND status IN (${placeholders})`,
    [contactId, ...NON_TERMINAL]
  );

  return { workflows, total, active_total };
}

module.exports = {
  listContacts,
  getContact,
  createContact,
  updateContact,
  normalizePhone,
  normalizeEmail,
  listContactSequences,
  listContactWorkflows,
  stripSsn
};