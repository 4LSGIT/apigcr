// services/contactEmailService.js
//
/**
 * Contact Email Service
 * services/contactEmailService.js
 *
 * CRUD + lifecycle for the contact_emails table. Companion to the legacy
 * contacts.contact_email column, which is now maintained as the
 * denormalized projection of the primary-active row in contact_emails.
 *
 * Mirror maintenance is delegated to lib/contactMirror.js after every
 * mutation that could change the primary-active row.
 *
 * Conventions (mirror services/contactPhoneService.js):
 *   - Validation errors throw Error with a user-presentable .message —
 *     the route layer maps them to 400/404/500 based on substring match.
 *   - Email-collision errors throw Error with a .conflict property
 *     attached; the route maps these to 409.
 *   - created_by / updated_by accept 0 as a sentinel for "no user identity"
 *     (API-key auth, system actions, legacy propagation without plumbed
 *     userId).
 *   - All mutations are wrapped in a transaction so that the child-table
 *     write + mirror recompute land atomically.
 *
 * Email normalization (trim + lowercase) is applied on input. Equality
 * comparisons in this service and in legacy propagation use the normalized
 * form, so 'Foo@BAR.com' and 'foo@bar.com' are treated as the same address.
 * The stored row is the normalized form.
 *
 * SLICE 3 STAGE A: validateEmailRow extracted as a pure validator that
 * is used both by the dedicated create/update routes here AND by the
 * aggregate reconciler in services/contactService.js. The validator has
 * two modes: 'insert' (full row with defaults; email required) and
 * 'update' (sparse — only fields present are validated/normalized).
 * Behavior of createContactEmail / updateContactEmail is unchanged.
 *
 * NOTE: audit logging for child-table mutations is deferred to a later
 * slice. The audit trigger on the contacts table will fire when the
 * mirror helper updates contact_email; per-row audit on contact_emails
 * itself is TBD.
 *
 * Usage:
 *   const emailSvc = require('../services/contactEmailService');
 *   const { emails } = await emailSvc.listContactEmails(db, contactId);
 *   const { email } = await emailSvc.createContactEmail(db, contactId, fields, { createdBy: 3 });
 */

const { recomputePrimaryEmail } = require('../lib/contactMirror');


// ─────────────────────────────────────────────────────────────
// Constants & helpers
// ─────────────────────────────────────────────────────────────

const EMAIL_LABELS    = ['Personal', 'Work', 'Other'];
const EMAIL_REGEX     = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EMAIL_MAX_LENGTH = 100; // matches contact_emails.email VARCHAR(100)

/**
 * Normalize an email: trim + lowercase. NOT exhaustive (no IDN handling,
 * no plus-tag stripping); intentional, see service header.
 *
 * @param {string|number|null|undefined} email
 * @returns {string}  - trimmed/lowercased, or '' if input is empty/null
 */
function normalizeEmail(email) {
  if (!email && email !== 0) return '';
  return String(email).trim().toLowerCase();
}

/** Normalize a possibly-empty date input to null. */
function _normDate(v) {
  if (v == null || v === '') return null;
  return v;
}

/** Coerce truthy/falsy to 0/1 for tinyint columns. */
function _toBit(v) {
  return v ? 1 : 0;
}


// ─────────────────────────────────────────────────────────────
// validateEmailRow — pure validator (no DB access)
// ─────────────────────────────────────────────────────────────

/**
 * Validate + normalize an email row. Pure function — no DB access. Used
 * by both the dedicated route handlers (createContactEmail /
 * updateContactEmail) and by the aggregate reconciler
 * (contactService._planEmails).
 *
 * Returns a normalized row object. Throws Error with a `.field` property
 * naming the offending column on validation failure.
 *
 * Modes:
 *   - 'insert' (default): full-row semantics. `email` is required and
 *     must satisfy EMAIL_REGEX and EMAIL_MAX_LENGTH. Missing optional
 *     fields take INSERT-time defaults. `is_primary` is preserved as
 *     `undefined` when absent so callers can apply auto-promote logic.
 *     Tinyint outputs are 0/1 (not booleans).
 *   - 'update': sparse semantics. Only fields actually present in `fields`
 *     appear in the result. Missing fields are NOT defaulted.
 *
 * @param {object} fields
 * @param {object} [opts]
 * @param {'insert'|'update'} [opts.mode='insert']
 * @returns {object}  normalized row (full in insert mode, sparse in update mode)
 */
function validateEmailRow(fields, { mode = 'insert' } = {}) {
  if (mode === 'insert') {
    const email = normalizeEmail(fields.email);
    if (!EMAIL_REGEX.test(email)) {
      const e = new Error('Invalid email — must be a valid address');
      e.field = 'email';
      throw e;
    }
    if (email.length > EMAIL_MAX_LENGTH) {
      const e = new Error(`Invalid email — exceeds ${EMAIL_MAX_LENGTH} character limit`);
      e.field = 'email';
      throw e;
    }

    const label = fields.label || 'Other';
    if (!EMAIL_LABELS.includes(label)) {
      const e = new Error(`Invalid label "${label}" (allowed: ${EMAIL_LABELS.join(', ')})`);
      e.field = 'label';
      throw e;
    }

    const result = {
      email,
      label,
      email_optout: _toBit(fields.email_optout),
      verified:     _toBit(fields.verified),
      start_date:   _normDate(fields.start_date),
      end_date:     _normDate(fields.end_date),
      end_reason:   fields.end_reason || null,
      notes:        fields.notes == null ? '' : fields.notes,
    };
    if (fields.is_primary !== undefined) {
      result.is_primary = _toBit(fields.is_primary);
    }
    return result;
  }

  // mode === 'update'
  const result = {};
  if ('email' in fields) {
    const email = normalizeEmail(fields.email);
    if (!EMAIL_REGEX.test(email)) {
      const e = new Error('Invalid email — must be a valid address');
      e.field = 'email';
      throw e;
    }
    if (email.length > EMAIL_MAX_LENGTH) {
      const e = new Error(`Invalid email — exceeds ${EMAIL_MAX_LENGTH} character limit`);
      e.field = 'email';
      throw e;
    }
    result.email = email;
  }
  if ('label' in fields) {
    if (!EMAIL_LABELS.includes(fields.label)) {
      const e = new Error(`Invalid label "${fields.label}" (allowed: ${EMAIL_LABELS.join(', ')})`);
      e.field = 'label';
      throw e;
    }
    result.label = fields.label;
  }
  if ('is_primary'   in fields) result.is_primary   = _toBit(fields.is_primary);
  if ('email_optout' in fields) result.email_optout = _toBit(fields.email_optout);
  if ('verified'     in fields) result.verified     = _toBit(fields.verified);
  if ('start_date'   in fields) result.start_date   = _normDate(fields.start_date);
  if ('end_date'     in fields) result.end_date     = _normDate(fields.end_date);
  if ('end_reason'   in fields) result.end_reason   = fields.end_reason == null ? null : fields.end_reason;
  if ('notes'        in fields) result.notes        = fields.notes == null ? '' : fields.notes;
  return result;
}


/** Shared SELECT/JOIN for fetching one or many emails with user joins. */
const EMAIL_SELECT_SQL = `
  SELECT ce.id, ce.contact_id, ce.email, ce.label, ce.is_primary,
         ce.email_optout, ce.verified,
         ce.start_date, ce.end_date, ce.end_reason, ce.notes,
         ce.created_at, ce.updated_at, ce.created_by, ce.updated_by,
         uc.user_name AS created_by_name,
         uu.user_name AS updated_by_name
    FROM contact_emails ce
    LEFT JOIN users uc ON uc.user = ce.created_by
    LEFT JOIN users uu ON uu.user = ce.updated_by
`;


// ─────────────────────────────────────────────────────────────
// listContactEmails
// ─────────────────────────────────────────────────────────────

/**
 * List emails for one contact.
 *
 * Returns null when the contact doesn't exist (route → 404).
 *
 * Ordering: primary-active first, then non-primary active, then ended rows,
 * with id ASC within each group (stable insert order).
 *
 * @param {object} db
 * @param {number|string} contactId
 * @param {object} [opts]
 * @param {boolean} [opts.include_inactive=false]
 * @returns {Promise<{emails: object[]} | null>}
 */
async function listContactEmails(db, contactId, { include_inactive = false } = {}) {
  const [[exists]] = await db.query(
    `SELECT contact_id FROM contacts WHERE contact_id = ?`,
    [contactId]
  );
  if (!exists) return null;

  const whereParts  = ['ce.contact_id = ?'];
  const whereParams = [contactId];
  if (!include_inactive) {
    whereParts.push('ce.end_date IS NULL');
  }
  const whereSQL = whereParts.join(' AND ');

  const [rows] = await db.query(
    `${EMAIL_SELECT_SQL}
      WHERE ${whereSQL}
      ORDER BY ce.is_primary DESC, (ce.end_date IS NULL) DESC, ce.id ASC`,
    whereParams
  );

  return { emails: rows };
}


// ─────────────────────────────────────────────────────────────
// getContactEmail
// ─────────────────────────────────────────────────────────────

/**
 * Fetch one email row in the full list-row shape (with user joins).
 * Returns null if not found.
 *
 * @param {object} db
 * @param {number|string} emailId
 * @returns {Promise<object|null>}
 */
async function getContactEmail(db, emailId) {
  const [[row]] = await db.query(
    `${EMAIL_SELECT_SQL} WHERE ce.id = ?`,
    [emailId]
  );
  return row || null;
}


// ─────────────────────────────────────────────────────────────
// createContactEmail
// ─────────────────────────────────────────────────────────────

/**
 * Create a contact_emails row.
 *
 * Validates (via validateEmailRow):
 *   - email normalizes + matches EMAIL_REGEX
 *   - email length <= EMAIL_MAX_LENGTH (100)
 *   - label is in EMAIL_LABELS (if provided)
 *   - contact exists
 *
 * Behavior:
 *   - Active-uniqueness collision, two cases:
 *       (a) same-contact   — the contact already has this email as an
 *           active row. Throws 400 ("already has...") directing the
 *           caller to PATCH/END the existing row instead.
 *       (b) cross-contact  — email is active on a DIFFERENT contact.
 *           Throws (with .conflict attached → 409) unless force=true,
 *           in which case the donor's row is ended ('transferred') and
 *           the donor's mirror is recomputed.
 *   - Same-contact primary demotion: if the new row is_primary=true,
 *     any existing primary-active row for this contact is demoted (in
 *     the same transaction).
 *   - Auto-promote: if the contact has zero email rows (active or not)
 *     before this insert AND is_primary wasn't explicitly set, default
 *     to is_primary=true. Surfaces as `auto_promoted: true` in response.
 *   - Historical reclamation: a contact may have ended rows with the
 *     same email value (post-Slice-2-Stage-1-revision migration). The
 *     INSERT proceeds and yields a new active row alongside the
 *     historical ended one(s).
 *
 * Cross-contact transfer donor-end rule (Slice 3.5):
 * On the force=true cross-contact transfer path below, the donor's
 * end_date is set to yesterday (DATE_SUB(CURDATE(), INTERVAL 1 DAY)) to
 * guarantee no same-day ownership overlap with the recipient.
 *
 * Edge case: a row created today and transferred today produces
 * end_date = today - 1 while start_date = today (i.e., end_date < start_date).
 * This is intentional — the donor never owned the value across any
 * meaningful interval. Reader queries using end_date >= log_created
 * naturally attribute any log written during that zero-duration window
 * to the recipient.
 *
 * No CHECK constraint exists on (end_date >= start_date) and none should be added
 * without first deciding whether to backfill or to remove same-day-transfer artifacts.
 *
 * @param {object} db
 * @param {number|string} contactId
 * @param {object} fields
 * @param {string}  fields.email        - required; normalized + validated
 * @param {string}  [fields.label='Other']
 * @param {boolean} [fields.is_primary]
 * @param {boolean} [fields.email_optout=false]
 * @param {boolean} [fields.verified=false]
 * @param {string}  [fields.start_date]
 * @param {string}  [fields.notes='']
 * @param {object}  [opts]
 * @param {boolean} [opts.force=false]
 * @param {number}  [opts.createdBy=0]
 * @returns {Promise<{email: object, auto_promoted: boolean, transferred_from?: object}>}
 */
async function createContactEmail(db, contactId, fields = {}, { force = false, createdBy = 0 } = {}) {
  // ─── Validation (pre-transaction) ───
  const validated = validateEmailRow(fields, { mode: 'insert' });

  const [[contactRow]] = await db.query(
    `SELECT contact_id FROM contacts WHERE contact_id = ?`,
    [contactId]
  );
  if (!contactRow) throw new Error(`Contact ${contactId} not found`);

  const cid = parseInt(contactId, 10);

  // ─── Transaction ───
  const { newId, autoPromoted, transferredFrom } = await db.withTransaction(async (conn) => {

    // 1. Active-uniqueness collision check
    let transferredFrom = null;
    const [[collision]] = await conn.query(
      `SELECT ce.id AS email_id, ce.contact_id, c.contact_name
         FROM contact_emails ce
         JOIN contacts c ON c.contact_id = ce.contact_id
        WHERE ce.email = ? AND ce.end_date IS NULL`,
      [validated.email]
    );

    if (collision) {
      if (collision.contact_id === cid) {
        // (a) same-contact: refuse and direct to PATCH the existing row
        throw new Error(
          'This contact already has this email as an active row. ' +
          'End or update the existing row first.'
        );
      }

      // (b) cross-contact
      if (!force) {
        const err = new Error(
          `Email is currently active on contact ${collision.contact_id} (${collision.contact_name})`
        );
        err.conflict = {
          contact_id:   collision.contact_id,
          contact_name: collision.contact_name,
          email_id:     collision.email_id,
        };
        throw err;
      }
      // force=true: end the donor's row + recompute donor's mirror.
      // Slice 3.5: donor ends YESTERDAY to guarantee no same-day
      // ownership overlap with the recipient (see function JSDoc).
      await conn.query(
        `UPDATE contact_emails
            SET end_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY),
                is_primary = 0,
                end_reason = 'transferred',
                updated_by = ?
          WHERE id = ?`,
        [createdBy, collision.email_id]
      );
      await recomputePrimaryEmail(conn, collision.contact_id);
      transferredFrom = {
        contact_id:   collision.contact_id,
        contact_name: collision.contact_name,
        email_id:     collision.email_id,
      };
    }

    // 2. Auto-promote check
    let isPrimary; // 0 or 1
    let autoPromoted = false;
    if (validated.is_primary !== undefined) {
      isPrimary = validated.is_primary; // already 0 or 1 from validator
    } else {
      const [[{ cnt }]] = await conn.query(
        `SELECT COUNT(*) AS cnt FROM contact_emails WHERE contact_id = ?`,
        [cid]
      );
      if (cnt === 0) {
        isPrimary   = 1;
        autoPromoted = true;
      } else {
        isPrimary = 0;
      }
    }

    // 3. Demote existing primary-active if we're inserting as primary
    if (isPrimary === 1) {
      await conn.query(
        `UPDATE contact_emails
            SET is_primary = 0, updated_by = ?
          WHERE contact_id = ? AND is_primary = 1 AND end_date IS NULL`,
        [createdBy, cid]
      );
    }

    // 4. INSERT new row
    let newId;
    try {
      const [insertResult] = await conn.query(
        `INSERT INTO contact_emails
           (contact_id, email, label, is_primary,
            email_optout, verified,
            start_date, notes, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURDATE()), ?, ?, ?)`,
        [
          cid, validated.email, validated.label, isPrimary,
          validated.email_optout,
          validated.verified,
          validated.start_date,
          validated.notes,
          createdBy, createdBy,
        ]
      );
      newId = insertResult.insertId;
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        // After the Slice 2 Stage 1 revision migration, uc_contact_email
        // is dropped, so this can only fire from uk_email_active (race)
        // or uk_one_active_primary (race). Same remediation: same-contact-
        // style 400, caller retries.
        throw new Error(
          'This contact already has this email as an active row. ' +
          'End or update the existing row first. ' +
          '(Likely a concurrent update — refresh and retry.)'
        );
      }
      throw err;
    }

    // 5. Recompute target contact's mirror
    await recomputePrimaryEmail(conn, cid);

    return { newId, autoPromoted, transferredFrom };
  });

  // 6. Re-fetch with joins (post-commit)
  const emailRow = await getContactEmail(db, newId);

  const result = {
    email:         emailRow,
    auto_promoted: autoPromoted,
  };
  if (transferredFrom) result.transferred_from = transferredFrom;
  return result;
}


// ─────────────────────────────────────────────────────────────
// updateContactEmail
// ─────────────────────────────────────────────────────────────

/**
 * Update lifecycle fields on a contact_emails row.
 *
 * Allowed:   label, is_primary, email_optout, verified, end_date,
 *            end_reason, notes
 * Forbidden: id, contact_id, email, start_date, created_*, updated_*,
 *            generated columns. Changing the email value is not supported
 *            via PATCH — delete and re-create instead.
 *            (NOTE: the AGGREGATE PATCH route in api.contacts.js DOES
 *             support email value changes via end-and-replace. This
 *             dedicated PATCH does not.)
 *
 * Transitions:
 *   - is_primary 0→1 → demotes any existing primary-active row first
 *   - end_date NULL→non-NULL on a primary-active row → also clears
 *     is_primary in the same UPDATE
 *
 * Mirror recompute fires if is_primary or end_date appears in fields.
 *
 * @param {object} db
 * @param {number|string} emailId
 * @param {object} fields
 * @param {object} [opts]
 * @param {number} [opts.updatedBy=0]
 * @returns {Promise<{ email: object }>}
 */
async function updateContactEmail(db, emailId, fields, { updatedBy = 0 } = {}) {
  if (!fields || !Object.keys(fields).length) {
    throw new Error('updateContactEmail requires at least one field');
  }

  const ALLOWED = ['label', 'is_primary', 'email_optout',
                   'verified', 'end_date', 'end_reason', 'notes'];
  const unknown = Object.keys(fields).filter(k => !ALLOWED.includes(k));
  if (unknown.length) {
    throw new Error(`Cannot update ${unknown.join(', ')}`);
  }

  // validateEmailRow (update mode) — sparse, per-field shape validation.
  const incoming = validateEmailRow(fields, { mode: 'update' });

  await db.withTransaction(async (conn) => {

    const [[current]] = await conn.query(
      `SELECT * FROM contact_emails WHERE id = ?`,
      [emailId]
    );
    if (!current) throw new Error(`Email ${emailId} not found`);

    const becomingPrimary = 'is_primary' in incoming
      && incoming.is_primary === 1
      && current.is_primary !== 1;
    const beingEnded = 'end_date' in incoming
      && incoming.end_date !== null
      && current.end_date === null;

    if (beingEnded && current.is_primary === 1) {
      incoming.is_primary = 0;
    }

    if (becomingPrimary && !beingEnded) {
      await conn.query(
        `UPDATE contact_emails
            SET is_primary = 0, updated_by = ?
          WHERE contact_id = ? AND is_primary = 1 AND end_date IS NULL AND id <> ?`,
        [updatedBy, current.contact_id, emailId]
      );
    }

    incoming.updated_by = updatedBy;
    const setKeys = Object.keys(incoming);
    const setSQL  = setKeys.map(k => `\`${k}\` = ?`).join(', ');
    const setVals = setKeys.map(k => incoming[k]);

    try {
      await conn.query(
        `UPDATE contact_emails SET ${setSQL} WHERE id = ?`,
        [...setVals, emailId]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new Error(
          'Update would violate uniqueness (uk_one_active_primary or uk_email_active). ' +
          'Another primary-active row may exist for this contact, or the email ' +
          'is already active elsewhere.'
        );
      }
      throw err;
    }

    const mirrorAffected = 'is_primary' in incoming || 'end_date' in incoming;
    if (mirrorAffected) {
      await recomputePrimaryEmail(conn, current.contact_id);
    }
  });

  const emailRow = await getContactEmail(db, emailId);
  return { email: emailRow };
}


// ─────────────────────────────────────────────────────────────
// deleteContactEmail
// ─────────────────────────────────────────────────────────────

/**
 * Hard-delete one contact_emails row.
 * Mirror recompute fires if the deleted row was primary-active.
 *
 * @param {object} db
 * @param {number|string} emailId
 * @returns {Promise<{ deleted: true, deleted_id: number }>}
 */
async function deleteContactEmail(db, emailId) {
  await db.withTransaction(async (conn) => {

    const [[current]] = await conn.query(
      `SELECT id, contact_id, is_primary, end_date FROM contact_emails WHERE id = ?`,
      [emailId]
    );
    if (!current) throw new Error(`Email ${emailId} not found`);

    await conn.query(`DELETE FROM contact_emails WHERE id = ?`, [emailId]);

    if (current.is_primary === 1 && current.end_date === null) {
      await recomputePrimaryEmail(conn, current.contact_id);
    }
  });

  return { deleted: true, deleted_id: parseInt(emailId, 10) };
}


// ─────────────────────────────────────────────────────────────
// setPrimaryContactEmail (convenience wrapper)
// ─────────────────────────────────────────────────────────────

/**
 * Promote an email row to primary. Equivalent to
 * updateContactEmail(db, emailId, { is_primary: 1 }, { updatedBy }).
 */
async function setPrimaryContactEmail(db, emailId, { updatedBy = 0 } = {}) {
  return updateContactEmail(db, emailId, { is_primary: 1 }, { updatedBy });
}


module.exports = {
  listContactEmails,
  getContactEmail,
  createContactEmail,
  updateContactEmail,
  deleteContactEmail,
  setPrimaryContactEmail,
  normalizeEmail,
  validateEmailRow,
  EMAIL_LABELS,
};