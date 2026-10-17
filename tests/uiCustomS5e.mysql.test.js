// tests/uiCustomS5e.mysql.test.js
//
/**
 * ui-custom S5e-1 on REAL MySQL — scripts/uiCustomS5eCustomTabsToButtons.js run
 * end to end, CHECK and --apply, on one connection, against the live shape.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3395/yc_s5e1_test npx jest tests/uiCustomS5e.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates users,
 * ui_config, ui_config_versions and entitlement_denies in it, cloned from
 * ref/database.sql (users.user_custom_tab is `json NOT NULL`, as live at the
 * S5e-1 run; once S5e-3 has dropped it, the suite adds it back where it stood). The
 * session runs the LIVE global sql_mode (manager, 2026-10-16:
 * NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION).
 * S5E_CHECK_OUT=<file>: the seeded CHECK's output is also written there.
 *
 * WHAT IS LOCKED
 *   - the shipped record is the expected state as-is (user 5's loadFunc read
 *     live); a record value held as {$unknown} is a NO-GO that writes nothing
 *     and prints the exact live value to paste;
 *   - CHECK writes nothing (every row, updated_at included) and says GO;
 *   - --apply reaches the end state: the planned documents, the JSON null
 *     scalar in user_custom_tab (IS NOT NULL, JSON_TYPE 'NULL'), updated_by =
 *     the user, no version rows, Fred's other rows untouched, users 2 / 4 / 23
 *     and the firm row untouched;
 *   - a second --apply is a no-op GO;
 *   - a run killed after a user commits resumes; a failure before a user's
 *     commit rolls that user back whole;
 *   - drift (CHECK and --apply alike) → NO-GO with zero writes.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const mysql = require('mysql2/promise');
const S = require('../scripts/uiCustomS5eCustomTabsToButtons');
const svc = require('../services/uiConfigService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const ROOT = path.join(__dirname, '..');
const LIVE_MODE = 'NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
// user 5's loadFunc, read live by the manager 2026-10-16 (U+1F947 twice)
const PRANK = "Toast.fire({text:'you clicked the link first so you get this prize',icon:'info',title:'\u{1F947} First Place! \u{1F947}'});";
const J = (x) => JSON.parse(JSON.stringify(x));

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

const FRED_ITEMS = { items: [
  { id: 'user:call-review', label: 'call review', icon: 'phone', action: { type: 'tool', key: 'call-review', present: 'modal' } },
  { id: 'user:box', label: 'Box', icon: 'box', action: { type: 'drawer', items: ['user:call-review', 'cases'] } },
] };
const FRED_LAYOUT = {
  placed: { home: [{ item: 'cases' }, { item: 'comms' }, { break: true }, { item: 'tasks' }, { item: 'log' }, { item: 'custom' }, { item: 'user:box' },
    { break: true }, { item: 'contacts' }, { item: 'appts' }, { item: 'bills' }, { item: 'pipeline' }, { item: 'events' }, { item: 'newClient' }, { item: 'moreFeatures' }] },
  removed: { home: [] },
};
const FIRM = { hidden: ['calendar'], locked: ['cases'], renames: { log: { label: 'History' } },
  items: [{ id: 'firm:payroll', label: 'Payroll', icon: 'money-check', action: { type: 'url', href: 'https://pay.example.com/', present: 'window' } }] };
const USERS = [
  [0, 'Automations', 'automation'], [1, 'Stuart', 'admin,staff,attorney'], [2, 'Two', 'staff'], [3, 'Rivka', 'staff'], [4, 'Four', 'staff'],
  [5, 'Shoshana', 'staff'], [6, 'Fred', 'it,admin,form_dev,su'], [22, 'Rena', 'staff'], [23, 'TwentyThree', 'staff'],
];

d('S5e-1: the custom-tab conversion on real MySQL', () => {
  let pool, conn, tmp, RECORD_OK, UNKNOWN;
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${LIVE_MODE}'`));
    const ddl = fs.readFileSync(path.join(ROOT, 'ref', 'database.sql'), 'utf8');
    for (const t of ['ui_config_versions', 'ui_config', 'entitlement_denies', 'users']) await q(`DROP TABLE IF EXISTS \`${t}\``);
    for (const t of ['users', 'entitlement_denies', 'ui_config', 'ui_config_versions']) for (const st of cloneDdl(ddl, t)) await q(st);
    // this suite records the S5e-1 run, which met users.user_custom_tab; S5e-3
    // (scripts/uiCustomS5e3DropCustomTab.js) drops it, so put it back where it stood
    const [[has]] = await pool.query("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() " +
      "AND TABLE_NAME = 'users' AND COLUMN_NAME = 'user_custom_tab'");
    if (!Number(has.n)) await q('ALTER TABLE `users` ADD COLUMN `user_custom_tab` json NOT NULL AFTER `reset_expires`');
    // the shipped record IS the expected state; a copy with an {$unknown} value for the refusal
    RECORD_OK = S.RECORD_FILE;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's5e1-'));
    const rec = JSON.parse(fs.readFileSync(S.RECORD_FILE, 'utf8'));
    expect(rec.users.find((u) => u.user === 5).user_custom_tab.loadFunc).toBe(PRANK);
    rec.users.find((u) => u.user === 5).user_custom_tab.loadFunc = { $unknown: 'paste it from CHECK' };
    UNKNOWN = path.join(tmp, 'record-unknown.json');
    fs.writeFileSync(UNKNOWN, JSON.stringify(rec));
  });
  afterAll(async () => {
    if (conn) await conn.end().catch(() => {});
    if (pool) await pool.end();
  });

  async function seed() {
    for (const t of ['ui_config_versions', 'ui_config', 'entitlement_denies', 'users']) await q(`DELETE FROM \`${t}\``);
    const rec = S.loadRecord(RECORD_OK);
    // users.user is AUTO_INCREMENT: a 0 needs NO_AUTO_VALUE_ON_ZERO (the live row 0 exists) — this one seeding connection only
    const sc = await pool.getConnection();
    await sc.query(`SET SESSION sql_mode = '${LIVE_MODE},NO_AUTO_VALUE_ON_ZERO'`);
    for (const [uid, name, roles] of USERS) {
      const ct = rec.get(uid).ct;
      await sc.query('INSERT INTO users (username, user_name, user_fname, user_lname, user_initials, user_auth, `user`, ringcentral, user_custom_tab, roles) ' +
        "VALUES (?, ?, ?, 'x', 'XX', 'authorized', ?, 0, ?, ?)", [name.toLowerCase(), name, name, uid, JSON.stringify(ct === null ? null : ct), roles]);
    }
    await sc.query(`SET SESSION sql_mode = '${LIVE_MODE}'`);
    sc.release();
    const row = (scope, uid, key, doc) => q("INSERT INTO ui_config (scope, user_id, role, config_key, config, updated_by, updated_at) VALUES (?, ?, '', ?, ?, ?, '2026-10-01 00:00:00')",
      [scope, uid, key, JSON.stringify(doc), uid]);
    await row('firm', 0, 'registry_overrides', FIRM);
    await row('user', 6, 'items', FRED_ITEMS);
    await row('user', 6, 'layout', FRED_LAYOUT);
    await row('user', 6, 'prefs', { theme: { mode: 'dark' } });
    await row('user', 6, 'shortcuts', { bindings: [{ combo: { ctrl: true, meta: false, alt: true, shift: false, key: 'c' }, id: 'user:call-review' }] });
    await q("INSERT INTO entitlement_denies (scope, scope_ref, item_key, created_by) VALUES ('user', '22', 'pipeline', 6), ('role', 'attorney', 'bills', 6)");
  }
  async function snapshot() {
    return {
      users: await q('SELECT `user`, CAST(user_custom_tab AS CHAR) AS ct, JSON_TYPE(user_custom_tab) AS jt, user_custom_tab IS NULL AS sqlnull FROM users ORDER BY `user`'),
      rows: await q('SELECT id, scope, user_id, role, config_key, CAST(config AS CHAR) AS c, updated_by, updated_at FROM ui_config ORDER BY id'),
      versions: (await q('SELECT COUNT(*) n FROM ui_config_versions'))[0].n,
    };
  }
  async function go(apply, { record = RECORD_OK, hooks, mode = LIVE_MODE } = {}) {
    if (conn) await conn.end().catch(() => {});
    conn = await mysql.createConnection({ uri: URL_, timezone: 'Z' });
    await conn.query(`SET SESSION sql_mode = '${mode}'`);
    const lines = [];
    const r = await S.run(conn, { apply, log: (s) => lines.push(s), recordFile: record, hooks });
    return { ...r, out: lines.join('\n') };
  }
  const userRows = async (uid) => {
    const out = {};
    for (const r of await q("SELECT config_key, config FROM ui_config WHERE scope = 'user' AND user_id = ?", [uid])) out[r.config_key] = r.config;
    return out;
  };
  const ctOf = async (uid) => (await q('SELECT user_custom_tab AS ct, JSON_TYPE(user_custom_tab) AS jt, user_custom_tab IS NULL AS n FROM users WHERE `user` = ?', [uid]))[0];

  test('the session runs the live sql_mode (no STRICT, no ONLY_FULL_GROUP_BY)', async () => {
    const [[m]] = await pool.query('SELECT @@SESSION.sql_mode m');
    expect(m.m).toBe(LIVE_MODE);
  });

  test('a record value held as {$unknown}: NO-GO until it is pasted in — nothing written, the live value printed', async () => {
    await seed();
    const before = await snapshot();
    for (const apply of [false, true]) {
      const r = await go(apply, { record: UNKNOWN });
      expect(r.ok).toBe(false);
      expect(r.line).toBe('NO-GO — 1 problem(s) above. Nothing was changed.');
      expect(r.out).toContain('  - user 5 (Shoshana) is neither as recorded nor in the end state: the record does not hold the exact prior user_custom_tab.loadFunc: paste it from PRIOR VALUES (user 5)');
      expect(r.out).toContain(JSON.stringify(PRANK));
    }
    expect(await snapshot()).toEqual(before);
  });

  test('CHECK writes nothing and says GO, printing the plan', async () => {
    await seed();
    const before = await snapshot();
    const r = await go(false);
    if (process.env.S5E_CHECK_OUT) fs.writeFileSync(process.env.S5E_CHECK_OUT, r.out + '\n');
    expect([r.ok, r.line]).toEqual([true, 'CHECK OK — GO. 6 user(s) to convert (0, 1, 3, 5, 6, 22). Next: node scripts/uiCustomS5eCustomTabsToButtons.js --apply']);
    expect(r.out).toContain('      items := {"items":[{"id":"user:call-review","label":"Call Review","icon":"headset","action":{"type":"tool","key":"call-review","present":"tab"}}]}');
    expect(r.out).toContain('the custom slot → Home moreManuals, sidebar moreManuals — identical otherwise (verified)');
    expect(r.out).toContain('the custom slot → Home user:call-review, sidebar (gone) — identical otherwise (verified)');
    expect(r.out).toMatch(/user 1 \(Stuart\) had no stored layout: from now on a "customized" user/);
    expect(await snapshot()).toEqual(before);
  });

  test('--apply reaches the end state; a second --apply is a no-op GO', async () => {
    await seed();
    const before = await snapshot();
    const r = await go(true);
    expect([r.ok, r.done]).toEqual([true, [0, 1, 3, 5, 6, 22]]);
    expect(r.line).toBe('S5e-1 APPLIED — GO. Converted this run: 0, 1, 3, 5, 6, 22; no user has a custom tab. Nothing else to run.');
    // user_custom_tab: the JSON null scalar for the six, untouched for 2 / 4 / 23
    for (const uid of [0, 1, 3, 5, 6, 22, 2, 4, 23]) expect([uid, await ctOf(uid)]).toEqual([uid, { ct: null, jt: 'NULL', n: 0 }]);
    // the documents: exactly the planner's, from the record's state
    const rec = S.loadRecord(RECORD_OK);
    const firm = (await svc.readFor(pool, null)).firm;
    const env = (uid, roles, denied) => ({ firm, denied, roles, isAdmin: roles.includes('su'), locked: ['cases'] });
    const want = {
      1: S.planUser(1, { ct: rec.get(1).ct, rows: {} }, env(1, ['admin', 'staff', 'attorney'], ['bills'])),
      3: S.planUser(3, { ct: rec.get(3).ct, rows: {} }, env(3, ['staff'], [])),
      5: S.planUser(5, { ct: rec.get(5).ct, rows: {} }, env(5, ['staff'], [])),
      22: S.planUser(22, { ct: rec.get(22).ct, rows: {} }, env(22, ['staff'], ['pipeline'])),
    };
    for (const uid of [1, 3, 5, 22]) {
      const got = await userRows(uid), w = {};
      for (const x of want[uid].writes) w[x.config_key] = x.config;
      expect([uid, got]).toEqual([uid, w]);
    }
    expect(Object.keys(await userRows(1))).toEqual(expect.arrayContaining(['items', 'layout']));
    expect((await userRows(1)).layout.placed.sidebar.map((e) => e.item || e.label)).not.toContain('bills');   // Stuart's attorney deny
    expect((await userRows(22)).layout.placed.home.map((e) => e.item)).not.toContain('pipeline');          // Rena's own deny
    expect((await userRows(5)).layout.placed.sidebar).toContainEqual({ item: 'moreManuals' });
    expect(await userRows(0)).toEqual({});
    // Fred: ONE entry swapped in his layout; his other rows byte-identical (updated_at too)
    expect((await userRows(6)).layout).toEqual({ ...FRED_LAYOUT, placed: { home: FRED_LAYOUT.placed.home.map((e) => (e.item === 'custom' ? { item: 'user:call-review' } : e)) } });
    const after = await snapshot();
    const keep = (s) => s.rows.filter((x) => !(x.user_id === 6 && x.config_key === 'layout') && x.user_id !== 1 && x.user_id !== 3 && x.user_id !== 5 && x.user_id !== 22);
    expect(keep(after)).toEqual(keep(before));                                  // firm row + Fred's items / prefs / shortcuts
    expect(after.rows.filter((x) => [1, 3, 5, 22].includes(x.user_id)).every((x) => x.updated_by === x.user_id)).toBe(true);
    expect(after.versions).toBe(0);
    // again: nothing to do
    const r2 = await go(true);
    expect([r2.ok, r2.line]).toEqual([true, 'ALREADY APPLIED — every custom tab is in the launcher and cleared. GO: nothing to run.']);
    expect(await snapshot()).toEqual(after);
    // and an edit since (Stuart moves a tile) is DRIFT, not "done": nothing written
    await svc.write(pool, { scope: 'user', config_key: 'layout', config: { placed: { home: [{ item: 'contacts' }] }, removed: {} } }, { type: 'jwt', userId: 1 });
    const edited = await snapshot();
    const r3 = await go(false);
    expect(r3.ok).toBe(false);
    expect(r3.out).toMatch(/user 1 \(Stuart\) is neither as recorded nor in the end state: .*\[not the end state either: its layout is not the document this script writes\]/);
    expect(await snapshot()).toEqual(edited);
  });

  test('the clear is the JSON null scalar itself: it works under a STRICT session too (SET … = NULL would be ERROR 1048 there)', async () => {
    await seed();
    const r = await go(true, { mode: 'STRICT_TRANS_TABLES' });
    expect([r.ok, r.done]).toEqual([true, [0, 1, 3, 5, 6, 22]]);
    for (const uid of [0, 1, 3, 5, 6, 22]) expect(await ctOf(uid)).toEqual({ ct: null, jt: 'NULL', n: 0 });
  });

  test('a run killed after a user commits resumes from there', async () => {
    await seed();
    const r = await go(true, { hooks: { afterCommit: (uid) => { if (uid === 3) throw new Error('killed'); } } });
    expect(r.ok).toBe(false);
    expect(r.line).toBe('NO-GO — stopped at user 3 (rolled back); done this run: 0, 1, 3. Re-running node scripts/uiCustomS5eCustomTabsToButtons.js --apply resumes.');
    for (const uid of [0, 1, 3]) expect((await ctOf(uid)).jt).toBe('NULL');
    for (const uid of [5, 6, 22]) expect((await ctOf(uid)).jt).toBe('OBJECT');
    expect(await userRows(5)).toEqual({});
    const c = await go(false);
    expect(c.line).toBe('CHECK OK — GO. 3 user(s) to convert (5, 6, 22). Next: node scripts/uiCustomS5eCustomTabsToButtons.js --apply');
    expect(c.out).toMatch(/user 1 Stuart \[admin,staff,attorney\]: ALREADY DONE — skipped/);
    const r2 = await go(true);
    expect([r2.ok, r2.done]).toEqual([true, [5, 6, 22]]);
  });

  test('a failure before a user\'s commit rolls that user back whole; the rerun finishes', async () => {
    await seed();
    const r = await go(true, { hooks: { beforeCommit: (uid) => { if (uid === 5) throw new Error('boom before commit'); } } });
    expect(r.ok).toBe(false);
    expect(r.out).toContain('  ✗ boom before commit');
    expect(r.line).toMatch(/^NO-GO — stopped at user 5 \(rolled back\); done this run: 0, 1, 3\./);
    expect(await ctOf(5)).toMatchObject({ jt: 'OBJECT' });
    expect(await userRows(5)).toEqual({});                                     // its layout write was rolled back with it
    expect((await go(true)).done).toEqual([5, 6, 22]);
  });

  test.each([
    ['Stuart\'s title changed', 'UPDATE users SET user_custom_tab = JSON_SET(user_custom_tab, \'$.title\', \'Calls\') WHERE `user` = 1', /user 1 \(Stuart\) is neither as recorded nor in the end state: user_custom_tab\.title differs from the record/],
    ['Fred\'s custom moved off log', null, /user 6 \(Fred\) is neither as recorded nor in the end state: placed\.home's custom is not right after \{item:'log'\}/],
    ['Rena got a layout', "INSERT INTO ui_config (scope, user_id, role, config_key, config) VALUES ('user', 22, '', 'layout', '{\"placed\":{},\"removed\":{}}')", /user 22 \(Rena\) is neither as recorded nor in the end state: ui_config rows are \[layout\], the record says \[\]/],
    ['user 2 made a custom tab', "UPDATE users SET user_custom_tab = '{\"src\":\"/x.html\"}' WHERE `user` = 2", /user 2 \(Two\) is neither as recorded nor in the end state: user_custom_tab differs from the record/],
    ['a user the record does not know', "INSERT INTO users (username, user_name, user_fname, user_lname, user_initials, user_auth, `user`, ringcentral, user_custom_tab) VALUES ('n', 'New', 'N', 'x', 'NN', 'authorized', 30, 0, '{\"src\":\"/y.html\"}')", /user 30 \(New\) has a custom tab the record does not know/],
    ['the firm hid the custom tab', "UPDATE ui_config SET config = JSON_SET(config, '$.hidden', JSON_ARRAY('custom')) WHERE scope = 'firm'", /user 1: the editor put user:call-review in the custom slot on \[\]/],
  ])('drift → NO-GO with zero writes (CHECK and --apply): %s', async (_n, sql, msg) => {
    await seed();
    if (sql) await q(sql);
    else {
      const lay = J(FRED_LAYOUT);
      lay.placed.home.splice(4, 1);
      await q("UPDATE ui_config SET config = ? WHERE scope = 'user' AND user_id = 6 AND config_key = 'layout'", [JSON.stringify(lay)]);
    }
    const before = await snapshot();
    for (const apply of [false, true]) {
      const r = await go(apply);
      expect([apply, r.ok]).toEqual([apply, false]);
      expect(r.out).toMatch(msg);
      expect(r.line).toMatch(/^NO-GO — \d+ problem\(s\) above\. Nothing was changed\.$/);
    }
    expect(await snapshot()).toEqual(before);
  });
});
