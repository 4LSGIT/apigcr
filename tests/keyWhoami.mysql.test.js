// tests/keyWhoami.mysql.test.js
//
/**
 * GET /api/readonly/whoami on REAL MySQL (routes/api.readonly.js over the real
 * lib/auth.readonly SELECT; the scripted half is tests/keyWhoami.test.js).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3361/yc_whoami_test npx jest tests/keyWhoami.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * readonly_query_log and readonly_api_keys in it, and drops them when done.
 *
 * WHAT IS LOCKED (what a scripted db cannot prove)
 *   - The row types: the JSON scopes column and both DATETIMEs as mysql2 returns
 *     them, joined through the real SELECT, reach the body correct (UTC, whole).
 *   - A scope edit and a parent's narrowing or renewal show on the very next call.
 *   - The log row lands in the real table under the key's id.
 */
'use strict';

process.env.JWT_SECRET = 'key-whoami-test-secret';

const express = require('express');
const mysql = require('mysql2/promise');

jest.mock('../startup/dbReadonly', () => ({
  getConnection: async () => { throw new Error('whoami must not touch the RO pool'); },
}));

const { hashKey } = require('../lib/auth.readonly');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;

d('whoami on real MySQL', () => {
  let pool, server, base;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const dropBoth = async () => {
    await q('DROP TABLE IF EXISTS readonly_query_log');
    await q('DROP TABLE IF EXISTS readonly_api_keys');
  };

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 5, timezone: 'Z' });
    await dropBoth();
    await q(`CREATE TABLE readonly_api_keys (
      id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
      key_hash char(64) NOT NULL UNIQUE, key_prefix varchar(16) NOT NULL, label varchar(255) NOT NULL,
      created_by int NOT NULL, created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at datetime NOT NULL, revoked_at datetime DEFAULT NULL, last_used_at datetime DEFAULT NULL,
      use_count int NOT NULL DEFAULT '0', scopes json DEFAULT NULL, parent_key_id int DEFAULT NULL,
      CONSTRAINT fk_rok_parent FOREIGN KEY (parent_key_id) REFERENCES readonly_api_keys (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`CREATE TABLE readonly_query_log (
      id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, api_key_id int NOT NULL,
      created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, ip varchar(45) DEFAULT NULL,
      user_agent varchar(512) DEFAULT NULL, sql_text mediumtext NOT NULL, params_json json DEFAULT NULL,
      row_count int DEFAULT NULL, duration_ms int DEFAULT NULL, status varchar(40) NOT NULL,
      sensitive_key tinyint(1) NOT NULL DEFAULT '0', error_text text,
      CONSTRAINT fk_rqlog_key FOREIGN KEY (api_key_id) REFERENCES readonly_api_keys (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    const app = express();
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.readonly'));
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  const settle = () => new Promise((r) => setTimeout(r, 50));   // the usage counter + log row are fire-and-forget

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (pool) { await settle(); await dropBoth(); await pool.end(); }
  });

  async function insertKey(key, { label = 'k', expires, scopes = null, parent = null }) {
    const r = await q(
      `INSERT INTO readonly_api_keys (key_hash, key_prefix, label, created_by, expires_at, scopes, parent_key_id)
       VALUES (?, ?, ?, 6, ?, ?, ?)`,
      [hashKey(key), key.slice(0, 12), label, expires, scopes == null ? null : JSON.stringify(scopes), parent]);
    return r.insertId;
  }
  async function ask(key) {
    const r = await fetch(`${base}/api/readonly/whoami`, { headers: { 'x-readonly-api-key': key } });
    return { status: r.status, body: await r.json() };
  }

  test('a scoped root key: JSON column and DATETIME reach the body as UTC; the log row lands', async () => {
    const id = await insertKey('ycro_rootscoped', { label: 'real', expires: '2099-03-04 05:06:00', scopes: ['alert', 'sql.ro'] });
    const r = await ask('ycro_rootscoped_any note');
    expect(r).toEqual({ status: 200, body: {
      ok: true, id, label: 'real', scopes: ['sql.ro', 'alert'], legacy: false,
      expiresAt: '2099-03-04T05:06:00.000Z', parentKeyId: null } });
    await settle();
    const logs = await q('SELECT api_key_id, sql_text, status, row_count FROM readonly_query_log WHERE api_key_id = ?', [id]);
    expect(logs).toEqual([{ api_key_id: id, sql_text: 'GET /api/readonly/whoami', status: 'success', row_count: 1 }]);
  });

  test('a legacy NULL column reads as legacy, its surface expanded', async () => {
    await insertKey('ycro_rootlegacy', { expires: '2099-01-01 00:00:00' });
    const r = await ask('ycro_rootlegacy');
    expect(r.body).toMatchObject({ legacy: true, scopes: ['sql.ro', 'scratch', 'alert', 'temp.clio', 'temp.dropbox', 'temp.zohosign'] });
  });

  test('a child through the real join; edits, narrowing and renewal show on the next call', async () => {
    const parent = await insertKey('ycro_rootparent', { expires: '2099-02-01 00:00:00', scopes: ['sql.ro', 'scratch', 'alert', 'keys.mint'] });
    await insertKey('ycro_childkey', { expires: '2099-06-01 00:00:00', scopes: ['sql.ro', 'scratch'], parent });

    let r = await ask('ycro_childkey');
    expect(r.body).toMatchObject({ scopes: ['sql.ro', 'scratch'], expiresAt: '2099-02-01T00:00:00.000Z', parentKeyId: parent });

    await q('UPDATE readonly_api_keys SET scopes = ? WHERE id = ?', [JSON.stringify(['scratch', 'alert']), parent]);
    r = await ask('ycro_childkey');
    expect(r.body.scopes).toEqual(['scratch']);

    await q("UPDATE readonly_api_keys SET expires_at = '2099-09-01 00:00:00' WHERE id = ?", [parent]);
    r = await ask('ycro_childkey');
    expect(r.body.expiresAt).toBe('2099-06-01T00:00:00.000Z');
  });
});
