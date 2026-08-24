/**
 * tests/hookService.splitPhase.test.js
 *
 * executeHook's split-phase dispatch (2026-08-24 slice). Evidence base: the
 * post-deploy report measured the awaited Cloud Tasks enqueue starving in
 * the throttled post-response tail (5.22s on the flip event; ~3% of
 * immediate jobs silently falling back to the 60s cron at idle hours).
 * Split-phase moves fast targets (workflow/sequence) in front of the
 * webhook response — request-bound at full CPU — while http/
 * internal_function targets stay detached as before.
 *
 * WHAT IS LOCKED SHUT (the review's item-H surface, plus the phase gate)
 *   1. PHASE GATE: under splitPhase, fast targets are delivered AND logged
 *      before executeHook returns; slow targets have NOT run at return time
 *      and run only when the returned `detached` promise is awaited.
 *   2. ORDERING: the `targets` result array keeps ORIGINAL position order
 *      even when execution order was fast-first ([http, workflow, http]
 *      comes back in exactly that order).
 *   3. TALLY + FINAL STATUS: successCount/failCount and the final
 *      hook_executions status are computed after phase 2 — a slow failure
 *      still yields 'partial' and queues its retry.
 *   4. ISOLATION: a slow target's failure cannot block a fast target
 *      (it already ran); a fast failure doesn't skip slow ones.
 *   5. SERIAL DEFAULT: without splitPhase the behavior, ordering, and
 *      return shape are the pre-slice ones — no `detached` key.
 *   6. dryRun NEVER splits, even if splitPhase is passed.
 *
 * actionDispatchers is mocked at the module boundary; delivery mechanics
 * have their own suites. DB is a matcher-based recording stub.
 *
 * Run: npx jest tests/hookService.splitPhase.test.js
 */

'use strict';

jest.mock('../lib/actionDispatchers', () => ({
  dispatch: jest.fn(),
}));

const actionDispatchers = require('../lib/actionDispatchers');
const hookService = require('../services/hookService');

const EXEC_ID = 900;

function target(id, type, overrides = {}) {
  return {
    id, name: `t${id}`, target_type: type, position: id,
    conditions: null, transform_mode: 'none', transform_config: null,
    config: null, method: null, url: null, headers: null,
    body_mode: null, body_template: null,
    ...overrides,
  };
}

function hookRow(targets) {
  return {
    id: 1, slug: 'test-hook', name: 'Test', active: 1,
    capture_mode: 'off', filter_mode: 'none', filter_config: null,
    transform_mode: 'none', transform_config: null,
    targets,
  };
}

function makeDb() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' '), params });
      if (sql.includes('INSERT INTO hook_executions')) {
        return [{ insertId: EXEC_ID, affectedRows: 1 }];
      }
      return [{ affectedRows: 1, insertId: 1 }];
    },
    async withTransaction(fn) { return fn({ query: this.query.bind(this) }); },
  };
}

/** dispatch mock: per-target-type result, recording invocation order. */
function armDispatch(resultByType, orderLog) {
  actionDispatchers.dispatch.mockImplementation(async (db, type, cfg, output, ctx) => {
    orderLog.push(`${type}:${ctx.target.id}`);
    const r = resultByType[type] || { status: 'success' };
    return {
      result: {
        target_id: ctx.target.id,
        request_url: null, request_method: null, request_body: null,
        response_status: 200, response_body: '{}',
        status: r.status, log_status: r.log_status, error: r.error || null,
      },
    };
  });
}

beforeEach(() => actionDispatchers.dispatch.mockReset());

describe('executeHook splitPhase', () => {

  test('PHASE GATE: workflow delivered+logged before return; slow phase completes off the request path', async () => {
    const db = makeDb();
    const order = [];
    // The slow (http) dispatch is GATED on a promise the test controls —
    // phase 2 legitimately STARTS concurrently at return (that is what
    // detached means), so the honest invariant is: phase 1 is COMPLETE at
    // return, and phase 2's writes land only on the detached promise.
    let releaseHttp;
    const httpGate = new Promise((r) => { releaseHttp = r; });
    actionDispatchers.dispatch.mockImplementation(async (db2, type, cfg, output, ctx) => {
      order.push(`${type}:${ctx.target.id}`);
      if (type === 'http') await httpGate;
      const r = type === 'workflow'
        ? { status: 'success', log_status: 'queued' }
        : { status: 'success' };
      return { result: {
        target_id: ctx.target.id, request_url: null, request_method: null,
        request_body: null, response_status: 200, response_body: '{}',
        status: r.status, log_status: r.log_status, error: null,
      } };
    });
    const hook = hookRow([target(1, 'http'), target(2, 'workflow')]);

    const res = await hookService.executeHook(db, 'test-hook', { a: 1 }, { hook, splitPhase: true });

    // At return: the fast target dispatched FIRST and its delivery log row
    // is already written (persisted as 'queued')…
    expect(order[0]).toBe('workflow:2');
    expect(res.status).toBe('accepted');
    const logs = db.calls.filter((c) => c.sql.includes('INSERT INTO hook_delivery_logs'));
    expect(logs).toHaveLength(1);
    expect(logs[0].params[1]).toBe(2); // target_id
    // …while the gated http target has not logged and the final-status
    // UPDATE (which needs phase-2 tallies) has not run.
    expect(db.calls.some((c) => c.sql.includes('UPDATE hook_executions SET status = ?'))).toBe(false);

    releaseHttp();
    await res.detached;
    expect(order).toEqual(['workflow:2', 'http:1']);
    expect(db.calls.filter((c) => c.sql.includes('INSERT INTO hook_delivery_logs'))).toHaveLength(2);
    expect(db.calls.some((c) => c.sql.includes('UPDATE hook_executions SET status = ?'))).toBe(true);
  });

  test('ORDERING: [http, workflow, http] returns results in original positions despite fast-first execution', async () => {
    const db = makeDb();
    const order = [];
    armDispatch({ workflow: { status: 'success', log_status: 'queued' }, http: { status: 'success' } }, order);
    const hook = hookRow([target(1, 'http'), target(2, 'workflow'), target(3, 'http')]);

    const res = await hookService.executeHook(db, 'test-hook', {}, { hook, splitPhase: true });
    const final = await res.detached;

    expect(order).toEqual(['workflow:2', 'http:1', 'http:3']); // execution order: fast first
    expect(final.targets.map((t) => t.target_id)).toEqual([1, 2, 3]); // result order: original
    expect(res.targets).toBe(final.targets); // same array, phase-2 slots filled in place
  });

  test('TALLY + STATUS: slow-phase failure → retry queued and final status partial', async () => {
    const db = makeDb();
    const order = [];
    armDispatch({
      workflow: { status: 'success', log_status: 'queued' },
      http: { status: 'failed', error: 'boom' },
    }, order);
    const hook = hookRow([target(1, 'http'), target(2, 'workflow')]);

    const res = await hookService.executeHook(db, 'test-hook', {}, { hook, splitPhase: true });
    const final = await res.detached;

    expect(final.status).toBe('partial');
    const statusUpd = db.calls.find((c) => c.sql.includes('UPDATE hook_executions SET status = ?'));
    expect(statusUpd.params[0]).toBe('partial');
    // hook_retry queued for the failed http target only.
    const retries = db.calls.filter((c) => c.sql.includes("'hook_retry'"));
    expect(retries).toHaveLength(1);
  });

  test('ISOLATION: fast-phase workflow failure still runs slow targets; both tallied', async () => {
    const db = makeDb();
    const order = [];
    armDispatch({
      workflow: { status: 'failed', error: 'wf down' },
      http: { status: 'success' },
    }, order);
    const hook = hookRow([target(1, 'workflow'), target(2, 'http')]);

    const res = await hookService.executeHook(db, 'test-hook', {}, { hook, splitPhase: true });
    const final = await res.detached;

    expect(order).toEqual(['workflow:1', 'http:2']);
    expect(final.status).toBe('partial'); // 1 fail + 1 success
  });

  test('SERIAL DEFAULT: without splitPhase — original order, no detached key, same final shape', async () => {
    const db = makeDb();
    const order = [];
    armDispatch({ workflow: { status: 'success', log_status: 'queued' }, http: { status: 'success' } }, order);
    const hook = hookRow([target(1, 'http'), target(2, 'workflow'), target(3, 'http')]);

    const res = await hookService.executeHook(db, 'test-hook', {}, { hook });

    expect(order).toEqual(['http:1', 'workflow:2', 'http:3']); // strictly positional
    expect(res.detached).toBeUndefined();
    expect(res.status).toBe('delivered');
    expect(res.targets.map((t) => t.target_id)).toEqual([1, 2, 3]);
    // Everything, including the final status UPDATE, done at return.
    expect(db.calls.some((c) => c.sql.includes('UPDATE hook_executions SET status = ?'))).toBe(true);
  });

  test('dryRun NEVER splits, even when splitPhase is passed', async () => {
    const db = makeDb();
    const order = [];
    armDispatch({}, order);
    const hook = hookRow([target(1, 'http'), target(2, 'workflow')]);

    const res = await hookService.executeHook(db, 'test-hook', {}, { hook, dryRun: true, splitPhase: true });

    expect(res.detached).toBeUndefined();
    expect(res.status).toBe('dry_run');
    expect(actionDispatchers.dispatch).not.toHaveBeenCalled(); // previews only
    expect(db.calls).toHaveLength(0); // dry run touches nothing
  });

  test('all-fast hook under splitPhase: response-phase does everything; detached only finalizes', async () => {
    const db = makeDb();
    const order = [];
    armDispatch({ workflow: { status: 'success', log_status: 'queued' } }, order);
    const hook = hookRow([target(1, 'workflow')]);

    const res = await hookService.executeHook(db, 'test-hook', {}, { hook, splitPhase: true });
    expect(order).toEqual(['workflow:1']);
    const final = await res.detached;
    expect(final.status).toBe('delivered');
  });

  test('conditions still gate fast targets in phase 1 (skipped target holds its slot)', async () => {
    const db = makeDb();
    const order = [];
    armDispatch({ workflow: { status: 'success', log_status: 'queued' } }, order);
    const hook = hookRow([
      target(1, 'workflow', { conditions: JSON.stringify({ path: 'never.exists', op: 'equals', value: 'x' }) }),
      target(2, 'workflow'),
    ]);

    const res = await hookService.executeHook(db, 'test-hook', { some: 'data' }, { hook, splitPhase: true });
    const final = await res.detached;

    expect(order).toEqual(['workflow:2']);
    expect(final.targets[0].conditions_passed).toBe(false);
    expect(final.targets[0].target_id).toBe(1);
    expect(final.targets[1].conditions_passed).toBe(true);
  });
});
