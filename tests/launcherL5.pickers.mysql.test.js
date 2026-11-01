// tests/launcherL5.pickers.mysql.test.js
//
/**
 * launcher-nits L5 — tools.visible_to on REAL MySQL, through the real routes
 * (routes/api.tools.js, routes/api.uiConfig.js → uiConfigService.pickers).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3391/yc_l5_test npx jest tests/launcherL5.pickers.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates the
 * tables it names in beforeAll. Prod's RELAXED sql_mode — asserted.
 *
 * WHAT IS LOCKED
 *   - The picker, role by role (Fred's rulings 2026-10-28 and 2026-11-01): NULL
 *     is everyone, a list is those roles, a role nobody ticked never sees it,
 *     [] is no role; holders of firm.settings (su, admin, IT) see every tool.
 *   - The column as mysql2 reads it: a real JSON array, and a real SQL NULL
 *     from a null write (not a JSON null) — a Date-vs-string class of bug is
 *     exactly what a mocked query cannot catch.
 *   - The routes that write it, through the SU chain with step-up.
 *   - A button already made keeps working: its tool stays out of `tools`, is in
 *     that user's `held` with its title, the user's items still save, and
 *     /tool/<key> still serves. Nobody else's `held` names it.
 *   - Picker only: nothing is refused at save or at serve.
 */
'use strict';

process.env.JWT_SECRET = 'launcher-l5-mysql-secret';
process.env.INTERNAL_API_KEY = 'yci_launcher_l5_mysql_internal';   // secret-scan: allow

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const express = require('express');
const jwt = require('jsonwebtoken');
const { mintElevationToken, _resetRateLimits } = require('../lib/auth.superuser');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const MIG = (f) => path.join(__dirname, '..', 'ref', 'migrations', f);
const statements = (f) => fs.readFileSync(MIG(f), 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
  .split(/;\s*$/m).map((x) => x.trim()).filter(Boolean);

d('tools.visible_to on real MySQL', () => {
  let pool, server, base;
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  const USERS = {
    staff: [['staff'], 9], attorney: [['attorney'], 11], formdev: [['form_dev'], 12], none: [[], 13],
    admin: [['admin'], 1], it: [['it'], 5], su: [['su'], 6],
  };
  const tok = (who) => 'Bearer ' + jwt.sign(
    { sub: USERS[who][1], username: who, user_type: 1, user_auth: 'authorized', roles: USERS[who][0], aud: 'staff' },
    process.env.JWT_SECRET, { expiresIn: '5m' });
  async function hit(method, url, who, body, extra) {
    const headers = { 'content-type': 'application/json', ...(extra || {}) };
    if (who) headers.authorization = tok(who);
    const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* html */ }
    return { status: r.status, text, body: json };
  }
  const su = (method, url, body) => hit(method, url, 'su', body, { 'x-su-elevation': mintElevationToken(6) });
  const offered = async (who) => {
    const r = await hit('GET', '/api/ui-config/pickers', who);
    expect([who, r.status]).toEqual([who, 200]);
    return { tools: r.body.tools.map((t) => t.key), held: r.body.held.map((t) => t.key), raw: r };
  };
  const setVisible = (key, v) => q('UPDATE tools SET visible_to = ? WHERE tool_key = ?', [v === null ? null : JSON.stringify(v), key]);
  const button = (id, key) => ({ id, label: id, icon: 'wrench', action: { type: 'tool', key, present: 'modal' } });
  const putItems = (who, items) => hit('PUT', '/api/ui-config', who, { scope: 'user', config_key: 'items', config: { items } });

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    const [[{ m }]] = await pool.query('SELECT @@sql_mode AS m');
    expect(m).not.toMatch(/STRICT_TRANS_TABLES/);
    for (const t of ['ui_config_versions', 'ui_config', 'jwt_api_audit_log', 'admin_audit_log', 'users', 'tool_versions', 'tools', 'report_definitions']) await q(`DROP TABLE IF EXISTS ${t}`);
    for (const st of statements('2026-10-16_ui_custom_s31_ui_config.sql')) await q(st);
    await q(`CREATE TABLE jwt_api_audit_log (
      id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, route varchar(255) NOT NULL, method varchar(10) NOT NULL,
      headers json DEFAULT NULL, query_params json DEFAULT NULL, body json DEFAULT NULL,
      ip_address varchar(45) DEFAULT NULL, user_agent varchar(255) DEFAULT NULL, auth_type varchar(20) DEFAULT NULL,
      username varchar(255) DEFAULT NULL, auth_status varchar(20) DEFAULT NULL,
      created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`CREATE TABLE admin_audit_log (
      id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, tool varchar(32) NOT NULL, user_id int DEFAULT NULL,
      username varchar(255) DEFAULT NULL, route varchar(255) NOT NULL, method varchar(10) NOT NULL, status varchar(40) NOT NULL,
      error_message text, duration_ms int DEFAULT NULL, ip_address varchar(45) DEFAULT NULL, user_agent varchar(255) DEFAULT NULL,
      details json DEFAULT NULL, created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q('CREATE TABLE users (user tinyint NOT NULL PRIMARY KEY, user_name varchar(100) DEFAULT NULL) ENGINE=InnoDB');
    // The live DDL (SHOW CREATE TABLE, 2026-11-01), then the migration itself.
    await q(`CREATE TABLE tools (
      id int NOT NULL AUTO_INCREMENT, tool_key varchar(80) NOT NULL, title varchar(200) NOT NULL DEFAULT '',
      status enum('draft','live') NOT NULL DEFAULT 'draft', html mediumtext NOT NULL, updated_by varchar(100) DEFAULT NULL,
      created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY tool_key (tool_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    for (const st of statements('2026-11-01_tools_visible_to.sql')) await q(st);
    await q(`CREATE TABLE tool_versions (id int NOT NULL AUTO_INCREMENT PRIMARY KEY, tool_id int NOT NULL, html mediumtext NOT NULL,
      saved_by varchar(100) DEFAULT NULL, saved_at timestamp NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`);
    await q(`CREATE TABLE report_definitions (id int NOT NULL AUTO_INCREMENT PRIMARY KEY, report_key varchar(60) NOT NULL,
      title varchar(200) DEFAULT NULL, kind varchar(20) NOT NULL, is_active tinyint NOT NULL DEFAULT 1) ENGINE=InnoDB`);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.uiConfig'));
    app.use(require('../routes/api.tools'));
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (pool) await pool.end();
  });
  beforeEach(async () => {
    _resetRateLimits();
    await q('DELETE FROM tools');
    await q('DELETE FROM ui_config');
    await q(`INSERT INTO tools (tool_key, title, status, html) VALUES
      ('a-open', 'A Open', 'live', '<p>open</p>'), ('b-staff', 'B Staff', 'live', '<p>staff</p>'),
      ('c-both', 'C Both', 'live', '<p>both</p>'), ('d-nobody', 'D Nobody', 'live', '<p>nobody</p>'),
      ('e-draft', 'E Draft', 'draft', '<p>draft</p>')`);
    await setVisible('b-staff', ['staff']);
    await setVisible('c-both', ['staff', 'attorney']);
    await setVisible('d-nobody', []);
    await setVisible('e-draft', ['staff']);
  });

  const ALL_LIVE = ['a-open', 'b-staff', 'c-both', 'd-nobody'];

  test.each([
    ['staff', ['a-open', 'b-staff', 'c-both']],
    ['attorney', ['a-open', 'c-both']],
    ['formdev', ['a-open']],        // a role nobody ticked
    ['none', ['a-open']],           // no roles at all
    ['admin', ALL_LIVE],            // firm.settings, unticked
    ['it', ALL_LIVE],
    ['su', ALL_LIVE],
  ])('%s is offered the right tools', async (who, want) => {
    const r = await offered(who);
    expect(r.tools).toEqual(want);
    expect(r.held).toEqual([]);
  });

  test('a restricted tool sends neither its key nor its title to someone it does not list for', async () => {
    const { raw } = await offered('formdev');
    expect(raw.text).not.toMatch(/b-staff|B Staff|c-both|C Both|d-nobody|D Nobody/);
  });

  test('mysql2 reads the column as an array, and a null write as a real SQL NULL', async () => {
    const t = (await su('POST', '/api/tools', { tool_key: 'f-new', html: '<p>f</p>', status: 'live', visible_to: ['attorney', 'staff'] })).body.tool;
    expect(t.visible_to).toEqual(['staff', 'attorney']);
    const [[row]] = await pool.query('SELECT visible_to, JSON_TYPE(visible_to) AS jt FROM tools WHERE id = ?', [t.id]);
    expect(row).toEqual({ visible_to: ['staff', 'attorney'], jt: 'ARRAY' });

    const cleared = await su('PATCH', `/api/tools/${t.id}`, { visible_to: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.tool.visible_to).toBeNull();
    const [[nulled]] = await pool.query('SELECT visible_to IS NULL AS isnull FROM tools WHERE id = ?', [t.id]);
    expect(nulled.isnull).toBe(1);
    expect((await offered('formdev')).tools).toContain('f-new');

    const empty = await su('PATCH', `/api/tools/${t.id}`, { visible_to: [] });
    expect(empty.body.tool.visible_to).toEqual([]);
    expect((await offered('staff')).tools).not.toContain('f-new');
    expect((await offered('admin')).tools).toContain('f-new');
  });

  test('the list route and the audit row carry it; a PATCH of it alone leaves the html and the history', async () => {
    const [[before]] = await pool.query("SELECT id FROM tools WHERE tool_key = 'a-open'");
    const r = await su('PATCH', `/api/tools/${before.id}`, { visible_to: ['attorney'] });
    expect(r.body.tool.html).toBe('<p>open</p>');
    expect(await q('SELECT id FROM tool_versions WHERE tool_id = ?', [before.id])).toEqual([]);
    const list = await su('GET', '/api/tools');
    expect(list.body.tools.find((t) => t.tool_key === 'a-open').visible_to).toEqual(['attorney']);
    expect(list.body.tools.find((t) => t.tool_key === 'b-staff').visible_to).toEqual(['staff']);
    const [audit] = await q("SELECT details FROM admin_audit_log WHERE tool = 'tools' ORDER BY id DESC LIMIT 1");
    expect(audit.details).toMatchObject({ action: 'update', fields: ['visible_to'] });
  });

  test('a button made before the restriction keeps its title, for its owner alone, and keeps working', async () => {
    await setVisible('b-staff', null);
    expect((await putItems('formdev', [button('user:b', 'b-staff')])).status).toBe(200);
    await setVisible('b-staff', ['staff']);

    const mine = await offered('formdev');
    expect(mine.tools).toEqual(['a-open']);
    expect(mine.raw.body.held).toEqual([{ key: 'b-staff', title: 'B Staff' }]);
    expect((await offered('attorney')).held).toEqual([]);

    // the whole document re-saves with the restricted tool in it, and the tool still opens
    expect((await putItems('formdev', [button('user:b', 'b-staff'), button('user:a', 'a-open')])).status).toBe(200);
    const page = await hit('GET', '/tool/b-staff', null);
    expect([page.status, page.text]).toEqual([200, '<p>staff</p>']);
  });

  test('held names only live tools the caller is not offered', async () => {
    expect((await putItems('formdev', [button('user:o', 'a-open'), button('user:d', 'e-draft'), button('user:g', 'gone')])).status).toBe(200);
    const r = await offered('formdev');
    expect(r.tools).toEqual(['a-open']);
    expect(r.held).toEqual([]);
  });

  test('picker only: a restricted tool can still be saved on a new button and opened, by anyone', async () => {
    expect((await putItems('formdev', [button('user:n', 'd-nobody')])).status).toBe(200);
    expect((await hit('GET', '/tool/d-nobody', null)).status).toBe(200);
  });

  test('a hand-written value that is not a list fails closed for a plain role, and firm settings still see it', async () => {
    await q(`UPDATE tools SET visible_to = '"staff"' WHERE tool_key = 'a-open'`);
    expect((await offered('staff')).tools).not.toContain('a-open');
    expect((await offered('admin')).tools).toContain('a-open');
  });
});
