/**
 * tests/taskQueue.accel.test.js
 *
 * lib/taskQueue.js — the Cloud Tasks accelerator (P1, 2026-08).
 *
 * WHAT IS LOCKED SHUT
 *   1. NEVER-THROWS: enqueueJobDispatch is called from inside
 *      scheduleResume/scheduleStepJob — the critical path for every workflow
 *      advance. A thrown/rejected enqueue would break workflow scheduling
 *      outright, which is strictly worse than the 60s latency this module
 *      exists to shave. Every failure mode here must resolve, not reject.
 *   2. OFF-BY-DEFAULT: with cloud_tasks_enabled != '1', no client is created
 *      and no RPC is attempted — the deploy is inert until Fred flips the
 *      setting, and flipping it back is the kill switch.
 *   3. TASK SHAPE: name d-{jobId} (queue-layer dedupe), POST
 *      {app_url}/process-job/{id}, x-api-key from firmConfig (the same
 *      credential jwtOrApiKey accepts), scheduleTime ≥ due + 2s buffer
 *      (MySQL-vs-Tasks clock skew on the `scheduled_time <= NOW()` claim).
 *   4. ALREADY_EXISTS (gRPC code 6) is a silent no-op — a duplicate enqueue
 *      is the named task doing its job, not an error worth a log line.
 *
 * Config flows through env (firmConfig's jest path never touches the DB):
 * CLOUD_TASKS_ENABLED / CLOUD_TASKS_LOCATION / APP_URL / INTERNAL_API_KEY.
 *
 * Run: npx jest tests/taskQueue.accel.test.js
 */

'use strict';

const taskQueue = require('../lib/taskQueue');

function fakeClient(overrides = {}) {
  return {
    queuePath: (p, l, q) => `projects/${p}/locations/${l}/queues/${q}`,
    taskPath: (p, l, q, t) => `projects/${p}/locations/${l}/queues/${q}/tasks/${t}`,
    getProjectId: jest.fn(async () => 'test-proj'),
    createTask: jest.fn(async () => [{ name: 'ok' }]),
    ...overrides,
  };
}

const ENV_KEYS = ['CLOUD_TASKS_ENABLED', 'CLOUD_TASKS_LOCATION', 'CLOUD_TASKS_QUEUE',
                  'CLOUD_TASKS_TARGET_URL', 'APP_URL', 'INTERNAL_API_KEY'];
const saved = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  taskQueue._test({ client: null, resetWarn: true });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  taskQueue._test({ client: null, resetWarn: true });
});

function armEnv() {
  process.env.CLOUD_TASKS_ENABLED = '1';
  process.env.CLOUD_TASKS_LOCATION = 'us-central1';
  process.env.APP_URL = 'https://app.example.test/';
  process.env.INTERNAL_API_KEY = 'yci_test_key';
}

describe('lib/taskQueue.enqueueJobDispatch', () => {

  test('disabled (flag unset) → no-op: no client touched, resolves false', async () => {
    const c = fakeClient();
    taskQueue._test({ client: c });
    const out = await taskQueue.enqueueJobDispatch(42, Date.now());
    expect(out).toBe(false);
    expect(c.createTask).not.toHaveBeenCalled();
    expect(c.getProjectId).not.toHaveBeenCalled();
  });

  test('enabled but missing CLOUD_TASKS_LOCATION → no-op false, never throws', async () => {
    process.env.CLOUD_TASKS_ENABLED = '1';
    process.env.APP_URL = 'https://app.example.test';
    process.env.INTERNAL_API_KEY = 'k';
    const c = fakeClient();
    taskQueue._test({ client: c });
    await expect(taskQueue.enqueueJobDispatch(42, Date.now())).resolves.toBe(false);
    expect(c.createTask).not.toHaveBeenCalled();
  });

  test('happy path: task name d-{id}, target URL, api-key header, ≥2s buffered eta', async () => {
    armEnv();
    const c = fakeClient();
    taskQueue._test({ client: c });

    const due = Date.now();
    const out = await taskQueue.enqueueJobDispatch(42, due);
    expect(out).toBe(true);
    expect(c.createTask).toHaveBeenCalledTimes(1);

    const [{ parent, task }, callOpts] = c.createTask.mock.calls[0];
    expect(parent).toBe('projects/test-proj/locations/us-central1/queues/yc-jobs');
    expect(task.name).toBe(`projects/test-proj/locations/us-central1/queues/yc-jobs/tasks/d-42-${Math.floor(due)}`);
    // Trailing slash on APP_URL must not produce a double slash.
    expect(task.httpRequest.url).toBe('https://app.example.test/process-job/42');
    expect(task.httpRequest.httpMethod).toBe('POST');
    expect(task.httpRequest.headers['x-api-key']).toBe('yci_test_key');
    // eta = max(due, now) + 2s buffer (clock-skew guard on scheduled_time <= NOW()).
    expect(task.scheduleTime.seconds * 1000).toBeGreaterThanOrEqual(due + taskQueue.DISPATCH_BUFFER_MS);
    // RPC self-limits (generous 15s: the hook path enqueues from throttled
    // post-response context; nothing awaits this call, so headroom is free).
    expect(callOpts).toEqual({ timeout: 15000 });
  });

  test('RESCHEDULE LOCK: same job at a DIFFERENT due time gets a DISTINCT task name', async () => {
    // The load-bearing property behind the run-now / admin-PATCH doorbells:
    // Cloud Tasks retains completed task names for ~1h, so a bare d-{jobId}
    // would swallow the reschedule's task as ALREADY_EXISTS — silently
    // un-ringing the doorbell. The due-time suffix is what prevents that.
    // The pre-suffix scheme (d-{jobId}) fails this test by construction.
    armEnv();
    const c = fakeClient();
    taskQueue._test({ client: c });

    const t1 = Date.now();
    const t2 = t1 + 5000;
    await taskQueue.enqueueJobDispatch(42, t1);
    await taskQueue.enqueueJobDispatch(42, t2);

    const names = c.createTask.mock.calls.map(([{ task }]) => task.name);
    expect(names[0]).not.toBe(names[1]);
    expect(names[0]).toContain(`d-42-${Math.floor(t1)}`);
    expect(names[1]).toContain(`d-42-${Math.floor(t2)}`);
  });

  test('CLOUD_TASKS_TARGET_URL overrides app_url; CLOUD_TASKS_QUEUE overrides queue name', async () => {
    armEnv();
    process.env.CLOUD_TASKS_TARGET_URL = 'https://direct.run.app';
    process.env.CLOUD_TASKS_QUEUE = 'other-q';
    const c = fakeClient();
    taskQueue._test({ client: c });
    await taskQueue.enqueueJobDispatch(7, Date.now());
    const [{ parent, task }] = c.createTask.mock.calls[0];
    expect(parent).toContain('/queues/other-q');
    expect(task.httpRequest.url).toBe('https://direct.run.app/process-job/7');
  });

  test('NEVER-THROWS: createTask rejection is swallowed → resolves false', async () => {
    armEnv();
    const c = fakeClient({ createTask: jest.fn(async () => { throw new Error('UNAVAILABLE'); }) });
    taskQueue._test({ client: c });
    await expect(taskQueue.enqueueJobDispatch(42, Date.now())).resolves.toBe(false);
  });

  test('NEVER-THROWS: getProjectId rejection is swallowed → resolves false', async () => {
    armEnv();
    const c = fakeClient({ getProjectId: jest.fn(async () => { throw new Error('metadata server unreachable'); }) });
    taskQueue._test({ client: c });
    await expect(taskQueue.enqueueJobDispatch(42, Date.now())).resolves.toBe(false);
  });

  test('ALREADY_EXISTS (code 6) → silent false, no warn log', async () => {
    armEnv();
    const err = Object.assign(new Error('exists'), { code: 6 });
    const c = fakeClient({ createTask: jest.fn(async () => { throw err; }) });
    taskQueue._test({ client: c });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(taskQueue.enqueueJobDispatch(42, Date.now())).resolves.toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('unparseable scheduleTime falls back to now (+buffer) rather than NaN seconds', async () => {
    armEnv();
    const c = fakeClient();
    taskQueue._test({ client: c });
    const before = Date.now();
    await taskQueue.enqueueJobDispatch(9, 'garbage');
    const [{ task }] = c.createTask.mock.calls[0];
    expect(Number.isFinite(task.scheduleTime.seconds)).toBe(true);
    // ...and the task NAME stays valid too (no 'd-9-NaN').
    expect(task.name).toMatch(/tasks\/d-9-\d+$/);
    expect(task.scheduleTime.seconds * 1000).toBeGreaterThanOrEqual(before + taskQueue.DISPATCH_BUFFER_MS - 1000);
  });

  test('POISONED-PROMISE FIX: a getProjectId rejection is NOT cached — the next enqueue retries and succeeds', async () => {
    armEnv();
    const getProjectId = jest.fn()
      .mockRejectedValueOnce(new Error('metadata server blip'))
      .mockResolvedValue('test-proj');
    const c = fakeClient({ getProjectId });
    taskQueue._test({ client: c });

    // First call: blip → swallowed, false. Pre-fix, the REJECTED promise
    // stayed cached and every later enqueue awaited the same rejection —
    // accelerator permanently dead on the instance until recycled.
    await expect(taskQueue.enqueueJobDispatch(1, Date.now())).resolves.toBe(false);
    expect(c.createTask).not.toHaveBeenCalled();

    // Second call: must retry getProjectId and create the task.
    await expect(taskQueue.enqueueJobDispatch(2, Date.now())).resolves.toBe(true);
    expect(getProjectId).toHaveBeenCalledTimes(2);
    expect(c.createTask).toHaveBeenCalledTimes(1);
  });

  test('project id IS cached across successful calls (one metadata hit, not one per job)', async () => {
    armEnv();
    const c = fakeClient();
    taskQueue._test({ client: c });
    await taskQueue.enqueueJobDispatch(1, Date.now());
    await taskQueue.enqueueJobDispatch(2, Date.now());
    expect(c.getProjectId).toHaveBeenCalledTimes(1);
    expect(c.createTask).toHaveBeenCalledTimes(2);
  });

  test('ACCEL_WINDOW_MS is the shared 90s horizon callers gate on', () => {
    expect(taskQueue.ACCEL_WINDOW_MS).toBe(90 * 1000);
  });
});

describe('lib/taskQueue.warmup (boot-time, startup/init.js)', () => {

  test('unconfigured (no CLOUD_TASKS_LOCATION) → false, no client work', async () => {
    const c = fakeClient();
    taskQueue._test({ client: c });
    await expect(taskQueue.warmup()).resolves.toBe(false);
    expect(c.getProjectId).not.toHaveBeenCalled();
  });

  test('configured → one getQueue against the right queue path, true (runs on env alone — enabled flag NOT required, it can flip at runtime)', async () => {
    process.env.CLOUD_TASKS_LOCATION = 'us-central1';
    const getQueue = jest.fn(async () => [{}]);
    const c = fakeClient({ getQueue });
    taskQueue._test({ client: c });
    await expect(taskQueue.warmup()).resolves.toBe(true);
    const [{ name }, opts] = getQueue.mock.calls[0];
    expect(name).toBe('projects/test-proj/locations/us-central1/queues/yc-jobs');
    expect(opts).toEqual({ timeout: 15000 });
  });

  test('PERMISSION_DENIED (enqueuer-only IAM) still counts as warm — channel and token are established by then', async () => {
    process.env.CLOUD_TASKS_LOCATION = 'us-central1';
    const err = Object.assign(new Error('denied'), { code: 7 });
    const c = fakeClient({ getQueue: jest.fn(async () => { throw err; }) });
    taskQueue._test({ client: c });
    await expect(taskQueue.warmup()).resolves.toBe(true);
  });

  test('queue NOT_FOUND (typo\'d region/queue) → false and a loud warn — the config-validation payoff', async () => {
    process.env.CLOUD_TASKS_LOCATION = 'us-central1';
    const err = Object.assign(new Error('missing'), { code: 5 });
    const c = fakeClient({ getQueue: jest.fn(async () => { throw err; }) });
    taskQueue._test({ client: c });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(taskQueue.warmup()).resolves.toBe(false);
      expect(warnSpy.mock.calls.some((a) => /NOT FOUND/.test(a[0]))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('NEVER-THROWS: metadata failure during warmup resolves false and does not poison later enqueues', async () => {
    process.env.CLOUD_TASKS_LOCATION = 'us-central1';
    process.env.CLOUD_TASKS_ENABLED = '1';
    process.env.APP_URL = 'https://app.example.test';
    process.env.INTERNAL_API_KEY = 'k';
    const getProjectId = jest.fn()
      .mockRejectedValueOnce(new Error('boot blip'))
      .mockResolvedValue('test-proj');
    const c = fakeClient({ getProjectId });
    taskQueue._test({ client: c });
    await expect(taskQueue.warmup()).resolves.toBe(false);
    // Later runtime enqueue must still work (rejection was not cached).
    await expect(taskQueue.enqueueJobDispatch(3, Date.now())).resolves.toBe(true);
  });
});
