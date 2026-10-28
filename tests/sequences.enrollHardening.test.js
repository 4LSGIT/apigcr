'use strict';
/**
 * tests/sequences.enrollHardening.test.js
 *
 * A18.4a — the ENGINE half of the enroll hardening (lib/sequenceEngine.js
 * _enrollWithTemplate, reached through the exported enrollContactByTemplateId
 * — the single funnel every caller passes through: the route, hook / trigger
 * sequence targets, the enroll_sequence internal function, appointment and
 * e-sign reminders).
 *
 * The contract pinned here, against a scripted pool that records WHICH
 * session ran each statement:
 *   1. THE FENCE IS ONE SESSION. GET_LOCK, the duplicate-check SELECT, the
 *      enrollment INSERT and RELEASE_LOCK all run on ONE connection pinned
 *      with getConnection(), in that order, and the connection goes back to
 *      the pool. GET_LOCK is session-scoped: on pool.query (which hops
 *      connections) it would fence nothing.
 *   2. FAIL CLOSED. A lock that is not granted (0 = timed out, NULL = error)
 *      is ENROLL_BUSY: no duplicate check, no INSERT, nothing to release.
 *   3. The lock is released on EVERY exit (duplicate refusal included); a
 *      connection whose RELEASE_LOCK failed is destroyed, never pooled —
 *      a pooled session still holding the lock would wedge that identity.
 *   4. A caller that hands in a single connection (no getConnection) is
 *      locked on that connection.
 *   5. THE WEDGE FIX. A first step that cannot be scheduled (the A18.0 trap:
 *      an absolute delay.at placeholder that resolves empty) cancels the
 *      enrollment it just inserted — cancel_reason 'scheduling failed: …',
 *      ≤ 200 chars — records an error alert, and throws SCHEDULING_FAILED
 *      carrying enrollment_id. A cancel write that itself fails still throws
 *      SCHEDULING_FAILED (cancelled:false) — never a success, never swallowed.
 *   6. The never-published and no-steps refusals carry NEVER_PUBLISHED /
 *      EMPTY_SEQUENCE.
 * The real-engine proof of the race itself is the gated twin
 * tests/sequences.enrollHardening.mysql.test.js.
 *
 *   npx jest tests/sequences.enrollHardening.test.js
 */

jest.mock('../lib/taskQueue', () => ({
  ...jest.requireActual('../lib/taskQueue'),
  enqueueJobDispatch: jest.fn(async () => true),
}));

const seq = require('../lib/sequenceEngine');

const TEMPLATE = { id: 42, name: 'Lead drip', active: 1, current_version: 3, capture_mode: 'off' };
const DELAY_STEP = { id: 900, template_id: 42, version: 3, step_number: 1, action_type: 'sms',
  action_config: '{}', timing: '{"type":"delay","value":1,"unit":"days"}',
  condition: null, fire_guard: null, error_policy: null };
const BROKEN_STEP = { ...DELAY_STEP, timing: '{"type":"delay","at":"{{trigger_data.hearing_at}}"}' };

/**
 * Scripted pool. Every statement is recorded as [session, sql, params] where
 * session is 'pool' or 'conn#N'. Unscripted SQL throws.
 */
function makePool({ template = TEMPLATE, steps = [DELAY_STEP], existing = [], lockGot = 1,
  releaseThrows = false, cancelThrows = false, cancelledElsewhere = false } = {}) {
  const log = [];
  const state = { enrollments: [], jobs: [], alerts: [], released: 0, destroyed: 0, conns: 0 };
  const run = (session) => async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    log.push([session, s, params]);
    if (/^SELECT GET_LOCK\(\?, \?\) AS got$/.test(s)) return [[{ got: lockGot }]];
    if (/^SELECT RELEASE_LOCK\(\?\)/.test(s)) {
      if (releaseThrows) throw Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' });
      return [[{ released: 1 }]];
    }
    if (/^SELECT \* FROM sequence_templates WHERE id = \?/.test(s)) return [params[0] === template.id ? [{ ...template }] : []];
    if (/^SELECT \* FROM sequence_steps WHERE template_id = \? AND version = \? ORDER BY/.test(s)) {
      return [steps.map((x) => ({ ...x }))];
    }
    if (/^SELECT id FROM sequence_enrollments WHERE contact_id = \?/.test(s)) return [existing];
    if (/^INSERT INTO sequence_enrollments/.test(s)) {
      const id = 600 + state.enrollments.length;
      state.enrollments.push({ id, status: 'active', cancel_reason: null, params });
      return [{ insertId: id, affectedRows: 1 }];
    }
    if (/^SELECT \* FROM sequence_steps WHERE template_id = \? AND version = \? AND step_number = \?/.test(s)) {
      return [steps.filter((x) => x.step_number === params[2]).map((x) => ({ ...x }))];
    }
    if (/^UPDATE sequence_enrollments SET current_step = \?/.test(s)) return [{ affectedRows: 1 }];
    if (/^UPDATE sequence_enrollments SET status = 'cancelled', cancel_reason = \?/.test(s)) {
      if (cancelThrows) throw Object.assign(new Error('Lock wait timeout exceeded'), { code: 'ER_LOCK_WAIT_TIMEOUT' });
      if (cancelledElsewhere) state.enrollments.forEach((x) => { x.status = 'cancelled'; x.cancel_reason = 'manual'; });
      // Honour the statement's own predicate: guarded on 'active' or not.
      const guarded = /WHERE id = \? AND status = 'active'$/.test(s);
      const e = state.enrollments.find((x) => x.id === params[1] && (!guarded || x.status === 'active'));
      if (e) { e.status = 'cancelled'; e.cancel_reason = params[0]; }
      return [{ affectedRows: e ? 1 : 0 }];
    }
    if (/^SELECT id FROM scheduled_jobs WHERE idempotency_key = \?/.test(s)) return [[]];
    if (/^INSERT INTO scheduled_jobs/.test(s)) { state.jobs.push(params); return [{ insertId: 7000 + state.jobs.length, affectedRows: 1 }]; }
    if (/^INSERT INTO system_alerts/.test(s)) { state.alerts.push(params); return [{ insertId: 1, affectedRows: 1 }]; }
    if (/^INSERT INTO alert_state/.test(s)) return [{ affectedRows: 1 }];
    throw new Error(`unscripted ${session} query: ${s}`);
  };
  const db = {
    query: run('pool'),
    async getConnection() {
      const n = ++state.conns;
      return {
        query: run(`conn#${n}`),
        release: () => { state.released++; },
        destroy: () => { state.destroyed++; },
      };
    },
  };
  return { db, log, state };
}

const sessions = (log, re) => log.filter(([, s]) => re.test(s)).map(([session]) => session);

beforeAll(() => { for (const m of ['log', 'error', 'warn']) jest.spyOn(console, m).mockImplementation(() => {}); });
afterAll(() => jest.restoreAllMocks());

describe('the duplicate fence runs on ONE pinned session', () => {
  test('GET_LOCK → duplicate check → INSERT → RELEASE_LOCK on the same connection, in order; it goes back to the pool', async () => {
    const { db, log, state } = makePool();
    const out = await seq.enrollContactByTemplateId(db, 1983, 42, { appt_id: 77, signing_request_id: 5 });
    expect(out).toMatchObject({ enrollmentId: 600, totalSteps: 1 });

    const fence = log.filter(([, s]) => /GET_LOCK|RELEASE_LOCK|FROM sequence_enrollments WHERE contact_id|INSERT INTO sequence_enrollments/.test(s));
    expect(fence.map(([session, s]) => [session, s.slice(0, 32)])).toEqual([
      ['conn#1', 'SELECT GET_LOCK(?, ?) AS got'],
      ['conn#1', 'SELECT id FROM sequence_enrollme'],
      ['conn#1', 'INSERT INTO sequence_enrollments'],
      ['conn#1', 'SELECT RELEASE_LOCK(?)'],
    ]);
    // Deterministic, identity-scoped name; bounded wait.
    expect(fence[0][2]).toEqual(['seq_enroll_42_1983_77_5', 5]);
    expect(fence[3][2]).toEqual(['seq_enroll_42_1983_77_5']);
    // The duplicate check and the lock agree on the identity.
    expect(fence[1][2]).toEqual([1983, 42, 77, 5]);
    expect([state.conns, state.released, state.destroyed]).toEqual([1, 1, 0]);
    // Scheduling stays on the pool, after the lock is gone.
    expect(sessions(log, /^INSERT INTO scheduled_jobs/)).toEqual(['pool']);
  });

  test('a contact-scoped enrollment locks on 0 for the absent appt / signing request', async () => {
    const { db, log } = makePool();
    await seq.enrollContactByTemplateId(db, 1983, 42, {});
    const [, , params] = log.find(([, s]) => /GET_LOCK/.test(s));
    expect(params).toEqual(['seq_enroll_42_1983_0_0', 5]);
  });

  test.each([[0, 'timed out'], [null, 'NULL (error)']])('a lock that is not granted (%s, %s) is ENROLL_BUSY — no check, no INSERT, nothing released', async (got) => {
    const { db, log, state } = makePool({ lockGot: got });
    const err = await seq.enrollContactByTemplateId(db, 1983, 42, {}).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('ENROLL_BUSY');
    expect(err.message).toMatch(/nothing was enrolled/);
    expect(state.enrollments).toEqual([]);
    expect(sessions(log, /FROM sequence_enrollments WHERE contact_id/)).toEqual([]);
    expect(sessions(log, /RELEASE_LOCK/)).toEqual([]);
    expect([state.released, state.destroyed]).toEqual([1, 0]);
  });

  test('a duplicate is ALREADY_ENROLLED and the lock is still released', async () => {
    const { db, log, state } = makePool({ existing: [{ id: 188 }] });
    const err = await seq.enrollContactByTemplateId(db, 1983, 42, {}).catch((e) => e);
    expect([err.code, err.enrollment_id]).toEqual(['ALREADY_ENROLLED', 188]);
    expect(state.enrollments).toEqual([]);
    expect(sessions(log, /RELEASE_LOCK/)).toEqual(['conn#1']);
    expect(state.released).toBe(1);
  });

  test('a connection whose RELEASE_LOCK failed is destroyed, never returned to the pool', async () => {
    const { db, state } = makePool({ releaseThrows: true });
    const out = await seq.enrollContactByTemplateId(db, 1983, 42, {});
    expect(out.enrollmentId).toBe(600);
    expect([state.released, state.destroyed]).toEqual([0, 1]);
  });

  test('a single connection handed in (no getConnection) is locked on directly', async () => {
    const { db, log } = makePool();
    const single = { query: db.query };
    await seq.enrollContactByTemplateId(single, 1983, 42, {});
    expect(sessions(log, /GET_LOCK|FROM sequence_enrollments WHERE contact_id|INSERT INTO sequence_enrollments|RELEASE_LOCK/))
      .toEqual(['pool', 'pool', 'pool', 'pool']);
  });
});

describe('a first step that cannot be scheduled no longer wedges the enrollment', () => {
  test('the row is cancelled with a bounded reason, an error alert is recorded, and SCHEDULING_FAILED carries the id', async () => {
    const { db, state } = makePool({ steps: [BROKEN_STEP] });
    const err = await seq.enrollContactByTemplateId(db, 1983, 42, { case_id: 'ABC' }).catch((e) => e);
    expect(err.code).toBe('SCHEDULING_FAILED');
    expect(err.enrollment_id).toBe(600);
    expect(err.cancelled).toBe(true);
    expect(err.message).toMatch(/was cancelled/);
    expect(err.cause.message).toMatch(/delay\.at resolved to empty/);
    expect(state.enrollments).toEqual([expect.objectContaining({ id: 600, status: 'cancelled' })]);
    const reason = state.enrollments[0].cancel_reason;
    expect(reason.startsWith('scheduling failed: delay.at resolved to empty')).toBe(true);
    expect([...reason].length).toBeLessThanOrEqual(200);
    expect(state.jobs).toEqual([]);
    expect(state.alerts).toHaveLength(1);
    const [source, kind, groupKey, severity] = state.alerts[0];
    expect([source, kind, groupKey, severity]).toEqual(['sequence', 'enrollment_schedule_failed', 'seq_enroll_sched:42', 'error']);
  });

  test('cancel_reason is cut to the varchar(200) column by characters, never past it', async () => {
    // The thrown message quotes the original placeholder, so a long one makes
    // a long cause. (Relaxed sql_mode would truncate silently on the server —
    // the bound is ours, not MySQL's.)
    const long = { ...BROKEN_STEP, timing: JSON.stringify({ type: 'delay', at: `{{trigger_data.${'x'.repeat(300)}}}` }) };
    const { db, state } = makePool({ steps: [long] });
    const err = await seq.enrollContactByTemplateId(db, 1983, 42, {}).catch((e) => e);
    expect(err.code).toBe('SCHEDULING_FAILED');
    expect(err.message.length).toBeGreaterThan(300);
    const reason = state.enrollments[0].cancel_reason;
    expect([...reason]).toHaveLength(200);
    expect(reason.startsWith('scheduling failed: delay.at resolved to empty')).toBe(true);
  });

  test('a row cancelled elsewhere in the meantime keeps ITS status and reason; no alert', async () => {
    const { db, state } = makePool({ steps: [BROKEN_STEP], cancelledElsewhere: true });
    const err = await seq.enrollContactByTemplateId(db, 1983, 42, {}).catch((e) => e);
    expect([err.code, err.enrollment_id, err.cancelled]).toEqual(['SCHEDULING_FAILED', 600, false]);
    expect(err.message).toMatch(/no longer active/);
    expect(state.enrollments[0]).toMatchObject({ status: 'cancelled', cancel_reason: 'manual' });
    expect(state.alerts).toEqual([]);
  });

  test('a cancel write that fails still throws SCHEDULING_FAILED, saying the row is still active', async () => {
    const { db, state } = makePool({ steps: [BROKEN_STEP], cancelThrows: true });
    const err = await seq.enrollContactByTemplateId(db, 1983, 42, {}).catch((e) => e);
    expect(err.code).toBe('SCHEDULING_FAILED');
    expect(err.enrollment_id).toBe(600);
    expect(err.cancelled).toBe(false);
    expect(err.message).toMatch(/could not be cancelled/);
    expect(state.enrollments[0].status).toBe('active');
  });
});

describe('the funnel refusals carry machine codes', () => {
  test('never published → NEVER_PUBLISHED; no steps → EMPTY_SEQUENCE; neither takes the lock', async () => {
    const v0 = makePool({ template: { ...TEMPLATE, current_version: 0 } });
    const a = await seq.enrollContactByTemplateId(v0.db, 1983, 42, {}).catch((e) => e);
    expect(a.code).toBe('NEVER_PUBLISHED');
    expect(a.message).toMatch(/has never been published/);
    const empty = makePool({ steps: [] });
    const b = await seq.enrollContactByTemplateId(empty.db, 1983, 42, {}).catch((e) => e);
    expect(b.code).toBe('EMPTY_SEQUENCE');
    expect(b.message).toMatch(/has no steps/);
    expect(sessions([...v0.log, ...empty.log], /GET_LOCK/)).toEqual([]);
  });
});
