// tests/unifiedEventsU6a.sweep.test.js
//
/**
 * Unified Events U6a — `sweep_calendar_missed` (v0.5 §3.7 "a daily sweep sets
 * missed on deadlines still Scheduled", §8.2 ruling gate on `since`).
 *
 * The population is kind='deadline', Scheduled, no pointer, event_date in
 * [since, firm-local today). Each row goes through completeEvent with
 * { resolution:'missed', source:'sweep' } — so the test asserts what that
 * writer does (status + resolution in one UPDATE, calendar.resolved with
 * resolution 'missed', a log row) rather than re-testing completeEvent.
 *
 * The two things that must never happen: touching history older than
 * `since` (30 live rows are UNKNOWN, not missed — the sweep has no default
 * because of them), and marking a deadline dated TODAY (the firm's day is
 * not over; today is computed in FIRM_TZ, never CURDATE()).
 *
 * Run:  npx jest tests/unifiedEventsU6a.sweep.test.js
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

const { DateTime }        = require('luxon');
const fns                 = require('../lib/internal_functions/events');
const calendarTypeService = require('../services/calendarTypeService');
const domainEvents        = require('../lib/domainEvents');
const logService          = require('../services/logService');
const gcalService         = require('../services/gcalService');
const { FIRM_TZ }         = require('../services/timezoneService');
const SEED                = require('./fixtures/calendar_item_types.seed.json');
const { makeEventsDb }    = require('./helpers/u6aEventsDb');

const TODAY     = DateTime.now().setZone(FIRM_TZ).toFormat('yyyy-MM-dd');
const daysAgo   = (n) => DateTime.now().setZone(FIRM_TZ).minus({ days: n }).toFormat('yyyy-MM-dd');
const SINCE     = daysAgo(10);

const dl = (id, date, o = {}) => ({
  event_id: id, event_type: 'Docs Deadline', kind: 'deadline', type_key: 'docs_deadline',
  event_link_type: 'case', event_link_id: 'ABCDEFGH', event_title: `DL ${id}`, event_date: date,
  event_time: null, event_all_day: 1, event_gcal: 'g' + id, ...o,
});
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const resolved = () => domainEvents.emit.mock.calls.filter((c) => c[1] === 'calendar.resolved').map((c) => c[2]);

beforeAll(() => calendarTypeService._primeCache(SEED));
afterAll(() => calendarTypeService.invalidate());
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { console.log.mockRestore(); console.error.mockRestore(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('sweep_calendar_missed', () => {
  test('`since` is required — no default, no run', async () => {
    const db = makeEventsDb();
    for (const bad of [{}, { since: '' }, { since: null }, { since: 'yesterday' }, { since: '2026-13-40' }, { since: '20260901' }]) {
      await expect(fns.sweep_calendar_missed(bad, db)).rejects.toThrow(/`since` \(YYYY-MM-DD\) is required/);
    }
    expect(db.calls).toEqual([]);
  });

  test('population: [since, today) — older rows, today, future, non-deadlines, non-Scheduled, superseded all untouched', async () => {
    const db = makeEventsDb({ events: [
      dl(1, daysAgo(3)),                                                     // in — marked
      dl(2, daysAgo(1)),                                                     // in — marked
      dl(3, daysAgo(20)),                                                    // before since — the "unknown" population
      dl(4, TODAY),                                                          // today is not missed (firm-local boundary)
      dl(5, daysAgo(-2)),                                                    // future
      dl(6, daysAgo(2), { kind: 'hearing', type_key: 'confirmation_hearing', event_type: 'Confirmation Hearing' }),
      dl(7, daysAgo(2), { event_status: 'Completed', event_resolution: 'met' }),
      dl(8, daysAgo(2), { event_status: 'Canceled', event_resolution: 'cancelled' }),
      dl(9, daysAgo(2), { superseded_by_event_id: 1, supersede_reason: 'rescheduled' }),   // Scheduled + pointer: dead
    ] });
    const r = await fns.sweep_calendar_missed({ since: SINCE }, db);
    await flush();

    expect(r.success).toBe(true);
    expect(r.output).toMatchObject({ scanned: 2, marked: 2, skipped: 0, dry_run: false, since: SINCE, today: TODAY, timed_out: false, capped: false, errors: [] });
    expect(typeof r.output.wall_clock_ms).toBe('number');

    // The population query binds firm-local today and since; no CURDATE().
    const pop = db.calls[0];
    expect(pop.sql).toMatch(/e\.kind = 'deadline' AND e\.event_status = 'Scheduled' AND e\.superseded_by_event_id IS NULL AND e\.event_date < \? AND e\.event_date >= \?/);
    expect(pop.sql).not.toMatch(/CURDATE/i);
    expect(pop.params).toEqual([TODAY, SINCE, 200]);

    for (const id of [1, 2]) expect(db.events.get(id)).toMatchObject({ event_status: 'Completed', event_resolution: 'missed' });
    for (const id of [3, 4, 5, 6, 9]) expect(db.events.get(id)).toMatchObject({ event_status: 'Scheduled', event_resolution: null });
    expect(db.events.get(7).event_resolution).toBe('met');
    expect(db.events.get(8).event_resolution).toBe('cancelled');
  });

  test('each marked row: one UPDATE with status+resolution, one calendar.resolved (resolution missed, source sweep, actor 0), one log row; no GCal action', async () => {
    const db = makeEventsDb({ events: [dl(1, daysAgo(3)), dl(2, daysAgo(1))], tasks: { '1': [55] } });
    await fns.sweep_calendar_missed({ since: SINCE }, db);
    await flush();

    const upd = db.calls.filter((c) => /^UPDATE events SET event_status = 'Completed', event_resolution = \?/.test(c.sql));
    expect(upd.map((c) => c.params)).toEqual([['missed', 1], ['missed', 2]]);   // oldest first
    expect(db.count(/^UPDATE/)).toBe(2);

    const envs = resolved();
    expect(envs).toHaveLength(2);
    for (const env of envs) {
      expect(env.source).toBe('sweep');
      expect(env.actor).toEqual({ user_id: 0 });
      expect(env.data).toMatchObject({ kind: 'deadline', status: 'Completed', state: 'resolved', resolution: 'missed' });
      expect(env.extra).toEqual({ via: 'complete', prior_status: 'Scheduled' });
    }
    expect(envs.map((e) => e.data.source_id)).toEqual([1, 2]);

    expect(logService.createLogEntry.mock.calls.map((c) => c[1].data)).toEqual([
      expect.objectContaining({ action: 'completed', event_id: 1, resolution: 'missed' }),
      expect.objectContaining({ action: 'completed', event_id: 2, resolution: 'missed' }),
    ]);
    expect(gcalService.deleteEvent).not.toHaveBeenCalled();
    expect(gcalService.createEvent).not.toHaveBeenCalled();
    expect(require('../services/taskService').deleteTask).toHaveBeenCalledWith(db, 55, 0);   // reminder cleared
  });

  test('idempotent: a second run finds nothing', async () => {
    const db = makeEventsDb({ events: [dl(1, daysAgo(3))] });
    await fns.sweep_calendar_missed({ since: SINCE }, db);
    const r2 = await fns.sweep_calendar_missed({ since: SINCE }, db);
    expect(r2.output).toMatchObject({ scanned: 0, marked: 0 });
  });

  test('dry_run: lists would-mark rows, writes nothing, emits nothing, logs nothing', async () => {
    const db = makeEventsDb({ events: [dl(1, daysAgo(3)), dl(2, daysAgo(1)), dl(3, daysAgo(20))] });
    const r = await fns.sweep_calendar_missed({ since: SINCE, dry_run: true }, db);
    await flush();
    expect(r.output).toMatchObject({ scanned: 2, marked: 0, skipped: 0, dry_run: true });
    expect(r.output.would_mark).toEqual([
      { event_id: 1, event_date: daysAgo(3), type_key: 'docs_deadline', link: 'case:ABCDEFGH' },
      { event_id: 2, event_date: daysAgo(1), type_key: 'docs_deadline', link: 'case:ABCDEFGH' },
    ]);
    expect(db.count(/^UPDATE/)).toBe(0);
    expect(domainEvents.emit).not.toHaveBeenCalled();
    expect(logService.createLogEntry).not.toHaveBeenCalled();
    expect(db.events.get(1).event_status).toBe('Scheduled');
  });

  test('max_rows caps the scan oldest-first; capped is reported; the rest is picked up next run', async () => {
    const db = makeEventsDb({ events: [dl(1, daysAgo(5)), dl(2, daysAgo(3)), dl(3, daysAgo(1))] });
    const r = await fns.sweep_calendar_missed({ since: SINCE, max_rows: 2 }, db);
    expect(r.output).toMatchObject({ scanned: 2, marked: 2, capped: true });
    expect(db.calls[0].params[2]).toBe(2);
    expect(db.events.get(1).event_status).toBe('Completed');
    expect(db.events.get(2).event_status).toBe('Completed');
    expect(db.events.get(3).event_status).toBe('Scheduled');
    const r2 = await fns.sweep_calendar_missed({ since: SINCE, max_rows: 2 }, db);
    expect(r2.output).toMatchObject({ scanned: 1, marked: 1, capped: false });
  });

  test('wall clock: stops before the next row, reports timed_out and skipped', async () => {
    const db = makeEventsDb({ events: [dl(1, daysAgo(5)), dl(2, daysAgo(3)), dl(3, daysAgo(1))] });
    // startedAt and firm-local `today` are read with the real clock; once the
    // population query has returned, the clock jumps past the bound so the
    // very first per-row check trips it.
    const realNow = Date.now;
    const orig = db.query;
    db.query = async (sql, params) => {
      const out = await orig(sql, params);
      if (/e\.kind = 'deadline'/.test(String(sql))) Date.now = () => realNow() + 999999;
      return out;
    };
    try {
      const r = await fns.sweep_calendar_missed({ since: SINCE, max_runtime_ms: 20000 }, db);
      expect(r.output).toMatchObject({ scanned: 3, marked: 0, skipped: 3, timed_out: true });
    } finally { Date.now = realNow; }
    expect(db.count(/^UPDATE/)).toBe(0);
  });

  test('a row that fails is recorded in errors and does not stop the run', async () => {
    const db = makeEventsDb({ events: [dl(1, daysAgo(5)), dl(2, daysAgo(3))] });
    const orig = db.query;
    db.query = async (sql, params) => {
      if (/^UPDATE events SET event_status/.test(String(sql).replace(/\s+/g, ' ')) && params[1] === 1) throw new Error('boom');
      return orig(sql, params);
    };
    const r = await fns.sweep_calendar_missed({ since: SINCE }, db);
    expect(r.output).toMatchObject({ scanned: 2, marked: 1, skipped: 1 });
    expect(r.output.errors).toEqual([{ event_id: 1, error: 'boom' }]);
    expect(db.events.get(2).event_status).toBe('Completed');
  });

  test('__meta: since is the only required param; category events', () => {
    const m = fns.sweep_calendar_missed.__meta;
    expect(m.category).toBe('events');
    expect(m.params.filter((p) => p.required).map((p) => p.name)).toEqual(['since']);
    expect(m.params.find((p) => p.name === 'since').default).toBeUndefined();
  });
});
