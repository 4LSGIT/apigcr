// tests/unifiedEventsU6a.supersede.test.js
//
/**
 * Unified Events U6a — the supersession writer and the singleton rule
 * (v0.5 §3.4, §3.4.2 amendment A4).
 *
 *   supersedeEvent  the first FORWARD writer of superseded_by_event_id. It
 *                   stamps a pointer + reason, self-assigns event_updated_at
 *                   (§7.1 rule 9), leaves event_status ALONE (E0a rule), tears
 *                   down the predecessor's GCal entry and reminder task(s),
 *                   logs 'superseded', and emits calendar.rescheduled with
 *                   the PREDECESSOR as data. Every precondition is a 409, and
 *                   a lost race (affectedRows 0) is a 409 too.
 *
 *   singleton       flag-guarded in createEvent. OFF → zero extra queries, no
 *                   pointer, byte-for-byte the pre-U6a create. ON → a new live
 *                   row for a singleton (anchor, type_key) supersedes every
 *                   prior live row with the same RESOLVED identity — so the
 *                   live cross-form pair shape (event 94 'case'/ayx7GJ7j vs
 *                   152 'case_number'/26-47542) collapses. Dedupe still wins
 *                   first; no link → no check; singleton=0 → no check; emit
 *                   order is scheduled (new) then rescheduled (old).
 *
 * Run:  npx jest tests/unifiedEventsU6a.supersede.test.js
 */

'use strict';

jest.mock('../services/gcalService', () => ({
  createEvent: jest.fn(async () => ({ id: 'gcal_new' })),
  deleteEvent: jest.fn(async () => ({})),
}));
jest.mock('../services/taskService', () => ({
  createTask: jest.fn(async () => ({ task_id: 1 })),
  deleteTask: jest.fn(async () => ({})),
}));
jest.mock('../services/logService', () => ({ createLogEntry: jest.fn(async () => ({ log_id: 1 })) }));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => ({})) }));
jest.mock('../lib/domainEvents', () => ({
  emit:         jest.fn(() => Promise.resolve()),
  buildChanges: jest.fn(() => ({})),
  runAsAction:  (_ruleId, fn) => fn(),
  MAX_DEPTH:    4,
}));
jest.mock('../lib/firmConfig', () => {
  const real = jest.requireActual('../lib/firmConfig');
  return { ...real, cfg: jest.fn((k) => (k === 'unified_singleton_enabled' ? global.__U6A_FLAG__ : null)) };
});

const eventService        = require('../services/eventService');
const calendarTypeService = require('../services/calendarTypeService');
const domainEvents        = require('../lib/domainEvents');
const gcalService         = require('../services/gcalService');
const taskService         = require('../services/taskService');
const logService          = require('../services/logService');
const { cfg }             = require('../lib/firmConfig');
const SEED                = require('./fixtures/calendar_item_types.seed.json');
const { makeEventsDb }    = require('./helpers/u6aEventsDb');

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const emits = (name) => domainEvents.emit.mock.calls.filter((c) => c[1] === name).map((c) => c[2]);
const emitNames = () => domainEvents.emit.mock.calls.map((c) => c[1]).filter((n) => n.startsWith('calendar.'));
const logActions = () => logService.createLogEntry.mock.calls.map((c) => c[1].data.action);

const CASES = [
  { case_id: 'ayx7GJ7j', case_number: '26-47542', case_number_full: '26-47542-mlo' },
  { case_id: 'SUTCdsPn', case_number: '26-46639', case_number_full: '26-46639-mar' },
];

beforeAll(() => calendarTypeService._primeCache(SEED));
afterAll(() => calendarTypeService.invalidate());
beforeEach(() => {
  jest.clearAllMocks();
  global.__U6A_FLAG__ = null;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { console.log.mockRestore(); console.warn.mockRestore(); console.error.mockRestore(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('supersedeEvent — the writer', () => {
  const pair = (o = {}) => [
    { event_id: 94,  event_type: 'Confirmation Hearing', kind: 'hearing', type_key: 'confirmation_hearing',
      event_link_type: 'case', event_link_id: 'ayx7GJ7j', event_title: 'Confirmation Hearing',
      event_date: '2026-10-05', event_time: '10:00:00', event_all_day: 0, event_length: 60,
      event_gcal: 'gcal_94', event_calendar_id: null, ...o },
    { event_id: 152, event_type: 'confirmation_hearing', kind: 'hearing', type_key: 'confirmation_hearing',
      event_link_type: 'case_number', event_link_id: '26-47542', event_title: 'Confirmation Hearing — Smith (26-47542)',
      event_date: '2026-11-02', event_time: '10:00:00', event_all_day: 0, event_length: 60 },
  ];

  test('happy path: pointer + reason, status untouched, updated_at self-assigned, GCal + reminders torn down, log, emit', async () => {
    const db = makeEventsDb({ events: pair(), cases: CASES, tasks: { '94': [701, 702] } });
    const r = await eventService.supersedeEvent(db, {
      predecessorId: 94, successorId: 152, actingUserId: 3, source: 'court',
    });
    await flush();

    const pred = db.events.get(94);
    expect(pred.superseded_by_event_id).toBe(152);
    expect(pred.supersede_reason).toBe('rescheduled');
    expect(pred.event_status).toBe('Scheduled');                 // NEVER a status (E0a rule)
    expect(pred.event_updated_at).toBe('T0');                    // §7.1 rule 9 — self-assigned, not bumped

    // The pointer write is the guarded form, byte-exact.
    const ptr = db.calls.find((c) => /superseded_by_event_id = \?/.test(c.sql));
    expect(ptr.sql).toBe('UPDATE events SET superseded_by_event_id = ?, supersede_reason = ?, event_updated_at = event_updated_at WHERE event_id = ? AND superseded_by_event_id IS NULL');
    expect(ptr.params).toEqual([152, 'rescheduled', 94]);

    // GCal delete + id clear (self-assigned too), reminder tasks soft-deleted.
    expect(gcalService.deleteEvent).toHaveBeenCalledTimes(1);
    expect(gcalService.deleteEvent.mock.calls[0][1].eventId).toBe('gcal_94');
    expect(pred.event_gcal).toBeNull();
    expect(db.calls.some((c) => /^UPDATE events SET event_gcal = NULL, event_updated_at = event_updated_at/.test(c.sql))).toBe(true);
    expect(taskService.deleteTask.mock.calls.map((c) => c[1])).toEqual([701, 702]);

    // Log row: action 'superseded' on the predecessor's link, with the successor.
    expect(logActions()).toEqual(['superseded']);
    const log = logService.createLogEntry.mock.calls[0][1];
    expect(log).toMatchObject({ type: 'event', link_type: 'case', link_id: 'ayx7GJ7j', by: 3 });
    expect(log.data).toMatchObject({ event_id: 94, successor_id: 152, reason: 'rescheduled' });

    // calendar.rescheduled with the PREDECESSOR as data, state superseded.
    expect(emitNames()).toEqual(['calendar.rescheduled']);
    const env = emits('calendar.rescheduled')[0];
    expect(env.source).toBe('court');
    expect(env.actor).toEqual({ user_id: 3 });
    expect(env.case_id).toBe('ayx7GJ7j');
    expect(env.data).toMatchObject({
      source: 'event', source_id: 94, status: 'Scheduled',
      state: 'superseded', resolution: null, superseded_by_event_id: 152,
    });
    expect(env.extra).toEqual({
      via: 'supersede', superseded_by: 152, reason: 'rescheduled',
      prior_starts_at: '2026-10-05 10:00', new_starts_at: '2026-11-02 10:00',
    });

    expect(r.predecessor.superseded_by_event_id).toBe(152);
    expect(r.successor.event_id).toBe(152);
    expect(db.unmatched).toEqual([]);
  });

  test('no GCal entry → no delete, no gcal-clear write', async () => {
    const db = makeEventsDb({ events: pair({ event_gcal: null }), cases: CASES });
    await eventService.supersedeEvent(db, { predecessorId: 94, successorId: 152 });
    await flush();
    expect(gcalService.deleteEvent).not.toHaveBeenCalled();
    expect(db.count(/SET event_gcal = NULL/)).toBe(0);
  });

  test("reason 'duplicate' is accepted and carried through", async () => {
    const db = makeEventsDb({ events: pair(), cases: CASES });
    await eventService.supersedeEvent(db, { predecessorId: 94, successorId: 152, reason: 'duplicate' });
    await flush();
    expect(db.events.get(94).supersede_reason).toBe('duplicate');
    expect(emits('calendar.rescheduled')[0].extra.reason).toBe('duplicate');
  });

  describe('every precondition is a 409 naming the ids, and NOTHING is written', () => {
    const expect409 = async (db, args, re) => {
      const before = db.calls.length;
      await expect(eventService.supersedeEvent(db, args)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(re) });
      expect(db.calls.slice(before).some((c) => /^UPDATE/i.test(c.sql))).toBe(false);
      expect(domainEvents.emit).not.toHaveBeenCalled();
      expect(logService.createLogEntry).not.toHaveBeenCalled();
    };

    test('predecessor missing', async () => {
      const db = makeEventsDb({ events: pair().slice(1), cases: CASES });
      await expect409(db, { predecessorId: 94, successorId: 152 }, /predecessor event 94 not found/);
    });
    test('successor missing', async () => {
      const db = makeEventsDb({ events: pair().slice(0, 1), cases: CASES });
      await expect409(db, { predecessorId: 94, successorId: 152 }, /successor event 152 not found/);
    });
    test('self-supersede', async () => {
      const db = makeEventsDb({ events: pair(), cases: CASES });
      await expect409(db, { predecessorId: 94, successorId: 94 }, /94 cannot supersede itself/);
    });
    test('predecessor already superseded', async () => {
      const db = makeEventsDb({ events: pair({ superseded_by_event_id: 7, supersede_reason: 'duplicate' }), cases: CASES });
      await expect409(db, { predecessorId: 94, successorId: 152 }, /94 is already superseded by 7/);
    });
    test('successor is itself superseded', async () => {
      const ev = pair(); ev[1].superseded_by_event_id = 8;
      const db = makeEventsDb({ events: ev, cases: CASES });
      await expect409(db, { predecessorId: 94, successorId: 152 }, /152 is itself superseded by 8/);
    });
    test('bad reason', async () => {
      const db = makeEventsDb({ events: pair(), cases: CASES });
      await expect409(db, { predecessorId: 94, successorId: 152, reason: 'moved' }, /reason must be/);
    });
    test('non-integer ids', async () => {
      const db = makeEventsDb({ events: pair(), cases: CASES });
      await expect409(db, { predecessorId: 'x', successorId: 152 }, /invalid predecessorId/);
      await expect409(db, { predecessorId: 94, successorId: 0 },   /invalid successorId/);
    });
  });

  test('lost race: the guarded UPDATE affects 0 rows → 409, no side effects', async () => {
    const db = makeEventsDb({ events: pair(), cases: CASES });
    // Someone else stamps the pointer between our precondition read and our write.
    const orig = db.query;
    db.query = async (sql, params) => {
      if (/superseded_by_event_id = \?/.test(String(sql))) db.events.get(94).superseded_by_event_id = 999;
      return orig(sql, params);
    };
    await expect(eventService.supersedeEvent(db, { predecessorId: 94, successorId: 152 }))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/94 was superseded concurrently/) });
    expect(db.events.get(94).superseded_by_event_id).toBe(999);      // the winner's pointer stands
    expect(gcalService.deleteEvent).not.toHaveBeenCalled();
    expect(logService.createLogEntry).not.toHaveBeenCalled();
    expect(domainEvents.emit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('singleton in createEvent', () => {
  const CREATE = {
    event_type: 'Confirmation Hearing', event_title: 'Confirmation Hearing',
    event_date: '2026-11-02', event_time: '10:00', event_all_day: 0, event_length: 60,
    skip_gcal: true, acting_user_id: 4,
  };
  const prior = (o = {}) => ({
    event_id: 94, event_type: 'Confirmation Hearing', kind: 'hearing', type_key: 'confirmation_hearing',
    event_link_type: 'case', event_link_id: 'ayx7GJ7j', event_title: 'Confirmation Hearing',
    event_date: '2026-10-05', event_time: '10:00:00', event_all_day: 0, event_length: 60, ...o,
  });

  test('FLAG OFF (absent): zero extra queries, no pointer, no rescheduled emit — the pre-U6a create', async () => {
    global.__U6A_FLAG__ = null;
    const db = makeEventsDb({ events: [prior()], cases: CASES });
    const { event_id } = await eventService.createEvent(db, {
      ...CREATE, event_link_type: 'case_number', event_link_id: '26-47542',
    });
    await flush();
    // Exactly the pre-U6a statement list: does_appts guard? (no event_with → none), INSERT, getEvent.
    expect(db.calls.map((c) => c.sql.split(' ')[0])).toEqual(['INSERT', 'SELECT']);
    expect(db.events.get(94).superseded_by_event_id).toBeNull();
    expect(emitNames()).toEqual(['calendar.scheduled']);
    expect(cfg).toHaveBeenCalledWith('unified_singleton_enabled');
    expect(event_id).toBeGreaterThan(94);
  });

  test("FLAG '0' behaves like absent", async () => {
    global.__U6A_FLAG__ = '0';
    const db = makeEventsDb({ events: [prior()], cases: CASES });
    await eventService.createEvent(db, { ...CREATE, event_link_type: 'case', event_link_id: 'ayx7GJ7j' });
    await flush();
    expect(db.calls.map((c) => c.sql.split(' ')[0])).toEqual(['INSERT', 'SELECT']);
    expect(db.events.get(94).superseded_by_event_id).toBeNull();
  });

  test("FLAG ON: the cross-form pair collapses — 'case_number' create supersedes the prior 'case' row (event 94 / 152 shape)", async () => {
    global.__U6A_FLAG__ = '1';
    const db = makeEventsDb({ events: [prior({ event_gcal: 'gcal_94' })], cases: CASES, tasks: { '94': [701] } });
    const { event_id } = await eventService.createEvent(db, {
      ...CREATE, event_link_type: 'case_number', event_link_id: '26-47542', source: 'court',
    });
    await flush();

    const pred = db.events.get(94);
    expect(pred.superseded_by_event_id).toBe(event_id);
    expect(pred.supersede_reason).toBe('rescheduled');
    expect(pred.event_status).toBe('Scheduled');
    expect(db.events.get(event_id).superseded_by_event_id).toBeNull();

    // Emit ORDER: the successor is real before the chain points at it.
    expect(emitNames()).toEqual(['calendar.scheduled', 'calendar.rescheduled']);
    expect(emits('calendar.scheduled')[0].data.source_id).toBe(event_id);
    const resched = emits('calendar.rescheduled')[0];
    expect(resched.data.source_id).toBe(94);
    expect(resched.extra).toMatchObject({ via: 'supersede', superseded_by: event_id, reason: 'rescheduled',
                                          prior_starts_at: '2026-10-05 10:00', new_starts_at: '2026-11-02 10:00' });
    expect(resched.actor).toEqual({ user_id: 4 });
    expect(resched.source).toBe('court');

    // Identity resolved through the case: the priors query is the case-scope form.
    const priors = db.calls.find((c) => /^SELECT e\.event_id, e\.event_date, e\.event_time, e\.event_all_day, e\.type_key FROM events e/.test(c.sql));
    expect(priors.sql).toMatch(/event_link_type = 'case' AND e\.event_link_id = \?/);
    expect(priors.sql).toMatch(/event_link_id IN \(\?,\?\)/);
    expect(priors.sql).toMatch(/e\.event_status = 'Scheduled' AND e\.superseded_by_event_id IS NULL/);
    expect(priors.params).toEqual(['ayx7GJ7j', '26-47542', '26-47542-mlo', 'confirmation_hearing', event_id]);

    expect(gcalService.deleteEvent).toHaveBeenCalledTimes(1);
    expect(taskService.deleteTask).toHaveBeenCalledWith(db, 701, 4);
    expect(logActions()).toEqual(['created', 'superseded']);
    expect(db.unmatched).toEqual([]);
  });

  test("FLAG ON: the reverse form too — a 'case' create supersedes a prior 'case_number' row", async () => {
    global.__U6A_FLAG__ = '1';
    const db = makeEventsDb({ events: [prior({ event_link_type: 'case_number', event_link_id: '26-47542-mlo' })], cases: CASES });
    const { event_id } = await eventService.createEvent(db, { ...CREATE, event_link_type: 'case', event_link_id: 'ayx7GJ7j' });
    await flush();
    expect(db.events.get(94).superseded_by_event_id).toBe(event_id);
  });

  test('FLAG ON: a prior on a DIFFERENT case is not touched', async () => {
    global.__U6A_FLAG__ = '1';
    const db = makeEventsDb({ events: [prior({ event_link_id: 'SUTCdsPn' })], cases: CASES });
    await eventService.createEvent(db, { ...CREATE, event_link_type: 'case', event_link_id: 'ayx7GJ7j' });
    await flush();
    expect(db.events.get(94).superseded_by_event_id).toBeNull();
    expect(emitNames()).toEqual(['calendar.scheduled']);
  });

  test('FLAG ON: a prior of a different type_key on the same case is not touched', async () => {
    global.__U6A_FLAG__ = '1';
    const db = makeEventsDb({ events: [prior({ event_type: 'Show Cause', type_key: 'show_cause' })], cases: CASES });
    await eventService.createEvent(db, { ...CREATE, event_link_type: 'case', event_link_id: 'ayx7GJ7j' });
    await flush();
    expect(db.events.get(94).superseded_by_event_id).toBeNull();
  });

  test('FLAG ON: already-dead priors (Canceled, or already pointered) are not re-superseded', async () => {
    global.__U6A_FLAG__ = '1';
    const db = makeEventsDb({ events: [
      prior({ event_id: 94, event_status: 'Canceled' }),
      prior({ event_id: 95, superseded_by_event_id: 94, supersede_reason: 'duplicate' }),
    ], cases: CASES });
    await eventService.createEvent(db, { ...CREATE, event_link_type: 'case', event_link_id: 'ayx7GJ7j' });
    await flush();
    expect(db.events.get(94).superseded_by_event_id).toBeNull();
    expect(db.events.get(95).superseded_by_event_id).toBe(94);
    expect(emitNames()).toEqual(['calendar.scheduled']);
  });

  test('FLAG ON: >1 prior live rows (the live 7-pair shape) — all superseded, one warning naming them', async () => {
    global.__U6A_FLAG__ = '1';
    const db = makeEventsDb({ events: [
      prior({ event_id: 94 }),
      prior({ event_id: 152, event_link_type: 'case_number', event_link_id: '26-47542', event_date: '2026-10-06' }),
    ], cases: CASES });
    const { event_id } = await eventService.createEvent(db, { ...CREATE, event_link_type: 'case', event_link_id: 'ayx7GJ7j' });
    await flush();
    expect(db.events.get(94).superseded_by_event_id).toBe(event_id);
    expect(db.events.get(152).superseded_by_event_id).toBe(event_id);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/found 2 prior live rows \[94, 152\]/));
    expect(emitNames()).toEqual(['calendar.scheduled', 'calendar.rescheduled', 'calendar.rescheduled']);
  });

  test('FLAG ON: no link → no check, no priors query', async () => {
    global.__U6A_FLAG__ = '1';
    const db = makeEventsDb({ events: [prior({ event_link_type: null, event_link_id: null })], cases: CASES });
    await eventService.createEvent(db, { ...CREATE });     // unlinked
    await flush();
    expect(db.count(/^SELECT e\.event_id, e\.event_date/)).toBe(0);
    expect(db.events.get(94).superseded_by_event_id).toBeNull();
  });

  test('FLAG ON: singleton=0 type → no check', async () => {
    global.__U6A_FLAG__ = '1';
    const seedRow = SEED.find((r) => r.singleton === 0 && r.kind !== 'meeting');
    const db = makeEventsDb({ events: [prior({ event_type: seedRow.label, type_key: seedRow.type_key, kind: seedRow.kind })], cases: CASES });
    await eventService.createEvent(db, { ...CREATE, event_type: seedRow.label, event_link_type: 'case', event_link_id: 'ayx7GJ7j' });
    await flush();
    expect(db.count(/^SELECT e\.event_id, e\.event_date/)).toBe(0);
    expect(db.events.get(94).superseded_by_event_id).toBeNull();
  });

  test('FLAG ON: contact-linked identity is the raw (link_type, link_id, type_key)', async () => {
    global.__U6A_FLAG__ = '1';
    const db = makeEventsDb({ events: [prior({ event_link_type: 'contact', event_link_id: '77' })], cases: CASES });
    const { event_id } = await eventService.createEvent(db, { ...CREATE, event_link_type: 'contact', event_link_id: '77' });
    await flush();
    expect(db.events.get(94).superseded_by_event_id).toBe(event_id);
    const priors = db.calls.find((c) => /^SELECT e\.event_id, e\.event_date/.test(c.sql));
    expect(priors.sql).toMatch(/\(e\.event_link_type = \? AND e\.event_link_id = \?\)/);
    expect(priors.params.slice(0, 2)).toEqual(['contact', '77']);
  });

  test('FLAG ON: unresolved docket falls back to raw docket equality', async () => {
    global.__U6A_FLAG__ = '1';
    const db = makeEventsDb({ events: [prior({ event_link_type: 'case_number', event_link_id: '99-00000' })], cases: CASES });
    const { event_id } = await eventService.createEvent(db, { ...CREATE, event_link_type: 'case_number', event_link_id: '99-00000' });
    await flush();
    expect(db.events.get(94).superseded_by_event_id).toBe(event_id);
  });

  test('FLAG ON: dedupe wins first — same slot returns deduped:true, no INSERT, no supersede, no emit', async () => {
    global.__U6A_FLAG__ = '1';
    const db = makeEventsDb({ events: [prior({ event_date: '2026-11-02' })], cases: CASES });   // same slot as CREATE
    const r = await eventService.createEvent(db, { ...CREATE, event_link_type: 'case', event_link_id: 'ayx7GJ7j', dedupe: true });
    await flush();
    expect(r.deduped).toBe(true);
    expect(r.event_id).toBe(94);
    expect(db.count(/^INSERT/)).toBe(0);
    expect(db.count(/^SELECT e\.event_id, e\.event_date/)).toBe(0);
    expect(emitNames()).toEqual([]);
    expect(db.events.get(94).superseded_by_event_id).toBeNull();
  });

  test('FLAG ON: a supersede failure never fails the create (row already committed)', async () => {
    global.__U6A_FLAG__ = '1';
    const db = makeEventsDb({ events: [prior()], cases: CASES });
    const orig = db.query;
    db.query = async (sql, params) => {
      if (/superseded_by_event_id = \?/.test(String(sql))) throw new Error('boom');
      return orig(sql, params);
    };
    const r = await eventService.createEvent(db, { ...CREATE, event_link_type: 'case', event_link_id: 'ayx7GJ7j' });
    await flush();
    expect(r.deduped).toBe(false);
    expect(r.event_id).toBeGreaterThan(94);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/singleton: supersede 94/), 'boom');
    expect(emitNames()).toEqual(['calendar.scheduled']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('_singletonPriors — the identity query on its own', () => {
  test('unlinked row → [] and NO query', async () => {
    const db = makeEventsDb({ cases: CASES });
    const out = await eventService._singletonPriors(db, { event_id: 1, type_key: 'confirmation_hearing', event_link_type: null, event_link_id: null });
    expect(out).toEqual([]);
    expect(db.calls).toEqual([]);
  });

  test('resolved case with a single docket form builds a 1-item IN list', async () => {
    const db = makeEventsDb({ cases: [{ case_id: 'ONEFORM', case_number: '26-1', case_number_full: null }] });
    await eventService._singletonPriors(db, { event_id: 1, type_key: 'k', event_link_type: 'case', event_link_id: 'ONEFORM' });
    const q = db.calls[1];
    expect(q.sql).toMatch(/event_link_id IN \(\?\)/);
    expect(q.params).toEqual(['ONEFORM', '26-1', 'k', 1]);
  });

  test('resolved case with NO docket at all uses the case-only form', async () => {
    const db = makeEventsDb({ cases: [{ case_id: 'NODOCKET', case_number: '', case_number_full: null }] });
    await eventService._singletonPriors(db, { event_id: 1, type_key: 'k', event_link_type: 'case', event_link_id: 'NODOCKET' });
    const q = db.calls[1];
    expect(q.sql).toMatch(/\(e\.event_link_type = 'case' AND e\.event_link_id = \?\)/);
    expect(q.sql).not.toMatch(/IN \(/);
    expect(q.params).toEqual(['NODOCKET', 'k', 1]);
  });
});
