// tests/portalCardEngine.home.test.js
//
// S5 — the HOME surface (lib/portalCardEngine.js + the admin preview's
// home path in routes/api.portalCardsAdmin.js):
//
//   • placement-aware validateCard MATRIX — a case field in the BODY, in a
//     RULE, and in a sql PARAMMAP is rejected for placement 'home' (errors
//     NAMED) and accepted for placement 'case'; contact fields accepted for
//     home; coded_key on home rejected; 'home' itself a valid surface.
//   • CASE-LESS render — renderCards({ caseId:null, placement:'home' })
//     never queries the cases table; a home card that carries a cases.*
//     template ref / rule / case_id sql param (a row that bypassed save
//     validation) is hidden fail-closed; a coded home row is hidden;
//     placement filtering holds.
//   • admin home preview — _previewDraft with a home draft requires
//     contact_id (400), 404s an unknown contact, and renders the REAL
//     case-less pipeline returning preview_contact.
//
// Stub pattern from tests/portalCardEngine.test.js (scripted mysql2 pool);
// lib/alerting is jest-mocked (no DB writes).
//
// Run:
//   npx jest tests/portalCardEngine.home.test.js

'use strict';

jest.mock('../lib/alerting', () => ({
  alert: jest.fn().mockResolvedValue(undefined),
}));

const { alert } = require('../lib/alerting');
const engine    = require('../lib/portalCardEngine');
const admin     = require('../routes/api.portalCardsAdmin');
// T9 script-drift guard: registers this file's scripted stubs so a global
// afterEach can fail on over- OR under-consumption of the script array.
// See tests/helpers/scriptGuard.js.
const { scriptGuard } = require('./helpers/scriptGuard');

// ─────────────────────────────────────────────────────────────────────────────
// Stubs / fixtures (portalCardEngine.test.js patterns)
// ─────────────────────────────────────────────────────────────────────────────

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

let _cardId = 100;
function homeRow(over = {}) {
  return Object.assign({
    id: ++_cardId,
    card_key: 'home_' + _cardId,
    title: 'A Home Card',
    body_type: 'template',
    body_template: 'Hello {{contacts.contact_fname}}.',
    coded_key: null,
    link_url: null,
    link_label: null,
    conditions: null,
    placement: 'home',
    sort: 10,
  }, over);
}

function card(over = {}) {
  return Object.assign({
    card_key: 'w', title: 'W', body_type: 'template',
    body_template: 'Hi {{contacts.contact_fname}}.',
    coded_key: null, link_url: null, link_label: null,
    conditions: null, placement: 'home', sort: 10, active: 1,
  }, over);
}

const contactCtxRow = (over = {}) => Object.assign({ contact_fname: 'Rivka' }, over);

function valid(c) {
  const v = engine.validateCard(c);
  expect(v.errors).toEqual([]);
  expect(v.valid).toBe(true);
  return v.card;
}
function invalid(c) {
  const v = engine.validateCard(c);
  expect(v.valid).toBe(false);
  return v.errors.join(' · ');
}

const sqlCond = (params) => ({
  mode: 'sql',
  condition: { query: 'SELECT 1 AS ok', params, assert: { ok: 1 } },
});

beforeEach(() => {
  jest.clearAllMocks();
  engine._resetAlertGate();
});

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary constants
// ─────────────────────────────────────────────────────────────────────────────

describe('S5 vocabulary', () => {
  test('home is a valid placement; the home sql-path subset and table set are frozen constants', () => {
    expect(engine.VALID_PLACEMENTS).toEqual(['case_top', 'case', 'home']);
    expect([...engine.ALLOWED_SQL_PARAM_PATHS_HOME].sort())
      .toEqual(['contact_id', 'trigger_data.contact_id']);
    expect([...engine.HOME_ALLOWED_TABLES]).toEqual(['contacts']);
    // KNOWN_CODED_KEYS deliberately unchanged — coded renderers are
    // case-view concerns (S5 ruling).
    expect(engine.KNOWN_CODED_KEYS).toEqual(['meeting341', 'docsNav']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateCard — the placement matrix
// ─────────────────────────────────────────────────────────────────────────────

describe('validateCard placement matrix', () => {
  test('BODY: case field rejected for home (named), accepted for case; contact field fine on home', () => {
    const msg = invalid(card({ body_template: 'Re {{cases.case_number}}.' }));
    expect(msg).toContain('cases.case_number');
    expect(msg).toContain('home');
    valid(card({ body_template: 'Re {{cases.case_number}}.', placement: 'case' }));
    valid(card({ body_template: 'Hi {{contacts.contact_fname}}.' }));
  });

  test('RULES: case field rejected for home (named), accepted for case; contact field fine; nesting too', () => {
    const caseRule = { mode: 'rules', match: 'all',
      rules: [{ field: 'cases.case_chapter', op: 'not_empty' }] };
    const msg = invalid(card({ conditions: caseRule }));
    expect(msg).toContain('cases.case_chapter');
    expect(msg).toContain('home surface');
    valid(card({ conditions: caseRule, placement: 'case' }));
    valid(card({ conditions: { mode: 'rules', match: 'all',
      rules: [{ field: 'contacts.contact_fname', op: 'not_empty' }] } }));
    // Nested group — the placement threads down.
    const nested = { mode: 'rules', match: 'all', rules: [
      { match: 'any', rules: [{ field: 'cases.case_type', op: 'in', value: ['Bankruptcy'] }] },
    ] };
    expect(invalid(card({ conditions: nested }))).toContain('cases.case_type');
    valid(card({ conditions: nested, placement: 'case' }));
  });

  test('SQL paramMap: case_id paths rejected for home (named), accepted for case; contact_id fine for both', () => {
    for (const path of ['case_id', 'trigger_data.case_id']) {
      const msg = invalid(card({ conditions: sqlCond({ cid: path }) }));
      expect(msg).toContain(`'${path}'`);
      expect(msg).toContain('no case_id on the home page');
      valid(card({ conditions: sqlCond({ cid: path }), placement: 'case' }));
    }
    for (const path of ['contact_id', 'trigger_data.contact_id']) {
      valid(card({ conditions: sqlCond({ c: path }) }));
      valid(card({ conditions: sqlCond({ c: path }), placement: 'case' }));
    }
    // Foreign paths stay rejected on BOTH surfaces.
    expect(invalid(card({ conditions: sqlCond({ x: 'user_id' }) }))).toContain("'user_id'");
    expect(invalid(card({ conditions: sqlCond({ x: 'user_id' }), placement: 'case' })))
      .toContain("'user_id'");
  });

  test('coded_key on a home card is a save-time rejection; same card on case saves', () => {
    const msg = invalid(card({
      body_type: 'coded', body_template: null, coded_key: 'meeting341',
    }));
    expect(msg).toContain('case-view renderers');
    valid(card({ body_type: 'coded', body_template: null, coded_key: 'meeting341',
                 placement: 'case_top' }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case-less render — renderCards({ caseId: null, placement: 'home' })
// ─────────────────────────────────────────────────────────────────────────────

// One case-less renderCards call issues: portal_cards SELECT → ctx CONTACTS
// SELECT (the cases SELECT is SKIPPED — that's the point) → one resolver
// query per template card with placeholders.
function scriptHome(cards, contactOver = {}, extra = []) {
  return [cards, [contactCtxRow(contactOver)], ...extra];
}
const HOME_ARGS = { caseId: null, contactId: 42, placement: 'home' };

describe('case-less render', () => {
  test('a clean home card renders; the cases table is NEVER queried', async () => {
    const db = stubDb(scriptHome(
      [homeRow({ card_key: 'welcome' })],
      {},
      [[{ contacts__contact_id: 42, contacts__contact_fname: 'Rivka' }]]
    ));
    const cards = await engine.renderCards(db, HOME_ARGS);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      key: 'welcome', body: 'Hello Rivka.', coded_key: null, placement: 'home',
    });
    for (const c of db.calls) {
      expect(c.sql).not.toMatch(/FROM `?cases`?/i);
      expect(c.sql).not.toMatch(/JOIN `?cases`?/i);
    }
  });

  test('placement filter: case/case_top rows are absent from a home render', async () => {
    const db = stubDb(scriptHome(
      [
        homeRow({ card_key: 'welcome' }),
        homeRow({ card_key: 'payment', placement: 'case', body_template: 'Pay us.' }),
        homeRow({ card_key: 'm341', placement: 'case_top', body_template: 'Meet.' }),
      ],
      {},
      [[{ contacts__contact_id: 42, contacts__contact_fname: 'Rivka' }]]
    ));
    const cards = await engine.renderCards(db, HOME_ARGS);
    expect(cards.map(c => c.key)).toEqual(['welcome']);
  });

  test('a home row with a cases.* TEMPLATE ref (bypassed validation) is REFUSED — absent + alert', async () => {
    const db = stubDb(scriptHome([
      homeRow({ card_key: 'sneaky', body_template: 'Docket {{cases.case_number}}.' }),
    ]));
    const cards = await engine.renderCards(db, HOME_ARGS);
    expect(cards).toEqual([]);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1]).toMatchObject({
      group_key: 'portal_card_refused:sneaky',
    });
    // The same template on the CASE surface is not a violation — the
    // refusal above is the placement, not the whitelist.
    expect(engine._scanTemplateViolations('Docket {{cases.case_number}}.')).toEqual([]);
    expect(engine._scanTemplateViolations('Docket {{cases.case_number}}.', 'home'))
      .toEqual(['cases.case_number']);
  });

  test('a home row with a cases.* RULE fails closed — hidden, no crash', async () => {
    const db = stubDb(scriptHome([
      homeRow({
        card_key: 'gated',
        conditions: { mode: 'rules', match: 'all',
          rules: [{ field: 'cases.case_chapter', op: 'empty' }] },   // empty would PASS pre-S5!
      }),
    ]));
    const cards = await engine.renderCards(db, HOME_ARGS);
    expect(cards).toEqual([]);
  });

  test('a home row whose sql condition maps case_id fails closed BEFORE any condition SQL runs', async () => {
    const db = stubDb(scriptHome([
      homeRow({ card_key: 'sqlgated', conditions: sqlCond({ cid: 'case_id' }) }),
    ]));
    const cards = await engine.renderCards(db, HOME_ARGS);
    expect(cards).toEqual([]);
    // Script exhausted exactly by portal_cards + ctx contacts — the
    // condition's SELECT never executed.
    expect(db.calls).toHaveLength(2);
    expect(db.calls[1].sql).toMatch(/FROM `?contacts`?/i);
  });

  test('a coded home row (bypassed validation) is hidden', async () => {
    const db = stubDb(scriptHome([
      homeRow({ card_key: 'codedhome', body_type: 'coded',
                body_template: null, coded_key: 'meeting341' }),
    ]));
    const cards = await engine.renderCards(db, HOME_ARGS);
    expect(cards).toEqual([]);
  });

  test('contacts rules still evaluate on the home surface (the gate is per-table, not global)', async () => {
    const db = stubDb(scriptHome(
      [homeRow({
        card_key: 'named',
        body_template: 'Hi.',
        conditions: { mode: 'rules', match: 'all',
          rules: [{ field: 'contacts.contact_fname', op: 'not_empty' }] },
      })],
    ));
    const cards = await engine.renderCards(db, HOME_ARGS);
    expect(cards.map(c => c.key)).toEqual(['named']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin preview — the home path (_previewDraft)
// ─────────────────────────────────────────────────────────────────────────────

describe('admin home preview', () => {
  test('home draft without contact_id → 400; unknown contact → 404', async () => {
    await expect(admin._previewDraft(stubDb([]), { card: card() }))
      .rejects.toMatchObject({ status: 400 });
    await expect(admin._previewDraft(stubDb([[]]), { card: card(), contact_id: 999999 }))
      .rejects.toMatchObject({ status: 404 });
  });

  test('valid home draft renders the REAL case-less pipeline → preview_contact + card', async () => {
    // Script: contact lookup → ctx contacts (loadCtx skips cases) → resolver.
    const db = stubDb([
      [{ contact_id: 42, contact_name: 'Rivka Test' }],
      [contactCtxRow()],
      [{ contacts__contact_id: 42, contacts__contact_fname: 'Rivka' }],
    ]);
    const out = await admin._previewDraft(db, { card: card(), contact_id: 42 });
    expect(out.validation.valid).toBe(true);
    expect(out.preview_contact).toEqual({ contact_id: 42, contact_name: 'Rivka Test' });
    expect(out.preview_case).toBeUndefined();
    expect(out.passes).toBe(true);
    expect(out.card).toMatchObject({ key: 'w', body: 'Hi Rivka.', placement: 'home' });
    for (const c of db.calls) {
      expect(c.sql).not.toMatch(/FROM `?cases`?/i);
    }
  });

  test('invalid home draft → 200-shaped validation errors, no lookups at all', async () => {
    const db = stubDb([]);
    const out = await admin._previewDraft(db, {
      card: card({ body_template: '{{cases.case_number}}' }),
      contact_id: 42,
    });
    expect(out.validation.valid).toBe(false);
    expect(out.validation.errors.join(' ')).toContain('cases.case_number');
    expect(db.calls).toHaveLength(0);
  });

  test('case drafts keep the case pin — case_id still required, contact_id ignored', async () => {
    await expect(admin._previewDraft(stubDb([]), {
      card: card({ placement: 'case' }), contact_id: 42,
    })).rejects.toMatchObject({ status: 400 });
  });
});
