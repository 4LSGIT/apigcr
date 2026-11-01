/**
 * tests/caseCaption.mysql.test.js
 *
 * Captions on a real engine: the court stamp's guarded UPDATE through the real
 * resolver and executor, the Cases tab search, and the picker's flag.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3341/yc_caption_test \
 *     npx jest tests/caseCaption.mysql.test.js --runInBand
 * Refuses port 3306 (production through the proxy) and any database whose
 * name does not end in _test. Tables are cloned from ref/database.sql.
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

jest.mock('../lib/domainEvents', () => ({
  emit:         jest.fn(() => Promise.resolve()),
  buildChanges: jest.fn(() => ({})),
  runAsAction:  (_ruleId, fn) => fn(),
  MAX_DEPTH:    4,
}));

const courtCitation = require('../lib/courtCitation');
courtCitation.checkCitations = () => ({ pass: true, misses: [] });

const caseService = require('../services/caseService');
const { executeCourtActions } = require('../services/courtExecutor');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['contacts', 'cases', 'case_relate', 'court_ai_log', 'ai_change_log', 'app_settings'];

function dumpBlocks(dumpLines, table) {
  const out = [];
  let cur = null;
  const start = new RegExp(`^(?:CREATE TABLE|ALTER TABLE) \`${table}\`[ (]*$`);
  for (const line of dumpLines) {
    if (cur == null) { if (start.test(line)) cur = [line]; continue; }
    cur.push(line);
    if (/;\s*$/.test(line)) { out.push(cur.join('\n').replace(/;\s*$/, '')); cur = null; }
  }
  return out;
}

d('case captions on a real engine', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const captionOf = async (id) =>
    (await q('SELECT case_caption FROM cases WHERE case_id = ?', [id]))[0].case_caption;
  let seq = 0;
  const email = (caseNumber, name, body) => executeCourtActions(pool, {
    payload: { message_id: `caption-${++seq}`, case_number: caseNumber, case_name: name,
      classification: 'other_notice', needs_review: false, actions: [] },
    subject: `${caseNumber} "Certificate of Service"`,
    body: body || `Case Name: ${name}\nCase Number: ${caseNumber}`,
    dryRun: false,
  });

  beforeAll(async () => {
    const url = new URL(URL_);
    if (!/_test$/.test(url.pathname.slice(1))) throw new Error(`refusing to run against "${url.pathname}"`);
    if (url.port === '3306' || url.port === '') throw new Error('refusing port 3306 — that is production');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    const [[{ mode }]] = await pool.query('SELECT @@SESSION.sql_mode AS mode');
    expect(mode).not.toMatch(/STRICT_TRANS_TABLES|ONLY_FULL_GROUP_BY|NO_BACKSLASH_ESCAPES/);

    const dumpLines = read('ref/database.sql').split('\n');
    for (const t of [...TABLES].reverse()) await q(`DROP TABLE IF EXISTS \`${t}\``);
    for (const t of TABLES) {
      const blocks = dumpBlocks(dumpLines, t);
      if (!blocks.length) throw new Error(`ref/database.sql has no CREATE TABLE for ${t}`);
      for (const b of blocks) await pool.query(b);
    }

    await q(`INSERT INTO contacts (contact_id, contact_fname, contact_lname, contact_name) VALUES
      (1, 'Jason', 'Childs', 'Jason F Childs'),
      (2, 'Jane',  'Smith',  'Jane Q Smith'),
      (3, 'Salwan','Savaya', 'Salwan Savaya')`);
    await q(`INSERT INTO cases (case_id, case_number, case_number_full, case_type, case_subtype, case_stage, case_status, case_caption, case_open_date) VALUES
      ('CAPNULL1', '26-1', '26-1-mar', 'Bankruptcy', 'Chapter 7', 'Filed', '', NULL, '2026-01-01'),
      ('CAPBLANK', '26-2', '26-2-mar', 'Bankruptcy', 'Chapter 7', 'Filed', '', '',   '2026-01-02'),
      ('CAPHAND1', '26-3', '26-3-mar', 'Bankruptcy', 'Chapter 7', 'Filed', '', 'In re Jane Q. Smith, Hand Typed', '2026-01-03'),
      ('CAPADV01', '26-4', '26-4-prh', 'Bankruptcy', 'Adversary Proceeding', 'Open', '', 'Schneyer v. Childs', '2026-01-04'),
      ('CAPOTHER', '26-5', '26-5-mar', 'Bankruptcy', 'Chapter 7', 'Filed', '', 'In re Ammar Victor Buny', '2026-01-05')`);
    await q(`INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type) VALUES
      ('CAPNULL1', 2, 'Primary'), ('CAPBLANK', 2, 'Primary'), ('CAPHAND1', 2, 'Primary'),
      ('CAPADV01', 1, 'Primary'), ('CAPOTHER', 3, 'Primary')`);
  });

  afterAll(async () => { if (pool) await pool.end(); });

  test('a NULL caption takes the court\'s name and logs the change', async () => {
    await email('26-1-mar', 'Jane Quincy Smith');
    expect(await captionOf('CAPNULL1')).toBe('In re Jane Quincy Smith');
    const rows = await q(`SELECT old_value, new_value FROM ai_change_log WHERE entity_id = 'CAPNULL1' AND field = 'case_caption'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].new_value).toBe('In re Jane Quincy Smith');
  });

  test('a blank-string caption is empty too', async () => {
    await email('26-2-mar', 'Jane Quincy Smith');
    expect(await captionOf('CAPBLANK')).toBe('In re Jane Quincy Smith');
  });

  test('a later court name does not replace the first', async () => {
    await email('26-1-mar', 'Jane Q. Smith-Jones');
    expect(await captionOf('CAPNULL1')).toBe('In re Jane Quincy Smith');
  });

  test('a hand-typed caption survives the court', async () => {
    await email('26-3-mar', 'Jane Quincy Smith');
    expect(await captionOf('CAPHAND1')).toBe('In re Jane Q. Smith, Hand Typed');
  });

  test('the Cases tab finds a case by a name only its caption holds', async () => {
    const r = await caseService.listCases(pool, { query: 'Schneyer' });
    expect(r.cases.map((c) => c.case_id)).toEqual(['CAPADV01']);
    expect(r.total).toBe(1);
  });

  test('the backfill plans, writes, reads back, and is then done', async () => {
    const os = require('os');
    const { run } = require('../scripts/caseCaptionBackfill');
    await q(`INSERT INTO contacts (contact_id, contact_fname, contact_lname, contact_name) VALUES (9, 'Old', 'Case', 'Old Case')`);
    await q(`INSERT INTO cases (case_id, case_number, case_type, case_subtype, case_stage, case_status, case_caption, case_open_date) VALUES
      ('BACKOLD1', '20-1', 'Bankruptcy', 'Chapter 7', 'Closed', '', NULL, '2020-01-01'),
      ('BACKBARE', '20-2', 'Bankruptcy', 'Chapter 7', 'Closed', '', 'Old Case', '2020-01-01'),
      ('BACKLEAD', NULL,   'Bankruptcy', 'Chapter 7', 'Open',   '', NULL, '2020-01-01')`);
    await q(`INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type) VALUES
      ('BACKOLD1', 9, 'Primary'), ('BACKBARE', 9, 'Primary'), ('BACKLEAD', 9, 'Primary')`);
    await q(`CREATE TABLE IF NOT EXISTS email_log (id INT PRIMARY KEY AUTO_INCREMENT, from_email VARCHAR(255), body MEDIUMTEXT)`);
    const conn = (await pool.getConnection()).connection;
    const lines = [];
    const before = await q('SELECT case_id, case_caption FROM cases');
    const check = await run(conn, { log: (l) => lines.push(l) });
    expect(check.ok).toBe(true);
    expect(await q('SELECT case_id, case_caption FROM cases')).toEqual(before);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-'));
    const applied = await run(conn, { apply: true, log: () => {}, ledgerDir: dir });
    expect(applied.line).toMatch(/^GO/);
    expect(await captionOf('BACKOLD1')).toBe('In re Old Case');
    expect(await captionOf('BACKBARE')).toBe('In re Old Case');
    expect(await captionOf('BACKLEAD')).toBeNull();
    expect(await captionOf('CAPHAND1')).toBe('In re Jane Q. Smith, Hand Typed');
    expect(JSON.parse(fs.readFileSync(applied.ledger, 'utf8')).length).toBe(applied.plan.writes.length);

    const again = await run(conn, { log: () => {} });
    expect(again.plan.writes).toEqual([]);
    await q('DROP TABLE email_log');
  });

  test('the picker flags a caption that says more than the client, and only that', async () => {
    const flag = async (term) => (await caseService.searchCases(pool, { q: term })).cases
      .reduce((o, c) => ({ ...o, [c.case_id]: c.caption_adds_info }), {});
    expect(await flag('Schneyer')).toEqual({ CAPADV01: true });
    expect(await flag('Buny')).toEqual({ CAPOTHER: true });
    expect((await flag('26-1-mar')).CAPNULL1).toBe(false);
  });
});
