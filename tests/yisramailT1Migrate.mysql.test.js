/**
 * REAL-ENGINE test for the YisraMail T1 session-script migration
 * (scripts/yisramailT1Migrate.js) and its record
 * (ref/migrations/2026-11-01_yisramail_t1_email_credentials_bulk.sql):
 *   R  the record file's ALTER is exactly what the script runs with all three
 *      columns missing; the script's driver list is emailService's;
 *   C  CHECK on the pre-T1 table (built from ref/database.sql) → GO, next
 *      --apply, nothing changed;
 *   A  --apply adds the three columns — types, nullability, defaults,
 *      collation, comments verified on the engine; existing rows read
 *      bulk_ok 0 / NULL / NULL; a second --apply is a no-op GO;
 *   P  a run that finds one column already added resumes with the other two;
 *   D  drift (a T1 column with another definition, an unexpected column) is a
 *      NO-GO with nothing changed;
 *   S  the §5.2 data checks: a bulk row sharing its SMTP login with another
 *      row, or with a mailbox sending through it, is NO-GO.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   Fresh *_test DB, mysqld --default-time-zone=+00:00, prod sql_mode:
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_t1_test npx jest tests/yisramailT1Migrate.mysql.test.js --runInBand
 *   Self-building: it drops and rebuilds email_credentials and mailboxes only.
 *
 * THE PRE-T1 TABLE IS INDEPENDENT OF THE DUMP. fresh() clones
 * email_credentials from the living ref/database.sql, which carries the three
 * T1 columns from the landing on (Fred runs --apply BEFORE the land, and the
 * landing hook regenerates the dump from the live schema). So fresh() drops
 * any T1 column it finds after the clone — the CHECK always starts from the
 * pre-T1 shape, against the dump before AND after the migration (both proved
 * at r2, the second on a scratch copy of the dump with the columns added).
 */

'use strict';

const fs = require('fs');

const URL_  = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

const m = require('../scripts/yisramailT1Migrate');
const ALL = ['bulk_ok', 'events_driver', 'driver_config'];

describe('R: the record file is what the script runs', () => {
  test('the file\'s ALTER = alterSql(all three), verbatim', () => {
    const txt = fs.readFileSync(m.MIGRATION, 'utf8');
    expect(txt).toContain(`${m.alterSql(ALL)};`);
    expect(Object.keys(m.clauses())).toEqual(ALL);
  });
  test('each clause carries the definition the verifier expects', () => {
    const c = m.clauses();
    expect(c.bulk_ok).toMatch(/^ADD COLUMN bulk_ok tinyint\(1\) NOT NULL DEFAULT 0 COMMENT '/);
    expect(c.events_driver).toMatch(/^ADD COLUMN events_driver varchar\(20\) NULL COMMENT '/);
    expect(c.driver_config).toMatch(/^ADD COLUMN driver_config json NULL COMMENT '/);
    expect(m.commentOf(c.bulk_ok)).toMatch(/only sendEmailDirect\(\{bulk:true\}\)/);
    expect(m.commentOf(c.driver_config)).toBe('driver-specific settings, e.g. {"configuration_set": "yisramail-marketing"} for ses; bulk_ok rows only, cleared with the driver. NULL = the provider defaults');
    expect(m.commentOf(c.events_driver)).toMatch(/; bulk_ok rows only \(emailService throws events_driver_requires_bulk otherwise\)\./);
  });
  test('the frozen driver list is emailService\'s', () => {
    expect(m.KNOWN_DRIVERS).toEqual(require('../services/emailService').VALID_EVENTS_DRIVERS);
  });
});

maybe('the T1 migration on real MySQL', () => {
  const mysql  = require('mysql2/promise');
  const schema = require('./helpers/commsArchiveSchema');
  let pool, conn;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const lines = [];
  const quiet = { say: (l) => lines.push(l) };
  const cols = () => q(`SELECT COLUMN_NAME n, COLUMN_TYPE t, IS_NULLABLE nl, COLUMN_DEFAULT d, COLLATION_NAME c, COLUMN_COMMENT cm
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'email_credentials' ORDER BY ORDINAL_POSITION`);
  const colNames = async () => (await cols()).map((c) => c.n);

  async function fresh() {
    await schema.build(pool, ['email_credentials', 'mailboxes']);
    // the pre-T1 shape, whatever the dump says (header: post-land dumps carry the columns)
    const t1 = (await q(`SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'email_credentials' AND COLUMN_NAME IN (?)`, [ALL])).map((r) => r.n);
    if (t1.length) await q(`ALTER TABLE email_credentials ${t1.map((n) => `DROP COLUMN ${n}`).join(', ')}`);
    await q(`INSERT INTO email_credentials (id, email, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, provider, credential_id, from_name) VALUES
      (1, 'stuart@firm.test', '', 0, '', '', 0, 'gmail', 11, 'Stuart'),
      (3, 'it@firm.test', '', 0, '', '', 0, 'gmail', 11, 'IT'),
      (4, 'it@mdbl.test', 'gcam.siteground.test', 587, 'it@mdbl.test', 'ENCv1:x', 0, 'smtp', NULL, 'IT'),
      (6, 'sh@mdbl.test', 'gcam.siteground.test', 587, 'sh@mdbl.test', 'ENCv1:x', 0, 'smtp', NULL, 'Sh'),
      (17, 'news@news.test', 'email-smtp.us-east-2.amazonaws.com', 587, 'AKIAEXAMPLE', 'ENCv1:x', 0, 'smtp', NULL, 'News')`);
    await q(`INSERT INTO mailboxes (id, address, domain, imap_host, imap_user, send_credential_id) VALUES
      (2, 'stuart@firm.test', 'firm.test', 'imap.gmail.com', 'stuart@firm.test', 1),
      (3, 'it@mdbl.test', 'mdbl.test', 'imap.mdbl.test', 'it@mdbl.test', 4)`);
    lines.length = 0;
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (c) => { c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`); });
  });
  afterAll(async () => {
    if (conn) conn.release();
    await q('DROP TABLE IF EXISTS email_credentials');
    await q('DROP TABLE IF EXISTS mailboxes');
    await pool.end();
  });
  beforeEach(async () => { if (conn) conn.release(); await fresh(); conn = await pool.getConnection(); });

  test('C: CHECK on the pre-T1 table → GO (next: --apply), nothing changed', async () => {
    const before = await colNames();
    expect(before).toEqual(m.BASE_COLUMNS);
    const r = await m.run(conn, quiet);
    expect(r).toEqual({ ok: true, altered: false, line: 'CHECK OK — GO. Next: node scripts/yisramailT1Migrate.js --apply' });
    expect(await colNames()).toEqual(before);
    expect(lines).toContain('email_credentials: T1 columns missing: bulk_ok, events_driver, driver_config');
    expect(lines).toContain('  · no two SMTP rows share a login');
    // a shared login is reported (information only before the columns exist)
    await q("UPDATE email_credentials SET smtp_user = 'it@mdbl.test' WHERE id = 6");
    lines.length = 0;
    expect((await m.run(conn, quiet)).ok).toBe(true);
    expect(lines).toContain('  · SMTP rows 4,6 share one login (gcam.siteground.test / it@mdbl.test) — none of them can be marked bulk');
  });

  test('the session settings: lock_wait_timeout 10 and time_zone +00:00 hold on the connection after a CHECK and an --apply', async () => {
    for (const apply of [false, true]) {
      await conn.query("SET SESSION lock_wait_timeout = 99, time_zone = '-05:00'");
      expect((await m.run(conn, { ...quiet, apply })).ok).toBe(true);
      const [[s]] = await conn.query('SELECT @@session.lock_wait_timeout AS lwt, @@session.time_zone AS tz');
      expect(s).toEqual({ lwt: 10, tz: '+00:00' });
    }
  });

  test('A: --apply adds the three columns exactly as the file says; existing rows read 0 / NULL / NULL; a second --apply is a no-op GO', async () => {
    const r = await m.run(conn, { ...quiet, apply: true });
    expect(r).toMatchObject({ ok: true, altered: true });
    expect(r.line).toBe('APPLIED — email_credentials T1 columns verified. GO. Next: the backend deploy.');
    const c = Object.fromEntries((await cols()).map((x) => [x.n, x]));
    expect(await colNames()).toEqual([...m.BASE_COLUMNS, ...ALL]);
    expect(c.bulk_ok).toMatchObject({ t: 'tinyint(1)', nl: 'NO', d: '0', c: null });
    expect(c.events_driver).toMatchObject({ t: 'varchar(20)', nl: 'YES', d: null, c: 'utf8mb4_general_ci' });
    expect(c.driver_config).toMatchObject({ t: 'json', nl: 'YES', d: null, c: null });
    const file = m.clauses();
    for (const n of ALL) expect(c[n].cm).toBe(m.commentOf(file[n]));
    expect(c.bulk_ok.cm).toContain('— the campaign marketing path —');   // multibyte survives the round trip
    expect(await q('SELECT id, bulk_ok, events_driver, driver_config FROM email_credentials ORDER BY id')).toEqual(
      [1, 3, 4, 6, 17].map((id) => ({ id, bulk_ok: 0, events_driver: null, driver_config: null })));
    // the JSON column holds the editor's value and hands it back parsed
    await q(`UPDATE email_credentials SET bulk_ok = 1, events_driver = 'ses', driver_config = ? WHERE id = 17`, ['{"configuration_set":"yisramail-marketing"}']);
    expect((await q('SELECT driver_config FROM email_credentials WHERE id = 17'))[0].driver_config).toEqual({ configuration_set: 'yisramail-marketing' });

    lines.length = 0;
    const again = await m.run(conn, { ...quiet, apply: true });
    expect(again).toEqual({ ok: true, altered: false, line: 'ALREADY IN PLACE — email_credentials T1 columns verified. GO. Next: the backend deploy.' });
    expect(lines).toContain('  · bulk rows: 17 news@news.test [ses]');
    const check = await m.run(conn, quiet);
    expect(check.line).toBe('CHECK OK — the T1 columns are in place as expected. GO (nothing to apply; next: the backend deploy).');
  });

  test('P: a run that stopped after one column resumes with the other two', async () => {
    await q(`ALTER TABLE email_credentials ${m.clauses().bulk_ok}`);
    const chk = await m.run(conn, quiet);
    expect(chk.line).toBe('CHECK OK — GO. Next: node scripts/yisramailT1Migrate.js --apply');
    expect(lines).toContain('email_credentials: T1 columns missing: events_driver, driver_config');
    const r = await m.run(conn, { ...quiet, apply: true });
    expect(r).toMatchObject({ ok: true, altered: true });
    expect(lines).toContain('  ✓ added events_driver, driver_config');
    expect(await colNames()).toEqual([...m.BASE_COLUMNS, ...ALL]);
  });

  test('D: a T1 column with another definition → NO-GO, nothing changed (CHECK and --apply)', async () => {
    await q("ALTER TABLE email_credentials ADD COLUMN events_driver varchar(30) NULL COMMENT 'x'");
    const before = await colNames();
    for (const apply of [false, true]) {
      lines.length = 0;
      const r = await m.run(conn, { ...quiet, apply });
      expect(r.ok).toBe(false);
      expect(r.line).toBe('NO-GO — email_credentials is not in a state this script expects (above). Nothing was changed.');
      expect(lines).toContain('  ✗ events_driver is varchar(30), expected varchar(20)');
      expect(lines).toContain('  ✗ events_driver comment differs from the migration file');
    }
    expect(await colNames()).toEqual(before);
  });

  test('D: an unexpected column → NO-GO, nothing changed', async () => {
    await q('ALTER TABLE email_credentials ADD COLUMN surprise int NULL');
    const r = await m.run(conn, { ...quiet, apply: true });
    expect(r.ok).toBe(false);
    expect(lines).toContain('  ✗ unexpected column surprise');
    expect(await colNames()).toEqual([...m.BASE_COLUMNS, 'surprise']);
  });

  test('S: a bulk row sharing its SMTP login with another row → NO-GO (CHECK and --apply), naming both', async () => {
    expect((await m.run(conn, { ...quiet, apply: true })).ok).toBe(true);
    await q("UPDATE email_credentials SET bulk_ok = 1, events_driver = 'ses' WHERE id = 17");
    await q(`INSERT INTO email_credentials (id, email, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, provider, from_name)
      VALUES (20, 'other@news.test', 'EMAIL-SMTP.us-east-2.amazonaws.com', 587, 'akiaexample', 'ENCv1:x', 0, 'smtp', 'Other')`);
    for (const apply of [false, true]) {
      lines.length = 0;
      const r = await m.run(conn, { ...quiet, apply });
      expect(r.ok).toBe(false);
      expect(lines).toContain('  ✗ bulk row 17 (news@news.test) shares its SMTP login with rows 17,20 — §5.2: no other row may');
      expect(r.line).toMatch(/^NO-GO/);
    }
  });

  test('S: a driver or driver_config on a row that is not bulk_ok → NO-GO', async () => {
    expect((await m.run(conn, { ...quiet, apply: true })).ok).toBe(true);
    await q("UPDATE email_credentials SET events_driver = 'ses' WHERE id = 4");
    await q(`UPDATE email_credentials SET driver_config = '{"configuration_set":"x"}' WHERE id = 6`);
    lines.length = 0;
    const r = await m.run(conn, quiet);
    expect(r.ok).toBe(false);
    expect(lines).toEqual(expect.arrayContaining([
      '  ✗ row 4 (it@mdbl.test) carries an events_driver / driver_config but is not bulk_ok — a driver is for bulk rows only',
      '  ✗ row 6 (sh@mdbl.test) carries an events_driver / driver_config but is not bulk_ok — a driver is for bulk rows only',
    ]));
  });

  test('S: a mailbox sending through a bulk row, a bulk gmail row, an unknown driver → NO-GO', async () => {
    expect((await m.run(conn, { ...quiet, apply: true })).ok).toBe(true);
    await q("UPDATE email_credentials SET smtp_user = 'it-only@mdbl.test' WHERE id = 4");
    await q("UPDATE email_credentials SET bulk_ok = 1 WHERE id IN (1, 4)");
    await q("UPDATE email_credentials SET bulk_ok = 1, events_driver = 'mailgun' WHERE id = 17");
    lines.length = 0;
    const r = await m.run(conn, quiet);
    expect(r).toMatchObject({ ok: false, line: 'NO-GO — the rows break §5.2 (above). Fix them in the sender editor first; nothing was changed.' });
    expect(lines).toEqual(expect.arrayContaining([
      '  ✗ mailbox 3 (it@mdbl.test) sends through bulk row 4 — re-point it',
      '  ✗ bulk row 1 (stuart@firm.test) is provider gmail — bulk_ok is for smtp rows only',
      '  ✗ mailbox 2 (stuart@firm.test) sends through bulk row 1 — re-point it',
      '  ✗ bulk row 17 names unknown events_driver "mailgun"',
    ]));
  });
});
