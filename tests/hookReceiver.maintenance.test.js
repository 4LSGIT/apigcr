/**
 * tests/hookReceiver.maintenance.test.js
 *
 * POST /hooks/:slug under MAINTENANCE_MODE=1 (routes/api.hooks.js).
 *
 * hookService is mocked (the pipeline has its own suites); lib/maintenance and
 * lib/hookSpool are REAL, with a fake Cloud Tasks client injected — so what is
 * asserted is the actual task the replay route will later receive.
 *
 * WHAT IS LOCKED SHUT
 *   1. OFF = today's behaviour, untouched: the pipeline runs, nothing is
 *      spooled. (tests/hookReceiver.splitPhase.test.js locks the details; this
 *      only proves the new branch is not taken.)
 *   2. ON = capture, never execute. executeHook is NOT called — not even the
 *      capture-mode intercept, which writes to `hooks`. The sender still sees
 *      the byte-identical 200 body.
 *   3. Authentication still gates the spool: a rejected sender gets 401 and no
 *      task. The spool only ever holds events the hook would have accepted.
 *   4. What is stored is the built `input` with secret-bearing headers already
 *      stripped — no x-api-key / authorization / cookie parked in the queue —
 *      plus meta.spooled / meta.spool_id for the replay's idempotency check.
 *   5. THE ONE BEHAVIOUR CHANGE: if the event could not be stored (spool
 *      failure, or the hook lookup itself failed) the answer is 503, not the
 *      usual 200. Outside maintenance a receiver error is still a 200.
 *
 * Run: npx jest tests/hookReceiver.maintenance.test.js
 */

'use strict';

jest.mock('../services/hookService', () => ({
  getHookBySlug: jest.fn(),
  authenticateRequest: jest.fn(() => ({ valid: true })),
  executeHook: jest.fn(),
  recordExecution: jest.fn(),
}));

const hookService = require('../services/hookService');
const hookSpool = require('../lib/hookSpool');
const maintenance = require('../lib/maintenance');
const express = require('express');

const HOOK = { id: 1, slug: 'test-hook', auth_type: 'none', capture_mode: 'off', targets: [] };

function fakeClient(overrides = {}) {
  return {
    queuePath: (p, l, q) => `projects/${p}/locations/${l}/queues/${q}`,
    taskPath: (p, l, q, t) => `projects/${p}/locations/${l}/queues/${q}/tasks/${t}`,
    getProjectId: jest.fn(async () => 'test-proj'),
    createTask: jest.fn(async () => [{ name: 'ok' }]),
    ...overrides,
  };
}

const ENV_KEYS = ['MAINTENANCE_MODE', 'CLOUD_TASKS_LOCATION', 'CLOUD_TASKS_SPOOL_QUEUE',
                  'CLOUD_TASKS_TARGET_URL', 'APP_URL', 'INTERNAL_API_KEY'];
const saved = {};
let server, base, client, logSpy, errSpy, warnSpy;

beforeAll((done) => {
  const app = express();
  // Same shape as server.js: the REAL gate first, then a parser scoped to
  // /hooks, then the router — so every case below also proves the gate and
  // the receiver agree about which requests are the receiver's.
  app.use(maintenance.gate());
  app.use('/hooks', express.json({ limit: '5mb' }));   // roomy: the too-large-to-spool case posts ~1 MB
  app.use((req, _res, next) => { req.db = { query: async () => [[]] }; next(); });
  app.use(require('../routes/api.hooks'));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(done);
});
beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.CLOUD_TASKS_LOCATION = 'us-east1';
  process.env.APP_URL = 'https://app.example.test';
  process.env.INTERNAL_API_KEY = 'yci_test_key';
  hookService.getHookBySlug.mockReset().mockResolvedValue(HOOK);
  hookService.authenticateRequest.mockReset().mockReturnValue({ valid: true });
  hookService.executeHook.mockReset().mockResolvedValue({ status: 'accepted', executionId: 7, targets: [] });
  hookService.recordExecution.mockReset().mockResolvedValue({ executionId: 7, truncated: false });
  client = fakeClient();
  hookSpool._test({ client });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  hookSpool._test({ client: null });
  logSpy.mockRestore(); errSpy.mockRestore(); warnSpy.mockRestore();
});

const fire = (slug = 'test-hook', headers = {}, body = { some: 'payload' }) =>
  fetch(`${base}/hooks/${slug}?src=web`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const storedTask = () => {
  expect(client.createTask).toHaveBeenCalledTimes(1);
  const { task } = client.createTask.mock.calls[0][0];
  return { task, payload: JSON.parse(task.httpRequest.body.toString('utf8')) };
};

describe('maintenance OFF — the new branch is not taken', () => {
  test('the event is recorded for the drain (ack-first receiver), nothing is spooled', async () => {
    const res = await fire();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'received', slug: 'test-hook' });
    // Ack first (2026-10-28): the row is written and the doorbell rung; the
    // pipeline runs later from lib/hookDrain, never in this request.
    expect(hookService.recordExecution).toHaveBeenCalledTimes(1);
    expect(hookService.executeHook).not.toHaveBeenCalled();
    expect(client.createTask).not.toHaveBeenCalled();   // the SPOOL client — not the doorbell's
    // …and the live input carries no spool markers.
    const input = hookService.recordExecution.mock.calls[0][3];
    expect(input.meta).not.toHaveProperty('spool_id');
    expect(input.meta).not.toHaveProperty('spooled');
  });

  test("a receiver error is still a 200 (the pre-existing 'never a sender retry' contract)", async () => {
    hookService.getHookBySlug.mockRejectedValue(new Error('db blip'));
    const res = await fire();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'received', slug: 'test-hook' });
  });
});

describe('maintenance ON — capture, never execute', () => {
  beforeEach(() => { process.env.MAINTENANCE_MODE = '1'; });

  test('event is spooled; neither executeHook nor recordExecution is called; the 200 body is unchanged', async () => {
    const res = await fire();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'received', slug: 'test-hook' });
    expect(hookService.executeHook).not.toHaveBeenCalled();
    expect(hookService.recordExecution).not.toHaveBeenCalled();

    const { task, payload } = storedTask();
    expect(task.httpRequest.url).toBe('https://app.example.test/internal/hook-replay');
    expect(payload.slug).toBe('test-hook');
    expect(payload.input.body).toEqual({ some: 'payload' });
    expect(payload.input.query).toEqual({ src: 'web' });
    expect(payload.input.method).toBe('POST');
    expect(payload.input.meta).toMatchObject({ source: 'http', slug: 'test-hook', spooled: true });
    expect(payload.input.meta.spool_id).toBe(payload.spool_id);
    expect(payload.spool_id).toMatch(/^[a-f0-9]{32}$/);
    expect(task.name).toMatch(new RegExp(`/tasks/hs-${payload.spool_id}$`));
    // received_at is the moment of receipt, preserved for the replay.
    expect(Number.isNaN(Date.parse(payload.input.meta.received_at))).toBe(false);
  });

  test('secret-bearing headers are stripped BEFORE the event is stored; signatures are kept', async () => {
    await fire('test-hook', {
      'x-api-key': 'yci_SUPER_SECRET',
      authorization: 'Bearer SECRET_JWT',
      cookie: 'sid=SECRET',
      'calendly-webhook-signature': 't=1,v1=abc',
    });
    const { task, payload } = storedTask();
    const h = payload.input.headers;
    expect(h).not.toHaveProperty('x-api-key');
    expect(h).not.toHaveProperty('authorization');
    expect(h).not.toHaveProperty('cookie');
    expect(h['calendly-webhook-signature']).toBe('t=1,v1=abc');
    // Nothing secret anywhere in the stored bytes.
    const raw = task.httpRequest.body.toString('utf8');
    expect(raw).not.toMatch(/SUPER_SECRET|SECRET_JWT|sid=SECRET/);
  });

  test('authentication still gates the spool: 401 and NO task', async () => {
    hookService.authenticateRequest.mockReturnValue({ valid: false, error: 'Invalid signature' });
    const res = await fire();
    expect(res.status).toBe(401);
    expect(client.createTask).not.toHaveBeenCalled();
    expect(hookService.executeHook).not.toHaveBeenCalled();
  });

  test('authentication runs against the hook that was looked up (not skipped in maintenance)', async () => {
    await fire();
    expect(hookService.getHookBySlug).toHaveBeenCalledWith(expect.anything(), 'test-hook');
    expect(hookService.authenticateRequest).toHaveBeenCalledTimes(1);
    expect(hookService.authenticateRequest.mock.calls[0][0]).toBe(HOOK);
  });

  test('a hook in capture mode is spooled like any other — the capture intercept (a write) does not run', async () => {
    hookService.getHookBySlug.mockResolvedValue({ ...HOOK, capture_mode: 'capturing' });
    const res = await fire();
    expect(await res.json()).toEqual({ status: 'received', slug: 'test-hook' }); // not {status:'captured'}
    expect(hookService.executeHook).not.toHaveBeenCalled();
    expect(client.createTask).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['/Hooks/test-hook'], ['/HOOKS/test-hook/'], ['/hooks/test-hook/'],
  ])('a differently-cased / trailing-slash URL (%s) passes the gate AND reaches the receiver — spooled, not refused', async (p) => {
    const res = await fetch(`${base}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ some: 'payload' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'received', slug: 'test-hook' });
    const { payload } = storedTask();
    expect(payload.input.body).toEqual({ some: 'payload' });   // the scoped parser ran too
    expect(hookService.executeHook).not.toHaveBeenCalled();
  });

  test('anything else under /hooks is refused by the gate before the receiver sees it', async () => {
    const res = await fetch(`${base}/hooks/test-hook/extra`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe('maintenance');
    expect(hookService.getHookBySlug).not.toHaveBeenCalled();
    expect(client.createTask).not.toHaveBeenCalled();
  });

  test('unknown slug falls back to the catch-all and is spooled under the ATTEMPTED slug', async () => {
    hookService.getHookBySlug.mockImplementation(async (_db, slug) =>
      (slug === '_catchall' ? { ...HOOK, id: 9, slug: '_catchall' } : null));
    const res = await fire('typo-slug');
    expect(res.status).toBe(200);
    const { payload } = storedTask();
    expect(payload.slug).toBe('typo-slug');
    expect(payload.input.meta).toMatchObject({ slug: 'typo-slug', unmatched: true, spooled: true });
  });

  test('unknown slug with no catch-all is still a 404, nothing spooled', async () => {
    hookService.getHookBySlug.mockResolvedValue(null);
    const res = await fire('nope');
    expect(res.status).toBe(404);
    expect(client.createTask).not.toHaveBeenCalled();
  });

  test('the RingCentral Validation-Token handshake is unaffected (no lookup, no spool)', async () => {
    const res = await fetch(`${base}/hooks/test-hook`, { method: 'POST', headers: { 'Validation-Token': 'vt-123' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('validation-token')).toBe('vt-123');
    expect(hookService.getHookBySlug).not.toHaveBeenCalled();
    expect(client.createTask).not.toHaveBeenCalled();
  });

  describe('could not be stored → 503, so the sender retries', () => {
    test('the spool RPC fails', async () => {
      client.createTask.mockRejectedValue(Object.assign(new Error('NOT_FOUND: queue'), { code: 5 }));
      const res = await fire();
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('60');
      expect(await res.json()).toMatchObject({ status: 'error' });
      expect(hookService.executeHook).not.toHaveBeenCalled();
      expect(errSpy.mock.calls.some((a) => /could NOT spool test-hook/.test(String(a[0])))).toBe(true);
    });

    test('the spool is misconfigured (no CLOUD_TASKS_LOCATION)', async () => {
      delete process.env.CLOUD_TASKS_LOCATION;
      const res = await fire();
      expect(res.status).toBe(503);
      expect(client.createTask).not.toHaveBeenCalled();
    });

    test('the event is too large for one task → 503, nothing stored, nothing executed', async () => {
      // Control: just under the cap is stored.
      const under = await fire('test-hook', {}, { a: 'x'.repeat(hookSpool.MAX_BODY_BYTES - 4096) });
      expect(under.status).toBe(200);
      expect(client.createTask).toHaveBeenCalledTimes(1);
      client.createTask.mockClear();

      const over = await fire('test-hook', {}, { a: 'x'.repeat(hookSpool.MAX_BODY_BYTES + 1) });
      expect(over.status).toBe(503);
      expect(over.headers.get('retry-after')).toBe('60');
      expect(client.createTask).not.toHaveBeenCalled();
      expect(hookService.executeHook).not.toHaveBeenCalled();
    });

    test('the hook lookup itself fails (frozen DB unreachable) → 503, not the usual 200', async () => {
      hookService.getHookBySlug.mockRejectedValue(new Error('ECONNRESET'));
      const res = await fire();
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('60');
      expect(client.createTask).not.toHaveBeenCalled();
    });
  });
});
