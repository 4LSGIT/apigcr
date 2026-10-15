// tests/uiConfig.mysql.test.js
//
/**
 * ui_config on REAL MySQL — ui-customization arc S3.1
 * (ref/migrations/2026-10-16_ui_custom_s31_ui_config.sql; routes/api.uiConfig.js
 * through services/uiConfigService.js).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3341/yc_ui31_test npx jest tests/uiConfig.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * ui_config, ui_config_versions and jwt_api_audit_log in it. Run it against a
 * server with prod's RELAXED sql_mode (no STRICT_TRANS_TABLES) — asserted.
 *
 * WHAT IS LOCKED
 *   - The migration file applies clean, and again as a no-op; the shapes the
 *     COMMENTs promise (signed tinyint user_id NOT NULL DEFAULT 0, role ''
 *     sentinel, the UNIQUE, the cascading FK).
 *   - Relaxed mode really stores a bad ENUM as '' (the app is the validator).
 *   - The UNIQUE refuses a duplicate FIRM row (the sentinels are why); the
 *     upsert lands on the one row; deleting a ui_config row cascades its versions.
 *   - The auth matrix end to end: firm PUT without firm.settings 403, with it
 *     200 (admin / it / su); user PUT writes only the caller's row and refuses a
 *     body user_id; API keys 401 on GET and PUT.
 *   - Versions: one row per firm CHANGE holding the new document (newest ==
 *     current); none for a key-reordered resubmission; none ever for user writes.
 *   - Concurrent first-ever saves of one row (user and firm scope): the deadlock
 *     retry keeps ER_LOCK_DEADLOCK from the caller; one row; versions = writers.
 */
'use strict';

process.env.JWT_SECRET = 'ui-config-s31-mysql-secret';
process.env.INTERNAL_API_KEY = 'yci_ui_config_s31_mysql_internal';   // secret-scan: allow

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const express = require('express');
const jwt = require('jsonwebtoken');
const svc = require('../services/uiConfigService');
const { canonical } = require('../lib/uiConfigShape');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-10-16_ui_custom_s31_ui_config.sql');

d('ui_config on real MySQL', () => {
  let pool, server, base;
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  // The file's statements, one at a time (SHOW WARNINGS covers only the last
  // statement run): comment lines dropped, split where a line ends in ';'.
  async function applyMigration() {
    const stmts = fs.readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !/^--/.test(l)).join('\n')
      .split(/;\s*$/m).map((x) => x.trim()).filter(Boolean);
    expect(stmts.map((x) => x.split('(')[0].trim())).toEqual(
      ['CREATE TABLE IF NOT EXISTS ui_config', 'CREATE TABLE IF NOT EXISTS ui_config_versions']);
    const conn = await mysql.createConnection({ uri: URL_ });
    const warnings = [];
    try {
      for (const st of stmts) {
        await conn.query(st);
        const [w] = await conn.query('SHOW WARNINGS');
        warnings.push(...w);
      }
      return warnings;
    } finally { await conn.end(); }
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    for (const t of ['ui_config_versions', 'ui_config', 'jwt_api_audit_log']) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q(`CREATE TABLE jwt_api_audit_log (
      id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, route varchar(255) NOT NULL, method varchar(10) NOT NULL,
      headers json DEFAULT NULL, query_params json DEFAULT NULL, body json DEFAULT NULL,
      ip_address varchar(45) DEFAULT NULL, user_agent varchar(255) DEFAULT NULL, auth_type varchar(20) DEFAULT NULL,
      username varchar(255) DEFAULT NULL, auth_status varchar(20) DEFAULT NULL,
      created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
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

  const tok = (roles, sub) => 'Bearer ' + jwt.sign(
    { sub, username: 'u' + sub, user_type: 1, user_auth: 'authorized', roles, aud: 'staff' }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const USERS = { staff: [['staff'], 9], dana: [['staff', 'attorney'], 11], admin: [['admin', 'staff'], 1], it: [['it'], 5], su: [['su'], 6] };
  async function hit(method, who, body, extra = {}) {
    const headers = { 'content-type': 'application/json', ...extra };
    if (who) headers.authorization = tok(...USERS[who]);
    const r = await fetch(base + '/api/ui-config', { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = {}; try { json = JSON.parse(await r.text()); } catch (_) { /* text */ }
    return { status: r.status, body: json };
  }
  const firmPut = (who, config) => hit('PUT', who, { scope: 'firm', config_key: 'registry_overrides', config });
  const userPut = (who, config, extra = {}) => hit('PUT', who, { scope: 'user', config_key: 'shortcuts', config, ...extra });
  const rows = () => q('SELECT id, scope, user_id, role, config_key, config, updated_by FROM ui_config ORDER BY id');
  const versions = () => q('SELECT ui_config_id, config_key, config, saved_by FROM ui_config_versions ORDER BY id');

  // ── the migration ─────────────────────────────────────────────────────────

  test('relaxed sql_mode, like prod (no STRICT_TRANS_TABLES / ONLY_FULL_GROUP_BY / NO_BACKSLASH_ESCAPES)', async () => {
    const [[m]] = await pool.query('SELECT @@SESSION.sql_mode m');
    expect(m.m).not.toMatch(/STRICT_TRANS_TABLES|STRICT_ALL_TABLES|ONLY_FULL_GROUP_BY|NO_BACKSLASH_ESCAPES/);
  });

  test('the migration applies clean, then again as a no-op', async () => {
    expect(await applyMigration()).toEqual([]);
    const again = await applyMigration();
    expect(again.map((w) => w.Code)).toEqual([1050, 1050]);            // "table already exists" notes only
    const [[c]] = await pool.query('SHOW CREATE TABLE ui_config');
    const ddl = c['Create Table'];
    expect(ddl).toMatch(/`user_id` tinyint NOT NULL DEFAULT '0'/);
    expect(ddl).toMatch(/`role` varchar\(20\)( COLLATE \w+)? NOT NULL DEFAULT ''/);
    expect(ddl).toMatch(/`scope` enum\('system','firm','user'\)/);
    expect(ddl).toMatch(/`updated_by` tinyint DEFAULT NULL/);
    expect(ddl).toMatch(/UNIQUE KEY `uq_ui_config_scope` \(`scope`,`user_id`,`role`,`config_key`\)/);
    const [[v]] = await pool.query('SHOW CREATE TABLE ui_config_versions');
    expect(v['Create Table']).toMatch(/FOREIGN KEY \(`ui_config_id`\) REFERENCES `ui_config` \(`id`\) ON DELETE CASCADE/);
    expect(v['Create Table']).toMatch(/`saved_by` tinyint DEFAULT NULL/);
  });

  test('relaxed mode: a bad ENUM is stored as \'\' with a warning, not refused — the app is the validator', async () => {
    const conn = await pool.getConnection();
    try {
      await conn.query("INSERT INTO ui_config (scope, config_key, config) VALUES ('bogus', 'x', '{}')");
      const [w] = await conn.query('SHOW WARNINGS');
      expect(w.map((x) => x.Code)).toEqual([1265]);
      const [[r]] = await conn.query("SELECT scope FROM ui_config WHERE config_key = 'x'");
      expect(r.scope).toBe('');
      await conn.query("DELETE FROM ui_config WHERE config_key = 'x'");
    } finally { conn.release(); }
  });

  test('the UNIQUE refuses a duplicate FIRM row (the 0 / \'\' sentinels); the upsert lands on the one row', async () => {
    await q("INSERT INTO ui_config (scope, user_id, role, config_key, config) VALUES ('firm', 0, '', 'k', '{}')");
    await expect(q("INSERT INTO ui_config (scope, config_key, config) VALUES ('firm', 'k', '{}')"))
      .rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    const [r] = await pool.query(
      "INSERT INTO ui_config (scope, user_id, role, config_key, config) VALUES ('firm', 0, '', 'k', '{\"a\":1}') AS n " +
      'ON DUPLICATE KEY UPDATE config = n.config, id = LAST_INSERT_ID(ui_config.id)');
    const all = await q("SELECT id, config FROM ui_config WHERE config_key = 'k'");
    expect(all).toHaveLength(1);
    expect([r.insertId, all[0].config]).toEqual([all[0].id, { a: 1 }]);
    await q("DELETE FROM ui_config WHERE config_key = 'k'");
  });

  // ── the auth matrix ───────────────────────────────────────────────────────

  test('API keys: 401 on GET and PUT; no token: 401; nothing written', async () => {
    const key = { 'x-api-key': process.env.INTERNAL_API_KEY };
    expect((await hit('GET', null, undefined, key)).status).toBe(401);
    expect((await hit('PUT', null, { scope: 'firm', config_key: 'registry_overrides', config: {} }, key)).status).toBe(401);
    expect((await hit('PUT', null, { scope: 'user', config_key: 'shortcuts', config: {} }, key)).status).toBe(401);
    expect((await hit('GET', null)).status).toBe(401);
    expect(await rows()).toEqual([]);
  });

  test('firm PUT without firm.settings → 403 and nothing written; admin → 200 on the firm row + one version', async () => {
    expect((await firmPut('staff', { hidden: ['bills'] })).status).toBe(403);
    expect((await firmPut('dana', { hidden: ['bills'] })).status).toBe(403);
    expect(await rows()).toEqual([]);
    const r = await firmPut('admin', { hidden: ['bills', 'bills'], renames: { cases: { label: ' Matters ' } } });
    expect(r.status).toBe(200);
    const doc = { hidden: ['bills'], locked: [], renames: { cases: { label: 'Matters' } }, items: [] };
    expect(r.body).toEqual({ status: 'success', scope: 'firm', config_key: 'registry_overrides', config: doc, changed: true, versioned: true });
    const [row] = await rows();
    expect(row).toMatchObject({ scope: 'firm', user_id: 0, role: '', config_key: 'registry_overrides', config: doc, updated_by: 1 });
    expect(await versions()).toEqual([{ ui_config_id: row.id, config_key: 'registry_overrides', config: doc, saved_by: 1 }]);
  });

  test('versions: a key-reordered resubmission appends nothing; a change appends the NEW document (newest == current)', async () => {
    const reordered = await firmPut('it', { items: [], renames: { cases: { label: 'Matters' } }, locked: [], hidden: ['bills'] });
    expect([reordered.status, reordered.body.changed, reordered.body.versioned]).toEqual([200, false, false]);
    expect(await versions()).toHaveLength(1);
    expect((await rows())[0].updated_by).toBe(1);                        // untouched

    const next = { hidden: ['bills'], locked: ['cases'], renames: {}, items: [
      { id: 'firm:payroll', label: 'Payroll', icon: 'money-check', action: { type: 'url', href: 'https://p.example.com', present: 'window' } },
      { id: 'firm:appt', label: 'Appt form', icon: 'calendar', action: { type: 'tool', key: 'appt-form', present: 'modal' } },
    ] };
    const r = await firmPut('su', next);
    expect([r.status, r.body.changed, r.body.versioned]).toEqual([200, true, true]);
    const v = await versions();
    expect(v).toHaveLength(2);
    const [row] = await rows();
    expect(canonical(v[1].config)).toBe(canonical(row.config));
    expect(canonical(row.config)).toBe(canonical(next));
    expect([row.updated_by, v[1].saved_by, (await rows()).length]).toEqual([6, 6, 1]);
  });

  test('an invalid firm document is 400 and changes nothing', async () => {
    const before = [await rows(), await versions()];
    for (const config of [{ hidden: ['moreSettings'] }, { items: [{ id: 'firm:x', label: 'X', icon: 'x', action: { type: 'url', href: 'javascript:alert(1)', present: 'window' } }] }]) {
      const r = await firmPut('admin', config);
      expect([r.status, r.body.errors.length > 0]).toEqual([400, true]);
    }
    expect(await hit('PUT', 'admin', { scope: 'system', config_key: 'registry_overrides', config: {} })).toMatchObject({ status: 400 });
    expect(await hit('PUT', 'admin', { scope: 'firm', config_key: 'registry_overrides', config: {}, role: 'admin' })).toMatchObject({ status: 400 });
    expect([await rows(), await versions()]).toEqual(before);
  });

  test('user PUT: only the caller\'s own row; a body user_id is refused; never versioned', async () => {
    const vBefore = (await versions()).length;
    const refused = await userPut('staff', { bindings: [] }, { user_id: 11 });
    expect(refused.status).toBe(400);
    expect((await rows()).filter((r) => r.scope === 'user')).toEqual([]);

    const b = { combo: { ctrl: true, meta: false, alt: false, shift: false, key: 'B' }, id: 'bills' };
    const r9 = await userPut('staff', { bindings: [b] });
    expect([r9.status, r9.body.versioned, r9.body.config.bindings[0].combo.key]).toEqual([200, false, 'b']);
    const r11 = await userPut('dana', { bindings: [] });
    expect(r11.status).toBe(200);
    expect((await userPut('staff', { bindings: [{ ...b, id: 'cases' }] })).body.changed).toBe(true);   // upsert, same row
    const users = (await rows()).filter((r) => r.scope === 'user').map((r) => [r.user_id, r.updated_by, r.config.bindings.length]);
    expect(users).toEqual([[9, 9, 1], [11, 11, 0]]);
    expect((await rows()).find((r) => r.user_id === 9).config.bindings[0].id).toBe('cases');
    expect((await versions()).length).toBe(vBefore);
  });

  test('GET: the firm layer + only the caller\'s user layer', async () => {
    const r = await hit('GET', 'dana');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.firm)).toEqual(['registry_overrides']);
    expect(r.body.user).toEqual({ shortcuts: { bindings: [] } });
    expect((await hit('GET', 'admin')).body.user).toEqual({});
    expect(await svc.readFor(pool, null)).toEqual({ firm: { registry_overrides: expect.any(Object) }, user: {} });
  });

  test('deleting a firm row cascades its versions', async () => {
    const [row] = (await rows()).filter((r) => r.scope === 'firm');
    expect((await q('SELECT COUNT(*) n FROM ui_config_versions WHERE ui_config_id = ?', [row.id]))[0].n).toBe(2);
    await q('DELETE FROM ui_config WHERE id = ?', [row.id]);
    expect((await q('SELECT COUNT(*) n FROM ui_config_versions'))[0].n).toBe(0);
  });

  // The first-ever save of a row takes gap locks under SELECT … FOR UPDATE;
  // two of them racing deadlock, and InnoDB kills one. uiConfigService.write
  // retries that span once (pure DB). Without the retry about 2 in 3 of these
  // writes fail with ER_LOCK_DEADLOCK (review S3.1, race2.js) — so several rounds.
  test('concurrent first-ever saves: no deadlock reaches the caller; one row; the right versions', async () => {
    const doc = (k) => ({ bindings: [{ combo: { ctrl: true, meta: false, alt: false, shift: false, key: k }, id: 'cases' }] });
    for (let round = 0; round < 6; round++) {
      const uid = 100 + round;                                         // never written before
      const docs = ['a', 'b', 'c'].map(doc);
      const res = await Promise.allSettled(docs.map((config) =>
        svc.write(pool, { scope: 'user', config_key: 'shortcuts', config }, { type: 'jwt', userId: uid, roles: ['staff'] })));
      expect([round, res.filter((r) => r.status === 'rejected').map((r) => r.reason.code || r.reason.message)]).toEqual([round, []]);
      const rows = await q("SELECT config FROM ui_config WHERE scope = 'user' AND user_id = ?", [uid]);
      expect(rows).toHaveLength(1);
      expect(docs.map(canonical)).toContain(canonical(rows[0].config));
    }
    const admin = { type: 'jwt', userId: 1, roles: ['admin'] };
    for (let round = 0; round < 3; round++) {
      await q("DELETE FROM ui_config WHERE scope = 'firm'");
      const docs = ['bills', 'cases', 'log', 'tasks'].map((id) => ({ hidden: [id], locked: [], renames: {}, items: [] }));
      const res = await Promise.allSettled(docs.map((config) =>
        svc.write(pool, { scope: 'firm', config_key: 'registry_overrides', config }, admin)));
      expect([round, res.filter((r) => r.status === 'rejected').map((r) => r.reason.code || r.reason.message)]).toEqual([round, []]);
      const rows = await q("SELECT id, config FROM ui_config WHERE scope = 'firm'");
      expect(rows).toHaveLength(1);
      const v = await q('SELECT config FROM ui_config_versions WHERE ui_config_id = ? ORDER BY id', [rows[0].id]);
      expect(v).toHaveLength(docs.length);                            // every write changed the document
      expect(canonical(v[v.length - 1].config)).toBe(canonical(rows[0].config));   // newest == current
    }
  });
});
