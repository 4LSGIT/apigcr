// services/contactAddressService.js
//
/**
 * Contact Address Service
 * services/contactAddressService.js
 *
 * CRUD + lifecycle for the contact_addresses table. Companion to the
 * legacy contacts.contact_address / contact_city / contact_state /
 * contact_zip columns, which are now maintained as the denormalized
 * projection of the primary-active row in contact_addresses.
 *
 * Mirror maintenance is delegated to lib/contactMirror.js after every
 * mutation that could change the primary-active row's address fields.
 *
 * Conventions (mirror services/contactPhoneService.js with addresses'
 * structural differences):
 *   - Validation errors throw Error with a user-presentable .message —
 *     the route layer maps them to 400/404/500 based on substring match.
 *   - created_by / updated_by accept 0 as a sentinel for "no user identity".
 *   - All mutations are wrapped in a transaction so child-table writes +
 *     mirror recompute land atomically.
 *
 * KEY DIFFERENCES FROM PHONE/EMAIL services:
 *   - NO active-uniqueness collision logic. Multiple contacts may legally
 *     share an address (e.g., spouses, children, co-tenants). There is no
 *     `force` opt, no 409 path, and no `transferred_from` response field.
 *   - PATCH allows editing the address VALUES (address1, address2, city,
 *     state, zip, country) — unlike phone/email where the value is
 *     immutable and a delete+re-create is required. Rationale: "moved
 *     vs typo" is genuinely ambiguous for addresses and forcing
 *     delete+create for every move would be onerous friction.
 *   - Mirror recompute is therefore also triggered when an address field
 *     changes on a primary-active row, not just on is_primary/end_date
 *     transitions.
 *
 * NOTE: audit logging for child-table mutations is deferred to a later
 * slice. The audit trigger on the contacts table will fire when the
 * mirror helper updates the contact_address/city/state/zip columns;
 * per-row audit on contact_addresses itself is TBD.
 *
 * Usage:
 *   const addrSvc = require('../services/contactAddressService');
 *   const { addresses } = await addrSvc.listContactAddresses(db, contactId);
 *   const { address }   = await addrSvc.createContactAddress(db, contactId, fields, { createdBy: 3 });
 */

const { recomputePrimaryAddress } = require('../lib/contactMirror');


// ─────────────────────────────────────────────────────────────
// Constants & helpers
// ─────────────────────────────────────────────────────────────

const ADDRESS_LABELS = ['Home', 'Work', 'Mailing', 'Other'];

/** Normalize a possibly-empty date input to null. */
function _normDate(v) {
  if (v == null || v === '') return null;
  return v;
}

/** Coerce truthy/falsy to 0/1 for tinyint columns. */
function _toBit(v) {
  return v ? 1 : 0;
}

/** Trim string-like input; preserve null/undefined as-is. */
function _trim(v) {
  if (v == null) return v;
  return String(v).trim();
}

/**
 * Returns true if at least one of address1/city/state/zip is non-empty.
 * Used both for create-time validation and for the legacy-clear-all-four
 * branch in dual-write propagation.
 */
function _hasAnyAddressField(row) {
  return Boolean(
    (row.address1 && String(row.address1).trim()) ||
    (row.city     && String(row.city).trim())     ||
    (row.state    && String(row.state).trim())    ||
    (row.zip      && String(row.zip).trim())
  );
}

/** Shared SELECT/JOIN for fetching one or many addresses with user joins. */
const ADDRESS_SELECT_SQL = `
  SELECT ca.id, ca.contact_id,
         ca.address1, ca.address2, ca.city, ca.state, ca.zip, ca.country,
         ca.label, ca.is_primary, ca.verified,
         ca.start_date, ca.end_date, ca.end_reason, ca.notes,
         ca.created_at, ca.updated_at, ca.created_by, ca.updated_by,
         uc.user_name AS created_by_name,
         uu.user_name AS updated_by_name
    FROM contact_addresses ca
    LEFT JOIN users uc ON uc.user = ca.created_by
    LEFT JOIN users uu ON uu.user = ca.updated_by
`;


// ─────────────────────────────────────────────────────────────
// listContactAddresses
// ─────────────────────────────────────────────────────────────

/**
 * List addresses for one contact. Returns null when the contact doesn't
 * exist (route → 404).
 *
 * Ordering: primary-active first, then non-primary active, then ended
 * rows, with id ASC within each group.
 *
 * @param {object} db
 * @param {number|string} contactId
 * @param {object} [opts]
 * @param {boolean} [opts.include_inactive=false]
 * @returns {Promise<{addresses: object[]} | null>}
 */
async function listContactAddresses(db, contactId, { include_inactive = false } = {}) {
  const [[exists]] = await db.query(
    `SELECT contact_id FROM contacts WHERE contact_id = ?`,
    [contactId]
  );
  if (!exists) return null;

  const whereParts  = ['ca.contact_id = ?'];
  const whereParams = [contactId];
  if (!include_inactive) {
    whereParts.push('ca.end_date IS NULL');
  }
  const whereSQL = whereParts.join(' AND ');

  const [rows] = await db.query(
    `${ADDRESS_SELECT_SQL}
      WHERE ${whereSQL}
      ORDER BY ca.is_primary DESC, (ca.end_date IS NULL) DESC, ca.id ASC`,
    whereParams
  );

  return { addresses: rows };
}


// ─────────────────────────────────────────────────────────────
// getContactAddress
// ─────────────────────────────────────────────────────────────

/**
 * Fetch one address row in the full list-row shape. Returns null if
 * not found.
 */
async function getContactAddress(db, addressId) {
  const [[row]] = await db.query(
    `${ADDRESS_SELECT_SQL} WHERE ca.id = ?`,
    [addressId]
  );
  return row || null;
}


// ─────────────────────────────────────────────────────────────
// createContactAddress
// ─────────────────────────────────────────────────────────────

/**
 * Create a contact_addresses row.
 *
 * Validates:
 *   - at least one of address1/city/state/zip is non-empty
 *   - label is in ADDRESS_LABELS (if provided)
 *   - contact exists
 *
 * Behavior:
 *   - NO collision check (addresses are not active-unique across
 *     contacts; spouses, children, co-tenants legitimately share).
 *   - Same-contact primary demotion: if is_primary=true, any existing
 *     primary-active row for this contact is demoted.
 *   - Auto-promote: if the contact has zero address rows (active or not)
 *     before this insert AND is_primary wasn't explicitly set, default
 *     to is_primary=true. Surfaces as `auto_promoted: true`.
 *
 * The whole operation runs in a transaction so the insert + mirror
 * recompute land atomically.
 *
 * @param {object} db
 * @param {number|string} contactId
 * @param {object} fields
 * @param {string}  [fields.address1='']
 * @param {string}  [fields.address2='']
 * @param {string}  [fields.city='']
 * @param {string}  [fields.state='']
 * @param {string}  [fields.zip='']
 * @param {string}  [fields.country='US']
 * @param {string}  [fields.label='Other']
 * @param {boolean} [fields.is_primary]
 * @param {boolean} [fields.verified=false]
 * @param {string}  [fields.start_date]
 * @param {string}  [fields.notes='']
 * @param {object}  [opts]
 * @param {number}  [opts.createdBy=0]
 * @returns {Promise<{address: object, auto_promoted: boolean}>}
 */
async function createContactAddress(db, contactId, fields = {}, { createdBy = 0 } = {}) {
  // ─── Validation (pre-transaction) ───
  const address1 = _trim(fields.address1) || '';
  const address2 = _trim(fields.address2) || '';
  const city     = _trim(fields.city)     || '';
  const state    = _trim(fields.state)    || '';
  const zip      = _trim(fields.zip)      || '';
  const country  = _trim(fields.country)  || 'US';

  if (!_hasAnyAddressField({ address1, city, state, zip })) {
    throw new Error('Address requires at least one of address1/city/state/zip');
  }

  const label = fields.label || 'Other';
  if (!ADDRESS_LABELS.includes(label)) {
    throw new Error(`Invalid label "${label}" (allowed: ${ADDRESS_LABELS.join(', ')})`);
  }

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

    // 1. Auto-promote check
    let isPrimary;
    let autoPromoted = false;
    if (fields.is_primary !== undefined) {
      isPrimary = !!fields.is_primary;
    } else {
      const [[{ cnt }]] = await conn.query(
        `SELECT COUNT(*) AS cnt FROM contact_addresses WHERE contact_id = ?`,
        [cid]
      );
      if (cnt === 0) {
        isPrimary   = true;
        autoPromoted = true;
      } else {
        isPrimary = false;
      }
    }

    // 2. Demote existing primary-active if we're inserting as primary
    if (isPrimary) {
      await conn.query(
        `UPDATE contact_addresses
            SET is_primary = 0, updated_by = ?
          WHERE contact_id = ? AND is_primary = 1 AND end_date IS NULL`,
        [createdBy, cid]
      );
    }

    // 3. INSERT new row
    let newId;
    try {
      const [insertResult] = await conn.query(
        `INSERT INTO contact_addresses
           (contact_id, address1, address2, city, state, zip, country,
            label, is_primary, verified,
            start_date, notes, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURDATE()), ?, ?, ?)`,
        [
          cid, address1, address2, city, state, zip, country,
          label, _toBit(isPrimary), _toBit(fields.verified),
          _normDate(fields.start_date),
          fields.notes || '',
          createdBy, createdBy,
        ]
      );
      newId = insertResult.insertId;
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        // Only uk_one_active_primary can fire here (no global uniqueness
        // on address content). A race condition with concurrent promote.
        throw new Error(
          'Concurrent promote on this contact — another primary-active ' +
          'address row was created. Refresh and retry.'
        );
      }
      throw err;
    }

    // 4. Recompute target contact's mirror
    await recomputePrimaryAddress(conn, cid);

    await conn.commit();

    const addressRow = await getContactAddress(db, newId);
    return {
      address:       addressRow,
      auto_promoted: autoPromoted,
    };
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}


// ─────────────────────────────────────────────────────────────
// updateContactAddress
// ─────────────────────────────────────────────────────────────

/**
 * Update fields on a contact_addresses row.
 *
 * Allowed:   address1, address2, city, state, zip, country, label,
 *            is_primary, verified, end_date, end_reason, notes
 * Forbidden: id, contact_id, start_date, created_*, updated_*,
 *            generated columns.
 *
 * Unlike phone/email PATCH, address VALUES (address1/address2/city/
 * state/zip/country) ARE editable here. "Moved vs typo" is genuinely
 * ambiguous and forcing delete+create for every move is onerous.
 *
 * Transitions:
 *   - is_primary 0→1 → demotes any existing primary-active row first
 *   - end_date NULL→non-NULL on a primary-active row → also clears
 *     is_primary in the same UPDATE
 *
 * Mirror recompute fires when:
 *   - is_primary or end_date changes (primary-active state changed), OR
 *   - any of address1/city/state/zip changes on a row that is or was
 *     primary-active (mirrored values changed)
 *
 * @param {object} db
 * @param {number|string} addressId
 * @param {object} fields
 * @param {object} [opts]
 * @param {number} [opts.updatedBy=0]
 * @returns {Promise<{ address: object }>}
 */
async function updateContactAddress(db, addressId, fields, { updatedBy = 0 } = {}) {
  if (!fields || !Object.keys(fields).length) {
    throw new Error('updateContactAddress requires at least one field');
  }

  const ALLOWED = ['address1', 'address2', 'city', 'state', 'zip', 'country',
                   'label', 'is_primary', 'verified',
                   'end_date', 'end_reason', 'notes'];
  const unknown = Object.keys(fields).filter(k => !ALLOWED.includes(k));
  if (unknown.length) {
    throw new Error(`Cannot update ${unknown.join(', ')}`);
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[current]] = await conn.query(
      `SELECT * FROM contact_addresses WHERE id = ?`,
      [addressId]
    );
    if (!current) throw new Error(`Address ${addressId} not found`);

    const incoming = { ...fields };

    // Trim string-typed address fields
    for (const k of ['address1', 'address2', 'city', 'state', 'zip', 'country']) {
      if (k in incoming) incoming[k] = _trim(incoming[k]) || '';
    }

    if ('label' in incoming && !ADDRESS_LABELS.includes(incoming.label)) {
      throw new Error(`Invalid label "${incoming.label}" (allowed: ${ADDRESS_LABELS.join(', ')})`);
    }
    if ('is_primary' in incoming) incoming.is_primary = _toBit(incoming.is_primary);
    if ('verified'   in incoming) incoming.verified   = _toBit(incoming.verified);
    if ('end_date'   in incoming) incoming.end_date   = _normDate(incoming.end_date);
    if ('end_reason' in incoming && incoming.end_reason == null) incoming.end_reason = null;
    if ('notes'      in incoming && incoming.notes      == null) incoming.notes      = '';

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
        `UPDATE contact_addresses
            SET is_primary = 0, updated_by = ?
          WHERE contact_id = ? AND is_primary = 1 AND end_date IS NULL AND id <> ?`,
        [updatedBy, current.contact_id, addressId]
      );
    }

    incoming.updated_by = updatedBy;
    const setKeys = Object.keys(incoming);
    const setSQL  = setKeys.map(k => `\`${k}\` = ?`).join(', ');
    const setVals = setKeys.map(k => incoming[k]);

    try {
      await conn.query(
        `UPDATE contact_addresses SET ${setSQL} WHERE id = ?`,
        [...setVals, addressId]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new Error(
          'Update would violate uniqueness (uk_one_active_primary). ' +
          'Another primary-active address row exists for this contact.'
        );
      }
      throw err;
    }

    // Mirror recompute: fire if primary-active state changed OR a mirrored
    // address field changed on a row that is/was primary-active.
    const mirrorFields = ['address1', 'city', 'state', 'zip'];
    const addressFieldChanged = mirrorFields.some(k => k in incoming);
    const wasOrIsPrimary = current.is_primary === 1
                        || (incoming.is_primary === 1)
                        || becomingPrimary;
    const mirrorAffected =
      'is_primary' in incoming ||
      'end_date'   in incoming ||
      (addressFieldChanged && wasOrIsPrimary && current.end_date === null);
    if (mirrorAffected) {
      await recomputePrimaryAddress(conn, current.contact_id);
    }

    await conn.commit();

    const addressRow = await getContactAddress(db, addressId);
    return { address: addressRow };
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}


// ─────────────────────────────────────────────────────────────
// deleteContactAddress
// ─────────────────────────────────────────────────────────────

/**
 * Hard-delete one contact_addresses row.
 * Mirror recompute fires if the deleted row was primary-active.
 */
async function deleteContactAddress(db, addressId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[current]] = await conn.query(
      `SELECT id, contact_id, is_primary, end_date FROM contact_addresses WHERE id = ?`,
      [addressId]
    );
    if (!current) throw new Error(`Address ${addressId} not found`);

    await conn.query(`DELETE FROM contact_addresses WHERE id = ?`, [addressId]);

    if (current.is_primary === 1 && current.end_date === null) {
      await recomputePrimaryAddress(conn, current.contact_id);
    }

    await conn.commit();
    return { deleted: true, deleted_id: parseInt(addressId, 10) };
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}


// ─────────────────────────────────────────────────────────────
// setPrimaryContactAddress (convenience wrapper)
// ─────────────────────────────────────────────────────────────

async function setPrimaryContactAddress(db, addressId, { updatedBy = 0 } = {}) {
  return updateContactAddress(db, addressId, { is_primary: 1 }, { updatedBy });
}


module.exports = {
  listContactAddresses,
  getContactAddress,
  createContactAddress,
  updateContactAddress,
  deleteContactAddress,
  setPrimaryContactAddress,
  ADDRESS_LABELS,
};