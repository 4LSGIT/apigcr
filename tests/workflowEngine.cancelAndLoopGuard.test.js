/**
 * tests/workflowEngine.cancelAndLoopGuard.test.js
 *
 * WF 27 v6 runaway (2026-09-22). A duplicated 8-step block pointed step 43
 * back at step 36, so 36 → 39 (create_task) → 40…43 → 36 looped with no
 * pause; two executions made 480 tasks + emails in 9½ minutes. Two engine
 * defects turned an authoring bug into an incident:
 *
 *   A. CANCEL DID NOT STICK. Nothing inside an advanceWorkflow invocation
 *      re-read status, and every status write was unconditional — a cancel
 *      landing mid-invocation let the batch keep firing side effects, then
 *      the self-continue / delay write flipped the row back to
 *      'active' / 'delayed' with a fresh resume job.
 *   B. NO LOOP PROTECTION. MAX_STEPS_PER_INVOCATION only reschedules.
 *
 * WHAT IS LOCKED SHUT
 *   1. A cancel halts the run: at most the step in flight completes, status
 *      stays 'cancelled', no pending resume is left behind — whether it
 *      lands during a step, between steps, just before the self-continue
 *      hand-off, during a wait step, or on a terminal step.
 *   2. The hand-off parks the status BEFORE its resume job exists (one
 *      transaction), so a second advance can never claim a row this
 *      invocation still holds — the stranding race the independent review
 *      found in the first cut of this fix.
 *   3. A pause-free loop is failed after LOOP_GUARD_MAX_BACKJUMPS backward
 *      jumps: failed step recorded with the reason, execution 'failed',
 *      exactly one critical alert, counter cleared, no pending resume.
 *   4. foreach: advancing loop-backs don't count (30-item and nested loops
 *      complete; every item — the first included — may detour and jump back
 *      within itself) — but a FAILING foreach (throws, 'ignore' falls into
 *      the body) trips, an outer loop that restarts a foreach trips, and
 *      forgiven passes are budgeted (a runaway through a 500-item foreach
 *      stops at LOOP_GUARD_MAX_FOREACH_PASSES, not restarts × 500).
 *   5. A pause of at least LOOP_GUARD_MIN_PAUSE_MS resets the counter; a
 *      seconds-long or past-dated wait does not (its back-jump counts).
 *   6. A short pause-free loop under the limit completes at runtime.
 *   7. The Cloud Tasks doorbell rings for the parked self-continue job
 *      (after the transaction), not for a far-future delay.
 *
 * HARNESS: the REAL engine and REAL control/variables/timing functions run
 * against a stateful in-memory DB. Its workflow_executions UPDATE handler
 * evaluates the statement's own `AND status = …` / `AND status IN (…)`
 * guard, so an UNGUARDED write (the pre-fix code) applies unconditionally —
 * which is exactly what makes these tests bite on the old engine.
 * Only the Cloud Tasks accelerator and the alert sink are mocked (neither is
 * under test; alert() would otherwise try to send email).
 *
 * Run: npx jest tests/workflowEngine.cancelAndLoopGuard.test.js
 */

'use strict';

jest.mock('../lib/taskQueue', () => ({
  enqueueJobDispatch: jest.fn(async () => false),
  ACCEL_WINDOW_MS: 90_000,
}));
jest.mock('../lib/alerting', () => ({
  alert: jest.fn(async () => {}),
}));

const {
  advanceWorkflow, LOOP_GUARD_VAR, LOOP_GUARD_MAX_BACKJUMPS,
  LOOP_GUARD_MAX_FOREACH_PASSES, LOOP_GUARD_MIN_PAUSE_MS,
} = require('../lib/workflow_engine');
const { alert } = require('../lib/alerting');
const { enqueueJobDispatch } = require('../lib/taskQueue');

// ── In-memory world ─────────────────────────────────────────────────────────
const EXEC_ID = 900;
const WF_ID = 77;

function fn(function_name, params, extra = {}) {
  return { type: 'internal_function', config: { function_name, params, ...extra } };
}
// Side-effect stand-in (create_task in the incident): its executions are
// counted from the step history.
const SIDE = (tag = 'side') => fn('set_var', { name: tag, value: 'fired' });

function makeWorld(stepDefs, { variables = {} } = {}) {
  const W = {
    exec: {
      id: EXEC_ID, workflow_id: WF_ID, contact_id: null, status: 'active',
      current_step_number: 1, steps_executed_count: 1, // not "fresh": skips the capture probe
      variables: { ...variables }, init_data: {}, workflow_version: 1,
    },
    steps: new Map(stepDefs.map((d, i) => [i + 1, {
      id: 5000 + i + 1, workflow_id: WF_ID, version: 1, step_number: i + 1,
      type: d.type, label: null, config: JSON.stringify(d.config), error_policy: null,
    }])),
    jobs: [],
    history: [],
    hooks: {},          // step_number → fn(W) run when that step's history row is written
    afterPointer: {},   // new pointer value → fn(W) run right after that pointer write
    jobInsertStatus: [],// row status observed at each workflow_resume INSERT
  };

  function guardPasses(sql, params) {
    let m = sql.match(/AND\s+status\s*=\s*'(\w+)'/i);
    if (m) return W.exec.status === m[1];
    m = sql.match(/AND\s+status\s+IN\s*\(([^)]*)\)/i);
    if (m) {
      const items = m[1].split(',').map(x => x.trim());
      const list = items[0] === '?'
        ? params.slice(params.length - items.length)
        : items.map(x => x.replace(/'/g, ''));
      return list.includes(W.exec.status);
    }
    return true; // unguarded write → applies unconditionally
  }

  const rules = [
    [/SELECT \* FROM workflow_executions[\s\S]*status IN \('active', 'delayed'\)[\s\S]*FOR UPDATE/i, () =>
      [['active', 'delayed'].includes(W.exec.status) ? [{ ...W.exec, variables: { ...W.exec.variables } }] : []]],
    [/UPDATE workflow_executions\s+SET status = 'processing'/i, () => {
      W.exec.status = 'processing'; return [{ affectedRows: 1 }];
    }],
    [/SELECT capture_mode FROM workflows/i, () => [[{ capture_mode: 'off' }]]],
    [/SELECT \* FROM workflow_steps WHERE workflow_id = \? AND version = \? AND step_number = \?/i, (p) => {
      const s = W.steps.get(p[2]);
      return [s ? [{ ...s }] : []];
    }],
    [/SELECT variables, status FROM workflow_executions WHERE id = \?/i, () =>
      [[{ variables: { ...W.exec.variables }, status: W.exec.status }]]],
    [/SELECT variables FROM workflow_executions WHERE id = \?/i, () => [[{ variables: { ...W.exec.variables } }]]],
    [/UPDATE workflow_executions SET variables = \?/i, (p) => {
      W.exec.variables = JSON.parse(p[0]); return [{ affectedRows: 1 }];
    }],
    [/INSERT INTO workflow_execution_steps/i, (p) => {
      W.history.push({ step_number: p[1], status: p[3], error: p[5] });
      const hook = W.hooks[p[1]];
      if (hook) hook(W);
      return [{ insertId: W.history.length }];
    }],
    [/SET steps_executed_count = steps_executed_count \+ 1/i, () => {
      W.exec.steps_executed_count++; return [{ affectedRows: 1 }];
    }],
    [/UPDATE workflow_executions\s+SET current_step_number = \?/i, (p, sql) => {
      if (!guardPasses(sql, p)) return [{ affectedRows: 0 }];
      W.exec.current_step_number = p[0];
      const hook = W.afterPointer[p[0]];
      if (hook) hook(W);
      return [{ affectedRows: 1 }];
    }],
    [/UPDATE workflow_executions\s+SET status = \?,\s*completed_at = NOW\(\)/i, (p, sql) => {
      if (!guardPasses(sql, p)) return [{ affectedRows: 0 }];
      W.exec.status = p[0]; W.exec.current_step_number = null; return [{ affectedRows: 1 }];
    }],
    [/UPDATE workflow_executions SET status = \?, updated_at = NOW\(\)/i, (p, sql) => {
      if (!guardPasses(sql, p)) return [{ affectedRows: 0 }];
      W.exec.status = p[0]; return [{ affectedRows: 1 }];
    }],
    [/SELECT id FROM scheduled_jobs[\s\S]*idempotency_key = \?/i, (p) =>
      [W.jobs.filter(j => j.key === p[0] && ['pending', 'running'].includes(j.status)).map(j => ({ id: j.id }))]],
    [/INSERT INTO scheduled_jobs/i, (p) => {
      W.jobInsertStatus.push(W.exec.status);
      const data = JSON.parse(p[2]);
      const job = { id: W.jobs.length + 1, status: 'pending', at: p[0], nextStep: data.nextStep, key: p[4] };
      W.jobs.push(job);
      return [{ insertId: job.id }];
    }],
    [/DELETE FROM scheduled_jobs[\s\S]*workflow_resume/i, (_p, sql) => {
      const statuses = /'running'/.test(sql) ? ['pending', 'running'] : ['pending'];
      const before = W.jobs.length;
      W.jobs = W.jobs.filter(j => !statuses.includes(j.status));
      return [{ affectedRows: before - W.jobs.length }];
    }],
    [/SELECT COUNT\(\*\) as total/i, () => [[{
      total: W.history.length,
      failed: W.history.filter(h => h.status === 'failed').length,
    }]]],
    [/SELECT status FROM workflow_executions WHERE id = \?/i, () => [[{ status: W.exec.status }]]],
  ];

  const db = {
    async query(rawSql, params = []) {
      const sql = rawSql.replace(/\s+/g, ' ').trim();   // match on normalized whitespace
      for (const [re, h] of rules) if (re.test(sql)) return h(params, sql);
      throw new Error(`unstubbed query: ${sql.slice(0, 140)}`);
    },
    async withTransaction(fnTx) { return fnTx(db); },
  };
  return { W, db };
}

// The cancel route's effect (routes/workflows.js POST /executions/:id/cancel).
function cancelNow(W) {
  if (['active', 'processing', 'delayed', 'held'].includes(W.exec.status)) {
    W.exec.status = 'cancelled';
    W.jobs = W.jobs.filter(j => !['pending', 'running'].includes(j.status));
  }
}

// process_jobs' workflow_resume handler, minus the network: consume the due
// job, guarded flip to 'active' at its nextStep, advance. Delayed resumes are
// only consumed when resumeDelayed is set (i.e. "time passes").
async function drive(W, db, { maxInvocations = 80, resumeDelayed = false } = {}) {
  let result;
  let invocations = 0;
  for (;;) {
    invocations++;
    result = await advanceWorkflow(EXEC_ID, db);
    if (invocations >= maxInvocations) break;
    const job = W.jobs.find(j => j.status === 'pending');
    if (!job) break;
    if (W.exec.status === 'delayed' && !resumeDelayed) break;
    if (!['delayed', 'active', 'processing'].includes(W.exec.status)) break;
    job.status = 'completed';
    W.exec.status = 'active';
    W.exec.current_step_number = job.nextStep;
  }
  return { result, invocations };
}

const ranStep = (W, n) => W.history.filter(h => h.step_number === n).length;
const pendingJobs = (W) => W.jobs.filter(j => j.status === 'pending').length;

beforeEach(() => { alert.mockClear(); enqueueJobDispatch.mockClear(); });

// ── 1. Cancel sticks ────────────────────────────────────────────────────────
describe('cancel landing mid-invocation', () => {
  test('straight-through: halts at the step boundary, nothing after the in-flight step runs', async () => {
    const { W, db } = makeWorld([SIDE('a'), SIDE('b'), SIDE('c'), SIDE('d')]);
    W.hooks[2] = cancelNow;                     // cancel arrives while step 2 runs
    const r = await advanceWorkflow(EXEC_ID, db);
    expect(r.status).toBe('halted');
    expect(W.exec.status).toBe('cancelled');
    expect(ranStep(W, 2)).toBe(1);              // the in-flight step completes…
    expect(ranStep(W, 3)).toBe(0);              // …and nothing after it
    expect(ranStep(W, 4)).toBe(0);
    expect(pendingJobs(W)).toBe(0);
  });

  test('self-continue path: a cancel during the 20th step is not undone by the batch hand-off', async () => {
    // 25 plain steps: the batch ends after step 20 and would self-continue.
    const { W, db } = makeWorld(Array.from({ length: 25 }, (_, i) => SIDE(`s${i + 1}`)));
    W.hooks[20] = cancelNow;
    const { result } = await drive(W, db);
    expect(result.status).toBe('halted');
    expect(W.exec.status).toBe('cancelled');
    expect(ranStep(W, 21)).toBe(0);
    expect(pendingJobs(W)).toBe(0);
  });

  test('delay path: a cancel during a wait step does not leave the run delayed with a live resume', async () => {
    const { W, db } = makeWorld([SIDE('a'), fn('wait_for', { duration: '1h', nextStep: 3 }), SIDE('after')]);
    W.hooks[2] = cancelNow;
    const r = await advanceWorkflow(EXEC_ID, db);
    expect(r.status).toBe('halted');
    expect(W.exec.status).toBe('cancelled');
    expect(pendingJobs(W)).toBe(0);             // pre-fix: 'delayed' + a pending resume → run comes back in 1h
  });

  test('cancel on a completing step: the terminal write does not overwrite cancelled', async () => {
    const { W, db } = makeWorld([SIDE('a'), SIDE('last')]);
    W.hooks[2] = cancelNow;
    await advanceWorkflow(EXEC_ID, db);
    expect(W.exec.status).toBe('cancelled');
  });

  test("cancel on a set_next 'end' step: terminal guard holds, result says halted", async () => {
    // No pointer write on this path — only markExecutionCompleted's guard stands between
    // the cancel and a 'completed' overwrite.
    const { W, db } = makeWorld([SIDE('a'), fn('set_next', { value: 'end' })]);
    W.hooks[2] = cancelNow;
    const r = await advanceWorkflow(EXEC_ID, db);
    expect(W.exec.status).toBe('cancelled');
    expect(r.status).toBe('halted');
  });

  test('cancel between steps: the next step never starts', async () => {
    const { W, db } = makeWorld([SIDE('a'), SIDE('b'), SIDE('c')]);
    W.afterPointer[2] = cancelNow;              // lands after step 1's pointer write
    const r = await advanceWorkflow(EXEC_ID, db);
    expect(r.status).toBe('halted');
    expect(ranStep(W, 1)).toBe(1);
    expect(ranStep(W, 2)).toBe(0);
    expect(W.exec.status).toBe('cancelled');
  });

  test('cancel just before the self-continue hand-off: the park does not undo it', async () => {
    const { W, db } = makeWorld(Array.from({ length: 25 }, (_, i) => SIDE(`s${i + 1}`)));
    W.afterPointer[21] = cancelNow;             // after step 20's pointer write, before the park
    const r = await advanceWorkflow(EXEC_ID, db);
    expect(r.status).toBe('halted');
    expect(W.exec.status).toBe('cancelled');
    expect(pendingJobs(W)).toBe(0);
    expect(W.jobInsertStatus).toEqual([]);      // nothing was queued at all
  });
});

// ── 2. Hand-off ordering ────────────────────────────────────────────────────
describe('hand-off parks the status before the resume job exists', () => {
  test('self-continue: the job is inserted only after the row is already active', async () => {
    const { W, db } = makeWorld(Array.from({ length: 25 }, (_, i) => SIDE(`s${i + 1}`)));
    const r = await advanceWorkflow(EXEC_ID, db);
    expect(r.status).toBe('continued_later');
    expect(W.jobInsertStatus).toEqual(['active']); // pre-fix: 'processing' → a 2nd advance could claim it
    expect(pendingJobs(W)).toBe(1);
  });

  test('delay: the job is inserted only after the row is already delayed', async () => {
    const { W, db } = makeWorld([SIDE('a'), fn('wait_for', { duration: '1h', nextStep: 3 }), SIDE('after')]);
    const r = await advanceWorkflow(EXEC_ID, db);
    expect(r.status).toBe('delayed');
    expect(W.jobInsertStatus).toEqual(['delayed']);
    expect(pendingJobs(W)).toBe(1);
  });

  test('the Cloud Tasks doorbell rings for the parked self-continue job, not for a far-future delay', async () => {
    const hop = makeWorld(Array.from({ length: 25 }, (_, i) => SIDE(`s${i + 1}`)));
    await advanceWorkflow(EXEC_ID, hop.db);
    expect(enqueueJobDispatch).toHaveBeenCalledTimes(1);
    const [jobId, dueMs] = enqueueJobDispatch.mock.calls[0];
    expect(jobId).toBe(hop.W.jobs[0].id);
    expect(dueMs - Date.now()).toBeLessThan(2000);

    enqueueJobDispatch.mockClear();
    const wait = makeWorld([SIDE('a'), fn('wait_for', { duration: '1h', nextStep: 3 }), SIDE('after')]);
    await advanceWorkflow(EXEC_ID, wait.db);
    expect(enqueueJobDispatch).not.toHaveBeenCalled();
  });
});

// ── 2. Runaway-loop guard ───────────────────────────────────────────────────
describe('runaway-loop guard', () => {
  test('limit is pinned — change it deliberately', () => {
    // Sized 2026-09-22 against the live corpus: of 38 published workflows only
    // wf27 (every pass pauses on request_decision / wait_for) and wf39 (foreach)
    // jump backwards at all, and no published graph has a pause-free cycle.
    // 10 caps a runaway's side effects at 11 passes (the incident produced ~240
    // per execution) while a short loop that slips past the publish gate
    // (dynamic target, pre-gate version) still finishes.
    expect(LOOP_GUARD_MAX_BACKJUMPS).toBe(10);
    // Forgiven foreach loop-backs between pauses: ≥ one full hard-max foreach
    // (500) with room for modest nesting; bounds a runaway THROUGH a foreach.
    expect(LOOP_GUARD_MAX_FOREACH_PASSES).toBe(1000);
    // Shorter waits resume almost at once via the Cloud Tasks doorbell.
    expect(LOOP_GUARD_MIN_PAUSE_MS).toBe(60_000);
  });

  // The incident's shape: side effect, then an unconditional jump back.
  const incidentLoop = () => [
    SIDE('escalate'),                                                               // 1 (≙ step 39 create_task)
    fn('evaluate_condition', { variable: 'never_set', operator: 'is_empty', then: 1 }), // 2 (≙ 43 → 36 → 39)
  ];

  test('fails the execution after the limit, records why, alerts once, leaves nothing scheduled', async () => {
    const { W, db } = makeWorld(incidentLoop());
    const { result, invocations } = await drive(W, db);

    expect(invocations).toBeLessThan(80);        // pre-fix: runs until the driver's cap
    expect(result.status).toBe('failed');
    expect(W.exec.status).toBe('failed');
    // limit N back-jumps allowed → the side effect fires N+1 times, not ~240.
    expect(ranStep(W, 1)).toBe(LOOP_GUARD_MAX_BACKJUMPS + 1);

    const last = W.history[W.history.length - 1];
    expect(last).toMatchObject({ step_number: 2, status: 'failed' });
    expect(last.error).toMatch(/runaway-loop guard/);

    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1]).toMatchObject({
      kind: 'runaway_loop', severity: 'critical', ref_id: EXEC_ID,
      group_key: `workflow_runaway:${WF_ID}`, dedup_key: `wf_runaway:${EXEC_ID}`,
    });
    expect(W.exec.variables[LOOP_GUARD_VAR]).toBeNull();   // fresh budget for an operator resume
    expect(pendingJobs(W)).toBe(0);
  });

  test('a set_next self-loop (no side-effect step at all) trips too', async () => {
    const { W, db } = makeWorld([fn('set_next', { value: 1 })]);
    const { result } = await drive(W, db);
    expect(result.status).toBe('failed');
    expect(ranStep(W, 1)).toBe(LOOP_GUARD_MAX_BACKJUMPS + 1);
  });

  test('advancing foreach loop-backs do not count — a 30-item foreach completes', async () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const { W, db } = makeWorld([
      fn('foreach', { list: '{{items}}', item_var: 'item', end_step: 4 }), // 1
      SIDE('body'),                                                        // 2
      fn('set_next', { value: 1 }),                                        // 3 → back to foreach
      SIDE('after'),                                                       // 4
    ], { variables: { items } });
    const { result } = await drive(W, db);
    expect(result.status).toBe('completed');
    expect(ranStep(W, 2)).toBe(30);
    expect(ranStep(W, 4)).toBe(1);
    expect(alert).not.toHaveBeenCalled();
  });

  test.each([
    ['a seconds-long wait', { duration: '5s', nextStep: 1 }],
    ['a past-dated wait', { at: '2020-01-01T09:00:00', nextStep: 1 }],
  ])('%s is not a pause — its back-jump counts and the loop trips', async (_label, waitParams) => {
    const { W, db } = makeWorld([SIDE('nudge'), fn('wait_for', waitParams)]);   // 2 resumes at 1
    const { result } = await drive(W, db, { resumeDelayed: true, maxInvocations: 60 });
    expect(result.status).toBe('failed');
    expect(ranStep(W, 1)).toBe(LOOP_GUARD_MAX_BACKJUMPS + 1);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  test('a pause inside the loop resets the counter — well past the limit, never trips', async () => {
    const { W, db } = makeWorld([
      SIDE('nudge'),                                                                   // 1
      fn('wait_for', { duration: '1d', nextStep: 3 }),                                 // 2 (pause)
      fn('evaluate_condition', { variable: 'never_set', operator: 'is_empty', then: 1 }), // 3 → back
    ]);
    const passes = LOOP_GUARD_MAX_BACKJUMPS * 3;
    await drive(W, db, { resumeDelayed: true, maxInvocations: passes });
    expect(ranStep(W, 1)).toBeGreaterThan(LOOP_GUARD_MAX_BACKJUMPS + 1);
    expect(W.exec.status).toBe('delayed');
    expect(W.exec.variables[LOOP_GUARD_VAR]?.n ?? 0).toBeLessThanOrEqual(1);
    expect(alert).not.toHaveBeenCalled();
  });

  test('a failing foreach (throws under ignore, falls into its body) trips the guard', async () => {
    // {{missing}} never resolves to an array → foreach throws on every visit; the
    // default 'ignore' policy falls through into the body, which loops back.
    const { W, db } = makeWorld([
      fn('foreach', { list: '{{missing}}', item_var: 'item', end_step: 4 }), // 1
      SIDE('body'),                                                           // 2
      fn('set_next', { value: 1 }),                                           // 3
      SIDE('after'),                                                          // 4
    ]);
    const { result } = await drive(W, db);
    expect(result.status).toBe('failed');
    expect(ranStep(W, 2)).toBe(LOOP_GUARD_MAX_BACKJUMPS + 1);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  test('a foreach that starts failing mid-loop (cursor stops moving) trips the guard', async () => {
    // The body shrinks the list → the next foreach visit throws "length changed";
    // the cursor stays at i=1, so every later loop-back is counted.
    const { W, db } = makeWorld([
      fn('foreach', { list: '{{items}}', item_var: 'item', end_step: 4 }), // 1
      fn('set_var', { name: 'items', value: [9, 9] }),                    // 2 body
      fn('set_next', { value: 1 }),                                       // 3
      SIDE('after'),                                                      // 4
    ], { variables: { items: [1, 2, 3] } });
    const { result } = await drive(W, db);
    expect(result.status).toBe('failed');
    expect(alert).toHaveBeenCalledTimes(1);
  });

  test('every item — the first included — gets the full per-item allowance', async () => {
    // 6 back-jumps inside EACH item (limit 10). Recording the loop's base at its
    // first loop-back would fold item 1's six into the base and trip on item 2.
    const items = Array.from({ length: 30 }, (_, i) => i);
    const { W, db } = makeWorld([
      fn('foreach', { list: '{{items}}', item_var: 'item', end_step: 12 }), // 1
      SIDE('body'),                                                         // 2
      fn('set_next', { value: 11 }),                                        // 3 detour
      SIDE('unused'),                                                       // 4
      fn('set_next', { value: 1 }),                                         // 5 loop-back
      fn('set_next', { value: 5 }),                                         // 6  ← back-jump 6
      fn('set_next', { value: 6 }),                                         // 7  ← 5
      fn('set_next', { value: 7 }),                                         // 8  ← 4
      fn('set_next', { value: 8 }),                                         // 9  ← 3
      fn('set_next', { value: 9 }),                                         // 10 ← 2
      fn('set_next', { value: 10 }),                                        // 11 ← 1
      SIDE('after'),                                                        // 12
    ], { variables: { items } });
    const { result } = await drive(W, db, { maxInvocations: 200 });
    expect(result.status).toBe('completed');
    expect(ranStep(W, 2)).toBe(30);
  });

  test('a runaway through a 500-item foreach stops at the pass budget, not restarts × 500', async () => {
    const items = Array.from({ length: 500 }, (_, i) => i);
    const { W, db } = makeWorld([
      SIDE('outer'),                                                                        // 1
      fn('foreach', { list: '{{items}}', item_var: 'item', end_step: 5, max_items: 500 }), // 2
      SIDE('body'),                                                                         // 3
      fn('set_next', { value: 2 }),                                                         // 4
      fn('set_next', { value: 1 }),                                                         // 5 unbounded outer jump
    ], { variables: { items } });
    const { result } = await drive(W, db, { maxInvocations: 400 });
    expect(result.status).toBe('failed');
    expect(ranStep(W, 3)).toBe(LOOP_GUARD_MAX_FOREACH_PASSES + 1);   // restarts alone would allow 11 × 500
    expect(W.history[W.history.length - 1].error).toMatch(/foreach passes/);
  });

  test('a foreach body that detours and jumps back within each item is forgiven per item', async () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const { W, db } = makeWorld([
      fn('foreach', { list: '{{items}}', item_var: 'item', end_step: 6 }), // 1
      SIDE('body'),                                                        // 2
      fn('set_next', { value: 5 }),                                        // 3 detour forward
      fn('set_next', { value: 1 }),                                        // 4 loop-back
      fn('set_next', { value: 4 }),                                        // 5 back-jump inside the item
      SIDE('after'),                                                       // 6
    ], { variables: { items } });
    const { result } = await drive(W, db);
    expect(result.status).toBe('completed');   // first cut: failed on item 11
    expect(ranStep(W, 2)).toBe(30);
    expect(alert).not.toHaveBeenCalled();
  });

  test.each([
    ['12 × 12', 12],
    // Single-item inner loop: a restart's first loop-back sees i=1, which would
    // EQUAL a stale record from the previous outer item and read as a stalled
    // foreach — the record opened when the inner foreach runs fresh prevents it.
    ['12 × 1', 1],
  ])('nested foreach (%s) completes', async (_label, innerLen) => {
    const twelve = Array.from({ length: 12 }, (_, i) => i);
    const inner = Array.from({ length: innerLen }, (_, i) => i);
    const { W, db } = makeWorld([
      fn('foreach', { list: '{{outer}}', item_var: 'o', end_step: 6 }), // 1
      fn('foreach', { list: '{{inner}}', item_var: 'i', end_step: 5 }), // 2
      SIDE('body'),                                                     // 3
      fn('set_next', { value: 2 }),                                     // 4 inner loop-back
      fn('set_next', { value: 1 }),                                     // 5 outer loop-back
      SIDE('after'),                                                    // 6
    ], { variables: { outer: twelve, inner } });
    const { result } = await drive(W, db, { maxInvocations: 200 });
    expect(result.status).toBe('completed');
    expect(ranStep(W, 3)).toBe(12 * innerLen);
    expect(alert).not.toHaveBeenCalled();
  });

  test.each([
    ['3-item', [1, 2, 3]],
    ['1-item', [1]],   // restarted cursor i=1 vs the fresh-start record (i=0): an advance, not a stall
  ])('an outer pause-free loop that keeps restarting a %s foreach trips after exactly the limit', async (_label, items) => {
    // The publish gate cannot see this one (foreach nodes are removed); runtime must.
    const { W, db } = makeWorld([
      SIDE('outer'),                                                       // 1
      fn('foreach', { list: '{{items}}', item_var: 'item', end_step: 5 }), // 2
      SIDE('body'),                                                        // 3
      fn('set_next', { value: 2 }),                                        // 4
      fn('set_next', { value: 1 }),                                        // 5 unbounded outer jump
    ], { variables: { items } });
    const { result } = await drive(W, db, { maxInvocations: 200 });
    expect(result.status).toBe('failed');
    expect(ranStep(W, 1)).toBe(LOOP_GUARD_MAX_BACKJUMPS + 1);
  });

  test('a short pause-free loop under the limit completes at runtime', async () => {
    // The publish gate rejects this shape; runtime tolerance is for loops that slip
    // past it (dynamic targets, versions published before the gate).
    // custom_code counter: n = n + 1, loop while n < LIMIT (LIMIT-1 back-jumps).
    const { W, db } = makeWorld([
      { type: 'custom_code', config: { code: '({ set_vars: { n: (Number(input.n) || 0) + 1 } })', input: { n: '{{n}}' } } }, // 1
      fn('evaluate_condition', { variable: 'n', operator: '<', value: LOOP_GUARD_MAX_BACKJUMPS, then: 1, else: 3 }),        // 2
      SIDE('done'),                                                                                                          // 3
    ]);
    const { result } = await drive(W, db);
    expect(result.status).toBe('completed');
    expect(W.exec.variables.n).toBe(LOOP_GUARD_MAX_BACKJUMPS);
    expect(ranStep(W, 3)).toBe(1);
  });
});
