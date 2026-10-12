/**
 * tests/hookReplay.routes.test.js
 *
 * POST /internal/hook-replay (routes/internal/hookReplay.js) — the Cloud Tasks
 * push target that runs a hook event captured during MAINTENANCE_MODE.
 *
 * The route is mounted through routes/internal.js (the real auto-mount) behind
 * the REAL lib/auth.jwtOrApiKey, so the auth cases are the ones production
 * will see. hookService and lib/alerting are mocked; the DB is a fake that
 * records every statement.
 *
 * WHAT IS LOCKED SHUT
 *   1. INTERNAL KEY ONLY. This endpoint is "run any hook with any payload,
 *      skipping per-hook authentication" — a staff JWT and a DB-issued API key
 *      (even one LABELLED "internal") are both refused, and nothing runs.
 *   2. IDEMPOTENT. Cloud Tasks delivers at least once; a redelivery whose
 *      spool_id already has a hook_executions row answers 200 and runs
 *      nothing.
 *   3. RETRY SEMANTICS match what Cloud Tasks does with them: 5xx only when
 *      nothing ran (safe to retry); 200 when the event ran — even if a target
 *      then failed — or can never run (no hook: alerted, not retried).
 *   4. The pipeline gets the captured input intact, plus meta.replayed_at, the
 *      re-resolved hook (catch-all included), and the slow phase is AWAITED
 *      before the 200.
 *
 * Run: npx jest tests/hookReplay.routes.test.js
 */

'use strict';

jest.mock('../services/hookService', () => ({
  getHookBySlug: jest.fn(),
  executeHook: jest.fn(),
}));
jest.mock('../lib/alerting', () => ({ alert: jest.fn() }));

const express = require('express');
const jwt = require('jsonwebtoken');
const hookService = require('../services/hookService');
const { alert } = require('../lib/alerting');
const hookSpool = require('../lib/hookSpool');
const { isInternalKey } = require('../routes/internal/hookReplay');

const INTERNAL_KEY = 'yci_test_internal_key';
const EXTERNAL_KEY = 'yck_some_external_source_key';
const HOOK = { id: 5, slug: 'test-hook', auth_type: 'api_key', capture_mode: 'off', targets: [] };
const CATCHALL = { id: 9, slug: '_catchall', auth_type: 'none', capture_mode: 'off', targets: [] };

const ENV_KEYS = ['INTERNAL_API_KEY', 'JWT_SECRET', 'JWT_VERSION', 'MAINTENANCE_MODE'];
const saved = {};
let server, base, queries, dupeRows, dbFail, logSpy, errSpy;

// Fake DB. Routes every statement the route (and the real auth middleware)
// issues; anything unexpected resolves empty, like an unrelated SELECT would.
const db = {
  query: jest.fn(async (sql, params) => {
    queries.push({ sql: String(sql), params });
    if (/FROM api_keys/i.test(sql)) {
      // An external key that an admin happened to LABEL "internal".
      return [[{ id: 44, label: 'internal', revoked_at: null }]];
    }
    if (/FROM hook_executions/i.test(sql)) {
      if (dbFail) throw dbFail;
      return [dupeRows];
    }
    return [[]];
  }),
};

beforeAll((done) => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use(require('../routes/internal'));   // the real auto-mount
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(done);
});
beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.INTERNAL_API_KEY = INTERNAL_KEY;
  process.env.JWT_SECRET = 'test-secret';
  queries = [];
  dupeRows = [];
  dbFail = null;
  db.query.mockClear();
  hookService.getHookBySlug.mockReset().mockImplementation(async (_db, slug) => (slug === 'test-hook' ? HOOK : null));
  hookService.executeHook.mockReset().mockResolvedValue({ status: 'delivered', executionId: 77, targets: [] });
  alert.mockReset();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  logSpy.mockRestore(); errSpy.mockRestore();
});

const SPOOL_ID = 'a'.repeat(32);

function task(overrides = {}) {
  const spool_id = overrides.spool_id || SPOOL_ID;
  return {
    spool_id,
    slug: 'test-hook',
    input: {
      body: { lead: 'Jane' },
      headers: { 'user-agent': 'sender/1.0' },
      query: { src: 'web' },
      method: 'POST',
      meta: {
        source: 'http', received_at: '2026-10-18T06:30:00.000Z', slug: 'test-hook',
        remote_ip: '203.0.113.9', spooled: true, spool_id,
      },
    },
    ...overrides,
  };
}

const post = (body, headers = { 'x-api-key': INTERNAL_KEY }) =>
  fetch(`${base}${hookSpool.REPLAY_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const staffJwt = () => jwt.sign(
  { sub: 1, username: 'fred', user_type: 'su', user_auth: 'authorized - su' },
  process.env.JWT_SECRET
);

describe('auth — the internal key and nothing else', () => {
  test('no credentials → 401, nothing runs', async () => {
    const res = await post(task(), {});
    expect(res.status).toBe(401);
    expect(hookService.executeHook).not.toHaveBeenCalled();
  });

  test('a valid staff JWT → 403, nothing runs', async () => {
    const res = await post(task(), { Authorization: `Bearer ${staffJwt()}` });
    expect(res.status).toBe(403);
    expect(hookService.getHookBySlug).not.toHaveBeenCalled();
    expect(hookService.executeHook).not.toHaveBeenCalled();
  });

  test('a DB-issued API key → 403, even when its label is "internal"', async () => {
    const res = await post(task(), { 'x-api-key': EXTERNAL_KEY });
    expect(res.status).toBe(403);
    // Proves the request really was authenticated as the labelled external
    // key (so the 403 came from the route's check, not from a 401).
    expect(queries.some((q) => /FROM api_keys/i.test(q.sql))).toBe(true);
    expect(hookService.executeHook).not.toHaveBeenCalled();
  });

  test('the internal key → runs', async () => {
    const res = await post(task());
    expect(res.status).toBe(200);
    expect(hookService.executeHook).toHaveBeenCalledTimes(1);
  });

  test('isInternalKey: exact shape only', () => {
    expect(isInternalKey({ type: 'api_key', key_label: 'internal' })).toBe(true);
    expect(isInternalKey({ type: 'api_key', key_label: 'internal', key_id: 44 })).toBe(false);
    expect(isInternalKey({ type: 'api_key', key_label: 'zapier' })).toBe(false);
    expect(isInternalKey({ type: 'jwt', key_label: 'internal' })).toBe(false);
    expect(isInternalKey({ type: 'jwt', userId: 1 })).toBe(false);
    expect(isInternalKey(undefined)).toBe(false);
    expect(isInternalKey(null)).toBe(false);
  });
});

describe('malformed task → 400 (can never succeed), nothing runs', () => {
  const t = task();
  test.each([
    ['empty body', {}],
    ['no slug', { ...t, slug: undefined }],
    ['empty slug', { ...t, slug: '' }],
    ['non-string slug', { ...t, slug: 7 }],
    ['no spool_id', { ...t, spool_id: undefined }],
    ['spool_id of the wrong shape', { ...t, spool_id: 'not-a-spool-id' }],
    ['no input', { ...t, input: undefined }],
    ['input is an array', { ...t, input: [] }],
    ['input is a string', { ...t, input: 'x' }],
    ['input without meta', { ...t, input: { body: {} } }],
    ['meta.spool_id differs from spool_id', { ...t, spool_id: 'b'.repeat(32) }],
  ])('%s', async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(hookService.getHookBySlug).not.toHaveBeenCalled();
    expect(hookService.executeHook).not.toHaveBeenCalled();
    expect(queries.some((q) => /hook_executions/i.test(q.sql))).toBe(false);
  });
});

describe('replay', () => {
  test('runs the pipeline with the captured input + replayed_at, split-phase, with the re-resolved hook', async () => {
    const before = Date.now();
    const res = await post(task());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'replayed', spool_id: SPOOL_ID, slug: 'test-hook', result: 'delivered', execution_id: 77,
    });

    expect(hookService.executeHook).toHaveBeenCalledTimes(1);
    const [dbArg, slugArg, inputArg, optsArg] = hookService.executeHook.mock.calls[0];
    expect(dbArg).toBe(db);
    expect(slugArg).toBe('test-hook');
    expect(optsArg).toEqual({ hook: HOOK, splitPhase: true });

    const sent = task().input;
    expect(inputArg.body).toEqual(sent.body);
    expect(inputArg.headers).toEqual(sent.headers);
    expect(inputArg.query).toEqual(sent.query);
    expect(inputArg.method).toBe('POST');
    const { replayed_at, ...metaRest } = inputArg.meta;
    expect(metaRest).toEqual(sent.meta);                       // received_at etc. untouched
    expect(Date.parse(replayed_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(replayed_at)).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test('the idempotency lookup is keyed on this spool_id and bounded in time', async () => {
    await post(task());
    const q = queries.find((x) => /FROM hook_executions/i.test(x.sql));
    expect(q).toBeDefined();
    expect(q.params).toEqual([SPOOL_ID]);
    expect(q.sql).toMatch(/\$\.meta\.spool_id/);
    expect(q.sql).toMatch(/created_at\s*>\s*NOW\(\)\s*-\s*INTERVAL\s+35\s+DAY/i);
  });

  test('REDELIVERY: an execution row with this spool_id exists → 200, nothing runs', async () => {
    dupeRows = [{ id: 4242 }];
    const res = await post(task());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'already_replayed', spool_id: SPOOL_ID, execution_id: 4242 });
    expect(hookService.getHookBySlug).not.toHaveBeenCalled();
    expect(hookService.executeHook).not.toHaveBeenCalled();
  });

  test('the slow (detached) phase is AWAITED before the 200', async () => {
    let finishSlow;
    let slowDone = false;
    const detached = new Promise((resolve) => { finishSlow = resolve; }).then(() => { slowDone = true; });
    hookService.executeHook.mockResolvedValue({ status: 'accepted', executionId: 78, detached });

    let answered = false;
    const pending = post(task()).then((r) => { answered = true; return r; });
    // Give the route ample time to (wrongly) answer early.
    await new Promise((r) => setTimeout(r, 150));
    expect(hookService.executeHook).toHaveBeenCalledTimes(1);
    expect(answered).toBe(false);

    finishSlow();
    const res = await pending;
    expect(slowDone).toBe(true);
    expect(res.status).toBe(200);
    expect((await res.json()).execution_id).toBe(78);
  });

  test('a slow-phase FAILURE is still a 200 — the event has run; a retry would run it twice', async () => {
    const detached = Promise.reject(new Error('target exploded'));
    detached.catch(() => {});
    hookService.executeHook.mockResolvedValue({ status: 'accepted', executionId: 79, detached });
    const res = await post(task());
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('replayed');
  });

  test('a filtered result (no detached phase) is a 200', async () => {
    hookService.executeHook.mockResolvedValue({ status: 'filtered', executionId: 80 });
    const res = await post(task());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'replayed', result: 'filtered', execution_id: 80 });
  });

  test('a captured result reports execution_id from the capture-mode shape', async () => {
    hookService.executeHook.mockResolvedValue({ status: 'captured', execution_id: 81 });
    const res = await post(task());
    expect(await res.json()).toMatchObject({ status: 'replayed', result: 'captured', execution_id: 81 });
  });
});

describe('hook resolution at replay time', () => {
  test('slug no longer has a hook → falls back to the catch-all, slug preserved', async () => {
    hookService.getHookBySlug.mockImplementation(async (_db, slug) => (slug === '_catchall' ? CATCHALL : null));
    const res = await post(task({ slug: 'gone-hook' }));
    expect(res.status).toBe(200);
    expect(hookService.getHookBySlug.mock.calls.map((c) => c[1])).toEqual(['gone-hook', '_catchall']);
    const [, slugArg, , optsArg] = hookService.executeHook.mock.calls[0];
    expect(slugArg).toBe('gone-hook');
    expect(optsArg.hook).toBe(CATCHALL);
    expect(alert).not.toHaveBeenCalled();
  });

  test('no hook and no catch-all → 200 dropped (a retry cannot fix it) + an error alert', async () => {
    hookService.getHookBySlug.mockResolvedValue(null);
    const res = await post(task({ slug: 'gone-hook' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'dropped_no_hook', spool_id: SPOOL_ID, slug: 'gone-hook' });
    expect(hookService.executeHook).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
    const [alertDb, opts] = alert.mock.calls[0];
    expect(alertDb).toBe(db);
    expect(opts).toMatchObject({
      source: 'hook', kind: 'spool_replay_dropped', severity: 'error',
      group_key: 'hook:spool_replay_dropped:gone-hook',
    });
    expect(opts.message).toContain(SPOOL_ID);
    expect(opts.message).toContain('2026-10-18T06:30:00.000Z');
    // The alert must point at where the payload really is.
    expect(opts.message).toContain(`DROPPED spooled event ${SPOOL_ID}`);
    expect(opts.message).not.toMatch(/Cloud Tasks/i);
  });

  test('a dropped event leaves its FULL payload in the log — the 200 makes Cloud Tasks delete the task', async () => {
    hookService.getHookBySlug.mockResolvedValue(null);
    const sent = task({ slug: 'gone-hook' });
    await post(sent);
    const line = errSpy.mock.calls.map((c) => c.join(' ')).find((l) => l.includes(`DROPPED spooled event ${SPOOL_ID}`));
    expect(line).toBeDefined();
    const logged = JSON.parse(line.slice(line.indexOf('PAYLOAD ') + 'PAYLOAD '.length));
    expect(logged).toEqual({ spool_id: SPOOL_ID, slug: 'gone-hook', input: sent.input });
  });

  test('an alerting failure does not turn the drop into a retry', async () => {
    hookService.getHookBySlug.mockResolvedValue(null);
    alert.mockImplementation(() => { throw new Error('alerting down'); });
    const res = await post(task({ slug: 'gone-hook' }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('dropped_no_hook');
  });
});

describe('failures BEFORE the pipeline started → 500 so Cloud Tasks retries', () => {
  test('the idempotency lookup fails (DB blip)', async () => {
    dbFail = new Error('ECONNRESET');
    const res = await post(task());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ status: 'error', message: 'replay failed', spool_id: SPOOL_ID });
    expect(hookService.executeHook).not.toHaveBeenCalled();
  });

  test('the hook lookup fails', async () => {
    hookService.getHookBySlug.mockRejectedValue(new Error('ECONNRESET'));
    const res = await post(task());
    expect(res.status).toBe(500);
    expect(hookService.executeHook).not.toHaveBeenCalled();
  });

  test('executeHook throws (e.g. the execution-row insert failed)', async () => {
    hookService.executeHook.mockRejectedValue(new Error('insert failed'));
    const res = await post(task());
    expect(res.status).toBe(500);
  });

  test('the error body never echoes the payload', async () => {
    hookService.executeHook.mockRejectedValue(new Error('boom with lead Jane'));
    const text = await (await post(task())).text();
    expect(text).not.toMatch(/Jane/);
  });
});
