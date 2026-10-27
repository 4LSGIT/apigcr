/**
 * scripts/mailboxIngestStateComment.js — every path of run() over a scripted
 * connection (the script's own module is real; only the DB is a stand-in),
 * and the new COMMENT pinned against the keys the ingest worker writes. The
 * real-engine run is a local 8.4 apply + the manager's CHECK on production.
 * Derived from tests/commsSummariesSkipReasonComment.test.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../scripts/mailboxIngestStateComment');

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
  expect(S.SQL.alter).toMatch(/MODIFY COLUMN `ingest_state` json DEFAULT NULL COMMENT \?, ALGORITHM=INSTANT$/);
});

test('already applied: GO, nothing written, even with --apply', async () => {
  const c = conn([col(S.NEW_COMMENT)]);
  const r = await S.run(c, { apply: true, ...quiet });
  expect([r.ok, r.state, wrote(c)]).toEqual([true, 'applied', false]);
});

test.each([
  ['COLUMN_TYPE', 'longtext'], ['IS_NULLABLE', 'NO'], ['COLUMN_DEFAULT', ''],
  ['CHARACTER_SET_NAME', 'utf8mb4'], ['COLLATION_NAME', 'utf8mb4_bin'], ['EXTRA', 'DEFAULT_GENERATED'],
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
  const c2 = conn([col(S.OLD_COMMENT), col(S.NEW_COMMENT, { COLUMN_TYPE: 'longtext' })]);
  expect((await S.run(c2, { apply: true, ...quiet })).state).toBe('verify-failed');
});

test('the NEW comment fits MySQL\'s 1024 cap, names the poison keys, and is safe to quote', () => {
  expect(S.NEW_COMMENT.length).toBeLessThanOrEqual(1024);
  expect(S.NEW_COMMENT).not.toMatch(/['\\]/);
  for (const k of ['poison', 'quarantined', 'quarantined_total', 'POISON MESSAGES']) expect(S.NEW_COMMENT).toContain(k);
  // the worker really writes them (services/mailbox/mailboxIngestService.js)
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'mailbox', 'mailboxIngestService.js'), 'utf8');
  for (const k of ['poison', 'quarantined', 'quarantined_total']) expect(src).toMatch(new RegExp(`\\.${k}\\s*=[^=]`));
});

test('the migration record carries the same statement and comment', () => {
  const rec = fs.readFileSync(path.join(__dirname, '..', 'ref', 'migrations', '2026-10-27_mailboxes_ingest_state_comment.sql'), 'utf8');
  expect(rec).toContain(S.SQL.lockWait + ';');
  expect(rec).toContain(S.SQL.alter.replace('COMMENT ?', `COMMENT '${S.NEW_COMMENT}'`) + ';');
  expect(rec).toContain('APPLIED BY: node scripts/mailboxIngestStateComment.js --apply');
});
