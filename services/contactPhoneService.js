// services/contactPhoneService.js
//
/**
 * Contact Phone Service
 * services/contactPhoneService.js
 *
 * CRUD + lifecycle for the contact_phones table. Companion to the legacy
 * contacts.contact_phone column, which is now maintained as the
 * denormalized projection of the primary-active row in contact_phones.
 *
 * Mirror maintenance is delegated to lib/contactMirror.js after every
 * mutation that could change the primary-active row.
 *
 * Conventions (mirror services/contactRelationService.js):
 *   - Validation errors throw Error with a user-presentable .message —
 *     the route layer maps them to 400/404/500 based on substring match.
 *   - Phone-collision errors throw Error with a .conflict property
 *     attached; the route maps these to 409.
 *   - created_by / updated_by accept 0 as a sentinel for "no user identity"
 *     (API-key auth, system actions, legacy propagation without plumbed
 *     userId).
 *   - All mutations are wrapped in a transaction so that the child-table
 *     write + mirror recompute land atomically. This guarantees the
 *     contacts.contact_phone column can never drift from the
 *     contact_phones primary-active row.
 *
 * SLICE 3 STAGE A: validatePhoneRow extracted as a pure validator that
 * is used both by the dedicated create/update routes here AND by the
 * aggregate reconciler in services/contactService.js. The validator has
 * two modes: 'insert' (full row with defaults; phone required) and
 * 'update' (sparse — only fields present are validated/normalized).
 * Behavior of createContactPhone / updateContactPhone is unchanged.
 *
 * NOTE: audit logging for child-table mutations is deferred to a later
 * slice. The audit trigger on the contacts table will fire when the
 * mirror helper updates contact_phone; per-row audit on contact_phones
 * itself is TBD.
 *
 * Usage:
 *   const phoneSvc = require('../services/contactPhoneService');
 *   const { phones } = await phoneSvc.listContactPhones(db, contactId);
 *   const { phone } = await phoneSvc.createContactPhone(db, contactId, fields, { createdBy: 3 });
 */

const { recomputePrimaryPhone } = require('../lib/contactMirror');


// ─────────────────────────────────────────────────────────────
// Constants & helpers
// ─────────────────────────────────────────────────────────────

const PHONE_LABELS = ['Mobile', 'Home', 'Work', 'Office', 'Fax', 'Other'];

/**
 * Normalize a phone string to 10 digits. Strips +1 prefix, dashes, etc.
 * Duplicates the helper in contactService.js intentionally so this service
 * is self-contained (no cross-service import). Kept in sync with that
 * function's behavior.
 *
 * @param {string|number|null|undefined} phone
 * @returns {string}  - 10 digits, or '' if input is empty/null
 */
function normalizePhone(phone) {
  if (!phone && phone !== 0) return '';
  const digits = String(phone).replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/**
 * Normalize a possibly-empty date input to null. Lets the route pass
 * '' (from a cleared form field) without writing '0000-00-00'.
 */
function _normDate(v) {
  if (v == null || v === '') return null;
  return v;
}

/** Coerce truthy/falsy to 0/1 for tinyint columns. */
function _toBit(v) {
  return v ? 1 : 0;
}


// ─────────────────────────────────────────────────────────────
// validatePhoneRow — pure validator (no DB access)
// ─────────────────────────────────────────────────────────────

/**
 * Validate + normalize a phone row. Pure function — no DB access. Used
 * by both the dedicated route handlers (createContactPhone /
 * updateContactPhone) and by the aggregate reconciler
 * (contactService._planPhones).
 *
 * Returns a normalized row object. Throws Error with a `.field` property
 * naming the offending column on validation failure.
 *
 * Modes:
 *   - 'insert' (default): full-row semantics. `phone` is required.
 *     Missing optional fields take INSERT-time defaults. `is_primary`
 *     is preserved as `undefined` when absent so callers can apply
 *     auto-promote logic. Tinyint outputs are 0/1 (not booleans).
 *   - 'update': sparse semantics. Only fields actually present in `fields`
 *     appear in the result. Missing fields are NOT defaulted. Useful for
 *     PATCH-style operations that should not touch unspecified columns.
 *
 * Note on PHONE_LABELS validation:
 *   - In 'insert' mode, label defaults to 'Other' if not provided.
 *   - In 'update' mode, label is validated only if present in `fields`.
 *
 * @param {object} fields
 * @param {object} [opts]
 * @param {'insert'|'update'} [opts.mode='insert']
 * @returns {object}  normalized row (full in insert mode, sparse in update mode)
 */
function validatePhoneRow(fields, { mode = 'insert' } = {}) {
  if (mode === 'insert') {
    const phone = normalizePhone(fields.phone);
    if (phone.length !== 10) {
      const e = new Error('Invalid phone — must be 10 digits');
      e.field = 'phone';
      throw e;
    }

    const label = fields.label || 'Other';
    if (!PHONE_LABELS.includes(label)) {
      const e = new Error(`Invalid label "${label}" (allowed: ${PHONE_LABELS.join(', ')})`);
      e.field = 'label';
      throw e;
    }

    const result = {
      phone,
      label,
      sms_optout:  _toBit(fields.sms_optout),
      mms_capable: fields.mms_capable === undefined ? 1 : _toBit(fields.mms_capable),
      verified:    _toBit(fields.verified),
      start_date:  _normDate(fields.start_date),
      end_date:    _normDate(fields.end_date),
      end_reason:  fields.end_reason || null,
      notes:       fields.notes == null ? '' : fields.notes,
    };
    // Preserve is_primary as undefined when caller didn't set it, so
    // auto-promote logic (in createContactPhone / aggregate reconciler)
    // can distinguish "user said no" from "user didn't say".
    if (fields.is_primary !== undefined) {
      result.is_primary = _toBit(fields.is_primary);
    }
    return result;
  }

  // mode === 'update'
  const result = {};
  if ('phone' in fields) {
    const phone = normalizePhone(fields.phone);
    if (phone.length !== 10) {
      const e = new Error('Invalid phone — must be 10 digits');
      e.field = 'phone';
      throw e;
    }
    result.phone = phone;
  }
  if ('label' in fields) {
    if (!PHONE_LABELS.includes(fields.label)) {
      const e = new Error(`Invalid label "${fields.label}" (allowed: ${PHONE_LABELS.join(', ')})`);
      e.field = 'label';
      throw e;
    }
    result.label = fields.label;
  }
  if ('is_primary'  in fields) result.is_primary  = _toBit(fields.is_primary);
  if ('sms_optout'  in fields) result.sms_optout  = _toBit(fields.sms_optout);
  if ('mms_capable' in fields) result.mms_capable = _toBit(fields.mms_capable);
  if ('verified'    in fields) result.verified    = _toBit(fields.verified);
  if ('start_date'  in fields) result.start_date  = _normDate(fields.start_date);
  if ('end_date'    in fields) result.end_date    = _normDate(fields.end_date);
  if ('end_reason'  in fields) result.end_reason  = fields.end_reason == null ? null : fields.end_reason;
  if ('notes'       in fields) result.notes       = fields.notes == null ? '' : fields.notes;
  return result;
}


/** Shared SELECT/JOIN for fetching one or many phones with user joins. */
const PHONE_SELECT_SQL = `
  SELECT cp.id, cp.contact_id, cp.phone, cp.label, cp.is_primary,
         cp.sms_optout, cp.mms_capable, cp.verified,
         cp.start_date, cp.end_date, cp.end_reason, cp.notes,
         cp.created_at, cp.updated_at, cp.created_by, cp.updated_by,
         uc.user_name AS created_by_name,
         uu.user_name AS updated_by_name
    FROM contact_phones cp
    LEFT JOIN users uc ON uc.user = cp.created_by
    LEFT JOIN users uu ON uu.user = cp.updated_by
`;


// ─────────────────────────────────────────────────────────────
// listContactPhones
// ─────────────────────────────────────────────────────────────

/**
 * List phones for one contact.
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
 * @returns {Promise<{phones: object[]} | null>}
 */
async function listContactPhones(db, contactId, { include_inactive = false } = {}) {
  const [[exists]] = await db.query(
    `SELECT contact_id FROM contacts WHERE contact_id = ?`,
    [contactId]
  );
  if (!exists) return null;

  const whereParts  = ['cp.contact_id = ?'];
  const whereParams = [contactId];
  if (!include_inactive) {
    whereParts.push('cp.end_date IS NULL');
  }
  const whereSQL = whereParts.join(' AND ');

  const [rows] = await db.query(
    `${PHONE_SELECT_SQL}
      WHERE ${whereSQL}
      ORDER BY cp.is_primary DESC, (cp.end_date IS NULL) DESC, cp.id ASC`,
    whereParams
  );

  return { phones: rows };
}


// ─────────────────────────────────────────────────────────────
// getContactPhone
// ─────────────────────────────────────────────────────────────

/**
 * Fetch one phone row in the full list-row shape (with user joins).
 * Returns null if not found.
 *
 * @param {object} db
 * @param {number|string} phoneId
 * @returns {Promise<object|null>}
 */
async function getContactPhone(db, phoneId) {
  const [[row]] = await db.query(
    `${PHONE_SELECT_SQL} WHERE cp.id = ?`,
    [phoneId]
  );
  return row || null;
}


// ─────────────────────────────────────────────────────────────
// createContactPhone
// ─────────────────────────────────────────────────────────────

/**
 * Create a contact_phones row.
 *
 * Validates (via validatePhoneRow):
 *   - phone normalizes to exactly 10 digits
 *   - label is in PHONE_LABELS (if provided)
 *   - contact exists
 *
 * Behavior:
 *   - Active-uniqueness collision, two cases:
 *       (a) same-contact   — the contact already has this phone as an
 *           active row. Throws 400 ("already has...") directing the
 *           caller to PATCH/END the existing row instead.
 *       (b) cross-contact  — phone is active on a DIFFERENT contact.
 *           Throws (with .conflict attached → 409) unless force=true,
 *           in which case the donor's row is ended ('transferred') and
 *           the donor's mirror is recomputed.
 *   - Same-contact primary demotion: if the new row is_primary=true,
 *     any existing primary-active row for this contact is demoted (in
 *     the same transaction).
 *   - Auto-promote: if the contact has zero phone rows (active or not)
 *     before this insert AND is_primary wasn't explicitly set, default
 *     to is_primary=true. Surfaces as `auto_promoted: true` in response.
 *   - Historical reclamation: a contact may have ended rows with the
 *     same phone value (post-Slice-2-Stage-1-revision migration). The
 *     INSERT proceeds and yields a new active row alongside the
 *     historical ended one(s).
 *
 * The whole operation runs in a transaction so the insert + mirror
 * recompute land atomically (and rollback together on any failure).
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
 * @param {string}  fields.phone        - required; normalized to 10 digits
 * @param {string}  [fields.label='Other']
 * @param {boolean} [fields.is_primary]
 * @param {boolean} [fields.sms_optout=false]
 * @param {boolean} [fields.mms_capable=true]
 * @param {boolean} [fields.verified=false]
 * @param {string}  [fields.start_date] - DATE string; defaults to today via SQL CURDATE()
 * @param {string}  [fields.notes='']
 * @param {object}  [opts]
 * @param {boolean} [opts.force=false]      - silently transfer on global collision
 * @param {number}  [opts.createdBy=0]      - users.user value, or 0 for system
 * @returns {Promise<{phone: object, auto_promoted: boolean, transferred_from?: object}>}
 */
async function createContactPhone(db, contactId, fields = {}, { force = false, createdBy = 0 } = {}) {
  // ─── Validation (pre-transaction) ───
  // validatePhoneRow throws on bad phone/label; preserves is_primary as
  // undefined when caller didn't set it, so auto-promote works below.
  const validated = validatePhoneRow(fields, { mode: 'insert' });

  const [[contactRow]] = await db.query(
    `SELECT contact_id FROM contacts WHERE contact_id = ?`,
    [contactId]
  );
  if (!contactRow) throw new Error(`Contact ${contactId} not found`);

  const cid = parseInt(contactId, 10);

  // ─── Transaction ───
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Active-uniqueness collision check.
    //
    // Two cases:
    //   (a) same-contact     — this contact already has this phone as an
    //       active row. The right path is to PATCH/END the existing row,
    //       not stack a duplicate. Throw 400 with a directive message.
    //   (b) cross-contact    — another contact currently holds the phone.
    //       Strict mode (force=false) throws 409 with a conflict payload;
    //       force=true ends the donor's row + recomputes donor mirror.
    let transferredFrom = null;
    const [[collision]] = await conn.query(
      `SELECT cp.id AS phone_id, cp.contact_id, c.contact_name
         FROM contact_phones cp
         JOIN contacts c ON c.contact_id = cp.contact_id
        WHERE cp.phone = ? AND cp.end_date IS NULL`,
      [validated.phone]
    );

    if (collision) {
      if (collision.contact_id === cid) {
        // (a) same-contact: caller intent is ambiguous — refuse and
        // direct them to PATCH the existing row instead.
        throw new Error(
          'This contact already has this phone as an active row. ' +
          'End or update the existing row first.'
        );
      }

      // (b) cross-contact
      if (!force) {
        const err = new Error(
          `Phone is currently active on contact ${collision.contact_id} (${collision.contact_name})`
        );
        err.conflict = {
          contact_id:   collision.contact_id,
          contact_name: collision.contact_name,
          phone_id:     collision.phone_id,
        };
        throw err;
      }
      // force=true: end the donor's row + recompute donor's mirror.
      // Slice 3.5: donor ends YESTERDAY to guarantee no same-day
      // ownership overlap with the recipient (see function JSDoc).
      await conn.query(
        `UPDATE contact_phones
            SET end_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY),
                is_primary = 0,
                end_reason = 'transferred',
                updated_by = ?
          WHERE id = ?`,
        [createdBy, collision.phone_id]
      );
      await recomputePrimaryPhone(conn, collision.contact_id);
      transferredFrom = {
        contact_id:   collision.contact_id,
        contact_name: collision.contact_name,
        phone_id:     collision.phone_id,
      };
    }

    // 2. Auto-promote check (zero rows ever for this contact)
    let isPrimary; // 0 or 1
    let autoPromoted = false;
    if (validated.is_primary !== undefined) {
      isPrimary = validated.is_primary; // already 0 or 1 from validator
    } else {
      const [[{ cnt }]] = await conn.query(
        `SELECT COUNT(*) AS cnt FROM contact_phones WHERE contact_id = ?`,
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
        `UPDATE contact_phones
            SET is_primary = 0, updated_by = ?
          WHERE contact_id = ? AND is_primary = 1 AND end_date IS NULL`,
        [createdBy, cid]
      );
    }

    // 4. INSERT new row
    let newId;
    try {
      const [insertResult] = await conn.query(
        `INSERT INTO contact_phones
           (contact_id, phone, label, is_primary,
            sms_optout, mms_capable, verified,
            start_date, notes, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURDATE()), ?, ?, ?)`,
        [
          cid, validated.phone, validated.label, isPrimary,
          validated.sms_optout,
          validated.mms_capable,
          validated.verified,
          validated.start_date,
          validated.notes,
          createdBy, createdBy,
        ]
      );
      newId = insertResult.insertId;
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        // After the Slice 2 Stage 1 revision migration, uc_contact_phone
        // is dropped, so this can only fire from uk_phone_active (a race
        // with a concurrent insert/update between our pre-SELECT and the
        // INSERT) or, less likely, uk_one_active_primary (a concurrent
        // promote of another row on the same contact). Either way the
        // remediation is the same: surface a same-contact-style 400 and
        // let the caller retry.
        throw new Error(
          'This contact already has this phone as an active row. ' +
          'End or update the existing row first. ' +
          '(Likely a concurrent update — refresh and retry.)'
        );
      }
      throw err;
    }

    // 5. Recompute target contact's mirror
    await recomputePrimaryPhone(conn, cid);

    await conn.commit();

    // 6. Re-fetch with joins (outside transaction is fine — commit is done)
    const phoneRow = await getContactPhone(db, newId);

    const result = {
      phone:         phoneRow,
      auto_promoted: autoPromoted,
    };
    if (transferredFrom) result.transferred_from = transferredFrom;
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}


// ─────────────────────────────────────────────────────────────
// updateContactPhone
// ─────────────────────────────────────────────────────────────

/**
 * Update lifecycle fields on a contact_phones row.
 *
 * Allowed:   label, is_primary, sms_optout, mms_capable, verified,
 *            end_date, end_reason, notes
 * Forbidden: id, contact_id, phone, start_date, created_*, updated_*,
 *            generated columns. Changing the phone value is not supported
 *            via PATCH — delete and re-create instead.
 *            (NOTE: the AGGREGATE PATCH route in api.contacts.js DOES
 *             support phone value changes via end-and-replace. This
 *             dedicated PATCH does not.)
 *
 * Transitions:
 *   - is_primary 0→1 → demotes any existing primary-active row first
 *   - end_date NULL→non-NULL on a primary-active row → also clears
 *     is_primary in the same UPDATE (a row can't be "primary ended")
 *
 * Mirror recompute fires if is_primary or end_date appears in fields.
 *
 * @param {object} db
 * @param {number|string} phoneId
 * @param {object} fields
 * @param {object} [opts]
 * @param {number} [opts.updatedBy=0]
 * @returns {Promise<{ phone: object }>}
 */
async function updateContactPhone(db, phoneId, fields, { updatedBy = 0 } = {}) {
  if (!fields || !Object.keys(fields).length) {
    throw new Error('updateContactPhone requires at least one field');
  }

  const ALLOWED = ['label', 'is_primary', 'sms_optout', 'mms_capable',
                   'verified', 'end_date', 'end_reason', 'notes'];
  const unknown = Object.keys(fields).filter(k => !ALLOWED.includes(k));
  if (unknown.length) {
    throw new Error(`Cannot update ${unknown.join(', ')}`);
  }

  // validatePhoneRow (update mode) does the per-field shape validation
  // + normalization that used to be inline. Sparse output — only fields
  // actually present in `fields` appear in `incoming`.
  const incoming = validatePhoneRow(fields, { mode: 'update' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Load current row
    const [[current]] = await conn.query(
      `SELECT * FROM contact_phones WHERE id = ?`,
      [phoneId]
    );
    if (!current) throw new Error(`Phone ${phoneId} not found`);

    // Detect transitions (validator already coerced to 0/1 ints)
    const becomingPrimary = 'is_primary' in incoming
      && incoming.is_primary === 1
      && current.is_primary !== 1;
    const beingEnded = 'end_date' in incoming
      && incoming.end_date !== null
      && current.end_date === null;

    // A primary row being ended must lose its primary flag in the same UPDATE.
    // Otherwise the uk_one_active_primary virtual generated column wouldn't
    // change (end_date going non-NULL makes is_primary_uniq NULL anyway),
    // but the semantic invariant "primary <=> active" should hold. Clear it.
    if (beingEnded && current.is_primary === 1) {
      incoming.is_primary = 0;
    }

    // 0→1 primary transition: demote any other primary-active row first.
    // Skip if this same row is being ended in the same call (already 0'd).
    if (becomingPrimary && !beingEnded) {
      await conn.query(
        `UPDATE contact_phones
            SET is_primary = 0, updated_by = ?
          WHERE contact_id = ? AND is_primary = 1 AND end_date IS NULL AND id <> ?`,
        [updatedBy, current.contact_id, phoneId]
      );
    }

    // Build UPDATE
    incoming.updated_by = updatedBy;
    const setKeys = Object.keys(incoming);
    const setSQL  = setKeys.map(k => `\`${k}\` = ?`).join(', ');
    const setVals = setKeys.map(k => incoming[k]);

    try {
      await conn.query(
        `UPDATE contact_phones SET ${setSQL} WHERE id = ?`,
        [...setVals, phoneId]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new Error(
          'Update would violate uniqueness (uk_one_active_primary or uk_phone_active). ' +
          'Another primary-active row may exist for this contact, or the phone ' +
          'is already active elsewhere.'
        );
      }
      throw err;
    }

    // Mirror recompute if anything touching primary-active changed
    const mirrorAffected = 'is_primary' in incoming || 'end_date' in incoming;
    if (mirrorAffected) {
      await recomputePrimaryPhone(conn, current.contact_id);
    }

    await conn.commit();

    const phoneRow = await getContactPhone(db, phoneId);
    return { phone: phoneRow };
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}


// ─────────────────────────────────────────────────────────────
// deleteContactPhone
// ─────────────────────────────────────────────────────────────

/**
 * Hard-delete one contact_phones row.
 * Throws "Phone N not found" (→ 404) if the row doesn't exist.
 * Mirror recompute fires if the deleted row was primary-active.
 *
 * @param {object} db
 * @param {number|string} phoneId
 * @returns {Promise<{ deleted: true, deleted_id: number }>}
 */
async function deleteContactPhone(db, phoneId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[current]] = await conn.query(
      `SELECT id, contact_id, is_primary, end_date FROM contact_phones WHERE id = ?`,
      [phoneId]
    );
    if (!current) throw new Error(`Phone ${phoneId} not found`);

    await conn.query(`DELETE FROM contact_phones WHERE id = ?`, [phoneId]);

    if (current.is_primary === 1 && current.end_date === null) {
      await recomputePrimaryPhone(conn, current.contact_id);
    }

    await conn.commit();
    return { deleted: true, deleted_id: parseInt(phoneId, 10) };
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}


// ─────────────────────────────────────────────────────────────
// setPrimaryContactPhone (convenience wrapper)
// ─────────────────────────────────────────────────────────────

/**
 * Promote a phone row to primary. Equivalent to
 * updateContactPhone(db, phoneId, { is_primary: 1 }, { updatedBy }).
 * Exposed for callers (workflows, internal_functions) that want the
 * intent to be obvious in their code.
 *
 * @param {object} db
 * @param {number|string} phoneId
 * @param {object} [opts]
 * @param {number} [opts.updatedBy=0]
 * @returns {Promise<{ phone: object }>}
 */
async function setPrimaryContactPhone(db, phoneId, { updatedBy = 0 } = {}) {
  return updateContactPhone(db, phoneId, { is_primary: 1 }, { updatedBy });
}


module.exports = {
  listContactPhones,
  getContactPhone,
  createContactPhone,
  updateContactPhone,
  deleteContactPhone,
  setPrimaryContactPhone,
  // Internal helpers (exported for tests / dual-write reuse)
  normalizePhone,
  validatePhoneRow,
  PHONE_LABELS,
};