// tests/portalCardEngine.test.js
//
// E1 card-engine contract tests for lib/portalCardEngine.js:
//   • PORTAL_FIELD_WHITELIST — frozen set + sensitive exclusions
//   • refuse-never-strip template enforcement (+ once-per-boot alert gate)
//   • rules-mode operator matrix, all/any, nesting, fail-closed posture
//   • sql-mode param pinning (config-supplied ids rejected) + error → hidden
//   • RAW resolved bodies (rider 2026-08-08 — the CLIENT escapes at
//     insertion; see the client-contract notes below); unresolved-token strip
//   • PARITY — representative cases produce the same visible card set +
//     341 data presence as the pre-E1 hardcoded logic (oracle replica below)
//
// Stub pattern from tests/portalCaseService.test.js (scripted mysql2 pool);
// lib/alerting is jest-mocked (no DB writes); pipelineService is jest-mocked
// for the parity section, which drives the REAL engine through the REAL
// portalCaseService.getCaseView.
//
// Run:
//   npx jest tests/portalCardEngine.test.js

'use strict';

jest.mock('../lib/alerting', () => ({
  alert: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/pipelineService', () => ({
  getPipeline: jest.fn(),
}));

const { alert }       = require('../lib/alerting');
const pipelineService = require('../services/pipelineService');
const engine          = require('../lib/portalCardEngine');
const portalCases     = require('../services/portalCaseService');

const { DateTime } = require('luxon');
const { FIRM_TZ }  = require('../services/timezoneService');
// T9 script-drift guard: registers this file's scripted stubs so a global
// afterEach can fail on over- OR under-consumption of the script array.
// See tests/helpers/scriptGuard.js.
const { scriptGuard } = require('./helpers/scriptGuard');

// ─────────────────────────────────────────────────────────────────────────────
// Stubs / fixtures
// ─────────────────────────────────────────────────────────────────────────────

// Plain pool stub: query() shifts the next scripted [rows] result.
function stubDb(script) {
  const calls = [];
  const guard = scriptGuard('stubDb', script);
  return {
    calls,
    guard,                       // escape hatches: expectOverruns() / allowLeftovers()
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) guard.overrun(sql);
      const next = script.shift();
      if (next instanceof Error) throw next;
      return [next];
    },
  };
}

// portal_cards row shape (renderCards' SELECT projection).
let _cardId = 0;
function cardRow(over = {}) {
  return Object.assign({
    id: ++_cardId,
    card_key: 'card_' + _cardId,
    title: 'A Card',
    body_type: 'template',
    body_template: 'Hello {{contacts.contact_fname}}.',
    coded_key: null,
    link_url: null,
    link_label: null,
    conditions: null,
    placement: 'case',
    sort: 10,
  }, over);
}

// Whitelisted ctx rows, as loadCtx SELECTs them.
function caseCtxRow(over = {}) {
  return Object.assign({
    case_id: 'AbCdEf12',
    case_chapter: '7',
    case_type: 'Bankruptcy',
    case_number: '24-40226',
    case_number_full: '24-40226-mlo',
    case_341_current: null,
    case_341_link: '',
  }, over);
}
function contactCtxRow(over = {}) {
  return Object.assign({ contact_fname: 'Test' }, over);
}
function ctx(caseOver = {}, contactOver = {}) {
  return {
    caseRow: caseCtxRow(caseOver),
    contactRow: contactCtxRow(contactOver),
    caseId: 'AbCdEf12',
    contactId: 42,
  };
}

// Firm-local wall-clock Date exactly as mysql2 (timezone:'Z') hands back the
// local-stored case_341_current column (see portalCaseService.test.js).
function wallDate(firmLocalDt, hhmm = '10:00') {
  return new Date(firmLocalDt.toFormat('yyyy-MM-dd') + 'T' + hhmm + ':00Z');
}
const todayFirm = () => DateTime.now().setZone(FIRM_TZ).startOf('day');

// The seeded meeting341 conditions — KEEP IN SYNC with
// ref/2026-08-07_portal_cards_e1.sql (the migration is the deployable copy;
// this literal is the test's).
const MEETING341_CONDITIONS = {
  mode: 'rules',
  match: 'all',
  rules: [
    { match: 'any', rules: [
      { field: 'cases.case_chapter', op: 'not_empty' },
      { field: 'cases.case_type', op: 'in', value: ['Bankruptcy'] },
    ]},
    { field: 'cases.case_341_current', op: 'not_empty' },
    { field: 'cases.case_341_current', op: 'date_future' },
  ],
};

// Seed rows exactly as the migrations insert them, in the renderCards
// SELECT's ORDER BY sort ASC, id ASC (the stub returns this array AS the
// query result, so array order must mirror the SQL order):
//   docsNav(sort 2, id 3) → callback(sort 4, id 4) → payment(sort 10, id 1)
//   → meeting341(sort 10, id 2).
// E1 rows: ref/2026-08-07_portal_cards_e1.sql (payment first → lower id).
// R2 rows: ref/2026-08-09_portal_r1_r2.sql (nav cards, sorted AHEAD of
// payment to mirror the pre-R2 hardcoded visual order). KEEP IN SYNC.
function seedCards() {
  return [
    cardRow({
      id: 3, card_key: 'docsNav', title: 'Documents',
      body_type: 'coded', body_template: null, coded_key: 'docsNav',
      conditions: null, placement: 'case', sort: 2,
    }),
    cardRow({
      id: 4, card_key: 'callback', title: 'Need a call?', body_type: 'template',
      body_template: null,
      link_url: '/portal/callback.html', link_label: 'Request a callback',
      conditions: null, placement: 'case', sort: 4,
    }),
    cardRow({
      id: 1, card_key: 'payment', title: 'Payments', body_type: 'template',
      body_template: 'You can make a secure online payment toward your account at any time.',
      link_url: '/r/payment', link_label: 'Make a payment',
      conditions: null, placement: 'case', sort: 10,
    }),
    cardRow({
      id: 2, card_key: 'meeting341', title: 'Meeting of Creditors (341)',
      body_type: 'coded', body_template: null, coded_key: 'meeting341',
      conditions: MEETING341_CONDITIONS, placement: 'case_top', sort: 10,
    }),
  ];
}

// One renderCards call issues: portal_cards SELECT → ctx cases SELECT →
// ctx contacts SELECT → then ONE resolver JOIN query PER template card whose
// body has placeholders (resolve() row shape: `table__column` aliases) —
// append those via `extra`.
function scriptRenderCards(cards, caseOver = {}, contactOver = {}, extra = []) {
  return [ cards, [caseCtxRow(caseOver)], [contactCtxRow(contactOver)], ...extra ];
}

beforeEach(() => {
  jest.clearAllMocks();
  engine._resetAlertGate();
});

// ─────────────────────────────────────────────────────────────────────────────
// PORTAL_FIELD_WHITELIST — frozen
// ─────────────────────────────────────────────────────────────────────────────

describe('PORTAL_FIELD_WHITELIST (frozen)', () => {
  test('E1 set is EXACTLY the ratified fields — additions are deliberate diffs', () => {
    expect([...engine.PORTAL_FIELD_WHITELIST].sort()).toEqual([
      'cases.case_341_current',
      'cases.case_341_link',
      'cases.case_chapter',
      'cases.case_id',
      'cases.case_number',
      'cases.case_number_full',
      'cases.case_type',
      'contacts.contact_fname',
    ]);
  });

  test('sensitive set is excluded — NEVER to be added', () => {
    for (const banned of [
      'contacts.contact_ssn',
      'cases.case_status',           // internal vocabulary
      'cases.internal_label',
      'users.password',
      'users.password_hash',
      'users.default_email',
      'log.note',
    ]) {
      expect(engine.PORTAL_FIELD_WHITELIST.has(banned)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Template refusal — refuse, never strip
// ─────────────────────────────────────────────────────────────────────────────

describe('template whitelist enforcement', () => {
  const args = { caseId: 'AbCdEf12', contactId: 42, placement: ['case_top', 'case'] };

  test('blocked field (contact_ssn) → whole card refused, absent from output', async () => {
    const db = stubDb(scriptRenderCards([cardRow({
      card_key: 'evil',
      body_template: 'Hi {{contacts.contact_fname}}, ssn {{contacts.contact_ssn}}',
    })]));
    const cards = await engine.renderCards(db, args);
    expect(cards).toEqual([]);                       // refused, not sanitized
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1]).toMatchObject({
      source: 'portal_cards',
      group_key: 'portal_card_refused:evil',
    });
    expect(alert.mock.calls[0][1].message).toContain('contacts.contact_ssn');
  });

  test('internal-vocabulary field (case_status) → refused', async () => {
    const db = stubDb(scriptRenderCards([cardRow({
      card_key: 'status_leak', body_template: 'Status: {{cases.case_status}}',
    })]));
    expect(await engine.renderCards(db, args)).toEqual([]);
  });

  test('non-portal table (users) and trigger_data → refused', async () => {
    const db = stubDb(scriptRenderCards([
      cardRow({ card_key: 'u', body_template: '{{users.default_email}}' }),
      cardRow({ card_key: 't', body_template: '{{trigger_data.anything}}' }),
    ]));
    expect(await engine.renderCards(db, args)).toEqual([]);
  });

  test('violation hidden in a nested |default: is still caught (scanner parity)', async () => {
    const db = stubDb(scriptRenderCards([cardRow({
      card_key: 'nested',
      body_template: '{{contacts.contact_fname|default:{{contacts.contact_ssn}}}}',
    })]));
    expect(await engine.renderCards(db, args)).toEqual([]);
  });

  test('refusal alert fires once per card key per boot, not per request', async () => {
    const row = () => cardRow({ id: 99, card_key: 'evil', body_template: '{{contacts.contact_ssn}}' });
    await engine.renderCards(stubDb(scriptRenderCards([row()])), args);
    await engine.renderCards(stubDb(scriptRenderCards([row()])), args);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  test('clean template renders (control)', async () => {
    const db = stubDb(scriptRenderCards(
      [cardRow({ card_key: 'ok', body_template: 'Hi {{contacts.contact_fname}}.' })],
      {}, { contact_fname: 'Rivka' },
      [[{ contacts__contact_id: 42, contacts__contact_fname: 'Rivka' }]]
    ));
    const cards = await engine.renderCards(db, args);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ key: 'ok', body: 'Hi Rivka.', coded_key: null });
    expect(alert).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rules mode — operator matrix, all/any, nesting, fail-closed
// ─────────────────────────────────────────────────────────────────────────────

describe('rules mode', () => {
  const evalC = (conditions, c) => engine.evaluateConditions(null, conditions, c);
  const one = (rule) => ({ mode: 'rules', match: 'all', rules: [rule] });

  test('NULL conditions → always passes; malformed shapes fail closed', async () => {
    expect(await evalC(null, ctx())).toBe(true);
    expect(await evalC(undefined, ctx())).toBe(true);
    expect(await evalC({}, ctx())).toBe(false);                       // no rules
    expect(await evalC({ mode: 'rules', rules: [] }, ctx())).toBe(false);
    expect(await evalC('not json{', ctx())).toBe(false);
    expect(await evalC([], ctx())).toBe(false);
    expect(await evalC({ mode: 'nope', rules: [{}] }, ctx())).toBe(false);
  });

  test('JSON-string conditions parse defensively (mysql2 string fallback)', async () => {
    const s = JSON.stringify(one({ field: 'cases.case_type', op: 'in', value: ['Bankruptcy'] }));
    expect(await evalC(s, ctx())).toBe(true);
  });

  test('empty / not_empty — trim semantics (parity with the shipped BK gate)', async () => {
    const r = (op) => one({ field: 'cases.case_chapter', op });
    expect(await evalC(r('not_empty'), ctx({ case_chapter: '7' }))).toBe(true);
    expect(await evalC(r('not_empty'), ctx({ case_chapter: '' }))).toBe(false);
    expect(await evalC(r('not_empty'), ctx({ case_chapter: '  ' }))).toBe(false);
    expect(await evalC(r('not_empty'), ctx({ case_chapter: null }))).toBe(false);
    expect(await evalC(r('empty'),     ctx({ case_chapter: '' }))).toBe(true);
    expect(await evalC(r('empty'),     ctx({ case_chapter: '13' }))).toBe(false);
    // Date value is "not empty".
    expect(await evalC(one({ field: 'cases.case_341_current', op: 'not_empty' }),
      ctx({ case_341_current: wallDate(todayFirm()) }))).toBe(true);
  });

  test('in — trimmed string membership; null never matches; non-array fails', async () => {
    const r = (value) => one({ field: 'cases.case_type', op: 'in', value });
    expect(await evalC(r(['Bankruptcy']), ctx({ case_type: 'Bankruptcy' }))).toBe(true);
    expect(await evalC(r(['Bankruptcy']), ctx({ case_type: ' Bankruptcy ' }))).toBe(true);
    expect(await evalC(r(['Bankruptcy']), ctx({ case_type: 'Litigation' }))).toBe(false);
    expect(await evalC(r(['Bankruptcy']), ctx({ case_type: null }))).toBe(false);
    expect(await evalC(r('Bankruptcy'),  ctx({ case_type: 'Bankruptcy' }))).toBe(false); // not an array
  });

  test('date_future — >= today (today still shows: the shipped 341 boundary)', async () => {
    const r = one({ field: 'cases.case_341_current', op: 'date_future' });
    expect(await evalC(r, ctx({ case_341_current: wallDate(todayFirm(), '00:05') }))).toBe(true);
    expect(await evalC(r, ctx({ case_341_current: wallDate(todayFirm().plus({ days: 1 })) }))).toBe(true);
    expect(await evalC(r, ctx({ case_341_current: wallDate(todayFirm().minus({ days: 1 })) }))).toBe(false);
    expect(await evalC(r, ctx({ case_341_current: null }))).toBe(false);
    expect(await evalC(r, ctx({ case_341_current: new Date('invalid') }))).toBe(false);
  });

  test('date_past — strictly before today', async () => {
    const r = one({ field: 'cases.case_341_current', op: 'date_past' });
    expect(await evalC(r, ctx({ case_341_current: wallDate(todayFirm().minus({ days: 1 })) }))).toBe(true);
    expect(await evalC(r, ctx({ case_341_current: wallDate(todayFirm()) }))).toBe(false);
    expect(await evalC(r, ctx({ case_341_current: null }))).toBe(false);
  });

  test('date_within_days — [today, today+N]; bad N fails closed', async () => {
    const r = (n) => one({ field: 'cases.case_341_current', op: 'date_within_days', value: n });
    const at = (dt) => ctx({ case_341_current: wallDate(dt) });
    expect(await evalC(r(7), at(todayFirm()))).toBe(true);
    expect(await evalC(r(7), at(todayFirm().plus({ days: 7 })))).toBe(true);   // boundary
    expect(await evalC(r(7), at(todayFirm().plus({ days: 8 })))).toBe(false);
    expect(await evalC(r(7), at(todayFirm().minus({ days: 1 })))).toBe(false); // past excluded
    expect(await evalC(r(-1), at(todayFirm()))).toBe(false);
    expect(await evalC(r('x'), at(todayFirm()))).toBe(false);
  });

  test('contains / starts_with — null value or null needle fails closed', async () => {
    const c1 = one({ field: 'cases.case_number_full', op: 'contains', value: '-mlo' });
    expect(await evalC(c1, ctx({ case_number_full: '24-40226-mlo' }))).toBe(true);
    expect(await evalC(c1, ctx({ case_number_full: '24-40226' }))).toBe(false);
    expect(await evalC(c1, ctx({ case_number_full: null }))).toBe(false);
    expect(await evalC(one({ field: 'cases.case_number_full', op: 'contains' }),
      ctx({ case_number_full: '24-40226-mlo' }))).toBe(false);        // no needle
    const s1 = one({ field: 'cases.case_number', op: 'starts_with', value: '24-' });
    expect(await evalC(s1, ctx({ case_number: '24-40226' }))).toBe(true);
    expect(await evalC(s1, ctx({ case_number: '25-40226' }))).toBe(false);
  });

  test('unknown op and unknown/non-whitelisted field → fail closed', async () => {
    expect(await evalC(one({ field: 'cases.case_type', op: 'regex', value: '.*' }), ctx())).toBe(false);
    expect(await evalC(one({ field: 'cases.case_status', op: 'not_empty' }), ctx())).toBe(false);
    expect(await evalC(one({ field: 'cases.nope', op: 'not_empty' }), ctx())).toBe(false);
    expect(await evalC(one({ field: 'users.user_name', op: 'not_empty' }), ctx())).toBe(false);
    expect(await evalC(one({ op: 'not_empty' }), ctx())).toBe(false);  // no field
  });

  test('all/any semantics + nested groups (the 341 shape)', async () => {
    const anyOf = {
      mode: 'rules', match: 'any',
      rules: [
        { field: 'cases.case_chapter', op: 'not_empty' },
        { field: 'cases.case_type', op: 'in', value: ['Bankruptcy'] },
      ],
    };
    expect(await evalC(anyOf, ctx({ case_chapter: '', case_type: 'Bankruptcy' }))).toBe(true);
    expect(await evalC(anyOf, ctx({ case_chapter: '13', case_type: '' }))).toBe(true);
    expect(await evalC(anyOf, ctx({ case_chapter: '', case_type: 'Litigation' }))).toBe(false);

    // Full seeded meeting341 conditions:
    const future = wallDate(todayFirm().plus({ days: 3 }));
    expect(await evalC(MEETING341_CONDITIONS, ctx({ case_341_current: future }))).toBe(true);
    expect(await evalC(MEETING341_CONDITIONS,
      ctx({ case_341_current: wallDate(todayFirm().minus({ days: 3 })) }))).toBe(false);
    expect(await evalC(MEETING341_CONDITIONS,
      ctx({ case_chapter: '', case_type: 'Adversary Proceeding', case_341_current: future }))).toBe(false);
    expect(await evalC(MEETING341_CONDITIONS, ctx({ case_341_current: null }))).toBe(false);
  });

  test('anchor present but row missing → field reads null (E1 semantics stand)', async () => {
    // caseId PRESENT, row missing (deleted entity) — value null; empty PASSES.
    const rowGone = { caseRow: null, contactRow: contactCtxRow(), caseId: 'AbCdEf12', contactId: 42 };
    expect(await evalC(one({ field: 'cases.case_type', op: 'not_empty' }), rowGone)).toBe(false);
    expect(await evalC(one({ field: 'cases.case_type', op: 'empty' }), rowGone)).toBe(true);
  });

  test('S5 anchor gate: NO case anchor in context → cases.* rules fail CLOSED (even `empty`)', async () => {
    // The home surface's context — caseId null. Pre-S5 an `empty` rule on a
    // cases.* column would PASS here (implicit all-NULL row); the anchor
    // gate closes exactly that leak.
    const noCase = { caseRow: null, contactRow: contactCtxRow(), caseId: null, contactId: 42 };
    expect(await evalC(one({ field: 'cases.case_type', op: 'not_empty' }), noCase)).toBe(false);
    expect(await evalC(one({ field: 'cases.case_type', op: 'empty' }), noCase)).toBe(false);
    // contacts.* rules still evaluate normally in the same context.
    expect(await evalC(one({ field: 'contacts.contact_fname', op: 'not_empty' }), noCase)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SQL mode — pinning + fail-closed
// ─────────────────────────────────────────────────────────────────────────────

describe('sql mode', () => {
  const CTX = ctx();

  const sqlCond = (over = {}) => ({
    mode: 'sql',
    condition: Object.assign({
      query: 'SELECT COUNT(*) AS n FROM tasks WHERE task_case = :cid',
      params: { cid: 'case_id' },
      assert: { n: { in: [1] } },
    }, over),
  });

  test('params are PINNED to the session — both path spellings resolve', async () => {
    const db = stubDb([[{ n: 1 }]]);
    const cond = sqlCond({
      query: 'SELECT COUNT(*) AS n FROM tasks WHERE task_case = :cid AND task_contact = :pid',
      params: { cid: 'trigger_data.case_id', pid: 'contact_id' },
    });
    expect(await engine.evaluateConditions(db, cond, CTX)).toBe(true);
    // Positional params carry EXACTLY the session values, in query order.
    expect(db.calls[0].params).toEqual(['AbCdEf12', 42]);
  });

  test('config-mapped path outside the pinned set → rejected BEFORE any SQL', async () => {
    const db = stubDb([]);   // any query would throw 'unscripted'
    for (const path of ['cases.case_id', 'appt_id', 'trigger_data.evil', '999', '']) {
      expect(await engine.evaluateConditions(db, sqlCond({ params: { cid: path } }), CTX)).toBe(false);
    }
    expect(db.calls).toHaveLength(0);
  });

  test('non-string param path / array condition → fail closed', async () => {
    const db = stubDb([]);
    expect(await engine.evaluateConditions(db, sqlCond({ params: { cid: 7 } }), CTX)).toBe(false);
    expect(await engine.evaluateConditions(db, { mode: 'sql', condition: [] }, CTX)).toBe(false);
    expect(await engine.evaluateConditions(db, { mode: 'sql' }, CTX)).toBe(false);
    expect(db.calls).toHaveLength(0);
  });

  test('non-SELECT query → false (checkCondition guard holds through the engine)', async () => {
    const db = stubDb([]);
    const cond = sqlCond({ query: 'DELETE FROM tasks WHERE task_case = :cid' });
    expect(await engine.evaluateConditions(db, cond, CTX)).toBe(false);
    expect(db.calls).toHaveLength(0);
  });

  test('query error → condition false, no throw (fail closed)', async () => {
    const db = stubDb([new Error('ER_BAD_FIELD_ERROR: boom')]);
    expect(await engine.evaluateConditions(db, sqlCond(), CTX)).toBe(false);
  });

  test('broken sql on a card → card hidden, renderCards resolves without error', async () => {
    const db = stubDb([
      [cardRow({ card_key: 'gated', conditions: sqlCond() }),
       cardRow({ card_key: 'plain', body_template: 'ok', conditions: null })],
      [caseCtxRow()], [contactCtxRow()],
      new Error('ER_NO_SUCH_TABLE: nope'),   // the gated card's condition query
    ]);
    const cards = await engine.renderCards(db, { caseId: 'AbCdEf12', contactId: 42 });
    expect(cards.map(c => c.key)).toEqual(['plain']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Escaping + link guard + mechanics
// ─────────────────────────────────────────────────────────────────────────────

describe('body content and rendering mechanics', () => {
  const args = { caseId: 'AbCdEf12', contactId: 42 };

  // CLIENT CONTRACT (rider 2026-08-08): payload bodies are RAW resolved
  // text. public/portal/case.html escText's card.body AT INSERTION, exactly
  // like every other payload string (title, docket, labels) — the portal's
  // client-side symmetry. These two tests pin the engine's half of that
  // contract: ship the text verbatim, no server-side HTML transform in
  // EITHER direction (no escaping, no sanitizing).

  test('resolved value containing HTML ships RAW — the client escapes at insertion', async () => {
    const hostile = '<img src=x onerror=alert(1)>&"\'';
    const db = stubDb(scriptRenderCards(
      [cardRow({ card_key: 'x', body_template: 'Hi {{contacts.contact_fname}}!' })],
      {}, { contact_fname: hostile },
      [[{ contacts__contact_id: 42, contacts__contact_fname: hostile }]]
    ));
    const [card] = await engine.renderCards(db, args);
    expect(card.body).toBe('Hi <img src=x onerror=alert(1)>&"\'!');   // verbatim
    expect(card.body).not.toContain('&amp;');                          // and never pre-escaped
  });

  test('staff-typed HTML in the template ships RAW (text, never HTML — client escapes)', async () => {
    // No placeholders → no resolver query (resolve short-circuits).
    const db = stubDb(scriptRenderCards(
      [cardRow({ card_key: 'x', body_template: '<b>Bold?</b>' })]
    ));
    const [card] = await engine.renderCards(db, args);
    expect(card.body).toBe('<b>Bold?</b>');
  });

  test('unresolved placeholders (NULL column, no default) are STRIPPED, never shipped raw', async () => {
    const db = stubDb(scriptRenderCards(
      [cardRow({ card_key: 'x', body_template: 'Docket: {{cases.case_number_full}} end' })],
      { case_number_full: null }, {},
      [[{ cases__case_id: 'AbCdEf12', cases__case_number_full: null }]]
    ));
    const [card] = await engine.renderCards(db, args);
    expect(card.body).not.toContain('{{');
    expect(card.body).toBe('Docket:  end');
  });

  test('|default: still works inside the whitelist', async () => {
    const db = stubDb(scriptRenderCards(
      [cardRow({ card_key: 'x', body_template: '{{cases.case_number_full|default:your case}}' })],
      { case_number_full: null }, {},
      [[{ cases__case_id: 'AbCdEf12', cases__case_number_full: null }]]
    ));
    const [card] = await engine.renderCards(db, args);
    expect(card.body).toBe('your case');
  });

  test('resolver refs are pinned to the session ids', async () => {
    const db = stubDb(scriptRenderCards(
      [cardRow({ card_key: 'x', body_template: 'Hi {{contacts.contact_fname}} re {{cases.case_number}}' })],
      {}, {},
      [[{ contacts__contact_id: 42, contacts__contact_fname: 'T',
          cases__case_id: 'AbCdEf12', cases__case_number: '24-40226' }]]
    ));
    const cards = await engine.renderCards(db, args);
    expect(cards).toHaveLength(1);                 // resolve succeeded for real
    expect(cards[0].body).toBe('Hi T re 24-40226');
    // The resolver query (4th call) binds EXACTLY the pinned session ids.
    const resolverCall = db.calls[3];
    expect(resolverCall.params.sort()).toEqual(['AbCdEf12', 42].sort());
  });

  test('link guard: unsafe schemes and protocol-relative urls are dropped', () => {
    expect(engine._safeLink('/r/payment', 'Pay')).toEqual({ url: '/r/payment', label: 'Pay' });
    expect(engine._safeLink('https://x.test/a', '')).toEqual({ url: 'https://x.test/a', label: 'Open' });
    expect(engine._safeLink('javascript:alert(1)', 'x')).toBeNull();
    expect(engine._safeLink('//evil.test/a', 'x')).toBeNull();
    expect(engine._safeLink('meet.zoom.us/x', 'x')).toBeNull();
    expect(engine._safeLink('', 'x')).toBeNull();
    expect(engine._safeLink(null, 'x')).toBeNull();
  });

  test('renderCards: active filter is in the SQL; sort order rides sort,id', async () => {
    // Zero cards → renderCards short-circuits before context hydration, so the
    // case/contact rows scriptRenderCards() would add are never read. One query,
    // one scripted result.
    const db = stubDb([[]]);
    await engine.renderCards(db, args);
    expect(db.calls[0].sql).toContain('active = 1');
    expect(db.calls[0].sql).toContain('ORDER BY sort ASC, id ASC');
  });

  test('placement filter; omitted placement returns all', async () => {
    const rows = [
      cardRow({ card_key: 'top', placement: 'case_top', body_template: 'a' }),
      cardRow({ card_key: 'bot', placement: 'case', body_template: 'b' }),
    ];
    const db1 = stubDb(scriptRenderCards(rows.map(r => ({ ...r }))));
    expect((await engine.renderCards(db1, { ...args, placement: 'case_top' })).map(c => c.key))
      .toEqual(['top']);
    const db2 = stubDb(scriptRenderCards(rows.map(r => ({ ...r }))));
    expect((await engine.renderCards(db2, args)).map(c => c.key)).toEqual(['top', 'bot']);
  });

  test('coded card without coded_key is misconfig → hidden', async () => {
    const db = stubDb(scriptRenderCards([cardRow({ body_type: 'coded', coded_key: null })]));
    expect(await engine.renderCards(db, args)).toEqual([]);
  });

  test('renderCards never throws — missing table (pre-migration) → []', async () => {
    const db = stubDb([new Error("ER_NO_SUCH_TABLE: 'portal_cards' doesn't exist")]);
    expect(await engine.renderCards(db, args)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PARITY — post-E1 output ≡ pre-E1 hardcoded logic
// ─────────────────────────────────────────────────────────────────────────────

// Pre-E1 oracle: the shipped S2.1 buildMeeting341 (gates included), copied
// verbatim from services/portalCaseService.js @ pre-E1 HEAD. The parity
// contract: post-E1, the 341 card (and its data) appears iff this returns
// non-null, and the payment card appears ALWAYS — for existing cases the
// portal is behaviorally identical.
function preE1BuildMeeting341(caseRow) {
  const chapter = String(caseRow.case_chapter == null ? '' : caseRow.case_chapter).trim();
  const type = String(caseRow.case_type == null ? '' : caseRow.case_type).trim();
  const isBK = Boolean(chapter) || type === 'Bankruptcy';
  if (!isBK) return null;
  if (!caseRow.case_341_current) return null;

  const d = caseRow.case_341_current instanceof Date
    ? caseRow.case_341_current : new Date(caseRow.case_341_current);
  if (isNaN(d.getTime())) return null;

  const naive = d.toISOString().slice(0, 19);
  const date = naive.slice(0, 10);
  const time = naive.slice(11, 16);
  if (date < DateTime.now().setZone(FIRM_TZ).toISODate()) return null;

  const rawLink = String(caseRow.case_341_link == null ? '' : caseRow.case_341_link).trim();
  const link = /^https?:\/\//i.test(rawLink) ? rawLink : null;
  return { date, time, link };
}

describe('PARITY — engine + seeds reproduce pre-E1 behavior', () => {
  // getCaseView scope row (VIEW_COLUMNS projection).
  function scopeRow(over = {}) {
    return Object.assign({
      case_id: 'AbCdEf12', case_chapter: '7', case_type: 'Bankruptcy',
      case_number: '24-40226', case_number_full: '24-40226-mlo',
      case_341_current: null, case_341_link: '',
    }, over);
  }

  const PIPELINE = { template: null, current: null, history: [], upcoming: [], stages: [] };

  // getCaseView query order: scope SELECT → (pipeline mocked) →
  // portal_cards SELECT → ctx cases SELECT → ctx contacts SELECT.
  async function viewFor(caseOver) {
    const row = scopeRow(caseOver);
    const db = stubDb([
      [row],
      seedCards(),
      [caseCtxRow(caseOver)],
      [contactCtxRow()],
    ]);
    pipelineService.getPipeline.mockResolvedValueOnce(PIPELINE);
    return portalCases.getCaseView(db, 42, 'AbCdEf12');
  }

  const FIXTURES = {
    'BK, future 341, with link': {
      case_341_current: wallDate(todayFirm().plus({ days: 5 }), '13:00'),
      case_341_link: 'https://meet.zoom.us/j/999',
    },
    'BK, future 341, no link': {
      case_341_current: wallDate(todayFirm().plus({ days: 2 }), '09:30'),
      case_341_link: '',
    },
    'BK, TODAY 341 (boundary — still shows)': {
      case_341_current: wallDate(todayFirm(), '00:05'),
    },
    'BK, past 341': {
      case_341_current: wallDate(todayFirm().minus({ days: 30 })),
      case_341_link: 'https://meet.zoom.us/j/999',
    },
    'BK by chapter only (blank type)': {
      case_chapter: '13', case_type: '',
      case_341_current: wallDate(todayFirm().plus({ days: 7 })),
    },
    'non-BK with a 341 date (exclusivity)': {
      case_chapter: '', case_type: 'Adversary Proceeding',
      case_341_current: wallDate(todayFirm().plus({ days: 7 })),
    },
    'BK, no 341 set': { case_341_current: null },
  };

  for (const [name, caseOver] of Object.entries(FIXTURES)) {
    test(name, async () => {
      const oracle = preE1BuildMeeting341(scopeRow(caseOver));
      const view = await viewFor(caseOver);

      // 341 data presence + values ≡ pre-E1.
      expect(view.meeting341).toEqual(oracle);

      // Visible card set ≡ pre-R2: docsNav/callback/payment always
      // (unconditional, like the hardcoded cards they replace); 341 iff
      // the oracle shows.
      const keys = view.cards.map(c => c.key).sort();
      expect(keys).toEqual(oracle
        ? ['callback', 'docsNav', 'meeting341', 'payment']
        : ['callback', 'docsNav', 'payment']);

      // R2 ORDER parity — the pre-R2 visual order below the timeline was
      // Documents → Need a call? → Payments; the client lays out 'case'
      // cards in payload order, so the (sort,id)-ordered payload must
      // carry exactly that subsequence.
      const caseKeys = view.cards.filter(c => c.placement === 'case').map(c => c.key);
      expect(caseKeys).toEqual(['docsNav', 'callback', 'payment']);

      // Placement/shape parity per card.
      const pay = view.cards.find(c => c.key === 'payment');
      expect(pay).toMatchObject({
        placement: 'case',
        coded_key: null,
        link: { url: '/r/payment', label: 'Make a payment' },
      });
      expect(view.cards.find(c => c.key === 'docsNav')).toMatchObject({
        placement: 'case', coded_key: 'docsNav', body: null, link: null,
      });
      expect(view.cards.find(c => c.key === 'callback')).toMatchObject({
        placement: 'case', coded_key: null,
        body: '',                      // NULL template → empty body; the
                                       // client renders no body paragraph
        link: { url: '/portal/callback.html', label: 'Request a callback' },
      });
      if (oracle) {
        expect(view.cards.find(c => c.key === 'meeting341')).toMatchObject({
          placement: 'case_top', coded_key: 'meeting341', body: null,
        });
      }
    });
  }

  test('payment kill switch: active=0 (filtered out server-side) → card gone, view healthy', async () => {
    const row = scopeRow({});
    const db = stubDb([
      [row],
      seedCards().filter(c => c.card_key !== 'payment'),   // WHERE active=1 already excluded it
      [caseCtxRow({})],
      [contactCtxRow()],
    ]);
    pipelineService.getPipeline.mockResolvedValueOnce(PIPELINE);
    const view = await portalCases.getCaseView(db, 42, 'AbCdEf12');
    // R2: the nav cards are independent rows — killing payment leaves them.
    expect(view.cards.map(c => c.key)).toEqual(['docsNav', 'callback']);
    expect(view.meeting341).toBeNull();
  });

  test('meeting341 card passed but nothing formattable → card dropped fail-closed', async () => {
    // Force the mismatch: conditions pass (not_empty/date on a valid future
    // date in ctx) while the SCOPE row carries an invalid date the formatter
    // rejects. Contrived — pins the defensive drop.
    const future = wallDate(todayFirm().plus({ days: 3 }));
    const db = stubDb([
      [scopeRow({ case_341_current: new Date('invalid') })],
      seedCards(),
      [caseCtxRow({ case_341_current: future })],
      [contactCtxRow()],
    ]);
    pipelineService.getPipeline.mockResolvedValueOnce(PIPELINE);
    const view = await portalCases.getCaseView(db, 42, 'AbCdEf12');
    expect(view.meeting341).toBeNull();
    expect(view.cards.map(c => c.key)).toEqual(['docsNav', 'callback', 'payment']);
  });
});