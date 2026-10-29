// Real-engine twin for the Code dialog's single-row audit lifecycle. Never
// points at the dev machine's production proxy (127.0.0.1:3306).
// YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3389/yc_code_box_test node node_modules/jest/bin/jest.js tests/codeBox.mysql.test.js --runInBand
'use strict';

process.env.JWT_SECRET = 'code-box-mysql-test-secret';
process.env.JWT_VERSION = '1';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const express = require('express');
const jwt = require('jsonwebtoken');
const router = require('../routes/api.codeBox');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;

d('Code audit outcomes on real MySQL', () => {
  let pool, server, base;
  const q = async (sql, params) => (await pool.query(sql, params))[0];
  const auth = (id = 2, target) => jwt.sign({
    sub: target || id, username: 'staff' + (target || id), user_type: 1,
    user_auth: 'authorized', roles: ['staff'], aud: 'staff', ver: 1,
    ...(target ? { view_as: true, view_as_mode: 'readonly', act: { sub: String(id), username: 'staff' + id } } : {}),
  }, process.env.JWT_SECRET, { expiresIn: '1h' });
  async function post(url, body, actor = 2, target) {
    const res = await fetch(base + url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth(actor, target) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }
  const start = (actor, target) => post('/api/code-box/runs', { code: 'return 42;' }, actor, target);
  const finish = (id, actor, target, status = 'success') => post('/api/code-box/runs/' + id + '/finish',
    { status, duration_ms: 23 }, actor, target);

  beforeAll(async () => {
    const u = new URL(URL_);
    if (!/_test$/.test(u.pathname.slice(1)) || !['127.0.0.1', 'localhost'].includes(u.hostname)
        || !u.port || u.port === '3306') throw new Error('Use a disposable local *_test DB on a non-production port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 3, timezone: 'Z' });
    const schema = fs.readFileSync(path.join(__dirname, '../ref/database.sql'), 'utf8');
    for (const table of ['admin_audit_log', 'jwt_api_audit_log']) {
      await q('DROP TABLE IF EXISTS `' + table + '`');
      const ddl = schema.match(new RegExp('CREATE TABLE `' + table + '` \\([\\s\\S]*?\\) ENGINE[^;]+;'))[0];
      const id = '`id` bigint NOT NULL,';
      expect(ddl.split(id)).toHaveLength(2);
      await q(ddl.replace(id, '`id` bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,'));
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(router);
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
  });

  test.each(['success', 'error'])('%s updates the original receipt once, without changing code or timestamp', async (status) => {
    const begun = await start();
    expect(begun.status).toBe(200);
    const id = begun.body.run_id;
    const [before] = await q('SELECT * FROM admin_audit_log WHERE id = ?', [id]);
    expect(before.status).toBe('run');
    expect((await finish(id, 2, undefined, status)).status).toBe(200);
    expect((await finish(id, 2, undefined, status === 'success' ? 'error' : 'success')).status).toBe(404);
    const [after] = await q('SELECT * FROM admin_audit_log WHERE id = ?', [id]);
    expect(after).toMatchObject({ status, duration_ms: 23, details: { code: 'return 42;' }, created_at: before.created_at });
    expect(after.details).toEqual(before.details);
  });

  test('SQL isolates real actor, effective user, tool and row id', async () => {
    const a = (await start(2)).body.run_id;
    const b = (await start(3)).body.run_id;
    expect((await finish(a, 3)).status).toBe(404);
    expect((await finish(a, 2, 4)).status).toBe(404);
    await q("UPDATE admin_audit_log SET tool = 'api_tester' WHERE id = ?", [a]);
    expect((await finish(a, 2)).status).toBe(404);
    expect((await finish(b, 3)).status).toBe(200);
    expect((await q('SELECT status FROM admin_audit_log WHERE id = ?', [a]))[0].status).toBe('run');

    const v = (await start(2, 4)).body.run_id;
    expect((await finish(v, 2)).status).toBe(404);
    expect((await finish(v, 3, 4)).status).toBe(404);
    expect((await finish(v, 2, 5)).status).toBe(404);
    expect((await finish(v, 2, 4, 'error')).status).toBe(200);
    const [row] = await q('SELECT * FROM admin_audit_log WHERE id = ?', [v]);
    expect(row).toMatchObject({ user_id: 2, status: 'error', details: { target_user_id: 4 } });
  });
});
