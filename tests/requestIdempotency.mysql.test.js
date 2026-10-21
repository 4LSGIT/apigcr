// tests/requestIdempotency.mysql.test.js
//
/**
 * Request idempotency on REAL MySQL — the SQL in lib/requestIdempotency.js,
 * the migration's DDL, and scripts/caseyP4Idempotency.js's own check/apply.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3341/yc_p4_test npx jest tests/requestIdempotency.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * request_idempotency and a minimal `users` in it.
 *
 * WHY A REAL ENGINE (CLAUDE.md: required for a module's SQL predicates and the
 * row types it reads). A fake cannot hold any of these:
 *   - the UNIQUE key is what fences two tabs — the claim race is ER_DUP_ENTRY
 *     from the engine, not an app-side check;
 *   - `result` is a JSON column: mysql2 hands it back PARSED, so a replay must
 *     not JSON.parse it again;
 *   - the staleness window is TIMESTAMPDIFF(SECOND, updated_at, NOW()) in SQL,
 *     not a JS clock on a mysql2 Date;
 *   - under the production (relaxed) sql_mode an over-long key is stored
 *     TRUNCATED, which would alias two different keys into one false replay —
 *     this file proves the engine does that, which is why the app validates
 *     the key width at the door;
 *   - idem_key is utf8mb4_bin, so two keys differing only in case are two
 *     keys (they are not under the table's general_ci default);
 *   - the user_id FK to users.`user` really rejects an unknown actor.
 */
'use strict';

const mysql = require('mysql2/promise');
const { withIdempotency, IN_FLIGHT_STALE_SECONDS } = require('../lib/requestIdempotency');
const migration = require('../scripts/caseyP4Idempotency');
const { stableJson } = migration;

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-10-21; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

const USER = 6;
const SCOPE = 'tasks.create';

d('request idempotency on real MySQL', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const rowsFor = (key) => q('SELECT * FROM request_idempotency WHERE idem_key = ?', [key]);
  const claim = (key, fn, { userId = USER, scope = SCOPE } = {}) =>
    withIdempotency(pool, { userId, scope, key }, fn);

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 6, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    await q('DROP TABLE IF EXISTS request_idempotency');
    await q('DROP TABLE IF EXISTS users');
    // Only the column the FK needs, with the live type (users.`user` tinyint).
    await q(`CREATE TABLE users (
      \`user\` tinyint NOT NULL PRIMARY KEY, user_name varchar(100) DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q("INSERT INTO users (`user`, user_name) VALUES (0, 'Automations'), (1, 'Stuart'), (6, 'Fred')");
  });

  afterAll(async () => { if (pool) await pool.end(); });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the migration script', () => {
    test('CHECK refuses to run before the table exists, then --apply creates and verifies it', async () => {
      const lines = [];
      const log = (s) => lines.push(String(s));
      const before = await migration.run(pool, { apply: false, log });
      expect(before.ok).toBe(true);
      expect(before.line).toMatch(/^CHECK OK — GO\./);
      expect(before.state.exists).toBe(false);

      const applied = await migration.run(pool, { apply: true, log });
      expect(applied.line).toMatch(/^P4 APPLIED — GO\./);
      expect(applied.ok).toBe(true);
      // The smoke test's own assertions ran against this engine.
      expect(lines.join('\n')).toMatch(/second claim for the same \(user, scope, key\) is ER_DUP_ENTRY/);
      expect(lines.join('\n')).toMatch(/utf8mb4_bin/);
      expect(lines.join('\n')).toMatch(/every smoke row disappeared with the rollback/);

      const again = await migration.run(pool, { apply: false, log });
      expect(again.line).toMatch(/^ALREADY APPLIED/);
      expect(again.done).toBe(true);
    });

    test('the live shape matches the migration, and a wrong shape is caught', async () => {
      const s = await migration.readState(pool);
      expect(migration.shapeProblems(s)).toEqual([]);
      expect(s.columns.map((c) => c.name)).toEqual(Object.keys(migration.EXPECTED_COLUMNS));
      // The two facts the module depends on, read off the live table.
      const byName = new Map(s.columns.map((c) => [c.name, c]));
      expect(byName.get('idem_key').collation_name).toBe('utf8mb4_bin');
      expect(byName.get('result').type).toBe('json');
      // A shape check that cannot fail is not a check.
      expect(migration.shapeProblems({ ...s, columns: s.columns.filter((c) => c.name !== 'idem_key'), indexes: [], fks: [] }).length)
        .toBeGreaterThan(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the engine facts the module relies on', () => {
    test('the UNIQUE key is per (user, scope, key); case differs because idem_key is utf8mb4_bin', async () => {
      const key = 'engine-unique-aaaa';
      await q("INSERT INTO request_idempotency (user_id, scope, idem_key) VALUES (?,?,?)", [USER, SCOPE, key]);
      let code = null;
      try { await q("INSERT INTO request_idempotency (user_id, scope, idem_key) VALUES (?,?,?)", [USER, SCOPE, key]); }
      catch (e) { code = e.code; }
      expect(code).toBe('ER_DUP_ENTRY');
      // Same key, other user / other scope / other case: all accepted.
      await q("INSERT INTO request_idempotency (user_id, scope, idem_key) VALUES (?,?,?)", [1, SCOPE, key]);
      await q("INSERT INTO request_idempotency (user_id, scope, idem_key) VALUES (?,?,?)", [USER, 'events.create', key]);
      await q("INSERT INTO request_idempotency (user_id, scope, idem_key) VALUES (?,?,?)", [USER, SCOPE, key.toUpperCase()]);
      expect((await q('SELECT COUNT(*) AS n FROM request_idempotency WHERE LOWER(idem_key) = ?', [key]))[0].n).toBe(4);
      await q('DELETE FROM request_idempotency');
    });

    test('an unknown actor is refused by the FK, not written', async () => {
      let code = null;
      try { await q("INSERT INTO request_idempotency (user_id, scope, idem_key) VALUES (?,?,?)", [99, SCOPE, 'engine-fk-aaaaaa']); }
      catch (e) { code = e.code; }
      expect(code).toBe('ER_NO_REFERENCED_ROW_2');
      expect(await rowsFor('engine-fk-aaaaaa')).toEqual([]);
    });

    test('an over-long key is stored TRUNCATED under the production sql_mode — why the app validates its width', async () => {
      const [{ sm }] = await q('SELECT @@SESSION.sql_mode AS sm');
      expect(sm).not.toMatch(/STRICT_(TRANS|ALL)_TABLES/);
      const long = 'x'.repeat(100) + 'AAA';
      const other = 'x'.repeat(100) + 'BBB';
      await q("INSERT INTO request_idempotency (user_id, scope, idem_key) VALUES (?,?,?)", [USER, SCOPE, long]);
      const [row] = await q('SELECT idem_key FROM request_idempotency WHERE scope = ?', [SCOPE]);
      expect(row.idem_key).toHaveLength(100);              // silently cut
      // So a DIFFERENT 103-char key collides with it: a false replay. The app
      // refuses anything over 100 characters before it ever gets here.
      let code = null;
      try { await q("INSERT INTO request_idempotency (user_id, scope, idem_key) VALUES (?,?,?)", [USER, SCOPE, other]); }
      catch (e) { code = e.code; }
      expect(code).toBe('ER_DUP_ENTRY');
      await q('DELETE FROM request_idempotency');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('withIdempotency against the engine', () => {
    beforeEach(async () => { await q('DELETE FROM request_idempotency'); });

    test('no key: fn runs and not one row is written', async () => {
      const fn = jest.fn().mockResolvedValue({ task_id: 1 });
      await expect(withIdempotency(pool, { userId: USER, scope: SCOPE, key: null }, fn))
        .resolves.toEqual({ value: { task_id: 1 }, replayed: false, idempotent: false });
      expect((await q('SELECT COUNT(*) AS n FROM request_idempotency'))[0].n).toBe(0);
    });

    test('claim, settle, replay: one record, and the stored JSON replays as the same wire bytes', async () => {
      const key = 'real-replay-0001';
      const value = { status: 'success', task_id: 7, action_url: 'https://app/t/x', nested: { rows: [1, 2, 3] }, nil: null };
      const fn = jest.fn().mockResolvedValue(value);
      const first = await claim(key, fn);
      expect(first).toMatchObject({ replayed: false, recorded: true });

      const [row] = await rowsFor(key);
      expect(row.status).toBe('applied');
      expect(typeof row.result).toBe('object');        // mysql2 parses a JSON column
      expect(row.user_id).toBe(USER);

      const second = await claim(key, fn);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(second.replayed).toBe(true);
      // Every value round-trips, including the null and the nested array.
      expect(second.value).toEqual(value);
      // But NOT byte-for-byte: MySQL re-orders JSON object keys on write (by
      // length, then lexicographically), so the replayed response carries the
      // same pairs in a different order. Compared key-order-insensitively
      // (CLAUDE.md, wf50) — and asserted, so the claim stays honest.
      expect(stableJson(second.value)).toBe(stableJson(value));
      expect(JSON.stringify(second.value)).not.toBe(JSON.stringify(value));
      expect((await rowsFor(key))).toHaveLength(1);
    });

    test('two concurrent submissions: one applies, the other is 409 in_flight, one row, fn once', async () => {
      const key = 'real-race-000001';
      let release;
      const gate = new Promise((res) => { release = res; });
      const fn = jest.fn(async () => { await gate; return { appt_id: 5 }; });
      const a = claim(key, fn);
      // Let a's claim commit, then start b (the browser's two-tab case).
      await new Promise((r) => setTimeout(r, 30));
      const b = claim(key, fn).then(() => 'resolved', (e) => e);
      const bErr = await b;
      expect(bErr).toBeInstanceOf(Error);
      expect(bErr.idempotency).toEqual({ status: 409, outcome: 'in_flight' });
      release();
      await expect(a).resolves.toMatchObject({ value: { appt_id: 5 }, replayed: false });
      expect(fn).toHaveBeenCalledTimes(1);
      expect(await rowsFor(key)).toHaveLength(1);
    });

    test('a truly simultaneous pair (no head start) still yields exactly one apply', async () => {
      const key = 'real-race-000002';
      let n = 0;
      const fn = jest.fn(async () => { n += 1; return { n }; });
      const results = await Promise.allSettled([claim(key, fn), claim(key, fn)]);
      // Exactly one submission applied. The loser either replays (the winner
      // had already settled) or is refused 409 — never a second apply.
      expect(fn).toHaveBeenCalledTimes(1);
      expect(n).toBe(1);
      expect(await rowsFor(key)).toHaveLength(1);
      const applied = results.filter((r) => r.status === 'fulfilled' && r.value.replayed === false);
      expect(applied).toHaveLength(1);
      const loser = results.find((r) => r !== applied[0]);
      if (loser.status === 'fulfilled') expect(loser.value).toMatchObject({ replayed: true, value: { n: 1 } });
      else expect(loser.reason.idempotency.status).toBe(409);
    });

    test('a claim stranded past the window reads unknown from the engine clock, and is never taken over', async () => {
      const key = 'real-unknown-0001';
      await q("INSERT INTO request_idempotency (user_id, scope, idem_key, status, updated_at) VALUES (?,?,?,'in_flight', NOW() - INTERVAL ? SECOND)",
        [USER, SCOPE, key, IN_FLIGHT_STALE_SECONDS + 5]);
      const fn = jest.fn();
      const err = await claim(key, fn).then(() => null, (e) => e);
      expect(err.idempotency).toEqual({ status: 409, outcome: 'unknown' });
      expect(fn).not.toHaveBeenCalled();
      const [row] = await rowsFor(key);
      expect(row.status).toBe('in_flight');
      // Just inside the window it is the retryable outcome instead.
      await q('UPDATE request_idempotency SET updated_at = NOW() - INTERVAL ? SECOND WHERE idem_key = ?',
        [IN_FLIGHT_STALE_SECONDS - 30, key]);
      const err2 = await claim(key, fn).then(() => null, (e) => e);
      expect(err2.idempotency).toEqual({ status: 409, outcome: 'in_flight' });
    });

    test('a failed fn deletes its claim, so the same key is honestly retryable', async () => {
      const key = 'real-failure-0001';
      const boom = jest.fn().mockRejectedValue(new Error('provider is unavailable'));
      await expect(claim(key, boom)).rejects.toThrow('provider is unavailable');
      expect(await rowsFor(key)).toEqual([]);
      const ok = jest.fn().mockResolvedValue({ task_id: 2 });
      await expect(claim(key, ok)).resolves.toMatchObject({ value: { task_id: 2 }, replayed: false });
      expect(await rowsFor(key)).toHaveLength(1);
    });

    test('an undefined result still settles, and replays as null', async () => {
      const key = 'real-undefined-01';
      const fn = jest.fn().mockResolvedValue(undefined);
      await expect(claim(key, fn)).resolves.toMatchObject({ replayed: false, recorded: true });
      const second = await claim(key, fn);
      expect(second).toEqual({ value: null, replayed: true, idempotent: true });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('the claim is committed before fn runs — a sibling connection can see it mid-flight', async () => {
      const key = 'real-visible-0001';
      let seenByOther = null;
      const fn = jest.fn(async () => {
        // A DIFFERENT pooled connection, i.e. what the second tab's request uses.
        const other = await pool.getConnection();
        try { seenByOther = (await other.query('SELECT status FROM request_idempotency WHERE idem_key = ?', [key]))[0]; }
        finally { other.release(); }
        return { task_id: 4 };
      });
      await claim(key, fn);
      expect(seenByOther).toEqual([{ status: 'in_flight' }]);
    });
  });
});
