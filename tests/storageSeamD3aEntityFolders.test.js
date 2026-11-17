// tests/storageSeamD3aEntityFolders.test.js
//
/**
 * scripts/storageSeamD3aEntityFolders.js over a scripted connection: CHECK with
 * no table, CHECK with a matching table (ALREADY APPLIED), CHECK with drift,
 * --apply creating + backfilling + verifying, --apply refusing on a verify
 * mismatch, lock_wait before DDL, and the CREATE TABLE read from the record
 * file (one source of truth; its shape pinned here).
 */

'use strict';

const mig = require('../scripts/storageSeamD3aEntityFolders');

function conn({ exists = false, base = { linked_cases: 1105, cache_rows: 1105, union_rows: 1105 }, have = 1105, bad = 0, afterHave = null, afterBad = null } = {}) {
  const calls = [];
  let created = false;
  let applied = false;
  return {
    calls,
    async query(sql) {
      const s = sql.replace(/\s+/g, ' ').trim();
      calls.push(s);
      if (/^SET SESSION lock_wait_timeout/.test(s)) return [{}];
      if (/information_schema\.TABLES/.test(s)) return [[{ n: exists || created ? 1 : 0 }]];
      if (/AS linked_cases/.test(s)) return [[base]];
      if (/^SELECT COUNT\(\*\) AS n FROM entity_folders WHERE entity_kind/.test(s)) return [[{ n: applied && afterHave != null ? afterHave : have }]];
      if (/^SELECT COUNT\(\*\) AS n FROM cases c LEFT JOIN case_folder_cache f/.test(s)) return [[{ n: applied && afterBad != null ? afterBad : bad }]];
      if (/^CREATE TABLE IF NOT EXISTS entity_folders/.test(s)) { created = true; return [{}]; }
      if (/^INSERT INTO entity_folders/.test(s)) { applied = true; return [{ affectedRows: base.union_rows }]; }
      throw new Error('unexpected SQL: ' + s.slice(0, 80));
    },
  };
}
const quiet = { log: () => {} };

test('the CREATE TABLE comes from the record file and has the shape the design names', () => {
  const sql = mig.createTableSql();
  expect(sql).toMatch(/^CREATE TABLE IF NOT EXISTS entity_folders \(/);
  expect(sql).toMatch(/entity_kind\s+ENUM\('case','contact'\) NOT NULL/);
  expect(sql).toMatch(/external_id\s+VARCHAR\(191\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin/);
  expect(sql).toMatch(/PRIMARY KEY \(entity_kind, entity_id, source\)/);
  expect(sql).toMatch(/KEY idx_entity_folders_ext \(source, external_id\)/);
  expect(sql).toMatch(/COLLATE=utf8mb4_general_ci/);
  expect(sql).not.toMatch(/;\s*$/);   // one bare statement, no trailing semicolon (COMMENT text may hold one)
});

test('CHECK with no table: GO, names the counts and the next command, runs no DDL', async () => {
  const c = conn();
  const r = await mig.run(c, quiet);
  expect(r).toEqual({ ok: true, created: false, backfilled: 0, line: expect.stringMatching(/^CHECK OK — GO\. entity_folders will be created and 1105 bindings backfilled\. Next: node scripts\/storageSeamD3aEntityFolders\.js --apply$/) });
  expect(c.calls.some((s) => /^CREATE|^INSERT|lock_wait/.test(s))).toBe(false);
});

test('--apply: lock_wait, CREATE, one backfill INSERT … SELECT … ON DUPLICATE KEY UPDATE, then the two verifies → APPLIED', async () => {
  const c = conn({ afterHave: 1105, afterBad: 0 });
  const r = await mig.run(c, { apply: true, ...quiet });
  expect(r).toEqual({ ok: true, created: true, backfilled: 1105, line: expect.stringMatching(/^APPLIED — GO\. Table created; 1105 bindings backfilled and verified equal to their source/) });
  const i = (re) => c.calls.findIndex((s) => re.test(s));
  expect(i(/lock_wait/)).toBeLessThan(i(/^CREATE TABLE/));
  expect(i(/^CREATE TABLE/)).toBeLessThan(i(/^INSERT INTO entity_folders/));
  expect(c.calls.filter((s) => /^INSERT/.test(s))).toHaveLength(1);
  expect(c.calls.find((s) => /^INSERT/.test(s))).toMatch(/SELECT 'case', c\.case_id, 'dropbox', f\.folder_external_id.*NULLIF\(TRIM\(c\.case_dropbox\), ''\).*ON DUPLICATE KEY UPDATE external_id = VALUES\(external_id\)/);
});

test('ALREADY APPLIED when the table exists, holds every binding and none differs; CHECK with drift says how many to resync; --apply on drift resyncs without CREATE', async () => {
  expect((await mig.run(conn({ exists: true }), quiet)).line).toMatch(/^ALREADY APPLIED — GO\. entity_folders holds all 1105 bindings/);
  expect((await mig.run(conn({ exists: true }), { apply: true, ...quiet })).line).toMatch(/^ALREADY APPLIED — GO/);
  const drift = conn({ exists: true, have: 1105, bad: 3, afterBad: 0 });
  expect((await mig.run(drift, quiet)).line).toMatch(/^CHECK OK — GO\. The table exists; 3 binding\(s\) to \(re\)sync/);
  const r = await mig.run(drift, { apply: true, ...quiet });
  expect(r.ok).toBe(true); expect(r.created).toBe(false); expect(r.line).toMatch(/^APPLIED — GO\. 1105 bindings backfilled and verified/);
  expect(drift.calls.some((s) => /^CREATE TABLE/.test(s))).toBe(false);
});

test('a verify mismatch after the backfill is NO-GO and says do not deploy', async () => {
  const r = await mig.run(conn({ afterHave: 1104, afterBad: 1 }), { apply: true, ...quiet });
  expect(r.ok).toBe(false);
  expect(r.line).toMatch(/^NO-GO — after the backfill entity_folders holds 1104 case bindings \(expected 1105\) with 1 differing.*Do not deploy D3a/);
});
