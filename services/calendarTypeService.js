// services/calendarTypeService.js
//
/**
 * Calendar Item Type Registry — RUNTIME READ LAYER  (Unified Events U2)
 * services/calendarTypeService.js
 *
 * Governing design: ref/UNIFIED_EVENTS_DESIGN_V0_5.md §3.3 (A1 — the registry
 * is a TABLE), §3.3.2 (storage rule), §7.1 (live-safety rules).
 *
 * One table, `calendar_item_types`, says what a calendar item IS — for appts
 * and events alike, court-sourced and staff-sourced alike. This module is the
 * only code that reads it. It answers exactly three questions:
 *
 *   resolveTypeKey(db, raw)   free text (label / alias / key) → { type_key, kind }
 *   getType(db, key)          is this key in the registry? → row | null
 *   listTypes(db, filters)    what does a picker show?
 *
 * ── NOT `calendarService.js` ────────────────────────────────────────────────
 * That file is the Shabbos / holiday business-calendar service. Unrelated.
 *
 * ── WHERE THIS SITS RELATIVE TO caseEventService (E1) ───────────────────────
 * E1 derives type_key at READ time from a hard-coded vocabulary
 * (`caseEventService._EVENT_TYPE_KEYS` / `_APPT_TYPE_KEYS`). This module
 * resolves at WRITE time from the registry table. They are deliberately NOT
 * imported into each other:
 *
 *   - the registry is the runtime source (staff edit it as data, U2b);
 *   - E1's vocabulary is the BACKFILL source (scripts/genTypeKeyBackfill.js);
 *   - U3 collapses the two by making E1 read the column this module writes.
 *
 * tests/calendarTypeService.test.js carries a PARITY test: every (raw → key)
 * pair in E1's maps resolves to the same key against the seed the generator
 * writes. That test is the guarantee that write-time resolution == backfill
 * == E1 derivation. If it fails, fix the SEED (scripts/calendarTypeSeed.js),
 * not the test.
 *
 * ── RESOLUTION ORDER (v0.5 §3.3 "aliases are not matching") ─────────────────
 *   1. exact key   (ci, trim)          'confirmation_hearing'
 *   2. label       (ci, trim)          'Confirmation Hearing'
 *   3. ingest_aliases (ci, trim)       'Court Date' → hearing
 *   4. null                            unmapped → warn once, never guess
 *
 * ci + trim mirrors the `utf8mb4_general_ci` collation of appt_type /
 * event_type — the same reason E1 normalizes that way. `active` does NOT gate
 * resolution: an inactive type (`test`) still resolves, because resolution is
 * about identity and `active` is about pickers. A guessed kind would route a
 * row to the wrong TABLE under §3.3.2, so an unmapped string yields nulls.
 *
 * ── FAIL-SOFT, BY RULING (Fred, U2 R1.2) ────────────────────────────────────
 * A create must never fail because the registry read failed. loadRegistry
 * swallows the query error, warns (throttled), and serves an EMPTY registry
 * (→ every resolution is null → type_key NULL on the row). The post-deploy
 * `type_key IS NULL` gate and the idempotent backfill catch stragglers. A
 * failed refresh keeps serving the last good cache rather than replacing it
 * with nothing.
 *
 * ── OPTIONS (U2b) ───────────────────────────────────────────────────────────
 * A second table, `calendar_type_options`, is what the staff APPOINTMENT
 * pickers offer: one row per (type_key, length) with a surfaces subset and an
 * optional label override. Identity stays on the type (type_key is what the
 * cascade / singleton / court / booking reference); an option is presentation
 * and nothing references one. listOptions({ surface, case_type }) is the
 * fourth question this module answers. A meeting type with no option rows is
 * offered in no staff picker (explicit-only — nothing appears by accident).
 * Options have their OWN cache (loadOptions) so the many suites that script
 * REGISTRY_SQL positionally are untouched. The admin CRUD lives in
 * services/calendarTypeAdminService.js and calls invalidate() after every
 * write — this module stays read-only.
 *
 * ── CACHE ───────────────────────────────────────────────────────────────────
 * In-process, TTL 60s. `invalidate()` is called by the U2b admin write path
 * (calendarTypeAdminService). `_primeCache(rows)` is the test hook: suites with scripted DB stubs
 * prime the cache with the seed fixture instead of adding a positional
 * registry query to their scripts (R1.3). Primed caches never expire; only
 * `invalidate()` or `{ force: true }` replace them.
 *
 * Usage:
 *   const calendarTypeService = require('./calendarTypeService');
 *   const { type_key, kind } = await calendarTypeService.resolveTypeKey(db, 'Show Cause');
 */

'use strict';

const TTL_MS        = 60 * 1000;
const FAIL_RETRY_MS = 5 * 1000;   // after a failed load with no prior cache, retry this soon
const WARN_THROTTLE_MS = 60 * 1000;

/** Enum values of calendar_item_types.kind — byte-identical to events.kind (E0a order). */
const KINDS = ['hearing', 'meeting', 'deadline', 'conference', 'other'];
const BLOCKS = ['attendee', 'firm', 'none'];
/**
 * Closed vocabulary of calendar_type_options.surfaces (U2b) — the staff
 * appointment pickers. Each option row names the subset it appears on.
 *   new_client   scripts.js newContact() inline first-appt picker
 *   follow_up    scripts.js newApptDialog() (case / contact / calendar / shell tab)
 */
const SURFACES = ['new_client', 'follow_up'];

// ─────────────────────────────────────────────────────────────────────────────
// Normalization
// ─────────────────────────────────────────────────────────────────────────────

/** Lookup normalization: trim + lowercase (mirrors utf8mb4_general_ci; same as E1's _vkey). */
const _norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/** JSON column → array (tolerates mysql2 already-parsed values, strings, null). */
function _jsonArray(v) {
  if (v == null || v === '') return null;
  let parsed = v;
  if (typeof v === 'string') {
    try { parsed = JSON.parse(v); } catch (_) { return null; }
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.map((x) => String(x));
}

const _int01 = (v) => (v === 1 || v === '1' || v === true) ? 1 : 0;

/**
 * Shape one registry row into the canonical in-memory form. Accepts raw DB
 * rows (JSON columns as strings) and already-shaped rows (arrays) alike, so
 * `_primeCache` can take the seed fixture directly.
 */
function _shapeRow(r) {
  return {
    type_key:       String(r.type_key),
    label:          String(r.label == null ? r.type_key : r.label),
    kind:           String(r.kind),
    singleton:      _int01(r.singleton),
    blocks_default: r.blocks_default == null ? 'attendee' : String(r.blocks_default),
    client_attends: _int01(r.client_attends),
    default_length: r.default_length == null || r.default_length === '' ? null : Number(r.default_length),
    ingest_aliases: _jsonArray(r.ingest_aliases) || [],
    case_types:     _jsonArray(r.case_types),   // null = all case types
    active:         r.active == null ? 1 : _int01(r.active),
    sort_order:     r.sort_order == null ? 0 : Number(r.sort_order),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────────

// { at: ms, primed: bool, map: Map<type_key,row>, byKey, byLabel, byAlias }
let _cache = null;
let _lastLoadWarnAt = 0;
const _warnedUnmapped = new Set();
const _warnedCollisions = new Set();

function _warnLoad(err) {
  const now = Date.now();
  if (now - _lastLoadWarnAt < WARN_THROTTLE_MS) return;
  _lastLoadWarnAt = now;
  console.warn(
    `[calendarTypeService] registry load failed — serving ${_cache ? 'the last good cache' : 'an EMPTY registry (type_key will be NULL on new rows until it recovers)'}: ` +
    `${err && err.message}`
  );
}

function _warnCollision(what, norm, keepKey, dropKey) {
  const k = `${what}\u0000${norm}`;
  if (_warnedCollisions.has(k)) return;
  _warnedCollisions.add(k);
  console.warn(
    `[calendarTypeService] registry ${what} ${JSON.stringify(norm)} is claimed by both ` +
    `'${keepKey}' and '${dropKey}' — '${keepKey}' (lower sort_order) wins. Fix the data.`
  );
}

/** Build the three lookup indexes from shaped rows (sorted by sort_order, type_key). */
function _index(rows) {
  const sorted = rows.slice().sort((a, b) =>
    (a.sort_order - b.sort_order) || (a.type_key < b.type_key ? -1 : a.type_key > b.type_key ? 1 : 0));
  const map = new Map();
  const byKey = new Map();
  const byLabel = new Map();
  const byAlias = new Map();
  for (const r of sorted) {
    map.set(r.type_key, r);
    const nk = _norm(r.type_key);
    if (byKey.has(nk)) { _warnCollision('key', nk, byKey.get(nk).type_key, r.type_key); }
    else byKey.set(nk, r);
  }
  for (const r of sorted) {
    const nl = _norm(r.label);
    if (nl === '') continue;
    if (byLabel.has(nl) && byLabel.get(nl) !== r) { _warnCollision('label', nl, byLabel.get(nl).type_key, r.type_key); }
    else if (!byLabel.has(nl)) byLabel.set(nl, r);
  }
  for (const r of sorted) {
    for (const a of r.ingest_aliases) {
      const na = _norm(a);
      if (na === '') continue;
      if (byAlias.has(na) && byAlias.get(na) !== r) { _warnCollision('alias', na, byAlias.get(na).type_key, r.type_key); }
      else if (!byAlias.has(na)) byAlias.set(na, r);
    }
  }
  return { map, byKey, byLabel, byAlias };
}

const REGISTRY_SQL =
  `SELECT type_key, label, kind, singleton, blocks_default, client_attends,
          default_length, ingest_aliases, case_types, active, sort_order
     FROM calendar_item_types
    ORDER BY sort_order ASC, type_key ASC`;

/**
 * Load the registry (cached, TTL 60s). Returns Map<type_key, row>.
 * `force` bypasses the cache (and a primed cache). Never throws (fail-soft).
 */
async function loadRegistry(db, { force = false } = {}) {
  if (!force && _cache && (_cache.primed || Date.now() - _cache.at < TTL_MS)) {
    return _cache.map;
  }
  let rows;
  try {
    const [res] = await db.query(REGISTRY_SQL);
    rows = (Array.isArray(res) ? res : []).map(_shapeRow);
  } catch (err) {
    _warnLoad(err);
    if (_cache) {
      // Keep serving the last good registry; try again after the normal TTL.
      _cache.at = Date.now();
      return _cache.map;
    }
    const empty = _index([]);
    _cache = { at: Date.now() - (TTL_MS - FAIL_RETRY_MS), primed: false, ...empty };
    return _cache.map;
  }
  _cache = { at: Date.now(), primed: false, ..._index(rows) };
  return _cache.map;
}

/** Internal: the full index (loads if needed). */
async function _idx(db, opts) {
  await loadRegistry(db, opts);
  return _cache;
}

/** Drop both caches (registry + options). Called by the admin write path (U2b). */
function invalidate() {
  _cache = null;
  _optCache = null;
  _lastLoadWarnAt = 0;   // a fresh load deserves a fresh warning if it fails
}

// ─────────────────────────────────────────────────────────────────────────────
// Options (U2b) — separate cache, same TTL / fail-soft rules
// ─────────────────────────────────────────────────────────────────────────────

const OPTIONS_SQL =
  `SELECT id, type_key, label, length, surfaces, sort_order, active
     FROM calendar_type_options
    ORDER BY sort_order ASC, length ASC, id ASC`;

/** Shape one option row (raw DB or fixture). */
function _shapeOption(o) {
  return {
    id:         Number(o.id),
    type_key:   String(o.type_key),
    label:      o.label == null || o.label === '' ? null : String(o.label),
    length:     Number(o.length),
    surfaces:   (_jsonArray(o.surfaces) || []).map((x) => _norm(x)),
    sort_order: o.sort_order == null ? 0 : Number(o.sort_order),
    active:     o.active == null ? 1 : _int01(o.active),
  };
}

let _optCache = null;   // { at, primed, rows }

async function loadOptions(db, { force = false } = {}) {
  if (!force && _optCache && (_optCache.primed || Date.now() - _optCache.at < TTL_MS)) {
    return _optCache.rows;
  }
  let rows;
  try {
    const [res] = await db.query(OPTIONS_SQL);
    rows = (Array.isArray(res) ? res : []).map(_shapeOption);
  } catch (err) {
    _warnLoad(err);
    if (_optCache) { _optCache.at = Date.now(); return _optCache.rows; }
    _optCache = { at: Date.now() - (TTL_MS - FAIL_RETRY_MS), primed: false, rows: [] };
    return _optCache.rows;
  }
  _optCache = { at: Date.now(), primed: false, rows };
  return _optCache.rows;
}

/** TEST HOOK. Prime the options cache (raw DB shape or fixture shape). */
function _primeOptions(rows) {
  _optCache = { at: Date.now(), primed: true, rows: (rows || []).map(_shapeOption) };
}

/**
 * What a staff appointment picker shows (U2b).
 *
 * @param {object} opts
 * @param {string} opts.surface     REQUIRED, one of SURFACES (else status-400 error)
 * @param {string} [opts.case_type] keep options whose TYPE's case_types is NULL or contains it (ci)
 * @param {*}      [opts.active]    default true: only active options of active types.
 *                                  Pass false/'0' to include inactive (admin views).
 * @returns rows ordered by type sort_order, option sort_order, length, id:
 *   { option_id, type_key, label (override ?? type label), type_label, length,
 *     kind, surfaces, sort_order, active }
 */
async function listOptions(db, { surface, case_type, active = true } = {}) {
  const sf = _norm(surface);
  if (!sf || !SURFACES.includes(sf)) {
    const e = new Error(`surface is required and must be one of ${SURFACES.join(', ')} (got ${JSON.stringify(surface == null ? null : String(surface))})`);
    e.status = 400;
    throw e;
  }
  const activeOnly = !(active === false || active === 0 || active === '0' || active === 'false');
  const ct = _norm(case_type);
  const idx = await _idx(db);
  const options = await loadOptions(db);

  const out = [];
  for (const o of options) {
    const t = idx.byKey.get(_norm(o.type_key));
    if (!t) continue;                                   // orphan option — never offered
    if (!o.surfaces.includes(sf)) continue;
    if (activeOnly && (!o.active || !t.active)) continue;
    if (ct && t.case_types && !t.case_types.some((c) => _norm(c) === ct)) continue;
    out.push({
      option_id:  o.id,
      type_key:   t.type_key,
      label:      o.label || t.label,
      type_label: t.label,
      length:     o.length,
      kind:       t.kind,
      surfaces:   o.surfaces.slice(),
      sort_order: o.sort_order,
      active:     o.active,
      _ts:        t.sort_order,
    });
  }
  out.sort((a, b) => (a._ts - b._ts) || (a.sort_order - b.sort_order) || (a.length - b.length) || (a.option_id - b.option_id));
  return out.map(({ _ts, ...r }) => r);
}

/**
 * TEST HOOK. Prime the cache with rows (raw DB shape or seed-fixture shape).
 * A primed cache never expires; `invalidate()` or `{ force: true }` clears it.
 * Also resets the per-process warning dedup so suites see warnings again.
 */
function _primeCache(rows) {
  const shaped = (rows || []).map(_shapeRow);
  _cache = { at: Date.now(), primed: true, ..._index(shaped) };
  _warnedUnmapped.clear();
  _warnedCollisions.clear();
  _lastLoadWarnAt = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

const NO_MATCH = Object.freeze({ type_key: null, kind: null, matched: null });

/**
 * Resolve free text (a label, an ingest alias, or a key) to a registry row.
 *
 * @returns {{ type_key: string|null, kind: string|null, matched: 'key'|'label'|'alias'|null }}
 *   NULL / blank raw → all nulls, no warning (absent data, not an unknown string).
 *   Unmapped raw     → all nulls, ONE console.warn per raw per process.
 */
async function resolveTypeKey(db, raw) {
  const n = _norm(raw);
  if (n === '') return { ...NO_MATCH };

  const idx = await _idx(db);
  let row = idx.byKey.get(n);
  if (row) return { type_key: row.type_key, kind: row.kind, matched: 'key' };
  row = idx.byLabel.get(n);
  if (row) return { type_key: row.type_key, kind: row.kind, matched: 'label' };
  row = idx.byAlias.get(n);
  if (row) return { type_key: row.type_key, kind: row.kind, matched: 'alias' };

  if (!_warnedUnmapped.has(n)) {
    _warnedUnmapped.add(n);
    console.warn('[calendarTypeService] unmapped type', String(raw));
  }
  return { ...NO_MATCH };
}

/**
 * Exact-key lookup (ci, trim). Labels and aliases do NOT match here — this is
 * the validator for callers that pass `type_key` explicitly.
 * @returns {object|null} the shaped registry row, or null
 */
async function getType(db, key) {
  const n = _norm(key);
  if (n === '') return null;
  const idx = await _idx(db);
  return idx.byKey.get(n) || null;
}

/** 'a,b' | ['a','b'] | 'a' → ['a','b'] (trimmed, lowercased, empties dropped). */
function _csv(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map((s) => _norm(s)).filter(Boolean);
}

/**
 * Rows for pickers, sorted by sort_order then type_key.
 *
 * @param {object} [opts]
 * @param {string|string[]} [opts.kind]      one or more kinds (CSV or array)
 * @param {*}               [opts.active]    undefined = all; truthy/'1' = active only; '0'/false/0 = inactive only
 * @param {string}          [opts.case_type] keep rows whose case_types is NULL (all) or contains it (ci)
 */
async function listTypes(db, { kind, active, case_type } = {}) {
  const idx = await _idx(db);
  const kinds = _csv(kind);
  let activeFilter = null;   // null = no filter
  if (active !== undefined && active !== null && active !== '') {
    activeFilter = (active === true || active === 1 || active === '1' || active === 'true') ? 1 : 0;
  }
  const ct = _norm(case_type);

  const out = [];
  for (const r of idx.map.values()) {
    if (kinds.length && !kinds.includes(_norm(r.kind))) continue;
    if (activeFilter !== null && r.active !== activeFilter) continue;
    if (ct && r.case_types && !r.case_types.some((c) => _norm(c) === ct)) continue;
    out.push({ ...r, ingest_aliases: r.ingest_aliases.slice(), case_types: r.case_types ? r.case_types.slice() : null });
  }
  return out;   // idx.map is insertion-ordered by sort_order, type_key
}

// ─────────────────────────────────────────────────────────────────────────────
// Write-path helpers (shared by eventService / apptService / the two appt
// PATCH surfaces, so all four resolve identically)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create-path resolution. Precedence (U2 §C.1/C.3):
 *   1. a given `type_key` that EXISTS in the registry → that row
 *   2. else resolve from the free-text label
 * A given-but-unknown key is not an error on create (raw passthrough), but it
 * is warned once so a caller typo does not stay silent.
 *
 * @returns {{ type_key: string|null, kind: string|null, matched: string|null }}
 */
async function resolveForCreate(db, givenKey, label) {
  if (givenKey != null && String(givenKey).trim() !== '') {
    const row = await getType(db, givenKey);
    if (row) return { type_key: row.type_key, kind: row.kind, matched: 'key' };
    const n = _norm(givenKey);
    if (!_warnedUnmapped.has(`key:${n}`)) {
      _warnedUnmapped.add(`key:${n}`);
      console.warn(`[calendarTypeService] create passed unknown type_key ${JSON.stringify(givenKey)} — resolving from the label instead`);
    }
  }
  return resolveTypeKey(db, label);
}

/** A 400-shaped error for the PATCH surfaces (routes read err.status). */
function _badKey(prefix, key) {
  const e = new Error(`${prefix}: unknown type_key ${JSON.stringify(String(key))}`);
  e.status = 400;
  return e;
}

/**
 * PATCH-path resolution for the two raw-SET appt surfaces
 * (routes/api.appts.js PATCH and update_appointment). Returns a NEW fields
 * object; the input is not mutated.
 *
 *   type_key given, non-blank → must exist (else throws status 400); canonical key written
 *   type_key blank/null       → resolved from appt_type if that is in the patch, else NULL
 *   appt_type only            → type_key resolved from it and ADDED to the patch
 *   neither                   → untouched
 */
async function applyApptTypePatch(db, fields, { errorPrefix = 'update_appointment' } = {}) {
  const out = { ...fields };
  const hasKey  = Object.prototype.hasOwnProperty.call(out, 'type_key');
  const hasType = Object.prototype.hasOwnProperty.call(out, 'appt_type');
  if (!hasKey && !hasType) return out;

  if (hasKey && out.type_key != null && String(out.type_key).trim() !== '') {
    const row = await getType(db, out.type_key);
    if (!row) throw _badKey(errorPrefix, out.type_key);
    out.type_key = row.type_key;
    return out;
  }
  // blank key, or label-only patch
  if (hasType) {
    const r = await resolveTypeKey(db, out.appt_type);
    out.type_key = r.type_key;
  } else {
    out.type_key = null;
  }
  return out;
}

module.exports = {
  loadRegistry,
  resolveTypeKey,
  getType,
  listTypes,
  listOptions,
  loadOptions,
  invalidate,
  resolveForCreate,
  applyApptTypePatch,
  KINDS,
  BLOCKS,
  SURFACES,
  // test hooks / internals (repo `_`-prefix convention)
  _primeCache,
  _primeOptions,
  _shapeOption,
  _norm,
  _shapeRow,
  _TTL_MS: TTL_MS,
  _REGISTRY_SQL: REGISTRY_SQL,
  _OPTIONS_SQL: OPTIONS_SQL,
};
