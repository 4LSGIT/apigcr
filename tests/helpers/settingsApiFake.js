// tests/helpers/settingsApiFake.js
//
/**
 * An in-memory apiSend for the settings API contract of the settings /
 * config-split arc (2026-10): GET /api/app-settings, PUT /api/app-settings/:key,
 * POST /api/app-settings, GET /api/app-settings/:key/history,
 * POST /api/app-settings/:key/restore — the shapes, statuses and messages the
 * arc's contract names — plus the two lookup lists the settings rows read
 * (GET /api/credentials, GET /sequences/templates).
 *
 * Metadata, edit posture, capabilities and validation come from the REAL
 * lib/settingsRegistry.js (registered keys) and its validateByType
 * (unregistered rows), so a page under test is driven by the registry it
 * ships with. Used by tests/ycSettingRows.test.js and tests/firmTab.test.js.
 *
 *   const s = makeSettingsApi({ values, variables, caps, credentials, sequences });
 *   s.api(path, method, body)  → Promise (rejects with an ApiError-shaped Error)
 *   s.st                       → { rows: Map, versions, calls, caps }
 *   s.value(key)               → the stored string (undefined: no row)
 *
 *   values     { key: value } — REGISTERED keys that have a row
 *   variables  [{ key, value, type, label?, description?, category?,
 *                sort_order?, is_secret?, is_editable? }] — UNREGISTERED rows
 *   caps       { firm, system, lists? } — the caller's firm.settings /
 *              system.settings / firm.lists (a key's alsoWrite — the staff
 *              role holds it; default off, so a caller is modelled as before)
 *              (change st.caps mid-test to model a role revoked since load)
 *   required   [key] — rows served with required:true (the arc adds the field;
 *              a registry entry's own `required: true` counts too)
 */
'use strict';

const reg = require('../../lib/settingsRegistry');

const MAX_VALUE_LEN = 60000;
const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
// routes/api.appSettings.js SETTING_TYPES (tests/firmTab.test.js pins the
// Firm tab's copy to the route's).
const SETTING_TYPES = ['string', 'template', 'number', 'bool', 'email', 'csv', 'phone', 'url', 'json', 'json_array', 'date'];
const HOME_ORDER = Object.keys(reg.HOME_CAPS);
const HOME_TITLES = { firm: 'Config → Firm', portal: 'Portal Manager → Settings', config: 'Config → Lists',
  system: 'Config → System', comms: 'Config → System', cta: 'CTA Links', console: 'the SU db console' };

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

function apiError(status, message) {
  const e = new Error(message);
  e.name = 'ApiError';
  e.status = status;
  e.body = { status: 'error', message };
  return e;
}

function makeSettingsApi({ values = {}, variables = [], caps = { firm: true, system: true }, credentials, sequences, user = { id: 1, name: 'Alex' }, required = [] } = {}) {
  let clock = 0;
  const ts = () => new Date(Date.UTC(2026, 9, 17, 10, 0, clock++)).toISOString();
  const st = { rows: new Map(), versions: [], nextVer: 1, calls: [], caps: { ...caps } };
  for (const [key, value] of Object.entries(values)) {
    if (!reg.isRegistered(key)) throw new Error(`settingsApiFake: values holds unregistered key ${key} (use variables)`);
    st.rows.set(key, { value, updated_at: ts(), is_secret: reg.isSecret(key, 0) ? 1 : 0, is_editable: 1,
      category: null, label: null, description: null, type: null, sort_order: null });
  }
  for (const v of variables) {
    if (reg.isRegistered(v.key)) throw new Error(`settingsApiFake: variable ${v.key} is a registered key`);
    st.rows.set(v.key, { value: v.value, updated_at: ts(), is_secret: v.is_secret ? 1 : 0, is_editable: v.is_editable === 0 ? 0 : 1,
      category: v.category ?? null, label: v.label ?? null, description: v.description ?? null, type: v.type ?? 'string', sort_order: v.sort_order ?? null });
  }
  const CREDS = credentials || [
    { id: 3, name: 'Dropbox', type: 'oauth2' }, { id: 7, name: 'Zoho Sign', type: 'oauth2' }, { id: 12, name: 'Google', type: 'oauth2' }];
  const SEQS = sequences || [
    { id: 4, name: 'E-sign reminders', type: 'esign', active: 1 }, { id: 5, name: 'Old reminders', type: 'esign', active: 0 },
    { id: 6, name: 'Intake follow-up', type: 'lead', active: 1 }];

  const has = (cap) => (cap === 'firm.settings' ? !!st.caps.firm : cap === 'system.settings' ? !!st.caps.system
    : cap === 'firm.lists' ? !!st.caps.lists : false);
  // The route's mayWrite (a staff JWT): the home's write capability, or the key's alsoWrite.
  const mayWrite = (e) => reg.writeCapsOf(e).some(has);
  const readOk = (c) => c.read === null || (typeof c.read === 'string' && has(c.read));
  const sectionTitle = (home, section) => ((reg.SECTIONS[home] || []).find((s) => s.id === section) || {}).title || null;

  /** A registered key → its ROW (with or without a stored row). */
  function registeredRow(key) {
    const e = reg.get(key), c = reg.capsOf(e), db = st.rows.get(key), edit = reg.editOf(e);
    return { key, value: db ? db.value : null, updated_at: db ? db.updated_at : null, exists: !!db, registered: true,
      kind: e.kind, home: e.home, section: e.section, type: e.type, options: e.options ? e.options.slice() : null,
      label: e.label, description: e.desc || null, sort_order: e.sort ?? null, edit, editor: e.editor || null,
      env: e.env || null, can_edit: edit === 'ui' && !!c.write && mayWrite(e),
      also_write: edit === 'ui' && !!c.write && !has(c.write) && e.alsoWrite && has(e.alsoWrite) ? e.alsoWrite : null,
      category: sectionTitle(e.home, e.section),
      required: e.required === true || required.includes(key) };
  }
  function variableRow(key) {
    const db = st.rows.get(key);
    return { key, value: db.value, updated_at: db.updated_at, exists: true, registered: false, kind: 'variable', home: 'firm',
      section: 'variables', type: db.type, options: null, label: db.label || key, description: db.description || null,
      sort_order: db.sort_order, edit: 'ui', editor: null, env: null, can_edit: has('firm.settings'), also_write: null,
      category: db.category, required: false };
  }
  function served() {
    const out = [];
    for (const key of Object.keys(reg.SETTINGS)) {
      const e = reg.get(key);
      if (reg.NEVER_SERVED.includes(e.kind) || !readOk(reg.capsOf(e))) continue;
      const db = st.rows.get(key);
      if (db && db.is_secret) continue;
      out.push(registeredRow(key));
    }
    for (const [key, db] of st.rows) {
      if (reg.isRegistered(key) || db.is_editable !== 1 || db.is_secret) continue;
      out.push(variableRow(key));
    }
    const secIdx = (r) => (reg.SECTIONS[r.home] || []).findIndex((s) => s.id === r.section);
    const so = (r) => (r.sort_order == null ? 1e9 : r.sort_order);
    return out.sort((a, b) => HOME_ORDER.indexOf(a.home) - HOME_ORDER.indexOf(b.home) || secIdx(a) - secIdx(b)
      || so(a) - so(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** PUT / restore's checks; throws the route's refusal. */
  function check(key, value) {
    if (typeof value !== 'string') throw apiError(400, 'value must be a string (JSON-stringify structured values client-side)');
    if (value.length > MAX_VALUE_LEN) throw apiError(400, `value exceeds maximum length of ${MAX_VALUE_LEN} characters`);
    const e = reg.get(key);
    if (e) {
      if (['secret', 'access', 'retired', 'state'].includes(e.kind) || reg.editOf(e) === 'console') {
        throw apiError(403, `${e.label} is changed from the SU db console only`);
      }
      const c = reg.capsOf(e);
      if (!c.write || !mayWrite(e)) throw apiError(403, `Changing ${e.label} needs the ${c.write} permission`);
      const v = reg.validate(key, value);
      if (v !== true) throw apiError(400, v);
      return;
    }
    const db = st.rows.get(key);
    if (!db) throw apiError(404, 'Setting not found');
    if (db.is_editable !== 1 || db.is_secret) throw apiError(403, 'This setting is not editable');
    if (!has('firm.settings')) throw apiError(403, `Changing ${db.label || key} needs the firm.settings permission`);
    const v = reg.validateByType(db.type, value);
    if (v !== true) throw apiError(400, v);
  }
  /** The write + its version row (one "transaction"); an unchanged value writes nothing. */
  function write(key, value, via) {
    const db = st.rows.get(key);
    if (db && db.value === value) return { key, value: db.value, updated_at: db.updated_at };
    const old = db ? db.value : null;
    const at = ts();
    if (db) { db.value = value; db.updated_at = at; } else {
      st.rows.set(key, { value, updated_at: at, is_secret: 0, is_editable: 1, category: null, label: null, description: null, type: null, sort_order: null });
    }
    st.versions.push({ id: st.nextVer++, setting_key: key, old_value: old, new_value: value,
      changed_by: user.id, changed_by_name: user.name, changed_via: via, changed_at: at });
    return { key, value, updated_at: at };
  }

  async function api(endpoint, method = 'GET', payload = null) {
    payload = payload == null ? null : clone(payload);
    st.calls.push({ endpoint, method, payload: clone(payload) });
    const [path, qs] = String(endpoint).split('?');
    const q = new URLSearchParams(qs || '');
    let m;
    if (method === 'GET' && path === '/api/app-settings') {
      const homes = q.get('home') ? q.get('home').split(',') : null;
      const settings = served().filter((r) => !homes || homes.includes(r.home));
      const sections = {};
      for (const r of settings) if (!sections[r.home]) sections[r.home] = clone(reg.SECTIONS[r.home]);
      return { status: 'success', caps: { firm: has('firm.settings'), system: has('system.settings') }, sections, settings: clone(settings) };
    }
    if (method === 'PUT' && (m = /^\/api\/app-settings\/([^/]+)$/.exec(path))) {
      const key = decodeURIComponent(m[1]);
      check(key, payload && payload.value);
      return { status: 'success', setting: write(key, payload.value, 'ui') };
    }
    if (method === 'POST' && path === '/api/app-settings') {
      if (!has('firm.settings')) throw apiError(403, 'Forbidden');
      const b = payload || {};
      if (typeof b.key !== 'string' || !KEY_RE.test(b.key)) {
        throw apiError(400, 'key must be 1-100 chars of letters, digits, _ or -, starting with a letter or digit');
      }
      const e = reg.get(b.key);
      if (e) throw apiError(409, `"${b.key}" is a registered setting — change it in ${HOME_TITLES[e.home] || e.home}`);
      if (st.rows.has(b.key)) throw apiError(409, `Setting "${b.key}" already exists`);
      const value = b.value == null ? '' : b.value;
      if (typeof value !== 'string') throw apiError(400, 'value must be a string (JSON-stringify structured values client-side)');
      const type = b.type == null || b.type === '' ? 'string' : b.type;
      if (!SETTING_TYPES.includes(type)) throw apiError(400, `type must be one of: ${SETTING_TYPES.join(', ')}`);
      const v = reg.validateByType(type, value);
      if (v !== true) throw apiError(400, v);
      const at = ts();
      const row = { value, updated_at: at, is_secret: 0, is_editable: 1, category: b.category || null, label: b.label || null,
        description: b.description || null, type, sort_order: b.sort_order ?? null };
      st.rows.set(b.key, row);
      st.versions.push({ id: st.nextVer++, setting_key: b.key, old_value: null, new_value: value,
        changed_by: user.id, changed_by_name: user.name, changed_via: 'create', changed_at: at });
      return { status: 'success', setting: { key: b.key, value, category: row.category, label: row.label,
        description: row.description, type, sort_order: row.sort_order, updated_at: at } };
    }
    if (method === 'GET' && (m = /^\/api\/app-settings\/([^/]+)\/history$/.exec(path))) {
      const key = decodeURIComponent(m[1]);
      const e = reg.get(key);
      if (e) {
        if (reg.NEVER_SERVED.includes(e.kind)) throw apiError(404, 'Setting not found');
        const c = reg.capsOf(e);
        if (!c.write || !mayWrite(e)) throw apiError(403, `Changing ${e.label} needs the ${c.write} permission`);
      } else {
        const db = st.rows.get(key);
        if (!db || db.is_secret) throw apiError(404, 'Setting not found');
        if (!has('firm.settings')) throw apiError(403, 'Forbidden');
      }
      const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 50));
      const versions = st.versions.filter((v) => v.setting_key === key).slice().reverse().slice(0, limit)
        .map(({ setting_key: _k, ...v }) => v);
      return { status: 'success', key, versions: clone(versions) };
    }
    if (method === 'POST' && (m = /^\/api\/app-settings\/([^/]+)\/restore$/.exec(path))) {
      const key = decodeURIComponent(m[1]);
      const ver = st.versions.find((v) => v.id === Number(payload && payload.version_id) && v.setting_key === key);
      if (!ver) throw apiError(404, 'Version not found');
      const value = ver.old_value == null ? '' : ver.old_value;
      check(key, value);
      return { status: 'success', setting: write(key, value, 'restore') };
    }
    if (method === 'GET' && path === '/api/credentials') return { status: 'success', credentials: clone(CREDS) };
    if (method === 'GET' && path === '/sequences/templates') return { success: true, templates: clone(SEQS) };
    throw new Error('settingsApiFake: unscripted ' + method + ' ' + endpoint);
  }

  return { api, st, value: (key) => (st.rows.has(key) ? st.rows.get(key).value : undefined), served };
}

module.exports = { makeSettingsApi, apiError, SETTING_TYPES };
