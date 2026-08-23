/**
 * tests/processJobs.targeted.test.js
 *
 * routes/process_jobs.js — the runJobPass extraction and the targeted
 * POST /process-job/:id dispatch route (Cloud Tasks slice, P1 2026-08).
 *
 * WHAT IS LOCKED SHUT
 *   1. HEARTBEAT ISOLATION: the targeted path must NEVER stamp
 *      process_jobs_last_heartbeat_at. The heartbeat means "the POLL cycle
 *      ran" — routes/api.systemStatus.js uses its age to detect a dead
 *      Cloud Scheduler job. If task traffic stamped it, a dead cron would be
 *      masked by task dispatches and nobody would find out. The batch path
 *      must KEEP stamping it (0-jobs and post-batch).
 *   2. HOUSEKEEPING ISOLATION: recoverStuckJobs runs on the batch path only.
 *      Per-task recovery sweeps multiply DB load by the task rate for no
 *      benefit.
 *   3. ALREADY_CLAIMED IS 200: Cloud Tasks retries on any non-2xx. A job the
 *      cron got to first is a normal outcome — a non-2xx here would retry a
 *      no-op forever-ish.
 *   4. TARGETED CLAIM PREDICATES: id + status='pending' + active=1 + due +
 *      not-expired + under max_executions — identical gate to the batch, so
 *      a task can never execute a paused/expired/not-yet-due job early.
 *   5. Malformed :id → 400 (Cloud Tasks does NOT retry 4xx — correct for a
 *      request that can never succeed).
 *   6. Auth: the new route sits behind the same jwtOrApiKey gate.
 *
 * Live express app on an ephemeral port (the f_route.x21 pattern); DB is a
 * matcher-based recording stub; workflow/sequence/job executors are mocked at
 * the module boundary — this suite is about routing, claiming, and gating,
 * not about what an executor does.
 *
 * Run: npx jest tests/processJobs.targeted.test.js
 */

'use strict';

process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'yci_test_internal';
const KEY = process.env.INTERNAL_API_KEY;

jest.mock('../lib/workflow_engine', () => ({
  advanceWorkflow: jest.fn(async () => ({ status: 'completed' })),
  scheduleResume: jest.fn(async () => {}),
}));
jest.mock('../lib/job_executor', () => ({ executeJob: jest.fn(async () => ({ ok: true })) }));
jest.mock('../lib/sequenceEngine', () => ({ executeStep: jest.fn(async () => ({ status: 'sent' })) }));

const { advanceWorkflow } = require('../lib/workflow_engine');

const express = require('express');

// ─────────────────────────────────────────────────────────────
// Recording stub pool — matcher-based
// ─────────────────────────────────────────────────────────────
//
// makeDb({ claimRows }) — claimRows is what the FOR UPDATE claim SELECT
// returns (targeted or batch). Every statement (pool or transaction
// connection) lands in `calls` for assertion.

function makeDb({ claimRows = [] } = {}) {
  const calls = [];
  async function query(sql, params) {
    calls.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ');
    if (s.includes('FROM scheduled_jobs') && s.includes('FOR UPDATE')) {
      return [claimRows.map((r) => ({ ...r }))];
    }
    if (s.includes('UPDATE workflow_executions') && s.includes("status IN ('delayed', 'active', 'processing')")) {
      return [{ affectedRows: 1 }];
    }
    // recoverStuckJobs' exec sweep SELECT
    if (s.includes('FROM workflow_executions') && s.includes("status = 'processing'")) {
      return [[]];
    }
    return [{ affectedRows: 1, insertId: 1 }];
  }
  return {
    calls,
    query,
    async withTransaction(fn /* , opts */) {
      return fn({ query });
    },
  };
}

const heartbeatCalls = (db) =>
  db.calls.filter((c) => c.sql.includes('process_jobs_last_heartbeat_at'));
const recoveryCalls = (db) =>
  db.calls.filter((c) => c.sql.replace(/\s+/g, ' ').includes("status = 'running' AND updated_at < NOW()"));

// ─────────────────────────────────────────────────────────────
// App bootstrap — fresh db stub per test, injected by reference
// ─────────────────────────────────────────────────────────────

let server, base, currentDb;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = currentDb; next(); });
  app.use(require('../routes/process_jobs'));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(done);
});
beforeEach(() => { advanceWorkflow.mockClear(); });

const post = (p, headers = {}) =>
  fetch(base + p, { method: 'POST', headers: { 'x-api-key': KEY, ...headers } });

const RESUME_JOB = {
  id: 50, type: 'workflow_resume', status: 'pending', active: 1,
  attempts: 0, max_attempts: 1, execution_count: 0, backoff_seconds: 60,
  data: JSON.stringify({ nextStep: 1, executionId: 7 }),
};

describe('POST /process-job/:id (targeted dispatch)', () => {

  test('malformed id → 400, before any DB work', async () => {
    currentDb = makeDb();
    for (const bad of ['abc', '1.5', '-3', '0']) {
      const res = await post(`/process-job/${bad}`);
      expect(res.status).toBe(400);
    }
    // Only auth-audit logging may have touched the stub — no claim attempted.
    expect(currentDb.calls.some((c) => c.sql.includes('scheduled_jobs'))).toBe(false);
  });

  test('unauthenticated → 401 (same jwtOrApiKey gate as the cron route)', async () => {
    currentDb = makeDb();
    const res = await fetch(base + '/process-job/50', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  test('job not claimable (cron won the race / done / inactive) → 200 already_claimed, NO heartbeat, NO recovery sweep', async () => {
    currentDb = makeDb({ claimRows: [] });
    const res = await post('/process-job/50');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      processed: 0,
      results: [{ id: 50, status: 'already_claimed' }],
    });
    expect(heartbeatCalls(currentDb)).toHaveLength(0);   // lock 1
    expect(recoveryCalls(currentDb)).toHaveLength(0);    // lock 2
    expect(advanceWorkflow).not.toHaveBeenCalled();
  });

  test('pending workflow_resume → claimed by id with full predicate set, dispatched, completed — and still NO heartbeat', async () => {
    currentDb = makeDb({ claimRows: [RESUME_JOB] });
    const res = await post('/process-job/50');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(1);
    expect(body.results[0]).toMatchObject({ id: 50, status: 'dispatched' });

    // Lock 4 — the targeted claim carries every batch predicate, keyed by id.
    const claim = currentDb.calls.find((c) => c.sql.includes('FOR UPDATE'));
    const s = claim.sql.replace(/\s+/g, ' ');
    expect(s).toContain('WHERE id = ?');
    expect(s).toContain("status = 'pending'");
    expect(s).toContain('active = 1');
    expect(s).toContain('scheduled_time <= NOW()');
    expect(s).toContain('expires_at IS NULL OR expires_at > NOW()');
    expect(s).toContain('max_executions IS NULL OR execution_count < max_executions');
    expect(s).toContain('SKIP LOCKED');
    expect(claim.params).toEqual([50]);

    // Claimed row flipped to running, executor ran, job closed.
    expect(currentDb.calls.some((c) =>
      c.sql.includes("SET status = 'running'") && String(c.params[0]) === '50'
    )).toBe(true);
    expect(advanceWorkflow).toHaveBeenCalledWith(7, currentDb);
    expect(currentDb.calls.some((c) =>
      c.sql.includes("SET status = 'completed'") && c.params[0] === 50
    )).toBe(true);

    expect(heartbeatCalls(currentDb)).toHaveLength(0);   // lock 1, hot path
    expect(recoveryCalls(currentDb)).toHaveLength(0);    // lock 2
  });
});

describe('/process-jobs (cron batch — externally unchanged)', () => {

  test('0 due jobs → {processed:0,results:[]}, heartbeat stamped, recovery sweep ran', async () => {
    currentDb = makeDb({ claimRows: [] });
    const res = await post('/process-jobs');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ processed: 0, results: [] });
    expect(heartbeatCalls(currentDb)).toHaveLength(1);
    expect(recoveryCalls(currentDb).length).toBeGreaterThan(0);
  });

  test('batch with a resume job → dispatched AND heartbeat stamped after the batch', async () => {
    currentDb = makeDb({ claimRows: [RESUME_JOB] });
    const res = await post('/process-jobs');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(1);
    expect(advanceWorkflow).toHaveBeenCalledWith(7, currentDb);
    expect(heartbeatCalls(currentDb)).toHaveLength(1);
  });
});
