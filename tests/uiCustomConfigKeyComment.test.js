/**
 * scripts/uiCustomConfigKeyComment.js — every path of run() over a scripted
 * connection (the script's own module is real; only the DB is a stand-in).
 * The real-engine run is the manager's CHECK + the reviewer's local 8.4 apply.
 */
'use strict';
const S = require('../scripts/uiCustomConfigKeyComment');

function conn(cols) {
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
const col = (c, t, over = {}) => ({ ...S.EXPECT, COLUMN_COMMENT: c, TABLE_COMMENT: t, TABLE_COLLATION: 'utf8mb4_general_ci', ...over });
const OLD = [S.OLD_COMMENT, S.OLD_TABLE_COMMENT], NEW = [S.NEW_COMMENT, S.NEW_TABLE_COMMENT];
const quiet = { log: () => {} };
const wrote = (c) => c.calls.some(([sql]) => /ALTER TABLE/.test(sql));

test('the OLD texts are pinned to what S3.1 created (the CHECK depends on them)', () => {
  expect(S.OLD_COMMENT).toBe('app-validated per scope: firm registry_overrides | user shortcuts (lib/uiConfigShape.js CONFIG_KEYS)');
  expect(S.OLD_TABLE_COMMENT).toBe('ui-custom launcher config documents (PLAN §6): firm overlay + per-user layers, delivered by /api/firm-data ui and GET /api/ui-config, written by PUT /api/ui-config. Firm writes are versioned in ui_config_versions; user writes are not.');
  expect(S.NEW_COMMENT).toBe('app-validated per scope (lib/uiConfigShape.js CONFIG_KEYS): firm registry_overrides | user layout, shortcuts, items, prefs');
});

test('CHECK on old comments: GO, nothing written', async () => {
  const c = conn([col(...OLD)]);
  const r = await S.run(c, { ...quiet });
  expect([r.ok, r.state, wrote(c)]).toEqual([true, 'check', false]);
});

test('--apply: lock_wait first, ONE ALTER carrying both new comments, verified', async () => {
  const c = conn([col(...OLD), col(...NEW)]);
  const r = await S.run(c, { apply: true, ...quiet });
  expect([r.ok, r.state]).toEqual([true, 'applied-now']);
  const sqls = c.calls.map(([s]) => s);
  expect(sqls.filter((s) => /ALTER TABLE/.test(s))).toHaveLength(1);
  expect(sqls.indexOf(S.SQL.lockWait)).toBeGreaterThan(-1);
  expect(sqls.indexOf(S.SQL.lockWait)).toBeLessThan(sqls.indexOf(S.SQL.alter));
  expect(c.calls.find(([s]) => s === S.SQL.alter)[1]).toEqual(NEW);
  expect(S.SQL.alter).toMatch(/MODIFY COLUMN `config_key` varchar\(50\) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT \?, COMMENT = \?, ALGORITHM=INPLACE, LOCK=NONE$/);
});

test('already applied: GO, nothing written, even with --apply', async () => {
  const c = conn([col(...NEW)]);
  const r = await S.run(c, { apply: true, ...quiet });
  expect([r.ok, r.state, wrote(c)]).toEqual([true, 'applied', false]);
});

test.each([
  ['column new, table old', [S.NEW_COMMENT, S.OLD_TABLE_COMMENT]],
  ['column old, table new', [S.OLD_COMMENT, S.NEW_TABLE_COMMENT]],
  ['foreign column comment', ['someone else', S.OLD_TABLE_COMMENT]],
  ['foreign table comment', [S.OLD_COMMENT, 'someone else']],
])('%s → NO-GO, nothing written', async (_n, pair) => {
  const c = conn([col(...pair)]);
  const r = await S.run(c, { apply: true, ...quiet });
  expect([r.ok, r.state, wrote(c)]).toEqual([false, 'unknown-comment', false]);
});

test.each([
  ['COLUMN_TYPE', 'varchar(64)'], ['IS_NULLABLE', 'YES'], ['COLUMN_DEFAULT', ''],
  ['CHARACTER_SET_NAME', 'utf8mb3'], ['COLLATION_NAME', 'utf8mb4_bin'], ['EXTRA', 'DEFAULT_GENERATED'],
])('an unexpected %s → NO-GO, nothing written', async (k, v) => {
  const c = conn([col(...OLD, { [k]: v })]);
  const r = await S.run(c, { apply: true, ...quiet });
  expect([r.ok, r.state, wrote(c)]).toEqual([false, 'unexpected', false]);
});

test('missing column → NO-GO; read-back mismatch → verify-failed', async () => {
  const c = conn([null]);
  expect((await S.run(c, { apply: true, ...quiet })).state).toBe('unexpected');
  expect(wrote(c)).toBe(false);
  const c2 = conn([col(...OLD), col(S.NEW_COMMENT, S.OLD_TABLE_COMMENT)]);
  expect((await S.run(c2, { apply: true, ...quiet })).state).toBe('verify-failed');
  const c3 = conn([col(...OLD), col(...NEW, { COLLATION_NAME: 'utf8mb4_bin' })]);
  expect((await S.run(c3, { apply: true, ...quiet })).state).toBe('verify-failed');
});
