// tests/sharedValuesMigrate.test.js
//
/**
 * scripts/sharedValuesMigrate.js without a database (the real-engine run is
 * tests/sharedValues.mysql.test.js, gated).
 *
 * WHAT IS LOCKED
 *   - The DDL the script runs is the DDL ref/migrations/2026-10-28_shared_values.sql
 *     records, statement for statement.
 *   - The DDL follows ref/SCHEMA_CONVENTIONS.md: no DEFAULT CHARSET (the
 *     tables inherit general_ci); ns / k utf8mb4_bin; the value column not.
 *   - The script's EXPECTED shape names the DDL's columns, in order.
 *   - shapeProblems flags a wrong collation, type, nullability, column set
 *     or primary key; a correct table has none.
 *   - run(): CHECK on an empty database plans and creates nothing; a wrong
 *     live state or database collation is a NO-GO that creates nothing;
 *     APPLY creates exactly the absent table(s), with lock_wait_timeout set
 *     first.
 *
 * Run: npx jest tests/sharedValuesMigrate.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const m = require('../scripts/sharedValuesMigrate');

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const SQL = fs.readFileSync(path.join(__dirname, '..', 'ref', 'migrations', '2026-10-28_shared_values.sql'), 'utf8');

/** `name` → its definition line, from a CREATE statement. */
function columnLines(ddl) {
  return ddl.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('`'))
    .map((l) => [l.match(/^`(\w+)`/)[1], l]);
}

describe('the DDL', () => {
  test('the script runs exactly what the migration record holds', () => {
    for (const st of [m.CREATE_NAMESPACES, m.CREATE_VALUES]) expect(norm(SQL)).toContain(norm(st));
    expect((SQL.match(/CREATE TABLE/g) || []).length).toBe(2);
  });

  test('schema conventions: no DEFAULT CHARSET; ns / k utf8mb4_bin; v general', () => {
    for (const st of [m.CREATE_NAMESPACES, m.CREATE_VALUES]) expect(st).not.toMatch(/DEFAULT CHARSET/i);
    const ns = Object.fromEntries(columnLines(m.CREATE_NAMESPACES));
    const vals = Object.fromEntries(columnLines(m.CREATE_VALUES));
    expect(ns.ns).toMatch(/COLLATE utf8mb4_bin NOT NULL/);
    expect(vals.ns).toMatch(/COLLATE utf8mb4_bin NOT NULL/);
    expect(vals.k).toMatch(/COLLATE utf8mb4_bin NOT NULL/);
    expect(vals.v).not.toMatch(/utf8mb4_bin/);
    expect(m.CREATE_VALUES).toMatch(/FOREIGN KEY \(`ns`\) REFERENCES `shared_namespaces` \(`ns`\) ON DELETE CASCADE/);
  });

  test('EXPECTED names the DDL\'s columns, in order', () => {
    expect(Object.keys(m.EXPECTED[m.NS_TABLE])).toEqual(columnLines(m.CREATE_NAMESPACES).map(([n]) => n));
    expect(Object.keys(m.EXPECTED[m.VALUES_TABLE])).toEqual(columnLines(m.CREATE_VALUES).map(([n]) => n));
  });
});

// A table info as information_schema would report a correct one.
function goodInfo(table) {
  return {
    type: 'BASE TABLE', coll: 'utf8mb4_general_ci',
    cols: Object.entries(m.EXPECTED[table]).map(([name, [type, nullable, coll]]) => ({ name, type, nullable, coll: coll || null })),
    pk: m.EXPECTED_PK[table].slice(),
  };
}

describe('shapeProblems', () => {
  test('a correct table has none', () => {
    expect(m.shapeProblems(m.NS_TABLE, goodInfo(m.NS_TABLE))).toEqual([]);
    expect(m.shapeProblems(m.VALUES_TABLE, goodInfo(m.VALUES_TABLE))).toEqual([]);
  });

  test.each([
    ['k collation', (i) => { i.cols.find((c) => c.name === 'k').coll = 'utf8mb4_general_ci'; }, /shared_values\.k collation utf8mb4_general_ci, expected utf8mb4_bin/],
    ['rev type', (i) => { i.cols.find((c) => c.name === 'rev').type = 'int'; }, /shared_values\.rev is int, expected int unsigned/],
    ['act nullability', (i) => { i.cols.find((c) => c.name === 'updated_act').nullable = 'NO'; }, /updated_act nullable=NO, expected YES/],
    ['a missing column', (i) => { i.cols = i.cols.filter((c) => c.name !== 'updated_act'); }, /columns are \[/],
    ['the primary key', (i) => { i.pk = ['k']; }, /primary key is \(k\), expected \(ns, k\)/],
    ['the table collation', (i) => { i.coll = 'utf8mb4_0900_ai_ci'; }, /table collation is utf8mb4_0900_ai_ci/],
    ['a view', (i) => { i.type = 'VIEW'; }, /exists as a VIEW/],
  ])('%s is flagged', (_n, mutate, re) => {
    const info = goodInfo(m.VALUES_TABLE);
    mutate(info);
    expect(m.shapeProblems(m.VALUES_TABLE, info).join('\n')).toMatch(re);
  });
});

// A fake connection answering the script's information_schema reads from a
// table map; CREATE TABLE adds the correct shape (the real DDL's effect is
// the gated twin's job).
function fakeConn({ tables = {}, dbColl = 'utf8mb4_general_ci', fk = true } = {}) {
  const ran = [];
  const conn = {
    ran,
    async query(sql, params = []) {
      const s = norm(String(sql));
      ran.push(s);
      if (/information_schema\.schemata/.test(s)) return [[{ coll: dbColl }]];
      if (/FROM information_schema\.tables/.test(s)) {
        const t = tables[params[0]];
        return [t ? [{ type: t.type, coll: t.coll }] : []];
      }
      if (/FROM information_schema\.columns/.test(s)) return [(tables[params[0]] || { cols: [] }).cols];
      if (/key_column_usage/.test(s)) return [(tables[params[0]] || { pk: [] }).pk.map((name) => ({ name }))];
      if (/referential_constraints/.test(s)) return [fk ? [{ del: 'CASCADE', ref: 'shared_namespaces' }] : []];
      if (/^SET SESSION lock_wait_timeout/.test(s)) return [{}];
      const c = s.match(/^CREATE TABLE `(\w+)`/);
      if (c) { tables[c[1]] = goodInfo(c[1]); return [{}]; }
      throw new Error('unscripted: ' + s);
    },
  };
  return conn;
}
const creates = (conn) => conn.ran.filter((s) => /^CREATE TABLE/.test(s));
const lines = () => { const out = []; return { out, log: (s) => out.push(s) }; };

describe('run()', () => {
  test('CHECK on an empty database: GO naming --apply, nothing created', async () => {
    const conn = fakeConn();
    const L = lines();
    expect(await m.run(conn, { apply: false, log: L.log })).toEqual({ ok: true });
    expect(creates(conn)).toEqual([]);
    expect(L.out[L.out.length - 1]).toBe('\nGO — base state matches. Next: node scripts/sharedValuesMigrate.js --apply');
  });

  test('APPLY creates both, lock_wait_timeout first, and ends GO', async () => {
    const conn = fakeConn();
    const L = lines();
    expect(await m.run(conn, { apply: true, log: L.log })).toEqual({ ok: true });
    const i = conn.ran.findIndex((s) => /lock_wait_timeout/.test(s));
    expect(i).toBeGreaterThan(-1);
    expect(creates(conn).map((s) => s.match(/`(\w+)`/)[1])).toEqual(['shared_namespaces', 'shared_values']);
    expect(conn.ran.findIndex((s) => /^CREATE TABLE/.test(s))).toBeGreaterThan(i);
    expect(L.out[L.out.length - 1]).toMatch(/^\nGO — migration applied/);
  });

  test('APPLY resumes: only the absent table is created', async () => {
    const conn = fakeConn({ tables: { shared_namespaces: goodInfo('shared_namespaces') } });
    expect(await m.run(conn, { apply: true, log: () => {} })).toEqual({ ok: true });
    expect(creates(conn).map((s) => s.match(/`(\w+)`/)[1])).toEqual(['shared_values']);
  });

  test.each([
    ['a wrong live shape', { tables: { shared_namespaces: { ...goodInfo('shared_namespaces'), coll: 'latin1_swedish_ci' } } }],
    ['the database default collation', { dbColl: 'utf8mb4_0900_ai_ci' }],
    ['values without namespaces', { tables: { shared_values: goodInfo('shared_values') } }],
    ['a missing cascade FK', { tables: { shared_namespaces: goodInfo('shared_namespaces'), shared_values: goodInfo('shared_values') }, fk: false }],
  ])('%s → NO-GO, nothing created, even with --apply', async (_n, opts) => {
    const conn = fakeConn(opts);
    const L = lines();
    expect(await m.run(conn, { apply: true, log: L.log })).toEqual({ ok: false });
    expect(creates(conn)).toEqual([]);
    expect(L.out[L.out.length - 1]).toMatch(/^\nNO-GO/);
  });
});
