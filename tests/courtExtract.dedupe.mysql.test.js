/**
 * REAL-ENGINE TWIN of tests/courtExtract.dedupe.test.js — the court_extract
 * content dedupe on MySQL with the production schema and sql_mode:
 *   M1  the migration file applied from disk, TWICE (CREATE TABLE IF NOT
 *       EXISTS), landing on utf8mb4_general_ci — the collation
 *       tests/schemaConventions.test.js enforces once ref/database.sql is
 *       regenerated;
 *   M2  two deliveries of one notice through the REAL court_extract: the
 *       first claims the hash and is processed, the second is skipped with a
 *       duplicate_of row; INSERT IGNORE's affectedRows 1/0 is what the code
 *       reads, so this is the engine-level proof of the ownership check;
 *   M3  that duplicate_of row against the REAL executor STEP 1 (the copy
 *       short-circuits as already_processed) and the queue's openness
 *       predicate (the copy can never open or close the ORIGINAL's card);
 *   M4  a Re-extract of the original (same message_id) still proceeds.
 *
 * aiService.call is the only stub (no JSON → the normal path lands on
 * logExtractFailure's real extract_failed row).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * A THROWAWAY database whose name ends in _test, loaded with ref/database.sql
 * (the court_email_hashes migration is applied BY THIS SUITE, from the file).
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3318/yc_court_test npx jest tests/courtExtract.dedupe.mysql.test.js
 * Worker run 2026-10-13: MySQL 8.0.46, all green.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const URL_  = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

// Mirror of routes/courtReview.js OPEN_QUEUE_WHERE (not exported there); the
// manual prints the same predicate. `cal` = court_ai_log.
const OPEN_QUEUE_WHERE = `
  cal.outcome = 'queued'
  AND NOT EXISTS (SELECT 1 FROM court_ai_log c2
                   WHERE c2.message_id = cal.message_id AND c2.id > cal.id
                     AND c2.dry_run = 0 AND c2.outcome IN ('executed','none'))
  AND NOT EXISTS (SELECT 1 FROM court_ai_log c3
                   WHERE c3.message_id = cal.message_id AND c3.id > cal.id
                     AND c3.outcome = 'queued')`;

maybe('court_extract content dedupe on real MySQL', () => {
  const mysql     = require('mysql2/promise');
  const aiService = require('../services/aiService');
  const fns       = require('../lib/internal_functions/court');
  const { executeCourtActions } = require('../services/courtExecutor');

  const SUBJECT = '26-43289-mlo "Final Decree and Case Closed" Ch 7';
  const BODY = 'Notice of Electronic Filing\n\nThe following transaction was entered on ' +
    '9/28/2026 at 2:46 AM EDT\nCase Number: 26-43289-mlo\nDocket Text: Final Decree.\n';

  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const realCall = aiService.call;
  const run = (messageId, overrides = {}) => fns.court_extract({
    message_id: messageId, subject: SUBJECT, from_email: 'cmecf@mieb.uscourts.gov', body: BODY, ...overrides,
  }, pool);

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    pool = mysql.createPool({
      host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database, timezone: 'Z', connectionLimit: 4, multipleStatements: true,
    });
    pool.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    // DROP first so the FILE builds the table: once ref/database.sql is
    // regenerated it already carries court_email_hashes, and IF NOT EXISTS
    // would then prove nothing about the migration itself.
    await q('DROP TABLE IF EXISTS court_email_hashes');
    const migration = fs.readFileSync(path.join(__dirname, '..', 'ref/migrations/2026-10-13_court_email_hashes.sql'), 'utf8');
    await q(migration);
    await q(migration);   // idempotent
  });
  afterAll(async () => {
    aiService.call = realCall;
    if (pool) await pool.end();
  });
  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    aiService.call = jest.fn(async () => ({ ok: false, error: 'stub_no_json', callId: null }));
    for (const t of ['court_email_hashes', 'court_ai_log']) await q(`DELETE FROM ${t}`);
    await q(`INSERT INTO app_settings (\`key\`, \`value\`) VALUES ('court_ingest_live', '1')
             ON DUPLICATE KEY UPDATE \`value\` = '1'`);
  });
  afterEach(() => jest.restoreAllMocks());

  test('M1 the migration lands on the schema collation, keyed on content_hash', async () => {
    const [t] = await q(
      `SELECT TABLE_COLLATION FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'court_email_hashes'`);
    expect(t.TABLE_COLLATION).toBe('utf8mb4_general_ci');
    const cols = await q(
      `SELECT COLUMN_NAME, COLUMN_TYPE, COLLATION_NAME, COLUMN_KEY FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'court_email_hashes' ORDER BY ORDINAL_POSITION`);
    expect(cols.map((c) => [c.COLUMN_NAME, c.COLUMN_TYPE, c.COLUMN_KEY])).toEqual([
      ['content_hash', 'char(64)', 'PRI'],
      ['message_id', 'varchar(255)', ''],
      ['created_at', 'datetime', ''],
    ]);
    expect(cols.filter((c) => c.COLLATION_NAME).every((c) => c.COLLATION_NAME === 'utf8mb4_general_ci')).toBe(true);
  });

  test('M2+M3 second delivery is skipped, satisfies STEP 1, and never touches the original card', async () => {
    const first = await run('1a0e79bab8ae5b3d');
    expect(first.output.skipped).toBe('extract_failed');           // processed normally
    const second = await run('1a0e79bcda7e5b3d');                   // the live pair, 5 s apart
    expect(second.output.skipped).toBe('duplicate_content');
    expect(second.output.duplicate_of).toBe('1a0e79bab8ae5b3d');
    expect(aiService.call).toHaveBeenCalledTimes(1);

    const hashes = await q('SELECT message_id FROM court_email_hashes');
    expect(hashes.map((h) => h.message_id)).toEqual(['1a0e79bab8ae5b3d']);

    const rows = await q('SELECT id, message_id, dry_run, outcome, review_reason, actions_json, raw_response FROM court_ai_log ORDER BY id');
    expect(rows.map((r) => [r.message_id, r.dry_run, r.outcome, r.review_reason])).toEqual([
      ['1a0e79bab8ae5b3d', 0, 'queued', 'extract_failed:stub_no_json'],
      ['1a0e79bcda7e5b3d', 0, 'none',   'duplicate_of:1a0e79bab8ae5b3d'],
    ]);
    expect(rows[1].actions_json).toBeNull();
    expect(rows[1].raw_response).toBeNull();
    expect(second.output.court_ai_log_id).toBe(rows[1].id);

    // M3a: the copy reaching the executor later short-circuits at STEP 1.
    const replay = await executeCourtActions(pool, {
      payload: { message_id: '1a0e79bcda7e5b3d', case_number: '26-43289-mlo', classification: 'case_closed', actions: [] },
      subject: SUBJECT, body: BODY, dryRun: false,
    });
    expect(replay.already_processed).toBe(true);
    expect(replay.court_ai_log_id).toBe(rows[1].id);

    // M3b: the open queue is exactly the original's card — the copy neither
    // shows up nor closes it.
    const open = await q(`SELECT cal.message_id FROM court_ai_log cal WHERE ${OPEN_QUEUE_WHERE}`);
    expect(open.map((r) => r.message_id)).toEqual(['1a0e79bab8ae5b3d']);
  });

  test('M4 a Re-extract of the original (same message_id) proceeds on the engine', async () => {
    await run('1a0e79bab8ae5b3d');
    const again = await run('1a0e79bab8ae5b3d');
    expect(again.output.skipped).toBe('extract_failed');
    expect(aiService.call).toHaveBeenCalledTimes(2);
    const reasons = (await q('SELECT review_reason FROM court_ai_log ORDER BY id')).map((r) => r.review_reason);
    expect(reasons).toEqual(['extract_failed:stub_no_json', 'extract_failed:stub_no_json']);
  });
});
