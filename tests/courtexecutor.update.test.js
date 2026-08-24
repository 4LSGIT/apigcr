/**
 * tests/courtexecutor.update.test.js
 *
 * update_event dispatch — the type-drift dupe fix (events 32/111 postmortem)
 * and the compare-first noop (logs 417–419 GCal churn).
 *
 *   npx jest tests/courtexecutor.update.test.js
 *
 * Contract under test (courtExecutor update_event dispatch):
 *   TYPE DRIFT    — candidate matching happens in JS with _normType, not
 *                   `event_type<=>?` in SQL. A wf24-created row typed
 *                   'confirmation_hearing' MUST match an action typed
 *                   'Confirmation Hearing' (underscore vs space — unequal
 *                   under any collation, which is exactly how event 32 was
 *                   missed and event 111 silently created). One match →
 *                   update in place, NO create.
 *   TITLE ARM     — full type drift (unrelated type strings) still folds in
 *                   when the STRICT title matcher says same hearing, mirroring
 *                   cancel_event's sameTitle arm.
 *   NOOP          — a re-notice / duplicate email copy whose date+time+
 *                   all_day+location already equal the row is a quiet
 *                   'update_already_done' skip: NO updateEvent call (GCal
 *                   delete-recreate churn), NO change row, NO applied entry,
 *                   outcome 'none' when nothing else applied.
 *   ZERO MATCH    — nothing matches on any arm → clean create, no flag
 *                   (behavior preserved from the prior slice).
 *   AMBIGUOUS     — type matches exist but no unique title match → create +
 *                   'event_title_mismatch' review (behavior preserved).
 *   SHOW CAUSE    — a rescheduled OSC moves cases.show_cause even on the
 *                   noop path (column convergence, compare-first inside).
 *
 * eventService.updateEvent / createEvent are stubbed; findDuplicateEvent is
 * stubbed to null (create-path dedupe is covered by eventDedup.phaseB tests).
 */

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

const CASE_ROW = {
  found: true,
  case_id: 'TrezJ001',
  case_number: '26-44937',
  case_number_full: '26-44937-mar',
  case_caption: null,
  primary_contact_id: 333,
  primary_contact_name: 'Trezette M. Johnson',
};
const courtResolve = require('../lib/courtResolve');
courtResolve.resolveCase = async () => ({ ...CASE_ROW });
const courtCitation = require('../lib/courtCitation');
courtCitation.checkCitations = () => ({ pass: true, misses: [] });

const eventService = require('../services/eventService');
const { executeCourtActions } = require('../services/courtExecutor');

// ─────────────────────────────────────────────────────────────
// db stub. The update_event candidates SELECT is recognized by its select
// list (`event_id, event_type, event_date` — the cancel candidates SELECT
// starts `event_id, event_type, event_title` and also selects event_status /
// event_calendar_id, which this one never does).
// ─────────────────────────────────────────────────────────────
function makeDb({ events = [], showCause = null } = {}) {
  const updates = [];
  const query = jest.fn(async (sql, params = []) => {
    if (/SELECT event_id, event_type, event_date/i.test(sql) &&
        /event_link_type='case_number' AND event_link_id=\?/i.test(sql)) {
      // update_event candidates: link + Scheduled + future are SQL-side; the
      // stub applies link + status and leaves the date floor to the fixtures
      // (all fixture dates are future).
      return [events
        .filter(e => e.event_link_id === params[0] && e.event_status === 'Scheduled')
        .map(e => ({ ...e }))];
    }
    if (/FROM cases WHERE case_id=\? LIMIT 1/i.test(sql)) {
      return [[{
        case_file_date: null, case_judge: '', case_close_date: null,
        case_discharge_date: null, case_chapter: '13', case_trustee: '',
        case_objection: null, show_cause: showCause,
      }]];
    }
    if (/SELECT `value` FROM app_settings/i.test(sql)) return [[]];
    if (/^\s*UPDATE\b/i.test(sql)) { updates.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return [{ affectedRows: 1 }]; }
    if (/^\s*INSERT\b/i.test(sql)) return [{ insertId: 88, affectedRows: 1 }];
    return [[]];
  });
  return { query, updates };
}

function updatePayload(fields, { messageId = 'court-update-run' } = {}) {
  return {
    payload: {
      message_id: messageId,
      case_number: '26-44937-mar',
      case_name: 'Trezette M. Johnson',
      classification: 'hearing_adjourned',
      needs_review: false,
      actions: [{ type: 'update_event', fields }],
    },
    subject: 'irrelevant (citations stubbed)',
    body: 'irrelevant (citations stubbed)',
  };
}

// The live events 32/111 pair, verbatim shapes. Dates pushed far future so
// the fixture never ages out.
const WF24_EVENT = {
  event_id: 32, event_link_type: 'case_number', event_link_id: '26-44937',
  event_type: 'confirmation_hearing',                       // wf24 snake_case
  event_title: 'Confirmation Hearing — Trezette M. Johnson (26-44937)',
  event_date: '2126-07-15', event_time: '09:00:00', event_all_day: 0,
  event_location: null, event_status: 'Scheduled',
};
const ADJOURN_FIELDS = {
  event_type: 'Confirmation Hearing',                        // model Title Case
  event_title: 'Confirmation Hearing – Trezette M. Johnson', // en-dash, no docket
  date: '2126-10-14', time: '14:00',
  location: 'Courtroom 1825, 211 W. Fort St.',
};

const realUpdateEvent = eventService.updateEvent;
const realCreateEvent = eventService.createEvent;
const realFindDupe = eventService.findDuplicateEvent;
beforeEach(() => {
  eventService.updateEvent = jest.fn(async () => ({ event: {} }));
  eventService.createEvent = jest.fn(async () => ({ event_id: 999 }));
  eventService.findDuplicateEvent = jest.fn(async () => null);
});
afterAll(() => {
  eventService.updateEvent = realUpdateEvent;
  eventService.createEvent = realCreateEvent;
  eventService.findDuplicateEvent = realFindDupe;
});

describe('update_event — type drift (events 32/111 regression)', () => {
  test('wf24 snake_case row matches model Title Case action → update in place, NO create', async () => {
    const db = makeDb({ events: [WF24_EVENT] });
    const res = await executeCourtActions(db, { ...updatePayload(ADJOURN_FIELDS), dryRun: false });

    expect(res.outcome).toBe('executed');
    expect(eventService.updateEvent).toHaveBeenCalledTimes(1);
    const [, targetId, patch] = eventService.updateEvent.mock.calls[0];
    expect(targetId).toBe(32);
    expect(patch).toEqual({
      event_date: '2126-10-14', event_time: '14:00',
      event_all_day: 0, event_location: 'Courtroom 1825, 211 W. Fort St.',
    });
    // The old bug's signature was a silent create — assert it cannot recur.
    expect(eventService.createEvent).not.toHaveBeenCalled();
    expect(res.review_reason).toBeFalsy();

    const up = res.applied.find(a => a.type === 'update_event');
    expect(up.entity_id).toBe('32');
    expect(up.summary).toMatch(/^reschedule /);
  });

  test('title arm: unrelated type strings still fold in on a strict title match', async () => {
    const generic = { ...WF24_EVENT, event_type: 'Hearing' };
    const db = makeDb({ events: [generic] });
    const res = await executeCourtActions(db, { ...updatePayload(ADJOURN_FIELDS), dryRun: false });
    expect(eventService.updateEvent).toHaveBeenCalledTimes(1);
    expect(eventService.updateEvent.mock.calls[0][1]).toBe(32);
    expect(eventService.createEvent).not.toHaveBeenCalled();
    expect(res.outcome).toBe('executed');
  });

  test('genuinely different hearing type on the case → clean create, no flag (zero-match path preserved)', async () => {
    const other = {
      ...WF24_EVENT, event_id: 40, event_type: 'dischargeability_due',
      event_title: 'Dischargeability Deadline — Trezette M. Johnson (26-44937)',
      event_all_day: 1, event_time: null,
    };
    const db = makeDb({ events: [other] });
    const res = await executeCourtActions(db, { ...updatePayload(ADJOURN_FIELDS), dryRun: false });
    expect(eventService.updateEvent).not.toHaveBeenCalled();
    expect(eventService.createEvent).toHaveBeenCalledTimes(1);
    expect(res.review_reason).toBeFalsy();
    expect(res.outcome).toBe('executed');
  });

  test('ambiguous: two drift-matched hearings, neither title unique → create + event_title_mismatch review', async () => {
    const a = { ...WF24_EVENT, event_id: 51, event_title: 'Confirmation Hearing — first plan' };
    const b = { ...WF24_EVENT, event_id: 52, event_title: 'Confirmation Hearing — amended plan' };
    const db = makeDb({ events: [a, b] });
    const res = await executeCourtActions(db, { ...updatePayload(ADJOURN_FIELDS), dryRun: false });
    expect(eventService.updateEvent).not.toHaveBeenCalled();
    expect(eventService.createEvent).toHaveBeenCalledTimes(1);
    expect(res.outcome).toBe('queued');
    expect(res.review_reason).toMatch(/event_title_mismatch/);
  });
});

describe('update_event — compare-first noop (logs 417–419 regression)', () => {
  const CONVERGED = {
    ...WF24_EVENT,
    event_id: 111, event_type: 'Confirmation Hearing',
    event_title: 'Confirmation Hearing – Trezette M. Johnson',
    event_date: '2126-10-14', event_time: '14:00:00', event_all_day: 0,
    event_location: 'Courtroom 1825, 211 W. Fort St.',
  };

  test('row already at target date/time/location → quiet skip, no updateEvent, no change row, outcome none', async () => {
    const db = makeDb({ events: [CONVERGED] });
    const res = await executeCourtActions(db, { ...updatePayload(ADJOURN_FIELDS), dryRun: false });

    expect(eventService.updateEvent).not.toHaveBeenCalled();
    const sk = res.skipped.find(s => s.type === 'update_event');
    expect(sk.reason).toBe('update_already_done');
    expect(sk.event_id).toBe(111);
    expect(res.applied.find(a => a.type === 'update_event')).toBeUndefined();
    expect(res.review_reason).toBeFalsy();
    expect(res.outcome).toBe('none');
    // No event change row flushed (the INSERT INTO ai_change_log for events).
    const changeInserts = db.query.mock.calls.filter(
      ([sql, p]) => /INSERT INTO ai_change_log/i.test(sql) && p && p[3] === 'event'
    );
    expect(changeInserts).toHaveLength(0);
  });

  test('same slot but location changed → real update (courtroom move is not a noop)', async () => {
    const moved = { ...CONVERGED, event_location: 'Courtroom 1975' };
    const db = makeDb({ events: [moved] });
    const res = await executeCourtActions(db, { ...updatePayload(ADJOURN_FIELDS), dryRun: false });
    expect(eventService.updateEvent).toHaveBeenCalledTimes(1);
    expect(eventService.updateEvent.mock.calls[0][2].event_location)
      .toBe('Courtroom 1825, 211 W. Fort St.');
    expect(res.outcome).toBe('executed');
  });

  test('noop on a show-cause reschedule still converges cases.show_cause', async () => {
    const osc = {
      ...CONVERGED, event_id: 119, event_type: 'Show Cause Hearing',
      event_title: 'Order to Show Cause on Dismissal of Case for Failure to Pay Filing Fee',
    };
    const fields = {
      event_type: 'Show Cause', // model self-drift (live 119/120)
      event_title: 'Order to Show Cause on Dismissal of Case for Failure to Pay Filing Fee',
      date: '2126-10-14', time: '14:00', location: 'Courtroom 1825, 211 W. Fort St.',
    };
    const db = makeDb({ events: [osc], showCause: null }); // column stale-empty
    const res = await executeCourtActions(db, { ...updatePayload(fields), dryRun: false });

    // Event untouched (converged) …
    expect(eventService.updateEvent).not.toHaveBeenCalled();
    expect(res.skipped.find(s => s.type === 'update_event').reason).toBe('update_already_done');
    // … but the column converged, and THAT is an applied action.
    expect(db.updates.some(u => /UPDATE cases SET show_cause=\?/i.test(u.sql))).toBe(true);
    const sc = res.applied.find(a => a.entity_type === 'case' && a.field === 'show_cause');
    expect(sc.new_value).toBe('2126-10-14 14:00');
    expect(res.outcome).toBe('executed');
  });
});

describe('update_event — dry run', () => {
  test('dry run plans the reschedule without calling updateEvent', async () => {
    const db = makeDb({ events: [WF24_EVENT] });
    const res = await executeCourtActions(db, { ...updatePayload(ADJOURN_FIELDS), dryRun: true });
    expect(eventService.updateEvent).not.toHaveBeenCalled();
    const up = res.applied.find(a => a.type === 'update_event');
    expect(up.entity_id).toBe('32');
  });
});
