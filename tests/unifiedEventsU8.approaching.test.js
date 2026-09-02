// tests/unifiedEventsU8.approaching.test.js
//
/**
 * Unified Events U8 — `calendar.approaching` (v0.5 §3.2, amendment A6).
 *
 * A6 turns a reminder into two things that already exist: a synthetic EVENT
 * (emitted here) and a TRIGGER RULE that decides what it does. So this suite
 * tests exactly one question — DOES THE RIGHT EVENT FIRE, ONCE — and leaves
 * "what a reminder is" to the rule engine's own suites.
 *
 * Four things must hold, and each has bitten a comparable emitter before:
 *
 *   1. NOTHING FIRES UNTIL SOMEBODY CONFIGURES IT. `approaching_offsets` ships
 *      NULL on all 34 rows. With none set, the job must not read `events` or
 *      `appts` at all — the acceptance bar for the slice is zero emissions at
 *      deploy, and "it emitted nothing because the tables happened to be
 *      empty" is not the same claim.
 *
 *   2. EXACTLY ONCE PER (item, rung, date) — and `item_date` is in that key on
 *      purpose. `updateEvent` moves a date IN PLACE (§3.5: that is a
 *      reschedule, not a supersession), so the same event_id legitimately
 *      needs its rungs again against the new date. The claim table's PK makes
 *      the stale claim self-invalidating; the tests below prove both halves —
 *      a re-run claims nothing, a moved date re-arms everything.
 *
 *   3. THE PAST BELONGS TO THE SWEEP. `sweep_calendar_missed` (U6a) owns
 *      past-dated deadlines. This emitter's window starts at firm-local today,
 *      so the two can never both act on one row.
 *
 *   4. THE ENVELOPE IS THE OTHER FOUR calendar.* NAMES' ENVELOPE. Same
 *      set-equality drift guard U4 shipped, applied to the fifth name: the
 *      catalog publishes exactly the `data.*` keys the emitter's own envelope
 *      builder produces, in both source flavours. A key the envelope carries
 *      and the catalog omits is invisible to a rule author; a key the catalog
 *      lists and no envelope produces is a filter that silently matches
 *      nothing.
 *
 * THE DB STUB executes the real SQL by statement shape (the u6aEventsDb
 * idiom) rather than replaying a positional script, so a predicate that goes
 * missing from a query fails a test here instead of silently widening a live
 * read. Unrecognised SQL throws with the flattened statement.
 *
 * Run:  npx jest tests/unifiedEventsU8.approaching.test.js
 */

'use strict';

jest.mock('../lib/domainEvents', () => ({
  emit: jest.fn(() => Promise.resolve()),
  buildEnvelope: jest.requireActual('../lib/domainEvents').buildEnvelope,
  buildChanges: jest.fn(() => ({})),
  runAsAction: (_r, fn) => fn(),
  MAX_DEPTH: 4,
}));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => ({})) }));

const { DateTime }    = require('luxon');
const fns             = require('../lib/internal_functions/events');
const domainEvents    = require('../lib/domainEvents');
const { alert }       = require('../lib/alerting');
const { EVENT_TYPES } = require('../services/triggerService');
const { FIRM_TZ }     = require('../services/timezoneService');

const emit = fns.emit_calendar_approaching;

const TODAY = DateTime.now().setZone(FIRM_TZ).toFormat('yyyy-MM-dd');
const day   = (n) => DateTime.now().setZone(FIRM_TZ).plus({ days: n }).toFormat('yyyy-MM-dd');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** A registry row carrying offsets. */
const type = (type_key, offsets, kind = 'deadline') => ({ type_key, kind, approaching_offsets: offsets });

const ev = (event_id, event_date, o = {}) => ({
  event_id, event_type: 'Schedules Deadline', kind: 'deadline', type_key: 'schedules_deadline',
  event_link_type: 'case', event_link_id: 'ABCDEFGH',
  event_date, event_time: null, event_all_day: 1, event_length: null,
  event_status: 'Scheduled', event_resolution: null, event_with: null,
  superseded_by_event_id: null, ...o,
});

const ap = (appt_id, appt_date, o = {}) => ({
  appt_id, appt_client_id: 77, appt_case_id: 'ABCDEFGH',
  appt_link_type: 'case', appt_link_id: 'ABCDEFGH',
  appt_type: '341 Meeting', type_key: 'meeting_341', appt_length: 10,
  appt_date: `${appt_date} 14:00:00`, appt_status: 'Scheduled', appt_with: 1,
  rescheduled_from_appt_id: null, ...o,
});

/**
 * In-memory `calendar_item_types` / `events` / `appts` /
 * `calendar_approaching_emitted`, dispatching on statement shape.
 *
 * `claims` really enforces the four-column PRIMARY KEY, because that key IS
 * the feature: a duplicate returns affectedRows 0 (INSERT IGNORE semantics),
 * and a different item_date is a different row.
 */
function makeDb({ types = [], events = [], appts = [], claims = [] } = {}) {
  const calls = [];
  const claimed = new Set(claims.map((c) => c.join('\u0000')));
  const claimLog = [];

  const between = (d, lo, hi) => d >= lo && d <= hi;

  const query = async (sql, params = []) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    calls.push({ sql: flat, params: [...params] });

    // ── registry ─────────────────────────────────────────────────────────
    if (/^SELECT type_key, approaching_offsets FROM calendar_item_types WHERE approaching_offsets IS NOT NULL$/i.test(flat)) {
      return [types.map((t) => ({ type_key: t.type_key, approaching_offsets: t.approaching_offsets }))];
    }

    // ── events population ────────────────────────────────────────────────
    if (/FROM events e WHERE e\.event_status = 'Scheduled'/i.test(flat)) {
      const keys = params[0], lo = params[1], hi = params[2];
      const hasPtr = /e\.superseded_by_event_id IS NULL/.test(flat);
      const rows = events
        .filter((e) => e.event_status === 'Scheduled'
                    && (!hasPtr || e.superseded_by_event_id == null)
                    && keys.includes(e.type_key)
                    && between(e.event_date, lo, hi))
        .sort((a, b) => (a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : a.event_id - b.event_id));
      return [rows.map((e) => ({ ...e, item_date: e.event_date, resolved_case_id: null }))];
    }

    // ── appts population ─────────────────────────────────────────────────
    if (/FROM appts a WHERE a\.appt_status = 'Scheduled'/i.test(flat)) {
      const keys = params[0], lo = params[1], hi = params[2];
      const rows = appts
        .filter((a) => a.appt_status === 'Scheduled'
                    && keys.includes(a.type_key)
                    && a.appt_date >= lo && a.appt_date < hi)
        .sort((a, b) => (a.appt_date < b.appt_date ? -1 : a.appt_date > b.appt_date ? 1 : a.appt_id - b.appt_id));
      return [rows.map((a) => ({ ...a, item_date: String(a.appt_date).slice(0, 10) }))];
    }

    // ── dry-run claim read ───────────────────────────────────────────────
    if (/^SELECT source, source_id, offset_days.*FROM calendar_approaching_emitted WHERE item_date BETWEEN \? AND \?$/i.test(flat)) {
      const [lo, hi] = params;
      return [[...claimed].map((k) => k.split('\u0000'))
        .filter((c) => between(c[3], lo, hi))
        .map((c) => ({ source: c[0], source_id: Number(c[1]), offset_days: Number(c[2]), item_date: c[3] }))];
    }

    // ── claim ────────────────────────────────────────────────────────────
    if (/^INSERT IGNORE INTO calendar_approaching_emitted/i.test(flat)) {
      const k = params.slice(0, 4).join('\u0000');
      claimLog.push(params.slice(0, 4));
      if (claimed.has(k)) return [{ affectedRows: 0 }];   // PK collision
      claimed.add(k);
      return [{ affectedRows: 1 }];
    }

    throw new Error(`makeDb: unscripted SQL: ${flat.slice(0, 160)}`);
  };

  return { query, calls, claimLog, claimed,
           count: (re) => calls.filter((c) => re.test(c.sql)).length };
}

const emissions = () => domainEvents.emit.mock.calls
  .filter((c) => c[1] === 'calendar.approaching')
  .map((c) => c[2]);

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => console.log.mockRestore());

// ─────────────────────────────────────────────────────────────────────────────
// 1. Nothing configured → nothing scanned  (the acceptance bar)
// ─────────────────────────────────────────────────────────────────────────────

describe('zero emissions at deploy', () => {
  test('no type carries offsets → one registry read, no population query, no emits', async () => {
    const db = makeDb({ types: [], events: [ev(1, day(1))], appts: [ap(9, day(1))] });
    const { output } = await emit({}, db);

    expect(output).toMatchObject({ scanned: 0, emitted: 0, claimed: 0, types_configured: 0, today: TODAY });
    expect(db.calls).toHaveLength(1);                       // the registry, and only the registry
    expect(db.count(/FROM events|FROM appts/)).toBe(0);
    expect(domainEvents.emit).not.toHaveBeenCalled();
  });

  test('a type whose offsets are NULL / [] / all-junk counts as unconfigured', async () => {
    for (const offsets of [null, [], '[]', 'not json', [999], ['soon'], [-4], [1.5]]) {
      const db = makeDb({ types: [type('schedules_deadline', offsets)], events: [ev(1, day(1))] });
      const { output } = await emit({}, db);
      expect(output.types_configured).toBe(0);
      expect(db.calls).toHaveLength(1);
    }
  });

  test('junk MIXED WITH a good offset disarms only the junk — the type still reminds', async () => {
    // Unattended job, human-edited data: one bad element must not silently
    // take a type's reminders offline (nor take the job down).
    const db = makeDb({ types: [type('schedules_deadline', [7, 999, 'x', 7])], events: [ev(1, day(7))] });
    const { output } = await emit({}, db);
    expect(output.types_configured).toBe(1);
    expect(output.max_offset).toBe(7);
    expect(output.emitted).toBe(1);
    expect(emissions()[0].data.offset_days).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The rung boundary
// ─────────────────────────────────────────────────────────────────────────────

describe('which rungs are due', () => {
  test('fires the day the rung arrives, not before', async () => {
    const db = makeDb({
      types: [type('schedules_deadline', [7])],
      events: [ev(1, day(8)), ev(2, day(7)), ev(3, day(6))],
    });
    const { output } = await emit({}, db);
    // day(8) is outside the horizon entirely; day(7) is the boundary — it
    // fires; day(6) is past its rung and fires as catch-up.
    expect(output.scanned).toBe(2);
    expect(emissions().map((e) => e.data.source_id).sort()).toEqual([2, 3]);
    expect(emissions().find((e) => e.data.source_id === 2).data.days_until).toBe(7);
    expect(emissions().find((e) => e.data.source_id === 3).data.days_until).toBe(6);
  });

  test('offset 0 = the day itself; today is firm-local, never CURDATE()', async () => {
    const db = makeDb({ types: [type('schedules_deadline', [0])], events: [ev(1, TODAY), ev(2, day(1))] });
    const { output } = await emit({}, db);
    expect(output.emitted).toBe(1);
    expect(emissions()[0].data).toMatchObject({ source_id: 1, offset_days: 0, days_until: 0 });
    const pop = db.calls.find((c) => /FROM events/.test(c.sql));
    expect(pop.sql).not.toMatch(/CURDATE/i);
    expect(pop.params).toEqual([['schedules_deadline'], TODAY, TODAY]);
  });

  test('THE PAST IS THE SWEEP\u2019S — a past-dated item is not in the window at all', async () => {
    const db = makeDb({ types: [type('schedules_deadline', [7, 1])], events: [ev(1, day(-1)), ev(2, day(-30))] });
    const { output } = await emit({}, db);
    expect(output).toMatchObject({ scanned: 0, emitted: 0 });
    const pop = db.calls.find((c) => /FROM events/.test(c.sql));
    expect(pop.params[1]).toBe(TODAY);                       // lower bound is today, not "any"
  });

  test('the horizon is max(offsets) across ALL configured types, not per type', async () => {
    const db = makeDb({
      types: [type('schedules_deadline', [1]), type('confirmation_hearing', [30], 'hearing')],
      events: [ev(1, day(25), { type_key: 'confirmation_hearing', kind: 'hearing' }), ev(2, day(25))],
    });
    const { output } = await emit({}, db);
    expect(output.max_offset).toBe(30);
    expect(output.horizon).toBe(day(30));
    expect(output.scanned).toBe(2);                          // both in the window …
    expect(output.emitted).toBe(1);                          // … only the hearing has a rung due
    expect(emissions()[0].data.source_id).toBe(1);
  });

  test('multi-rung catch-up: every passed rung fires, smallest offset first under the cap', async () => {
    const db = makeDb({ types: [type('schedules_deadline', [1, 7, 30])], events: [ev(1, day(3))] });
    const { output } = await emit({}, db);
    expect(output).toMatchObject({ pairs_due: 2, emitted: 2 });   // 7 and 30 passed; 1 has not
    expect(emissions().map((e) => e.data.offset_days)).toEqual([7, 30]);
    expect(emissions().every((e) => e.data.days_until === 3)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Population predicates
// ─────────────────────────────────────────────────────────────────────────────

describe('population', () => {
  test('events: superseded and non-Scheduled rows are excluded', async () => {
    const db = makeDb({
      types: [type('schedules_deadline', [7])],
      events: [
        ev(1, day(2)),
        ev(2, day(2), { superseded_by_event_id: 99, supersede_reason: 'rescheduled' }),  // §3.4: pointer, still "Scheduled"
        ev(3, day(2), { event_status: 'Completed', event_resolution: 'met' }),
        ev(4, day(2), { event_status: 'Canceled',  event_resolution: 'cancelled' }),
      ],
    });
    const { output } = await emit({}, db);
    expect(output.scanned).toBe(1);
    expect(emissions().map((e) => e.data.source_id)).toEqual([1]);
    const pop = db.calls.find((c) => /FROM events/.test(c.sql));
    expect(pop.sql).toMatch(/e\.event_status = 'Scheduled'/);
    expect(pop.sql).toMatch(/e\.superseded_by_event_id IS NULL/);
  });

  test('appts: Rescheduled / Canceled / Attended / No Show are excluded', async () => {
    const db = makeDb({
      types: [type('meeting_341', [7], 'meeting')],
      appts: [
        ap(1, day(2)),
        ap(2, day(2), { appt_status: 'Rescheduled' }),   // §3.4 tombstone
        ap(3, day(2), { appt_status: 'Canceled' }),
        ap(4, day(2), { appt_status: 'Attended' }),
        ap(5, day(2), { appt_status: 'No Show' }),
      ],
    });
    const { output } = await emit({}, db);
    expect(output.scanned).toBe(1);
    expect(emissions().map((e) => e.data.source_id)).toEqual([1]);
    // sargable half-open datetime bounds, not DATE(appt_date) BETWEEN …
    const pop = db.calls.find((c) => /FROM appts/.test(c.sql));
    expect(pop.sql).toMatch(/a\.appt_date >= \? AND a\.appt_date < \?/);
    expect(pop.sql).not.toMatch(/DATE\(a\.appt_date\)/);
    expect(pop.params.slice(1)).toEqual([`${TODAY} 00:00:00`, `${day(8)} 00:00:00`]);
  });

  test('BOTH tables get the FULL key set — kind does not split the query', async () => {
    // §3.3.2 routes storage by kind at WRITE time, but interim kind='meeting'
    // 341 EVENT rows exist pending A3. Splitting the key sets by kind would
    // make those silently unremindable.
    const db = makeDb({ types: [type('schedules_deadline', [7]), type('meeting_341', [7], 'meeting')] });
    await emit({}, db);
    const evPop = db.calls.find((c) => /FROM events/.test(c.sql));
    const apPop = db.calls.find((c) => /FROM appts/.test(c.sql));
    expect(evPop.params[0].sort()).toEqual(['meeting_341', 'schedules_deadline']);
    expect(apPop.params[0].sort()).toEqual(['meeting_341', 'schedules_deadline']);
  });

  test('a type with no offsets is not in the key set, so its items never load', async () => {
    const db = makeDb({
      types: [type('schedules_deadline', [7])],
      events: [ev(1, day(2)), ev(2, day(2), { type_key: 'docs_deadline' })],
    });
    const { output } = await emit({}, db);
    expect(output.scanned).toBe(1);
    expect(db.calls.find((c) => /FROM events/.test(c.sql)).params[0]).toEqual(['schedules_deadline']);
  });

  test('both sources are merged soonest-first so the cap truncates the least urgent', async () => {
    const db = makeDb({
      types: [type('schedules_deadline', [30]), type('meeting_341', [30], 'meeting')],
      events: [ev(1, day(5))],
      appts:  [ap(9, day(2))],
    });
    await emit({}, db);
    expect(emissions().map((e) => `${e.data.source}:${e.data.source_id}`)).toEqual(['appt:9', 'event:1']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The claim table — the reason item_date is in the key
// ─────────────────────────────────────────────────────────────────────────────

describe('claims: exactly once per (source, id, offset, date)', () => {
  test('claim then emit, in that order, with the PK columns bound', async () => {
    const db = makeDb({ types: [type('schedules_deadline', [7])], events: [ev(42, day(3))] });
    await emit({}, db);
    expect(db.claimLog).toEqual([['event', 42, 7, day(3)]]);
    const ins = db.calls.find((c) => /INSERT IGNORE/.test(c.sql));
    expect(ins.sql).toMatch(/INSERT IGNORE INTO calendar_approaching_emitted \(source, source_id, offset_days, item_date\)/);
    // INSERT IGNORE, never ODKU: under mysql2's CLIENT_FOUND_ROWS default an
    // ODKU reports affectedRows=1 for a no-change duplicate too, and every
    // rung would look freshly claimed forever.
    expect(ins.sql).not.toMatch(/ON DUPLICATE KEY/i);
  });

  test('a second run claims nothing and emits nothing (idempotent)', async () => {
    const seed = { types: [type('schedules_deadline', [7, 1])], events: [ev(42, day(3))] };
    const first = makeDb(seed);
    const r1 = await emit({}, first);
    expect(r1.output).toMatchObject({ claimed: 1, emitted: 1, duplicates: 0 });

    const second = makeDb({ ...seed, claims: [...first.claimed].map((k) => k.split('\u0000')) });
    jest.clearAllMocks();
    const r2 = await emit({}, second);
    expect(r2.output).toMatchObject({ claimed: 0, emitted: 0, duplicates: 1, pairs_due: 1 });
    expect(domainEvents.emit).not.toHaveBeenCalled();
  });

  test('MOVING THE DATE RE-ARMS EVERY RUNG — the stale claim self-invalidates', async () => {
    // updateEvent with a new event_date is a reschedule IN PLACE (§3.5), so
    // event 42 keeps its id. Its old claim is keyed to the old date and can
    // never suppress the new one — no cleanup job, no UPDATE.
    const oldDate = day(3), newDate = day(20);
    const db = makeDb({
      types:  [type('schedules_deadline', [7, 1])],
      events: [ev(42, newDate)],
      claims: [['event', 42, 7, oldDate], ['event', 42, 1, oldDate]],
    });
    const { output } = await emit({}, db);
    expect(output).toMatchObject({ duplicates: 0, claimed: 0, emitted: 0 });   // 20 days out: no rung due yet

    // …and when the new date's 7-day mark arrives, it claims cleanly.
    const later = makeDb({
      types:  [type('schedules_deadline', [7, 1])],
      events: [ev(42, day(5))],
      claims: [['event', 42, 7, oldDate], ['event', 42, 1, oldDate]],
    });
    const r = await emit({}, later);
    expect(r.output).toMatchObject({ claimed: 1, emitted: 1, duplicates: 0 });
    expect(later.claimLog).toEqual([['event', 42, 7, day(5)]]);
  });

  test('moving a date BACK to a previously-claimed value stays claimed (that rung did fire)', async () => {
    const db = makeDb({
      types:  [type('schedules_deadline', [7])],
      events: [ev(42, day(3))],
      claims: [['event', 42, 7, day(3)]],
    });
    const { output } = await emit({}, db);
    expect(output).toMatchObject({ duplicates: 1, emitted: 0 });
  });

  test('an appt and an event sharing an id are different claims', async () => {
    const db = makeDb({
      types:  [type('schedules_deadline', [7]), type('meeting_341', [7], 'meeting')],
      events: [ev(7, day(2))],
      appts:  [ap(7, day(2))],
    });
    const { output } = await emit({}, db);
    expect(output.emitted).toBe(2);
    expect(db.claimLog.map((c) => c[0]).sort()).toEqual(['appt', 'event']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Bounds and dry run
// ─────────────────────────────────────────────────────────────────────────────

describe('bounds', () => {
  const many = (n, d) => Array.from({ length: n }, (_, i) => ev(i + 1, d));

  test('max_emits stops BEFORE claiming; the remainder stays claimable', async () => {
    const db = makeDb({ types: [type('schedules_deadline', [7])], events: many(5, day(2)) });
    const { output } = await emit({ max_emits: 2 }, db);
    expect(output).toMatchObject({ scanned: 5, pairs_due: 5, emitted: 2, claimed: 2, skipped_capped: 3, capped: true });
    expect(db.claimLog).toHaveLength(2);                     // nothing claimed past the cap
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1]).toMatchObject({ kind: 'calendar_approaching_cap', severity: 'warning' });
  });

  test('the wall-clock bound stops the same way', async () => {
    const db = makeDb({ types: [type('schedules_deadline', [7])], events: many(4, day(2)) });

    // DETERMINISTIC CLOCK, not `max_runtime_ms: 1`. The bound is checked after
    // three setup queries that all resolve from memory, so on a fast machine
    // Date.now() has not advanced at all by the first check and the bound
    // silently does not fire — a coin-flip test that passes locally and fails
    // in CI (observed: ~1 run in 3). Real time until the population is loaded,
    // then a jump past any bound; `today` is still computed from real time, so
    // no date arithmetic moves under the test.
    const realNow = Date.now.bind(Date);
    let elapsed = 0;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + elapsed);
    const inner = db.query;
    db.query = async (sql, params) => {
      const out = await inner(sql, params);
      if (/FROM appts/.test(String(sql))) elapsed = 60_000;   // both populations in hand
      return out;
    };

    try {
      const { output } = await emit({ max_runtime_ms: 1000 }, db);
      expect(output).toMatchObject({ timed_out: true, capped: false, emitted: 0, claimed: 0, skipped_capped: 4 });
      expect(db.claimLog).toEqual([]);                        // stopped BEFORE claiming
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0][1].message).toMatch(/wall-clock bound/);
    } finally {
      clock.mockRestore();
    }
  });

  test('a real run does not read the claim ledger — the INSERT IGNORE is the check', async () => {
    const db = makeDb({ types: [type('schedules_deadline', [7])], events: many(2, day(2)) });
    await emit({}, db);
    expect(db.count(/^SELECT source, source_id, offset_days/)).toBe(0);
  });

  test('a clean run raises no alert', async () => {
    const db = makeDb({ types: [type('schedules_deadline', [7])], events: many(3, day(2)) });
    const { output } = await emit({}, db);
    expect(output).toMatchObject({ emitted: 3, capped: false, timed_out: false, skipped_capped: 0 });
    expect(alert).not.toHaveBeenCalled();
  });
});

describe('dry run', () => {
  test('claims nothing, emits nothing, and reports what it would have done — uncapped', async () => {
    const db = makeDb({
      types:  [type('schedules_deadline', [7, 1])],
      events: [ev(1, day(3))],
      appts:  [],
    });
    const { output } = await emit({ dry_run: true, max_emits: 1 }, db);

    expect(output).toMatchObject({ dry_run: true, claimed: 0, emitted: 0, pairs_due: 1, capped: false });
    expect(output.would_emit).toEqual([
      { source: 'event', source_id: 1, type_key: 'schedules_deadline', item_date: day(3), offset_days: 7, days_until: 3 },
    ]);
    expect(db.count(/INSERT IGNORE/)).toBe(0);
    expect(domainEvents.emit).not.toHaveBeenCalled();
  });

  test('dry_run accepts the string forms placeholder resolution produces', async () => {
    const seed = { types: [type('schedules_deadline', [7])], events: [ev(1, day(3))] };
    for (const [v, isDry] of [['true', true], [true, true], ['1', true], ['false', false], [false, false], ['', false]]) {
      jest.clearAllMocks();
      const db = makeDb(seed);
      const { output } = await emit({ dry_run: v }, db);
      expect(output.dry_run).toBe(isDry);
      expect(output.emitted).toBe(isDry ? 0 : 1);
    }
  });

  test('it reads the claim ledger, so a rung already emitted counts as a duplicate, not a would-emit', async () => {
    // The moment somebody runs a dry run is usually AFTER the job has been
    // live for a while. Listing every rung it already fired would read as a
    // pending stampede.
    const db = makeDb({
      types:  [type('schedules_deadline', [7, 1])],
      events: [ev(1, day(3)), ev(2, day(3))],
      claims: [['event', 1, 7, day(3)]],
    });
    const { output } = await emit({ dry_run: true }, db);
    expect(output).toMatchObject({ pairs_due: 2, duplicates: 1, claimed: 0, emitted: 0 });
    expect(output.would_emit).toEqual([
      { source: 'event', source_id: 2, type_key: 'schedules_deadline', item_date: day(3), offset_days: 7, days_until: 3 },
    ]);
    expect(db.count(/INSERT IGNORE/)).toBe(0);
  });

  test('a non-dry run carries no would_emit key at all', async () => {
    const db = makeDb({ types: [type('schedules_deadline', [7])], events: [ev(1, day(3))] });
    const { output } = await emit({}, db);
    expect(output).not.toHaveProperty('would_emit');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The envelope, and the catalog that describes it
// ─────────────────────────────────────────────────────────────────────────────

const ENVELOPE = fns.emit_calendar_approaching._envelope;

const APPT_ROW = {
  appt_id: 3001, appt_client_id: 77, appt_case_id: 'ABCDEFGH',
  appt_type: '341 Meeting', type_key: 'meeting_341', appt_length: 30,
  appt_date: '2026-10-01 14:00:00', appt_status: 'Scheduled', appt_with: 1,
  rescheduled_from_appt_id: 3000,
  appt_manage_token: 'deadbeefdeadbeefdeadbeefdeadbeef',   // must never surface
};
const EVENT_ROW = {
  event_id: 4001, event_type: 'Confirmation Hearing', kind: 'hearing',
  type_key: 'confirmation_hearing', event_link_type: 'case_number',
  event_link_id: '26-48953', resolved_case_id: 'ABCDEFGH',
  event_date: '2026-10-01', event_time: '10:00:00', event_all_day: 0,
  event_length: 60, event_status: 'Scheduled', event_resolution: null,
  event_with: 2, superseded_by_event_id: null,
};

const apptEnv  = () => ENVELOPE({ source: 'appt',  row: APPT_ROW  }, 7, 3);
const eventEnv = () => ENVELOPE({ source: 'event', row: EVENT_ROW }, 1, 0);

const dataPaths   = (e) => new Set(Object.keys(e.data).map((k) => `data.${k}`));
const catalogData = new Set(EVENT_TYPES['calendar.approaching'].fields
  .map((f) => f.path).filter((p) => p.startsWith('data.')));
const sorted = (s) => [...s].sort();

describe('the calendar.approaching envelope', () => {
  test('it IS the shared calendar envelope, from whichever service owns the row', () => {
    expect(apptEnv().data).toMatchObject({
      source: 'appt', source_id: 3001, type_key: 'meeting_341', kind: 'meeting',
      label: '341 Meeting', starts_at: '2026-10-01 14:00', all_day: false,
      state: 'live', resolution: null, link_type: 'case', link_id: 'ABCDEFGH',
    });
    expect(eventEnv().data).toMatchObject({
      source: 'event', source_id: 4001, type_key: 'confirmation_hearing', kind: 'hearing',
      starts_at: '2026-10-01 10:00', all_day: false, state: 'live',
      link_type: 'case_number', link_id: '26-48953', docket: '26-48953',
    });
    expect(eventEnv().case_id).toBe('ABCDEFGH');            // docket resolved
  });

  test('source is system, actor 0, extra.via names the emitter', () => {
    for (const e of [apptEnv(), eventEnv()]) {
      expect(e.source).toBe('system');
      expect(e.actor).toEqual({ user_id: 0 });
      expect(e.extra).toEqual({ via: 'approaching_emitter' });
    }
  });

  test('offset_days and days_until are the two paths this event adds', () => {
    expect(apptEnv().data).toMatchObject({ offset_days: 7, days_until: 3 });
    expect(eventEnv().data).toMatchObject({ offset_days: 1, days_until: 0 });
  });

  test('THE DRIFT GUARD — the catalog publishes exactly the data.* keys the envelope carries', () => {
    const produced = new Set([...dataPaths(apptEnv()), ...dataPaths(eventEnv())]);
    expect(sorted(catalogData)).toEqual(sorted(produced));
  });

  test('the only source-specific keys are U4\u2019s legacy dual-carry pair', () => {
    const a = dataPaths(apptEnv()), e = dataPaths(eventEnv());
    expect([...a].filter((p) => !e.has(p)).sort()).toEqual(['data.appt_type']);
    expect([...e].filter((p) => !a.has(p)).sort()).toEqual(['data.event_type']);
  });

  test('the appt manage token is absent from the payload, not merely redacted from it', () => {
    const payload = apptEnv();
    expect(Object.keys(payload.data)).not.toContain('appt_manage_token');
    expect(JSON.stringify(payload)).not.toContain('deadbeef');
    // buildEnvelope's suffix denylist has nothing to do — the projection got there first.
    const built = domainEvents.buildEnvelope('calendar.approaching', payload);
    expect(Object.keys(built.data).sort()).toEqual(Object.keys(payload.data).sort());
  });

  test('the emitter emits through THIS builder — same shape end to end, both sources', async () => {
    const db = makeDb({
      types:  [type('schedules_deadline', [7]), type('meeting_341', [7], 'meeting')],
      events: [ev(1, day(3))],
      appts:  [ap(9, day(3))],
    });
    await emit({}, db);
    expect(domainEvents.emit.mock.calls.every((c) => c[1] === 'calendar.approaching')).toBe(true);

    const live = Object.fromEntries(emissions().map((e) => [e.data.source, e]));
    // Each emission carries its OWN source's shape — which is the catalog set
    // minus the other source's legacy dual-carry key (U4 §7.1 rule 4). The
    // union across both sources IS the catalog, asserted above.
    expect(sorted(dataPaths(live.event))).toEqual(sorted(dataPaths(eventEnv())));
    expect(sorted(dataPaths(live.appt))).toEqual(sorted(dataPaths(apptEnv())));
    expect(sorted(new Set([...dataPaths(live.event), ...dataPaths(live.appt)]))).toEqual(sorted(catalogData));
    for (const e of emissions()) {
      expect(e).toMatchObject({ source: 'system', actor: { user_id: 0 }, extra: { via: 'approaching_emitter' } });
      expect(e.data).toMatchObject({ offset_days: 7, days_until: 3 });
    }
  });
});

describe('the catalog entry', () => {
  const entry = EVENT_TYPES['calendar.approaching'];

  test('registered, labelled, and described as synthetic', () => {
    expect(entry).toBeDefined();
    expect(typeof entry.label).toBe('string');
    expect(entry.description).toMatch(/SYNTHETIC/);
    // The one authoring rule a reader must not miss (mirrors case.stage_aged's
    // threshold_days advice — a `>=` filter would fire on every rung).
    expect(entry.description).toMatch(/equals/i);
  });

  test('every field entry is {path,label}, no duplicates, nothing credential-named', () => {
    const paths = entry.fields.map((f) => f.path);
    expect(paths.length).toBe(new Set(paths).size);
    for (const f of entry.fields) {
      expect(Object.keys(f).sort()).toEqual(['label', 'path']);
      expect(String(f.label).trim().length).toBeGreaterThan(0);
    }
    const DENY = /(_token|_secret|_password|password|_pin|pin_hash|api_key|apikey|_ssn)$/i;
    expect(paths.filter((p) => DENY.test(p))).toEqual([]);
  });

  test('the emitter is discoverable as an internal function with sane meta', () => {
    const meta = fns.emit_calendar_approaching.__meta;
    expect(meta.category).toBe('events');
    expect(meta.params.map((p) => p.name).sort()).toEqual(['dry_run', 'max_emits', 'max_runtime_ms']);
    expect(meta.params.every((p) => p.required === false)).toBe(true);   // no required param: safe to schedule bare
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Offset normalization (shared shape with the admin validator)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 8. The migration says what the code assumes
//
// The emitter's correctness rests on two facts that live in SQL, not JS: the
// claim table's PK includes item_date, and approaching_offsets ships unseeded.
// Neither is observable from a unit test of the function, and both are exactly
// the sort of thing a later hand-edit of the migration would quietly change.
// ─────────────────────────────────────────────────────────────────────────────

describe('ref/2026-09-02_unified_events_u8.sql', () => {
  const fs   = require('fs');
  const path = require('path');
  const SQL  = fs.readFileSync(
    path.join(__dirname, '..', 'ref', '2026-09-02_unified_events_u8.sql'), 'utf8');
  const norm = SQL.replace(/\s+/g, ' ');

  test('the claim table keys on all four columns, item_date included', () => {
    expect(norm).toMatch(/PRIMARY KEY \(source, source_id, offset_days, item_date\)/);
    expect(norm).toMatch(/CREATE TABLE IF NOT EXISTS calendar_approaching_emitted/);
    expect(norm).toMatch(/source ENUM\('appt','event'\)/);
  });

  test('collation is explicit — a bare DEFAULT CHARSET=utf8mb4 yields 0900_ai_ci on MySQL 8', () => {
    expect(norm).toMatch(/CREATE TABLE IF NOT EXISTS calendar_approaching_emitted[\s\S]*?COLLATE=utf8mb4_general_ci/);
  });

  test('approaching_offsets is added NULL and SEEDED NOTHING (the acceptance bar)', () => {
    expect(norm).toMatch(/ADD COLUMN approaching_offsets JSON NULL/);
    // Executable text only, and specifically about the registry table: the
    // prose (and the claim table's own COMMENT=) discuss INSERT IGNORE at
    // length, which a whole-file regex would read as a seed.
    const live = SQL.split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('--'))
      .join(' ').replace(/\s+/g, ' ');
    expect(live).not.toMatch(/INSERT[^;]*INTO calendar_item_types/i);
    expect(live).not.toMatch(/UPDATE calendar_item_types/i);
  });

  test('court_item_reminders is dropped (A6 supersedes it) and court_item_policy is not', () => {
    expect(norm).toMatch(/DROP TABLE IF EXISTS court_item_reminders;/);
    // Only ever as commented rollback SQL — never a live statement.
    expect(SQL.split('\n').filter((l) => !l.trim().startsWith('--') && /court_item_policy/.test(l))).toEqual([]);
  });

  test('a rollback is written down, including how to put court_item_reminders back', () => {
    expect(norm).toMatch(/DROP TABLE calendar_approaching_emitted;/);
    expect(norm).toMatch(/ALTER TABLE calendar_item_types DROP COLUMN approaching_offsets;/);
    expect(norm).toMatch(/CONSTRAINT fk_cir_type FOREIGN KEY \(type_id\) REFERENCES ai_match_types \(id\)/);
  });
});

describe('_normalizeOffsets', () => {
  const norm = fns.emit_calendar_approaching._normalizeOffsets;

  test.each([
    [[7, 1],            [1, 7]],
    [[1, 7, 7],         [1, 7]],
    ['[30,7,1]',        [1, 7, 30]],     // JSON string, as a driver might hand it back
    [[0],               [0]],
    [['7', 1],          [1, 7]],
    [null,              []],
    [[],                []],
    [[366, -1, 1.5],    []],
    [{ d: 7 },          []],
  ])('%j → %j (ascending, deduped, junk dropped)', (input, want) => {
    expect(norm(input)).toEqual(want);
  });
});
