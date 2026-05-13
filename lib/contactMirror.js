// lib/contactMirror.js
//
/**
 * Contact Mirror Helpers
 * lib/contactMirror.js
 *
 * Recomputes the legacy "denormalized projection" columns on the contacts
 * table (contact_phone, contact_email, contact_address/city/state/zip) from
 * the primary-active child row in contact_phones / contact_emails /
 * contact_addresses.
 *
 * Called AFTER any child-table mutation that could change which row is
 * primary-active for a contact (INSERT with is_primary=1, UPDATE of
 * is_primary or end_date, DELETE of a primary-active row).
 *
 * Design notes:
 *   - "Compute from scratch" pattern: the helper reads the current primary
 *     active row and writes it back to contacts. Slightly more cost per call
 *     than an incremental update, but guarantees the mirror can never drift
 *     from the child table's truth.
 *   - Early-return-if-no-change: avoids spurious UPDATE statements (and
 *     spurious audit-trigger fires) when the recomputed value matches the
 *     current contacts column.
 *   - Writes will fire the existing after_contact_update audit trigger;
 *     this is intentional — the projection change is part of the audit
 *     trail.
 *   - contact_updated is NOT touched here. The mirror is a derived
 *     projection; bumping the updated timestamp would be misleading. The
 *     trigger captures the column change either way.
 *   - Accepts `db` as either a pool or a transaction connection — both
 *     expose .query() with the same signature. Callers performing dual-write
 *     in a transaction should pass the connection.
 */

/**
 * Recompute contacts.contact_phone from the primary-active row in
 * contact_phones. Idempotent. Writes '' when no primary-active row exists.
 *
 * @param {object} db          - pool or connection
 * @param {number|string} contactId
 * @returns {Promise<void>}
 */
async function recomputePrimaryPhone(db, contactId) {
  const [[child]] = await db.query(
    `SELECT phone FROM contact_phones
      WHERE contact_id = ? AND is_primary = 1 AND end_date IS NULL
      LIMIT 1`,
    [contactId]
  );
  const newValue = child ? child.phone : '';

  const [[current]] = await db.query(
    `SELECT contact_phone FROM contacts WHERE contact_id = ?`,
    [contactId]
  );
  if (!current) return; // contact deleted out from under us; defensive
  if (current.contact_phone === newValue) return; // no-op

  await db.query(
    `UPDATE contacts SET contact_phone = ? WHERE contact_id = ?`,
    [newValue, contactId]
  );
}

/**
 * Recompute contacts.contact_email from the primary-active row in
 * contact_emails. Idempotent. Writes '' when no primary-active row exists.
 *
 * @param {object} db          - pool or connection
 * @param {number|string} contactId
 * @returns {Promise<void>}
 */
async function recomputePrimaryEmail(db, contactId) {
  const [[child]] = await db.query(
    `SELECT email FROM contact_emails
      WHERE contact_id = ? AND is_primary = 1 AND end_date IS NULL
      LIMIT 1`,
    [contactId]
  );
  const newValue = child ? child.email : '';

  const [[current]] = await db.query(
    `SELECT contact_email FROM contacts WHERE contact_id = ?`,
    [contactId]
  );
  if (!current) return;
  if (current.contact_email === newValue) return;

  await db.query(
    `UPDATE contacts SET contact_email = ? WHERE contact_id = ?`,
    [newValue, contactId]
  );
}

/**
 * Recompute contacts.contact_address/city/state/zip from the primary-active
 * row in contact_addresses. Idempotent. Writes empty strings for all four
 * when no primary-active row exists.
 *
 * Only address1 maps to contact_address; address2 has no mirror column.
 * country has no mirror column either.
 *
 * @param {object} db          - pool or connection
 * @param {number|string} contactId
 * @returns {Promise<void>}
 */
async function recomputePrimaryAddress(db, contactId) {
  const [[child]] = await db.query(
    `SELECT address1, city, state, zip FROM contact_addresses
      WHERE contact_id = ? AND is_primary = 1 AND end_date IS NULL
      LIMIT 1`,
    [contactId]
  );
  const newAddr  = child ? (child.address1 || '') : '';
  const newCity  = child ? (child.city     || '') : '';
  const newState = child ? (child.state    || '') : '';
  const newZip   = child ? (child.zip      || '') : '';

  const [[current]] = await db.query(
    `SELECT contact_address, contact_city, contact_state, contact_zip
       FROM contacts WHERE contact_id = ?`,
    [contactId]
  );
  if (!current) return;
  if (current.contact_address === newAddr &&
      current.contact_city    === newCity &&
      current.contact_state   === newState &&
      current.contact_zip     === newZip) {
    return; // no-op
  }

  await db.query(
    `UPDATE contacts
        SET contact_address = ?, contact_city = ?, contact_state = ?, contact_zip = ?
      WHERE contact_id = ?`,
    [newAddr, newCity, newState, newZip, contactId]
  );
}


module.exports = {
  recomputePrimaryPhone,
  recomputePrimaryEmail,
  recomputePrimaryAddress,
};