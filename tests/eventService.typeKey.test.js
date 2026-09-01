// tests/eventService.typeKey.test.js
//
/**
 * Unified Events U2 — eventService writes (type_key, kind).
 *
 *   createEvent   (a) known label  (b) known alias / court spelling
 *                 (c) unknown non-blank → type_key NULL, kind 'other'
 *                 (d) blank → both NULL
 *                 (e) given valid type_key wins over the label
 *                 (f) INSERT shape: kind/type_key are the LAST two binds;
 *                     binds 0..13 are exactly what they were before U2
 *   updateEvent   re-resolves on event_type change; validates type_key
 *                 (unknown → Error.status 400, NO UPDATE issued); a key-only
 *                 patch leaves the label alone; kind is never patchable raw.
 *
 * U4 note: lib/domainEvents is mocked below — see the comment there.
 *
 * DB is a SQL-routing stub (no ordered script). The registry cache is PRIMED
 * from the seed fixture (Fred, U2 R1.3) so no registry query hits the stub;
 * the SELECT itself is covered by tests/calendarTypeService.test.js.
 *
 * Run:  npx jest tests/eventService.typeKey.test.js
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
// U4 — eventService now emits calendar.* (v0.5 §3.5). Left unmocked, the real
// emit() would fire an INSERT INTO domain_event_queue at this suite's SQL
// router and land in `unmatched`, which every test here asserts is empty. The
// emits themselves are this file's neighbour's job
// (tests/calendarEvents.event.test.js); here they are noise.
jest.mock('../lib/domainEvents', () => ({
  emit:         jest.fn(() => Promise.resolve()),
  buildChanges: jest.fn(() => ({})),
  runAsAction:  (_ruleId, fn) => fn(),
  MAX_DEPTH:    4,
}));

const eventService        = require('../services/eventService');
const calendarTypeService = require('../services/calendarTypeService');
const SEED                = require('./fixtures/calendar_item_types.seed.json');

// ─────────────────────────────────────────────────────────────────────────────
function makeDb(seedEvents = []) {
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
        event_gcal: null,
      });
      return [{ insertId: id, affectedRows: 1 }];
    }
    if (/joined_case_id/i.test(flat)) {                       // getEvent
      const row = events.get(Number(params[0]));
      return [row ? [{ ...row }] : []];
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
    unmatched.push(flat);
    return [[]];
  };
  return { query, calls, events, unmatched };
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

const BASE = {
  event_title: 'Test',
  event_date:  '2026-10-01',
  event_all_day: 1,
  event_link_type: 'case',
  event_link_id: 'ABCDEFGH',
  skip_gcal: true,
};

const insertOf = (db) => db.calls.find((c) => /^INSERT INTO events/i.test(c.sql));

beforeAll(() => calendarTypeService._primeCache(SEED));
afterAll(() => calendarTypeService.invalidate());
beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  console.log.mockRestore(); console.warn.mockRestore(); console.error.mockRestore();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('createEvent — type_key + kind', () => {
  test('(a) known label → key + kind; event_type written verbatim', async () => {
    const db = makeDb();
    const { event } = await eventService.createEvent(db, { ...BASE, event_type: 'Docs Deadline' });
    await flush();
    expect(event.type_key).toBe('docs_deadline');
    expect(event.kind).toBe('deadline');
    expect(event.event_type).toBe('Docs Deadline');
    expect(db.unmatched).toEqual([]);
  });

  test("(b) court spelling 'confirmation_hearing' (key form) and alias 'Court Date' both resolve; label untouched", async () => {
    const db = makeDb();
    const a = await eventService.createEvent(db, { ...BASE, event_type: 'confirmation_hearing' });
    const b = await eventService.createEvent(db, { ...BASE, event_type: 'Court Date' });
    await flush();
    expect([a.event.type_key, a.event.kind, a.event.event_type]).toEqual(['confirmation_hearing', 'hearing', 'confirmation_hearing']);
    expect([b.event.type_key, b.event.kind, b.event.event_type]).toEqual(['hearing', 'hearing', 'Court Date']);
  });

  test("(c) unknown non-blank → type_key NULL, kind 'other' (raw passthrough, findable)", async () => {
    const db = makeDb();
    const { event } = await eventService.createEvent(db, { ...BASE, event_type: 'Mediation' });
    await flush();
    expect(event.type_key).toBeNull();
    expect(event.kind).toBe('other');
    expect(event.event_type).toBe('Mediation');
  });

  test('(d) blank / null event_type → both NULL', async () => {
    const db = makeDb();
    const n = await eventService.createEvent(db, { ...BASE, event_type: null });
    const b = await eventService.createEvent(db, { ...BASE, event_type: '   ' });
    await flush();
    expect([n.event.type_key, n.event.kind]).toEqual([null, null]);
    expect([b.event.type_key, b.event.kind]).toEqual([null, null]);
  });

  test('(e) a given VALID type_key wins over the label; an unknown given key falls back to the label', async () => {
    const db = makeDb();
    const a = await eventService.createEvent(db, { ...BASE, event_type: 'Hearing', type_key: 'show_cause' });
    const b = await eventService.createEvent(db, { ...BASE, event_type: 'Hearing', type_key: 'bogus' });
    await flush();
    expect([a.event.type_key, a.event.kind, a.event.event_type]).toEqual(['show_cause', 'hearing', 'Hearing']);
    expect([b.event.type_key, b.event.kind]).toEqual(['hearing', 'hearing']);
  });

  test('(f) INSERT shape: kind and type_key are the LAST two bound columns; binds 0..13 unchanged', async () => {
    const db = makeDb();
    await eventService.createEvent(db, {
      ...BASE, event_type: 'Show Cause', event_all_day: 0, event_time: '14:00', event_length: 30,
      event_with: 1, acting_user_id: 7, event_location: 'Rm 1', event_link: 'http://x', event_note: 'n',
      event_calendar_id: 'cal',
    });
    await flush();
    const ins = insertOf(db);
    const cols = /\(([^)]*)\)\s*VALUES/i.exec(ins.sql)[1].split(',').map((s) => s.trim());
    expect(cols.slice(-2)).toEqual(['kind', 'type_key']);
    expect(cols.slice(0, 16)).toEqual([
      'event_type', 'event_link_type', 'event_link_id', 'event_title', 'event_date',
      'event_time', 'event_all_day', 'event_length', 'event_location', 'event_link',
      'event_note', 'event_status', 'event_calendar_id', 'event_with', 'event_create_date', 'event_created_by',
    ]);
    const placeholders = (/VALUES\s*\(([\s\S]*)\)\s*$/i.exec(ins.sql)[1].match(/\?/g) || []).length;
    expect(ins.params).toHaveLength(placeholders);
    expect(ins.params).toHaveLength(16);
    expect(ins.params.slice(0, 14)).toEqual([
      'Show Cause', 'case', 'ABCDEFGH', 'Test', '2026-10-01', '14:00:00', 0, 30, 'Rm 1', 'http://x', 'n', 'cal', 1, 7,
    ]);
    expect(ins.params.slice(14)).toEqual(['hearing', 'show_cause']);
  });

  test('a registry read failure does not fail the create (fail-soft) — key NULL, kind other', async () => {
    calendarTypeService.invalidate();
    const db = makeDb();
    const origQuery = db.query;
    db.query = async (sql, params) => {
      if (/FROM calendar_item_types/.test(sql)) throw new Error('ER_NO_SUCH_TABLE');
      return origQuery(sql, params);
    };
    const { event } = await eventService.createEvent(db, { ...BASE, event_type: 'Docs Deadline' });
    await flush();
    expect(event.type_key).toBeNull();
    expect(event.kind).toBe('other');
    calendarTypeService._primeCache(SEED);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('updateEvent — type_key + kind', () => {
  const seed = () => [{
    event_id: 42, event_type: 'Docs Deadline', kind: 'deadline', type_key: 'docs_deadline',
    event_link_type: 'case', event_link_id: 'ABCDEFGH', event_title: 'T', event_date: '2026-10-01',
    event_time: null, event_all_day: 1, event_length: null, event_with: null, event_gcal: null,
    event_calendar_id: null,
  }];

  test('event_type change re-resolves type_key AND kind', async () => {
    const db = makeDb(seed());
    const { event } = await eventService.updateEvent(db, 42, { event_type: 'Show Cause' }, 1);
    await flush();
    expect([event.event_type, event.type_key, event.kind]).toEqual(['Show Cause', 'show_cause', 'hearing']);
    const upd = db.calls.find((c) => /^UPDATE events SET/.test(c.sql) && !/event_gcal/.test(c.sql));
    expect(upd.sql).toMatch(/`type_key` = \?/);
    expect(upd.sql).toMatch(/`kind` = \?/);
  });

  test("event_type change to an unknown label → type_key NULL, kind 'other'", async () => {
    const db = makeDb(seed());
    const { event } = await eventService.updateEvent(db, 42, { event_type: 'Mediation' }, 1);
    expect([event.type_key, event.kind]).toEqual([null, 'other']);
  });

  test('type_key-only patch: key + kind written, label left ALONE (label is display, key is truth)', async () => {
    const db = makeDb(seed());
    const { event } = await eventService.updateEvent(db, 42, { type_key: 'schedules_deadline' }, 1);
    expect([event.event_type, event.type_key, event.kind]).toEqual(['Docs Deadline', 'schedules_deadline', 'deadline']);
  });

  test('type_key + event_type together: the key is validated and used; the label written as given', async () => {
    const db = makeDb(seed());
    const { event } = await eventService.updateEvent(db, 42, { type_key: 'confirmation_hearing', event_type: 'Confirmation Hearing' }, 1);
    expect([event.event_type, event.type_key, event.kind]).toEqual(['Confirmation Hearing', 'confirmation_hearing', 'hearing']);
  });

  test('unknown type_key → Error with status 400 and NO UPDATE issued', async () => {
    const db = makeDb(seed());
    await expect(eventService.updateEvent(db, 42, { type_key: 'bogus' }, 1))
      .rejects.toMatchObject({ status: 400, message: 'updateEvent: unknown type_key "bogus"' });
    expect(db.calls.some((c) => /^UPDATE events/.test(c.sql))).toBe(false);
    expect(db.events.get(42).type_key).toBe('docs_deadline');
  });

  test('blank type_key = re-derive from the existing label', async () => {
    const db = makeDb(seed());
    db.events.get(42).type_key = null;   // a straggler
    const { event } = await eventService.updateEvent(db, 42, { type_key: '' }, 1);
    expect([event.type_key, event.kind]).toEqual(['docs_deadline', 'deadline']);
  });

  test('kind cannot be patched raw (not in UPDATE_ALLOWED)', async () => {
    const db = makeDb(seed());
    await expect(eventService.updateEvent(db, 42, { kind: 'hearing' }, 1))
      .rejects.toThrow(/blocked fields: kind/);
  });

  test('a patch without type fields writes neither key nor kind', async () => {
    const db = makeDb(seed());
    await eventService.updateEvent(db, 42, { event_location: 'Rm 2' }, 1);
    const upd = db.calls.find((c) => /^UPDATE events SET/.test(c.sql));
    expect(upd.sql).not.toMatch(/type_key|kind/);
  });
});
