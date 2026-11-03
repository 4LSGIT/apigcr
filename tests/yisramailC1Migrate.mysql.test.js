/**
 * REAL-ENGINE test for the YisraMail C1 session-script migration
 * (scripts/yisramailC1Migrate.js) and its record
 * (ref/migrations/2026-11-03_yisramail_c1_campaign_class.sql):
 *   R  the record file's statements are exactly what the script runs with everything missing;
 *   C  CHECK on the pre-C1 tables → GO (next --apply), nothing changed, the row counts printed;
 *   A  --apply adds the columns + enum members + comments + the seed row, verified on the engine;
 *      existing rows read class 'operational'; a second --apply is a no-op GO;
 *   P  a run that finds part of it done resumes with the rest; an existing seed row is left alone;
 *   D  drift (a column of another definition, an unexpected column, a status enum that is neither
 *      shape, the switch already '1') is a NO-GO with nothing changed;
 *   S  the session settings hold on the connection after a run.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_c1mig_test npx jest tests/yisramailC1Migrate.mysql.test.js --runInBand
 * Its OWN *_test DB (it drops and rebuilds campaigns / campaign_results / app_settings).
 * THE PRE-C1 TABLES ARE INDEPENDENT OF THE DUMP: fresh() clones from ref/database.sql,
 * which carries the C1 columns once the migration has run live and the landing hook
 * regenerated it — so fresh() strips every C1 change after the clone (the T1 r2 lesson).
 */

'use strict';

const fs = require('fs');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const m = require('../scripts/yisramailC1Migrate');

describe('R: the record file is what the script runs', () => {
  test('each ALTER in the file = alterSql(table, every C1 column), verbatim; every clause commented; the seed leaves an existing row alone', () => {
    const text = fs.readFileSync(m.MIGRATION, 'utf8');
    for (const t of m.TABLES) {
      const cols = [...Object.keys(m.MODIFIED[t]), ...Object.keys(m.ADDED[t])];
      expect(text).toContain(`${m.alterSql(t, cols)};`);
      for (const n of cols) expect(m.commentOf(m.clauses().alters[t][n])).toMatch(/\S{10}/);
      for (const n of cols) expect(Buffer.byteLength(m.commentOf(m.clauses().alters[t][n]))).toBeLessThanOrEqual(1024);
    }
    expect(m.clauses().seed).toBe("INSERT INTO app_settings (`key`, `value`, is_secret, is_editable)\n  VALUES ('marketing_send_enabled', '0', 0, 0)\n  ON DUPLICATE KEY UPDATE `key` = `key`");
  });
});

maybe('the C1 migration on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const schema = require('./helpers/commsArchiveSchema');
  let pool, conn;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const lines = [];
  const quiet = { say: (l) => lines.push(l) };
  const colsOf = async (t) => (await q(`SELECT COLUMN_NAME n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [t])).map((r) => r.n);
  const colDef = async (t, n) => (await q(`SELECT COLUMN_TYPE t, IS_NULLABLE nl, COLUMN_DEFAULT d, COLUMN_COMMENT cm FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [t, n]))[0];

  async function fresh() {
    await schema.build(pool, ['campaigns', 'campaign_results', 'email_credentials', 'app_settings']);
    // Strip C1 (the dump carries it once the migration ran live).
    for (const [t, cols] of Object.entries(m.ADDED)) {
      const present = (await colsOf(t)).filter((n) => cols[n]);
      if (present.length) await q(`ALTER TABLE ${t} ${present.map((n) => `DROP COLUMN ${n}`).join(', ')}`);
    }
    await q("ALTER TABLE campaigns MODIFY COLUMN status enum('draft','scheduled','sending','sent','failed','partial_fail','canceled') DEFAULT 'draft' COMMENT ''");
    await q("ALTER TABLE campaign_results MODIFY COLUMN status enum('sent','failed','skipped') NOT NULL COMMENT ''");
    await q(`ALTER TABLE campaign_results MODIFY COLUMN provider_message_id varchar(128) NULL COMMENT '${m.MODIFIED.campaign_results.provider_message_id.before[4].replace(/'/g, "''")}'`);
    await q(`ALTER TABLE email_credentials MODIFY COLUMN bulk_ok tinyint(1) NOT NULL DEFAULT 0 COMMENT '${m.MODIFIED.email_credentials.bulk_ok.before[4].replace(/'/g, "''")}'`);
    await q("DELETE FROM app_settings WHERE `key` = 'marketing_send_enabled'");
    await q("INSERT INTO campaigns (campaign_id, type, sender, body, status, contact_count) VALUES (1, 'email', 'a@x.test', 'b', 'sent', 2), (2, 'sms', '2485550000', 'b', 'scheduled', 1)");
    await q("INSERT INTO campaign_results (result_id, campaign_id, contact_id, status) VALUES (1, 1, 1, 'sent'), (2, 1, 2, 'failed')");
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
    for (const t of ['campaigns', 'campaign_results', 'email_credentials', 'app_settings']) await q(`DROP TABLE IF EXISTS ${t}`);
    await pool.end();
  });
  beforeEach(async () => { if (conn) conn.release(); await fresh(); conn = await pool.getConnection(); });

  test('C: CHECK on the pre-C1 tables → GO, next --apply; nothing changed; the row counts printed', async () => {
    const before = { c: await colsOf('campaigns'), r: await colsOf('campaign_results') };
    expect(before.c).toEqual(m.BASE_COLUMNS.campaigns);
    expect(before.r).toEqual(m.BASE_COLUMNS.campaign_results);
    const r = await m.run(conn, quiet);
    expect(r).toEqual({ ok: true, altered: false, line: 'CHECK OK — GO. Next: node scripts/yisramailC1Migrate.js --apply' });
    expect(lines).toEqual(expect.arrayContaining([
      'campaigns: 2 row(s)', 'campaign_results: 2 row(s)', 'email_credentials: 0 row(s)',
      'campaigns: C1 work to do: status, class, topic_key, bulk_confirmed_count',
      'campaign_results: C1 work to do: status, provider_message_id',
      'email_credentials: C1 work to do: bulk_ok',
      "app_settings marketing_send_enabled: absent (seeded '0' by --apply)",
    ]));
    expect({ c: await colsOf('campaigns'), r: await colsOf('campaign_results') }).toEqual(before);
    expect(await q("SELECT * FROM app_settings WHERE `key` = 'marketing_send_enabled'")).toEqual([]);
  });

  test('A: --apply → columns, enum members, comments and the seed exactly as the file says; old rows operational; re-run no-op GO', async () => {
    const r = await m.run(conn, { ...quiet, apply: true });
    expect(r).toEqual({ ok: true, altered: true, line: 'APPLIED — C1 schema verified. GO. Next: the backend deploy.' });
    expect(await colsOf('campaigns')).toEqual([...m.BASE_COLUMNS.campaigns, 'class', 'topic_key', 'bulk_confirmed_count']);
    const c = m.clauses().alters;
    expect(await colDef('campaigns', 'class')).toEqual({ t: "enum('operational','marketing')", nl: 'NO', d: 'operational', cm: m.commentOf(c.campaigns.class) });
    expect(await colDef('campaigns', 'topic_key')).toEqual({ t: 'varchar(40)', nl: 'YES', d: null, cm: m.commentOf(c.campaigns.topic_key) });
    expect(await colDef('campaigns', 'bulk_confirmed_count')).toEqual({ t: 'int unsigned', nl: 'YES', d: null, cm: m.commentOf(c.campaigns.bulk_confirmed_count) });
    expect(await colDef('campaigns', 'status')).toEqual({ t: "enum('draft','scheduled','sending','sent','failed','partial_fail','canceled','paused')", nl: 'YES', d: 'draft', cm: m.commentOf(c.campaigns.status) });
    expect(await colDef('campaign_results', 'status')).toEqual({ t: "enum('sent','failed','skipped','sending','unknown')", nl: 'NO', d: null, cm: m.commentOf(c.campaign_results.status) });
    expect((await colDef('campaign_results', 'provider_message_id')).cm).toBe(m.commentOf(c.campaign_results.provider_message_id));
    expect(await colDef('email_credentials', 'bulk_ok')).toEqual({ t: 'tinyint(1)', nl: 'NO', d: '0', cm: m.commentOf(c.email_credentials.bulk_ok) });
    expect(await q("SELECT `value`, is_secret, is_editable FROM app_settings WHERE `key` = 'marketing_send_enabled'")).toEqual([{ value: '0', is_secret: 0, is_editable: 0 }]);
    expect(await q('SELECT campaign_id, class, topic_key, bulk_confirmed_count, status FROM campaigns ORDER BY campaign_id')).toEqual([
      { campaign_id: 1, class: 'operational', topic_key: null, bulk_confirmed_count: null, status: 'sent' },
      { campaign_id: 2, class: 'operational', topic_key: null, bulk_confirmed_count: null, status: 'scheduled' }]);
    // the new members are writable (relaxed sql_mode would silently store '' for an unknown member)
    await q("UPDATE campaigns SET status = 'paused' WHERE campaign_id = 2");
    await q("UPDATE campaign_results SET status = 'sending' WHERE result_id = 1");
    await q("UPDATE campaign_results SET status = 'unknown' WHERE result_id = 2");
    expect((await q('SELECT status FROM campaigns WHERE campaign_id = 2'))[0].status).toBe('paused');
    expect((await q('SELECT status FROM campaign_results ORDER BY result_id')).map((x) => x.status)).toEqual(['sending', 'unknown']);
    const again = await m.run(conn, { ...quiet, apply: true });
    expect(again).toEqual({ ok: true, altered: false, line: 'ALREADY IN PLACE — C1 schema verified. GO. Next: the backend deploy.' });
    expect((await m.run(conn, quiet)).line).toBe('CHECK OK — the C1 columns, enum members and seed are in place as expected. GO (nothing to apply; next: the backend deploy).');
  });

  test('P: part done → --apply does only the rest; an existing seed row (any value but 1) is left as it is', async () => {
    await q(`ALTER TABLE campaigns ${m.clauses().alters.campaigns.class}`);
    await q("INSERT INTO app_settings (`key`, `value`) VALUES ('marketing_send_enabled', '')");
    const r = await m.run(conn, { ...quiet, apply: true });
    expect(r).toMatchObject({ ok: true, altered: true });
    expect(lines).toContain('  ✓ campaigns: status, topic_key, bulk_confirmed_count');
    expect(lines).toContain('  ✓ campaign_results: status, provider_message_id');
    expect(lines).toContain('  ✓ email_credentials: bulk_ok');
    expect(lines.some((l) => /✓ app_settings/.test(l))).toBe(false);
    expect((await q("SELECT `value` FROM app_settings WHERE `key` = 'marketing_send_enabled'"))[0].value).toBe('');
  });

  test('D: drift → NO-GO, nothing changed', async () => {
    const cases = [
      ['campaigns has a class column of another definition', "ALTER TABLE campaigns ADD COLUMN class varchar(20) NULL", /class is varchar\(20\)/],
      ['an unexpected column', 'ALTER TABLE campaign_results ADD COLUMN extra int NULL', /unexpected column extra/],
      ['a status enum of neither shape', "ALTER TABLE campaigns MODIFY COLUMN status enum('draft','sent') DEFAULT 'draft'", /campaigns\.status is neither/],
      ['the switch already on', "INSERT INTO app_settings (`key`, `value`) VALUES ('marketing_send_enabled', '1')", /already '1'/],
    ];
    for (const [, sql, problem] of cases) {
      await fresh();
      await q(sql);
      const before = { c: await colsOf('campaigns'), r: await colsOf('campaign_results'), e: await colDef('email_credentials', 'bulk_ok'), s: await q('SELECT * FROM app_settings') };
      for (const apply of [false, true]) {
        lines.length = 0;
        const r = await m.run(conn, { ...quiet, apply });
        expect(r).toEqual({ ok: false, altered: false, line: 'NO-GO — the database is not in a state this script expects (above). Nothing was changed.' });
        expect(lines.some((l) => problem.test(l))).toBe(true);
      }
      expect({ c: await colsOf('campaigns'), r: await colsOf('campaign_results'), e: await colDef('email_credentials', 'bulk_ok'), s: await q('SELECT * FROM app_settings') }).toEqual(before);
    }
  });

  test('S: the session settings hold after a run', async () => {
    await m.run(conn, quiet);
    const [[s]] = await conn.query('SELECT @@session.lock_wait_timeout AS lw, @@session.time_zone AS tz');
    expect(s).toEqual({ lw: 10, tz: '+00:00' });
  });
});
