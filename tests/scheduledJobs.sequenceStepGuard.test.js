/**
 * tests/scheduledJobs.sequenceStepGuard.test.js
 *
 * PATCH /scheduled-jobs/:id — a sequence_step job is editable only while it
 * is pending; and the Scheduled Jobs screen hides the buttons the route
 * refuses.
 *
 * WHY THIS EXISTS
 * Editing scheduled_time on a failed or cancelled job resets it to 'pending'
 * — that is what the jobs manager's Retry button sends. For one_time jobs it
 * is the point. For a sequence step it re-runs the step OUTSIDE the engine's
 * one-job-per-enrollment invariant (traced 2026-10-12):
 *   - enrollment not active → the step is skipped, leaving a junk
 *     sequence_step_log row (step_number 0);
 *   - enrollment active → the step's action runs again and the advance
 *     rewrites current_step and queues the next step. After "Recover stuck
 *     enrollment" that is the same client message sent twice; if the
 *     enrollment had moved on, every step in between re-sends.
 * Recover (re-places the step by its timing) and Fire Now (sends a pending
 * step early) are the tools, so the route refuses and the screen stops
 * offering.
 *
 * WHAT MUST NOT CHANGE
 *   - Moving a PENDING sequence step's time is a legitimate reschedule.
 *   - workflow_resume: retrying a failed resume row is the repair for an
 *     execution stranded 'delayed' (POST /executions/:id/resume refuses a
 *     live execution). Still allowed, still resets to pending.
 *   - hook_retry and ordinary one_time jobs: untouched.
 *
 * The route half runs the real router in-process (the
 * tests/scheduledJobs.doorbell.test.js idiom). The screen half runs the real
 * jobCardHTML() lifted out of public/automation/scheduledJobs.html.
 *
 *   npx jest tests/scheduledJobs.sequenceStepGuard.test.js
 */

'use strict';

process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'yci_test_internal';
const KEY = process.env.INTERNAL_API_KEY;

jest.mock('../lib/taskQueue', () => ({
  enqueueJobDispatch: jest.fn(async () => true),
  ACCEL_WINDOW_MS: 90 * 1000,
  DISPATCH_BUFFER_MS: 2000,
}));

const fs = require('fs');
const path = require('path');
const express = require('express');
const { enqueueJobDispatch } = require('../lib/taskQueue');

function makeDb(jobRow) {
  const calls = [];
  return {
    calls,
    updates: () => calls.filter(c => /^UPDATE scheduled_jobs/i.test(c.sql.trim())),
    async query(sql, params) {
      calls.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ');
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

async function patch(jobRow, body) {
  currentDb = makeDb(jobRow);
  const res = await fetch(`${base}/scheduled-jobs/${jobRow.id}`, {
    method: 'PATCH',
    headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), db: currentDb };
}

const NOW_ISO = () => new Date().toISOString();

// ─────────────────────────────────────────────────────────────
describe('PATCH /scheduled-jobs/:id — sequence_step is pending-only', () => {
  test.each(['failed', 'cancelled'])('Retry (scheduled_time → now) on a %s sequence step is refused, and nothing is written', async (status) => {
    const r = await patch({ id: 353, status, type: 'sequence_step' }, { scheduled_time: NOW_ISO() });

    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(new RegExp(`Cannot edit or retry a ${status} sequence step job`));
    expect(r.body.error).toMatch(/Recover stuck enrollment/);
    expect(r.body.error).toMatch(/Fire Now/);
    expect(r.db.updates()).toHaveLength(0);          // never reset to pending
    expect(enqueueJobDispatch).not.toHaveBeenCalled();
  });

  test('a non-time edit of a failed sequence step is refused too — the rule is "pending only", not "no retry"', async () => {
    const r = await patch({ id: 353, status: 'failed', type: 'sequence_step' }, { name: 'renamed' });
    expect(r.status).toBe(409);
    expect(r.db.updates()).toHaveLength(0);
  });

  test('moving a PENDING sequence step is still allowed — a reschedule, with no status reset', async () => {
    const r = await patch({ id: 6274, status: 'pending', type: 'sequence_step' }, { scheduled_time: NOW_ISO() });

    expect(r.status).toBe(200);
    const [upd] = r.db.updates();
    expect(upd.sql).toMatch(/scheduled_time = \?/);
    expect(upd.sql).not.toMatch(/status = 'pending'/);
    expect(enqueueJobDispatch).toHaveBeenCalledTimes(1);
    expect(enqueueJobDispatch.mock.calls[0][0]).toBe(6274);
  });

  test('a completed sequence step keeps the general refusal', async () => {
    const r = await patch({ id: 1, status: 'completed', type: 'sequence_step' }, { scheduled_time: NOW_ISO() });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Only pending, failed, or cancelled jobs can be edited/);
  });
});

describe('PATCH /scheduled-jobs/:id — what the guard must leave alone', () => {
  test.each([
    ['workflow_resume', 'failed'],     // the repair for an execution stranded 'delayed'
    ['workflow_resume', 'cancelled'],
    ['hook_retry', 'failed'],          // explicit re-delivery
    ['one_time', 'failed'],
    ['one_time', 'cancelled'],
  ])('Retry on a %s job that is %s still resets it to pending', async (type, status) => {
    const r = await patch({ id: 77, status, type }, { scheduled_time: NOW_ISO() });

    expect(r.status).toBe(200);
    const [upd] = r.db.updates();
    expect(upd.sql).toMatch(/status = 'pending'/);
    expect(upd.sql).toMatch(/attempts = 0/);
    expect(enqueueJobDispatch).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────
// The screen: the real jobCardHTML(), lifted from the page source.
// ─────────────────────────────────────────────────────────────
describe('Scheduled Jobs screen — buttons match the route', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'automation', 'scheduledJobs.html'), 'utf8');
  const start = html.indexOf('function jobCardHTML(job) {');
  const end = html.indexOf('\n}\n', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  // eslint-disable-next-line no-new-func
  const jobCardHTML = new Function('esc', `${html.slice(start, end + 2)}; return jobCardHTML;`)(s => String(s));

  const card = (type, status) => jobCardHTML({
    id: 9, type, status, name: 'job', scheduled_time: '2026-10-12T15:00:00Z',
    active: 1, execution_count: 0, attempts: 0,
  });
  const hasEdit  = (h) => /onclick="jobEdit\(9\)"/.test(h);
  const hasRetry = (h) => /onclick="jobRetry\(9\)"/.test(h);

  test.each([
    // type,             status,      edit,  retry
    ['sequence_step',   'pending',   true,  false],
    ['sequence_step',   'failed',    false, false],
    ['sequence_step',   'cancelled', false, false],
    ['sequence_step',   'completed', false, false],
    ['workflow_resume', 'pending',   true,  false],
    ['workflow_resume', 'failed',    true,  true],
    ['workflow_resume', 'cancelled', true,  true],
    ['hook_retry',      'failed',    true,  true],
    ['one_time',        'pending',   true,  false],
    ['one_time',        'failed',    true,  true],
    ['one_time',        'cancelled', true,  true],
    ['one_time',        'completed', false, false],
    ['recurring',       'cancelled', true,  true],
  ])('%s / %s → edit %s, retry %s', (type, status, edit, retry) => {
    const h = card(type, status);
    expect(hasEdit(h)).toBe(edit);
    expect(hasRetry(h)).toBe(retry);
    // View is always there — the card is still a card.
    expect(h).toMatch(/onclick="jobView\(9\)"/);
  });
});
