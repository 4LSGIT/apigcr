/**
 * scripts/commUnsubTokensCampaignIdComment.js — every path of run() over a
 * scripted connection (the script's own module is real; only the DB is a
 * stand-in), and the new COMMENT pinned against the mint that makes NULL a
 * production value (campaignService.sendPromotional passes campaignId: null).
 * The real-engine run is a local 8.4 apply (2026-11-15) + the CHECK on
 * production. Derived from tests/mailboxIngestStateComment.test.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../scripts/commUnsubTokensCampaignIdComment');

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
  expect(S.SQL.alter).toMatch(/MODIFY COLUMN `campaign_id` int DEFAULT NULL COMMENT \?, ALGORITHM=INSTANT$/);
});

test('already applied: GO, nothing written, even with --apply', async () => {
  const c = conn([col(S.NEW_COMMENT)]);
  const r = await S.run(c, { apply: true, ...quiet });
  expect([r.ok, r.state, wrote(c)]).toEqual([true, 'applied', false]);
});

test.each([
  ['COLUMN_TYPE', 'int unsigned'], ['IS_NULLABLE', 'NO'], ['COLUMN_DEFAULT', '0'],
  ['CHARACTER_SET_NAME', 'utf8mb4'], ['COLLATION_NAME', 'utf8mb4_bin'], ['EXTRA', 'auto_increment'],
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
  const c2 = conn([col(S.OLD_COMMENT), col(S.NEW_COMMENT, { COLUMN_TYPE: 'int unsigned' })]);
  expect((await S.run(c2, { apply: true, ...quiet })).state).toBe('verify-failed');
});

test('the NEW comment fits MySQL\'s 1024 cap, names the promotional mint, and is safe to quote', () => {
  expect(S.NEW_COMMENT.length).toBeLessThanOrEqual(1024);
  expect(S.NEW_COMMENT).not.toMatch(/['\\]/);
  for (const k of ['sendPromotional', 'NULL', 'contact_id', 'test/smoke']) expect(S.NEW_COMMENT).toContain(k);
  // the mint really runs with campaign_id NULL (services/campaignService.js sendPromotional)
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'campaignService.js'), 'utf8');
  const start = src.indexOf('async function sendPromotional(');
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\nasync function ', start + 1));
  expect(body).toMatch(/mintOrReuseUnsubToken\(db,\s*\{[^}]*campaignId:\s*null[^}]*contactId:\s*cid/);
});

test('the migration record carries the same statement and comment', () => {
  const rec = fs.readFileSync(path.join(__dirname, '..', 'ref', 'migrations', '2026-11-15_comm_unsub_tokens_campaign_id_comment.sql'), 'utf8');
  expect(rec).toContain(S.SQL.lockWait + ';');
  expect(rec).toContain(S.SQL.alter.replace('COMMENT ?', `COMMENT '${S.NEW_COMMENT}'`) + ';');
  expect(rec).toContain('APPLIED BY: node scripts/commUnsubTokensCampaignIdComment.js --apply');
});
