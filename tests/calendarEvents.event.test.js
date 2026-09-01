// tests/calendarEvents.event.test.js
//
/**
 * Unified Events U4 — the event side of `calendar.*` (v0.5 §3.5, amendment A5).
 *
 * eventService emitted NOTHING before this slice. Everything here is new
 * behaviour on a live service, so the tests are written around the places it
 * could go wrong rather than around the happy path:
 *
 *   DEDUPE      createEvent's `deduped:true` return writes no row, no log, no
 *               calendar entry and no reminder. It must also emit nothing —
 *               "the court re-docketed the same NEF" is not a scheduling
 *               event, and a rule that sent a client SMS on it would fire
 *               twice for one hearing.
 *
 *   THE MATRIX  updateEvent is the interesting one. `event_status` is in
 *               UPDATE_ALLOWED, so a status transition can arrive through
 *               PATCH — and can arrive in the SAME body as a date move. Each
 *               branch is decided independently, in catalog order, off a
 *               BEFORE/AFTER row comparison rather than an inspection of
 *               `fields` (PATCHing a status to the value it already holds is
 *               in changedKeys but is not a transition).
 *
 *   THE GATE    A move is only a reschedule if something is still scheduled.
 *               `{event_date, event_status:'Canceled'}` in one body emits
 *               calendar.cancelled ONLY — claiming the event also moved to a
 *               date it will never be held on is two contradictory statements
 *               about one write.
 *
 *   RESOLUTION  events.event_resolution has no writer until U6, so today every
 *               Completed row reports the §3.7 fallback: kind 'deadline' → met,
 *               anything else → held. A stored value overrides it, which is
 *               asserted here so U6 lands on a proven contract.
 *
 * Run:  npx jest tests/calendarEvents.event.test.js
 */

'use strict';

jest.mock('../services/gcalService', () => ({
  createEvent: jest.fn(async () => ({ id: 'gcal_1' })),
  deleteEvent: jest.fn(async () => ({})),
}));
jest.mock('../services/taskService', () => ({
  createTask: jest.fn(async () => ({ task_id: 1 })),
  cancelTask: jest.fn(async () => ({})),
}));
jest.mock('../services/logService', () => ({ createLogEntry: jest.fn(async () => ({ log_id: 1 })) }));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => ({})) }));
jest.mock('../lib/domainEvents', () => ({
  emit:         jest.fn(() => Promise.resolve()),
  buildChanges: jest.fn(() => ({})),
  runAsAction:  (_ruleId, fn) => fn(),
  MAX_DEPTH:    4,
}));

const eventService        = require('../services/eventService');
const calendarTypeService = require('../services/calendarTypeService');
const domainEvents        = require('../lib/domainEvents');
const SEED                = require('./fixtures/calendar_item_types.seed.json');

// ─────────────────────────────────────────────────────────────────────────────
function makeDb(seedEvents = [], { cases = [] } = {}) {
  const events = new Map(seedEvents.map((e) => [e.event_id, { event_status: 'Scheduled', ...e }]));
  const calls = [];
  const unmatched = [];
  let nextId = 500;

  const query = async (sql, params = []) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    calls.push({ sql: flat, params });

    if (/^INSERT INTO events/i.test(flat)) {
      const id = nextId++;
      events.set(id, {
        event_id: id,
        event_type: params[0], event_link_type: params[1], event_link_id: params[2],
        event_title: params[3], event_date: params[4], event_time: params[5],
        event_all_day: params[6], event_length: params[7], event_location: params[8],
        event_link: params[9], event_note: params[10], event_status: 'Scheduled',
        event_calendar_id: params[11], event_with: params[12], event_created_by: params[13],
        kind: params[14], type_key: params[15],
        event_gcal: null, event_resolution: null, superseded_by_event_id: null,
      });
      return [{ insertId: id, affectedRows: 1 }];
    }
    if (/joined_case_id/i.test(flat)) {                       // getEvent
      const row = events.get(Number(params[0]));
      if (!row) return [[]];
      // Mirror getEvent's correlated resolved_case_id subquery.
      const resolved = row.event_link_type === 'case_number'
        ? (cases.find((c) => c.case_number === row.event_link_id
                          || c.case_number_full === row.event_link_id) || null)
        : null;
      return [[{ ...row, resolved_case_id: resolved ? resolved.case_id : null,
                 link_type: row.event_link_type, link_id: row.event_link_id, link_label: null }]];
    }
    // NOTE the ordering: completeEvent/cancelEvent write a LITERAL status with
    // no backticked placeholder, so the generic column-writer below would match
    // the statement and then write nothing at all. Specific first.
    if (/^UPDATE events SET event_status = '(Completed|Canceled)'/i.test(flat)) {
      const row = events.get(Number(params[0]));
      if (row) row.event_status = /Completed/.test(flat) ? 'Completed' : 'Canceled';
      return [{ affectedRows: row ? 1 : 0 }];
    }
    if (/^UPDATE events SET .* WHERE event_id = \?$/i.test(flat)) {
      const id = Number(params[params.length - 1]);
      const row = events.get(id);
      if (!row) return [{ affectedRows: 0 }];
      const cols = [...flat.matchAll(/`(\w+)` = \?/g)].map((m) => m[1]);
      cols.forEach((c, i) => { row[c] = params[i]; });
      return [{ affectedRows: 1 }];
    }
    if (/FROM users WHERE user = \? AND does_appts = 1/i.test(flat)) {
      return [Number(params[0]) === 1 ? [{ user: 1 }] : []];
    }
    if (/FROM tasks/i.test(flat)) return [[]];
    if (/^UPDATE events SET event_gcal/i.test(flat)) return [{ affectedRows: 1 }];
    if (/FROM events/i.test(flat)) return [[]];               // findDuplicateEvent
    unmatched.push(flat);
    return [[]];
  };
  return { query, calls, events, unmatched };
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

const calendarEmits = () =>
  domainEvents.emit.mock.calls.filter((c) => String(c[1]).startsWith('calendar.'));
const calendarNames = () => calendarEmits().map((c) => c[1]);
const onlyEmit = (name) => {
  const hits = calendarEmits().filter((c) => c[1] === name);
  expect(hits).toHaveLength(1);
  return hits[0][2];
};

const BASE = {
  event_title: 'Test',
  event_date:  '2026-10-01',
  event_all_day: 1,
  event_link_type: 'case',
  event_link_id: 'ABCDEFGH',
  skip_gcal: true,
};

beforeAll(() => calendarTypeService._primeCache(SEED));
afterAll(() => calendarTypeService.invalidate());
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { console.log.mockRestore(); console.warn.mockRestore(); console.error.mockRestore(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('createEvent → calendar.scheduled', () => {
  test('one emit on insert, carrying the unified shape', async () => {
    const db = makeDb();
    const { event_id } = await eventService.createEvent(db, {
      ...BASE, event_type: 'Docs Deadline', acting_user_id: 7, source: 'court',
    });
    await flush();

    expect(calendarNames()).toEqual(['calendar.scheduled']);
    const env = onlyEmit('calendar.scheduled');
    expect(env.case_id).toBe('ABCDEFGH');
    expect(env.contact_id).toBeNull();
    expect(env.source).toBe('court');
    expect(env.actor).toEqual({ user_id: 7 });
    expect(env.data).toMatchObject({
      source:       'event',
      source_id:    event_id,
      type_key:     'docs_deadline',
      kind:         'deadline',
      label:        'Docs Deadline',
      event_type:   'Docs Deadline',
      starts_at:    '2026-10-01',      // all-day → bare date
      all_day:      true,
      length_min:   null,
      with_user_id: null,
      status:       'Scheduled',
      state:        'live',
      resolution:   null,
      link_type:    'case',
      link_id:      'ABCDEFGH',
      docket:       null,
      rescheduled_from_appt_id: null,
      superseded_by_event_id:   null,
    });
    expect(env.extra).toEqual({ deduped: false, created_by_source: 'court' });
  });

  test('a timed event carries HH:mm, minutes only', async () => {
    const db = makeDb();
    await eventService.createEvent(db, {
      ...BASE, event_type: 'Show Cause', event_all_day: 0, event_time: '14:30', event_length: 30, event_with: 1,
    });
    await flush();
    const d = onlyEmit('calendar.scheduled').data;
    expect(d.starts_at).toBe('2026-10-01 14:30');
    expect(d.all_day).toBe(false);
    expect(d.length_min).toBe(30);
    expect(d.with_user_id).toBe(1);
  });

  test('ZERO emits on a dedupe hit — no row was written, nothing was scheduled', async () => {
    const db = makeDb([{
      event_id: 42, event_type: 'Docs Deadline', kind: 'deadline', type_key: 'docs_deadline',
      event_link_type: 'case', event_link_id: 'ABCDEFGH', event_title: 'Test',
      event_date: '2026-10-01', event_time: null, event_all_day: 1,
    }]);
    // findDuplicateEvent reads through db.query; route its lookup to the seed.
    const orig = db.query;
    db.query = async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      if (/FROM events/i.test(flat) && !/joined_case_id/i.test(flat) && !/^INSERT|^UPDATE/i.test(flat)) {
        return [[{ ...db.events.get(42), _dedupe_rule: 'exact' }]];
      }
      return orig(sql, params);
    };
    const r = await eventService.createEvent(db, { ...BASE, event_type: 'Docs Deadline', dedupe: true });
    await flush();
    expect(r.deduped).toBe(true);
    expect(calendarNames()).toEqual([]);
  });

  test("a docket-linked event promotes the case the docket resolves to right now", async () => {
    const db = makeDb([], { cases: [{ case_id: 'REALCASE', case_number: '26-48953', case_number_full: '26-48953-abc' }] });
    await eventService.createEvent(db, {
      ...BASE, event_link_type: 'case_number', event_link_id: '26-48953', event_type: 'Confirmation Hearing',
    });
    await flush();
    const env = onlyEmit('calendar.scheduled');
    expect(env.case_id).toBe('REALCASE');
    expect(env.data.link_type).toBe('case_number');
    expect(env.data.docket).toBe('26-48953');
  });

  test('an UNRESOLVED docket promotes case_id null and still carries the docket', async () => {
    const db = makeDb([], { cases: [] });
    await eventService.createEvent(db, {
      ...BASE, event_link_type: 'case_number', event_link_id: '99-00000', event_type: 'Confirmation Hearing',
    });
    await flush();
    const env = onlyEmit('calendar.scheduled');
    expect(env.case_id).toBeNull();
    expect(env.data.docket).toBe('99-00000');
  });

  test('a contact-linked event promotes contact_id (Fred, U4)', async () => {
    const db = makeDb();
    await eventService.createEvent(db, {
      ...BASE, event_link_type: 'contact', event_link_id: '77', event_type: 'Docs Deadline',
    });
    await flush();
    const env = onlyEmit('calendar.scheduled');
    expect(env.contact_id).toBe(77);
    expect(env.case_id).toBeNull();
    expect(env.data.link_type).toBe('contact');
  });

  test('an unlinked (firm-wide) event promotes neither id', async () => {
    const db = makeDb();
    await eventService.createEvent(db, {
      event_title: 'Office closed', event_date: '2026-12-25', event_all_day: 1,
      event_type: 'Docs Deadline', skip_gcal: true,
    });
    await flush();
    const env = onlyEmit('calendar.scheduled');
    expect([env.case_id, env.contact_id]).toEqual([null, null]);
    expect([env.data.link_type, env.data.link_id, env.data.docket]).toEqual([null, null, null]);
  });

  test('no caller source → envelope source and created_by_source are both null', async () => {
    const db = makeDb();
    await eventService.createEvent(db, { ...BASE, event_type: 'Docs Deadline' });
    await flush();
    const env = onlyEmit('calendar.scheduled');
    expect(env.source).toBeNull();
    expect(env.extra.created_by_source).toBeNull();
    expect(db.unmatched).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('updateEvent — the transition matrix', () => {
  const seed = (o = {}) => [{
    event_id: 42, event_type: 'Docs Deadline', kind: 'deadline', type_key: 'docs_deadline',
    event_link_type: 'case', event_link_id: 'ABCDEFGH', event_title: 'T', event_date: '2026-10-01',
    event_time: null, event_all_day: 1, event_length: null, event_with: null, event_gcal: null,
    event_calendar_id: null, event_status: 'Scheduled', event_resolution: null,
    superseded_by_event_id: null, ...o,
  }];

  test('date-only change → calendar.rescheduled, with the prior start in extra', async () => {
    const db = makeDb(seed());
    await eventService.updateEvent(db, 42, { event_date: '2026-11-15' }, 3, { source: 'staff' });
    await flush();
    expect(calendarNames()).toEqual(['calendar.rescheduled']);
    const env = onlyEmit('calendar.rescheduled');
    expect(env.source).toBe('staff');
    expect(env.actor).toEqual({ user_id: 3 });
    expect(env.data.starts_at).toBe('2026-11-15');       // the row AFTER the update
    expect(env.data.state).toBe('live');
    expect(env.extra).toEqual({ via: 'update', prior_starts_at: '2026-10-01', prior_all_day: true });
  });

  test('an all_day → timed flip is a reschedule too', async () => {
    const db = makeDb(seed());
    await eventService.updateEvent(db, 42, { event_time: '09:15' }, 1);
    await flush();
    const env = onlyEmit('calendar.rescheduled');
    expect(env.data.all_day).toBe(false);
    expect(env.data.starts_at).toBe('2026-10-01 09:15');
    expect(env.extra.prior_all_day).toBe(true);
  });

  test('status → Canceled emits calendar.cancelled only', async () => {
    const db = makeDb(seed());
    await eventService.updateEvent(db, 42, { event_status: 'Canceled' }, 1);
    await flush();
    expect(calendarNames()).toEqual(['calendar.cancelled']);
    const env = onlyEmit('calendar.cancelled');
    expect(env.data).toMatchObject({ status: 'Canceled', state: 'cancelled', resolution: 'cancelled' });
    expect(env.extra).toEqual({ via: 'update', prior_status: 'Scheduled' });
  });

  test("status → Completed on a DEADLINE resolves 'met'", async () => {
    const db = makeDb(seed());
    await eventService.updateEvent(db, 42, { event_status: 'Completed' }, 1);
    await flush();
    expect(calendarNames()).toEqual(['calendar.resolved']);
    expect(onlyEmit('calendar.resolved').data)
      .toMatchObject({ status: 'Completed', state: 'resolved', resolution: 'met' });
  });

  test("status → Completed on a HEARING resolves 'held'", async () => {
    const db = makeDb(seed({ event_type: 'Confirmation Hearing', kind: 'hearing', type_key: 'confirmation_hearing' }));
    await eventService.updateEvent(db, 42, { event_status: 'Completed' }, 1);
    await flush();
    expect(onlyEmit('calendar.resolved').data.resolution).toBe('held');
  });

  test('a stored event_resolution overrides the fallback (the U6 contract)', async () => {
    const db = makeDb(seed({ event_resolution: 'missed' }));
    await eventService.updateEvent(db, 42, { event_status: 'Completed' }, 1);
    await flush();
    expect(onlyEmit('calendar.resolved').data.resolution).toBe('missed');
  });

  test("Canceled + event_resolution 'moot' reads moot, not cancelled", async () => {
    const db = makeDb(seed({ event_resolution: 'moot' }));
    await eventService.updateEvent(db, 42, { event_status: 'Canceled' }, 1);
    await flush();
    expect(onlyEmit('calendar.cancelled').data.resolution).toBe('moot');
  });

  test('Canceled → Scheduled is a reopen: calendar.scheduled with extra.reopened', async () => {
    const db = makeDb(seed({ event_status: 'Canceled' }));
    await eventService.updateEvent(db, 42, { event_status: 'Scheduled' }, 1);
    await flush();
    expect(calendarNames()).toEqual(['calendar.scheduled']);
    const env = onlyEmit('calendar.scheduled');
    expect(env.data.state).toBe('live');
    expect(env.extra).toEqual({ via: 'update', reopened: true, prior_status: 'Canceled' });
  });

  test('date + reopen in ONE patch emits both, in catalog order', async () => {
    const db = makeDb(seed({ event_status: 'Canceled' }));
    await eventService.updateEvent(db, 42, { event_date: '2026-11-15', event_status: 'Scheduled' }, 1);
    await flush();
    expect(calendarNames()).toEqual(['calendar.rescheduled', 'calendar.scheduled']);
  });

  test('date + cancel in ONE patch emits cancelled ONLY — a cancelled event did not move', async () => {
    const db = makeDb(seed());
    await eventService.updateEvent(db, 42, { event_date: '2026-11-15', event_status: 'Canceled' }, 1);
    await flush();
    expect(calendarNames()).toEqual(['calendar.cancelled']);
  });

  test('date + complete in ONE patch emits resolved ONLY', async () => {
    const db = makeDb(seed());
    await eventService.updateEvent(db, 42, { event_date: '2026-11-15', event_status: 'Completed' }, 1);
    await flush();
    expect(calendarNames()).toEqual(['calendar.resolved']);
  });

  test('a note-only patch emits nothing', async () => {
    const db = makeDb(seed());
    await eventService.updateEvent(db, 42, { event_note: 'n' }, 1);
    await flush();
    expect(calendarNames()).toEqual([]);
  });

  test('a title/type patch emits nothing — renaming is not a calendar transition', async () => {
    const db = makeDb(seed());
    await eventService.updateEvent(db, 42, { event_title: 'T2', event_type: 'Show Cause' }, 1);
    await flush();
    expect(calendarNames()).toEqual([]);
  });

  test('re-writing event_status with the value it already has is NOT a transition', async () => {
    const db = makeDb(seed());
    await eventService.updateEvent(db, 42, { event_status: 'Scheduled', event_note: 'n' }, 1);
    await flush();
    expect(calendarNames()).toEqual([]);
  });

  test('a reminder-only call touches no row and emits nothing', async () => {
    const db = makeDb(seed());
    await eventService.updateEvent(db, 42, {}, 1, { reminder: null });
    await flush();
    expect(calendarNames()).toEqual([]);
  });

  test('a superseded row never reports live, so a date move on one is not a reschedule', async () => {
    const db = makeDb(seed({ superseded_by_event_id: 99 }));
    await eventService.updateEvent(db, 42, { event_date: '2026-11-15' }, 1);
    await flush();
    expect(calendarNames()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('completeEvent / cancelEvent', () => {
  const seed = (o = {}) => [{
    event_id: 42, event_type: 'Confirmation Hearing', kind: 'hearing', type_key: 'confirmation_hearing',
    event_link_type: 'case', event_link_id: 'ABCDEFGH', event_title: 'T', event_date: '2026-10-01',
    event_time: '10:00:00', event_all_day: 0, event_length: 60, event_with: null, event_gcal: null,
    event_calendar_id: null, event_status: 'Scheduled', event_resolution: null,
    superseded_by_event_id: null, ...o,
  }];

  test('completeEvent → calendar.resolved via complete', async () => {
    const db = makeDb(seed());
    await eventService.completeEvent(db, 42, 5, { source: 'court' });
    await flush();
    expect(calendarNames()).toEqual(['calendar.resolved']);
    const env = onlyEmit('calendar.resolved');
    expect(env.source).toBe('court');
    expect(env.actor).toEqual({ user_id: 5 });
    expect(env.data).toMatchObject({
      source: 'event', source_id: 42, status: 'Completed',
      state: 'resolved', resolution: 'held', starts_at: '2026-10-01 10:00', length_min: 60,
    });
    expect(env.extra).toEqual({ via: 'complete', prior_status: 'Scheduled' });
  });

  test('cancelEvent → calendar.cancelled via cancel, reporting the gcal teardown', async () => {
    const db = makeDb(seed());
    await eventService.cancelEvent(db, 42, 5, { delete_gcal: false });
    await flush();
    expect(calendarNames()).toEqual(['calendar.cancelled']);
    const env = onlyEmit('calendar.cancelled');
    expect(env.data).toMatchObject({ status: 'Canceled', state: 'cancelled', resolution: 'cancelled' });
    expect(env.extra).toEqual({ via: 'cancel', prior_status: 'Scheduled', delete_gcal: false });
  });

  test('cancelEvent on a Completed row carries the real prior status', async () => {
    const db = makeDb(seed({ event_status: 'Completed' }));
    await eventService.cancelEvent(db, 42, 0);
    await flush();
    expect(onlyEmit('calendar.cancelled').extra)
      .toEqual({ via: 'cancel', prior_status: 'Completed', delete_gcal: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('_calendarEnvelope edge cases', () => {
  const env = (row) => eventService._calendarEnvelope(row);
  const row = (o = {}) => ({
    event_id: 1, event_type: 'Hearing', kind: 'hearing', type_key: 'hearing',
    event_date: '2026-05-05', event_time: null, event_all_day: 1, event_length: null,
    event_status: 'Scheduled', event_resolution: null, superseded_by_event_id: null,
    event_link_type: null, event_link_id: null, event_with: null, ...o,
  });

  test('event_with 0 (nobody) survives as 0; null (firm-wide) survives as null', () => {
    expect(env(row({ event_with: 0 })).data.with_user_id).toBe(0);
    expect(env(row({ event_with: null })).data.with_user_id).toBeNull();
  });

  test('supersession decides state outright, whatever the status column says', () => {
    const d = env(row({ event_status: 'Canceled', superseded_by_event_id: 99 })).data;
    expect(d.state).toBe('superseded');
    expect(d.resolution).toBeNull();
    expect(d.superseded_by_event_id).toBe(99);
  });

  test('an unmapped type reports type_key null with kind other (U2 ruling D7)', () => {
    const d = env(row({ event_type: 'Mediation', type_key: null, kind: 'other' })).data;
    expect([d.type_key, d.kind, d.label]).toEqual([null, 'other', 'Mediation']);
  });

  test('a non-numeric contact link is NOT promoted into the numeric contact_id column', () => {
    const e = env(row({ event_link_type: 'contact', event_link_id: 'not-an-id' }));
    expect(e.contact_id).toBeNull();
    expect(e.data.link_id).toBe('not-an-id');   // the raw value still ships
  });

  test('a fake-UTC Date event_date renders as the stored calendar day', () => {
    const d = env(row({ event_date: new Date('2026-05-05T00:00:00.000Z') })).data;
    expect(d.starts_at).toBe('2026-05-05');
  });
});
