// tests/keyScopes.mysql.test.js
//
/**
 * Key scopes on REAL MySQL — access-control B1
 * (scripts/accessB1KeyScopes.js; the JSON column through lib/auth.readonly
 * and lib/apiKeys).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_b1_test npx jest tests/keyScopes.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * readonly_api_keys, api_keys and admin_audit_log in it (production shapes,
 * from ref/database.sql).
 *
 * WHAT IS LOCKED (what a fake db cannot prove)
 *   - The migration: CHECK GO with nothing written; APPLY adds both columns
 *     (JSON, NULL, no default) and every existing row reads NULL = legacy;
 *     re-run is a no-op GO; a `scopes` column of another type is a NO-GO,
 *     never altered.
 *   - The round trip: a mint stores JSON.stringify(array); mysql2 hands the
 *     JSON column back as an ARRAY in the same order (arrays are order-stable
 *     — no key-order trap here), through readonlyApiKeyAuth onto req.auth and
 *     through apiKeys.lookup; NULL comes back null.
 */
'use strict';

const mysql = require('mysql2/promise');
const script = require('../scripts/accessB1KeyScopes');
const { readonlyApiKeyAuth, requireKeyScope, hashKey } = require('../lib/auth.readonly');
const apiKeys = require('../lib/apiKeys');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;

d('key scopes on real MySQL', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const quiet = () => jest.spyOn(console, 'log').mockImplementation(() => {});

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    for (const t of ['readonly_api_keys', 'api_keys', 'admin_audit_log']) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q(`CREATE TABLE readonly_api_keys (
      id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
      key_hash char(64) NOT NULL UNIQUE, key_prefix varchar(16) NOT NULL, label varchar(255) NOT NULL,
      created_by int NOT NULL, created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at datetime NOT NULL, revoked_at datetime DEFAULT NULL, last_used_at datetime DEFAULT NULL,
      use_count int NOT NULL DEFAULT '0', ip_allowlist text
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`CREATE TABLE api_keys (
      id int NOT NULL AUTO_INCREMENT PRIMARY KEY, label varchar(100) NOT NULL,
      key_hash char(64) NOT NULL UNIQUE, key_prefix varchar(12) NOT NULL, created_by int DEFAULT NULL,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at timestamp NULL DEFAULT NULL,
      revoked_at timestamp NULL DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`CREATE TABLE admin_audit_log (
      id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, tool varchar(32) NOT NULL, user_id int DEFAULT NULL,
      username varchar(255) DEFAULT NULL, route varchar(255) NOT NULL, method varchar(10) NOT NULL,
      status varchar(40) NOT NULL, error_message text, duration_ms int DEFAULT NULL,
      ip_address varchar(45) DEFAULT NULL, user_agent varchar(255) DEFAULT NULL, details json DEFAULT NULL,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    // pre-B1 rows: a legacy session key and a legacy machine key
    await q(`INSERT INTO readonly_api_keys (key_hash, key_prefix, label, created_by, expires_at)
             VALUES (?, 'ycro_legacy', 'claude long key', 6, '2028-01-01')`, [hashKey('ycro_legacy')]);
    await q(`INSERT INTO api_keys (label, key_hash, key_prefix) VALUES ('Pabbly', ?, 'yck_legacy')`, [apiKeys.hashKey('yck_legacy')]);
  });
  afterAll(async () => { if (pool) await pool.end(); });
  afterEach(() => jest.restoreAllMocks());

  test('migration: CHECK writes nothing; APPLY adds both; existing rows NULL; re-run no-op', async () => {
    quiet();
    const conn = await pool.getConnection();
    try {
      expect(await script.run(conn, { apply: false })).toEqual({ ok: true });
      expect(await q("SHOW COLUMNS FROM readonly_api_keys LIKE 'scopes'")).toHaveLength(0);
      expect(await script.run(conn, { apply: true })).toEqual({ ok: true });
      for (const t of ['readonly_api_keys', 'api_keys']) {
        const [c] = await q(`SHOW FULL COLUMNS FROM ${t} LIKE 'scopes'`);
        expect(c).toMatchObject({ Type: 'json', Null: 'YES', Default: null });
        expect(c.Comment).toMatch(/NULL = legacy full surface/);
        const [[n]] = await conn.query(`SELECT COUNT(*) n FROM ${t} WHERE scopes IS NOT NULL`);
        expect(Number(n.n)).toBe(0);
      }
      expect(await script.run(conn, { apply: true })).toEqual({ ok: true });
    } finally { conn.release(); }
  });

  test('a scopes column of another type is a NO-GO, never altered', async () => {
    quiet();
    const conn = await pool.getConnection();
    try {
      await conn.query('ALTER TABLE api_keys MODIFY scopes TEXT NULL');
      expect(await script.run(conn, { apply: true })).toEqual({ ok: false });
      const [[c]] = await conn.query("SHOW COLUMNS FROM api_keys LIKE 'scopes'");
      expect(c.Type).toBe('text');
      await conn.query(`ALTER TABLE api_keys MODIFY scopes JSON NULL COMMENT '${script.COMMENT.replace(/'/g, "''")}'`);
      expect(await script.run(conn, { apply: false })).toEqual({ ok: true });
    } finally { conn.release(); }
  });

  // readonlyApiKeyAuth + requireKeyScope over the real pool.
  // Settles on whichever comes first: the gate's next() or a response (the
  // middleware does not await next(), so awaiting it alone is not enough).
  function gate(rawKey, scope) {
    return new Promise((resolve) => {
      const req = { headers: { 'x-readonly-api-key': rawKey }, db: pool, originalUrl: '/x', method: 'POST', socket: {} };
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; resolve({ passed: false, req, res: this }); return this; } };
      readonlyApiKeyAuth(req, res, () => requireKeyScope(scope)(req, res, () => resolve({ passed: true, req, res })));
    });
  }

  test('round trip: the minted JSON array comes back as the same array, in order', async () => {
    const minted = ['temp.clio', 'sql.ro', 'scratch'];
    await q(`INSERT INTO readonly_api_keys (key_hash, key_prefix, label, created_by, expires_at, scopes)
             VALUES (?, 'ycro_scoped', 'scoped', 6, DATE_ADD(NOW(), INTERVAL 1 DAY), ?)`,
      [hashKey('ycro_scoped_20991231T0000Z'), JSON.stringify(minted)]);
    const ok = await gate('ycro_scoped_20991231T0000Z', 'temp.clio');
    expect(ok.passed).toBe(true);
    expect(ok.req.auth.scopes).toEqual(minted);
    const no = await gate('ycro_scoped', 'alert');
    expect(no.passed).toBe(false);
    expect(no.res.statusCode).toBe(403);
    expect(no.res.body.missingScope).toBe('alert');
    const [row] = await q("SELECT tool, status, details FROM admin_audit_log WHERE status = 'rejected_scope' ORDER BY id DESC LIMIT 1");
    expect(row).toMatchObject({ tool: 'readonlyKeys', status: 'rejected_scope' });
    expect(row.details).toMatchObject({ scope: 'alert' });
  });

  test('a legacy (NULL) session key passes every surface, scopes null', async () => {
    for (const s of ['sql.ro', 'scratch', 'alert', 'temp.ringcentral']) {
      const r = await gate('ycro_legacy', s);
      expect(r.passed).toBe(true);
      expect(r.req.auth.scopes).toBeNull();
    }
  });

  test('apiKeys.lookup: NULL → null; a JSON array → that array', async () => {
    apiKeys.invalidateCache();
    expect(await apiKeys.lookup(pool, 'yck_legacy')).toMatchObject({ label: 'Pabbly', scopes: null });
    await q(`INSERT INTO api_keys (label, key_hash, key_prefix, scopes) VALUES ('scheduler', ?, 'yck_sched', ?)`,
      [apiKeys.hashKey('yck_sched'), JSON.stringify(['route:/process-jobs'])]);
    expect(await apiKeys.lookup(pool, 'yck_sched')).toMatchObject({ label: 'scheduler', scopes: ['route:/process-jobs'] });
  });
});
