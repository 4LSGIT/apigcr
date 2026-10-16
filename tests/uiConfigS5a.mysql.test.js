// tests/uiConfigS5a.mysql.test.js
//
/**
 * Users' own buttons ("My buttons") on REAL MySQL — ui-customization arc S5a
 * (routes/api.uiConfig.js → services/uiConfigService.js → lib/uiConfigShape.js).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3391/yc_ui5a_test npx jest tests/uiConfigS5a.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * ui_config, ui_config_versions, jwt_api_audit_log and users in it — give it
 * its own database. Prod's RELAXED sql_mode — asserted.
 *
 * WHAT IS LOCKED
 *   - A user's `items`: PUT by any staff user into their OWN row (another
 *     user's row untouched), delivered by GET /api/ui-config and readFor (the
 *     /api/firm-data `ui` read); a re-PUT of the same document after MySQL
 *     re-ordered its keys is a no-op; never versioned; a bad document is a 400
 *     that stores nothing.
 *   - The retired-id lifecycle, end to end: deleting a button retires its id
 *     in that user's row; re-adding that id is a 400 that writes nothing; a
 *     client's own `retired` is dropped; another user may use the same id
 *     (retired is per user); the user's layout and shortcuts may name a
 *     button (user: refs) and a deleted button's references, gone from the
 *     documents, can never re-point.
 *   - The pickers read: any staff user, keys and titles only.
 */
'use strict';

process.env.JWT_SECRET = 'ui-config-s5a-mysql-secret';
process.env.INTERNAL_API_KEY = 'yci_ui_config_s5a_mysql_internal';   // secret-scan: allow

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

d('S5a: users\' own buttons on real MySQL', () => {
  let pool, server, base;
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    for (const t of ['ui_config_versions', 'ui_config', 'jwt_api_audit_log', 'users', 'tools', 'report_definitions']) await q(`DROP TABLE IF EXISTS \`${t}\``);
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
    // the two tables pickers() reads — only the columns it touches, plus the html / sql it must never return
    await q('CREATE TABLE tools (id int NOT NULL AUTO_INCREMENT PRIMARY KEY, tool_key varchar(80) NOT NULL, title varchar(200) DEFAULT NULL, status varchar(20) NOT NULL, html mediumtext) ENGINE=InnoDB');
    await q("INSERT INTO tools (tool_key, title, status, html) VALUES ('clio-code', 'Get Clio Code', 'live', '<script>secret tool html</script>'), ('draft-one', 'Draft', 'draft', 'x')");
    await q('CREATE TABLE report_definitions (id int NOT NULL AUTO_INCREMENT PRIMARY KEY, report_key varchar(60) NOT NULL, title varchar(200) DEFAULT NULL, kind varchar(20) NOT NULL, is_active tinyint NOT NULL DEFAULT 1, sql_text text) ENGINE=InnoDB');
    await q("INSERT INTO report_definitions (report_key, title, kind, is_active, sql_text) VALUES ('lead_followups', 'Leads', 'view', 1, 'SELECT secret'), ('old_view', 'Old', 'view', 0, 'x'), ('a_report', 'R', 'report', 1, 'x')");
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

  const USERS = { staff: [['staff'], 9], dana: [['attorney'], 11], admin: [['admin', 'staff'], 1] };
  const tok = (who) => 'Bearer ' + jwt.sign(
    { sub: USERS[who][1], username: who, user_type: 1, user_auth: 'authorized', roles: USERS[who][0], aud: 'staff' },
    process.env.JWT_SECRET, { expiresIn: '5m' });
  async function hit(method, url, who, body) {
    const headers = { 'content-type': 'application/json' };
    if (who) headers.authorization = tok(who);
    const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = {}; try { json = JSON.parse(text); } catch (_) { /* text */ }
    return { status: r.status, body: json, text };
  }
  const parse = (c) => (typeof c === 'string' ? JSON.parse(c) : c);
  const row = async (uid, key = 'items') => {
    const [r] = await q("SELECT config FROM ui_config WHERE scope = 'user' AND user_id = ? AND config_key = ?", [uid, key]);
    return r ? parse(r.config) : null;
  };
  const putItems = (who, config) => hit('PUT', '/api/ui-config', who, { scope: 'user', config_key: 'items', config });

  // keys in an order MySQL will not keep
  const BTN = (id, label = 'Button') => ({ action: { present: 'modal', key: 'lead_followups', type: 'view' }, icon: 'star', label, id });
  const NORM = (id, label = 'Button') => ({ id, label, icon: 'star', action: { type: 'view', key: 'lead_followups', present: 'modal' } });

  test('relaxed sql_mode, like prod', async () => {
    const [[m]] = await pool.query('SELECT @@SESSION.sql_mode m');
    expect(m.m).not.toMatch(/STRICT_TRANS_TABLES|STRICT_ALL_TABLES|ONLY_FULL_GROUP_BY|NO_BACKSLASH_ESCAPES/);
  });

  test('a staff user saves their own buttons: their row only, delivered by GET and readFor, never versioned', async () => {
    const r = await putItems('staff', { items: [BTN('user:leads', 'My leads'), BTN('user:court', 'Court')] });
    expect([r.status, r.body.changed, r.body.versioned]).toEqual([200, true, false]);
    expect(await row(9)).toEqual({ items: [NORM('user:leads', 'My leads'), NORM('user:court', 'Court')] });
    expect(await row(11)).toBe(null);
    expect((await hit('GET', '/api/ui-config', 'staff')).body.user.items).toEqual({ items: [NORM('user:leads', 'My leads'), NORM('user:court', 'Court')] });
    expect((await svc.readFor(pool, 9)).user.items.items.map((i) => i.id)).toEqual(['user:leads', 'user:court']);
    expect((await svc.readFor(pool, 11)).user).toEqual({});
    expect((await q('SELECT COUNT(*) n FROM ui_config_versions'))[0].n).toBe(0);
  });

  test('re-PUT of the same document (MySQL re-ordered its keys) is a no-op', async () => {
    const r = await putItems('staff', { items: [BTN('user:leads', 'My leads'), BTN('user:court', 'Court')] });
    expect([r.status, r.body.changed]).toEqual([200, false]);
  });

  test('a bad document is a 400 that stores nothing (tab, a shell-only link, http:, a firm id, 51 buttons)', async () => {
    const before = await row(9);
    const bad = [
      { items: [{ ...BTN('user:x'), action: { type: 'view', key: 'lead_followups', present: 'tab' } }] },
      { items: [{ ...BTN('user:x'), action: { type: 'url', href: '/tool/clio-code', present: 'window' } }] },
      { items: [{ ...BTN('user:x'), action: { type: 'url', href: 'http://x.example/', present: 'window' } }] },
      { items: [BTN('firm:x')] },
      { items: Array.from({ length: 51 }, (_, i) => BTN('user:b' + i)) },
    ];
    for (const config of bad) {
      const r = await putItems('staff', config);
      expect(r.status).toBe(400);
      expect(r.body.errors.length).toBeGreaterThan(0);
    }
    expect(await row(9)).toEqual(before);
  });

  test('the retired lifecycle: delete → retired in the row; re-add → 400, nothing written; a client\'s retired is dropped', async () => {
    const del = await putItems('staff', { items: [BTN('user:court', 'Court')] });
    expect(del.body.config).toEqual({ items: [NORM('user:court', 'Court')], retired: ['user:leads'] });
    expect(await row(9)).toEqual({ items: [NORM('user:court', 'Court')], retired: ['user:leads'] });

    const again = await putItems('staff', { items: [BTN('user:court', 'Court'), BTN('user:leads', 'Leads again')] });
    expect([again.status, again.body.message]).toEqual([400, expect.stringMatching(/user:leads belonged to a deleted item and is retired/)]);
    expect(await row(9)).toEqual({ items: [NORM('user:court', 'Court')], retired: ['user:leads'] });

    const shrink = await putItems('staff', { items: [BTN('user:court', 'Court'), BTN('user:new', 'New')], retired: [] });
    expect(shrink.body.config.retired).toEqual(['user:leads']);
    const grow = await putItems('staff', { items: [BTN('user:court', 'Court'), BTN('user:new', 'New')], retired: ['user:leads', 'user:zzz'] });
    expect([grow.body.changed, grow.body.config.retired]).toEqual([false, ['user:leads']]);

    const both = await putItems('staff', { items: [] });
    expect(both.body.config.retired).toEqual(['user:leads', 'user:court', 'user:new']);
  });

  test('retired is per user: another user may use the same id', async () => {
    const r = await putItems('dana', { items: [BTN('user:leads', 'Dana leads')] });
    expect(r.status).toBe(200);
    expect(await row(11)).toEqual({ items: [NORM('user:leads', 'Dana leads')] });
    expect((await row(9)).retired).toContain('user:leads');
  });

  test('a user\'s layout and shortcuts may name a button (user: refs)', async () => {
    const lay = await hit('PUT', '/api/ui-config', 'dana', { scope: 'user', config_key: 'layout', config: { placed: { home: [{ item: 'user:leads' }, { item: 'cases' }] } } });
    expect(lay.status).toBe(200);
    const sc = await hit('PUT', '/api/ui-config', 'dana', { scope: 'user', config_key: 'shortcuts', config: { bindings: [{ combo: { ctrl: true, meta: true, alt: false, shift: false, key: 'l' }, id: 'user:leads' }] } });
    expect(sc.status).toBe(200);
    expect((await row(11, 'layout')).placed.home[0]).toEqual({ item: 'user:leads' });
    expect((await row(11, 'shortcuts')).bindings[0].id).toBe('user:leads');
    // the firm document still never names one
    const firm = await hit('PUT', '/api/ui-config', 'admin', { scope: 'firm', config_key: 'registry_overrides', config: { hidden: ['user:leads'] } });
    expect([firm.status, firm.body.errors]).toEqual([400, ['hidden[0]: not an item id']]);
  });

  test('pickers: any staff user — keys and titles only (live tools, active views), never html or sql', async () => {
    for (const who of ['staff', 'dana', 'admin']) {
      const r = await hit('GET', '/api/ui-config/pickers', who);
      expect([who, r.status]).toEqual([who, 200]);
      expect(r.body).toEqual({ status: 'success', tools: [{ key: 'clio-code', title: 'Get Clio Code' }], views: [{ key: 'lead_followups', title: 'Leads' }] });
      expect(r.text).not.toMatch(/secret|script/i);
    }
    const key = await fetch(base + '/api/ui-config/pickers', { headers: { 'x-api-key': process.env.INTERNAL_API_KEY } });
    expect(key.status).toBe(401);
  });
});
