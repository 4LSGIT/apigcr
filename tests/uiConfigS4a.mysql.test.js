// tests/uiConfigS4a.mysql.test.js
//
/**
 * The user layout key and durable retired firm ids on REAL MySQL —
 * ui-customization arc S4a (routes/api.uiConfig.js → services/uiConfigService.js
 * → lib/uiConfigShape.js).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3381/yc_ui4a_test npx jest tests/uiConfigS4a.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * ui_config, ui_config_versions, jwt_api_audit_log and users in it — give it
 * its own database. Prod's RELAXED sql_mode — asserted.
 *
 * WHAT IS LOCKED
 *   - A user's layout: PUT by any staff user into their OWN row, delivered by
 *     GET /api/ui-config and by readFor (the /api/firm-data `ui` read); a
 *     re-PUT of the same document is a no-op after MySQL re-ordered its keys;
 *     a bad document is a 400 that stores nothing; `layout` is not a firm key.
 *   - The retired-id lifecycle, end to end: deleting a firm item retires its
 *     id in the stored row AND its version; re-adding that id is a 400 that
 *     writes nothing; a client's own `retired` is dropped (neither shrinks nor
 *     grows the list); restoring a version brings the very item back and its
 *     id leaves the list (what that restore drops is retired in turn);
 *     deleting it again retires it again.
 */
'use strict';

process.env.JWT_SECRET = 'ui-config-s4a-mysql-secret';
process.env.INTERNAL_API_KEY = 'yci_ui_config_s4a_mysql_internal';   // secret-scan: allow

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

d('S4a: user layouts and retired firm ids on real MySQL', () => {
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
    await q("INSERT INTO users (user, user_name) VALUES (1, 'Alex Admin'), (9, 'Sam Staff'), (11, 'Dana')");
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

  const USERS = { staff: [['staff'], 9], dana: [['staff'], 11], admin: [['admin', 'staff'], 1] };
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

  test('relaxed sql_mode, like prod', async () => {
    const [[m]] = await pool.query('SELECT @@SESSION.sql_mode m');
    expect(m.m).not.toMatch(/STRICT_TRANS_TABLES|STRICT_ALL_TABLES|ONLY_FULL_GROUP_BY|NO_BACKSLASH_ESCAPES/);
  });

  describe('a user\'s layout', () => {
    // keys in an order MySQL will not keep (it stores shortest-key-first)
    const LAYOUT = { removed: { sidebar: ['bills'] }, placed: { sidebar: [{ label: 'Mine' }, { item: 'tasks' }], home: [{ item: 'comms' }, { break: true }, { item: 'firm:payroll' }] } };
    const put = (who, config) => hit('PUT', '/api/ui-config', who, { scope: 'user', config_key: 'layout', config });

    test('stored in the caller\'s own row; delivered by GET and by readFor; never versioned', async () => {
      const r = await put('staff', LAYOUT);
      expect(r.status).toBe(200);
      expect([r.body.changed, r.body.versioned]).toEqual([true, false]);
      const rows = await q("SELECT user_id, config FROM ui_config WHERE scope = 'user' AND config_key = 'layout'");
      expect(rows.map((x) => x.user_id)).toEqual([9]);
      expect(parse(rows[0].config)).toEqual(LAYOUT);
      expect((await hit('GET', '/api/ui-config', 'staff')).body.user.layout).toEqual(LAYOUT);
      expect((await svc.readFor(pool, 9)).user.layout).toEqual(LAYOUT);
      expect((await svc.readFor(pool, 11)).user).toEqual({});      // nobody else's
      expect((await hit('GET', '/api/ui-config', 'dana')).body.user).toEqual({});
      expect(await q('SELECT id FROM ui_config_versions')).toEqual([]);
    });

    test('the same document again is a no-op, whatever order MySQL stored its keys in', async () => {
      const r = await put('staff', { placed: { home: LAYOUT.placed.home, sidebar: LAYOUT.placed.sidebar }, removed: { sidebar: ['bills', 'bills'] } });
      expect([r.status, r.body.changed]).toEqual([200, false]);
    });

    test('a bad document is a 400 with errors, and nothing changes (either scope)', async () => {
      const before = await q("SELECT config FROM ui_config WHERE scope = 'user'");
      const r = await put('staff', { placed: { home: [{ label: 'x' }, { item: 'cases' }, { item: 'cases' }] } });
      expect(r.status).toBe(400);
      expect(r.body.errors).toEqual(expect.arrayContaining([expect.stringMatching(/label is for the sidebar only/), expect.stringMatching(/already placed/)]));
      expect((await put('staff', { removed: ['bills'] })).status).toBe(400);      // the flat form: refused
      expect(await q("SELECT config FROM ui_config WHERE scope = 'user'")).toEqual(before);
      expect((await hit('PUT', '/api/ui-config', 'admin', { scope: 'firm', config_key: 'layout', config: { pages: { 'user:x': {} } } })).status).toBe(400);   // S6c: firm layout is a key; S6c-5: its pages map names firm pages only
    });
  });

  describe('retired firm ids, end to end', () => {
    const ITEM = (id, label) => ({ id, label, icon: 'c', action: { type: 'url', href: `https://example.com/${id.slice(5)}`, present: 'window' } });
    const A = ITEM('firm:a', 'A'), B = ITEM('firm:b', 'B'), C = ITEM('firm:c', 'C');
    const DOC = (items, extra) => ({ hidden: [], locked: [], renames: {}, items, ...extra });
    const put = (config) => hit('PUT', '/api/ui-config', 'admin', { scope: 'firm', config_key: 'registry_overrides', config });
    const row = async () => parse((await q("SELECT config FROM ui_config WHERE scope = 'firm'"))[0].config);
    const versions = async () => (await q('SELECT id, config FROM ui_config_versions ORDER BY id')).map((v) => ({ id: v.id, config: parse(v.config) }));

    test('two items, then one deleted: its id is retired in the row and in the new version', async () => {
      expect((await put(DOC([A, B]))).body.config).toEqual(DOC([A, B]));
      const r = await put(DOC([A]));
      expect(r.status).toBe(200);
      expect(r.body.config.retired).toEqual(['firm:b']);
      expect((await row()).retired).toEqual(['firm:b']);
      const v = await versions();
      expect(v.map((x) => x.config.retired)).toEqual([undefined, ['firm:b']]);
    });

    test('re-adding the retired id is a 400 that writes nothing', async () => {
      const before = [await row(), (await versions()).length];
      const r = await put(DOC([A, ITEM('firm:b', 'B again')]));
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/firm:b belonged to a deleted item and is retired/);
      expect([await row(), (await versions()).length]).toEqual(before);
    });

    test('a client\'s own retired is dropped: [] shrinks nothing (a no-op), extra ids add nothing', async () => {
      const r1 = await put(DOC([A], { retired: [] }));
      expect([r1.status, r1.body.changed]).toEqual([200, false]);
      const r2 = await put(DOC([A, C], { retired: ['firm:zz'] }));
      expect(r2.status).toBe(200);
      expect((await row()).retired).toEqual(['firm:b']);
    });

    test('restoring the version that had B brings the very item back; what the restore drops (C) is retired', async () => {
      const v1 = (await versions())[0];
      expect(v1.config.items.map((i) => i.id)).toEqual(['firm:a', 'firm:b']);
      const r = await hit('POST', `/api/ui-config/versions/${v1.id}/restore`, 'admin', {});
      expect(r.status).toBe(200);
      expect(r.body.config.items).toEqual([A, B]);
      expect((await row()).retired).toEqual(['firm:c']);
      // …and deleting B again retires it again
      expect((await put(DOC([A]))).body.config.retired).toEqual(['firm:c', 'firm:b']);
      expect((await svc.readFor(pool, 1)).firm.registry_overrides.retired).toEqual(['firm:c', 'firm:b']);
    });
  });
});
