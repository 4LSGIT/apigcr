// tests/emailIngestSurrogate.mysql.test.js
//
/**
 * REAL-ENGINE twin of tests/emailIngestSurrogate.test.js: MySQL itself refuses
 * an escaped lone surrogate in a JSON column (the live 2026-10-25 error,
 * reproduced), and emailIngestService.ingestEmail now writes the same
 * over-16-KB, cut-mid-emoji envelope's executions row cleanly — the path the
 * mailbox worker took for the task-summary email that held mailbox 2's All
 * Mail from 13:01Z.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * The gated-suite protocol of tests/mailboxS2.mysql.test.js (its header): ONE
 * fresh throwaway *_test database loaded from ref/database.sql, --runInBand.
 * Run 2026-10-25: MySQL 8.0.46, all green.
 *
 * Mutation-checked: _writeExecution back to plain JSON.stringify →
 * "ingestEmail writes the cut-mid-emoji envelope's executions row" fails with
 * the production error, ER_INVALID_JSON_TEXT … "The surrogate pair in string
 * is invalid."
 */

'use strict';

process.env.EMAIL_DOMAINS = '4lsg.com';

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;

const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

maybe('lone surrogates vs MySQL JSON columns (real engine)', () => {
  const mysql = require('mysql2/promise');
  const svc = require('../services/emailIngestService');

  const EMOJI = '\u{1F4CB}';
  const CUT = svc.RAW_INPUT_LIMIT - 200;
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  /** Over the limit, with the emoji's first half as the preview's last code unit. */
  function envelopeCutMidPair(mid) {
    const env = (n) => ({
      kind: 'email', source: 'gmail-firm',
      from: { email: 'automations@4lsg.com', name: 'Automations' },
      to: [{ email: 'stuart@4lsg.com', name: '' }],
      subject: 'Your Task Summary',
      headers: { message_id: mid },
      text: 'a'.repeat(n) + EMOJI + 'b'.repeat(4000),
    });
    const base = JSON.stringify(env(0)).indexOf(EMOJI);
    const e = env(CUT - 1 - base);
    if (JSON.stringify(e).charCodeAt(CUT - 1) !== EMOJI.charCodeAt(0)) throw new Error('fixture does not cut mid-pair');
    return e;
  }

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    pool = mysql.createPool({
      host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database, timezone: 'Z', connectionLimit: 4,
    });
    pool.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
  });
  afterAll(async () => { if (pool) await pool.end(); });
  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (const t of ['email_ingest_executions', 'email_log', 'email_ingest_rules', 'email_ingest_log_suppressions', 'email_ingest_sources']) await q(`DELETE FROM ${t}`);
    await q("INSERT INTO email_ingest_sources (id, name, api_key, active) VALUES (1, 'gmail-firm', 'test-not-a-key', 1)"); // secret-scan: allow
  });
  afterEach(() => jest.restoreAllMocks());

  test('the engine refuses an escaped lone surrogate — the production error, reproduced', async () => {
    const raw = svc._truncateRawInput(envelopeCutMidPair('repro@4lsg.com'));
    await expect(q(
      "INSERT INTO email_ingest_executions (source_id, message_id, status, raw_input) VALUES (1, 'repro', 'skipped_firm_to_firm', ?)",
      [JSON.stringify(raw)]
    )).rejects.toMatchObject({ code: 'ER_INVALID_JSON_TEXT', message: expect.stringMatching(/The surrogate pair in string is invalid/) });
  });

  test('ingestEmail writes the cut-mid-emoji envelope\'s executions row (firm-to-firm, as live)', async () => {
    const r = await svc.ingestEmail(pool, { id: 1, name: 'gmail-firm' }, envelopeCutMidPair('task-summary-1@4lsg.com'), null);
    expect(r.status).toBe('skipped_firm_to_firm');
    const [row] = await q('SELECT status, raw_input FROM email_ingest_executions WHERE id = ?', [r.executionId]);
    expect(row.status).toBe('skipped_firm_to_firm');
    expect(row.raw_input._truncated).toBe(true);
    expect(row.raw_input.preview).toHaveLength(CUT);
    expect(row.raw_input.preview.slice(-1)).toBe('�');
    expect(row.raw_input.preview.isWellFormed()).toBe(true);
    // a retry (the worker's next tick) is the duplicate path — it writes too
    const again = await svc.ingestEmail(pool, { id: 1, name: 'gmail-firm' }, envelopeCutMidPair('task-summary-1@4lsg.com'), null);
    expect(again.status).toBe('duplicate');
  });
});
