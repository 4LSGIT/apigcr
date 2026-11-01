// tests/launcherL5.migration.mysql.test.js
//
/**
 * launcher-nits L5 — scripts/launcherL5ToolsVisibleTo.js, the migration that
 * adds tools.visible_to.
 *
 * The first block is pure and runs everywhere: the file holds one INSTANT ALTER
 * and the script's shape check names every way the table can be wrong.
 *
 * ── THE SECOND BLOCK IS GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3391/yc_l5_test npx jest tests/launcherL5.migration.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates `tools`.
 *
 * WHAT IS LOCKED ON THE ENGINE
 *   - CHECK writes nothing, and says GO with the next command;
 *   - --apply adds the column to live-shaped rows without touching them (no
 *     html, no updated_at), every tool NULL, and the COMMENT from the file;
 *   - a re-run does nothing and says so, and leaves a restriction a superuser
 *     has since set alone;
 *   - the probe's list is rolled back, updated_at with it;
 *   - a table of any other shape is NO-GO, unchanged;
 *   - an ALTER behind an open transaction gives up in seconds, never queues.
 */
'use strict';

const mysql = require('mysql2/promise');
const script = require('../scripts/launcherL5ToolsVisibleTo');

const { run, statements, expectedComment, shapeProblems, BASE_COLUMNS, COLUMN } = script;

const col = (over) => ({ name: COLUMN, type: 'json', nullable: 'YES', def: null, comment: expectedComment(), ...over });
const base = () => BASE_COLUMNS.map((name) => ({ name, type: 'x', nullable: 'NO', def: null, comment: '' }));

describe('the migration file', () => {
  test('one statement: an INSTANT ALTER that can never rebuild the table', () => {
    const s = statements();
    expect(s).toHaveLength(1);
    expect(s[0]).toMatch(/^ALTER TABLE tools\s+ADD COLUMN visible_to json NULL DEFAULT NULL COMMENT '/);
    expect(s[0]).toMatch(/ALGORITHM=INSTANT$/);
  });

  test('the COMMENT states the rule, including that it is visibility only', () => {
    expect(expectedComment()).toMatch(/NULL = everyone/);
    expect(expectedComment()).toMatch(/firm\.settings/);
    expect(expectedComment()).toMatch(/never security/);
    expect(expectedComment().length).toBeLessThanOrEqual(1024);   // MySQL's limit on a column comment
  });
});

describe('shapeProblems', () => {
  test('the expected shapes are clean, with and without the column', () => {
    expect(shapeProblems(base())).toEqual([]);
    expect(shapeProblems([...base(), col()])).toEqual([]);
  });

  test.each([
    ['a wrong type', { type: 'varchar' }, /is varchar, expected json/],
    ['NOT NULL', { nullable: 'NO' }, /IS_NULLABLE NO/],
    ['a default', { def: '[]' }, /default \[\], expected NULL/],
    ['another comment', { comment: 'stale' }, /COMMENT differs/],
  ])('%s is a problem', (_label, over, re) => {
    expect(shapeProblems([...base(), col(over)]).join('\n')).toMatch(re);
  });

  test('a missing base column and an unknown column are problems', () => {
    expect(shapeProblems(base().slice(1)).join('\n')).toMatch(/column id is missing/);
    expect(shapeProblems([...base(), { name: 'owner' }]).join('\n')).toMatch(/unexpected column owner/);
  });
});

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;

d('on real MySQL', () => {
  let conn;
  const q = async (sql, p) => (await conn.query(sql, p))[0];
  const quiet = () => {};
  const STAMP = '2026-09-11 14:06:17';

  // The live DDL (SHOW CREATE TABLE, 2026-11-01).
  async function rebuild() {
    await q('DROP TABLE IF EXISTS tools');
    await q(`CREATE TABLE tools (
      id int NOT NULL AUTO_INCREMENT,
      tool_key varchar(80) NOT NULL,
      title varchar(200) NOT NULL DEFAULT '',
      status enum('draft','live') NOT NULL DEFAULT 'draft',
      html mediumtext NOT NULL,
      updated_by varchar(100) DEFAULT NULL,
      created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY tool_key (tool_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`INSERT INTO tools (tool_key, title, status, html, updated_at) VALUES
      ('appt-form', 'Appt Form', 'live', '<p>a</p>', ?), ('carve', 'Carve', 'draft', '<p>b</p>', ?)`, [STAMP, STAMP]);
  }
  const columns = async () => (await q(
    "SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tools' ORDER BY ORDINAL_POSITION")).map((r) => r.n);

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    conn = await mysql.createConnection({ uri: URL_, timezone: 'Z' });
  });
  afterAll(async () => { if (conn) await conn.end(); });
  beforeEach(rebuild);

  test('CHECK writes nothing and names the next command', async () => {
    const r = await run(conn, { say: quiet });
    expect(r).toMatchObject({ ok: true, altered: false });
    expect(r.line).toBe('CHECK OK — GO. Next: node scripts/launcherL5ToolsVisibleTo.js --apply');
    expect(await columns()).not.toContain(COLUMN);
  });

  test('--apply adds the column after status and touches no row', async () => {
    const r = await run(conn, { apply: true, say: quiet });
    expect(r).toMatchObject({ ok: true, altered: true });
    expect(r.line).toMatch(/^ADDED — tools\.visible_to verified\. GO\./);
    expect(await columns()).toEqual(['id', 'tool_key', 'title', 'status', 'visible_to', 'html', 'updated_by', 'created_at', 'updated_at']);
    const rows = await q("SELECT visible_to, html, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS at FROM tools ORDER BY id");
    expect(rows).toEqual([
      { visible_to: null, html: '<p>a</p>', at: STAMP },
      { visible_to: null, html: '<p>b</p>', at: STAMP },
    ]);
    const [c] = await q("SELECT COLUMN_COMMENT AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tools' AND COLUMN_NAME = 'visible_to'");
    expect(c.c).toBe(expectedComment());
  });

  test('re-running does nothing and leaves a restriction alone', async () => {
    await run(conn, { apply: true, say: quiet });
    await q("UPDATE tools SET visible_to = '[\"staff\"]' WHERE tool_key = 'carve'");
    const check = await run(conn, { say: quiet });
    expect(check.line).toMatch(/^CHECK OK — tools\.visible_to is in place/);
    const again = await run(conn, { apply: true, say: quiet });
    expect(again).toMatchObject({ ok: true, altered: false });
    expect(again.line).toMatch(/^ALREADY IN PLACE/);
    expect((await q("SELECT visible_to FROM tools WHERE tool_key = 'carve'"))[0].visible_to).toEqual(['staff']);
  });

  test('the round-trip probe reads a list and rolls back', async () => {
    await run(conn, { apply: true, say: quiet });
    await q('UPDATE tools SET updated_at = ?', [STAMP]);
    expect(await script.roundTripProbe(conn)).toBeNull();
    const [row] = await q("SELECT visible_to, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS at FROM tools WHERE tool_key = 'appt-form'");
    expect(row).toEqual({ visible_to: null, at: STAMP });
  });

  test('the probe reports a column that does not read back as a list', async () => {
    await q('ALTER TABLE tools ADD COLUMN visible_to varchar(50) NULL');
    expect(await script.roundTripProbe(conn)).toMatch(/read back as .*\(string\)/);
  });

  test('a table of another shape is NO-GO and unchanged', async () => {
    await q('ALTER TABLE tools ADD COLUMN owner varchar(20) NULL');
    const before = await columns();
    const r = await run(conn, { apply: true, say: quiet });
    expect(r).toMatchObject({ ok: false, altered: false });
    expect(r.line).toMatch(/^NO-GO — tools has another shape/);
    expect(await columns()).toEqual(before);
  });

  test('a visible_to of another type is NO-GO and unchanged', async () => {
    await q('ALTER TABLE tools ADD COLUMN visible_to varchar(50) NULL');
    const r = await run(conn, { apply: true, say: quiet });
    expect(r).toMatchObject({ ok: false, altered: false });
    expect((await q("SELECT DATA_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tools' AND COLUMN_NAME = 'visible_to'"))[0].t).toBe('varchar');
  });

  test('behind an open transaction the ALTER gives up within seconds', async () => {
    const other = await mysql.createConnection({ uri: URL_, timezone: 'Z' });
    try {
      await other.beginTransaction();
      await other.query('SELECT id FROM tools LIMIT 1');   // holds the shared metadata lock
      const t0 = Date.now();
      await expect(run(conn, { apply: true, say: quiet })).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' });
      expect(Date.now() - t0).toBeLessThan(8000);
      await other.rollback();
      expect(await columns()).not.toContain(COLUMN);
    } finally {
      await other.end();
    }
  }, 15000);
});
