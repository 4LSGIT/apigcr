/**
 * tests/hookReceiver.async.test.js
 *
 * The ack-first webhook receiver (async hook receiver S1, 2026-10-28) —
 * routes/api.hooks.js normal path. hookService and taskQueue are mocked at the
 * module boundary (the drain and the pipeline have their own suites); this
 * suite locks only what the ROUTE guarantees to webhook senders and to the
 * drain:
 *
 *   1. RECORD, RING, ANSWER — in that order, all three awaited: the row is
 *      written (hookService.recordExecution, queued) BEFORE the doorbell rings
 *      (taskQueue.enqueueHookExecutionDispatch, with that row's id), and the
 *      response is sent AFTER the enqueue resolves. A doorbell against a row
 *      that does not exist yet burns itself as already-claimed; an enqueue
 *      left to the post-response tail starves (lib/domainEvents.js).
 *   2. The pipeline does NOT run in the request: executeHook is never called
 *      on the normal path.
 *   3. The body is byte-identical to every earlier contract —
 *      {status:'received', slug} — and well under RingCentral's 1024-byte cap
 *      (headers included).
 *   4. A dead doorbell (enqueue → false) is still a 200 and the row still
 *      exists: the cron drains it.
 *   5. A failed INSERT is still 200 {status:'received'} — our failure never
 *      becomes a sender-side retry — and nothing is enqueued for a row that
 *      does not exist.
 *   6. Kill switch: HOOK_ASYNC_ACK='0' (registry `hook_async_ack`) takes the
 *      split-phase path — executeHook with splitPhase:true, no record, no
 *      doorbell. Any other value, or unset, is ack-first.
 *   7. Capture mode stays synchronous and untouched by the switch.
 *
 * Run: npx jest tests/hookReceiver.async.test.js
 */
'use strict';

jest.mock('../services/hookService', () => ({
  getHookBySlug: jest.fn(),
  authenticateRequest: jest.fn(() => ({ valid: true })),
  executeHook: jest.fn(),
  recordExecution: jest.fn(),
}));
jest.mock('../lib/taskQueue', () => ({
  enqueueHookExecutionDispatch: jest.fn(async () => true),
  enqueueJobDispatch: jest.fn(async () => true),
  enqueueDomainEventDispatch: jest.fn(async () => true),
}));

const hookService = require('../services/hookService');
const taskQueue = require('../lib/taskQueue');
const express = require('express');
const http = require('http');

const HOOK = { id: 22, slug: 'rc-message-out', auth_type: 'none', capture_mode: 'off', targets: [] };
let server, base;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = { query: async () => [[]] }; next(); });
  app.use(require('../routes/api.hooks'));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(done);
});
beforeEach(() => {
  delete process.env.HOOK_ASYNC_ACK;
  hookService.getHookBySlug.mockReset().mockResolvedValue(HOOK);
  hookService.authenticateRequest.mockReset().mockReturnValue({ valid: true });
  hookService.executeHook.mockReset();
  hookService.recordExecution.mockReset().mockResolvedValue({ executionId: 4242, truncated: false });
  taskQueue.enqueueHookExecutionDispatch.mockReset().mockResolvedValue(true);
});
afterAll(() => { delete process.env.HOOK_ASYNC_ACK; });

// Raw http so the response size (status line + headers + body) can be measured.
function fire(body = { uuid: 'evt-1', event: '/restapi/v1.0/account/~/extension/~/message-store' }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      port: server.address().port, path: `/hooks/${HOOK.slug}`, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: data, receivedAt: Date.now() }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('POST /hooks/:slug — ack first, work after', () => {

  test('record → ring → answer, each awaited; the pipeline does not run in the request', async () => {
    let enqueueResolvedAt = 0;
    taskQueue.enqueueHookExecutionDispatch.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 40));
      enqueueResolvedAt = Date.now();
      return true;
    });

    const res = await fire();
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'received', slug: 'rc-message-out' });

    // The row first, with the hook the receiver authenticated against and the
    // built input (meta.slug, source http) — QUEUED, not claimed.
    expect(hookService.recordExecution).toHaveBeenCalledTimes(1);
    const [db, hook, slug, input, opts] = hookService.recordExecution.mock.calls[0];
    expect(db).toBeDefined();
    expect(hook).toBe(HOOK);
    expect(slug).toBe('rc-message-out');
    expect(input.body).toEqual({ uuid: 'evt-1', event: '/restapi/v1.0/account/~/extension/~/message-store' });
    expect(input.meta).toMatchObject({ source: 'http', slug: 'rc-message-out' });
    expect(opts).toBeUndefined();

    // Then the doorbell, for THAT row …
    expect(taskQueue.enqueueHookExecutionDispatch).toHaveBeenCalledTimes(1);
    expect(taskQueue.enqueueHookExecutionDispatch).toHaveBeenCalledWith(4242);
    const recordOrder = hookService.recordExecution.mock.invocationCallOrder[0];
    const ringOrder = taskQueue.enqueueHookExecutionDispatch.mock.invocationCallOrder[0];
    expect(recordOrder).toBeLessThan(ringOrder);

    // … and the answer only after the enqueue resolved.
    expect(enqueueResolvedAt).toBeGreaterThan(0);
    expect(res.receivedAt).toBeGreaterThanOrEqual(enqueueResolvedAt);

    expect(hookService.executeHook).not.toHaveBeenCalled();
  });

  test('the answer fits RingCentral: 200, JSON, status line + headers + body under 1024 bytes', async () => {
    const res = await fire();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    const statusLine = `HTTP/1.1 ${res.status} OK\r\n`;
    const headerBytes = res.rawHeaders.reduce((n, h, i) => n + Buffer.byteLength(h) + (i % 2 ? 2 : 2), 0);
    const total = Buffer.byteLength(statusLine) + headerBytes + 2 + Buffer.byteLength(res.body);
    expect(total).toBeLessThan(1024);
    expect(Buffer.byteLength(res.body)).toBeLessThan(100);
  });

  test('a dead doorbell (enqueue → false) is still 200; the row was written and the cron will drain it', async () => {
    taskQueue.enqueueHookExecutionDispatch.mockResolvedValue(false);
    const res = await fire();
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'received', slug: 'rc-message-out' });
    expect(hookService.recordExecution).toHaveBeenCalledTimes(1);
    expect(hookService.executeHook).not.toHaveBeenCalled();
  });

  test('a failed INSERT is still 200 {status:received} (never a sender retry) and rings nothing', async () => {
    hookService.recordExecution.mockRejectedValue(new Error('ER_LOCK_WAIT_TIMEOUT'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fire();
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: 'received', slug: 'rc-message-out' });
      expect(taskQueue.enqueueHookExecutionDispatch).not.toHaveBeenCalled();
      expect(errSpy.mock.calls.some((a) => /could not record rc-message-out/.test(a[0]))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("kill switch HOOK_ASYNC_ACK='0': the split-phase path — executeHook splitPhase:true, no record, no doorbell", async () => {
    process.env.HOOK_ASYNC_ACK = '0';
    let phase1Resolved = false;
    hookService.executeHook.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      phase1Resolved = true;
      return { status: 'accepted', executionId: 7, targets: [], detached: Promise.resolve() };
    });
    const res = await fire();
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'received', slug: 'rc-message-out' });
    expect(phase1Resolved).toBe(true);
    expect(hookService.executeHook).toHaveBeenCalledTimes(1);
    expect(hookService.executeHook.mock.calls[0][3]).toMatchObject({ hook: HOOK, splitPhase: true });
    expect(hookService.executeHook.mock.calls[0][3]).not.toHaveProperty('executionId');
    expect(hookService.recordExecution).not.toHaveBeenCalled();
    expect(taskQueue.enqueueHookExecutionDispatch).not.toHaveBeenCalled();
  });

  test("any other switch value ('1', 'yes', blank) is ack-first", async () => {
    for (const v of ['1', 'yes', '']) {
      process.env.HOOK_ASYNC_ACK = v;
      hookService.recordExecution.mockClear();
      hookService.executeHook.mockClear();
      const res = await fire();
      expect(res.status).toBe(200);
      expect(hookService.recordExecution).toHaveBeenCalledTimes(1);
      expect(hookService.executeHook).not.toHaveBeenCalled();
    }
  });

  test('capture mode is synchronous and reports captured — no record, no doorbell', async () => {
    hookService.getHookBySlug.mockResolvedValue({ ...HOOK, capture_mode: 'capturing' });
    hookService.executeHook.mockResolvedValue({ status: 'captured', execution_id: 99 });
    const res = await fire();
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'captured', execution_id: 99 });
    expect(hookService.executeHook).toHaveBeenCalledTimes(1);
    expect(hookService.executeHook.mock.calls[0][3]).toEqual({ hook: { ...HOOK, capture_mode: 'capturing' } });
    expect(hookService.recordExecution).not.toHaveBeenCalled();
    expect(taskQueue.enqueueHookExecutionDispatch).not.toHaveBeenCalled();
  });

  test('auth failure is still 401 with no row and no doorbell', async () => {
    hookService.authenticateRequest.mockReturnValue({ valid: false, error: 'bad key' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await fire();
      expect(res.status).toBe(401);
    } finally { warn.mockRestore(); }
    expect(hookService.recordExecution).not.toHaveBeenCalled();
    expect(taskQueue.enqueueHookExecutionDispatch).not.toHaveBeenCalled();
  });
});
