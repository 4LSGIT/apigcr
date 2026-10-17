// tests/uiCustomS5e3.mysql.test.js
//
/**
 * ui-custom S5e-3 on REAL MySQL — scripts/uiCustomS5e3DropCustomTab.js run end
 * to end on one connection, CHECK and --apply, against the live shape; and
 * routes/admin.users.js's INSERT run on both sides of the drop.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3395/yc_s5e3_test npx jest tests/uiCustomS5e3.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates `users`
 * in it from ref/database.sql (putting user_custom_tab back after reset_expires
 * once the regenerated dump no longer has it). Sessions run the LIVE global
 * sql_mode (NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,
 * NO_ENGINE_SUBSTITUTION — no STRICT_TRANS_TABLES).
 *
 * WHAT IS LOCKED
 *   - the INSERT, as shipped, works WITH the column (relaxed mode stores the
 *     JSON null scalar, exactly what it used to write) and WITHOUT it;
 *   - CHECK writes nothing and says GO; --apply drops the column (INSTANT),
 *     keeps every other column and row, and a second run is a no-op GO;
 *   - a value someone wrote, a trigger or a view naming the column → NO-GO,
 *     nothing changed (the sweep reads real information_schema bodies);
 *   - lock_wait_timeout = 5 is real: an open transaction holding a metadata
 *     lock on users makes --apply fail fast, nothing changed;
 *   - the migration record's ROLLBACK statement puts the column back where it
 *     stood with every row the JSON null, and CHECK is GO again.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const S = require('../scripts/uiCustomS5e3DropCustomTab');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const ROOT = path.join(__dirname, '..');
const LIVE_MODE = 'NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const LIVE_OK = async () => ({ ok: true, detail: 'stand-in: the new backend is live' });
const quiet = { log: () => {} };

/** CREATE TABLE + its ALTER blocks for one table, from ref/database.sql — line-based (COMMENTs hold ';'). */
function cloneDdl(sqlText, table) {
  const lines = sqlText.split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i];
    if (head === 'CREATE TABLE `' + table + '` (' || head === 'ALTER TABLE `' + table + '`') {
      const blk = [head];
      const end = head.startsWith('CREATE') ? /^\) ENGINE=.*;$/ : /;$/;
      while (!end.test(lines[i])) blk.push(lines[++i]);
      out.push(blk.join('\n').replace(/;$/, ''));
    }
  }
  if (!out.length || !out[0].startsWith('CREATE')) throw new Error('no DDL for ' + table);
  return out;
}

// routes/admin.users.js's INSERT, as shipped, and a parameter row for it
const ROUTE = fs.readFileSync(path.join(ROOT, 'routes', 'admin.users.js'), 'utf8');
const INSERT = ROUTE.match(/`(INSERT INTO users[\s\S]*?)`/)[1];
const insertParams = (n) => [`new${n}`, 1, null, `New${n}`, 'New', 'User', 'NU', 'authorized', 'staff', null, null, null, null,
  0, 0, 0, null, null, null];
const ROLLBACK = fs.readFileSync(path.join(ROOT, 'ref', 'migrations', '2026-10-17_ui_custom_s5e3_drop_user_custom_tab.sql'), 'utf8')
  .split('\n').filter((l) => /^-- ALTER TABLE `users` ADD COLUMN/.test(l)).map((l) => l.replace(/^-- /, '').replace(/;$/, ''));

d('S5e-3: dropping users.user_custom_tab on real MySQL', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const one = async () => {
    const c = await pool.getConnection();
    return c;
  };
  const columns = async () => (await q("SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() " +
    "AND TABLE_NAME = 'users' ORDER BY ORDINAL_POSITION")).map((r) => r.c);
  const hasCol = async () => (await columns()).includes('user_custom_tab');

  async function rebuild() {
    await q('DROP TRIGGER IF EXISTS s5e3_t');
    await q('DROP VIEW IF EXISTS v_s5e3');
    await q('DROP TABLE IF EXISTS `users`');
    for (const st of cloneDdl(fs.readFileSync(path.join(ROOT, 'ref', 'database.sql'), 'utf8'), 'users')) await q(st);
    if (!await hasCol()) await q('ALTER TABLE `users` ADD COLUMN `user_custom_tab` json NOT NULL AFTER `reset_expires`');
    const sc = await one();
    await sc.query(`SET SESSION sql_mode = '${LIVE_MODE},NO_AUTO_VALUE_ON_ZERO'`);     // the live row 0 exists
    for (const [uid, name, roles] of [[0, 'Automations', 'automation'], [1, 'Stuart', 'admin,staff,attorney'], [3, 'Rivka', 'staff'],
      [5, 'Shoshana', 'staff'], [6, 'Fred', 'it,admin,form_dev,su'], [22, 'Rena', 'staff']]) {
      await sc.query("INSERT INTO users (username, user_name, user_fname, user_lname, user_initials, user_auth, `user`, ringcentral, user_custom_tab, roles) " +
        "VALUES (?, ?, ?, 'x', 'XX', 'authorized', ?, 0, 'null', ?)", [name.toLowerCase(), name, name, uid, roles]);
    }
    sc.release();
  }
  async function runOn(opts) {
    const c = await one();
    try { return await S.run(c, { ...quiet, live: LIVE_OK, ...opts }); } finally { c.release(); }
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${LIVE_MODE}'`));
    expect(ROLLBACK).toHaveLength(1);
    expect((INSERT.match(/\?/g) || []).length).toBe(insertParams(0).length);
  });
  afterAll(async () => { if (pool) await pool.end(); });

  test('the shipped INSERT works with the column (it stores the JSON null) — then CHECK is GO and writes nothing', async () => {
    await rebuild();
    const r = await q(INSERT, insertParams(1));
    const [row] = await q('SELECT CAST(user_custom_tab AS CHAR) AS v, JSON_TYPE(user_custom_tab) AS t, user_custom_tab IS NULL AS n FROM users WHERE `user` = ?', [r.insertId]);
    expect([row.v, row.t, Number(row.n)]).toEqual(['null', 'NULL', 0]);
    const before = JSON.stringify(await q('SELECT * FROM users ORDER BY `user`'));
    const res = await runOn({});
    expect([res.ok, res.state]).toEqual([true, 'check']);
    expect(JSON.stringify(await q('SELECT * FROM users ORDER BY `user`'))).toBe(before);
    expect(await hasCol()).toBe(true);
  });

  test('--apply drops it (every other column and row kept); a second run is a no-op GO; the INSERT works without it', async () => {
    const cols = await columns(), rows = await q('SELECT `user`, username, user_name, roles FROM users ORDER BY `user`');
    const res = await runOn({ apply: true });
    expect([res.ok, res.state]).toEqual([true, 'applied-now']);
    expect(await columns()).toEqual(cols.filter((c) => c !== 'user_custom_tab'));
    expect(await q('SELECT `user`, username, user_name, roles FROM users ORDER BY `user`')).toEqual(rows);
    const again = await runOn({ apply: true });
    expect([again.ok, again.state]).toEqual([true, 'applied']);
    const r = await q(INSERT, insertParams(2));
    expect((await q('SELECT username FROM users WHERE `user` = ?', [r.insertId]))[0].username).toBe('new2');
  });

  test('the migration record\'s ROLLBACK puts it back where it stood, every row the JSON null; CHECK is GO again', async () => {
    const cols = await columns();
    expect(cols).not.toContain('user_custom_tab');
    const c = await one();                                             // the session setting and the ALTER on ONE connection
    try { await c.query('SET SESSION lock_wait_timeout = 5'); await c.query(ROLLBACK[0]); } finally { c.release(); }
    const after = await columns();
    expect(after.indexOf('user_custom_tab')).toBe(after.indexOf('reset_expires') + 1);
    const [v] = await q("SELECT COUNT(*) AS n, SUM(JSON_TYPE(user_custom_tab) = 'NULL') AS j FROM users");
    expect(Number(v.j)).toBe(Number(v.n));
    expect((await runOn({})).state).toBe('check');
  });

  test.each([
    ['a value someone wrote', async () => { await q("UPDATE users SET user_custom_tab = '{\"src\":\"/x.html\"}' WHERE `user` = 3"); }],
    ['SQL NULL', async () => { await q('ALTER TABLE `users` MODIFY `user_custom_tab` json NULL'); await q('UPDATE users SET user_custom_tab = NULL WHERE `user` = 3'); }],
    ['a trigger naming it', async () => { await q('CREATE TRIGGER s5e3_t BEFORE UPDATE ON users FOR EACH ROW SET NEW.user_custom_tab = OLD.user_custom_tab'); }],
    ['a view naming it', async () => { await q('CREATE VIEW v_s5e3 AS SELECT `user`, user_custom_tab FROM users'); }],
  ])('%s → NO-GO, nothing changed', async (_, make) => {
    await rebuild();
    await make();
    const res = await runOn({ apply: true });
    expect([res.ok, res.state]).toEqual([false, 'blocked']);
    expect(await hasCol()).toBe(true);
    await q('DROP TRIGGER IF EXISTS s5e3_t');
    await q('DROP VIEW IF EXISTS v_s5e3');
  });

  test('lock_wait_timeout is real: a transaction holding users makes --apply fail in ~5 s, nothing changed', async () => {
    await rebuild();
    const holder = await one();
    await holder.query('START TRANSACTION');
    await holder.query('SELECT * FROM users LIMIT 1');                 // a shared metadata lock until commit
    const t0 = Date.now();
    let err = null;
    try { await runOn({ apply: true }); } catch (e) { err = e; }
    const took = Date.now() - t0;
    await holder.query('COMMIT');
    holder.release();
    expect(err && err.code).toBe('ER_LOCK_WAIT_TIMEOUT');
    expect(took).toBeGreaterThan(4000);
    expect(took).toBeLessThan(20000);
    expect(await hasCol()).toBe(true);
  }, 30000);
});
