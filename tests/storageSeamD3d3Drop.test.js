// tests/storageSeamD3d3Drop.test.js
//
/**
 * scripts/storageSeamD3d3Drop.js — the retire-a-column gate as a script, over a
 * scripted connection: CHECK GO; every NO-GO (a stored definition, a trigger, a
 * view, an uncovered column link, an uncovered cache row, the manifest still
 * naming the column) drops nothing; --apply sets lock_wait, drops the column
 * then the table, verifies both gone; resumable (one already gone → drops the
 * other); ALREADY APPLIED when both are gone; a verify failure is a NO-GO.
 */

'use strict';

const script = require('../scripts/storageSeamD3d3Drop');

function conn(state = {}) {
  const s = {
    column: true, table: true, defs: {}, triggers: 0, views: 0,
    columnRows: 1105, columnUncovered: 0, cacheRows: 1105, cacheUncovered: 0,
    dropFails: null, ...state,
  };
  const calls = [];
  return {
    calls, state: s,
    query: async (sql) => {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      calls.push(q);
      const one = (v) => [[{ n: v }]];
      if (q === script.SQL.columnExists) return one(s.column ? 1 : 0);
      if (q === script.SQL.tableExists) return one(s.table ? 1 : 0);
      const d = script.SQL.definitions.find((x) => x.sql === q);
      if (d) return one(s.defs[`${d.table}.${d.column}`] || 0);
      if (q === script.SQL.triggers) return one(s.triggers);
      if (q === script.SQL.views) return one(s.views);
      if (q === script.SQL.columnRows) return one(s.columnRows);
      if (q === script.SQL.columnUncovered) return one(s.columnUncovered);
      if (q === script.SQL.cacheRows) return one(s.cacheRows);
      if (q === script.SQL.cacheUncovered) return one(s.cacheUncovered);
      if (q === script.SQL.lockWait) return [{}];
      if (q === script.SQL.dropColumn) { if (s.dropFails === 'column') throw new Error('Lock wait timeout exceeded'); s.column = false; return [{}]; }
      if (q === script.SQL.dropTable) { if (s.dropFails === 'table') throw new Error('Lock wait timeout exceeded'); s.table = false; return [{}]; }
      throw new Error(`unexpected SQL: ${q}`);
    },
  };
}
const quiet = { log: () => {} };
const noManifest = () => false;
const writes = (c) => c.calls.filter((q) => /^(ALTER|DROP)/.test(q));

test('CHECK: GO names what would drop; nothing written', async () => {
  const c = conn();
  const r = await script.run(c, { ...quiet, manifestCheck: noManifest });
  expect(r).toEqual({ ok: true, dropped: [], line: 'CHECK OK — GO. Would drop cases.case_dropbox and case_folder_cache. Next: --apply.' });
  expect(writes(c)).toEqual([]);
  expect(c.calls.some((q) => q === script.SQL.lockWait)).toBe(false);
});

test('the gate: each failing check is a NO-GO that drops nothing (CHECK and --apply alike)', async () => {
  const cases = [
    [{ defs: { 'workflow_steps.config': 2 } }, /2 workflow_steps\.config row\(s\) name the pair/],
    [{ defs: { 'report_definitions.sql_text': 1 } }, /1 report_definitions\.sql_text row\(s\)/],
    [{ triggers: 1 }, /1 trigger\(s\) name the pair/],
    [{ views: 1 }, /1 view\(s\) name the pair/],
    [{ columnUncovered: 3 }, /3 case\(s\) hold a link in cases\.case_dropbox that the binding does not/],
    [{ cacheUncovered: 1 }, /1 case_folder_cache row\(s\) carry a path the binding does not/],
  ];
  for (const [state, re] of cases) {
    for (const apply of [false, true]) {
      const c = conn(state);
      const r = await script.run(c, { ...quiet, apply, manifestCheck: noManifest });
      expect(r.ok).toBe(false);
      expect(r.line).toMatch(/^NO-GO — /);
      expect(r.line).toMatch(re);
      expect(r.line).toMatch(/Nothing dropped\.$/);
      expect(writes(c)).toEqual([]);
    }
  }
  // the manifest still naming the column: D3d-2b's deploy + regrant come first
  const c = conn();
  const r = await script.run(c, { ...quiet, apply: true, manifestCheck: () => true });
  expect(r.line).toMatch(/NO-GO — lib\/reportSchema\/manifest\.js still lists cases\.case_dropbox \(land D3d-2b and run the yc_report regrant first\)/);
  expect(writes(c)).toEqual([]);
  // several problems are all named
  const many = conn({ triggers: 1, columnUncovered: 2 });
  const rm = await script.run(many, { ...quiet, manifestCheck: noManifest });
  expect(rm.problems).toHaveLength(2);
});

test('--apply: lock_wait first, the column then the table, both verified gone', async () => {
  const c = conn();
  const r = await script.run(c, { ...quiet, apply: true, manifestCheck: noManifest });
  expect(r).toEqual({ ok: true, dropped: ['cases.case_dropbox', 'case_folder_cache'], line: expect.stringMatching(/^APPLIED — GO\. Dropped cases\.case_dropbox and case_folder_cache; both verified gone\. Next: scripts\/reportGrantUserProvision\.js --apply --rotate/) });
  const i = c.calls.indexOf(script.SQL.lockWait);
  expect(i).toBeGreaterThan(-1);
  expect(c.calls.slice(i)).toEqual([script.SQL.lockWait, script.SQL.dropColumn, script.SQL.dropTable, script.SQL.columnExists, script.SQL.tableExists]);
});

test('resumable: the column already gone → only the table drops (and the column coverage check is skipped); then ALREADY APPLIED', async () => {
  const c = conn({ column: false });
  const r = await script.run(c, { ...quiet, apply: true, manifestCheck: () => true });   // the manifest check is moot once the column is gone
  expect(r.dropped).toEqual(['case_folder_cache']);
  expect(c.calls).not.toContain(script.SQL.columnUncovered);
  expect(writes(c)).toEqual([script.SQL.dropTable]);
  const again = conn({ column: false, table: false });
  const r2 = await script.run(again, { ...quiet, apply: true });
  expect(r2).toEqual({ ok: true, dropped: [], line: expect.stringMatching(/^ALREADY APPLIED — GO\. cases\.case_dropbox and case_folder_cache are gone\./) });
  expect(again.calls).toEqual([script.SQL.columnExists, script.SQL.tableExists]);
});

test('a DROP that fails throws (the caller prints NO-GO; the ✓ lines say what went through); a verify that still sees the pair is a NO-GO', async () => {
  const c = conn({ dropFails: 'table' });
  await expect(script.run(c, { ...quiet, apply: true, manifestCheck: noManifest })).rejects.toThrow(/Lock wait timeout/);
  expect(c.state.column).toBe(false);   // the column went; a re-run finishes the table
  // the verify disagreeing with the drops (information_schema lagging, another session re-adding): NO-GO, not APPLIED
  const stuck = conn();
  const realQuery = stuck.query;
  stuck.query = async (sql) => { if (String(sql) === script.SQL.dropColumn) { stuck.calls.push(sql); return [{}]; } return realQuery(sql); };   // the ALTER "succeeds" but the column stays
  const r = await script.run(stuck, { ...quiet, apply: true, manifestCheck: noManifest });
  expect(r.ok).toBe(false);
  expect(r.line).toMatch(/^NO-GO — after the drop: cases\.case_dropbox STILL EXISTS, case_folder_cache gone\. Re-run to finish\./);
});

test('manifestNamesColumn reads the real manifest (D3d-2b: no longer listed — the manifest gate is open)', () => {
  const { TABLES } = require('../lib/reportSchema/manifest');
  expect(TABLES.cases.columns.case_dropbox).toBeUndefined();
  expect(script.manifestNamesColumn()).toBe(false);
});
