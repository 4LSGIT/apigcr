// tests/appSettingsRegistry.test.js
//
/**
 * The registry-aware App Settings API (settings / config-split arc,
 * routes/api.appSettings.js over lib/settingsRegistry.js).
 *
 * WHAT IS LOCKED
 *   - GET per caller (staff, admin, it, su, a NULL-scope machine key): which
 *     homes are served (system / comms only to system.settings holders; console
 *     never), caps, sections, per-row can_edit; secrets by EITHER source never
 *     served and never even read out of MySQL (the SELECT nulls a flagged
 *     row's value); access / retired keys never; unregistered variable rows
 *     (editable, non-secret) with their DB metadata; exists:false rows for
 *     registered keys with no row; the order; the ?home filter.
 *   - PUT every branch: console posture (state / secret / access / retired /
 *     edit 'console'), the per-key capability (403 naming the setting + the
 *     gate's audit row), validation by the registry type, a row flagged
 *     secret, INSERT when a registered row is missing, UPDATE, unchanged = no
 *     write and no version row, the version row in the SAME transaction
 *     (retries:1; a failed version insert rolls the write back), invalidate
 *     after a change only, verbatim whitespace, changed_by / changed_via, the
 *     first-write race; unregistered keys keep today's rules (firm.settings
 *     first, 404, not editable 403, DB-type validation).
 *   - POST: a registered key → 409 naming its home, row or no row; the version
 *     row ('create', old NULL) in the same transaction; dup → 409 and nothing
 *     versioned; machine keys and non-holders refused.
 *   - history: caps (403), 404 for never-served / secret / unregistered
 *     hidden or missing, limit bounds, newest first, changed_by_name joined.
 *   - restore: the version's old_value (NULL → ''), checks exactly as PUT on
 *     the restored value, a 'restore' version row, unchanged = nothing.
 *   - machine keys: a key SCOPED to a capability reaches the keys that
 *     capability writes with no route scope (access-control B2), and no others.
 *   - the collation: a key spelled differently (case, trailing spaces) reaches
 *     no other setting — PUT / restore / history 404, POST 409 naming the
 *     registered spelling; the exact spelling keeps working.
 *
 * HARNESS: the REAL router, requireAuth, jwtOrApiKey, capabilities, registry
 * and lib/withTransaction on an in-process express app; req.db is an
 * in-memory app_settings / app_settings_versions / users world that answers
 * the statements the route sends (regex-dispatched, transactional by
 * snapshot: rollback restores it), matching keys the way the live
 * utf8mb4_general_ci PAD SPACE columns do. Nothing in the route's import graph is
 * mocked; firmConfig.invalidate is spied (called through).
 *
 * Run: npx jest tests/appSettingsRegistry.test.js
 */
'use strict';

process.env.JWT_SECRET = 'app-settings-registry-test-secret';
process.env.INTERNAL_API_KEY = 'yci_app_settings_registry_internal';   // secret-scan: allow

const express = require('express');
const jwt = require('jsonwebtoken');

const router = require('../routes/api.appSettings');
const reg = require('../lib/settingsRegistry');
const firmConfig = require('../lib/firmConfig');
const apiKeys = require('../lib/apiKeys');
const { withTransaction } = require('../lib/withTransaction');

jest.setTimeout(20000);

// ─────────────────────────────────────────────────────────────────────────────
// The world: app_settings + app_settings_versions + users + api_keys
// ─────────────────────────────────────────────────────────────────────────────

const T0 = '2026-10-01 00:00:00';
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const SECRET_IF = 'IF(is_secret = 0, `value`, NULL) AS `value`';

const KEYS = {
  firmCap: { raw: 'yck_' + 'f'.repeat(22), row: { id: 11, label: 'firm-bot', revoked_at: null, expires_at: null, scopes: ['firm.settings'] } },
  sysCap:  { raw: 'yck_' + 's'.repeat(22), row: { id: 12, label: 'system-bot', revoked_at: null, expires_at: null, scopes: ['system.settings'] } },
  route:   { raw: 'yck_' + 'r'.repeat(22), row: { id: 13, label: 'route-bot', revoked_at: null, expires_at: null, scopes: ['route:/api/app-settings'] } },
};

function world({ rows = [], versions = [], users = { 5: 'sb', 6: 'IT', 9: 'Admin' }, onQuery, looseVariables = false } = {}) {
  const st = {
    rows: new Map(rows.map((r) => [r.key, {
      value: null, is_secret: 0, is_editable: 1, category: null, label: null, description: null,
      type: null, sort_order: null, updated_at: T0, ...r }])),
    versions: versions.map((v) => ({ changed_by: null, changed_via: 'ui', changed_at: T0, ...v })),
    nextVersion: Math.max(0, ...versions.map((v) => v.id)) + 1,
    tick: 0,
    elsewhere: [],   // writes another session committed: they survive our rollback
  };
  const calls = [];      // { sql, params, on }
  const events = [];     // begin / commit / rollback per connection
  const audits = [];     // [auth_type, username, status]
  const leaks = [];      // secret values that left the "server"
  const txOpts = [];
  const byHash = Object.fromEntries(Object.values(KEYS).map((k) => [apiKeys.hashKey(k.raw), k.row]));
  const clone = () => ({ rows: new Map([...st.rows].map(([k, v]) => [k, { ...v }])), versions: st.versions.map((v) => ({ ...v })),
    nextVersion: st.nextVersion });
  const now = () => `2026-10-18 10:00:${String(++st.tick).padStart(2, '0')}`;
  // `key` = ? the way MySQL answers it: app_settings.key (and setting_key) are
  // utf8mb4_general_ci PAD SPACE — case-insensitive, trailing spaces ignored.
  // An exact-match fake would hide every bypass that rides the collation.
  const ci = (k) => String(k).toLowerCase().replace(/ +$/, '');
  const rowOf = (k) => [...st.rows.values()].find((r) => ci(r.key) === ci(k));
  const dup = () => Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
  const out = (r, guarded) => {
    if (Number(r.is_secret) === 1 && !guarded && r.value != null) leaks.push(r.value);
    return Number(r.is_secret) === 1 && guarded ? null : r.value;
  };

  function exec(sql, params, on) {
    calls.push({ sql, params, on });
    if (onQuery) onQuery(sql, params, st);
    if (/^INSERT INTO jwt_api_audit_log/.test(sql)) { audits.push([params[7], params[8], params[9]]); return [{ affectedRows: 1 }]; }
    if (/FROM api_keys WHERE key_hash/.test(sql)) { const r = byHash[params[0]]; return [r ? [{ ...r }] : []]; }
    if (/^UPDATE api_keys SET last_used_at/.test(sql)) return [{ affectedRows: 1 }];

    // GET /api/app-settings
    if (/^SELECT `key`, .* is_secret, is_editable, category, label, description, `type`, sort_order, updated_at FROM app_settings WHERE /.test(sql)) {
      const guarded = sql.includes(SECRET_IF);
      const where = sql.split(' WHERE ')[1];
      let i = 0;
      const served = /^`key` IN \(\?\)/.test(where) ? params[i++] : null;
      const vars = /\(is_editable = 1 AND is_secret = 0 AND `key` NOT IN \(\?\)\)/.test(where) ? params[i++] : null;
      // looseVariables: a DB answer that ignores the flags (the route's own filter must still hold)
      const inList = (list, k) => list.some((x) => ci(x) === ci(k));
      const hit = [...st.rows.values()].filter((r) => (served && inList(served, r.key))
        || (vars && (looseVariables || (Number(r.is_editable) === 1 && Number(r.is_secret) === 0)) && !inList(vars, r.key)));
      return [hit.map((r) => ({ key: r.key, value: out(r, guarded), is_secret: r.is_secret, is_editable: r.is_editable,
        category: r.category, label: r.label, description: r.description, type: r.type, sort_order: r.sort_order, updated_at: r.updated_at }))];
    }
    // PUT / restore: the locked read
    if (/^SELECT `key`, .* is_secret, is_editable, `type`, updated_at FROM app_settings WHERE `key` = \? FOR UPDATE$/.test(sql)) {
      const r = rowOf(params[0]);
      return [r ? [{ key: r.key, value: out(r, sql.includes(SECRET_IF)), is_secret: r.is_secret, is_editable: r.is_editable,
        type: r.type, updated_at: r.updated_at }] : []];
    }
    if (sql === 'UPDATE app_settings SET `value` = ? WHERE `key` = ?') {
      const r = rowOf(params[1]);
      if (r) { r.value = params[0]; r.updated_at = now(); }
      return [{ affectedRows: r ? 1 : 0 }];
    }
    if (sql === 'INSERT INTO app_settings (`key`, `value`, is_secret, is_editable) VALUES (?, ?, 0, 1)') {
      if (rowOf(params[0])) throw dup();
      st.rows.set(params[0], { key: params[0], value: params[1], is_secret: 0, is_editable: 1, category: null, label: null,
        description: null, type: null, sort_order: null, updated_at: now() });
      return [{ affectedRows: 1 }];
    }
    if (sql === 'INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order) ' +
               'VALUES (?, ?, 0, 1, ?, ?, ?, ?, ?)') {
      if (rowOf(params[0])) throw dup();
      const [key, value, category, label, description, type, sort_order] = params;
      st.rows.set(key, { key, value, is_secret: 0, is_editable: 1, category, label, description, type, sort_order, updated_at: now() });
      return [{ affectedRows: 1 }];
    }
    if (sql === 'INSERT INTO app_settings_versions (setting_key, old_value, new_value, changed_by, changed_via) VALUES (?, ?, ?, ?, ?)') {
      const [setting_key, old_value, new_value, changed_by, changed_via] = params;
      const id = st.nextVersion++;
      st.versions.push({ id, setting_key, old_value, new_value, changed_by, changed_via, changed_at: now() });
      return [{ insertId: id, affectedRows: 1 }];
    }
    if (sql === 'SELECT `key`, `value`, updated_at FROM app_settings WHERE `key` = ?') {
      const r = rowOf(params[0]);
      return [r ? [{ key: r.key, value: out(r, false), updated_at: r.updated_at }] : []];
    }
    if (sql === 'SELECT `key`, `value`, category, label, description, `type`, sort_order, updated_at FROM app_settings WHERE `key` = ?') {
      const r = rowOf(params[0]);
      return [r ? [{ key: r.key, value: out(r, false), category: r.category, label: r.label, description: r.description,
        type: r.type, sort_order: r.sort_order, updated_at: r.updated_at }] : []];
    }
    if (sql === 'SELECT `key`, is_secret, is_editable FROM app_settings WHERE `key` = ?') {
      const r = rowOf(params[0]);
      return [r ? [{ key: r.key, is_secret: r.is_secret, is_editable: r.is_editable }] : []];
    }
    let m;
    if ((m = /^SELECT v\.id, v\.old_value, v\.new_value, v\.changed_by, u\.user_name AS changed_by_name, v\.changed_via, v\.changed_at FROM app_settings_versions v LEFT JOIN users u ON u\.user = v\.changed_by WHERE v\.setting_key = \? ORDER BY v\.id DESC LIMIT (\d+)$/.exec(sql))) {
      const rows = st.versions.filter((v) => ci(v.setting_key) === ci(params[0])).sort((a, b) => b.id - a.id).slice(0, Number(m[1]));
      return [rows.map((v) => ({ id: v.id, old_value: v.old_value, new_value: v.new_value, changed_by: v.changed_by,
        changed_by_name: v.changed_by == null || users[v.changed_by] === undefined ? null : users[v.changed_by],
        changed_via: v.changed_via, changed_at: v.changed_at }))];
    }
    if (sql === 'SELECT id, old_value FROM app_settings_versions WHERE id = ? AND setting_key = ?') {
      const v = st.versions.find((x) => x.id === params[0] && ci(x.setting_key) === ci(params[1]));
      return [v ? [{ id: v.id, old_value: v.old_value }] : []];
    }
    throw new Error('unscripted query: ' + sql);
  }

  let connSeq = 0;
  const pool = {
    st, calls, events, audits, leaks, txOpts,
    query: async (sql, params = []) => exec(norm(sql), params, 'pool'),
    getConnection: async () => {
      const id = ++connSeq;
      let snap = null;
      return {
        query: async (sql, params = []) => exec(norm(sql), params, id),
        beginTransaction: async () => { snap = clone(); events.push(['begin', id]); },
        commit: async () => { snap = null; events.push(['commit', id]); },
        rollback: async () => {
          if (snap) { st.rows = snap.rows; st.versions = snap.versions; st.nextVersion = snap.nextVersion; snap = null; }
          st.elsewhere.forEach((fn) => fn(st));
          events.push(['rollback', id]);
        },
        release: () => events.push(['release', id]),
        destroy: () => {},
      };
    },
  };
  pool.withTransaction = (fn, opts) => { txOpts.push(opts); return withTransaction(pool, fn, opts); };
  return pool;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP: one server for the file, the world swapped per call
// ─────────────────────────────────────────────────────────────────────────────

let server;
let current = null;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = current; next(); });
  app.use(router);
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  apiKeys.invalidateCache();
  jest.spyOn(firmConfig, 'invalidate');
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const flush = () => new Promise((r) => setImmediate(r));

async function call(db, method, url, { headers = {}, body } = {}) {
  current = db;
  const r = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch (_) { /* text */ }
  await flush();
  return { status: r.status, body: json, text };
}

const tok = (roles, sub = 5, username = 'sb') => ({ authorization: 'Bearer ' + jwt.sign(
  { sub, username, user_type: 1, user_auth: 'authorized', roles, aud: 'staff', ver: 1 },
  process.env.JWT_SECRET, { expiresIn: '5m' }) });
const STAFF = tok(['staff']);
const ADMIN = tok(['staff', 'admin'], 9, 'Admin');
const IT = tok(['it'], 6, 'IT');
const SU = tok(['su'], 6, 'IT');
const INTERNAL = { 'x-api-key': process.env.INTERNAL_API_KEY };
const keyHdr = (k) => ({ 'x-api-key': KEYS[k].raw });

const settingsSql = (db) => db.calls.filter((c) => /app_settings/.test(c.sql));
const writes = (db) => db.calls.filter((c) => /^(UPDATE app_settings SET|INSERT INTO app_settings \()/.test(c.sql));

// ─────────────────────────────────────────────────────────────────────────────
// Fixture rows
// ─────────────────────────────────────────────────────────────────────────────

const ROWS = () => [
  { key: 'firm_name', value: 'Acme Law', category: 'Firm', label: 'IGNORED LABEL', description: 'IGNORED', type: 'json', sort_order: 99, is_editable: 0 },
  { key: 'fe-firm_phone', value: '2485551234' },
  { key: 'firm_email', value: 'office@example.com' },
  { key: 'email_it', value: 'SECRET-flagged-email', is_secret: 1 },            // a registered firm key flagged secret
  { key: 'portal_live', value: '1' },
  { key: 'fe-lead_sources', value: '["Web"]' },
  { key: 'cta_default_timeout_once', value: '3d' },
  { key: 'cloud_tasks_enabled', value: '1' },
  { key: 'app_url', value: 'https://app.example.com' },
  { key: 'alert_email_min_severity', value: 'error' },
  { key: 'comms_archive_enabled', value: '0' },
  { key: 'clio_login_code', value: '123456' },
  { key: 'quo_api_key', value: 'SECRET-quo', is_secret: 1, is_editable: 0 },
  { key: 'pabbly_internal_url', value: 'https://hook.example/?k=SECRET-pabbly', is_secret: 0, is_editable: 1 },
  { key: 'comms_archive_admins', value: '5,6', is_editable: 1 },
  { key: 'fe-trustees', value: '[]', is_editable: 1 },
  { key: 'unified_singleton_enabled', value: '1', is_editable: 1 },
  // unregistered
  { key: 'my_var', value: 'hello', type: 'text', description: 'A var', category: 'Automations', sort_order: 2 },
  { key: 'another_var', value: 'x', type: 'number', label: 'Another', category: 'Automations', sort_order: null },
  { key: 'first_var', value: 'y', type: 'string', sort_order: 1 },
  { key: 'zz_var', value: 'z', type: 'string', sort_order: null },
  { key: 'hidden_var', value: 'h', is_editable: 0 },
  { key: 'secret_var', value: 'SECRET-var', is_editable: 1, is_secret: 1 },
];

const homesOf = (r) => [...new Set(r.body.settings.map((s) => s.home))];
const byKey = (r) => Object.fromEntries(r.body.settings.map((s) => [s.key, s]));

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/app-settings
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/app-settings — per caller', () => {
  const CALLERS = {
    staff:    [STAFF, { firm: false, system: false }, ['firm', 'portal', 'config', 'cta']],
    admin:    [ADMIN, { firm: true, system: false }, ['firm', 'portal', 'config', 'cta']],
    it:       [IT, { firm: true, system: true }, ['firm', 'portal', 'config', 'cta', 'system', 'comms']],
    su:       [SU, { firm: true, system: true }, ['firm', 'portal', 'config', 'cta', 'system', 'comms']],
    internal: [INTERNAL, { firm: true, system: true }, ['firm', 'portal', 'config', 'cta', 'system', 'comms']],
  };

  for (const [who, [headers, caps, homes]] of Object.entries(CALLERS)) {
    test(`${who}: caps, served homes in order, sections for exactly those homes`, async () => {
      const db = world({ rows: ROWS() });
      const r = await call(db, 'GET', '/api/app-settings', { headers });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('success');
      expect(r.body.caps).toEqual(caps);
      expect(homesOf(r)).toEqual(homes);
      expect(Object.keys(r.body.sections)).toEqual(homes);
      for (const h of homes) expect(r.body.sections[h]).toEqual(reg.SECTIONS[h].map((s) => ({ ...s })));
    });

    test(`${who}: every registered key the caller may read is served, row or no row; nothing else registered`, async () => {
      const db = world({ rows: ROWS() });
      const r = await call(db, 'GET', '/api/app-settings', { headers });
      const want = Object.keys(reg.SETTINGS).filter((k) => {
        const e = reg.SETTINGS[k];
        return homes.includes(e.home) && !reg.NEVER_SERVED.includes(e.kind) && k !== 'email_it';   // email_it: its row is flagged secret
      }).sort();
      expect(r.body.settings.filter((s) => s.registered).map((s) => s.key).sort()).toEqual(want);
    });

    test(`${who}: can_edit = posture ui (not state) AND the home's write capability`, async () => {
      const db = world({ rows: ROWS() });
      const r = await call(db, 'GET', '/api/app-settings', { headers });
      for (const s of r.body.settings) {
        if (!s.registered) { expect([s.key, s.can_edit]).toEqual([s.key, caps.firm]); continue; }
        const e = reg.SETTINGS[s.key];
        const capHeld = reg.capsOf(e).write === 'firm.settings' ? caps.firm : caps.system;
        const want = reg.editOf(e) === 'ui' && e.kind !== 'state' && capHeld;
        expect([s.key, s.can_edit]).toEqual([s.key, want]);
      }
    });
  }

  test('concrete can_edit pins: admin edits firm / portal / config, not cta or system; it edits cta and system ui keys, never console or state', async () => {
    const admin = byKey(await call(world({ rows: ROWS() }), 'GET', '/api/app-settings', { headers: ADMIN }));
    expect([admin.firm_name.can_edit, admin.portal_live.can_edit, admin['fe-lead_sources'].can_edit,
      admin.cta_default_timeout_once.can_edit, admin.cloud_tasks_enabled]).toEqual([true, true, true, false, undefined]);
    const it = byKey(await call(world({ rows: ROWS() }), 'GET', '/api/app-settings', { headers: IT }));
    expect([it.cta_default_timeout_once.can_edit, it.cloud_tasks_enabled.can_edit, it.comms_archive_enabled.can_edit,
      it.app_url.can_edit, it.clio_login_code.can_edit, it.alert_last_sweep_at.can_edit]).toEqual([true, true, true, false, false, false]);
  });

  test('never served: secrets (registry kind, or the row flag), access and retired keys — even to su, even when flagged editable', async () => {
    const db = world({ rows: ROWS() });
    const r = await call(db, 'GET', '/api/app-settings', { headers: SU });
    const keys = r.body.settings.map((s) => s.key);
    for (const k of ['quo_api_key', 'pabbly_internal_url', 'email_it', 'secret_var', 'comms_archive_admins', 'comms_eval_reviewers',
      'fe-trustees', 'unified_singleton_enabled', 'esign_webhook_hmac_mode', 'internal_api_key', 'hidden_var']) {
      expect([k, keys.includes(k)]).toEqual([k, false]);
    }
    expect(r.text).not.toMatch(/SECRET/);
    expect(r.body.settings.some((s) => s.kind === 'secret' || s.kind === 'access' || s.kind === 'retired' || s.home === 'console')).toBe(false);
  });

  test('a secret value never even leaves MySQL: flagged rows come back NULLed; never-served keys are not selected', async () => {
    const db = world({ rows: ROWS() });
    await call(db, 'GET', '/api/app-settings', { headers: SU });
    expect(db.leaks).toEqual([]);
    const sel = db.calls.find((c) => /FROM app_settings WHERE/.test(c.sql));
    expect(sel.sql).toContain(SECRET_IF);
    const served = sel.params[0];
    for (const k of ['quo_api_key', 'pabbly_internal_url', 'comms_archive_admins', 'fe-trustees', 'internal_api_key']) {
      expect([k, served.includes(k)]).toEqual([k, false]);
    }
    expect(sel.params[1].sort()).toEqual(Object.keys(reg.SETTINGS).sort());   // the variables branch excludes every registered key
  });

  test('a registered key with no row: exists:false, value / updated_at null (the code default applies)', async () => {
    const r = byKey(await call(world({ rows: ROWS() }), 'GET', '/api/app-settings', { headers: ADMIN }));
    expect(r.firm_attorney_name).toMatchObject({ exists: false, value: null, updated_at: null, registered: true, can_edit: true });
    expect(r.firm_name).toMatchObject({ exists: true, value: 'Acme Law', updated_at: T0 });
  });

  test('a registered row: the registry\'s metadata, never the DB\'s', async () => {
    const r = byKey(await call(world({ rows: ROWS() }), 'GET', '/api/app-settings', { headers: ADMIN }));
    expect(r.firm_name).toEqual({
      key: 'firm_name', value: 'Acme Law', updated_at: T0, exists: true, registered: true, kind: 'firm', home: 'firm',
      section: 'identity', type: 'string', options: null, label: 'Firm name', description: reg.SETTINGS.firm_name.desc,
      sort_order: 5, edit: 'ui', editor: null, env: null, required: false, can_edit: true, category: 'Firm identity',
    });
    expect(r['fe-firm_phone']).toMatchObject({ type: 'phone', env: 'FIRM_PHONE', category: 'Firm identity' });
    expect(r['fe-lead_sources']).toMatchObject({ home: 'config', section: 'lists', category: 'Lists', kind: 'vocab' });
  });

  test('enum options, editor, console posture and state rows (it)', async () => {
    const r = byKey(await call(world({ rows: ROWS() }), 'GET', '/api/app-settings', { headers: IT }));
    expect(r.alert_email_min_severity).toMatchObject({ type: 'enum', options: ['error', 'warn', 'info'], value: 'error', can_edit: true });
    expect(r.dropbox_case_folder_templates).toMatchObject({ editor: 'dropboxTemplates', exists: false });
    expect(r.app_url).toMatchObject({ edit: 'console', can_edit: false, value: 'https://app.example.com', category: 'Platform' });
    expect(r.clio_login_code).toMatchObject({ kind: 'state', edit: 'console', can_edit: false, category: 'Runtime state (read-only)' });
  });

  test('unregistered rows: editable + non-secret only, as Firm → Automation variables with their DB metadata', async () => {
    const r = await call(world({ rows: ROWS() }), 'GET', '/api/app-settings', { headers: STAFF });
    const vars = r.body.settings.filter((s) => !s.registered);
    expect(vars.map((s) => s.key)).toEqual(['first_var', 'my_var', 'another_var', 'zz_var']);   // sort_order, unset last, then key
    expect(byKey(r).my_var).toEqual({
      key: 'my_var', value: 'hello', updated_at: T0, exists: true, registered: false, kind: 'variable', home: 'firm',
      section: 'variables', type: 'text', options: null, label: 'my_var', description: 'A var', sort_order: 2,
      edit: 'ui', editor: null, env: null, required: false, can_edit: false, category: 'Automations',
    });
    expect(byKey(r).another_var).toMatchObject({ label: 'Another', type: 'number', sort_order: null });
    const admin = await call(world({ rows: ROWS() }), 'GET', '/api/app-settings', { headers: ADMIN });
    expect(admin.body.settings.filter((s) => !s.registered).every((s) => s.can_edit === true)).toBe(true);
  });

  test('the route filters variables itself too: a broader DB answer still serves no hidden or secret row', async () => {
    const db = world({ rows: ROWS(), looseVariables: true });
    const r = await call(db, 'GET', '/api/app-settings', { headers: SU });
    expect(r.body.settings.filter((s) => !s.registered).map((s) => s.key)).toEqual(['first_var', 'my_var', 'another_var', 'zz_var']);
    expect(r.text).not.toMatch(/SECRET/);
  });

  test('order: home, section, sort_order (unset last), key', async () => {
    const r = await call(world({ rows: ROWS() }), 'GET', '/api/app-settings', { headers: SU });
    const S = r.body.settings;
    const homes = Object.keys(reg.HOME_CAPS);
    const rank = (s) => [homes.indexOf(s.home), reg.SECTIONS[s.home].findIndex((x) => x.id === s.section),
      s.sort_order == null ? Infinity : s.sort_order];
    for (let i = 1; i < S.length; i++) {
      const a = rank(S[i - 1]), b = rank(S[i]);
      const cmp = a[0] - b[0] || a[1] - b[1] || (a[2] === b[2] ? 0 : a[2] < b[2] ? -1 : 1) || (S[i - 1].key < S[i].key ? -1 : 1);
      expect([S[i - 1].key, S[i].key, cmp < 0]).toEqual([S[i - 1].key, S[i].key, true]);
    }
    const keys = S.map((s) => s.key);
    expect(keys.slice(0, 3)).toEqual(['firm_name', 'fe-firm_logo_url', 'fe-firm_phone']);   // identity, sort 5 / 10 / 20
    expect(keys.indexOf('esign_credit_alert_threshold')).toBeLessThan(keys.indexOf('first_var'));   // variables close the firm home
    expect(keys.indexOf('zz_var')).toBeLessThan(keys.indexOf('portal_live'));
    expect(keys.indexOf('cta_default_timeout_repeatable')).toBeLessThan(keys.indexOf('app_url'));   // cta before system
    expect(keys[keys.length - 1]).toBe('comms_summary_firm_context');                               // comms last, sort 63
  });

  test('?home filters (comma-separated, repeatable); only the asked homes are read', async () => {
    let db = world({ rows: ROWS() });
    let r = await call(db, 'GET', '/api/app-settings?home=portal', { headers: ADMIN });
    expect([homesOf(r), Object.keys(r.body.sections)]).toEqual([['portal'], ['portal']]);
    expect(r.body.settings.map((s) => s.key)).toEqual(Object.keys(reg.SETTINGS).filter((k) => reg.SETTINGS[k].home === 'portal')
      .sort((a, b) => reg.SETTINGS[a].sort - reg.SETTINGS[b].sort));
    expect(db.calls.find((c) => /FROM app_settings WHERE/.test(c.sql)).sql).not.toMatch(/NOT IN/);   // no variables branch
    expect(r.body.caps).toEqual({ firm: true, system: false });

    r = await call(world({ rows: ROWS() }), 'GET', '/api/app-settings?home=cta,firm', { headers: STAFF });
    expect(homesOf(r)).toEqual(['firm', 'cta']);
    expect(r.body.settings.some((s) => s.key === 'my_var')).toBe(true);

    r = await call(world({ rows: ROWS() }), 'GET', '/api/app-settings?home=config&home=portal', { headers: STAFF });
    expect(homesOf(r)).toEqual(['portal', 'config']);
  });

  test('?home of a home the caller may not read, or console: empty, no query', async () => {
    for (const [q, headers] of [['system', ADMIN], ['comms', STAFF], ['console', SU]]) {
      const db = world({ rows: ROWS() });
      const r = await call(db, 'GET', `/api/app-settings?home=${q}`, { headers });
      expect([q, r.status, r.body.settings, r.body.sections]).toEqual([q, 200, [], {}]);
      expect(settingsSql(db)).toEqual([]);
    }
  });

  test('?home with an unknown home → 400, nothing read; an empty ?home= filters nothing', async () => {
    for (const q of ['nope', 'firm,nope', 'Firm']) {
      const db = world({ rows: ROWS() });
      const r = await call(db, 'GET', `/api/app-settings?home=${q}`, { headers: SU });
      expect([q, r.status, r.body.message]).toEqual([q, 400, `home must be one of: ${Object.keys(reg.HOME_CAPS).join(', ')}`]);
      expect(settingsSql(db)).toEqual([]);
    }
    const r = await call(world({ rows: ROWS() }), 'GET', '/api/app-settings?home=', { headers: SU });
    expect([r.status, homesOf(r)]).toEqual([200, ['firm', 'portal', 'config', 'cta', 'system', 'comms']]);
  });

  test('portal token / no credentials cannot read', async () => {
    const portal = { authorization: 'Bearer ' + jwt.sign({ sub: 7, aud: 'contact', ver: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' }) };
    expect((await call(world(), 'GET', '/api/app-settings', { headers: portal })).status).toBe(401);
    expect((await call(world(), 'GET', '/api/app-settings', {})).status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/app-settings/:key
// ─────────────────────────────────────────────────────────────────────────────

const PUT = (db, key, value, headers = SU) => call(db, 'PUT', `/api/app-settings/${encodeURIComponent(key)}`, { headers, body: { value } });

describe('PUT — registered keys', () => {
  test.each([
    ['app_url', 'App URL'],                          // system, edit console
    ['comms_stt_credential_id', 'STT credential'],   // comms, edit console
    ['clio_login_code', 'Clio login code'],          // state
    ['alert_last_sweep_at', 'Alert sweep last ran'], // state
    ['quo_api_key', 'Quo API key'],                  // secret
    ['comms_archive_admins', 'Comms archive admins'],// access
    ['fe-trustees', 'Trustee roster (retired)'],     // retired
  ])('%s → 403 console only, before any app_settings query, even for su', async (key, label) => {
    const db = world({ rows: ROWS() });
    const r = await PUT(db, key, 'x');
    expect([r.status, r.body]).toEqual([403, { status: 'error', message: `${label} is changed from the SU db console only` }]);
    expect(settingsSql(db)).toEqual([]);
    expect(firmConfig.invalidate).not.toHaveBeenCalled();
  });

  test.each([
    ['firm_name', STAFF, 'Changing Firm name needs the firm.settings permission'],
    ['portal_live', STAFF, 'Changing Portal live needs the firm.settings permission'],
    ['fe-lead_sources', STAFF, 'Changing Lead sources needs the firm.settings permission'],
    ['cloud_tasks_enabled', ADMIN, 'Changing Cloud Tasks accelerator needs the system.settings permission'],
    ['cta_default_timeout_once', ADMIN, 'Changing Default expiry (single-use) needs the system.settings permission'],
    ['comms_archive_enabled', ADMIN, 'Changing Comms archive sweep needs the system.settings permission'],
  ])('%s without the home\'s write capability → 403 naming it, the gate\'s audit row, nothing read', async (key, headers, message) => {
    const db = world({ rows: ROWS() });
    const r = await PUT(db, key, '1', headers);
    expect([r.status, r.body]).toEqual([403, { status: 'error', message }]);
    expect(settingsSql(db)).toEqual([]);
    expect(db.audits.map((a) => a[2])).toEqual(['authorized', 'unauthorized']);
    expect(db.audits[1][0]).toBe('jwt');
  });

  test('holders write: admin firm / portal / config, it and su system / cta / comms', async () => {
    const cases = [['firm_name', ADMIN, 'New Name'], ['portal_live', ADMIN, '0'], ['fe-lead_sources', ADMIN, '["Web","Radio"]'],
      ['cloud_tasks_enabled', IT, '0'], ['cta_default_timeout_once', SU, '5d'], ['comms_archive_enabled', IT, '1']];
    for (const [key, headers, value] of cases) {
      const db = world({ rows: ROWS() });
      const r = await PUT(db, key, value, headers);
      expect([key, r.status, r.body.setting.value, db.st.rows.get(key).value]).toEqual([key, 200, value, value]);
    }
  });

  test('validation by the REGISTRY type (the DB type of a registered row is ignored) → 400, nothing written', async () => {
    const cases = [['firm_email', 'not-an-email', 'must be a valid email address'], ['fe-firm_phone', 'call me', /phone number/],
      ['alert_email_min_severity', 'loud', 'must be one of: error, warn, info'], ['portal_live', 'yes', 'must be 1 or 0'],
      ['office_alerts_to', '5,x', 'must be a comma-separated list of user ids'], ['fe-lead_sources', '{"a":1}', 'must be a JSON array'],
      // the registry's `required` (blank breaks the feature) and `duration` (a unit, ≤ 365 days)
      ['portal_email_from', '', 'cannot be blank'], ['portal_callback_task_to', '  ', 'cannot be blank'],
      ['cta_default_timeout_once', '3', /with a unit/], ['cta_default_timeout_repeatable', '400d', 'must be at most 365 days']];
    for (const [key, value, msg] of cases) {
      const db = world({ rows: ROWS() });
      const r = await PUT(db, key, value);
      expect([key, r.status]).toEqual([key, 400]);
      expect(r.body.message).toEqual(typeof msg === 'string' ? msg : expect.stringMatching(msg));
      expect(writes(db)).toEqual([]);
      expect(db.st.versions).toEqual([]);
    }
    // firm_name's row says type 'json' — the registry says string: '{bad' is fine
    const db = world({ rows: ROWS() });
    expect((await PUT(db, 'firm_name', '{bad')).status).toBe(200);
  });

  test('value shape: not a string / too long → 400 (after the capability check), nothing written', async () => {
    for (const value of [42, { a: 1 }, null, ['x'], 'x'.repeat(60001)]) {
      const db = world({ rows: ROWS() });
      const r = await PUT(db, 'firm_name', value);
      expect(r.status).toBe(400);
      expect(writes(db)).toEqual([]);
    }
    const db = world({ rows: ROWS() });
    expect((await PUT(db, 'firm_name', 42, STAFF)).status).toBe(403);   // the gate speaks first
  });

  test('a registered row flagged is_secret → 403 console only, its value never read, nothing written', async () => {
    const db = world({ rows: ROWS() });
    const r = await PUT(db, 'email_it', 'it@example.com');
    expect([r.status, r.body.message]).toEqual([403, 'IT email is changed from the SU db console only']);
    expect(writes(db)).toEqual([]);
    expect(db.leaks).toEqual([]);
    expect(db.events.map((e) => e[0])).toEqual(['begin', 'rollback', 'release']);
  });

  test('UPDATE: the write and its version row on ONE connection inside ONE transaction (retries:1), then invalidate', async () => {
    const db = world({ rows: ROWS() });
    const r = await PUT(db, 'firm_name', 'New Name', ADMIN);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'success', setting: { key: 'firm_name', value: 'New Name', updated_at: '2026-10-18 10:00:01' } });
    expect(db.txOpts).toEqual([{ retries: 1 }]);
    const tx = db.calls.filter((c) => c.on !== 'pool');
    expect(tx.map((c) => c.sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'SELECT `key`, IF(is_secret', 'UPDATE app_settings SET', 'INSERT INTO app_settings_versions', 'SELECT `key`, `value`,']);
    expect(new Set(tx.map((c) => c.on)).size).toBe(1);
    expect(db.events.map((e) => e[0])).toEqual(['begin', 'commit', 'release']);
    expect(db.st.versions).toEqual([{ id: 1, setting_key: 'firm_name', old_value: 'Acme Law', new_value: 'New Name',
      changed_by: 9, changed_via: 'ui', changed_at: '2026-10-18 10:00:02' }]);
    expect(firmConfig.invalidate).toHaveBeenCalledTimes(1);
  });

  test('a registered key with no row → INSERT (is_secret 0, is_editable 1, no metadata) + a version row with old_value NULL', async () => {
    const db = world({ rows: ROWS() });
    const r = await PUT(db, 'firm_attorney_name', 'J. Doe', ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.setting).toMatchObject({ key: 'firm_attorney_name', value: 'J. Doe' });
    expect(db.st.rows.get('firm_attorney_name')).toMatchObject({ value: 'J. Doe', is_secret: 0, is_editable: 1, category: null,
      label: null, description: null, type: null, sort_order: null });
    expect(writes(db).map((c) => c.sql)).toEqual(['INSERT INTO app_settings (`key`, `value`, is_secret, is_editable) VALUES (?, ?, 0, 1)']);
    expect(db.st.versions).toMatchObject([{ setting_key: 'firm_attorney_name', old_value: null, new_value: 'J. Doe', changed_via: 'ui' }]);
  });

  test('unchanged (byte for byte) → 200 with the current row, no write, no version row, no invalidate', async () => {
    const db = world({ rows: ROWS() });
    const r = await PUT(db, 'firm_name', 'Acme Law', ADMIN);
    expect([r.status, r.body]).toEqual([200, { status: 'success', setting: { key: 'firm_name', value: 'Acme Law', updated_at: T0 } }]);
    expect(writes(db)).toEqual([]);
    expect(db.st.versions).toEqual([]);
    expect(firmConfig.invalidate).not.toHaveBeenCalled();
    // one byte different IS a change
    const db2 = world({ rows: ROWS() });
    await PUT(db2, 'firm_name', 'Acme Law ', ADMIN);
    expect(db2.st.versions.length).toBe(1);
  });

  test('stored verbatim: whitespace and all', async () => {
    const db = world({ rows: ROWS() });
    await PUT(db, 'dropbox_unsorted_uploads_path', '   /Unsorted  ', ADMIN);
    expect(db.st.rows.get('dropbox_unsorted_uploads_path').value).toBe('   /Unsorted  ');
    expect(db.st.versions[0].new_value).toBe('   /Unsorted  ');
  });

  test('a failed version insert rolls the write back: the value is unchanged, 500, no invalidate', async () => {
    const db = world({ rows: ROWS(), onQuery: (sql) => { if (/^INSERT INTO app_settings_versions/.test(sql)) throw new Error('boom'); } });
    const r = await PUT(db, 'firm_name', 'New Name', ADMIN);
    expect(r.status).toBe(500);
    expect(db.st.rows.get('firm_name').value).toBe('Acme Law');
    expect(db.events.map((e) => e[0])).toEqual(['begin', 'rollback', 'release']);
    expect(firmConfig.invalidate).not.toHaveBeenCalled();
  });

  test('changed_by / changed_via: a staff JWT → its user and ui; a machine key → NULL and api_key', async () => {
    const db = world({ rows: ROWS() });
    await PUT(db, 'firm_name', 'A', IT);
    await PUT(db, 'firm_name', 'B', INTERNAL);
    expect(db.st.versions.map((v) => [v.changed_by, v.changed_via])).toEqual([[6, 'ui'], [null, 'api_key']]);
  });

  test('the first-write race: the INSERT collides with a concurrent creator → once more, as an UPDATE over the winner', async () => {
    let raced = false;
    const db = world({ rows: ROWS(), onQuery: (sql, params, st) => {
      if (!raced && sql.startsWith('INSERT INTO app_settings (`key`')) {
        raced = true;   // another session commits the row between our locked read and our INSERT
        const winner = (w) => w.rows.set('firm_attorney_name',
          { key: 'firm_attorney_name', value: 'Winner', is_secret: 0, is_editable: 1, type: null, updated_at: T0 });
        winner(st);
        st.elsewhere.push(winner);
      }
    } });
    const r = await PUT(db, 'firm_attorney_name', 'Me', ADMIN);
    expect(r.status).toBe(200);
    expect(db.st.rows.get('firm_attorney_name').value).toBe('Me');
    expect(db.st.versions.map((v) => [v.old_value, v.new_value])).toEqual([['Winner', 'Me']]);
  });
});

describe('PUT — unregistered keys keep today\'s rules', () => {
  test('a non-holder is refused before any app_settings read (no existence oracle), with the audit row', async () => {
    for (const key of ['my_var', 'hidden_var', 'secret_var', 'no_such_var']) {
      const db = world({ rows: ROWS() });
      const r = await PUT(db, key, 'v', STAFF);
      expect([key, r.status, r.body.message]).toEqual([key, 403, `Changing ${key} needs the firm.settings permission`]);
      expect(settingsSql(db)).toEqual([]);
      expect(db.audits.map((a) => a[2])).toEqual(['authorized', 'unauthorized']);
    }
  });

  test('missing → 404; is_editable 0 or secret → 403 not editable (the secret value never read)', async () => {
    const db = world({ rows: ROWS() });
    expect([(await PUT(db, 'no_such_var', 'v', ADMIN)).status]).toEqual([404]);
    for (const key of ['hidden_var', 'secret_var']) {
      const r = await PUT(db, key, 'v', ADMIN);
      expect([key, r.status, r.body.message]).toEqual([key, 403, 'This setting is not editable']);
    }
    expect(writes(db)).toEqual([]);
    expect(db.leaks).toEqual([]);
  });

  test('validated by the row\'s DB type; an unknown DB type is verbatim', async () => {
    const db = world({ rows: ROWS() });
    const bad = await PUT(db, 'another_var', '12x', ADMIN);
    expect([bad.status, bad.body.message]).toEqual([400, 'must be a number']);
    expect((await PUT(db, 'another_var', ' 42 ', ADMIN)).status).toBe(200);
    expect((await PUT(db, 'my_var', '{not json', ADMIN)).status).toBe(200);   // type 'text': no validator
    expect(db.st.versions.map((v) => [v.setting_key, v.old_value, v.new_value])).toEqual([
      ['another_var', 'x', ' 42 '], ['my_var', 'hello', '{not json']]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/app-settings
// ─────────────────────────────────────────────────────────────────────────────

const POST = (db, body, headers = ADMIN) => call(db, 'POST', '/api/app-settings', { headers, body });

describe('POST /api/app-settings', () => {
  test('a registered key → 409 naming its home, whether or not its row exists; nothing inserted', async () => {
    const cases = [['firm_attorney_name', 'YisraCase Config → Firm'], ['firm_name', 'YisraCase Config → Firm'],
      ['portal_live', 'Portal Manager → Settings'], ['fe-lead_sources', 'YisraCase Config (Lists / Types & Subtypes)'],
      ['cloud_tasks_enabled', 'YisraCase Config → System'], ['comms_archive_enabled', 'YisraCase Config → System'],
      ['cta_default_timeout_once', 'CTA Links'], ['quo_api_key', 'the SU db console'], ['gcs_bucket', 'YisraCase Config → System']];
    for (const [key, home] of cases) {
      const db = world({ rows: ROWS() });
      const r = await POST(db, { key, value: 'x' });
      expect([key, r.status, r.body.message]).toEqual([key, 409, `"${key}" is a registered setting — change it in ${home}`]);
      expect(writes(db)).toEqual([]);
    }
  });

  test('creates the row and its version row (old NULL, create, the user) in one transaction → 201', async () => {
    const db = world({ rows: ROWS() });
    const r = await POST(db, { key: 'new_knob', value: ' v ', type: 'string', label: 'New knob', category: 'Automations', sort_order: 3 });
    expect(r.status).toBe(201);
    expect(r.body.setting).toMatchObject({ key: 'new_knob', value: ' v ', label: 'New knob', type: 'string', sort_order: 3 });
    expect(db.st.rows.get('new_knob')).toMatchObject({ is_secret: 0, is_editable: 1 });
    expect(db.st.versions).toMatchObject([{ setting_key: 'new_knob', old_value: null, new_value: ' v ', changed_by: 9, changed_via: 'create' }]);
    expect(db.txOpts).toEqual([{ retries: 1 }]);
    const tx = db.calls.filter((c) => c.on !== 'pool');
    expect(new Set(tx.map((c) => c.on)).size).toBe(1);
    expect(tx.map((c) => c.sql.slice(0, 33))).toEqual(['INSERT INTO app_settings (`key`, ', 'INSERT INTO app_settings_versions', 'SELECT `key`, `value`, category, ']);
    expect(firmConfig.invalidate).toHaveBeenCalledTimes(1);
  });

  test('an existing (unregistered) row → 409 already exists; nothing versioned', async () => {
    const db = world({ rows: ROWS() });
    const r = await POST(db, { key: 'hidden_var', value: 'x' });
    expect([r.status, r.body.message]).toEqual([409, 'Setting "hidden_var" already exists']);
    expect(db.st.versions).toEqual([]);
    expect(db.events.map((e) => e[0])).toEqual(['begin', 'rollback', 'release']);
  });

  test('machine keys and non-holders are refused; nothing inserted', async () => {
    const db = world({ rows: ROWS() });
    const k = await POST(db, { key: 'new_knob', value: 'x' }, INTERNAL);
    expect([k.status, k.body.message]).toEqual([403, 'Settings can only be created by a signed-in user']);
    const s = await POST(db, { key: 'new_knob', value: 'x' }, STAFF);
    expect([s.status, s.body.message]).toEqual([403, 'Creating a setting needs the firm.settings permission']);
    expect(writes(db)).toEqual([]);
  });

  test('today\'s validation stands: KEY_RE, SETTING_TYPES, the type validator', async () => {
    const db = world();
    expect((await POST(db, { key: '-bad', value: 'x' })).status).toBe(400);
    expect((await POST(db, { key: 'k1', value: 'x', type: 'user' })).status).toBe(400);   // a registry picker type is not creatable
    expect((await POST(db, { key: 'k2', value: 'x', type: 'number' })).status).toBe(400);
    expect(writes(db)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/app-settings/:key/history
// ─────────────────────────────────────────────────────────────────────────────

const V = (id, key, old_value, new_value, changed_by, changed_via) =>
  ({ id, setting_key: key, old_value, new_value, changed_by, changed_via, changed_at: `2026-10-0${id} 00:00:00` });
const VERSIONS = () => [
  V(1, 'firm_name', null, 'Acme', 9, 'ui'), V(2, 'firm_name', 'Acme', 'Acme Law', null, 'api_key'),
  V(3, 'my_var', null, 'hello', 9, 'create'), V(4, 'firm_name', 'Acme Law', 'Acme', 77, 'restore'),
  V(5, 'cloud_tasks_enabled', '0', '1', 6, 'ui'),
];
const HIST = (db, key, headers = SU, q = '') => call(db, 'GET', `/api/app-settings/${encodeURIComponent(key)}/history${q}`, { headers });

describe('GET /api/app-settings/:key/history', () => {
  test('newest first, changed_by_name joined (NULL for a machine or an unknown user)', async () => {
    const db = world({ rows: ROWS(), versions: VERSIONS() });
    const r = await HIST(db, 'firm_name', ADMIN);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'success', key: 'firm_name', versions: [
      { id: 4, old_value: 'Acme Law', new_value: 'Acme', changed_by: 77, changed_by_name: null, changed_via: 'restore', changed_at: '2026-10-04 00:00:00' },
      { id: 2, old_value: 'Acme', new_value: 'Acme Law', changed_by: null, changed_by_name: null, changed_via: 'api_key', changed_at: '2026-10-02 00:00:00' },
      { id: 1, old_value: null, new_value: 'Acme', changed_by: 9, changed_by_name: 'Admin', changed_via: 'ui', changed_at: '2026-10-01 00:00:00' },
    ] });
  });

  test('needs the key\'s WRITE capability → 403 naming it (staff on firm; admin on system); it / su pass', async () => {
    let db = world({ rows: ROWS(), versions: VERSIONS() });
    let r = await HIST(db, 'firm_name', STAFF);
    expect([r.status, r.body.message]).toEqual([403, 'The history of Firm name needs the firm.settings permission']);
    r = await HIST(db, 'cloud_tasks_enabled', ADMIN);
    expect([r.status, r.body.message]).toEqual([403, 'The history of Cloud Tasks accelerator needs the system.settings permission']);
    r = await HIST(db, 'my_var', STAFF);
    expect([r.status, r.body.message]).toEqual([403, 'The history of my_var needs the firm.settings permission']);
    expect(db.calls.filter((c) => /app_settings_versions/.test(c.sql))).toEqual([]);
    db = world({ rows: ROWS(), versions: VERSIONS() });
    expect((await HIST(db, 'cloud_tasks_enabled', IT)).body.versions.map((v) => v.id)).toEqual([5]);
    expect((await HIST(db, 'app_url', SU)).body.versions).toEqual([]);   // console posture: readable history (holders), empty
  });

  test('404: never-served kinds (even for su), a row flagged secret, unregistered hidden / secret / missing', async () => {
    for (const key of ['quo_api_key', 'comms_archive_admins', 'fe-trustees', 'pabbly_internal_url', 'email_it',
      'hidden_var', 'secret_var', 'no_such_var']) {
      const db = world({ rows: ROWS(), versions: [V(9, key, 'a', 'b', 6, 'ui')] });
      const r = await HIST(db, key, SU);
      expect([key, r.status, r.body.message]).toEqual([key, 404, 'Setting not found']);
      expect(db.calls.filter((c) => /app_settings_versions/.test(c.sql))).toEqual([]);
    }
  });

  test('a registered key with no row still has a history; an unregistered row with one shows it', async () => {
    const db = world({ rows: ROWS(), versions: [V(1, 'firm_attorney_name', null, 'X', 9, 'ui'), ...VERSIONS()] });
    expect((await HIST(db, 'firm_attorney_name', ADMIN)).body.versions.map((v) => v.id)).toEqual([1]);
    expect((await HIST(db, 'my_var', ADMIN)).body.versions.map((v) => v.id)).toEqual([3]);
  });

  test('limit: default 50; 1..200 honoured; anything else → 400 before any read', async () => {
    const many = Array.from({ length: 230 }, (_, i) => V(i + 1, 'firm_name', 'a', 'b', 6, 'ui'));
    let db = world({ rows: ROWS(), versions: many });
    expect((await HIST(db, 'firm_name')).body.versions.length).toBe(50);
    expect(db.calls.find((c) => /app_settings_versions/.test(c.sql)).sql).toMatch(/LIMIT 50$/);
    for (const [q, n] of [['1', 1], ['200', 200], ['007', 7]]) {
      db = world({ rows: ROWS(), versions: many });
      const r = await HIST(db, 'firm_name', SU, `?limit=${q}`);
      expect([q, r.status, r.body.versions.length, r.body.versions[0].id]).toEqual([q, 200, n, 230]);
    }
    for (const q of ['0', '201', '-1', 'abc', '1.5', '', '1000']) {
      db = world({ rows: ROWS(), versions: many });
      const r = await HIST(db, 'firm_name', SU, `?limit=${q}`);
      expect([q, r.status, r.body.message]).toEqual([q, 400, 'limit must be an integer from 1 to 200']);
      expect(settingsSql(db)).toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/app-settings/:key/restore
// ─────────────────────────────────────────────────────────────────────────────

const RESTORE = (db, key, version_id, headers = SU) =>
  call(db, 'POST', `/api/app-settings/${encodeURIComponent(key)}/restore`, { headers, body: { version_id } });

describe('POST /api/app-settings/:key/restore', () => {
  test('the version\'s old_value comes back, a restore version row is written, the response is the PUT\'s', async () => {
    const db = world({ rows: ROWS(), versions: VERSIONS() });   // firm_name is 'Acme Law' now
    const r = await RESTORE(db, 'firm_name', 1, ADMIN);         // v1: NULL → 'Acme' … its old value is NULL
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'success', setting: { key: 'firm_name', value: '', updated_at: '2026-10-18 10:00:01' } });
    const r2 = await RESTORE(db, 'firm_name', '2', ADMIN);      // v2: 'Acme' → 'Acme Law' — as a string id too
    expect(r2.body.setting.value).toBe('Acme');
    expect(db.st.versions.slice(-2).map((v) => [v.old_value, v.new_value, v.changed_by, v.changed_via])).toEqual([
      ['Acme Law', '', 9, 'restore'], ['', 'Acme', 9, 'restore']]);
    expect(firmConfig.invalidate).toHaveBeenCalledTimes(2);
    expect(db.txOpts).toEqual([{ retries: 1 }, { retries: 1 }]);
  });

  test('a machine key restores too (changed_by NULL), still as restore', async () => {
    const db = world({ rows: ROWS(), versions: VERSIONS() });
    await RESTORE(db, 'firm_name', 2, INTERNAL);
    expect(db.st.versions.at(-1)).toMatchObject({ changed_by: null, changed_via: 'restore', new_value: 'Acme' });
  });

  test('the version must be this key\'s: another key\'s or none → 404; nothing written', async () => {
    const db = world({ rows: ROWS(), versions: VERSIONS() });
    for (const id of [3, 5, 999]) {
      const r = await RESTORE(db, 'firm_name', id);
      expect([id, r.status, r.body.message]).toEqual([id, 404, 'Version not found']);
    }
    expect(writes(db)).toEqual([]);
  });

  test('version_id must be a positive integer → 400 before any read', async () => {
    for (const id of [0, -1, 1.5, 'x', '', null, undefined, '01', 4294967296, [1], { id: 1 }]) {
      const db = world({ rows: ROWS(), versions: VERSIONS() });
      const r = await RESTORE(db, 'firm_name', id);
      expect([id, r.status, r.body.message]).toEqual([id, 400, 'version_id must be a positive integer']);
      expect(settingsSql(db)).toEqual([]);
    }
  });

  test('the PUT checks: capability, console posture, the restored value\'s validation, unchanged', async () => {
    let db = world({ rows: ROWS(), versions: VERSIONS() });
    let r = await RESTORE(db, 'cloud_tasks_enabled', 5, ADMIN);
    expect([r.status, r.body.message]).toEqual([403, 'Changing Cloud Tasks accelerator needs the system.settings permission']);
    r = await RESTORE(db, 'app_url', 1, SU);
    expect([r.status, r.body.message]).toEqual([403, 'App URL is changed from the SU db console only']);
    r = await RESTORE(db, 'quo_api_key', 1, SU);
    expect(r.status).toBe(403);

    db = world({ rows: ROWS(), versions: [V(1, 'firm_email', 'junk', 'office@example.com', 9, 'ui')] });
    r = await RESTORE(db, 'firm_email', 1, ADMIN);                       // the old value no longer validates
    expect([r.status, r.body.message]).toEqual([400, 'must be a valid email address']);
    expect(writes(db)).toEqual([]);

    db = world({ rows: ROWS(), versions: [V(1, 'firm_name', 'Acme Law', 'Other', 9, 'ui')] });
    r = await RESTORE(db, 'firm_name', 1, ADMIN);                        // already the old value: nothing to do
    expect([r.status, r.body.setting.value]).toEqual([200, 'Acme Law']);
    expect(db.st.versions.length).toBe(1);
    expect(firmConfig.invalidate).not.toHaveBeenCalled();
  });

  test('unregistered: firm.settings, then the row rules (404 missing, 403 not editable)', async () => {
    const db = world({ rows: ROWS(), versions: VERSIONS() });
    expect((await RESTORE(db, 'my_var', 3, STAFF)).status).toBe(403);
    const ok = await RESTORE(db, 'my_var', 3, ADMIN);                    // v3 old NULL → ''
    expect([ok.status, ok.body.setting.value]).toEqual([200, '']);
    expect((await RESTORE(db, 'no_such_var', 3, ADMIN)).status).toBe(404);
    expect((await RESTORE(db, 'hidden_var', 3, ADMIN)).status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Machine keys: a capability scope reaches its keys, with no route scope (B2)
// ─────────────────────────────────────────────────────────────────────────────

describe('machine keys on the per-key routes', () => {
  test('scoped firm.settings: firm keys yes (no route scope needed), system keys → 403 missingCapability', async () => {
    const db = world({ rows: ROWS() });
    expect((await PUT(db, 'firm_name', 'Bot Name', keyHdr('firmCap'))).status).toBe(200);
    expect((await PUT(db, 'my_var', 'v2', keyHdr('firmCap'))).status).toBe(200);
    const r = await PUT(db, 'cloud_tasks_enabled', '0', keyHdr('firmCap'));
    expect([r.status, r.body]).toEqual([403, { error: 'Forbidden', missingCapability: 'system.settings' }]);
    expect(db.st.versions.map((v) => [v.setting_key, v.changed_via, v.changed_by])).toEqual([['firm_name', 'api_key', null], ['my_var', 'api_key', null]]);
  });

  test('scoped system.settings: system keys yes, firm keys no; history follows the same rule', async () => {
    const db = world({ rows: ROWS(), versions: VERSIONS() });
    expect((await PUT(db, 'cloud_tasks_enabled', '0', keyHdr('sysCap'))).status).toBe(200);
    expect((await PUT(db, 'firm_name', 'x', keyHdr('sysCap'))).status).toBe(403);
    expect((await HIST(db, 'cloud_tasks_enabled', keyHdr('sysCap'))).status).toBe(200);
    expect((await HIST(db, 'firm_name', keyHdr('sysCap'))).status).toBe(403);
  });

  test('a route scope alone does not stand in for the capability', async () => {
    const db = world({ rows: ROWS() });
    expect((await PUT(db, 'firm_name', 'x', keyHdr('route'))).status).toBe(403);
    expect(writes(db)).toEqual([]);
  });

  test('a console key from a machine: the handler\'s 403 (no capability to gate on)', async () => {
    const db = world({ rows: ROWS() });
    const r = await PUT(db, 'quo_api_key', 'x', INTERNAL);
    expect([r.status, r.body.message]).toEqual([403, 'Quo API key is changed from the SU db console only']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The collation: app_settings.key is utf8mb4_general_ci PAD SPACE, so MySQL
// answers `key` = 'CLOUD_TASKS_ENABLED ' with the cloud_tasks_enabled row. The
// registry lookup is exact — a spelling it does not know is "unregistered" and
// gated by firm.settings — so every per-key path must refuse a row whose key
// is not the asked key byte for byte (review F1, 2026-10-18).
// ─────────────────────────────────────────────────────────────────────────────

describe('a key spelled differently reaches no other setting', () => {
  const ALIASES = ['CLOUD_TASKS_ENABLED', 'cloud_tasks_enabled ', 'Comms_Archive_Enabled', 'PABBLY_INTERNAL_URL',
    'Pabbly_Internal_Url ', 'Firm_Email', 'Portal_Live', 'MY_VAR', 'my_var  '];

  test('PUT: 404, nothing written, no version row, no value served — admin and su alike', async () => {
    for (const headers of [ADMIN, SU]) {
      for (const key of ALIASES) {
        const db = world({ rows: ROWS() });
        const r = await PUT(db, key, '0', headers);
        expect([key, r.status, r.body.message]).toEqual([key, 404, 'Setting not found']);
        expect(writes(db)).toEqual([]);
        expect(db.st.versions).toEqual([]);
        expect(r.text).not.toMatch(/SECRET/);
      }
    }
  });

  test('PUT of the unchanged value through an alias does not echo the row either', async () => {
    const db = world({ rows: ROWS() });
    const r = await PUT(db, 'PABBLY_INTERNAL_URL', 'https://hook.example/?k=SECRET-pabbly', ADMIN);
    expect([r.status, r.text]).toEqual([404, expect.not.stringMatching(/SECRET/)]);
  });

  test('restore: 404, nothing written', async () => {
    const db = world({ rows: ROWS(), versions: VERSIONS() });
    for (const key of ['CLOUD_TASKS_ENABLED', 'cloud_tasks_enabled ', 'Firm_Name']) {
      const r = await RESTORE(db, key, key.startsWith('F') ? 2 : 5, ADMIN);
      expect([key, r.status, r.body.message]).toEqual([key, 404, 'Setting not found']);
    }
    expect(writes(db)).toEqual([]);
    expect(db.st.versions).toHaveLength(VERSIONS().length);
  });

  test('history: 404, no versions served', async () => {
    const db = world({ rows: ROWS(), versions: VERSIONS() });
    for (const key of ['CLOUD_TASKS_ENABLED', 'cloud_tasks_enabled ', 'PABBLY_INTERNAL_URL', 'MY_VAR']) {
      const r = await HIST(db, key, ADMIN);
      expect([key, r.status, r.body.message, r.body.versions]).toEqual([key, 404, 'Setting not found', undefined]);
    }
  });

  test('the exact spelling still works on every path', async () => {
    const db = world({ rows: ROWS(), versions: VERSIONS() });
    expect((await PUT(db, 'my_var', 'v2', ADMIN)).status).toBe(200);
    expect((await HIST(db, 'my_var', ADMIN)).body.versions).toHaveLength(2);
    expect((await RESTORE(db, 'cloud_tasks_enabled', 5, IT)).body.setting.value).toBe('0');
  });

  test('POST: a key a registered key folds onto → 409 naming the registered spelling and its home; nothing inserted', async () => {
    const cases = [['MAIL_SEND_DAILY_BUDGET', 'mail_send_daily_budget', 'YisraCase Config → System'],   // registered, no row
      ['Cloud_Tasks_Enabled', 'cloud_tasks_enabled', 'YisraCase Config → System'],
      ['FIRM_NAME', 'firm_name', 'YisraCase Config → Firm'],
      ['Quo_Api_Key', 'quo_api_key', 'the SU db console']];
    for (const [key, spelling, home] of cases) {
      const db = world({ rows: ROWS() });
      const r = await POST(db, { key, value: '1' });
      expect([key, r.status, r.body.message]).toEqual([key, 409,
        `"${key}" is the registered setting "${spelling}" (setting keys ignore case) — change it in ${home}`]);
      expect(writes(db)).toEqual([]);
    }
  });

  test('POST: an unregistered key an existing variable folds onto → 409 already exists (the DB\'s unique key)', async () => {
    const db = world({ rows: ROWS() });
    const r = await POST(db, { key: 'My_Var', value: 'x' });
    expect([r.status, r.body.message]).toEqual([409, 'Setting "My_Var" already exists']);
    expect(db.st.rows.get('my_var').value).toBe('hello');
  });
});
