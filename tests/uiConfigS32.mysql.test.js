// tests/uiConfigS32.mysql.test.js
//
/**
 * The Firm tab's routes on REAL MySQL — ui-customization arc S3.2
 * (routes/api.uiConfig.js → services/uiConfigService.js listVersions /
 * getVersion / restoreVersion / pickers).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3362/yc_ui32_test npx jest tests/uiConfigS32.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * ui_config, ui_config_versions, jwt_api_audit_log, users, tools and
 * report_definitions in it — give it its own database (not the one
 * tests/uiConfig.mysql.test.js uses). Prod's RELAXED sql_mode — asserted.
 * users / tools / report_definitions come from ref/database.sql (line-based
 * extraction: column COMMENTs carry ';').
 *
 * WHAT IS LOCKED
 *   - can_edit_firm across roles, on the real router.
 *   - The auth matrix: versions / view / restore 403 without
 *     firm.settings (nothing written), 401 for an API key; 200 for admin/it/su.
 *     Pickers: 200 for any staff user since ui-custom S5a, still 401 for an API key.
 *   - versions: newest first, saved_by_name joined, is_current a boolean that
 *     is true for exactly the current document (MySQL JSON equality, key-order
 *     insensitive); only the FIRM row's versions; a user row's never.
 *   - restore: an older version comes back through write() — one NEW version
 *     row, newest == current; restoring the current document appends nothing;
 *     a stale-invalid version (rules tightened since) is a 400 with errors and
 *     changes nothing; a non-holder is refused by write()'s re-check even when
 *     the service is called directly.
 *   - pickers: live tools only, never html; active views only.
 *   - Optimistic concurrency (fix round, review SF1): GET's firm_versions is the
 *     newest version id; a PUT / restore carrying a stale base is a 409 and writes
 *     nothing; no base = no check (S3.1 contract); two writers holding the SAME
 *     base race → exactly one 409 (first-ever row included).
 *   - Restore writes into the PARENT row's config_key; a version whose own key
 *     disagrees is a 400 (review N3).
 */
'use strict';

process.env.JWT_SECRET = 'ui-config-s32-mysql-secret';
process.env.INTERNAL_API_KEY = 'yci_ui_config_s32_mysql_internal';   // secret-scan: allow

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const express = require('express');
const jwt = require('jsonwebtoken');
const svc = require('../services/uiConfigService');
const { canonical } = require('../lib/uiConfigShape');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const ROOT = path.join(__dirname, '..');
const MIGRATION = path.join(ROOT, 'ref', 'migrations', '2026-10-16_ui_custom_s31_ui_config.sql');

/** CREATE TABLE `name` … ) ENGINE=…; from ref/database.sql, line-based. */
function ddlOf(name) {
  const lines = fs.readFileSync(path.join(ROOT, 'ref', 'database.sql'), 'utf8').split('\n');
  const i = lines.findIndex((l) => l.startsWith(`CREATE TABLE \`${name}\` (`));
  if (i < 0) throw new Error('no DDL for ' + name);
  const out = [];
  for (let j = i; j < lines.length; j++) {
    out.push(lines[j]);
    if (/^\) ENGINE=.*;$/.test(lines[j])) break;
  }
  return out.join('\n').replace(/;$/, '');
}

d('Firm-tab routes on real MySQL', () => {
  let pool, server, base;
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    for (const t of ['ui_config_versions', 'ui_config', 'jwt_api_audit_log', 'users', 'tools', 'report_definitions']) {
      await q(`DROP TABLE IF EXISTS \`${t}\``);
    }
    const stmts = fs.readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !/^--/.test(l)).join('\n')
      .split(/;\s*$/m).map((x) => x.trim()).filter(Boolean);
    for (const st of stmts) await q(st);
    await q(`CREATE TABLE jwt_api_audit_log (
      id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, route varchar(255) NOT NULL, method varchar(10) NOT NULL,
      headers json DEFAULT NULL, query_params json DEFAULT NULL, body json DEFAULT NULL,
      ip_address varchar(45) DEFAULT NULL, user_agent varchar(255) DEFAULT NULL, auth_type varchar(20) DEFAULT NULL,
      username varchar(255) DEFAULT NULL, auth_status varchar(20) DEFAULT NULL,
      created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    for (const t of ['users', 'tools', 'report_definitions']) await q(ddlOf(t));

    // Relaxed mode: the NOT NULL columns without defaults take their implicit default.
    await q("INSERT INTO users (user, user_name, username) VALUES (1, 'Alex Admin', 'alex'), (5, 'Ivy IT', 'ivy'), (6, 'Sol Su', 'sol')");
    await q(`INSERT INTO tools (id, tool_key, title, status, html) VALUES
      (1, 'appt-form', 'Appt Form', 'live', '<p>secret tool html</p>'),
      (2, 'draft-thing', 'Draft Thing', 'draft', '<p>draft</p>'),
      (3, 'call-review', '', 'live', '<p>x</p>')`);
    await q(`INSERT INTO report_definitions (id, report_key, title, kind, sql_text, is_active) VALUES
      (10, 'lead_followups', 'Leads — Follow Ups', 'view', 'SELECT 1', 1),
      (11, 'old_view', 'Retired view', 'view', 'SELECT 1', 0),
      (12, 'a_report', 'A report', 'report', 'SELECT 1', 1)`);

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

  const USERS = { staff: [['staff'], 9], dana: [['staff', 'attorney'], 11], admin: [['admin', 'staff'], 1], it: [['it'], 5], su: [['su'], 6] };
  const tok = (who) => 'Bearer ' + jwt.sign(
    { sub: USERS[who][1], username: who, user_type: 1, user_auth: 'authorized', roles: USERS[who][0], aud: 'staff' },
    process.env.JWT_SECRET, { expiresIn: '5m' });
  async function hit(method, url, who, body, extra = {}) {
    const headers = { 'content-type': 'application/json', ...extra };
    if (who) headers.authorization = tok(who);
    const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = {}; try { json = JSON.parse(text); } catch (_) { /* text */ }
    return { status: r.status, body: json, text };
  }
  const firmPut = (who, config) => hit('PUT', '/api/ui-config', who, { scope: 'firm', config_key: 'registry_overrides', config });
  const versions = () => q('SELECT id, config FROM ui_config_versions ORDER BY id');
  const firmRow = async () => (await q("SELECT id, config, updated_by FROM ui_config WHERE scope = 'firm'"))[0];
  const DOC = (hidden, extra = {}) => ({ hidden, locked: [], renames: {}, items: [], ...extra });

  test('relaxed sql_mode, like prod', async () => {
    const [[m]] = await pool.query('SELECT @@SESSION.sql_mode m');
    expect(m.m).not.toMatch(/STRICT_TRANS_TABLES|STRICT_ALL_TABLES|ONLY_FULL_GROUP_BY|NO_BACKSLASH_ESCAPES/);
  });

  test('can_edit_firm on the real router', async () => {
    const got = {};
    for (const who of Object.keys(USERS)) got[who] = (await hit('GET', '/api/ui-config', who)).body.can_edit_firm;
    expect(got).toEqual({ staff: false, dana: false, admin: true, it: true, su: true });
  });

  test('three saves → three versions, newest first, names joined, exactly one current', async () => {
    expect((await firmPut('admin', DOC(['bills']))).status).toBe(200);
    expect((await firmPut('it', DOC(['bills', 'log']))).status).toBe(200);
    expect((await firmPut('su', DOC(['log'], { renames: { cases: { label: 'Matters' } } }))).status).toBe(200);
    const r = await hit('GET', '/api/ui-config/versions?config_key=registry_overrides', 'admin');
    expect(r.status).toBe(200);
    const v = r.body.versions;
    expect(v.map((x) => [x.saved_by, x.saved_by_name, x.is_current])).toEqual(
      [[6, 'Sol Su', true], [5, 'Ivy IT', false], [1, 'Alex Admin', false]]);
    expect(v[0].id).toBeGreaterThan(v[1].id);
    expect(v.every((x) => typeof x.size === 'number' && x.size > 10 && typeof x.is_current === 'boolean')).toBe(true);
  });

  test('view: one version in full; another row\'s (a user row) is 404', async () => {
    const [first] = await versions();
    const r = await hit('GET', `/api/ui-config/versions/${first.id}`, 'it');
    expect(r.status).toBe(200);
    expect(r.body.version).toMatchObject({ id: first.id, config_key: 'registry_overrides', config: DOC(['bills']), saved_by: 1, saved_by_name: 'Alex Admin' });
    // a version row hung off a USER row never answers here
    await q("INSERT INTO ui_config (scope, user_id, role, config_key, config) VALUES ('user', 9, '', 'shortcuts', '{\"bindings\":[]}')");
    const [[u]] = await pool.query("SELECT id FROM ui_config WHERE scope = 'user'");
    const [ins] = await pool.query("INSERT INTO ui_config_versions (ui_config_id, config_key, config) VALUES (?, 'shortcuts', '{\"bindings\":[]}')", [u.id]);
    expect((await hit('GET', `/api/ui-config/versions/${ins.insertId}`, 'admin')).status).toBe(404);
    expect((await hit('POST', `/api/ui-config/versions/${ins.insertId}/restore`, 'admin')).status).toBe(404);
    const list = (await hit('GET', '/api/ui-config/versions?config_key=registry_overrides', 'admin')).body.versions;
    expect(list.map((x) => x.id)).not.toContain(ins.insertId);
    await q('DELETE FROM ui_config WHERE id = ?', [u.id]);
  });

  test('restore an older version: back through write() — one new version, newest == current', async () => {
    const before = await versions();
    const r = await hit('POST', `/api/ui-config/versions/${before[0].id}/restore`, 'admin');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'success', scope: 'firm', config_key: 'registry_overrides', changed: true, versioned: true, restored_from: before[0].id });
    expect(r.body.config).toEqual(DOC(['bills']));
    const after = await versions();
    expect(after).toHaveLength(before.length + 1);
    const row = await firmRow();
    expect(canonical(row.config)).toBe(canonical(DOC(['bills'])));
    expect(canonical(after[after.length - 1].config)).toBe(canonical(row.config));
    expect(row.updated_by).toBe(1);
    const list = (await hit('GET', '/api/ui-config/versions?config_key=registry_overrides', 'admin')).body.versions;
    // the restored-from version equals the current document again → both flagged current
    expect(list.filter((x) => x.is_current).map((x) => x.id).sort()).toEqual([after[0].id, after[after.length - 1].id].sort());
  });

  test('restoring the current document appends nothing', async () => {
    const before = await versions();
    const newest = before[before.length - 1];
    const r = await hit('POST', `/api/ui-config/versions/${newest.id}/restore`, 'su');
    expect([r.status, r.body.changed, r.body.versioned]).toEqual([200, false, false]);
    expect(await versions()).toEqual(before);
    expect((await firmRow()).updated_by).toBe(1);   // untouched
  });

  test('a stale-invalid version (saved before the rules tightened) is a 400 listing the errors; nothing changes', async () => {
    const row = await firmRow();
    const stale = { hidden: ['moreSettings'], locked: [], renames: { custom: { label: 'Mine' } }, items: [] };
    const [ins] = await pool.query('INSERT INTO ui_config_versions (ui_config_id, config_key, config, saved_by) VALUES (?, ?, ?, 1)',
      [row.id, 'registry_overrides', JSON.stringify(stale)]);
    const before = [await firmRow(), await versions()];
    const r = await hit('POST', `/api/ui-config/versions/${ins.insertId}/restore`, 'admin');
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/no longer passes/);
    expect(r.body.errors.join(' | ')).toMatch(/moreSettings cannot be hidden/);
    expect(r.body.errors.join(' | ')).toMatch(/custom tab is titled by its user/);
    expect([await firmRow(), await versions()]).toEqual(before);
    await q('DELETE FROM ui_config_versions WHERE id = ?', [ins.insertId]);
  });

  test('auth matrix: no firm.settings → 403 and nothing written; API key → 401', async () => {
    const [v] = await versions();
    const routes = [['GET', '/api/ui-config/versions?config_key=registry_overrides'], ['GET', `/api/ui-config/versions/${v.id}`],
      ['POST', `/api/ui-config/versions/${v.id}/restore`]];
    // pickers: any staff user since ui-custom S5a — still never an API key
    const pickers = ['GET', '/api/ui-config/pickers'];
    const before = [await firmRow(), await versions()];
    for (const who of ['staff', 'dana']) {
      for (const [m, url] of routes) expect([who, m, url, (await hit(m, url, who)).status]).toEqual([who, m, url, 403]);
      expect([who, (await hit(...pickers, who)).status]).toEqual([who, 200]);
    }
    for (const [m, url] of [...routes, pickers]) {
      expect([m, url, (await hit(m, url, null, undefined, { 'x-api-key': process.env.INTERNAL_API_KEY })).status]).toEqual([m, url, 401]);
    }
    expect([await firmRow(), await versions()]).toEqual(before);
    // the service's own re-check, past the route
    await expect(svc.restoreVersion(pool, v.id, { type: 'jwt', userId: 9, roles: ['staff'] })).rejects.toMatchObject({ status: 403 });
    expect([await firmRow(), await versions()]).toEqual(before);
  });

  test('pickers: live tools only and never their html; active views only', async () => {
    for (const who of ['admin', 'it', 'su']) {
      const r = await hit('GET', '/api/ui-config/pickers', who);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ status: 'success',
        tools: [{ key: 'appt-form', title: 'Appt Form' }, { key: 'call-review', title: 'call-review' }],
        views: [{ key: 'lead_followups', title: 'Leads — Follow Ups' }] });
      expect(r.text).not.toMatch(/secret tool html|draft/i);
    }
  });

  // ── fix round: optimistic concurrency + restore key binding ───────────────
  const head = async () => (await q("SELECT MAX(v.id) AS id FROM ui_config_versions v JOIN ui_config c ON c.id = v.ui_config_id WHERE c.scope = 'firm'"))[0].id;
  const put = (who, config, extra = {}) => hit('PUT', '/api/ui-config', who, { scope: 'firm', config_key: 'registry_overrides', config, ...extra });

  test('GET firm_versions = the newest version id (firm.settings holders only)', async () => {
    expect((await hit('GET', '/api/ui-config', 'admin')).body.firm_versions).toEqual({ registry_overrides: await head() });
    expect((await hit('GET', '/api/ui-config', 'staff')).body).not.toHaveProperty('firm_versions');
  });

  test('PUT with the current base → 200 + the new version_id; the same (now stale) base → 409, nothing written', async () => {
    const h = await head();
    const ok = await put('admin', DOC(['tasks']), { base: h });
    expect([ok.status, ok.body.changed]).toEqual([200, true]);
    expect(ok.body.version_id).toBe(await head());
    expect(ok.body.version_id).toBeGreaterThan(h);
    const before = [await firmRow(), await versions()];
    const stale = await put('it', DOC(['events']), { base: h });
    expect([stale.status, stale.body.message]).toEqual([409, svc.CONFLICT_MSG]);
    const nullBase = await put('it', DOC(['events']), { base: null });            // "no row" — but there is one
    expect(nullBase.status).toBe(409);
    // a stale base is refused even when the document would be a no-op
    expect((await put('it', DOC(['tasks']), { base: h })).status).toBe(409);
    expect([await firmRow(), await versions()]).toEqual(before);
    // no base → no check: the S3.1 contract
    const legacy = await put('it', DOC(['tasks']));
    expect([legacy.status, legacy.body.changed, legacy.body.version_id]).toEqual([200, false, await head()]);
  });

  test('restore carries the same check: stale base → 409, nothing written; current base → restored', async () => {
    const [oldest] = await versions();
    const h = await head();
    const before = [await firmRow(), await versions()];
    const stale = await hit('POST', `/api/ui-config/versions/${oldest.id}/restore`, 'admin', { base: h - 1 });
    expect(stale.status).toBe(409);
    expect([await firmRow(), await versions()]).toEqual(before);
    const ok = await hit('POST', `/api/ui-config/versions/${oldest.id}/restore`, 'admin', { base: h });
    expect([ok.status, ok.body.restored_from, ok.body.version_id]).toEqual([200, oldest.id, await head()]);
  });

  test('two writers holding the SAME base: exactly one wins, the other gets 409 (existing row, and first-ever row)', async () => {
    const admin = { type: 'jwt', userId: 1, roles: ['admin'] };
    const go = (hidden, base) => svc.write(pool, { scope: 'firm', config_key: 'registry_overrides', config: DOC([hidden]), base }, admin);
    for (let round = 0; round < 4; round++) {
      const h = await head();
      // fresh documents each round: a writer re-sending the current one is a no-op, which moves no version
      const res = await Promise.allSettled([go(`a${round}`, h), go(`b${round}`, h)]);
      expect([round, res.filter((r) => r.status === 'fulfilled').length,
        res.filter((r) => r.status === 'rejected').map((r) => r.reason.status)]).toEqual([round, 1, [409]]);
      expect(await head()).toBe(h + 1);
    }
    for (let round = 0; round < 3; round++) {
      await q("DELETE FROM ui_config WHERE scope = 'firm'");                  // versions cascade
      const res = await Promise.allSettled([go(`c${round}`, null), go(`d${round}`, null), go(`e${round}`, null)]);
      expect([round, res.filter((r) => r.status === 'fulfilled').length,
        res.filter((r) => r.status === 'rejected').map((r) => r.reason.status || r.reason.code)]).toEqual([round, 1, [409, 409]]);
      expect((await q("SELECT COUNT(*) n FROM ui_config WHERE scope = 'firm'"))[0].n).toBe(1);
      expect((await versions()).length).toBe(1);
    }
  });

  test('N3: restore binds to the parent row\'s key — a version row with another key is refused, nothing written', async () => {
    const row = await firmRow();
    const [ins] = await pool.query('INSERT INTO ui_config_versions (ui_config_id, config_key, config, saved_by) VALUES (?, ?, ?, 1)',
      [row.id, 'shortcuts', JSON.stringify(DOC(['bills']))]);
    const before = [await firmRow(), await versions()];
    const r = await hit('POST', `/api/ui-config/versions/${ins.insertId}/restore`, 'admin');
    expect([r.status, r.body.message]).toEqual([400, `version ${ins.insertId} does not match its row's config_key`]);
    expect([await firmRow(), await versions()]).toEqual(before);
    await q('DELETE FROM ui_config_versions WHERE id = ?', [ins.insertId]);
  });
});
