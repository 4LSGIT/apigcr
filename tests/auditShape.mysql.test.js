// tests/auditShape.mysql.test.js
//
/**
 * SEC-2 scrub on REAL MySQL (scripts/sec2ScrubAuditShapes.js).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_sec2_test npx jest tests/auditShape.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * jwt_api_audit_log in it (the live DDL's columns).
 *
 * WHAT IS LOCKED (what a scripted conn cannot prove)
 *   - mysql2 hands JSON columns back PARSED, and the script's isShaped /
 *     shapeTop see the same values the logger wrote: CHECK counts, APPLY
 *     rewrites across more than one batch, a re-run (CHECK and APPLY) is a
 *     no-op, and the stored bytes never contain the canary.
 *   - SQL NULL stays SQL NULL (not JSON null) on a side that was NULL.
 *   - created_at is not bumped by the UPDATE (no ON UPDATE on the column).
 *   - A row the live logger writes (logJwtApiAttempt → INSERT) is already
 *     shaped to the scrub: logger and scrub agree on the engine.
 */
'use strict';

const mysql = require('mysql2/promise');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const CANARY = 'FAKEcanary-7c1e9b-5551234';

d('SEC-2 scrub on real MySQL', () => {
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
               user_agent text,
               auth_type varchar(20) NOT NULL,
               username varchar(255) DEFAULT NULL,
               auth_status varchar(20) NOT NULL,
               created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP
             ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
  });
  afterAll(async () => { if (pool) await pool.end(); });

  test('CHECK → APPLY across batches → re-run no-op; NULL kept; created_at kept; logger rows already shaped', async () => {
    jest.resetModules();
    const script = require('../scripts/sec2ScrubAuditShapes');
    const { logJwtApiAttempt } = require('../lib/auth.jwtOrApiKey');
    const N = script.BATCH + 50;
    const vals = [];
    for (let i = 0; i < N; i++) {
      const body = i % 7 === 3 ? null : JSON.stringify({ to: CANARY, message: `m ${CANARY}`, ids: [1, 2], password: '[REDACTED]' });
      vals.push(['/api/sms', 'POST', '{}', JSON.stringify({ q: '[REDACTED]', page: String(i) }), body, 'jwt', 'authorized', '2026-01-02 03:04:05']);
    }
    await q('INSERT INTO jwt_api_audit_log (route, method, headers, query_params, body, auth_type, auth_status, created_at) VALUES ?', [vals]);
    // one row written by the live logger, through the same pool
    await logJwtApiAttempt({
      originalUrl: '/api/x', method: 'POST', headers: { 'user-agent': 'jest' },
      query: { s: CANARY }, body: { to: CANARY, n: 1 }, socket: { remoteAddress: '127.0.0.1' }, db: pool,
    }, 'jwt', 'alice', 'authorized');
    const total = N + 1;
    const nullIds = (await q('SELECT id FROM jwt_api_audit_log WHERE body IS NULL ORDER BY id')).map(r => r.id);
    expect(nullIds.length).toBeGreaterThan(0);

    const conn = await pool.getConnection();
    try {
      const silent = () => {};
      expect(await script.run(conn, { apply: false, log: silent })).toEqual({ ok: true, scanned: total, rewritten: N });
      expect((await q('SELECT COUNT(*) n FROM jwt_api_audit_log WHERE CAST(body AS CHAR) LIKE ?', [`%${CANARY}%`]))[0].n)
        .toBe(N - nullIds.length);                                                        // CHECK wrote nothing
      expect(await script.run(conn, { apply: true, log: silent })).toEqual({ ok: true, scanned: total, rewritten: N });
      expect(await script.run(conn, { apply: true, log: silent })).toEqual({ ok: true, scanned: total, rewritten: 0 });
      expect(await script.run(conn, { apply: false, log: silent })).toEqual({ ok: true, scanned: total, rewritten: 0 });
    } finally {
      conn.release();
    }

    const leaked = await q(
      'SELECT COUNT(*) n FROM jwt_api_audit_log WHERE CAST(body AS CHAR) LIKE ? OR CAST(query_params AS CHAR) LIKE ?',
      [`%${CANARY}%`, `%${CANARY}%`]);
    expect(leaked[0].n).toBe(0);
    // SQL NULL stays SQL NULL, not JSON null
    expect((await q('SELECT id FROM jwt_api_audit_log WHERE body IS NULL ORDER BY id')).map(r => r.id)).toEqual(nullIds);
    const [first] = await q('SELECT body, query_params, DATE_FORMAT(created_at, "%Y-%m-%d %H:%i:%s") c FROM jwt_api_audit_log ORDER BY id LIMIT 1');
    expect(first.body).toEqual({ to: `[str ${CANARY.length}]`, message: `[str ${CANARY.length + 2}]`, ids: '[arr 2]', password: '[secret]' });
    expect(first.query_params).toEqual({ q: '[str 10]', page: '[str 1]' });
    expect(first.c).toBe('2026-01-02 03:04:05');                                         // not bumped
  });
});
