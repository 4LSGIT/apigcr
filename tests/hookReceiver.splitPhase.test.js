/**
 * tests/hookReceiver.splitPhase.test.js
 *
 * The webhook receiver's split-phase contract (routes/api.hooks.js,
 * 2026-08-24). hookService is mocked wholesale — the split mechanics live in
 * tests/hookService.splitPhase.test.js; this suite locks only what the
 * ROUTE guarantees to webhook senders:
 *
 *   1. The response body is the pre-slice shape, byte for byte:
 *      {status:'received', slug} — senders (RingCentral, Quo) validate it.
 *   2. The response is sent AFTER phase 1 completes (executeHook resolves
 *      before res.json — that ordering IS the slice).
 *   3. A rejecting `detached` promise is caught by the route — no unhandled
 *      rejection, no effect on the already-sent response.
 *   4. executeHook THROWING (phase-1 infrastructure failure) still returns
 *      200 {status:'received'} — our pipeline errors must never turn into
 *      sender-side retries. Same guarantee the fully-detached design had.
 *   5. Results without `detached` (filtered/captured shapes) are handled —
 *      no crash on the missing key.
 *
 * Run: npx jest tests/hookReceiver.splitPhase.test.js
 */

'use strict';

jest.mock('../services/hookService', () => ({
  getHookBySlug: jest.fn(),
  authenticateRequest: jest.fn(() => ({ valid: true })),
  executeHook: jest.fn(),
}));

const hookService = require('../services/hookService');
const express = require('express');

const HOOK = { id: 1, slug: 'test-hook', auth_type: 'none', capture_mode: 'off', targets: [] };

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
  hookService.getHookBySlug.mockReset().mockResolvedValue(HOOK);
  hookService.authenticateRequest.mockReset().mockReturnValue({ valid: true });
  hookService.executeHook.mockReset();
});

const fire = () =>
  fetch(`${base}/hooks/test-hook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ some: 'payload' }),
  });

describe('POST /hooks/:slug — split-phase receiver contract', () => {

  test('responds with the pre-slice body AFTER phase 1 resolves; passes splitPhase:true', async () => {
    let phase1Resolved = false;
    hookService.executeHook.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      phase1Resolved = true;
      return { status: 'accepted', executionId: 7, targets: [], detached: Promise.resolve() };
    });

    const res = await fire();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'received', slug: 'test-hook' });
    // The response arrived, therefore executeHook had resolved first.
    expect(phase1Resolved).toBe(true);

    const opts = hookService.executeHook.mock.calls[0][3];
    expect(opts.splitPhase).toBe(true);
    expect(opts.hook).toBe(HOOK);
  });

  test('a rejecting detached promise is caught — no unhandled rejection, response unaffected', async () => {
    let rejectDetached;
    const detached = new Promise((_r, rej) => { rejectDetached = rej; });
    hookService.executeHook.mockResolvedValue({ status: 'accepted', executionId: 7, targets: [], detached });

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const res = await fire();
      expect(res.status).toBe(200);

      rejectDetached(new Error('phase-2 infra failure'));
      await new Promise((r) => setImmediate(r));

      expect(unhandled).toHaveLength(0);
      expect(errSpy.mock.calls.some((a) => /Detached-phase pipeline error/.test(a[0]))).toBe(true);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      errSpy.mockRestore();
    }
  });

  test('executeHook throwing in phase 1 still yields 200 {status:received} — never a sender retry', async () => {
    hookService.executeHook.mockRejectedValue(new Error('db down'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fire();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'received', slug: 'test-hook' });
    } finally {
      errSpy.mockRestore();
    }
  });

  test('a result without detached (filtered shape) is handled without error', async () => {
    hookService.executeHook.mockResolvedValue({ status: 'filtered', executionId: 7, filter: { passed: false } });
    const res = await fire();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'received', slug: 'test-hook' });
  });
});
