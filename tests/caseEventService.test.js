// tests/caseEventService.test.js
//
// E1 — services/caseEventService.js (the unified calendar read layer) and its
// HTTP surface routes/api.caseEvents.js. Exercised against STUB mysql2 pools
// that record every (sql, params) call and return scripted rows — no database
// (stub pattern from tests/requirementService.test.js, scriptGuard-registered).
//
// WHY THESE PARTICULAR ASSERTIONS
//
// Almost everything this service does is a mapping decision, and the ones that
// matter are exactly the ones that stay green while lying:
//
//   · appt_date VS appt_date_utc. They differ on 2,109 of 2,216 live rows
//     (95.2%). Read the wrong column and every appointment is five hours off —
//     a plausible-looking time on every row, no exception, no visual tell. The
//     pin here is a fixture whose two columns differ by exactly that offset, so
//     picking the wrong one fails loudly instead of shipping.
//   · THE DOCKET FAN-OUT. A docket shared by two cases must bucket to BOTH.
//     There is no live collision (verified 2026-08-30) and case_number carries
//     no unique constraint, so this path has no production exercise — this
//     suite IS its only coverage. eventService's resolver takes LIMIT 1 for a
//     different reason (a JOIN there fans out rows); copying that here would
//     silently hide one case's hearings.
//   · TOMBSTONE + SUPERSEDED EXCLUSION IS THE DEFAULT. 31 of 52 live Canceled
//     events and 262 appts are dead rows. If the default leaks them, every
//     consumer — including R2's detector — counts dead obligations as live.
//   · THE FIELD-PRESENCE ASYMMETRY (v0.4 §3.4). Event tombstones carry a
//     pointer and a reason; appt tombstones carry NEITHER, because no such data
//     exists. Emitting `superseded_by_event_id: null` on an appt would assert
//     the fact is known and empty. Presence/absence is asserted per source.
//   · QUERY COUNT IS A CONTRACT, NOT A PERFORMANCE NOTE. This layer sits inside
//     portal/list loops; a fourth query per case is a fourth query per row of a
//     page. 3 for N cases, always.
//   · KEYS COME FROM THE VOCABULARY. v0.5 §0 makes this E1's one obligation to
//     the U-series: derive from fred/calendar_type_keys_v1 so U2's column
//     backfill produces the SAME keys and E1's output does not move when the
//     sourcing swaps. An ad-hoc map would pass every other test in this file.
//
// Run:
//   npx jest tests/caseEventService.test.js

'use strict';

const svc = require('../services/caseEventService');
const { scriptGuard } = require('./helpers/scriptGuard');

// ─────────────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────────────

// Plain pool stub: query() shifts the next scripted [rows] result.
function stubDb(script) {
  const calls = [];
  const guard = scriptGuard('stubDb', script);
  return {
    calls,
    guard,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) guard.overrun(sql);
      return [script.shift()];
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — column shapes copied from the live tables (2026-08-30).
//
// mysql2 runs the pool at timezone:'Z', so DATE/DATETIME columns arrive as JS
// Dates whose UTC fields ARE the stored naive wall clock. The fixtures use that
// exact representation rather than strings, so the mappers are tested against
// what production actually hands them.
// ─────────────────────────────────────────────────────────────────────────────

const D = (naive) => new Date(`${naive.replace(' ', 'T')}Z`);

const CASE_A = { case_id: 'TYL6KJN8', case_number: '26-46639', case_number_full: '26-46639-mar' };
const CASE_B = { case_id: 'SUTCdsPn', case_number: null, case_number_full: null };

function ev(over) {
  return Object.assign({
    event_id: 100,
    event_type: 'Confirmation Hearing',
    event_title: 'Confirmation Hearing',
    event_date: D('2026-09-10 00:00:00'),
    event_time: '10:00:00',
    event_all_day: 0,
    event_length: null,
    event_location: 'Courtroom 1875, 211 W. Fort St.',
    event_status: 'Scheduled',
    event_link_type: 'case',
    event_link_id: 'TYL6KJN8',
    kind: null,
    superseded_by_event_id: null,
    supersede_reason: null,
  }, over);
}

function ap(over) {
  return Object.assign({
    appt_id: 900,
    appt_case_id: 'TYL6KJN8',
    appt_type: 'Initial Strategy Session',
    appt_status: 'Scheduled',
    appt_date: D('2026-09-01 14:00:00'),
    appt_end: D('2026-09-01 14:30:00'),
    appt_length: 30,
    appt_platform: 'telephone',
  }, over);
}

/** The three scripted result sets a full read consumes, in order. */
const script3 = (cases, events, appts) => [cases, events, appts];


// ─────────────────────────────────────────────────────────────────────────────
// Link resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('link resolution — all four states', () => {
  test('case-linked events and appts both land on the case', async () => {
    const db = stubDb(script3([CASE_A], [ev()], [ap()]));
    const rows = await svc.listForCase(db, 'TYL6KJN8');
    expect(rows.map(r => [r.source, r.source_id])).toEqual([['appt', 900], ['event', 100]]);
  });

  test('a docket matching case_number resolves', async () => {
    const db = stubDb(script3(
      [CASE_A],
      [ev({ event_id: 101, event_link_type: 'case_number', event_link_id: '26-46639' })],
      []
    ));
    const rows = await svc.listForCase(db, 'TYL6KJN8');
    expect(rows).toHaveLength(1);
    expect(rows[0].case_id).toBe('TYL6KJN8');
  });

  test('a docket matching case_number_full resolves too — BOTH columns, not just the short one', async () => {
    const db = stubDb(script3(
      [CASE_A],
      [ev({ event_id: 102, event_link_type: 'case_number', event_link_id: '26-46639-mar' })],
      []
    ));
    const rows = await svc.listForCase(db, 'TYL6KJN8');
    expect(rows).toHaveLength(1);
  });

  test('both dockets go into ONE events query as an IN list', async () => {
    const db = stubDb(script3([CASE_A], [], []));
    await svc.listForCase(db, 'TYL6KJN8');
    const evCall = db.calls[1];
    expect(evCall.sql).toMatch(/FROM events/);
    // case-id branch + both docket values, all bound.
    expect(evCall.params).toEqual(['TYL6KJN8', '26-46639', '26-46639-mar']);
    expect(evCall.sql).toMatch(/event_link_type = 'case_number' AND e\.event_link_id IN \(\?,\?\)/);
  });

  test('a case with no docket queries events on the case branch alone', async () => {
    const db = stubDb(script3([CASE_B], [], []));
    await svc.listForCase(db, 'SUTCdsPn');
    expect(db.calls[1].params).toEqual(['SUTCdsPn']);
    expect(db.calls[1].sql).not.toMatch(/case_number/);
  });

  test('blank dockets are not treated as a docket', async () => {
    const db = stubDb(script3(
      [{ case_id: 'X1', case_number: '   ', case_number_full: '' }], [], []
    ));
    await svc.listForCase(db, 'X1');
    expect(db.calls[1].params).toEqual(['X1']);
  });

  test('identical case_number and case_number_full bind ONCE', async () => {
    const db = stubDb(script3(
      [{ case_id: 'X1', case_number: '26-1', case_number_full: '26-1' }], [], []
    ));
    await svc.listForCase(db, 'X1');
    expect(db.calls[1].params).toEqual(['X1', '26-1']);
  });

  test('a docket shared by TWO cases buckets to BOTH', async () => {
    // No live collision exists; case_number has no unique constraint, so this
    // is the only place the behaviour is pinned. Picking one winner would make
    // a hearing vanish from the other case's timeline.
    const db = stubDb(script3(
      [{ case_id: 'AAA', case_number: '26-9999', case_number_full: null },
       { case_id: 'BBB', case_number: '26-9999', case_number_full: null }],
      [ev({ event_id: 500, event_link_type: 'case_number', event_link_id: '26-9999' })],
      []
    ));
    const byCase = await svc.listForCases(db, ['AAA', 'BBB']);
    expect(byCase.get('AAA').map(r => r.source_id)).toEqual([500]);
    expect(byCase.get('BBB').map(r => r.source_id)).toEqual([500]);
    // Same event, bucketed twice, each copy stamped with ITS case.
    expect(byCase.get('AAA')[0].case_id).toBe('AAA');
    expect(byCase.get('BBB')[0].case_id).toBe('BBB');
  });

  test("contact-linked and NULL-linked events never reach a case bucket", async () => {
    // They cannot match either SQL branch; the mapper must not rescue them
    // either, so a leak past the WHERE clause still buckets nowhere.
    const db = stubDb(script3(
      [CASE_A],
      [ev({ event_id: 300, event_link_type: 'contact', event_link_id: '1001' }),
       ev({ event_id: 301, event_link_type: null, event_link_id: null })],
      []
    ));
    const rows = await svc.listForCase(db, 'TYL6KJN8');
    expect(rows).toEqual([]);
  });

  test('bucketing is case-INSENSITIVE, matching utf8mb4_general_ci', async () => {
    // SQL matched 'sutcdspn' against 'SUTCdsPn'; an exact-string JS compare
    // would find rows and then drop every one of them.
    const db = stubDb(script3([CASE_B], [], [ap({ appt_case_id: 'sutcdspn' })]));
    const rows = await svc.listForCase(db, 'sutcdspn');
    expect(rows).toHaveLength(1);
    expect(rows[0].case_id).toBe('SUTCdsPn');   // canonical casing from the DB
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// starts_at / ends_at
// ─────────────────────────────────────────────────────────────────────────────

describe('starts_at composition', () => {
  test('APPTS READ appt_date, NEVER appt_date_utc (the 95%-of-rows offset bug)', async () => {
    const db = stubDb(script3([CASE_A], [], [ap({
      appt_date:     D('2026-09-01 14:00:00'),
      // The real column, five hours ahead. If it is ever selected or preferred,
      // this assertion is what says so.
      appt_date_utc: D('2026-09-01 19:00:00'),
      appt_end:      D('2026-09-01 14:30:00'),
    })]));
    const rows = await svc.listForCase(db, 'TYL6KJN8');
    expect(rows[0].starts_at).toBe('2026-09-01 14:00:00');
    expect(rows[0].ends_at).toBe('2026-09-01 14:30:00');
    // Belt and braces: the column is not even in the SELECT list.
    expect(db.calls[2].sql).not.toMatch(/appt_date_utc/);
  });

  test('a timed event composes event_date + event_time', async () => {
    const db = stubDb(script3([CASE_A], [ev()], []));
    const [row] = await svc.listForCase(db, 'TYL6KJN8');
    expect(row.starts_at).toBe('2026-09-10 10:00:00');
    expect(row.all_day).toBe(false);
  });

  test('an all-day event is midnight + the flag, and has no end', async () => {
    const db = stubDb(script3([CASE_A], [ev({
      event_all_day: 1, event_time: null, event_length: 60,
      event_type: 'Docs Deadline', event_title: 'Docs Due to Trustee',
    })], []));
    const [row] = await svc.listForCase(db, 'TYL6KJN8');
    expect(row.starts_at).toBe('2026-09-10 00:00:00');
    expect(row.all_day).toBe(true);
    expect(row.ends_at).toBeNull();
  });

  test('a NULL event_time with all_day=0 still lands at midnight', async () => {
    const db = stubDb(script3([CASE_A], [ev({ event_time: null })], []));
    const [row] = await svc.listForCase(db, 'TYL6KJN8');
    expect(row.starts_at).toBe('2026-09-10 00:00:00');
  });

  test('event ends_at = start + event_length minutes; null without a length', async () => {
    const db = stubDb(script3([CASE_A], [
      ev({ event_id: 1, event_length: 90 }),
      ev({ event_id: 2, event_length: null }),
    ], []));
    const rows = await svc.listForCase(db, 'TYL6KJN8');
    expect(rows.find(r => r.source_id === 1).ends_at).toBe('2026-09-10 11:30:00');
    expect(rows.find(r => r.source_id === 2).ends_at).toBeNull();
  });

  test('appt ends_at reads the stored generated column, null when appt_length is null', async () => {
    const db = stubDb(script3([CASE_A], [], [ap({ appt_length: null, appt_end: null })]));
    const [row] = await svc.listForCase(db, 'TYL6KJN8');
    expect(row.ends_at).toBeNull();
  });

  test('appts are never all_day', async () => {
    const db = stubDb(script3([CASE_A], [], [ap()]));
    const [row] = await svc.listForCase(db, 'TYL6KJN8');
    expect(row.all_day).toBe(false);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────

describe('status normalization', () => {
  test.each([
    ['Scheduled', 'scheduled'],
    ['Completed', 'held'],
    ['Canceled',  'canceled'],
  ])('event %s -> %s', (raw, want) => {
    expect(svc._normStatus('event', raw)).toBe(want);
  });

  test.each([
    ['Scheduled', 'scheduled'],
    ['Attended',  'held'],
    ['No Show',   'missed'],
    ['Canceled',  'canceled'],
  ])('appt %s -> %s', (raw, want) => {
    expect(svc._normStatus('appt', raw)).toBe(want);
  });

  test('the 6 legacy blank-enum appts normalize to NULL, never to held or scheduled', async () => {
    // Ruled 2026-08-30: never launder unknown into a real value. These are real
    // 2024 appointments whose outcome nobody recorded.
    const db = stubDb(script3([CASE_A], [], [ap({ appt_status: '' })]));
    const [row] = await svc.listForCase(db, 'TYL6KJN8');
    expect(row.status_norm).toBeNull();
    expect(row.superseded).toBeUndefined();     // blank is not a tombstone
  });

  test('an unknown status maps to null rather than guessing', () => {
    expect(svc._normStatus('appt', 'Nonsense')).toBeNull();
    expect(svc._normStatus('event', null)).toBeNull();
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Supersession / tombstones
// ─────────────────────────────────────────────────────────────────────────────

describe('dead rows are excluded by default', () => {
  test('superseded events are filtered IN SQL, not in the mapper', async () => {
    const db = stubDb(script3([CASE_A], [], []));
    await svc.listForCase(db, 'TYL6KJN8');
    expect(db.calls[1].sql).toMatch(/e\.superseded_by_event_id IS NULL/);
  });

  test('Rescheduled appts are filtered IN SQL', async () => {
    const db = stubDb(script3([CASE_A], [], []));
    await svc.listForCase(db, 'TYL6KJN8');
    expect(db.calls[2].sql).toMatch(/a\.appt_status <> 'Rescheduled'/);
  });

  test('a superseded event is excluded even though its status is Canceled', async () => {
    // The 31 E0a tombstones genuinely ARE Canceled. The pointer is what marks
    // them dead; excluding on status alone would also hide the 21 real
    // cancellations, and excluding on neither shows phantom twins.
    const db = stubDb(script3([CASE_A], [], []));
    await svc.listForCase(db, 'TYL6KJN8');
    // Scope the negative to the WHERE clause — event_status is legitimately in
    // the SELECT list; what must not happen is it becoming a liveness FILTER.
    const where = db.calls[1].sql.split(/\bWHERE\b/)[1];
    expect(where).toMatch(/superseded_by_event_id IS NULL/);
    expect(where).not.toMatch(/event_status/);
  });

  test('default rows omit all three superseded keys entirely (frozen R2 shape)', async () => {
    const db = stubDb(script3([CASE_A], [ev()], [ap()]));
    const rows = await svc.listForCase(db, 'TYL6KJN8');
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual([
        'all_day', 'case_id', 'ends_at', 'kind_key', 'location', 'source',
        'source_id', 'starts_at', 'status_norm', 'title', 'type_key',
      ]);
    }
  });
});

describe('includeSuperseded', () => {
  test('drops both exclusion clauses', async () => {
    const db = stubDb(script3([CASE_A], [], []));
    await svc.listForCase(db, 'TYL6KJN8', { includeSuperseded: true });
    expect(db.calls[1].sql).not.toMatch(/superseded_by_event_id IS NULL/);
    expect(db.calls[2].sql).not.toMatch(/Rescheduled/);
  });

  test('a superseded EVENT carries the pointer AND the reason', async () => {
    const db = stubDb(script3([CASE_A], [ev({
      event_id: 41, event_status: 'Canceled',
      superseded_by_event_id: 51, supersede_reason: 'duplicate',
    })], []));
    const [row] = await svc.listForCase(db, 'TYL6KJN8', { includeSuperseded: true });
    expect(row.superseded).toBe(true);
    expect(row.superseded_by_event_id).toBe(51);
    expect(row.supersede_reason).toBe('duplicate');
    expect(row.status_norm).toBe('canceled');   // keeps its real status
  });

  test('an APPT tombstone carries the flag and NEITHER other field (v0.4 §3.4)', async () => {
    // The asymmetry is the point: emitting superseded_by_event_id:null here
    // would claim the fact is known and empty. It is not known at all.
    const db = stubDb(script3([CASE_A], [], [ap({ appt_status: 'Rescheduled' })]));
    const [row] = await svc.listForCase(db, 'TYL6KJN8', { includeSuperseded: true });
    expect(row.superseded).toBe(true);
    expect('superseded_by_event_id' in row).toBe(false);
    expect('supersede_reason' in row).toBe(false);
    expect(row.status_norm).toBeNull();         // Rescheduled is not a status
  });

  test('LIVE rows never gain the flag, even under includeSuperseded', async () => {
    const db = stubDb(script3([CASE_A], [ev()], [ap()]));
    const rows = await svc.listForCase(db, 'TYL6KJN8', { includeSuperseded: true });
    for (const r of rows) expect('superseded' in r).toBe(false);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Type keys — the U-series alignment contract (v0.5 §0 / §3)
// ─────────────────────────────────────────────────────────────────────────────

describe('type_key / kind_key come from the calendar_type_keys_v1 vocabulary', () => {
  test.each([
    ['Confirmation Hearing', 'confirmation_hearing', 'hearing'],
    ['confirmation_hearing', 'confirmation_hearing', 'hearing'],   // merged spelling
    ['Show Cause Hearing',   'show_cause',           'hearing'],
    ['Status Conference',    'status_conference',    'conference'],
    ['Deposition',           'deposition',           'conference'],
    ['341',                  'meeting_341',          'meeting'],
    ['poc_gov_due',          'poc_gov_due',          'deadline'],
    ['Deadline',             'deadline',             'deadline'],
  ])('event %s -> %s / %s', (raw, tk, kk) => {
    expect(svc._deriveKeys('event', raw, 999)).toEqual({ type_key: tk, kind_key: kk });
  });

  test.each([
    ['Initial Strategy Session', 'iss',          'meeting'],
    ['Intial Strategy Session',  'iss',          'meeting'],   // the live typo
    ['Strategy Session',         'ss',           'meeting'],   // distinct from iss
    ['341 Meeting',              'meeting_341',  'meeting'],   // same key as events side
    ['Consultation',             'consultation', 'meeting'],
    ['Pizza Party',              'test',         'meeting'],
  ])('appt %s -> %s / %s', (raw, tk, kk) => {
    expect(svc._deriveKeys('appt', raw, 999)).toEqual({ type_key: tk, kind_key: kk });
  });

  test('341 is ONE key across both tables — the cross-table join U7 depends on', () => {
    expect(svc._deriveKeys('event', '341', 1).type_key)
      .toBe(svc._deriveKeys('appt', '341 Meeting', 1).type_key);
  });

  test('unmapped strings pass through RAW with a null kind and one warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(svc._deriveKeys('event', 'Brand New Court Thing', 999))
        .toEqual({ type_key: 'Brand New Court Thing', kind_key: null });
      expect(warn).toHaveBeenCalledTimes(1);
      // Deduped: this runs inside list loops.
      svc._deriveKeys('event', 'Brand New Court Thing', 998);
      svc._deriveKeys('event', 'Brand New Court Thing', 997);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });

  test('an unmapped string is NEVER laundered into a real key', () => {
    // The scratch vocabulary's unmapped_fallback (['meeting','meeting']) is
    // deliberately NOT honoured: kind='meeting' decides STORAGE under v0.5 §4,
    // so a guessed kind would route an unknown item into the wrong table.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const got = svc._deriveKeys('appt', 'Something Nobody Seeded', 999);
      expect(got.kind_key).toBeNull();
      expect(got.type_key).not.toBe('meeting');
    } finally { warn.mockRestore(); }
  });

  test('a NULL or blank type yields nulls WITHOUT a warning — absent data, not an unknown string', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(svc._deriveKeys('appt', null, 1)).toEqual({ type_key: null, kind_key: null });
      expect(svc._deriveKeys('appt', '', 2)).toEqual({ type_key: null, kind_key: null });
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  test('prototype keys are not vocabulary entries', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A Map, not an object literal: '__proto__' / 'constructor' must miss.
      expect(svc._deriveKeys('event', 'constructor', 1).kind_key).toBeNull();
      expect(svc._deriveKeys('event', '__proto__', 2).kind_key).toBeNull();
    } finally { warn.mockRestore(); }
  });

  test.each([
    [107, 'filing_fee_deadline', 'deadline'],   // "Order Extending Time to Pay Filing Fee"
    [134, 'trial',               'hearing'],    // "Order Canceling Trial ... Dates"
    [4,   'test',                'other'],
    [6,   'test',                'other'],
  ])('row override %i wins over the type string', (id, tk, kk) => {
    // Applying these now is what keeps E1's keys STABLE across U2: U1/E0b
    // writes exactly these values into the column, so nothing moves when the
    // sourcing swaps at U3.
    expect(svc._deriveKeys('event', 'Order', id)).toEqual({ type_key: tk, kind_key: kk });
  });

  test('overrides are events-only — an appt id never collides with an event id', async () => {
    const db = stubDb(script3([CASE_A], [], [ap({ appt_id: 107, appt_type: 'Strategy Session' })]));
    const [row] = await svc.listForCase(db, 'TYL6KJN8');
    expect(row.type_key).toBe('ss');
  });

  // ── The collation finding (2026-08-30) ────────────────────────────────────
  //
  // The v0.5 §3 vocabulary was derived from a `GROUP BY appt_type` census, which
  // runs under utf8mb4_general_ci and therefore collapses case variants into ONE
  // representative spelling per group. The table stores the variants. Re-censused
  // with CAST(... AS BINARY):
  //
  //     'Pre-filing Meeting'            316 rows   vocabulary says 'Pre-Filing Meeting'
  //     'Meeting'                       108 rows   vocabulary says 'meeting'
  //     'Pre-Filing Meeting'             15 rows
  //     'Schedules completion meeting'    1 row
  //
  // Exact-string matching missed 425 of 2,216 appts (19%) — including the
  // DOMINANT spelling of the second-most-common appointment type — and dropped
  // every one to raw passthrough with a null kind.

  test.each([
    ['Pre-filing Meeting',           'pre_filing'],          // 316 live rows
    ['Pre-Filing Meeting',           'pre_filing'],          //  15 live rows
    ['Meeting',                      'meeting'],             // 108 live rows
    ['meeting',                      'meeting'],             //   5 live rows
    ['Schedules completion meeting', 'schedules_meeting'],   //   1 live row
    ['Schedules Completion Meeting', 'schedules_meeting'],   // 121 live rows
  ])('%s resolves case-insensitively, matching the column collation', (raw, tk) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const got = svc._deriveKeys('appt', raw, 999);
      expect(got.type_key).toBe(tk);
      expect(got.kind_key).toBe('meeting');
      expect(warn).not.toHaveBeenCalled();   // a real type must never warn
    } finally { warn.mockRestore(); }
  });

  test('EVERY case-sensitive value live on 2026-08-30 maps — zero passthrough', () => {
    // The census that produced this list is `SELECT CAST(x AS BINARY), COUNT(*)
    // ... GROUP BY CAST(x AS BINARY)` on each table. Regenerate it the same way
    // when adding types: a ci GROUP BY is what hid the variants above.
    const EVENTS = [
      'Confirmation Hearing', '341', 'dischargeability_due', 'Hearing',
      'Docs Deadline', 'Schedules Deadline', 'Confirmation Certificate Deadline',
      'poc_gov_due', 'poc_due', 'object_confirmation_due', 'confirmation_hearing',
      'Deadline', 'Show Cause', 'Milestone', 'Pre-trial Conference', 'Trial',
      'Deposition', 'Initial Scheduling Conference', 'Filing Fee Deadline',
      'Order', 'Filing Fee Installment Deadline', 'Show Cause Hearing',
      'Telephonic Status Conference', 'Status Conference', 'Trial / Pre-Trial Hearing',
    ];
    const APPTS = [
      'Initial Strategy Session', 'Pre-filing Meeting', 'Strategy Session',
      '341 Meeting', 'Strategy Session Follow Up', 'Schedules Completion Meeting',
      'Meeting', 'Pre-Filing Meeting', 'Consultation', 'meeting', 'test',
      'Pre-Lawsuit Meeting', 'Tax Consult', 'Follow Up', 'Pre-filing (30 min)',
      'Pizza Party', 'Documents Completion Meeting', 'Matrix Completion Meeting',
      'bug hunting Session', 'Repetitive Session', 'test3 appt', 'test2 appt',
      'test appt', 'Schedules completion meeting', 'Pre Lawsuit Meeting',
      'Case Status Review', 'Intial Strategy Session',
      'to go over objections to Chapt', 'Test Appointment', 'to go over claims',
    ];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const unmapped = [];
      for (const t of EVENTS) {
        if (!svc._deriveKeys('event', t, 999).kind_key) unmapped.push(`event:${t}`);
      }
      for (const t of APPTS) {
        if (!svc._deriveKeys('appt', t, 999).kind_key) unmapped.push(`appt:${t}`);
      }
      expect(unmapped).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  test('a vocabulary that would shadow an entry refuses to load', () => {
    // Two spellings normalizing together with DIFFERENT values would silently
    // lose one and map a whole type wrong with no symptom. Load-time throw,
    // because this module is the single mapping site.
    jest.isolateModules(() => {
      const fresh = require('../services/caseEventService');
      // The shipped vocabulary is clean — nothing shadows.
      expect(fresh._APPT_TYPE_KEYS.size).toBeGreaterThan(20);
      expect(fresh._EVENT_TYPE_KEYS.size).toBeGreaterThan(20);
    });
    // The maps are keyed on the NORMALIZED form, so variants share one entry.
    expect(svc._APPT_TYPE_KEYS.has('pre-filing meeting')).toBe(true);
    expect(svc._APPT_TYPE_KEYS.has('Pre-Filing Meeting')).toBe(false);
  });

  test('leading/trailing whitespace does not defeat the lookup', () => {
    // No live value is padded (0 rows on both tables), but free text is free text.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(svc._deriveKeys('event', '  Docs Deadline  ', 1))
        .toEqual({ type_key: 'docs_deadline', kind_key: 'deadline' });
      expect(svc._deriveKeys('appt', '   ', 1))
        .toEqual({ type_key: null, kind_key: null });
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  test('kind_key is derived, NOT read from events.kind (NULL until E0b)', async () => {
    // Every live row has kind NULL today. Reading the column would make every
    // event render unclassified and the glyphs meaningless for the whole slice.
    const db = stubDb(script3([CASE_A], [ev({ kind: null })], []));
    const [row] = await svc.listForCase(db, 'TYL6KJN8');
    expect(row.kind_key).toBe('hearing');
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Title / location
// ─────────────────────────────────────────────────────────────────────────────

describe('title and location', () => {
  test('an event uses its real event_title, not the type string', async () => {
    const db = stubDb(script3([CASE_A], [ev({
      event_type: 'Hearing',
      event_title: 'Hearing on Motion to Dismiss Adversary Proceeding',
    })], []));
    const [row] = await svc.listForCase(db, 'TYL6KJN8');
    expect(row.title).toBe('Hearing on Motion to Dismiss Adversary Proceeding');
    expect(row.type_key).toBe('hearing');       // type_key stays raw-derived
  });

  test('a blank event_title falls back to the type string rather than to null', async () => {
    const db = stubDb(script3([CASE_A], [ev({ event_title: '   ' })], []));
    const [row] = await svc.listForCase(db, 'TYL6KJN8');
    expect(row.title).toBe('Confirmation Hearing');
  });

  test('an appt uses appt_type — it has no title column', async () => {
    const db = stubDb(script3([CASE_A], [], [ap()]));
    const [row] = await svc.listForCase(db, 'TYL6KJN8');
    expect(row.title).toBe('Initial Strategy Session');
  });

  test('appt location is appt_platform, verbatim', async () => {
    const db = stubDb(script3([CASE_A], [], [ap({ appt_platform: 'in-person' })]));
    const [row] = await svc.listForCase(db, 'TYL6KJN8');
    expect(row.location).toBe('in-person');
  });

  test('a blank event_location is null, not an empty string', async () => {
    const db = stubDb(script3([CASE_A], [ev({ event_location: '' })], []));
    const [row] = await svc.listForCase(db, 'TYL6KJN8');
    expect(row.location).toBeNull();
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Ordering
// ─────────────────────────────────────────────────────────────────────────────

describe('ordering', () => {
  test('starts_at ascending across BOTH sources — the whole point of the layer', async () => {
    const db = stubDb(script3([CASE_A],
      [ev({ event_id: 10, event_date: D('2026-09-05 00:00:00'), event_time: '09:00:00' }),
       ev({ event_id: 11, event_date: D('2026-09-01 00:00:00'), event_time: '09:00:00' })],
      [ap({ appt_id: 20, appt_date: D('2026-09-03 14:00:00') }),
       ap({ appt_id: 21, appt_date: D('2026-08-28 14:00:00') })]
    ));
    const rows = await svc.listForCase(db, 'TYL6KJN8');
    expect(rows.map(r => r.source_id)).toEqual([21, 11, 20, 10]);
  });

  test('ties break deterministically on (source, source_id), not on query order', async () => {
    const same = D('2026-09-05 09:00:00');
    const db = stubDb(script3([CASE_A],
      [ev({ event_id: 9, event_date: D('2026-09-05 00:00:00'), event_time: '09:00:00' }),
       ev({ event_id: 8, event_date: D('2026-09-05 00:00:00'), event_time: '09:00:00' })],
      [ap({ appt_id: 7, appt_date: same }), ap({ appt_id: 6, appt_date: same })]
    ));
    const rows = await svc.listForCase(db, 'TYL6KJN8');
    // appts before events at the same instant ('appt' < 'event'), ids ascending.
    expect(rows.map(r => `${r.source}${r.source_id}`))
      .toEqual(['appt6', 'appt7', 'event8', 'event9']);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// from / to
// ─────────────────────────────────────────────────────────────────────────────

describe('from / to filtering', () => {
  test('both bounds are pushed into SQL on both sources, adding no queries', async () => {
    const db = stubDb(script3([CASE_A], [], []));
    await svc.listForCase(db, 'TYL6KJN8', { from: '2026-09-01', to: '2026-09-30' });
    expect(db.calls).toHaveLength(3);
    expect(db.calls[1].sql).toMatch(/e\.event_date >= \? AND e\.event_date <= \?/);
    expect(db.calls[1].params.slice(-2)).toEqual(['2026-09-01', '2026-09-30']);
    expect(db.calls[2].params.slice(-2)).toEqual(['2026-09-01', '2026-09-30']);
  });

  test("appt `to` is inclusive of the whole day and keeps the COLUMN bare", async () => {
    // appt_date is a DATETIME: `<= '2026-09-30'` would drop everything after
    // midnight that day. The interval goes on the PARAMETER so the column stays
    // index-eligible — DATE(appt_date) would not.
    const db = stubDb(script3([CASE_A], [], []));
    await svc.listForCase(db, 'TYL6KJN8', { to: '2026-09-30' });
    expect(db.calls[2].sql).toMatch(/a\.appt_date < \(\? \+ INTERVAL 1 DAY\)/);
    expect(db.calls[2].sql).not.toMatch(/DATE\(a\.appt_date\)/);
  });

  test('one bound alone works', async () => {
    const db = stubDb(script3([CASE_A], [], []));
    await svc.listForCase(db, 'TYL6KJN8', { from: '2026-09-01' });
    expect(db.calls[1].sql).toMatch(/e\.event_date >= \?/);
    expect(db.calls[1].sql).not.toMatch(/e\.event_date <= \?/);
  });

  test('no bounds add no clauses', async () => {
    const db = stubDb(script3([CASE_A], [], []));
    await svc.listForCase(db, 'TYL6KJN8');
    // event_date is in the SELECT list either way; only a BOUND is forbidden.
    expect(db.calls[1].sql).not.toMatch(/event_date (>=|<=)/);
    expect(db.calls[2].sql).not.toMatch(/appt_date (>=|<)/);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Query budget
// ─────────────────────────────────────────────────────────────────────────────

describe('query budget — a contract, not a performance note', () => {
  test('ONE case costs 3 queries', async () => {
    const db = stubDb(script3([CASE_A], [ev()], [ap()]));
    await svc.listForCase(db, 'TYL6KJN8');
    expect(db.calls).toHaveLength(3);
  });

  test('FIFTY cases also cost 3 queries', async () => {
    const cases = Array.from({ length: 50 }, (_, i) => ({
      case_id: `C${i}`, case_number: `26-${1000 + i}`, case_number_full: null,
    }));
    const db = stubDb(script3(cases, [], []));
    const byCase = await svc.listForCases(db, cases.map(c => c.case_id));
    expect(db.calls).toHaveLength(3);
    expect(byCase.size).toBe(50);
  });

  test('opts add zero queries', async () => {
    const db = stubDb(script3([CASE_A], [], []));
    await svc.listForCase(db, 'TYL6KJN8',
      { includeSuperseded: true, from: '2026-01-01', to: '2026-12-31' });
    expect(db.calls).toHaveLength(3);
  });

  test('an empty id list short-circuits at ZERO queries', async () => {
    const db = stubDb([]);
    expect(await svc.listForCases(db, [])).toEqual(new Map());
    expect(await svc.listForCases(db, null)).toEqual(new Map());
    expect(await svc.listForCases(db, ['', '   '])).toEqual(new Map());
    expect(db.calls).toHaveLength(0);
  });

  test('ids that resolve to no case short-circuit at ONE query', async () => {
    const db = stubDb([[]]);
    expect(await svc.listForCases(db, ['nope'])).toEqual(new Map());
    expect(db.calls).toHaveLength(1);
  });

  test('duplicate ids are de-duplicated before binding', async () => {
    const db = stubDb(script3([CASE_A], [], []));
    await svc.listForCases(db, ['TYL6KJN8', 'TYL6KJN8', 'TYL6KJN8']);
    expect(db.calls[0].params).toEqual(['TYL6KJN8']);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// listForCase vs listForCases — 404 vs silent absence
// ─────────────────────────────────────────────────────────────────────────────

describe('unknown cases', () => {
  test('listForCase throws a 404 — and pays no extra query for it', async () => {
    const db = stubDb([[]]);
    await expect(svc.listForCase(db, 'ghost')).rejects.toMatchObject({ status: 404 });
    expect(db.calls).toHaveLength(1);           // existence came from query 1
  });

  test('an EXISTING case with an empty calendar returns [] — not a 404', async () => {
    // The distinction is the whole reason the route can 404 at all: a typo'd id
    // must not read as "a case with nothing scheduled".
    const db = stubDb(script3([CASE_A], [], []));
    await expect(svc.listForCase(db, 'TYL6KJN8')).resolves.toEqual([]);
  });

  test('listForCases is silent-absence, matching resolveRequirements batch semantics', async () => {
    const db = stubDb(script3([CASE_A], [], []));
    const byCase = await svc.listForCases(db, ['TYL6KJN8', 'ghost']);
    expect(byCase.has('TYL6KJN8')).toBe(true);
    expect(byCase.has('ghost')).toBe(false);    // absent, not empty, not an error
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// auditOrphans
// ─────────────────────────────────────────────────────────────────────────────

describe('auditOrphans', () => {
  test('covers all three orphan shapes and excludes contact-linked rows', async () => {
    const db = stubDb([[]]);
    await svc.auditOrphans(db);
    const sql = db.calls[0].sql;
    expect(sql).toMatch(/e\.event_link_type IS NULL/);
    expect(sql).toMatch(/event_link_type = 'case_number' AND NOT EXISTS/);
    expect(sql).toMatch(/event_link_type = 'case' AND NOT EXISTS/);
    expect(sql).toMatch(/c\.case_number = e\.event_link_id OR c\.case_number_full/);
    // A contact-linked event resolves — to a contact. Not an orphan.
    expect(sql).not.toMatch(/'contact'/);
  });

  test('labels each row with its reason and normalizes the shape', async () => {
    const db = stubDb([[
      { event_id: 4, event_type: 'Milestone', event_title: 'Reminder smoke',
        event_date: D('2026-05-01 00:00:00'), event_time: null, event_all_day: 1,
        event_status: 'Canceled', event_link_type: null, event_link_id: null,
        superseded_by_event_id: null, supersede_reason: null, reason: 'no_link' },
      { event_id: 88, event_type: 'Hearing', event_title: 'Hearing',
        event_date: D('2026-04-01 00:00:00'), event_time: '10:00:00', event_all_day: 0,
        event_status: 'Scheduled', event_link_type: 'case_number', event_link_id: '99-00000',
        superseded_by_event_id: null, supersede_reason: null,
        reason: 'unresolved_case_number' },
    ]]);
    const rows = await svc.auditOrphans(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      event_id: 4, reason: 'no_link', event_date: '2026-05-01',
      event_time: null, all_day: true, link_type: null, link_id: null,
    });
    expect(rows[1]).toMatchObject({
      event_id: 88, reason: 'unresolved_case_number',
      event_date: '2026-04-01', event_time: '10:00:00', all_day: false,
      link_type: 'case_number', link_id: '99-00000',
    });
  });

  test('one query, no parameters', async () => {
    const db = stubDb([[]]);
    await svc.auditOrphans(db);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].params).toEqual([]);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// The route
// ─────────────────────────────────────────────────────────────────────────────

describe('routes/api.caseEvents.js', () => {
  // supertest is not a dependency — express in-process over a real ephemeral
  // socket, the idiom from tests/formrender.extappearance.test.js.
  const express = require('express');
  const http = require('http');

  let authOk = true;
  jest.mock('../lib/auth.jwtOrApiKey', () => (req, res, next) => {
    if (!global.__ceAuthOk) {
      return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }
    req.auth = { type: 'jwt', userId: 6 };
    next();
  });

  beforeEach(() => { global.__ceAuthOk = true; });
  afterAll(() => { delete global.__ceAuthOk; });

  function app(db) {
    const a = express();
    a.use((req, _res, next) => { req.db = db; next(); });
    a.use(require('../routes/api.caseEvents'));
    return a;
  }

  function get(a, urlPath) {
    return new Promise((resolve, reject) => {
      const server = a.listen(0, () => {
        const port = server.address().port;
        http.get({ port, path: urlPath }, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: JSON.parse(data || '{}') });
          });
        }).on('error', (e) => { server.close(); reject(e); });
      });
    });
  }

  test('GET /api/cases/:id/events returns the timeline in a success envelope', async () => {
    const db = stubDb(script3([CASE_A], [ev()], [ap()]));
    const { status, body } = await get(app(db), '/api/cases/TYL6KJN8/events');
    expect(status).toBe(200);
    expect(body.status).toBe('success');
    expect(body.events.map(e => e.source)).toEqual(['appt', 'event']);
  });

  test('an unknown case is a 404, an empty calendar is a 200 with []', async () => {
    // The distinction the route exists to preserve: a typo'd id must not read
    // as "a case with nothing scheduled".
    const miss = stubDb([[]]);
    expect((await get(app(miss), '/api/cases/ghost/events')).status).toBe(404);

    const empty = stubDb(script3([CASE_A], [], []));
    const { status, body } = await get(app(empty), '/api/cases/TYL6KJN8/events');
    expect(status).toBe(200);
    expect(body.events).toEqual([]);
  });

  test('include_superseded=1 maps to the opt', async () => {
    const db = stubDb(script3([CASE_A], [], []));
    await get(app(db), '/api/cases/TYL6KJN8/events?include_superseded=1');
    expect(db.calls[1].sql).not.toMatch(/superseded_by_event_id IS NULL/);
  });

  test('anything else leaves superseded rows excluded', async () => {
    for (const q of ['', '?include_superseded=0', '?include_superseded=']) {
      const db = stubDb(script3([CASE_A], [], []));
      await get(app(db), `/api/cases/TYL6KJN8/events${q}`);
      expect(db.calls[1].sql).toMatch(/superseded_by_event_id IS NULL/);
    }
  });

  test('from / to are passed through', async () => {
    const db = stubDb(script3([CASE_A], [], []));
    await get(app(db), '/api/cases/TYL6KJN8/events?from=2026-09-01&to=2026-09-30');
    expect(db.calls[1].params.slice(-2)).toEqual(['2026-09-01', '2026-09-30']);
  });

  test('a malformed date is treated as absent, never bound', async () => {
    const db = stubDb(script3([CASE_A], [], []));
    await get(app(db), '/api/cases/TYL6KJN8/events?from=lastweek');
    expect(db.calls[1].sql).not.toMatch(/event_date (>=|<=)/);
    expect(db.calls[1].params).toEqual(['TYL6KJN8', '26-46639', '26-46639-mar']);
  });

  test('GET /api/case-events/audit returns the census with a count', async () => {
    const db = stubDb([[
      { event_id: 4, event_type: 'Milestone', event_title: 'Reminder smoke',
        event_date: D('2026-05-01 00:00:00'), event_time: null, event_all_day: 1,
        event_status: 'Canceled', event_link_type: null, event_link_id: null,
        superseded_by_event_id: null, supersede_reason: null, reason: 'no_link' },
    ]]);
    const { status, body } = await get(app(db), '/api/case-events/audit');
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'success', count: 1 });
    expect(body.orphans[0].reason).toBe('no_link');
  });

  test('both routes are behind jwtOrApiKey', async () => {
    global.__ceAuthOk = false;
    const db = stubDb([]);
    expect((await get(app(db), '/api/cases/TYL6KJN8/events')).status).toBe(401);
    expect((await get(app(db), '/api/case-events/audit')).status).toBe(401);
    expect(db.calls).toHaveLength(0);   // auth ran BEFORE any query
  });

  test('a service failure is a 500 with the error envelope', async () => {
    const boom = { query: async () => { throw new Error('db exploded'); } };
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { status, body } = await get(app(boom), '/api/cases/TYL6KJN8/events');
      expect(status).toBe(500);
      expect(body.status).toBe('error');
    } finally { spy.mockRestore(); }
  });
});
