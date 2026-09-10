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

/** Active-by-default role type catalog (attrs_schema parsed). */
async function listRoleTypes(db, { includeInactive = false } = {}) {
  const [rows] = await db.query(
    `SELECT role_code, label, attrs_schema, sort_order, active
       FROM contact_role_types
      ${includeInactive ? '' : 'WHERE active = 1'}
      ORDER BY sort_order ASC, role_code ASC`
  );
  return { types: rows.map(r => ({ ...r, attrs_schema: _parseAttrs(r.attrs_schema) })) };
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

  // Role-forms slice: attrs are validated against the role type's
  // attrs_schema (NULL schema = any object accepted — pre-m7 behavior).
  validateRoleAttrs(await _loadAttrsSchema(db, code), attrs);

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
  if (attrs !== undefined) {
    // Role-forms slice: any attrs write is validated against the row's role
    // type attrs_schema. updateRole REPLACES the whole attrs object (existing
    // contract, kept) — callers that must preserve undeclared keys (the
    // contact form) merge before calling. The lookup doubles as the
    // not-found check for attrs updates; active/sort_order-only updates keep
    // the affectedRows check below unchanged.
    const [[row]] = await db.query(
      `SELECT cr.role, crt.attrs_schema
         FROM contact_roles cr
         LEFT JOIN contact_role_types crt ON crt.role_code = cr.role
        WHERE cr.id = ? LIMIT 1`, [id]);
    if (!row) throw new Error(`contact_roles row ${id} not found`);
    validateRoleAttrs(_parseAttrs(row.attrs_schema), attrs);
    sets.push('attrs = ?'); args.push(attrs == null ? null : JSON.stringify(attrs));
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// Role-forms slice — attrs_schema vocabulary + per-row attrs validation +
// role-type CRUD. attrs_schema (contact_role_types, m7) is an ordered field
// list: [{ key, label, type, required?, options?, placeholder? }],
// type ∈ text | url | number | select | multi_select. NULL = the role has no
// structured attrs and any object is accepted (pre-m7 behavior).
//
// NUMBER IDENTITY IS LOAD-BEARING: trustee chapter options are the NUMBERS
// [7, 11, 12, 13] and lib/trusteeRoster explodes attrs.chapter into roster
// entries whose case_type feeds trusteeMatch rule 0. A '7' (string) stored
// where 7 (number) belongs is the bug class this validator exists to stop —
// option membership is checked with === and never coerced.
// ─────────────────────────────────────────────────────────────────────────────

const ATTR_FIELD_TYPES = ['text', 'url', 'number', 'select', 'multi_select'];
/** Same slug rule as role_code: routes reject codes outside it too. */
const SLUG_RE = /^[a-z0-9_]{1,40}$/;

function _httpUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) { return false; }
}

/** One "not an allowed option" message; names the type mismatch when a loose
 *  (String-equal) match exists — the '7' vs 7 trap made visible. */
function _optErr(label, options, v) {
  const loose = options.find(o => String(o) === String(v) && o !== v);
  if (loose !== undefined) {
    return `${label}: ${JSON.stringify(v)} has the wrong type — the option is ` +
           `${JSON.stringify(loose)} (${typeof loose}), not ${JSON.stringify(v)} (${typeof v})`;
  }
  return `${label}: ${JSON.stringify(v)} is not one of the allowed options ` +
         `(${options.map(o => JSON.stringify(o)).join(', ')})`;
}

/**
 * Validate (and normalize) an attrs_schema value. Shared by the role-type
 * routes. Accepts an array, a JSON string of one, or null. Returns the
 * parsed array, or null (both for null input and for an empty array — an
 * empty field list IS "no structured attrs"). Throws with every problem
 * joined by '; ' so the settings editor can surface them verbatim.
 */
function validateAttrsSchema(schema) {
  if (schema == null) return null;
  let s = schema;
  if (typeof s === 'string') {
    try { s = JSON.parse(s); }
    catch (_) { throw new Error('attrs_schema must be valid JSON'); }
    if (s == null) return null;
  }
  if (!Array.isArray(s)) {
    throw new Error('attrs_schema must be a JSON array of field objects, or null');
  }
  if (!s.length) return null;

  const KNOWN = ['key', 'label', 'type', 'required', 'options', 'placeholder'];
  const seen = new Set();
  const errs = [];
  s.forEach((f, i) => {
    const at = `attrs_schema[${i}]`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      errs.push(`${at} must be an object`);
      return;
    }
    if (typeof f.key !== 'string' || !SLUG_RE.test(f.key)) {
      errs.push(`${at}.key must be 1–40 chars of a–z, 0–9, _`);
    } else if (seen.has(f.key)) {
      errs.push(`${at}.key "${f.key}" is duplicated`);
    } else {
      seen.add(f.key);
    }
    if (typeof f.label !== 'string' || !f.label.trim()) {
      errs.push(`${at}.label is required`);
    }
    if (!ATTR_FIELD_TYPES.includes(f.type)) {
      errs.push(`${at}.type must be one of ${ATTR_FIELD_TYPES.join(', ')}`);
    }
    if (f.required !== undefined && typeof f.required !== 'boolean') {
      errs.push(`${at}.required must be true or false`);
    }
    if (f.placeholder !== undefined && typeof f.placeholder !== 'string') {
      errs.push(`${at}.placeholder must be a string`);
    }
    const needsOptions = f.type === 'select' || f.type === 'multi_select';
    if (needsOptions) {
      if (!Array.isArray(f.options) || !f.options.length) {
        errs.push(`${at}.options is required for ${f.type} and must be a non-empty array`);
      } else {
        const ok = o => (typeof o === 'string' && o.trim() !== '')
                     || (typeof o === 'number' && Number.isFinite(o));
        if (!f.options.every(ok)) {
          errs.push(`${at}.options entries must be non-empty strings or finite numbers`);
        }
        if (new Set(f.options.map(o => typeof o + ':' + String(o))).size !== f.options.length) {
          errs.push(`${at}.options must be unique`);
        }
      }
    } else if (f.options !== undefined) {
      errs.push(`${at}.options is only allowed for select / multi_select fields`);
    }
    // Strict on the SCHEMA (editor-authored; a typo'd "requried" silently
    // not enforcing is worse than a 400). Attrs VALUES stay forward-compat
    // open — see validateRoleAttrs.
    Object.keys(f).forEach(k => {
      if (!KNOWN.includes(k)) errs.push(`${at}: unknown property "${k}"`);
    });
  });
  if (errs.length) throw new Error(errs.join('; '));
  return s;
}

/**
 * Validate an attrs object against a (parsed) attrs_schema.
 *
 * - schema null → any object (or null) accepted.
 * - Declared fields: type conformance (url = http(s); number = finite
 *   NUMBER, never a numeric string; select value strictly ∈ options;
 *   multi_select values ⊆ options with identity preserved and no
 *   duplicates). required = present and non-blank.
 * - UNDECLARED keys pass through untouched — never stripped, never
 *   rejected (forward compat).
 *
 * Because updateRole replaces the whole attrs object, every attrs-bearing
 * write is validated at attach strength: a required field omitted from an
 * update WOULD be removed by it, so it is rejected the same way.
 */
function validateRoleAttrs(schema, attrs) {
  if (attrs != null && (typeof attrs !== 'object' || Array.isArray(attrs))) {
    throw new Error('attrs must be a JSON object or null');
  }
  if (schema == null) return;

  const a = attrs || {};
  const errs = [];
  for (const f of schema) {
    const v = a[f.key];
    const label = `attrs.${f.key}`;
    const blank = v === undefined || v === null || v === ''
      || (f.type === 'multi_select' && Array.isArray(v) && v.length === 0);
    if (blank) {
      if (f.required) errs.push(`${label} is required`);
      continue;
    }
    switch (f.type) {
      case 'text':
        if (typeof v !== 'string') errs.push(`${label} must be text`);
        break;
      case 'url':
        if (typeof v !== 'string' || !_httpUrl(v)) {
          errs.push(`${label} must be an http(s) URL`);
        }
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          errs.push(`${label} must be a number` +
            (typeof v === 'string' ? ` (got the string ${JSON.stringify(v)})` : ''));
        }
        break;
      case 'select':
        if (!f.options.some(o => o === v)) errs.push(_optErr(label, f.options, v));
        break;
      case 'multi_select': {
        if (!Array.isArray(v)) { errs.push(`${label} must be an array`); break; }
        if (new Set(v.map(x => typeof x + ':' + String(x))).size !== v.length) {
          errs.push(`${label} must not contain duplicates`);
        }
        for (const item of v) {
          if (!f.options.some(o => o === item)) errs.push(_optErr(label, f.options, item));
        }
        break;
      }
      // no default — validateAttrsSchema guarantees the type vocabulary
    }
  }
  if (errs.length) throw new Error(errs.join('; '));
}

/** The (parsed) attrs_schema for one role code, or null. */
async function _loadAttrsSchema(db, roleCode) {
  const [[row]] = await db.query(
    'SELECT attrs_schema FROM contact_role_types WHERE role_code = ? LIMIT 1',
    [roleCode]
  );
  return row ? _parseAttrs(row.attrs_schema) : null;
}

/** One contact_roles row by id (attrs parsed), or null. Routes use this for
 *  ownership scoping (/api/contacts/:id/roles/:roleRowId). */
async function getRoleRow(db, roleRowId) {
  const id = parseInt(roleRowId, 10);
  if (!Number.isInteger(id)) throw new Error('role row id must be an integer');
  const [[row]] = await db.query(
    `SELECT id, contact_id, role, attrs, active, sort_order, created_at
       FROM contact_roles WHERE id = ? LIMIT 1`, [id]
  );
  return row ? { ...row, attrs: _parseAttrs(row.attrs) } : null;
}

/**
 * Create a role type. role_code is slug-validated and IMMUTABLE after
 * creation — consumers reference codes as strings ('judge', 'trustee' in
 * lib/trusteeRoster, lib/caseRoleResolver, /api/judges) and contact_roles
 * rows carry the code with no FK; a rename would orphan both.
 */
async function createRoleType(db, { role_code, label, sort_order = 0, active = 1, attrs_schema = null } = {}) {
  const code = String(role_code == null ? '' : role_code).trim();
  if (!SLUG_RE.test(code)) {
    throw new Error('role_code must be 1–40 chars of a–z, 0–9, _');
  }
  const lbl = String(label == null ? '' : label).trim();
  if (!lbl) throw new Error('label is required');
  if (lbl.length > 60) throw new Error('label must be 60 characters or fewer');
  const schema = validateAttrsSchema(attrs_schema);

  try {
    await db.query(
      `INSERT INTO contact_role_types (role_code, label, attrs_schema, sort_order, active)
       VALUES (?, ?, ?, ?, ?)`,
      [code, lbl, schema == null ? null : JSON.stringify(schema), sort_order | 0, active ? 1 : 0]
    );
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      throw new Error(`role type "${code}" already exists`);
    }
    throw err;
  }
  return { role_code: code };
}

/**
 * Update label / sort_order / active / attrs_schema on one role type.
 * role_code is immutable (see createRoleType). There is deliberately no
 * deleteRoleType — contact_roles rows may reference the code; deactivate
 * instead (active = 0 removes it from pickers and filters, keeps history).
 */
async function updateRoleType(db, roleCode, opts = {}) {
  const code = String(roleCode == null ? '' : roleCode).trim();
  if (!code) throw new Error('role_code is required');
  if (opts && opts.role_code !== undefined && String(opts.role_code).trim() !== code) {
    throw new Error('role_code is immutable — deactivate this type and create a new one instead');
  }
  const { label, sort_order, active, attrs_schema } = opts;

  const sets = [];
  const args = [];
  if (label !== undefined) {
    const lbl = String(label == null ? '' : label).trim();
    if (!lbl) throw new Error('label is required');
    if (lbl.length > 60) throw new Error('label must be 60 characters or fewer');
    sets.push('label = ?'); args.push(lbl);
  }
  if (sort_order !== undefined) { sets.push('sort_order = ?'); args.push(sort_order | 0); }
  if (active !== undefined) { sets.push('active = ?'); args.push(active ? 1 : 0); }
  if (attrs_schema !== undefined) {
    const schema = validateAttrsSchema(attrs_schema);
    sets.push('attrs_schema = ?'); args.push(schema == null ? null : JSON.stringify(schema));
  }
  if (!sets.length) {
    throw new Error('updateRoleType requires at least one of label, sort_order, active, attrs_schema');
  }

  const [result] = await db.query(
    `UPDATE contact_role_types SET ${sets.join(', ')} WHERE role_code = ?`,
    [...args, code]
  );
  if (!result.affectedRows) throw new Error(`role type "${code}" not found`);
  return { role_code: code };
}

module.exports = {
  assertValidRole,
  listRoleTypes,
  listContactRoles,
  listContactsByRole,
  attachRole,
  updateRole,
  detachRole,
  getRoleRow,
  createRoleType,
  updateRoleType,
  validateAttrsSchema,
  validateRoleAttrs,
  _parseAttrs,
  _loadAttrsSchema,
};
