/**
 * REAL-ENGINE test for the YisraMail C3a session-script migration
 * (scripts/yisramailC3Migrate.js) and its record
 * (ref/migrations/2026-11-04_yisramail_c3_email_designs.sql):
 *   R  the record file holds exactly the two statements the script runs (CREATE, ALTER), every
 *      column commented (≤ 1024 bytes), the table commented;
 *   C  CHECK on the pre-C3 schema → GO (next --apply), nothing changed, the row count printed;
 *   A  --apply creates email_designs exactly as the file says (columns, types, defaults, extras,
 *      collations, comments, keys) and adds campaigns.design_id; existing rows read NULL; the
 *      JSON column and an INSERT the service would make work; a second --apply is a no-op GO;
 *   P  a run that finds part of it done resumes with the rest (either half);
 *   D  drift (email_designs of another shape, an extra index, design_id of another type, an
 *      unexpected / missing campaigns column) is a NO-GO with nothing changed;
 *   V  an apply whose CREATE / ALTER silently does nothing is caught by the end-state check;
 *   S  the session settings hold on the connection after a run;
 *   L  with design_id present, the C1 and C2 CHECKs still say GO (their LATER_COLUMNS) — and
 *      the tolerance is exactly design_id.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_c3mig_test npx jest tests/yisramailC3Migrate.mysql.test.js --runInBand
 * Its OWN *_test DB (it drops and rebuilds campaigns / campaign_results / email_credentials /
 * app_settings / mailboxes and email_designs). THE PRE-C3 SCHEMA IS INDEPENDENT OF THE DUMP:
 * fresh() clones from ref/database.sql — which carries design_id once the migration has run live —
 * and strips it.
 */

'use strict';

const fs = require('fs');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const m = require('../scripts/yisramailC3Migrate');
const BUILT = ['campaigns', 'campaign_results', 'email_credentials', 'app_settings', 'mailboxes'];

describe('R: the record file is what the script runs', () => {
  test('exactly a CREATE TABLE IF NOT EXISTS email_designs and an ALTER TABLE campaigns; every column + the table commented', () => {
    const st = m.statements();
    expect(st).toHaveLength(2);
    expect(st[0]).toBe(m.createSql());
    expect(st[1]).toBe(m.alterSql());
    expect(m.alterSql()).toMatch(/^ALTER TABLE campaigns\n {2}ADD COLUMN design_id int unsigned NULL COMMENT '/);
    const fc = m.fileComments();
    expect(Object.keys(fc.columns)).toEqual(Object.keys(m.EXPECTED_COLUMNS));
    for (const c of [...Object.values(fc.columns), fc.design_id]) {
      expect(c.length).toBeGreaterThan(10);
      expect(Buffer.byteLength(c)).toBeLessThanOrEqual(1024);
    }
    expect(Buffer.byteLength(fc.table)).toBeLessThanOrEqual(2048);
    expect(fs.readFileSync(m.MIGRATION, 'utf8')).not.toMatch(/DEFAULT CHARSET=utf8mb4;/);   // SCHEMA_CONVENTIONS: never CHARSET without COLLATE
  });
});

maybe('the C3 migration on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const schema = require('./helpers/commsArchiveSchema');
  const c1 = require('../scripts/yisramailC1Migrate');
  const c2 = require('../scripts/yisramailC2Migrate');
  let pool, conn;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const lines = [];
  const quiet = { say: (l) => lines.push(l) };
  const colsOf = async (t) => (await q('SELECT COLUMN_NAME n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [t])).map((r) => r.n);
  const hasTable = async (t) => (await q('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]))[0].n > 0;
  const colDef = async (t, n) => (await q(`SELECT COLUMN_TYPE t, IS_NULLABLE nl, COLUMN_DEFAULT d, COLLATION_NAME c, COLUMN_COMMENT cm FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [t, n]))[0];

  async function fresh() {
    await q('DROP TABLE IF EXISTS email_designs');
    await schema.build(pool, BUILT);
    if ((await colsOf('campaigns')).includes('design_id')) await q('ALTER TABLE campaigns DROP COLUMN design_id');
    await q("INSERT INTO campaigns (campaign_id, type, sender, body, status, contact_count) VALUES (1, 'email', 'a@x.test', 'b', 'sent', 2)");
    lines.length = 0;
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (c) => { c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`); });
  });
  afterAll(async () => {
    if (conn) conn.release();
    for (const t of [...BUILT, 'email_designs']) await q(`DROP TABLE IF EXISTS ${t}`);
    await pool.end();
  });
  beforeEach(async () => { if (conn) conn.release(); await fresh(); conn = await pool.getConnection(); });

  test('C: CHECK on the pre-C3 schema → GO, next --apply; nothing changed; the row count printed', async () => {
    expect(await colsOf('campaigns')).toEqual(m.CAMPAIGNS_BASE);
    const r = await m.run(conn, quiet);
    expect(r).toEqual({ ok: true, created: false, altered: false, line: 'CHECK OK — GO. Next: node scripts/yisramailC3Migrate.js --apply' });
    expect(lines).toEqual(expect.arrayContaining(['campaigns: 1 row(s)', 'email_designs: absent — to do: create', 'campaigns: C3 work to do: design_id']));
    expect(await colsOf('campaigns')).toEqual(m.CAMPAIGNS_BASE);
    expect(await hasTable('email_designs')).toBe(false);
  });

  test('A: --apply → the table and the column exactly as the file says; old rows NULL; the service\'s INSERT works; re-run no-op GO', async () => {
    const r = await m.run(conn, { ...quiet, apply: true });
    expect(r).toEqual({ ok: true, created: true, altered: true, line: 'APPLIED — C3 schema verified. GO. Next: the backend deploy.' });
    expect(await m.tableProblems(conn)).toEqual([]);
    expect(await colsOf('email_designs')).toEqual(Object.keys(m.EXPECTED_COLUMNS));
    expect(await colsOf('campaigns')).toEqual([...m.CAMPAIGNS_BASE, 'design_id']);
    expect(await colDef('campaigns', 'design_id')).toEqual({ t: 'int unsigned', nl: 'YES', d: null, c: null, cm: m.fileComments().design_id });
    expect(await q('SELECT design_id FROM campaigns')).toEqual([{ design_id: null }]);
    const [[t]] = await conn.query("SELECT TABLE_COLLATION c, ENGINE e FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'email_designs'");
    expect(t).toEqual({ c: 'utf8mb4_general_ci', e: 'InnoDB' });
    // the defaults the service relies on
    await q("INSERT INTO email_designs (name, builder, design_json, html, text, created_by) VALUES ('n', 'grapesjs-mjml', '{\"b\":1,\"a\":[2]}', '<p>h</p>', 't', 6)");
    const [row] = await q('SELECT * FROM email_designs');
    expect(row).toMatchObject({ id: 1, builder: 'grapesjs-mjml', design_json: { a: [2], b: 1 }, archived: 0, thumbnail_asset_id: null, created_by: 6 });
    expect(row.created_at).toBeInstanceOf(Date);
    const again = await m.run(conn, { ...quiet, apply: true });
    expect(again).toEqual({ ok: true, created: false, altered: false, line: 'ALREADY IN PLACE — C3 schema verified. GO. Next: the backend deploy.' });
    expect((await m.run(conn, quiet)).line).toBe('CHECK OK — the C3 schema is in place as expected. GO (nothing to apply; next: the backend deploy).');
    expect(lines).toContain('email_designs: present, 1 row(s)');
  });

  test('P: either half done → --apply does only the rest', async () => {
    await q(m.createSql());
    let r = await m.run(conn, { ...quiet, apply: true });
    expect(r).toMatchObject({ ok: true, created: false, altered: true });
    expect(lines).toContain('  ✓ campaigns: design_id');
    await fresh();
    await q(m.alterSql());
    r = await m.run(conn, { ...quiet, apply: true });
    expect(r).toMatchObject({ ok: true, created: true, altered: false });
    expect(lines).toContain('  ✓ created email_designs');
  });

  test('D: drift → NO-GO, nothing changed', async () => {
    const cases = [
      ['email_designs of another shape', m.createSql().replace('name               varchar(255)', 'name               varchar(100)'), /name is varchar\(100\)/],
      ['email_designs with another comment', m.createSql().replace("COMMENT 'UTC create time'", "COMMENT 'x'"), /created_at comment differs/],
      ['email_designs with an extra index', `${m.createSql()}`, /unexpected index ix_name/, 'ALTER TABLE email_designs ADD KEY ix_name (name)'],
      ['design_id of another type', 'ALTER TABLE campaigns ADD COLUMN design_id bigint NULL', /design_id is bigint/],
      ['an unexpected campaigns column', 'ALTER TABLE campaigns ADD COLUMN extra int NULL', /unexpected column extra/],
      ['a missing base column', 'ALTER TABLE campaigns DROP COLUMN send_snapshot', /pre-C3 column send_snapshot is missing/],
    ];
    for (const [, sql, problem, extra] of cases) {
      await fresh();
      await q(sql);
      if (extra) await q(extra);
      const before = { c: await colsOf('campaigns'), t: await hasTable('email_designs') ? await colsOf('email_designs') : null };
      for (const apply of [false, true]) {
        lines.length = 0;
        const r = await m.run(conn, { ...quiet, apply });
        expect(r).toEqual({ ok: false, created: false, altered: false, line: 'NO-GO — the database is not in a state this script expects (above). Nothing was changed.' });
        expect(lines.some((l) => problem.test(l))).toBe(true);
      }
      expect({ c: await colsOf('campaigns'), t: await hasTable('email_designs') ? await colsOf('email_designs') : null }).toEqual(before);
    }
  });

  test('V: an apply whose CREATE / ALTER silently does nothing → the end-state check says NO-GO (does not verify)', async () => {
    const swallow = (re) => ({ query: (sql, p) => (re.test(String(sql).trimStart()) ? Promise.resolve([{}]) : conn.query(sql, p)) });
    for (const [re, missing] of [[/^(CREATE|ALTER) TABLE/, /email_designs still absent/], [/^CREATE TABLE/, /email_designs still absent/], [/^ALTER TABLE/, /design_id still missing/]]) {
      await fresh();
      lines.length = 0;
      const r = await m.run(swallow(re), { ...quiet, apply: true });
      expect(r.ok).toBe(false);
      expect(r.line).toBe('NO-GO — the result does not verify (above). Paste this output to Claude; do not deploy.');
      expect(lines.some((l) => missing.test(l))).toBe(true);
    }
  });

  test('S: the session settings hold after a run', async () => {
    await m.run(conn, quiet);
    const [[s]] = await conn.query('SELECT @@session.lock_wait_timeout AS lw, @@session.time_zone AS tz');
    expect(s).toEqual({ lw: 10, tz: '+00:00' });
  });

  test('L: with design_id in place, the C1 and C2 CHECKs still say GO; the tolerance is exactly design_id', async () => {
    expect((await m.run(conn, { ...quiet, apply: true })).ok).toBe(true);
    expect((await c1.run(conn, { say: () => {} })).ok).toBe(true);
    expect((await c2.run(conn, { say: () => {} })).ok).toBe(true);
    await q('ALTER TABLE campaigns ADD COLUMN not_later int NULL');
    expect((await c1.run(conn, { say: () => {} })).ok).toBe(false);
    expect((await c2.run(conn, { say: () => {} })).ok).toBe(false);
  });
});
