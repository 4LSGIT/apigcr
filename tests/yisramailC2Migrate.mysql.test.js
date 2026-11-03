/**
 * REAL-ENGINE test for the YisraMail C2 session-script migration
 * (scripts/yisramailC2Migrate.js) and its record
 * (ref/migrations/2026-11-04_yisramail_c2_marketing_send.sql):
 *   R  the record file's statements are exactly what the script runs with everything missing;
 *   C  CHECK on the pre-C2 tables → GO (next --apply), nothing changed, the row counts printed;
 *   A  --apply adds the three columns with the file's definitions + comments; existing rows read
 *      NULL; a second --apply is a no-op GO;
 *   P  a run that finds part of it done resumes with the rest;
 *   D  drift (a C2 column of another definition, an unexpected column, a missing base column) is a
 *      NO-GO with nothing changed;
 *   S  the session settings hold on the connection after a run;
 *   L  with the C2 columns present, the C1 CHECK still says GO and the T1 column check finds no
 *      unexpected column (their LATER_COLUMNS).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_c2mig_test npx jest tests/yisramailC2Migrate.mysql.test.js --runInBand
 * Its OWN *_test DB (it drops and rebuilds campaigns / campaign_results / email_credentials /
 * app_settings / mailboxes). THE PRE-C2 TABLES ARE INDEPENDENT OF THE DUMP: fresh() clones from
 * ref/database.sql — which carries the C2 columns once the migration has run live — and strips them.
 */

'use strict';

const fs = require('fs');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const m = require('../scripts/yisramailC2Migrate');
const BUILT = ['campaigns', 'campaign_results', 'email_credentials', 'app_settings', 'mailboxes'];

describe('R: the record file is what the script runs', () => {
  test('each ALTER in the file = alterSql(table, every C2 column), verbatim; every clause commented, ≤ 1024 bytes', () => {
    const text = fs.readFileSync(m.MIGRATION, 'utf8');
    for (const t of m.TABLES) {
      const cols = Object.keys(m.ADDED[t]);
      expect(text).toContain(`${m.alterSql(t, cols)};`);
      for (const n of cols) expect((m.commentOf(m.clauses()[t][n]) || '').length).toBeGreaterThan(40);
      for (const n of cols) expect(Buffer.byteLength(m.commentOf(m.clauses()[t][n]))).toBeLessThanOrEqual(1024);
    }
    expect(m.alterSql('campaigns', [])).toBeNull();
  });
});

maybe('the C2 migration on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const schema = require('./helpers/commsArchiveSchema');
  const c1 = require('../scripts/yisramailC1Migrate');
  const t1 = require('../scripts/yisramailT1Migrate');
  let pool, conn;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const lines = [];
  const quiet = { say: (l) => lines.push(l) };
  const colsOf = async (t) => (await q(`SELECT COLUMN_NAME n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [t])).map((r) => r.n);
  const colDef = async (t, n) => (await q(`SELECT COLUMN_TYPE t, IS_NULLABLE nl, COLUMN_DEFAULT d, COLLATION_NAME c, COLUMN_COMMENT cm FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [t, n]))[0];

  async function fresh() {
    await schema.build(pool, BUILT);
    for (const [t, cols] of Object.entries(m.ADDED)) {
      const present = (await colsOf(t)).filter((n) => cols[n]);
      if (present.length) await q(`ALTER TABLE ${t} ${present.map((n) => `DROP COLUMN ${n}`).join(', ')}`);
    }
    await q("INSERT INTO campaigns (campaign_id, type, sender, body, status, contact_count) VALUES (1, 'email', 'a@x.test', 'b', 'sent', 2)");
    await q("INSERT INTO email_credentials (id, email, smtp_host, smtp_port, smtp_user, smtp_pass, provider, from_name, bulk_ok) VALUES (17, 'news@news.test', 'h', 587, 'u', 'ENCv1:x', 'smtp', 'News', 1)");
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
    for (const t of BUILT) await q(`DROP TABLE IF EXISTS ${t}`);
    await pool.end();
  });
  beforeEach(async () => { if (conn) conn.release(); await fresh(); conn = await pool.getConnection(); });

  test('C: CHECK on the pre-C2 tables → GO, next --apply; nothing changed; the row counts printed', async () => {
    expect(await colsOf('campaigns')).toEqual(m.BASE_COLUMNS.campaigns);
    expect(await colsOf('email_credentials')).toEqual(m.BASE_COLUMNS.email_credentials);
    const r = await m.run(conn, quiet);
    expect(r).toEqual({ ok: true, altered: false, line: 'CHECK OK — GO. Next: node scripts/yisramailC2Migrate.js --apply' });
    expect(lines).toEqual(expect.arrayContaining([
      'campaigns: 1 row(s)', 'email_credentials: 1 row(s)',
      'campaigns: C2 work to do: send_snapshot', 'email_credentials: C2 work to do: held_at, held_reason',
    ]));
    expect(await colsOf('campaigns')).toEqual(m.BASE_COLUMNS.campaigns);
    expect(await colsOf('email_credentials')).toEqual(m.BASE_COLUMNS.email_credentials);
  });

  test('A: --apply → the columns exactly as the file says; old rows NULL; re-run no-op GO', async () => {
    const r = await m.run(conn, { ...quiet, apply: true });
    expect(r).toEqual({ ok: true, altered: true, line: 'APPLIED — C2 schema verified. GO. Next: the backend deploy.' });
    expect(await colsOf('campaigns')).toEqual([...m.BASE_COLUMNS.campaigns, 'send_snapshot']);
    expect(await colsOf('email_credentials')).toEqual([...m.BASE_COLUMNS.email_credentials, 'held_at', 'held_reason']);
    const c = m.clauses();
    expect(await colDef('campaigns', 'send_snapshot')).toEqual({ t: 'json', nl: 'YES', d: null, c: null, cm: m.commentOf(c.campaigns.send_snapshot) });
    expect(await colDef('email_credentials', 'held_at')).toEqual({ t: 'datetime', nl: 'YES', d: null, c: null, cm: m.commentOf(c.email_credentials.held_at) });
    expect(await colDef('email_credentials', 'held_reason')).toEqual({ t: 'varchar(255)', nl: 'YES', d: null, c: 'utf8mb4_general_ci', cm: m.commentOf(c.email_credentials.held_reason) });
    expect(await q('SELECT send_snapshot FROM campaigns')).toEqual([{ send_snapshot: null }]);
    expect(await q('SELECT held_at, held_reason FROM email_credentials')).toEqual([{ held_at: null, held_reason: null }]);
    const again = await m.run(conn, { ...quiet, apply: true });
    expect(again).toEqual({ ok: true, altered: false, line: 'ALREADY IN PLACE — C2 schema verified. GO. Next: the backend deploy.' });
    expect((await m.run(conn, quiet)).line).toBe('CHECK OK — the C2 columns are in place as expected. GO (nothing to apply; next: the backend deploy).');
  });

  test('P: part done → --apply does only the rest', async () => {
    await q(`ALTER TABLE email_credentials ${m.clauses().email_credentials.held_at}`);
    const r = await m.run(conn, { ...quiet, apply: true });
    expect(r).toMatchObject({ ok: true, altered: true });
    expect(lines).toContain('  ✓ campaigns: send_snapshot');
    expect(lines).toContain('  ✓ email_credentials: held_reason');
    expect(await colsOf('email_credentials')).toEqual([...m.BASE_COLUMNS.email_credentials, 'held_at', 'held_reason']);
  });

  test('D: drift → NO-GO, nothing changed', async () => {
    const cases = [
      ['held_reason of another definition', 'ALTER TABLE email_credentials ADD COLUMN held_reason varchar(64) NULL', /held_reason is varchar\(64\)/],
      ['an unexpected column', 'ALTER TABLE campaigns ADD COLUMN extra int NULL', /unexpected column extra/],
      ['a missing base column', 'ALTER TABLE campaigns DROP COLUMN topic_key', /pre-C2 column topic_key is missing/],
      ['send_snapshot with another comment', "ALTER TABLE campaigns ADD COLUMN send_snapshot json NULL COMMENT 'x'", /send_snapshot comment differs/],
    ];
    for (const [, sql, problem] of cases) {
      await fresh();
      await q(sql);
      const before = { c: await colsOf('campaigns'), e: await colsOf('email_credentials') };
      for (const apply of [false, true]) {
        lines.length = 0;
        const r = await m.run(conn, { ...quiet, apply });
        expect(r).toEqual({ ok: false, altered: false, line: 'NO-GO — the database is not in a state this script expects (above). Nothing was changed.' });
        expect(lines.some((l) => problem.test(l))).toBe(true);
      }
      expect({ c: await colsOf('campaigns'), e: await colsOf('email_credentials') }).toEqual(before);
    }
  });

  test('S: the session settings hold after a run', async () => {
    await m.run(conn, quiet);
    const [[s]] = await conn.query('SELECT @@session.lock_wait_timeout AS lw, @@session.time_zone AS tz');
    expect(s).toEqual({ lw: 10, tz: '+00:00' });
  });

  test('L: with the C2 columns in place, C1 CHECK still GO and T1 sees no unexpected column (LATER_COLUMNS)', async () => {
    expect((await m.run(conn, { ...quiet, apply: true })).ok).toBe(true);
    // the dump this was cloned from carries C1 and T1 (both live)
    expect((await c1.run(conn, { say: () => {} })).ok).toBe(true);
    // T1: its CHECK already reports C1's bulk_ok comment rewrite (pre-existing, not C2's) —
    // the tolerance under test is only that the hold columns are not "unexpected"
    const tState = await t1.columnState(conn);
    expect(tState.problems.filter((p) => /unexpected column/.test(p))).toEqual([]);
    // and the tolerance is exactly those columns — anything else is still unexpected
    await q('ALTER TABLE email_credentials ADD COLUMN not_later int NULL');
    expect((await c1.run(conn, { say: () => {} })).ok).toBe(false);
    expect((await t1.columnState(conn)).problems).toContain('unexpected column not_later');
  });
});
