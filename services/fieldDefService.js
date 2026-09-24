// services/fieldDefService.js
//
/**
 * Field Definition Service (custom-fields arc S1, values S2, columns S3)
 * services/fieldDefService.js
 *
 * The `field_defs` registry — single source of truth for admin-defined
 * fields (ref/CUSTOM_FIELDS_DESIGN.md §2–§3). S1: read API + cache,
 * validation, and the CRUD the Fields editor drives (public/caseconfig/
 * fields.html since CFG-1). S2: value validation
 * and the write-chokepoint helpers (see VALUES below); S4's renderers will
 * read the registry through listActive / getByKey.
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
 * ── COLUMN SURFACE (S3) ─────────────────────────────────────────────────────
 * services/fieldDefReconciler.js owns the DDL. The mutations that can change
 * the column surface — createDef, setActive (either way), and an updateDef
 * that changed field_type — call scheduleReconcile right after bump(),
 * fire-and-forget; label / options / validation / sort_order edits don't.
 * Pass { actor } (the route's audit context) so the reconcile's own
 * admin_audit_log row names who caused it.
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
 * ── VALUES (S2) ─────────────────────────────────────────────────────────────
 * <entity>.custom holds the values, one JSON key per def. The two service
 * chokepoints (caseService.updateCase, contactService.updateContact) are the
 * only writers, and both go through the helpers at the bottom of this file:
 *   splitCustomFields   cf_ keys out of the payload, each validated against
 *                       its ACTIVE def (validateValue) — unknown/retired → 400
 *   customAssignment    one `custom = JSON_REMOVE(JSON_SET(custom, …), …)`
 *                       clause, composed INTO the caller's single UPDATE
 *   buildCustomChanges  per-key {from,to} — never a `custom` entry
 * Design doc §3 rules these enforce: never read-modify-write the bag in JS
 * (a concurrent form save + executor write would lose one); never store JSON
 * null (clear = JSON_REMOVE); nothing reads a key back out of the bag in SQL
 * with ->> / JSON_EXTRACT (the S3 virtual column is the only comparison
 * surface — tests/customFields.s2.test.js greps lib/ services/ routes/ for
 * it, comments included, so don't write the operator next to the column
 * name even in prose). `validation.required` is NOT enforced here: a
 * partial PATCH omitting a required field must not fail; renderers own it
 * (S4).
 * updateDef enforces §3's post-data locks: field_type, and option values.
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

/** Design doc §3. 60 chars max, so the S3 index name `idx_<key>` tops out at
 *  exactly MySQL's 64-char identifier limit (the old {1,60} allowed 64-char
 *  keys → 68-char index names → ERROR 1059 at reconcile time). */
const KEY_RE = /^cf_[a-z][a-z0-9_]{1,56}$/;

/** Width of the S3 VARCHAR column for text + select (fieldDefReconciler
 *  COLUMN_SPECS). Text values and option values are capped to it at write /
 *  def time — the NUMBER_ABS_LIMIT argument: a longer value would store fine
 *  in JSON and read back NULL from the column. Also the row-size budget:
 *  virtual columns count toward InnoDB's 65,535-byte row limit (measured:
 *  cases fits ~47 of these, contacts ~58). */
const STRING_MAX_LEN = 255;

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
const _cache = new Map();    // entity → { at, rows: frozen[], byKey: Map }
const _colCache = new Map(); // entity → { at, set } — writableColumns (S2)

/** Invalidate every entity's cached defs (and column lists) on this instance. */
function bump() {
  _gen++;
  _cache.clear();
  _colCache.clear();
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

/**
 * `active` (S2) is the option's RETIRE flag (design doc §3): a retired option
 * is hidden from pickers but still labels the records that hold it, and
 * writes still accept it. Omitted → the stored state for that same value
 * (priorOptions), else true for a new value. NOT a flat "default true": an
 * editor or API caller that round-trips {value, label} only would otherwise
 * silently reactivate every retired option on each save (the S1 settings
 * editor did exactly that; the CFG-1 Fields editor sends active explicitly).
 */
function _checkOptions(options, fieldType, errs, priorOptions) {
  const wants = OPTION_TYPES.includes(fieldType);
  if (!wants) {
    if (options != null) errs.push('options is only allowed for select / multiselect fields');
    return null;
  }
  if (!Array.isArray(options) || !options.length) {
    errs.push(`options is required for ${fieldType} and must be a non-empty array`);
    return null;
  }
  const prior = new Map((Array.isArray(priorOptions) ? priorOptions : [])
    .filter(_isPlainObject).map(o => [o.value, o]));
  const out = [];
  const seen = new Set();
  options.forEach((o, i) => {
    const at = `options[${i}]`;
    if (!_isPlainObject(o)) { errs.push(`${at} must be an object {value, label}`); return; }
    Object.keys(o).forEach(k => {
      if (k !== 'value' && k !== 'label' && k !== 'active') errs.push(`${at}: unknown property "${k}"`);
    });
    // value is the STORED form: MEMBER OF is byte-sensitive and the S3
    // select column is utf8mb4_general_ci (case-insensitive, PAD SPACE) —
    // so no edge whitespace, and uniqueness is case-insensitive.
    const v = o.value;
    if (typeof v !== 'string' || v === '') {
      errs.push(`${at}.value must be a non-empty string`);
    } else if (Array.from(v).length > STRING_MAX_LEN) {
      errs.push(`${at}.value must be ${STRING_MAX_LEN} characters or fewer`);
    } else if (v.trim() !== v) {
      errs.push(`${at}.value must not start or end with whitespace`);
    } else if (seen.has(v.toLowerCase())) {
      errs.push(`${at}.value "${v}" is duplicated (values must be unique, case-insensitive)`);
    } else {
      seen.add(v.toLowerCase());
    }
    const lbl = typeof o.label === 'string' ? o.label.trim() : '';
    if (!lbl) errs.push(`${at}.label is required`);
    let active = true;
    if (o.active === undefined) {
      const was = prior.get(v);
      active = was ? was.active !== false : true;
    } else if (typeof o.active !== 'boolean') {
      errs.push(`${at}.active must be true or false`);
    } else {
      active = o.active;
    }
    out.push({ value: v, label: lbl, active });
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
    if (k === 'max_len' && !(Number.isInteger(v) && v >= 1 && v <= STRING_MAX_LEN)) {
      errs.push(`validation.max_len must be a whole number from 1 to ${STRING_MAX_LEN}`);
    }
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
 * priorOptions (PATCH only) is the stored options array — an option that
 * omits `active` keeps its stored state (see _checkOptions).
 *
 * @returns normalized { entity, field_key, label, field_type, options,
 *          validation, show_when, sort_order, active }
 */
async function validateDef(db, def = {}, { isCreate = true, priorOptions = null } = {}) {
  const errs = [];
  const d = def || {};

  const entity = String(d.entity == null ? '' : d.entity).trim();
  if (!ENTITIES.includes(entity)) errs.push(`entity must be one of ${ENTITIES.join(', ')}`);

  const fieldKey = String(d.field_key == null ? '' : d.field_key).trim();
  if (!KEY_RE.test(fieldKey)) {
    errs.push('field_key must match ^cf_[a-z][a-z0-9_]{1,56}$ (cf_ + a letter + 1–56 of a–z, 0–9, _ — 60 characters at most)');
  }

  const label = String(d.label == null ? '' : d.label).trim();
  if (!label) errs.push('label is required');
  else if (label.length > LABEL_MAX) errs.push(`label must be ${LABEL_MAX} characters or fewer`);

  const fieldType = d.field_type;
  const typeOk = FIELD_TYPES.includes(fieldType);
  if (!typeOk) errs.push(`field_type must be one of ${FIELD_TYPES.join(', ')}`);

  const rawOptions = _jsonIn(d.options, 'options', errs);
  const options = typeOk ? _checkOptions(rawOptions, fieldType, errs, priorOptions) : null;

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

/** Post-bump() column-surface hook (S3). Lazy require: the reconciler requires
 *  this module. Fire-and-forget — the reconciler alerts on its own failures. */
function _reconcileSoon(db, trigger, actor) {
  require('./fieldDefReconciler').scheduleReconcile(db, { trigger, actor: actor || null });
}

/** `indexed` belongs to the S3 reconciler; the v1 API never writes it. */
function _assertIndexedUntouched(body, current) {
  if (body.indexed !== undefined && (body.indexed ? 1 : 0) !== current) {
    throw _err(400, 'indexed is managed by the reconciler (S3) and is not writable in v1');
  }
}

/** Create a def. @returns {{ id, entity, field_key }} */
async function createDef(db, body = {}, { actor = null } = {}) {
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
    _reconcileSoon(db, 'create', actor);
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
 *
 * POST-DATA LOCKS (S2, design doc §3) — 409, checked inside the row lock
 * against the stored JSON (existence probes only; never `->>`):
 *   - field_type is frozen once ANY record holds a value under the key. The
 *     escape hatch is a new field plus one UPDATE copying values across.
 *   - an option VALUE is frozen once any record holds it. Options are
 *     matched by value, so a "rename" and a removal look the same: the old
 *     value is gone from the array. Gone + unused = hard delete (fine);
 *     gone + used = rejected with the retire hint (active: false).
 * Residual, accepted: a def edited while another instance's cache (TTL_MS)
 * still holds the old def can let one write validate against the old shape.
 * A changed field_type retypes the column (S3) — reconciled after commit.
 */
async function updateDef(db, id, patch = {}, { actor = null } = {}) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) throw _err(400, 'id must be an integer');
  const p = patch || {};

  let typeChanged = false;
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
    const def = await validateDef(conn, merged, { isCreate: false, priorOptions: row.options });

    const table = ENTITY_TABLES[row.entity];
    const path = `$.${row.field_key}`;
    if (def.field_type !== row.field_type && await _keyHasData(conn, table, path)) {
      throw _err(409,
        `field_type is locked: records already hold a value for ${row.field_key}. ` +
        'Create a new field and copy the values across instead of changing the type.');
    }
    if (present.includes('options') && def.field_type === row.field_type && OPTION_TYPES.includes(row.field_type)) {
      const kept = new Set((def.options || []).map(o => o.value));
      const gone = (row.options || []).map(o => o && o.value).filter(v => typeof v === 'string' && !kept.has(v));
      const used = [];
      for (const v of gone) if (await _optionHasData(conn, table, path, v)) used.push(v);
      if (used.length) {
        throw _err(409,
          `option value${used.length > 1 ? 's' : ''} ${used.map(v => `"${v}"`).join(', ')} ` +
          `${used.length > 1 ? 'are' : 'is'} held by existing records and cannot be removed or changed — ` +
          'keep the option and retire it instead ("active": false hides it from pickers)');
      }
    }

    const sets = present.map(k => `${k} = ?`);
    const args = present.map(k => (['options', 'validation', 'show_when'].includes(k) ? _json(def[k]) : def[k]));
    await conn.query(`UPDATE field_defs SET ${sets.join(', ')} WHERE id = ?`, [...args, n]);
    typeChanged = def.field_type !== row.field_type;
    return { id: n, entity: row.entity, field_key: row.field_key };
  });
  bump();
  if (typeChanged) _reconcileSoon(db, 'update', actor);
  return result;
}

/** Deactivate (retire) or reactivate a def. Idempotent. Either way the
 *  column surface may change (S3: a retired def's column is dropped). */
async function setActive(db, id, active, { actor = null } = {}) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) throw _err(400, 'id must be an integer');
  const [result] = await db.query(
    'UPDATE field_defs SET active = ? WHERE id = ?', [active ? 1 : 0, n]
  );
  if (!result.affectedRows) throw _err(404, `field def ${n} not found`);
  bump();
  _reconcileSoon(db, active ? 'reactivate' : 'deactivate', actor);
  return { id: n, active: active ? 1 : 0 };
}

// ─────────────────────────────────────────────────────────────
// Post-data probes (S2) — the only reads of <entity>.custom outside the
// chokepoint. Existence checks via JSON_CONTAINS*, never `->>` (§3). An
// unindexed scan of ~1k rows; only a def PATCH (or the editor's usage
// read) pays it.
// ─────────────────────────────────────────────────────────────

/** THE record-holds-a-value predicate (`?` binds the '$.<key>' path).
 *  Defined once so the S2 type-lock probe and the CFG-1 usage counts can
 *  never disagree: exists (LIMIT 1) and COUNT are two aggregates over this
 *  one definition. JSON null is never stored (§3), so path-exists = has
 *  data. */
const KEY_DATA_SQL = `JSON_CONTAINS_PATH(custom, 'one', ?)`;

async function _keyHasData(conn, table, path) {
  const [rows] = await conn.query(
    `SELECT 1 AS hit FROM \`${table}\` WHERE ${KEY_DATA_SQL} LIMIT 1`, [path]
  );
  return !!(rows && rows.length);
}

/**
 * Per-field record counts for an entity — { field_key: count } over every
 * def incl. inactive (values persist through retirement). Powers the Fields
 * editor's usage badges (CFG-1): count > 0 renders field_type locked, and
 * because the count and the updateDef type-lock read the same KEY_DATA_SQL,
 * the badge and the 409 cannot disagree. One COUNT per def — the registry
 * is small and only the editor pays it.
 */
async function usageCounts(db, entity) {
  const table = ENTITY_TABLES[_assertEntity(entity)];
  const usage = {};
  for (const def of await listAll(db, entity)) {
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS n FROM \`${table}\` WHERE ${KEY_DATA_SQL}`, [`$.${def.field_key}`]
    );
    usage[def.field_key] = row ? Number(row.n) || 0 : 0;
  }
  return usage;
}

/** JSON_CONTAINS is true for a select scalar equal to the value AND for a
 *  multiselect array holding it — one probe serves both stored shapes. */
async function _optionHasData(conn, table, path, value) {
  const [rows] = await conn.query(
    `SELECT 1 AS hit FROM \`${table}\` WHERE JSON_CONTAINS(custom, CAST(? AS JSON), ?) LIMIT 1`,
    [JSON.stringify(value), path]
  );
  return !!(rows && rows.length);
}

// ─────────────────────────────────────────────────────────────
// Values (S2) — validateValue + the chokepoint helpers
// ─────────────────────────────────────────────────────────────

/** DECIMAL(18,4) bound — number's S3 virtual column type (design doc §2). A
 *  bigger value would store fine in JSON and read back clamped in SQL.
 *  EXCLUSIVE 1e14: the column max 99999999999999.9999 is not a JS double
 *  (it rounds to exactly 1e14), so `> max` would let 1e14 through. */
const NUMBER_ABS_LIMIT = 1e14;
const NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A select/multiselect input → the canonical stored option value, or null.
 *  Exact match first, then case-insensitive: values are unique case-
 *  insensitively (validateDef), so the fold is unambiguous, and storing the
 *  canonical spelling keeps MEMBER OF (byte-sensitive) honest. Active and
 *  retired options both match (§3). */
function _optionValue(def, raw) {
  let s = null;
  if (typeof raw === 'string') s = raw.trim();
  else if (typeof raw === 'number' && Number.isFinite(raw)) s = String(raw);
  if (!s) return null;
  const opts = Array.isArray(def.options) ? def.options : [];
  const hit = opts.find(o => o.value === s)
           || opts.find(o => String(o.value).toLowerCase() === s.toLowerCase());
  return hit ? hit.value : null;
}

function _optionList(def) {
  return (Array.isArray(def.options) ? def.options : []).map(o => o.value).join(', ');
}

/**
 * Validate + normalize one value for a def (design doc §2 type map).
 *
 * @returns {{ ok: true, value }} — value null means CLEAR (the key is
 *          JSON_REMOVEd; JSON null is never stored) — or
 *          {{ ok: false, error }} with the key named in the message.
 *
 * Clear: null / undefined / '' on any type, [] on multiselect.
 * text: a string (a finite number is taken as its text); at most
 *   STRING_MAX_LEN characters whatever the def says (the S3 column width);
 *   max_len counts characters; pattern must match the WHOLE value (the HTML
 *   input `pattern` semantics a renderer will use), not a substring.
 * number: a finite number or a plain decimal string; stored as a JSON
 *   number; min / max; |n| within DECIMAL(18,4).
 * date: 'YYYY-MM-DD', a real calendar date, year 1000+ (MySQL DATE).
 * boolean: true/false, 1/0, '1'/'0', 'true'/'false' (any case) → true/false.
 * select: one option value (active or retired); unknown rejected.
 * multiselect: an array of option values (active or retired), no repeats;
 *   stored in the def's option order so an equal set diffs as unchanged.
 * validation.required is deliberately NOT checked (renderers own it, S4).
 */
function validateValue(def, raw) {
  const key = def && def.field_key;
  const bad = msg => ({ ok: false, error: `${key}: ${msg}` });
  if (!def) return { ok: false, error: 'no field definition' };

  if (raw === null || raw === undefined || raw === ''
      || (def.field_type === 'multiselect' && Array.isArray(raw) && raw.length === 0)) {
    return { ok: true, value: null };
  }
  const v = _isPlainObject(def.validation) ? def.validation : {};

  switch (def.field_type) {
    case 'text': {
      const s = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
      if (typeof s !== 'string') return bad('must be text');
      const len = Array.from(s).length;
      if (len > STRING_MAX_LEN) return bad(`must be ${STRING_MAX_LEN} characters or fewer (got ${len})`);
      if (Number.isInteger(v.max_len) && len > v.max_len) {
        return bad(`must be ${v.max_len} characters or fewer (got ${len})`);
      }
      if (typeof v.pattern === 'string' && v.pattern) {
        let re;
        try { re = new RegExp(`^(?:${v.pattern})$`); }
        catch (_) { return bad('the field\'s validation pattern is not a valid regular expression'); }
        if (!re.test(s)) return bad(`must match the pattern ${v.pattern}`);
      }
      return { ok: true, value: s };
    }

    case 'number': {
      let n;
      if (typeof raw === 'number') n = raw;
      else if (typeof raw === 'string' && NUMERIC_RE.test(raw.trim())) n = Number(raw.trim());
      else return bad('must be a number');
      if (!Number.isFinite(n)) return bad('must be a finite number');
      if (Math.abs(n) >= NUMBER_ABS_LIMIT) return bad('must be between -99999999999999.9999 and 99999999999999.9999');
      if (typeof v.min === 'number' && n < v.min) return bad(`must be at least ${v.min}`);
      if (typeof v.max === 'number' && n > v.max) return bad(`must be at most ${v.max}`);
      return { ok: true, value: n === 0 ? 0 : n }; // -0 → 0
    }

    case 'date': {
      const s = typeof raw === 'string' ? raw.trim() : '';
      const m = DATE_RE.exec(s);
      if (!m) return bad('must be a date written YYYY-MM-DD');
      const y = +m[1], mo = +m[2], d = +m[3];
      const dt = new Date(Date.UTC(y, mo - 1, d));
      if (y < 1000 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
        return bad(`"${s}" is not a real calendar date`);
      }
      return { ok: true, value: s };
    }

    case 'boolean': {
      const b = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
      if (b === true || b === 1 || b === '1' || b === 'true') return { ok: true, value: true };
      if (b === false || b === 0 || b === '0' || b === 'false') return { ok: true, value: false };
      return bad('must be true or false');
    }

    case 'select': {
      const val = _optionValue(def, raw);
      if (val == null) return bad(`${JSON.stringify(raw)} is not one of its options (${_optionList(def)})`);
      return { ok: true, value: val };
    }

    case 'multiselect': {
      if (!Array.isArray(raw)) return bad('must be an array of option values');
      const picked = new Set();
      const errs = [];
      for (const item of raw) {
        const val = _optionValue(def, item);
        if (val == null) errs.push(`${JSON.stringify(item)} is not one of its options (${_optionList(def)})`);
        else if (picked.has(val)) errs.push(`"${val}" is listed twice`);
        else picked.add(val);
      }
      if (errs.length) return bad(errs.join(', '));
      return { ok: true, value: def.options.map(o => o.value).filter(x => picked.has(x)) };
    }

    default:
      return bad(`has an unsupported field_type "${def.field_type}"`);
  }
}

/** Custom-namespace test. Case-insensitive: MySQL column names are, so after
 *  S3 a `CF_X` key must never reach the column path and hit the virtual
 *  column — it lands here and fails as an unknown field instead. */
const CF_PREFIX_RE = /^cf_/i;

/**
 * Partition an update payload into core columns and cf_ keys — THE shared
 * front half of both chokepoints (caseService.updateCase,
 * contactService.updateContact). Every cf_ key must name an ACTIVE def on the
 * entity and carry a valid value; `custom` itself is never a writable key.
 * All problems are collected and thrown together (400, joined with '; ').
 *
 * The core keys are returned untouched — each service keeps its own core
 * gate (cases: the real-column set; contacts: its ALLOWED list).
 *
 * @returns {{ coreFields: object,
 *             customSets: {[key]: value},  // JSON_SET, validated + normalized
 *             customRemoves: string[],      // JSON_REMOVE (cleared keys)
 *             customKeys: string[] }}       // every cf_ key written, input order
 */
async function splitCustomFields(db, entity, fields) {
  _assertEntity(entity);
  const coreFields = {};
  const customSets = {};
  const customRemoves = [];
  const customKeys = [];
  const errs = [];
  const cfKeys = [];

  for (const k of Object.keys(fields || {})) {
    if (k.toLowerCase() === 'custom') errs.push('custom is not writable as a whole — write individual cf_ keys');
    else if (CF_PREFIX_RE.test(k)) cfKeys.push(k);
    else coreFields[k] = fields[k];
  }

  const unknown = [];
  const inactive = [];
  for (const k of cfKeys) {
    const def = await getByKey(db, entity, k, { includeInactive: true });
    if (!def) { unknown.push(k); continue; }
    if (!def.active) { inactive.push(k); continue; }
    const r = validateValue(def, fields[k]);
    if (!r.ok) { errs.push(r.error); continue; }
    customKeys.push(k);
    if (r.value === null) customRemoves.push(k);
    else customSets[k] = r.value;
  }
  if (inactive.length) errs.unshift(`inactive custom field(s) on ${entity}: ${inactive.join(', ')} — reactivate the field before writing it`);
  if (unknown.length)  errs.unshift(`unknown custom field(s) on ${entity}: ${unknown.join(', ')}`);

  if (errs.length) throw _err(400, errs.join('; '));
  return { coreFields, customSets, customRemoves, customKeys };
}

/**
 * The ONE assignment that writes custom values, for the caller to append to
 * its single UPDATE's SET list (§3: same statement as the core columns; the
 * bag is never read-modify-written in JS). Paths and values are bound
 * parameters; every value goes through CAST(? AS JSON) of its JSON text so a
 * boolean stays a JSON boolean and an array a JSON array (a bare `?` would
 * bind true as 1 and an array as a SQL list).
 *
 * @returns {{ sql: string, params: any[] } | null} null when nothing to write
 */
function customAssignment(customSets, customRemoves) {
  const sets = Object.keys(customSets || {});
  const removes = customRemoves || [];
  if (!sets.length && !removes.length) return null;
  for (const k of [...sets, ...removes]) {
    if (!KEY_RE.test(k)) throw _err(500, `customAssignment: refusing malformed key "${k}"`);
  }
  let expr = '`custom`';
  const params = [];
  if (sets.length) {
    expr = `JSON_SET(${expr}, ${sets.map(() => '?, CAST(? AS JSON)').join(', ')})`;
    for (const k of sets) params.push(`$.${k}`, JSON.stringify(customSets[k]));
  }
  if (removes.length) {
    expr = `JSON_REMOVE(${expr}, ${removes.map(() => '?').join(', ')})`;
    for (const k of removes) params.push(`$.${k}`);
  }
  return { sql: `\`custom\` = ${expr}`, params };
}

/**
 * Per-key { from, to } for the cf_ keys just written — merged by the services
 * into the same `changes` map as their core columns. Compared as JSON text,
 * never through domainEvents' _diffNorm (String() of an array/object is
 * useless). Unchanged keys are omitted; a clear of an absent key is no change.
 *
 * @param {object|string|null} priorCustom  the row's custom BEFORE the write
 */
function buildCustomChanges(priorCustom, customSets, customRemoves) {
  const p = _parseJson(priorCustom);
  const prior = _isPlainObject(p) ? p : {};
  const has = k => Object.prototype.hasOwnProperty.call(prior, k) && prior[k] !== null;
  const changes = {};
  for (const [k, to] of Object.entries(customSets || {})) {
    const from = has(k) ? prior[k] : null;
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[k] = { from, to };
  }
  for (const k of customRemoves || []) {
    if (has(k)) changes[k] = { from: prior[k], to: null };
  }
  return changes;
}

/**
 * Lower-cased set of the entity table's WRITABLE real columns — generated
 * columns (S3's cf_ virtuals among them) and `custom` excluded. caseService
 * uses it to reject keys that are neither a column nor a cf_ key. Cached like
 * the defs (TTL_MS, cleared by bump()). An empty read throws rather than
 * rejecting every column as unknown.
 */
async function writableColumns(db, entity) {
  const table = ENTITY_TABLES[_assertEntity(entity)];
  const hit = _colCache.get(entity);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.set;
  const gen = _gen;
  const [rows] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND GENERATION_EXPRESSION = ''`,
    [table]
  );
  const set = new Set((rows || []).map(r => String(r.COLUMN_NAME).toLowerCase()));
  set.delete('custom');
  if (!set.size) throw _err(500, `could not read the column list for ${table}`);
  if (gen === _gen) _colCache.set(entity, { at: Date.now(), set });
  return set;
}

module.exports = {
  ENTITIES,
  ENTITY_TABLES,
  FIELD_TYPES,
  KEY_RE,
  STRING_MAX_LEN,
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
  usageCounts,
  // S2 — values + the write chokepoint
  validateValue,
  splitCustomFields,
  customAssignment,
  buildCustomChanges,
  writableColumns,
};
