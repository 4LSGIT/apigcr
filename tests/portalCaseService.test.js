// tests/portalCaseService.test.js
//
// Slice 2 (+E1) service assertions for services/portalCaseService.js — the
// portal contract tests: scope gating, ratified visibility rules, projection
// whitelist, title/docket derivation, and (E1) the cards/meeting341 wiring.
//
// Stub pattern from tests/pipelineService.test.js (scripted mysql2 pool);
// pipelineService is jest-mocked (esign-suite precedent) so these tests
// exercise portalCaseService's rules against getPipeline's OUTPUT SHAPE
// rather than re-driving pipelineService's own queries (that service has its
// own suite).
//
// E1 AMENDMENT (2026-08-07, flagged for ratification): the card engine is
// jest-mocked here the same way — this suite tests the SERVICE contract
// (cards ride the payload; meeting341 data appears iff the engine passed the
// coded 341 card). The engine's own rules — including the 341 gates that
// MOVED out of this service (BK-exclusivity, past-date suppression) — are
// pinned by tests/portalCardEngine.test.js, whose PARITY section drives the
// REAL engine through the REAL getCaseView against the pre-E1 oracle. No
// pre-E1 protection was dropped; the moved assertions live there.
//
// Run:
//   npx jest tests/portalCaseService.test.js

'use strict';

jest.mock('../services/pipelineService', () => ({
  getPipeline: jest.fn(),
}));
jest.mock('../lib/portalCardEngine', () => ({
  renderCards: jest.fn(),
}));

const pipelineService = require('../services/pipelineService');
const portalCardEngine = require('../lib/portalCardEngine');
const svc = require('../services/portalCaseService');

// The coded 341 card as the (mocked) engine emits it when its conditions pass.
const CARD_341 = () => ({
  key: 'meeting341', title: 'Meeting of Creditors (341)',
  body: null, link: null, coded_key: 'meeting341', placement: 'case_top',
});

// ─────────────────────────────────────────────────────────────────────────────
// Stubs / fixtures
// ─────────────────────────────────────────────────────────────────────────────

// Plain pool stub: query() shifts the next scripted [rows] result.
function stubDb(script) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) throw new Error('stubDb: unscripted query: ' + sql);
      return [script.shift()];
    },
  };
}

// Whitelisted scope-row shape (what _scopedCaseRows / getCaseView SELECT).
function caseRow(over = {}) {
  return Object.assign({
    case_id: 'AbCdEf12',
    case_chapter: '7',
    case_type: 'Bankruptcy',
    case_number: '24-40226',
    case_number_full: '24-40226-mlo',
    case_open_date: null,           // listCases scope query only (ORDER BY fuel)
    case_341_current: null,         // S2.1 view columns
    case_341_link: '',
  }, over);
}

// Template stage rows as getPipeline projects them (stages / upcoming shape).
function stage(key, number, clientLabel, visible, over = {}) {
  return Object.assign({
    stage_id: 100 + number,
    stage_key: key,
    stage_number: number,
    internal_label: 'INTERNAL ' + key,     // must never surface
    client_label: clientLabel,
    case_stage: 'Filed',
    is_terminal: 0,
    default_rec: '',
    client_visible: visible,
  }, over);
}

// Log rows as getPipeline projects them (current / history shape).
function logRow(key, enteredAt, over = {}) {
  return Object.assign({
    stage_id: 900,
    stage_key: key,
    case_stage: 'Filed',
    status_label: 'SNAPSHOT ' + key,       // must never surface
    entered_at: new Date(enteredAt),
    entered_by: 5,                         // must never surface
    source: 'manual',                      // must never surface
    note: 'internal note',                 // must never surface
    id: 1,
  }, over);
}

// UTC times chosen mid-day so the firm-local (America/Detroit) date equals
// the UTC date — no DST-boundary flakiness.
const STAGES = [
  stage('docs',        1, 'Preparing your case',  1),
  stage('filed',       2, 'Your case is filed',   1),
  stage('review',      3, 'Internal review',      0),   // hidden
  stage('meeting_341', 4, 'Meeting of creditors', 1),
  stage('discharge',   5, 'Discharge entered',    1),
];

function pipelinePayload(over = {}) {
  const history = over.history || [
    logRow('docs',  '2026-05-04T16:00:00Z'),
    logRow('filed', '2026-06-10T16:00:00Z'),
  ];
  return {
    template: { id: 2, name: 'BK Ch 7', role: 'case', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' },
    current: history.length ? history[history.length - 1] : null,
    history,
    upcoming: over.upcoming || [STAGES[2], STAGES[3], STAGES[4]],
    stages: over.stages || STAGES,
  };
}

beforeEach(() => {
  // Default: no configured cards pass (tests that need the 341 card override).
  portalCardEngine.renderCards.mockResolvedValue([]);
});
afterEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// Scope gate
// ─────────────────────────────────────────────────────────────────────────────

describe('scope gate', () => {
  test('non-owned and nonexistent case both → null (same empty scope read)', async () => {
    // The scope query cannot distinguish the two — one empty result covers
    // both; the route turns null into ONE uniform 404.
    const db = stubDb([[]]);
    const view = await svc.getCaseView(db, 42, 'NotYours1');
    expect(view).toBeNull();
    expect(pipelineService.getPipeline).not.toHaveBeenCalled();
  });

  test('scope queries restrict to Primary/Secondary (Other/Bystander excluded)', async () => {
    const db1 = stubDb([[]]);
    await svc.getCaseView(db1, 42, 'X');
    expect(db1.calls[0].sql).toContain(`case_relate_type IN ('Primary','Secondary')`);
    expect(db1.calls[0].params).toEqual([42, 'X']);

    const db2 = stubDb([[]]);
    await svc.listCases(db2, 42);
    expect(db2.calls[0].sql).toContain(`case_relate_type IN ('Primary','Secondary')`);
    expect(db2.calls[0].params).toEqual([42]);
  });

  test('getCaseView pipeline 404 (delete race) degrades to null, not a throw', async () => {
    const db = stubDb([[caseRow()]]);
    const gone = new Error('Case AbCdEf12 not found');
    gone.status = 404;
    pipelineService.getPipeline.mockRejectedValueOnce(gone);
    expect(await svc.getCaseView(db, 42, 'AbCdEf12')).toBeNull();
  });

  test('non-404 pipeline errors propagate', async () => {
    const db = stubDb([[caseRow()]]);
    pipelineService.getPipeline.mockRejectedValueOnce(new Error('boom'));
    await expect(svc.getCaseView(db, 42, 'AbCdEf12')).rejects.toThrow('boom');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Visibility rules (ratified)
// ─────────────────────────────────────────────────────────────────────────────

describe('visibility rules', () => {
  test('hidden stage appears NOWHERE — not done, not current, not upcoming', async () => {
    const db = stubDb([[caseRow()]]);
    pipelineService.getPipeline.mockResolvedValueOnce(pipelinePayload({
      history: [
        logRow('docs',   '2026-05-04T16:00:00Z'),
        logRow('review', '2026-05-20T16:00:00Z'),   // hidden stage visited
        logRow('filed',  '2026-06-10T16:00:00Z'),
      ],
      upcoming: [STAGES[2], STAGES[3], STAGES[4]],  // hidden 'review' offered upstream
    }));

    const view = await svc.getCaseView(db, 42, 'AbCdEf12');
    const tl = view.timeline;

    expect(tl.done).toEqual([{ label: 'Preparing your case', date: '2026-05-04' }]);
    expect(tl.current).toEqual({ label: 'Your case is filed', since: '2026-06-10' });
    expect(tl.upcoming).toEqual([
      { label: 'Meeting of creditors' },
      { label: 'Discharge entered' },
    ]);
    // No trace of the hidden stage anywhere in the serialized payload.
    expect(JSON.stringify(view)).not.toMatch(/review|Internal review/);
  });

  test('hidden REAL current → portal current is the latest VISIBLE row (hidden stage never shown)', async () => {
    const db = stubDb([[caseRow()]]);
    pipelineService.getPipeline.mockResolvedValueOnce(pipelinePayload({
      history: [
        logRow('docs',   '2026-05-04T16:00:00Z'),
        logRow('filed',  '2026-06-10T16:00:00Z'),
        logRow('review', '2026-06-20T16:00:00Z'),   // real current is hidden
      ],
      upcoming: [STAGES[3], STAGES[4]],
    }));

    const view = await svc.getCaseView(db, 42, 'AbCdEf12');
    const tl = view.timeline;

    // Ratified: current = latest VISIBLE history row.
    expect(tl.current).toEqual({ label: 'Your case is filed', since: '2026-06-10' });
    expect(tl.done).toEqual([{ label: 'Preparing your case', date: '2026-05-04' }]);
    expect(JSON.stringify(view)).not.toContain('Internal review');
  });

  test('NO visible history at all → current: null, timeline is upcoming-only', async () => {
    const db = stubDb([[caseRow()]]);
    pipelineService.getPipeline.mockResolvedValueOnce(pipelinePayload({
      history: [logRow('review', '2026-05-01T16:00:00Z')],  // only a hidden visit
      upcoming: [STAGES[3], STAGES[4]],
    }));

    const view = await svc.getCaseView(db, 42, 'AbCdEf12');
    expect(view.timeline.current).toBeNull();               // never a hidden fallback
    expect(view.timeline.done).toEqual([]);
    expect(view.timeline.upcoming).toEqual([
      { label: 'Meeting of creditors' },
      { label: 'Discharge entered' },
    ]);
  });

  test('history row absent from the resolved template (branched from intake) skips silently', async () => {
    const db = stubDb([[caseRow()]]);
    pipelineService.getPipeline.mockResolvedValueOnce(pipelinePayload({
      history: [
        logRow('consult_held', '2026-04-01T16:00:00Z'),     // intake-era key, not in template
        logRow('docs',         '2026-05-04T16:00:00Z'),
      ],
      upcoming: [STAGES[1], STAGES[2], STAGES[3], STAGES[4]],
    }));

    const view = await svc.getCaseView(db, 42, 'AbCdEf12');
    expect(view.timeline.done).toEqual([]);
    expect(view.timeline.current).toEqual({ label: 'Preparing your case', since: '2026-05-04' });
    expect(JSON.stringify(view)).not.toContain('consult_held');
  });

  test('empty pipeline (day-one case) → empty done, null current, full visible upcoming', async () => {
    const db = stubDb([[caseRow()]]);
    pipelineService.getPipeline.mockResolvedValueOnce(pipelinePayload({
      history: [],
      upcoming: STAGES,     // getPipeline: no history → upcoming = ALL stages
    }));

    const view = await svc.getCaseView(db, 42, 'AbCdEf12');
    expect(view.timeline).toEqual({
      done: [],
      current: null,
      upcoming: [
        { label: 'Preparing your case' },
        { label: 'Your case is filed' },
        { label: 'Meeting of creditors' },
        { label: 'Discharge entered' },
      ],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Projection whitelist
// ─────────────────────────────────────────────────────────────────────────────

// Collect every key at every depth of a payload.
function deepKeys(v, acc = new Set()) {
  if (Array.isArray(v)) { v.forEach(x => deepKeys(x, acc)); return acc; }
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    for (const [k, val] of Object.entries(v)) { acc.add(k); deepKeys(val, acc); }
  }
  return acc;
}

const FORBIDDEN_KEYS = [
  'case_status', 'internal_label', 'note', 'entered_by', 'source',
  'status_label', 'stage_key', 'stage_id',
  '341_status', 'case_341_current', 'case_341_link',   // raw 341 columns never surface
];

describe('projection whitelist', () => {
  test('getCaseView payload carries EXACTLY the specced keys — nothing internal', async () => {
    const db = stubDb([[caseRow()]]);
    pipelineService.getPipeline.mockResolvedValueOnce(pipelinePayload());

    const view = await svc.getCaseView(db, 42, 'AbCdEf12');

    expect(Object.keys(view).sort()).toEqual(['cards', 'case_id', 'docket', 'meeting341', 'timeline', 'title']);
    expect(view.cards).toEqual([]);       // engine mocked: nothing passed
    expect(view.meeting341).toBeNull();   // fixture has no 341 date set
    expect(Object.keys(view.timeline).sort()).toEqual(['current', 'done', 'upcoming']);
    view.timeline.done.forEach(d => expect(Object.keys(d).sort()).toEqual(['date', 'label']));
    expect(Object.keys(view.timeline.current).sort()).toEqual(['label', 'since']);
    view.timeline.upcoming.forEach(u => expect(Object.keys(u)).toEqual(['label']));

    const keys = deepKeys(view);
    for (const k of FORBIDDEN_KEYS) expect(keys.has(k)).toBe(false);
    // Client vocabulary only — internal strings absent from the whole payload.
    expect(JSON.stringify(view)).not.toMatch(/INTERNAL|SNAPSHOT|internal note/);
  });

  test('listCases rows carry EXACTLY the specced keys', async () => {
    const db = stubDb([[caseRow()]]);
    pipelineService.getPipeline.mockResolvedValueOnce(pipelinePayload());

    const cases = await svc.listCases(db, 42);
    expect(cases).toHaveLength(1);
    expect(Object.keys(cases[0]).sort())
      .toEqual(['case_id', 'current_stage_label', 'docket', 'title']);
    expect(cases[0].current_stage_label).toBe('Your case is filed');

    const keys = deepKeys(cases);
    for (const k of FORBIDDEN_KEYS) expect(keys.has(k)).toBe(false);
    expect(keys.has('case_open_date')).toBe(false);   // ORDER BY fuel stays server-side
  });

  test('listCases current label obeys the hidden-current rule too', async () => {
    const db = stubDb([[caseRow()]]);
    pipelineService.getPipeline.mockResolvedValueOnce(pipelinePayload({
      history: [logRow('review', '2026-05-01T16:00:00Z')],  // hidden current, nothing visible
    }));
    const cases = await svc.listCases(db, 42);
    expect(cases[0].current_stage_label).toBeNull();
  });

  test('listCases pipeline 404 (delete race) degrades one label, keeps the list', async () => {
    const db = stubDb([[caseRow({ case_id: 'GoneCase' }), caseRow({ case_id: 'LiveCase' })]]);
    const gone = new Error('gone');
    gone.status = 404;
    pipelineService.getPipeline
      .mockRejectedValueOnce(gone)
      .mockResolvedValueOnce(pipelinePayload());

    const cases = await svc.listCases(db, 42);
    expect(cases).toHaveLength(2);
    expect(cases[0]).toMatchObject({ case_id: 'GoneCase', current_stage_label: null });
    expect(cases[1]).toMatchObject({ case_id: 'LiveCase', current_stage_label: 'Your case is filed' });
  });

  test('listCases dedupes a Primary+Secondary double relation to one row', async () => {
    const db = stubDb([[caseRow(), caseRow()]]);   // same case_id twice
    pipelineService.getPipeline.mockResolvedValueOnce(pipelinePayload());
    const cases = await svc.listCases(db, 42);
    expect(cases).toHaveLength(1);
    expect(pipelineService.getPipeline).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Title / docket derivation
// ─────────────────────────────────────────────────────────────────────────────

describe('title derivation', () => {
  const t = svc._deriveTitle;

  test('chapter + type → "Chapter 7 Bankruptcy"', () => {
    expect(t({ case_chapter: '7', case_type: 'Bankruptcy' })).toBe('Chapter 7 Bankruptcy');
    expect(t({ case_chapter: '13', case_type: 'Bankruptcy' })).toBe('Chapter 13 Bankruptcy');
  });

  test('chapter with blank type → Bankruptcy default', () => {
    expect(t({ case_chapter: '7', case_type: '' })).toBe('Chapter 7 Bankruptcy');
    expect(t({ case_chapter: '7', case_type: '   ' })).toBe('Chapter 7 Bankruptcy');
  });

  test('no chapter → case_type alone', () => {
    expect(t({ case_chapter: '', case_type: 'Adversary Proceeding' })).toBe('Adversary Proceeding');
    expect(t({ case_chapter: '  ', case_type: 'Litigation' })).toBe('Litigation');
  });

  test('nothing → "Your Case"', () => {
    expect(t({ case_chapter: '', case_type: '' })).toBe('Your Case');
    expect(t({ case_chapter: null, case_type: null })).toBe('Your Case');
  });
});

describe('docket passthrough', () => {
  const d = svc._deriveDocket;

  test('full form preferred, short fallback, else null', () => {
    expect(d({ case_number_full: '24-40226-mlo', case_number: '24-40226' })).toBe('24-40226-mlo');
    expect(d({ case_number_full: null, case_number: '24-40226' })).toBe('24-40226');
    expect(d({ case_number_full: '', case_number: '' })).toBeNull();
    expect(d({ case_number_full: null, case_number: null })).toBeNull();
  });

  test('opaque: weird strings survive verbatim — never parsed or reshaped', () => {
    const weird = ' 24-48734-mlo (amended) //v2 ';
    expect(d({ case_number_full: weird, case_number: 'x' })).toBe(weird);
    expect(d({ case_number_full: null, case_number: 'NOT A DOCKET @all' })).toBe('NOT A DOCKET @all');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S2.1 (D8/D9) — Meeting of Creditors (341)
// ─────────────────────────────────────────────────────────────────────────────

const { DateTime } = require('luxon');
const { FIRM_TZ } = require('../services/timezoneService');

// Build a fake-UTC Date whose NAIVE components are the given firm-local wall
// clock — exactly what mysql2 (timezone:'Z') hands back for the local-stored
// case_341_current column.
function wallDate(firmLocalDt, hhmm = '10:00') {
  return new Date(firmLocalDt.toFormat('yyyy-MM-dd') + 'T' + hhmm + ':00Z');
}

const todayFirm = () => DateTime.now().setZone(FIRM_TZ).startOf('day');

describe('meeting341 formatter (S2.1, reshaped by E1)', () => {
  const m = svc._formatMeeting341;

  // E1: the BK-exclusivity and past-date-suppression assertions that lived
  // here MOVED with the gates onto the card engine's conditions — see the
  // rules + PARITY sections of tests/portalCardEngine.test.js (which pin the
  // identical behavior against the pre-E1 oracle). What remains here is the
  // pure formatter contract.

  test('null case_341_current → null (nothing to format)', () => {
    expect(m(caseRow({ case_341_current: null }))).toBeNull();
  });

  test('TODAY formats — time-of-day never nulls the block', () => {
    const out = m(caseRow({ case_341_current: wallDate(todayFirm(), '00:05') }));
    expect(out).toEqual({ date: todayFirm().toISODate(), time: '00:05', link: null });
  });

  test('FUTURE formats with wall components preserved — NO timezone shift', () => {
    const tomorrow = todayFirm().plus({ days: 1 });
    const out = m(caseRow({ case_341_current: wallDate(tomorrow, '09:30') }));
    // formatLocal semantics: 09:30 stays 09:30 (a UTC→Detroit conversion
    // would have shifted it to 05:30/04:30 — the defect this test pins).
    expect(out).toEqual({ date: tomorrow.toISODate(), time: '09:30', link: null });
  });

  test('formatter is GATE-FREE — past dates and non-BK rows still format (gates live in the engine)', () => {
    // The service must NOT re-apply the moved gates (double-gating hides
    // bugs). getCaseView only calls the formatter after the engine passed
    // the card; whether these rows' cards appear is the engine's decision.
    const past = m(caseRow({ case_341_current: wallDate(todayFirm().minus({ days: 30 }), '10:00') }));
    expect(past).toEqual({ date: todayFirm().minus({ days: 30 }).toISODate(), time: '10:00', link: null });
    const nonBk = m(caseRow({
      case_chapter: '', case_type: 'Adversary Proceeding',
      case_341_current: wallDate(todayFirm().plus({ days: 7 }), '11:00'),
    }));
    expect(nonBk).not.toBeNull();
  });

  test('NO status wording — output keys are exactly date/time/link', () => {
    const out = m(caseRow({ case_341_current: wallDate(todayFirm().plus({ days: 3 })) }));
    expect(Object.keys(out).sort()).toEqual(['date', 'link', 'time']);
    expect(JSON.stringify(out)).not.toMatch(/status|Continued|Completed|Scheduled/i);
  });

  test('link guard: http(s) passes through; empty/junk/unsafe schemes → null', () => {
    const future = wallDate(todayFirm().plus({ days: 3 }));
    const link = (v) => m(caseRow({ case_341_current: future, case_341_link: v })).link;
    expect(link('https://meet.zoom.us/j/123?pwd=x')).toBe('https://meet.zoom.us/j/123?pwd=x');
    expect(link('http://example.com/341')).toBe('http://example.com/341');
    expect(link('')).toBeNull();
    expect(link('   ')).toBeNull();
    expect(link(null)).toBeNull();
    expect(link('meet.zoom.us/j/123')).toBeNull();          // schemeless
    expect(link('javascript:alert(1)')).toBeNull();          // unsafe scheme
  });

  test('getCaseView carries meeting341 through WHEN the engine passed the card; raw 341 columns never surface', async () => {
    const db = stubDb([[caseRow({
      case_341_current: wallDate(todayFirm().plus({ days: 5 }), '13:00'),
      case_341_link: 'https://meet.zoom.us/j/999',
    })]]);
    pipelineService.getPipeline.mockResolvedValueOnce(pipelinePayload());
    portalCardEngine.renderCards.mockResolvedValueOnce([CARD_341()]);

    const view = await svc.getCaseView(db, 42, 'AbCdEf12');
    expect(view.meeting341).toEqual({
      date: todayFirm().plus({ days: 5 }).toISODate(),
      time: '13:00',
      link: 'https://meet.zoom.us/j/999',
    });
    expect(view.cards.map(c => c.coded_key)).toEqual(['meeting341']);
    // Engine invoked with the pinned session + the case-view placements.
    expect(portalCardEngine.renderCards).toHaveBeenCalledWith(db, {
      caseId: 'AbCdEf12', contactId: 42, placement: ['case_top', 'case'],
    });
    expect(db.calls[0].sql).toContain('case_341_current');
    const keys = deepKeys(view);
    for (const k of FORBIDDEN_KEYS) expect(keys.has(k)).toBe(false);
  });

  test('engine did NOT pass the 341 card (e.g. past/non-BK conditions) → meeting341: null, link never leaves', async () => {
    // E1: suppression is the ENGINE's ruling (seeded conditions — parity
    // pinned in tests/portalCardEngine.test.js); the service must not ship
    // 341 data without the card.
    const db = stubDb([[caseRow({
      case_341_current: wallDate(todayFirm().minus({ days: 30 })),
      case_341_link: 'https://meet.zoom.us/j/999',           // suppressed with the card
    })]]);
    pipelineService.getPipeline.mockResolvedValueOnce(pipelinePayload());
    // default renderCards mock → []

    const view = await svc.getCaseView(db, 42, 'AbCdEf12');
    expect(view.meeting341).toBeNull();
    expect(view.cards).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('meet.zoom.us');
  });

  test('passed 341 card with nothing formattable → card dropped fail-closed (no empty shell)', async () => {
    const db = stubDb([[caseRow({ case_341_current: new Date('invalid') })]]);
    pipelineService.getPipeline.mockResolvedValueOnce(pipelinePayload());
    portalCardEngine.renderCards.mockResolvedValueOnce([CARD_341()]);

    const view = await svc.getCaseView(db, 42, 'AbCdEf12');
    expect(view.meeting341).toBeNull();
    expect(view.cards).toEqual([]);
  });

  test('non-341 cards pass through untouched alongside the 341 card', async () => {
    const payment = {
      key: 'payment', title: 'Payments', body: 'Pay here.',
      link: { url: '/r/payment', label: 'Make a payment' },
      coded_key: null, placement: 'case',
    };
    const db = stubDb([[caseRow({
      case_341_current: wallDate(todayFirm().plus({ days: 5 }), '13:00'),
    })]]);
    pipelineService.getPipeline.mockResolvedValueOnce(pipelinePayload());
    portalCardEngine.renderCards.mockResolvedValueOnce([CARD_341(), payment]);

    const view = await svc.getCaseView(db, 42, 'AbCdEf12');
    expect(view.cards).toEqual([CARD_341(), payment]);
    expect(view.meeting341).not.toBeNull();
  });

  test('listCases rows still have NO meeting341 (view-only field)', async () => {
    const db = stubDb([[caseRow({ case_341_current: wallDate(todayFirm().plus({ days: 5 })) })]]);
    pipelineService.getPipeline.mockResolvedValueOnce(pipelinePayload());
    const cases = await svc.listCases(db, 42);
    expect(Object.keys(cases[0]).sort())
      .toEqual(['case_id', 'current_stage_label', 'docket', 'title']);
  });
});