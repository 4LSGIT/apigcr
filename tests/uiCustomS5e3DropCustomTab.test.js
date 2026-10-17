/**
 * scripts/uiCustomS5e3DropCustomTab.js — every path of run() and liveCheck()
 * over a scripted connection (the script's own module is real; only the DB,
 * git and the network are stand-ins). The real-engine run is
 * tests/uiCustomS5e3.mysql.test.js (gated) and the manager's CHECK.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../scripts/uiCustomS5e3DropCustomTab');

const ROOT = path.join(__dirname, '..');
const quiet = { log: () => {} };
const LIVE_OK = async () => ({ ok: true, detail: 'build x, after the commit' });
const LIVE_NO = async () => ({ ok: false, detail: 'live build older than the commit' });

// users as live 2026-10-17: 25 columns, user_custom_tab 21st (json NOT NULL, no default)
const col = (name, type, over = {}) => ({ COLUMN_NAME: name, COLUMN_TYPE: type, IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, EXTRA: '',
  CHARACTER_SET_NAME: null, COLLATION_NAME: null, COLUMN_COMMENT: '', ...over });
const COLS = () => [
  col('username', 'varchar(50)', { IS_NULLABLE: 'NO' }), col('user_type', 'tinyint(1)', { IS_NULLABLE: 'NO', COLUMN_DEFAULT: '1' }),
  col('user_name', 'varchar(20)', { IS_NULLABLE: 'NO' }), col('user', 'tinyint', { IS_NULLABLE: 'NO', EXTRA: 'auto_increment' }),
  col('reset_expires', 'datetime'), col('user_custom_tab', 'json', { IS_NULLABLE: 'NO' }), col('does_appts', 'tinyint(1)', { IS_NULLABLE: 'NO', COLUMN_DEFAULT: '0' }),
  col('roles', "set('it','admin','staff','attorney','automation','form_dev','su')", { IS_NULLABLE: 'NO', COLUMN_DEFAULT: '' }),
];
const EMPTY_REFS = () => ({ triggers: [], views: [], routines: [], events: [], generated: [], checks: [], indexes: [], fks: [] });

/** A stand-in DB that behaves like the real one for the statements the script sends. */
function db(over = {}) {
  const st = { cols: COLS(), rows: 9, values: { n: 9, jnull: 9, sqlnull: 0 }, refs: EMPTY_REFS(), dropWorks: true, ...over };
  const calls = [];
  const txn = [];
  const keyOf = (sql) => Object.keys(S.SQL).find((k) => typeof S.SQL[k] === 'string' && S.SQL[k] === sql);
  const conn = {
    st, calls, txn,
    async beginTransaction() { txn.push('begin'); },
    async rollback() { txn.push('rollback'); },
    async commit() { txn.push('commit'); },
    async query(q, params) {
      const sql = typeof q === 'string' ? q : q.sql;
      calls.push([sql, params]);
      if (st.onQuery) st.onQuery(sql, st);
      switch (keyOf(sql)) {
        case 'who': return [[{ cu: 'app@%', db: 'yc', v: '8.4.11-google' }]];
        case 'columns': return [st.cols.map((c) => ({ ...c }))];
        case 'rows': return [[{ n: st.rows }]];
        case 'values': return [[{ n: st.values.n, jnull: String(st.values.jnull), sqlnull: String(st.values.sqlnull) }]];
        case 'lockWait': return [{}];
        case 'drop': if (st.dropWorks) st.cols = st.cols.filter((c) => c.COLUMN_NAME !== 'user_custom_tab'); return [{ info: '' }];
        case 'smokeRow': {
          const row = { user: 0, user_name: 'Automations' };
          if (st.cols.some((c) => c.COLUMN_NAME === 'user_custom_tab') || st.smokeKeepsColumn) row.user_custom_tab = null;
          return [[row]];
        }
        case 'smokeUpd': return [{ affectedRows: st.updMatches === undefined ? 1 : st.updMatches }];
        default: {
          const k = Object.keys(st.refs).find((r) => S.SQL[r] === sql);
          if (k) return [st.refs[k]];
          throw new Error('unscripted SQL: ' + sql);
        }
      }
    },
  };
  return conn;
}
const altered = (c) => c.calls.some(([sql]) => /^ALTER TABLE/.test(sql));

describe('run()', () => {
  test('CHECK on the live shape: GO, nothing written, the live check consulted', async () => {
    const c = db();
    let asked = 0;
    const r = await S.run(c, { ...quiet, live: async () => { asked++; return LIVE_OK(); } });
    expect([r.ok, r.state, altered(c), asked, c.txn]).toEqual([true, 'check', false, 1, []]);
    expect(r.line).toBe('CHECK OK — GO. Next: node scripts/uiCustomS5e3DropCustomTab.js --apply');
  });

  test('--apply: lock_wait first, a re-read on that session, the INSTANT drop, verified, smoke rolled back', async () => {
    const c = db();
    const r = await S.run(c, { apply: true, ...quiet, live: LIVE_OK });
    expect([r.ok, r.state]).toEqual([true, 'applied-now']);
    const sqls = c.calls.map(([s]) => s);
    const lw = sqls.indexOf(S.SQL.lockWait), drop = sqls.indexOf(S.SQL.drop);
    expect(lw).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(lw);
    expect(sqls.slice(lw, drop).filter((s) => s === S.SQL.values).length).toBe(1);   // re-asserted on the ALTER's session
    expect(sqls.filter((s) => s === S.SQL.drop).length).toBe(1);
    expect(c.txn).toEqual(['begin', 'rollback']);                                    // the smoke never commits
    expect(sqls.indexOf(S.SQL.smokeUpd)).toBeGreaterThan(drop);
    expect(c.st.cols.map((x) => x.COLUMN_NAME)).not.toContain('user_custom_tab');
    expect(r.line).toBe('APPLIED — GO. users.user_custom_tab is gone. Next: any commit regenerates ref/database.sql (pre-commit hook).');
  });

  test('already dropped: GO, nothing written and no live check, even with --apply', async () => {
    const c = db({ cols: COLS().filter((x) => x.COLUMN_NAME !== 'user_custom_tab') });
    const r = await S.run(c, { apply: true, ...quiet, live: async () => { throw new Error('not consulted'); } });
    expect([r.ok, r.state, altered(c)]).toEqual([true, 'applied', false]);
    expect(c.calls.some(([s]) => s === S.SQL.values || s === S.SQL.lockWait)).toBe(false);
  });

  test('dropped, but something still names it → NO-GO dropped-dirty', async () => {
    const refs = EMPTY_REFS(); refs.views = [{ name: 'v_old', body: 'select `users`.`user_custom_tab` AS `t` from `users`' }];
    const c = db({ cols: COLS().filter((x) => x.COLUMN_NAME !== 'user_custom_tab'), refs });
    const r = await S.run(c, { apply: true, ...quiet, live: LIVE_OK });
    expect([r.ok, r.state, altered(c)]).toEqual([false, 'dropped-dirty', false]);
  });

  test.each([
    ['COLUMN_TYPE', 'longtext'], ['IS_NULLABLE', 'YES'], ['COLUMN_DEFAULT', 'null'], ['EXTRA', 'DEFAULT_GENERATED'], ['COLUMN_COMMENT', 'someone wrote this'],
  ])('an unexpected %s → NO-GO, nothing written', async (k, v) => {
    const c = db({ cols: COLS().map((x) => (x.COLUMN_NAME === 'user_custom_tab' ? { ...x, [k]: v } : x)) });
    const r = await S.run(c, { apply: true, ...quiet, live: LIVE_OK });
    expect([r.ok, r.state, altered(c)]).toEqual([false, 'blocked', false]);
  });

  test.each([
    ['a row holding a value', { n: 9, jnull: 8, sqlnull: 0 }, 9],
    ['a row holding SQL NULL', { n: 9, jnull: 8, sqlnull: 1 }, 9],
    ['the counts disagreeing', { n: 9, jnull: 9, sqlnull: 0 }, 10],
  ])('values: %s → NO-GO, nothing written', async (_, values, rows) => {
    const c = db({ values, rows });
    const r = await S.run(c, { apply: true, ...quiet, live: LIVE_OK });
    expect([r.ok, r.state, altered(c)]).toEqual([false, 'blocked', false]);
  });

  test.each([
    ['triggers', { name: 'after_users_update', tbl: 'users', body: 'BEGIN SET @x = NEW.user_custom_tab; END' }],
    ['views', { name: 'v', body: 'select `user_custom_tab` from users' }],
    ['routines', { name: 'p', body: 'BEGIN SELECT user_custom_tab FROM users; END' }],
    ['events', { name: 'e', body: 'UPDATE users SET user_custom_tab = NULL' }],
    ['generated', { name: 'users.x', body: 'json_extract(`user_custom_tab`,_utf8mb4\'$.src\')' }],
    ['checks', { name: 'c', body: '(json_valid(`user_custom_tab`))' }],
    ['indexes', { name: 'ix_tab' }],
    ['fks', { name: 'fk_tab' }],
  ])('the sweep: a %s that names it → NO-GO, nothing written', async (kind, row) => {
    const refs = EMPTY_REFS(); refs[kind] = [row];
    const c = db({ refs });
    const r = await S.run(c, { apply: true, ...quiet, live: LIVE_OK });
    expect([r.ok, r.state, altered(c)]).toEqual([false, 'blocked', false]);
  });

  test('the sweep reads whole identifiers: a trigger that names other columns is not a reference', async () => {
    const refs = EMPTY_REFS();
    refs.triggers = [{ name: 't1', tbl: 'cases', body: 'SET NEW.user_custom_tabs = 1; SET @a = my_user_custom_tab; SET @b = user_custom_tab2;' }];
    const c = db({ refs });
    expect((await S.run(c, { ...quiet, live: LIVE_OK })).state).toBe('check');
    for (const yes of ['user_custom_tab', 'NEW.user_custom_tab', '`user_custom_tab`', 'JSON_TYPE(user_custom_tab)', 'USER_CUSTOM_TAB']) expect([yes, S.NAMES_RE.test(yes)]).toEqual([yes, true]);
    for (const no of ['user_custom_tabs', 'my_user_custom_tab', 'user_custom_tab2', '$user_custom_tab', 'user_custom_tab$']) expect([no, S.NAMES_RE.test(no)]).toEqual([no, false]);
  });

  test('the live backend not confirmed → NO-GO, nothing written, CHECK and --apply alike', async () => {
    for (const apply of [false, true]) {
      const c = db();
      const r = await S.run(c, { apply, ...quiet, live: LIVE_NO });
      expect([apply, r.ok, r.state, altered(c), c.calls.some(([s]) => s === S.SQL.lockWait)]).toEqual([apply, false, 'blocked', false, false]);
    }
  });

  test('the state changes between CHECK and the ALTER (a value written) → NO-GO changed, nothing dropped', async () => {
    let reads = 0;
    const c = db({ onQuery: (sql, st) => { if (sql === S.SQL.values && ++reads === 2) st.values = { n: 9, jnull: 8, sqlnull: 0 }; } });
    const r = await S.run(c, { apply: true, ...quiet, live: LIVE_OK });
    expect([r.ok, r.state, altered(c)]).toEqual([false, 'changed', false]);
  });

  test.each([
    ['the column still there', { dropWorks: false }],
    ['another column changed', { onQuery: (sql, st) => { if (sql === S.SQL.drop) st.cols = st.cols.map((x) => (x.COLUMN_NAME === 'roles' ? { ...x, COLUMN_DEFAULT: 'staff' } : x)); } }],
    ['the column order changed', { onQuery: (sql, st) => { if (sql === S.SQL.drop) st.cols = st.cols.slice().reverse(); } }],
    ['the row count changed', { onQuery: (sql, st) => { if (sql === S.SQL.drop) st.rows = 8; } }],
    ['SELECT * still carrying it', { smokeKeepsColumn: true }],
    ['the one-row UPDATE matching none', { updMatches: 0 }],
  ])('a read-back that does not verify (%s) → NO-GO verify-failed', async (_, over) => {
    const c = db(over);
    const r = await S.run(c, { apply: true, ...quiet, live: LIVE_OK });
    expect([r.ok, r.state]).toEqual([false, 'verify-failed']);
    expect(r.line).toMatch(/ref\/migrations\/2026-10-17_ui_custom_s5e3_drop_user_custom_tab\.sql/);
  });

  test('run() refuses to start without a live check', async () => {
    await expect(S.run(db(), { ...quiet })).rejects.toThrow('a live-build check is required');
  });
});

describe('liveCheck()', () => {
  const ROUTE_NEW = "INSERT INTO users (username, user_gcal_id, password_hash) VALUES (?, ?, ?)";
  const COMMIT = Date.parse('2026-10-18T10:00:00Z');
  const res = (body, status = 200) => async () => ({ ok: status === 200, status, json: async () => body });
  const base = { url: 'https://app.example/api/version', readFile: () => ROUTE_NEW, gitTime: async () => COMMIT };

  test('a build checked out after the commit → ok', async () => {
    const r = await S.liveCheck({ ...base, fetchImpl: res({ build: 'svpcac-1', mtime: COMMIT + 60_000 }) });
    expect(r).toEqual({ ok: true, detail: 'build svpcac-1 from 2026-10-18T10:01:00Z, after this script\'s commit (2026-10-18T10:00:00Z)' });
  });

  test.each([
    ['an older build', { fetchImpl: res({ build: 'svpcac-0', mtime: COMMIT - 1 }) }, /older than this script's commit .* deploy main first/],
    ['the same instant', { fetchImpl: res({ build: 'svpcac-0', mtime: COMMIT }) }, /older than/],
    ['no mtime', { fetchImpl: res({ build: 'svpcac-0' }) }, /from \?/],
    ['a 503', { fetchImpl: res({}, 503) }, /answered 503/],
    ['a timeout', { fetchImpl: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; } }, /timed out after 10 s/],
    ['an uncommitted script', { gitTime: async () => null, fetchImpl: res({ mtime: COMMIT + 1 }) }, /not committed here/],
    ['a checkout whose route still names the column', { readFile: () => ROUTE_NEW.replace('user_gcal_id,', 'user_gcal_id, user_custom_tab,'), fetchImpl: res({ mtime: COMMIT + 1 }) }, /still names the column/],
  ])('%s → not ok', async (_, over, re) => {
    const r = await S.liveCheck({ ...base, ...over });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(re);
  });

  test('the fetch is time-limited (an AbortSignal is passed)', async () => {
    let seen;
    await S.liveCheck({ ...base, fetchImpl: async (u, o) => { seen = o; return { ok: true, status: 200, json: async () => ({ mtime: COMMIT + 1 }) }; } });
    expect(seen && seen.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('pins', () => {
  test('the drop and the session setting, exactly; the expected definition is what prod reads (2026-10-17)', () => {
    expect(S.SQL.drop).toBe('ALTER TABLE `users` DROP COLUMN `user_custom_tab`, ALGORITHM=INSTANT');
    expect(S.SQL.lockWait).toBe('SET SESSION lock_wait_timeout = 5');
    expect(S.EXPECT).toEqual({ COLUMN_TYPE: 'json', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, EXTRA: '', COLUMN_COMMENT: '' });
    expect(S.SWEEP.map(([, k]) => k)).toEqual(['triggers', 'views', 'routines', 'events', 'generated', 'checks', 'indexes', 'fks']);
  });

  test('the migration record carries the same statements, and its rollback puts the column back where it stood', () => {
    const rec = fs.readFileSync(path.join(ROOT, 'ref/migrations/2026-10-17_ui_custom_s5e3_drop_user_custom_tab.sql'), 'utf8');
    expect(rec).toContain(S.SQL.lockWait + ';\n' + S.SQL.drop + ';');
    expect(rec).toContain('-- ALTER TABLE `users` ADD COLUMN `user_custom_tab` json NOT NULL AFTER `reset_expires`, ALGORITHM=INSTANT;');
    expect(rec).toContain('APPLIED BY: node scripts/uiCustomS5e3DropCustomTab.js --apply');
  });

  test('the backend half: routes/admin.users.js names the column nowhere (the drop\'s live check reads the same file)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes/admin.users.js'), 'utf8');
    expect(S.NAMES_RE.test(src)).toBe(false);
    const ins = src.match(/`(INSERT INTO users[\s\S]*?)`/)[1];
    expect((ins.match(/\?/g) || []).length).toBe(19);    // 17 fields + password_hash + password, the handler's 19 values
  });
});
