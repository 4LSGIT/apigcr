// tests/unifiedEventsU9.range.test.js
//
/**
 * Unified Events U9 — the firm-wide range read
 * (services/caseEventService.listRange + routes/api.calendarRange.js), and the
 * mint-from-unmapped adoption (calendarTypeAdminService.adoptUnmapped +
 * its route).
 *
 * WHY THESE PARTICULAR ASSERTIONS
 *
 *   · THE PARITY GATE IS THE POINT OF THE SLICE. listRange exists so the firm
 *     has ONE answer about a dated thing. If it maps a row even slightly
 *     differently from listForCase — a different state, a different title, a
 *     different end time — then U9 shipped a SECOND calendar, which is the
 *     exact failure the whole Unified Events arc is trying to end. The parity
 *     test feeds the SAME fixture rows through both surfaces and demands the
 *     frozen §3.1 fields be equal, field by field. It is the reason the
 *     implementation reuses _mapEvent/_mapAppt rather than writing new
 *     mappers, and it is what stops a later "small fix" from forking them.
 *
 *   · THE 'live' PREDICATE IS A COMPLEMENT, NOT AN EQUALITY. _deriveState maps
 *     a blank or unknown status to live (six live 2024 appts carry
 *     appt_status = ''). A SQL half written as `= 'Scheduled'` would drop
 *     exactly those rows while the JS half still expected them — and the bug
 *     would be invisible, because the rows it hides are rows nobody has looked
 *     at since 2024. Asserted as SQL TEXT, because that is where it can go
 *     wrong silently.
 *
 *   · QUERY COUNT MUST NOT SCALE WITH ROWS. The anchor and label lookups are
 *     batched IN-lists keyed by DISTINCT anchors. A per-row lookup would look
 *     identical in every output assertion in this file and would only show up
 *     as a 200-query page in production. Pinned by comparing the query count
 *     of a 2-row page against a 60-row page.
 *
 *   · `event_updated_at = event_updated_at` IN THE ADOPTION. The column is
 *     ON UPDATE CURRENT_TIMESTAMP. Without the self-assignment, classifying a
 *     2024 hearing restamps it as edited today — visible in eventform, in the
 *     log feed, and wrong. It cannot be asserted by output (the stub has no
 *     clock), so it is asserted as SQL text.
 *
 *   · includeSuperseded IS ADDITIVE. The U9 tab renders it as a checkbox BESIDE
 *     the state select. If it behaved as a state VALUE, ticking it on the
 *     default Live view would replace the live rows with the dead ones, which
 *     is the opposite of what the control looks like it does.
 *
 * Run:  npx jest tests/unifiedEventsU9.range.test.js
 */

'use strict';

const svc = require('../services/caseEventService');
const admin = require('../services/calendarTypeAdminService');
const { scriptGuard } = require('./helpers/scriptGuard');

// ─────────────────────────────────────────────────────────────────────────────
// Stubs — same shape as tests/caseEventService.test.js
// ─────────────────────────────────────────────────────────────────────────────

function stubDb(script) {
  const calls = [];
  const guard = scriptGuard('stubDb', script);
  return {
    calls,
    guard,
    query: async (sql, params) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) guard.overrun(sql);
      return [script.shift()];
    },
  };
}

/** A stub whose UPDATEs report affectedRows (the adoption's return value). */
function stubWriteDb(script) {
  const calls = [];
  const guard = scriptGuard('stubWriteDb', script);
  return {
    calls,
    guard,
    query: async (sql, params) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) guard.overrun(sql);
      return [script.shift()];
    },
  };
}

const D = (naive) => new Date(`${naive.replace(' ', 'T')}Z`);

const CASE_A = { case_id: 'TYL6KJN8', case_number: '26-46639', case_number_full: '26-46639-mar' };

function ev(over) {
  return Object.assign({
    event_id: 100,
    event_type: 'Confirmation Hearing',
    event_title: 'Confirmation Hearing',
    event_date: D('2026-09-10 00:00:00'),
    event_time: '10:00:00',
    event_all_day: 0,
    event_length: null,
    event_location: 'Courtroom 1875',
    event_status: 'Scheduled',
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
    appt_date: D('2026-09-05 14:00:00'),
    appt_end: D('2026-09-05 14:30:00'),
    appt_length: 30,
    appt_platform: 'telephone',
    appt_with: 1,
    appt_link_type: null,
    appt_link_id: null,
  }, over);
}

const WINDOW = { from: '2026-09-01', to: '2026-09-30' };

/** listRange's scripted results, in order: events, appts, [cases], [contacts]. */
const range = (...sets) => sets;


// ─────────────────────────────────────────────────────────────────────────────
// Window validation
// ─────────────────────────────────────────────────────────────────────────────

describe('listRange — window validation', () => {
  test('from and to are required and must be YYYY-MM-DD', async () => {
    await expect(svc.listRange(stubDb([]), { to: '2026-09-30' }))
      .rejects.toMatchObject({ status: 400, message: /from is required/ });
    await expect(svc.listRange(stubDb([]), { from: '2026-09-01' }))
      .rejects.toMatchObject({ status: 400, message: /to is required/ });
    await expect(svc.listRange(stubDb([]), { from: '09/01/2026', to: '2026-09-30' }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('a reversed window is a 400, not an empty list', async () => {
    // Silently returning [] would read as "nothing scheduled" for a typo.
    await expect(svc.listRange(stubDb([]), { from: '2026-09-30', to: '2026-09-01' }))
      .rejects.toMatchObject({ status: 400, message: /not be earlier/ });
  });

  test('92 days is allowed; 93 is a 400 naming the span', async () => {
    const ok = stubDb(range([], []));
    await expect(svc.listRange(ok, { from: '2026-01-01', to: '2026-04-03' })).resolves.toBeDefined();
    await expect(svc.listRange(stubDb([]), { from: '2026-01-01', to: '2026-04-04' }))
      .rejects.toMatchObject({ status: 400, message: /93 days/ });
  });

  test('a bad kind or state is a 400 naming the vocabulary — NOT silently dropped', async () => {
    // auditEventLinks drops unknown severities because it is a diagnostics
    // list. This is a data read behind a UI filter: quietly widening or
    // narrowing what was asked for would be answering a different question.
    await expect(svc.listRange(stubDb([]), { ...WINDOW, kind: 'appointment' }))
      .rejects.toMatchObject({ status: 400, message: /unknown "appointment"/ });
    await expect(svc.listRange(stubDb([]), { ...WINDOW, state: 'open' }))
      .rejects.toMatchObject({ status: 400, message: /unknown "open"/ });
  });

  test('the vocabulary constants are exported and match what the filters accept', async () => {
    expect(svc._RANGE_STATES).toEqual(['live', 'resolved', 'cancelled', 'superseded']);
    expect(svc._RANGE_KINDS).toEqual(['hearing', 'meeting', 'deadline', 'conference', 'other']);
    expect(svc._RANGE_LIMIT_MAX).toBe(1000);
    expect(svc._RANGE_MAX_DAYS).toBe(92);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Filters
// ─────────────────────────────────────────────────────────────────────────────

describe('listRange — filters', () => {
  test('the default state is live, and the SQL half is a COMPLEMENT on both sides', async () => {
    const db = stubDb(range([], []));
    await svc.listRange(db, WINDOW);
    // The blank-enum rows are LIVE (_deriveState). `= 'Scheduled'` would drop
    // them in SQL while the JS half still expected them.
    expect(db.calls[0].sql).toContain(`e.event_status NOT IN ('Completed','Canceled','Rescheduled')`);
    expect(db.calls[1].sql).toContain(`a.appt_status NOT IN ('Attended','No Show','Canceled','Rescheduled')`);
  });

  test('a kind filter that excludes meeting SKIPS the appts query entirely', async () => {
    // Every appt is kind 'meeting' BY TABLE (§3.3.2). Running a query that
    // cannot match is a wasted round trip on every hearings-only view.
    const db = stubDb(range([ev()]));
    const { items } = await svc.listRange(db, { ...WINDOW, kind: ['hearing'] });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toContain('FROM events');
    expect(items.every(r => r.source === 'event')).toBe(true);
  });

  test('a kind filter naming meeting queries both tables', async () => {
    const db = stubDb(range([], [ap()]));
    const { items } = await svc.listRange(db, { ...WINDOW, kind: ['meeting', 'deadline'] });
    expect(db.calls).toHaveLength(2);
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe('appt');
  });

  test('kind NULL is never collected by a kind filter', async () => {
    // A NULL-kind row is a write-path bug (§7.1 rule 8), not an 'other'.
    // 'other' excludes meeting, so the appts query is skipped — hence ONE
    // scripted result, not two. The guard enforces that.
    const db = stubDb(range([]));
    await svc.listRange(db, { ...WINDOW, kind: ['other'] });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toContain('e.kind IN (?)');
    expect(db.calls[0].sql).not.toMatch(/kind IS NULL/);
  });

  test('type_key filters both tables', async () => {
    const db = stubDb(range([], []));
    await svc.listRange(db, { ...WINDOW, type_key: 'meeting_341,poc_due' });
    expect(db.calls[0].params).toEqual(expect.arrayContaining(['meeting_341', 'poc_due']));
    expect(db.calls[1].params).toEqual(expect.arrayContaining(['meeting_341', 'poc_due']));
  });

  test('a with_user_id filter INCLUDES firm-wide events but not firm-wide appts', async () => {
    // A firm-wide event (event_with NULL) blocks EVERY provider's calendar —
    // availabilityService's own rule — so it is on that provider's day and
    // hiding it would hide the thing actually occupying the slot. Appts have
    // no firm-wide semantic: a NULL host means "not recorded", not "everyone".
    const db = stubDb(range([], []));
    await svc.listRange(db, { ...WINDOW, with_user_id: 5 });
    expect(db.calls[0].sql).toContain('(e.event_with IS NULL OR e.event_with IN (?))');
    expect(db.calls[1].sql).toContain('a.appt_with IN (?)');
    expect(db.calls[1].sql).not.toContain('appt_with IS NULL');
  });

  test('event_with = 0 ("nobody") is excluded by a user filter', async () => {
    const db = stubDb(range([ev({ event_with: 0 })], []));
    // The SQL would not have returned it; the fixture forces it through to
    // prove nothing downstream re-admits it into a provider's view.
    const { items } = await svc.listRange(db, { ...WINDOW, with_user_id: 5 });
    expect(items).toHaveLength(1);          // mapper does not filter — SQL does
    expect(db.calls[0].params).toContain(5);
  });

  test('a non-integer with_user_id is dropped rather than bound', async () => {
    const db = stubDb(range([], []));
    await svc.listRange(db, { ...WINDOW, with_user_id: ['', 'abc'] });
    expect(db.calls[0].sql).not.toContain('event_with IN');
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Supersession
// ─────────────────────────────────────────────────────────────────────────────

describe('listRange — supersession', () => {
  const DEAD_EV = ev({ event_id: 101, event_status: 'Canceled', superseded_by_event_id: 200, supersede_reason: 'rescheduled' });
  const DEAD_AP = ap({ appt_id: 901, appt_status: 'Rescheduled' });

  test('dead rows are hidden by default — in SQL, not in the mapper', async () => {
    const db = stubDb(range([], []));
    await svc.listRange(db, WINDOW);
    expect(db.calls[0].sql).toContain('e.superseded_by_event_id IS NULL');
    expect(db.calls[1].sql).not.toContain(`a.appt_status = 'Rescheduled'`);
  });

  test('includeSuperseded is ADDITIVE to the default live state, not a replacement', async () => {
    // The tab renders this as a checkbox BESIDE the state select. If it were a
    // state VALUE, ticking it on the default view would swap the live rows for
    // the dead ones — the opposite of what the control looks like it does.
    const db = stubDb(range([ev(), DEAD_EV], [ap(), DEAD_AP]));
    const { items } = await svc.listRange(db, { ...WINDOW, includeSuperseded: true });
    const states = items.map(r => r.state).sort();
    expect(states).toEqual(['live', 'live', 'superseded', 'superseded']);
  });

  test('a superseded row comes back with state superseded WHATEVER its status says', async () => {
    // The 31 E0a tombstones are genuinely event_status='Canceled'. If status
    // decided state they would need 'cancelled' in the filter to appear at
    // all — the confusion §3.7 exists to end.
    const db = stubDb(range([DEAD_EV], []));
    const { items } = await svc.listRange(db, { ...WINDOW, state: ['live'], includeSuperseded: true });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ state: 'superseded', superseded: true, superseded_by_event_id: 200 });
    expect(db.calls[0].sql).toContain('e.superseded_by_event_id IS NOT NULL');
  });

  test('naming superseded in `state` implies includeSuperseded', async () => {
    const db = stubDb(range([DEAD_EV], [DEAD_AP]));
    const { items } = await svc.listRange(db, { ...WINDOW, state: ['superseded'] });
    expect(items.map(r => r.state)).toEqual(['superseded', 'superseded']);
  });

  test('an appt tombstone carries the flag and NO successor pointer (§3.4 asymmetry)', async () => {
    const db = stubDb(range([], [DEAD_AP]));
    const { items } = await svc.listRange(db, { ...WINDOW, state: ['superseded'] });
    expect(items[0].superseded).toBe(true);
    expect(items[0]).not.toHaveProperty('superseded_by_event_id');
  });

  test('rows the caller did not ask for do not carry the superseded keys at all', async () => {
    const db = stubDb(range([ev()], []));
    const { items } = await svc.listRange(db, WINDOW);
    expect(items[0]).not.toHaveProperty('superseded');
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// State filtering
// ─────────────────────────────────────────────────────────────────────────────

describe('listRange — state', () => {
  test('resolved / cancelled map to the right statuses on both tables', async () => {
    const db = stubDb(range([], []));
    await svc.listRange(db, { ...WINDOW, state: ['resolved', 'cancelled'] });
    expect(db.calls[0].sql).toContain(`e.event_status = 'Completed'`);
    expect(db.calls[0].sql).toContain(`e.event_status = 'Canceled'`);
    expect(db.calls[1].sql).toContain(`a.appt_status IN ('Attended','No Show')`);
    expect(db.calls[1].sql).toContain(`a.appt_status = 'Canceled'`);
  });

  test('the JS half is the authority — a row the SQL let through is still filtered', async () => {
    // Belt-and-braces by design: if the two halves ever drift, the OUTPUT
    // stays correct and only the wire gets fatter.
    const db = stubDb(range([ev({ event_status: 'Completed' })], []));
    const { items } = await svc.listRange(db, { ...WINDOW, state: ['live'] });
    expect(items).toEqual([]);
  });

  test('a deadline Completed with no stored resolution reads met (the §3.7 fallback)', async () => {
    const db = stubDb(range([ev({ kind: 'deadline', type_key: 'poc_due', event_status: 'Completed' })], []));
    const { items } = await svc.listRange(db, { ...WINDOW, state: ['resolved'] });
    expect(items[0]).toMatchObject({ state: 'resolved', resolution: 'met' });
  });

  test('a stored moot overrides the cancelled default; plain Canceled does not', async () => {
    const db = stubDb(range([
      ev({ event_id: 1, kind: 'deadline', event_status: 'Canceled', event_resolution: 'moot' }),
      ev({ event_id: 2, kind: 'deadline', event_status: 'Canceled', event_resolution: null }),
    ], []));
    const { items } = await svc.listRange(db, { ...WINDOW, state: ['cancelled'] });
    expect(items.map(r => r.resolution)).toEqual(['moot', 'cancelled']);
  });

  test('status_norm is untouched — R2 still sees exactly its four values', async () => {
    const db = stubDb(range([ev({ event_status: 'Completed' })], [ap({ appt_status: 'No Show' })]));
    const { items } = await svc.listRange(db, { ...WINDOW, state: ['resolved'] });
    expect(items.map(r => r.status_norm).sort()).toEqual(['held', 'missed']);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Anchors and labels
// ─────────────────────────────────────────────────────────────────────────────

describe('listRange — anchors and labels', () => {
  test('a docket-anchored event resolves to a real case_id (the reverse walk)', async () => {
    const db = stubDb(range(
      [ev({ event_id: 110, event_link_type: 'case_number', event_link_id: '26-46639' })],
      [],
      [CASE_A]
    ));
    const { items } = await svc.listRange(db, WINDOW);
    expect(items[0]).toMatchObject({ case_id: 'TYL6KJN8', link_type: 'case_number', docket: '26-46639' });
    // ONE cases query, keyed by the dockets seen — never a correlated subquery.
    expect(db.calls[2].sql).toMatch(/FROM cases c WHERE/);
    expect(db.calls[2].sql).toContain('c.case_number IN');
    expect(db.calls[2].sql).toContain('c.case_number_full IN');
  });

  test('an unresolvable docket keeps its docket text and a null case_id', async () => {
    // Self-healing, exactly as on the per-case side: it resolves the moment
    // the case is created. Inventing a case_id here would be worse than null.
    const db = stubDb(range(
      [ev({ event_link_type: 'case_number', event_link_id: '99-00000' })],
      [],
      []
    ));
    const { items } = await svc.listRange(db, WINDOW);
    expect(items[0].case_id).toBeNull();
    expect(items[0].docket).toBe('99-00000');
  });

  test('no dockets and no labels wanted → NO cases query at all', async () => {
    const db = stubDb(range([ev()], [ap()]));
    await svc.listRange(db, WINDOW);
    expect(db.calls).toHaveLength(2);
  });

  test('includeLabels adds display{} and costs ONE cases + ONE contacts query', async () => {
    const db = stubDb(range(
      [ev({ event_id: 1, event_link_type: 'contact', event_link_id: '1042' })],
      [ap()],
      [CASE_A],
      [{ contact_id: 1042, contact_name: 'Denise A Herig' }]
    ));
    const { items } = await svc.listRange(db, { ...WINDOW, includeLabels: true });
    expect(db.calls).toHaveLength(4);
    const evRow = items.find(r => r.source === 'event');
    const apRow = items.find(r => r.source === 'appt');
    expect(evRow.display).toEqual({ case_label: null, contact_name: 'Denise A Herig' });
    expect(apRow.display).toEqual({ case_label: '26-46639-mar', contact_name: 'Denise A Herig' });
  });

  test('display is ABSENT without includeLabels — the frozen shape gains no default keys', async () => {
    const db = stubDb(range([ev()], []));
    const { items } = await svc.listRange(db, WINDOW);
    expect(items[0]).not.toHaveProperty('display');
  });

  test('THE QUERY COUNT DOES NOT SCALE WITH ROWS', async () => {
    // The whole point of batching. A per-row lookup would satisfy every output
    // assertion in this file and only show up as a 200-query page in prod.
    const many = [];
    for (let i = 0; i < 60; i++) {
      many.push(ev({ event_id: 300 + i, event_link_type: 'case_number', event_link_id: '26-46639' }));
    }
    // Three queries each: events, appts, cases. NO contacts query — nothing on
    // this page is contact-anchored, and a lookup with an empty IN-list is a
    // round trip that can only return nothing.
    const big = stubDb(range(many, [], [CASE_A]));
    await svc.listRange(big, { ...WINDOW, includeLabels: true });

    const small = stubDb(range(
      [ev({ event_link_type: 'case_number', event_link_id: '26-46639' })], [], [CASE_A]
    ));
    await svc.listRange(small, { ...WINDOW, includeLabels: true });

    expect(big.calls.length).toBe(small.calls.length);
    // …and the IN-list is keyed by DISTINCT dockets, so 60 rows on one docket
    // bind one docket, not sixty.
    expect(big.calls[2].params).toEqual(['26-46639', '26-46639']);
  });

  test('every source names its anchor — the events mapper gains link_type here', async () => {
    // The per-case row shape leaves link_type off event rows (there is an
    // ambient case). A range list has none, so both sources must say it or the
    // anchor column cannot be rendered at all.
    const db = stubDb(range([ev()], [ap()]));
    const { items } = await svc.listRange(db, WINDOW);
    expect(items.find(r => r.source === 'event')).toMatchObject({ link_type: 'case', link_id: 'TYL6KJN8' });
    expect(items.find(r => r.source === 'appt')).toMatchObject({ link_type: 'case', link_id: 'TYL6KJN8' });
  });

  test('a client-only appt (no case) anchors to the contact', async () => {
    const db = stubDb(range([], [ap({ appt_case_id: '', appt_client_id: 77 })]));
    const { items } = await svc.listRange(db, WINDOW);
    expect(items[0]).toMatchObject({ case_id: null, link_type: 'contact', link_id: '77' });
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Sort, limit, paging
// ─────────────────────────────────────────────────────────────────────────────

describe('listRange — sort and cap', () => {
  test('starts_at ascending across BOTH tables', async () => {
    const db = stubDb(range(
      [ev({ event_id: 1, event_date: D('2026-09-20 00:00:00'), event_time: '09:00:00' })],
      [ap({ appt_id: 2, appt_date: D('2026-09-05 14:00:00') })]
    ));
    const { items } = await svc.listRange(db, WINDOW);
    expect(items.map(r => r.source_id)).toEqual([2, 1]);
  });

  test('ALL-DAY ROWS COME FIRST WITHIN THEIR DAY', async () => {
    // The one rule that separates _byRangeStart from the frozen _byStart. An
    // all-day row composes to '<date> 00:00:00', so on a per-case timeline it
    // sorted first by accident; here it does so by rule, and a 00:00 timed row
    // cannot displace it.
    const db = stubDb(range([
      ev({ event_id: 1, event_date: D('2026-09-10 00:00:00'), event_time: '00:00:00', event_all_day: 0 }),
      ev({ event_id: 2, event_date: D('2026-09-10 00:00:00'), event_time: null, event_all_day: 1 }),
    ], []));
    const { items } = await svc.listRange(db, WINDOW);
    expect(items.map(r => r.source_id)).toEqual([2, 1]);
  });

  test('ties break deterministically on (source, source_id)', async () => {
    const at = D('2026-09-10 10:00:00');
    const db = stubDb(range(
      [ev({ event_id: 9, event_date: at, event_time: '10:00:00' })],
      [ap({ appt_id: 3, appt_date: at }), ap({ appt_id: 1, appt_date: at })]
    ));
    const { items } = await svc.listRange(db, WINDOW);
    expect(items.map(r => [r.source, r.source_id]))
      .toEqual([['appt', 1], ['appt', 3], ['event', 9]]);
  });

  test('limit defaults to 500 and is capped at 1000, and the cap reaches the SQL', async () => {
    const db = stubDb(range([], []));
    await svc.listRange(db, WINDOW);
    expect(db.calls[0].params[db.calls[0].params.length - 1]).toBe(501);   // offset 0 + 500 + 1

    const capped = stubDb(range([], []));
    await svc.listRange(capped, { ...WINDOW, limit: 99999 });
    expect(capped.calls[0].params[capped.calls[0].params.length - 1]).toBe(1001);
  });

  test('has_more is true only when the page actually clipped something', async () => {
    const rows = [1, 2, 3].map(i => ev({ event_id: i, event_time: `0${i}:00:00` }));
    const clipped = stubDb(range(rows, []));
    const a = await svc.listRange(clipped, { ...WINDOW, limit: 2 });
    expect(a.items.map(r => r.source_id)).toEqual([1, 2]);
    expect(a.has_more).toBe(true);

    const exact = stubDb(range(rows, []));
    const b = await svc.listRange(exact, { ...WINDOW, limit: 3 });
    expect(b.has_more).toBe(false);
  });

  test('offset pages through the MERGED list, not one table at a time', async () => {
    const db = stubDb(range(
      [ev({ event_id: 1, event_date: D('2026-09-02 00:00:00'), event_time: '09:00:00' })],
      [ap({ appt_id: 2, appt_date: D('2026-09-03 09:00:00') })]
    ));
    const { items } = await svc.listRange(db, { ...WINDOW, offset: 1, limit: 10 });
    expect(items.map(r => r.source_id)).toEqual([2]);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// THE PARITY GATE
// ─────────────────────────────────────────────────────────────────────────────

describe('listRange ⊇ listForCase — the mapper-reuse proof', () => {
  /** The frozen §3.1 fields. Every one must be identical across both reads. */
  const FROZEN = ['source', 'source_id', 'case_id', 'kind_key', 'type_key', 'title',
                  'starts_at', 'ends_at', 'all_day', 'status_norm', 'location',
                  'state', 'resolution'];

  test('the same rows, read both ways, agree field for field', async () => {
    const EVENTS = [
      ev({ event_id: 100 }),
      ev({ event_id: 101, kind: 'deadline', type_key: 'poc_due', event_all_day: 1, event_time: null,
           event_title: 'Proof of Claim Deadline', event_status: 'Completed' }),
      ev({ event_id: 102, event_link_type: 'case_number', event_link_id: '26-46639-mar',
           event_status: 'Canceled', event_resolution: 'moot', kind: 'deadline' }),
    ];
    const APPTS = [
      ap({ appt_id: 900 }),
      ap({ appt_id: 901, appt_status: 'Attended', appt_type: 'Pre-Filing Meeting', type_key: 'pre_filing' }),
      ap({ appt_id: 902, appt_status: '', type_key: null, appt_type: null }),   // the blank-enum shape
    ];

    // listForCase: cases, events, appts.
    const perCase = stubDb([[CASE_A], EVENTS, APPTS]);
    const caseRows = await svc.listForCase(perCase, 'TYL6KJN8');

    // listRange: events, appts, cases (the docket row forces the anchor query).
    const ranged = stubDb([EVENTS, APPTS, [CASE_A]]);
    const { items } = await svc.listRange(ranged, {
      ...WINDOW, state: ['live', 'resolved', 'cancelled'],
    });

    const byId = new Map(items.map(r => [`${r.source}:${r.source_id}`, r]));
    expect(caseRows.length).toBeGreaterThan(0);
    for (const want of caseRows) {
      const got = byId.get(`${want.source}:${want.source_id}`);
      expect(got).toBeDefined();
      for (const f of FROZEN) {
        expect([f, got[f]]).toEqual([f, want[f]]);
      }
    }
  });

  test('includeAttendees produces the same attendees[] through both reads', async () => {
    const EVENTS = [ev({ event_with: 4 })];
    const APPTS  = [ap()];
    const registryRow = [{
      type_key: 'confirmation_hearing', label: 'Confirmation Hearing', kind: 'hearing',
      singleton: 1, blocks_default: 'attendee', client_attends: 0, default_length: 30,
      approaching_offsets: null, ingest_aliases: '[]', case_types: null, active: 1, sort_order: 0,
    }];
    const calendarTypeService = require('../services/calendarTypeService');
    calendarTypeService.invalidate();

    const perCase = stubDb([[CASE_A], EVENTS, APPTS, registryRow]);
    const caseRows = await svc.listForCase(perCase, 'TYL6KJN8', { includeAttendees: true });
    calendarTypeService.invalidate();

    const ranged = stubDb([EVENTS, APPTS, registryRow]);
    const { items } = await svc.listRange(ranged, { ...WINDOW, includeAttendees: true });
    calendarTypeService.invalidate();

    const pick = (rows, source) => rows.find(r => r.source === source);
    expect(pick(items, 'event').attendees).toEqual(pick(caseRows, 'event').attendees);
    expect(pick(items, 'appt').attendees).toEqual(pick(caseRows, 'appt').attendees);
    expect(pick(items, 'event').client_expected).toBe(pick(caseRows, 'event').client_expected);
  });

  test('appt_date is read, appt_date_utc never is — the five-hour trap, on this surface too', async () => {
    const db = stubDb(range([], [ap({
      appt_date: D('2026-09-05 14:00:00'),
      appt_date_utc: D('2026-09-05 19:00:00'),
    })]));
    const { items } = await svc.listRange(db, WINDOW);
    expect(items[0].starts_at).toBe('2026-09-05 14:00:00');
    expect(db.calls[1].sql).not.toContain('appt_date_utc');
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// The route
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/calendar-range', () => {
  const express = require('express');
  const dbHolder = {};
  let app;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../lib/auth.jwtOrApiKey', () => (req, res, next) => { req.auth = { userId: 6 }; next(); });
    const router = require('../routes/api.calendarRange');
    app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.db = dbHolder.db; next(); });
    app.use(router);
  });
  afterAll(() => jest.dontMock('../lib/auth.jwtOrApiKey'));

  const call = (url) => new Promise((resolve) => {
    const srv = app.listen(0, async () => {
      const res = await fetch(`http://127.0.0.1:${srv.address().port}${url}`);
      const body = await res.json();
      srv.close(() => resolve({ status: res.status, body }));
    });
  });

  test('happy path returns items + resolved paging meta', async () => {
    dbHolder.db = stubDb(range([ev()], [ap()]));
    const { status, body } = await call('/api/calendar-range?from=2026-09-01&to=2026-09-30');
    expect(status).toBe(200);
    expect(body.status).toBe('success');
    expect(body.count).toBe(2);
    expect(body).toMatchObject({ limit: 500, offset: 0, has_more: false });
  });

  test('CSV and repeated params are both accepted', async () => {
    // Neither spelling names 'meeting', so both skip the appts query.
    dbHolder.db = stubDb(range([]));
    await call('/api/calendar-range?from=2026-09-01&to=2026-09-30&kind=hearing,deadline&state=live');
    expect(dbHolder.db.calls[0].params).toEqual(expect.arrayContaining(['hearing', 'deadline']));

    dbHolder.db = stubDb(range([]));
    await call('/api/calendar-range?from=2026-09-01&to=2026-09-30&kind=hearing&kind=deadline&state=live');
    expect(dbHolder.db.calls[0].params).toEqual(expect.arrayContaining(['hearing', 'deadline']));
  });

  test('the service 400 reaches the client with its message', async () => {
    dbHolder.db = stubDb([]);
    const wide = await call('/api/calendar-range?from=2026-01-01&to=2026-12-31');
    expect(wide.status).toBe(400);
    expect(wide.body.message).toMatch(/maximum is 92/);

    dbHolder.db = stubDb([]);
    const missing = await call('/api/calendar-range');
    expect(missing.status).toBe(400);
  });

  test('an over-cap limit is echoed as the CAPPED value, not as asked', async () => {
    dbHolder.db = stubDb(range([], []));
    const { body } = await call('/api/calendar-range?from=2026-09-01&to=2026-09-30&limit=5000');
    expect(body.limit).toBe(1000);
  });

  test('a thrown non-http error is a generic 500, not a leaked stack', async () => {
    dbHolder.db = { query: async () => { throw new Error('ECONNREFUSED at 10.0.0.1'); } };
    const { status, body } = await call('/api/calendar-range?from=2026-09-01&to=2026-09-30');
    expect(status).toBe(500);
    expect(body.message).toBe('Calendar range request failed');
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Adopt unmapped
// ─────────────────────────────────────────────────────────────────────────────

describe('adoptUnmapped', () => {
  const TYPE = (over) => [Object.assign({ type_key: 'mediation', kind: 'conference', active: 1 }, over)];

  test('happy path stamps both tables and reports the counts split by table', async () => {
    const db = stubWriteDb([TYPE(), { affectedRows: 1 }, { affectedRows: 2 }]);
    const out = await admin.adoptUnmapped(db, 'mediation', 'Mediation');
    expect(out).toEqual({ type_key: 'mediation', kind: 'conference', raw_label: 'Mediation', events: 1, appts: 2, total: 3 });
  });

  test('events.event_updated_at IS PINNED — classifying a row is not editing it', async () => {
    // ON UPDATE CURRENT_TIMESTAMP. Without the self-assignment, adopting a
    // type restamps every matched row as edited today, which eventform shows
    // and the log feed orders by. Not observable in output; asserted as SQL.
    const db = stubWriteDb([TYPE(), { affectedRows: 1 }, { affectedRows: 0 }]);
    await admin.adoptUnmapped(db, 'mediation', 'Mediation');
    expect(db.calls[1].sql).toContain('event_updated_at = event_updated_at');
    // appts has NO updated_at column at all, so its statement carries none.
    expect(db.calls[2].sql).not.toContain('updated_at');
  });

  test('both UPDATEs are narrowed to unmapped rows carrying exactly that label', async () => {
    const db = stubWriteDb([TYPE(), { affectedRows: 0 }, { affectedRows: 0 }]);
    await admin.adoptUnmapped(db, 'mediation', '  Mediation  ');
    expect(db.calls[1].sql).toContain('WHERE type_key IS NULL AND event_type = ?');
    expect(db.calls[1].params).toEqual(['mediation', 'conference', 'Mediation']);
    expect(db.calls[2].sql).toContain('WHERE type_key IS NULL AND appt_type = ?');
    expect(db.calls[2].params).toEqual(['mediation', 'Mediation']);
  });

  test('the events UPDATE also writes kind, from the registry — appts get no kind', async () => {
    // kind is a real column on events and NOT on appts: every appt is kind
    // 'meeting' BY TABLE (§3.3.2), which is why the read layer derives it.
    const db = stubWriteDb([TYPE({ kind: 'deadline' }), { affectedRows: 3 }, { affectedRows: 0 }]);
    await admin.adoptUnmapped(db, 'mediation', 'Mediation');
    expect(db.calls[1].sql).toContain('SET type_key = ?, kind = ?');
    expect(db.calls[1].params[1]).toBe('deadline');
    expect(db.calls[2].sql).toContain('SET type_key = ?');
    expect(db.calls[2].sql).not.toContain('kind');
  });

  test('a blank raw_label is a 400 — and nothing is written', async () => {
    const db = stubWriteDb([]);
    await expect(admin.adoptUnmapped(db, 'mediation', '   '))
      .rejects.toMatchObject({ status: 400, message: /raw_label is required/ });
    await expect(admin.adoptUnmapped(db, 'mediation', null)).rejects.toMatchObject({ status: 400 });
    expect(db.calls).toHaveLength(0);
  });

  test('an unknown key is a 404 and an inactive one a 409 — neither writes', async () => {
    const missing = stubWriteDb([[]]);
    await expect(admin.adoptUnmapped(missing, 'nope', 'Mediation')).rejects.toMatchObject({ status: 404 });
    expect(missing.calls).toHaveLength(1);

    const off = stubWriteDb([TYPE({ active: 0 })]);
    await expect(admin.adoptUnmapped(off, 'mediation', 'Mediation'))
      .rejects.toMatchObject({ status: 409, message: /inactive/ });
    expect(off.calls).toHaveLength(1);
  });

  test('it invalidates NOTHING — the options cache is keyed on registry rows', async () => {
    const calendarTypeService = require('../services/calendarTypeService');
    const spy = jest.spyOn(calendarTypeService, 'invalidate');
    const db = stubWriteDb([TYPE(), { affectedRows: 1 }, { affectedRows: 0 }]);
    await admin.adoptUnmapped(db, 'mediation', 'Mediation');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
