// tests/unifiedEventsU6a.resolution.test.js
//
/**
 * Unified Events U6a — the event_resolution writers (v0.5 §3.7, amendment A7).
 *
 * Before this slice the column had no writer and the read layer derived an
 * answer from status + kind. Now every terminal write stamps it:
 *
 *   completeEvent   { resolution } optional; validated per KIND; default
 *                   deadline → 'met', else 'held'; written in the SAME UPDATE
 *                   as the status; the calendar.resolved envelope carries it.
 *   cancelEvent     { resolution } ∈ { cancelled, moot }; 'moot' on deadlines
 *                   only; default 'cancelled'.
 *   updateEvent     event_resolution is patchable, validated against the
 *                   POST-update status and kind; a bare status move gets the
 *                   default; a move back to Scheduled clears it; null is
 *                   accepted only when the row ends up Scheduled.
 *   routes          PATCH /complete and /cancel accept { resolution }; an
 *                   invalid one is a 400 through err.status.
 *
 * ONE SOURCE. The defaults this file's writers stamp are pinned against
 * caseEventService._deriveState's fallback for the same (status, kind) — the
 * writer and the reader cannot disagree without a red test.
 *
 * Run:  npx jest tests/unifiedEventsU6a.resolution.test.js
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
  emit:         jest.fn(() => Promise.resolve()),
  buildChanges: jest.fn(() => ({})),
  runAsAction:  (_ruleId, fn) => fn(),
  MAX_DEPTH:    4,
}));

const eventService        = require('../services/eventService');
const { _deriveState }    = require('../services/caseEventService');
const calendarTypeService = require('../services/calendarTypeService');
const domainEvents        = require('../lib/domainEvents');
const logService          = require('../services/logService');
const SEED                = require('./fixtures/calendar_item_types.seed.json');
const { makeEventsDb }    = require('./helpers/u6aEventsDb');

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const only = (name) => {
  const hits = domainEvents.emit.mock.calls.filter((c) => c[1] === name);
  expect(hits).toHaveLength(1);
  return hits[0][2];
};

const row = (o = {}) => ({
  event_id: 42, event_type: 'Docs Deadline', kind: 'deadline', type_key: 'docs_deadline',
  event_link_type: 'case', event_link_id: 'ABCDEFGH', event_title: 'T', event_date: '2026-10-01',
  event_time: null, event_all_day: 1, ...o,
});
const HEARING = { event_type: 'Confirmation Hearing', kind: 'hearing', type_key: 'confirmation_hearing' };
const OTHER   = { event_type: 'Mediation', kind: 'other', type_key: null };
const NOKIND  = { event_type: null, kind: null, type_key: null };

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
describe('one source: writer defaults == _deriveState fallbacks', () => {
  test.each([
    ['deadline'], ['hearing'], ['conference'], ['meeting'], ['other'], [null],
  ])('kind %s — Completed default matches the read layer', (kind) => {
    const stamped = eventService._defaultResolution('Completed', kind);
    const derived = _deriveState('event', { event_status: 'Completed', event_resolution: null }, kind, false).resolution;
    expect(stamped).toBe(derived);
  });

  test.each([
    ['deadline'], ['hearing'], ['conference'], ['meeting'], ['other'], [null],
  ])('kind %s — Canceled default matches the read layer', (kind) => {
    const stamped = eventService._defaultResolution('Canceled', kind);
    const derived = _deriveState('event', { event_status: 'Canceled', event_resolution: null }, kind, false).resolution;
    expect(stamped).toBe(derived);
  });

  test('every value the writer accepts is one the column enum holds', () => {
    const enumVals = new Set(['held', 'met', 'missed', 'moot', 'cancelled']);
    const all = [
      ...Object.values(eventService._EVENT_RESOLUTIONS_COMPLETED).flat(),
      ...Object.values(eventService._EVENT_RESOLUTIONS_CANCELED).flat(),
    ];
    for (const v of all) expect(enumVals.has(v)).toBe(true);
    expect(Object.isFrozen(eventService._EVENT_RESOLUTIONS_COMPLETED)).toBe(true);
  });

  test('_validateResolution — the full matrix', () => {
    const v = eventService._validateResolution;
    // defaults
    expect(v(undefined, 'Completed', 'deadline')).toBe('met');
    expect(v('',        'Completed', 'hearing')).toBe('held');
    expect(v(undefined, 'Canceled',  'deadline')).toBe('cancelled');
    expect(v(undefined, 'Scheduled', 'deadline')).toBeNull();
    // explicit, normalized
    expect(v(' MISSED ', 'Completed', 'deadline')).toBe('missed');
    expect(v('moot',     'Completed', 'deadline')).toBe('moot');
    expect(v('moot',     'Canceled',  'deadline')).toBe('moot');
    expect(v('held',     'Completed', null)).toBe('held');          // unmapped kind → 'other'
    // null clears only on Scheduled
    expect(v(null, 'Scheduled', 'deadline')).toBeNull();
    expect(() => v(null, 'Completed', 'deadline')).toThrow(expect.objectContaining({ status: 400 }));
    // wrong kind / wrong status
    expect(() => v('met',    'Completed', 'hearing')).toThrow(expect.objectContaining({ status: 400, message: expect.stringMatching(/allowed: held/) }));
    expect(() => v('moot',   'Canceled',  'hearing')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => v('held',   'Canceled',  'hearing')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => v('missed', 'Canceled',  'deadline')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => v('held',   'Scheduled', 'hearing')).toThrow(expect.objectContaining({ status: 400, message: expect.stringMatching(/Scheduled event cannot carry/) }));
    expect(() => v('bogus',  'Completed', 'deadline')).toThrow(expect.objectContaining({ status: 400 }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('completeEvent', () => {
  test('deadline, no resolution → met, written in the SAME UPDATE, envelope + log carry it', async () => {
    const db = makeEventsDb({ events: [row()] });
    await eventService.completeEvent(db, 42, 5);
    await flush();
    const upd = db.calls.find((c) => /^UPDATE events SET event_status/.test(c.sql));
    expect(upd.sql).toBe("UPDATE events SET event_status = 'Completed', event_resolution = ? WHERE event_id = ?");
    expect(upd.params).toEqual(['met', 42]);
    expect(db.count(/^UPDATE/)).toBe(1);
    expect(db.events.get(42)).toMatchObject({ event_status: 'Completed', event_resolution: 'met' });
    const env = only('calendar.resolved');
    expect(env.data).toMatchObject({ status: 'Completed', state: 'resolved', resolution: 'met' });
    expect(env.extra).toEqual({ via: 'complete', prior_status: 'Scheduled' });
    expect(logService.createLogEntry.mock.calls[0][1].data).toMatchObject({ action: 'completed', resolution: 'met' });
  });

  test('hearing, no resolution → held', async () => {
    const db = makeEventsDb({ events: [row(HEARING)] });
    await eventService.completeEvent(db, 42, 5);
    await flush();
    expect(db.events.get(42).event_resolution).toBe('held');
    expect(only('calendar.resolved').data.resolution).toBe('held');
  });

  test("kind 'other' and NULL kind → held", async () => {
    for (const k of [OTHER, NOKIND]) {
      jest.clearAllMocks();
      const db = makeEventsDb({ events: [row(k)] });
      await eventService.completeEvent(db, 42, 5);
      expect(db.events.get(42).event_resolution).toBe('held');
    }
  });

  test("deadline { resolution:'missed' } (the sweep's call) → missed, source carried", async () => {
    const db = makeEventsDb({ events: [row()] });
    await eventService.completeEvent(db, 42, 0, { resolution: 'missed', source: 'sweep' });
    await flush();
    expect(db.events.get(42).event_resolution).toBe('missed');
    const env = only('calendar.resolved');
    expect(env.source).toBe('sweep');
    expect(env.actor).toEqual({ user_id: 0 });
    expect(env.data.resolution).toBe('missed');
  });

  test("deadline { resolution:'moot' } on complete is allowed (§3.7 deadline vocabulary)", async () => {
    const db = makeEventsDb({ events: [row()] });
    await eventService.completeEvent(db, 42, 0, { resolution: 'moot' });
    expect(db.events.get(42).event_resolution).toBe('moot');
  });

  test("hearing { resolution:'met' } → 400, NOTHING written", async () => {
    const db = makeEventsDb({ events: [row(HEARING)] });
    await expect(eventService.completeEvent(db, 42, 5, { resolution: 'met' }))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/completeEvent: "met" is not a valid Completed resolution for kind "hearing"/) });
    expect(db.count(/^UPDATE/)).toBe(0);
    expect(db.events.get(42).event_status).toBe('Scheduled');
    expect(domainEvents.emit).not.toHaveBeenCalled();
  });

  test("{ resolution:'cancelled' } on complete → 400 (cancel paths only)", async () => {
    const db = makeEventsDb({ events: [row()] });
    await expect(eventService.completeEvent(db, 42, 5, { resolution: 'cancelled' })).rejects.toMatchObject({ status: 400 });
  });

  test('already Completed still throws the plain error, before validation', async () => {
    const db = makeEventsDb({ events: [row({ event_status: 'Completed', event_resolution: 'met' })] });
    await expect(eventService.completeEvent(db, 42, 5)).rejects.toThrow('Event is already Completed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('cancelEvent', () => {
  test('default → cancelled, same UPDATE, envelope carries it', async () => {
    const db = makeEventsDb({ events: [row(HEARING)] });
    await eventService.cancelEvent(db, 42, 5, { delete_gcal: false });
    await flush();
    const upd = db.calls.find((c) => /^UPDATE events SET event_status/.test(c.sql));
    expect(upd.sql).toBe("UPDATE events SET event_status = 'Canceled', event_resolution = ? WHERE event_id = ?");
    expect(upd.params).toEqual(['cancelled', 42]);
    expect(db.events.get(42)).toMatchObject({ event_status: 'Canceled', event_resolution: 'cancelled' });
    const env = only('calendar.cancelled');
    expect(env.data).toMatchObject({ state: 'cancelled', resolution: 'cancelled' });
    expect(env.extra).toEqual({ via: 'cancel', prior_status: 'Scheduled', delete_gcal: false });
    expect(logService.createLogEntry.mock.calls[0][1].data).toMatchObject({ action: 'canceled', resolution: 'cancelled' });
  });

  test("deadline { resolution:'moot' } → moot, and the envelope reads moot", async () => {
    const db = makeEventsDb({ events: [row()] });
    await eventService.cancelEvent(db, 42, 5, { resolution: 'moot' });
    await flush();
    expect(db.events.get(42).event_resolution).toBe('moot');
    expect(only('calendar.cancelled').data.resolution).toBe('moot');
  });

  test("hearing { resolution:'moot' } → 400, nothing written", async () => {
    const db = makeEventsDb({ events: [row(HEARING)] });
    await expect(eventService.cancelEvent(db, 42, 5, { resolution: 'moot' }))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/cancelEvent/) });
    expect(db.count(/^UPDATE/)).toBe(0);
    expect(domainEvents.emit).not.toHaveBeenCalled();
  });

  test("{ resolution:'met' } on cancel → 400", async () => {
    const db = makeEventsDb({ events: [row()] });
    await expect(eventService.cancelEvent(db, 42, 5, { resolution: 'met' })).rejects.toMatchObject({ status: 400 });
  });

  test('cancel from Completed overwrites the completion resolution with cancelled', async () => {
    const db = makeEventsDb({ events: [row({ event_status: 'Completed', event_resolution: 'met' })] });
    await eventService.cancelEvent(db, 42, 5);
    await flush();
    expect(db.events.get(42).event_resolution).toBe('cancelled');
    expect(only('calendar.cancelled').extra.prior_status).toBe('Completed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('updateEvent — event_resolution in the patch', () => {
  const written = (db) => {
    const upd = db.calls.find((c) => /^UPDATE events SET `/.test(c.sql));
    const cols = [...upd.sql.matchAll(/`(\w+)` = \?/g)].map((m) => m[1]);
    const out = {};
    cols.forEach((c, i) => { out[c] = upd.params[i]; });
    return out;
  };

  test('a bare status → Completed on a deadline stamps met in the SAME UPDATE, emits with it', async () => {
    const db = makeEventsDb({ events: [row()] });
    await eventService.updateEvent(db, 42, { event_status: 'Completed' }, 1);
    await flush();
    expect(written(db)).toEqual({ event_status: 'Completed', event_resolution: 'met' });
    expect(db.count(/^UPDATE/)).toBe(1);
    expect(only('calendar.resolved').data.resolution).toBe('met');
  });

  test('a bare status → Canceled stamps cancelled', async () => {
    const db = makeEventsDb({ events: [row(HEARING)] });
    await eventService.updateEvent(db, 42, { event_status: 'Canceled' }, 1);
    await flush();
    expect(written(db)).toEqual({ event_status: 'Canceled', event_resolution: 'cancelled' });
    expect(only('calendar.cancelled').data.resolution).toBe('cancelled');
  });

  test('status + resolution together validate against the POST-update state', async () => {
    const db = makeEventsDb({ events: [row()] });
    await eventService.updateEvent(db, 42, { event_status: 'Completed', event_resolution: 'missed' }, 1);
    await flush();
    expect(written(db)).toEqual({ event_status: 'Completed', event_resolution: 'missed' });
    expect(only('calendar.resolved').data.resolution).toBe('missed');
  });

  test('status + type change together: the resolution validates against the NEW kind', async () => {
    // Row is a deadline; the patch retypes it to a hearing and completes it.
    const db = makeEventsDb({ events: [row()] });
    await expect(eventService.updateEvent(db, 42, { event_type: 'Confirmation Hearing', event_status: 'Completed', event_resolution: 'met' }, 1))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/kind "hearing"/) });
    expect(db.count(/^UPDATE/)).toBe(0);
    // And with no resolution given, the default follows the new kind.
    await eventService.updateEvent(db, 42, { event_type: 'Confirmation Hearing', event_status: 'Completed' }, 1);
    expect(written(db)).toMatchObject({ event_status: 'Completed', event_resolution: 'held', kind: 'hearing' });
  });

  test('correcting the resolution on an already-Completed row (no status move)', async () => {
    const db = makeEventsDb({ events: [row({ event_status: 'Completed', event_resolution: 'met' })] });
    await eventService.updateEvent(db, 42, { event_resolution: 'missed' }, 1);
    await flush();
    expect(written(db)).toEqual({ event_resolution: 'missed' });
    expect(domainEvents.emit).not.toHaveBeenCalled();     // not a transition
  });

  test('a resolution on a row that stays Scheduled → 400, nothing written', async () => {
    const db = makeEventsDb({ events: [row()] });
    await expect(eventService.updateEvent(db, 42, { event_resolution: 'met' }, 1))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Scheduled event cannot carry/) });
    expect(db.count(/^UPDATE/)).toBe(0);
  });

  test('reopen (→ Scheduled) clears the resolution; an explicit null is accepted there', async () => {
    const db = makeEventsDb({ events: [row({ event_status: 'Completed', event_resolution: 'met' })] });
    await eventService.updateEvent(db, 42, { event_status: 'Scheduled' }, 1);
    await flush();
    expect(written(db)).toEqual({ event_status: 'Scheduled', event_resolution: null });
    expect(db.events.get(42).event_resolution).toBeNull();
    expect(only('calendar.scheduled').extra).toEqual({ via: 'update', reopened: true, prior_status: 'Completed' });

    const db2 = makeEventsDb({ events: [row({ event_status: 'Canceled', event_resolution: 'moot' })] });
    await eventService.updateEvent(db2, 42, { event_status: 'Scheduled', event_resolution: null }, 1);
    expect(written(db2)).toEqual({ event_status: 'Scheduled', event_resolution: null });
  });

  test('null on a row that stays Completed → 400', async () => {
    const db = makeEventsDb({ events: [row({ event_status: 'Completed', event_resolution: 'met' })] });
    await expect(eventService.updateEvent(db, 42, { event_resolution: null }, 1)).rejects.toMatchObject({ status: 400 });
  });

  test('re-writing the status it already holds writes no resolution and emits nothing', async () => {
    const db = makeEventsDb({ events: [row()] });
    await eventService.updateEvent(db, 42, { event_status: 'Scheduled', event_note: 'n' }, 1);
    await flush();
    expect(written(db)).toEqual({ event_status: 'Scheduled', event_note: 'n' });
    expect(domainEvents.emit).not.toHaveBeenCalled();
  });

  test('a note-only patch never touches the column', async () => {
    const db = makeEventsDb({ events: [row()] });
    await eventService.updateEvent(db, 42, { event_note: 'n' }, 1);
    expect(written(db)).toEqual({ event_note: 'n' });
  });

  test('superseded_by_event_id / supersede_reason are still NOT patchable', async () => {
    const db = makeEventsDb({ events: [row()] });
    await expect(eventService.updateEvent(db, 42, { superseded_by_event_id: 1 }, 1)).rejects.toThrow(/blocked fields: superseded_by_event_id/);
    await expect(eventService.updateEvent(db, 42, { supersede_reason: 'duplicate' }, 1)).rejects.toThrow(/blocked fields/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('routes/api.events.js — /complete and /cancel pass { resolution }; 400 via err.status', () => {
  jest.mock('../lib/auth.jwtOrApiKey', () => jest.fn((req, res, next) => { req.auth = { userId: 9 }; next(); }));
  const express = require('express');
  const router  = require('../routes/api.events');

  let server, base, db;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use(router);

  beforeAll(async () => {
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => { db = makeEventsDb({ events: [row(), row({ event_id: 43, ...HEARING })] }); });

  const patch = (path, body) => fetch(`${base}${path}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });

  test('PATCH /complete with {} → Completed + default resolution (gate 3 shape)', async () => {
    const res = await patch('/api/events/42/complete', {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ event_status: 'Completed', event_resolution: 'met' });
    const res2 = await patch('/api/events/43/complete', {});
    expect((await res2.json()).data).toMatchObject({ event_status: 'Completed', event_resolution: 'held' });
  });

  test('PATCH /complete with no body at all still works (staff button)', async () => {
    const res = await patch('/api/events/42/complete');
    expect(res.status).toBe(200);
    expect(db.events.get(42).event_resolution).toBe('met');
  });

  test("PATCH /complete { resolution:'missed' } on a deadline", async () => {
    const res = await patch('/api/events/42/complete', { resolution: 'missed' });
    expect(res.status).toBe(200);
    expect(db.events.get(42).event_resolution).toBe('missed');
  });

  test("PATCH /complete { resolution:'met' } on a hearing → 400 with the service message", async () => {
    const res = await patch('/api/events/43/complete', { resolution: 'met' });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/not a valid Completed resolution for kind "hearing"/);
    expect(db.events.get(43).event_status).toBe('Scheduled');
  });

  test("PATCH /cancel { resolution:'moot' } on a deadline; on a hearing → 400; default → cancelled", async () => {
    expect((await patch('/api/events/42/cancel', { resolution: 'moot', delete_gcal: false })).status).toBe(200);
    expect(db.events.get(42).event_resolution).toBe('moot');
    expect((await patch('/api/events/43/cancel', { resolution: 'moot' })).status).toBe(400);
    expect(db.events.get(43).event_status).toBe('Scheduled');
    expect((await patch('/api/events/43/cancel', {})).status).toBe(200);
    expect(db.events.get(43).event_resolution).toBe('cancelled');
  });

  test('the existing 404 / already-* mappings are intact', async () => {
    expect((await patch('/api/events/999/complete', {})).status).toBe(404);
    await patch('/api/events/42/complete', {});
    expect((await patch('/api/events/42/complete', {})).status).toBe(400);   // already Completed
  });

  test("PATCH /api/events/:id { event_status:'Completed', event_resolution:'met' } on a hearing → 400 via err.status", async () => {
    const res = await patch('/api/events/43', { event_status: 'Completed', event_resolution: 'met' });
    expect(res.status).toBe(400);
  });

  test('GET /api/events?include_superseded=1 reaches listEvents as includeSuperseded:true', async () => {
    const spy = jest.spyOn(eventService, 'listEvents').mockResolvedValue({ data: [], total: 0 });
    await fetch(`${base}/api/events?include_superseded=1`);
    expect(spy.mock.calls[0][1].includeSuperseded).toBe(true);
    await fetch(`${base}/api/events`);
    expect(spy.mock.calls[1][1].includeSuperseded).toBe(false);
    spy.mockRestore();
  });
});
