'use strict';
/**
 * tests/workflowsStart.idempotency.test.js
 *
 * POST /workflows/:id/start's optional Idempotency-Key (P4, scope
 * workflows.start) under the SEND rule — ported at Casey v2 S6 (2026-11-24)
 * from the retired v1 suite caseyWorkflowStart.test.js, whose card half (the
 * normalizer, the fixed builder, the A17.7b input contract) went with v1.
 * These are the ROUTE's cases, which no other suite exercised; every Casey v2
 * card step sends `Idempotency-Key: casey:<card>:<step>`:
 *   no key = the old behaviour (two posts, two runs, zero idempotency queries);
 *   a key replays the first run (same executionId, replayed:true, NO second
 *   INSERT, NO second advance); a pre-INSERT refusal releases the claim; a
 *   failure after the INSERT (a lost commit acknowledgement) KEEPS it, so the
 *   same key is 409 and never a second run; a malformed key is 400.
 *
 *   npx jest tests/workflowsStart.idempotency.test.js
 */

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
// ── The route ─────────────────────────────────────────────────────────────── ───────────────────────
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
    const request = REQ;   // the card's request: {init_data: {}} — byte-identical to v1's fixed builder, which went at S6
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
