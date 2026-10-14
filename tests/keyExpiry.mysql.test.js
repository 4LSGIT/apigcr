// tests/keyExpiry.mysql.test.js
//
/**
 * B6 machine-key expiry on REAL MySQL (scripts/accessB6KeyExpiry.js +
 * lib/apiKeys createKey / lookup over a real pool).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_b6_test npx jest tests/keyExpiry.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * api_keys in it (the live DDL's columns).
 *
 * WHAT IS LOCKED (what a scripted conn cannot prove)
 *   - DEPLOY ORDER, proven: before the migration the B6 lookup's SELECT fails
 *     ("Unknown column 'expires_at'") and lookup fails CLOSED — every machine
 *     key would stop authenticating — so the migration goes FIRST; the
 *     pre-B6 INSERT still lands after it (the old backend is safe).
 *   - The migration: CHECK → GO, nothing changed; APPLY adds the column
 *     INSTANT (TOTAL_ROW_VERSIONS > 0, no rebuild), every existing key NULL;
 *     a re-run is a no-op GO; a column of another shape is a NO-GO, unaltered.
 *   - Time on the engine: a pool with timezone 'Z' (as startup/db.js) writes
 *     and reads expires_at as UTC, so an expiry one minute either side of the
 *     server's UTC_TIMESTAMP() is live / refused — no zone skew.
 */
'use strict';

const mysql = require('mysql2/promise');
const apiKeys = require('../lib/apiKeys');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;

d('B6 key expiry on real MySQL', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const script = require('../scripts/accessB6KeyExpiry');
  const lines = () => { const out = []; return { out, log: (s) => out.push(String(s)) }; };
  const goLine = (out) => out.map(l => l.trim()).filter(l => /^(GO|NO-GO)\b/.test(l));
  const OLD_INSERT = 'INSERT INTO api_keys (label, key_hash, key_prefix, created_by, scopes) VALUES (?, ?, ?, ?, ?)';

  async function fresh() {
    await q('DROP TABLE IF EXISTS api_keys');
    await q(`CREATE TABLE api_keys (
      id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
      label varchar(100) NOT NULL, key_hash char(64) NOT NULL, key_prefix varchar(12) NOT NULL,
      created_by int DEFAULT NULL, created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at timestamp NULL DEFAULT NULL, revoked_at timestamp NULL DEFAULT NULL,
      scopes json DEFAULT NULL,
      UNIQUE KEY uq_api_keys_hash (key_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
  });
  afterAll(async () => { if (pool) await pool.end(); });
  beforeEach(() => apiKeys.invalidateCache());

  test('deploy order, migration, re-run, existing keys NULL, old INSERT still lands', async () => {
    await fresh();
    const pre = 'yck_' + 'P'.repeat(22);
    await q(OLD_INSERT, ['Pabbly', apiKeys.hashKey(pre), pre.slice(0, 12), 6, null]);

    // B6 code before the column: lookup fails CLOSED — the hazard the order avoids
    const errs = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...a) => errs.push(a.join(' ')));
    expect(await apiKeys.lookup(pool, pre)).toBeNull();
    spy.mockRestore();
    expect(errs.join('\n')).toMatch(/lookup failed: Unknown column 'expires_at'/);

    const conn = await pool.getConnection();
    try {
      const c = lines();
      expect(await script.run(conn, { apply: false, log: c.log })).toEqual({ ok: true });
      expect(goLine(c.out)).toEqual(['GO — base state matches. Next: node scripts/accessB6KeyExpiry.js --apply']);
      expect(await q("SHOW COLUMNS FROM api_keys LIKE 'expires_at'")).toHaveLength(0);   // CHECK wrote nothing
      const a = lines();
      expect(await script.run(conn, { apply: true, log: a.log })).toEqual({ ok: true });
      expect(a.out.join('\n')).toMatch(/all 1 existing key\(s\) NULL/);
      expect(goLine(a.out)).toEqual([expect.stringMatching(/^GO — migration applied/)]);
      const r = lines();
      expect(await script.run(conn, { apply: true, log: r.log })).toEqual({ ok: true });
      expect(goLine(r.out)).toEqual([expect.stringMatching(/^GO — the migration is already applied/)]);
    } finally {
      conn.release();
    }

    const [col] = await q(`SELECT LOWER(COLUMN_TYPE) t, IS_NULLABLE n, COLUMN_DEFAULT d, COLUMN_COMMENT c
                             FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'api_keys' AND column_name = 'expires_at'`);
    expect(col).toEqual({ t: 'datetime', n: 'YES', d: null, c: script.COMMENT });
    const dbName = new URL(URL_).pathname.slice(1);
    const [iv] = await q('SELECT TOTAL_ROW_VERSIONS v FROM information_schema.INNODB_TABLES WHERE NAME = ?', [`${dbName}/api_keys`]);
    expect(iv.v).toBeGreaterThan(0);

    // after: the pre-existing NULL key works exactly as before; the old INSERT still lands
    expect(await apiKeys.lookup(pool, pre)).toEqual({ id: 1, label: 'Pabbly', scopes: null });
    const old = 'yck_' + 'O'.repeat(22);
    await q(OLD_INSERT, ['old-backend', apiKeys.hashKey(old), old.slice(0, 12), 6, null]);
    expect((await q('SELECT expires_at FROM api_keys WHERE label = ?', ['old-backend']))[0].expires_at).toBeNull();
  });

  test('expiry against the server clock: ±1 minute of UTC_TIMESTAMP(), via createKey + lookup', async () => {
    const out = await apiKeys.createKey(pool, 'vendor', 6, ['route:/process-jobs'], 60);
    const [row] = await q('SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), expires_at) s FROM api_keys WHERE id = ?', [out.id]);
    expect(row.s).toBeGreaterThan(3500);
    expect(row.s).toBeLessThanOrEqual(3601);                 // stored as UTC, not shifted by a zone (DATETIME rounds the ms)
    expect(await apiKeys.lookup(pool, out.raw)).toEqual({ id: out.id, label: 'vendor', scopes: ['route:/process-jobs'] });

    await q('UPDATE api_keys SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE id = ?', [out.id]);
    apiKeys.invalidateCache();
    expect(await apiKeys.lookup(pool, out.raw)).toBeNull();

    await q('UPDATE api_keys SET expires_at = UTC_TIMESTAMP() + INTERVAL 1 MINUTE WHERE id = ?', [out.id]);
    apiKeys.invalidateCache();
    expect(await apiKeys.lookup(pool, out.raw)).not.toBeNull();

    await q('UPDATE api_keys SET revoked_at = UTC_TIMESTAMP() WHERE id = ?', [out.id]);
    apiKeys.invalidateCache();
    expect(await apiKeys.lookup(pool, out.raw)).toBeNull();  // revoked beats a live expiry
  });

  test('a column of another shape: NO-GO, unaltered', async () => {
    await fresh();
    await q('ALTER TABLE api_keys ADD COLUMN expires_at timestamp NULL');
    const conn = await pool.getConnection();
    try {
      const o = lines();
      expect(await script.run(conn, { apply: true, log: o.log })).toEqual({ ok: false });
      expect(o.out.join('\n')).toMatch(/api_keys\.expires_at exists as timestamp/);
      expect(goLine(o.out)).toEqual([expect.stringMatching(/^NO-GO — re-verify by hand/)]);
    } finally {
      conn.release();
    }
    expect((await q("SHOW COLUMNS FROM api_keys LIKE 'expires_at'"))[0].Type).toBe('timestamp');
  });
});
