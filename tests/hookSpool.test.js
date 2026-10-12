/**
 * tests/hookSpool.test.js
 *
 * lib/hookSpool.js — durable capture of webhooks during a write freeze.
 *
 * WHAT IS LOCKED SHUT
 *   1. put() REJECTS on every failure. This is the opposite contract to
 *      lib/taskQueue.js (which never rejects): during maintenance the task is
 *      the ONLY copy of the event, so a swallowed error is silent data loss.
 *      The receiver turns a rejection into a 503 so the sender retries.
 *   2. TASK SHAPE: queue yc-hook-spool (not the accelerator's yc-jobs), named
 *      hs-{spool_id}, POST {app_url}/internal/hook-replay with the internal
 *      x-api-key, JSON body { spool_id, slug, input } — the exact object the
 *      replay route validates. No scheduleTime: the queue is paused; resume is
 *      the trigger.
 *   3. NOT GATED BY cloud_tasks_enabled. That flag is the accelerator's kill
 *      switch; flipping it off must not turn maintenance into a black hole.
 *   4. ALREADY_EXISTS (gRPC 6) is success — the same spool id is already
 *      stored. Any other RPC error rejects.
 *   5. An event too large for one task is refused BEFORE the RPC.
 *
 * Config flows through env (firmConfig's jest path never touches the DB).
 *
 * Run: npx jest tests/hookSpool.test.js
 */

'use strict';

const hookSpool = require('../lib/hookSpool');

function fakeClient(overrides = {}) {
  return {
    queuePath: (p, l, q) => `projects/${p}/locations/${l}/queues/${q}`,
    taskPath: (p, l, q, t) => `projects/${p}/locations/${l}/queues/${q}/tasks/${t}`,
    getProjectId: jest.fn(async () => 'test-proj'),
    createTask: jest.fn(async () => [{ name: 'ok' }]),
    getQueue: jest.fn(async () => [{ state: 'PAUSED' }]),
    ...overrides,
  };
}

const ENV_KEYS = ['CLOUD_TASKS_ENABLED', 'CLOUD_TASKS_LOCATION', 'CLOUD_TASKS_QUEUE',
                  'CLOUD_TASKS_SPOOL_QUEUE', 'CLOUD_TASKS_TARGET_URL', 'APP_URL', 'INTERNAL_API_KEY'];
const saved = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  hookSpool._test({ client: null });
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  hookSpool._test({ client: null });
  jest.restoreAllMocks();
});

function armEnv() {
  process.env.CLOUD_TASKS_LOCATION = 'us-east1';
  process.env.APP_URL = 'https://app.example.test/';
  process.env.INTERNAL_API_KEY = 'yci_test_key';
}

function event(extraMeta = {}) {
  const spoolId = hookSpool.newSpoolId();
  return {
    spoolId,
    slug: 'rc-message-in',
    input: {
      body: { text: 'hello', from: '+15555550100' },
      headers: { 'content-type': 'application/json', 'user-agent': 'RingCentral' },
      query: {},
      method: 'POST',
      meta: { source: 'http', received_at: '2026-10-18T06:10:00.000Z', slug: 'rc-message-in',
              remote_ip: '203.0.113.9', spooled: true, spool_id: spoolId, ...extraMeta },
    },
  };
}

describe('newSpoolId / isSpoolId', () => {
  test('32 lowercase hex, unique, and valid as a Cloud Tasks task-name segment', () => {
    const a = hookSpool.newSpoolId();
    const b = hookSpool.newSpoolId();
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(a).not.toBe(b);
    expect(`hs-${a}`).toMatch(/^[A-Za-z0-9_-]{1,500}$/); // task id charset per the Cloud Tasks API
    expect(hookSpool.isSpoolId(a)).toBe(true);
  });

  test.each([[''], ['abc'], ['G'.repeat(32)], ['a'.repeat(31)], ['a'.repeat(33)], [null], [undefined], [123]])(
    'isSpoolId(%j) is false', (v) => { expect(hookSpool.isSpoolId(v)).toBe(false); });
});

describe('put — task shape', () => {
  test('stores the event on the spool queue, addressed to the replay route', async () => {
    armEnv();
    const c = fakeClient();
    hookSpool._test({ client: c });
    const e = event();

    const out = await hookSpool.put(e);

    expect(c.createTask).toHaveBeenCalledTimes(1);
    const [{ parent, task }, callOpts] = c.createTask.mock.calls[0];
    expect(parent).toBe('projects/test-proj/locations/us-east1/queues/yc-hook-spool');
    expect(task.name).toBe(`projects/test-proj/locations/us-east1/queues/yc-hook-spool/tasks/hs-${e.spoolId}`);
    expect(task.httpRequest.httpMethod).toBe('POST');
    expect(task.httpRequest.url).toBe('https://app.example.test/internal/hook-replay'); // trailing slash trimmed
    expect(task.httpRequest.headers).toEqual({ 'x-api-key': 'yci_test_key', 'content-type': 'application/json' });
    // Paused queue: resume is the trigger. A scheduleTime would add nothing.
    expect(task).not.toHaveProperty('scheduleTime');
    expect(callOpts.timeout).toBeGreaterThan(0);

    // The body is exactly what /internal/hook-replay validates and runs.
    expect(Buffer.isBuffer(task.httpRequest.body)).toBe(true);
    expect(JSON.parse(task.httpRequest.body.toString('utf8'))).toEqual({
      spool_id: e.spoolId, slug: e.slug, input: e.input,
    });

    expect(out).toEqual({ spoolId: e.spoolId, bytes: task.httpRequest.body.length, queue: 'yc-hook-spool', duplicate: false });
  });

  test('CLOUD_TASKS_SPOOL_QUEUE and CLOUD_TASKS_TARGET_URL override; CLOUD_TASKS_QUEUE does NOT leak in', async () => {
    armEnv();
    process.env.CLOUD_TASKS_QUEUE = 'yc-jobs';                 // the accelerator's queue
    process.env.CLOUD_TASKS_SPOOL_QUEUE = 'spool-2';
    process.env.CLOUD_TASKS_TARGET_URL = 'https://direct.run.app';
    const c = fakeClient();
    hookSpool._test({ client: c });
    await hookSpool.put(event());
    const [{ parent, task }] = c.createTask.mock.calls[0];
    expect(parent).toBe('projects/test-proj/locations/us-east1/queues/spool-2');
    expect(task.httpRequest.url).toBe('https://direct.run.app/internal/hook-replay');
  });

  test('default queue is never the accelerator queue', async () => {
    armEnv();
    process.env.CLOUD_TASKS_QUEUE = 'yc-jobs';
    const c = fakeClient();
    hookSpool._test({ client: c });
    await hookSpool.put(event());
    expect(c.createTask.mock.calls[0][0].parent).toMatch(/\/queues\/yc-hook-spool$/);
  });

  test('works with the accelerator kill switch OFF (cloud_tasks_enabled != 1)', async () => {
    armEnv();
    process.env.CLOUD_TASKS_ENABLED = '0';
    const c = fakeClient();
    hookSpool._test({ client: c });
    await expect(hookSpool.put(event())).resolves.toMatchObject({ duplicate: false });
    expect(c.createTask).toHaveBeenCalledTimes(1);
  });

  test('unicode survives the byte round trip', async () => {
    armEnv();
    const c = fakeClient();
    hookSpool._test({ client: c });
    const e = event();
    e.input.body.text = 'שלום — “quoted” 🙂';
    await hookSpool.put(e);
    const body = c.createTask.mock.calls[0][0].task.httpRequest.body;
    expect(JSON.parse(body.toString('utf8')).input.body.text).toBe('שלום — “quoted” 🙂');
  });
});

describe('put — REJECTS when the event was not stored', () => {
  test.each([
    ['CLOUD_TASKS_LOCATION', () => { delete process.env.CLOUD_TASKS_LOCATION; }],
    ['app_url', () => { delete process.env.APP_URL; }],
    ['internal_api_key', () => { delete process.env.INTERNAL_API_KEY; }],
  ])('missing %s → rejects, no RPC', async (_label, breakIt) => {
    armEnv();
    breakIt();
    const c = fakeClient();
    hookSpool._test({ client: c });
    await expect(hookSpool.put(event())).rejects.toThrow(/misconfigured/);
    expect(c.createTask).not.toHaveBeenCalled();
  });

  test('createTask failure (queue missing, permission, deadline) rejects with the RPC error', async () => {
    armEnv();
    const boom = Object.assign(new Error('NOT_FOUND: Queue does not exist'), { code: 5 });
    const c = fakeClient({ createTask: jest.fn(async () => { throw boom; }) });
    hookSpool._test({ client: c });
    await expect(hookSpool.put(event())).rejects.toBe(boom);
  });

  test('getProjectId failure rejects, and is NOT cached — the next put retries it', async () => {
    armEnv();
    let n = 0;
    const c = fakeClient({
      getProjectId: jest.fn(async () => { if (n++ === 0) throw new Error('metadata server blip'); return 'test-proj'; }),
    });
    hookSpool._test({ client: c });
    await expect(hookSpool.put(event())).rejects.toThrow(/metadata server blip/);
    await expect(hookSpool.put(event())).resolves.toMatchObject({ duplicate: false });
    expect(c.getProjectId).toHaveBeenCalledTimes(2);
  });

  test('ALREADY_EXISTS (gRPC 6) is success: the event is already stored', async () => {
    armEnv();
    const c = fakeClient({ createTask: jest.fn(async () => { throw Object.assign(new Error('exists'), { code: 6 }); }) });
    hookSpool._test({ client: c });
    const e = event();
    await expect(hookSpool.put(e)).resolves.toMatchObject({ spoolId: e.spoolId, duplicate: true });
  });

  test('an event over the size limit is refused before any RPC', async () => {
    armEnv();
    const c = fakeClient();
    hookSpool._test({ client: c });
    const e = event();
    e.input.body.blob = 'x'.repeat(hookSpool.MAX_BODY_BYTES);
    await expect(hookSpool.put(e)).rejects.toThrow(/too large to spool/);
    expect(c.createTask).not.toHaveBeenCalled();
  });

  test('an event just under the limit is accepted', async () => {
    armEnv();
    const c = fakeClient();
    hookSpool._test({ client: c });
    const e = event();
    e.input.body.blob = 'x'.repeat(hookSpool.MAX_BODY_BYTES - 2048);
    await expect(hookSpool.put(e)).resolves.toMatchObject({ duplicate: false });
  });

  test.each([
    ['no slug', (e) => { e.slug = ''; }, /slug required/],
    ['no input', (e) => { e.input = null; }, /input required/],
    ['spoolId not from newSpoolId', (e) => { e.spoolId = 'nope'; }, /spoolId must come from newSpoolId/],
    ['input.meta missing', (e) => { delete e.input.meta; }, /meta\.spool_id must equal spoolId/],
    ['meta.spool_id differs', (e) => { e.input.meta.spool_id = hookSpool.newSpoolId(); }, /meta\.spool_id must equal spoolId/],
  ])('bad arguments (%s) reject without an RPC', async (_label, breakIt, re) => {
    armEnv();
    const c = fakeClient();
    hookSpool._test({ client: c });
    const e = event();
    breakIt(e);
    await expect(hookSpool.put(e)).rejects.toThrow(re);
    expect(c.createTask).not.toHaveBeenCalled();
  });
});

describe('warmup — never throws, reports the queue state', () => {
  const quiet = () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  };

  test('paused queue → "paused" (the state a freeze needs)', async () => {
    armEnv(); quiet();
    const c = fakeClient();
    hookSpool._test({ client: c });
    await expect(hookSpool.warmup()).resolves.toBe('paused');
    expect(c.getQueue.mock.calls[0][0]).toEqual({ name: 'projects/test-proj/locations/us-east1/queues/yc-hook-spool' });
  });

  test('numeric enum 2 is also PAUSED', async () => {
    armEnv(); quiet();
    hookSpool._test({ client: fakeClient({ getQueue: jest.fn(async () => [{ state: 2 }]) }) });
    await expect(hookSpool.warmup()).resolves.toBe('paused');
  });

  test('RUNNING queue → "running" and a warning that names the problem', async () => {
    armEnv(); quiet();
    hookSpool._test({ client: fakeClient({ getQueue: jest.fn(async () => [{ state: 'RUNNING' }]) }) });
    await expect(hookSpool.warmup()).resolves.toBe('running');
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/not PAUSED/));
  });

  test('queue missing → "missing", loudly', async () => {
    armEnv(); quiet();
    hookSpool._test({ client: fakeClient({ getQueue: jest.fn(async () => { throw Object.assign(new Error('nf'), { code: 5 }); }) }) });
    await expect(hookSpool.warmup()).resolves.toBe('missing');
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/NOT FOUND/));
  });

  test('permission denied on getQueue → "unknown" (channel still warmed)', async () => {
    armEnv(); quiet();
    hookSpool._test({ client: fakeClient({ getQueue: jest.fn(async () => { throw Object.assign(new Error('pd'), { code: 7 }); }) }) });
    await expect(hookSpool.warmup()).resolves.toBe('unknown');
  });

  test('no CLOUD_TASKS_LOCATION → "unconfigured", no client call', async () => {
    quiet();
    const c = fakeClient();
    hookSpool._test({ client: c });
    await expect(hookSpool.warmup()).resolves.toBe('unconfigured');
    expect(c.getQueue).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/CANNOT be stored/));
  });

  test.each([
    ['APP_URL', /app_url/],
    ['INTERNAL_API_KEY', /internal_api_key/],
  ])('no %s → "unconfigured" (put() would reject), named in the log, never "ready"', async (envKey, named) => {
    armEnv(); quiet();
    delete process.env[envKey];
    const c = fakeClient();
    hookSpool._test({ client: c });
    await expect(hookSpool.warmup()).resolves.toBe('unconfigured');
    expect(c.getQueue).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(named));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringMatching(/ready/));
  });

  test('any other failure → "error", still resolves', async () => {
    armEnv(); quiet();
    hookSpool._test({ client: fakeClient({ getQueue: jest.fn(async () => { throw new Error('network'); }) }) });
    await expect(hookSpool.warmup()).resolves.toBe('error');
  });
});
