// Casey v2 S1 — sql_read on a REAL MySQL 8.4 (own *_test DB; gated on
// YC_TEST_MYSQL_URL, skipped otherwise):
//
//   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3379/yc_casey_sqlread_test \
//     npx jest tests/caseySqlRead.mysql.test.js --runInBand
//
// The report pool (startup/dbReport) is replaced by a pool on the same DB
// (the yc_report ACCOUNT boundary was proven by v1's assistantContinuation
// twin, retired at S6 — ref/plans.md; this twin proves the rule layer, the real EXPLAIN gate and
// LIMIT, the report_runs rows and the row types mysql2 returns). Tables
// report_runs, contacts and log are built from ref/database.sql as it stands
// (CREATE TABLE only — no triggers, so no tz tables needed); contacts' many
// NOT NULL columns are filled by the relaxed production sql_mode, as live.
// Own DB: this twin drops and rebuilds those three tables.
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const mockReportPool = { pool: null };
jest.mock('../startup/dbReport', () => ({
  getConnection: (...args) => {
    if (!mockReportPool.pool) throw new Error('report pool not ready');
    return mockReportPool.pool.getConnection(...args);
  },
}));

const tools = require('../services/casey/tools');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const suite = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

function ddl(table) {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`CREATE TABLE \`${table}\``));
  if (start < 0) throw new Error(`${table} missing from ref/database.sql`);
  const end = lines.findIndex((l, i) => i > start && /^\) ENGINE=.*;$/.test(l));
  return lines.slice(start, end + 1).join('\n');
}

suite('sql_read — real engine', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const runs = async () => q('SELECT report_key, run_by, params_json, sql_text, row_count, status, error_text FROM report_runs ORDER BY id');
  const ctx = () => ({ db: pool, auth: { type: 'jwt', userId: 6, username: 'IT', roles: ['su'] }, app: null, headers: {}, port: 0, via: 'test' });
  const run = (input) => tools.runTool('sql_read', ctx(), input);

  beforeAll(async () => {
    const url = new URL(URL_);
    if (!/_test$/.test(url.pathname) || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Own local *_test DB required');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 3, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    mockReportPool.pool = pool;
    for (const t of ['report_runs', 'contacts', 'log']) { await q(`DROP TABLE IF EXISTS \`${t}\``); await q(ddl(t)); }
    await q('ALTER TABLE report_runs MODIFY id bigint unsigned NOT NULL AUTO_INCREMENT, ADD PRIMARY KEY (id)');
    await q('ALTER TABLE contacts ADD PRIMARY KEY (contact_id)');
    await q('ALTER TABLE log ADD PRIMARY KEY (log_id)');
    for (let i = 1; i <= 6; i++) await q('INSERT INTO contacts (contact_id, contact_type, contact_name, contact_fname, contact_lname, contact_ssn, contact_notes) VALUES (?,?,?,?,?,?,?)', [i, 'Client', `Person ${i}`, 'P', `L${i}`, `000-00-000${i}`, 'note password here']);
    await q("INSERT INTO log (log_id, log_type, log_date, log_link, log_by, log_data, log_message) VALUES (1,'note','2026-01-05 10:00:00','contact:1',6,'d','old'), (2,'note','2026-11-01 10:00:00','contact:1',6,'d','new')");
  });
  afterAll(async () => { if (pool) await pool.end(); });
  beforeEach(async () => { await q('DELETE FROM report_runs'); });

  test('an allowed SELECT returns real rows, the LIMIT bounds them, and ONE report_runs row records the run with the SQL (as v1)', async () => {
    const r = await run({ sql: 'SELECT contact_id, contact_name FROM contacts ORDER BY contact_id LIMIT 3', purpose: 'first three' });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ columns: ['contact_id', 'contact_name'], row_count: 3, truncated: false, tables: ['contacts'] });
    expect(r.data.rows).toEqual([{ contact_id: 1, contact_name: 'Person 1' }, { contact_id: 2, contact_name: 'Person 2' }, { contact_id: 3, contact_name: 'Person 3' }]);
    await new Promise((res) => setTimeout(res, 50)); // logRun is fire-and-forget
    const rows = await runs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ report_key: 'casey_v2', run_by: 6, sql_text: 'SELECT contact_id, contact_name FROM contacts ORDER BY contact_id LIMIT 3', row_count: 3, status: 'success', error_text: null });
    expect(rows[0].params_json).toEqual({ purpose: 'first three' });
  });

  test('a string-literal mention of a denied name is allowed; a real reference is refused with NO run row', async () => {
    const ok = await run({ sql: "SELECT contact_id FROM contacts WHERE contact_notes LIKE '%password%' ORDER BY contact_id LIMIT 250" });
    expect(ok.ok).toBe(true);
    expect(ok.data.row_count).toBe(6);
    const no = await run({ sql: 'SELECT contact_id, contact_ssn FROM contacts LIMIT 1' });
    expect(no).toMatchObject({ ok: false, error: { code: 'SQL_REFUSED', message: 'Query asks for a field Casey may not read: contact_ssn' } });
    await new Promise((res) => setTimeout(res, 50));
    expect((await runs()).map((x) => x.status)).toEqual(['success']);
  });

  test('log needs a lower date bound; with one, mysql2 hands back a DATETIME as a Date', async () => {
    const no = await run({ sql: 'SELECT log_id FROM log LIMIT 5' });
    expect(no).toMatchObject({ ok: false, error: { code: 'SQL_REFUSED', message: 'Query must put a concrete lower date bound on log.log_date' } });
    const yes = await run({ sql: "SELECT log_id, log_date, log_type FROM log WHERE log_date >= '2026-06-01' LIMIT 5" }); // manifest columns only (log_message is not one)
    expect(yes.ok).toBe(true);
    expect(yes.data.rows).toHaveLength(1);
    expect(yes.data.rows[0].log_id).toBe(2);
    expect(yes.data.rows[0].log_date).toBeInstanceOf(Date);
    expect(yes.data.rows[0].log_date.toISOString()).toBe('2026-11-01T10:00:00.000Z');
    await new Promise((res) => setTimeout(res, 50));
    expect((await runs()).map((x) => x.status)).toEqual(['success']);
  });

  test('no trailing LIMIT, a non-manifest table and a write are refused before the engine; no run row', async () => {
    for (const sql of ['SELECT contact_id FROM contacts', 'SELECT * FROM report_runs LIMIT 1', 'UPDATE contacts SET contact_name = 1 LIMIT 1', 'SELECT contact_id FROM contacts LIMIT 251']) {
      const r = await run({ sql });
      expect([sql, r.ok, r.error && r.error.code]).toEqual([sql, false, 'SQL_REFUSED']);
    }
    await new Promise((res) => setTimeout(res, 50));
    expect(await runs()).toEqual([]);
    expect((await q('SELECT contact_name FROM contacts WHERE contact_id = 1'))[0].contact_name).toBe('Person 1');
  });

  test('an engine error (unknown column) is SQL_FAILED and logged as error', async () => {
    const r = await run({ sql: 'SELECT nope FROM contacts LIMIT 1' });
    expect(r).toMatchObject({ ok: false, error: { code: 'SQL_FAILED', message: expect.stringMatching(/Unknown column 'nope'/) } });
    await new Promise((res) => setTimeout(res, 50));
    const rows = await runs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ report_key: 'casey_v2', status: 'error', sql_text: 'SELECT nope FROM contacts LIMIT 1' });
    expect(rows[0].error_text).toMatch(/Unknown column/);
  });

  test('the real EXPLAIN gate: an 8-way self join of 6 rows (~1.7M rows examined) is refused as too large and logged so', async () => {
    const sql = 'SELECT a.contact_id FROM contacts a, contacts b, contacts c, contacts d, contacts e, contacts f, contacts g, contacts h LIMIT 1';
    const r = await run({ sql });
    expect(r).toMatchObject({ ok: false, error: { code: 'SQL_FAILED', message: expect.stringMatching(/estimates too much work/) } });
    await new Promise((res) => setTimeout(res, 50));
    const rows = await runs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'rejected_too_large' });
    expect(rows[0].error_text).toMatch(/estimated \d+ rows examined/);
  });

  test('a LIMIT inside a comment is refused before the engine (MySQL would run the statement unbounded)', async () => {
    const r = await run({ sql: 'SELECT contact_id FROM contacts -- LIMIT 2' });
    expect(r).toMatchObject({ ok: false, error: { code: 'SQL_REFUSED', message: 'Query must end with LIMIT 1-250' } });
    await new Promise((res) => setTimeout(res, 50));
    expect(await runs()).toEqual([]);
  });
});
