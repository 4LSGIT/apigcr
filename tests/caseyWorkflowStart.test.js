'use strict';
/**
 * tests/caseyWorkflowStart.test.js
 *
 * A17.7 — Casey starts ONE run of a workflow's PUBLISHED version through a
 * reviewed card, and POST /workflows/:id/start gains an optional
 * Idempotency-Key (P4, scope workflows.start) under the SEND rule.
 *
 * The contract pinned here:
 *   1. the card is the impact preview, server-computed from the PUBLISHED
 *      version's rows (never the draft): effects (sends, webhooks reduced to
 *      method + host, safe code), what normally starts it, runs in flight,
 *      recent volume, and the placeholder inputs this empty start leaves blank;
 *   2. refusals: use_draft BY NAME, any input key, unknown keys, evidence that
 *      does not carry the workflow_id, an inactive or never-published workflow,
 *      a STANDARD-mode code step (absent / 'standard' / unparseable config —
 *      fail closed; safe mode starts), and the casey_workflow_start_enabled
 *      off switch;
 *   3. the SHIPPED browser builder can express nothing but
 *      POST /workflows/:id/start {init_data:{}} — whatever the draft carries;
 *   4. the route: no key = the old behaviour (two posts, two runs, zero
 *      idempotency queries); a key replays the first run (same executionId,
 *      replayed:true, NO second INSERT, NO second advance); a pre-INSERT
 *      refusal releases the claim; a failure after the INSERT (a lost commit
 *      acknowledgement) KEEPS it, so the same key is 409 and never a second run.
 *
 *   npx jest tests/caseyWorkflowStart.test.js
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');

jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = { type: 'jwt', userId: 6, roles: ['staff'], username: 'IT' }; next(); }));
// The detached advance is the fan-out itself — recorded, never run.
jest.mock('../lib/workflow_engine', () => {
  const actual = jest.requireActual('../lib/workflow_engine');
  return { ...actual, advanceWorkflow: jest.fn(async () => ({ status: 'completed' })) };
});

const { advanceWorkflow } = require('../lib/workflow_engine');
const { SQL } = require('../lib/requestIdempotency');
const { normalizeActionDraft } = require('../services/assistantService');

// Workflow 5: active, published v3 (4 steps) with an unpublished draft v4 the
// card must ignore. Step 2 stores `rows` (output_var), so only `source` and
// `day` are inputs nobody sets.
const WF_ROW = { id: 5, name: 'Daily Appointment Report', active: 1, current_version: 3, draft_version: 4 };
const PUBLISHED = [
  { step_number: 1, type: 'internal_function', label: 'Log', note: null,
    config: JSON.stringify({ function_name: 'create_log', params: { text: 'Report for {{day}} from {{source}} at {{env.now}}' } }), error_policy: null },
  { step_number: 2, type: 'internal_function', label: 'Rows', note: null,
    config: JSON.stringify({ function_name: 'query_db', params: { sql: 'SELECT 1', output_var: 'rows' } }), error_policy: null },
  { step_number: 3, type: 'internal_function', label: 'Mail', note: null,
    config: JSON.stringify({ function_name: 'send_email', params: { to: 'staff@4lsg.com', body: '{{rows}} {{this.count}}' } }), error_policy: null },
  { step_number: 4, type: 'webhook', label: 'Ping', note: null,
    config: JSON.stringify({ url: 'https://hooks.example.com/x?token=SECRET', method: 'post' }), error_policy: null },
];
const DRAFT = [{ step_number: 1, type: 'custom_code', label: 'Draft code', note: null,
  config: JSON.stringify({ code: 'process.exit()' }), error_policy: null }];

function proposalDb(over = {}) {
  const state = { wf: { ...WF_ROW, ...(over.wf || {}) }, published: (over.published || PUBLISHED).map((s) => ({ ...s })), reads: [] };
  const query = jest.fn(async (sql, params = []) => {
    state.reads.push([sql.replace(/\s+/g, ' ').trim(), params]);
    if (/SELECT id, name, active, current_version, draft_version FROM workflows WHERE id = \?/.test(sql)) {
      return [params[0] === state.wf.id ? [{ ...state.wf }] : []];
    }
    if (/SELECT \* FROM workflow_steps WHERE workflow_id = \? AND version = \?/.test(sql)) {
      if (params[1] === state.wf.current_version) return [state.published.map((s) => ({ ...s }))];
      if (params[1] === state.wf.draft_version) return [DRAFT.map((s) => ({ ...s }))];
      return [[]];
    }
    if (/SELECT COUNT\(\*\) AS n FROM workflow_executions[\s\S]*status IN \('pending','active','processing','delayed','held'\)/.test(sql)) return [[{ n: 1 }]];
    if (/SELECT COUNT\(\*\) AS n, AVG\(steps_executed_count\) AS avg_steps FROM workflow_executions/.test(sql)) return [[{ n: 77, avg_steps: '10.6667' }]];
    // automationReadService.references
    if (/FROM hook_targets/.test(sql)) return [[]];
    if (/FROM trigger_rule_actions/.test(sql)) return [[]];
    if (/FROM sequence_steps/.test(sql)) return [[]];
    if (/FROM workflow_steps s JOIN workflows w/.test(sql)) return [[]];
    if (/FROM cta_links/.test(sql)) return [[]];
    if (/FROM email_ingest_rule_actions a JOIN email_ingest_rules r/.test(sql)) return [[]];
    if (/FROM phone_ingest_rule_actions a JOIN phone_ingest_rules r/.test(sql)) return [[]];
    throw new Error(`unscripted query: ${sql}`);
  });
  return { state, db: { query } };
}

const EVIDENCE = [{ id: 'q1', label: 'Workflow 5 definition', rows: [{ workflow_id: 5, row_number: 1 }] }];
const startDraft = (over = {}) => ({ kind: 'workflow.start.v1', workflow_id: 5, evidence: [{ query_id: 'q1', row_number: 1 }], ...over });

afterEach(() => { delete process.env.CASEY_WORKFLOW_START_ENABLED; });

describe('the workflow-start normalizer', () => {
  test('a valid start normalizes into the impact preview of the PUBLISHED version', async () => {
    const { db, state } = proposalDb();
    const out = await normalizeActionDraft(db, startDraft(), EVIDENCE);
    expect(out).toMatchObject({
      kind: 'workflow.start.v1', status: 'draft',
      workflow: { workflow_id: 5, name: 'Daily Appointment Report', active: 1, version: 3, step_count: 4, has_draft: 1 },
      in_flight_count: 1,
      recent: { runs_90d: 77, avg_steps: 10.7 },
      expected: { current_version: 3 },
      starters: [],
    });
    expect(out.draft_id).toMatch(/^[0-9a-f-]{36}$/);
    // Only the published version's steps are read — never the draft.
    const stepReads = state.reads.filter(([sql]) => /FROM workflow_steps WHERE workflow_id/.test(sql));
    expect(stepReads.map(([, p]) => p)).toEqual([[5, 3]]);
    expect(out.effects).toEqual([
      'step 3: send_email — external-send: messages staff@4lsg.com on this run',
      'step 4: webhook POST → hooks.example.com',
    ]);
    expect(JSON.stringify(out)).not.toContain('SECRET');
    // `rows` is stored by step 2; this/env are engine-provided.
    expect(out.unset_inputs).toEqual(['day', 'source']);
    // The card never carries an input or a draft selector.
    expect(out).not.toHaveProperty('init_data');
    expect(out).not.toHaveProperty('use_draft');
  });

  test('use_draft is refused BY NAME, in any form, before anything is read', async () => {
    for (const v of [true, 1, '1', false]) {
      const { db } = proposalDb();
      await expect(normalizeActionDraft(db, startDraft({ use_draft: v }), EVIDENCE))
        .rejects.toThrow(/never runs a draft \(use_draft\) — Casey starts the PUBLISHED version only/);
      expect(db.query).not.toHaveBeenCalled();
    }
  });

  test('an input payload and any other unknown key are refused', async () => {
    for (const key of ['init_data', 'initData', 'contact_id', 'input']) {
      const { db } = proposalDb();
      await expect(normalizeActionDraft(db, startDraft({ [key]: { a: 1 } }), EVIDENCE))
        .rejects.toThrow(new RegExp(`takes no input \\(${key}\\)`));
    }
    const { db } = proposalDb();
    await expect(normalizeActionDraft(db, startDraft({ version: 4 }), EVIDENCE)).rejects.toThrow(/unsupported fields/);
  });

  test('evidence must carry the exact workflow_id', async () => {
    const { db } = proposalDb();
    await expect(normalizeActionDraft(db, startDraft(), [{ id: 'q1', rows: [{ workflow_id: 6, row_number: 1 }] }]))
      .rejects.toThrow(/does not identify the target workflow/);
    await expect(normalizeActionDraft(db, startDraft({ evidence: [] }), EVIDENCE))
      .rejects.toThrow(/does not identify the target workflow/);
  });

  test('inactive, never-published, missing and step-less workflows refuse', async () => {
    await expect(normalizeActionDraft(proposalDb({ wf: { active: 0 } }).db, startDraft(), EVIDENCE)).rejects.toThrow(/is inactive/);
    await expect(normalizeActionDraft(proposalDb({ wf: { current_version: 0 } }).db, startDraft(), EVIDENCE)).rejects.toThrow(/never been published/);
    await expect(normalizeActionDraft(proposalDb({ wf: { id: 99 } }).db, startDraft(), EVIDENCE)).rejects.toThrow(/Workflow 5 is unavailable/);
    await expect(normalizeActionDraft(proposalDb({ published: [] }).db, startDraft(), EVIDENCE)).rejects.toThrow(/has no steps/);
  });

  test('a STANDARD-mode code step in the published version refuses; unparseable config fails closed', async () => {
    for (const config of ['{"code":"1;","input":{}}', '{"code":"1;","code_mode":"standard"}', 'not json{{{']) {
      const { db } = proposalDb({ published: [...PUBLISHED,
        { step_number: 5, type: 'custom_code', label: null, note: null, config, error_policy: null }] });
      await expect(normalizeActionDraft(db, startDraft(), EVIDENCE))
        .rejects.toThrow(/published version contains standard-mode code step 5 — Casey does not start versions with standard-mode code/);
    }
  });

  test('a SAFE-mode code step starts and is disclosed (the mode-scoped ruling, 2026-10-25)', async () => {
    const { db } = proposalDb({ published: [...PUBLISHED,
      { step_number: 5, type: 'custom_code', label: null, note: null,
        config: JSON.stringify({ code: '1;', input: {}, code_mode: 'safe' }), error_policy: null }] });
    const out = await normalizeActionDraft(db, startDraft(), EVIDENCE);
    expect(out.effects).toContain('step 5: safe-mode code (sandboxed — no network, no database)');
  });

  test('casey_workflow_start_enabled = "0" makes the kind unavailable; the authoring flag does not', async () => {
    const { db } = proposalDb();
    process.env.CASEY_WORKFLOW_START_ENABLED = '0';
    await expect(normalizeActionDraft(db, startDraft(), EVIDENCE)).rejects.toThrow(/Action kind is unavailable/);
    expect(db.query).not.toHaveBeenCalled();
    process.env.CASEY_WORKFLOW_START_ENABLED = '1';
    process.env.CASEY_WORKFLOW_AUTHORING_ENABLED = '0';
    try {
      await expect(normalizeActionDraft(db, startDraft(), EVIDENCE)).resolves.toMatchObject({ kind: 'workflow.start.v1' });
    } finally { delete process.env.CASEY_WORKFLOW_AUTHORING_ENABLED; }
  });
});

describe('the receipt', () => {
  test('the ledger records the run under the same field the card\'s family reports', () => {
    const ledger = require('../services/assistantActionLedger');
    expect(ledger.KINDS.get('workflow.start.v1')).toBe('execution_id');
    const family = html.slice(html.indexOf("id: 'workflow_start'"), html.indexOf("id: 'sequence_step'"));
    expect(family).toContain("idField: 'execution_id'");
  });
});

// ── The shipped browser builder ─────────────────────────────────────────────
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
function fnSrc(src, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!match) throw new Error(`function ${name} not found`);
  let parens = 0, body = match.index + match[0].length - 1;
  for (; body < src.length; body++) {
    if (src[body] === '(') parens++;
    else if (src[body] === ')' && --parens === 0) break;
  }
  let depth = 0;
  for (let i = body; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(match.index, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}
// eslint-disable-next-line no-new-func
const buildRequest = new Function(`${fnSrc(html, 'workflowStartRequest')}; return workflowStartRequest;`)();

describe('the fixed request builder', () => {
  test('it can express only POST /workflows/:id/start {init_data:{}}, whatever the draft carries', async () => {
    const { db } = proposalDb();
    const card = await normalizeActionDraft(db, startDraft(), EVIDENCE);
    expect(buildRequest(card)).toEqual({ path: '/workflows/5/start', method: 'POST', body: { init_data: {} }, idempotent: true });
    // A tampered card (model text that somehow reached the draft) changes nothing.
    const hostile = { ...card, use_draft: true, init_data: { x: 1 }, contact_id: 9, query: '?use_draft=1',
      workflow: { ...card.workflow, use_draft: true } };
    expect(buildRequest(hostile)).toEqual({ path: '/workflows/5/start', method: 'POST', body: { init_data: {} }, idempotent: true });
    expect(() => buildRequest({ workflow: { workflow_id: '5?use_draft=1' } })).toThrow(/no usable workflow/);
  });
});

// ── The route, end to end through the shipped builder ───────────────────────
function routeDb(over = {}) {
  const state = {
    wf: { id: 5, active: 1, default_contact_id_from: null, capture_mode: 'off', current_version: 3, draft_version: 4, ...(over.wf || {}) },
    claims: [], executions: [], idemQueries: 0, nextClaim: 1, nextExec: 900,
    loseCommitAck: false,
  };
  const conn = {
    async query(sql, params = []) {
      if (/SELECT id, active, default_contact_id_from, capture_mode, current_version, draft_version FROM workflows WHERE id = \?/.test(sql)) {
        return [params[0] === state.wf.id ? [{ ...state.wf }] : []];
      }
      if (/UPDATE workflows[\s\S]*captured_input/.test(sql)) return [{ affectedRows: 0 }];
      if (/INSERT INTO workflow_executions/.test(sql)) {
        const id = state.nextExec++;
        state.executions.push({ id, workflow_id: params[0], contact_id: params[1], init_data: params[2], version: params[4] });
        return [{ insertId: id, affectedRows: 1 }];
      }
      throw new Error(`unscripted txn query: ${sql}`);
    },
  };
  const db = {
    getConnection: async () => { throw new Error('the fake pool hands out no connections'); },
    // A lost commit acknowledgement: the transaction's work landed, the
    // caller sees an error — the case the kept claim exists for.
    withTransaction: async (fn) => {
      const out = await fn(conn);
      if (state.loseCommitAck) throw Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST' });
      return out;
    },
    async query(sql, p = []) {
      state.idemQueries++;
      if (sql === SQL.claim) {
        const [user_id, scope, idem_key] = p;
        if (state.claims.some((r) => r.user_id === user_id && r.scope === scope && r.idem_key === idem_key)) {
          throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
        }
        const row = { id: state.nextClaim++, user_id, scope, idem_key, status: 'in_flight', result: null };
        state.claims.push(row);
        return [{ insertId: row.id, affectedRows: 1 }];
      }
      if (sql === SQL.read) {
        const row = state.claims.find((r) => r.user_id === p[0] && r.scope === p[1] && r.idem_key === p[2]);
        return [row ? [{ id: row.id, status: row.status, result: row.result, age_s: 0 }] : []];
      }
      if (sql === SQL.settle) {
        const row = state.claims.find((r) => r.id === p[1] && r.status === 'in_flight');
        if (!row) return [{ affectedRows: 0 }];
        row.status = 'applied'; row.result = JSON.parse(p[0]);
        return [{ affectedRows: 1 }];
      }
      if (sql === SQL.release) {
        const i = state.claims.findIndex((r) => r.id === p[0] && r.status === 'in_flight');
        if (i >= 0) state.claims.splice(i, 1);
        return [{ affectedRows: i >= 0 ? 1 : 0 }];
      }
      throw new Error(`unscripted pool query: ${sql}`);
    },
  };
  return { state, db };
}

function send(db, request, headers = {}) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.db = db; next(); });
  a.use(require('../routes/workflows.js'));
  const data = JSON.stringify(request.body);
  return new Promise((resolve, reject) => {
    const server = a.listen(0, () => {
      const req = http.request({
        port: server.address().port, path: request.path, method: request.method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
      }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(data); req.end();
    });
  });
}

const KEY = '0f8a3c1e-5b7d-4e2a-9c6f-1a2b3c4d5e6f';
const REQ = { path: '/workflows/5/start', method: 'POST', body: { init_data: {} } };
const flush = () => new Promise((r) => setImmediate(r));

describe('POST /workflows/:id/start — optional Idempotency-Key (scope workflows.start)', () => {
  beforeEach(() => { advanceWorkflow.mockClear(); });
  beforeAll(() => { for (const m of ['log', 'error']) jest.spyOn(console, m).mockImplementation(() => {}); });
  afterAll(() => jest.restoreAllMocks());

  test('no key: the old behaviour — two posts, two runs, two advances, zero idempotency queries', async () => {
    const { db, state } = routeDb();
    const a = await send(db, REQ);
    const b = await send(db, REQ);
    await flush();
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(a.body).toEqual({ success: true, executionId: 900, workflowId: 5, contactId: null, status: 'processing',
      message: 'Workflow execution started and is now processing' });
    expect(state.executions.map((e) => e.id)).toEqual([900, 901]);
    expect(state.executions[0]).toMatchObject({ init_data: '{}', version: 3, contact_id: null });
    expect(advanceWorkflow.mock.calls.map((c) => c[0])).toEqual([900, 901]);
    expect(state.idemQueries).toBe(0);
  });

  test('the card\'s key: the repeat replays the FIRST run — same executionId, no second INSERT, no second advance', async () => {
    const { db, state } = routeDb();
    const request = { ...REQ, body: buildRequest({ workflow: { workflow_id: 5 } }).body };
    const first = await send(db, request, { 'Idempotency-Key': KEY });
    const again = await send(db, request, { 'Idempotency-Key': KEY });
    await flush();
    expect(first.status).toBe(202);
    expect(first.body).not.toHaveProperty('replayed');
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ success: true, executionId: first.body.executionId, workflowId: 5, replayed: true });
    expect(again.body.message).toMatch(/already started execution 900; nothing was started again/);
    expect(state.executions).toHaveLength(1);
    expect(advanceWorkflow.mock.calls.map((c) => c[0])).toEqual([900]);
    expect(state.claims).toEqual([expect.objectContaining({ user_id: 6, scope: 'workflows.start', idem_key: KEY, status: 'applied' })]);
  });

  test('a pre-INSERT refusal releases the claim; the same key then starts once the refusal is fixed', async () => {
    const { db, state } = routeDb({ wf: { active: 0 } });
    const refused = await send(db, REQ, { 'Idempotency-Key': KEY });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: 'Workflow is inactive', message: 'Activate the workflow before starting it.' });
    expect(state.claims).toEqual([]);
    expect(state.executions).toEqual([]);
    state.wf.active = 1;
    const ok = await send(db, REQ, { 'Idempotency-Key': KEY });
    expect(ok.status).toBe(202);
    expect(state.executions).toHaveLength(1);
  });

  test('every other refusal shape (404, never published, invalid contact_id) answers exactly as before and releases', async () => {
    const cases = [
      [{ wf: { id: 6 } }, REQ.body, 404, { error: 'Workflow not found' }],
      [{ wf: { current_version: 0 } }, REQ.body, 409, { error: 'Workflow has never been published' }],
      [{}, { init_data: {}, contact_id: 'abc' }, 400, { error: 'Invalid contact_id' }],
    ];
    for (const [over, body, status, expected] of cases) {
      const { db, state } = routeDb(over);
      const r = await send(db, { ...REQ, body }, { 'Idempotency-Key': KEY });
      expect({ status: r.status, body: r.body }).toEqual({ status, body: expect.objectContaining(expected) });
      expect(state.claims).toEqual([]);
      expect(state.executions).toEqual([]);
    }
  });

  test('a failure AFTER the INSERT keeps the claim: the same key is 409, never a second run', async () => {
    const { db, state } = routeDb();
    state.loseCommitAck = true;
    const lost = await send(db, REQ, { 'Idempotency-Key': KEY });
    expect(lost.status).toBe(500);
    expect(state.executions).toHaveLength(1);                     // the run DID land
    expect(state.claims).toEqual([expect.objectContaining({ status: 'in_flight' })]);
    state.loseCommitAck = false;
    const retry = await send(db, REQ, { 'Idempotency-Key': KEY });
    expect(retry.status).toBe(409);
    expect(retry.body.idempotency).toEqual({ outcome: 'in_flight' });
    expect(state.executions).toHaveLength(1);
    await flush();
    expect(advanceWorkflow).not.toHaveBeenCalled();
  });

  test('a malformed key is a 400 before anything is read or written', async () => {
    const { db, state } = routeDb();
    const r = await send(db, REQ, { 'Idempotency-Key': 'bad key!' });
    expect(r.status).toBe(400);
    expect(r.body.idempotency).toEqual({ outcome: 'invalid_key' });
    expect(state.executions).toEqual([]);
    expect(state.idemQueries).toBe(0);
  });
});
