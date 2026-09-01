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
    // U3 columns. `kind` and `type_key` are now POPULATED in the fixture,
    // because they are populated on all 156 live rows (U1 + U2, verified
    // 2026-09-01) — a fixture with kind:null would be testing a state the
    // table no longer has.
    event_resolution: null,
    kind: 'hearing',
    type_key: 'confirmation_hearing',
    event_with: null,
    event_link_type: 'case',
    event_link_id: 'TYL6KJN8',
    superseded_by_event_id: null,
    supersede_reason: null,
  }, over);
}

function ap(over) {
  return Object.assign({
    appt_id: 900,
    appt_case_id: 'TYL6KJN8',
    appt_client_id: 1042,
    appt_type: 'Initial Strategy Session',
    type_key: 'iss',
    appt_status: 'Scheduled',
    appt_date: D('2026-09-01 14:00:00'),
    appt_end: D('2026-09-01 14:30:00'),
    appt_length: 30,
    appt_platform: 'telephone',
    appt_with: 1,
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
// state / resolution  (U3 — v0.5 §3.7, A7)
//
// status_norm is FROZEN and every one of its values is asserted above. This
// pair sits BESIDE it ("extended, not forked") and answers the question the
// single string cannot: `status_norm 'canceled'` cannot tell a deadline that was
// CANCELLED from one that became MOOT. Both are Canceled rows.
//
// events.event_resolution is NULL on all 156 live rows and has no writer until
// U6, so the fallback below IS the behaviour today, not an edge case.
// ─────────────────────────────────────────────────────────────────────────────

describe('state / resolution', () => {
  test.each([
    ['Scheduled', 'live',      null,        'scheduled'],
    ['Attended',  'resolved',  'attended',  'held'],
    ['No Show',   'resolved',  'no_show',   'missed'],
    ['Canceled',  'cancelled', 'cancelled', 'canceled'],
  ])('appt %s -> %s / %s, status_norm still %s', async (raw, state, res, sn) => {
    const db = stubDb(script3([CASE_A], [], [ap({ appt_status: raw })]));
    const [row] = await svc.listForCase(db, 'TYL6KJN8');
    expect(row.state).toBe(state);
    expect(row.resolution).toBe(res);
    expect(row.status_norm).toBe(sn);       // the R2 projection is untouched
  });

  test('the 6 blank-enum appts are LIVE with nothing recorded, never cancelled', async () => {
    // Same ruling as _normStatus (Fred, 2026-08-30): never launder unknown into
    // a real value. An appointment whose outcome nobody wrote down is not
    // thereby cancelled — reading it as 'cancelled' would delete six real 2024
    // appointments from every live-obligation count.
    const db = stubDb(script3([CASE_A], [], [ap({ appt_status: '' })]));
    const [row] = await svc.listForCase(db, 'TYL6KJN8');
    expect(row.state).toBe('live');
    expect(row.resolution).toBeNull();
    expect(row.status_norm).toBeNull();
  });

  test('an unknown appt status also reads live/null', () => {
    expect(svc._deriveState('appt', { appt_status: 'Nonsense' }, 'meeting', false))
      .toEqual({ state: 'live', resolution: null });
  });

  test.each([
    ['Scheduled', 'hearing',  'live',      null],
    ['Scheduled', 'deadline', 'live',      null],
    ['Completed', 'hearing',  'resolved',  'held'],
    ['Completed', 'deadline', 'resolved',  'met'],       // ← the kind-dependent fallback
    ['Completed', 'meeting',  'resolved',  'held'],
    ['Completed', null,       'resolved',  'held'],      // unmapped kind → held, not met
    ['Canceled',  'hearing',  'cancelled', 'cancelled'],
    ['Canceled',  'deadline', 'cancelled', 'cancelled'],
  ])('event %s + kind %s -> %s / %s (event_resolution NULL)', (status, kind, state, res) => {
    expect(svc._deriveState('event', { event_status: status, event_resolution: null }, kind, false))
      .toEqual({ state: state, resolution: res });
  });

  test('a Completed deadline reports MET, a Completed hearing reports HELD — end to end', async () => {
    const db = stubDb(script3([CASE_A], [
      ev({ event_id: 1, event_status: 'Completed', kind: 'deadline',
           type_key: 'docs_deadline', event_type: 'Docs Deadline', event_all_day: 1, event_time: null }),
      ev({ event_id: 2, event_status: 'Completed', kind: 'hearing' }),
    ], []));
    const rows = await svc.listForCase(db, 'TYL6KJN8');
    expect(rows.find(r => r.source_id === 1).resolution).toBe('met');
    expect(rows.find(r => r.source_id === 2).resolution).toBe('held');
    // Both still project to the same status_norm — that is the point of having
    // two fields rather than widening the frozen one.
    for (const r of rows) expect(r.status_norm).toBe('held');
  });

  test('a STORED event_resolution overrides the fallback', () => {
    // The day U6 stamps a real value, the row starts reporting it with no
    // migration. 'missed' on a Completed deadline is the sweep's output.
    expect(svc._deriveState('event', { event_status: 'Completed', event_resolution: 'missed' }, 'deadline', false))
      .toEqual({ state: 'resolved', resolution: 'missed' });
    expect(svc._deriveState('event', { event_status: 'Completed', event_resolution: 'held' }, 'deadline', false))
      .toEqual({ state: 'resolved', resolution: 'held' });
  });

  test('MOOT is the only Canceled resolution that overrides — the whole reason for the column', () => {
    // A cancelled deadline and a mooted one are both event_status='Canceled'.
    // Nothing else in the row distinguishes them.
    expect(svc._deriveState('event', { event_status: 'Canceled', event_resolution: 'moot' }, 'deadline', false))
      .toEqual({ state: 'cancelled', resolution: 'moot' });
    // Anything else stored on a Canceled row does NOT override: 'held' on a
    // cancelled hearing is a contradiction, and the status is the stronger fact.
    expect(svc._deriveState('event', { event_status: 'Canceled', event_resolution: 'held' }, 'hearing', false))
      .toEqual({ state: 'cancelled', resolution: 'cancelled' });
  });

  test('the column is SELECTed — without it every Canceled row would read cancelled', async () => {
    const db = stubDb(script3([CASE_A], [], []));
    await svc.listForCase(db, 'TYL6KJN8');
    expect(db.calls[1].sql).toMatch(/e\.event_resolution/);
  });

  test('an unreachable event_status reads live, not cancelled', () => {
    // event_status is NOT NULL DEFAULT 'Scheduled' with a three-value enum, so
    // this cannot happen on live data. If a non-strict-mode write ever put ''
    // there, the honest read is "live, nothing recorded" — matching the appt
    // side rather than inventing a cancellation nobody performed.
    expect(svc._deriveState('event', { event_status: '', event_resolution: null }, 'hearing', false))
      .toEqual({ state: 'live', resolution: null });
  });

  // ── superseded overrides everything ──────────────────────────────────────

  test('a superseded EVENT is state superseded, though its status says Canceled', async () => {
    // E0a's 31 dedup tombstones genuinely ARE Canceled. Reporting them
    // 'cancelled' would claim the COURT cancelled them; a July cleanup script
    // did. The pointer is what marks a row dead, never the status (E0a rule).
    const db = stubDb(script3([CASE_A], [ev({
      event_id: 41, event_status: 'Canceled',
      superseded_by_event_id: 51, supersede_reason: 'duplicate',
    })], []));
    const [row] = await svc.listForCase(db, 'TYL6KJN8', { includeSuperseded: true });
    expect(row.state).toBe('superseded');
    expect(row.resolution).toBeNull();
    expect(row.status_norm).toBe('canceled');   // the raw status still shows
    expect(row.superseded).toBe(true);
  });

  test('a Rescheduled appt tombstone is state superseded', async () => {
    const db = stubDb(script3([CASE_A], [], [ap({ appt_status: 'Rescheduled' })]));
    const [row] = await svc.listForCase(db, 'TYL6KJN8', { includeSuperseded: true });
    expect(row.state).toBe('superseded');
    expect(row.resolution).toBeNull();
    expect(row.status_norm).toBeNull();
  });

  test('superseded rows are still excluded by DEFAULT — state does not resurrect them', async () => {
    const db = stubDb(script3([CASE_A], [], []));
    await svc.listForCase(db, 'TYL6KJN8');
    expect(db.calls[1].sql).toMatch(/e\.superseded_by_event_id IS NULL/);
    expect(db.calls[2].sql).toMatch(/a\.appt_status <> 'Rescheduled'/);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// attendees  (U3 — v0.5 §3.6, A8: contract now, storage later)
//
// OPT-IN, like includeSuperseded. No child table, no joins: everything comes
// from columns the two queries already select. What ships is the SHAPE, so U6's
// write API and the portal can bind it before the storage question is answered.
//
// `blocks` mirrors services/availabilityService.js exactly — see the block
// comment on _deriveAttendees for the four rules and why NULL means the firm.
// ─────────────────────────────────────────────────────────────────────────────

describe('includeAttendees', () => {
  const calendarTypeService = require('../services/calendarTypeService');
  const SEED = require('./fixtures/calendar_item_types.seed.json');

  beforeEach(() => calendarTypeService._primeCache(SEED));
  afterEach(() => calendarTypeService.invalidate());

  test('OFF by default — the frozen row shape gains nothing', async () => {
    const db = stubDb(script3([CASE_A], [ev()], [ap()]));
    const rows = await svc.listForCase(db, 'TYL6KJN8');
    for (const r of rows) {
      expect('attendees' in r).toBe(false);
      expect('client_expected' in r).toBe(false);
    }
  });

  test('an appt yields its user host and its client', async () => {
    const db = stubDb(script3([CASE_A], [], [ap({ appt_with: 22, appt_client_id: 1042 })]));
    const [row] = await svc.listForCase(db, 'TYL6KJN8', { includeAttendees: true });
    expect(row.attendees).toEqual([
      { party: 'user',    id: 22,   role: 'host',     blocks: true,  notify: true },
      { party: 'contact', id: 1042, role: 'attendee', blocks: false, notify: true },
    ]);
  });

  test('a client-less appt yields the host alone (A3a tolerates no client)', async () => {
    // 58 live appts have no case and 12 have no client at all. apptService
    // already skips confirmations for these and still blocks the provider.
    const db = stubDb(script3([CASE_A], [], [ap({ appt_client_id: null })]));
    const [row] = await svc.listForCase(db, 'TYL6KJN8', { includeAttendees: true });
    expect(row.attendees).toEqual([
      { party: 'user', id: 1, role: 'host', blocks: true, notify: true },
    ]);
  });

  test('an appt NEVER carries client_expected — the row already answers it', async () => {
    // §3.6 puts client_expected on events only. An appt records the fact as
    // data; a registry OPINION beside it would disagree with the row itself on
    // every client-less appointment.
    const db = stubDb(script3([CASE_A], [], [ap()]));
    const [row] = await svc.listForCase(db, 'TYL6KJN8', { includeAttendees: true });
    expect('client_expected' in row).toBe(false);
  });

  test.each([
    [1,    [{ party: 'user', id: 1, role: 'host', blocks: true, notify: false }]],
    [null, [{ party: 'firm', id: null, role: 'host', blocks: true, notify: false }]],
    [0,    []],
  ])('event_with %s yields the right host', async (w, want) => {
    const db = stubDb(script3([CASE_A], [ev({ event_with: w })], []));
    const [row] = await svc.listForCase(db, 'TYL6KJN8', { includeAttendees: true });
    expect(row.attendees).toEqual(want);
  });

  test('event_with NULL is the FIRM, not an absent attendee', async () => {
    // availabilityService: a NULL event_with blocks EVERY provider. "Nobody in
    // particular" and "the whole firm" are opposite facts about the calendar
    // and 102 of 156 live rows are the latter.
    const db = stubDb(script3([CASE_A], [ev({ event_with: null })], []));
    const [row] = await svc.listForCase(db, 'TYL6KJN8', { includeAttendees: true });
    expect(row.attendees[0].party).toBe('firm');
    expect(row.attendees[0].blocks).toBe(true);
  });

  test('event_with 0 means NOBODY — no attendee row at all', () => {
    // Emitting one with blocks:false would claim a person is expected who
    // explicitly is not. No live row carries 0; the branch is defensive.
    expect(svc._deriveAttendees('event', { event_with: 0 }, false)).toEqual([]);
  });

  test('an ALL-DAY event never blocks, whatever event_with says', async () => {
    // availabilityService line ~294: `if (all_day) continue`, before the
    // event_with check. A deadline that blocked the calendar would make every
    // deadline day unbookable.
    const db = stubDb(script3([CASE_A], [ev({
      event_all_day: 1, event_time: null, event_with: 1,
      event_type: 'Docs Deadline', type_key: 'docs_deadline', kind: 'deadline',
    })], []));
    const [row] = await svc.listForCase(db, 'TYL6KJN8', { includeAttendees: true });
    expect(row.attendees[0].blocks).toBe(false);
    expect(row.attendees[0].party).toBe('user');
  });

  test('an all-day FIRM event also blocks nothing', () => {
    expect(svc._deriveAttendees('event', { event_with: null }, true))
      .toEqual([{ party: 'firm', id: null, role: 'host', blocks: false, notify: false }]);
  });

  test('events NEVER notify this slice', async () => {
    // eventService sends no client mail. Asserting true here would be a promise
    // no code keeps; U6/U8 decide whether a court date ever notifies.
    const db = stubDb(script3([CASE_A], [ev({ event_with: 1 })], []));
    const [row] = await svc.listForCase(db, 'TYL6KJN8', { includeAttendees: true });
    for (const a of row.attendees) expect(a.notify).toBe(false);
  });

  test('no contact is invented for an event', async () => {
    // Resolving "the client" for a case-linked event means joining
    // case→contacts and picking a Primary — a JOIN this layer refuses and a
    // case-ROLES question that is unowned (v0.5 §8.2).
    const db = stubDb(script3([CASE_A], [ev()], []));
    const [row] = await svc.listForCase(db, 'TYL6KJN8', { includeAttendees: true });
    expect(row.attendees.some(a => a.party === 'contact')).toBe(false);
  });

  test('client_expected comes from the registry, per type_key', async () => {
    // Seed: meeting_341 client_attends 1; confirmation_hearing 0.
    const db = stubDb(script3([CASE_A], [
      ev({ event_id: 1, type_key: 'meeting_341',          kind: 'meeting' }),
      ev({ event_id: 2, type_key: 'confirmation_hearing', kind: 'hearing' }),
    ], []));
    const rows = await svc.listForCase(db, 'TYL6KJN8', { includeAttendees: true });
    expect(rows.find(r => r.source_id === 1).client_expected).toBe(true);
    expect(rows.find(r => r.source_id === 2).client_expected).toBe(false);
  });

  test('an unmapped type_key is client_expected false, not a throw', async () => {
    const db = stubDb(script3([CASE_A], [ev({ type_key: null, event_type: 'Mediation', kind: 'other' })], []));
    const [row] = await svc.listForCase(db, 'TYL6KJN8', { includeAttendees: true });
    expect(row.client_expected).toBe(false);
    expect(row.type_key).toBe('Mediation');
  });

  test('a registry that will not load is client_expected false, NEVER a 500', async () => {
    // U2 R1.2 fail-soft, carried through: a missing registry must not make a
    // case timeline fail. loadRegistry swallows its own error and serves an
    // empty map; this asserts the timeline survives that.
    calendarTypeService.invalidate();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = stubDb([...script3([CASE_A], [ev()], []), new Error('ER_NO_SUCH_TABLE')]);
      // The 4th scripted entry is an Error; make the stub throw it.
      const inner = db.query;
      db.query = async (sql, params) => {
        const r = await inner(sql, params);
        if (r[0] instanceof Error) throw r[0];
        return r;
      };
      const [row] = await svc.listForCase(db, 'TYL6KJN8', { includeAttendees: true });
      expect(row.client_expected).toBe(false);
      expect(row.attendees).toBeDefined();
    } finally { warn.mockRestore(); }
  });

  test('the registry query is the FOURTH call and is issued once per call', async () => {
    // The budget contract, amended: includeAttendees costs at most one extra
    // query, AFTER the three positional ones so no existing index moves.
    calendarTypeService.invalidate();
    const db = stubDb([...script3([CASE_A], [ev()], [ap()]), SEED.map(r => ({
      ...r,
      ingest_aliases: JSON.stringify(r.ingest_aliases || []),
      case_types: r.case_types == null ? null : JSON.stringify(r.case_types),
    }))]);
    await svc.listForCase(db, 'TYL6KJN8', { includeAttendees: true });
    expect(db.calls).toHaveLength(4);
    expect(db.calls[3].sql).toMatch(/FROM calendar_item_types/);
  });

  test('a WARM registry cache costs nothing — the loop pays once a minute', async () => {
    const db = stubDb(script3([CASE_A], [ev()], [ap()]));   // primed in beforeEach
    await svc.listForCase(db, 'TYL6KJN8', { includeAttendees: true });
    expect(db.calls).toHaveLength(3);
  });

  test('an unknown case pays for no registry at all', async () => {
    calendarTypeService.invalidate();
    const db = stubDb([[]]);
    await expect(svc.listForCase(db, 'ghost', { includeAttendees: true }))
      .rejects.toMatchObject({ status: 404 });
    expect(db.calls).toHaveLength(1);
  });

  test('the attendee columns are SELECTed', async () => {
    const db = stubDb(script3([CASE_A], [], []));
    await svc.listForCase(db, 'TYL6KJN8');
    expect(db.calls[1].sql).toMatch(/e\.event_with/);
    expect(db.calls[2].sql).toMatch(/a\.appt_client_id/);
    expect(db.calls[2].sql).toMatch(/a\.appt_with/);
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

  test('default rows omit the superseded trio AND the attendee pair (frozen R2 shape)', async () => {
    // The E1 shape plus exactly the two U3 fields (v0.5 §3.7), and nothing else.
    // attendees / client_expected are opt-in and MUST NOT appear here: §3.1
    // freezes the default shape, so new information arrives as opt-ins.
    const db = stubDb(script3([CASE_A], [ev()], [ap()]));
    const rows = await svc.listForCase(db, 'TYL6KJN8');
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual([
        'all_day', 'case_id', 'ends_at', 'kind_key', 'location', 'resolution',
        'source', 'source_id', 'starts_at', 'state', 'status_norm', 'title',
        'type_key',
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
// Type keys — THE COLUMN IS TRUTH  (v0.5 §0.1 "U3 handoff site", §3.3)
//
// E1 derived these from a hard-coded vocabulary. U2 filled the column FROM that
// vocabulary, via a generated, byte-checked backfill. U3 reads the column. The
// parity gate at the bottom of this describe is what proves the third step did
// not move any row's answer — run against the real live census, not a sample.
// ─────────────────────────────────────────────────────────────────────────────

describe('type_key / kind_key come from the COLUMN', () => {
  test.each([
    ['confirmation_hearing', 'hearing'],
    ['meeting_341',          'meeting'],
    ['poc_gov_due',          'deadline'],
    ['deposition',           'conference'],
  ])('an event reports its stored key %s / kind %s verbatim', (tk, kk) => {
    expect(svc._deriveKeys('event', { event_type: 'anything at all', type_key: tk, kind: kk }))
      .toEqual({ type_key: tk, kind_key: kk });
  });

  test('the COLUMN wins over the type string — that IS the slice', async () => {
    // The row override case, generalized. Event 107's event_type is 'Order' and
    // its key is 'filing_fee_deadline' ("Order Extending Time to Pay Case Filing
    // Fee"): the string does not describe what the row IS. E1 carried four such
    // rows in a hand-kept map; U1 wrote them into the column and the map is gone.
    const db = stubDb(script3([CASE_A], [ev({
      event_id: 107, event_type: 'Order', type_key: 'filing_fee_deadline', kind: 'deadline',
    })], []));
    const [row] = await svc.listForCase(db, 'TYL6KJN8');
    expect(row.type_key).toBe('filing_fee_deadline');
    expect(row.kind_key).toBe('deadline');
  });

  test('an appt reports its stored key; kind is meeting BY TABLE (v0.5 §3.3.2)', () => {
    expect(svc._deriveKeys('appt', { appt_type: 'Initial Strategy Session', type_key: 'iss' }))
      .toEqual({ type_key: 'iss', kind_key: 'meeting' });
  });

  test('the 9 test appts stay kind meeting, though the registry calls the type other', async () => {
    // calendar_item_types.test.kind = 'other'. Reading kind from the registry
    // here would give an appt a kind whose storage rule says it belongs in
    // `events` — a row contradicting the table it is sitting in. E1 derived
    // 'meeting' for these; so does U3. By table, never by registry.
    const db = stubDb(script3([CASE_A], [], [ap({ appt_type: 'Pizza Party', type_key: 'test' })]));
    const [row] = await svc.listForCase(db, 'TYL6KJN8');
    expect(row.type_key).toBe('test');
    expect(row.kind_key).toBe('meeting');
  });

  test('341 is ONE key across both tables — the cross-table join U7 depends on', () => {
    expect(svc._deriveKeys('event', { event_type: '341', type_key: 'meeting_341', kind: 'meeting' }).type_key)
      .toBe(svc._deriveKeys('appt', { appt_type: '341 Meeting', type_key: 'meeting_341' }).type_key);
  });

  test('the columns are selected — a derivation cannot happen without them', async () => {
    const db = stubDb(script3([CASE_A], [], []));
    await svc.listForCase(db, 'TYL6KJN8');
    expect(db.calls[1].sql).toMatch(/e\.kind, e\.type_key/);
    expect(db.calls[2].sql).toMatch(/a\.type_key/);
  });

  // ── Unmapped rows: NULL key, raw label ────────────────────────────────────

  test('an unmapped EVENT keeps its label and gains kind other (U2 ruling D7)', () => {
    // The column stores type_key NULL + kind 'other' for a non-blank string the
    // registry did not recognise. The raw passthrough is a LABEL, not a key: no
    // consumer matching type_key === 'meeting_341' can ever match 'Mediation'.
    // It exists so the row renders with its name and shows up in U9's
    // mint-me-a-type worklist instead of rendering blank.
    expect(svc._deriveKeys('event', { event_type: 'Mediation', type_key: null, kind: 'other' }))
      .toEqual({ type_key: 'Mediation', kind_key: 'other' });
  });

  test('an unmapped string is NEVER laundered into a real key', () => {
    // v0.5 §3.3.2: a guessed kind='meeting' would route the item to the wrong
    // TABLE. The failure mode of guessing is structural, not cosmetic.
    const got = svc._deriveKeys('event', { event_type: 'Brand New Court Thing', type_key: null, kind: 'other' });
    expect(got.type_key).toBe('Brand New Court Thing');
    expect(got.type_key).not.toBe('meeting');
    expect(got.kind_key).toBe('other');
  });

  test('a NULL or blank type with a NULL key yields nulls — absent data', () => {
    // The 8 live appt_type IS NULL rows (v0.5 §8.1: type_key NULL by ruling).
    expect(svc._deriveKeys('appt', { appt_type: null, type_key: null }))
      .toEqual({ type_key: null, kind_key: null });
    expect(svc._deriveKeys('appt', { appt_type: '   ', type_key: null }))
      .toEqual({ type_key: null, kind_key: null });
    expect(svc._deriveKeys('event', { event_type: '', type_key: null, kind: null }))
      .toEqual({ type_key: null, kind_key: null });
  });

  test('the read layer NEVER warns — the write path already did', () => {
    // E1 warned once per unmapped string per process. A read layer that warns
    // about a row it did not create warns forever, once per page per row, about
    // a condition calendarTypeService already logged at write time.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      svc._deriveKeys('event', { event_type: 'Mediation', type_key: null, kind: 'other' });
      svc._deriveKeys('appt', { appt_type: 'Nobody Seeded This', type_key: null });
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  test('prototype-shaped values are strings, not lookups', () => {
    // The vocabulary was a Map for this reason. A column read has no lookup at
    // all, so the hazard is gone — pinned so a future "optimization" back to an
    // object literal has to argue with a test.
    expect(svc._deriveKeys('event', { event_type: 'constructor', type_key: null, kind: 'other' }))
      .toEqual({ type_key: 'constructor', kind_key: 'other' });
    expect(svc._deriveKeys('appt', { appt_type: '__proto__', type_key: null }))
      .toEqual({ type_key: '__proto__', kind_key: 'meeting' });
  });

  // ── THE PARITY GATE ───────────────────────────────────────────────────────
  //
  // v0.5 §0.1 promises: "no row changed key the day the column landed — which is
  // what makes U3's swap a no-op on the data." This is that promise, executed.
  //
  // The census below is DATA, measured live 2026-09-01 with
  //   SELECT CAST(event_type AS BINARY), kind, type_key, COUNT(*)
  //     FROM events GROUP BY CAST(event_type AS BINARY), kind, type_key
  // and the appt equivalent. BINARY, not the default ci — a ci GROUP BY collapses
  // spelling variants covering 19% of appts and would hide exactly the rows most
  // likely to diverge (the E1 collation finding, 2026-08-30).
  //
  // Every combination is run through the new derivation and checked against what
  // the frozen vocabulary would have returned. Two rows differ, both named and
  // both asserted individually below. Everything else is byte-identical.
  // ─────────────────────────────────────────────────────────────────────────

  describe('parity gate — the column returns what the vocabulary returned', () => {
    const vocabulary = require('../scripts/typeKeyVocabulary');

    /** Exactly E1's _deriveKeys, reconstructed from the frozen maps. */
    function e1Derive(source, rawType, sourceId) {
      if (source === 'event') {
        const ov = vocabulary.EVENT_ROW_OVERRIDES.get(Number(sourceId));
        if (ov) return { type_key: ov[0], kind_key: ov[1] };
      }
      const raw = rawType == null ? '' : String(rawType);
      if (raw.trim() === '') return { type_key: null, kind_key: null };
      const hit = (source === 'event' ? vocabulary.EVENT_TYPE_KEYS : vocabulary.APPT_TYPE_KEYS)
        .get(vocabulary._vkey(raw));
      if (hit) return { type_key: hit[0], kind_key: hit[1] };
      return { type_key: raw, kind_key: null };
    }

    // events: [event_type, kind, type_key, rows, representative_event_id]
    // The id matters only for the four override rows; 999 elsewhere.
    const EVENT_CENSUS = [
      ['Confirmation Hearing',              'hearing',    'confirmation_hearing',              23, 999],
      ['341',                               'meeting',    'meeting_341',                       16, 999],
      ['dischargeability_due',              'deadline',   'dischargeability_due',              16, 999],
      ['Hearing',                           'hearing',    'hearing',                           14, 999],
      ['Docs Deadline',                     'deadline',   'docs_deadline',                     13, 999],
      ['Schedules Deadline',                'deadline',   'schedules_deadline',                11, 999],
      ['Confirmation Certificate Deadline', 'deadline',   'confirmation_certificate_deadline', 10, 999],
      ['object_confirmation_due',           'deadline',   'object_confirmation_due',            9, 999],
      ['poc_due',                           'deadline',   'poc_due',                            9, 999],
      ['poc_gov_due',                       'deadline',   'poc_gov_due',                        9, 999],
      ['confirmation_hearing',              'hearing',    'confirmation_hearing',               7, 999],
      ['Show Cause',                        'hearing',    'show_cause',                         3, 999],
      ['Deadline',                          'deadline',   'deadline',                           2, 999],
      ['Deadline',                          'other',      'test',                               1,   6],  // override
      ['Deposition',                        'conference', 'deposition',                         1, 999],
      ['Filing Fee Deadline',               'deadline',   'filing_fee_deadline',                1, 999],
      ['Filing Fee Installment Deadline',   'deadline',   'filing_fee_installment_deadline',    1, 999],
      ['Initial Scheduling Conference',     'conference', 'scheduling_conference',              1, 999],
      ['Mediation',                         'other',      null,                                 1, 156],  // ← DIFFERS
      ['Milestone',                         'other',      'test',                               1,   4],  // override
      ['Order',                             'deadline',   'filing_fee_deadline',                1, 107],  // override
      ['Pre-trial Conference',              'conference', 'pretrial_conference',                1, 999],
      ['Show Cause Hearing',                'hearing',    'show_cause',                         1, 999],
      ['Status Conference',                 'conference', 'status_conference',                  1, 999],
      ['Telephonic Status Conference',      'conference', 'status_conference',                  1, 999],
      ['Trial',                             'hearing',    'trial',                              1, 999],
      ['Trial / Pre-Trial Hearing',         'hearing',    'trial',                              1, 134],  // override
    ];

    // appts: [appt_type, type_key, rows]
    const APPT_CENSUS = [
      ['Initial Strategy Session',      'iss',               924],
      ['Pre-filing Meeting',            'pre_filing',        316],
      ['Strategy Session',              'ss',                276],
      ['341 Meeting',                   'meeting_341',       241],
      ['Strategy Session Follow Up',    'ss_follow_up',      173],
      ['Schedules Completion Meeting',  'schedules_meeting', 121],
      ['Meeting',                       'meeting',           108],
      ['Pre-Filing Meeting',            'pre_filing',         15],
      [null,                            null,                  8],
      ['Consultation',                  'consultation',        7],
      ['meeting',                       'meeting',             5],
      ['Pre-Lawsuit Meeting',           'pre_lawsuit',         2],
      ['Tax Consult',                   'tax_consult',         2],
      ['test',                          'test',                2],
      ['Case Status Review',            'meeting',             1],
      ['Documents Completion Meeting',  'docs_meeting',        1],
      ['Follow Up',                     'ss_follow_up',        1],
      ['Intial Strategy Session',       'iss',                 1],   // the live typo
      ['Matrix Completion Meeting',     'matrix_meeting',      1],
      ['Pizza Party',                   'test',                1],
      ['Potato Hunting',                'test',                1],   // ← DIFFERS
      ['Pre Lawsuit Meeting',           'pre_lawsuit',         1],
      ['Pre-filing (30 min)',           'pre_filing',          1],
      ['Repetitive Session',            'test',                1],
      ['Schedules completion meeting',  'schedules_meeting',   1],
      ['Test Appointment',              'test',                1],
      ['bug hunting Session',           'test',                1],
      ['test appt',                     'test',                1],
      ['test2 appt',                    'test',                1],
      ['test3 appt',                    'test',                1],
      ['to go over claims',             'meeting',             1],
      ['to go over objections to Chapt', 'meeting',            1],
    ];

    /** The two rows that legitimately moved. Anything else is a regression. */
    const KNOWN_DIFFS = new Set(['event:Mediation', 'appt:Potato Hunting']);

    test('the census is the whole table — row counts reconcile', () => {
      // If somebody adds a type without re-censusing, these sums drift and the
      // gate silently stops covering the new rows.
      expect(EVENT_CENSUS.reduce((a, r) => a + r[3], 0)).toBe(156);
      expect(APPT_CENSUS.reduce((a, r) => a + r[2], 0)).toBe(2218);
      expect(EVENT_CENSUS).toHaveLength(27);
      expect(APPT_CENSUS).toHaveLength(32);
    });

    test('EVERY live event combination derives what E1 derived', () => {
      const moved = [];
      for (const [type, kind, key, , id] of EVENT_CENSUS) {
        const now = svc._deriveKeys('event', { event_type: type, kind, type_key: key });
        const then = e1Derive('event', type, id);
        if (now.type_key !== then.type_key || now.kind_key !== then.kind_key) {
          moved.push({ type, then, now });
        }
      }
      expect(moved.map((m) => `event:${m.type}`).filter((k) => !KNOWN_DIFFS.has(k))).toEqual([]);
      expect(moved).toHaveLength(1);
    });

    test('EVERY live appt combination derives what E1 derived', () => {
      const moved = [];
      for (const [type, key] of APPT_CENSUS) {
        const now = svc._deriveKeys('appt', { appt_type: type, type_key: key });
        const then = e1Derive('appt', type, 999);
        if (now.type_key !== then.type_key || now.kind_key !== then.kind_key) {
          moved.push({ type, then, now });
        }
      }
      expect(moved.map((m) => `appt:${m.type}`).filter((k) => !KNOWN_DIFFS.has(k))).toEqual([]);
      expect(moved).toHaveLength(1);
    });

    test('NAMED DIFF 1 — event 156 Mediation: kind_key null → other', () => {
      // U2 ruling D7. A non-blank unmapped type is stored type_key NULL AND
      // kind 'other'; E1 returned kind_key null. 'other' is the more honest
      // answer — the row IS classified, as none-of-the-four — and it is what
      // makes §7.1 rule 8's straggler gate readable: kind 'other' + NULL key is
      // a type to mint, kind NULL is a write-path bug.
      //
      // The row is unlinked (event_link_type NULL), so it reaches no case
      // timeline; only the link audit sees it.
      expect(e1Derive('event', 'Mediation', 156))
        .toEqual({ type_key: 'Mediation', kind_key: null });
      expect(svc._deriveKeys('event', { event_type: 'Mediation', type_key: null, kind: 'other' }))
        .toEqual({ type_key: 'Mediation', kind_key: 'other' });
    });

    test('NAMED DIFF 2 — appt Potato Hunting: the column knows an alias E1 never did', () => {
      // appt 3966, created 2026-09-01 11:09 (after the U2 backend deploy).
      // 'Potato Hunting' is a booking_views.appt_type that resolves only through
      // calendar_item_types.test.ingest_aliases, which the write path consults
      // and the frozen vocabulary never contained. E1 would have passed it
      // through raw with a null kind; the column says 'test'.
      //
      // This is the alignment working, not a defect: the registry is editable
      // data and the frozen list is a 2026-08-30 snapshot. It is asserted by
      // name so a THIRD such row cannot appear without this gate going red.
      expect(e1Derive('appt', 'Potato Hunting', 999))
        .toEqual({ type_key: 'Potato Hunting', kind_key: null });
      expect(svc._deriveKeys('appt', { appt_type: 'Potato Hunting', type_key: 'test' }))
        .toEqual({ type_key: 'test', kind_key: 'meeting' });
    });
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Title / location
// ─────────────────────────────────────────────────────────────────────────────

describe('title and location', () => {
  test('an event uses its real event_title, not the type string', async () => {
    const db = stubDb(script3([CASE_A], [ev({
      event_type: 'Hearing', type_key: 'hearing',
      event_title: 'Hearing on Motion to Dismiss Adversary Proceeding',
    })], []));
    const [row] = await svc.listForCase(db, 'TYL6KJN8');
    expect(row.title).toBe('Hearing on Motion to Dismiss Adversary Proceeding');
    expect(row.type_key).toBe('hearing');       // title is display; key is the column
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
// auditEventLinks
//
// THE FRAMING IS THE FEATURE. An event is ALLOWED to be attached to nothing:
// the columns are nullable, eventService._normalizeLink returns cleanly for an
// absent link (it throws only on a HALF link), listEvents does not filter it
// out, eventform renders '—' and calendar.html renders it without a case line.
// A firm-wide event — office closed, a CLE seminar — is exactly this shape.
//
// E1 shipped this as an "orphan audit" and lumped that supported state in with
// two broken ones. It read as garbage only because the single live unlinked row
// happens to be a Canceled test row ("Reminder smoke"). These tests pin the
// three conditions APART so nobody re-collapses them and has staff "cleaning
// up" the first real firm-wide event somebody creates.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The audit query's OUTER where clause.
 *
 * A naive `sql.split(/\bWHERE\b/)[1]` stops at the first subquery's WHERE and
 * silently asserts against the wrong fragment. Slicing between `FROM events e`
 * and `ORDER BY` also excludes the SELECT list, whose CASE expression mentions
 * every branch condition and would make every negative assertion pass.
 */
const whereOf = (sql) => sql.split('FROM events e')[1].split('ORDER BY')[0];

const auditRow = (over) => Object.assign({
  event_id: 4, event_type: 'Milestone', event_title: 'Reminder smoke',
  event_date: D('2026-05-01 00:00:00'), event_time: null, event_all_day: 1,
  event_status: 'Canceled', event_location: null,
  event_link_type: null, event_link_id: null,
  superseded_by_event_id: null, supersede_reason: null, reason: 'unlinked',
}, over);

/**
 * An appt audit row (U3). Defaults to the `unlinked` shape: no case, no client.
 * Live 2026-09-01 there are 12 of these and 8 broken.
 */
const auditAppt = (over) => Object.assign({
  appt_id: 3801, appt_type: 'Strategy Session', type_key: 'ss',
  appt_date: D('2026-05-14 11:45:00'), appt_status: 'Canceled',
  appt_platform: 'telephone', appt_case_id: '', appt_client_id: null,
  reason: 'unlinked',
}, over);

/**
 * The audit is TWO queries at U3 — events then appts — so every script needs a
 * second result set. `auditScript` says that once instead of thirty times, and
 * names which half is which at each call site.
 */
const auditScript = (events = [], appts = []) => [events, appts];

describe('auditEventLinks — the events half (E1, unchanged at U3)', () => {
  test('covers all three conditions and excludes contact-linked rows', async () => {
    const db = stubDb(auditScript());
    await svc.auditEventLinks(db);
    const sql = db.calls[0].sql;
    expect(sql).toMatch(/e\.event_link_type IS NULL/);
    expect(sql).toMatch(/event_link_type = 'case_number' AND NOT EXISTS/);
    expect(sql).toMatch(/event_link_type = 'case' AND NOT EXISTS/);
    expect(sql).toMatch(/c\.case_number = e\.event_link_id OR c\.case_number_full/);
    // A contact-linked event resolves — to a contact. Not a link fault.
    expect(sql).not.toMatch(/'contact'/);
  });

  test('an unlinked row is severity "unlinked", NOT broken and NOT an orphan', async () => {
    const db = stubDb(auditScript([auditRow()]));
    const { counts, items } = await svc.auditEventLinks(db);
    expect(items[0]).toMatchObject({
      source: 'event', event_id: 4, severity: 'unlinked', reason: 'unlinked',
      event_date: '2026-05-01', all_day: true, link_type: null, link_id: null,
    });
    expect(counts).toMatchObject({ broken: 0, pending: 0, unlinked: 1, total: 1 });
  });

  test('the three severities are counted separately', async () => {
    const db = stubDb(auditScript([
      auditRow({ event_id: 4 }),
      auditRow({ event_id: 88, event_link_type: 'case_number', event_link_id: '99-00000',
                 event_type: 'Hearing', event_title: 'Hearing', event_all_day: 0,
                 event_time: '10:00:00', event_status: 'Scheduled',
                 reason: 'unresolved_case_number' }),
      auditRow({ event_id: 90, event_link_type: 'case', event_link_id: 'GONE1234',
                 reason: 'dead_case_id' }),
    ]));
    const { counts, items } = await svc.auditEventLinks(db);
    expect(counts).toMatchObject({ broken: 1, pending: 1, unlinked: 1, total: 3 });
    expect(items.map(i => i.severity)).toEqual(['unlinked', 'pending', 'broken']);
    expect(items[1].event_time).toBe('10:00:00');
    expect(items[1].all_day).toBe(false);
  });

  test('severity filtering happens in SQL, not by slicing the result', async () => {
    // The UI's "unlinked only" view must not pull broken rows over the wire to
    // throw them away.
    const db = stubDb(auditScript());
    await svc.auditEventLinks(db, { severity: ['unlinked'] });
    const where = whereOf(db.calls[0].sql);
    expect(where).toMatch(/event_link_type IS NULL/);
    expect(where).not.toMatch(/NOT EXISTS/);      // neither broken nor pending branch
  });

  test.each([
    // The third column is the QUERY COUNT, which is branch-dependent at U3:
    // 'broken' asks both tables, 'pending' asks only events (appts have no
    // docket anchor until A3a). scriptGuard fails an under-consumed script, so
    // the count has to be stated rather than assumed.
    ['broken',   /c\.case_id = e\.event_link_id/, 2],
    ['pending',  /case_number_full/,               1],
  ])('filtering to %s emits only that branch', async (sev, re, queries) => {
    const db = stubDb(Array.from({ length: queries }, () => []));
    await svc.auditEventLinks(db, { severity: [sev] });
    const where = whereOf(db.calls[0].sql);
    expect(where).toMatch(re);
    expect(where).not.toMatch(/event_link_type IS NULL/);
    expect(db.calls).toHaveLength(queries);
  });

  test('counts always carry all three keys, even when filtered', async () => {
    // A zero you asked to hide is still a zero worth seeing — the UI's segment
    // control would otherwise blank out the options you are not looking at.
    const db = stubDb(auditScript([auditRow()]));
    const { counts } = await svc.auditEventLinks(db, { severity: ['unlinked'] });
    expect(Object.keys(counts).sort()).toEqual(['appts', 'broken', 'pending', 'total', 'unlinked']);
    expect(counts.broken).toBe(0);
  });

  test('unknown severities are dropped; an all-unknown filter returns nothing', async () => {
    const db = stubDb([]);
    const { counts, items } = await svc.auditEventLinks(db, { severity: ['nonsense'] });
    expect(items).toEqual([]);
    expect(counts.total).toBe(0);
    expect(counts.appts.total).toBe(0);
    // Zero queries: quietly widening to ALL would show more than was asked for.
    expect(db.calls).toHaveLength(0);
  });

  test('a half-written link reports as unlinked, not as a dead pointer', async () => {
    // A blank id points at nothing in particular, which is not the same claim
    // as pointing at a case that was deleted. The CASE expression tests the
    // no-link branch first for exactly this reason.
    const db = stubDb(auditScript());
    await svc.auditEventLinks(db);
    const caseExpr = db.calls[0].sql.split('CASE')[1].split('END')[0];
    expect(caseExpr.indexOf("'unlinked'"))
      .toBeLessThan(caseExpr.indexOf("'dead_case_id'"));
  });

  test('two queries at U3 — events then appts — and no parameters on either', async () => {
    // E1 was one query. Widening to appts is a SECOND shaped query rather than
    // a UNION: the tables share no column names, so a union would alias eleven
    // columns twice to produce rows that still need a `source` discriminator.
    const db = stubDb(auditScript());
    await svc.auditEventLinks(db);
    expect(db.calls).toHaveLength(2);
    expect(db.calls[0].sql).toMatch(/FROM events e/);
    expect(db.calls[1].sql).toMatch(/FROM appts a/);
    expect(db.calls[0].params).toEqual([]);
    expect(db.calls[1].params).toEqual([]);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// auditEventLinks — the appts half (U3, v0.5 §0.1 "the same split applies to
// appts once A3a lands" — two thirds of it land now)
//
// Live 2026-09-01: broken 8, pending 0, unlinked 12, total 20.
//
//   broken    5 rows whose appt_case_id is the literal '<TEST>' (no such case)
//             + 3 rows (1786, 2477, 2908) whose appt_client_id names a deleted
//             contact. Either dead pointer is the same defect.
//   unlinked  12 rows with neither anchor. Legitimate, like an unlinked event.
//   pending    0, and structurally so: appts have no docket anchor until A3a.
//
// The 46 appts with a blank case_id and a LIVE client are in NONE of these.
// They are consultations booked before a case exists — the commonest shape in
// the whole booking flow — and calling them a fault would put a fifth of this
// year's intake on a cleanup list.
// ─────────────────────────────────────────────────────────────────────────────

describe('auditEventLinks — the appts half', () => {
  test('an appt with neither anchor is unlinked', async () => {
    const db = stubDb(auditScript([], [auditAppt()]));
    const { counts, items } = await svc.auditEventLinks(db);
    expect(counts.appts).toEqual({ broken: 0, pending: 0, unlinked: 1, total: 1 });
    expect(items[0]).toMatchObject({
      source: 'appt', appt_id: 3801, severity: 'unlinked', reason: 'unlinked',
      case_id: null, client_id: null, all_day: false,
      event_date: '2026-05-14', event_time: '11:45:00',
    });
  });

  test('a dead case pointer is broken', async () => {
    const db = stubDb(auditScript([], [auditAppt({
      appt_id: 3855, appt_case_id: '<TEST>', appt_client_id: 1001, reason: 'dead_anchor',
    })]));
    const { counts, items } = await svc.auditEventLinks(db);
    expect(counts.appts).toMatchObject({ broken: 1, unlinked: 0, total: 1 });
    expect(items[0]).toMatchObject({
      source: 'appt', severity: 'broken', reason: 'dead_anchor',
      case_id: '<TEST>', client_id: 1001,
    });
  });

  test('a dead CONTACT pointer is broken too, on a row whose case is fine', async () => {
    // ids 1786 / 2477 / 2908 live. A row can have a perfectly good case and a
    // client_id pointing at a contact somebody deleted; the appointment still
    // half-refers to nobody.
    const db = stubDb(auditScript([], [auditAppt({
      appt_id: 1786, appt_case_id: 'M3BWQIek', appt_client_id: 1073,
      appt_type: 'Pre-filing Meeting', type_key: 'pre_filing',
      appt_status: 'No Show', reason: 'dead_anchor',
    })]));
    const { counts, items } = await svc.auditEventLinks(db);
    expect(counts.appts.broken).toBe(1);
    expect(items[0]).toMatchObject({ severity: 'broken', case_id: 'M3BWQIek', client_id: 1073 });
  });

  test('BOTH dead pointers are ONE broken row, not two', async () => {
    // The caller's question is "is this row's anchor real". A row with both
    // pointers dead is one broken appointment.
    const db = stubDb(auditScript([], [auditAppt({
      appt_case_id: 'GONE', appt_client_id: 99999, reason: 'dead_anchor',
    })]));
    const { counts, items } = await svc.auditEventLinks(db);
    expect(counts.appts.total).toBe(1);
    expect(items).toHaveLength(1);
  });

  test('the SQL asks both dead-pointer questions and the no-anchor one', async () => {
    const db = stubDb(auditScript());
    await svc.auditEventLinks(db);
    const ap = db.calls[1].sql;
    expect(ap).toMatch(/FROM cases c WHERE c\.case_id = a\.appt_case_id/);
    expect(ap).toMatch(/FROM contacts ct WHERE ct\.contact_id = a\.appt_client_id/);
    expect(ap).toMatch(/TRIM\(a\.appt_case_id\) = '' AND a\.appt_client_id IS NULL/);
    // A blank case WITH a live client is neither condition — the 46 live
    // pre-case consultations must not be swept up.
    expect(ap).not.toMatch(/appt_case_id = '' AND a\.appt_client_id IS NOT NULL/);
  });

  test('unlinked-first in the CASE, same reason as the events side', async () => {
    const db = stubDb(auditScript());
    await svc.auditEventLinks(db);
    const expr = db.calls[1].sql.split('CASE')[1].split('END')[0];
    expect(expr.indexOf("'unlinked'")).toBeLessThan(expr.indexOf("'dead_anchor'"));
  });

  test('appt severity filtering happens in SQL', async () => {
    const db = stubDb(auditScript());
    await svc.auditEventLinks(db, { severity: ['unlinked'] });
    const ap = db.calls[1].sql;
    expect(ap).toMatch(/TRIM\(a\.appt_case_id\) = ''/);
    expect(ap).not.toMatch(/NOT EXISTS/);
  });

  test('pending ALONE issues no appt query — it could only return zero rows', async () => {
    // Appts have no docket anchor until A3a, so there is nothing to be pending
    // about. Paying a round trip to prove that is the waste the SQL-side filter
    // exists to avoid.
    const db = stubDb([[]]);
    const { counts } = await svc.auditEventLinks(db, { severity: ['pending'] });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toMatch(/FROM events e/);
    // Still reported as a zero: absence of the key would read as "not audited",
    // which is a different claim from "audited, none found".
    expect(counts.appts).toEqual({ broken: 0, pending: 0, unlinked: 0, total: 0 });
  });

  test('appt pending is ALWAYS zero, even asked for alongside the others', async () => {
    const db = stubDb(auditScript([], [auditAppt(), auditAppt({ appt_id: 3802, reason: 'dead_anchor', appt_case_id: 'GONE' })]));
    const { counts } = await svc.auditEventLinks(db);
    expect(counts.appts.pending).toBe(0);
  });

  test('the events counts are NOT polluted by appt rows', async () => {
    // counts.broken and friends stay the EVENTS figures so an E1-era consumer
    // cannot silently start counting appointments.
    const db = stubDb(auditScript(
      [auditRow()],
      [auditAppt(), auditAppt({ appt_id: 3802, appt_case_id: 'GONE', reason: 'dead_anchor' })]
    ));
    const { counts, items } = await svc.auditEventLinks(db);
    expect(counts).toMatchObject({ broken: 0, pending: 0, unlinked: 1, total: 1 });
    expect(counts.appts).toEqual({ broken: 1, pending: 0, unlinked: 1, total: 2 });
    expect(items.map(i => i.source)).toEqual(['event', 'appt', 'appt']);
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

  test('include_attendees=1 maps to the opt; anything else leaves it off', async () => {
    // Same flag() helper as include_superseded — one line in the route, and the
    // gate is testable over HTTP rather than only through the service.
    const calendarTypeService = require('../services/calendarTypeService');
    calendarTypeService._primeCache(require('./fixtures/calendar_item_types.seed.json'));
    try {
      const on = stubDb(script3([CASE_A], [ev()], []));
      const body = (await get(app(on), '/api/cases/TYL6KJN8/events?include_attendees=1')).body;
      expect(Array.isArray(body.events[0].attendees)).toBe(true);
      expect(body.events[0].client_expected).toBe(false);   // confirmation_hearing

      for (const q of ['', '?include_attendees=0', '?include_attendees=']) {
        const off = stubDb(script3([CASE_A], [ev()], []));
        const b = (await get(app(off), `/api/cases/TYL6KJN8/events${q}`)).body;
        expect('attendees' in b.events[0]).toBe(false);
        expect('client_expected' in b.events[0]).toBe(false);
      }
    } finally { calendarTypeService.invalidate(); }
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

  test('GET /api/case-events/audit returns counts + items for BOTH sources', async () => {
    const db = stubDb(auditScript([auditRow()], [auditAppt()]));
    const { status, body } = await get(app(db), '/api/case-events/audit');
    expect(status).toBe(200);
    expect(body.status).toBe('success');
    // The E1-era keys keep meaning EVENTS. The appt figures arrive additively,
    // so a consumer bound to body.counts.unlinked keeps counting events.
    expect(body.counts).toEqual({
      broken: 0, pending: 0, unlinked: 1, total: 1,
      appts: { broken: 0, pending: 0, unlinked: 1, total: 1 },
    });
    expect(body.items[0]).toMatchObject({ source: 'event', event_id: 4, severity: 'unlinked' });
    expect(body.items[1]).toMatchObject({ source: 'appt', appt_id: 3801, severity: 'unlinked' });
  });

  test('?severity= filters, CSV and repeated both', async () => {
    for (const q of ['?severity=unlinked', '?severity=unlinked,unlinked']) {
      const db = stubDb(auditScript());
      await get(app(db), `/api/case-events/audit${q}`);
      expect(whereOf(db.calls[0].sql)).not.toMatch(/NOT EXISTS/);
    }
    const multi = stubDb(auditScript());
    await get(app(multi), '/api/case-events/audit?severity=broken&severity=pending');
    const where = whereOf(multi.calls[0].sql);
    expect(where).toMatch(/c\.case_id = e\.event_link_id/);
    expect(where).toMatch(/case_number_full/);
    expect(where).not.toMatch(/event_link_type IS NULL/);
  });

  test('a typo\'d severity narrows rather than 400s, and never widens', async () => {
    // Diagnostics list: a bad filter should show LESS, never more. Quietly
    // showing everything when the caller asked for one thing is the worse bug.
    const db = stubDb([]);
    const { status, body } = await get(app(db), '/api/case-events/audit?severity=brokn');
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  test('no severity param means all three', async () => {
    const db = stubDb(auditScript());
    await get(app(db), '/api/case-events/audit');
    const where = whereOf(db.calls[0].sql);
    expect(where).toMatch(/event_link_type IS NULL/);
    expect(where).toMatch(/c\.case_id = e\.event_link_id/);
    expect(where).toMatch(/case_number_full/);
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
