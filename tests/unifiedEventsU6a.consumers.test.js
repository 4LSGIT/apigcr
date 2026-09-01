// tests/unifiedEventsU6a.consumers.test.js
//
/**
 * Unified Events U6a — the consumer audit (v0.5 §3.4, §8.3 "forward
 * supersession needs its consumers").
 *
 * A rescheduled predecessor keeps event_status='Scheduled' — supersession is
 * the pointer, never a status. Before U6a only caseEventService filtered the
 * pointer; every other raw `FROM events` liveness query filtered on status
 * alone, which was invisible because all 31 E0a rows are Canceled. The writer
 * (supersedeEvent) and these filters ship together.
 *
 * Every test here seeds a row that is Scheduled AND carries a pointer — the
 * shape that cannot exist live until the flag is on — and asserts the site
 * no longer sees it. The mirror assertion (a Canceled + pointer row keeps
 * its pre-U6a visibility under listEvents status:'all') pins the acceptance
 * bar: with the flag off, nothing observable changes (Fred, option B).
 *
 * Sites: listEvents (+ includeSuperseded), findDuplicateEvent (both candidate
 * queries), getEventsForDigest, availabilityService (SQL + in-memory guard),
 * routes/api.calendarFeed, internal function get_events (+ include_superseded).
 *
 * Run:  npx jest tests/unifiedEventsU6a.consumers.test.js
 */

'use strict';

jest.mock('../services/gcalService', () => ({
  createEvent: jest.fn(async () => ({ id: 'gcal_1' })),
  deleteEvent: jest.fn(async () => ({})),
}));
jest.mock('../services/taskService', () => ({
  createTask: jest.fn(async () => ({ task_id: 1 })),
  deleteTask: jest.fn(async () => ({})),
}));
jest.mock('../services/logService', () => ({ createLogEntry: jest.fn(async () => ({ log_id: 1 })) }));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => ({})) }));
jest.mock('../lib/domainEvents', () => ({
  emit: jest.fn(() => Promise.resolve()), buildChanges: jest.fn(() => ({})),
  runAsAction: (_r, fn) => fn(), MAX_DEPTH: 4,
}));
jest.mock('../lib/auth.jwtOrApiKey', () => jest.fn((req, res, next) => { req.auth = { userId: 9 }; next(); }));

const eventService        = require('../services/eventService');
const availability        = require('../services/availabilityService');
const calendarTypeService = require('../services/calendarTypeService');
const SEED                = require('./fixtures/calendar_item_types.seed.json');
const { makeEventsDb }    = require('./helpers/u6aEventsDb');

const CASES = [{ case_id: 'ayx7GJ7j', case_number: '26-47542', case_number_full: '26-47542-mlo' }];

// The three shapes every site is tested against.
const LIVE     = { event_id: 1, event_status: 'Scheduled', superseded_by_event_id: null };
const PHANTOM  = { event_id: 2, event_status: 'Scheduled', superseded_by_event_id: 1, supersede_reason: 'rescheduled' };  // U6a hazard
const TOMB     = { event_id: 3, event_status: 'Canceled',  superseded_by_event_id: 1, supersede_reason: 'duplicate' };    // the 31 E0a rows
const base = (o = {}) => ({
  event_type: 'Confirmation Hearing', kind: 'hearing', type_key: 'confirmation_hearing',
  event_link_type: 'case', event_link_id: 'ayx7GJ7j', event_title: 'Confirmation Hearing',
  event_date: '2026-10-05', event_time: '10:00:00', event_all_day: 0, event_length: 60, event_with: null, ...o,
});
const seed = () => [base(LIVE), base(PHANTOM), base(TOMB)];
const ids = (rows) => rows.map((r) => r.event_id);

beforeAll(() => calendarTypeService._primeCache(SEED));
afterAll(() => calendarTypeService.invalidate());
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { console.log.mockRestore(); console.error.mockRestore(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('listEvents', () => {
  test("default (status 'Scheduled'): the phantom is hidden; the live row shows", async () => {
    const db = makeEventsDb({ events: seed(), cases: CASES });
    const { data, total } = await eventService.listEvents(db, { link_type: 'case', link_id: 'ayx7GJ7j' });
    expect(ids(data)).toEqual([1]);
    expect(total).toBe(1);
    expect(db.hidesLiveSuperseded(db.calls[1].sql)).toBe(true);        // COUNT
    expect(db.hidesLiveSuperseded(db.calls[2].sql)).toBe(true);        // SELECT
  });

  test("status 'all' (case.html / contact.html): the phantom is hidden, the Canceled tombstone STAYS (acceptance bar — option B)", async () => {
    const db = makeEventsDb({ events: seed(), cases: CASES });
    const { data } = await eventService.listEvents(db, { link_type: 'case', link_id: 'ayx7GJ7j', status: 'all' });
    expect(ids(data)).toEqual([1, 3]);
  });

  test("status 'Canceled' still returns the tombstone, exactly as before U6a", async () => {
    const db = makeEventsDb({ events: seed(), cases: CASES });
    const { data } = await eventService.listEvents(db, { status: 'Canceled' });
    expect(ids(data)).toEqual([3]);
  });

  test('includeSuperseded:true returns everything, and the predicate is gone from the SQL', async () => {
    const db = makeEventsDb({ events: seed(), cases: CASES });
    const { data, total } = await eventService.listEvents(db, { status: 'all', includeSuperseded: true });
    expect(ids(data)).toEqual([1, 2, 3]);
    expect(total).toBe(3);
    expect(db.calls.some((c) => /superseded_by_event_id/.test(c.sql))).toBe(false);
  });

  test('the predicate adds NO query and NO bind (query budget unchanged: case lookup + COUNT + SELECT)', async () => {
    const db = makeEventsDb({ events: seed(), cases: CASES });
    await eventService.listEvents(db, { link_type: 'case', link_id: 'ayx7GJ7j', status: 'Scheduled' });
    expect(db.calls).toHaveLength(3);
    expect(db.calls[1].params).toEqual(['ayx7GJ7j', '26-47542', '26-47542-mlo', 'Scheduled']);
  });

  test("the predicate contains no 'IS NULL' — the positive-link contract in eventservice.linkfilter.test.js holds", async () => {
    const db = makeEventsDb({ events: seed(), cases: CASES });
    await eventService.listEvents(db, { link_type: 'contact', link_id: '77', status: 'all' });
    expect(db.calls[0].sql.split(/\bWHERE\b/)[1]).not.toMatch(/IS NULL/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('findDuplicateEvent — a superseded row is never "the existing match"', () => {
  const cand = {
    event_link_type: 'case', event_link_id: 'ayx7GJ7j', event_type: 'Confirmation Hearing',
    event_title: 'Confirmation Hearing', event_date: '2026-10-05', event_time: '10:00:00',
  };

  test('RULE 1 (natural key): only the phantom matches exactly → no hit; the live twin matches → hit', async () => {
    const db = makeEventsDb({ events: [base(PHANTOM)], cases: CASES });
    expect(await eventService.findDuplicateEvent(db, cand)).toBeNull();
    expect(db.calls[0].sql).toMatch(/e\.event_status = 'Scheduled' AND e\.superseded_by_event_id IS NULL/);

    const db2 = makeEventsDb({ events: [base(PHANTOM), base(LIVE)], cases: CASES });
    const hit = await eventService.findDuplicateEvent(db2, cand);
    expect(hit.event_id).toBe(1);
    expect(hit._dedupe_rule).toBe('natural_key');
  });

  test('SLOT set (rules 2–3): the phantom at the same slot is not a candidate', async () => {
    // Different title so rule 1 misses and the slot query runs.
    const db = makeEventsDb({ events: [base({ ...PHANTOM, event_title: 'Confirmation Hearing — Smith' })], cases: CASES });
    expect(await eventService.findDuplicateEvent(db, cand)).toBeNull();
    const slot = db.calls.find((c) => /event_time <=> \?/.test(c.sql));
    expect(slot.sql).toMatch(/e\.event_status = 'Scheduled' AND e\.superseded_by_event_id IS NULL/);
  });

  test('createEvent { dedupe:true } therefore INSERTS beside a phantom instead of deduping onto it', async () => {
    const db = makeEventsDb({ events: [base(PHANTOM)], cases: CASES });
    const r = await eventService.createEvent(db, { ...cand, event_all_day: 0, dedupe: true, skip_gcal: true });
    expect(r.deduped).toBe(false);
    expect(db.count(/^INSERT/)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getEventsForDigest', () => {
  test('the phantom is excluded from the window', async () => {
    const db = makeEventsDb({ events: seed(), cases: CASES });
    const rows = await eventService.getEventsForDigest(db, { from: '2026-10-01', to: '2026-10-31' });
    expect(ids(rows)).toEqual([1]);
    expect(db.calls[0].sql).toMatch(/e\.event_status = 'Scheduled' AND e\.superseded_by_event_id IS NULL AND e\.event_date BETWEEN \? AND \?/);
    expect(db.calls[0].params).toEqual(['2026-10-01', '2026-10-31']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('availabilityService', () => {
  const ev = (o = {}) => ({ event_date: '2026-10-05', event_time: '10:00:00', event_all_day: 0, event_length: 60,
                            event_status: 'Scheduled', event_with: null, superseded_by_event_id: null, ...o });

  test('in-memory guard: a Scheduled row carrying a pointer does not block; without the column (old fixtures) behaviour is unchanged', () => {
    const live    = availability.normalizeBusyForProvider(1, { events: [ev()] });
    const phantom = availability.normalizeBusyForProvider(1, { events: [ev({ superseded_by_event_id: 7 })] });
    const both    = availability.normalizeBusyForProvider(1, { events: [ev(), ev({ superseded_by_event_id: 7, event_time: '14:00:00' })] });
    const legacy  = availability.normalizeBusyForProvider(1, { events: [(() => { const e = ev(); delete e.superseded_by_event_id; return e; })()] });
    expect(live).toHaveLength(1);
    expect(phantom).toEqual([]);
    expect(both).toEqual(live);
    expect(legacy).toEqual(live);
  });

  test('getSlots: the events SQL filters the pointer and selects the column', async () => {
    const calls = [];
    const db = { query: async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: flat, params });
      if (/FROM users WHERE user IN/.test(flat)) return [[{ user: 1, freebusy_calendar_ids: null, user_gcal_id: null }]];
      return [[]];
    } };
    await availability.getSlots(db, { providerIds: [1], appt_length: 30, from: '2026-10-05', to: '2026-10-05' });
    const evq = calls.find((c) => /FROM events/.test(c.sql));
    expect(evq).toBeTruthy();
    expect(evq.sql).toMatch(/event_all_day = 0 AND event_status = 'Scheduled' AND superseded_by_event_id IS NULL AND \(event_with IS NULL OR event_with IN \(\?\)\)/);
    expect(evq.sql).toMatch(/event_all_day, event_length, event_status, event_with, superseded_by_event_id FROM events/);
    expect(evq.params).toHaveLength(3);     // pids, lookback, to — no new bind
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('routes/api.calendarFeed.js', () => {
  const express = require('express');
  const router  = require('../routes/api.calendarFeed');
  let server, base, calls, events;
  const app = express();
  app.use((req, res, next) => {
    req.db = { query: async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: flat, params });
      if (/FROM users ORDER BY user ASC/.test(flat)) return [[{ user: 1, user_name: 'SS', does_appts: 1 }]];
      if (/FROM events e/.test(flat)) {
        const hasPtr = /e\.superseded_by_event_id IS NULL/.test(flat);
        return [events.filter((e) => e.event_status === 'Scheduled' && (!hasPtr || e.superseded_by_event_id == null))
                      .map((e) => ({ ...e, contact_name: null, case_number_display: null, resolved_case_id: null }))];
      }
      return [[]];
    } };
    next();
  });
  app.use(router);
  beforeAll(async () => {
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => { calls = []; events = seed(); });

  test('show=events: the phantom is not in the feed; the SQL carries the filter', async () => {
    const res = await fetch(`${base}/api/calendar-feed?from=2026-10-01&to=2026-10-31&show=events`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const items = (body.items || body.data || body).filter((i) => String(i.id).startsWith('event-'));
    expect(items.map((i) => i.id)).toEqual(['event-1']);
    const evq = calls.find((c) => /FROM events e/.test(c.sql));
    expect(evq.sql).toMatch(/WHERE e\.event_status = 'Scheduled' AND e\.superseded_by_event_id IS NULL AND \(e\.event_with IS NULL OR e\.event_with IN \(\?\)\)/);
    expect(evq.params).toEqual([[1], '2026-10-01', '2026-10-31']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('internal function get_events', () => {
  const fns = require('../lib/internal_functions/events');

  test("default (status 'Scheduled'): phantom hidden", async () => {
    const db = makeEventsDb({ events: seed(), cases: CASES });
    const r = await fns.get_events({ link_type: 'case', link_id: 'ayx7GJ7j' }, db);
    expect(ids(r.output.rows)).toEqual([1]);
    expect(db.hidesLiveSuperseded(db.calls[0].sql)).toBe(true);
    expect(db.calls[0].params).toEqual(['case', 'ayx7GJ7j', 'Scheduled', 200]);   // no new bind
  });

  test("status 'all': phantom hidden, tombstone kept (same contract as listEvents)", async () => {
    const db = makeEventsDb({ events: seed(), cases: CASES });
    const r = await fns.get_events({ status: 'all' }, db);
    expect(ids(r.output.rows)).toEqual([1, 3]);
  });

  test('include_superseded:true shows everything', async () => {
    const db = makeEventsDb({ events: seed(), cases: CASES });
    const r = await fns.get_events({ status: 'all', include_superseded: true }, db);
    expect(ids(r.output.rows)).toEqual([1, 2, 3]);
    expect(db.calls[0].sql).not.toMatch(/superseded/);
  });

  test('the __meta registry carries the new param', () => {
    expect(fns.get_events.__meta.params.map((p) => p.name)).toContain('include_superseded');
    expect(fns.complete_event.__meta.params.map((p) => p.name)).toContain('resolution');
  });
});
