// tests/unifiedEventsU6c.rescheduledStatus.test.js
//
/**
 * UNIFIED EVENTS U6c — `events.event_status = 'Rescheduled'`
 *
 * U6a shipped supersession as a POINTER ONLY, on E0a's rule "supersession is
 * the pointer, never a status". That rule cost the tree a whole class of bug:
 * every liveness query already knew how to ask "is this Scheduled?" and had to
 * be taught a second, unfamiliar predicate instead — and courtExecutor's two
 * candidate queries never were.
 *
 * `appts` had solved this years earlier by carrying BOTH
 * (`appt_status='Rescheduled'` + `rescheduled_from_appt_id`). U6c brings
 * `events` into line.
 *
 * WHAT THIS SUITE PINS, and why each one is here rather than assumed:
 *
 *   1. supersedeEvent writes the status and the pointer in ONE statement, so
 *      they can never disagree — and does it ONLY for reason='rescheduled'.
 *   2. reason='duplicate' leaves the status alone. The 31 E0a cleanup
 *      artifacts are 'Canceled' because a script cancelled them; a dedupe
 *      reclassification is not a court moving a hearing, and 'Canceled' must
 *      keep meaning court-cancelled ONLY.
 *   3. updateEvent refuses both half-writes: setting 'Rescheduled' raw (status
 *      with no pointer), and flipping the status of a row that already carries
 *      a pointer (which would orphan it).
 *   4. The read layer treats EITHER half as dead, and a status-only tombstone
 *      reports `superseded_by_event_id: null` rather than 0.
 *   5. courtExecutor's reschedule candidate query still filters on status —
 *      the regression that motivated the whole slice.
 */

'use strict';

const { makeEventsDb } = require('./helpers/u6aEventsDb');

// Same mock set as the U6a suites — this file exercises the same write paths.
jest.mock('../services/gcalService', () => ({
  createEvent: jest.fn(async () => ({ id: 'gcal_new' })),
  updateEvent: jest.fn(async () => ({})),
  deleteEvent: jest.fn(async () => ({})),
}));
jest.mock('../services/taskService', () => ({
  createTask: jest.fn(async () => ({ task_id: 1 })),
  updateTask: jest.fn(async () => ({})),
  deleteTask: jest.fn(async () => ({})),
}));
jest.mock('../services/logService', () => ({ createLogEntry: jest.fn(async () => ({ log_id: 1 })) }));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => ({})) }));
jest.mock('../lib/domainEvents', () => ({
  emit:         jest.fn(() => Promise.resolve()),
  buildChanges: jest.fn(() => ({})),
  runAsAction:  (_ruleId, fn) => fn(),
  MAX_DEPTH:    4,
  EVENT_TYPES:  {},
}));
jest.mock('../lib/firmConfig', () => {
  const real = jest.requireActual('../lib/firmConfig');
  return { ...real, cfg: jest.fn(() => null) };   // singleton flag OFF throughout
});

const eventService     = require('../services/eventService');
const caseEventService = require('../services/caseEventService');

const flush = () => new Promise((r) => setImmediate(r));

const CASES = [{ case_id: 'ayx7GJ7j', case_number: '26-47542', case_number_full: '26-47542-mlo' }];

function dbWith(events) {
  return makeEventsDb({ events, cases: CASES });
}

beforeEach(() => jest.clearAllMocks());


// ─────────────────────────────────────────────────────────────────────────────
describe('U6c — supersedeEvent writes status AND pointer together', () => {

  test("reason='rescheduled' sets event_status='Rescheduled' in the same UPDATE", async () => {
    const db = dbWith([
      { event_id: 94,  event_link_type: 'case', event_link_id: 'ayx7GJ7j',
        type_key: 'confirmation_hearing', kind: 'hearing', event_date: '2026-10-05' },
      { event_id: 152, event_link_type: 'case', event_link_id: 'ayx7GJ7j',
        type_key: 'confirmation_hearing', kind: 'hearing', event_date: '2026-11-02' },
    ]);

    await eventService.supersedeEvent(db, { predecessorId: 94, successorId: 152 });
    await flush();

    const pred = db.events.get(94);
    expect(pred.event_status).toBe('Rescheduled');
    expect(pred.superseded_by_event_id).toBe(152);
    expect(pred.supersede_reason).toBe('rescheduled');

    // ONE statement, not two. Two statements could half-apply: a crash between
    // them leaves either a pointer with a live-looking status (the phantom
    // twin) or a status with no successor (an unreadable chain).
    const writes = db.calls.filter((c) =>
      /^UPDATE events SET superseded_by_event_id/i.test(c.sql.replace(/\s+/g, ' ').trim()));
    expect(writes).toHaveLength(1);
    expect(writes[0].sql.replace(/\s+/g, ' ')).toContain("event_status = 'Rescheduled'");

    // §7.1 rule 9 — the pointer is a fact about the SUCCESSOR's creation, not
    // an edit of the predecessor, so its timestamp must not move.
    expect(pred.event_updated_at).toBe('T0');
  });

  test("reason='duplicate' does NOT touch the status", async () => {
    const db = dbWith([
      { event_id: 40, event_status: 'Canceled', event_link_type: 'case', event_link_id: 'ayx7GJ7j' },
      { event_id: 41, event_link_type: 'case', event_link_id: 'ayx7GJ7j' },
    ]);

    await eventService.supersedeEvent(db, {
      predecessorId: 40, successorId: 41, reason: 'duplicate',
    });
    await flush();

    const pred = db.events.get(40);
    expect(pred.event_status).toBe('Canceled');          // unchanged — the E0a shape
    expect(pred.supersede_reason).toBe('duplicate');
    expect(pred.superseded_by_event_id).toBe(41);

    const write = db.calls.find((c) =>
      /^UPDATE events SET superseded_by_event_id/i.test(c.sql.replace(/\s+/g, ' ').trim()));
    expect(write.sql).not.toContain('Rescheduled');
  });

  test('the guarded WHERE still makes a lost race a 409, not an overwrite', async () => {
    const db = dbWith([
      { event_id: 60, superseded_by_event_id: 61, supersede_reason: 'rescheduled',
        event_status: 'Rescheduled' },
      { event_id: 61 },
      { event_id: 62 },
    ]);
    await expect(
      eventService.supersedeEvent(db, { predecessorId: 60, successorId: 62 })
    ).rejects.toMatchObject({ status: 409 });
    expect(db.events.get(60).superseded_by_event_id).toBe(61);   // untouched
  });
});


// ─────────────────────────────────────────────────────────────────────────────
describe('U6c — updateEvent refuses both half-writes', () => {

  test("PATCH event_status:'Rescheduled' is a 400 naming supersedeEvent", async () => {
    const db = dbWith([{ event_id: 70, event_link_type: 'case', event_link_id: 'ayx7GJ7j' }]);
    await expect(
      eventService.updateEvent(db, 70, { event_status: 'Rescheduled' })
    ).rejects.toMatchObject({ status: 400, message: /supersedeEvent/ });
    expect(db.events.get(70).event_status).toBe('Scheduled');
  });

  test('PATCHing the status of an already-superseded row is a 409', async () => {
    const db = dbWith([
      { event_id: 71, superseded_by_event_id: 72, supersede_reason: 'rescheduled',
        event_status: 'Rescheduled' },
      { event_id: 72 },
    ]);
    await expect(
      eventService.updateEvent(db, 71, { event_status: 'Scheduled' })
    ).rejects.toMatchObject({ status: 409, message: /superseded by 72/ });
    expect(db.events.get(71).event_status).toBe('Rescheduled');
  });

  test('a NON-status patch on a superseded row is still allowed', async () => {
    // The guard is about the STATUS, not about the row. Correcting a typo in
    // the title of a dead row must stay possible — history is still read.
    const db = dbWith([
      { event_id: 73, superseded_by_event_id: 74, supersede_reason: 'rescheduled',
        event_status: 'Rescheduled', event_title: 'Confirmaton Hearing' },
      { event_id: 74 },
    ]);
    await eventService.updateEvent(db, 73, { event_title: 'Confirmation Hearing' });
    await flush();
    expect(db.events.get(73).event_title).toBe('Confirmation Hearing');
    expect(db.events.get(73).event_status).toBe('Rescheduled');
  });

  test("re-sending the same 'Rescheduled' value is still refused, by the FIRST guard", async () => {
    // Documented, not incidental: the raw-'Rescheduled' guard fires before the
    // no-op check, so a form that round-trips every field on a superseded row
    // gets a 400. That is correct here — eventform.html renders no status
    // control at all once a row is not Scheduled (efRenderActions), so nothing
    // in the product sends this shape. If a caller ever needs the idempotent
    // form, the fix is to let the first guard pass on a no-op, not to weaken it.
    const db = dbWith([
      { event_id: 75, superseded_by_event_id: 76, supersede_reason: 'rescheduled',
        event_status: 'Rescheduled' },
      { event_id: 76 },
    ]);
    await expect(
      eventService.updateEvent(db, 75, { event_status: 'Rescheduled' })
    ).rejects.toMatchObject({ status: 400 });   // caught by the FIRST guard, not the second
  });
});


// ─────────────────────────────────────────────────────────────────────────────
describe('U6c — the read layer reads either half as dead', () => {

  const mapEvent = (row) => {
    const [out] = [row].map((r) =>
      caseEventService._deriveState('event', r, r.kind || null,
        r.superseded_by_event_id != null || String(r.event_status) === 'Rescheduled'));
    return out;
  };

  test("_deriveState: pointer set → superseded (unchanged from U6a)", () => {
    expect(mapEvent({ event_status: 'Scheduled', superseded_by_event_id: 9 }))
      .toEqual({ state: 'superseded', resolution: null });
  });

  test("_deriveState: status 'Rescheduled' with NO pointer → superseded", () => {
    // A hand-edit or a half-applied deploy. Believing the row costs at most one
    // hidden row; disbelieving it puts a tombstone back on the timeline.
    expect(caseEventService._deriveState('event', { event_status: 'Rescheduled' }, 'hearing', false))
      .toEqual({ state: 'superseded', resolution: null });
  });

  test("status_norm is null for 'Rescheduled', exactly as for an appt tombstone", () => {
    expect(caseEventService._normStatus('event', 'Rescheduled')).toBeNull();
    expect(caseEventService._normStatus('appt',  'Rescheduled')).toBeNull();
  });

  test('the listRange live predicate excludes it, twinned with the appt line', () => {
    // RANGE_*_STATE_SQL is module-private (it is SQL, not vocabulary), so this
    // reads the source. Both lines are asserted together on purpose: the whole
    // claim of U6c is that the two tables now say the same thing the same way,
    // and a future edit to one and not the other is exactly what this catches.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'services', 'caseEventService.js'), 'utf8');
    expect(src).toContain("live:      `e.event_status NOT IN ('Completed','Canceled','Rescheduled')`");
    expect(src).toContain("live:      `a.appt_status NOT IN ('Attended','No Show','Canceled','Rescheduled')`");
  });

  test('default per-case reads exclude a status-only tombstone', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'services', 'caseEventService.js'), 'utf8');
    expect(src).toContain("evFilters.push(`e.event_status <> 'Rescheduled'`)");
  });
});


// ─────────────────────────────────────────────────────────────────────────────
describe('U6c — the regression that motivated the slice', () => {

  test("courtExecutor's reschedule candidate query filters event_status='Scheduled'", () => {
    // THE POINT OF U6c. Under U6a's pointer-only design this query returned a
    // superseded predecessor as a live candidate the moment
    // unified_singleton_enabled was switched on, because a rescheduled row
    // stayed 'Scheduled'. With the status written, the filter that was already
    // here does the job. If someone removes it, this fails.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'services', 'courtExecutor.js'), 'utf8');
    const q = src.match(/SELECT event_id, event_type, event_date, event_time, event_all_day, event_location, event_title\s+FROM events\s+WHERE[\s\S]{0,200}?`/);
    expect(q).not.toBeNull();
    expect(q[0].replace(/\s+/g, ' ')).toContain("event_status='Scheduled'");
  });

  test("the cancel path narrows to Scheduled before choosing a target", () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'services', 'courtExecutor.js'), 'utf8');
    expect(src).toContain("matches.filter((m) => m.event_status === 'Scheduled')");
  });
});
