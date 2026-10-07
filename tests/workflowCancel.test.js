// tests/workflowCancel.test.js
//
/**
 * Workflow-execution cancel — extracted for the CTA arc (S1, ref/CTA_DESIGN.md
 * §4 / R7) into services/workflowExecutionService.cancelWorkflowExecution,
 * shared by POST /executions/:id/cancel and the cancel_workflow_execution
 * internal function.
 *
 * LOCKS
 *   1. ROUTE CONTRACT — status codes and bodies for every branch (invalid id,
 *      missing/short/non-string reason, not cancellable, success, 500-char
 *      truncation). This block is a CHARACTERIZATION: it was run against the
 *      pre-extraction inline route and passes there too, except the one
 *      deliberate change in (3).
 *   2. CASCADE — one transaction holds the existence check, the status write,
 *      the resume-job DELETE and the decision cascade; paired decision tasks
 *      are dismissed only AFTER commit, through the pool (not the
 *      transaction connection).
 *   3. R7 STATUS GUARD — an execution that finishes between the existence
 *      SELECT and the UPDATE is NOT overwritten 'completed' → 'cancelled'
 *      and none of the cascade runs. (The inline route overwrote it.)
 *   4. INTERNAL FUNCTION — idempotent skip on finished/missing targets,
 *      self-cancel refused, reason required.
 *
 * HARNESS: a stateful fake db whose workflow_executions UPDATE evaluates the
 * statement's own `AND status IN (…)` guard (an unguarded write applies
 * unconditionally — exactly what made the old race real). taskService is
 * mocked: it is not under test and deleteTask would need its own world.
 *
 * Run: npx jest tests/workflowCancel.test.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-cancel';

const mockEvents = [];
jest.mock('../services/taskService', () => ({
  deleteTask: jest.fn(async (db, taskId, userId, opts) => {
    mockEvents.push({ ev: 'deleteTask', taskId, userId, opts, viaPool: !db.__isConn });
  }),
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const taskService = require('../services/taskService');
const { cancelWorkflowExecution, normalizeCancelReason } = require('../services/workflowExecutionService');
const registry = require('../lib/internal_functions');

// ── stateful fake ───────────────────────────────────────────────────────────
let world;

function resetWorld() {
  mockEvents.length = 0;
  world = {
    execs: new Map([
      [10, { id: 10, status: 'delayed', cancel_reason: null, completed_at: null }],
      [11, { id: 11, status: 'completed', cancel_reason: null, completed_at: new Date() }],
      [12, { id: 12, status: 'processing', cancel_reason: null, completed_at: null }],
    ]),
    jobs: [
      { id: 1, type: 'workflow_resume', workflow_execution_id: 10, status: 'pending' },
      { id: 2, type: 'workflow_resume', workflow_execution_id: 10, status: 'completed' },
      { id: 3, type: 'workflow_resume', workflow_execution_id: 12, status: 'pending' },
      { id: 4, type: 'one_time', workflow_execution_id: 10, status: 'pending' },
    ],
    decisions: [
      { id: 51, workflow_execution_id: 10, status: 'pending', paired_task_id: 801 },
      { id: 52, workflow_execution_id: 10, status: 'pending', paired_task_id: null },
      { id: 53, workflow_execution_id: 10, status: 'responded', paired_task_id: 802 },
    ],
    afterSelect: null,   // hook: runs right after the cancellable-status SELECT
  };
}

function inList(sql, status) {
  const m = /AND\s+status\s+IN\s*\(([^)]*)\)/i.exec(sql);
  if (!m) return true;   // unguarded → applies unconditionally
  return m[1].split(',').map((x) => x.trim().replace(/'/g, '')).includes(status);
}

function handle(sqlRaw, params, isConn) {
  const sql = sqlRaw.replace(/\s+/g, ' ').trim();
  mockEvents.push({ ev: 'query', sql, isConn });

  if (/^INSERT INTO jwt_api_audit_log/i.test(sql)) return [{}];

  if (/^SELECT status FROM workflow_executions WHERE id = \? AND status IN/i.test(sql)) {
    const e = world.execs.get(Number(params[0]));
    const rows = e && inList(sql, e.status) ? [{ status: e.status }] : [];
    if (world.afterSelect) world.afterSelect();
    return [rows];
  }
  if (/^SELECT status FROM workflow_executions WHERE id = \?$/i.test(sql)) {
    const e = world.execs.get(Number(params[0]));
    return [e ? [{ status: e.status }] : []];
  }
  if (/^UPDATE workflow_executions SET status = 'cancelled'/i.test(sql)) {
    const e = world.execs.get(Number(params[1]));
    if (!e || !inList(sql, e.status)) return [{ affectedRows: 0 }];
    Object.assign(e, { status: 'cancelled', cancel_reason: params[0], completed_at: new Date() });
    return [{ affectedRows: 1 }];
  }
  if (/^DELETE FROM scheduled_jobs WHERE type = 'workflow_resume' AND workflow_execution_id = \? AND status IN \('pending', 'running'\)$/i.test(sql)) {
    const before = world.jobs.length;
    world.jobs = world.jobs.filter((j) => !(j.type === 'workflow_resume' && j.workflow_execution_id === Number(params[0]) && ['pending', 'running'].includes(j.status)));
    return [{ affectedRows: before - world.jobs.length }];
  }
  if (/^SELECT id, paired_task_id FROM decision_requests WHERE workflow_execution_id = \? AND status = 'pending'$/i.test(sql)) {
    return [world.decisions.filter((d) => d.workflow_execution_id === Number(params[0]) && d.status === 'pending').map((d) => ({ id: d.id, paired_task_id: d.paired_task_id }))];
  }
  if (/^UPDATE decision_requests SET status = 'cancelled', updated_at = NOW\(\) WHERE workflow_execution_id = \? AND status = 'pending'$/i.test(sql)) {
    let n = 0;
    for (const d of world.decisions) {
      if (d.workflow_execution_id === Number(params[0]) && d.status === 'pending') { d.status = 'cancelled'; n++; }
    }
    return [{ affectedRows: n }];
  }
  throw new Error(`cancel fake: unscripted query: ${sql}`);
}

const db = {
  query: async (sql, params) => handle(sql, params, false),
  withTransaction: async (fn) => {
    mockEvents.push({ ev: 'begin' });
    const conn = { __isConn: true, query: async (sql, params) => handle(sql, params, true) };
    const r = await fn(conn);
    mockEvents.push({ ev: 'commit' });
    return r;
  },
};

beforeEach(() => {
  resetWorld();
  taskService.deleteTask.mockClear();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Route contract (characterization — also green on the pre-extraction route)
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /executions/:id/cancel — route contract', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.db = db; next(); });
    app.use(require('../routes/workflows'));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
  });
  afterAll((done) => {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(done);
  });

  const token = () => jwt.sign(
    { sub: 6, username: 'fred', user_type: 'staff', user_auth: 'authorized - SU', aud: 'staff', roles: [] },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );
  const post = async (id, body) => {
    const res = await fetch(`${base}/executions/${id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  test('invalid id → 400', async () => {
    expect(await post('abc', { reason: 'valid reason' })).toEqual({ status: 400, body: { error: 'Invalid execution ID' } });
    expect(await post('0', { reason: 'valid reason' })).toEqual({ status: 400, body: { error: 'Invalid execution ID' } });
  });

  test('reason missing / short / non-string → 400 with the original message', async () => {
    const want = { status: 400, body: { error: 'Reason required', message: 'reason is required and must be at least 3 characters after trim' } };
    expect(await post(10, {})).toEqual(want);
    expect(await post(10, { reason: '  ab  ' })).toEqual(want);
    expect(await post(10, { reason: 12345 })).toEqual(want);
    expect(world.execs.get(10).status).toBe('delayed');
  });

  test('finished or missing execution → 400 Cannot cancel', async () => {
    const want = { status: 400, body: { error: 'Cannot cancel', message: 'Execution not found or already finished' } };
    expect(await post(11, { reason: 'valid reason' })).toEqual(want);
    expect(await post(99, { reason: 'valid reason' })).toEqual(want);
    expect(world.execs.get(11).status).toBe('completed');
  });

  test('success → 200 body; reason trimmed and truncated to 500', async () => {
    expect(await post(10, { reason: '  Stop this run  ' })).toEqual({
      status: 200,
      body: { success: true, executionId: 10, cancel_reason: 'Stop this run', message: 'Workflow execution cancelled successfully' },
    });
    expect(world.execs.get(10)).toMatchObject({ status: 'cancelled', cancel_reason: 'Stop this run' });
    const long = 'x'.repeat(600);
    const r = await post(12, { reason: long });
    expect(r.status).toBe(200);
    expect(r.body.cancel_reason).toHaveLength(500);
    expect(world.execs.get(12).cancel_reason).toHaveLength(500);
  });

  test('R7 (deliberate change): a run finishing between check and write → 400 Cannot cancel, not overwritten', async () => {
    // The ONE route test that fails on the pre-extraction inline route — it
    // returned 200 and stamped the completed run 'cancelled'.
    world.afterSelect = () => { world.execs.get(10).status = 'completed'; };
    expect(await post(10, { reason: 'valid reason' })).toEqual({
      status: 400, body: { error: 'Cannot cancel', message: 'Execution not found or already finished' },
    });
    expect(world.execs.get(10).status).toBe('completed');
  });

  test('cascade happens through the route: resume jobs, decisions, paired task', async () => {
    await post(10, { reason: 'valid reason' });
    expect(world.jobs.map((j) => j.id)).toEqual([2, 3, 4]);   // only exec 10's pending/running resume job
    expect(world.decisions.map((d) => d.status)).toEqual(['cancelled', 'cancelled', 'responded']);
    expect(taskService.deleteTask).toHaveBeenCalledTimes(1);
    expect(taskService.deleteTask.mock.calls[0].slice(1)).toEqual([801, 0, { via: 'workflow_cancelled' }]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2–3. Service: transaction span, post-commit dismissal, R7 guard
// ═════════════════════════════════════════════════════════════════════════════

describe('cancelWorkflowExecution — service', () => {
  test('all writes inside ONE transaction; task dismissal after commit, through the pool', async () => {
    const r = await cancelWorkflowExecution(db, 10, 'valid reason');
    expect(r).toEqual({ cancelled: true, executionId: 10, cancel_reason: 'valid reason', decisionsCancelled: 2 });

    const begin = mockEvents.findIndex((e) => e.ev === 'begin');
    const commit = mockEvents.findIndex((e) => e.ev === 'commit');
    const writes = mockEvents.filter((e) => e.ev === 'query');
    expect(writes).toHaveLength(5);
    expect(writes.every((e) => e.isConn)).toBe(true);
    const firstQ = mockEvents.findIndex((e) => e.ev === 'query');
    expect(begin).toBeLessThan(firstQ);
    const dismiss = mockEvents.findIndex((e) => e.ev === 'deleteTask');
    expect(dismiss).toBeGreaterThan(commit);
    expect(mockEvents[dismiss]).toMatchObject({ taskId: 801, userId: 0, viaPool: true });
  });

  test('R7: a run that finishes between the existence check and the write is not overwritten', async () => {
    world.afterSelect = () => { world.execs.get(10).status = 'completed'; };   // the engine lands
    const r = await cancelWorkflowExecution(db, 10, 'valid reason');
    expect(r).toEqual({ cancelled: false });
    expect(world.execs.get(10)).toMatchObject({ status: 'completed', cancel_reason: null });
    expect(world.jobs.map((j) => j.id)).toEqual([1, 2, 3, 4]);           // no cascade
    expect(world.decisions.map((d) => d.status)).toEqual(['pending', 'pending', 'responded']);
    expect(taskService.deleteTask).not.toHaveBeenCalled();
  });

  test('a paired-task dismissal failure does not fail the cancel', async () => {
    taskService.deleteTask.mockImplementationOnce(async () => { throw new Error('already completed'); });
    const r = await cancelWorkflowExecution(db, 10, 'valid reason');
    expect(r.cancelled).toBe(true);
  });

  test('normalizeCancelReason', () => {
    expect(normalizeCancelReason(' ok ')).toEqual({ error: expect.stringMatching(/at least 3/) });
    expect(normalizeCancelReason(undefined)).toEqual({ error: expect.any(String) });
    expect(normalizeCancelReason('  fine  ')).toEqual({ reason: 'fine' });
    expect(normalizeCancelReason('y'.repeat(501)).reason).toHaveLength(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. cancel_workflow_execution internal function
// ═════════════════════════════════════════════════════════════════════════════

describe('cancel_workflow_execution', () => {
  const fn = registry.cancel_workflow_execution;

  test('cancels and reports', async () => {
    const r = await fn({ execution_id: '10', reason: 'superseded' }, db);
    expect(r).toEqual({
      success: true,
      output: { execution_id: 10, cancelled: true, cancel_reason: 'superseded', decisions_cancelled: 2 },
    });
    expect(world.execs.get(10).status).toBe('cancelled');
  });

  test('idempotent: finished or missing targets succeed with output.skipped', async () => {
    expect(await fn({ execution_id: 11, reason: 'superseded' }, db)).toEqual({
      success: true, output: { execution_id: 11, cancelled: false, skipped: 'status was completed' },
    });
    expect(await fn({ execution_id: 99, reason: 'superseded' }, db)).toEqual({
      success: true, output: { execution_id: 99, cancelled: false, skipped: 'execution not found' },
    });
    // and a second cancel of the same run
    await fn({ execution_id: 10, reason: 'superseded' }, db);
    expect((await fn({ execution_id: 10, reason: 'superseded' }, db)).output.skipped).toBe('status was cancelled');
  });

  test('self-cancel is refused; other executions are fine from inside a workflow', async () => {
    await expect(fn({ execution_id: 10, reason: 'superseded', _execution_id: 10 }, db)).rejects.toThrow(/cannot cancel its own execution/);
    expect(world.execs.get(10).status).toBe('delayed');
    expect((await fn({ execution_id: 12, reason: 'superseded', _execution_id: 10 }, db)).output.cancelled).toBe(true);
  });

  test('execution_id and reason are required', async () => {
    await expect(fn({ reason: 'superseded' }, db)).rejects.toThrow(/positive integer/);
    await expect(fn({ execution_id: 'x', reason: 'superseded' }, db)).rejects.toThrow(/positive integer/);
    await expect(fn({ execution_id: 10, reason: 'no' }, db)).rejects.toThrow(/at least 3/);
    await expect(fn({ execution_id: 10 }, db)).rejects.toThrow(/at least 3/);
    expect(world.execs.get(10).status).toBe('delayed');
  });

  test('meta: composition, not workflow-only, not control flow; save-time validation', () => {
    expect(fn.__meta).toMatchObject({ category: 'composition' });
    expect(fn.__meta.workflowOnly).toBeUndefined();
    expect(fn.__meta.controlFlow).toBeUndefined();
    expect(registry.__validateFunctionParams('cancel_workflow_execution', { execution_id: '{{x}}' }))
      .toEqual({ status: 400, error: 'reason is required' });
    expect(registry.__validateFunctionParams('cancel_workflow_execution', { execution_id: '{{x}}', reason: 'r' })).toBeNull();
  });
});
