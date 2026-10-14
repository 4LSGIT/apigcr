// tests/entitlements.mysql.test.js
//
/**
 * Entitlement denies on REAL MySQL — access-control A5
 * (scripts/accessA5Entitlements.js, services/entitlementService.js).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_a5_test npx jest tests/entitlements.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * entitlement_denies and a minimal users table in it.
 *
 * WHAT IS LOCKED (what a fake db cannot prove)
 *   - The migration script: CHECK → GO, APPLY creates + verifies, a re-run is
 *     a no-op GO, and a table in another shape is a NO-GO never altered.
 *   - The resolver's ONE statement on the engine: denied = firm ∪ the user's
 *     roles (FIND_IN_SET over the real SET column) ∪ the user; deny wins; a
 *     user with no such row still gets the firm denies; undeniable rows
 *     planted by hand are stripped; 'user' refs match numerically.
 *   - The UNIQUE holds for a duplicate FIRM deny (scope_ref '' sentinel) —
 *     refused by the engine, and createDeny maps it to 409.
 */
'use strict';

const mysql = require('mysql2/promise');
const script = require('../scripts/accessA5Entitlements');
const svc = require('../services/entitlementService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;

d('entitlements on real MySQL', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const quiet = () => jest.spyOn(console, 'log').mockImplementation(() => {});

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    await q('DROP TABLE IF EXISTS entitlement_denies');
    await q('DROP TABLE IF EXISTS users');
    await q(`CREATE TABLE users (
               \`user\` tinyint NOT NULL PRIMARY KEY,
               user_auth varchar(20) NOT NULL DEFAULT 'authorized',
               roles set('it','admin','staff','attorney','automation','form_dev','su') NOT NULL DEFAULT ''
             ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`INSERT INTO users (\`user\`, roles) VALUES
               (1, 'admin,staff,attorney'), (5, 'staff'), (6, 'it,admin,form_dev,su'), (22, 'staff')`);
  });
  afterAll(async () => { if (pool) await pool.end(); });
  afterEach(() => jest.restoreAllMocks());

  test('the migration script: CHECK GO, APPLY creates + verifies, re-run is a no-op', async () => {
    quiet();
    const conn = await pool.getConnection();
    try {
      expect(await script.run(conn, { apply: false })).toEqual({ ok: true });
      expect((await q("SHOW TABLES LIKE 'entitlement_denies'"))).toHaveLength(0);   // CHECK wrote nothing
      expect(await script.run(conn, { apply: true })).toEqual({ ok: true });
      expect(await script.run(conn, { apply: true })).toEqual({ ok: true });
      const [[c]] = await conn.query('SHOW CREATE TABLE entitlement_denies');
      expect(c['Create Table']).toMatch(/COLLATE=utf8mb4_general_ci/);
      expect(c['Create Table']).toMatch(/`scope_ref` varchar\(64\)( COLLATE \w+)? NOT NULL DEFAULT ''/);
    } finally { conn.release(); }
  });

  test('a table in another shape is a NO-GO, never altered', async () => {
    quiet();
    const conn = await pool.getConnection();
    try {
      await conn.query('ALTER TABLE entitlement_denies MODIFY scope_ref varchar(64) NULL');
      expect(await script.run(conn, { apply: true })).toEqual({ ok: false });
      const [[col]] = await conn.query(
        "SELECT IS_NULLABLE n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'entitlement_denies' AND column_name = 'scope_ref'");
      expect(col.n).toBe('YES');                                     // left exactly as found
      await conn.query("ALTER TABLE entitlement_denies MODIFY scope_ref varchar(64) NOT NULL DEFAULT '' COMMENT 'empty string = firm (sentinel; NOT NULL so the UNIQUE holds); role = a users.roles SET member; user = users.user as digits'");
      expect(await script.run(conn, { apply: false })).toEqual({ ok: true });
    } finally { conn.release(); }
  });

  describe('resolver', () => {
    beforeEach(async () => {
      await q('DELETE FROM entitlement_denies');
      await q(`INSERT INTO entitlement_denies (scope, scope_ref, item_key, created_by) VALUES
                 ('firm', '',         'moreClioCode', 6),
                 ('role', 'staff',    'moreCampaigns', 6),
                 ('role', 'attorney', 'moreRedirects', 6),
                 ('role', 'it',       'moreCourtPreview', 6),
                 ('user', '5',        'bills', 6),
                 ('user', '22',       'moreReports', 6)`);
    });

    test('firm ∪ the user\'s roles ∪ the user — per user', async () => {
      expect(await svc.deniedFor(pool, 5)).toEqual(['bills', 'moreCampaigns', 'moreClioCode']);
      expect(await svc.deniedFor(pool, 1)).toEqual(['moreCampaigns', 'moreClioCode', 'moreRedirects']);   // multi-role
      expect(await svc.deniedFor(pool, 6)).toEqual(['moreClioCode', 'moreCourtPreview']);
      expect(await svc.deniedFor(pool, 22)).toEqual(['moreCampaigns', 'moreClioCode', 'moreReports']);
    });

    test('deny wins: the same item at several scopes is simply denied, once', async () => {
      await q("INSERT INTO entitlement_denies (scope, scope_ref, item_key, created_by) VALUES ('user', '5', 'moreCampaigns', 6), ('firm', '', 'bills', 6)");
      expect(await svc.deniedFor(pool, 5)).toEqual(['bills', 'moreCampaigns', 'moreClioCode']);
    });

    test('no users row (an x-api-key caller) still gets the firm denies, and only those', async () => {
      expect(await svc.deniedFor(pool, 99)).toEqual(['moreClioCode']);
      expect(await svc.deniedFor(pool, undefined)).toEqual(['moreClioCode']);
    });

    test('a role name is a whole SET member, not a substring', async () => {
      await q("INSERT INTO entitlement_denies (scope, scope_ref, item_key, created_by) VALUES ('role', 'sta', 'adminEtch', 6)");
      expect(await svc.deniedFor(pool, 5)).not.toContain('adminEtch');
    });

    test('undeniable rows planted by hand are stripped at resolve', async () => {
      await q(`INSERT INTO entitlement_denies (scope, scope_ref, item_key, created_by) VALUES
                 ('firm', '', 'moreSettings', 6), ('user', '5', 'helpSupport', 6)`);
      expect(await svc.deniedFor(pool, 5)).toEqual(['bills', 'moreCampaigns', 'moreClioCode']);
    });

    test('a role removed from the user takes effect on the next resolve (DB-fresh)', async () => {
      await q("UPDATE users SET roles = 'admin' WHERE `user` = 1");
      expect(await svc.deniedFor(pool, 1)).toEqual(['moreClioCode']);
      await q("UPDATE users SET roles = 'admin,staff,attorney' WHERE `user` = 1");
    });
  });

  describe('the UNIQUE', () => {
    beforeEach(() => q('DELETE FROM entitlement_denies'));

    test('the engine refuses a duplicate FIRM deny (the \'\' sentinel is why)', async () => {
      await q("INSERT INTO entitlement_denies (scope, scope_ref, item_key, created_by) VALUES ('firm', '', 'bills', 6)");
      await expect(q("INSERT INTO entitlement_denies (scope, scope_ref, item_key, created_by) VALUES ('firm', '', 'bills', 6)"))
        .rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    });

    test('createDeny maps it to 409, with null / omitted firm refs landing on the same row', async () => {
      await svc.createDeny(pool, { scope: 'firm', item_key: 'bills' }, 6);
      await expect(svc.createDeny(pool, { scope: 'firm', scope_ref: null, item_key: 'bills' }, 6)).rejects.toMatchObject({ status: 409 });
      await expect(svc.createDeny(pool, { scope: 'user', scope_ref: '5', item_key: 'bills' }, 6)).resolves.toMatchObject({ scope: 'user' });
      await expect(svc.createDeny(pool, { scope: 'user', scope_ref: 5, item_key: 'bills' }, 6)).rejects.toMatchObject({ status: 409 });
      const rows = await q('SELECT scope, scope_ref FROM entitlement_denies ORDER BY id');
      expect(rows).toEqual([{ scope: 'firm', scope_ref: '' }, { scope: 'user', scope_ref: '5' }]);
    });

    test('deleteDeny removes the one row, and the deny is gone', async () => {
      const { id } = await svc.createDeny(pool, { scope: 'firm', item_key: 'moreReports' }, 6);
      expect(await svc.deniedFor(pool, 5)).toEqual(['moreReports']);
      await svc.deleteDeny(pool, id);
      expect(await svc.deniedFor(pool, 5)).toEqual([]);
      await expect(svc.deleteDeny(pool, id)).rejects.toMatchObject({ status: 404 });
    });
  });
});
