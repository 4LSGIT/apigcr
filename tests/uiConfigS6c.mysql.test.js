// tests/uiConfigS6c.mysql.test.js
//
/**
 * The firm's default `layout` key on REAL MySQL — ui-customization arc S6c-2
 * (routes/api.uiConfig.js → services/uiConfigService.js → lib/uiConfigShape.js).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3391/yc_ui6c_test npx jest tests/uiConfigS6c.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * ui_config, ui_config_versions, jwt_api_audit_log and users in it — give it
 * its own database. Prod's RELAXED sql_mode — asserted.
 *
 * WHAT IS LOCKED
 *   - A firm layout: PUT by a firm.settings holder into the firm row (user_id
 *     0), versioned in ui_config_versions, delivered by GET /api/ui-config
 *     (firm.layout, firm_versions.layout) and by readFor (the /api/firm-data
 *     `ui` read); staff get 403; a stale base is a 409 that writes nothing and
 *     appends no version; the same document again (MySQL re-ordered its keys)
 *     is a no-op; versions list and restore work for this key exactly as for
 *     registry_overrides; a user's page in the firm's `pages` (S6c-5) and a
 *     removal of `all` from Home's icon row are 400s that store nothing.
 *   - A user's layout carrying homeIcons round-trips.
 */
'use strict';

process.env.JWT_SECRET = 'ui-config-s6c-mysql-secret';
process.env.INTERNAL_API_KEY = 'yci_ui_config_s6c_mysql_internal';   // secret-scan: allow

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const express = require('express');
const jwt = require('jsonwebtoken');
const svc = require('../services/uiConfigService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const ROOT = path.join(__dirname, '..');
const MIGRATION = path.join(ROOT, 'ref', 'migrations', '2026-10-16_ui_custom_s31_ui_config.sql');

d('S6c: the firm default layout on real MySQL', () => {
  let pool, server, base;
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    for (const t of ['ui_config_versions', 'ui_config', 'jwt_api_audit_log', 'users']) await q(`DROP TABLE IF EXISTS \`${t}\``);
    const stmts = fs.readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !/^--/.test(l)).join('\n')
      .split(/;\s*$/m).map((x) => x.trim()).filter(Boolean);
    for (const st of stmts) await q(st);
    await q(`CREATE TABLE jwt_api_audit_log (
      id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, route varchar(255) NOT NULL, method varchar(10) NOT NULL,
      headers json DEFAULT NULL, query_params json DEFAULT NULL, body json DEFAULT NULL,
      ip_address varchar(45) DEFAULT NULL, user_agent varchar(255) DEFAULT NULL, auth_type varchar(20) DEFAULT NULL,
      username varchar(255) DEFAULT NULL, auth_status varchar(20) DEFAULT NULL,
      created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q('CREATE TABLE users (user tinyint NOT NULL PRIMARY KEY, user_name varchar(100) DEFAULT NULL) ENGINE=InnoDB');
    await q("INSERT INTO users (user, user_name) VALUES (1, 'Alex Admin'), (9, 'Sam Staff')");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.uiConfig'));
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (pool) await pool.end();
  });

  const USERS = { staff: [['staff'], 9], admin: [['admin', 'staff'], 1] };
  const tok = (who) => 'Bearer ' + jwt.sign(
    { sub: USERS[who][1], username: who, user_type: 1, user_auth: 'authorized', roles: USERS[who][0], aud: 'staff' },
    process.env.JWT_SECRET, { expiresIn: '5m' });
  async function hit(method, url, who, body) {
    const headers = { 'content-type': 'application/json' };
    if (who) headers.authorization = tok(who);
    const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = {}; try { json = JSON.parse(text); } catch (_) { /* text */ }
    return { status: r.status, body: json };
  }
  const parse = (c) => (typeof c === 'string' ? JSON.parse(c) : c);
  const row = async () => { const r = await q("SELECT user_id, config FROM ui_config WHERE scope = 'firm' AND config_key = 'layout'"); return r.length ? { user_id: r[0].user_id, config: parse(r[0].config) } : null; };
  const versions = async () => (await q("SELECT id, config_key, config FROM ui_config_versions ORDER BY id")).map((v) => ({ id: v.id, config_key: v.config_key, config: parse(v.config) }));
  const put = (who, config, extra = {}) => hit('PUT', '/api/ui-config', who, { scope: 'firm', config_key: 'layout', config, ...extra });

  // keys in an order MySQL will not keep (it stores shortest-key-first)
  const V1 = { removed: { sidebar: ['adminDbConsole'] }, placed: { home: [{ item: 'moreReports' }, { break: true }, { item: 'firm:clio-code' }], homeIcons: [{ item: 'casey' }, { item: 'myTasks' }] } };
  const V2 = { placed: { home: [{ item: 'moreManuals' }], sidebar: [{ item: 'logout' }] }, removed: {} };
  // the hubs' lists (launcher-nits C4 retired the surfaces): the live firm layout and its older versions carry them
  const HUBS = { more: [{ item: 'moreReports' }, { break: true }, { item: 'moreViews' }], moreIcons: [{ item: 'casey' }], admin: [{ item: 'adminUsers' }], adminIcons: [] };

  test('relaxed sql_mode, like prod', async () => {
    const [[m]] = await pool.query('SELECT @@SESSION.sql_mode m');
    expect(m.m).not.toMatch(/STRICT_TRANS_TABLES|STRICT_ALL_TABLES|ONLY_FULL_GROUP_BY|NO_BACKSLASH_ESCAPES/);
  });

  test('staff: 403, nothing written; admin: the firm row (user_id 0), ONE version, version_id in the response', async () => {
    expect((await put('staff', V1)).status).toBe(403);
    expect(await row()).toBeNull();
    const r = await put('admin', V1);
    expect(r.status).toBe(200);
    expect([r.body.changed, r.body.versioned, typeof r.body.version_id]).toEqual([true, true, 'number']);
    expect(r.body.config).toEqual(V1);
    expect(await row()).toEqual({ user_id: 0, config: V1 });
    const v = await versions();
    expect(v.map((x) => [x.config_key, x.id])).toEqual([['layout', r.body.version_id]]);
    expect(v[0].config).toEqual(V1);
  });

  test('delivered: GET /api/ui-config firm.layout + firm_versions.layout (firm.settings holders), readFor (the firm-data read); staff see the layout, not the versions', async () => {
    const head = (await versions()).slice(-1)[0].id;
    const a = await hit('GET', '/api/ui-config', 'admin');
    expect(a.body.firm.layout).toEqual(V1);
    expect(a.body.firm_versions).toEqual({ registry_overrides: null, layout: head });
    const s = await hit('GET', '/api/ui-config', 'staff');
    expect(s.body.firm.layout).toEqual(V1);
    expect(s.body).not.toHaveProperty('firm_versions');
    expect((await svc.readFor(pool, 9)).firm.layout).toEqual(V1);
  });

  test('the same document again (MySQL\'s key order) is a no-op; a stale base is a 409 that writes nothing; the newest base passes and versions', async () => {
    const head = (await versions()).slice(-1)[0].id;
    const same = await put('admin', { placed: { homeIcons: [{ item: 'casey' }, { item: 'myTasks' }], home: V1.placed.home }, removed: { sidebar: ['adminDbConsole'] } }, { base: head });
    expect([same.status, same.body.changed, same.body.versioned, same.body.version_id]).toEqual([200, false, false, head]);
    const stale = await put('admin', V2, { base: head + 100 });   // a version id that is not the newest (0 would fail the envelope, 400)
    expect(stale.status).toBe(409);
    expect(stale.body.message).toBe(svc.CONFLICT_MSG);
    expect(await row()).toEqual({ user_id: 0, config: V1 });
    expect((await versions()).length).toBe(1);
    const r = await put('admin', V2, { base: head });
    expect([r.status, r.body.changed, r.body.versioned, r.body.version_id]).toEqual([200, true, true, head + 1]);
    expect((await row()).config).toEqual(V2);
    expect((await hit('GET', '/api/ui-config', 'admin')).body.firm_versions.layout).toBe(head + 1);
  });

  test('versions: the list for config_key=layout, newest first; a view; restore brings V1 back as a NEW version (one more row)', async () => {
    const list = await hit('GET', '/api/ui-config/versions?config_key=layout', 'admin');
    expect(list.status).toBe(200);
    expect(list.body.versions.map((v) => v.is_current)).toEqual([true, false]);
    const v1 = list.body.versions[1];
    const view = await hit('GET', `/api/ui-config/versions/${v1.id}`, 'admin');
    expect([view.status, view.body.version.config_key, view.body.version.config]).toEqual([200, 'layout', V1]);
    const r = await hit('POST', `/api/ui-config/versions/${v1.id}/restore`, 'admin', { base: list.body.versions[0].id });
    expect([r.status, r.body.changed, r.body.versioned, r.body.restored_from]).toEqual([200, true, true, v1.id]);
    expect((await row()).config).toEqual(V1);
    expect((await versions()).map((v) => v.config)).toEqual([V1, V2, V1]);
    expect((await hit('GET', '/api/ui-config/versions?config_key=registry_overrides', 'admin')).body.versions).toEqual([]);   // its own key only
  });

  test('launcher-nits C4: a stored layout and a History version that still carry the hubs\' lists — read as stored (History shows them), dropped on any write: a resave, a restore', async () => {
    const head = (await versions()).slice(-1)[0].id;
    const OLD = { placed: { ...HUBS, home: [{ item: 'cases' }] }, removed: { admin: ['adminScratch'] }, pages: { 'firm:more': { tiles: [{ item: 'moreReports' }] } } };
    const LIVE = { placed: { home: [{ item: 'cases' }] }, removed: {}, pages: OLD.pages };
    // as production's: written before C4, so the rows hold them
    await q("UPDATE ui_config SET config = ? WHERE scope = 'firm' AND config_key = 'layout'", [JSON.stringify(OLD)]);
    const ins = await q("INSERT INTO ui_config_versions (ui_config_id, config_key, config, saved_by) SELECT id, 'layout', ?, 1 FROM ui_config WHERE scope = 'firm' AND config_key = 'layout'", [JSON.stringify(OLD)]);
    expect(ins.affectedRows).toBe(1);
    const vOld = ins.insertId;
    expect((await row()).config).toEqual(OLD);
    expect((await hit('GET', '/api/ui-config', 'admin')).body.firm.layout).toEqual(OLD);   // the client ignores what it does not draw
    const view = await hit('GET', `/api/ui-config/versions/${vOld}`, 'admin');
    expect([view.status, view.body.version.config]).toEqual([200, OLD]);                 // History shows what was saved
    // resaving the same document (an editor's Save with nothing changed) stores it WITHOUT them
    const r = await put('admin', OLD, { base: vOld });
    expect([r.status, r.body.changed, r.body.config]).toEqual([200, true, LIVE]);
    expect((await row()).config).toEqual(LIVE);
    // restoring the old version brings back what is live in it, not the hubs' lists
    const back = await hit('POST', `/api/ui-config/versions/${head}/restore`, 'admin', { base: r.body.version_id });
    expect(back.status).toBe(200);
    const again = await hit('POST', `/api/ui-config/versions/${vOld}/restore`, 'admin', { base: back.body.version_id });
    expect([again.status, again.body.restored_from]).toEqual([200, vOld]);
    expect((await row()).config).toEqual(LIVE);
  });

  test('refused and unstored: a user page in the firm\'s pages; a removal of all from Home\'s icon row; a user id in a firm list', async () => {
    const before = [await row(), (await versions()).length];
    for (const bad of [{ pages: { 'user:x': {} } }, { removed: { homeIcons: ['all'] } }, { placed: { home: [{ item: 'user:x' }] } }, { placed: { homeIcons: Array.from({ length: 13 }, (_, i) => ({ item: 'i' + i })) } }]) {
      const r = await put('admin', bad);
      expect([bad, r.status, Array.isArray(r.body.errors)]).toEqual([bad, 400, true]);
    }
    expect([await row(), (await versions()).length]).toEqual(before);
  });

  test('a user\'s layout with homeIcons round-trips into their own row, never versioned', async () => {
    const LAYOUT = { placed: { homeIcons: [{ item: 'myTasks' }, { item: 'all' }], home: [{ item: 'comms' }] }, removed: { sidebar: ['all'] } };
    const r = await hit('PUT', '/api/ui-config', 'staff', { scope: 'user', config_key: 'layout', config: LAYOUT });
    expect([r.status, r.body.changed, r.body.versioned]).toEqual([200, true, false]);
    expect((await hit('GET', '/api/ui-config', 'staff')).body.user.layout).toEqual(LAYOUT);
    expect((await svc.readFor(pool, 9)).user.layout).toEqual(LAYOUT);
    expect((await versions()).length).toBe(7);   // + the C4 test's inserted old version and its three writes
    const bad = await hit('PUT', '/api/ui-config', 'staff', { scope: 'user', config_key: 'layout', config: { placed: { more: [] } } });
    expect(bad.status).toBe(400);
  });
});
