/**
 * scripts/phoneDeliveryS1DeliveryColumns.js — every path of run() over a
 * scripted connection (the script's own module is real; only the DB is a
 * stand-in). The real-engine run is the gated twin
 * (tests/phoneDelivery.mysql.test.js) plus Fred's live CHECK → --apply.
 */
'use strict';

const S = require('../scripts/phoneDeliveryS1DeliveryColumns');

/**
 * state: { table?, cols?: array of information_schema column rows,
 *          index?: 0|1, indexCols?: [names] } — successive reads walk
 * `states` (reads after the last reuse it); every query is recorded.
 */
function conn(states) {
  const calls = [];
  let step = 0;
  const cur = () => states[Math.min(step, states.length - 1)];
  return {
    calls,
    async query(sql, params) {
      calls.push([sql, params]);
      const s = cur();
      if (sql === S.SQL.readTable) return [[{ n: s.table === false ? 0 : 1 }]];
      if (sql === S.SQL.readCols) { const out = [[...(s.cols || [])]]; return out; }
      if (sql === S.SQL.readIndex) { const r = [[{ n: s.index ? 1 : 0 }]]; step = Math.min(step + (s.advanceOnIndexRead ? 1 : 0), states.length - 1); return r; }
      if (sql === S.SQL.readIndexCols) return [(s.indexCols || ['delivery_state', 'processed_at']).map(c => ({ COLUMN_NAME: c }))];
      return [[]];
    },
  };
}

const col = (name) => ({ COLUMN_NAME: name, ...S.COLUMNS[name] });
const ALL = S.COL_NAMES.map(col);
const quiet = { log: () => {} };
const altered = (c) => c.calls.filter(([sql]) => /^ALTER TABLE/.test(sql)).map(([sql]) => sql);

test('fresh table, CHECK: GO, nothing written', async () => {
  const c = conn([{ cols: [], index: 0 }]);
  const r = await S.run(c, { ...quiet });
  expect([r.ok, r.state, altered(c).length]).toEqual([true, 'check', 0]);
});

test('--apply on a fresh table: lock_wait, columns (INSTANT), index (INPLACE), verified', async () => {
  // reads: state(1) fresh → after ALTERs, verify reads see everything
  const c = conn([{ cols: [], index: 0, advanceOnIndexRead: true }, { cols: ALL, index: 1 }]);
  const r = await S.run(c, { apply: true, ...quiet });
  expect([r.ok, r.state]).toEqual([true, 'applied-now']);
  const sqls = c.calls.map(([s]) => s);
  const iLock = sqls.indexOf(S.SQL.lockWait);
  const iCols = sqls.indexOf(S.SQL.addCols);
  const iIdx = sqls.indexOf(S.SQL.addIndex);
  expect(iLock).toBeGreaterThan(-1);
  expect(iLock).toBeLessThan(iCols);
  expect(iCols).toBeLessThan(iIdx);
  expect(S.SQL.addCols).toMatch(/ALGORITHM=INSTANT$/);
  expect(S.SQL.addIndex).toMatch(/ALGORITHM=INPLACE, LOCK=NONE$/);
});

test('already applied: GO, no write', async () => {
  const c = conn([{ cols: ALL, index: 1 }]);
  const r = await S.run(c, { ...quiet });
  expect([r.ok, r.state, altered(c).length]).toEqual([true, 'applied', 0]);
});

test('columns present, index missing (a run died between the ALTERs): resumes at the index only', async () => {
  const c = conn([{ cols: ALL, index: 0, advanceOnIndexRead: true }, { cols: ALL, index: 1 }]);
  const r = await S.run(c, { apply: true, ...quiet });
  expect([r.ok, r.state]).toEqual([true, 'applied-now']);
  expect(altered(c)).toEqual([S.SQL.addIndex]);
});

test('partial columns: NO-GO, nothing written', async () => {
  const c = conn([{ cols: ALL.slice(0, 2), index: 0 }]);
  const r = await S.run(c, { apply: true, ...quiet });
  expect([r.ok, r.state, altered(c).length]).toEqual([false, 'partial', 0]);
});

test('index without columns: NO-GO', async () => {
  const c = conn([{ cols: [], index: 1 }]);
  const r = await S.run(c, { apply: true, ...quiet });
  expect([r.ok, r.state, altered(c).length]).toEqual([false, 'index-without-columns', 0]);
});

test('all present but a definition differs: NO-GO mismatch', async () => {
  const cols = [...ALL.slice(0, 3), { ...col('delivery_checked_at'), COLUMN_TYPE: 'timestamp' }];
  const c = conn([{ cols, index: 1 }]);
  const r = await S.run(c, { ...quiet });
  expect([r.ok, r.state]).toEqual([false, 'mismatch']);
});

test('no table: NO-GO', async () => {
  const c = conn([{ table: false, cols: [], index: 0 }]);
  const r = await S.run(c, { ...quiet });
  expect([r.ok, r.state]).toEqual([false, 'no-table']);
});

test('verify failure after apply is NO-GO (wrong index columns read back)', async () => {
  const c = conn([
    { cols: [], index: 0, advanceOnIndexRead: true },
    { cols: ALL, index: 1, indexCols: ['processed_at', 'delivery_state'] },
  ]);
  const r = await S.run(c, { apply: true, ...quiet });
  expect([r.ok, r.state]).toEqual([false, 'verify-failed']);
});

test('the record file and the script agree on the ALTERs', () => {
  const fs = require('fs');
  const path = require('path');
  const rec = fs.readFileSync(
    path.join(__dirname, '..', 'ref', 'migrations', '2026-10-21_phone_delivery_s1_delivery_columns.sql'), 'utf8');
  // Same columns, same comments, same index — the dated record never drifts
  // from what the script actually runs.
  for (const name of S.COL_NAMES) {
    expect(rec).toContain(`\`${name}\``);
    expect(rec).toContain(S.COLUMNS[name].COLUMN_COMMENT);
  }
  expect(rec).toContain('`idx_phone_event_delivery` (`delivery_state`, `processed_at`)');
});
