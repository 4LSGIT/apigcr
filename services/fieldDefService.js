// services/fieldDefService.js
//
/**
 * Field Definition Service (custom-fields arc S1)
 * services/fieldDefService.js
 *
 * The `field_defs` registry — single source of truth for admin-defined
 * fields (ref/CUSTOM_FIELDS_DESIGN.md §2–§3). S1 scope: read API + cache,
 * validation, and the CRUD the settings editor drives. Nothing consumes the
 * registry yet; S2's write chokepoint and S4's renderers will read it
 * through listActive / getByKey.
 *
 * Shape follows contactRoleService (pure logic, no HTTP; validation throws
 * Error with a user-presentable .message) — with calendarTypeAdminService's
 * `.status` on every thrown error so the route never sniffs message text.
 *
 * WHY APP-SIDE VALIDATION IS THE ONLY GATE: sql_mode is non-strict and every
 * enum-ish column here is a plain varchar — the DB accepts garbage silently
 * and truncates over-length writes. validateDef is the whole defense.
 *
 * IMMUTABLE after create: entity and field_key. The key becomes the JSON
 * path in <entity>.custom (S2) and the VIRTUAL column name on the entity
 * table (S3); renames are a v2 non-feature. There is no delete — active = 0
 * is retirement (values stored under the key persist in the JSON by design).
 *
 * ── CACHE ───────────────────────────────────────────────────────────────────
 * In-process Map, entity → every def row (active and inactive), frozen.
 * listActive / getByKey read it; listAll (the editor list) always goes to
 * the DB. Every mutation below calls bump() itself, so no caller can
 * forget. bump() advances a generation counter: a load that started before a
 * bump and finishes after it is returned to its caller but NOT cached.
 *
 * TTL 60s on top of bump(): Cloud Run runs up to 6 instances (ref/INFRA_GCP.md)
 * and bump() only reaches the instance that took the write. Other instances
 * converge within TTL_MS — same posture as calendarTypeService and
 * lib/apiKeys. Defs change rarely; consumers must not pay a query per write.
 *
 * Usage:
 *   const fieldDefs = require('../services/fieldDefService');
 *   const defs = await fieldDefs.listActive(db, 'case');
 *   const def  = await fieldDefs.getByKey(db, 'contact', 'cf_clio_id');
 */

'use strict';

const { withTransaction } = require('../lib/withTransaction');

/** entity → the table its custom fields live on (the collision-check target). */
const ENTITY_TABLES = Object.freeze({ case: 'cases', contact: 'contacts' });
const ENTITIES = Object.freeze(Object.keys(ENTITY_TABLES));

const FIELD_TYPES = Object.freeze(['text', 'number', 'date', 'select', 'multiselect', 'boolean']);
const OPTION_TYPES = Object.freeze(['select', 'multiselect']);

/** Design doc §3. 64 chars max = MySQL's identifier limit (the S3 column name). */
const KEY_RE = /^cf_[a-z][a-z0-9_]{1,60}$/;

/** v1 validation vocabulary: key → field types it applies to. */
const VALIDATION_KEYS = Object.freeze({
  required: FIELD_TYPES,
  max_len:  ['text'],
  pattern:  ['text'],
  min:      ['number'],
  max:      ['number'],
});

const LABEL_MAX = 100;                      // varchar(100)
const SORT_MIN = -32768, SORT_MAX = 32767;  // smallint

const TTL_MS = 60 * 1000;

const SELECT_COLS =
  `SELECT id, entity, field_key, label, field_type, options, validation,
          show_when, indexed, sort_order, active, created_at, updated_at
     FROM field_defs`;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function _err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** JSON column → value|null regardless of driver behavior. */
function _parseJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

function _isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function _shape(r) {
  return {
    ...r,
    options:    _parseJson(r.options),
    validation: _parseJson(r.validation),
    show_when:  _parseJson(r.show_when),
    indexed:    r.indexed ? 1 : 0,
    active:     r.active ? 1 : 0,
  };
}

function _deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) _deepFreeze(v);
  }
  return o;
}

function _assertEntity(entity) {
  if (!ENTITIES.includes(entity)) {
    throw _err(400, `entity must be one of ${ENTITIES.join(', ')}`);
  }
  return entity;
}

// ─────────────────────────────────────────────────────────────
// Cache + read API
// ─────────────────────────────────────────────────────────────

let _gen = 0;
const _cache = new Map(); // entity → { at, rows: frozen[], byKey: Map }

/** Invalidate every entity's cached defs on this instance. */
function bump() {
  _gen++;
  _cache.clear();
}

async function _load(db, entity) {
  const hit = _cache.get(entity);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const gen = _gen;
  const [rows] = await db.query(
    `${SELECT_COLS} WHERE entity = ? ORDER BY sort_order ASC, id ASC`, [entity]
  );
  const shaped = rows.map(r => _deepFreeze(_shape(r)));
  const entry = { at: Date.now(), rows: shaped, byKey: new Map(shaped.map(r => [r.field_key, r])) };
  if (gen === _gen) _cache.set(entity, entry); // a bump() mid-load discards this result
  return entry;
}

/** Active defs for an entity, ordered sort_order, id. Cached; rows are frozen. */
async function listActive(db, entity) {
  _assertEntity(entity);
  return (await _load(db, entity)).rows.filter(r => r.active);
}

/**
 * One def by key, or null. Cached; the row is frozen. Active-only by
 * default — pass { includeInactive: true } to tell a retired key apart
 * from an unknown one (the row's .active says which).
 */
async function getByKey(db, entity, fieldKey, { includeInactive = false } = {}) {
  _assertEntity(entity);
  const row = (await _load(db, entity)).byKey.get(fieldKey) || null;
  return row && (row.active || includeInactive) ? row : null;
}

/** Every def for an entity incl. inactive — the editor list. Always fresh. */
async function listAll(db, entity) {
  _assertEntity(entity);
  const [rows] = await db.query(
    `${SELECT_COLS} WHERE entity = ? ORDER BY sort_order ASC, id ASC`, [entity]
  );
  return rows.map(_shape);
}

// ─────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────

/** Accept a value or a JSON string of one (the roles attrs_schema idiom). */
function _jsonIn(v, name, errs) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); }
  catch (_) { errs.push(`${name} must be valid JSON`); return undefined; }
}

function _checkOptions(options, fieldType, errs) {
  const wants = OPTION_TYPES.includes(fieldType);
  if (!wants) {
    if (options != null) errs.push('options is only allowed for select / multiselect fields');
    return null;
  }
  if (!Array.isArray(options) || !options.length) {
    errs.push(`options is required for ${fieldType} and must be a non-empty array`);
    return null;
  }
  const out = [];
  const seen = new Set();
  options.forEach((o, i) => {
    const at = `options[${i}]`;
    if (!_isPlainObject(o)) { errs.push(`${at} must be an object {value, label}`); return; }
    Object.keys(o).forEach(k => {
      if (k !== 'value' && k !== 'label') errs.push(`${at}: unknown property "${k}"`);
    });
    // value is the STORED form: MEMBER OF is byte-sensitive and the S3
    // select column is utf8mb4_general_ci (case-insensitive, PAD SPACE) —
    // so no edge whitespace, and uniqueness is case-insensitive.
    const v = o.value;
    if (typeof v !== 'string' || v === '') {
      errs.push(`${at}.value must be a non-empty string`);
    } else if (v.trim() !== v) {
      errs.push(`${at}.value must not start or end with whitespace`);
    } else if (seen.has(v.toLowerCase())) {
      errs.push(`${at}.value "${v}" is duplicated (values must be unique, case-insensitive)`);
    } else {
      seen.add(v.toLowerCase());
    }
    const lbl = typeof o.label === 'string' ? o.label.trim() : '';
    if (!lbl) errs.push(`${at}.label is required`);
    out.push({ value: v, label: lbl });
  });
  return out;
}

function _checkValidation(validation, fieldType, errs) {
  if (validation == null) return null;
  if (!_isPlainObject(validation)) { errs.push('validation must be an object'); return null; }
  const keys = Object.keys(validation);
  if (!keys.length) return null;
  for (const k of keys) {
    const v = validation[k];
    if (!VALIDATION_KEYS[k]) {
      errs.push(`validation: unknown property "${k}" (v1: ${Object.keys(VALIDATION_KEYS).join(', ')})`);
      continue;
    }
    if (!VALIDATION_KEYS[k].includes(fieldType)) {
      errs.push(`validation.${k} is only allowed for ${VALIDATION_KEYS[k].join(' / ')} fields`);
      continue;
    }
    if (k === 'required' && typeof v !== 'boolean') errs.push('validation.required must be true or false');
    if (k === 'max_len' && !(Number.isInteger(v) && v >= 1)) errs.push('validation.max_len must be a positive integer');
    if ((k === 'min' || k === 'max') && !(typeof v === 'number' && Number.isFinite(v))) {
      errs.push(`validation.${k} must be a number`);
    }
    if (k === 'pattern') {
      if (typeof v !== 'string' || v === '') errs.push('validation.pattern must be a non-empty string');
      else { try { new RegExp(v); } catch (_) { errs.push('validation.pattern is not a valid regular expression'); } }
    }
  }
  if (typeof validation.min === 'number' && typeof validation.max === 'number' && validation.min > validation.max) {
    errs.push('validation.min must not be greater than validation.max');
  }
  return validation;
}

/**
 * Throw unless field_key names no existing column on the entity's table.
 * With today's KEY_RE this cannot fire for a real column (none start with
 * cf_) — it is NOT dead code: it guards S3's ADD COLUMN against any future
 * loosening of the regex, and against a cf_ column added by hand. Create-only
 * (see validateDef).
 */
async function assertNoColumnCollision(db, entity, fieldKey) {
  const table = ENTITY_TABLES[_assertEntity(entity)];
  const [rows] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, fieldKey]
  );
  if (rows && rows.length) {
    throw _err(400, `field_key "${fieldKey}" collides with the existing column ${table}.${rows[0].COLUMN_NAME} — choose another key`);
  }
}

/**
 * Validate (and normalize) a whole def. Every shape problem is collected and
 * joined with '; ' so the editor can show them verbatim; then, on create
 * only, the registry duplicate check and the column-collision check run.
 *
 * isCreate=false (PATCH, called with the merged row) skips both DB checks on
 * purpose: the key is immutable, and after S3 it IS a column on the entity
 * table — re-checking would reject every edit of a live field.
 *
 * @returns normalized { entity, field_key, label, field_type, options,
 *          validation, show_when, sort_order, active }
 */
async function validateDef(db, def = {}, { isCreate = true } = {}) {
  const errs = [];
  const d = def || {};

  const entity = String(d.entity == null ? '' : d.entity).trim();
  if (!ENTITIES.includes(entity)) errs.push(`entity must be one of ${ENTITIES.join(', ')}`);

  const fieldKey = String(d.field_key == null ? '' : d.field_key).trim();
  if (!KEY_RE.test(fieldKey)) {
    errs.push('field_key must match ^cf_[a-z][a-z0-9_]{1,60}$ (cf_ + a letter + 1–60 of a–z, 0–9, _)');
  }

  const label = String(d.label == null ? '' : d.label).trim();
  if (!label) errs.push('label is required');
  else if (label.length > LABEL_MAX) errs.push(`label must be ${LABEL_MAX} characters or fewer`);

  const fieldType = d.field_type;
  const typeOk = FIELD_TYPES.includes(fieldType);
  if (!typeOk) errs.push(`field_type must be one of ${FIELD_TYPES.join(', ')}`);

  const rawOptions = _jsonIn(d.options, 'options', errs);
  const options = typeOk ? _checkOptions(rawOptions, fieldType, errs) : null;

  const rawValidation = _jsonIn(d.validation, 'validation', errs);
  const validation = typeOk ? _checkValidation(rawValidation, fieldType, errs) : null;

  // show_when: stored, not interpreted until S4 — an object or nothing.
  const showWhen = _jsonIn(d.show_when, 'show_when', errs);
  if (showWhen != null && !_isPlainObject(showWhen)) errs.push('show_when must be an object');

  let sortOrder = 0;
  if (d.sort_order !== undefined && d.sort_order !== null && d.sort_order !== '') {
    sortOrder = typeof d.sort_order === 'string' ? Number(d.sort_order) : d.sort_order;
    if (!Number.isInteger(sortOrder) || sortOrder < SORT_MIN || sortOrder > SORT_MAX) {
      errs.push(`sort_order must be an integer from ${SORT_MIN} to ${SORT_MAX}`);
    }
  }

  if (errs.length) throw _err(400, errs.join('; '));

  if (isCreate) {
    const [[dup]] = await db.query(
      'SELECT id FROM field_defs WHERE entity = ? AND field_key = ? LIMIT 1', [entity, fieldKey]
    );
    if (dup) throw _err(409, `field "${fieldKey}" already exists on ${entity}`);
    await assertNoColumnCollision(db, entity, fieldKey);
  }

  return {
    entity,
    field_key:  fieldKey,
    label,
    field_type: fieldType,
    options,
    validation,
    show_when:  showWhen == null ? null : showWhen,
    sort_order: sortOrder,
    active:     d.active === undefined ? 1 : (d.active ? 1 : 0),
  };
}

// ─────────────────────────────────────────────────────────────
// Mutations — every one ends in bump()
// ─────────────────────────────────────────────────────────────

const _json = v => (v == null ? null : JSON.stringify(v));

/** `indexed` belongs to the S3 reconciler; the v1 API never writes it. */
function _assertIndexedUntouched(body, current) {
  if (body.indexed !== undefined && (body.indexed ? 1 : 0) !== current) {
    throw _err(400, 'indexed is managed by the reconciler (S3) and is not writable in v1');
  }
}

/** Create a def. @returns {{ id, entity, field_key }} */
async function createDef(db, body = {}) {
  const b = body || {};
  _assertIndexedUntouched(b, 0);
  const def = await validateDef(db, b, { isCreate: true });
  try {
    const [result] = await db.query(
      `INSERT INTO field_defs
         (entity, field_key, label, field_type, options, validation, show_when, sort_order, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [def.entity, def.field_key, def.label, def.field_type, _json(def.options),
       _json(def.validation), _json(def.show_when), def.sort_order, def.active]
    );
    bump();
    return { id: result.insertId, entity: def.entity, field_key: def.field_key };
  } catch (err) {
    // The pre-check in validateDef can lose a race; the UNIQUE key cannot.
    if (err && err.code === 'ER_DUP_ENTRY') {
      throw _err(409, `field "${def.field_key}" already exists on ${def.entity}`);
    }
    throw err;
  }
}

const PATCHABLE = ['label', 'field_type', 'options', 'validation', 'show_when', 'sort_order'];

/**
 * Partial update of label / field_type / options / validation / show_when /
 * sort_order. entity and field_key are immutable (a body carrying either
 * with a DIFFERENT value is a 400; the same value is a no-op, the roles
 * PUT idiom). active has its own verbs (setActive). The merged row is
 * validated whole — changing select → text requires options: null in the
 * same patch. Row-locked so two editors can't validate against a stale row.
 */
async function updateDef(db, id, patch = {}) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) throw _err(400, 'id must be an integer');
  const p = patch || {};

  const result = await withTransaction(db, async (conn) => {
    const [[raw]] = await conn.query(`${SELECT_COLS} WHERE id = ? LIMIT 1 FOR UPDATE`, [n]);
    if (!raw) throw _err(404, `field def ${n} not found`);
    const row = _shape(raw);

    for (const k of ['entity', 'field_key']) {
      if (p[k] !== undefined && String(p[k]).trim() !== row[k]) {
        throw _err(400, `${k} is immutable — deactivate this field and create a new one instead`);
      }
    }
    if (p.active !== undefined) {
      throw _err(400, 'active is not patchable — use /deactivate or /reactivate');
    }
    _assertIndexedUntouched(p, row.indexed);

    const present = PATCHABLE.filter(k => p[k] !== undefined);
    if (!present.length) {
      throw _err(400, `update requires at least one of ${PATCHABLE.join(', ')}`);
    }
    const merged = { ...row };
    for (const k of present) merged[k] = p[k];
    const def = await validateDef(conn, merged, { isCreate: false });

    const sets = present.map(k => `${k} = ?`);
    const args = present.map(k => (['options', 'validation', 'show_when'].includes(k) ? _json(def[k]) : def[k]));
    await conn.query(`UPDATE field_defs SET ${sets.join(', ')} WHERE id = ?`, [...args, n]);
    return { id: n, entity: row.entity, field_key: row.field_key };
  });
  bump();
  return result;
}

/** Deactivate (retire) or reactivate a def. Idempotent. */
async function setActive(db, id, active) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) throw _err(400, 'id must be an integer');
  const [result] = await db.query(
    'UPDATE field_defs SET active = ? WHERE id = ?', [active ? 1 : 0, n]
  );
  if (!result.affectedRows) throw _err(404, `field def ${n} not found`);
  bump();
  return { id: n, active: active ? 1 : 0 };
}

module.exports = {
  ENTITIES,
  ENTITY_TABLES,
  FIELD_TYPES,
  KEY_RE,
  VALIDATION_KEYS,
  TTL_MS,
  bump,
  listActive,
  getByKey,
  listAll,
  validateDef,
  assertNoColumnCollision,
  createDef,
  updateDef,
  setActive,
};
