// tests/mailEventHook.routes.test.js
//
/**
 * YisraMail T2 — the SES event path through YisraHook, end to end on the REAL
 * receiver (routes/api.hooks.js) and the REAL hookService over a scripted db:
 *   - POST /hooks/ses-events with the key in x-api-key (what the EventBridge
 *     Connection sends) → 200 {status:'received'}, one queued execution row,
 *     the key NOT stored; a wrong / missing key → 401, nothing stored;
 *   - the same EventBridge event id POSTed again (an EventBridge retry, or the
 *     DLQ replay) → 200, recorded as a duplicate: no second row, nothing
 *     queued, nothing runs (hooks.dedup_path = body.id);
 *   - the drain's call (executeHook with the executionId) runs the target
 *     internal_function mail_event_ingest with params.event = the event body
 *     (params_mapping event ← body).
 * lib/taskQueue (the doorbell) is mocked; mail_event_ingest itself is spied
 * (its behaviour is tests/mailEventIngest.mysql.test.js's).
 * Run: npx jest tests/mailEventHook.routes.test.js
 */

'use strict';

jest.mock('../lib/taskQueue', () => ({
  enqueueHookExecutionDispatch: jest.fn(async () => true),
  enqueueJobDispatch: jest.fn(async () => true),
  enqueueDomainEventDispatch: jest.fn(async () => true),
}));

const fs = require('fs');
const path = require('path');
const express = require('express');
const taskQueue = require('../lib/taskQueue');
const hookService = require('../services/hookService');
const registry = require('../lib/internal_functions');
const H = require('../lib/hookCredentialHeaders');

const KEY = 'ses-hook-key-FAKE-0001'; // test literal only — secret-scan: allow
const EVENT = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ses-events', 'bounce-permanent.json'), 'utf8'));
const HOOK = { id: 70, slug: 'ses-events', active: 1, auth_type: 'api_key', auth_config: { header: 'x-api-key', key: KEY },
  filter_mode: 'none', transform_mode: 'passthrough', capture_mode: 'off', dedup_path: 'body.id' };
const TARGET = { id: 71, hook_id: 70, target_type: 'internal_function', name: 'mail_event_ingest', position: 0,
  config: { function_name: 'mail_event_ingest', params_mapping: { event: 'body' } }, conditions: null,
  transform_mode: 'passthrough', transform_config: null, active: 1 };

function makeDb() {
  const execs = [];
  const logs = [];
  const keys = new Set();
  const query = jest.fn(async (sql, p = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === H.UNION_SQL) return [[{ header: 'x-api-key' }]];
    if (/^SELECT \* FROM hooks WHERE slug = \?/.test(s)) return [p[0] === HOOK.slug ? [{ ...HOOK }] : []];
    if (/FROM hook_targets ht/.test(s)) return [[{ ...TARGET }]];
    if (/^INSERT INTO hook_executions/.test(s)) {
      const dedupKey = p[5];
      if (dedupKey != null && keys.has(dedupKey)) throw Object.assign(new Error("Duplicate entry for key 'uq_hook_dedup'"), { code: 'ER_DUP_ENTRY', errno: 1062 });
      if (dedupKey != null) keys.add(dedupKey);
      execs.push({ id: 500 + execs.length, raw: JSON.parse(p[2]), dedupKey });
      return [{ insertId: 500 + execs.length - 1 }];
    }
    if (/^INSERT INTO hook_delivery_logs/.test(s)) { logs.push(p); return [{ insertId: 1 }]; }
    if (/^UPDATE hook_executions/.test(s)) return [{ affectedRows: 1 }];
    return [[]];
  });
  return { query, execs, logs };
}

let currentDb;
let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = currentDb; next(); });
  app.use(require('../routes/api.hooks'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => {
  H.invalidateConfiguredHeaderNames();
  taskQueue.enqueueHookExecutionDispatch.mockClear();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  currentDb = makeDb();
});
afterEach(() => jest.restoreAllMocks());

const post = (key, body = EVENT) => fetch(`${base}/hooks/ses-events`, { method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...(key ? { 'x-api-key': key } : {}) }, body: JSON.stringify(body) });

test('the EventBridge POST: 200 received, one queued row keyed by the event id, the key not stored', async () => {
  const r = await post(KEY);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ status: 'received', slug: 'ses-events' });
  expect(currentDb.execs).toHaveLength(1);
  expect(currentDb.execs[0].dedupKey).toBe(EVENT.id);
  expect(currentDb.execs[0].raw.body).toEqual(EVENT);
  expect(JSON.stringify(currentDb.execs)).not.toContain(KEY);
  expect(taskQueue.enqueueHookExecutionDispatch).toHaveBeenCalledTimes(1);
});

test('a wrong or missing key → 401, nothing stored, nothing queued', async () => {
  for (const k of ['nope', null]) {
    const r = await post(k);
    expect(r.status).toBe(401);
  }
  expect(currentDb.execs).toEqual([]);
  expect(taskQueue.enqueueHookExecutionDispatch).not.toHaveBeenCalled();
});

test('the same event id again (EventBridge retry / DLQ replay) → 200, a duplicate: no second row, nothing queued or run', async () => {
  const spy = jest.spyOn(registry, 'mail_event_ingest').mockResolvedValue({ success: true });
  expect((await post(KEY)).status).toBe(200);
  const again = await post(KEY);
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual({ status: 'received', slug: 'ses-events' });
  expect(currentDb.execs).toHaveLength(1);
  expect(taskQueue.enqueueHookExecutionDispatch).toHaveBeenCalledTimes(1);
  expect(spy).not.toHaveBeenCalled();
});

test('the drain\'s run calls mail_event_ingest with params.event = the event body', async () => {
  const spy = jest.spyOn(registry, 'mail_event_ingest').mockResolvedValue({ success: true, output: { parsed: 1 } });
  await post(KEY);
  const row = currentDb.execs[0];
  const result = await hookService.executeHook(currentDb, 'ses-events', row.raw, { hook: await hookService.getHookBySlug(currentDb, 'ses-events'), executionId: row.id });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0][0]).toEqual({ event: EVENT });
  expect(spy.mock.calls[0][1]).toBe(currentDb);
  expect(result && result.status).not.toBe('failed');
});
