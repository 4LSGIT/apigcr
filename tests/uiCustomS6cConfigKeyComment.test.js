/**
 * scripts/uiCustomS6cConfigKeyComment.js — every path of run() over a scripted
 * connection (the script's own module is real; only the DB is a stand-in).
 * The real-engine run is the manager's CHECK + the reviewer's local 8.4 apply.
 */
'use strict';
const S = require('../scripts/uiCustomS6cConfigKeyComment');

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
  expect(S.SQL.alter).toMatch(/MODIFY COLUMN `config_key` varchar\(50\) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT \?, ALGORITHM=INSTANT$/);
});

test('already applied: GO, nothing written, even with --apply', async () => {
  const c = conn([col(S.NEW_COMMENT)]);
  const r = await S.run(c, { apply: true, ...quiet });
  expect([r.ok, r.state, wrote(c)]).toEqual([true, 'applied', false]);
});

test.each([
  ['COLUMN_TYPE', 'varchar(64)'], ['IS_NULLABLE', 'YES'], ['COLUMN_DEFAULT', ''],
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

test('the OLD and NEW comments are pinned (the CHECK depends on OLD; NEW is what lands)', () => {
  // the text uiCustomConfigKeyComment.js wrote on 2026-10-16 (088295b), what prod reads now
  expect(S.OLD_COMMENT).toBe('app-validated per scope (lib/uiConfigShape.js CONFIG_KEYS): firm registry_overrides | user layout, shortcuts, items, prefs');
  expect(S.NEW_COMMENT).toBe('app-validated per scope (lib/uiConfigShape.js CONFIG_KEYS): firm registry_overrides, layout | user layout, shortcuts, items, prefs');
});
