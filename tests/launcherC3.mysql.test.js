// tests/launcherC3.mysql.test.js
//
/**
 * launcher-nits C3 on REAL MySQL — scripts/launcherC3MoreAdminPages.js run()
 * end to end on one connection, against tables cloned from ref/database.sql.
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3397/yc_c3_test npx jest tests/launcherC3.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates users,
 * ui_config, ui_config_versions, entitlement_denies and rw_scratch in it. The
 * session runs the live sql_mode (NO_ZERO_IN_DATE,NO_ZERO_DATE,
 * ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION), UTC.
 *   - CHECK writes nothing and says GO with the digest;
 *   - --apply with a wrong digest is a NO-GO with zero writes (no backup either);
 *   - --apply backs up FIRST (rw_scratch fred/launcher_c3_backup_<digest>, read
 *     back = every overwritten row as it was), then writes the planned
 *     documents in one transaction (firm rows versioned, saved_by 6; user rows
 *     updated_by the user), and the end state verifies;
 *   - a second run is a no-op GO;
 *   - a row changed between the backup and the lock → ROLLBACK, NO-GO, nothing
 *     written but the backup.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const C3 = require('../scripts/launcherC3MoreAdminPages');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const ROOT = path.join(__dirname, '..');
const LIVE_MODE = 'NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
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

const MORE = C3.loadCore().LAY.more.filter((e) => e.item).map((e) => e.item);
const SEED = [
  ['firm', 0, 'registry_overrides', { items: [{ id: 'firm:get-clio-code', icon: 'c', label: 'Get Clio Code', action: { key: 'clio-code', size: 'compact', type: 'tool', present: 'modal' } }],
    hidden: [], locked: [], renames: {}, retired: ['firm:clio-code-v2'], visible_to: { admin: ['it', 'admin'] } }],
  ['firm', 0, 'layout', { placed: { more: [...MORE.filter((k) => k !== 'moreAssistant').map((item) => ({ item })), { item: 'firm:get-clio-code' }] }, removed: { more: ['moreAssistant'] } }],
  ['user', 1, 'layout', { placed: { home: [{ item: 'cases' }, { item: 'moreFeatures' }], sidebar: [{ label: 'Records' }, { item: 'cases' }, { label: 'Settings' }, { item: 'moreFeatures' }, { item: 'helpSupport' }] }, removed: {} }],
  ['user', 6, 'shortcuts', { bindings: [{ id: 'admin', combo: { alt: false, key: 'x', ctrl: true, meta: true, shift: false } }] }],
  ['user', 2, 'prefs', { theme: { mode: 'dark' } }],   // a row the script never touches
];
const USERS = [[0, 'automation'], [1, 'admin,staff,attorney'], [2, 'staff'], [6, 'it,admin,form_dev,su']];

d('launcher-nits C3 on real MySQL', () => {
  let conn, other;
  const quiet = () => {};
  async function reset() {
    const u = new URL(URL_);
    const name = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(name)) throw new Error('YC_TEST_MYSQL_URL: the database name must end in _test');
    const ddl = fs.readFileSync(path.join(ROOT, 'ref/database.sql'), 'utf8');
    await conn.query("SET SESSION sql_mode='NO_AUTO_VALUE_ON_ZERO," + LIVE_MODE + "', foreign_key_checks=0");
    const TABLES = ['users', 'ui_config', 'ui_config_versions', 'entitlement_denies', 'rw_scratch'];
    // drop every one first, children first: re-creating ui_config while an old ui_config_versions
    // still references it fails its foreign key (MySQL 8.4 checks the referenced key)
    for (const t of [...TABLES].reverse()) await conn.query('DROP TABLE IF EXISTS `' + t + '`');
    for (const t of TABLES) for (const s of cloneDdl(ddl, t)) await conn.query(s);
    for (const [uid, roles] of USERS) await conn.query('INSERT INTO users (`user`, roles) VALUES (?, ?)', [uid, roles]);
    for (const [scope, uid, key, config] of SEED) {
      await conn.query("INSERT INTO ui_config (scope, user_id, role, config_key, config, updated_by) VALUES (?, ?, '', ?, ?, ?)", [scope, uid, key, JSON.stringify(config), uid || 6]);
    }
    await conn.query("SET SESSION sql_mode='" + LIVE_MODE + "', foreign_key_checks=1");
  }
  const snapshot = async () => {
    const [ui] = await conn.query('SELECT id, scope, user_id, config_key, config, updated_by, updated_at FROM ui_config ORDER BY id');
    const [v] = await conn.query('SELECT COUNT(*) n FROM ui_config_versions');
    const [s] = await conn.query('SELECT COUNT(*) n FROM rw_scratch');
    return { ui: J(ui), versions: v[0].n, scratch: s[0].n };
  };

  beforeAll(async () => {
    conn = await mysql.createConnection({ uri: URL_, timezone: 'Z' });
    other = await mysql.createConnection({ uri: URL_, timezone: 'Z' });
    await conn.query("SET time_zone = '+00:00'");
  });
  afterAll(async () => { if (conn) await conn.end(); if (other) await other.end(); });
  beforeEach(reset);

  test('CHECK writes nothing; a wrong digest writes nothing; --apply backs up first, writes, verifies; a second run is a no-op', async () => {
    const before = await snapshot();
    const chk = await C3.run(conn, { log: quiet });
    expect([chk.ok, chk.line]).toEqual([true, expect.stringMatching(/^GO — CHECK passed\. Next: .* --apply --expect=[0-9a-f]{16}$/)]);
    expect(chk.writes.map((w) => [w.scope, w.uid, w.key])).toEqual([['firm', 0, 'registry_overrides'], ['firm', 0, 'layout'], ['user', 1, 'layout'], ['user', 6, 'shortcuts']]);
    expect(await snapshot()).toEqual(before);
    const wrong = await C3.run(conn, { apply: true, expect: '0000000000000000', log: quiet });
    expect([wrong.ok, await snapshot()]).toEqual([false, before]);

    const ap = await C3.run(conn, { apply: true, expect: chk.digest, log: quiet });
    expect([ap.ok, ap.line]).toEqual([true, expect.stringMatching(/^GO — More and Admin are the firm's pages/)]);
    // the backup: every overwritten row as it was
    const [[b]] = await conn.query("SELECT v FROM rw_scratch WHERE ns = 'fred' AND k = ?", ['launcher_c3_backup_' + chk.digest]);
    const saved = JSON.parse(b.v);
    expect(saved.rows.map((r) => [r.scope, r.user_id, r.config_key])).toEqual([['firm', 0, 'registry_overrides'], ['firm', 0, 'layout'], ['user', 1, 'layout'], ['user', 6, 'shortcuts']]);
    for (const r of saved.rows) {
      const want = SEED.find(([s, u, k]) => s === r.scope && u === r.user_id && k === r.config_key)[3];
      expect([r.config_key, r.config]).toEqual([r.config_key, want]);
    }
    // the end state
    const [[ro]] = await conn.query("SELECT config FROM ui_config WHERE scope = 'firm' AND config_key = 'registry_overrides'");
    expect(ro.config.items.map((i) => i.id)).toEqual(['firm:get-clio-code', 'firm:more', 'firm:admin']);
    expect(ro.config.visible_to['firm:admin']).toEqual(['it', 'admin']);
    expect(ro.config.retired).toEqual(['firm:clio-code-v2']);
    const [vers] = await conn.query('SELECT config_key, saved_by FROM ui_config_versions ORDER BY id');
    expect(J(vers)).toEqual([{ config_key: 'registry_overrides', saved_by: 6 }, { config_key: 'layout', saved_by: 6 }]);
    const [[u1]] = await conn.query("SELECT config, updated_by FROM ui_config WHERE scope = 'user' AND user_id = 1 AND config_key = 'layout'");
    expect([u1.updated_by, u1.config.placed.sidebar.map((e) => e.item || '#' + e.label)]).toEqual([1, ['#Records', 'cases', '#Settings', 'firm:more', 'helpSupport']]);
    const [[sc]] = await conn.query("SELECT config FROM ui_config WHERE scope = 'user' AND user_id = 6 AND config_key = 'shortcuts'");
    expect(sc.config.bindings[0].id).toBe('firm:admin');
    const [[prefs]] = await conn.query("SELECT config, updated_at FROM ui_config WHERE scope = 'user' AND user_id = 2 AND config_key = 'prefs'");
    const was = before.ui.find((r) => r.user_id === 2);
    expect(J(prefs)).toEqual({ config: was.config, updated_at: was.updated_at });   // untouched, not even re-saved
    // again: nothing to do
    const after = await snapshot();
    const again = await C3.run(conn, { apply: true, expect: 'whatever', log: quiet });
    expect([again.ok, again.line, await snapshot()]).toEqual([true, expect.stringMatching(/^GO — nothing to write/), after]);
  });

  test('a row changed between the backup and the lock: ROLLBACK, NO-GO, only the backup written', async () => {
    const chk = await C3.run(conn, { log: quiet });
    // a connection that, right after the backup read-back, has someone else edit user 1's layout
    const sneaky = Object.create(conn);
    sneaky.query = async (...a) => {
      const r = await conn.query(...a);
      const sql = typeof a[0] === 'string' ? a[0] : a[0].sql;
      if (/^SELECT v FROM rw_scratch/.test(sql)) {
        await other.query("UPDATE ui_config SET config = JSON_SET(config, '$.removed.home', JSON_ARRAY('log')) WHERE scope = 'user' AND user_id = 1 AND config_key = 'layout'");
      }
      return r;
    };
    const before = await snapshot();
    const r = await C3.run(sneaky, { apply: true, expect: chk.digest, log: quiet });
    expect([r.ok, r.line]).toEqual([false, expect.stringMatching(/^NO-GO — rolled back, nothing written \(the backup stays\): the rows changed since the backup/)]);
    const now = await snapshot();
    expect([now.versions, now.scratch]).toEqual([0, 1]);
    // only user 1's row moved — by the other session, not by the script
    expect(now.ui.filter((x, i) => JSON.stringify(x) !== JSON.stringify(before.ui[i])).map((x) => [x.scope, x.user_id, x.config_key])).toEqual([['user', 1, 'layout']]);
  });
});
