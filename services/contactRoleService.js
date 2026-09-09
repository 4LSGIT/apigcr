// services/contactRoleService.js
//
/**
 * Contact Role Service (slice 5)
 * services/contactRoleService.js
 *
 * Pure logic for the contact_roles + contact_role_types tables — the role
 * axis that folds judges and trustees (and future roles) into contacts. No
 * HTTP; routes are the HTTP layer (today: GET /api/judges reads through
 * listContactsByRole). Follows contactRelationService's shape: validation
 * errors throw Error with a user-presentable .message.
 *
 * WHY APP-SIDE ROLE VALIDATION IS THE ONLY GATE: contact_roles.role is a
 * plain varchar(40) and this session's sql_mode has no STRICT_TRANS_TABLES —
 * the DB accepts any garbage silently. attachRole's check against
 * contact_role_types (active = 1) is the whole defense, same posture as
 * contactService's CONTACT_KINDS gate.
 *
 * attrs is a JSON column. mysql2 usually hands JSON columns back parsed, but
 * _parseAttrs normalizes either way so callers always see object|null.
 *
 * Usage:
 *   const svc = require('../services/contactRoleService');
 *   await svc.attachRole(db, { contact_id: 7, role: 'judge',
 *                              attrs: { judge_3: 'mar' } });
 */

'use strict';

/** JSON column → object|null regardless of driver behavior. */
function _parseAttrs(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

/**
 * Throw unless roleCode names an ACTIVE row in contact_role_types.
 * Exported so scripts (seedRoleContacts) validate through the same gate.
 */
async function assertValidRole(db, roleCode) {
  const code = String(roleCode == null ? '' : roleCode).trim();
  if (!code) throw new Error('role is required');
  const [[row]] = await db.query(
    'SELECT role_code FROM contact_role_types WHERE role_code = ? AND active = 1 LIMIT 1',
    [code]
  );
  if (!row) {
    throw new Error(`role "${code}" is not an active contact_role_types code`);
  }
  return code;
}

/** Active-by-default role type catalog. */
async function listRoleTypes(db, { includeInactive = false } = {}) {
  const [rows] = await db.query(
    `SELECT role_code, label, sort_order, active
       FROM contact_role_types
      ${includeInactive ? '' : 'WHERE active = 1'}
      ORDER BY sort_order ASC, role_code ASC`
  );
  return { types: rows };
}

/** All role rows for one contact (attrs parsed). */
async function listContactRoles(db, contactId, { activeOnly = false } = {}) {
  const cid = parseInt(contactId, 10);
  if (!Number.isInteger(cid)) throw new Error('contact_id must be an integer');
  const [rows] = await db.query(
    `SELECT cr.id, cr.contact_id, cr.role, crt.label, cr.attrs,
            cr.active, cr.sort_order, cr.created_at
       FROM contact_roles cr
       LEFT JOIN contact_role_types crt ON crt.role_code = cr.role
      WHERE cr.contact_id = ?
        ${activeOnly ? 'AND cr.active = 1' : ''}
      ORDER BY cr.sort_order ASC, cr.role ASC`,
    [cid]
  );
  return { roles: rows.map(r => ({ ...r, attrs: _parseAttrs(r.attrs) })) };
}

/**
 * All contacts holding a role. Backs GET /api/judges (the route maps these
 * to its frozen legacy keys) and any future role-scoped picker.
 */
async function listContactsByRole(db, roleCode, { activeOnly = true } = {}) {
  const code = String(roleCode == null ? '' : roleCode).trim();
  if (!code) throw new Error('role is required');
  const [rows] = await db.query(
    `SELECT cr.id, cr.contact_id, c.contact_name, cr.attrs,
            cr.active, cr.sort_order
       FROM contact_roles cr
       JOIN contacts c ON c.contact_id = cr.contact_id
      WHERE cr.role = ?
        ${activeOnly ? 'AND cr.active = 1' : ''}
      ORDER BY c.contact_name ASC`,
    [code]
  );
  return { contacts: rows.map(r => ({ ...r, attrs: _parseAttrs(r.attrs) })) };
}

/**
 * Attach a role to a contact.
 *
 * Validates role against contact_role_types (active = 1) and that the
 * contact exists. Plain INSERT — the uk_contact_role UNIQUE (contact_id,
 * role) makes a duplicate attach throw a clear error rather than silently
 * stacking rows; callers that want merge semantics (the seed script's
 * McDonald ch12+ch13 case) read + updateRole themselves.
 *
 * @returns {{ id:number }}
 */
async function attachRole(db, { contact_id, role, attrs = null, active = 1, sort_order = 0 } = {}) {
  const cid = parseInt(contact_id, 10);
  if (!Number.isInteger(cid)) throw new Error('contact_id must be an integer');
  const code = await assertValidRole(db, role);

  const [[contact]] = await db.query(
    'SELECT contact_id FROM contacts WHERE contact_id = ? LIMIT 1', [cid]
  );
  if (!contact) throw new Error(`contact ${cid} not found`);

  try {
    const [result] = await db.query(
      `INSERT INTO contact_roles (contact_id, role, attrs, active, sort_order)
       VALUES (?, ?, ?, ?, ?)`,
      [cid, code, attrs == null ? null : JSON.stringify(attrs), active ? 1 : 0, sort_order | 0]
    );
    return { id: result.insertId };
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      throw new Error(`contact ${cid} already has role "${code}"`);
    }
    throw err;
  }
}

/**
 * Update attrs / active / sort_order on one role row (by id). The role code
 * itself is immutable here — detach + attach to change it.
 */
async function updateRole(db, roleRowId, { attrs, active, sort_order } = {}) {
  const id = parseInt(roleRowId, 10);
  if (!Number.isInteger(id)) throw new Error('role row id must be an integer');

  const sets = [];
  const args = [];
  if (attrs !== undefined) { sets.push('attrs = ?'); args.push(attrs == null ? null : JSON.stringify(attrs)); }
  if (active !== undefined) { sets.push('active = ?'); args.push(active ? 1 : 0); }
  if (sort_order !== undefined) { sets.push('sort_order = ?'); args.push(sort_order | 0); }
  if (!sets.length) throw new Error('updateRole requires at least one of attrs, active, sort_order');

  const [result] = await db.query(
    `UPDATE contact_roles SET ${sets.join(', ')} WHERE id = ?`, [...args, id]
  );
  if (!result.affectedRows) throw new Error(`contact_roles row ${id} not found`);
  return { id };
}

/** Remove a (contact, role) row. Returns how many rows went (0 or 1). */
async function detachRole(db, { contact_id, role } = {}) {
  const cid = parseInt(contact_id, 10);
  if (!Number.isInteger(cid)) throw new Error('contact_id must be an integer');
  const code = String(role == null ? '' : role).trim();
  if (!code) throw new Error('role is required');
  const [result] = await db.query(
    'DELETE FROM contact_roles WHERE contact_id = ? AND role = ?', [cid, code]
  );
  return { removed: result.affectedRows };
}

module.exports = {
  assertValidRole,
  listRoleTypes,
  listContactRoles,
  listContactsByRole,
  attachRole,
  updateRole,
  detachRole,
  _parseAttrs,
};
