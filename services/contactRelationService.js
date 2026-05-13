// services/contactRelationService.js
//
/**
 * Contact Relation Service
 * services/contactRelationService.js
 *
 * Pure logic for the contact_relations + contact_relation_types tables.
 * No HTTP — routes/api.contactRelations.js is the HTTP layer.
 *
 * Conventions:
 *   - Vocab columns (allowed_statuses, allowed_end_reasons) are stored as
 *     CSV strings in the catalog and exposed to callers as arrays.
 *   - Validation errors throw Error with a user-presentable .message —
 *     the route layer maps them to 400/404/500 based on substring match.
 *   - `created_by` accepts 0 as a sentinel for "no user identity"
 *     (API-key auth or system actions).
 *
 * NOTE: audit logging (writing relation events to the `log` table) is
 * deferred to a later slice. `// TODO audit slice` markers below show
 * where hooks belong.
 *
 * Usage:
 *   const svc = require('../services/contactRelationService');
 *   const { types } = await svc.listRelationTypes(db);
 *   const created = await svc.createRelation(db, fields, { createdBy: 3 });
 */

// ─────────────────────────────────────────────────────────────
// Internal helpers (exported for testability)
// ─────────────────────────────────────────────────────────────

/**
 * Parse a comma-separated vocab string into a trimmed array.
 *   'a,b,c'  → ['a','b','c']
 *   ' a , b' → ['a','b']
 *   ''       → []
 *   null     → []
 *
 * @param {string|null} csv
 * @returns {string[]}
 */
function parseVocabCsv(csv) {
  if (!csv) return [];
  return String(csv)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Validate `value` against a CSV allowlist.
 *   - empty/null `value` is always valid (the field is being omitted)
 *   - non-empty `value` with empty allowlist → throws ("not allowed for this type")
 *   - non-empty `value` not in allowlist → throws
 *
 * @param {string|null|undefined} value
 * @param {string|null} allowedCsv
 * @param {string} fieldName  - for the error message
 */
function validateVocab(value, allowedCsv, fieldName) {
  if (value == null || value === '') return;
  const allowed = parseVocabCsv(allowedCsv);
  if (allowed.length === 0) {
    throw new Error(`${fieldName} "${value}" is not allowed for this type`);
  }
  if (!allowed.includes(value)) {
    throw new Error(
      `${fieldName} "${value}" is not allowed for this type (allowed: ${allowed.join(', ')})`
    );
  }
}

/**
 * Normalize a possibly-empty date input to null. Lets the route pass
 * '' (from a cleared form field) without writing '0000-00-00'.
 */
function _normDate(v) {
  if (v == null || v === '') return null;
  return v;
}

/**
 * Project a joined relation row (with crt + users + ca/cb aliases)
 * into the public list-row shape, from the perspective of
 * `perspectiveContactId`. If perspective is null, defaults to
 * contact_a_id's POV (canonical creator POV).
 *
 * @param {object} r            - joined row from listRelations/getRelation
 * @param {number|null} perspectiveContactId
 * @returns {object}
 */
function _projectRelationRow(r, perspectiveContactId) {
  const cid = perspectiveContactId == null
    ? r.contact_a_id
    : parseInt(perspectiveContactId, 10);
  const isA = r.contact_a_id === cid;

  const other = isA
    ? { id: r.b_id, name: r.b_name, pname: r.b_pname, type: r.b_type }
    : { id: r.a_id, name: r.a_name, pname: r.a_pname, type: r.a_type };

  return {
    id: r.id,
    type_code: r.type_code,
    perspective: {
      label: isA ? r.forward_label : r.reverse_label,
      other_contact_id: other.id,
      other_contact_name: other.name,
      other_contact_pname: other.pname,
      other_contact_type: other.type,
    },
    contact_a_id: r.contact_a_id,
    contact_b_id: r.contact_b_id,
    active: r.active,
    status: r.status,
    start_date: r.start_date,
    end_date: r.end_date,
    end_reason: r.end_reason,
    notes: r.notes,
    is_symmetric: r.is_symmetric,
    forward_label: r.forward_label,
    reverse_label: r.reverse_label,
    created_at: r.created_at,
    created_by: r.created_by,
    created_by_name: r.created_by_name,
    updated_at: r.updated_at,
  };
}

/** Shared SELECT/JOIN block for fetching one or many relations with
 *  catalog + creator + both contacts joined. */
const RELATION_SELECT_SQL = `
  SELECT
    cr.id, cr.type_code, cr.contact_a_id, cr.contact_b_id,
    cr.active, cr.status, cr.start_date, cr.end_date, cr.end_reason, cr.notes,
    cr.created_at, cr.created_by, cr.updated_at,
    crt.is_symmetric, crt.forward_label, crt.reverse_label, crt.sort_order,
    u.user_name      AS created_by_name,
    ca.contact_id    AS a_id,
    ca.contact_name  AS a_name,
    ca.contact_pname AS a_pname,
    ca.contact_type  AS a_type,
    cb.contact_id    AS b_id,
    cb.contact_name  AS b_name,
    cb.contact_pname AS b_pname,
    cb.contact_type  AS b_type
  FROM contact_relations cr
  JOIN contact_relation_types crt ON crt.type_code = cr.type_code
  LEFT JOIN users    u  ON u.user = cr.created_by
  LEFT JOIN contacts ca ON ca.contact_id = cr.contact_a_id
  LEFT JOIN contacts cb ON cb.contact_id = cr.contact_b_id
`;

/** Fetch the catalog row for one type_code. Throws if not found. */
async function _getType(db, typeCode) {
  const [[type]] = await db.query(
    `SELECT type_code, is_symmetric, allowed_statuses, allowed_end_reasons, active
       FROM contact_relation_types
      WHERE type_code = ?`,
    [typeCode]
  );
  if (!type) throw new Error(`Relation type "${typeCode}" not found`);
  return type;
}


// ─────────────────────────────────────────────────────────────
// listRelationTypes
// ─────────────────────────────────────────────────────────────

/**
 * List the relation-type catalog, sorted by sort_order ASC.
 * Vocab columns are parsed from CSV into arrays.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {boolean} [opts.includeInactive=false]
 * @returns {{ types: object[] }}
 */
async function listRelationTypes(db, { includeInactive = false } = {}) {
  const whereSQL = includeInactive ? '' : 'WHERE active = 1';
  const [rows] = await db.query(
    `SELECT type_code, forward_label, reverse_label, is_symmetric,
            allowed_statuses, allowed_end_reasons, sort_order, active
       FROM contact_relation_types
       ${whereSQL}
       ORDER BY sort_order ASC`
  );

  const types = rows.map(r => ({
    type_code: r.type_code,
    forward_label: r.forward_label,
    reverse_label: r.reverse_label,
    is_symmetric: r.is_symmetric,
    allowed_statuses: parseVocabCsv(r.allowed_statuses),
    allowed_end_reasons: parseVocabCsv(r.allowed_end_reasons),
    sort_order: r.sort_order,
    active: r.active,
  }));

  return { types };
}


// ─────────────────────────────────────────────────────────────
// listContactRelations
// ─────────────────────────────────────────────────────────────

/**
 * List relations for one contact (both directions), with perspective
 * projected from that contact's POV.
 *
 * Returns null when the contact doesn't exist (route → 404).
 *
 * @param {object} db
 * @param {number|string} contactId
 * @param {object} [opts]
 * @param {string|boolean|undefined} [opts.active]
 *        'true'/'1'/true → active=1 only
 *        'false'/'0'/false → active=0 only
 *        undefined/'' → no active filter (all)
 * @param {string|null} [opts.typeCode]
 * @param {number} [opts.limit=100]   max 500
 * @param {number} [opts.offset=0]
 * @returns {Promise<{relations: object[], total: number} | null>}
 */
async function listContactRelations(db, contactId, {
  active   = undefined,
  typeCode = null,
  limit    = 100,
  offset   = 0,
} = {}) {
  // 404 support: confirm the contact exists so the route can distinguish
  // "no such contact" from "no relations".
  const [[exists]] = await db.query(
    `SELECT contact_id FROM contacts WHERE contact_id = ?`,
    [contactId]
  );
  if (!exists) return null;

  const cid = parseInt(contactId, 10);

  const whereParts  = ['(cr.contact_a_id = ? OR cr.contact_b_id = ?)'];
  const whereParams = [cid, cid];

  // Normalize the `active` query param to a tri-state.
  if (active === true || active === 1 || active === 'true' || active === '1') {
    whereParts.push('cr.active = 1');
  } else if (active === false || active === 0 || active === 'false' || active === '0') {
    whereParts.push('cr.active = 0');
  }

  if (typeCode) {
    whereParts.push('cr.type_code = ?');
    whereParams.push(typeCode);
  }

  const whereSQL = whereParts.join(' AND ');

  const lim = Math.min(500, Math.max(1, parseInt(limit, 10)  || 100));
  const off = Math.max(0, parseInt(offset, 10) || 0);

  // Active rows first; then by the catalog's natural sort; newest within.
  const [rows] = await db.query(
    `${RELATION_SELECT_SQL}
     WHERE ${whereSQL}
     ORDER BY cr.active DESC, crt.sort_order ASC, cr.created_at DESC
     LIMIT ? OFFSET ?`,
    [...whereParams, lim, off]
  );

  const relations = rows.map(r => _projectRelationRow(r, cid));

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM contact_relations cr WHERE ${whereSQL}`,
    whereParams
  );

  return { relations, total };
}


// ─────────────────────────────────────────────────────────────
// getRelation (internal — used by create/update to return full row)
// ─────────────────────────────────────────────────────────────

/**
 * Fetch one relation in the full list-row shape, projected from
 * `perspectiveContactId`'s POV (defaults to contact_a_id).
 * Returns null if not found.
 *
 * @param {object} db
 * @param {number|string} relationId
 * @param {number|null} [perspectiveContactId]
 * @returns {Promise<object|null>}
 */
async function getRelation(db, relationId, perspectiveContactId = null) {
  const [[r]] = await db.query(
    `${RELATION_SELECT_SQL} WHERE cr.id = ?`,
    [relationId]
  );
  if (!r) return null;
  return _projectRelationRow(r, perspectiveContactId);
}


// ─────────────────────────────────────────────────────────────
// createRelation
// ─────────────────────────────────────────────────────────────

/**
 * Create a contact_relations row.
 *
 * Validates:
 *   - both contacts exist
 *   - contact_a_id !== contact_b_id
 *   - type exists and is active=1
 *   - status / end_reason are in the type's allowed vocab
 *   - start_date <= end_date if both provided
 *   - for symmetric types: no reverse (b,a,type_code) row already exists
 *
 * @param {object} db
 * @param {object} fields
 * @param {object} [opts]
 * @param {number} [opts.createdBy=0] - users.user value, or 0 for system
 * @returns {Promise<{ relation: object }>}
 */
async function createRelation(db, fields, { createdBy = 0 } = {}) {
  const {
    contact_a_id,
    contact_b_id,
    type_code,
    active     = 1,
    status     = '',
    start_date = null,
    end_date   = null,
    end_reason = '',
    notes      = '',
  } = fields || {};

  // Required-field checks (must contain "required" so route → 400)
  if (!contact_a_id) throw new Error('contact_a_id is required');
  if (!contact_b_id) throw new Error('contact_b_id is required');
  if (!type_code)    throw new Error('type_code is required');

  const aId = parseInt(contact_a_id, 10);
  const bId = parseInt(contact_b_id, 10);
  if (!Number.isInteger(aId) || aId <= 0) {
    throw new Error('contact_a_id must be a positive integer');
  }
  if (!Number.isInteger(bId) || bId <= 0) {
    throw new Error('contact_b_id must be a positive integer');
  }
  if (aId === bId) {
    throw new Error('contact_a_id and contact_b_id must be different');
  }

  // Verify both contacts exist in a single round-trip.
  const [contacts] = await db.query(
    `SELECT contact_id FROM contacts WHERE contact_id IN (?, ?)`,
    [aId, bId]
  );
  const foundIds = new Set(contacts.map(c => c.contact_id));
  if (!foundIds.has(aId)) throw new Error(`Contact ${aId} not found`);
  if (!foundIds.has(bId)) throw new Error(`Contact ${bId} not found`);

  // Type must exist and be active for new relations.
  const type = await _getType(db, type_code);
  if (!type.active) {
    throw new Error(`Relation type "${type_code}" is not active (invalid for new relations)`);
  }

  // Vocab validation against catalog.
  validateVocab(status,     type.allowed_statuses,    'status');
  validateVocab(end_reason, type.allowed_end_reasons, 'end_reason');

  // Date sanity.
  const sd = _normDate(start_date);
  const ed = _normDate(end_date);
  if (sd && ed && new Date(sd) > new Date(ed)) {
    throw new Error('start_date must be on or before end_date');
  }

  // Symmetric reverse-collision check. Catches both:
  //   (b, a, type)  — literal reverse, and
  // We do NOT also check (a, b, type) here because the symmetric pair
  // is canonically identified by the (a,b) → (b,a) flip; a hypothetical
  // duplicate (a,b,type) would surface as a DB unique-key error if one
  // exists. (No unique index assumed; collision check is application-level.)
  if (type.is_symmetric) {
    const [[reverse]] = await db.query(
      `SELECT id FROM contact_relations
        WHERE contact_a_id = ? AND contact_b_id = ? AND type_code = ?
        LIMIT 1`,
      [bId, aId, type_code]
    );
    if (reverse) {
      throw new Error(`Reverse relation already exists (id=${reverse.id})`);
    }
  }

// TODO audit slice — write a log row describing the relation creation
  // (relation_id, type, a, b, who, when) once audit hooks land.
  let newId;
  try {
    const [result] = await db.query(
      `INSERT INTO contact_relations
         (contact_a_id, contact_b_id, type_code, active, status,
          start_date, end_date, end_reason, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [aId, bId, type_code, active ? 1 : 0, status || '',
       sd, ed, end_reason || '', notes || '', createdBy]
    );
    newId = result.insertId;
  } catch (err) {
    // UNIQUE KEY (contact_a_id, contact_b_id, type_code) catches exact-
    // forward-duplicates that the app-level symmetric reverse check can't
    // see. Map to a 400-mappable message instead of leaking the raw DB error.
    if (err.code === 'ER_DUP_ENTRY') {
      throw new Error('This relation already exists (same A, B, and type)');
    }
    throw err;
  }

  const relation = await getRelation(db, newId, aId); // perspective = A
  return { relation };
}


// ─────────────────────────────────────────────────────────────
// updateRelation
// ─────────────────────────────────────────────────────────────

/**
 * Update lifecycle fields on a relation.
 *
 * Allowed:   type_code, active, status, start_date, end_date, end_reason, notes
 * Forbidden: id, contact_a_id, contact_b_id, created_at, created_by, updated_at
 *
 * If type_code changes, status/end_reason are re-validated against the
 * NEW type's vocab (using post-update values). If type_code changes AND
 * the new type is symmetric, the reverse-collision check is re-run.
 *
 * @param {object} db
 * @param {number|string} relationId
 * @param {object} fields
 * @returns {Promise<{ relation: object }>}
 */
async function updateRelation(db, relationId, fields) {
  if (!fields || !Object.keys(fields).length) {
    throw new Error('updateRelation requires at least one field');
  }

  const FORBIDDEN = ['id', 'contact_a_id', 'contact_b_id', 'created_at', 'created_by', 'updated_at'];
  const forbidden = Object.keys(fields).filter(k => FORBIDDEN.includes(k));
  if (forbidden.length) {
    throw new Error(`Cannot update forbidden fields: ${forbidden.join(', ')}`);
  }

  const ALLOWED = ['type_code', 'active', 'status', 'start_date', 'end_date', 'end_reason', 'notes'];
  const unknown = Object.keys(fields).filter(k => !ALLOWED.includes(k));
  if (unknown.length) {
    throw new Error(`Invalid update fields: ${unknown.join(', ')}`);
  }

  // Load the current row.
  const [[current]] = await db.query(
    `SELECT * FROM contact_relations WHERE id = ?`,
    [relationId]
  );
  if (!current) throw new Error(`Relation ${relationId} not found`);

  // Normalize incoming fields a bit before merging.
  const incoming = { ...fields };
  if ('start_date' in incoming) incoming.start_date = _normDate(incoming.start_date);
  if ('end_date'   in incoming) incoming.end_date   = _normDate(incoming.end_date);
  if ('active'     in incoming) incoming.active     = incoming.active ? 1 : 0;
  if ('status'     in incoming && incoming.status     == null) incoming.status     = '';
  if ('end_reason' in incoming && incoming.end_reason == null) incoming.end_reason = '';
  if ('notes'      in incoming && incoming.notes      == null) incoming.notes      = '';

  // Merge to see post-update state.
  const merged = { ...current, ...incoming };

  // Resolve the (possibly new) type.
  const type = await _getType(db, merged.type_code);
  // Only enforce "active" gating when type_code itself is changing; existing
  // rows on a since-deactivated type are grandfathered for non-type updates.
  if (fields.type_code !== undefined && !type.active) {
    throw new Error(`Relation type "${merged.type_code}" is not active (invalid for new relations)`);
  }

  // Vocab re-validation against (possibly new) type, using post-update values.
  validateVocab(merged.status,     type.allowed_statuses,    'status');
  validateVocab(merged.end_reason, type.allowed_end_reasons, 'end_reason');

  // Date sanity on merged values.
  if (merged.start_date && merged.end_date &&
      new Date(merged.start_date) > new Date(merged.end_date)) {
    throw new Error('start_date must be on or before end_date');
  }

  // If type_code is changing and the new type is symmetric, re-check reverse.
  // (contact_a_id / contact_b_id can't change in PATCH, so we use `current`.)
  if (fields.type_code !== undefined && type.is_symmetric) {
    const [[reverse]] = await db.query(
      `SELECT id FROM contact_relations
        WHERE contact_a_id = ? AND contact_b_id = ? AND type_code = ?
          AND id <> ?
        LIMIT 1`,
      [current.contact_b_id, current.contact_a_id, merged.type_code, relationId]
    );
    if (reverse) {
      throw new Error(`Reverse relation already exists (id=${reverse.id})`);
    }
  }

  // Build the UPDATE.
  const setKeys = Object.keys(incoming);
  if (!setKeys.length) {
    // Pathological — caller passed only no-op normalizations. Bail cleanly.
    const relation = await getRelation(db, relationId, current.contact_a_id);
    return { relation };
  }
  const setSQL  = setKeys.map(k => `\`${k}\` = ?`).join(', ');
  const setVals = setKeys.map(k => incoming[k]);

  // TODO audit slice — write a log row describing the update with diff
  // (relation_id, changed fields old→new, who, when) once audit hooks land.
  await db.query(
    `UPDATE contact_relations SET ${setSQL} WHERE id = ?`,
    [...setVals, relationId]
  );

  const relation = await getRelation(db, relationId, current.contact_a_id);
  return { relation };
}


// ─────────────────────────────────────────────────────────────
// deleteRelation
// ─────────────────────────────────────────────────────────────

/**
 * Hard delete one relation row.
 * Throws "Relation N not found" (→ 404) if the row doesn't exist.
 *
 * @param {object} db
 * @param {number|string} relationId
 * @returns {Promise<{ deleted_id: number }>}
 */
async function deleteRelation(db, relationId) {
  // TODO audit slice — capture the row (or its essentials) BEFORE delete
  // so the audit log can record what was destroyed.
  const [result] = await db.query(
    `DELETE FROM contact_relations WHERE id = ?`,
    [relationId]
  );
  if (result.affectedRows === 0) {
    throw new Error(`Relation ${relationId} not found`);
  }
  return { deleted_id: parseInt(relationId, 10) };
}


module.exports = {
  listRelationTypes,
  listContactRelations,
  getRelation,
  createRelation,
  updateRelation,
  deleteRelation,
  // Internal helpers (exported for tests)
  parseVocabCsv,
  validateVocab,
};