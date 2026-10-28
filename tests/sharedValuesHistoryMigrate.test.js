// tests/sharedValuesHistoryMigrate.test.js
//
/**
 * scripts/sharedValuesHistoryMigrate.js without a database (the real-engine
 * run is tests/sharedValues.mysql.test.js, gated).
 *
 * WHAT IS LOCKED
 *   - The DDL the script runs is the DDL
 *     ref/migrations/2026-10-28_shared_values_history.sql records.
 *   - Schema conventions: no DEFAULT CHARSET; ns / k utf8mb4_bin; the value
 *     columns not; NO foreign key (history outlives a deleted namespace).
 *   - EXPECTED names the DDL's columns, in order.
 *   - shapeProblems flags a wrong collation, type, nullability, column set,
 *     primary key, auto_increment, or either index: (ns, k, id) for one key's
 *     history, (ns, id) for a whole namespace's (WHERE ns = ? ORDER BY id DESC).
 *   - run(): CHECK plans and creates nothing; a wrong live state or database
 *     collation is a NO-GO that creates nothing; APPLY creates the table
 *     with lock_wait_timeout set first; an applied table is a GO no-op.
 *
 * Run: npx jest tests/sharedValuesHistoryMigrate.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const m = require('../scripts/sharedValuesHistoryMigrate');

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const SQL = fs.readFileSync(path.join(__dirname, '..', 'ref', 'migrations', '2026-10-28_shared_values_history.sql'), 'utf8');
const columnLines = (ddl) => ddl.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('`'))
  .map((l) => [l.match(/^`(\w+)`/)[1], l]);

describe('the DDL', () => {
  test('the script runs exactly what the migration record holds', () => {
    expect(norm(SQL)).toContain(norm(m.CREATE_HISTORY));
    expect((SQL.match(/CREATE TABLE/g) || []).length).toBe(1);
  });

  test('schema conventions: no DEFAULT CHARSET, ns / k bin, values general, no FK', () => {
    expect(m.CREATE_HISTORY).not.toMatch(/DEFAULT CHARSET/i);
    expect(m.CREATE_HISTORY).not.toMatch(/FOREIGN KEY|REFERENCES/i);
    const c = Object.fromEntries(columnLines(m.CREATE_HISTORY));
    expect(c.ns).toMatch(/COLLATE utf8mb4_bin NOT NULL/);
    expect(c.k).toMatch(/COLLATE utf8mb4_bin DEFAULT NULL/);
    expect(c.old_v).not.toMatch(/utf8mb4_bin/);
    expect(c.new_v).not.toMatch(/utf8mb4_bin/);
    expect(c.id).toMatch(/AUTO_INCREMENT/);
    expect(m.CREATE_HISTORY).toMatch(/KEY `idx_shared_values_history_ns_k_id` \(`ns`, `k`, `id`\)/);
    expect(m.CREATE_HISTORY).toMatch(/KEY `idx_shared_values_history_ns_id` \(`ns`, `id`\)/);
  });

  test('EXPECTED names the DDL\'s columns, in order', () => {
    expect(Object.keys(m.EXPECTED)).toEqual(columnLines(m.CREATE_HISTORY).map(([n]) => n));
  });

  test('the op enum is the service\'s', () => {
    const svc = require('../services/sharedValuesService');
    expect(m.EXPECTED.op[0]).toBe(`enum(${svc.HISTORY_OPS.map((o) => `'${o}'`).join(',')})`);
  });
});

function goodInfo() {
  return {
    type: 'BASE TABLE', coll: 'utf8mb4_general_ci',
    cols: Object.entries(m.EXPECTED).map(([name, [type, nullable, coll]]) =>
      ({ name, type, nullable, coll: coll || null, extra: name === 'id' ? 'auto_increment' : '' })),
    indexes: { PRIMARY: ['id'], [m.INDEX]: ['ns', 'k', 'id'], [m.NS_INDEX]: ['ns', 'id'] },
  };
}

describe('shapeProblems', () => {
  test('a correct table has none', () => {
    expect(m.shapeProblems(goodInfo())).toEqual([]);
  });

  test.each([
    ['k collation', (i) => { i.cols.find((c) => c.name === 'k').coll = 'utf8mb4_general_ci'; }, /\.k collation utf8mb4_general_ci, expected utf8mb4_bin/],
    ['k nullability', (i) => { i.cols.find((c) => c.name === 'k').nullable = 'NO'; }, /\.k nullable=NO, expected YES/],
    ['changed_by nullability', (i) => { i.cols.find((c) => c.name === 'changed_by').nullable = 'YES'; }, /changed_by nullable=YES, expected NO/],
    ['old_rev type', (i) => { i.cols.find((c) => c.name === 'old_rev').type = 'int'; }, /old_rev is int, expected int unsigned/],
    ['a missing column', (i) => { i.cols = i.cols.filter((c) => c.name !== 'changed_act'); }, /columns are \[/],
    ['auto_increment', (i) => { i.cols.find((c) => c.name === 'id').extra = ''; }, /id is not AUTO_INCREMENT/],
    ['the primary key', (i) => { i.indexes.PRIMARY = ['ns']; }, /primary key is \(ns\), expected \(id\)/],
    ['the index', (i) => { i.indexes[m.INDEX] = ['ns', 'id']; }, /index idx_shared_values_history_ns_k_id is \(ns,id\)/],
    ['a missing index', (i) => { delete i.indexes[m.INDEX]; }, /index idx_shared_values_history_ns_k_id is \(\)/],
    ['a missing (ns, id) index', (i) => { delete i.indexes[m.NS_INDEX]; }, /index idx_shared_values_history_ns_id is \(\), expected \(ns, id\)/],
    ['a wrong (ns, id) index', (i) => { i.indexes[m.NS_INDEX] = ['ns']; }, /index idx_shared_values_history_ns_id is \(ns\), expected \(ns, id\)/],
    ['the table collation', (i) => { i.coll = 'utf8mb4_0900_ai_ci'; }, /table collation is utf8mb4_0900_ai_ci/],
    ['a view', (i) => { i.type = 'VIEW'; }, /exists as a VIEW/],
  ])('%s is flagged', (_n, mutate, re) => {
    const info = goodInfo();
    mutate(info);
    expect(m.shapeProblems(info).join('\n')).toMatch(re);
  });
});

function fakeConn({ table = null, dbColl = 'utf8mb4_general_ci' } = {}) {
  const ran = [];
  let t = table;
  return {
    ran,
    async query(sql) {
      const s = norm(String(sql));
      ran.push(s);
      if (/information_schema\.schemata/.test(s)) return [[{ coll: dbColl }]];
      if (/FROM information_schema\.tables/.test(s)) return [t ? [{ type: t.type, coll: t.coll }] : []];
      if (/FROM information_schema\.columns/.test(s)) return [t ? t.cols : []];
      if (/FROM information_schema\.statistics/.test(s)) {
        const rows = [];
        if (t) for (const [name, cols] of Object.entries(t.indexes)) for (const col of cols) rows.push({ name, col });
        return [rows];
      }
      if (/^SET SESSION lock_wait_timeout/.test(s)) return [{}];
      if (/^CREATE TABLE `shared_values_history`/.test(s)) { t = goodInfo(); return [{}]; }
      throw new Error('unscripted: ' + s);
    },
  };
}
const creates = (conn) => conn.ran.filter((s) => /^CREATE TABLE/.test(s));
const lines = () => { const out = []; return { out, log: (s) => out.push(s) }; };

describe('run()', () => {
  test('CHECK on an empty database: GO naming --apply, nothing created', async () => {
    const conn = fakeConn();
    const L = lines();
    expect(await m.run(conn, { apply: false, log: L.log })).toEqual({ ok: true });
    expect(creates(conn)).toEqual([]);
    expect(L.out[L.out.length - 1]).toBe('\nGO — base state matches. Next: node scripts/sharedValuesHistoryMigrate.js --apply');
  });

  test('APPLY creates it, lock_wait_timeout first, verifies, ends GO', async () => {
    const conn = fakeConn();
    const L = lines();
    expect(await m.run(conn, { apply: true, log: L.log })).toEqual({ ok: true });
    const i = conn.ran.findIndex((s) => /lock_wait_timeout/.test(s));
    expect(i).toBeGreaterThan(-1);
    expect(creates(conn)).toHaveLength(1);
    expect(conn.ran.findIndex((s) => /^CREATE TABLE/.test(s))).toBeGreaterThan(i);
    expect(L.out[L.out.length - 1]).toMatch(/^\nGO — migration applied/);
  });

  test('already applied: GO, nothing created', async () => {
    const conn = fakeConn({ table: goodInfo() });
    const L = lines();
    expect(await m.run(conn, { apply: true, log: L.log })).toEqual({ ok: true });
    expect(creates(conn)).toEqual([]);
    expect(L.out[L.out.length - 1]).toMatch(/already applied/);
  });

  test.each([
    ['a wrong live shape', { table: { ...goodInfo(), coll: 'latin1_swedish_ci' } }],
    ['the database default collation', { dbColl: 'utf8mb4_0900_ai_ci' }],
  ])('%s → NO-GO, nothing created, even with --apply', async (_n, opts) => {
    const conn = fakeConn(opts);
    const L = lines();
    expect(await m.run(conn, { apply: true, log: L.log })).toEqual({ ok: false });
    expect(creates(conn)).toEqual([]);
    expect(L.out[L.out.length - 1]).toMatch(/^\nNO-GO/);
  });
});
