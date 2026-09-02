// services/calendarTypeAdminService.js
//
/**
 * Calendar Item Type Registry — ADMIN WRITE LAYER  (Unified Events U2b)
 *
 * Governing design: ref/UNIFIED_EVENTS_DESIGN_V0_5.md §3.3 (A1 — the registry
 * is a TABLE), §3.3.2 (kind routes storage), §7.1 (live-safety rules).
 * Build philosophy: code owns vocabulary; data owns policy. This module is
 * the write side of `calendar_item_types`. services/calendarTypeService.js
 * (the runtime read layer with the 60s cache) stays read-only; every write
 * here ends with calendarTypeService.invalidate().
 *
 * Route: routes/api.calendarTypesAdmin.js. UI: public/caseconfig/calendarTypes.html.
 *
 * Two tables (Fred's ruling, 2026-09-02): `calendar_item_types` is IDENTITY,
 * `calendar_type_options` is PRESENTATION — one row per (type, length) with
 * the surfaces subset a staff appointment picker offers it on. Options exist
 * for kind=meeting types only, nothing references an option row, and a
 * meeting type with no options is offered in no staff picker (explicit-only).
 *
 * ── RULES ENFORCED HERE (the route is a thin mapper) ──────────────────────
 *   type_key    required on create, ^[a-z][a-z0-9_]{1,39}$, IMMUTABLE after
 *               create. Keys are the permanent contract — events.type_key,
 *               appts.type_key, booking_views.type_key, ai_match_types.item_type,
 *               sequence_templates.filters.type_key all reference keys, never
 *               labels. (Same design as pipeline stage_key.)
 *   kind        required on create; IMMUTABLE once ANY reference exists → 409.
 *               kind routes STORAGE (meeting → appts, else → events, §3.3.2);
 *               flipping it under live rows would orphan them in the wrong table.
 *   label       required, ≤ 80. Freely editable (that is the point).
 *   case_types / ingest_aliases   arrays of non-empty strings or null,
 *               deduped (ci) and trimmed. [] is stored as NULL for case_types
 *               (NULL = every case type) and as [] for aliases.
 *   kind        additionally locked while OPTION rows exist (options are a
 *               meeting-only concept) → 409 "remove the options first".
 *   DELETE type cascades its option rows (owned children, no FK — app code).
 *   OPTIONS     type must exist and be kind=meeting (400 otherwise);
 *               length integer 1..1440; surfaces NON-EMPTY subset of SURFACES;
 *               label override ≤ 80 or null; UNIQUE (type_key, length) →
 *               ER_DUP_ENTRY maps to 409; type_key immutable on an option.
 *   blocks_default ∈ BLOCKS; default_length null or integer 0..1440;
 *               singleton / client_attends / active ∈ {0,1}; sort_order integer.
 *   RESOLVER UNAMBIGUITY (the rule E1 enforced at load, calendarTypeService
 *               warns on): across the registry no two rows may claim the same
 *               (ci, trim) string as key, label or alias. On every write the
 *               row's key + label + aliases are checked against every OTHER
 *               row's key + label + aliases → 409 naming the row. Within the
 *               row, an alias equal to its own key or label → 400 (D5: aliases
 *               never contain the row's own label).
 *   DELETE      only at zero references across events, appts, booking_views,
 *               ai_match_types → else 409 "deactivate instead".
 *
 * ── REFERENCE COUNTS ─────────────────────────────────────────────────────
 *   events.type_key, appts.type_key, booking_views.type_key,
 *   ai_match_types.item_type — one grouped query each for the list, one
 *   4-way UNION for a single key. No FK constraints exist (repo convention),
 *   so these counts ARE the integrity check.
 *
 * ── JSON COLUMNS ─────────────────────────────────────────────────────────
 *   mysql2 needs a STRING at a JSON placeholder; arrays are JSON.stringify'd
 *   before binding and never passed raw. Reads tolerate both parsed and string
 *   forms (same helper shape as calendarTypeService._jsonArray).
 */

'use strict';

const calendarTypeService = require('./calendarTypeService');
const { KINDS, BLOCKS, SURFACES } = calendarTypeService;

const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const LABEL_MAX = 80;
const LENGTH_MAX = 1440;

// ─────────────────────────────────────────────────────────────────────────────
// Error helpers (routes read err.status)
// ─────────────────────────────────────────────────────────────────────────────

function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }
const badRequest = (m) => httpErr(400, m);
const notFound   = (m) => httpErr(404, m);
const conflict   = (m) => httpErr(409, m);

// ─────────────────────────────────────────────────────────────────────────────
// Normalization / validation
// ─────────────────────────────────────────────────────────────────────────────

const _norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/** JSON column → array | null (tolerates parsed values, strings, null). */
function jsonArray(v) {
  if (v == null || v === '') return null;
  let parsed = v;
  if (typeof v === 'string') {
    try { parsed = JSON.parse(v); } catch (_) { return null; }
  }
  return Array.isArray(parsed) ? parsed.map((x) => String(x)) : null;
}

/**
 * Validate an incoming string-array field. Accepts an array, null, '' or
 * undefined. Returns a trimmed, ci-deduped array (order preserved) or null.
 */
function vStringArray(v, field) {
  if (v === undefined || v === null || v === '') return null;
  if (!Array.isArray(v)) throw badRequest(`${field} must be an array of strings`);
  const out = [];
  const seen = new Set();
  for (const x of v) {
    if (typeof x !== 'string') throw badRequest(`${field} must be an array of strings`);
    const t = x.trim();
    if (!t) throw badRequest(`${field} may not contain blank entries`);
    const n = t.toLowerCase();
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(t);
  }
  return out;
}

function vBool(v, field) {
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  if (v === false || v === 0 || v === '0' || v === 'false') return 0;
  throw badRequest(`${field} must be 0 or 1`);
}

/** Option surfaces: a NON-EMPTY subset of SURFACES (an option nowhere is a deleted option). */
function vSurfaces(v) {
  const arr = vStringArray(v, 'surfaces');
  if (!arr || !arr.length) throw badRequest(`surfaces must name at least one of ${SURFACES.join(', ')}`);
  const bad = arr.filter((s) => !SURFACES.includes(s.toLowerCase()));
  if (bad.length) {
    throw badRequest(`surfaces: unknown ${bad.map((b) => JSON.stringify(b)).join(', ')} — expected a subset of ${SURFACES.join(', ')}`);
  }
  return arr.map((s) => s.toLowerCase());
}

function vOptionLength(v) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isInteger(n) || n < 1 || n > LENGTH_MAX) {
    throw badRequest(`length must be an integer between 1 and ${LENGTH_MAX}`);
  }
  return n;
}

function vOptionLabel(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw badRequest('label must be a string or null');
  const t = v.trim();
  if (!t) return null;
  if (t.length > LABEL_MAX) throw badRequest(`label must be ${LABEL_MAX} characters or fewer`);
  return t;
}

function vCaseTypes(v) {
  const arr = vStringArray(v, 'case_types');
  return arr && arr.length ? arr : null;   // [] → NULL (all case types)
}

function vAliases(v) {
  const arr = vStringArray(v, 'ingest_aliases');
  return arr || [];                         // aliases are [] when empty, never NULL
}

function vLength(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > LENGTH_MAX) {
    throw badRequest(`default_length must be an integer between 0 and ${LENGTH_MAX}, or null`);
  }
  return n;
}

function vSortOrder(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isInteger(n)) throw badRequest('sort_order must be an integer');
  return n;
}

function vLabel(v) {
  if (typeof v !== 'string' || !v.trim()) throw badRequest('label is required');
  const t = v.trim();
  if (t.length > LABEL_MAX) throw badRequest(`label must be ${LABEL_MAX} characters or fewer`);
  return t;
}

function vKind(v) {
  const k = _norm(v);
  if (!KINDS.includes(k)) throw badRequest(`kind must be one of ${KINDS.join(', ')}`);
  return k;
}

function vBlocks(v) {
  if (v === undefined || v === null || v === '') return 'attendee';
  const b = _norm(v);
  if (!BLOCKS.includes(b)) throw badRequest(`blocks_default must be one of ${BLOCKS.join(', ')}`);
  return b;
}

function vKey(v) {
  if (typeof v !== 'string') throw badRequest('type_key is required');
  const k = v.trim();
  if (!KEY_RE.test(k)) {
    throw badRequest('type_key must match ^[a-z][a-z0-9_]{1,39}$ (lowercase, starts with a letter, 2–40 chars)');
  }
  return k;
}

/** Shape a DB row for the admin API (all columns, JSON parsed). */
function shapeRow(r) {
  return {
    type_key:       String(r.type_key),
    label:          String(r.label),
    kind:           String(r.kind),
    singleton:      Number(r.singleton) ? 1 : 0,
    blocks_default: String(r.blocks_default || 'attendee'),
    client_attends: Number(r.client_attends) ? 1 : 0,
    default_length: r.default_length == null ? null : Number(r.default_length),
    ingest_aliases: jsonArray(r.ingest_aliases) || [],
    case_types:     jsonArray(r.case_types),
    active:         r.active == null ? 1 : (Number(r.active) ? 1 : 0),
    sort_order:     r.sort_order == null ? 0 : Number(r.sort_order),
    created_at:     r.created_at == null ? null : r.created_at,
    updated_at:     r.updated_at == null ? null : r.updated_at,
  };
}

const SELECT_COLS =
  `type_key, label, kind, singleton, blocks_default, client_attends, default_length,
   ingest_aliases, case_types, active, sort_order, created_at, updated_at`;

const OPTION_COLS = `id, type_key, label, length, surfaces, sort_order, active, created_at, updated_at`;

function shapeOption(o) {
  return {
    id:         Number(o.id),
    type_key:   String(o.type_key),
    label:      o.label == null || o.label === '' ? null : String(o.label),
    length:     Number(o.length),
    surfaces:   jsonArray(o.surfaces) || [],
    sort_order: o.sort_order == null ? 0 : Number(o.sort_order),
    active:     o.active == null ? 1 : (Number(o.active) ? 1 : 0),
    created_at: o.created_at == null ? null : o.created_at,
    updated_at: o.updated_at == null ? null : o.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Collision check (resolver unambiguity)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The strings a row CLAIMS for the resolver: its key, its label, its aliases.
 * Returns [{ norm, what }] — `what` is 'key' | 'label' | 'alias'.
 */
function claimsOf({ type_key, label, ingest_aliases }) {
  const out = [];
  const nk = _norm(type_key);
  if (nk) out.push({ norm: nk, what: 'key' });
  const nl = _norm(label);
  if (nl) out.push({ norm: nl, what: 'label' });
  for (const a of ingest_aliases || []) {
    const na = _norm(a);
    if (na) out.push({ norm: na, what: 'alias' });
  }
  return out;
}

/**
 * 400 if an alias duplicates the row's own key or label (D5). 409 if any of
 * the row's claims collides with another row's claims. `others` = every
 * registry row EXCEPT the one being written ({ type_key, label, ingest_aliases }).
 */
function assertUnambiguous(next, others) {
  const nk = _norm(next.type_key);
  const nl = _norm(next.label);
  for (const a of next.ingest_aliases || []) {
    const na = _norm(a);
    if (na === nk) throw badRequest(`ingest_aliases: ${JSON.stringify(a)} duplicates the row's own type_key`);
    if (na === nl) throw badRequest(`ingest_aliases: ${JSON.stringify(a)} duplicates the row's own label — the label already resolves by itself`);
  }
  const mine = claimsOf(next);
  for (const o of others) {
    if (_norm(o.type_key) === nk) continue;   // defensive: never compare a row to itself
    for (const oc of claimsOf(o)) {
      const hit = mine.find((m) => m.norm === oc.norm);
      if (hit) {
        throw conflict(
          `${hit.what} ${JSON.stringify(hit.what === 'key' ? next.type_key : hit.what === 'label' ? next.label : (next.ingest_aliases || []).find((x) => _norm(x) === hit.norm))} ` +
          `is already claimed as the ${oc.what} of '${o.type_key}' (${o.label}) — the resolver must stay unambiguous`
        );
      }
    }
  }
}

async function loadOthers(db, exceptKey) {
  const [rows] = await db.query(
    `SELECT type_key, label, ingest_aliases FROM calendar_item_types WHERE type_key <> ?`,
    [exceptKey]
  );
  return (rows || []).map((r) => ({
    type_key: String(r.type_key), label: String(r.label), ingest_aliases: jsonArray(r.ingest_aliases) || [],
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference counts
// ─────────────────────────────────────────────────────────────────────────────

const REF_SOURCES = [
  { name: 'events',         sql: `SELECT type_key AS k, COUNT(*) AS n FROM events         WHERE type_key  IS NOT NULL GROUP BY type_key`  },
  { name: 'appts',          sql: `SELECT type_key AS k, COUNT(*) AS n FROM appts          WHERE type_key  IS NOT NULL GROUP BY type_key`  },
  { name: 'booking_views',  sql: `SELECT type_key AS k, COUNT(*) AS n FROM booking_views  WHERE type_key  IS NOT NULL GROUP BY type_key`  },
  { name: 'ai_match_types', sql: `SELECT item_type AS k, COUNT(*) AS n FROM ai_match_types WHERE item_type IS NOT NULL GROUP BY item_type` },
];

const emptyRefs = () => ({ events: 0, appts: 0, booking_views: 0, ai_match_types: 0, total: 0 });

/** Map<type_key(norm), refs> across the whole registry — one query per source. */
async function loadAllRefs(db) {
  const map = new Map();
  for (const src of REF_SOURCES) {
    const [rows] = await db.query(src.sql);
    for (const r of rows || []) {
      const k = _norm(r.k);
      if (!map.has(k)) map.set(k, emptyRefs());
      const e = map.get(k);
      e[src.name] = Number(r.n);
      e.total += Number(r.n);
    }
  }
  return map;
}

/** Refs for one key — single UNION query. */
async function getRefs(db, key) {
  const [rows] = await db.query(
    `SELECT 'events' AS src, COUNT(*) AS n FROM events         WHERE type_key  = ?
     UNION ALL
     SELECT 'appts',          COUNT(*)      FROM appts          WHERE type_key  = ?
     UNION ALL
     SELECT 'booking_views',  COUNT(*)      FROM booking_views  WHERE type_key  = ?
     UNION ALL
     SELECT 'ai_match_types', COUNT(*)      FROM ai_match_types WHERE item_type = ?`,
    [key, key, key, key]
  );
  const refs = emptyRefs();
  for (const r of rows || []) {
    refs[r.src] = Number(r.n);
    refs.total += Number(r.n);
  }
  return refs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/** Every registry row (active and not), registry order, with per-key refs. */
async function listTypesAdmin(db) {
  const [rows] = await db.query(
    `SELECT ${SELECT_COLS} FROM calendar_item_types ORDER BY sort_order ASC, type_key ASC`
  );
  const refs = await loadAllRefs(db);
  const [optRows] = await db.query(
    `SELECT ${OPTION_COLS} FROM calendar_type_options ORDER BY sort_order ASC, length ASC, id ASC`
  );
  const optsByKey = new Map();
  for (const o of optRows || []) {
    const so = shapeOption(o);
    const k = _norm(so.type_key);
    if (!optsByKey.has(k)) optsByKey.set(k, []);
    optsByKey.get(k).push(so);
  }
  return (rows || []).map((r) => {
    const row = shapeRow(r);
    row.refs = refs.get(_norm(row.type_key)) || emptyRefs();
    row.options = optsByKey.get(_norm(row.type_key)) || [];
    return row;
  });
}

async function getTypeAdmin(db, key) {
  const [rows] = await db.query(`SELECT ${SELECT_COLS} FROM calendar_item_types WHERE type_key = ?`, [key]);
  const r = rows && rows[0];
  if (!r) throw notFound(`Calendar type '${key}' not found`);
  const row = shapeRow(r);
  row.refs = await getRefs(db, row.type_key);
  const [optRows] = await db.query(
    `SELECT ${OPTION_COLS} FROM calendar_type_options WHERE type_key = ? ORDER BY sort_order ASC, length ASC, id ASC`,
    [row.type_key]
  );
  row.options = (optRows || []).map(shapeOption);
  return row;
}

/**
 * Rows that carry an UNMAPPED type: type_key IS NULL. For events that means
 * the 'other' kind bucket the server assigns to every unknown string; appts
 * are all meetings so any NULL key counts. This is the U9 worklist teaser —
 * minting a type from an unmapped row is U9, not here.
 */
async function listUnmapped(db) {
  const [ev] = await db.query(
    `SELECT event_id AS id, event_type AS label, event_date AS date, event_link_type AS link_type, event_link_id AS link_id
       FROM events WHERE type_key IS NULL AND kind = 'other'
      ORDER BY event_date DESC LIMIT 200`
  );
  const [ap] = await db.query(
    `SELECT appt_id AS id, appt_type AS label, appt_date AS date, appt_case_id AS case_id, appt_client_id AS contact_id, appt_status AS status
       FROM appts WHERE type_key IS NULL
      ORDER BY appt_date DESC LIMIT 200`
  );
  return {
    events: (ev || []).map((r) => ({ ...r, id: Number(r.id) })),
    appts:  (ap || []).map((r) => ({ ...r, id: Number(r.id) })),
  };
}

/** DISTINCT cases.case_type (non-blank) — options for the case_types checkbox group. */
async function listCaseTypes(db) {
  const [rows] = await db.query(
    `SELECT case_type, COUNT(*) AS n FROM cases
      WHERE case_type IS NOT NULL AND case_type <> ''
      GROUP BY case_type ORDER BY n DESC, case_type ASC`
  );
  return (rows || []).map((r) => ({ case_type: String(r.case_type), cases: Number(r.n) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

async function createType(db, body = {}) {
  const next = {
    type_key:       vKey(body.type_key),
    label:          vLabel(body.label),
    kind:           vKind(body.kind),
    singleton:      body.singleton === undefined ? 0 : vBool(body.singleton, 'singleton'),
    blocks_default: vBlocks(body.blocks_default),
    client_attends: body.client_attends === undefined ? 0 : vBool(body.client_attends, 'client_attends'),
    default_length: vLength(body.default_length),
    ingest_aliases: vAliases(body.ingest_aliases),
    case_types:     vCaseTypes(body.case_types),
    active:         body.active === undefined ? 1 : vBool(body.active, 'active'),
    sort_order:     vSortOrder(body.sort_order),
  };

  assertUnambiguous(next, await loadOthers(db, next.type_key));

  try {
    await db.query(
      `INSERT INTO calendar_item_types
         (type_key, label, kind, singleton, blocks_default, client_attends, default_length,
          ingest_aliases, case_types, active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [next.type_key, next.label, next.kind, next.singleton, next.blocks_default, next.client_attends,
       next.default_length, JSON.stringify(next.ingest_aliases),
       next.case_types ? JSON.stringify(next.case_types) : null,
       next.active, next.sort_order]
    );
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') throw conflict(`type_key '${next.type_key}' already exists`);
    throw err;
  }
  calendarTypeService.invalidate();
  return getTypeAdmin(db, next.type_key);
}

const UPDATABLE = ['label', 'kind', 'singleton', 'blocks_default', 'client_attends', 'default_length',
                   'ingest_aliases', 'case_types', 'active', 'sort_order'];

async function updateType(db, key, patch = {}) {
  if (Object.prototype.hasOwnProperty.call(patch, 'type_key') && _norm(patch.type_key) !== _norm(key)) {
    throw conflict('type_key is immutable — create a new type and deactivate this one');
  }
  const cur = await getTypeAdmin(db, key);   // 404 if missing; carries refs

  const set = {};
  for (const f of UPDATABLE) {
    if (!Object.prototype.hasOwnProperty.call(patch, f)) continue;
    const v = patch[f];
    switch (f) {
      case 'label':          set.label = vLabel(v); break;
      case 'kind': {
        const k = vKind(v);
        if (k !== cur.kind && cur.options.length > 0) {
          throw conflict(`kind is locked: '${cur.type_key}' has ${cur.options.length} picker option(s) — options are a meeting-only concept. Remove them first.`);
        }
        if (k !== cur.kind && cur.refs.total > 0) {
          throw conflict(
            `kind is locked: ${cur.refs.total} row(s) reference '${cur.type_key}' ` +
            `(events ${cur.refs.events}, appts ${cur.refs.appts}, booking views ${cur.refs.booking_views}, court matches ${cur.refs.ai_match_types}). ` +
            `kind routes storage (meeting → appts, otherwise → events), so changing it would orphan them. Create a new type instead.`
          );
        }
        set.kind = k; break;
      }
      case 'singleton':      set.singleton = vBool(v, 'singleton'); break;
      case 'blocks_default': set.blocks_default = vBlocks(v); break;
      case 'client_attends': set.client_attends = vBool(v, 'client_attends'); break;
      case 'default_length': set.default_length = vLength(v); break;
      case 'ingest_aliases': set.ingest_aliases = vAliases(v); break;
      case 'case_types':     set.case_types = vCaseTypes(v); break;
      case 'active':         set.active = vBool(v, 'active'); break;
      case 'sort_order':     set.sort_order = vSortOrder(v); break;
      default: break;
    }
  }
  const fields = Object.keys(set);
  if (!fields.length) throw badRequest('No updatable fields in body');

  if ('label' in set || 'ingest_aliases' in set) {
    assertUnambiguous(
      { type_key: cur.type_key, label: set.label ?? cur.label, ingest_aliases: set.ingest_aliases ?? cur.ingest_aliases },
      await loadOthers(db, cur.type_key)
    );
  }

  const params = fields.map((f) => {
    const v = set[f];
    if (f === 'ingest_aliases') return JSON.stringify(v);
    if (f === 'case_types') return v ? JSON.stringify(v) : null;
    return v;
  });
  await db.query(
    `UPDATE calendar_item_types SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE type_key = ?`,
    [...params, cur.type_key]
  );
  calendarTypeService.invalidate();
  return getTypeAdmin(db, cur.type_key);
}

async function deleteType(db, key) {
  const cur = await getTypeAdmin(db, key);
  if (cur.refs.total > 0) {
    throw conflict(
      `Cannot delete '${cur.type_key}': ${cur.refs.total} row(s) reference it ` +
      `(events ${cur.refs.events}, appts ${cur.refs.appts}, booking views ${cur.refs.booking_views}, court matches ${cur.refs.ai_match_types}). ` +
      `Deactivate it instead.`
    );
  }
  await db.query(`DELETE FROM calendar_type_options WHERE type_key = ?`, [cur.type_key]);   // owned children
  await db.query(`DELETE FROM calendar_item_types WHERE type_key = ?`, [cur.type_key]);
  calendarTypeService.invalidate();
  return { type_key: cur.type_key, deleted: true, options_deleted: cur.options.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Options (U2b) — presentation rows under a meeting type
// ─────────────────────────────────────────────────────────────────────────────

async function getOption(db, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw badRequest('option id must be a positive integer');
  const [rows] = await db.query(`SELECT ${OPTION_COLS} FROM calendar_type_options WHERE id = ?`, [n]);
  const r = rows && rows[0];
  if (!r) throw notFound(`Calendar type option ${n} not found`);
  return shapeOption(r);
}

async function createOption(db, typeKey, body = {}) {
  const [trows] = await db.query(`SELECT type_key, kind FROM calendar_item_types WHERE type_key = ?`, [String(typeKey)]);
  const t = trows && trows[0];
  if (!t) throw notFound(`Calendar type '${typeKey}' not found`);
  if (String(t.kind) !== 'meeting') {
    throw badRequest(`'${t.type_key}' is kind=${t.kind} — picker options exist for meeting types only (other kinds go through the staff event form)`);
  }
  const next = {
    type_key:   String(t.type_key),
    label:      vOptionLabel(body.label),
    length:     vOptionLength(body.length),
    surfaces:   vSurfaces(body.surfaces),
    sort_order: vSortOrder(body.sort_order),
    active:     body.active === undefined ? 1 : vBool(body.active, 'active'),
  };
  let ins;
  try {
    [ins] = await db.query(
      `INSERT INTO calendar_type_options (type_key, label, length, surfaces, sort_order, active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [next.type_key, next.label, next.length, JSON.stringify(next.surfaces), next.sort_order, next.active]
    );
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      throw conflict(`'${next.type_key}' already has a ${next.length}-minute option — edit that one (its surfaces / label) instead`);
    }
    throw err;
  }
  calendarTypeService.invalidate();
  return getOption(db, ins.insertId);
}

const OPTION_UPDATABLE = ['label', 'length', 'surfaces', 'sort_order', 'active'];

async function updateOption(db, id, patch = {}) {
  if (Object.prototype.hasOwnProperty.call(patch, 'type_key')) {
    const cur0 = await getOption(db, id);
    if (_norm(patch.type_key) !== _norm(cur0.type_key)) {
      throw conflict('an option cannot move between types — delete it and create it under the other type');
    }
  }
  const cur = await getOption(db, id);
  const set = {};
  for (const f of OPTION_UPDATABLE) {
    if (!Object.prototype.hasOwnProperty.call(patch, f)) continue;
    const v = patch[f];
    switch (f) {
      case 'label':      set.label = vOptionLabel(v); break;
      case 'length':     set.length = vOptionLength(v); break;
      case 'surfaces':   set.surfaces = vSurfaces(v); break;
      case 'sort_order': set.sort_order = vSortOrder(v); break;
      case 'active':     set.active = vBool(v, 'active'); break;
      default: break;
    }
  }
  const fields = Object.keys(set);
  if (!fields.length) throw badRequest('No updatable fields in body');
  const params = fields.map((f) => (f === 'surfaces' ? JSON.stringify(set[f]) : set[f]));
  try {
    await db.query(
      `UPDATE calendar_type_options SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
      [...params, cur.id]
    );
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      throw conflict(`'${cur.type_key}' already has a ${set.length}-minute option`);
    }
    throw err;
  }
  calendarTypeService.invalidate();
  return getOption(db, cur.id);
}

async function deleteOption(db, id) {
  const cur = await getOption(db, id);
  await db.query(`DELETE FROM calendar_type_options WHERE id = ?`, [cur.id]);
  calendarTypeService.invalidate();
  return { id: cur.id, type_key: cur.type_key, deleted: true };
}

module.exports = {
  listTypesAdmin,
  getTypeAdmin,
  listUnmapped,
  listCaseTypes,
  createType,
  updateType,
  deleteType,
  getRefs,
  getOption,
  createOption,
  updateOption,
  deleteOption,
  // internals (repo `_`-prefix convention)
  _assertUnambiguous: assertUnambiguous,
  _vSurfaces: vSurfaces,
  _KEY_RE: KEY_RE,
  _SELECT_COLS: SELECT_COLS,
  _REF_SOURCES: REF_SOURCES,
};
