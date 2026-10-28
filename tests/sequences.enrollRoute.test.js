'use strict';
/**
 * tests/sequences.enrollRoute.test.js
 *
 * A18.4a — native hardening of POST /sequences/enroll, the ROUTE half (the
 * engine half — the GET_LOCK duplicate fence and the scheduling-wedge fix —
 * is tests/sequences.enrollHardening.test.js and its real-engine twin
 * tests/sequences.enrollHardening.mysql.test.js).
 *
 * The contract pinned here:
 *   1. ERROR MAPPING — the engine's machine codes reach the HTTP caller:
 *        ALREADY_ENROLLED  → 409 + code + enrollment_id
 *        NEVER_PUBLISHED   → 409 + code
 *        EMPTY_SEQUENCE    → 409 + code
 *        ENROLL_BUSY       → 503 + code
 *        SCHEDULING_FAILED → 500 + code + enrollment_id
 *        anything else     → 500, the old shape exactly (no code key)
 *      Every mapped body keeps the old `error` / `message` pair, so a caller
 *      reading either (apiSend prefers `message`) shows the same text as
 *      before; only the status and the added keys differ.
 *   2. IDEMPOTENCY (scope sequences.enroll) — no key = the old behaviour (two
 *      posts, two enrolls, zero idempotency queries); a key replays the first
 *      enrollment (same enrollmentId, replayed:true, NO second engine call);
 *      a 4xx refusal and ENROLL_BUSY (both raised before any enrollment row
 *      exists) RELEASE the claim; SCHEDULING_FAILED and any other 5xx KEEP it
 *      (an enrollment row exists, or may), so the same key is 409, never a
 *      second enrollment.
 *
 * The engine is the collaborator here, not the module under test: its two
 * enroll entry points are stubbed; the route, lib/requestIdempotency and
 * express run for real against an in-memory claim table.
 *
 *   npx jest tests/sequences.enrollRoute.test.js
 */

const express = require('express');
const http = require('http');

jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = { type: 'jwt', userId: 6, roles: ['staff'] }; next(); }));

jest.mock('../lib/sequenceEngine', () => ({
  ...jest.requireActual('../lib/sequenceEngine'),
  enrollContact: jest.fn(),
  enrollContactByTemplateId: jest.fn(),
}));

const seq = require('../lib/sequenceEngine');
const { SQL } = require('../lib/requestIdempotency');

const engineError = (code, message, extra = {}) =>
  Object.assign(new Error(message), code ? { code } : {}, extra);

const OK = { enrollmentId: 501, templateName: 'Lead drip', totalSteps: 3, firstJobScheduledAt: '2026-10-29T14:00:00.000Z' };

function routeDb({ templates = [42] } = {}) {
  const state = { claims: [], idemQueries: 0, nextClaim: 1 };
  const db = {
    getConnection: async () => { throw new Error('the fake pool hands out no connections'); },
    async query(sql, p = []) {
      if (/SELECT id FROM sequence_templates WHERE id = \?/.test(sql)) {
        return [templates.includes(p[0]) ? [{ id: p[0] }] : []];
      }
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

function send(db, body, headers = {}) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.db = db; next(); });
  a.use(require('../routes/sequences.js'));
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const server = a.listen(0, () => {
      const req = http.request({
        port: server.address().port, path: '/sequences/enroll', method: 'POST',
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

const KEY = '7c1e2a9f-3b4d-4c5e-8f6a-0b1c2d3e4f5a';
const BY_ID = { contact_id: 1983, template_id: 42, trigger_data: { case_id: 'ABC' } };
const BY_TYPE = { contact_id: 1983, template_type: 'lead_drip', trigger_data: {} };

beforeAll(() => { for (const m of ['log', 'error', 'warn']) jest.spyOn(console, m).mockImplementation(() => {}); });
afterAll(() => jest.restoreAllMocks());
beforeEach(() => { seq.enrollContact.mockReset(); seq.enrollContactByTemplateId.mockReset(); });

describe('POST /sequences/enroll — engine codes reach the caller', () => {
  const MAP = [
    ['ALREADY_ENROLLED', { enrollment_id: 188 }, 409, { code: 'ALREADY_ENROLLED', enrollment_id: 188 }],
    ['NEVER_PUBLISHED', {}, 409, { code: 'NEVER_PUBLISHED' }],
    ['EMPTY_SEQUENCE', {}, 409, { code: 'EMPTY_SEQUENCE' }],
    ['ENROLL_BUSY', {}, 503, { code: 'ENROLL_BUSY' }],
    ['SCHEDULING_FAILED', { enrollment_id: 777 }, 500, { code: 'SCHEDULING_FAILED', enrollment_id: 777 }],
  ];

  test.each(MAP)('%s → its status, code and the old error/message pair (both enroll modes)', async (code, extra, status, keys) => {
    for (const [fn, body] of [[seq.enrollContactByTemplateId, BY_ID], [seq.enrollContact, BY_TYPE]]) {
      fn.mockRejectedValueOnce(engineError(code, `engine says ${code}`, extra));
      const { db } = routeDb();
      const r = await send(db, body);
      expect({ status: r.status, body: r.body }).toEqual({
        status,
        body: { error: 'Failed to enroll contact', message: `engine says ${code}`, ...keys },
      });
    }
  });

  test('an unmapped failure is the old 500 exactly — a foreign err.code is not surfaced', async () => {
    seq.enrollContactByTemplateId.mockRejectedValueOnce(engineError('ER_LOCK_DEADLOCK', 'Deadlock found'));
    seq.enrollContact.mockRejectedValueOnce(engineError(null, 'No active sequence template found for type: lead_drip'));
    const a = await send(routeDb().db, BY_ID);
    const b = await send(routeDb().db, BY_TYPE);
    expect([a.status, a.body]).toEqual([500, { error: 'Failed to enroll contact', message: 'Deadlock found' }]);
    expect([b.status, b.body]).toEqual([500, { error: 'Failed to enroll contact', message: 'No active sequence template found for type: lead_drip' }]);
  });

  test('success and the pre-engine refusals answer exactly as before', async () => {
    seq.enrollContactByTemplateId.mockResolvedValueOnce(OK);
    const ok = await send(routeDb().db, BY_ID);
    expect([ok.status, ok.body]).toEqual([201, { success: true, ...OK }]);
    expect(seq.enrollContactByTemplateId).toHaveBeenCalledWith(expect.anything(), 1983, 42, { case_id: 'ABC' });

    const missing = await send(routeDb({ templates: [] }).db, BY_ID);
    expect([missing.status, missing.body]).toEqual([404, { error: 'Template not found' }]);
    const badId = await send(routeDb().db, { ...BY_ID, template_id: 'x' });
    expect([badId.status, badId.body]).toEqual([400, { error: 'template_id must be a positive integer' }]);
    const noContact = await send(routeDb().db, { template_id: 42 });
    expect([noContact.status, noContact.body]).toEqual([400, { error: 'contact_id is required' }]);
    expect(seq.enrollContactByTemplateId).toHaveBeenCalledTimes(1);
  });
});

describe('POST /sequences/enroll — optional Idempotency-Key (scope sequences.enroll)', () => {
  test('no key: the old behaviour — two posts, two enrolls, zero idempotency queries', async () => {
    seq.enrollContactByTemplateId.mockResolvedValueOnce(OK).mockResolvedValueOnce({ ...OK, enrollmentId: 502 });
    const { db, state } = routeDb();
    const a = await send(db, BY_ID);
    const b = await send(db, BY_ID);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a.body.enrollmentId, b.body.enrollmentId]).toEqual([501, 502]);
    expect(a.body).not.toHaveProperty('replayed');
    expect(seq.enrollContactByTemplateId).toHaveBeenCalledTimes(2);
    expect(state.idemQueries).toBe(0);
  });

  test('a repeat of the key replays the FIRST enrollment — same enrollmentId, no second engine call', async () => {
    seq.enrollContactByTemplateId.mockResolvedValue(OK);
    const { db, state } = routeDb();
    const first = await send(db, BY_ID, { 'Idempotency-Key': KEY });
    const again = await send(db, BY_ID, { 'Idempotency-Key': KEY });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ success: true, ...OK });
    expect(again.status).toBe(201);
    expect(again.body).toEqual({ success: true, ...OK, replayed: true });
    expect(seq.enrollContactByTemplateId).toHaveBeenCalledTimes(1);
    expect(state.claims).toEqual([expect.objectContaining({ user_id: 6, scope: 'sequences.enroll', idem_key: KEY, status: 'applied' })]);
  });

  test('a refusal raised before any enrollment row exists RELEASES the claim; the same key then enrolls', async () => {
    const refusals = [
      [() => seq.enrollContactByTemplateId.mockRejectedValueOnce(engineError('ALREADY_ENROLLED', 'dup', { enrollment_id: 188 })), BY_ID, 409],
      [() => seq.enrollContactByTemplateId.mockRejectedValueOnce(engineError('NEVER_PUBLISHED', 'v0')), BY_ID, 409],
      [() => seq.enrollContact.mockRejectedValueOnce(engineError('EMPTY_SEQUENCE', 'no steps')), BY_TYPE, 409],
      [() => seq.enrollContact.mockRejectedValueOnce(engineError('ENROLL_BUSY', 'busy')), BY_TYPE, 503],
      [() => {}, { ...BY_ID, template_id: 9 }, 404],
    ];
    for (const [arm, body, status] of refusals) {
      const { db, state } = routeDb();
      arm();
      const refused = await send(db, body, { 'Idempotency-Key': KEY });
      expect(refused.status).toBe(status);
      expect(state.claims).toEqual([]);
      seq.enrollContactByTemplateId.mockResolvedValueOnce(OK);
      seq.enrollContact.mockResolvedValueOnce(OK);
      const ok = await send(db, { ...body, template_id: body.template_id === 9 ? 42 : body.template_id }, { 'Idempotency-Key': KEY });
      expect(ok.status).toBe(201);
      expect(ok.body).toEqual({ success: true, ...OK });
      seq.enrollContactByTemplateId.mockReset(); seq.enrollContact.mockReset();
    }
  });

  test('SCHEDULING_FAILED KEEPS the claim: the same key is 409 in_flight, never a second enrollment', async () => {
    seq.enrollContactByTemplateId.mockRejectedValueOnce(engineError('SCHEDULING_FAILED', 'first step could not be scheduled', { enrollment_id: 777 }));
    const { db, state } = routeDb();
    const failed = await send(db, BY_ID, { 'Idempotency-Key': KEY });
    expect(failed.status).toBe(500);
    expect(failed.body).toMatchObject({ code: 'SCHEDULING_FAILED', enrollment_id: 777 });
    expect(state.claims).toEqual([expect.objectContaining({ scope: 'sequences.enroll', status: 'in_flight' })]);
    seq.enrollContactByTemplateId.mockResolvedValueOnce(OK);
    const retry = await send(db, BY_ID, { 'Idempotency-Key': KEY });
    expect(retry.status).toBe(409);
    expect(retry.body.idempotency).toEqual({ outcome: 'in_flight' });
    expect(seq.enrollContactByTemplateId).toHaveBeenCalledTimes(1);
  });

  test('an unmapped 5xx keeps the claim too (the SENDS rule)', async () => {
    seq.enrollContact.mockRejectedValueOnce(engineError('PROTOCOL_CONNECTION_LOST', 'Connection lost'));
    const { db, state } = routeDb();
    const lost = await send(db, BY_TYPE, { 'Idempotency-Key': KEY });
    expect(lost.status).toBe(500);
    expect(state.claims).toEqual([expect.objectContaining({ status: 'in_flight' })]);
  });

  test('a malformed key is a 400 before the engine or the claim table is touched', async () => {
    const { db, state } = routeDb();
    const r = await send(db, BY_ID, { 'Idempotency-Key': 'bad key!' });
    expect(r.status).toBe(400);
    expect(r.body.idempotency).toEqual({ outcome: 'invalid_key' });
    expect(state.idemQueries).toBe(0);
    expect(seq.enrollContactByTemplateId).not.toHaveBeenCalled();
  });
});
