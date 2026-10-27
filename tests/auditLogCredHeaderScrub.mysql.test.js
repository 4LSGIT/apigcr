// tests/auditLogCredHeaderScrub.mysql.test.js
//
/**
 * Credential-header scrub on REAL MySQL (scripts/auditLogCredHeaderScrub.js).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3329/yc_credscrub_test npx jest tests/auditLogCredHeaderScrub.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * jwt_api_audit_log in it (the live DDL's columns).
 *
 * WHAT IS LOCKED
 *   - CHECK counts the rows holding a credential-named header and writes
 *     nothing; APPLY rewrites across more than one batch; a re-run is a no-op.
 *   - The canary token is gone from every stored byte; every OTHER header key
 *     and value is kept; SQL NULL headers stay NULL; created_at is not bumped.
 *   - A row the live logger writes is already clean to the scrub.
 */
'use strict';

const mysql = require('mysql2/promise');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const CANARY = 'FAKEelevcanary-3f9a1c'; // test literal only

d('credential-header scrub on real MySQL', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    await q('DROP TABLE IF EXISTS jwt_api_audit_log');
    await q(`CREATE TABLE jwt_api_audit_log (
               id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
               route varchar(255) NOT NULL,
               method varchar(10) NOT NULL,
               headers json DEFAULT NULL,
               query_params json DEFAULT NULL,
               body json DEFAULT NULL,
               ip_address varchar(45) DEFAULT NULL,
               user_agent varchar(255) DEFAULT NULL,
               auth_type varchar(20) DEFAULT NULL,
               username varchar(255) DEFAULT NULL,
               auth_status varchar(20) DEFAULT NULL,
               created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP
             ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
  });
  afterAll(async () => { if (pool) await pool.end(); });

  test('CHECK → APPLY across batches → re-run no-op; other headers, NULL and created_at kept', async () => {
    jest.resetModules();
    const script = require('../scripts/auditLogCredHeaderScrub');
    const { logJwtApiAttempt } = require('../lib/auth.jwtOrApiKey');
    const N = script.BATCH + 50;
    const BENIGN = { 'user-agent': 'jest', 'x-app-build': '77', referer: 'https://app.4lsg.com/' };
    const rows = [];
    for (let i = 0; i < N; i++) {
      let h;
      if (i % 3 === 0) h = { ...BENIGN, 'x-su-elevation': `${CANARY}-${i}` };
      else if (i === 1) h = { ...BENIGN, 'x-readonly-api-key': `${CANARY}-ro` };
      else if (i === 2) h = null;
      else h = { ...BENIGN };
      rows.push(['/api/x', 'GET', h == null ? null : JSON.stringify(h), 'jwt', 'success', '2026-09-01 12:00:00']);
    }
    await q(`INSERT INTO jwt_api_audit_log (route, method, headers, auth_type, auth_status, created_at) VALUES ?`, [rows]);
    const expected = rows.filter((_, i) => i % 3 === 0 || i === 1).length;

    const conn = await pool.getConnection();
    const quiet = () => {};
    try {
      const check = await script.run(conn, { apply: false, log: quiet });
      expect(check).toMatchObject({ ok: true, rewritten: expected });
      expect((await q(`SELECT COUNT(*) n FROM jwt_api_audit_log WHERE CAST(headers AS CHAR) LIKE ?`, [`%${CANARY}%`]))[0].n).toBe(expected);

      const apply = await script.run(conn, { apply: true, log: quiet });
      expect(apply).toMatchObject({ ok: true, scanned: N, rewritten: expected });
      expect(apply.byName).toEqual({ 'x-su-elevation': expected - 1, 'x-readonly-api-key': 1 });

      expect((await q(`SELECT COUNT(*) n FROM jwt_api_audit_log WHERE CAST(headers AS CHAR) LIKE ?`, [`%${CANARY}%`]))[0].n).toBe(0);
      const all = await q('SELECT id, headers, created_at FROM jwt_api_audit_log ORDER BY id');
      all.forEach((r, i) => {
        if (i === 2) expect(r.headers).toBeNull();
        else expect(r.headers).toEqual(BENIGN);
        expect(r.created_at.toISOString()).toBe('2026-09-01T12:00:00.000Z');
      });

      const again = await script.run(conn, { apply: true, log: quiet });
      expect(again).toMatchObject({ ok: true, rewritten: 0 });

      // a row written by the live logger is already clean
      await logJwtApiAttempt({
        originalUrl: '/api/tasks', method: 'GET', query: {}, body: {},
        headers: { ...BENIGN, 'x-su-elevation': CANARY, authorization: `Bearer ${CANARY}` },
        socket: { remoteAddress: '127.0.0.1' }, db: pool,
      }, 'jwt', 'alice', 'success');
      await new Promise(r => setTimeout(r, 200)); // fire-and-forget INSERT
      expect((await q('SELECT COUNT(*) n FROM jwt_api_audit_log'))[0].n).toBe(N + 1);
      expect((await script.run(conn, { apply: false, log: quiet })).rewritten).toBe(0);
    } finally {
      conn.release();
    }
  });
});
