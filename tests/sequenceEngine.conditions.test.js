/**
 * tests/sequenceEngine.conditions.test.js
 *
 * Tri-state condition evaluation (2026-10-12) — the engine-level fix for the
 * 2026-09-08 incident: sequence template 30 v1's template condition compared
 * DATE column case_close_date to '' → ER_WRONG_VALUE throw → checkCondition's
 * catch returned false → executeStep read "condition failed" → enrollment 172
 * silently CANCELLED at first fire. Errors and clean failures are now
 * distinct outcomes:
 *
 *   pass  → proceed (unchanged)
 *   fail  → cancel (template) / skip+advance (step)   (unchanged — pinned here)
 *   error → HOLD: log 'failed' + discriminator skip_reason + operator story
 *           in error_message, execute nothing, advance nothing, cancel
 *           nothing. The enrollment sits active with no live job — the shape
 *           _scanStuckEnrollments and _scanSequences already page on.
 *
 * Also covers the job-scoped enrollment-history join
 * (GET /sequences/enrollments/:id?history=true): a held step legitimately
 * accumulates several scheduled_jobs rows over its life (hold consumes one,
 * Recover re-places a new one), so each log row attaches to the LATEST
 * same-step job created at-or-before its executed_at — a bare
 * (enrollment, step_number) join hangs the old 'failed' log on the fresh
 * pending job and fans 2×2 after the re-fire.
 *
 * HARNESS: real engine + real route handler against in-memory fakes that
 * interpret exactly the statements they issue; unrecognized SQL THROWS so
 * drift fails the suite loudly. Boundaries mocked: lib/job_executor
 * (executeJob — the action side effect) and lib/taskQueue (Cloud Tasks
 * doorbell). The module under test (lib/sequenceEngine) is never mocked.
 *
 *   npx jest tests/sequenceEngine.conditions.test.js
 */

jest.mock('../lib/job_executor', () => ({
  executeJob: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../lib/taskQueue', () => ({
  ...jest.requireActual('../lib/taskQueue'),
  enqueueJobDispatch: jest.fn(async () => true),
}));

const { executeJob } = require('../lib/job_executor');
const engine = require('../lib/sequenceEngine');
const {
  checkCondition,
  checkConditionDetailed,
  executeStep,
  TEMPLATE_CONDITION_ERROR,
  STEP_CONDITION_ERROR,
  CONDITION_ERROR_REASONS,
} = engine;

let errorSpy, warnSpy, logSpy;
beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy  = jest.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy   = jest.spyOn(console, 'log').mockImplementation(() => {});
  executeJob.mockClear();
});
afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

// ─────────────────────────────────────────────────────────────
// 1. checkConditionDetailed — the tri-state unit contract
// ─────────────────────────────────────────────────────────────

describe('checkConditionDetailed — outcomes', () => {
  const dbReturning = (rows) => ({ query: jest.fn(async () => [rows]) });
  const dbThrowing  = (msg)  => ({ query: jest.fn(async () => { const e = new Error(msg); e.code = 'ER_WRONG_VALUE'; throw e; }) });
  const COND = (over = {}) => ({
    query:  'SELECT ok FROM gate WHERE id = :cid',
    params: { cid: 'trigger_data.case_id' },
    assert: { ok: 1 },
    ...over,
  });
  const TD = { case_id: 42 };

  test('no condition → pass', async () => {
    expect(await checkConditionDetailed({ query: () => { throw new Error('must not query'); } }, null, TD))
      .toEqual({ outcome: 'pass' });
  });

  test('assertions hold → pass; binds params positionally and appends LIMIT 1', async () => {
    const db = dbReturning([{ ok: 1 }]);
    expect(await checkConditionDetailed(db, COND(), TD)).toEqual({ outcome: 'pass' });
    expect(db.query).toHaveBeenCalledWith('SELECT ok FROM gate WHERE id = ? LIMIT 1', [42]);
  });

  test('assertions do not hold → fail (clean verdict, not error)', async () => {
    expect(await checkConditionDetailed(dbReturning([{ ok: 0 }]), COND(), TD)).toEqual({ outcome: 'fail' });
  });

  test('no rows → fail — deliberate existence-check semantics, never error', async () => {
    expect(await checkConditionDetailed(dbReturning([]), COND(), TD)).toEqual({ outcome: 'fail' });
  });

  test('param resolving null binds NULL (unchanged pre-tri-state behavior)', async () => {
    const db = dbReturning([]);
    const out = await checkConditionDetailed(db, COND(), { /* no case_id */ });
    expect(db.query).toHaveBeenCalledWith('SELECT ok FROM gate WHERE id = ? LIMIT 1', [null]);
    expect(out).toEqual({ outcome: 'fail' }); // no rows, as a NULL compare yields
  });

  test('missing query → error', async () => {
    const out = await checkConditionDetailed(dbReturning([]), { assert: { ok: 1 } }, TD);
    expect(out.outcome).toBe('error');
    expect(out.error).toMatch(/no query/);
  });

  test('non-SELECT → error', async () => {
    const out = await checkConditionDetailed(dbReturning([]), COND({ query: 'UPDATE gate SET ok = 1' }), TD);
    expect(out.outcome).toBe('error');
    expect(out.error).toMatch(/must be a SELECT/);
  });

  test('unknown placeholder → error naming the placeholder', async () => {
    const out = await checkConditionDetailed(dbReturning([]), COND({ params: {} }), TD);
    expect(out.outcome).toBe('error');
    expect(out.error).toMatch(/unknown placeholders: :cid/);
  });

  test('query THROW → error carrying the raw SQL error (the enrollment-172 class)', async () => {
    const out = await checkConditionDetailed(dbThrowing("Incorrect DATE value: ''"), COND(), TD);
    expect(out.outcome).toBe('error');
    expect(out.error).toMatch(/condition query failed: Incorrect DATE value: ''/);
  });

  test('assert field the query never selected → error listing the real columns', async () => {
    const out = await checkConditionDetailed(dbReturning([{ other: 5 }]), COND(), TD);
    expect(out.outcome).toBe('error');
    expect(out.error).toMatch(/assert field "ok" is not a column/);
    expect(out.error).toMatch(/columns: other/);
  });

  test('non-array `in` → error (String.prototype.includes must never decide a verdict)', async () => {
    const out = await checkConditionDetailed(
      dbReturning([{ ok: 'No' }]),
      COND({ assert: { ok: { in: 'No Show' } } }),
      TD
    );
    expect(out.outcome).toBe('error');
    expect(out.error).toMatch(/"ok"\.in must be an array/);
  });

  test('array `in` still evaluates normally', async () => {
    expect(await checkConditionDetailed(dbReturning([{ ok: 'No Show' }]),
      COND({ assert: { ok: { in: ['No Show', 'Canceled'] } } }), TD)).toEqual({ outcome: 'pass' });
  });

  test('assert_mode any', async () => {
    const cond = COND({ query: 'SELECT a, b FROM gate WHERE id = :cid', assert: { a: 1, b: 2 }, assert_mode: 'any' });
    expect(await checkConditionDetailed(dbReturning([{ a: 1, b: 9 }]), cond, TD)).toEqual({ outcome: 'pass' });
    expect(await checkConditionDetailed(dbReturning([{ a: 0, b: 9 }]), cond, TD)).toEqual({ outcome: 'fail' });
  });

  test('ANY throw anywhere in the body → error, never an escaped exception or a bogus verdict', async () => {
    const booby = { get query() { throw new Error('boom from getter'); } };
    const out = await checkConditionDetailed(dbReturning([]), booby, TD);
    expect(out.outcome).toBe('error');
    expect(out.error).toMatch(/condition evaluation threw: boom from getter/);
  });
});

describe('checkCondition — boolean fail-closed wrapper (portalCardEngine contract)', () => {
  test('pass → true; fail → false; error → false', async () => {
    const db = { query: jest.fn(async () => [[{ ok: 1 }]]) };
    const cond = { query: 'SELECT ok FROM gate', assert: { ok: 1 } };
    expect(await checkCondition(db, cond, {})).toBe(true);
    db.query.mockImplementation(async () => [[{ ok: 0 }]]);
    expect(await checkCondition(db, cond, {})).toBe(false);
    db.query.mockImplementation(async () => { throw new Error('ER_WRONG_VALUE'); });
    expect(await checkCondition(db, cond, {})).toBe(false); // fail CLOSED on error
  });
});

// ─────────────────────────────────────────────────────────────
// 2. executeStep guards — hold on error, byte-identical on clean verdicts
// ─────────────────────────────────────────────────────────────

// In-memory fake of the tables executeStep + the advance walk touch.
// gate.rows / gate.throwMsg drive the condition query's result.
function makeEngineDb({ enrollment, steps, gate = { rows: [{ ok: 1 }] } }) {
  const state = {
    enrollments: [{ ...enrollment }],
    steps: steps.map((s, i) => ({ id: 1000 + i, ...s })),
    jobs: [],
    logs: [],
    gate,
    sql: [],
  };
  const enr = (id) => state.enrollments.find(e => e.id === id);
  const nextId = (rows, base) => rows.reduce((m, r) => Math.max(m, r.id), base) + 1;

  const handlers = [
    [/^SELECT e\.\*, tv\.template_condition AS template_condition, tv\.version AS _tv_version, t\.name AS template_name, t\.type AS template_type FROM sequence_enrollments e JOIN sequence_templates t ON t\.id = e\.template_id LEFT JOIN sequence_template_versions tv ON tv\.template_id = e\.template_id AND tv\.version = e\.template_version WHERE e\.id = \?$/,
      ([id]) => {
        const e = enr(id);
        return [e ? [{ ...e }] : []];
      }],
    [/^SELECT \* FROM sequence_steps WHERE template_id = \? AND version = \? AND step_number = \?$/,
      ([tid, ver, n]) => [state.steps
        .filter(s => s.template_id === tid && s.version === ver && s.step_number === n)
        .map(s => ({ ...s }))]],
    [/^SELECT scheduled_time FROM scheduled_jobs WHERE sequence_enrollment_id = \? AND JSON_UNQUOTE\(JSON_EXTRACT\(data, '\$\.stepNumber'\)\) = \? ORDER BY id DESC LIMIT 1$/,
      () => [[]]],
    // The condition under test (engine appends LIMIT 1).
    [/^SELECT ok FROM gate WHERE id = \? LIMIT 1$/,
      () => {
        if (state.gate.throwMsg) { const e = new Error(state.gate.throwMsg); e.code = 'ER_WRONG_VALUE'; throw e; }
        return [state.gate.rows.map(r => ({ ...r }))];
      }],
    // logStep
    [/^INSERT INTO sequence_step_log \(enrollment_id, step_id, step_number, status, skip_reason, action_config_resolved, output_data, error_message, duration_ms, scheduled_at, executed_at\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, NOW\(\)\)$/,
      ([enrollment_id, step_id, step_number, status, skip_reason, cfg, out, error_message]) => {
        const id = nextId(state.logs, 99);
        state.logs.push({ id, enrollment_id, step_id, step_number, status, skip_reason, error_message });
        return [{ insertId: id }];
      }],
    // cancelEnrollment
    [/^UPDATE sequence_enrollments SET status = 'cancelled', cancel_reason = \?, updated_at = NOW\(\) WHERE id = \?$/,
      ([reason, id]) => { Object.assign(enr(id), { status: 'cancelled', cancel_reason: reason }); return [{ affectedRows: 1 }]; }],
    [/^UPDATE scheduled_jobs SET status = 'cancelled', updated_at = NOW\(\) WHERE sequence_enrollment_id = \? AND status IN \('pending', 'running'\)$/,
      () => [{ affectedRows: 0 }]],
    // advance walk (scheduleFromStep)
    [/^UPDATE sequence_enrollments SET current_step = \?, updated_at = NOW\(\) WHERE id = \?$/,
      ([step, id]) => { enr(id).current_step = step; return [{ affectedRows: 1 }]; }],
    [/^UPDATE sequence_enrollments SET status = 'completed', current_step = \?, completed_at = NOW\(\), updated_at = NOW\(\) WHERE id = \?$/,
      ([step, id]) => { Object.assign(enr(id), { status: 'completed', current_step: step }); return [{ affectedRows: 1 }]; }],
    // scheduleStepJob
    [/^SELECT id FROM scheduled_jobs WHERE idempotency_key = \? AND status IN \('pending','running'\) LIMIT 1$/,
      ([key]) => [state.jobs.filter(j => j.idempotency_key === key && ['pending', 'running'].includes(j.status)).slice(0, 1)]],
    [/^INSERT INTO scheduled_jobs \(type, scheduled_time, status, name, data, sequence_enrollment_id, idempotency_key\) VALUES \('sequence_step', \?, 'pending', \?, \?, \?, \?\)$/,
      ([scheduled_time, name, data, sequence_enrollment_id, idempotency_key]) => {
        const id = nextId(state.jobs, 499);
        state.jobs.push({ id, type: 'sequence_step', scheduled_time, status: 'pending', name, data, sequence_enrollment_id, idempotency_key });
        return [{ insertId: id }];
      }],
  ];

  return {
    state,
    query: async (sql, params = []) => {
      const flat = sql.replace(/\s+/g, ' ').trim();
      state.sql.push(flat);
      for (const [re, fn] of handlers) if (re.test(flat)) return fn(params);
      throw new Error(`conditions harness: unrecognized SQL — ${flat}`);
    },
  };
}

const TEMPLATE_COND = { query: 'SELECT ok FROM gate WHERE id = :cid', params: { cid: 'trigger_data.case_id' }, assert: { ok: 1 } };
const BASE_ENROLLMENT = {
  id: 7, template_id: 30, template_version: 3, status: 'active',
  contact_id: 55, current_step: 1, total_steps: 2,
  trigger_data: JSON.stringify({ case_id: 42 }),
  template_condition: null, _tv_version: 3,
  template_name: 'Post-341 Ch7', template_type: 'post_341_ch7',
};
const STEP = (n, over = {}) => ({
  template_id: 30, version: 3, step_number: n,
  action_type: 'internal_function',
  timing: JSON.stringify({ type: 'immediate' }),
  action_config: JSON.stringify({ function_name: 'noop_fn', params: {} }),
  condition: null, fire_guard: null, error_policy: null,
  ...over,
});

describe('executeStep — template-level condition (Guard 2)', () => {
  test('ERROR → HOLD: no cancel, no action, no advance; failed log row carries discriminator + operator story', async () => {
    const db = makeEngineDb({
      enrollment: { ...BASE_ENROLLMENT, template_condition: JSON.stringify(TEMPLATE_COND) },
      steps: [STEP(1), STEP(2)],
      gate: { throwMsg: "Incorrect DATE value: ''" },
    });
    const result = await executeStep(db, 7, 1000, 1);

    expect(result).toEqual({ status: 'failed', reason: TEMPLATE_CONDITION_ERROR });
    // the incident's silent cancel must NOT happen
    expect(db.state.enrollments[0].status).toBe('active');
    expect(db.state.enrollments[0].cancel_reason).toBeUndefined();
    // no action, no successor job
    expect(executeJob).not.toHaveBeenCalled();
    expect(db.state.jobs).toHaveLength(0);
    expect(db.state.enrollments[0].current_step).toBe(1);
    // the log row: 'failed' + discriminator skip_reason + the whole story in error_message
    expect(db.state.logs).toHaveLength(1);
    const log = db.state.logs[0];
    expect(log.status).toBe('failed');
    expect(log.skip_reason).toBe(TEMPLATE_CONDITION_ERROR);
    expect(log.error_message).toMatch(/Template condition errored — enrollment HELD/);
    expect(log.error_message).toMatch(/not cancelled, not skipped, nothing was sent/);
    expect(log.error_message).toMatch(/skip_held_step/);
    expect(log.error_message).toMatch(/Error: condition query failed: Incorrect DATE value: ''/);
  });

  test('clean FALSE → cancels exactly as before: cancel_reason condition_failed, skipped log row, no action', async () => {
    const db = makeEngineDb({
      enrollment: { ...BASE_ENROLLMENT, template_condition: JSON.stringify(TEMPLATE_COND) },
      steps: [STEP(1), STEP(2)],
      gate: { rows: [{ ok: 0 }] },
    });
    const result = await executeStep(db, 7, 1000, 1);

    expect(result).toEqual({ status: 'skipped', reason: 'condition_failed' });
    expect(db.state.enrollments[0].status).toBe('cancelled');
    expect(db.state.enrollments[0].cancel_reason).toBe('condition_failed');
    expect(executeJob).not.toHaveBeenCalled();
    expect(db.state.logs).toHaveLength(1);
    expect(db.state.logs[0]).toMatchObject({ status: 'skipped', skip_reason: 'condition_failed', error_message: null });
  });

  test('PASS → action executes and the next step is scheduled', async () => {
    const db = makeEngineDb({
      enrollment: { ...BASE_ENROLLMENT, template_condition: JSON.stringify(TEMPLATE_COND) },
      steps: [STEP(1), STEP(2)],
      gate: { rows: [{ ok: 1 }] },
    });
    const result = await executeStep(db, 7, 1000, 1);

    expect(result.status).toBe('sent');
    expect(executeJob).toHaveBeenCalledTimes(1);
    expect(db.state.logs.map(l => l.status)).toEqual(['sent']);
    expect(db.state.jobs).toHaveLength(1); // step 2 scheduled
    expect(JSON.parse(db.state.jobs[0].data).stepNumber).toBe(2);
  });
});

describe('executeStep — step-level condition (Guard 4)', () => {
  const stepWithCond = (n) => STEP(n, { condition: JSON.stringify(TEMPLATE_COND) });

  test('ERROR → HOLD: no skip, no advance, no action; failed log row with discriminator', async () => {
    const db = makeEngineDb({
      enrollment: { ...BASE_ENROLLMENT },
      steps: [stepWithCond(1), STEP(2)],
      gate: { throwMsg: 'Unknown column case_341_initail in field list' },
    });
    const result = await executeStep(db, 7, 1000, 1);

    expect(result).toEqual({ status: 'failed', reason: STEP_CONDITION_ERROR });
    expect(db.state.enrollments[0].status).toBe('active');
    expect(executeJob).not.toHaveBeenCalled();
    expect(db.state.jobs).toHaveLength(0);             // NOT advanced — the skip path would have scheduled step 2
    expect(db.state.enrollments[0].current_step).toBe(1);
    expect(db.state.logs).toHaveLength(1);
    expect(db.state.logs[0]).toMatchObject({ status: 'failed', skip_reason: STEP_CONDITION_ERROR });
    expect(db.state.logs[0].error_message).toMatch(/Step condition errored — enrollment HELD/);
  });

  test('clean FALSE → skips and advances exactly as before', async () => {
    const db = makeEngineDb({
      enrollment: { ...BASE_ENROLLMENT },
      steps: [stepWithCond(1), STEP(2)],
      gate: { rows: [{ ok: 0 }] },
    });
    const result = await executeStep(db, 7, 1000, 1);

    expect(result).toEqual({ status: 'skipped', reason: 'step_condition_failed' });
    expect(db.state.enrollments[0].status).toBe('active');
    expect(executeJob).not.toHaveBeenCalled();
    expect(db.state.logs[0]).toMatchObject({ status: 'skipped', skip_reason: 'step_condition_failed', error_message: null });
    expect(db.state.jobs).toHaveLength(1);             // advanced to step 2
    expect(JSON.parse(db.state.jobs[0].data).stepNumber).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. previewEnrollmentSteps — errors surfaced, verdict is a stable token
// ─────────────────────────────────────────────────────────────

describe('previewEnrollmentSteps — condition errors surface to the author', () => {
  function makePreviewDb({ templateCondition = null, stepCondition = null, gate }) {
    const handlers = [
      [/^SELECT id, name, type, current_version, draft_version FROM sequence_templates WHERE id = \?$/,
        () => [[{ id: 30, name: 'T', type: 'post_341_ch7', current_version: 3, draft_version: null }]]],
      [/^SELECT template_condition FROM sequence_template_versions WHERE template_id = \? AND version = \?$/,
        () => [[{ template_condition: templateCondition ? JSON.stringify(templateCondition) : null }]]],
      [/^SELECT \* FROM sequence_steps WHERE template_id = \? AND version = \? ORDER BY step_number ASC$/,
        () => [[{
          id: 1000, template_id: 30, version: 3, step_number: 1, action_type: 'internal_function',
          timing: JSON.stringify({ type: 'immediate' }),
          action_config: JSON.stringify({ function_name: 'noop_fn', params: {} }),
          condition: stepCondition ? JSON.stringify(stepCondition) : null,
          fire_guard: null, error_policy: null,
        }]]],
      [/^SELECT ok FROM gate WHERE id = \? LIMIT 1$/,
        () => {
          if (gate.throwMsg) { throw new Error(gate.throwMsg); }
          return [gate.rows.map(r => ({ ...r }))];
        }],
    ];
    return {
      query: async (sql, params = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        for (const [re, fn] of handlers) if (re.test(flat)) return fn(params);
        // Preview is read-only; any write here is a side-effect bug.
        if (/^(INSERT|UPDATE|DELETE)/i.test(flat)) throw new Error(`preview issued a WRITE: ${flat}`);
        throw new Error(`preview harness: unrecognized SQL — ${flat}`);
      },
    };
  }

  test('template condition ERROR → stable token verdict + message in its own field; steps still previewed', async () => {
    const db = makePreviewDb({ templateCondition: TEMPLATE_COND, gate: { throwMsg: "Incorrect DATE value: ''" } });
    const p = await engine.previewEnrollmentSteps(db, { template_id: 30, contact_id: 55, trigger_data: { case_id: 42 } });
    expect(p.enrollment_verdict).toBe('would_hold_at_first_step');
    expect(p.template_condition_error).toMatch(/Incorrect DATE value/);
    expect(p.steps).toHaveLength(1);
  });

  test('template condition clean fail → verdict unchanged from pre-tri-state, no error field', async () => {
    const db = makePreviewDb({ templateCondition: TEMPLATE_COND, gate: { rows: [{ ok: 0 }] } });
    const p = await engine.previewEnrollmentSteps(db, { template_id: 30, contact_id: 55, trigger_data: { case_id: 42 } });
    expect(p.enrollment_verdict).toBe('would_cancel_at_first_step (template condition failed)');
    expect(p.template_condition_error).toBeNull();
  });

  test('step condition ERROR → condition_error on the step, would_skip stays null (production holds, not skips)', async () => {
    const db = makePreviewDb({ stepCondition: TEMPLATE_COND, gate: { throwMsg: 'Unknown column' } });
    const p = await engine.previewEnrollmentSteps(db, { template_id: 30, contact_id: 55, trigger_data: { case_id: 42 } });
    expect(p.enrollment_verdict).toBe('would_proceed');
    expect(p.steps[0].would_skip).toBeNull();
    expect(p.steps[0].condition_error).toMatch(/Unknown column/);
  });

  test('step condition clean fail → would_skip step_condition_failed, no condition_error', async () => {
    const db = makePreviewDb({ stepCondition: TEMPLATE_COND, gate: { rows: [{ ok: 0 }] } });
    const p = await engine.previewEnrollmentSteps(db, { template_id: 30, contact_id: 55, trigger_data: { case_id: 42 } });
    expect(p.steps[0].would_skip).toBe('step_condition_failed');
    expect(p.steps[0].condition_error).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// 4. GET /sequences/enrollments/:id?history=true — job-scoped log attachment
// ─────────────────────────────────────────────────────────────

const router = require('../routes/sequences');
const getLayer = router.stack.find(l =>
  l.route && l.route.path === '/sequences/enrollments/:id' && l.route.methods.get);
const getHandler = getLayer.route.stack[getLayer.route.stack.length - 1].handle;

// JS evaluation of the two history SELECTs over fake rows, mirroring the SQL
// semantics for exactly these predicates. The SQL TEXT itself is pinned by
// the source assertions below; this exercises the route + merge logic over
// the multi-job-per-step shapes the predicates exist for.
function makeHistoryDb({ enrollment, jobs, logs }) {
  const state = { enrollment, jobs, logs, sql: [] };
  const key = (v) => (v == null ? null : Number(v));
  const jobStep = (j) => key((typeof j.data === 'string' ? JSON.parse(j.data) : j.data || {}).stepNumber);
  const sameStep = (a, b) => (a === null && b === null) || a === b; // <=> semantics
  const t = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

  const pass1 = () => {
    const rows = [];
    for (const sj of state.jobs.filter(j => j.type === 'sequence_step' && j.sequence_enrollment_id === state.enrollment.id)) {
      const sjStep = jobStep(sj);
      const matches = state.logs.filter(l =>
        l.enrollment_id === sj.sequence_enrollment_id &&
        sameStep(key(l.step_number), sjStep) &&
        l.executed_at != null && t(l.executed_at) >= t(sj.created_at) &&
        !state.jobs.some(sj2 =>
          sj2.type === 'sequence_step' &&
          sj2.sequence_enrollment_id === sj.sequence_enrollment_id &&
          sameStep(jobStep(sj2), key(l.step_number)) &&
          (t(sj2.created_at) > t(sj.created_at) || (t(sj2.created_at) === t(sj.created_at) && sj2.id > sj.id)) &&
          t(sj2.created_at) <= t(l.executed_at)));
      const emit = (l) => rows.push({
        job_id: sj.id, scheduled_time: sj.scheduled_time, job_status: sj.status,
        attempts: sj.attempts ?? 0, max_attempts: sj.max_attempts ?? 3,
        job_updated_at: sj.updated_at ?? null, job_data: sj.data,
        step_number: jobStep(sj),
        log_id: l ? l.id : null, log_status: l ? l.status : null,
        skip_reason: l ? l.skip_reason : null, error_message: l ? l.error_message : null,
        duration_ms: l ? l.duration_ms ?? 0 : null, executed_at: l ? l.executed_at : null,
        action_config_resolved: null, output_data: null,
        log_step_id: l ? l.step_id : null, action_type: l ? 'internal_function' : null,
      });
      if (matches.length) matches.forEach(emit); else emit(null);
    }
    return rows;
  };

  const pass2 = () => state.logs
    .filter(l => l.enrollment_id === state.enrollment.id &&
      !state.jobs.some(sj =>
        sj.type === 'sequence_step' &&
        sj.sequence_enrollment_id === l.enrollment_id &&
        sameStep(jobStep(sj), key(l.step_number)) &&
        l.executed_at != null && t(sj.created_at) <= t(l.executed_at)))
    .map(l => ({
      job_id: null, scheduled_time: null, job_status: null, attempts: null,
      max_attempts: null, job_updated_at: null, job_data: null,
      step_number: l.step_number, log_id: l.id, log_status: l.status,
      skip_reason: l.skip_reason, error_message: l.error_message,
      duration_ms: l.duration_ms ?? 0, executed_at: l.executed_at,
      action_config_resolved: null, output_data: null,
      log_step_id: l.step_id, action_type: 'internal_function',
    }));

  return {
    state,
    query: async (sql, params = []) => {
      const flat = sql.replace(/\s+/g, ' ').trim();
      state.sql.push(flat);
      if (/^SELECT e\.\*, t\.name AS template_name, t\.type AS template_type FROM sequence_enrollments e JOIN sequence_templates t ON t\.id = e\.template_id WHERE e\.id = \?$/.test(flat)) {
        return [params[0] === state.enrollment.id ? [{ ...state.enrollment }] : []];
      }
      if (/^SELECT sj\.id AS job_id,/.test(flat)) return [pass1()];
      if (/^SELECT NULL AS job_id,/.test(flat)) return [pass2()];
      throw new Error(`history harness: unrecognized SQL — ${flat}`);
    },
  };
}

async function getHistory(db, id = '7') {
  const res = {
    code: 200, body: undefined,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
  await getHandler({ db, params: { id }, query: { log: 'false', history: 'true' } }, res);
  return res;
}

describe('enrollment history — job-scoped log attachment', () => {
  const T = (min) => new Date(Date.UTC(2026, 9, 12, 10, min));
  const ENR = { id: 7, template_id: 30, status: 'active', template_name: 'T', template_type: 'x', trigger_data: '{}' };
  const job = (id, n, status, createdMin, over = {}) => ({
    id, type: 'sequence_step', sequence_enrollment_id: 7, status,
    scheduled_time: T(createdMin), created_at: T(createdMin),
    data: JSON.stringify({ enrollmentId: 7, stepId: 1000, stepNumber: n }), ...over,
  });
  const log = (id, n, status, skip_reason, executedMin, over = {}) => ({
    id, enrollment_id: 7, step_id: 1000, step_number: n, status, skip_reason,
    error_message: null, executed_at: T(executedMin), ...over,
  });

  test('single-job steps: history unchanged — one row per job, its log attached, pending job bare', async () => {
    const db = makeHistoryDb({
      enrollment: ENR,
      jobs: [job(500, 1, 'completed', 0), job(501, 2, 'pending', 5)],
      logs: [log(100, 1, 'sent', null, 4)],
    });
    const { body } = await getHistory(db);
    expect(body.history).toHaveLength(2);
    expect(body.history[0]).toMatchObject({ job_id: 500, step_number: 1, log_status: 'sent' });
    expect(body.history[1]).toMatchObject({ job_id: 501, step_number: 2, log_status: null });
  });

  test('held step re-placed: the fresh pending job carries NO log; the old failed row stays on the consumed job', async () => {
    const db = makeHistoryDb({
      enrollment: ENR,
      jobs: [
        job(500, 2, 'completed', 0),             // the fire that held
        job(501, 2, 'pending', 20),              // Recover's re-placement, same step
      ],
      logs: [log(100, 2, 'failed', 'step_condition_error', 4)],
    });
    const { body } = await getHistory(db);
    expect(body.history).toHaveLength(2);
    const byJob = Object.fromEntries(body.history.map(r => [r.job_id, r]));
    expect(byJob[500]).toMatchObject({ log_status: 'failed', skip_reason: 'step_condition_error' });
    expect(byJob[501]).toMatchObject({ log_status: null, skip_reason: null }); // the bug: bare join hung the old row here
  });

  test('after the re-fire: 2 jobs ↔ 2 logs, matched 1:1 by tenure — no 2×2 fan-out', async () => {
    const db = makeHistoryDb({
      enrollment: ENR,
      jobs: [job(500, 2, 'completed', 0), job(501, 2, 'completed', 20)],
      logs: [
        log(100, 2, 'failed', 'step_condition_error', 4),
        log(101, 2, 'sent', null, 25),
      ],
    });
    const { body } = await getHistory(db);
    expect(body.history).toHaveLength(2); // the bare join produced 4
    const byJob = Object.fromEntries(body.history.map(r => [r.job_id, r]));
    expect(byJob[500]).toMatchObject({ log_id: 100, log_status: 'failed' });
    expect(byJob[501]).toMatchObject({ log_id: 101, log_status: 'sent' });
  });

  test('skip_held_step shape: hold + skip rows both sit on the consumed job (two events of its tenure); the walk-placed next-step job is bare', async () => {
    const db = makeHistoryDb({
      enrollment: ENR,
      jobs: [job(500, 2, 'completed', 0), job(501, 3, 'pending', 30)],
      logs: [
        log(100, 2, 'failed', 'step_condition_error', 4),
        log(101, 2, 'skipped', 'held_step_skipped', 29),
      ],
    });
    const { body } = await getHistory(db);
    expect(body.history).toHaveLength(3);
    expect(body.history.filter(r => r.job_id === 500).map(r => r.skip_reason).sort())
      .toEqual(['held_step_skipped', 'step_condition_error']);
    expect(body.history.find(r => r.job_id === 501)).toMatchObject({ log_status: null });
  });

  test('orphan unschedulable skips still surface via pass 2, exactly once', async () => {
    const db = makeHistoryDb({
      enrollment: ENR,
      jobs: [job(500, 2, 'pending', 0)],
      logs: [log(100, 1, 'skipped', 'unschedulable', 0)], // step 1 never got a job
    });
    const { body } = await getHistory(db);
    expect(body.history).toHaveLength(2);
    const orphan = body.history.find(r => r.job_id === null);
    expect(orphan).toMatchObject({ step_number: 1, skip_reason: 'unschedulable' });
  });

  test('SOURCE PIN — the live SQL carries the tenure predicates in BOTH passes (the fake above evaluates, this guards the real statements)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sequences.js'), 'utf8');
    // pass 1: log must postdate the job…
    expect(src).toMatch(/AND l\.executed_at\s+>= sj\.created_at/);
    // …and no newer same-step job may predate the log (id breaks created_at ties)
    expect(src).toMatch(/sj2\.created_at > sj\.created_at/);
    expect(src).toMatch(/sj2\.created_at = sj\.created_at AND sj2\.id > sj\.id/);
    expect(src).toMatch(/AND sj2\.created_at <= l\.executed_at/);
    // pass 2 mirrors: "has a job" means a same-step job created at-or-before executed_at
    expect(src).toMatch(/<=> l\.step_number\s+AND sj\.created_at <= l\.executed_at\s+\)`/);
  });
});

// ─────────────────────────────────────────────────────────────
// 5. Source pins — the engine never routes its guards through the boolean
//    wrapper again, and the constants stay shared
// ─────────────────────────────────────────────────────────────

describe('source pins — tri-state wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const engineSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sequenceEngine.js'), 'utf8');
  const routeSrc  = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sequences.js'), 'utf8');

  test('executeStep guards call checkConditionDetailed, not the boolean wrapper', () => {
    // Both fire-time guards use the detailed form…
    expect(engineSrc).toMatch(/const cond = await checkConditionDetailed\(db, templateCondition, triggerData\);/);
    expect(engineSrc).toMatch(/const cond = await checkConditionDetailed\(db, step\.condition, triggerData\);/);
    // …and no fire-time guard collapses errors back into booleans.
    expect(engineSrc).not.toMatch(/await checkCondition\(db, templateCondition/);
    expect(engineSrc).not.toMatch(/await checkCondition\(db, step\.condition/);
  });

  test('hold paths return the shared reason constants and never cancel', () => {
    expect(engineSrc).toMatch(/return \{ status: 'failed', reason: TEMPLATE_CONDITION_ERROR \};/);
    expect(engineSrc).toMatch(/return \{ status: 'failed', reason: STEP_CONDITION_ERROR \};/);
  });

  test('/recover keys its target on CONDITION_ERROR_REASONS from the engine (one source of truth)', () => {
    expect(routeSrc).toMatch(/CONDITION_ERROR_REASONS\.includes\(lastLog\.skip_reason\)/);
    expect(routeSrc).toMatch(/require\('\.\.\/lib\/sequenceEngine'\)/);
    expect(CONDITION_ERROR_REASONS).toEqual(['template_condition_error', 'step_condition_error']);
  });
});
