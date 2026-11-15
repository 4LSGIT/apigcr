// tests/caseyQueryDbColumns.mysql.test.js
//
/**
 * A17.4a / A17.4b normalizer SQL on REAL MySQL.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a174_test npx jest tests/caseyQueryDbColumns.mysql.test.js --runInBand
 * The database name must end in _test and the port must not be 3306 (on a dev
 * machine that is production). This suite DROPS and recreates cases,
 * case_relate and credentials in it (and drops job_results, rebuilt by none) — only the columns the normalizers read,
 * with the live types (ref/database.sql) — on ONE connection with
 * FOREIGN_KEY_CHECKS=0 for the drop/create, because a sibling twin may have
 * built a table whose real FK points at credentials (hook_targets,
 * phone_lines, email_credentials).
 *
 * WHAT IS LOCKED (the two reads the stub suites cannot prove):
 *   - query_db's live-column check: the information_schema read returns the
 *     aliased table_name / column_name keys on the engine (MySQL 8 returns
 *     I_S column names upper-case unless aliased), scoped to DATABASE(), in
 *     ORDINAL order — a real column passes, a misspelled one is refused with
 *     the table's real readable columns, a blocked one is refused;
 *   - the credentials read: allowed_urls is a JSON column, which mysql2
 *     returns already PARSED (an array, not a string) — the webhook pairing
 *     rule and checkUrlScope must both read it that way.
 *
 * The one query routed to a stub is the draft kind's workflow-name collision
 * SELECT (covered by tests/caseyWorkflowDraft.test.js; `workflows` carries
 * real FKs from three tables, so this suite does not rebuild it). The module
 * under test is not mocked.
 */
'use strict';

const mysql = require('mysql2/promise');
const svc = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

d('A17.4a/b normalizer reads on real MySQL', () => {
  let conn;
  let db;
  const q = async (sql, p) => (await conn.query(sql, p))[0];

  beforeAll(async () => {
    const u = new URL(URL_);
    if (!/_test$/.test(u.pathname.slice(1))) throw new Error(`refusing to run against "${u.pathname.slice(1)}"`);
    if (u.port === '3306' || u.port === '') throw new Error('refusing port 3306: on a dev machine that is production');
    conn = await mysql.createConnection({ uri: URL_, timezone: 'Z' });
    await q(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`);
    await q('SET FOREIGN_KEY_CHECKS = 0');
    // job_results is DROPPED and not rebuilt: the absent-table test needs one
    // allowlisted table this DB lacks, whatever a sibling twin left behind.
    for (const t of ['case_relate', 'cases', 'credentials', 'job_results']) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q(`CREATE TABLE cases (
      case_id varchar(20) NOT NULL PRIMARY KEY, case_number varchar(20) DEFAULT NULL,
      case_status varchar(50) NOT NULL, case_open_date date DEFAULT NULL,
      custom json NOT NULL DEFAULT (json_object())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`CREATE TABLE case_relate (
      case_relate_id int unsigned NOT NULL PRIMARY KEY, case_relate_case_id varchar(8) NOT NULL,
      case_relate_client_id int unsigned NOT NULL,
      case_relate_type enum('Primary','Secondary','Other','Bystander') NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`CREATE TABLE credentials (
      id int NOT NULL PRIMARY KEY, name varchar(255) NOT NULL,
      type enum('internal','bearer','api_key','basic','oauth2') NOT NULL DEFAULT 'internal',
      config json DEFAULT NULL, allowed_urls json DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q('SET FOREIGN_KEY_CHECKS = 1');
    await q(`INSERT INTO credentials (id, name, type, config, allowed_urls) VALUES
      (3, 'Zap Key', 'bearer', JSON_OBJECT('token', 'fixture-value'), JSON_ARRAY('https://hooks.zapier.com/*')),
      (4, 'Loose Bearer', 'bearer', NULL, NULL)`);
    db = { query: (sql, p) => (/SELECT id FROM workflows WHERE name/.test(sql) ? Promise.resolve([[]]) : conn.query(sql, p)) };
  });
  afterAll(async () => { if (conn) await conn.end(); });

  const draft = (steps) => ({ kind: 'workflow.draft.v1', name: 'Twin', description: '', steps, evidence: [] });
  const qdb = (params) => ({ type: 'internal_function', config: { function_name: 'query_db', params } });

  test('the session runs prod\'s relaxed mode', async () => {
    const [{ m }] = await q('SELECT @@SESSION.sql_mode m');
    expect(m).not.toMatch(/STRICT_TRANS_TABLES|ONLY_FULL_GROUP_BY|NO_BACKSLASH_ESCAPES/);
  });

  test('real columns pass — joined under an alias, the engine\'s I_S keys read through the aliases', async () => {
    const out = await svc.normalizeActionDraft(db, draft([qdb({
      select: ['cases.case_number', 'cr.case_relate_type'], from: 'cases',
      join: [{ table: 'case_relate', alias: 'cr', on: { left: 'cases.case_id', right: 'cr.case_relate_case_id' } }],
      where: [{ column: 'cases.case_status', op: '=', value: 'Open' }],
    })]), []);
    expect(out.steps[0].query.columns).toEqual(['cases.case_number', 'cr.case_relate_type']);
  });

  test('a misspelled column is refused naming the REAL readable columns in table order; a blocked one is refused', async () => {
    await expect(svc.normalizeActionDraft(db, draft([qdb({ select: ['cases.case_numbr'], from: 'cases' })]), []))
      .rejects.toThrow(/cases has no column "case_numbr"\. Its columns: case_id, case_number, case_status, case_open_date$/);
    await expect(svc.normalizeActionDraft(db, draft([qdb({ select: ['cases.custom'], from: 'cases' })]), []))
      .rejects.toThrow(/blocked column/);
  });

  test('a table the database lacks is refused, not passed through (scoped to DATABASE())', async () => {
    // job_results is on query_db's allowlist; the before-hook dropped it.
    await expect(svc.normalizeActionDraft(db, draft([qdb({ select: ['job_results.id'], from: 'job_results' })]), []))
      .rejects.toThrow(/query_db table job_results has no columns in this database/);
  });

  test('credentials.allowed_urls arrives parsed from the JSON column; pairing and the run-time scope both read it', async () => {
    const url = 'https://hooks.zapier.com/hooks/catch/1/abc';
    const out = await svc.normalizeActionDraft(db, draft([{ type: 'webhook', config: { url, method: 'POST', credential: 'Zap Key' } }]), [],
      { question: `post to ${url} with the Zap Key credential` });
    expect(out.steps[0].config.credential_id).toBe(3);
    expect(JSON.stringify(out)).not.toContain('fixture-value');
    // Host evidence from the stored pattern alone (no URL typed).
    const viaCred = await svc.normalizeActionDraft(db, draft([{ type: 'webhook', config: { url: 'https://hooks.zapier.com/x', method: 'POST' } }]), [],
      { question: 'add a zapier call' });
    expect(viaCred.steps[0].webhook.url_source).toBe('host named by the allowed URLs of credential "Zap Key"');
    await expect(svc.normalizeActionDraft(db, draft([{ type: 'webhook', config: { url: 'https://other.example.com/x', method: 'POST', credential: 'Zap Key' } }]), [],
      { question: 'post to https://other.example.com/x with Zap Key' })).rejects.toThrow(/would refuse this URL/);
    await expect(svc.normalizeActionDraft(db, draft([{ type: 'webhook', config: { url, method: 'POST', credential: 'Loose Bearer' } }]), [],
      { question: `post to ${url} with Loose Bearer` })).rejects.toThrow(/never pairs a credential with a new host/);
  });
});
