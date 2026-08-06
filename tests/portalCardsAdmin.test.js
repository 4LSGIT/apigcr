// tests/portalCardsAdmin.test.js
//
// E2 admin-surface tests:
//   • validateCard — the save-time REJECT (never strip) matrix, built on the
//     engine's own primitives: whitelist violations NAMED in the error, bad
//     rule ops, bad value shapes, nesting cap, sql non-SELECT, foreign
//     paramMap paths, coded-card body rejection, placement/card_key/link
//     rules, normalization contract.
//   • route ops (routes/api.portalCardsAdmin.js exported internals):
//     create/update/delete/preview — merged-update revalidation, body_type +
//     coded_key immutability, coded-card DELETE refusal (deactivate is the
//     path), preview pinned to the case's server-resolved Primary contact
//     through the REAL engine pipeline (previewCard → renderOneCard).
//   • previewCard — per-top-level-group condition detail; refusal reported
//     in hidden_reason WITHOUT firing the once-per-boot alert.
//
// Stub pattern from tests/portalCardEngine.test.js (scripted mysql2 pool);
// lib/alerting is jest-mocked (no DB writes).
//
// Run:
//   npx jest tests/portalCardsAdmin.test.js

'use strict';

jest.mock('../lib/alerting', () => ({
  alert: jest.fn().mockResolvedValue(undefined),
}));

const { alert } = require('../lib/alerting');
const engine    = require('../lib/portalCardEngine');
const admin     = require('../routes/api.portalCardsAdmin');

const { DateTime } = require('luxon');
const { FIRM_TZ }  = require('../services/timezoneService');

// ─────────────────────────────────────────────────────────────────────────────
// Stubs / fixtures
// ─────────────────────────────────────────────────────────────────────────────

// Plain pool stub: query() shifts the next scripted [rows]/result. An Error
// entry throws; a function entry is called with (sql, params) and its return
// used — lets a script assert or branch mid-sequence.
function stubDb(script) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) throw new Error('stubDb: unscripted query: ' + sql);
      let next = script.shift();
      if (typeof next === 'function') next = next(sql, params);
      if (next instanceof Error) throw next;
      return [next];
    },
  };
}

// A valid template-card payload (create shape).
function tplCard(over = {}) {
  return Object.assign({
    card_key: 'welcome',
    title: 'Welcome',
    body_type: 'template',
    body_template: 'Hi {{contacts.contact_fname}}, re {{cases.case_number}}.',
    coded_key: null,
    link_url: '/r/payment',
    link_label: 'Pay',
    conditions: null,
    placement: 'case',
    sort: 10,
    active: 1,
  }, over);
}

// A stored row as fetchCard returns it (adds id + timestamps).
function storedRow(over = {}) {
  return Object.assign(tplCard(), {
    id: 7, created_at: '2026-08-08 00:00:00', updated_at: '2026-08-08 00:00:00',
  }, over);
}

function storedCodedRow(over = {}) {
  return storedRow(Object.assign({
    id: 2, card_key: 'meeting341', title: 'Meeting of Creditors (341)',
    body_type: 'coded', body_template: null, coded_key: 'meeting341',
    link_url: null, link_label: null, placement: 'case_top',
  }, over));
}

// Whitelisted ctx rows, as the engine's loadCtx SELECTs them.
function caseCtxRow(over = {}) {
  return Object.assign({
    case_id: 'AbCdEf12', case_chapter: '7', case_type: 'Bankruptcy',
    case_number: '24-40226', case_number_full: '24-40226-mlo',
    case_341_current: null, case_341_link: '',
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

const todayFirm = () => DateTime.now().setZone(FIRM_TZ).startOf('day');
function wallDate(firmLocalDt, hhmm = '10:00') {
  return new Date(firmLocalDt.toFormat('yyyy-MM-dd') + 'T' + hhmm + ':00Z');
}

// Shorthand: validateCard, expect invalid, return the joined error text.
function invalid(card) {
  const v = engine.validateCard(card);
  expect(v.valid).toBe(false);
  expect(v.card).toBeNull();
  return v.errors.join(' | ');
}
function valid(card) {
  const v = engine.validateCard(card);
  expect(v.valid).toBe(true);
  expect(v.errors).toEqual([]);
  return v.card;
}

beforeEach(() => {
  jest.clearAllMocks();
  engine._resetAlertGate();
});

// ─────────────────────────────────────────────────────────────────────────────
// validateCard — template bodies (refuse, never strip; errors NAME refs)
// ─────────────────────────────────────────────────────────────────────────────

describe('validateCard — template body whitelist', () => {
  test('clean template validates; normalized card returned', () => {
    const card = valid(tplCard());
    expect(card).toMatchObject({
      card_key: 'welcome', body_type: 'template', placement: 'case',
      sort: 10, active: 1, coded_key: null,
    });
  });

  test('non-whitelisted ref is REJECTED and NAMED in the error', () => {
    const msg = invalid(tplCard({
      body_template: 'Hi {{contacts.contact_fname}}, ssn {{contacts.contact_ssn}}',
    }));
    expect(msg).toContain('contacts.contact_ssn');
    expect(msg).toContain('refuse');           // never strip — staff-facing wording
  });

  test('internal vocabulary + foreign tables + trigger_data all rejected by name', () => {
    expect(invalid(tplCard({ body_template: '{{cases.case_status}}' })))
      .toContain('cases.case_status');
    expect(invalid(tplCard({ body_template: '{{users.default_email}}' })))
      .toContain('users.default_email');
    expect(invalid(tplCard({ body_template: '{{trigger_data.anything}}' })))
      .toContain('trigger_data.*');
  });

  test('violation nested in |default: is caught (same scanner as render time)', () => {
    const msg = invalid(tplCard({
      body_template: '{{contacts.contact_fname|default:{{contacts.contact_ssn}}}}',
    }));
    expect(msg).toContain('contacts.contact_ssn');
  });

  test('empty body is fine (link-only cards are a real shape)', () => {
    const card = valid(tplCard({ body_template: '' }));
    expect(card.body_template).toBe('');
  });

  test('template card must not carry a coded_key', () => {
    expect(invalid(tplCard({ coded_key: 'meeting341' }))).toContain('coded_key');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateCard — coded cards
// ─────────────────────────────────────────────────────────────────────────────

describe('validateCard — coded cards', () => {
  const coded = (over = {}) => tplCard(Object.assign({
    card_key: 'meeting341', body_type: 'coded', body_template: null,
    coded_key: 'meeting341', link_url: null, link_label: null,
    placement: 'case_top',
  }, over));

  test('valid coded card (known renderer) passes', () => {
    const card = valid(coded());
    expect(card).toMatchObject({ body_type: 'coded', coded_key: 'meeting341', body_template: null });
  });

  test('body fields on a coded card are REJECTED (body is code)', () => {
    const msg = invalid(coded({ body_template: 'staff-typed body' }));
    expect(msg).toContain('coded cards have no body_template');
  });

  test('missing coded_key rejected', () => {
    expect(invalid(coded({ coded_key: null }))).toContain('require a coded_key');
  });

  test('unknown coded_key rejected — error lists the known renderers', () => {
    const msg = invalid(coded({ coded_key: 'no_such_renderer' }));
    expect(msg).toContain('no_such_renderer');
    expect(msg).toContain('meeting341');       // the known set is named
  });

  test('R2: docsNav is a known coded renderer — admin can save/deactivate it', () => {
    const card = valid(coded({
      card_key: 'docsNav', coded_key: 'docsNav', placement: 'case',
    }));
    expect(card).toMatchObject({ body_type: 'coded', coded_key: 'docsNav', placement: 'case' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateCard — rules-mode conditions
// ─────────────────────────────────────────────────────────────────────────────

describe('validateCard — rules conditions', () => {
  const withRules = (rules, match = 'all') =>
    tplCard({ conditions: { mode: 'rules', match, rules } });

  test('every real operator validates with a proper value', () => {
    valid(withRules([
      { field: 'cases.case_chapter', op: 'not_empty' },
      { field: 'cases.case_chapter', op: 'empty' },
      { field: 'cases.case_type', op: 'in', value: ['Bankruptcy'] },
      { field: 'cases.case_341_current', op: 'date_future' },
      { field: 'cases.case_341_current', op: 'date_past' },
      { field: 'cases.case_341_current', op: 'date_within_days', value: 7 },
      { field: 'cases.case_number_full', op: 'contains', value: '-mlo' },
      { field: 'cases.case_number', op: 'starts_with', value: '24-' },
    ]));
  });

  test('the shipped meeting341 conditions shape validates (nested any-group)', () => {
    valid(withRules([
      { match: 'any', rules: [
        { field: 'cases.case_chapter', op: 'not_empty' },
        { field: 'cases.case_type', op: 'in', value: ['Bankruptcy'] },
      ]},
      { field: 'cases.case_341_current', op: 'not_empty' },
      { field: 'cases.case_341_current', op: 'date_future' },
    ]));
  });

  test('unknown op rejected by name; prototype-chain ops do not sneak through', () => {
    expect(invalid(withRules([{ field: 'cases.case_type', op: 'regex', value: '.*' }])))
      .toContain("unknown op 'regex'");
    expect(invalid(withRules([{ field: 'cases.case_type', op: 'constructor' }])))
      .toContain("unknown op 'constructor'");
  });

  test('non-whitelisted rule field rejected by name', () => {
    const msg = invalid(withRules([{ field: 'cases.case_status', op: 'not_empty' }]));
    expect(msg).toContain('cases.case_status');
    expect(msg).toContain('whitelist');
  });

  test('op value shapes: in needs a non-empty array; within_days a number ≥ 0; contains a value', () => {
    expect(invalid(withRules([{ field: 'cases.case_type', op: 'in', value: 'Bankruptcy' }])))
      .toContain('non-empty array');
    expect(invalid(withRules([{ field: 'cases.case_type', op: 'in', value: [] }])))
      .toContain('non-empty array');
    expect(invalid(withRules([{ field: 'cases.case_341_current', op: 'date_within_days', value: -1 }])))
      .toContain('date_within_days');
    expect(invalid(withRules([{ field: 'cases.case_341_current', op: 'date_within_days', value: 'x' }])))
      .toContain('date_within_days');
    expect(invalid(withRules([{ field: 'cases.case_number', op: 'contains' }])))
      .toContain("op 'contains' requires a value");
  });

  test('structural rules: empty rules array, bad match, non-object entries, depth cap', () => {
    expect(invalid(tplCard({ conditions: { mode: 'rules', rules: [] } })))
      .toContain('non-empty array');
    expect(invalid(withRules([{ field: 'cases.case_type', op: 'not_empty' }], 'some')))
      .toContain("match must be 'all' or 'any'");
    expect(invalid(withRules(['not-an-object'])))
      .toContain('must be a rule or a nested group');
    // depth 6 > engine cap 5
    let g = { field: 'cases.case_type', op: 'not_empty' };
    for (let i = 0; i < 6; i++) g = { match: 'all', rules: [g] };
    expect(invalid(withRules([g]))).toContain('cap');
  });

  test('conditions as a JSON string parse; broken JSON rejected; non-object rejected', () => {
    const card = valid(tplCard({
      conditions: JSON.stringify({ mode: 'rules', match: 'all',
        rules: [{ field: 'cases.case_type', op: 'not_empty' }] }),
    }));
    expect(card.conditions).toMatchObject({ mode: 'rules' });   // normalized to object
    expect(invalid(tplCard({ conditions: '{broken' }))).toContain('JSON parse failed');
    expect(invalid(tplCard({ conditions: [1, 2] }))).toContain('JSON object');
    expect(invalid(tplCard({ conditions: { mode: 'nope', rules: [{}] } })))
      .toContain("unknown conditions mode 'nope'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateCard — sql-mode conditions
// ─────────────────────────────────────────────────────────────────────────────

describe('validateCard — sql conditions', () => {
  const withSql = (condition) => tplCard({ conditions: { mode: 'sql', condition } });

  test('valid sql condition (both pinned path spellings) passes', () => {
    valid(withSql({
      query: 'SELECT COUNT(*) AS n FROM tasks WHERE task_case = :cid AND task_contact = :pid',
      params: { cid: 'trigger_data.case_id', pid: 'contact_id' },
      assert: { n: { in: [1] } },
    }));
  });

  test('non-SELECT query rejected', () => {
    const msg = invalid(withSql({
      query: 'DELETE FROM tasks WHERE task_case = :cid',
      params: { cid: 'case_id' },
    }));
    expect(msg).toContain('SELECT');
  });

  test('foreign paramMap path rejected — names the mapping and the pinned paths', () => {
    for (const path of ['cases.case_id', 'appt_id', 'trigger_data.evil', '999', '']) {
      const msg = invalid(withSql({
        query: 'SELECT 1 AS n', params: { cid: path }, assert: { n: 1 },
      }));
      expect(msg).toContain(`:cid maps to '${path}'`);
      expect(msg).toContain('pinned');
    }
  });

  test('structural: missing condition object, bad params/assert/assert_mode', () => {
    expect(invalid(tplCard({ conditions: { mode: 'sql' } })))
      .toContain("'condition' object");
    expect(invalid(withSql({ query: 'SELECT 1 AS n', params: [1] })))
      .toContain('params must be an object');
    expect(invalid(withSql({ query: 'SELECT 1 AS n', params: {}, assert: [] })))
      .toContain('assert must be an object');
    expect(invalid(withSql({ query: 'SELECT 1 AS n', params: {}, assert_mode: 'most' })))
      .toContain('assert_mode');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateCard — identity / link / placement / normalization
// ─────────────────────────────────────────────────────────────────────────────

describe('validateCard — identity, link, placement, normalization', () => {
  test('card_key rules', () => {
    expect(invalid(tplCard({ card_key: '' }))).toContain('card_key');
    expect(invalid(tplCard({ card_key: 'has spaces' }))).toContain('card_key');
    expect(invalid(tplCard({ card_key: 'x'.repeat(51) }))).toContain('card_key');
    valid(tplCard({ card_key: 'Meeting341_v2-a' }));
  });

  test('title required, capped at 100', () => {
    expect(invalid(tplCard({ title: '  ' }))).toContain('title is required');
    expect(invalid(tplCard({ title: 'x'.repeat(101) }))).toContain('100');
  });

  test('bad body_type rejected', () => {
    expect(invalid(tplCard({ body_type: 'html' }))).toContain('body_type');
  });

  test('link rules mirror the render-time guard, but REJECT instead of dropping', () => {
    expect(invalid(tplCard({ link_url: 'javascript:alert(1)' }))).toContain('link_url');
    expect(invalid(tplCard({ link_url: '//evil.test/a' }))).toContain('link_url');
    expect(invalid(tplCard({ link_url: 'meet.zoom.us/x' }))).toContain('link_url');
    expect(invalid(tplCard({ link_url: null, link_label: 'Orphan' })))
      .toContain('link_label without link_url');
    valid(tplCard({ link_url: 'https://x.test/a', link_label: null }));
    valid(tplCard({ link_url: '/r/payment', link_label: 'Pay' }));
  });

  test('placement pinned to the portal surfaces — error names them', () => {
    const msg = invalid(tplCard({ placement: 'home' }));
    expect(msg).toContain("placement 'home'");
    expect(msg).toContain('case_top');
    expect(msg).toContain('renders nowhere');
    valid(tplCard({ placement: 'case_top' }));
  });

  test('sort must be an integer; active must be 0/1-ish', () => {
    expect(invalid(tplCard({ sort: 'abc' }))).toContain('sort');
    expect(invalid(tplCard({ sort: 1.5 }))).toContain('sort');
    expect(invalid(tplCard({ active: 'yes' }))).toContain('active');
    expect(valid(tplCard({ sort: '25', active: true })).sort).toBe(25);
    expect(valid(tplCard({ active: false })).active).toBe(0);
    expect(valid(tplCard({ active: '0' })).active).toBe(0);
  });

  test('normalization: trims strings, blanks → null, defaults applied', () => {
    const card = valid(tplCard({
      card_key: '  welcome  ', title: '  Welcome  ',
      link_url: undefined, link_label: undefined,
      placement: undefined, sort: undefined, active: undefined,
    }));
    expect(card).toMatchObject({
      card_key: 'welcome', title: 'Welcome',
      link_url: null, link_label: null,
      placement: 'case', sort: 0, active: 1,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route ops — create / update / delete
// ─────────────────────────────────────────────────────────────────────────────

describe('admin route ops — create/update/delete', () => {
  test('create: invalid card → 400 carrying the error list, no SQL touched', async () => {
    const db = stubDb([]);
    await expect(admin._createCard(db, tplCard({
      body_template: '{{contacts.contact_ssn}}',
    }))).rejects.toMatchObject({
      status: 400,
      errors: expect.arrayContaining([expect.stringContaining('contacts.contact_ssn')]),
    });
    expect(db.calls).toHaveLength(0);
  });

  test('create: valid card → INSERT with stringified conditions, fresh row returned', async () => {
    const conditions = { mode: 'rules', match: 'all',
      rules: [{ field: 'cases.case_type', op: 'not_empty' }] };
    const db = stubDb([
      { insertId: 9 },                                   // INSERT
      [storedRow({ id: 9, conditions })],                // fetch fresh
    ]);
    const row = await admin._createCard(db, tplCard({ conditions }));
    expect(row.id).toBe(9);
    expect(db.calls[0].sql).toContain('INSERT INTO portal_cards');
    // conditions bind is the JSON string, not [object Object]
    const condParam = db.calls[0].params[7];
    expect(typeof condParam).toBe('string');
    expect(JSON.parse(condParam)).toEqual(conditions);
  });

  test('create: duplicate card_key → 409', async () => {
    const dup = new Error('dup'); dup.code = 'ER_DUP_ENTRY';
    const db = stubDb([dup]);
    await expect(admin._createCard(db, tplCard()))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('welcome') });
  });

  test('update: patch merges onto the existing row and the MERGED card revalidates', async () => {
    const db = stubDb([
      [storedRow()],                                     // fetch existing
    ]);
    // Existing row is valid; this patch makes the MERGED card invalid.
    await expect(admin._updateCard(db, 7, {
      body_template: 'ssn {{contacts.contact_ssn}}',
    })).rejects.toMatchObject({
      status: 400,
      errors: expect.arrayContaining([expect.stringContaining('contacts.contact_ssn')]),
    });
    expect(db.calls).toHaveLength(1);                    // no UPDATE ran
  });

  test('update: clean partial patch updates and returns the fresh row', async () => {
    const db = stubDb([
      [storedRow()],                                     // fetch existing
      {},                                                // UPDATE
      [storedRow({ title: 'Payments!' })],               // fetch fresh
    ]);
    const row = await admin._updateCard(db, 7, { title: 'Payments!' });
    expect(row.title).toBe('Payments!');
    expect(db.calls[1].sql).toContain('UPDATE portal_cards');
    // Unpatched fields ride the existing values (merge, not replace).
    expect(db.calls[1].params[0]).toBe('welcome');       // card_key
  });

  test('update: body_type is immutable → 409; same-value no-op allowed', async () => {
    const db1 = stubDb([[storedRow()]]);
    await expect(admin._updateCard(db1, 7, { body_type: 'coded' }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('immutable') });

    const db2 = stubDb([[storedRow()], {}, [storedRow()]]);
    await expect(admin._updateCard(db2, 7, { body_type: 'template', sort: 20 }))
      .resolves.toBeTruthy();
  });

  test('update on a coded card: body fields rejected (400)', async () => {
    const db = stubDb([[storedCodedRow()]]);
    await expect(admin._updateCard(db, 2, { body_template: 'sneaky body' }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('coded card') });
  });

  test('update on a coded card: coded_key is immutable → 409', async () => {
    const db = stubDb([[storedCodedRow()]]);
    await expect(admin._updateCard(db, 2, { coded_key: 'meeting342' }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('coded_key is immutable') });
  });

  test('update on a coded card: conditions/placement/sort/active/title stay editable', async () => {
    const db = stubDb([
      [storedCodedRow()], {}, [storedCodedRow({ sort: 99, active: 0 })],
    ]);
    const row = await admin._updateCard(db, 2, {
      sort: 99, active: 0, title: '341 Meeting',
      conditions: { mode: 'rules', match: 'all',
        rules: [{ field: 'cases.case_341_current', op: 'not_empty' }] },
    });
    expect(row.sort).toBe(99);
    expect(db.calls[1].sql).toContain('UPDATE portal_cards');
  });

  test('delete: template card hard-deletes', async () => {
    const db = stubDb([[storedRow()], {}]);
    const out = await admin._deleteCard(db, 7);
    expect(out).toEqual({ deleted: true, card_key: 'welcome' });
    expect(db.calls[1].sql).toContain('DELETE FROM portal_cards');
  });

  test('delete: CODED card refuses (409) and points at deactivate — no DELETE runs', async () => {
    const db = stubDb([[storedCodedRow()]]);
    await expect(admin._deleteCard(db, 2)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/coded card[\s\S]*[Dd]eactivate/),
    });
    expect(db.calls).toHaveLength(1);                    // fetch only
  });

  test('get/update/delete: unknown id → 404', async () => {
    await expect(admin._getCard(stubDb([[]]), 999)).rejects.toMatchObject({ status: 404 });
    await expect(admin._updateCard(stubDb([[]]), 999, {})).rejects.toMatchObject({ status: 404 });
    await expect(admin._deleteCard(stubDb([[]]), 999)).rejects.toMatchObject({ status: 404 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Preview — the REAL pipeline, pinned to the case's Primary contact
// ─────────────────────────────────────────────────────────────────────────────

describe('preview', () => {
  // previewDraft query order: case+Primary lookup → engine loadCtx cases →
  // loadCtx contacts → (resolver query per template placeholder set).
  function caseLookupRow(over = {}) {
    return Object.assign({
      case_id: 'AbCdEf12', case_number: '24-40226', case_number_full: '24-40226-mlo',
      primary_contact_id: 42, primary_contact_name: 'Test Client',
    }, over);
  }

  test('missing case_id → 400; unknown case → 404', async () => {
    await expect(admin._previewDraft(stubDb([]), { card: tplCard() }))
      .rejects.toMatchObject({ status: 400 });
    await expect(admin._previewDraft(stubDb([[]]), { card: tplCard(), case_id: 'nope1234' }))
      .rejects.toMatchObject({ status: 404 });
  });

  test('invalid draft → 200-shaped validation payload, no case lookup', async () => {
    const db = stubDb([]);
    const out = await admin._previewDraft(db, {
      case_id: 'AbCdEf12',
      card: tplCard({ body_template: '{{contacts.contact_ssn}}' }),
    });
    expect(out.validation.valid).toBe(false);
    expect(out.validation.errors.join(' ')).toContain('contacts.contact_ssn');
    expect(out.card).toBeUndefined();
    expect(db.calls).toHaveLength(0);
  });

  test('valid draft renders through the REAL pipeline pinned to the Primary contact', async () => {
    const db = stubDb([
      [caseLookupRow()],                                 // case + Primary
      [caseCtxRow()],                                    // loadCtx cases
      [contactCtxRow({ contact_fname: 'Rivka' })],       // loadCtx contacts
      [{ contacts__contact_id: 42, contacts__contact_fname: 'Rivka',
         cases__case_id: 'AbCdEf12', cases__case_number: '24-40226' }],    // resolver
    ]);
    const out = await admin._previewDraft(db, { case_id: 'AbCdEf12', card: tplCard() });

    expect(out.validation.valid).toBe(true);
    expect(out.preview_case).toEqual({
      case_id: 'AbCdEf12', docket: '24-40226-mlo',
      primary_contact_id: 42, primary_contact_name: 'Test Client',
    });
    expect(out.passes).toBe(true);
    expect(out.card).toMatchObject({
      key: 'welcome', title: 'Welcome',
      body: 'Hi Rivka, re 24-40226.',                    // RAW resolved text (rider)
      link: { url: '/r/payment', label: 'Pay' },
      coded_key: null, placement: 'case',
    });
    // The resolver bound EXACTLY the pinned session ids (case + its Primary).
    expect(db.calls[3].params.sort()).toEqual(['AbCdEf12', 42].sort());
    // The case lookup resolves Primary via the MIN-among-Primary rule.
    expect(db.calls[0].sql).toContain("case_relate_type = 'Primary'");
    expect(db.calls[0].sql).toContain('MIN(case_relate_client_id)');
  });

  test('conditions detail: per-top-level-group pass/fail rides the payload', async () => {
    const future = wallDate(todayFirm().plus({ days: 3 }));
    const db = stubDb([
      [caseLookupRow()],
      [caseCtxRow({ case_341_current: future })],
      [contactCtxRow()],
    ]);
    const out = await admin._previewDraft(db, {
      case_id: 'AbCdEf12',
      card: tplCard({
        body_template: 'no placeholders',
        conditions: { mode: 'rules', match: 'all', rules: [
          { match: 'any', rules: [
            { field: 'cases.case_chapter', op: 'not_empty' },
            { field: 'cases.case_type', op: 'in', value: ['Bankruptcy'] },
          ]},
          { field: 'cases.case_341_current', op: 'date_future' },
          { field: 'cases.case_number', op: 'starts_with', value: '99-' },
        ]},
      }),
    });
    expect(out.passes).toBe(false);
    expect(out.hidden_reason).toBe('conditions failed');
    expect(out.card).toBeNull();
    expect(out.conditions.mode).toBe('rules');
    expect(out.conditions.match).toBe('all');
    expect(out.conditions.groups).toEqual([
      { type: 'group', label: expect.stringContaining('any'), passes: true },
      { type: 'rule',  label: expect.stringContaining('date_future'), passes: true },
      { type: 'rule',  label: expect.stringContaining('starts_with'), passes: false },
    ]);
  });

  test('case without a Primary contact previews with contact fields NULL + a note', async () => {
    const db = stubDb([
      [caseLookupRow({ primary_contact_id: null, primary_contact_name: null })],
      [caseCtxRow()],
      // loadCtx skips the contacts SELECT entirely for a null contactId.
    ]);
    const out = await admin._previewDraft(db, {
      case_id: 'AbCdEf12',
      card: tplCard({ body_template: 'static body, no refs' }),
    });
    expect(out.note).toContain('no Primary contact');
    expect(out.preview_case.primary_contact_id).toBeNull();
    expect(out.passes).toBe(true);
    expect(out.card.body).toBe('static body, no refs');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// previewCard (engine) — refusal reporting without alerts
// ─────────────────────────────────────────────────────────────────────────────

describe('engine.previewCard — refusal + alert suppression', () => {
  test('refused template in preview: hidden_reason names refs, NO alert fires, gate not consumed', async () => {
    // A refused body can only reach previewCard if validation was bypassed —
    // the pipeline must still refuse (enforcement of record), report why,
    // and NOT page anyone or consume the once-per-boot alert gate.
    const db = stubDb([[caseCtxRow()], [contactCtxRow()]]);   // loadCtx only
    const out = await engine.previewCard(db, {
      card_key: 'evil', title: 'X', body_type: 'template',
      body_template: '{{contacts.contact_ssn}}', coded_key: null,
      link_url: null, link_label: null, conditions: null,
      placement: 'case', sort: 0, active: 1,
    }, { caseId: 'AbCdEf12', contactId: 42 });

    expect(out.passes).toBe(true);                       // conditions were null
    expect(out.card).toBeNull();                         // …but the pipeline refused
    expect(out.hidden_reason).toContain('contacts.contact_ssn');
    expect(alert).not.toHaveBeenCalled();

    // Production render of the same key later still alerts (gate untouched).
    const db2 = stubDb([
      [{ id: 1, card_key: 'evil', title: 'X', body_type: 'template',
         body_template: '{{contacts.contact_ssn}}', coded_key: null,
         link_url: null, link_label: null, conditions: null,
         placement: 'case', sort: 0 }],
      [caseCtxRow()], [contactCtxRow()],
    ]);
    await engine.renderCards(db2, { caseId: 'AbCdEf12', contactId: 42 });
    expect(alert).toHaveBeenCalledTimes(1);
  });

  test('coded preview renders the coded shell (body null, coded_key carried)', async () => {
    const db = stubDb([[caseCtxRow()], [contactCtxRow()]]);
    const out = await engine.previewCard(db, {
      card_key: 'meeting341', title: 'Meeting of Creditors (341)',
      body_type: 'coded', body_template: null, coded_key: 'meeting341',
      link_url: null, link_label: null, conditions: null,
      placement: 'case_top', sort: 10, active: 1,
    }, { caseId: 'AbCdEf12', contactId: 42 });
    expect(out.card).toMatchObject({
      key: 'meeting341', body: null, coded_key: 'meeting341', placement: 'case_top',
    });
  });
});
