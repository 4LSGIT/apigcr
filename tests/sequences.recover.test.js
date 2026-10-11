/**
 * tests/sequences.recover.test.js
 *
 * POST /sequences/enrollments/:id/recover — operator recovery of a wedged
 * enrollment (status 'active', no pending/running scheduled_jobs row).
 *
 * WHY THIS EXISTS
 * Until 2026-10 the route inserted the target step's job at NOW() and never
 * looked at the step's timing. The path had never run in production (zero
 * wedges since the May 2026 calendar fix), so nothing showed it — but the
 * next operator click would have sent, on the spot:
 *   - a `next_business_day @ 15:00` no-show text at whatever hour the click
 *     happened (night in Detroit, Shabbos, Yom Tov);
 *   - "your 341 Meeting is starting in 10 minutes" days before the meeting;
 *   - a reminder for an appointment that had already happened.
 * No execution-time guard catches those (fire_guard only blocks too-close-to-
 * appt; `appt_status = 'Scheduled'` passes for an early send and for any past
 * appt nobody marked).
 *
 * The route now hands the walk to sequenceEngine.scheduleFromStep — the same
 * function enrollment and advanceToNextStep use — with floor = now.
 *
 * HARNESS
 * The REAL route handler and the REAL engine (scheduleFromStep →
 * calculateStepTime → scheduleStepJob / logStep) run against an in-memory
 * table fake that interprets exactly the statements those two issue. An
 * unrecognized statement THROWS — SQL drift fails the suite instead of
 * quietly returning no rows. Boundaries faked: the Cloud Tasks doorbell
 * (lib/taskQueue.enqueueJobDispatch) and Hebcal (global fetch → no holidays).
 * The clock is frozen at Friday 2026-10-16 23:00 America/Detroit — i.e.
 * Shabbos has started — so "fired right now" is distinguishable from
 * "placed by the timing rule" in every case.
 *
 *   npx jest tests/sequences.recover.test.js
 */

jest.mock('../lib/taskQueue', () => ({
  ...jest.requireActual('../lib/taskQueue'),
  enqueueJobDispatch: jest.fn(async () => true),
}));

const router = require('../routes/sequences');

// Friday 2026-10-16 23:00 EDT. Saturday 10-17 is Shabbos; Sunday 10-18 is the
// next business day (noSunday unset).
const NOW = new Date('2026-10-17T03:00:00.000Z');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

const recoverLayer = router.stack.find(l =>
  l.route && l.route.path === '/sequences/enrollments/:id/recover' && l.route.methods.post);
const recoverHandler = recoverLayer.route.stack[recoverLayer.route.stack.length - 1].handle;

// ─────────────────────────────────────────────────────────────
// In-memory fake of the four tables the route + walk touch.
// ─────────────────────────────────────────────────────────────
function makeDb({ enrollment, steps, jobs = [], logs = [] }) {
  const state = {
    enrollments: [{ ...enrollment }],
    steps: steps.map((s, i) => ({ id: 1000 + i, ...s })),
    jobs: jobs.map((j, i) => ({ id: 500 + i, ...j })),
    logs: logs.map((l, i) => ({ id: 100 + i, ...l })),
    sql: [],
  };
  const nextId = (rows, base) => rows.reduce((m, r) => Math.max(m, r.id), base) + 1;
  const enr = (id) => state.enrollments.find(e => e.id === id);

  const handlers = [
    // ── route ──
    [/^SELECT id, template_id, template_version, status, current_step, total_steps, trigger_data FROM sequence_enrollments WHERE id = \?$/,
      ([id]) => [[enr(id)].filter(Boolean).map(e => ({ ...e }))]],
    [/^SELECT id, status FROM scheduled_jobs WHERE sequence_enrollment_id = \? AND status IN \('pending', 'running'\) ORDER BY id DESC LIMIT 1$/,
      ([id]) => [state.jobs
        .filter(j => j.sequence_enrollment_id === id && ['pending', 'running'].includes(j.status))
        .sort((a, b) => b.id - a.id).slice(0, 1)]],
    [/^SELECT id, step_number FROM sequence_step_log WHERE enrollment_id = \? ORDER BY id DESC LIMIT 1$/,
      ([id]) => [state.logs.filter(l => l.enrollment_id === id).sort((a, b) => b.id - a.id).slice(0, 1)]],
    [/^SELECT step_number FROM sequence_step_log WHERE enrollment_id = \? AND id > \? AND status = 'skipped' AND skip_reason = 'unschedulable' ORDER BY id ASC$/,
      ([id, after]) => [state.logs
        .filter(l => l.enrollment_id === id && l.id > after && l.status === 'skipped' && l.skip_reason === 'unschedulable')
        .sort((a, b) => a.id - b.id)]],
    [/^SELECT COALESCE\(MAX\(id\), 0\) AS max_id FROM scheduled_jobs WHERE sequence_enrollment_id = \?$/,
      ([id]) => [[{ max_id: state.jobs.filter(j => j.sequence_enrollment_id === id).reduce((m, j) => Math.max(m, j.id), 0) }]]],
    [/^SELECT id, scheduled_time, status, data FROM scheduled_jobs WHERE sequence_enrollment_id = \? AND id > \? ORDER BY id ASC LIMIT 1$/,
      ([id, after]) => [state.jobs
        .filter(j => j.sequence_enrollment_id === id && j.id > after)
        .sort((a, b) => a.id - b.id).slice(0, 1)]],

    // ── engine: scheduleFromStep ──
    [/^SELECT \* FROM sequence_steps WHERE template_id = \? AND version = \? AND step_number = \?$/,
      ([tid, ver, n]) => [state.steps
        .filter(s => s.template_id === tid && s.version === ver && s.step_number === n)
        // mysql2 hands JSON columns back parsed OR as strings depending on the
        // column/driver path; the walk handles both — exercise the string form.
        .map(s => ({ ...s, timing: JSON.stringify(s.timing) }))]],
    [/^UPDATE sequence_enrollments SET status = 'completed', current_step = \?, completed_at = NOW\(\), updated_at = NOW\(\) WHERE id = \?$/,
      ([step, id]) => { Object.assign(enr(id), { status: 'completed', current_step: step }); return [{ affectedRows: 1 }]; }],
    [/^UPDATE sequence_enrollments SET current_step = \?, updated_at = NOW\(\) WHERE id = \?$/,
      ([step, id]) => { enr(id).current_step = step; return [{ affectedRows: 1 }]; }],

    // ── engine: logStep ──
    [/^INSERT INTO sequence_step_log \(enrollment_id, step_id, step_number, status, skip_reason, action_config_resolved, output_data, error_message, duration_ms, scheduled_at, executed_at\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, NOW\(\)\)$/,
      ([enrollment_id, step_id, step_number, status, skip_reason]) => {
        const id = nextId(state.logs, 99);
        state.logs.push({ id, enrollment_id, step_id, step_number, status, skip_reason });
        return [{ insertId: id }];
      }],

    // ── engine: scheduleStepJob ──
    [/^SELECT id FROM scheduled_jobs WHERE idempotency_key = \? AND status IN \('pending','running'\) LIMIT 1$/,
      ([key]) => [state.jobs.filter(j => j.idempotency_key === key && ['pending', 'running'].includes(j.status)).slice(0, 1)]],
    [/^INSERT INTO scheduled_jobs \(type, scheduled_time, status, name, data, sequence_enrollment_id, idempotency_key\) VALUES \('sequence_step', \?, 'pending', \?, \?, \?, \?\)$/,
      ([scheduled_time, name, data, sequence_enrollment_id, idempotency_key]) => {
        // The live column is NOT NULL and mysql2 serializes Invalid Date as
        // NULL — the exact failure behind the May 2026 wedge. Keep it loud.
        if (!(scheduled_time instanceof Date) || Number.isNaN(scheduled_time.getTime())) {
          throw new Error("Column 'scheduled_time' cannot be null");
        }
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
      throw new Error(`recover harness: unrecognized SQL — ${flat}`);
    },
  };
}

async function recover(db, id = '7') {
  const res = {
    code: 200, body: undefined,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
  await recoverHandler({ db, params: { id } }, res);
  return res;
}

const ENROLLMENT = {
  id: 7, template_id: 19, template_version: 2, status: 'active',
  current_step: 2, total_steps: 4, trigger_data: {},
};
const step = (n, timing, extra = {}) => ({ template_id: 19, version: 2, step_number: n, timing, ...extra });
const sentLog = (n) => ({ enrollment_id: 7, step_id: 1, step_number: n, status: 'sent', skip_reason: null });
const pendingJobs = (db) => db.state.jobs.filter(j => j.status === 'pending');
// What production always has: finished jobs for the steps already run, plus
// unrelated rows. The read-back must report the walk's job, not any of these.
const doneJob = (enrollmentId, n) => ({
  sequence_enrollment_id: enrollmentId, status: 'completed',
  idempotency_key: `seq-${enrollmentId}-step-${n}`,
  scheduled_time: new Date(NOW.getTime() - DAY), data: JSON.stringify({ enrollmentId, stepNumber: n }),
});
const HISTORY = [doneJob(7, 1), doneJob(7, 2), doneJob(8, 1)]; // ids 500, 501, 502

let errorSpy;
let logSpy;
beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ items: [] }) }));
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  delete global.fetch;
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

describe('POST /sequences/enrollments/:id/recover — the target step keeps its timing rule', () => {
  test('next_business_day @ 15:00 recovered on Friday night is placed on the next business day, not fired on the spot', async () => {
    const db = makeDb({
      enrollment: ENROLLMENT,
      steps: [step(3, { type: 'next_business_day', timeOfDay: '15:00' })],
      logs: [sentLog(2)],
      jobs: HISTORY,
    });
    const res = await recover(db);

    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({ success: true, step_number: 3, skipped_steps: [] });
    const [job] = pendingJobs(db);
    expect(job.id).toBe(503);                          // the new row, above the history
    // Sunday 2026-10-18 15:00 EDT. Shabbos (10-17) is skipped.
    expect(job.scheduled_time.toISOString()).toBe('2026-10-18T19:00:00.000Z');
    expect(res.body.new_scheduled_at).toBe('2026-10-18T19:00:00.000Z');
    expect(res.body.job_id).toBe(job.id);
    expect(db.state.enrollments[0]).toMatchObject({ status: 'active', current_step: 3 });
  });

  test('relative delay counts from the recovery moment', async () => {
    const db = makeDb({
      enrollment: ENROLLMENT,
      steps: [step(3, { type: 'delay', value: 2, unit: 'hours' })],
      logs: [sentLog(2)],
    });
    await recover(db);
    expect(pendingJobs(db)[0].scheduled_time.toISOString()).toBe(iso(NOW.getTime() + 2 * HOUR));
  });

  test('an appointment reminder that is not due yet is placed at its own offset — never early', async () => {
    // "Starting in 10 minutes" for an appointment three days out.
    const appt = NOW.getTime() + 3 * DAY;
    const db = makeDb({
      enrollment: { ...ENROLLMENT, trigger_data: { appt_time: iso(appt) } },
      steps: [step(3, { type: 'before_appt_fixed', hoursBack: 0.1667 })],
      logs: [sentLog(2)],
    });
    const res = await recover(db);

    const [job] = pendingJobs(db);
    expect(job.scheduled_time.getTime()).toBe(appt - Math.round(0.1667 * HOUR));
    expect(job.scheduled_time.getTime()).toBeGreaterThan(NOW.getTime() + 2 * DAY);
    expect(res.body.skipped_steps).toEqual([]);
  });
});

describe('POST /sequences/enrollments/:id/recover — floor = now: a missed window is skipped, not sent late', () => {
  test('business-day reminder (before_appt) that still fits is placed on its own slot', async () => {
    // Appointment Thu 2026-10-29 14:00 EDT; "24h before, same time" → Wed
    // 2026-10-28 14:00 EDT, a business day well ahead of the frozen clock.
    const appt = new Date('2026-10-29T18:00:00.000Z').getTime();
    const db = makeDb({
      enrollment: { ...ENROLLMENT, trigger_data: { appt_time: iso(appt) } },
      steps: [step(3, { type: 'before_appt', hoursBack: 24, sameTimeAsAnchor: true })],
      logs: [sentLog(2)],
      jobs: HISTORY,
    });
    const res = await recover(db);

    expect(res.body).toMatchObject({ success: true, step_number: 3, skipped_steps: [] });
    expect(pendingJobs(db)[0].scheduled_time.toISOString()).toBe('2026-10-28T18:00:00.000Z');
  });

  test('a reminder whose time passed during the wedge is skipped and the next one that still fits is placed', async () => {
    // Appointment in 5h. Step 3 (24h before) is 19h stale; step 4 (2h before)
    // still fits.
    const appt = NOW.getTime() + 5 * HOUR;
    const db = makeDb({
      enrollment: { ...ENROLLMENT, trigger_data: { appt_time: iso(appt) } },
      steps: [
        step(3, { type: 'before_appt_fixed', hoursBack: 24 }),
        step(4, { type: 'before_appt_fixed', hoursBack: 2 }),
      ],
      // Step 1 was skipped the same way back at ENROLLMENT — an older
      // 'unschedulable' row that this recovery must not report as its own.
      logs: [
        { enrollment_id: 7, step_id: 1, step_number: 1, status: 'skipped', skip_reason: 'unschedulable' },
        sentLog(2),
      ],
      jobs: HISTORY,
    });
    const res = await recover(db);

    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({ success: true, step_number: 4 });
    expect(res.body.skipped_steps).toEqual([3]);      // not [1, 3]
    expect(res.body.note).toMatch(/step\(s\) 3 skipped/);

    const jobs = pendingJobs(db);
    expect(jobs).toHaveLength(1);                     // exactly one job — no late step 3
    expect(res.body.job_id).toBe(jobs[0].id);
    expect(JSON.parse(jobs[0].data)).toMatchObject({ enrollmentId: 7, stepNumber: 4 });
    expect(jobs[0].scheduled_time.getTime()).toBe(appt - 2 * HOUR);

    const skip = db.state.logs.find(l => l.step_number === 3);
    expect(skip).toMatchObject({ status: 'skipped', skip_reason: 'unschedulable' });
    expect(db.state.enrollments[0]).toMatchObject({ status: 'active', current_step: 4 });
  });

  test('business-day reminder (before_appt) with no runway left is skipped the same way', async () => {
    // The live "7 days before @ 11:00" shape, appointment only 2 days out.
    const appt = NOW.getTime() + 2 * DAY;
    const db = makeDb({
      enrollment: { ...ENROLLMENT, trigger_data: { appt_time: iso(appt) } },
      steps: [
        step(3, { type: 'before_appt', hoursBack: 168, timeOfDay: '11:00', sameTimeAsAnchor: false }),
        step(4, { type: 'before_appt_fixed', hoursBack: 2 }),
      ],
      logs: [sentLog(2)],
    });
    const res = await recover(db);

    expect(res.body).toMatchObject({ step_number: 4, skipped_steps: [3] });
    expect(pendingJobs(db)).toHaveLength(1);
    expect(pendingJobs(db)[0].scheduled_time.getTime()).toBe(appt - 2 * HOUR);
  });

  test('recovered after the appointment: every remaining reminder is skipped, nothing is sent, enrollment completes', async () => {
    const appt = NOW.getTime() - 3 * HOUR;
    const db = makeDb({
      enrollment: { ...ENROLLMENT, trigger_data: { appt_time: iso(appt) } },
      steps: [
        step(3, { type: 'before_appt_fixed', hoursBack: 2 }),
        step(4, { type: 'before_appt_fixed', hoursBack: 0.05 }),
      ],
      logs: [sentLog(2)],
    });
    const res = await recover(db);

    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: 'completed', skipped_steps: [3, 4] });
    expect(res.body.note).toMatch(/send window had already passed for step\(s\) 3, 4/);
    expect(db.state.jobs).toHaveLength(0);            // no stale burst
    expect(db.state.enrollments[0].status).toBe('completed');
  });
});

describe('POST /sequences/enrollments/:id/recover — target selection, terminal, pinned version', () => {
  test('target is last-logged step + 1 even when current_step lags, and current_step is brought forward', async () => {
    const db = makeDb({
      enrollment: { ...ENROLLMENT, current_step: 2 },
      steps: [step(4, { type: 'immediate' })],
      logs: [sentLog(2), sentLog(3)],
    });
    const res = await recover(db);
    expect(res.body.step_number).toBe(4);
    expect(db.state.enrollments[0].current_step).toBe(4);
    expect(pendingJobs(db)[0].scheduled_time.toISOString()).toBe(iso(NOW.getTime() + 5000));
  });

  test('read-back reports the walk\'s own job even if the doorbell already ran it and queued its successor', async () => {
    // An `immediate` step is inside the Cloud Tasks accelerator window. Model
    // the worst case: by the time the route reads back, the step has
    // executed (job completed) and the engine has inserted step 5's job.
    const { enqueueJobDispatch } = require('../lib/taskQueue');
    const db = makeDb({
      enrollment: ENROLLMENT,
      steps: [step(4, { type: 'immediate' })],
      logs: [sentLog(3)],
      jobs: HISTORY,
    });
    enqueueJobDispatch.mockImplementationOnce(async (jobId) => {
      db.state.jobs.find(j => j.id === jobId).status = 'completed';
      db.state.jobs.push({
        id: jobId + 1, sequence_enrollment_id: 7, status: 'pending', idempotency_key: 'seq-7-step-5',
        scheduled_time: new Date(NOW.getTime() + DAY), data: JSON.stringify({ enrollmentId: 7, stepNumber: 5 }),
      });
      return true;
    });
    const res = await recover(db);

    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({ success: true, job_id: 503, step_number: 4 });
    expect(res.body.new_scheduled_at).toBe(iso(NOW.getTime() + 5000));
  });

  test('enrollment-time wedge (no log rows) resumes at current_step', async () => {
    const db = makeDb({
      enrollment: { ...ENROLLMENT, current_step: 1 },
      steps: [step(1, { type: 'delay', value: 15, unit: 'minutes' })],
    });
    const res = await recover(db);
    expect(res.body.step_number).toBe(1);
    expect(pendingJobs(db)[0].scheduled_time.toISOString()).toBe(iso(NOW.getTime() + 15 * 60 * 1000));
  });

  test('no step at the target number → enrollment completed, no job', async () => {
    const db = makeDb({ enrollment: ENROLLMENT, steps: [], logs: [sentLog(4)] });
    const res = await recover(db);
    expect(res.body).toMatchObject({ success: true, status: 'completed', step_number: 5, skipped_steps: [] });
    expect(res.body.note).toMatch(/Nothing left to schedule from step 5/);
    expect(db.state.jobs).toHaveLength(0);
    expect(db.state.enrollments[0].status).toBe('completed');
  });

  test('walks the PINNED version, not a newer one with the same step number', async () => {
    const db = makeDb({
      enrollment: ENROLLMENT, // pinned v2
      steps: [
        step(3, { type: 'delay', value: 1, unit: 'hours' }),
        { template_id: 19, version: 3, step_number: 3, timing: { type: 'delay', value: 9, unit: 'hours' } },
      ],
      logs: [sentLog(2)],
    });
    await recover(db);
    expect(pendingJobs(db)[0].scheduled_time.toISOString()).toBe(iso(NOW.getTime() + 1 * HOUR));
    expect(JSON.parse(pendingJobs(db)[0].data).stepId).toBe(1000); // the v2 row
  });

  test('trigger_data delivered as a JSON string is parsed before the walk', async () => {
    const appt = NOW.getTime() + 3 * DAY;
    const db = makeDb({
      enrollment: { ...ENROLLMENT, trigger_data: JSON.stringify({ appt_time: iso(appt) }) },
      steps: [step(3, { type: 'before_appt_fixed', hoursBack: 2 })],
      logs: [sentLog(2)],
    });
    await recover(db);
    expect(pendingJobs(db)[0].scheduled_time.getTime()).toBe(appt - 2 * HOUR);
  });
});

describe('POST /sequences/enrollments/:id/recover — refusals and failures', () => {
  test('a step that cannot be timed fails the recovery instead of being force-fired now', async () => {
    // Appt-anchored step, no appt_time in trigger_data: calculateStepTime
    // throws. The old route never computed timing and sent this at NOW().
    const db = makeDb({
      enrollment: ENROLLMENT,
      steps: [step(3, { type: 'before_appt_fixed', hoursBack: 2 })],
      logs: [sentLog(2)],
    });
    const res = await recover(db);

    expect(res.code).toBe(500);
    expect(res.body.error).toBe('Failed to recover enrollment');
    expect(res.body.message).toMatch(/Could not schedule step 3: before_appt_fixed requires trigger_data\.appt_time/);
    expect(res.body).toMatchObject({ step_number: 3, skipped_steps: [] });
    expect(res.body.message).toMatch(/still stuck/);
    expect(db.state.jobs).toHaveLength(0);
    expect(db.state.enrollments[0]).toMatchObject({ status: 'active', current_step: 2 });
  });

  test('409 when a pending job already exists — nothing is walked', async () => {
    const db = makeDb({
      enrollment: ENROLLMENT,
      steps: [step(3, { type: 'immediate' })],
      logs: [sentLog(2)],
      jobs: [{ sequence_enrollment_id: 7, status: 'pending', idempotency_key: 'seq-7-step-3', scheduled_time: NOW, data: '{}' }],
    });
    const res = await recover(db);
    expect(res.code).toBe(409);
    expect(res.body).toMatchObject({ job_id: 500, job_status: 'pending' });
    expect(db.state.jobs).toHaveLength(1);
    expect(db.state.sql.some(s => /FROM sequence_steps/.test(s))).toBe(false);
  });

  test('409 when the existing job is running, too', async () => {
    const db = makeDb({
      enrollment: ENROLLMENT,
      steps: [step(3, { type: 'immediate' })],
      logs: [sentLog(2)],
      jobs: [{ sequence_enrollment_id: 7, status: 'running', idempotency_key: 'seq-7-step-3', scheduled_time: NOW, data: '{}' }],
    });
    const res = await recover(db);
    expect(res.code).toBe(409);
    expect(res.body.job_status).toBe('running');
    expect(db.state.jobs).toHaveLength(1);
  });

  test('skip-then-throw: the 500 names the step that failed and the steps already skipped', async () => {
    // Step 3's window is gone (skip, committed); step 4 cannot be timed.
    const appt = NOW.getTime() + 5 * HOUR;
    const db = makeDb({
      enrollment: { ...ENROLLMENT, trigger_data: { appt_time: iso(appt) } },
      steps: [
        step(3, { type: 'before_appt_fixed', hoursBack: 24 }),
        step(4, { type: 'no_such_timing' }),
      ],
      logs: [sentLog(2)],
      jobs: HISTORY,
    });
    const res = await recover(db);

    expect(res.code).toBe(500);
    expect(res.body).toMatchObject({ step_number: 4, skipped_steps: [3] });
    expect(res.body.message).toMatch(/Could not schedule step 4: Unknown timing type: "no_such_timing"/);
    expect(res.body.message).toMatch(/Step\(s\) 3 were skipped first/);
    expect(pendingJobs(db)).toHaveLength(0);

    // The retry resumes AFTER the committed skip and fails the same way —
    // it cannot report step 3 again, which is why the first response must.
    const again = await recover(db);
    expect(again.code).toBe(500);
    expect(again.body).toMatchObject({ step_number: 4, skipped_steps: [] });
    expect(db.state.logs.filter(l => l.skip_reason === 'unschedulable')).toHaveLength(1);
  });

  test('malformed trigger_data fails closed — 500, nothing walked', async () => {
    const db = makeDb({
      enrollment: { ...ENROLLMENT, trigger_data: '{not json' },
      steps: [step(3, { type: 'immediate' })],
      logs: [sentLog(2)],
    });
    const res = await recover(db);
    expect(res.code).toBe(500);
    expect(res.body.error).toBe('Failed to recover enrollment');
    expect(db.state.jobs).toHaveLength(0);
    expect(db.state.sql.some(s => /FROM sequence_steps/.test(s))).toBe(false);
  });

  test('409 when the enrollment is not active; 404 when missing; 400 on a bad id', async () => {
    const cancelled = makeDb({ enrollment: { ...ENROLLMENT, status: 'cancelled' }, steps: [] });
    expect((await recover(cancelled)).code).toBe(409);

    const missing = makeDb({ enrollment: ENROLLMENT, steps: [] });
    expect((await recover(missing, '8')).code).toBe(404);

    const bad = makeDb({ enrollment: ENROLLMENT, steps: [] });
    expect((await recover(bad, 'abc')).code).toBe(400);
    expect(bad.state.sql).toHaveLength(0);
  });
});
