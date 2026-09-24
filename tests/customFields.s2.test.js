// tests/customFields.s2.test.js
//
/**
 * Custom-fields arc S2 — the `custom` JSON bag on cases + contacts, and the
 * write chokepoint (ref/CUSTOM_FIELDS_DESIGN.md §2–§3, §7 S2 row).
 *
 * Proof obligations:
 *
 *   1. VALUES: validateValue's per-type coercion + clear semantics, as tables.
 *      select/multiselect accept retired options and reject unknown ones;
 *      `validation.required` is NOT enforced (renderers own it, S4).
 *   2. SPLIT: splitCustomFields routes cf_ keys (any case) off the column
 *      path; unknown / inactive keys and `custom` itself are one 400.
 *   3. ONE UPDATE: updateCase and updateContact compose the core SETs and the
 *      `custom = JSON_REMOVE(JSON_SET(...))` assignment into a SINGLE
 *      statement, params aligned — asserted on the SQL shape AND on the row
 *      the world ends up holding. Two statements would re-open the lost-
 *      update window §3 exists to close.
 *   4. CHANGES: per cf_ key, never `custom`; updated_fields the same.
 *   5. updateCase's any-column hole: a key that is neither a real column nor
 *      a cf_ key is a 400 before any UPDATE; column names are matched
 *      case-insensitively (MySQL's rule), so CASE_ID is still the PK.
 *   6. POST-DATA LOCKS: field_type and used option values lock ONLY once a
 *      record holds data; option `active` (retire) is inherited when the
 *      editor round-trips {value,label} without it.
 *   7. CONTAINMENT: `custom` is stripped from the persisted envelope (both
 *      entities, through the real emit path), refused by the resolver and the
 *      report validator, and stripped from query_db output.
 *   8. update_case fn: cf_ keys pass to the service gate; the two drifted
 *      core columns (pipeline_phase, case_341_link) are writable.
 *   9. GREP: no shipped code under lib/ services/ routes/ reads a key back
 *      out of `custom` with the JSON path operators (design doc §3). The
 *      scan includes comments on purpose — prose that spells the operator
 *      next to the column name is a copy-paste template for the real thing.
 *
 * Harness: the house dispatch-on-SQL-text world — cases / contacts /
 * field_defs rows in memory, and an UPDATE interpreter for exactly the shape
 * customAssignment emits (so param misalignment shows up as a wrong ROW, not
 * just a wrong string). The services, fieldDefService, domainEvents, the
 * resolver, the report validator and the internal fns all run for real; only
 * the Cloud Tasks doorbell, alerting and the Google push are stubbed.
 * Real-engine semantics of the same SQL (JSON types of CAST(? AS JSON),
 * JSON_REMOVE of an absent path, JSON_CONTAINS on scalar vs array) were
 * verified against MySQL 9.6 during S2 — see the S2 report; this suite has no
 * MySQL, like the rest of the run.
 *
 *   npx jest tests/customFields.s2.test.js
 */

'use strict';

jest.mock('../lib/taskQueue', () => ({
  ...jest.requireActual('../lib/taskQueue'),
  enqueueDomainEventDispatch: jest.fn(async () => true),
}));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));
jest.mock('../services/gContactsService', () => ({ pushContact: jest.fn(async () => {}) }));

const fs = require('fs');
const path = require('path');

const fieldDefs     = require('../services/fieldDefService');
const caseService   = require('../services/caseService');
const contactService = require('../services/contactService');
const domainEvents  = require('../lib/domainEvents');
const resolverService = require('../services/resolverService');
const { validateSql } = require('../lib/reportSchema/validator');
const manifest      = require('../lib/reportSchema/manifest');
const caseFns       = require('../lib/internal_functions/cases');
const contactFns    = require('../lib/internal_functions/contacts');
const dbFns         = require('../lib/internal_functions/db');

const ROOT = path.join(__dirname, '..');

// ─────────────────────────────────────────────────────────────
// Defs
// ─────────────────────────────────────────────────────────────

let nextDefId = 1;
function def(o) {
  return {
    id: nextDefId++, entity: 'case', label: o.field_key, options: null, validation: null,
    show_when: null, indexed: 0, sort_order: 0, active: 1,
    created_at: '2026-09-24 10:00:00', updated_at: '2026-09-24 10:00:00', ...o,
  };
}
const OPT = (value, label = value, active = true) => ({ value, label, active });

const DEFS = () => [
  def({ field_key: 'cf_txt', field_type: 'text', validation: { max_len: 5, pattern: '[A-Z]+' } }),
  def({ field_key: 'cf_note', field_type: 'text' }),
  def({ field_key: 'cf_num', field_type: 'number', validation: { min: 0, max: 100 } }),
  def({ field_key: 'cf_dt', field_type: 'date' }),
  def({ field_key: 'cf_yes', field_type: 'boolean' }),
  def({ field_key: 'cf_sel', field_type: 'select', options: [OPT('A'), OPT('B', 'Bee', false)] }),
  def({ field_key: 'cf_ms', field_type: 'multiselect', options: [OPT('x'), OPT('y'), OPT('z', 'Zed', false)] }),
  def({ field_key: 'cf_old', field_type: 'text', active: 0 }),
  def({ entity: 'contact', field_key: 'cf_txt', field_type: 'text' }),
  def({ entity: 'contact', field_key: 'cf_tags', field_type: 'multiselect', options: [OPT('vip'), OPT('slow')] }),
];

const byKey = (defs, entity, key) => defs.find(d => d.entity === entity && d.field_key === key);

// ─────────────────────────────────────────────────────────────
// In-memory world — dispatch on SQL text
// ─────────────────────────────────────────────────────────────

const COLUMNS = {
  cases: ['case_id', 'case_stage', 'case_status', 'case_notes', 'case_open_date', 'case_judge',
    'case_judge_contact_id', 'case_number_full', 'case_trustee', 'case_trustee_contact_id',
    'case_chapter', 'case_ISSN_form', 'pipeline_phase', 'case_341_link', 'custom'],
  contacts: ['contact_id', 'contact_kind', 'contact_org_name', 'contact_fname', 'contact_lname',
    'contact_tags', 'contact_notes', 'contact_updated', 'custom'],
};

const norm = sql => String(sql).replace(/\s+/g, ' ').trim();
const clone = o => JSON.parse(JSON.stringify(o));

/**
 * Apply `UPDATE <t> SET <assignments> WHERE ...` to `row`. Core assignments
 * are "`col` = ?"; the custom one is interpreted for the exact shape
 * customAssignment emits. Params are consumed left to right, as MySQL binds.
 */
function applyUpdate(row, setText, params) {
  const at = setText.indexOf('`custom` = ');
  const coreText = at === -1 ? setText : setText.slice(0, at).replace(/,\s*$/, '');
  let customText = at === -1 ? '' : setText.slice(at);
  const tail = customText.match(/, contact_updated = NOW\(\)$/);
  if (tail) customText = customText.slice(0, tail.index);
  let i = 0;
  for (const a of coreText.split(', ').filter(Boolean)) {
    if (a === 'contact_updated = NOW()') { row.contact_updated = 'NOW'; continue; }
    const m = a.match(/^`([^`]+)` = \?$/);
    if (!m) throw new Error('world: unexpected core assignment ' + a);
    row[m[1]] = params[i++];
  }
  if (customText) {
    const sets = (customText.match(/\?, CAST\(\? AS JSON\)/g) || []).length;
    const total = (customText.match(/\?/g) || []).length;
    const bag = { ...(row.custom || {}) };
    for (let s = 0; s < sets; s++) {
      const p = params[i++], v = params[i++];
      bag[p.replace(/^\$\./, '')] = JSON.parse(v);
    }
    for (let r = 0; r < total - 2 * sets; r++) delete bag[params[i++].replace(/^\$\./, '')];
    row.custom = bag;
  }
  if (tail) row.contact_updated = 'NOW';
  return i;
}

function world({ defs = DEFS(), cases = {}, contacts = {} } = {}) {
  const state = {
    defs: defs.map(d => ({ ...d, options: d.options && clone(d.options), validation: d.validation && clone(d.validation) })),
    cases: clone(cases), contacts: clone(contacts),
    updates: [], events: [], log: [], defUpdates: [],
  };
  const query = async (sql, params = []) => {
    const s = norm(sql);
    state.log.push(s);

    // ── field_defs ──
    if (/FROM field_defs WHERE entity = \? ORDER BY sort_order ASC, id ASC$/.test(s)) {
      return [state.defs.filter(d => d.entity === params[0]).map(d => clone(d))];
    }
    if (/FROM field_defs WHERE id = \? LIMIT 1 FOR UPDATE$/.test(s)) {
      const d = state.defs.find(x => x.id === params[0]);
      return [d ? [clone(d)] : []];
    }
    if (/^UPDATE field_defs SET .* WHERE id = \?$/.test(s)) {
      const cols = s.match(/SET (.*) WHERE/)[1].split(', ').map(x => x.replace(' = ?', ''));
      const d = state.defs.find(x => x.id === params[params.length - 1]);
      cols.forEach((c, k) => { d[c] = ['options', 'validation', 'show_when'].includes(c) ? JSON.parse(params[k]) : params[k]; });
      state.defUpdates.push({ cols, params });
      return [{ affectedRows: 1 }];
    }

    // ── information_schema (writableColumns) ──
    if (/^SELECT COLUMN_NAME FROM information_schema\.COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = \? AND GENERATION_EXPRESSION = ''$/.test(s)) {
      return [(COLUMNS[params[0]] || []).map(c => ({ COLUMN_NAME: c }))];
    }

    // ── post-data probes (existence only) ──
    let m;
    if ((m = s.match(/^SELECT 1 AS hit FROM `(cases|contacts)` WHERE JSON_CONTAINS_PATH\(custom, 'one', \?\) LIMIT 1$/))) {
      const k = params[0].replace(/^\$\./, '');
      const hit = Object.values(state[m[1]]).some(r => r.custom && Object.prototype.hasOwnProperty.call(r.custom, k));
      return [hit ? [{ hit: 1 }] : []];
    }
    if ((m = s.match(/^SELECT 1 AS hit FROM `(cases|contacts)` WHERE JSON_CONTAINS\(custom, CAST\(\? AS JSON\), \?\) LIMIT 1$/))) {
      const v = JSON.parse(params[0]);
      const k = params[1].replace(/^\$\./, '');
      const hit = Object.values(state[m[1]]).some(r => {
        const x = r.custom && r.custom[k];
        return Array.isArray(x) ? x.includes(v) : x === v;
      });
      return [hit ? [{ hit: 1 }] : []];
    }

    // ── cases ──
    if (/^SELECT \* FROM cases WHERE case_id = \?$/.test(s)) {
      const r = state.cases[params[0]];
      return [r ? [clone(r)] : []];
    }
    if ((m = s.match(/^UPDATE cases SET (.*) WHERE case_id = \?$/))) {
      state.updates.push({ table: 'cases', sql: s, params });
      const r = state.cases[params[params.length - 1]];
      if (!r) return [{ affectedRows: 0 }];
      applyUpdate(r, m[1], params);
      return [{ affectedRows: 1 }];
    }

    // ── contacts ──
    if ((m = s.match(/^SELECT (.+) FROM contacts WHERE contact_id = \?$/))) {
      const r = state.contacts[params[0]];
      if (!r) return [[]];
      if (m[1] === '*') return [[clone(r)]];
      const out = {};
      for (const c of m[1].split(', ')) { const k = c.replace(/`/g, ''); out[k] = clone(r)[k]; }
      return [[out]];
    }
    if ((m = s.match(/^UPDATE contacts SET (.*) WHERE contact_id = \?$/))) {
      state.updates.push({ table: 'contacts', sql: s, params });
      const r = state.contacts[params[params.length - 1]];
      if (!r) return [{ affectedRows: 0 }];
      applyUpdate(r, m[1], params);
      return [{ affectedRows: 1 }];
    }

    // ── domain events (the real emit path persists the envelope here) ──
    if (/^INSERT INTO domain_event_queue/.test(s)) {
      state.events.push({ type: params[0], envelope: JSON.parse(params[2]) });
      return [{ insertId: state.events.length }];
    }

    throw new Error('world: unscripted query — ' + s);
  };
  const conn = {
    query,
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
    release: () => {}, destroy: () => {},
  };
  return {
    state,
    query,
    getConnection: async () => conn,
    withTransaction: async fn => fn(conn),
  };
}

/** emit() is fire-and-forget; let its INSERT land. */
const settle = () => new Promise(r => setImmediate(r));

const CASE_A = () => ({
  case_id: 'A', case_stage: 'Open', case_status: '', case_notes: null, case_open_date: null,
  case_judge: '', case_judge_contact_id: null, case_number_full: '', case_trustee: '',
  case_trustee_contact_id: null, case_chapter: '', case_ISSN_form: '', pipeline_phase: 'intake',
  case_341_link: '', custom: { cf_note: 'keep', cf_ms: ['x'] },
});
const CONTACT_1 = () => ({
  contact_id: 1, contact_kind: 'person', contact_org_name: '', contact_fname: 'Ada', contact_lname: 'Lovelace',
  contact_tags: '', contact_notes: '', contact_updated: null, custom: { cf_txt: 'old' },
});

beforeEach(() => { fieldDefs.bump(); });

async function rejects(p) {
  try { await p; } catch (e) { return e; }
  throw new Error('expected a rejection');
}

// ─────────────────────────────────────────────────────────────
// 1. validateValue
// ─────────────────────────────────────────────────────────────

describe('validateValue — per-type coercion (design doc §2 type map)', () => {
  const defs = DEFS();
  const D = k => byKey(defs, 'case', k);
  const ok  = (k, raw, want) => expect(fieldDefs.validateValue(D(k), raw)).toEqual({ ok: true, value: want });
  const bad = (k, raw, re) => {
    const r = fieldDefs.validateValue(D(k), raw);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(new RegExp(`^${k}: `));
    if (re) expect(r.error).toMatch(re);
  };

  test.each([
    ['cf_txt'], ['cf_note'], ['cf_num'], ['cf_dt'], ['cf_yes'], ['cf_sel'], ['cf_ms'],
  ])('%s: null / undefined / "" clear (value null → JSON_REMOVE)', (k) => {
    ok(k, null, null); ok(k, undefined, null); ok(k, '', null);
  });

  test('multiselect [] clears; false and 0 are VALUES, not clears', () => {
    ok('cf_ms', [], null);
    ok('cf_yes', false, false);
    ok('cf_num', 0, 0);
  });

  test('text: string, a finite number as its text; max_len counts characters; pattern is a FULL match', () => {
    ok('cf_txt', 'ABC', 'ABC');
    ok('cf_note', 12345, '12345');
    ok('cf_note', '  spaced  ', '  spaced  ');            // stored verbatim
    bad('cf_note', true, /must be text/);
    bad('cf_note', { a: 1 }, /must be text/);
    bad('cf_txt', 'ABCDEF', /5 characters or fewer \(got 6\)/);
    bad('cf_txt', 'ABCd', /pattern/);                      // a substring match would pass this
    const emoji = { ...D('cf_note'), validation: { max_len: 2 } };
    expect(fieldDefs.validateValue(emoji, '😀😀')).toEqual({ ok: true, value: '😀😀' });
  });

  test('number: finite, plain decimal strings coerce, min/max, DECIMAL(18,4) bound', () => {
    ok('cf_num', 42, 42);
    ok('cf_num', '42.5', 42.5);
    ok('cf_num', ' 7 ', 7);
    ok('cf_num', '1e1', 10);
    ok('cf_num', -0 + 0, 0);
    bad('cf_num', 'abc', /must be a number/);
    bad('cf_num', '0x10', /must be a number/);
    bad('cf_num', '12abc', /must be a number/);
    bad('cf_num', NaN, /finite/);
    bad('cf_num', Infinity, /finite/);
    bad('cf_num', 101, /at most 100/);
    bad('cf_num', -1, /at least 0/);
    const wide = { ...D('cf_num'), validation: null };
    expect(fieldDefs.validateValue(wide, 99999999999999).ok).toBe(true);
    expect(fieldDefs.validateValue(wide, -99999999999999.99).ok).toBe(true);
    expect(fieldDefs.validateValue(wide, 1e14).ok).toBe(false);    // the column max is not a double: 99999999999999.9999 === 1e14
    expect(fieldDefs.validateValue(wide, '-1e14').ok).toBe(false);
    expect(fieldDefs.validateValue(wide, -0)).toEqual({ ok: true, value: 0 });
    expect(Object.is(fieldDefs.validateValue(wide, -0).value, 0)).toBe(true);
  });

  test('date: YYYY-MM-DD, real calendar date, year ≥ 1000', () => {
    ok('cf_dt', '2026-02-28', '2026-02-28');
    ok('cf_dt', '2024-02-29', '2024-02-29');
    ok('cf_dt', ' 2026-01-05 ', '2026-01-05');
    bad('cf_dt', '2026-02-29', /not a real calendar date/);
    bad('cf_dt', '2026-13-01', /not a real calendar date/);
    bad('cf_dt', '0999-01-01', /not a real calendar date/);
    bad('cf_dt', '2026-1-5', /YYYY-MM-DD/);
    bad('cf_dt', '2026-01-05T00:00:00Z', /YYYY-MM-DD/);
    bad('cf_dt', 20260105, /YYYY-MM-DD/);
  });

  test('boolean: true/false, 1/0, "1"/"0", "true"/"false" any case', () => {
    for (const t of [true, 1, '1', 'true', 'TRUE', ' True ']) ok('cf_yes', t, true);
    for (const f of [false, 0, '0', 'false', 'FALSE']) ok('cf_yes', f, false);
    bad('cf_yes', 'yes', /true or false/);
    bad('cf_yes', 2, /true or false/);
  });

  test('select: an option value — active OR retired — canonical spelling; unknown rejected', () => {
    ok('cf_sel', 'A', 'A');
    ok('cf_sel', 'a', 'A');           // case-folded to the stored spelling
    ok('cf_sel', 'B', 'B');           // retired: still writable (§3)
    bad('cf_sel', 'C', /"C" is not one of its options \(A, B\)/);
    bad('cf_sel', ['A'], /not one of its options/);
    const numeric = { ...D('cf_sel'), options: [OPT('1'), OPT('2')] };
    expect(fieldDefs.validateValue(numeric, 2)).toEqual({ ok: true, value: '2' });
  });

  test('multiselect: array of option values, retired ok, no repeats, stored in option order', () => {
    ok('cf_ms', ['y', 'X'], ['x', 'y']);
    ok('cf_ms', ['z'], ['z']);        // retired member
    bad('cf_ms', ['x', 'X'], /"x" is listed twice/);
    bad('cf_ms', ['q'], /"q" is not one of its options/);
    bad('cf_ms', 'x', /array of option values/);
  });

  test('validation.required is NOT enforced (a partial PATCH clearing it must not fail)', () => {
    const req = { ...D('cf_note'), validation: { required: true } };
    expect(fieldDefs.validateValue(req, null)).toEqual({ ok: true, value: null });
    expect(fieldDefs.validateValue(req, '')).toEqual({ ok: true, value: null });
  });
});

// ─────────────────────────────────────────────────────────────
// 2. splitCustomFields + customAssignment
// ─────────────────────────────────────────────────────────────

describe('splitCustomFields — the shared front half of both chokepoints', () => {
  test('partitions core vs cf_, validates, normalizes', async () => {
    const db = world();
    const r = await fieldDefs.splitCustomFields(db, 'case', {
      case_stage: 'Filed', cf_num: '5', cf_txt: '', cf_ms: ['y', 'x'],
    });
    expect(r.coreFields).toEqual({ case_stage: 'Filed' });
    expect(r.customSets).toEqual({ cf_num: 5, cf_ms: ['x', 'y'] });
    expect(r.customRemoves).toEqual(['cf_txt']);
    expect(r.customKeys).toEqual(['cf_num', 'cf_txt', 'cf_ms']);
  });

  test('unknown, inactive, `custom` and bad values are ONE 400 naming each', async () => {
    const db = world();
    const e = await rejects(fieldDefs.splitCustomFields(db, 'case', {
      cf_nope: 1, cf_old: 'x', custom: {}, CF_SHOUT: 1, cf_num: 'lots',
    }));
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/unknown custom field\(s\) on case: cf_nope, CF_SHOUT/);
    expect(e.message).toMatch(/inactive custom field\(s\) on case: cf_old/);
    expect(e.message).toMatch(/custom is not writable as a whole/);
    expect(e.message).toMatch(/cf_num: must be a number/);
  });

  test('entity-scoped: a contact def does not satisfy a case write', async () => {
    const e = await rejects(fieldDefs.splitCustomFields(world(), 'case', { cf_tags: ['vip'] }));
    expect(e.message).toMatch(/unknown custom field\(s\) on case: cf_tags/);
  });
});

describe('customAssignment — ONE clause, bound paths, JSON-typed values', () => {
  test('sets + removes compose into a single JSON_REMOVE(JSON_SET(...)) expression', () => {
    const r = fieldDefs.customAssignment({ cf_aa: 'x', cf_bb: true, cf_cc: ['p', 'q'] }, ['cf_dd']);
    expect(r.sql).toBe('`custom` = JSON_REMOVE(JSON_SET(`custom`, ?, CAST(? AS JSON), ?, CAST(? AS JSON), ?, CAST(? AS JSON)), ?)');
    expect(r.params).toEqual(['$.cf_aa', '"x"', '$.cf_bb', 'true', '$.cf_cc', '["p","q"]', '$.cf_dd']);
  });

  test('set-only / remove-only / nothing', () => {
    expect(fieldDefs.customAssignment({ cf_aa: 1 }, []).sql).toBe('`custom` = JSON_SET(`custom`, ?, CAST(? AS JSON))');
    expect(fieldDefs.customAssignment({}, ['cf_aa']).sql).toBe('`custom` = JSON_REMOVE(`custom`, ?)');
    expect(fieldDefs.customAssignment({}, [])).toBeNull();
  });

  test('refuses a key the registry could never have produced', () => {
    expect(() => fieldDefs.customAssignment({ "cf_aa') OR 1 -- ": 1 }, [])).toThrow(/malformed key/);
    expect(() => fieldDefs.customAssignment({}, ['nope'])).toThrow(/malformed key/);
  });
});

describe('buildCustomChanges — per key, JSON-compared', () => {
  test('set/clear/no-op', () => {
    const prior = { cf_a: 'x', cf_b: ['p'], cf_n: 1 };
    expect(fieldDefs.buildCustomChanges(prior, { cf_a: 'x', cf_b: ['p', 'q'], cf_new: false }, ['cf_n', 'cf_absent']))
      .toEqual({
        cf_b:   { from: ['p'], to: ['p', 'q'] },
        cf_new: { from: null, to: false },
        cf_n:   { from: 1, to: null },
      });
    expect(fieldDefs.buildCustomChanges(JSON.stringify(prior), { cf_n: '1' }, [])).toEqual({ cf_n: { from: 1, to: '1' } });
    expect(fieldDefs.buildCustomChanges(null, {}, ['cf_a'])).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────
// 3–5. caseService.updateCase
// ─────────────────────────────────────────────────────────────

describe('caseService.updateCase — the case chokepoint', () => {
  test('core + cf_ sets + cf_ clears land in ONE UPDATE, params aligned', async () => {
    const db = world({ cases: { A: CASE_A() } });
    const r = await caseService.updateCase(db, 'A', {
      case_stage: 'Filed', cf_num: '42.5', cf_yes: 'true', cf_ms: ['y', 'x'], cf_note: '', case_status: 'ok',
    });

    expect(db.state.updates).toHaveLength(1);
    const u = db.state.updates[0];
    expect(u.sql).toMatch(/^UPDATE cases SET `case_stage` = \?, `case_status` = \?, `custom` = JSON_REMOVE\(JSON_SET\(`custom`, /);
    expect(u.sql).toContain('JSON_SET(');
    expect(u.sql).toContain('JSON_REMOVE(');

    const row = db.state.cases.A;
    expect(row.case_stage).toBe('Filed');
    expect(row.case_status).toBe('ok');
    expect(row.custom).toEqual({ cf_num: 42.5, cf_yes: true, cf_ms: ['x', 'y'] });

    expect(r.updated_fields).toEqual(['case_stage', 'case_status', 'cf_num', 'cf_yes', 'cf_ms', 'cf_note']);
    expect(r.changes).toEqual({
      case_stage: { from: 'Open', to: 'Filed' },
      case_status: { from: '', to: 'ok' },
      cf_num: { from: null, to: 42.5 },
      cf_yes: { from: null, to: true },
      cf_ms:  { from: ['x'], to: ['x', 'y'] },
      cf_note: { from: 'keep', to: null },
    });
    expect(r.updated_fields).not.toContain('custom');
    expect(r.changes).not.toHaveProperty('custom');
  });

  test('a cf_-only write is still one UPDATE — just the custom clause', async () => {
    const db = world({ cases: { A: CASE_A() } });
    await caseService.updateCase(db, 'A', { cf_sel: 'B' });
    expect(db.state.updates).toHaveLength(1);
    expect(db.state.updates[0].sql).toBe('UPDATE cases SET `custom` = JSON_SET(`custom`, ?, CAST(? AS JSON)) WHERE case_id = ?');
    expect(db.state.cases.A.custom.cf_sel).toBe('B');
  });

  test('role twins still bind at their updated_fields index with cf_ keys present', async () => {
    const db = world({ cases: { A: CASE_A() } });
    // resolver lookups miss everything in this world → twin written NULL
    const q = db.query;
    db.query = async (sql, params) => (/contact_roles|app_settings|FROM contacts c/i.test(sql) ? [[]] : q(sql, params));
    const r = await caseService.updateCase(db, 'A', { cf_num: 3, case_judge: 'Nobody' });
    const u = db.state.updates[0];
    r.updated_fields.filter(k => !k.startsWith('cf_')).forEach((k, idx) => {
      expect(u.sql).toContain(`\`${k}\` = ?`);
      expect(u.params[idx]).toBe(k === 'case_judge' ? 'Nobody' : null);
    });
    expect(db.state.cases.A.custom.cf_num).toBe(3);
  });

  test('a key that is neither a real column nor a cf_ key is a 400 before any UPDATE', async () => {
    const db = world({ cases: { A: CASE_A() } });
    const e = await rejects(caseService.updateCase(db, 'A', { case_stage: 'Filed', case_stagee: 'x', bogus: 1 }));
    expect(e.status).toBe(400);
    expect(e.message).toBe('updateCase: unknown column(s): case_stagee, bogus');
    expect(db.state.updates).toHaveLength(0);
  });

  test('column names match case-insensitively (MySQL rule) — and CASE_ID is still the PK', async () => {
    const db = world({ cases: { A: CASE_A() } });
    await caseService.updateCase(db, 'A', { case_issn_form: 'f1' });
    expect(db.state.updates).toHaveLength(1);
    await expect(caseService.updateCase(db, 'A', { CASE_ID: 'Z' })).rejects.toThrow(/blocked columns: CASE_ID/);
  });

  test('`custom` itself (any case) and unknown / inactive cf_ keys are refused, nothing written', async () => {
    const db = world({ cases: { A: CASE_A() } });
    for (const f of [{ custom: {} }, { CUSTOM: '{}' }, { cf_nope: 1 }, { cf_old: 'x' }, { cf_num: 1000 }]) {
      const e = await rejects(caseService.updateCase(db, 'A', f));
      expect(e.status).toBe(400);
    }
    expect(db.state.updates).toHaveLength(0);
  });

  test('case.updated envelope: no `custom` in data; cf_ keys in changes + updated_fields', async () => {
    const db = world({ cases: { A: CASE_A() } });
    await caseService.updateCase(db, 'A', { cf_num: 9, case_stage: 'Filed' }, { userId: 3, source: 'manual' });
    await settle();
    expect(db.state.events).toHaveLength(1);
    const env = db.state.events[0].envelope;
    expect(env.event).toBe('case.updated');
    expect(env.data).not.toHaveProperty('custom');
    expect(env.data.case_stage).toBe('Filed');
    expect(Object.keys(env.changes).sort()).toEqual(['case_stage', 'cf_num']);
    expect(env.extra.updated_fields).toEqual(['case_stage', 'cf_num']);
    expect(JSON.stringify(env)).not.toContain('"custom"');
    expect(JSON.stringify(env)).not.toContain('keep');   // the untouched cf_note value never travels
  });

  test('re-writing the same values changes nothing and emits nothing', async () => {
    const db = world({ cases: { A: CASE_A() } });
    const r = await caseService.updateCase(db, 'A', { cf_note: 'keep', cf_ms: ['x'], cf_dt: null });
    await settle();
    expect(r.changes).toEqual({});
    expect(db.state.events).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// contactService.updateContact
// ─────────────────────────────────────────────────────────────

describe('contactService.updateContact — the contact chokepoint', () => {
  test('core + cf_ in ONE UPDATE (contact_updated bumped); old values from the in-tx pre-read', async () => {
    const db = world({ contacts: { 1: CONTACT_1() } });
    const r = await contactService.updateContact(db, 1, { contact_tags: 'a', cf_txt: 'new', cf_tags: ['slow', 'vip'] }, { userId: 3 });

    expect(db.state.updates).toHaveLength(1);
    const u = db.state.updates[0];
    expect(u.sql).toMatch(/^UPDATE contacts SET `contact_tags` = \?, `custom` = JSON_SET\(`custom`, \?, CAST\(\? AS JSON\), \?, CAST\(\? AS JSON\)\), contact_updated = NOW\(\) WHERE contact_id = \?$/);
    expect(db.state.log).toContain('SELECT `contact_tags`, `custom` FROM contacts WHERE contact_id = ?');

    const row = db.state.contacts[1];
    expect(row.contact_tags).toBe('a');
    expect(row.contact_updated).toBe('NOW');
    expect(row.custom).toEqual({ cf_txt: 'new', cf_tags: ['vip', 'slow'] });

    expect(r.updated_fields).toEqual(['contact_tags', 'cf_txt', 'cf_tags']);
    expect(r.changes).toEqual({
      contact_tags: { from: '', to: 'a' },
      cf_txt: { from: 'old', to: 'new' },
      cf_tags: { from: null, to: ['vip', 'slow'] },
    });
    expect(r).not.toHaveProperty('custom');
  });

  test('a cf_-only patch runs the UPDATE (not the bare existence check) and can clear', async () => {
    const db = world({ contacts: { 1: CONTACT_1() } });
    const r = await contactService.updateContact(db, 1, { cf_txt: null });
    expect(db.state.updates).toHaveLength(1);
    expect(db.state.updates[0].sql).toBe('UPDATE contacts SET `custom` = JSON_REMOVE(`custom`, ?), contact_updated = NOW() WHERE contact_id = ?');
    expect(db.state.contacts[1].custom).toEqual({});
    expect(r).toEqual({ contact_id: 1, updated_fields: ['cf_txt'], changes: { cf_txt: { from: 'old', to: null } } });
  });

  test('cf_ keys never meet ALLOWED; `custom` and non-ALLOWED core keys are still refused', async () => {
    const db = world({ contacts: { 1: CONTACT_1() } });
    await expect(contactService.updateContact(db, 1, { custom: {} })).rejects.toThrow(/custom is not writable/);
    await expect(contactService.updateContact(db, 1, { contact_id: 9 })).rejects.toThrow(/blocked columns: contact_id/);
    await expect(contactService.updateContact(db, 1, { cf_sel: 'A' })).rejects.toThrow(/unknown custom field\(s\) on contact: cf_sel/);
    expect(db.state.updates).toHaveLength(0);
  });

  test('contact.updated envelope (full-row re-fetch) carries no `custom`', async () => {
    const db = world({ contacts: { 1: CONTACT_1() } });
    await contactService.updateContact(db, 1, { cf_txt: 'z' }, { userId: 3 });
    await settle(); await settle();
    expect(db.state.log).toContain('SELECT * FROM contacts WHERE contact_id = ?');
    expect(db.state.events).toHaveLength(1);
    const env = db.state.events[0].envelope;
    expect(env.event).toBe('contact.updated');
    expect(env.data).not.toHaveProperty('custom');
    expect(env.data.contact_fname).toBe('Ada');
    expect(env.changes).toEqual({ cf_txt: { from: 'old', to: 'z' } });
    expect(env.extra.updated_fields).toEqual(['cf_txt']);
  });

  test('update_contact fn: cf_ keys pass through to the service gate', async () => {
    const db = world({ contacts: { 1: CONTACT_1() } });
    const out = await contactFns.update_contact({ contact_id: 1, fields: { cf_tags: ['vip'] } }, db);
    expect(out.output.updated_fields).toEqual(['cf_tags']);
    expect(db.state.contacts[1].custom.cf_tags).toEqual(['vip']);
  });
});

// ─────────────────────────────────────────────────────────────
// 8. update_case fn
// ─────────────────────────────────────────────────────────────

describe('update_case fn — core whitelist + registry-gated cf_ keys', () => {
  test('cf_ keys reach the service; pipeline_phase + case_341_link are now whitelisted', async () => {
    const db = world({ cases: { A: CASE_A() } });
    const out = await caseFns.update_case({
      case_id: 'A', fields: { cf_sel: 'a', pipeline_phase: 'case', case_341_link: 'https://zoom.example/j/1' },
    }, db);
    expect(out.output.updated_fields).toEqual(['pipeline_phase', 'case_341_link', 'cf_sel']);
    expect(db.state.cases.A.pipeline_phase).toBe('case');
    expect(db.state.cases.A.custom.cf_sel).toBe('A');
  });

  test('`custom` and non-whitelisted core columns stay blocked at the fn', async () => {
    const db = world({ cases: { A: CASE_A() } });
    await expect(caseFns.update_case({ case_id: 'A', fields: { custom: {} } }, db)).rejects.toThrow(/blocked columns: custom/);
    await expect(caseFns.update_case({ case_id: 'A', fields: { case_judge_contact_id: 5 } }, db)).rejects.toThrow(/blocked columns/);
    await expect(caseFns.update_case({ case_id: 'A', fields: { cf_nope: 1 } }, db)).rejects.toThrow(/unknown custom field/);
    expect(db.state.updates).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 6. Post-data locks + option retire
// ─────────────────────────────────────────────────────────────

describe('updateDef — §3 post-data locks', () => {
  const idOf = (db, entity, key) => byKey(db.state.defs, entity, key).id;

  test('field_type is free before data, locked (409) once any record holds the key', async () => {
    const free = world({ cases: { A: CASE_A() } });           // A holds cf_note + cf_ms, not cf_dt
    await fieldDefs.updateDef(free, idOf(free, 'case', 'cf_dt'), { field_type: 'text' });
    expect(byKey(free.state.defs, 'case', 'cf_dt').field_type).toBe('text');

    const e = await rejects(fieldDefs.updateDef(free, idOf(free, 'case', 'cf_note'), { field_type: 'number' }));
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/field_type is locked: records already hold a value for cf_note/);
    expect(free.state.defUpdates).toHaveLength(1);            // only the cf_dt change landed
    expect(free.state.log.some(s => /JSON_CONTAINS_PATH\(custom, 'one', \?\)/.test(s))).toBe(true);
  });

  test('the same field_type (the editor always sends it) never probes', async () => {
    const db = world({ cases: { A: CASE_A() } });
    await fieldDefs.updateDef(db, idOf(db, 'case', 'cf_note'), { field_type: 'text', label: 'Note' });
    expect(db.state.log.some(s => /JSON_CONTAINS/.test(s))).toBe(false);
  });

  test('removing (or renaming) a USED option value is a 409 with the retire hint; unused may go', async () => {
    const db = world({ cases: { A: { ...CASE_A(), custom: { cf_sel: 'A', cf_ms: ['x', 'y'] } } } });
    const sel = idOf(db, 'case', 'cf_sel');
    const ms  = idOf(db, 'case', 'cf_ms');

    let e = await rejects(fieldDefs.updateDef(db, sel, { options: [{ value: 'B', label: 'Bee' }] }));
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/option value "A" is held by existing records/);
    expect(e.message).toMatch(/retire it instead \("active": false/);

    e = await rejects(fieldDefs.updateDef(db, sel, { options: [{ value: 'a', label: 'A' }, { value: 'B', label: 'Bee' }] }));
    expect(e.message).toMatch(/"A"/);                            // a case-only rename is a value change

    e = await rejects(fieldDefs.updateDef(db, ms, { options: [{ value: 'x', label: 'x' }] }));
    expect(e.message).toMatch(/option values "y", "z"|option value "y"/);
    expect(e.message).not.toMatch(/"z"/);                      // z is unused → deletable

    await fieldDefs.updateDef(db, ms, { options: [{ value: 'x', label: 'x' }, { value: 'y', label: 'y' }] });
    expect(byKey(db.state.defs, 'case', 'cf_ms').options.map(o => o.value)).toEqual(['x', 'y']);
    await fieldDefs.updateDef(db, sel, { options: [{ value: 'A', label: 'Aye' }, { value: 'B', label: 'Bee' }] });
  });

  test('option `active`: omitted inherits the stored state, new values default true, explicit wins', async () => {
    const db = world();
    const sel = idOf(db, 'case', 'cf_sel');
    // the settings editor round-trips {value,label} only — B must stay retired
    await fieldDefs.updateDef(db, sel, { options: [{ value: 'A', label: 'A' }, { value: 'B', label: 'Bee!' }, { value: 'C', label: 'C' }] });
    expect(byKey(db.state.defs, 'case', 'cf_sel').options).toEqual([
      { value: 'A', label: 'A', active: true },
      { value: 'B', label: 'Bee!', active: false },
      { value: 'C', label: 'C', active: true },
    ]);
    await fieldDefs.updateDef(db, sel, { options: [{ value: 'A', label: 'A', active: false }, { value: 'B', label: 'B', active: true }] });
    expect(byKey(db.state.defs, 'case', 'cf_sel').options.map(o => o.active)).toEqual([false, true]);
    await expect(fieldDefs.updateDef(db, sel, { options: [{ value: 'A', label: 'A', active: 'no' }] }))
      .rejects.toThrow(/options\[0\]\.active must be true or false/);
  });

  test('createDef stores active:true on every option', async () => {
    const db = world({ defs: [] });
    const q = db.query;
    db.query = async (sql, params) => {
      const s = norm(sql);
      if (/^SELECT id FROM field_defs WHERE entity = \? AND field_key = \?/.test(s)) return [[]];
      if (/COLUMN_NAME = \?$/.test(s)) return [[]];
      if (/^INSERT INTO field_defs/.test(s)) { db.inserted = params; return [{ insertId: 1 }]; }
      return q(sql, params);
    };
    await fieldDefs.createDef(db, { entity: 'case', field_key: 'cf_new', label: 'New', field_type: 'select', options: [{ value: 'v', label: 'V' }] });
    expect(JSON.parse(db.inserted[4])).toEqual([{ value: 'v', label: 'V', active: true }]);
  });
});

// ─────────────────────────────────────────────────────────────
// 7. Containment — the bag never travels whole
// ─────────────────────────────────────────────────────────────

describe('bag containment', () => {
  test('buildEnvelope strips `custom` from data for case- and contact-shaped rows', () => {
    for (const data of [CASE_A(), CONTACT_1()]) {
      const env = domainEvents.buildEnvelope('x.updated', { data, changes: { custom: { from: {}, to: {} } }, extra: { custom: 1 } });
      expect(env.data).not.toHaveProperty('custom');
      expect(env.changes).not.toHaveProperty('custom');
      expect(env.extra).not.toHaveProperty('custom');
    }
  });

  test('resolver: {{cases.custom}} / {{contacts.custom}} are refused, as placeholder and as ref column', async () => {
    expect(resolverService.BLOCKED_COLUMNS.cases).toContain('custom');
    expect(resolverService.BLOCKED_COLUMNS.contacts).toContain('custom');
    for (const t of ['cases', 'contacts']) {
      const r = await resolverService.resolve({ db: null, text: `x {{${t}.custom}} y`, refs: {} });
      expect(r.status).toBe('failed');
      expect(r.errors.join(' ')).toMatch(new RegExp(`Column '${t}\\.custom' is not accessible`));
    }
    const r2 = await resolverService.resolve({
      db: { query: async () => { throw new Error('must not query'); } },
      text: '{{contacts.contact_fname}}', refs: { contacts: { custom: '{}' } },
    });
    expect(r2.status).toBe('failed');
    expect(r2.errors.join(' ')).toMatch(/Ref column 'contacts\.custom' is not accessible/);
  });

  test('report validator: `custom` is denied as an identifier — bare, backticked, qualified, inside JSON functions', () => {
    expect(manifest.DENIED_COLUMNS).toContain('custom');
    for (const sql of [
      'SELECT custom FROM cases',
      'SELECT `custom` FROM contacts',
      'SELECT c.case_id FROM cases c WHERE JSON_EXTRACT(c.custom, \'$.cf_x\') = 1',
      'SELECT JSON_UNQUOTE(JSON_EXTRACT(`custom`, "$.cf_x")) AS v FROM contacts',
      'SELECT case_id FROM cases WHERE c.custom->>\'$.cf_x\' = \'1\'',
    ]) {
      const r = validateSql(sql);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('Column "custom" may not appear in a report');
    }
    // a string literal mentioning it is still fine (the scanner blanks literals)
    expect(validateSql("SELECT case_id FROM cases WHERE case_notes LIKE '%custom%'").ok).toBe(true);
  });

  test('manifest notes on cases + contacts say why', () => {
    expect(manifest.TABLES.cases.note).toMatch(/`custom`.*denylist/);
    expect(manifest.TABLES.contacts.note).toMatch(/`custom`.*denylist/);
  });

  test('query_db strips `custom` from rows, `*` included', async () => {
    const rows = [{ case_id: 'A', case_stage: 'Open', custom: { cf_x: 'secretish' } }];
    const db = { query: async () => [rows.map(r => ({ ...r }))] };
    const out = await dbFns.query_db({ select: ['*'], from: 'cases' }, db);
    expect(out.output).toEqual([{ case_id: 'A', case_stage: 'Open' }]);
    const out2 = await dbFns.query_db({ select: ['contacts.custom', 'contacts.contact_id'], from: 'contacts' },
      { query: async () => [[{ contact_id: 1, custom: {} }]] });
    expect(out2.output).toEqual([{ contact_id: 1 }]);
  });
});

// ─────────────────────────────────────────────────────────────
// 9. GREP — nothing reads a key back out of `custom` in SQL (§3)
// ─────────────────────────────────────────────────────────────

describe('design doc §3: no JSON-path reads of `custom` in shipped code', () => {
  // `custom->` / `custom->>` (backticked or qualified) and the function forms
  // of the same read. JSON_SET / JSON_REMOVE (the chokepoint) and
  // JSON_CONTAINS / JSON_CONTAINS_PATH (the post-data existence probes) are
  // the sanctioned JSON SQL and are deliberately NOT matched.
  const PATTERNS = [
    /\bcustom`?\s*->/i,
    /\bJSON_(EXTRACT|VALUE|SEARCH|KEYS|TABLE|OVERLAPS)\s*\(\s*[`\w.]*\bcustom\b/i,
  ];

  function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
      else if (/\.(js|cjs|mjs)$/.test(e.name)) out.push(p);
    }
    return out;
  }

  test('the patterns catch the forms they exist for (sanity)', () => {
    for (const s of ["WHERE c.custom->>'$.cf_x' = ?", 'ORDER BY `custom`->"$.cf_n"', "JSON_EXTRACT(custom, '$.cf_x')",
      'JSON_VALUE(`cases`.`custom`, "$.cf_x")']) {
      expect(PATTERNS.some(re => re.test(s))).toBe(true);
    }
    for (const s of ['`custom` = JSON_REMOVE(JSON_SET(`custom`, ?, CAST(? AS JSON)), ?)',
      "JSON_CONTAINS_PATH(custom, 'one', ?)", 'JSON_CONTAINS(custom, CAST(? AS JSON), ?)', 'customer->name']) {
      expect(PATTERNS.some(re => re.test(s))).toBe(false);
    }
  });

  test('lib/ services/ routes/ have zero hits', () => {
    const hits = [];
    for (const dir of ['lib', 'services', 'routes']) {
      for (const f of walk(path.join(ROOT, dir))) {
        fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
          if (PATTERNS.some(re => re.test(line))) hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
