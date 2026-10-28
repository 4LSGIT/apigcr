// tests/sharedValues.mysql.test.js
//
/**
 * Shared values on a REAL MySQL — the migration script's DDL and verify, and
 * the service's SQL predicates under real locking (settings-access arc,
 * 2026-10-28). The in-memory twin is tests/sharedValues.test.js.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_shared_test npx jest tests/sharedValues.mysql.test.js --runInBand
 * The database name must end in _test (it is created if absent). This suite
 * DROPS and recreates shared_values / shared_namespaces in it. Sessions run
 * prod's relaxed sql_mode (no STRICT_TRANS_TABLES), whatever the server's
 * global mode — the enum and truncation behaviour depend on it. Never point
 * it at 127.0.0.1:3306: on a dev machine that is production.
 *
 * WHAT IS LOCKED
 *   - The script: CHECK creates nothing; --apply creates both tables and its
 *     own verify passes against the real information_schema (types,
 *     collations, primary keys, the cascade FK); a re-run is a no-op GO; a
 *     pre-existing table of another shape is a NO-GO, never altered.
 *   - The columns compare case-sensitively (utf8mb4_bin) and are still PAD
 *     SPACE — why the route's pattern refuses spaces.
 *   - Compare-and-set holds under real concurrency: of two creates of one key
 *     exactly one lands; of two updates from the same rev exactly one lands;
 *     with max_keys 1, of two creates of different keys exactly one lands
 *     (the FOR UPDATE on the namespace row).
 *   - A 409's `current` and a delete's 404 reflect the LATEST committed row,
 *     not the transaction's REPEATABLE READ snapshot: a writer that loses to
 *     an update holding the row lock is told rev 2 and the winner's value; a
 *     delete that loses to another delete gets 404, not 409 (review of
 *     b902a84, reproduced on 8.4.11 before the FOR SHARE re-read).
 *   - A write_mode relaxed sql_mode stored as '' refuses writes.
 *   - Deleting a namespace removes its values (and the FK cascades on its own).
 *   - HISTORY (scripts/sharedValuesHistoryMigrate.js): the migration's CHECK /
 *     APPLY / re-run and a wrong-shape NO-GO on the real engine; each write
 *     leaves its row (before / after / revs / writer); of four racing updates
 *     exactly one history row lands (the losers' 409s write none); LENGTH()
 *     counts BYTES, as the page budget assumes; the history reads newest
 *     first, by key, by page — and still after the namespace is deleted.
 *   - The history's "before" is the row an update / delete REPLACED, not the
 *     transaction's snapshot: another writer commits rev 1 → 2 ('B') right
 *     after the write's first read (which fixes the REPEATABLE READ snapshot);
 *     the write, naming rev 2, records old_v 'B' — only because it reads the
 *     row FOR UPDATE (a plain read returns the snapshot's 'A').
 */
'use strict';

const mysql = require('mysql2/promise');
const script = require('../scripts/sharedValuesMigrate');
const hscript = require('../scripts/sharedValuesHistoryMigrate');
const svc = require('../services/sharedValuesService');
const { withTransaction } = require('../lib/withTransaction');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

const staff = (userId, extra = {}) => ({ type: 'jwt', userId, roles: ['staff'], ...extra });

d('shared values on real MySQL', () => {
  let pool;
  let db;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const quiet = () => jest.spyOn(console, 'log').mockImplementation(() => {});

  beforeAll(async () => {
    const u = new URL(URL_);
    const dbName = u.pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (u.port === '3306' || u.port === '') throw new Error('refusing port 3306: on a dev machine that is production');
    const admin = await mysql.createConnection({ host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username) || 'root',
      password: decodeURIComponent(u.password) || undefined });
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
    await admin.end();
    pool = mysql.createPool({ uri: URL_, connectionLimit: 6, timezone: 'Z' });
    pool.pool.on('connection', (c) => { c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`); });
    db = { query: (s, p) => pool.query(s, p), getConnection: () => pool.getConnection() };
    db.withTransaction = (fn, opts) => withTransaction(db, fn, opts);
    await q('DROP TABLE IF EXISTS shared_values_history');
    await q('DROP TABLE IF EXISTS shared_values');
    await q('DROP TABLE IF EXISTS shared_namespaces');
  });
  afterAll(async () => { if (pool) await pool.end(); });
  afterEach(() => jest.restoreAllMocks());

  test('the session runs prod\'s relaxed mode', async () => {
    const [[m]] = await pool.query('SELECT @@SESSION.sql_mode m');
    expect(m.m).not.toMatch(/STRICT_TRANS_TABLES|ONLY_FULL_GROUP_BY|NO_BACKSLASH_ESCAPES/);
  });

  test('migration: CHECK creates nothing; APPLY creates and verifies; a re-run is a no-op GO', async () => {
    quiet();
    const conn = await pool.getConnection();
    try {
      expect(await script.run(conn, { apply: false })).toEqual({ ok: true });
      expect(await q("SHOW TABLES LIKE 'shared\\_%'")).toHaveLength(0);
      expect(await script.run(conn, { apply: true })).toEqual({ ok: true });
      expect((await q("SHOW TABLES LIKE 'shared\\_%'")).length).toBe(2);
      const st = await script.state(conn);
      expect(st).toEqual({ namespaces: 'present', values: 'present', problems: [] });
      expect(await script.run(conn, { apply: true })).toEqual({ ok: true });
      // the history table (its own script)
      expect(await hscript.run(conn, { apply: false })).toEqual({ ok: true });
      expect(await q("SHOW TABLES LIKE 'shared\\_values\\_history'")).toHaveLength(0);
      expect(await hscript.run(conn, { apply: true })).toEqual({ ok: true });
      expect(await hscript.state(conn)).toEqual({ history: 'present', problems: [] });
      expect(await hscript.run(conn, { apply: true })).toEqual({ ok: true });
    } finally { conn.release(); }
  });

  test('history migration: a pre-existing table of another shape is a NO-GO, never altered', async () => {
    quiet();
    const conn = await pool.getConnection();
    try {
      await conn.query('ALTER TABLE shared_values_history DROP INDEX idx_shared_values_history_ns_k_id, ADD INDEX idx_shared_values_history_ns_k_id (ns, id)');
      const out = [];
      expect(await hscript.run(conn, { apply: true, log: (s) => out.push(s) })).toEqual({ ok: false });
      expect(out.join('\n')).toMatch(/index idx_shared_values_history_ns_k_id is \(ns,id\), expected \(ns, k, id\)/);
      await conn.query('ALTER TABLE shared_values_history DROP INDEX idx_shared_values_history_ns_k_id, ADD INDEX idx_shared_values_history_ns_k_id (ns, k, id)');
      expect(await hscript.run(conn, { apply: false })).toEqual({ ok: true });
    } finally { conn.release(); }
  });

  test('a pre-existing table of another shape is a NO-GO and is never altered', async () => {
    quiet();
    const conn = await pool.getConnection();
    try {
      await conn.query('ALTER TABLE shared_values MODIFY `k` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL');
      const out = [];
      expect(await script.run(conn, { apply: true, log: (s) => out.push(s) })).toEqual({ ok: false });
      expect(out.join('\n')).toMatch(/shared_values\.k collation utf8mb4_general_ci, expected utf8mb4_bin/);
      const [[c]] = await conn.query("SHOW FULL COLUMNS FROM shared_values LIKE 'k'");
      expect(c.Collation).toBe('utf8mb4_general_ci');
      await conn.query('ALTER TABLE shared_values MODIFY `k` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL');
      expect(await script.run(conn, { apply: false })).toEqual({ ok: true });
    } finally { conn.release(); }
  });

  test('names compare case-sensitively and are still PAD SPACE', async () => {
    await svc.createNamespace(db, { ns: 'coll' }, staff(5));
    await svc.putValue(db, 'coll', 'abc', { v: '1', rev: null }, staff(5));
    expect(await q("SELECT k FROM shared_values WHERE ns = 'coll' AND k = 'ABC'")).toHaveLength(0);
    expect(await q("SELECT k FROM shared_values WHERE ns = 'coll' AND k = 'abc '")).toHaveLength(1);
  });

  test('compare-and-set: create, conflict, update, stale rev — on the real engine', async () => {
    await svc.createNamespace(db, { ns: 'cas' }, staff(5));
    const a = await svc.putValue(db, 'cas', 'high', { v: '100', rev: null }, staff(5));
    expect(a).toMatchObject({ v: '100', rev: 1, updated_by: 5, updated_act: null });
    await expect(svc.putValue(db, 'cas', 'high', { v: '200', rev: null }, staff(7)))
      .rejects.toMatchObject({ httpStatus: 409, code: 'exists', current: expect.objectContaining({ v: '100', rev: 1 }) });
    const b = await svc.putValue(db, 'cas', 'high', { v: '150', rev: 1 }, staff(7, { impersonator: { userId: 6 } }));
    expect(b).toMatchObject({ v: '150', rev: 2, updated_by: 7, updated_act: 6 });
    await expect(svc.putValue(db, 'cas', 'high', { v: '120', rev: 1 }, staff(5)))
      .rejects.toMatchObject({ httpStatus: 409, code: 'rev_conflict', current: expect.objectContaining({ v: '150', rev: 2 }) });
    const [[row]] = await pool.query("SELECT v, rev FROM shared_values WHERE ns = 'cas' AND k = 'high'");
    expect(row).toEqual({ v: '150', rev: 2 });
  });

  test('concurrency: two creates of one key → exactly one lands', async () => {
    await svc.createNamespace(db, { ns: 'race1' }, staff(5));
    const rs = await Promise.allSettled([5, 7, 9, 11].map((u) => svc.putValue(db, 'race1', 'k', { v: String(u), rev: null }, staff(u))));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rs.filter((r) => r.status === 'rejected').map((r) => r.reason.httpStatus)).toEqual([409, 409, 409]);
  });

  test('concurrency: updates from the same rev → exactly one lands, rev ends at 2', async () => {
    await svc.createNamespace(db, { ns: 'race2' }, staff(5));
    await svc.putValue(db, 'race2', 'k', { v: 'start', rev: null }, staff(5));
    const rs = await Promise.allSettled([5, 7, 9, 11].map((u) => svc.putValue(db, 'race2', 'k', { v: String(u), rev: 1 }, staff(u))));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const losers = rs.filter((r) => r.status === 'rejected').map((r) => r.reason);
    expect(losers.every((e) => e.code === 'rev_conflict')).toBe(true);
    expect(losers.map((e) => e.current && e.current.rev)).toEqual([2, 2, 2]);
    const winner = rs.find((r) => r.status === 'fulfilled').value;
    expect(losers.every((e) => e.current.v === winner.v)).toBe(true);
    const [[row]] = await pool.query("SELECT rev FROM shared_values WHERE ns = 'race2' AND k = 'k'");
    expect(Number(row.rev)).toBe(2);
    // exactly one update in the history — the winner's; the losers' 409s wrote none
    const h = await q("SELECT op, old_v, new_v, old_rev, new_rev, changed_by FROM shared_values_history WHERE ns = 'race2' AND k = 'k' ORDER BY id");
    expect(h.map((r) => r.op)).toEqual(['create', 'update']);
    expect(h[1]).toMatchObject({ old_v: 'start', new_v: winner.v, old_rev: 1, new_rev: 2, changed_by: winner.updated_by });
  });

  // The reviewer's repro (scratchpad stale.js): B holds the row lock with an
  // uncommitted rev 1 → 2 while A's PUT from rev 1 starts; B commits.
  test('a PUT that loses to an update holding the lock is told the LATEST row (rev 2, B\'s value)', async () => {
    await svc.createNamespace(db, { ns: 'stale1' }, staff(5));
    await svc.putValue(db, 'stale1', 'k', { v: 'start', rev: null }, staff(5));
    const b = await pool.getConnection();
    try {
      await b.beginTransaction();
      await b.query("UPDATE shared_values SET v = 'B', rev = rev + 1 WHERE ns = 'stale1' AND k = 'k'");
      const pA = svc.putValue(db, 'stale1', 'k', { v: 'A', rev: 1 }, staff(7)).then(() => null, (e) => e);
      await new Promise((r) => setTimeout(r, 300));
      await b.commit();
      const err = await pA;
      expect(err).toMatchObject({ httpStatus: 409, code: 'rev_conflict', current: expect.objectContaining({ v: 'B', rev: 2 }) });
    } finally { b.release(); }
  });

  test('a DELETE that loses to another delete gets 404, not 409', async () => {
    await svc.createNamespace(db, { ns: 'stale2' }, staff(5));
    await svc.putValue(db, 'stale2', 'k', { v: 'start', rev: null }, staff(5));
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      await c.query("DELETE FROM shared_values WHERE ns = 'stale2' AND k = 'k'");
      const pD = svc.deleteValue(db, 'stale2', 'k', undefined, staff(7)).then(() => null, (e) => e);
      await new Promise((r) => setTimeout(r, 300));
      await c.commit();
      const err = await pD;
      expect(err).toMatchObject({ httpStatus: 404 });
    } finally { c.release(); }
  });

  test('concurrency: max_keys 1, creates of different keys → exactly one lands', async () => {
    await svc.createNamespace(db, { ns: 'race3', max_keys: 1 }, staff(5));
    const rs = await Promise.allSettled(['a', 'b', 'c', 'd'].map((k) => svc.putValue(db, 'race3', k, { v: k, rev: null }, staff(5))));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rs.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'full')).toBe(true);
    expect(await q("SELECT k FROM shared_values WHERE ns = 'race3'")).toHaveLength(1);
  });

  test('relaxed sql_mode stores an unknown write_mode as \'\' — and writes are refused', async () => {
    await q("INSERT INTO shared_namespaces (ns, write_mode, created_by) VALUES ('broken', 'bogus', 5)");
    const [[n]] = await pool.query("SELECT write_mode FROM shared_namespaces WHERE ns = 'broken'");
    expect(n.write_mode).toBe('');
    await expect(svc.putValue(db, 'broken', 'x', { v: '1', rev: null }, staff(5))).rejects.toMatchObject({ httpStatus: 403 });
  });

  test('deleting a namespace removes its values; the FK cascades on its own too', async () => {
    await svc.createNamespace(db, { ns: 'gone' }, staff(5));
    await svc.putValue(db, 'gone', 'a', { v: '1', rev: null }, staff(5));
    await svc.putValue(db, 'gone', 'b', { v: '2', rev: null }, staff(5));
    expect(await svc.deleteNamespace(db, 'gone', staff(5))).toEqual({ ns: 'gone', values_deleted: 2 });
    expect(await q("SELECT * FROM shared_values WHERE ns = 'gone'")).toHaveLength(0);
    await svc.createNamespace(db, { ns: 'cascade' }, staff(5));
    await svc.putValue(db, 'cascade', 'a', { v: '1', rev: null }, staff(5));
    await q("DELETE FROM shared_namespaces WHERE ns = 'cascade'");
    expect(await q("SELECT * FROM shared_values WHERE ns = 'cascade'")).toHaveLength(0);
  });

  test('the listing\'s key count and paging run on the real engine', async () => {
    await svc.createNamespace(db, { ns: 'page' }, staff(5));
    for (const k of ['c', 'a', 'b']) await svc.putValue(db, 'page', k, { v: k, rev: null }, staff(5));
    const list = await svc.listNamespaces(db);
    expect(list.find((n) => n.ns === 'page').key_count).toBe(3);
    const p1 = await svc.listValues(db, 'page', { limit: '2' });
    expect([p1.values.map((v) => v.k), p1.next]).toEqual([['a', 'b'], 'b']);
    const p2 = await svc.listValues(db, 'page', { limit: '2', after: 'b' });
    expect([p2.values.map((v) => v.k), p2.next]).toEqual([['c'], null]);
  });

  test('history: each write leaves its row on the real engine; ns_delete carries the key count', async () => {
    await svc.createNamespace(db, { ns: 'hist', description: 'H' }, staff(5));
    await svc.updateNamespace(db, 'hist', { max_keys: 9 }, staff(5));
    await svc.putValue(db, 'hist', 'k', { v: 'one', rev: null }, staff(5));
    await svc.putValue(db, 'hist', 'k', { v: 'two', rev: 1 }, staff(7, { impersonator: { userId: 6 } }));
    await svc.deleteValue(db, 'hist', 'k', '2', staff(5));
    await svc.putValue(db, 'hist', 'z', { v: 'z', rev: null }, staff(5));
    await svc.deleteNamespace(db, 'hist', staff(5));
    const h = await q("SELECT k, op, old_v, new_v, old_rev, new_rev, changed_by, changed_act FROM shared_values_history WHERE ns = 'hist' ORDER BY id");
    expect(h.map((r) => [r.k, r.op, r.old_rev, r.new_rev, r.changed_by, r.changed_act])).toEqual([
      [null, 'ns_create', null, null, 5, null], [null, 'ns_update', null, null, 5, null],
      ['k', 'create', null, 1, 5, null], ['k', 'update', 1, 2, 7, 6], ['k', 'delete', 2, null, 5, null],
      ['z', 'create', null, 1, 5, null], [null, 'ns_delete', null, null, 5, null]]);
    expect([h[3].old_v, h[3].new_v, h[4].old_v, h[4].new_v]).toEqual(['one', 'two', 'two', null]);
    expect(JSON.parse(h[6].old_v)).toEqual({ description: 'H', write_mode: 'staff', max_value_bytes: 65536, max_keys: 9, key_count: 1 });
    // still readable after the delete; newest first; by key; paged
    const all = await svc.listHistory(db, 'hist');
    expect([all.namespace, all.history.map((r) => r.op)]).toEqual([null,
      ['ns_delete', 'create', 'delete', 'update', 'create', 'ns_update', 'ns_create']]);
    const byKey = await svc.listHistory(db, 'hist', { k: 'k', limit: '2' });
    expect(byKey.history.map((r) => r.op)).toEqual(['delete', 'update']);
    const rest = await svc.listHistory(db, 'hist', { k: 'k', limit: '2', before: String(byKey.next) });
    expect([rest.history.map((r) => r.op), rest.next]).toEqual([['create'], null]);
  });

  test('history: LENGTH() counts bytes (the page budget\'s unit), and a failed write leaves no row', async () => {
    await svc.createNamespace(db, { ns: 'bytes' }, staff(5));
    await svc.putValue(db, 'bytes', 'k', { v: 'éé', rev: null }, staff(5));        // 2 characters, 4 bytes
    const [[r]] = await pool.query(
      "SELECT COALESCE(LENGTH(old_v), 0) + COALESCE(LENGTH(new_v), 0) AS bytes FROM shared_values_history WHERE ns = 'bytes' AND k = 'k'");
    expect(Number(r.bytes)).toBe(4);
    await expect(svc.putValue(db, 'bytes', 'k', { v: 'x', rev: 7 }, staff(5))).rejects.toMatchObject({ httpStatus: 409 });
    await expect(svc.putValue(db, 'bytes', 'k', { v: 'x'.repeat(65537), rev: 1 }, staff(5))).rejects.toMatchObject({ httpStatus: 413 });
    expect((await q("SELECT op FROM shared_values_history WHERE ns = 'bytes' ORDER BY id")).map((x) => x.op)).toEqual(['ns_create', 'create']);
  });

  // A db whose transactions pause after their FIRST namespace read (loadNs —
  // the consistent read that fixes the snapshot) while another connection
  // commits a change; every other call goes straight to the pool.
  function racingDb(afterFirstNsRead) {
    let fired = false;
    const w = {
      query: (s, p) => pool.query(s, p),
      getConnection: async () => {
        const c = await pool.getConnection();
        return {
          beginTransaction: () => c.beginTransaction(), commit: () => c.commit(), rollback: () => c.rollback(),
          release: () => c.release(), destroy: () => c.destroy(),
          async query(sql, params) {
            const r = await c.query(sql, params);
            if (!fired && /FROM shared_namespaces WHERE ns = \?/.test(String(sql))) { fired = true; await afterFirstNsRead(); }
            return r;
          },
        };
      },
    };
    w.withTransaction = (fn, opts) => withTransaction(w, fn, opts);
    return w;
  }
  const bumpToB = (ns) => () => pool.query("UPDATE shared_values SET v = 'B', rev = rev + 1 WHERE ns = ? AND k = 'k'", [ns]);

  test('history "before" on an update is the row it replaced (FOR UPDATE), not the snapshot', async () => {
    await svc.createNamespace(db, { ns: 'lock1' }, staff(5));
    await svc.putValue(db, 'lock1', 'k', { v: 'A', rev: null }, staff(5));
    const out = await svc.putValue(racingDb(bumpToB('lock1')), 'lock1', 'k', { v: 'C', rev: 2 }, staff(7));
    expect(out).toMatchObject({ v: 'C', rev: 3 });
    const [h] = await q("SELECT op, old_v, new_v, old_rev, new_rev FROM shared_values_history WHERE ns = 'lock1' AND op = 'update'");
    expect(h).toEqual({ op: 'update', old_v: 'B', new_v: 'C', old_rev: 2, new_rev: 3 });
  });

  test('history "before" on a delete is the row it removed (FOR UPDATE), not the snapshot', async () => {
    await svc.createNamespace(db, { ns: 'lock2' }, staff(5));
    await svc.putValue(db, 'lock2', 'k', { v: 'A', rev: null }, staff(5));
    expect(await svc.deleteValue(racingDb(bumpToB('lock2')), 'lock2', 'k', '2', staff(7))).toEqual({ ns: 'lock2', k: 'k', deleted: true });
    const [h] = await q("SELECT op, old_v, new_v, old_rev, new_rev FROM shared_values_history WHERE ns = 'lock2' AND op = 'delete'");
    expect(h).toEqual({ op: 'delete', old_v: 'B', new_v: null, old_rev: 2, new_rev: null });
  });
});
