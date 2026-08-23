/**
 * tests/scheduledJobs.doorbell.test.js
 *
 * The "human is waiting" doorbell call sites added 2026-08-23 (review item 6):
 * routes/scheduled_jobs.js POST (near-immediate creation — default schedule is
 * now+5s, `delay` accepts "30s") and PATCH (admin moves a job to now/near-now
 * by in-place UPDATE, so no insert-site enqueue exists for it).
 *
 * WHAT IS LOCKED SHUT
 *   1. POST one_time due ≤90s → enqueues with the fresh insertId and due ms.
 *   2. POST one_time due far-future → row created, NO enqueue (calendar, not
 *      doorbell).
 *   3. POST recurring → NEVER enqueues, even at a near-immediate first tick —
 *      immortal row ids fight named-task retention (taskQueue header §3a).
 *   4. PATCH moving scheduled_time to now → enqueues for that job id.
 *   5. PATCH of other fields (no scheduled_time) → no enqueue.
 *   6. PATCH a recurring row's time → no enqueue (same §3a).
 *
 * The sequences run-now site (routes/sequences.js) carries the same 2-line
 * pattern but is NOT covered here: that router transitively loads the full
 * sequenceEngine/versionDiff/timezoneService stack, and stubbing enough of it
 * to boot the route would be a heavy fixture proving little beyond what the
 * pattern tests here already prove. Flagged per the slice's testing ground
 * rules rather than built.
 *
 * taskQueue is mocked at the module boundary; the RPC mechanics live in
 * tests/taskQueue.accel.test.js.
 *
 * Run: npx jest tests/scheduledJobs.doorbell.test.js
 */

'use strict';

process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'yci_test_internal';
const KEY = process.env.INTERNAL_API_KEY;

jest.mock('../lib/taskQueue', () => ({
  enqueueJobDispatch: jest.fn(async () => true),
  ACCEL_WINDOW_MS: 90 * 1000,
  DISPATCH_BUFFER_MS: 2000,
}));

const { enqueueJobDispatch } = require('../lib/taskQueue');
const express = require('express');

const INSERT_ID = 4242;

function makeDb({ jobRow = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('INSERT INTO scheduled_jobs')) {
        return [{ insertId: INSERT_ID, affectedRows: 1 }];
      }
      if (s.includes('SELECT id, status, type FROM scheduled_jobs')) {
        return [jobRow ? [jobRow] : []];
      }
      return [{ affectedRows: 1 }];
    },
    async withTransaction(fn) { return fn({ query: this.query.bind(this) }); },
  };
}

let server, base, currentDb;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = currentDb; next(); });
  app.use(require('../routes/scheduled_jobs'));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(done);
});
beforeEach(() => enqueueJobDispatch.mockClear());

const send = (method, path, body) =>
  fetch(base + path, {
    method,
    headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('POST /scheduled-jobs — creation doorbell', () => {

  test('one_time with a 30s delay (inside the window) → enqueues insertId at the due time', async () => {
    currentDb = makeDb();
    const res = await send('POST', '/scheduled-jobs', {
      type: 'one_time', job_type: 'custom_code', code: 'return 1;', delay: '30s',
    });
    expect(res.status).toBe(201);
    expect((await res.json()).id).toBe(INSERT_ID);

    expect(enqueueJobDispatch).toHaveBeenCalledTimes(1);
    const [jobId, dueMs] = enqueueJobDispatch.mock.calls[0];
    expect(jobId).toBe(INSERT_ID);
    // due ≈ now+30s — inside the 90s window, well clear of both edges.
    const delta = dueMs - Date.now();
    expect(delta).toBeGreaterThan(20 * 1000);
    expect(delta).toBeLessThan(40 * 1000);
  });

  test('one_time with no timing at all (defaults to now+5s) → enqueues — the dead-zone default is exactly the case that matters', async () => {
    currentDb = makeDb();
    const res = await send('POST', '/scheduled-jobs', {
      type: 'one_time', job_type: 'custom_code', code: 'return 1;',
    });
    expect(res.status).toBe(201);
    expect(enqueueJobDispatch).toHaveBeenCalledTimes(1);
  });

  test('one_time scheduled far in the future → row created, NO enqueue', async () => {
    currentDb = makeDb();
    const res = await send('POST', '/scheduled-jobs', {
      type: 'one_time', job_type: 'custom_code', code: 'return 1;',
      scheduled_time: new Date(Date.now() + 3600 * 1000).toISOString(),
    });
    expect(res.status).toBe(201);
    expect(enqueueJobDispatch).not.toHaveBeenCalled();
  });

  test('recurring → NEVER enqueues, even with an imminent first tick', async () => {
    currentDb = makeDb();
    const res = await send('POST', '/scheduled-jobs', {
      type: 'recurring', job_type: 'custom_code', code: 'return 1;',
      recurrence_rule: '* * * * *',
    });
    expect(res.status).toBe(201);
    expect(enqueueJobDispatch).not.toHaveBeenCalled();
  });
});

describe('PATCH /scheduled-jobs/:id — reschedule doorbell', () => {

  test('moving a pending one_time job to now → enqueues that job id at the new time', async () => {
    currentDb = makeDb({ jobRow: { id: 55, status: 'pending', type: 'one_time' } });
    const now = new Date().toISOString();
    const res = await send('PATCH', '/scheduled-jobs/55', { scheduled_time: now });
    expect(res.status).toBe(200);

    expect(enqueueJobDispatch).toHaveBeenCalledTimes(1);
    const [jobId, dueMs] = enqueueJobDispatch.mock.calls[0];
    expect(jobId).toBe(55);
    expect(Math.abs(dueMs - Date.parse(now))).toBeLessThan(1000);
  });

  test('editing other fields without touching scheduled_time → no enqueue', async () => {
    currentDb = makeDb({ jobRow: { id: 55, status: 'pending', type: 'one_time' } });
    const res = await send('PATCH', '/scheduled-jobs/55', { name: 'renamed' });
    expect(res.status).toBe(200);
    expect(enqueueJobDispatch).not.toHaveBeenCalled();
  });

  test('moving scheduled_time far out → no enqueue (calendar, not doorbell)', async () => {
    currentDb = makeDb({ jobRow: { id: 55, status: 'pending', type: 'one_time' } });
    const res = await send('PATCH', '/scheduled-jobs/55', {
      scheduled_time: new Date(Date.now() + 86400 * 1000).toISOString(),
    });
    expect(res.status).toBe(200);
    expect(enqueueJobDispatch).not.toHaveBeenCalled();
  });

  test('a recurring row moved to now → no enqueue (immortal id, §3a)', async () => {
    currentDb = makeDb({ jobRow: { id: 867, status: 'pending', type: 'recurring' } });
    const res = await send('PATCH', '/scheduled-jobs/867', {
      scheduled_time: new Date().toISOString(),
    });
    expect(res.status).toBe(200);
    expect(enqueueJobDispatch).not.toHaveBeenCalled();
  });

  test('a failed one_time job rescheduled to now → reset to pending AND enqueued', async () => {
    currentDb = makeDb({ jobRow: { id: 55, status: 'failed', type: 'one_time' } });
    const res = await send('PATCH', '/scheduled-jobs/55', {
      scheduled_time: new Date().toISOString(),
    });
    expect(res.status).toBe(200);
    // The route resets failed→pending when scheduled_time is edited, so the
    // targeted claim can take the job the task delivers.
    const upd = currentDb.calls.find((c) => c.sql.includes('UPDATE scheduled_jobs SET'));
    expect(upd.sql).toContain("status = 'pending'");
    expect(enqueueJobDispatch).toHaveBeenCalledTimes(1);
  });
});
