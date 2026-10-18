// routes/api.appSettings.js
//
/**
 * App Settings API — registry-aware (settings / config-split arc, 2026-10)
 * ------------------------------------------------------------------------
 * lib/settingsRegistry.js is the spine: one entry per app_settings key the
 * code reads — its kind, its ONE editor home, section, type, label,
 * description and edit posture. app_settings keeps the VALUE; its metadata
 * columns (category, label, description, type, sort_order, is_editable)
 * describe UNREGISTERED rows only: the "automation variables" a person
 * created (POST below). Consumers: the YisraCase Config tabs (Firm, Lists,
 * System), Portal Manager → Settings and CTA Links.
 *
 * GET  /api/app-settings[?home=firm,portal]   jwtOrApiKey (any staff; machine keys)
 *   → { status, caps: { firm, system }, sections: { <home>: [{ id, title, icon }] },
 *       settings: [ROW] }
 *   caps.firm / caps.system = can(req.auth, 'firm.settings' / 'system.settings').
 *   Served:
 *     - every REGISTERED key whose kind is not secret / access / retired
 *       (registry NEVER_SERVED) and whose home's READ capability is null or
 *       held by the caller — with or without a row. No row: value and
 *       updated_at null, exists:false (the code's default applies; a PUT
 *       creates the row);
 *     - every UNREGISTERED row with is_editable = 1 AND is_secret = 0, as
 *       kind 'variable', home 'firm', section 'variables', with its DB type
 *       (anything a migration wrote), label (blank → the key), description,
 *       category and sort_order.
 *   NEVER served: a secret by either source (registry kind secret, or the
 *   row's is_secret = 1 — the SELECT nulls such a value inside MySQL, so it
 *   never reaches this process), access and retired keys, unregistered
 *   is_editable = 0 rows.
 *   ROW = { key, value, updated_at, exists, registered, kind, home, section,
 *           type, options, label, description, sort_order, edit, editor, env,
 *           required, can_edit, category }
 *   required = the registry refuses a blank value for this key (unregistered:
 *   false).
 *   can_edit = posture 'ui' (kind not state) AND the caller holds the home's
 *   WRITE capability. category = the section's title (registered) or the DB
 *   category (unregistered). Order: home (HOME_CAPS order), section, sort_order
 *   (unset last), key. sections = SECTIONS of every home present in settings.
 *   ?home = comma-separated homes (repeatable; empty = all); an unknown home → 400.
 *
 * PUT  /api/app-settings/:key   body { value: string }
 *   → { status:'success', setting: { key, value, updated_at } }  (yc-sync contract)
 *   REGISTERED key:
 *     - kind secret / access / retired / state, or posture 'console' → 403
 *       "<label> is changed from the SU db console only";
 *     - caller without the home's WRITE capability → 403 "Changing <label>
 *       needs the <cap> permission";
 *     - value not a string, or over 60000 characters → 400;
 *     - reg.validate(key, value) fails → 400 with the reason;
 *     - its row flagged is_secret = 1 → 403 (console only, as above);
 *     - no row → INSERT (is_secret 0, is_editable 1, metadata NULL); else UPDATE.
 *   UNREGISTERED key: firm.settings FIRST (403 — a non-holder learns nothing
 *   about which rows exist), the value's shape (400), then no row (or a row
 *   stored under another spelling — the collation, GATES) → 404, not
 *   is_editable = 1 or a secret → 403, then the row's DB type validates
 *   (reg.validateByType; an unknown type is verbatim).
 *   Unchanged (equal to the stored string, byte for byte) → 200 with the row:
 *   nothing written, no version row.
 *
 * POST /api/app-settings   body { key, value?, category?, label?, description?, type?, sort_order? }
 *   Creates an automation variable: firm.settings, staff JWT only — a machine
 *   key is refused (403): automation never mints keys, the same rule as
 *   set_setting's key-must-exist gate (a typo'd params_mapping must not
 *   create a row). KEY_RE / SETTING_TYPES below; value stored verbatim.
 *   A REGISTERED key → 409 "change it in <its home>", whether or not its row
 *   exists — and so does a key that differs from one only in case (MySQL
 *   would read it as that setting); an existing row → 409. is_secret 0 / is_editable 1 are
 *   HARDCODED: secrets are created only from the SU db console.
 *   → 201 { status, setting: the full row }
 *
 * GET  /api/app-settings/:key/history?limit=50   limit 1–200, else 400
 *   → { status, key, versions: [{ id, old_value, new_value, changed_by,
 *       changed_by_name, changed_via, changed_at }] } newest first.
 *   Needs the key's WRITE capability (unregistered: firm.settings) → 403.
 *   Never-served kinds, a row flagged is_secret, a row stored under another
 *   spelling, and an unregistered key with no row or is_editable = 0 → 404.
 *
 * POST /api/app-settings/:key/restore   body { version_id }
 *   Sets the value back to that version's old_value — "the value before this
 *   change" (NULL → ''). The version must be :key's (404). Every PUT check
 *   applies, to the RESTORED value; appends a 'restore' version row.
 *   Response exactly like PUT. A write on the `setting` bus entity: its own
 *   matcher in public/js/yc-sync.js.
 *
 * GATES
 *   - Mount (PUT, POST, history, restore): requireAuth({ audience:'staff',
 *     allowApiKey:true }) — any staff JWT passes it; the HANDLER decides per
 *     key with lib/capabilities can() against the registry's WRITE capability
 *     (reg.capsOf(entry).write; unregistered → firm.settings), so the refusal
 *     can name the setting. A capability refusal there writes the
 *     jwt_api_audit_log row a gate refusal writes (jwt 'unauthorized'), beside
 *     the mount's 'authorized' one.
 *   - Machine keys (an x-api-key header) on a per-key route go through
 *     requireAuth({ audience:'staff', can:<the key's write capability>,
 *     allowApiKey:true }) instead: a NULL-scope key passes (machine trust,
 *     ACCESS_CONTROL_DESIGN §8 Q3) and a SCOPED key passes only when its
 *     scopes name that capability — with no route scope, as on every
 *     requireAuth({ can }) route (access-control B2). The handler checks again.
 *   - GET stays on jwtOrApiKey: any signed-in staff user reads; WHAT a caller
 *     sees follows the READ rule above.
 *   - A secret is never returned, written or versioned here. Keys are never
 *     renamed or deleted here.
 *   - THE COLLATION: app_settings.key is utf8mb4_general_ci PAD SPACE, so
 *     `key` = 'Cloud_Tasks_Enabled ' reads the cloud_tasks_enabled row — while
 *     the registry lookup is exact, and an unknown spelling is gated as an
 *     automation variable (firm.settings). So PUT, restore and history refuse
 *     (404) a row whose key is not the asked key byte for byte, and POST
 *     refuses (409) a key that folds onto a registered one
 *     (reg.registeredSpelling).
 *
 * HISTORY (app_settings_versions — this is the settings audit):
 *   every write through this route — PUT, POST, restore — appends ONE row in
 *   the SAME transaction as the write (req.db.withTransaction, retries:1:
 *   pure DB): setting_key, old_value (NULL = no row before), new_value,
 *   changed_by (users.user of a staff JWT; NULL for a machine key) and
 *   changed_via — 'ui' (staff PUT), 'api_key' (machine PUT), 'create' (POST),
 *   'restore'. An unchanged value appends nothing. Writes made elsewhere
 *   (automation's set_setting / update_db, runtime state, key rotation, the
 *   SU db console) are not versioned.
 *
 * TYPE VALIDATION: lib/settingsRegistry.js TYPE_VALIDATORS / validateByType.
 *   PERMISSIVE and NEVER MUTATES: checks run on a trimmed COPY; the stored
 *   value is the exact string received. A blank value always passes the type
 *   check — blank means "unset" — except for a registry entry marked
 *   required: true, which reg.validate refuses blank. string / template (and
 *   an unknown DB type) are verbatim.
 *
 * WHITESPACE INVARIANT:
 *   Values are stored VERBATIM. Never trim, collapse, or normalize whitespace.
 *   Some settings carry load-bearing leading/trailing spaces (e.g. Dropbox
 *   folder-name padding used for manual sort ordering).
 *
 * CACHE COHERENCE:
 *   Every write that changed a value calls firmConfig.invalidate() after its
 *   commit, so lib/firmConfig.js consumers on THIS instance see the new value
 *   on their next read. Other Cloud Run instances converge within firmConfig's
 *   TTL (60s).
 */

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const requireAuth = require('../lib/auth.requireAuth');
const firmConfig  = require('../lib/firmConfig');
const reg         = require('../lib/settingsRegistry');
const { can }     = require('../lib/capabilities');
const { logJwtApiAttempt } = jwtOrApiKey;

const { validateByType } = reg;

// app_settings.value is TEXT (64KB). Leave headroom for multi-byte chars.
const MAX_VALUE_LEN = 60000;

// Unregistered rows (automation variables) are Firm-tab rows.
const VARIABLE_CAP = 'firm.settings';

// Kinds a person never changes through this route, whatever the posture says.
const CONSOLE_KINDS = Object.freeze(['secret', 'access', 'retired', 'state']);

// Where each home is edited — POST's 409 names it.
const HOME_TITLES = Object.freeze({
  firm:    'YisraCase Config → Firm',
  portal:  'Portal Manager → Settings',
  config:  'YisraCase Config (Lists / Types & Subtypes)',
  system:  'YisraCase Config → System',
  comms:   'YisraCase Config → System',
  cta:     'CTA Links',
  console: 'the SU db console',
});

const HOMES = Object.keys(reg.HOME_CAPS);

// ─────────────────────────────────────────
// Gates (see GATES above)
// ─────────────────────────────────────────
const staffGate = requireAuth({ audience: 'staff', allowApiKey: true });
const keyGates = {};
for (const cap of [VARIABLE_CAP, ...Object.values(reg.HOME_CAPS).map((h) => h.write)]) {
  if (cap && !keyGates[cap]) keyGates[cap] = requireAuth({ audience: 'staff', can: cap, allowApiKey: true });
}

/** The capability that writes `key`: its home's (null: none), firm.settings when unregistered. */
function writeCapOf(key) {
  const e = reg.get(key);
  if (!e) return VARIABLE_CAP;
  if (reg.NEVER_SERVED.includes(e.kind)) return null;
  return reg.capsOf(e).write || null;
}

function perKeyGate(req, res, next) {
  const cap = req.headers['x-api-key'] ? writeCapOf(req.params.key) : null;
  return (cap ? keyGates[cap] : staffGate)(req, res, next);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.httpStatus = status; }
}

/** A capability refusal in the handler: 403, plus the audit row a gate refusal writes. */
function deny(req, message) {
  const a = req.auth || {};
  if (a.type === 'api_key') logJwtApiAttempt(req, 'api_key', a.key_label, 'forbidden_scope');
  else logJwtApiAttempt(req, 'jwt', a.username || a.userId, 'unauthorized');
  return new HttpError(403, message);
}

/** users.user of a staff JWT (signed tinyint), else NULL. */
function changedBy(auth) {
  if (!auth || auth.type !== 'jwt') return null;
  const n = Number(auth.userId);
  return auth.userId != null && auth.userId !== '' && Number.isInteger(n) && n >= -128 && n <= 127 ? n : null;
}

function send(res, label, err) {
  if (err && err.httpStatus) return res.status(err.httpStatus).json({ status: 'error', message: err.message });
  console.error(`${label} error:`, err);
  return res.status(500).json({ status: 'error', message: 'Settings request failed' });
}

/** → an HttpError (400), or null when the value is a storable string. */
function valueShapeError(value) {
  // Structured values (case_types map, event_types array) must be
  // JSON.stringify'd client-side. Refusing non-strings here prevents
  // accidental "[object Object]" writes.
  if (typeof value !== 'string') {
    return new HttpError(400, 'value must be a string (JSON-stringify structured values client-side)');
  }
  if (value.length > MAX_VALUE_LEN) {
    return new HttpError(400, `value exceeds maximum length of ${MAX_VALUE_LEN} characters`);
  }
  return null;
}

/**
 * The per-key decision that needs no row (PUT, restore, history).
 * → { entry, label } or throws HttpError (403 / 404).
 *   forHistory: a read — a never-served key is a 404 (not a setting this API
 *   knows) and the edit posture does not matter.
 */
function authorize(req, key, { forHistory = false } = {}) {
  const entry = reg.get(key);
  const what = (label) => (forHistory ? `The history of ${label}` : `Changing ${label}`);
  if (!entry) {
    if (!can(req.auth, VARIABLE_CAP)) throw deny(req, `${what(key)} needs the ${VARIABLE_CAP} permission`);
    return { entry: null, label: key };
  }
  const label = entry.label || key;
  const cap = reg.NEVER_SERVED.includes(entry.kind) ? null : reg.capsOf(entry).write;
  if (forHistory) {
    if (!cap) throw new HttpError(404, 'Setting not found');
  } else if (!cap || CONSOLE_KINDS.includes(entry.kind) || reg.editOf(entry) !== 'ui') {
    throw new HttpError(403, `${label} is changed from the SU db console only`);
  }
  if (!can(req.auth, cap)) throw deny(req, `${what(label)} needs the ${cap} permission`);
  return { entry, label };
}

const SQL_ROW_FOR_UPDATE =
  'SELECT `key`, IF(is_secret = 0, `value`, NULL) AS `value`, is_secret, is_editable, `type`, updated_at ' +
  'FROM app_settings WHERE `key` = ? FOR UPDATE';
const SQL_ROW_OUT = 'SELECT `key`, `value`, updated_at FROM app_settings WHERE `key` = ?';
const SQL_VERSION_INSERT =
  'INSERT INTO app_settings_versions (setting_key, old_value, new_value, changed_by, changed_via) VALUES (?, ?, ?, ?, ?)';

/**
 * The write path PUT and restore share: ONE transaction holding the row
 * checks, the validation, the write and its version row.
 *   valueFor(conn) → the value to store (restore reads its version there)
 * → { changed, setting: { key, value, updated_at } }
 */
async function writeValue(req, key, gate, valueFor, via) {
  const span = () => req.db.withTransaction(async (conn) => {
    const [[cur]] = await conn.query(SQL_ROW_FOR_UPDATE, [key]);
    // app_settings.key ignores case and trailing spaces; authorize() judged
    // the asked spelling. A row under another spelling is another setting.
    if (cur && cur.key !== key) throw new HttpError(404, 'Setting not found');
    if (gate.entry) {
      if (cur && reg.isSecret(key, cur.is_secret)) throw new HttpError(403, `${gate.label} is changed from the SU db console only`);
    } else {
      if (!cur) throw new HttpError(404, 'Setting not found');
      if (Number(cur.is_editable) !== 1 || Number(cur.is_secret) === 1) {
        throw new HttpError(403, 'This setting is not editable');
      }
    }

    const value = await valueFor(conn);
    const bad = valueShapeError(value);
    if (bad) throw bad;
    const check = gate.entry ? reg.validate(key, value) : validateByType(cur.type, value);
    if (check !== true) throw new HttpError(400, check);

    // Unchanged: byte-for-byte the stored string → nothing written, no version.
    if (cur && cur.value === value) {
      return { changed: false, setting: { key: cur.key, value: cur.value, updated_at: cur.updated_at } };
    }

    // Stored VERBATIM — see the whitespace invariant in the header comment.
    if (cur) {
      await conn.query('UPDATE app_settings SET `value` = ? WHERE `key` = ?', [value, key]);
    } else {
      await conn.query('INSERT INTO app_settings (`key`, `value`, is_secret, is_editable) VALUES (?, ?, 0, 1)', [key, value]);
    }
    await conn.query(SQL_VERSION_INSERT, [key, cur ? cur.value : null, value, changedBy(req.auth), via]);
    const [[row]] = await conn.query(SQL_ROW_OUT, [key]);
    return { changed: true, setting: { key: row.key, value: row.value, updated_at: row.updated_at } };
  }, { retries: 1 });

  let out;
  try {
    out = await span();
  } catch (err) {
    // Two first writes of one missing registered row race: the loser's INSERT
    // collides (or deadlocks on the gap lock). Once more — it then UPDATEs,
    // with the winner's value as its old_value.
    if (!err || (err.code !== 'ER_DUP_ENTRY' && err.code !== 'ER_LOCK_DEADLOCK')) throw err;
    out = await span();
  }
  // Same-instance firmConfig consumers pick up the change immediately;
  // other instances converge within the firmConfig TTL.
  if (out.changed) firmConfig.invalidate();
  return out;
}

// ─────────────────────────────────────────
// GET /api/app-settings
// ─────────────────────────────────────────
function homesFilter(q) {
  if (q === undefined) return null;
  const parts = [].concat(q).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
  if (parts.some((h) => !HOMES.includes(h))) throw new HttpError(400, `home must be one of: ${HOMES.join(', ')}`);
  return parts.length ? parts : null;   // ?home= (empty) filters nothing
}

function readable(auth, entry) {
  if (reg.NEVER_SERVED.includes(entry.kind)) return false;
  const r = reg.capsOf(entry).read;
  return r === null || (typeof r === 'string' && can(auth, r));
}

function canEdit(auth, entry) {
  const cap = reg.capsOf(entry).write;
  return reg.editOf(entry) === 'ui' && !CONSOLE_KINDS.includes(entry.kind) && !!cap && can(auth, cap);
}

const sectionsOf = (home) => reg.SECTIONS[home] || [];

router.get('/api/app-settings', jwtOrApiKey, async (req, res) => {
  try {
    const homes = homesFilter(req.query.home);
    const wanted = (h) => !homes || homes.includes(h);
    const auth = req.auth;

    const served = Object.keys(reg.SETTINGS).filter((k) => wanted(reg.SETTINGS[k].home) && readable(auth, reg.SETTINGS[k]));
    const variables = wanted('firm');

    // Registered keys by name; unregistered rows by the editable / non-secret
    // flags. A row flagged secret comes back with its value NULLed by MySQL.
    const where = [];
    const params = [];
    if (served.length) { where.push('`key` IN (?)'); params.push(served); }
    if (variables) { where.push('(is_editable = 1 AND is_secret = 0 AND `key` NOT IN (?))'); params.push(Object.keys(reg.SETTINGS)); }
    let rows = [];
    if (where.length) {
      [rows] = await req.db.query(
        'SELECT `key`, IF(is_secret = 0, `value`, NULL) AS `value`, is_secret, is_editable, category, label, ' +
        'description, `type`, sort_order, updated_at FROM app_settings WHERE ' + where.join(' OR '),
        params);
    }
    const byKey = new Map(rows.map((r) => [r.key, r]));

    const caps = { firm: can(auth, 'firm.settings'), system: can(auth, 'system.settings') };
    const out = [];
    for (const key of served) {
      const e = reg.SETTINGS[key];
      const row = byKey.get(key) || null;
      if (row && reg.isSecret(key, row.is_secret)) continue;   // a row flagged secret is a secret: never served
      const sec = sectionsOf(e.home).find((s) => s.id === e.section);
      out.push({
        key, value: row ? row.value : null, updated_at: row ? row.updated_at : null, exists: !!row,
        registered: true, kind: e.kind, home: e.home, section: e.section, type: e.type,
        options: e.options ? e.options.slice() : null, label: e.label || key, description: e.desc || null,
        sort_order: e.sort == null ? null : e.sort, edit: reg.editOf(e), editor: e.editor || null, env: e.env || null,
        required: e.required === true, can_edit: canEdit(auth, e), category: sec ? sec.title : null,
      });
    }
    if (variables) {
      for (const row of rows) {
        if (reg.isRegistered(row.key) || Number(row.is_editable) !== 1 || Number(row.is_secret) === 1) continue;
        out.push({
          key: row.key, value: row.value, updated_at: row.updated_at, exists: true,
          registered: false, kind: 'variable', home: 'firm', section: 'variables', type: row.type,
          options: null, label: row.label || row.key, description: row.description == null ? null : row.description,
          sort_order: row.sort_order == null ? null : Number(row.sort_order), edit: 'ui', editor: null, env: null,
          required: false, can_edit: caps.firm, category: row.category == null ? null : row.category,
        });
      }
    }

    const rank = (s) => [HOMES.indexOf(s.home), sectionsOf(s.home).findIndex((x) => x.id === s.section),
      s.sort_order == null ? Infinity : s.sort_order];
    out.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] < rb[i] ? -1 : 1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

    const sections = {};
    for (const s of out) if (!sections[s.home]) sections[s.home] = sectionsOf(s.home).map((x) => ({ ...x }));

    res.json({ status: 'success', caps, sections, settings: out });
  } catch (err) { send(res, 'GET /api/app-settings', err); }
});

// ─────────────────────────────────────────
// PUT /api/app-settings/:key
// Body: { value: string } — validated, stored verbatim, versioned
// ─────────────────────────────────────────
router.put('/api/app-settings/:key', perKeyGate, async (req, res) => {
  const key = req.params.key;
  try {
    const gate = authorize(req, key);
    const { value } = req.body || {};
    const bad = valueShapeError(value);
    if (bad) throw bad;
    const via = req.auth && req.auth.type === 'jwt' ? 'ui' : 'api_key';
    const out = await writeValue(req, key, gate, async () => value, via);
    res.json({ status: 'success', setting: out.setting });
  } catch (err) { send(res, `PUT /api/app-settings/${key}`, err); }
});

// ─────────────────────────────────────────
// GET /api/app-settings/:key/history?limit=50
// ─────────────────────────────────────────
const HISTORY_DEFAULT = 50;
const HISTORY_MAX = 200;

router.get('/api/app-settings/:key/history', perKeyGate, async (req, res) => {
  const key = req.params.key;
  try {
    const gate = authorize(req, key, { forHistory: true });
    let limit = HISTORY_DEFAULT;
    if (req.query.limit !== undefined) {
      const s = String(req.query.limit);
      if (!/^[0-9]{1,3}$/.test(s) || Number(s) < 1 || Number(s) > HISTORY_MAX) {
        throw new HttpError(400, `limit must be an integer from 1 to ${HISTORY_MAX}`);
      }
      limit = Number(s);
    }
    const [[row]] = await req.db.query('SELECT `key`, is_secret, is_editable FROM app_settings WHERE `key` = ?', [key]);
    if (row && row.key !== key) throw new HttpError(404, 'Setting not found');   // the collation — see writeValue
    if (row && reg.isSecret(key, row.is_secret)) throw new HttpError(404, 'Setting not found');
    if (!gate.entry && (!row || Number(row.is_editable) !== 1)) throw new HttpError(404, 'Setting not found');

    const [versions] = await req.db.query(
      'SELECT v.id, v.old_value, v.new_value, v.changed_by, u.user_name AS changed_by_name, v.changed_via, v.changed_at ' +
      'FROM app_settings_versions v LEFT JOIN users u ON u.user = v.changed_by ' +
      `WHERE v.setting_key = ? ORDER BY v.id DESC LIMIT ${limit}`,
      [key]);
    res.json({
      status: 'success', key,
      versions: versions.map((v) => ({
        id: v.id, old_value: v.old_value, new_value: v.new_value, changed_by: v.changed_by,
        changed_by_name: v.changed_by_name == null ? null : v.changed_by_name,
        changed_via: v.changed_via, changed_at: v.changed_at,
      })),
    });
  } catch (err) { send(res, `GET /api/app-settings/${key}/history`, err); }
});

// ─────────────────────────────────────────
// POST /api/app-settings/:key/restore
// Body: { version_id } — the value BEFORE that change comes back
// ─────────────────────────────────────────
router.post('/api/app-settings/:key/restore', perKeyGate, async (req, res) => {
  const key = req.params.key;
  try {
    const gate = authorize(req, key);
    const raw = req.body && typeof req.body === 'object' ? req.body.version_id : undefined;
    const s = typeof raw === 'number' || typeof raw === 'string' ? String(raw) : '';
    if (!/^[1-9][0-9]{0,9}$/.test(s) || Number(s) > 4294967295) throw new HttpError(400, 'version_id must be a positive integer');
    const out = await writeValue(req, key, gate, async (conn) => {
      const [[v]] = await conn.query('SELECT id, old_value FROM app_settings_versions WHERE id = ? AND setting_key = ?', [Number(s), key]);
      if (!v) throw new HttpError(404, 'Version not found');
      return v.old_value == null ? '' : v.old_value;
    }, 'restore');
    res.json({ status: 'success', setting: out.setting });
  } catch (err) { send(res, `POST /api/app-settings/${key}/restore`, err); }
});

// ─────────────────────────────────────────
// POST /api/app-settings
// Body: { key, value?, category?, label?, description?, type?, sort_order? }
// Creates an automation variable. firm.settings staff JWTs only.
// ─────────────────────────────────────────

// The `type` vocabulary an automation variable may be created with. 'string'
// and 'template' are verbatim (no validation); the rest map to the registry's
// TYPE_VALIDATORS. An explicit allow-list so a typo'd type on creation can't
// silently produce an unvalidated row.
const SETTING_TYPES = ['string', 'template', 'number', 'bool', 'email',
                       'csv', 'phone', 'url', 'json', 'json_array', 'date'];

// app_settings.key is varchar(100). No whitespace (keys travel through csv
// lists in get_settings and {{placeholders}}), no leading _/- for tidiness.
const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_\-]{0,99}$/;

router.post('/api/app-settings', staffGate, async (req, res) => {
  try {
    // Machine keys pass the mount; this is what refuses them. Automation must
    // never mint settings keys — the set_setting / get_setting key-must-exist
    // rule, which exists so a typo'd params_mapping can't silently create a row.
    const auth = req.auth || {};
    if (auth.type !== 'jwt') throw new HttpError(403, 'Settings can only be created by a signed-in user');
    if (!can(auth, VARIABLE_CAP)) throw deny(req, `Creating a setting needs the ${VARIABLE_CAP} permission`);

    const b = req.body || {};
    const key = b.key;
    if (typeof key !== 'string' || !KEY_RE.test(key)) {
      throw new HttpError(400, 'key must be 1-100 chars of letters, digits, _ or -, starting with a letter or digit');
    }
    const entry = reg.get(key);
    if (entry) throw new HttpError(409, `"${key}" is a registered setting — change it in ${HOME_TITLES[entry.home] || entry.home}`);
    // MySQL would read this row AS the registered setting (the key ignores case).
    const spelling = reg.registeredSpelling(key);
    if (spelling) {
      const home = reg.get(spelling).home;
      throw new HttpError(409, `"${key}" is the registered setting "${spelling}" (setting keys ignore case) — change it in ${HOME_TITLES[home] || home}`);
    }

    // value: optional, defaults to '' (blank = unset, same as everywhere else).
    const value = (b.value === undefined || b.value === null) ? '' : b.value;
    const bad = valueShapeError(value);
    if (bad) throw bad;

    const type = (b.type == null || b.type === '') ? 'string' : b.type;
    if (!SETTING_TYPES.includes(type)) throw new HttpError(400, `type must be one of: ${SETTING_TYPES.join(', ')}`);
    const check = validateByType(type, value);
    if (check !== true) throw new HttpError(400, check);

    // Optional display metadata — reject over-length rather than silently
    // truncating (column limits: category 50, label 100, description 500).
    const optStr = (name, v, max) => {
      if (v == null || v === '') return { val: null };
      if (typeof v !== 'string') return { err: `${name} must be a string` };
      if (v.length > max) return { err: `${name} exceeds ${max} characters` };
      return { val: v };
    };
    const category    = optStr('category',    b.category,    50);
    const label       = optStr('label',       b.label,       100);
    const description = optStr('description', b.description, 500);
    for (const f of [category, label, description]) if (f.err) throw new HttpError(400, f.err);

    let sortOrder = null;
    if (b.sort_order != null && b.sort_order !== '') {
      const n = Number(b.sort_order);
      if (!Number.isInteger(n)) throw new HttpError(400, 'sort_order must be an integer');
      sortOrder = n;
    }

    let row;
    try {
      row = await req.db.withTransaction(async (conn) => {
        // is_secret=0 and is_editable=1 are HARDCODED — this route can never
        // mint a secret, and a UI-created setting must remain UI-editable.
        await conn.query(
          'INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order) ' +
          'VALUES (?, ?, 0, 1, ?, ?, ?, ?, ?)',
          [key, value, category.val, label.val, description.val, type, sortOrder]);
        await conn.query(SQL_VERSION_INSERT, [key, null, value, changedBy(auth), 'create']);
        const [[r]] = await conn.query(
          'SELECT `key`, `value`, category, label, description, `type`, sort_order, updated_at FROM app_settings WHERE `key` = ?',
          [key]);
        return r;
      }, { retries: 1 });
    } catch (err) {
      // Covers secret + non-editable rows too, without existence-leaking
      // anything beyond "taken" — which the DB console owner already knows.
      if (err && err.code === 'ER_DUP_ENTRY') throw new HttpError(409, `Setting "${key}" already exists`);
      throw err;
    }

    // Same coherence rule as every write here (see CACHE COHERENCE).
    firmConfig.invalidate();
    res.status(201).json({ status: 'success', setting: row });
  } catch (err) { send(res, 'POST /api/app-settings', err); }
});

module.exports = router;

module.exports.validateByType = validateByType; // the registry's own — exported for existing tests
