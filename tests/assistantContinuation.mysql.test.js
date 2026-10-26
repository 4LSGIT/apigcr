// tests/assistantContinuation.mysql.test.js
//
// R1 read-loop continuation on a REAL engine.
//
// ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
//   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3326/yc_r1_test \
//     npx jest tests/assistantContinuation.mysql.test.js --runInBand
// The database name must end in _test; the suite DROPs and recreates its
// tables FROM ref/database.sql (live types), and every read runs on a
// least-privilege report account the way scripts/reportGrantUserProvision
// builds one. Never point it at 3306.
//
// WHAT IS LOCKED (the parts tests/assistantContinuation.test.js fakes)
//   - The chat binding is the real ownership predicate on assistant_chats
//     (user_id tinyint): the owner's chat resumes, another user naming the
//     same chat is refused, a deleted chat refuses the continuation.
//   - The spend cap is the real month-to-date SUM over ai_calls: a
//     continuation past the cap is a 429 before any model call.
//   - Evidence read by the engine (mysql2 returns DATETIME as a Date) crosses
//     the seal intact and the resumed answer cites rows from both segments.
// Models are stubbed at aiService.call; nothing calls a real model.

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

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const REPO = path.join(__dirname, '..');
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['users', 'contacts', 'report_runs', 'app_settings', 'ai_calls', 'assistant_chats', 'assistant_chat_messages'];
const SECRET = 'assistant-continuation-mysql-secret';
const RO_USER = 'yc_r1_report_test';
const RO_PASS = 'scratch-only-not-a-secret'; // secret-scan: allow

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

d('R1 continuation on a real engine', () => {
  const svc = require('../services/assistantService');
  const aiService = require('../services/aiService');
  const assistantTicket = require('../lib/assistantTicket');
  let pool;
  let roPool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const OLD_SECRET = process.env.JWT_SECRET;
  const AUTH = { type: 'jwt', userId: 7 };
  const read = (n) => ({ id: 'q1', kind: 'sql.read', purpose: `Contact ${n}`,
    sql: `SELECT contact_id, contact_name, contact_created FROM contacts WHERE contact_id = ${n} LIMIT 5` });

  function scriptAi({ investigate = [], answer = [] }) {
    const queues = { assistant_investigate: [...investigate], assistant_answer: [...answer] };
    return jest.spyOn(aiService, 'call').mockImplementation(async (_db, opts) => {
      const next = (queues[opts.promptKey] || []).shift();
      if (!next) throw new Error(`unscripted ${opts.promptKey} call`);
      return { usage: { input_tokens: 1000, output_tokens: 100 }, callId: 1, ...next };
    });
  }
  const queryOf = (n) => ({ ok: true, json: { action: 'query', summary: `Contact ${n}`, steps: [read(n)] } });

  async function stoppedOnRounds(chatId) {
    const plan = svc.validatePlan({ action: 'query', summary: 'First', steps: [read(1)] });
    const signedTicket = assistantTicket.sign({ v: 1, uid: 7, question: 'Tell me about contacts one to four', history: [], plan: { action: 'query', ...plan } });
    scriptAi({ investigate: [queryOf(2), queryOf(3)], answer: [{ ok: true, json: { answer: 'Stopped.', citations: [] } }] });
    const out = await svc.execute(pool, { signedTicket, chatId, userId: 7, auth: AUTH });
    jest.restoreAllMocks();
    return out;
  }

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    const url = new URL(URL_);
    const dbName = url.pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (url.port === '3306' || url.port === '') throw new Error('refusing port 3306 — that is production');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    const dumpLines = fs.readFileSync(path.join(REPO, 'ref/database.sql'), 'utf8').split('\n');
    for (const t of [...TABLES].reverse()) await q(`DROP TABLE IF EXISTS \`${t}\``);
    for (const t of TABLES) {
      const blocks = dumpBlocks(dumpLines, t);
      if (!blocks.length) throw new Error(`ref/database.sql has no CREATE TABLE for ${t}`);
      for (const b of blocks) await pool.query(b);
    }
    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth, user_type) VALUES
      (7, 'seven', 'Staff Seven', 'S', 'Seven', 'SS7', 'authorized', 1), (8, 'eight', 'Staff Eight', 'S', 'Eight', 'SS8', 'authorized', 1)`);
    await q(`INSERT INTO contacts (contact_id, contact_fname, contact_lname, contact_name, contact_kind, contact_created) VALUES
      (1, 'Pat', 'One', 'Pat One', 'person', '2026-01-02 03:04:05'), (2, 'Sam', 'Two', 'Sam Two', 'person', '2026-02-03 04:05:06'),
      (3, 'Lee', 'Three', 'Lee Three', 'person', '2026-03-04 05:06:07'), (4, 'Kim', 'Four', 'Kim Four', 'person', '2026-04-05 06:07:08')`);
    await q("INSERT INTO assistant_chats (id, user_id, title, model_mode) VALUES (41, 7, 'Seven''s chat', 'better_quality'), (42, 8, 'Eight''s chat', 'better_quality')");

    const manifest = require('../lib/reportSchema/manifest');
    await q(`DROP USER IF EXISTS '${RO_USER}'@'%'`);
    await q(`CREATE USER '${RO_USER}'@'%' IDENTIFIED BY '${RO_PASS}'`);
    for (const t of TABLES.filter((x) => manifest.isAllowedTable(x))) {
      const cols = (await q('SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [dbName, t]))
        .map((r) => r.c).filter((c) => !manifest.isDeniedColumn(c));
      await q(`GRANT SELECT (${cols.map((c) => `\`${c}\``).join(', ')}) ON \`${dbName}\`.\`${t}\` TO '${RO_USER}'@'%'`);
    }
    roPool = mysql.createPool({ host: url.hostname, port: Number(url.port), user: RO_USER, password: RO_PASS, database: dbName,
      connectionLimit: 2, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false });
    roPool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    mockReportPool.pool = roPool;
  });

  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(async () => {
    if (OLD_SECRET === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = OLD_SECRET;
    if (roPool) await roPool.end();
    if (pool) { await q(`DROP USER IF EXISTS '${RO_USER}'@'%'`).catch(() => {}); await pool.end(); }
  });

  test('the owner resumes in the bound chat; Date evidence crosses the seal; citations span both segments', async () => {
    const first = await stoppedOnRounds(41);
    expect(first.investigation).toMatchObject({ stop_reason: 'round_budget', continuable: true });
    const ai = scriptAi({ investigate: [queryOf(4), { ok: true, json: { action: 'finish' } }], answer: [{ ok: true, json: {
      answer: 'One through four.', citations: [{ query_id: 'q1', row_number: 1, label: 'first' }, { query_id: 'q4', row_number: 1, label: 'resumed' }] } }] });
    const out = await svc.execute(pool, { continuation: first.continuation, chatId: 41, userId: 7, auth: AUTH });
    expect(out.sources.map((s) => [s.query_id, s.row.contact_name, s.row.contact_created])).toEqual([
      ['q1', 'Pat One', '2026-01-02T03:04:05.000Z'], ['q4', 'Kim Four', '2026-04-05T06:07:08.000Z']]);
    expect(ai.mock.calls[0][1].userInput).toMatch(/2026-03-04T05:06:07\.000Z/); // round-3 evidence, carried
    // report_runs is a fire-and-forget insert: wait for it to settle, then
    // require exactly three reads plus ONE more — nothing was re-read.
    let runs = 0;
    for (let i = 0; i < 40 && runs < 4; i++) {
      runs = Number((await q("SELECT COUNT(*) n FROM report_runs WHERE report_key = 'assistant_chat'"))[0].n);
      if (runs < 4) await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 150));
    expect(Number((await q("SELECT COUNT(*) n FROM report_runs WHERE report_key = 'assistant_chat'"))[0].n)).toBe(4);
  });

  test('another user naming the bound chat is refused by the ownership predicate', async () => {
    const first = await stoppedOnRounds(41);
    const ai = jest.spyOn(aiService, 'call');
    await expect(svc.execute(pool, { continuation: first.continuation, chatId: 41, userId: 8, auth: { type: 'jwt', userId: 8 } }))
      .rejects.toMatchObject({ status: 404 });
    await expect(svc.execute(pool, { continuation: first.continuation, chatId: 42, userId: 8, auth: { type: 'jwt', userId: 8 } }))
      .rejects.toMatchObject({ status: 403 });
    expect(ai).not.toHaveBeenCalled();
  });

  test('a deleted chat refuses its continuation', async () => {
    await q("INSERT INTO assistant_chats (id, user_id, title, model_mode) VALUES (43, 7, 'Doomed', 'better_quality')");
    const first = await stoppedOnRounds(43);
    await q('DELETE FROM assistant_chats WHERE id = 43');
    await expect(svc.execute(pool, { continuation: first.continuation, chatId: 43, userId: 7, auth: AUTH })).rejects.toMatchObject({ status: 404 });
  });

  test('the real month-to-date spend sum gates a continuation', async () => {
    const first = await stoppedOnRounds(41);
    await q(`INSERT INTO ai_calls (prompt_key, model, mode, output_type, consumer_ref, status, cost_cents, created_at)
      VALUES ('assistant_answer', 'claude-opus-5', 'live', 'json', 'assistant_answer:u7', 'ok', 999999, UTC_TIMESTAMP())`);
    const ai = jest.spyOn(aiService, 'call');
    await expect(svc.execute(pool, { continuation: first.continuation, chatId: 41, userId: 7, auth: AUTH })).rejects.toMatchObject({ status: 429 });
    expect(ai).not.toHaveBeenCalled();
    await q("DELETE FROM ai_calls WHERE consumer_ref = 'assistant_answer:u7'");
  });
});
