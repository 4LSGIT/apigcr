// tests/fieldDefs.s1.test.js
//
/**
 * Custom-fields arc S1 — services/fieldDefService.js, routes/api.fieldDefs.js,
 * and the settings.html "Custom Fields" editor contract.
 *
 * Proof obligations:
 *
 *   1. KEY REGEX: the design-doc §3 pattern ^cf_[a-z][a-z0-9_]{1,60}$, as an
 *      accept/reject table AND through validateDef (the real gate). It already
 *      excludes every real (non-generated) column of cases + contacts — read
 *      from ref/database.sql, not a hand-kept list.
 *   2. COLLISION: assertNoColumnCollision rejects a real column, called
 *      directly (the regex makes it unreachable through validateDef today —
 *      it guards S3's ADD COLUMN against a loosened regex, so it is tested
 *      via its export). validateDef runs it on CREATE, and never on update
 *      (after S3 the key IS a column; re-checking would block every edit).
 *   3. OPTIONS / VALIDATION / SHOW_WHEN shape enforcement.
 *   4. IMMUTABILITY: PATCH cannot change field_key or entity — rejected
 *      before any UPDATE is issued.
 *   5. CACHE: listActive does not re-query until bump() (or a mutation, or
 *      the TTL); a bump during an in-flight load is not overwritten by it.
 *   6. ROUTES: inventory; the same auth middleware stack as the contact-role-
 *      type routes; 400/404/409 mapping; 500 never leaks DB text.
 *   7. settings.html: inline scripts parse; the UI's key regex / type list /
 *      validation map are pinned equal to the service's.
 *
 * No real MySQL in this repo's test run: the db is the house dispatch-on-SQL-
 * text stub (an in-memory registry world), never scripted result arrays. The
 * module under test is the real one; only lib/auth.jwtOrApiKey is mocked.
 */

'use strict';

jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = { userId: 6 }; next(); }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const express = require('express');

const svc = require('../services/fieldDefService');

const ROOT = path.join(__dirname, '..');

// ─────────────────────────────────────────────────────────────
// In-memory registry world — dispatch on SQL text
// ─────────────────────────────────────────────────────────────

const COLUMNS = {
  cases:    ['case_id', 'case_number', 'case_type', 'clio_matter'],
  contacts: ['contact_id', 'contact_email', 'contact_name', 'contact_clio_id'],
};

function row(o) {
  return {
    options: null, validation: null, show_when: null, indexed: 0, sort_order: 0, active: 1,
    created_at: '2026-09-24 10:00:00', updated_at: '2026-09-24 10:00:00', ...o,
  };
}

function worldDb({ rows = [], columns = COLUMNS, raceDup = false } = {}) {
  const state = { rows: rows.map(r => ({ ...r })), nextId: 100, log: [], tx: [] };
  const query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    state.log.push({ s, params });
    if (/FROM field_defs WHERE entity = \? ORDER BY sort_order ASC, id ASC/.test(s)) {
      return [state.rows.filter(r => r.entity === params[0])
        .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id))
        .map(r => ({ ...r }))];
    }
    if (/FROM field_defs WHERE id = \? LIMIT 1/.test(s)) {
      const r = state.rows.find(x => x.id === params[0]);
      return [r ? [{ ...r }] : []];
    }
    if (/^SELECT id FROM field_defs WHERE entity = \? AND field_key = \?/.test(s)) {
      if (raceDup) return [[]];                               // pre-check loses the race
      const r = state.rows.find(x => x.entity === params[0] && x.field_key === params[1]);
      return [r ? [{ id: r.id }] : []];
    }
    if (/FROM information_schema\.COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = \? AND COLUMN_NAME = \?/.test(s)) {
      const hit = (columns[params[0]] || []).find(c => c.toLowerCase() === String(params[1]).toLowerCase());
      return [hit ? [{ COLUMN_NAME: hit }] : []];
    }
    if (/^INSERT INTO field_defs/.test(s)) {
      const [entity, field_key, label, field_type, options, validation, show_when, sort_order, active] = params;
      if (raceDup || state.rows.some(r => r.entity === entity && r.field_key === field_key)) {
        const e = new Error(`Duplicate entry '${entity}-${field_key}' for key 'field_defs.uq_field_defs_entity_key'`);
        e.code = 'ER_DUP_ENTRY'; throw e;
      }
      const id = state.nextId++;
      state.rows.push(row({ id, entity, field_key, label, field_type, options, validation, show_when, sort_order, active }));
      return [{ insertId: id, affectedRows: 1 }];
    }
    if (/^UPDATE field_defs SET active = \? WHERE id = \?$/.test(s)) {
      const r = state.rows.find(x => x.id === params[1]);
      if (r) r.active = params[0];
      return [{ affectedRows: r ? 1 : 0 }];
    }
    if (/^UPDATE field_defs SET .* WHERE id = \?$/.test(s)) {
      const cols = s.match(/SET (.*) WHERE/)[1].split(', ').map(x => x.replace(' = ?', ''));
      const r = state.rows.find(x => x.id === params[params.length - 1]);
      cols.forEach((c, i) => { if (r) r[c] = params[i]; });
      return [{ affectedRows: r ? 1 : 0 }];
    }
    throw new Error('worldDb: unscripted query — ' + s);
  };
  return {
    state,
    query,
    getConnection: async () => ({
      query,
      beginTransaction: async () => state.tx.push('begin'),
      commit: async () => state.tx.push('commit'),
      rollback: async () => state.tx.push('rollback'),
      release: () => state.tx.push('release'),
      destroy: () => state.tx.push('destroy'),
    }),
  };
}

const updates = db => db.state.log.filter(q => /^UPDATE field_defs/.test(q.s));
const registryReads = db => db.state.log.filter(q => /ORDER BY sort_order ASC, id ASC/.test(q.s));
const schemaReads = db => db.state.log.filter(q => /information_schema/.test(q.s));

const SELECT_DEF = row({
  id: 7, entity: 'case', field_key: 'cf_status', label: 'Status', field_type: 'select',
  options: JSON.stringify([{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }]),
});

async function rejects(p, status, re) {
  let err;
  try { await p; } catch (e) { err = e; }
  expect(err).toBeDefined();
  expect(err.status).toBe(status);
  if (re) expect(err.message).toMatch(re);
  return err;
}

beforeEach(() => { svc.bump(); jest.restoreAllMocks(); });

// ─────────────────────────────────────────────────────────────
// 1. Key regex
// ─────────────────────────────────────────────────────────────

describe('field_key regex (design doc §3)', () => {
  const max64 = 'cf_a' + 'b'.repeat(60);
  const over65 = 'cf_a' + 'b'.repeat(61);

  test('boundary lengths are what the pattern says', () => {
    expect(max64).toHaveLength(64);   // MySQL's identifier limit — S3's column name
    expect(over65).toHaveLength(65);
  });

  test.each([
    ['cf_xy'], ['cf_clio_matter'], ['cf_a1'], ['cf_a_'], ['cf_x__y'], [max64],
  ])('accepts %s', (k) => {
    expect(svc.KEY_RE.test(k)).toBe(true);
  });

  // NB 'cf_x': the ratified regex needs cf_ + a letter + at least ONE more
  // char — the 5-char minimum is the doc's, the S1 prompt's "cf_x ok" is not.
  test.each([
    ['cf_x'], ['cf_X'], ['cf_Xy'], ['CF_ab'], ['cf-1'], ['cf-ab'], ['cf_1x'], ['cf__x'],
    ['cf_'], [''], ['case_id'], ['custom'], ['contact_email'], ['cfab'], [' cf_ab'], ['cf_ab '],
    ['cf_a-b'], ['cf_a.b'], [over65],
  ])('rejects %j', (k) => {
    expect(svc.KEY_RE.test(k)).toBe(false);
  });

  test('validateDef enforces it (the real gate, not just the exported constant)', async () => {
    const db = worldDb();
    for (const k of ['cf_X', 'cf-1', 'case_id', 'custom', over65, 'cf_x']) {
      await rejects(svc.validateDef(db, { entity: 'case', field_key: k, label: 'L', field_type: 'text' }),
        400, /field_key must match/);
    }
    const ok = await svc.validateDef(db, { entity: 'case', field_key: max64, label: 'L', field_type: 'text' });
    expect(ok.field_key).toBe(max64);
    expect(db.state.tx).toEqual([]); // no transaction on the validate path
  });

  test('the regex alone excludes every real column of cases + contacts (ref/database.sql)', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'ref/database.sql'), 'utf8');
    for (const table of ['cases', 'contacts']) {
      const block = sql.match(new RegExp('CREATE TABLE `' + table + '` \\(([\\s\\S]*?)\\n\\) ENGINE'))[1];
      // Generated columns are excluded ON PURPOSE: from S3 the reconciler's
      // VIRTUAL cf_ columns land here and are supposed to match.
      const cols = block.split('\n')
        .filter(l => /^ {2}`/.test(l) && !/GENERATED ALWAYS/.test(l))
        .map(l => l.match(/^ {2}`([^`]+)`/)[1]);
      expect(cols.length).toBeGreaterThan(30);
      expect(cols.filter(c => svc.KEY_RE.test(c))).toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 2. Column collision
// ─────────────────────────────────────────────────────────────

describe('column-collision check', () => {
  test('rejects a real column, called directly (regex-independent)', async () => {
    const db = worldDb();
    await rejects(svc.assertNoColumnCollision(db, 'contact', 'contact_email'),
      400, /collides with the existing column contacts\.contact_email/);
    // case-insensitive, like MySQL identifiers
    await rejects(svc.assertNoColumnCollision(db, 'contact', 'CONTACT_EMAIL'), 400, /collides/);
    // entity → table mapping: the same name on the OTHER entity is free
    await expect(svc.assertNoColumnCollision(db, 'case', 'contact_email')).resolves.toBeUndefined();
    expect(schemaReads(db).map(q => q.params)).toEqual([
      ['contacts', 'contact_email'], ['contacts', 'CONTACT_EMAIL'], ['cases', 'contact_email'],
    ]);
  });

  test('validateDef runs it on CREATE — a hypothetical real cf_ column blocks the def', async () => {
    const db = worldDb({ columns: { ...COLUMNS, cases: [...COLUMNS.cases, 'cf_legacy'] } });
    await rejects(svc.validateDef(db, { entity: 'case', field_key: 'cf_legacy', label: 'Legacy', field_type: 'text' }),
      400, /collides with the existing column cases\.cf_legacy/);
    await rejects(svc.createDef(db, { entity: 'case', field_key: 'cf_legacy', label: 'Legacy', field_type: 'text' }),
      400, /collides/);
    expect(db.state.log.some(q => /^INSERT/.test(q.s))).toBe(false);
  });

  test('validateDef never runs it on update — after S3 the key IS a column', async () => {
    const db = worldDb({
      rows: [SELECT_DEF],
      columns: { ...COLUMNS, cases: [...COLUMNS.cases, 'cf_status'] }, // the S3 virtual column
    });
    await svc.updateDef(db, 7, { label: 'Case status' });
    expect(schemaReads(db)).toHaveLength(0);
    expect(db.state.rows[0].label).toBe('Case status');
  });

  test('unknown entity → 400 before any query', async () => {
    const db = worldDb();
    await rejects(svc.assertNoColumnCollision(db, 'matter', 'cf_ab'), 400, /entity must be one of case, contact/);
    expect(db.state.log).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. Shape enforcement
// ─────────────────────────────────────────────────────────────

describe('validateDef shape', () => {
  const base = (o = {}) => ({ entity: 'case', field_key: 'cf_ab', label: 'AB', field_type: 'text', ...o });
  const v = (o) => svc.validateDef(worldDb(), base(o));

  test('valid text def → normalized', async () => {
    await expect(v({ label: '  Clio matter ', sort_order: '5' })).resolves.toEqual({
      entity: 'case', field_key: 'cf_ab', label: 'Clio matter', field_type: 'text', options: null,
      validation: null, show_when: null, sort_order: 5, active: 1,
    });
  });

  test.each([
    ['select without options',        { field_type: 'select' },                                   /options is required for select/],
    ['multiselect with []',           { field_type: 'multiselect', options: [] },                 /options is required for multiselect/],
    ['options on a text field',       { options: [{ value: 'a', label: 'A' }] },                  /options is only allowed for select/],
    ['options [] on a text field',    { options: [] },                                            /options is only allowed for select/],
    ['duplicate values',              { field_type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] }, /"a" is duplicated/],
    ['case-insensitive duplicates',   { field_type: 'select', options: [{ value: 'Yes', label: 'Y' }, { value: 'yes', label: 'y' }] }, /"yes" is duplicated/],
    ['numeric value',                 { field_type: 'select', options: [{ value: 7, label: 'Seven' }] }, /value must be a non-empty string/],
    ['empty value',                   { field_type: 'select', options: [{ value: '', label: 'Blank' }] }, /value must be a non-empty string/],
    ['edge-whitespace value',         { field_type: 'select', options: [{ value: 'a ', label: 'A' }] }, /must not start or end with whitespace/],
    ['missing label',                 { field_type: 'select', options: [{ value: 'a' }] },        /options\[0\]\.label is required/],
    ['bare string option',            { field_type: 'select', options: ['a'] },                   /must be an object \{value, label\}/],
    ['unknown option property',       { field_type: 'select', options: [{ value: 'a', label: 'A', color: 'red' }] }, /unknown property "color"/],
    ['options as bad JSON text',      { field_type: 'select', options: '[{' },                   /options must be valid JSON/],
    ['bad entity',                    { entity: 'matter' },                                       /entity must be one of/],
    ['empty label',                   { label: '   ' },                                           /label is required/],
    ['101-char label',                { label: 'x'.repeat(101) },                                 /label must be 100 characters/],
    ['unknown field_type',            { field_type: 'currency' },                                 /field_type must be one of/],
    ['sort_order out of smallint',    { sort_order: 40000 },                                      /sort_order must be an integer/],
    ['fractional sort_order',         { sort_order: 1.5 },                                        /sort_order must be an integer/],
    ['validation as an array',        { validation: [] },                                         /validation must be an object/],
    ['unknown validation key',        { validation: { requried: true } },                         /unknown property "requried"/],
    ['max_len on a number',           { field_type: 'number', validation: { max_len: 5 } },       /max_len is only allowed for text/],
    ['min on a text field',           { validation: { min: 1 } },                                 /min is only allowed for number/],
    ['bad regex pattern',             { validation: { pattern: '(' } },                           /not a valid regular expression/],
    ['min > max',                     { field_type: 'number', validation: { min: 5, max: 1 } },   /min must not be greater than/],
    ['required not boolean',          { validation: { required: 'yes' } },                        /required must be true or false/],
    ['show_when as an array',         { show_when: [1] },                                         /show_when must be an object/],
    ['show_when as a string',         { show_when: '"x"' },                                       /show_when must be an object/],
  ])('rejects %s', async (_name, o, re) => {
    await rejects(v(o), 400, re);
  });

  test('every problem is reported at once, joined with "; "', async () => {
    const err = await rejects(v({ entity: 'x', field_key: 'bad', label: '' }), 400);
    expect(err.message.split('; ')).toHaveLength(3);
  });

  test('valid select: options normalized (labels trimmed), values untouched', async () => {
    const out = await v({ field_type: 'select', options: [{ value: 'open', label: ' Open ' }, { value: 'Closed-2', label: 'Closed' }] });
    expect(out.options).toEqual([{ value: 'open', label: 'Open' }, { value: 'Closed-2', label: 'Closed' }]);
  });

  test('options / validation / show_when accept JSON text; {} validation → null; show_when stored verbatim', async () => {
    const sw = { field: 'cf_other', equals: 'x', nested: { any: [1, 2] } };
    const out = await v({ field_type: 'multiselect', options: '[{"value":"a","label":"A"}]',
      validation: {}, show_when: JSON.stringify(sw) });
    expect(out.options).toEqual([{ value: 'a', label: 'A' }]);
    expect(out.validation).toBeNull();
    expect(out.show_when).toEqual(sw);
  });

  test('indexed is not writable through create', async () => {
    const db = worldDb();
    await rejects(svc.createDef(db, base({ indexed: 1 })), 400, /indexed is managed by the reconciler/);
    await expect(svc.createDef(db, base({ indexed: 0 }))).resolves.toMatchObject({ field_key: 'cf_ab' });
  });
});

// ─────────────────────────────────────────────────────────────
// 4. Create / duplicate / update / immutability / setActive
// ─────────────────────────────────────────────────────────────

describe('mutations', () => {
  test('createDef inserts JSON columns as JSON text and returns the id', async () => {
    const db = worldDb();
    const r = await svc.createDef(db, { entity: 'contact', field_key: 'cf_clio_id', label: 'Clio ID',
      field_type: 'select', options: [{ value: 'a', label: 'A' }], validation: { required: true } });
    expect(r).toEqual({ id: 100, entity: 'contact', field_key: 'cf_clio_id' });
    const ins = db.state.log.find(q => /^INSERT/.test(q.s));
    expect(ins.params).toEqual(['contact', 'cf_clio_id', 'Clio ID', 'select',
      '[{"value":"a","label":"A"}]', '{"required":true}', null, 0, 1]);
  });

  test('duplicate key → clean 409, never raw ER_DUP_ENTRY (pre-check AND the race)', async () => {
    const pre = await rejects(svc.createDef(worldDb({ rows: [SELECT_DEF] }),
      { entity: 'case', field_key: 'cf_status', label: 'S', field_type: 'text' }), 409,
      /^field "cf_status" already exists on case$/);
    expect(pre.code).toBeUndefined();
    const race = await rejects(svc.createDef(worldDb({ raceDup: true }),
      { entity: 'case', field_key: 'cf_status', label: 'S', field_type: 'text' }), 409,
      /^field "cf_status" already exists on case$/);
    expect(race.code).toBeUndefined();
  });

  test('same key on the other entity is allowed (UNIQUE is (entity, field_key))', async () => {
    const db = worldDb({ rows: [SELECT_DEF] });
    await expect(svc.createDef(db, { entity: 'contact', field_key: 'cf_status', label: 'S', field_type: 'text' }))
      .resolves.toMatchObject({ entity: 'contact' });
  });

  test.each([
    ['field_key', { field_key: 'cf_other' }],
    ['field_key', { field_key: 'cf_status_2', label: 'Also a label change' }],
    ['entity',    { entity: 'contact' }],
  ])('PATCH changing %s → 400 and NO UPDATE issued', async (k, patch) => {
    const db = worldDb({ rows: [SELECT_DEF] });
    await rejects(svc.updateDef(db, 7, patch), 400, new RegExp(`^${k} is immutable`));
    expect(updates(db)).toHaveLength(0);
    expect(db.state.rows[0]).toMatchObject({ entity: 'case', field_key: 'cf_status', label: 'Status' });
    expect(db.state.tx).toContain('rollback');
  });

  test('PATCH echoing the SAME key/entity is a no-op on them (the roles PUT idiom)', async () => {
    const db = worldDb({ rows: [SELECT_DEF] });
    await svc.updateDef(db, 7, { entity: 'case', field_key: 'cf_status', label: 'Case status' });
    expect(updates(db)).toHaveLength(1);
    expect(updates(db)[0].s).toBe('UPDATE field_defs SET label = ? WHERE id = ?');
  });

  test('PATCH validates the MERGED row: select → text needs options: null in the same patch', async () => {
    const db = worldDb({ rows: [SELECT_DEF] });
    await rejects(svc.updateDef(db, 7, { field_type: 'text' }), 400, /options is only allowed/);
    expect(updates(db)).toHaveLength(0);
    await svc.updateDef(db, 7, { field_type: 'text', options: null });
    expect(db.state.rows[0]).toMatchObject({ field_type: 'text', options: null });
  });

  test('PATCH rejects active (own verbs), a changed indexed, empty bodies, unknown ids', async () => {
    const db = worldDb({ rows: [SELECT_DEF] });
    await rejects(svc.updateDef(db, 7, { active: 0 }), 400, /use \/deactivate or \/reactivate/);
    await rejects(svc.updateDef(db, 7, { indexed: 1 }), 400, /indexed is managed/);
    await rejects(svc.updateDef(db, 7, { id: 7, created_at: 'x' }), 400, /requires at least one of/);
    await rejects(svc.updateDef(db, 999, { label: 'x' }), 404, /field def 999 not found/);
    await rejects(svc.updateDef(db, 'abc', { label: 'x' }), 400, /id must be an integer/);
    expect(updates(db)).toHaveLength(0);
  });

  test('PATCH runs in a row-locked transaction', async () => {
    const db = worldDb({ rows: [SELECT_DEF] });
    await svc.updateDef(db, 7, { sort_order: 3 });
    expect(db.state.log.find(q => /WHERE id = \? LIMIT 1 FOR UPDATE/.test(q.s))).toBeTruthy();
    expect(db.state.tx).toEqual(['begin', 'commit', 'release']);
  });

  test('setActive: deactivate / reactivate are idempotent; unknown id → 404', async () => {
    const db = worldDb({ rows: [SELECT_DEF] });
    await expect(svc.setActive(db, 7, false)).resolves.toEqual({ id: 7, active: 0 });
    await expect(svc.setActive(db, 7, false)).resolves.toEqual({ id: 7, active: 0 });
    expect(db.state.rows[0].active).toBe(0);
    await expect(svc.setActive(db, 7, true)).resolves.toEqual({ id: 7, active: 1 });
    await rejects(svc.setActive(db, 999, false), 404);
  });
});

// ─────────────────────────────────────────────────────────────
// 5. Cache
// ─────────────────────────────────────────────────────────────

describe('cache', () => {
  const RETIRED = row({ id: 8, entity: 'case', field_key: 'cf_old', label: 'Old', field_type: 'text', active: 0, sort_order: 1 });
  const CONTACT = row({ id: 9, entity: 'contact', field_key: 'cf_c', label: 'C', field_type: 'boolean' });

  test('listActive does not re-query until bump()', async () => {
    const db = worldDb({ rows: [SELECT_DEF, RETIRED] });
    const a = await svc.listActive(db, 'case');
    const b = await svc.listActive(db, 'case');
    await svc.getByKey(db, 'case', 'cf_status');
    expect(registryReads(db)).toHaveLength(1);
    expect(b).toEqual(a);
    expect(a.map(r => r.field_key)).toEqual(['cf_status']);        // inactive filtered out
    expect(a[0].options).toEqual([{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }]);

    db.state.rows[0].label = 'Changed underneath';
    expect((await svc.listActive(db, 'case'))[0].label).toBe('Status'); // still cached
    svc.bump();
    expect((await svc.listActive(db, 'case'))[0].label).toBe('Changed underneath');
    expect(registryReads(db)).toHaveLength(2);
  });

  test('entities cache independently', async () => {
    const db = worldDb({ rows: [SELECT_DEF, CONTACT] });
    await svc.listActive(db, 'case');
    await svc.listActive(db, 'contact');
    await svc.listActive(db, 'case');
    await svc.listActive(db, 'contact');
    expect(registryReads(db).map(q => q.params[0])).toEqual(['case', 'contact']);
  });

  test.each([
    ['createDef', db => svc.createDef(db, { entity: 'case', field_key: 'cf_new', label: 'N', field_type: 'text' })],
    ['updateDef', db => svc.updateDef(db, 7, { label: 'Renamed' })],
    ['setActive', db => svc.setActive(db, 7, false)],
  ])('%s invalidates the cache itself (no caller can forget)', async (_n, mutate) => {
    const db = worldDb({ rows: [SELECT_DEF] });
    await svc.listActive(db, 'case');
    await mutate(db);
    await svc.listActive(db, 'case');
    expect(registryReads(db)).toHaveLength(2);
  });

  test('a failed mutation does not bump', async () => {
    const db = worldDb({ rows: [SELECT_DEF] });
    await svc.listActive(db, 'case');
    await rejects(svc.updateDef(db, 7, { field_key: 'cf_other' }), 400);
    await svc.listActive(db, 'case');
    expect(registryReads(db)).toHaveLength(1);
  });

  test('TTL: other instances converge — a cached entry expires after TTL_MS', async () => {
    const db = worldDb({ rows: [SELECT_DEF] });
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    await svc.listActive(db, 'case');
    now += svc.TTL_MS - 1;
    await svc.listActive(db, 'case');
    expect(registryReads(db)).toHaveLength(1);
    now += 1;
    await svc.listActive(db, 'case');
    expect(registryReads(db)).toHaveLength(2);
  });

  test('a bump() during an in-flight load: that load is served but NOT cached', async () => {
    const db = worldDb({ rows: [SELECT_DEF] });
    const realQuery = db.query;
    let release;
    const gate = new Promise(r => { release = r; });
    db.query = async (sql, params) => { const out = await realQuery(sql, params); await gate; return out; };
    const inflight = svc.listActive(db, 'case');   // reads 'Status', then waits
    await new Promise(r => setImmediate(r));
    db.state.rows[0].label = 'Renamed';
    svc.bump();                                      // a write landed meanwhile
    release();
    expect((await inflight)[0].label).toBe('Status');
    db.query = realQuery;
    expect((await svc.listActive(db, 'case'))[0].label).toBe('Renamed'); // re-queried, not the stale load
  });

  test('getByKey: active-only by default; includeInactive tells retired from unknown', async () => {
    const db = worldDb({ rows: [SELECT_DEF, RETIRED] });
    expect((await svc.getByKey(db, 'case', 'cf_status')).id).toBe(7);
    expect(await svc.getByKey(db, 'case', 'cf_old')).toBeNull();
    expect((await svc.getByKey(db, 'case', 'cf_old', { includeInactive: true })).active).toBe(0);
    expect(await svc.getByKey(db, 'case', 'cf_nope', { includeInactive: true })).toBeNull();
    expect(registryReads(db)).toHaveLength(1);
  });

  test('cached rows are frozen — a consumer cannot poison the cache', async () => {
    const db = worldDb({ rows: [SELECT_DEF] });
    const [def] = await svc.listActive(db, 'case');
    expect(() => { def.label = 'x'; }).toThrow(TypeError);
    expect(() => { def.options.push({ value: 'x', label: 'X' }); }).toThrow(TypeError);
    expect(() => { def.options[0].value = 'x'; }).toThrow(TypeError);
  });

  test('listAll (editor) always reads fresh and includes inactive', async () => {
    const db = worldDb({ rows: [SELECT_DEF, RETIRED] });
    await svc.listAll(db, 'case');
    const all = await svc.listAll(db, 'case');
    expect(all.map(r => r.field_key)).toEqual(['cf_status', 'cf_old']);
    expect(registryReads(db)).toHaveLength(2);
  });

  test('unknown entity → 400 on the read API', async () => {
    await rejects(svc.listActive(worldDb(), 'matter'), 400);
    await rejects(svc.listAll(worldDb(), undefined), 400);
  });
});

// ─────────────────────────────────────────────────────────────
// 6. Routes
// ─────────────────────────────────────────────────────────────

describe('routes/api.fieldDefs.js', () => {
  const router = require('../routes/api.fieldDefs');
  const rolesRouter = require('../routes/api.contactRoles');
  const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

  const routesOf = r => r.stack.filter(l => l.route).map(l => ({
    path: l.route.path,
    methods: Object.keys(l.route.methods),
    middleware: l.route.stack.slice(0, -1).map(h => h.handle),
  }));

  test('inventory — no DELETE route', () => {
    expect(routesOf(router).map(r => `${r.methods.join(',').toUpperCase()} ${r.path}`)).toEqual([
      'GET /api/field-defs',
      'POST /api/field-defs',
      'PATCH /api/field-defs/:id',
      'POST /api/field-defs/:id/deactivate',
      'POST /api/field-defs/:id/reactivate',
    ]);
  });

  test('gating is exactly the contact-role-type routes\' middleware stack', () => {
    const roleTypeStacks = routesOf(rolesRouter)
      .filter(r => r.path.startsWith('/api/contact-role-types'))
      .map(r => r.middleware);
    expect(roleTypeStacks).toHaveLength(3);
    const reference = roleTypeStacks[0];
    for (const s of roleTypeStacks) expect(s).toEqual(reference);
    expect(reference).toEqual([jwtOrApiKey]);
    for (const r of routesOf(router)) expect(r.middleware).toEqual(reference);
  });

  let server, base, db;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = db; next(); });
    app.use(router);
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(resolve => server.close(resolve)));
  beforeEach(() => { db = worldDb({ rows: [SELECT_DEF] }); jwtOrApiKey.mockClear(); });

  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  test('GET ?entity=case → every def; missing entity → 400', async () => {
    const ok = await call('GET', '/api/field-defs?entity=case');
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('success');
    expect(ok.body.defs.map(d => d.field_key)).toEqual(['cf_status']);
    expect(jwtOrApiKey).toHaveBeenCalledTimes(1);
    const bad = await call('GET', '/api/field-defs');
    expect(bad).toEqual({ status: 400, body: { status: 'error', message: 'entity must be one of case, contact' } });
  });

  test('POST → 201; duplicate → 409; invalid → 400 with every problem', async () => {
    const created = await call('POST', '/api/field-defs', { entity: 'case', field_key: 'cf_clio_matter', label: 'Clio matter', field_type: 'text' });
    expect(created).toEqual({ status: 201, body: { status: 'success', id: 100, entity: 'case', field_key: 'cf_clio_matter' } });
    const dup = await call('POST', '/api/field-defs', { entity: 'case', field_key: 'cf_clio_matter', label: 'Again', field_type: 'text' });
    expect(dup.status).toBe(409);
    const bad = await call('POST', '/api/field-defs', { entity: 'case', field_key: 'cf_X', label: '', field_type: 'select' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/field_key must match.*; label is required; options is required/);
  });

  test('PATCH immutable key → 400; ok → 200; unknown id → 404', async () => {
    expect((await call('PATCH', '/api/field-defs/7', { field_key: 'cf_renamed' })).status).toBe(400);
    expect(updates(db)).toHaveLength(0);
    expect(await call('PATCH', '/api/field-defs/7', { label: 'Case status' }))
      .toEqual({ status: 200, body: { status: 'success', id: 7, entity: 'case', field_key: 'cf_status' } });
    expect((await call('PATCH', '/api/field-defs/999', { label: 'x' })).status).toBe(404);
  });

  test('deactivate / reactivate', async () => {
    expect((await call('POST', '/api/field-defs/7/deactivate')).body).toEqual({ status: 'success', id: 7, active: 0 });
    expect(db.state.rows[0].active).toBe(0);
    expect((await call('POST', '/api/field-defs/7/reactivate')).body).toEqual({ status: 'success', id: 7, active: 1 });
    expect((await call('POST', '/api/field-defs/999/deactivate')).status).toBe(404);
  });

  test('a DB failure is a 500 with a generic message — no SQL text leaks', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    db.query = async () => { throw new Error("ER_NO_SUCH_TABLE: Table 'x.field_defs' doesn't exist"); };
    const r = await call('GET', '/api/field-defs?entity=case');
    expect(r).toEqual({ status: 500, body: { status: 'error', message: 'Field definition request failed' } });
    expect(spy).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// 7. settings.html editor contract
// ─────────────────────────────────────────────────────────────

describe('settings.html Custom Fields editor', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/settings.html'), 'utf8');

  test('inline scripts pass node --check', () => {
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    expect(blocks.length).toBeGreaterThan(0);
    blocks.forEach((block, i) => {
      const tmp = path.join(os.tmpdir(), `fielddefs-settings-${process.pid}-${i}.js`);
      fs.writeFileSync(tmp, block);
      try { execFileSync('node', ['--check', tmp], { stdio: 'pipe' }); }
      finally { fs.unlinkSync(tmp); }
    });
  });

  test('carries the section, the table routes, and the permanence warning', () => {
    expect(html).toMatch(/id="customFieldsSection"/);
    expect(html).toMatch(/api\('\/api\/field-defs', 'GET', \{ entity: cfEntity \}\)/);
    expect(html).toMatch(/\/api\/field-defs\/\$\{t\.id\}\/\$\{verb\}/);
    expect(html).toMatch(/The key is permanent/);
    expect(html).toMatch(/cfInit\(\);/);
  });

  test('UI mirrors are pinned to the service (regex, type list, validation map)', () => {
    const re = html.match(/const CF_KEY_RE = \/(.+)\/;/)[1];
    expect(re).toBe(svc.KEY_RE.source);
    const types = JSON.parse(html.match(/const CF_TYPES = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
    expect(types).toEqual([...svc.FIELD_TYPES]);
    const vmap = html.match(/const CF_VALIDATION_FOR = \{([^}]*)\};/)[1];
    const uiKeys = [...vmap.matchAll(/(\w+):/g)].map(m => m[1]);
    expect(uiKeys).toEqual(Object.keys(svc.VALIDATION_KEYS));
    for (const [k, applies] of Object.entries(svc.VALIDATION_KEYS)) {
      const ui = vmap.match(new RegExp(`${k}: ([^,]+(?:\\][^,]*)?)`))[1].trim();
      if (ui === 'CF_TYPES') expect([...applies]).toEqual([...svc.FIELD_TYPES]);
      else expect(JSON.parse(ui.replace(/'/g, '"'))).toEqual([...applies]);
    }
  });

  test('Save never sends show_when (a value set through the API survives edits)', () => {
    const save = html.match(/async function cfSave\(i\) \{([\s\S]*?)\n\}/)[1];
    expect(save).toMatch(/'PATCH'/);
    expect(save).not.toMatch(/show_when\s*:/);
  });
});
