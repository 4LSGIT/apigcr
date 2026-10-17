/**
 * scripts/commsSummariesSkipReasonComment.js — every path of run() over a
 * scripted connection (the script's own module is real; only the DB is a
 * stand-in), and the new COMMENT pinned against the reasons the summarize
 * sweep actually writes. The real-engine run is a local 8.4 apply + the
 * manager's CHECK.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../scripts/commsSummariesSkipReasonComment');

function conn(cols) {
  // cols: successive information_schema reads; queries recorded
  const calls = [];
  let reads = 0;
  return {
    calls,
    async query(sql, params) {
      calls.push([sql, params]);
      if (sql === S.SQL.read) { const c = cols[Math.min(reads++, cols.length - 1)]; return [c ? [c] : []]; }
      return [[]];
    },
  };
}
const col = (comment, over = {}) => ({ ...S.EXPECT, COLUMN_COMMENT: comment, ...over });
const quiet = { log: () => {} };
const wrote = (c) => c.calls.some(([sql]) => /ALTER TABLE/.test(sql));

test('CHECK on the old comment: GO, nothing written', async () => {
  const c = conn([col(S.OLD_COMMENT)]);
  const r = await S.run(c, { ...quiet });
  expect([r.ok, r.state, wrote(c)]).toEqual([true, 'check', false]);
});

test('--apply: lock_wait first, then ALTER with the new comment, verified', async () => {
  const c = conn([col(S.OLD_COMMENT), col(S.NEW_COMMENT)]);
  const r = await S.run(c, { apply: true, ...quiet });
  expect([r.ok, r.state]).toEqual([true, 'applied-now']);
  const sqls = c.calls.map(([s]) => s);
  expect(sqls.indexOf(S.SQL.lockWait)).toBeGreaterThan(-1);
  expect(sqls.indexOf(S.SQL.lockWait)).toBeLessThan(sqls.indexOf(S.SQL.alter));
  expect(c.calls.find(([s]) => s === S.SQL.alter)[1]).toEqual([S.NEW_COMMENT]);
  expect(S.SQL.alter).toMatch(/MODIFY COLUMN `skip_reason` varchar\(32\) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT \?, ALGORITHM=INSTANT$/);
});

test('already applied: GO, nothing written, even with --apply', async () => {
  const c = conn([col(S.NEW_COMMENT)]);
  const r = await S.run(c, { apply: true, ...quiet });
  expect([r.ok, r.state, wrote(c)]).toEqual([true, 'applied', false]);
});

test.each([
  ['COLUMN_TYPE', 'varchar(64)'], ['IS_NULLABLE', 'NO'], ['COLUMN_DEFAULT', ''],
  ['CHARACTER_SET_NAME', 'utf8mb3'], ['COLLATION_NAME', 'utf8mb4_bin'], ['EXTRA', 'DEFAULT_GENERATED'],
])('an unexpected %s → NO-GO, nothing written', async (k, v) => {
  const c = conn([col(S.OLD_COMMENT, { [k]: v })]);
  const r = await S.run(c, { apply: true, ...quiet });
  expect([r.ok, r.state, wrote(c)]).toEqual([false, 'unexpected', false]);
});

test('missing column / unknown comment → NO-GO, nothing written', async () => {
  let c = conn([null]);
  expect((await S.run(c, { apply: true, ...quiet })).state).toBe('unexpected');
  expect(wrote(c)).toBe(false);
  c = conn([col('someone else wrote this')]);
  expect((await S.run(c, { apply: true, ...quiet })).state).toBe('unknown-comment');
  expect(wrote(c)).toBe(false);
});

test('a read-back that does not match → NO-GO verify-failed', async () => {
  const c = conn([col(S.OLD_COMMENT), col(S.OLD_COMMENT)]);
  expect((await S.run(c, { apply: true, ...quiet })).state).toBe('verify-failed');
  const c2 = conn([col(S.OLD_COMMENT), col(S.NEW_COMMENT, { COLLATION_NAME: 'utf8mb4_bin' })]);
  expect((await S.run(c2, { apply: true, ...quiet })).state).toBe('verify-failed');
});

test('the OLD comment is what prod reads (2026-10-17); the NEW one names exactly the reasons the sweep writes', () => {
  expect(S.OLD_COMMENT).toBe('restricted (back to pending once unrestricted) | short | empty | refused | purged');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'commsSummarizeSweep.js'), 'utf8');
  const calls = src.match(/await _skip\(db, row, [^;]*?\);/g) || [];   // the calls, not the function's own body
  const written = new Set();
  for (const c of calls) for (const m of c.matchAll(/'([a-z_]+)'/g)) written.add(m[1]);
  const named = new Set(S.NEW_COMMENT.split('|').map((w) => w.trim().split(' ')[0]));
  expect([...written].sort()).toEqual(['empty', 'no_speech', 'not_transcribed', 'purged', 'refused', 'restricted', 'short']);
  expect([...named].sort()).toEqual([...written].sort());
});

test('the migration record carries the same statement and comment', () => {
  const rec = fs.readFileSync(path.join(__dirname, '..', 'ref', 'migrations', '2026-10-17_comms_summaries_skip_reason_comment.sql'), 'utf8');
  expect(rec).toContain(S.SQL.lockWait + ';');
  expect(rec).toContain(S.SQL.alter.replace('COMMENT ?', `COMMENT '${S.NEW_COMMENT}'`) + ';');
  expect(rec).toContain('APPLIED BY: node scripts/commsSummariesSkipReasonComment.js --apply');
});
