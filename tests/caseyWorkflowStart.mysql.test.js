// tests/caseyWorkflowStart.mysql.test.js
//
/**
 * A17.7 on REAL MySQL: the workflow.start.v1 normalizer's SQL, and the
 * shipped browser builder's request — with the card's draft_id as
 * Idempotency-Key — through the real routes/workflows.js router, the real
 * lib/withTransaction, the real lib/requestIdempotency against a real
 * request_idempotency table, and a real InnoDB engine.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a177_test npx jest tests/caseyWorkflowStart.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates the
 * tables below in it, cloned line-by-line from ref/database.sql (live types,
 * keys; FKs kept only between cloned tables). Never point it at port 3306
 * (the production proxy).
 *
 * WHY A REAL ENGINE (course correction 5): the in-flight predicate runs
 * against the real status ENUM (a typo'd literal matches nothing, silently);
 * the code-mode refusal reads a real JSON column that mysql2 returns PARSED;
 * the published-vs-draft version pin is a real composite key; AVG() comes
 * back as a DECIMAL string; and the start's claim/settle/replay is the real
 * unique key (user_id, scope, idem_key) — the second request of a key must
 * hit ER_DUP_ENTRY on the engine, not on a fake.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = { type: 'jwt', userId: 6, roles: ['staff'], username: 'IT' }; next(); }));
// The detached advance is the fan-out itself — recorded, never run.
jest.mock('../lib/workflow_engine', () => {
  const actual = jest.requireActual('../lib/workflow_engine');
  return { ...actual, advanceWorkflow: jest.fn(async () => ({ status: 'completed' })) };
});

const { withTransaction } = require('../lib/withTransaction');
const { advanceWorkflow } = require('../lib/workflow_engine');
const { normalizeActionDraft } = require('../services/assistantService');
const automationReadService = require('../services/automationReadService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
// Every workflow table with an FK into workflows / workflow_executions is
// built (and so dropped first), so a shared _test DB holds no orphan FK a
// sibling twin (caseyWorkflowSend: workflows + workflow_steps) cannot drop.
// "What normally starts it" (automationReadService.references, its own
// suites' SQL) is stubbed: this suite is about the start predicates.
const TABLES = ['workflows', 'workflow_versions', 'workflow_steps', 'workflow_executions', 'workflow_execution_steps', 'request_idempotency'];

// Line-based extraction (column COMMENTs may hold ';'). Constraint clauses
// that reference a table outside TABLES are dropped.
function schemaFor(tables) {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8').split('\n');
  const creates = [];
  const alters = [];
  for (let i = 0; i < lines.length; i++) {
    for (const t of tables) {
      if (lines[i].startsWith(`CREATE TABLE \`${t}\` (`)) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/^\) ENGINE=.*;$/.test(lines[i])) break; }
        creates.push(buf.join('\n'));
      } else if (lines[i] === `ALTER TABLE \`${t}\``) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/;\s*$/.test(lines[i])) break; }
        const head = buf[0];
        const clauses = buf.slice(1).map((l) => l.replace(/[,;]\s*$/, ''))
          .filter((l) => { const m = /REFERENCES `([a-z_]+)`/.exec(l); return !m || tables.includes(m[1]); });
        if (clauses.length) alters.push(`${head}\n${clauses.join(',\n')};`);
      }
    }
  }
  if (creates.length !== tables.length) throw new Error(`schema extraction found ${creates.length} CREATE blocks`);
  alters.sort((a, b) => /FOREIGN KEY/.test(a) - /FOREIGN KEY/.test(b));
  return { creates, alters };
}

// The SHIPPED browser builder, extracted from public/assistant.html.
function browserBuilder() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
  const m = /function\s+workflowStartRequest\s*\(/.exec(html);
  let depth = 0;
  let end = -1;
  for (let i = html.indexOf('{', m.index); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`${html.slice(m.index, end)}; return workflowStartRequest;`)();
}

d('A17.7 workflow start on real MySQL', () => {
  let pool;
  let server;
  let port;
  let loseCommitAck = false;
  const buildRequest = browserBuilder();
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  const call = (request, headers = {}) => new Promise((resolve, reject) => {
    const data = JSON.stringify(request.body);
    const req = http.request({ port, path: request.path, method: request.method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => { let body = {}; try { body = JSON.parse(out || '{}'); } catch { body = { raw: out }; } resolve({ status: res.statusCode, body }); });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });

  const evidenceFor = (id) => [{ id: 'q1', label: `Workflow ${id}`, rows: [{ workflow_id: id, row_number: 1 }] }];
  const card = (id) => normalizeActionDraft(pool, {
    kind: 'workflow.start.v1', workflow_id: id, evidence: [{ query_id: 'q1', row_number: 1 }],
  }, evidenceFor(id));
  const runsOf = async (id) => q('SELECT id, status, workflow_version, contact_id, init_data FROM workflow_executions WHERE workflow_id = ? ORDER BY id', [id]);

  // Published v2 (two steps, a send among them) + draft v3 whose only step is
  // standard-mode code — the card must review v2 and never see v3. Step JSON
  // is inserted with keys in an order MySQL re-orders on write.
  async function seedWorkflow(id, { active = 1, current = 2, draft = 3, published } = {}) {
    await q('INSERT INTO workflows (id, name, active, current_version, draft_version) VALUES (?, ?, ?, ?, ?)', [id, `wf${id}`, active, current, draft]);
    const steps = published || [
      { type: 'internal_function', config: { params: { text: 'for {{day}}', output_var: 'logged' }, function_name: 'create_log' } },
      { type: 'internal_function', config: { params: { body: '{{logged}}', to: 'staff@4lsg.com' }, function_name: 'send_email' } },
    ];
    for (const [i, s] of steps.entries()) {
      await q('INSERT INTO workflow_steps (workflow_id, version, step_number, type, config) VALUES (?, ?, ?, ?, ?)',
        [id, current, i + 1, s.type, JSON.stringify(s.config)]);
    }
    if (draft != null) {
      await q('INSERT INTO workflow_steps (workflow_id, version, step_number, type, config) VALUES (?, ?, 1, \'custom_code\', ?)',
        [id, draft, JSON.stringify({ code: 'return 1' })]);
    }
  }

  beforeAll(async () => {
    jest.spyOn(automationReadService, 'references').mockImplementation(async (_db, { workflow_id }) =>
      [{ source: 'hook', workflow_id, source_id: 5, source_name: 'Intake hook', active: true }]);
    for (const m of ['log', 'error']) jest.spyOn(console, m).mockImplementation(() => {});
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    // A switchable lost commit acknowledgement: the real transaction commits,
    // then the caller is told it failed — the case the kept claim exists for.
    pool.withTransaction = async (fn, opts) => {
      const out = await withTransaction(pool, fn, opts);
      if (loseCommitAck) throw Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST' });
      return out;
    };
    await q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...TABLES].reverse()) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q('SET FOREIGN_KEY_CHECKS = 1');
    const { creates, alters } = schemaFor(TABLES);
    for (const sql of creates) await q(sql);
    for (const sql of alters) await q(sql);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/workflows.js'));
    server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    port = server.address().port;
  });
  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (pool) await pool.end();
    jest.restoreAllMocks();
  });
  beforeEach(() => { advanceWorkflow.mockClear(); loseCommitAck = false; });

  test('the card reads the PUBLISHED version and counts in-flight runs by the real status enum', async () => {
    await seedWorkflow(1);
    // Every enum value once, on two versions: the five live states count, the four terminal ones do not.
    for (const [status, v] of [['pending', 2], ['active', 2], ['processing', 1], ['delayed', 2], ['held', 1],
      ['completed', 2], ['completed_with_errors', 2], ['failed', 1], ['cancelled', 2]]) {
      await q('INSERT INTO workflow_executions (workflow_id, status, workflow_version, steps_executed_count) VALUES (1, ?, ?, 3)', [status, v]);
    }
    // One run older than the 90-day window: in flight, but not in recent volume.
    await q('INSERT INTO workflow_executions (workflow_id, status, workflow_version, steps_executed_count, created_at) VALUES (1, \'held\', 2, 9, NOW() - INTERVAL 100 DAY)');
    const c = await card(1);
    expect(c).toMatchObject({ kind: 'workflow.start.v1',
      workflow: { workflow_id: 1, version: 2, step_count: 2, has_draft: 1, active: 1 },
      in_flight_count: 6, recent: { runs_90d: 9, avg_steps: 3 }, expected: { current_version: 2 },
      starters: [{ source: 'hook', name: 'Intake hook', active: 1 }] });
    expect(c.effects).toEqual(['step 2: send_email — external-send: messages staff@4lsg.com on this run']);
    expect(c.unset_inputs).toEqual(['day']);                            // `logged` is stored by step 1
    const [stored] = await q('SELECT config FROM workflow_steps WHERE workflow_id = 1 AND version = 2 AND step_number = 1');
    expect(typeof stored.config).toBe('object');                        // parsed by mysql2
  });

  test('standard-mode code in the published version refuses on the real JSON column; safe mode starts', async () => {
    for (const [id, config] of [[2, { code: 'return 1' }], [3, { code_mode: 'standard', code: 'return 1' }]]) {
      await seedWorkflow(id, { draft: null, published: [{ type: 'custom_code', config }] });
      await expect(card(id)).rejects.toThrow(/published version contains standard-mode code step 1/);
    }
    await seedWorkflow(4, { draft: null, published: [{ type: 'custom_code', config: { input: {}, code_mode: 'safe', code: '1' } }] });
    await expect(card(4)).resolves.toMatchObject({ effects: ['step 1: safe-mode code (sandboxed — no network, no database)'] });
    // A draft's standard code does not block a start of the clean published version.
    await seedWorkflow(5);
    await expect(card(5)).resolves.toMatchObject({ workflow: { version: 2, has_draft: 1 } });
  });

  test('the card starts ONE run through the real route; the same key replays it and never starts a second', async () => {
    await seedWorkflow(10);
    const c = await card(10);
    const request = buildRequest(c);
    expect(request).toEqual({ path: '/workflows/10/start', method: 'POST', body: { init_data: {} }, idempotent: true });
    const first = await call(request, { 'Idempotency-Key': c.draft_id });
    const again = await call(request, { 'Idempotency-Key': c.draft_id });
    expect(first.status).toBe(202);
    expect(again).toMatchObject({ status: 202, body: { executionId: first.body.executionId, replayed: true } });
    const runs = await runsOf(10);
    expect(runs).toEqual([{ id: first.body.executionId, status: 'active', workflow_version: 2, contact_id: null, init_data: {} }]);
    expect(advanceWorkflow.mock.calls.map((x) => x[0])).toEqual([first.body.executionId]);
    const claims = await q('SELECT user_id, scope, idem_key, status, result FROM request_idempotency WHERE idem_key = ?', [c.draft_id]);
    expect(claims).toEqual([{ user_id: 6, scope: 'workflows.start', idem_key: c.draft_id, status: 'applied',
      result: expect.objectContaining({ executionId: first.body.executionId, workflowId: 10 }) }]);
  });

  test('no key keeps the native behaviour: two posts are two runs, and no claim row is written', async () => {
    await seedWorkflow(11);
    const before = (await q('SELECT COUNT(*) AS n FROM request_idempotency'))[0].n;
    expect((await call({ path: '/workflows/11/start', method: 'POST', body: { init_data: {} } })).status).toBe(202);
    expect((await call({ path: '/workflows/11/start', method: 'POST', body: { init_data: {} } })).status).toBe(202);
    expect(await runsOf(11)).toHaveLength(2);
    expect((await q('SELECT COUNT(*) AS n FROM request_idempotency'))[0].n).toBe(before);
  });

  test('a pre-INSERT refusal releases the claim; a lost commit ack keeps it and the key can never start twice', async () => {
    await seedWorkflow(12, { active: 0 });
    const key = '3c2b1a0f-1111-4222-8333-444455556666';
    const refused = await call({ path: '/workflows/12/start', method: 'POST', body: { init_data: {} } }, { 'Idempotency-Key': key });
    expect({ status: refused.status, error: refused.body.error }).toEqual({ status: 409, error: 'Workflow is inactive' });
    expect(await q('SELECT COUNT(*) AS n FROM request_idempotency WHERE idem_key = ?', [key])).toEqual([{ n: 0 }]);
    expect(await runsOf(12)).toEqual([]);

    await q('UPDATE workflows SET active = 1 WHERE id = 12');
    loseCommitAck = true;
    const lost = await call({ path: '/workflows/12/start', method: 'POST', body: { init_data: {} } }, { 'Idempotency-Key': key });
    expect(lost.status).toBe(500);
    expect(await runsOf(12)).toHaveLength(1);                              // the run DID commit
    expect(await q('SELECT status FROM request_idempotency WHERE idem_key = ?', [key])).toEqual([{ status: 'in_flight' }]);
    loseCommitAck = false;
    const retry = await call({ path: '/workflows/12/start', method: 'POST', body: { init_data: {} } }, { 'Idempotency-Key': key });
    expect({ status: retry.status, outcome: retry.body.idempotency && retry.body.idempotency.outcome }).toEqual({ status: 409, outcome: 'in_flight' });
    expect(await runsOf(12)).toHaveLength(1);
    expect(advanceWorkflow).not.toHaveBeenCalled();
  });
});
