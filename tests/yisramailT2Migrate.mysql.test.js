/**
 * REAL-ENGINE test for the YisraMail T2 session-script migration
 * (scripts/yisramailT2Migrate.js) and its record
 * (ref/migrations/2026-11-02_yisramail_t2_campaign_results_delivery.sql):
 *   R  the record file's ALTER is exactly what the script runs with everything missing;
 *   C  CHECK on the pre-T2 table → GO (next --apply), nothing changed, the row count printed;
 *   A  --apply adds the six columns + the index, verified on the engine; existing rows read
 *      'unknown' / NULL; a second --apply is a no-op GO;
 *   P  a run that finds part of it done resumes with the rest;
 *   D  drift (a column of another definition, a foreign index of the same name, an unexpected
 *      column) is a NO-GO with nothing changed;
 *   S  the session settings hold on the connection after a run.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_t2mig_test npx jest tests/yisramailT2Migrate.mysql.test.js --runInBand
 * THE PRE-T2 TABLE IS INDEPENDENT OF THE DUMP: fresh() clones campaign_results
 * from ref/database.sql, which carries the T2 columns once the migration has run
 * live and the landing hook regenerated it — so fresh() drops any T2 column and
 * the index after the clone (the T1 r2 lesson).
 */

'use strict';

const fs = require('fs');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const m = require('../scripts/yisramailT2Migrate');
const ALL = Object.keys(m.EXPECTED_COLUMNS);

describe('R: the record file is what the script runs', () => {
  test('the file\'s ALTER = alterSql(all, index), verbatim; every column commented', () => {
    expect(fs.readFileSync(m.MIGRATION, 'utf8')).toContain(`${m.alterSql(ALL, true)};`);
    const c = m.clauses();
    expect(Object.keys(c.columns)).toEqual(ALL);
    for (const n of ALL) expect(m.commentOf(c.columns[n])).toMatch(/\S{10}/);
    expect(c.index).toBe('ADD KEY ix_provider_message_id (provider_message_id)');
  });
});

maybe('the T2 migration on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const schema = require('./helpers/commsArchiveSchema');
  let pool, conn;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const lines = [];
  const quiet = { say: (l) => lines.push(l) };
  const colNames = async () => (await q(`SELECT COLUMN_NAME n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_results' ORDER BY ORDINAL_POSITION`)).map((r) => r.n);
  const indexCols = async () => (await q(`SELECT COLUMN_NAME c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_results' AND INDEX_NAME = 'ix_provider_message_id' ORDER BY SEQ_IN_INDEX`)).map((r) => r.c);

  async function fresh() {
    await schema.build(pool, ['campaign_results']);
    const t2 = (await q(`SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_results' AND COLUMN_NAME IN (?)`, [ALL])).map((r) => r.n);
    if ((await indexCols()).length) await q('ALTER TABLE campaign_results DROP INDEX ix_provider_message_id');
    if (t2.length) await q(`ALTER TABLE campaign_results ${t2.map((n) => `DROP COLUMN ${n}`).join(', ')}`);
    await q("INSERT INTO campaign_results (result_id, campaign_id, contact_id, status) VALUES (1, 7, 1, 'sent'), (2, 7, 2, 'failed')");
    lines.length = 0;
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (c) => { c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`); });
  });
  afterAll(async () => { if (conn) conn.release(); await q('DROP TABLE IF EXISTS campaign_results'); await pool.end(); });
  beforeEach(async () => { if (conn) conn.release(); await fresh(); conn = await pool.getConnection(); });

  test('C: CHECK on the pre-T2 table → GO, next --apply; nothing changed; the row count printed', async () => {
    const before = await colNames();
    expect(before).toEqual(m.BASE_COLUMNS);
    const r = await m.run(conn, quiet);
    expect(r).toEqual({ ok: true, altered: false, line: 'CHECK OK — GO. Next: node scripts/yisramailT2Migrate.js --apply' });
    expect(lines).toContain('campaign_results: 2 row(s)');
    expect(lines).toContain(`campaign_results: T2 columns missing: ${ALL.join(', ')}; index ix_provider_message_id missing`);
    expect(await colNames()).toEqual(before);
  });

  test('A: --apply adds the columns + index exactly as the file says; existing rows unknown / NULL; a second --apply is a no-op GO', async () => {
    const r = await m.run(conn, { ...quiet, apply: true });
    expect(r).toEqual({ ok: true, altered: true, line: 'APPLIED — campaign_results T2 columns verified. GO. Next: the backend deploy.' });
    expect(await colNames()).toEqual([...m.BASE_COLUMNS, ...ALL]);
    expect(await indexCols()).toEqual(['provider_message_id']);
    const cols = Object.fromEntries((await q(`SELECT COLUMN_NAME n, COLUMN_TYPE t, IS_NULLABLE nl, COLUMN_DEFAULT d, COLUMN_COMMENT cm FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_results'`)).map((c) => [c.n, c]));
    for (const [n, [type, nullable, dflt]] of Object.entries(m.EXPECTED_COLUMNS)) {
      expect({ n, t: cols[n].t, nl: cols[n].nl, d: cols[n].d }).toEqual({ n, t: type, nl: nullable, d: dflt });
      expect(cols[n].cm).toBe(m.commentOf(m.clauses().columns[n]));
    }
    expect(await q('SELECT result_id, delivery_status, provider_message_id, delivered_at FROM campaign_results ORDER BY result_id')).toEqual([
      { result_id: 1, delivery_status: 'unknown', provider_message_id: null, delivered_at: null },
      { result_id: 2, delivery_status: 'unknown', provider_message_id: null, delivered_at: null }]);
    const again = await m.run(conn, { ...quiet, apply: true });
    expect(again).toEqual({ ok: true, altered: false, line: 'ALREADY IN PLACE — campaign_results T2 columns verified. GO. Next: the backend deploy.' });
    expect((await m.run(conn, quiet)).line).toBe('CHECK OK — the T2 columns and index are in place as expected. GO (nothing to apply; next: the backend deploy).');
  });

  test('P: columns there, index missing → --apply adds only the index; index there, a column missing → only the column', async () => {
    await q(`ALTER TABLE campaign_results ${ALL.map((n) => m.clauses().columns[n]).join(', ')}`);
    let r = await m.run(conn, { ...quiet, apply: true });
    expect(r).toMatchObject({ ok: true, altered: true });
    expect(lines).toContain('  ✓ added KEY ix_provider_message_id');
    await q('ALTER TABLE campaign_results DROP COLUMN delivery_diag');
    lines.length = 0;
    r = await m.run(conn, { ...quiet, apply: true });
    expect(r).toMatchObject({ ok: true, altered: true });
    expect(lines).toContain('  ✓ added delivery_diag');
  });

  test('D: a column of another definition / a foreign index of the same name / an unexpected column → NO-GO, nothing changed', async () => {
    await q("ALTER TABLE campaign_results ADD COLUMN delivery_status varchar(20) NULL COMMENT 'x'");
    let before = await colNames();
    for (const apply of [false, true]) {
      lines.length = 0;
      const r = await m.run(conn, { ...quiet, apply });
      expect(r.line).toBe('NO-GO — campaign_results is not in a state this script expects (above). Nothing was changed.');
      expect(lines).toContain(`  ✗ delivery_status is varchar(20), expected ${m.EXPECTED_COLUMNS.delivery_status[0]}`);
      expect(lines).toContain('  ✗ delivery_status comment differs from the migration file');
    }
    expect(await colNames()).toEqual(before);
    await fresh();
    await q('ALTER TABLE campaign_results ADD KEY ix_provider_message_id (campaign_id)');
    expect((await m.run(conn, { ...quiet, apply: true })).ok).toBe(false);
    expect(lines).toContain('  ✗ index ix_provider_message_id is (campaign_id), expected (provider_message_id)');
    await fresh();
    await q('ALTER TABLE campaign_results ADD COLUMN surprise int NULL');
    before = await colNames();
    expect((await m.run(conn, { ...quiet, apply: true })).ok).toBe(false);
    expect(lines).toContain('  ✗ unexpected column surprise');
    expect(await colNames()).toEqual(before);
  });

  test('S: lock_wait_timeout 10 and time_zone +00:00 hold on the connection after a CHECK and an --apply', async () => {
    for (const apply of [false, true]) {
      await conn.query("SET SESSION lock_wait_timeout = 99, time_zone = '-05:00'");
      await m.run(conn, { ...quiet, apply });
      const [[s]] = await conn.query('SELECT @@session.lock_wait_timeout AS lwt, @@session.time_zone AS tz');
      expect(s).toEqual({ lwt: 10, tz: '+00:00' });
    }
  });
});
