/**
 * scripts/settingsArcMigrate.js — every path of run() (stage 1), runStage2()
 * and liveCheck() over a scripted connection (the script's own module is real;
 * only the DB, git and the network are stand-ins). The fake APPLIES what each
 * statement says — the comments an ALTER carries, the rows a DELETE names —
 * so a wrong statement fails the script's own verify, not just a string pin.
 *
 * NO gated MySQL suite: this environment has no MySQL. The real-engine
 * proof is the manager's read-only CHECK against production before Fred's
 * --apply (CLAUDE.md "A migration that needs a session").
 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../scripts/settingsArcMigrate');

const ROOT = path.join(__dirname, '..');
const quiet = { log: () => {} };
const LIVE_OK = async () => ({ ok: true, detail: 'build x, after the arc' });
const LIVE_NO = async () => ({ ok: false, detail: 'live build older than the arc' });
const PABBLY_VALUE = 'https://hook.example/?k=SECRET-PABBLY';

// app_settings as live 2026-10-17 (ref/database.sql)
const col = (name, pos, type, over = {}) => ({ COLUMN_NAME: name, ORDINAL_POSITION: pos, COLUMN_TYPE: type, IS_NULLABLE: 'YES',
  COLUMN_DEFAULT: null, CHARACTER_SET_NAME: null, COLLATION_NAME: null, EXTRA: '', COLUMN_COMMENT: '', ...over });
const GCI = { CHARACTER_SET_NAME: 'utf8mb4', COLLATION_NAME: 'utf8mb4_general_ci' };
const COLS = () => [
  col('key', 1, 'varchar(100)', { IS_NULLABLE: 'NO', ...GCI }),
  col('value', 2, 'text', GCI),
  col('is_secret', 3, 'tinyint(1)', { IS_NULLABLE: 'NO', COLUMN_DEFAULT: '0', COLUMN_COMMENT: 'never returned by any settings API' }),
  col('is_editable', 4, 'tinyint(1)', { IS_NULLABLE: 'NO', COLUMN_DEFAULT: '0', COLUMN_COMMENT: 'exposed in settings.html' }),
  col('category', 5, 'varchar(50)', GCI),
  col('label', 6, 'varchar(100)', GCI),
  col('description', 7, 'varchar(500)', GCI),
  col('type', 8, 'varchar(20)', GCI),
  col('sort_order', 9, 'int'),
  col('updated_at', 10, 'timestamp', { COLUMN_DEFAULT: 'CURRENT_TIMESTAMP', EXTRA: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP' }),
];
const row = (key, value, over = {}) => [key, { key, value, is_secret: 0, is_editable: 0, category: null, label: null, description: null,
  type: null, sort_order: null, ...over }];
const ROWS = () => new Map([
  row('firm_name', 'Acme Law', { is_editable: 1 }),
  row('pabbly_internal_url', PABBLY_VALUE),
  row('gate_probe', 'hello', { is_editable: 1, category: 'Test' }),
  row('fe-gate_probe', 'hello2', { is_editable: 1 }),
  row('unified_singleton_enabled', '1', { is_editable: 1, type: 'bool' }),
  row('esign_webhook_hmac_mode', 'enforce'),
  row('quo_api_key', 'SECRET-QUO', { is_secret: 1 }),
]);
// What MySQL reports for the table the script creates (from its own definition).
const createdVersions = () => ({
  vTable: { TABLE_TYPE: 'BASE TABLE', ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_general_ci', TABLE_COMMENT: S.V_TABLE_COMMENT },
  vCols: S.V_COLUMNS.map(([n, t, nl, d, x, coll, cm], i) => ({ COLUMN_NAME: n, ORDINAL_POSITION: i + 1, COLUMN_TYPE: t, IS_NULLABLE: nl,
    COLUMN_DEFAULT: d, EXTRA: x, CHARACTER_SET_NAME: coll ? 'utf8mb4' : null, COLLATION_NAME: coll, COLUMN_COMMENT: cm })),
  vIdx: [{ INDEX_NAME: S.V_INDEX, SEQ_IN_INDEX: 1, COLUMN_NAME: 'setting_key', NON_UNIQUE: 1 },
    { INDEX_NAME: S.V_INDEX, SEQ_IN_INDEX: 2, COLUMN_NAME: 'id', NON_UNIQUE: 1 },
    { INDEX_NAME: 'PRIMARY', SEQ_IN_INDEX: 1, COLUMN_NAME: 'id', NON_UNIQUE: 0 }],
});
/** The live state once stage 1 is applied. */
const STAGE1_DONE = () => {
  const cols = COLS().map((c) => (S.COLUMNS[c.COLUMN_NAME] ? { ...c, COLUMN_COMMENT: S.COLUMNS[c.COLUMN_NAME].new } : c));
  const rows = ROWS();
  rows.get('pabbly_internal_url').is_secret = 1;
  rows.delete('gate_probe'); rows.delete('fe-gate_probe');
  return { cols, rows, table: { TABLE_TYPE: 'BASE TABLE', ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_general_ci', TABLE_COMMENT: S.NEW_TABLE_COMMENT },
    ...createdVersions() };
};

const unq = (s) => s.replace(/''/g, "'").replace(/\\\\/g, '\\');

/** A stand-in DB that behaves like the real one for the statements the script sends. */
function db(over = {}) {
  const st = {
    table: { TABLE_TYPE: 'BASE TABLE', ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_general_ci', TABLE_COMMENT: '' },
    cols: COLS(), rows: ROWS(), vTable: null, vCols: [], vIdx: [], smokeRows: [], ...over,
  };
  const calls = [];
  const txn = [];
  const valueReads = [];
  let snap = null;
  const conn = {
    st, calls, txn, valueReads,
    async beginTransaction() { txn.push('begin'); snap = { rows: new Map([...st.rows].map(([k, v]) => [k, { ...v }])), smoke: st.smokeRows.slice() }; },
    async commit() { txn.push('commit'); snap = null; },
    async rollback() { txn.push('rollback'); if (snap) { st.rows = snap.rows; st.smokeRows = snap.smoke; snap = null; } },
    async query(qo, params = []) {
      const sql = typeof qo === 'string' ? qo : qo.sql;
      calls.push([sql, params]);
      if (st.onQuery) st.onQuery(sql, st, params);
      if (sql === S.SQL.who) return [[{ cu: 'app@%', db: 'yc', v: '8.4.11-google' }]];
      if (sql === S.SQL.table) {
        if (params[0] === 'app_settings') return [st.table ? [{ ...st.table }] : []];
        return [st.vTable ? [{ ...st.vTable }] : []];
      }
      if (sql === S.SQL.columns) return [(params[0] === 'app_settings' ? st.cols : st.vCols).map((c) => ({ ...c }))];
      if (sql === S.SQL.indexes) return [st.vIdx.map((c) => ({ ...c }))];
      if (sql === S.SQL.rows) return [[{ n: st.rows.size }]];
      if (sql === S.SQL.pabbly) {
        const r = st.rows.get('pabbly_internal_url');
        return [r ? [{ key: r.key, is_secret: r.is_secret }] : []];
      }
      if (sql.startsWith('/* settingsArc:probe */')) {
        const keys = [...sql.split(' IN (')[1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => unq(m[1]));
        const guarded = sql.includes('IF(`is_secret` = 0, `value`, NULL) AS `value`');
        return [keys.sort().filter((k) => st.rows.has(k)).map((k) => {
          const r = st.rows.get(k);
          const secret = Number(r.is_secret) === 1;
          if (!(secret && guarded)) valueReads.push(k);
          return { ...r, value: secret && guarded ? null : r.value };
        })];
      }
      if (sql === S.SQL.lockWait) return [{}];
      if (sql === S.SQL.createVersions) {
        if (st.vTable) throw Object.assign(new Error("Table 'app_settings_versions' already exists"), { code: 'ER_TABLE_EXISTS_ERROR' });
        Object.assign(st, createdVersions());
        return [{}];
      }
      if (sql.startsWith('ALTER TABLE `app_settings`\n  MODIFY COLUMN')) {
        for (const m of sql.matchAll(/MODIFY COLUMN `(\w+)` .*? COMMENT '((?:[^']|'')*)'/g)) {
          const c = st.cols.find((x) => x.COLUMN_NAME === m[1]);
          c.COLUMN_COMMENT = unq(m[2]);
        }
        return [{}];
      }
      if (sql === S.SQL.alterTable) { st.table.TABLE_COMMENT = unq(/COMMENT = '((?:[^']|'')*)'/.exec(sql)[1]); return [{}]; }
      if (sql === S.SQL.markPabbly) {
        const r = st.rows.get('pabbly_internal_url');
        if (st.markMisses || !r || Number(r.is_secret) !== 0) return [{ affectedRows: 0 }];
        r.is_secret = 1;
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('DELETE FROM `app_settings` WHERE `key` = ')) {
        const [, k, v] = /`key` = '((?:[^']|'')*)' AND `value` COLLATE utf8mb4_bin = '((?:[^']|'')*)' AND `is_secret` = 0$/.exec(sql);
        const r = st.rows.get(unq(k));
        if (st.deleteMisses === unq(k) || !r || r.value !== unq(v) || Number(r.is_secret) !== 0) return [{ affectedRows: 0 }];
        st.rows.delete(unq(k));
        return [{ affectedRows: 1 }];
      }
      if (sql === S.SQL.smokeIns) {
        if (!st.vTable) throw new Error("Table 'app_settings_versions' doesn't exist");
        st.smokeRows.push({ setting_key: '__settings_arc_smoke__', old_value: null, new_value: 'x', changed_by: null, changed_via: 'ui',
          changed_at: new Date() });
        return [{ insertId: 1, affectedRows: 1 }];
      }
      if (sql === S.SQL.smokeSel) return [st.smokeBroken ? [] : st.smokeRows.map((r) => ({ ...r }))];
      throw new Error('unscripted SQL: ' + sql);
    },
  };
  return conn;
}
const sqls = (c) => c.calls.map(([s]) => s);
const wrote = (c) => sqls(c).filter((s) => /^(\/\* [^*]+ \*\/ )?(CREATE|ALTER|UPDATE|DELETE|INSERT)\b/.test(s));
const logInto = (arr) => ({ log: (x) => arr.push(String(x)) });

// ─────────────────────────────────────────────────────────────
// Stage 1
// ─────────────────────────────────────────────────────────────

describe('run() — stage 1', () => {
  test('CHECK on the live pre-arc shape: GO, every step listed, nothing written', async () => {
    const c = db();
    const out = [];
    const r = await S.run(c, logInto(out));
    expect([r.ok, r.state, wrote(c), c.txn]).toEqual([true, 'check', [], []]);
    expect(r.line).toBe('CHECK OK — GO. Next: node scripts/settingsArcMigrate.js --apply');
    expect(out.filter((l) => l.includes('to do:'))).toEqual([
      '  · to do: CREATE TABLE app_settings_versions',
      '  · to do: app_settings column COMMENTs (INSTANT): key, is_editable, category, label, description, type, sort_order',
      '  · to do: app_settings table COMMENT (INPLACE, LOCK=NONE)',
      '  · to do: pabbly_internal_url: is_secret = 1',
      '  · to do: DELETE test rows: gate_probe, fe-gate_probe',
    ]);
  });

  test('--apply: lock_wait first, a re-read on that session, CREATE, the INSTANT column ALTER, the INPLACE table ALTER, the rows in one transaction, verified, smoke rolled back', async () => {
    const c = db();
    const out = [];
    const r = await S.run(c, { apply: true, ...logInto(out) });
    expect([r.ok, r.state]).toEqual([true, 'applied-now']);
    expect(r.line).toBe('STAGE 1 APPLIED — GO. Next: land + deploy the settings arc backend, then node scripts/settingsArcMigrate.js --stage2');
    const s = sqls(c);
    const lw = s.indexOf(S.SQL.lockWait);
    expect(lw).toBeGreaterThan(-1);
    expect(wrote(c).map((x) => x.split(/[\s(]/).slice(0, 3).join(' '))).toEqual([
      'CREATE TABLE `app_settings_versions`', 'ALTER TABLE `app_settings`', 'ALTER TABLE `app_settings`',
      'UPDATE `app_settings` SET', 'DELETE FROM `app_settings`', 'DELETE FROM `app_settings`',
      '/* settingsArc:smoke */ INSERT',
    ].map((x) => x.split(/[\s(]/).slice(0, 3).join(' ')));
    expect(s.indexOf(S.SQL.createVersions)).toBeGreaterThan(lw);
    expect(s.slice(lw, s.indexOf(S.SQL.createVersions)).filter((x) => x === S.SQL.columns).length).toBe(1);   // re-read on the session
    expect(s).toContain(S.SQL.alterColumns(Object.keys(S.COLUMNS)));
    expect(s).toContain(S.SQL.alterTable);
    expect(c.txn).toEqual(['begin', 'commit', 'begin', 'rollback']);   // the rows, then the smoke (never committed)
    expect(c.st.smokeRows).toEqual([]);
    // the end state
    expect(c.st.cols.filter((x) => S.COLUMNS[x.COLUMN_NAME]).map((x) => x.COLUMN_COMMENT)).toEqual(Object.values(S.COLUMNS).map((x) => x.new));
    expect(c.st.cols.find((x) => x.COLUMN_NAME === 'is_secret').COLUMN_COMMENT).toBe('never returned by any settings API');
    expect(c.st.table.TABLE_COMMENT).toBe(S.NEW_TABLE_COMMENT);
    expect(c.st.rows.get('pabbly_internal_url').is_secret).toBe(1);
    expect([c.st.rows.has('gate_probe'), c.st.rows.has('fe-gate_probe'), c.st.rows.size]).toEqual([false, false, 5]);
    expect(c.st.rows.get('pabbly_internal_url').value).toBe(PABBLY_VALUE);
    // the deleted rows are recorded in the output first
    expect(out.filter((l) => l.includes('record — deleting')).length).toBe(2);
  });

  test('pabbly_internal_url\'s value is never read, printed or recorded', async () => {
    const c = db();
    const out = [];
    await S.run(c, { apply: true, ...logInto(out) });
    for (const s of sqls(c).filter((x) => x.includes('pabbly_internal_url'))) expect(s).not.toMatch(/`value`|\bvalue\b|SELECT \*/);
    expect(c.valueReads).not.toContain('pabbly_internal_url');
    expect(out.join('\n')).not.toContain('SECRET');
  });

  test('already applied: GO, nothing written, even with --apply', async () => {
    const c = db(STAGE1_DONE());
    const r = await S.run(c, { apply: true, ...quiet });
    expect([r.ok, r.state, wrote(c), c.txn]).toEqual([true, 'applied', [], []]);
    expect(r.line).toBe('ALREADY APPLIED — GO. Nothing to do. Next: land + deploy the settings arc backend, then node scripts/settingsArcMigrate.js --stage2');
    expect(sqls(c)).not.toContain(S.SQL.lockWait);
  });

  test('resumes: with the DDL done, --apply does only the rows', async () => {
    const done = STAGE1_DONE();
    const c = db({ ...done, rows: ROWS() });
    const r = await S.run(c, { apply: true, ...quiet });
    expect([r.ok, r.state]).toEqual([true, 'applied-now']);
    expect(wrote(c).filter((s) => !s.includes('smoke')).map((s) => s.split(' ')[0])).toEqual(['UPDATE', 'DELETE', 'DELETE']);
  });

  test('resumes: only the columns whose comment is still old are restated; rows already done are left alone', async () => {
    const cols = COLS().map((x) => (['is_editable', 'label', 'sort_order'].includes(x.COLUMN_NAME) ? { ...x, COLUMN_COMMENT: S.COLUMNS[x.COLUMN_NAME].new } : x));
    const rows = ROWS();
    rows.delete('gate_probe');
    rows.get('pabbly_internal_url').is_secret = 1;
    const c = db({ cols, rows, ...createdVersions() });
    const r = await S.run(c, { apply: true, ...quiet });
    expect([r.ok, r.state]).toEqual([true, 'applied-now']);
    expect(sqls(c)).toContain(S.SQL.alterColumns(['key', 'category', 'description', 'type']));
    expect(sqls(c)).not.toContain(S.SQL.createVersions);
    expect(wrote(c).filter((s) => /^(UPDATE|DELETE)/.test(s))).toEqual([S.SQL.del('fe-gate_probe', 'hello2')]);
  });

  test.each([
    ['is_editable', 'COLUMN_TYPE', 'tinyint'], ['is_editable', 'COLUMN_DEFAULT', '1'], ['is_editable', 'IS_NULLABLE', 'YES'],
    ['category', 'COLUMN_TYPE', 'varchar(64)'], ['label', 'COLLATION_NAME', 'utf8mb4_bin'], ['description', 'CHARACTER_SET_NAME', 'latin1'],
    ['type', 'EXTRA', 'VIRTUAL GENERATED'], ['sort_order', 'COLUMN_TYPE', 'bigint'], ['sort_order', 'ORDINAL_POSITION', 10],
    ['key', 'COLLATION_NAME', 'utf8mb4_bin'], ['key', 'COLUMN_TYPE', 'varchar(191)'], ['key', 'IS_NULLABLE', 'YES'],
  ])('an unexpected definition (%s.%s) → NO-GO, nothing written', async (name, k, v) => {
    const c = db({ cols: COLS().map((x) => (x.COLUMN_NAME === name ? { ...x, [k]: v } : x)) });
    const r = await S.run(c, { apply: true, ...quiet });
    expect([r.ok, r.state, wrote(c)]).toEqual([false, 'blocked', []]);
  });

  test('a missing column / a comment someone else changed / a table comment someone else set → NO-GO', async () => {
    for (const over of [
      { cols: COLS().filter((x) => x.COLUMN_NAME !== 'label') },
      { cols: COLS().map((x) => (x.COLUMN_NAME === 'type' ? { ...x, COLUMN_COMMENT: 'validator type' } : x)) },
      { table: { TABLE_TYPE: 'BASE TABLE', ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_general_ci', TABLE_COMMENT: 'settings' } },
      { table: null },
    ]) {
      const c = db(over);
      const r = await S.run(c, { apply: true, ...quiet });
      expect([r.ok, r.state, wrote(c)]).toEqual([false, 'blocked', []]);
    }
  });

  test.each([
    ['its table comment', (v) => { v.vTable.TABLE_COMMENT = 'someone else\'s'; }],
    ['its engine', (v) => { v.vTable.ENGINE = 'MyISAM'; }],
    ['a column type', (v) => { v.vCols[2].COLUMN_TYPE = 'mediumtext'; }],
    ['a column comment', (v) => { v.vCols[5].COLUMN_COMMENT = ''; }],
    ['an extra column', (v) => { v.vCols.push({ ...v.vCols[1], COLUMN_NAME: 'extra' }); }],
    ['the index', (v) => { v.vIdx = v.vIdx.filter((i) => i.COLUMN_NAME !== 'id' || i.INDEX_NAME === 'PRIMARY'); }],
    ['a unique index', (v) => { v.vIdx = v.vIdx.map((i) => ({ ...i, NON_UNIQUE: 0 })); }],
  ])('%s: an app_settings_versions of another shape → NO-GO, never altered', async (_, mutate) => {
    const v = createdVersions();
    mutate(v);
    const c = db(v);
    const r = await S.run(c, { apply: true, ...quiet });
    expect([r.ok, r.state, wrote(c)]).toEqual([false, 'blocked', []]);
  });

  test('pabbly_internal_url: missing or an odd flag → NO-GO; already secret → not a step', async () => {
    let rows = ROWS(); rows.delete('pabbly_internal_url');
    expect((await S.run(db({ rows }), { apply: true, ...quiet })).state).toBe('blocked');
    rows = ROWS(); rows.get('pabbly_internal_url').is_secret = 2;
    expect((await S.run(db({ rows }), { apply: true, ...quiet })).state).toBe('blocked');
    rows = ROWS(); rows.get('pabbly_internal_url').is_secret = 1;
    const c = db({ rows });
    await S.run(c, { apply: true, ...quiet });
    expect(sqls(c)).not.toContain(S.SQL.markPabbly);
  });

  test.each([['HELLO'], ['hello '], [''], [null], ['something real']])('a test row holding %p → NO-GO naming it, nothing written', async (v) => {
    const rows = ROWS(); rows.get('gate_probe').value = v;
    const c = db({ rows });
    const out = [];
    const r = await S.run(c, { apply: true, ...logInto(out) });
    expect([r.ok, r.state, wrote(c)]).toEqual([false, 'blocked', []]);
    expect(out.join('\n')).toMatch(/test row gate_probe holds .* expected "hello"/);
  });

  test('a test row flagged secret → NO-GO, its value never read or printed', async () => {
    const rows = ROWS(); rows.set('fe-gate_probe', { ...rows.get('fe-gate_probe'), value: 'SECRET-PROBE', is_secret: 1 });
    const c = db({ rows });
    const out = [];
    const r = await S.run(c, { apply: true, ...logInto(out) });
    expect([r.ok, r.state, wrote(c)]).toEqual([false, 'blocked', []]);
    expect(out.join('\n')).not.toContain('SECRET');
    expect(c.valueReads).not.toContain('fe-gate_probe');
  });

  test.each([
    ['unified_singleton_enabled', '0'], ['unified_singleton_enabled', ' 1'],
    ['esign_webhook_hmac_mode', 'log'], ['esign_webhook_hmac_mode', 'Enforce'], ['esign_webhook_hmac_mode', null],
  ])('a retired flag (%s) holding %p → NO-GO before the deploy, CHECK and --apply alike, nothing written', async (key, v) => {
    for (const apply of [false, true]) {
      const rows = ROWS(); rows.get(key).value = v;
      const c = db({ rows });
      const out = [];
      const r = await S.run(c, { apply, ...logInto(out) });
      expect([apply, r.ok, r.state, wrote(c)]).toEqual([apply, false, 'blocked', []]);
      expect(out.join('\n')).toContain(`${key} holds`);
      expect(out.join('\n')).toContain('deploying it now would change behaviour');
    }
  });

  test('a retired flag flagged secret → NO-GO, its value never printed', async () => {
    const rows = ROWS(); rows.set('unified_singleton_enabled', { ...rows.get('unified_singleton_enabled'), value: 'SECRET-FLAG', is_secret: 1 });
    const c = db({ rows });
    const out = [];
    const r = await S.run(c, { apply: true, ...logInto(out) });
    expect([r.ok, r.state, wrote(c)]).toEqual([false, 'blocked', []]);
    expect(out.join('\n')).not.toContain('SECRET');
  });

  test('the retired flags at their final values, or already gone (a re-run after stage 2) → no problem', async () => {
    expect((await S.run(db(), quiet)).state).toBe('check');
    const rows = ROWS(); rows.delete('unified_singleton_enabled'); rows.delete('esign_webhook_hmac_mode');
    expect((await S.run(db({ rows }), quiet)).state).toBe('check');
  });

  test('the retired flags are re-asserted on the ALTER session too', async () => {
    const c = db({ onQuery: (sql, st) => { if (sql === S.SQL.lockWait) st.rows.get('esign_webhook_hmac_mode').value = 'log'; } });
    const r = await S.run(c, { apply: true, ...quiet });
    expect([r.ok, r.state, wrote(c)]).toEqual([false, 'changed', []]);
  });

  test('the test rows already gone → not a step', async () => {
    const rows = ROWS(); rows.delete('gate_probe'); rows.delete('fe-gate_probe');
    const c = db({ rows });
    const r = await S.run(c, { apply: true, ...quiet });
    expect(r.state).toBe('applied-now');
    expect(wrote(c).filter((s) => s.startsWith('DELETE'))).toEqual([]);
  });

  test('a row statement that misses its row → the row transaction rolls back, NO-GO naming what stood; the re-run resumes', async () => {
    const c = db({ deleteMisses: 'fe-gate_probe' });
    const r = await S.run(c, { apply: true, ...quiet });
    expect([r.ok, r.state]).toEqual([false, 'stopped']);
    expect(r.line).toMatch(/stopped after: app_settings_versions created; column comments; table comment \(ROWS DELETE fe-gate_probe matched 0 rows/);
    expect(c.txn).toEqual(['begin', 'rollback']);
    expect([c.st.rows.get('pabbly_internal_url').is_secret, c.st.rows.has('gate_probe')]).toEqual([0, true]);   // rolled back
    c.st.deleteMisses = null;
    c.calls.length = 0;
    const again = await S.run(c, { apply: true, ...quiet });
    expect([again.ok, again.state]).toEqual([true, 'applied-now']);
    expect(wrote(c).filter((s) => /^(CREATE|ALTER)/.test(s))).toEqual([]);
  });

  test('a DDL step that fails (lock wait timeout) → NO-GO naming what stood, nothing after it', async () => {
    const c = db({ onQuery: (sql) => { if (sql === S.SQL.alterTable) throw Object.assign(new Error('Lock wait timeout exceeded'), { code: 'ER_LOCK_WAIT_TIMEOUT' }); } });
    const r = await S.run(c, { apply: true, ...quiet });
    expect([r.ok, r.state]).toEqual([false, 'stopped']);
    expect(r.line).toMatch(/stopped after: app_settings_versions created; column comments \(ER_LOCK_WAIT_TIMEOUT/);
    expect(wrote(c).filter((s) => /^(UPDATE|DELETE)/.test(s))).toEqual([]);
  });

  test('the state changes between CHECK and apply (the re-read finds a problem) → NO-GO changed, nothing written', async () => {
    let reads = 0;
    const c = db({ onQuery: (sql, st) => { if (sql === S.SQL.columns && ++reads === 2) st.cols = st.cols.map((x) => (x.COLUMN_NAME === 'label' ? { ...x, COLUMN_TYPE: 'varchar(200)' } : x)); } });
    const r = await S.run(c, { apply: true, ...quiet });
    expect([r.ok, r.state, wrote(c)]).toEqual([false, 'changed', []]);
  });

  test.each([
    ['another column changed by the ALTER', { onQuery: (sql, st) => { if (sql.startsWith('ALTER TABLE `app_settings`\n')) st.cols = st.cols.map((x) => (x.COLUMN_NAME === 'value' ? { ...x, COLUMN_TYPE: 'mediumtext' } : x)); } }],
    ['is_secret\'s comment changed', { onQuery: (sql, st) => { if (sql === S.SQL.alterTable) st.cols.find((x) => x.COLUMN_NAME === 'is_secret').COLUMN_COMMENT = ''; } }],
    ['the row count off', { onQuery: (sql, st) => { if (sql === S.SQL.markPabbly) st.rows.set('stray', { key: 'stray', value: 'x', is_secret: 0 }); } }],
    ['the smoke reading back nothing', { smokeBroken: true }],
  ])('a read-back that does not verify (%s) → NO-GO verify-failed', async (_, over) => {
    const c = db(over);
    const r = await S.run(c, { apply: true, ...quiet });
    expect([r.ok, r.state]).toEqual([false, 'verify-failed']);
    expect(r.line).toMatch(/ref\/migrations\/2026-10-18_settings_arc\.sql/);
  });
});

// ─────────────────────────────────────────────────────────────
// Stage 2
// ─────────────────────────────────────────────────────────────

describe('runStage2()', () => {
  test('refuses to start without a live check', async () => {
    await expect(S.runStage2(db(STAGE1_DONE()), { ...quiet })).rejects.toThrow('a live-build check is required');
  });

  test('stage 1 not complete → NO-GO naming stage 1, the live build not consulted, nothing written', async () => {
    const c = db();
    const r = await S.runStage2(c, { apply: true, ...quiet, live: async () => { throw new Error('not consulted'); } });
    expect([r.ok, r.state, wrote(c)]).toEqual([false, 'stage1', []]);
    expect(r.line).toBe('NO-GO — stage 1 is not complete. Next: node scripts/settingsArcMigrate.js');
  });

  test('CHECK: both flags at their final value, the new backend live → GO, nothing written', async () => {
    const c = db(STAGE1_DONE());
    let asked = 0;
    const r = await S.runStage2(c, { ...quiet, live: async () => { asked++; return LIVE_OK(); } });
    expect([r.ok, r.state, wrote(c), asked]).toEqual([true, 'check', [], 1]);
    expect(r.line).toBe('CHECK OK — GO. Next: node scripts/settingsArcMigrate.js --stage2 --apply');
  });

  test('--apply: both rows recorded, then deleted in one transaction; verified', async () => {
    const c = db(STAGE1_DONE());
    const out = [];
    const r = await S.runStage2(c, { apply: true, ...logInto(out), live: LIVE_OK });
    expect([r.ok, r.state, r.line]).toEqual([true, 'applied-now', 'STAGE 2 APPLIED — GO. The settings arc migration is complete.']);
    expect(wrote(c)).toEqual([S.SQL.del('unified_singleton_enabled', '1'), S.SQL.del('esign_webhook_hmac_mode', 'enforce')]);
    expect(c.txn).toEqual(['begin', 'commit']);
    expect([c.st.rows.has('unified_singleton_enabled'), c.st.rows.has('esign_webhook_hmac_mode')]).toEqual([false, false]);
    expect(out.filter((l) => l.includes('record — deleting')).map((l) => l.split(':')[0])).toEqual([
      '  record — deleting unified_singleton_enabled', '  record — deleting esign_webhook_hmac_mode']);
  });

  test('the new backend not confirmed live → NO-GO, nothing deleted, CHECK and --apply alike', async () => {
    for (const apply of [false, true]) {
      const c = db(STAGE1_DONE());
      const r = await S.runStage2(c, { apply, ...quiet, live: LIVE_NO });
      expect([apply, r.ok, r.state, wrote(c)]).toEqual([apply, false, 'blocked', []]);
    }
  });

  test('both already gone → GO, the live build not consulted', async () => {
    const done = STAGE1_DONE();
    done.rows.delete('unified_singleton_enabled'); done.rows.delete('esign_webhook_hmac_mode');
    const c = db(done);
    const r = await S.runStage2(c, { apply: true, ...quiet, live: async () => { throw new Error('not consulted'); } });
    expect([r.ok, r.state, wrote(c)]).toEqual([true, 'applied', []]);
  });

  test('one already gone → only the other is deleted (resumes)', async () => {
    const done = STAGE1_DONE();
    done.rows.delete('esign_webhook_hmac_mode');
    const c = db(done);
    const r = await S.runStage2(c, { apply: true, ...quiet, live: LIVE_OK });
    expect([r.ok, wrote(c)]).toEqual([true, [S.SQL.del('unified_singleton_enabled', '1')]]);
  });

  test.each([
    ['unified_singleton_enabled', '0'], ['unified_singleton_enabled', ''], ['unified_singleton_enabled', ' 1'],
    ['esign_webhook_hmac_mode', 'log'], ['esign_webhook_hmac_mode', 'Enforce'], ['esign_webhook_hmac_mode', null],
  ])('%s holding %p → NO-GO naming it, nothing deleted', async (key, v) => {
    const done = STAGE1_DONE();
    done.rows.get(key).value = v;
    const c = db(done);
    const out = [];
    const r = await S.runStage2(c, { apply: true, ...logInto(out), live: LIVE_OK });
    expect([r.ok, r.state, wrote(c)]).toEqual([false, 'blocked', []]);
    expect(out.join('\n')).toContain(`${key} holds`);
  });

  test('a flag flagged secret → NO-GO, its value never read or printed', async () => {
    const done = STAGE1_DONE();
    done.rows.set('esign_webhook_hmac_mode', { ...done.rows.get('esign_webhook_hmac_mode'), value: 'SECRET-MODE', is_secret: 1 });
    const c = db(done);
    const out = [];
    const r = await S.runStage2(c, { apply: true, ...logInto(out), live: LIVE_OK });
    expect([r.ok, r.state, wrote(c)]).toEqual([false, 'blocked', []]);
    expect(out.join('\n')).not.toContain('SECRET');
    expect(c.valueReads).not.toContain('esign_webhook_hmac_mode');
  });

  test('a DELETE that misses → rolled back (the other one too), NO-GO', async () => {
    const c = db({ ...STAGE1_DONE(), deleteMisses: 'unified_singleton_enabled' });
    const r = await S.runStage2(c, { apply: true, ...quiet, live: LIVE_OK });
    expect([r.ok, r.state]).toEqual([false, 'stopped']);
    expect(c.txn).toEqual(['begin', 'rollback']);
    expect([c.st.rows.has('unified_singleton_enabled'), c.st.rows.has('esign_webhook_hmac_mode')]).toEqual([true, true]);
  });
});

// ─────────────────────────────────────────────────────────────
// liveCheck()
// ─────────────────────────────────────────────────────────────

describe('liveCheck()', () => {
  const CLEAN = "const x = cfg('cloud_tasks_enabled');\n// unified_singleton_enabled retired (settings arc) — `esign_webhook_hmac_mode` too";
  const COMMIT = Date.parse('2026-10-18T10:00:00Z');
  const res = (body, status = 200) => async () => ({ ok: status === 200, status, json: async () => body });
  const base = { url: 'https://app.example/api/version', readFile: () => CLEAN, gitTime: async () => COMMIT };

  test('readers clean and a build checked out after the arc\'s newest commit → ok', async () => {
    const r = await S.liveCheck({ ...base, fetchImpl: res({ build: 'svpcac-1', mtime: COMMIT + 60_000 }) });
    expect(r).toEqual({ ok: true, detail: 'build svpcac-1 from 2026-10-18T10:01:00Z, after the arc\'s newest commit here (2026-10-18T10:00:00Z)' });
  });

  test.each([
    ['an older build', { fetchImpl: res({ build: 'svpcac-0', mtime: COMMIT - 1 }) }, /older than the arc's newest commit .* deploy main first/],
    ['the same instant', { fetchImpl: res({ build: 'svpcac-0', mtime: COMMIT }) }, /older than/],
    ['no mtime', { fetchImpl: res({ build: 'svpcac-0' }) }, /from \?/],
    ['a 503', { fetchImpl: res({}, 503) }, /answered 503/],
    ['a timeout', { fetchImpl: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; } }, /timed out after 10 s/],
    ['an uncommitted script', { gitTime: async () => null, fetchImpl: res({ mtime: COMMIT + 1 }) }, /not committed here/],
  ])('%s → not ok', async (_, over, re) => {
    const r = await S.liveCheck({ ...base, ...over });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(re);
  });

  test.each(S.READERS.flatMap((f) => [[f, "cfg('unified_singleton_enabled')"], [f, 'const K = "esign_webhook_hmac_mode";']]))(
    'this checkout\'s %s still naming a flag (%s) → not ok, the build not even asked', async (file, text) => {
      let fetched = false;
      const r = await S.liveCheck({ ...base, readFile: (rel) => (rel === file ? text : CLEAN),
        fetchImpl: async () => { fetched = true; return { ok: true, status: 200, json: async () => ({ mtime: COMMIT + 1 }) }; } });
      expect([r.ok, fetched]).toEqual([false, false]);
      expect(r.detail).toMatch(new RegExp(`${file.replace(/[.]/g, '\\.')} still names`));
    });

  test('the fetch is time-limited (an AbortSignal is passed)', async () => {
    let seen;
    await S.liveCheck({ ...base, fetchImpl: async (u, o) => { seen = o; return { ok: true, status: 200, json: async () => ({ mtime: COMMIT + 1 }) }; } });
    expect(seen && seen.signal).toBeInstanceOf(AbortSignal);
  });
});

// ─────────────────────────────────────────────────────────────
// Pins
// ─────────────────────────────────────────────────────────────

describe('pins', () => {
  const REC = fs.readFileSync(path.join(ROOT, 'ref/migrations/2026-10-18_settings_arc.sql'), 'utf8');

  test('the migration record carries the script\'s statements verbatim, in order, and the rollback', () => {
    const s1 = S.stage1Sql().join('\n\n');
    const s2 = S.stage2Sql().join('\n');
    expect(REC).toContain(s1);
    expect(REC).toContain(s2);
    expect(REC.indexOf(s1)).toBeLessThan(REC.indexOf(s2));
    expect(REC).toContain('APPLIED BY: node scripts/settingsArcMigrate.js [--apply]');
    expect(REC).toContain("-- UPDATE `app_settings` SET `is_secret` = 0 WHERE `key` = 'pabbly_internal_url';");
    expect(REC).toContain('-- DROP TABLE `app_settings_versions`;');
    expect(REC).toContain("--   MODIFY COLUMN `is_editable` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'exposed in settings.html',");
    expect(REC).toContain("--   MODIFY COLUMN `key` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '',");
    expect(REC).toContain("-- INSERT INTO `app_settings` (`key`, `value`, `is_secret`) VALUES ('esign_webhook_hmac_mode', 'enforce', 0);");
  });

  test('the session setting, and the ALTERs\' algorithms', () => {
    expect(S.SQL.lockWait).toBe('SET SESSION lock_wait_timeout = 5');
    expect(S.SQL.alterColumns(['label'])).toMatch(/\n {2}ALGORITHM=INSTANT$/);
    expect(S.SQL.alterTable).toMatch(/, ALGORITHM=INPLACE, LOCK=NONE$/);
    expect(S.SQL.createVersions).not.toMatch(/IF NOT EXISTS/);   // a foreign table of that name must error, not pass
  });

  test('the expected app_settings definitions are the schema dump\'s (old comment before the migration, new after)', () => {
    const dump = fs.readFileSync(path.join(ROOT, 'ref/database.sql'), 'utf8');
    const ddl = /CREATE TABLE `app_settings` \(([\s\S]*?)\n\)/.exec(dump)[1];
    for (const [name, c] of Object.entries(S.COLUMNS)) {
      const line = ddl.split('\n').find((l) => l.trim().startsWith(`\`${name}\` `)).trim().replace(/,$/, '');
      const norm = (x) => x.replace(/ NULL DEFAULT NULL/, ' DEFAULT NULL');
      const variants = [c.old, c.new].map((cm) => norm(`\`${name}\` ${c.ddl}${cm ? ` COMMENT ${S.sqlStr(cm)}` : ''}`));
      expect([name, variants.includes(line)]).toEqual([name, true]);
    }
    expect(ddl).toContain("`is_secret` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'never returned by any settings API'");
  });

  test('a flag is a QUOTED literal to the readers check; a mention in prose or backticks is not', () => {
    for (const yes of ["'unified_singleton_enabled'", '"esign_webhook_hmac_mode"']) expect([yes, S.FLAG_LITERAL_RE.test(yes)]).toEqual([yes, true]);
    for (const no of ['unified_singleton_enabled', '`esign_webhook_hmac_mode`', "'unified_singleton_enabled\"", "'esign_webhook_hmac_mode_x'"]) {
      expect([no, S.FLAG_LITERAL_RE.test(no)]).toEqual([no, false]);
    }
  });

  test('the registry agrees with what the script changes', () => {
    const reg = require('../lib/settingsRegistry');
    expect(reg.get(S.PABBLY).kind).toBe('secret');
    for (const [k] of S.FLAGS) expect([k, reg.get(k).kind]).toEqual([k, 'retired']);
    for (const [k] of S.TEST_ROWS) expect([k, reg.isRegistered(k)]).toEqual([k, false]);
  });
});
