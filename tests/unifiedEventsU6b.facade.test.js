// tests/unifiedEventsU6b.facade.test.js
//
/**
 * Unified Events U6b — calendarWriteService, the write facade.
 *
 *   ROUTING     the registry's kind decides the table: 'meeting' → apptService,
 *               everything else → eventService. Unknown type_key → 400.
 *   ARG MAPPING each verb's facade vocabulary lands on the right service
 *               params (both services fully mocked — the services' own
 *               behaviour is their own suites' problem).
 *   VOCAB       appt resolve is {'attended','no_show'} (§3.7's appt-status
 *               encoding, frozen HERE); appt cancel validates through
 *               eventService._validateResolution (the real one).
 *   findLive    both tables, through the two services' own identity helpers;
 *               a contact anchor matches events only (the deliberate U6b
 *               asymmetry).
 *
 * Run:  npx jest tests/unifiedEventsU6b.facade.test.js
 */

'use strict';

jest.mock('../services/apptService', () => ({
  createAppt:           jest.fn(async () => ({ appt_id: 901, appt: {}, superseded: [501] })),
  rescheduleAppt:       jest.fn(async () => ({ old_appt_id: 31, new_appt_id: 902 })),
  cancelAppt:           jest.fn(async () => ({})),
  markAttended:         jest.fn(async () => ({})),
  markNoShow:           jest.fn(async () => ({})),
  _singletonPriorAppts: jest.fn(async () => []),
}));
jest.mock('../services/eventService', () => {
  const real = jest.requireActual('../services/eventService');
  return {
    createEvent:         jest.fn(async () => ({ event_id: 7001, event: {}, deduped: false })),
    getEvent:            jest.fn(async () => null),
    supersedeEvent:      jest.fn(async () => ({})),
    cancelEvent:         jest.fn(async () => ({})),
    completeEvent:       jest.fn(async () => ({})),
    _singletonPriors:    jest.fn(async () => []),
    _validateResolution: real._validateResolution,        // the REAL §3.7 validator
  };
});

const facade              = require('../services/calendarWriteService');
const apptService         = require('../services/apptService');
const eventService        = require('../services/eventService');
const calendarTypeService = require('../services/calendarTypeService');
const SEED                = require('./fixtures/calendar_item_types.seed.json');

function scriptDb(routes = {}) {
  // routes: { docket: caseRow|null, caseId: caseRow|null }
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: flat, params });
      if (/FROM cases WHERE case_number = \?/.test(flat)) return [routes.docket ? [routes.docket] : []];
      if (/FROM cases WHERE case_id = \?/.test(flat))     return [routes.caseId ? [routes.caseId] : []];
      return [[]];
    },
  };
}

beforeAll(() => calendarTypeService._primeCache(SEED));
afterAll(() => calendarTypeService.invalidate());
beforeEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
describe('schedule — routing + mapping', () => {
  test("kind 'meeting' → apptService.createAppt with the registry LABEL and the anchor as A3a params", async () => {
    const db = scriptDb();
    const r = await facade.schedule(db, {
      type_key: 'meeting_341',
      anchor: { docket: '26-1000' },
      starts_at: '2026-09-10 14:00',
      length_min: 30,
      source_tag: 'court',
      actingUserId: 3,
    });
    expect(r).toEqual({ source: 'appt', id: 901, superseded: [501] });
    expect(apptService.createAppt).toHaveBeenCalledWith(db, expect.objectContaining({
      contact_id:    null,
      case_id:       '',
      docket:        '26-1000',
      appt_type:     '341 Meeting',              // the REGISTRY label, canonical
      type_key:      'meeting_341',
      appt_length:   30,
      appt_platform: 'telephone',                // the default
      appt_date:     '2026-09-10 14:00:00',
      appt_with:     1,
      source:        'court',
      actingUserId:  3,
    }));
    expect(eventService.createEvent).not.toHaveBeenCalled();
  });

  test('a meeting with a case anchor passes case_id and NO docket', async () => {
    const db = scriptDb();
    await facade.schedule(db, {
      type_key: 'consultation', anchor: { case_id: 'X1', contact_id: 77 },
      starts_at: '2026-09-10 14:00', length_min: 15, platform: 'Zoom',
    });
    expect(apptService.createAppt).toHaveBeenCalledWith(db, expect.objectContaining({
      contact_id: 77, case_id: 'X1', docket: null, appt_platform: 'Zoom',
    }));
  });

  test('a meeting without length_min is a 400; all_day on a meeting is a 400; both before any write', async () => {
    const db = scriptDb();
    await expect(facade.schedule(db, {
      type_key: 'meeting_341', anchor: { case_id: 'X1' }, starts_at: '2026-09-10 14:00',
    })).rejects.toMatchObject({ status: 400 });
    await expect(facade.schedule(db, {
      type_key: 'meeting_341', anchor: { case_id: 'X1' }, starts_at: '2026-09-10', all_day: true, length_min: 30,
    })).rejects.toMatchObject({ status: 400 });
    expect(apptService.createAppt).not.toHaveBeenCalled();
  });

  test("any other kind → eventService.createEvent; the anchor becomes the event link; superseded is [] BY DESIGN (createEvent doesn't report — U7)", async () => {
    const db = scriptDb();
    const r = await facade.schedule(db, {
      type_key: 'confirmation_hearing',
      anchor: { docket: '26-1000' },
      starts_at: '2026-10-05 10:00',
      length_min: 60,
      source_tag: 'court',
      actingUserId: 3,
    });
    expect(r).toEqual({ source: 'event', id: 7001, superseded: [] });
    expect(eventService.createEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      event_type:      'Confirmation Hearing',
      type_key:        'confirmation_hearing',
      event_link_type: 'case_number',
      event_link_id:   '26-1000',
      event_date:      '2026-10-05',
      event_time:      '10:00:00',
      event_all_day:   0,
      event_length:    60,
      acting_user_id:  3,
      source:          'court',
    }));
    expect(apptService.createAppt).not.toHaveBeenCalled();
  });

  test('an all-day deadline maps to a bare date; a dedupe hit is surfaced', async () => {
    eventService.createEvent.mockResolvedValueOnce({ event_id: 7002, event: {}, deduped: true });
    const db = scriptDb();
    const r = await facade.schedule(db, {
      type_key: 'docs_deadline', anchor: { case_id: 'X1' }, starts_at: '2026-10-05', all_day: true,
    });
    expect(r).toEqual({ source: 'event', id: 7002, superseded: [], deduped: true });
    expect(eventService.createEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      event_date: '2026-10-05', event_time: null, event_all_day: 1,
    }));
  });

  test('unknown type_key → 400; no anchor → 400; garbage starts_at → 400', async () => {
    const db = scriptDb();
    await expect(facade.schedule(db, { type_key: 'nope', anchor: { case_id: 'X' }, starts_at: '2026-01-01 10:00' }))
      .rejects.toMatchObject({ status: 400 });
    await expect(facade.schedule(db, { type_key: 'consultation', anchor: {}, starts_at: '2026-01-01 10:00' }))
      .rejects.toMatchObject({ status: 400 });
    await expect(facade.schedule(db, { type_key: 'consultation', anchor: { contact_id: 7 }, starts_at: 'soonish', length_min: 15 }))
      .rejects.toMatchObject({ status: 400 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('reschedule', () => {
  test('appt → rescheduleAppt; the facade reports successor + superseded predecessor', async () => {
    const db = scriptDb();
    const r = await facade.reschedule(db, {
      source: 'appt', id: 31, starts_at: '2026-09-20 09:00', source_tag: 'court', actingUserId: 3,
    });
    expect(r).toEqual({ source: 'appt', id: 902, superseded: [31] });
    expect(apptService.rescheduleAppt).toHaveBeenCalledWith(db, expect.objectContaining({
      appt_id: 31, newDate: '2026-09-20 09:00:00', source: 'court', actingUserId: 3,
    }));
  });

  test('event → getEvent(pred) → createEvent(successor, same fields, new start) → supersedeEvent', async () => {
    eventService.getEvent.mockResolvedValueOnce({
      event_id: 94, event_type: 'Confirmation Hearing', type_key: 'confirmation_hearing',
      event_link_type: 'case_number', event_link_id: '26-1000',
      event_title: 'Confirmation Hearing — Smith', event_date: '2026-10-05', event_time: '10:00:00',
      event_all_day: 0, event_length: 60, event_location: 'Rm 100', event_link: null,
      event_note: 'n', event_calendar_id: null, event_with: 2,
    });
    const db = scriptDb();
    const r = await facade.reschedule(db, {
      source: 'event', id: 94, starts_at: '2026-11-02 10:00', source_tag: 'court', actingUserId: 3,
    });
    expect(r).toEqual({ source: 'event', id: 7001, superseded: [94] });
    expect(eventService.createEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      event_title: 'Confirmation Hearing — Smith', event_link_type: 'case_number', event_link_id: '26-1000',
      event_date: '2026-11-02', event_time: '10:00:00', event_all_day: 0, event_length: 60,
      event_location: 'Rm 100', event_with: 2, source: 'court',
    }));
    expect(eventService.supersedeEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      predecessorId: 94, successorId: 7001, reason: 'rescheduled', actingUserId: 3, source: 'court',
    }));
  });

  test('unknown event → 404; bad source → 400', async () => {
    const db = scriptDb();
    await expect(facade.reschedule(db, { source: 'event', id: 5, starts_at: '2026-01-01 10:00' }))
      .rejects.toMatchObject({ status: 404 });
    await expect(facade.reschedule(db, { source: 'thing', id: 5, starts_at: '2026-01-01 10:00' }))
      .rejects.toMatchObject({ status: 400 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('cancel + resolve — vocab rides §3.7', () => {
  test("appt cancel: default and 'cancelled' pass (the real validator); 'moot' is a 400 on a meeting", async () => {
    const db = scriptDb();
    await facade.cancel(db, { source: 'appt', id: 31 });
    await facade.cancel(db, { source: 'appt', id: 31, resolution: 'cancelled' });
    expect(apptService.cancelAppt).toHaveBeenCalledTimes(2);
    expect(apptService.cancelAppt).toHaveBeenLastCalledWith(db, expect.objectContaining({
      appt_id: 31, cancel_gcal: true, source: 'internal',
    }));
    await expect(facade.cancel(db, { source: 'appt', id: 31, resolution: 'moot' }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('event cancel maps delete_gcal + resolution through to cancelEvent', async () => {
    const db = scriptDb();
    await facade.cancel(db, { source: 'event', id: 9, resolution: 'moot', delete_gcal: false, actingUserId: 3 });
    expect(eventService.cancelEvent).toHaveBeenCalledWith(db, 9, 3, expect.objectContaining({
      delete_gcal: false, resolution: 'moot', source: 'internal',
    }));
  });

  test("appt resolve: 'attended' → markAttended, 'no_show' → markNoShow, anything else (incl. 'held') → 400", async () => {
    const db = scriptDb();
    await facade.resolve(db, { source: 'appt', id: 31, resolution: 'attended', actingUserId: 3 });
    expect(apptService.markAttended).toHaveBeenCalledWith(db, expect.objectContaining({ appt_id: 31, actingUserId: 3 }));
    await facade.resolve(db, { source: 'appt', id: 31, resolution: 'no_show' });
    expect(apptService.markNoShow).toHaveBeenCalledTimes(1);
    for (const bad of ['held', 'met', 'cancelled', undefined]) {
      await expect(facade.resolve(db, { source: 'appt', id: 31, resolution: bad }))
        .rejects.toMatchObject({ status: 400 });
    }
  });

  test('event resolve delegates to completeEvent with the resolution verbatim', async () => {
    const db = scriptDb();
    const r = await facade.resolve(db, { source: 'event', id: 9, resolution: 'met', actingUserId: 3 });
    expect(r).toEqual({ source: 'event', id: 9, resolution: 'met' });
    expect(eventService.completeEvent).toHaveBeenCalledWith(db, 9, 3, expect.objectContaining({ resolution: 'met' }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('findLive — both tables, the services\' own identity semantics', () => {
  const CASE_ROW = { case_id: 'X1', case_number: '26-1000', case_number_full: '26-1000-mlo' };

  test('a case anchor: events via _singletonPriors (synthetic row, event_id 0), appts via _singletonPriorAppts with the dockets', async () => {
    eventService._singletonPriors.mockResolvedValueOnce([
      { event_id: 40, event_date: '2026-10-05', event_time: '10:00:00', event_all_day: 0, type_key: 'meeting_341' },
    ]);
    apptService._singletonPriorAppts.mockResolvedValueOnce([
      { appt_id: 501, appt_date: '2026-09-01 10:00:00' },
    ]);
    const db = scriptDb({ caseId: CASE_ROW });
    const out = await facade.findLive(db, { type_key: 'meeting_341', anchor: { case_id: 'X1' } });
    expect(out).toEqual([
      { source: 'event', id: 40,  starts_at: '2026-10-05 10:00' },
      { source: 'appt',  id: 501, starts_at: '2026-09-01 10:00' },
    ]);
    expect(eventService._singletonPriors).toHaveBeenCalledWith(db, {
      event_link_type: 'case', event_link_id: 'X1', type_key: 'meeting_341', event_id: 0,
    });
    expect(apptService._singletonPriorAppts).toHaveBeenCalledWith(db, {
      caseId: 'X1', dockets: ['26-1000', '26-1000-mlo'], typeKey: 'meeting_341',
    });
  });

  test('a docket anchor that resolves reaches the appt side through the resolved case', async () => {
    const db = scriptDb({ docket: CASE_ROW });
    await facade.findLive(db, { type_key: 'meeting_341', anchor: { docket: '26-1000' } });
    expect(apptService._singletonPriorAppts).toHaveBeenCalledWith(db, expect.objectContaining({ caseId: 'X1' }));
  });

  test('a CONTACT anchor matches events only — the appt side has no contact identity (deliberate asymmetry)', async () => {
    const db = scriptDb();
    const out = await facade.findLive(db, { type_key: 'meeting_341', anchor: { contact_id: 77 } });
    expect(out).toEqual([]);
    expect(eventService._singletonPriors).toHaveBeenCalledWith(db, expect.objectContaining({
      event_link_type: 'contact', event_link_id: '77',
    }));
    expect(apptService._singletonPriorAppts).not.toHaveBeenCalled();
  });

  test('an UNRESOLVED docket: events by raw identity, no appt query, empty is a real answer', async () => {
    const db = scriptDb({ docket: null });
    const out = await facade.findLive(db, { type_key: 'meeting_341', anchor: { docket: '26-9' } });
    expect(out).toEqual([]);
    expect(apptService._singletonPriorAppts).not.toHaveBeenCalled();
  });

  test('an all-day event reports a bare date', async () => {
    eventService._singletonPriors.mockResolvedValueOnce([
      { event_id: 41, event_date: '2026-10-05', event_time: null, event_all_day: 1, type_key: 'docs_deadline' },
    ]);
    const db = scriptDb({ caseId: CASE_ROW });
    const out = await facade.findLive(db, { type_key: 'docs_deadline', anchor: { case_id: 'X1' } });
    expect(out[0].starts_at).toBe('2026-10-05');
  });
});
