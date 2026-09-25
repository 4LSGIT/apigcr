// tests/customFields.s6.test.js
//
/**
 * Custom-fields arc S6 — FIELD DEFAULTS (ref/CUSTOM_FIELDS_DESIGN.md §3
 * "Defaults", ruled 2026-09-25). S2 fenced the create paths off ("create-then-
 * patch"); S6 is that fence opening for exactly one purpose, so the proof
 * obligations are about WHEN a default applies as much as what it is:
 *
 *   1. DEF-SAVE VALIDATION. A default is validated against its own def, by the
 *      same validateValue a written value goes through — wrong type, unknown
 *      option, over the 255 cap, outside the field's own validation.min/max,
 *      not a real date. Plus the one rule that is NOT validateValue's: a
 *      select/multiselect default must name an ACTIVE option, because a
 *      default pickers hide is incoherent.
 *   2. STAMPED ONCE, AT CREATE. Composed into the create INSERT itself — one
 *      write, no follow-up UPDATE — with the virtual column agreeing with the
 *      bag, and a def that has no default leaving its key ABSENT.
 *   3. NEVER RETROACTIVE. A def gaining or changing a default must not touch a
 *      single existing row. This is the one staff will trip on and the one a
 *      future refactor is most likely to break.
 *   4. STAMPED REGARDLESS OF show_when. A default is data; show_when is display.
 *   5. THE FENCE STAYS SHUT. An explicit cf_ key at create is REFUSED, not
 *      silently replaced by the default (see the createContact block — before
 *      S6 it was silently dropped, which S6 would have turned into a wrong
 *      value rather than no value).
 *
 * HARNESS: the arc's dispatch-on-SQL-text world (S2–S5), extended to the
 * create INSERTs, with S3's virtual columns computed off the bag in JS.
 *
 * S6-B (same day, Fred's ruling): the case side had no create chokepoint, so
 * caseService.createCase was extracted and is now the only INSERT INTO cases.
 * Its callers keep their own linking, log row and emit, and spread the
 * returned custom_fields into case.created — closing the envelope asymmetry
 * with contact.created that the S6 census found.
 *
 * The same code was ALSO run against a real MySQL 8.4.11 clone of
 * cases/contacts/field_defs from ref/database.sql — carrying every real
 * trigger (contact_name_insert, after_contact_update, trg_cases_ct_compat_*),
 * the REAL fieldDefReconciler building the virtual columns, and the REAL
 * create paths (createContact, intakeService.intakeCase and caseService.
 * createCase): 66/66. That run is what proves the case-side behaviour, the
 * column agreement and the envelope shapes on a real engine; see design doc §8.
 *
 *   npx jest tests/customFields.s6.test.js
 */

'use strict';

jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));
jest.mock('../services/gContactsService', () => ({ pushContact: jest.fn(async () => {}) }));
jest.mock('../services/fieldDefReconciler', () => {
  const actual = jest.requireActual('../services/fieldDefReconciler');
  return { ...actual, scheduleReconcile: jest.fn(), reconcile: jest.fn() };
});

const fs   = require('fs');
const path = require('path');

const fieldDefs      = require('../services/fieldDefService');
const contactService = require('../services/contactService');

const REPO = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(REPO, p), 'utf8');

const norm  = sql => String(sql).replace(/\s+/g, ' ').trim();
const clone = o => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

// ─────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────

let nextDefId = 1;
function def(o) {
  return {
    id: nextDefId++, entity: 'contact', label: o.field_key, options: null, validation: null,
    show_when: null, default_value: null, indexed: 0, sort_order: nextDefId, active: 1,
    created_at: '2026-09-25 10:00:00', updated_at: '2026-09-25 10:00:00', ...o,
  };
}

/** One def per type, each carrying a default — plus one with none. */
const DEFS = () => {
  nextDefId = 1;
  return [
    def({ field_key: 'cf_txt',  field_type: 'text',        default_value: '0001234' }),
    def({ field_key: 'cf_num',  field_type: 'number',      default_value: 42.5 }),
    def({ field_key: 'cf_dt',   field_type: 'date',        default_value: '2026-09-25' }),
    def({ field_key: 'cf_bool', field_type: 'boolean',     default_value: true }),
    def({ field_key: 'cf_sel',  field_type: 'select',      default_value: 'b',
          options: [{ value: 'a', label: 'A', active: true }, { value: 'b', label: 'B', active: true }] }),
    def({ field_key: 'cf_ms',   field_type: 'multiselect', default_value: ['x', 'y'],
          options: [{ value: 'x', label: 'X', active: true }, { value: 'y', label: 'Y', active: true }] }),
    def({ field_key: 'cf_nodef', field_type: 'text' }),
    def({ entity: 'case', field_key: 'cf_ctxt',  field_type: 'text',    default_value: 'seed' }),
    def({ entity: 'case', field_key: 'cf_cbool', field_type: 'boolean', default_value: false }),
    // hidden by show_when, and stamped anyway — data, not display
    def({ entity: 'case', field_key: 'cf_chid',  field_type: 'text',    default_value: 'hid',
          show_when: { field: 'case_stage', op: 'eq', value: 'NeverThisStage' } }),
  ];
};

const COLUMNS = {
  cases:    ['case_id', 'case_stage', 'case_open_date', 'case_type', 'custom'],
  contacts: ['contact_id', 'contact_kind', 'contact_org_name', 'contact_fname', 'contact_mname',
             'contact_lname', 'contact_pname', 'contact_phone', 'contact_email', 'contact_type',
             'contact_address', 'contact_city', 'contact_state', 'contact_zip', 'contact_dob',
             'contact_marital_status', 'contact_phone2', 'contact_email2', 'contact_tags',
             'contact_notes', 'contact_token', 'contact_created', 'contact_name',
             'contact_updated', 'custom'],
};

// ── S3's generated columns in JS (the JSON_VALUE / JSON_EXTRACT semantics) ──
const project = {
  text:        v => (v == null ? null : String(v).slice(0, 255)),
  select:      v => (v == null ? null : String(v).slice(0, 255)),
  number:      v => (typeof v === 'number' ? v.toFixed(4) : null),      // DECIMAL(18,4), driver-coerced
  date:        v => (typeof v === 'string' ? v : null),
  boolean:     v => (v === true ? 1 : v === false ? 0 : null),          // TINYINT(1)
  multiselect: v => (Array.isArray(v) ? v : null),                      // JSON
};
function virtualize(row, defs, entity) {
  const bag = row && row.custom && typeof row.custom === 'object' ? row.custom : {};
  const out = { ...row };
  for (const d of defs.filter(x => x.entity === entity && x.active)) {
    const has = Object.prototype.hasOwnProperty.call(bag, d.field_key);
    out[d.field_key] = project[d.field_type](has ? bag[d.field_key] : null);
  }
  return out;
}

/**
 * Split an `INSERT INTO t (cols) VALUES (vals)` into a row. Only the bound `?`
 * positions carry params, so the literal slots (NOW(), CONVERT_TZ(…)) are
 * skipped exactly as MySQL would — which is what lets this world catch a
 * column/placeholder mismatch in the composed INSERT rather than paper over it.
 */
function splitTopLevel(src) {
  const out = [];
  let depth = 0, quote = null, buf = '';
  for (const ch of src) {
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; buf += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function rowFromInsert(colsSrc, valsSrc, params) {
  const cols = splitTopLevel(colsSrc).map(s => s.replace(/`/g, ''));
  const vals = splitTopLevel(valsSrc);
  if (cols.length !== vals.length) {
    throw new Error(`world: INSERT column/value count mismatch (${cols.length} vs ${vals.length})`);
  }
  const row = {};
  let pi = 0;
  cols.forEach((c, i) => {
    if (vals[i] === '?') row[c] = params[pi++];
    else row[c] = vals[i].replace(/^'|'$/g, '');   // a literal like 'Filed' or NOW()
  });
  if (pi !== params.length) {
    throw new Error(`world: INSERT bound ${params.length} params but consumed ${pi}`);
  }
  return row;
}

function world({ defs = DEFS(), cases = {}, contacts = {} } = {}) {
  const state = {
    defs: clone(defs), cases: clone(cases), contacts: clone(contacts),
    inserts: [], updates: [], events: [], logs: [], sql: [], nextContactId: 100,
  };
  const query = async (sql, params = []) => {
    const s = norm(sql);
    state.sql.push(s);
    let m;

    // ── field_defs ──
    if (/FROM field_defs WHERE entity = \? ORDER BY sort_order ASC, id ASC$/.test(s)) {
      return [state.defs.filter(d => d.entity === params[0]).map(clone)];
    }
    if (/FROM field_defs WHERE id = \? LIMIT 1 FOR UPDATE$/.test(s)) {
      const d = state.defs.find(x => x.id === params[0]);
      return [d ? [clone(d)] : []];
    }
    if (/^SELECT id FROM field_defs WHERE entity = \? AND field_key = \? LIMIT 1$/.test(s)) {
      const d = state.defs.find(x => x.entity === params[0] && x.field_key === params[1]);
      return [d ? [{ id: d.id }] : []];
    }
    if (/^INSERT INTO field_defs/.test(s)) {
      state.inserts.push({ table: 'field_defs', sql: s, params });
      return [{ insertId: 900 + state.inserts.length }];
    }
    if (/^UPDATE field_defs SET .* WHERE id = \?$/.test(s)) {
      const cols = s.match(/SET (.*) WHERE/)[1].split(', ').map(x => x.replace(' = ?', ''));
      const d = state.defs.find(x => x.id === params[params.length - 1]);
      cols.forEach((c, k) => {
        d[c] = ['options', 'validation', 'show_when', 'default_value'].includes(c)
          ? (params[k] == null ? null : JSON.parse(params[k]))
          : params[k];
      });
      state.updates.push({ table: 'field_defs', cols, params });
      return [{ affectedRows: 1 }];
    }

    // ── information_schema ──
    if (/^SELECT COLUMN_NAME FROM information_schema\.COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = \? AND COLUMN_NAME = \?$/.test(s)) {
      const hit = (COLUMNS[params[0]] || []).includes(params[1]);
      return [hit ? [{ COLUMN_NAME: params[1] }] : []];
    }
    if (/^SELECT COLUMN_NAME FROM information_schema\.COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = \? AND GENERATION_EXPRESSION = ''$/.test(s)) {
      return [(COLUMNS[params[0]] || []).map(c => ({ COLUMN_NAME: c }))];
    }

    // ── post-data probes ──
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

    // ── contacts: the create INSERT (S6's stamp site) ──
    if ((m = s.match(/^INSERT INTO contacts \((.*)\) VALUES \((.*)\)$/))) {
      const row = rowFromInsert(m[1], m[2], params);
      // Snapshot as BOUND: the row object is post-processed below (custom parsed,
      // name computed), and a live reference would make `inserts` lie about it.
      state.inserts.push({ table: 'contacts', sql: s, cols: m[1], row: clone(row) });
      const id = state.nextContactId++;
      row.contact_id = id;
      row.custom = row.custom == null ? {} : JSON.parse(row.custom);
      row.contact_name = [row.contact_fname, row.contact_lname].filter(Boolean).join(' ');
      state.contacts[id] = row;
      return [{ insertId: id, affectedRows: 1 }];
    }
    if ((m = s.match(/^SELECT (.+) FROM contacts WHERE contact_id = \?$/))) {
      const r = state.contacts[params[0]];
      if (!r) return [[]];
      const full = virtualize(clone(r), state.defs, 'contact');
      if (m[1] === '*') return [[full]];
      const out = {};
      for (const c of m[1].split(', ')) { const k = c.replace(/`/g, ''); out[k] = full[k]; }
      return [[out]];
    }

    // ── cases: the create INSERT ──
    if ((m = s.match(/^INSERT INTO cases \((.*)\) VALUES \((.*)\)$/))) {
      const row = rowFromInsert(m[1], m[2], params);
      state.inserts.push({ table: 'cases', sql: s, cols: m[1], row: clone(row) });
      row.custom = row.custom == null ? {} : JSON.parse(row.custom);
      state.cases[row.case_id] = row;
      return [{ insertId: 1, affectedRows: 1 }];
    }
    if ((m = s.match(/^SELECT (.+) FROM cases WHERE case_id = \?$/))) {
      const r = state.cases[params[0]];
      if (!r) return [[]];
      const full = virtualize(clone(r), state.defs, 'case');
      if (m[1] === '*') return [[full]];
      const out = {};
      for (const c of m[1].split(', ')) { const k = c.replace(/`/g, ''); out[k] = full[k]; }
      return [[out]];
    }

    // ── side tables ──
    if (/^INSERT INTO domain_event_queue/.test(s)) {
      state.events.push({ type: params[0], envelope: JSON.parse(params[2]) });
      return [{ insertId: state.events.length }];
    }
    if (/^INSERT INTO log/.test(s)) {
      state.logs.push({ params });
      return [{ insertId: state.logs.length }];
    }

    throw new Error('world: unscripted query — ' + s);
  };
  const conn = {
    query, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
    release: () => {}, destroy: () => {},
  };
  return { state, query, getConnection: async () => conn, withTransaction: async fn => fn(conn) };
}

/** emit() is fire-and-forget; let its INSERT land. */
const settle = () => new Promise(r => setImmediate(r));

beforeEach(() => { fieldDefs.bump(); });

async function rejects(p) {
  try { await p; } catch (e) { return e; }
  throw new Error('expected a rejection');
}

// ═════════════════════════════════════════════════════════════
// 1. Reading the column — the scalar-JSON trap
// ═════════════════════════════════════════════════════════════

describe('S6 — default_value is read AS-IS, never re-parsed', () => {
  test('every type comes back in its own shape', async () => {
    const db = world();
    const got = (await fieldDefs.listActive(db, 'contact'))
      .map(d => [d.field_key, d.default_value, Array.isArray(d.default_value) ? 'array' : typeof d.default_value]);
    expect(got).toEqual([
      ['cf_txt',  '0001234',    'string'],
      ['cf_num',  42.5,         'number'],
      ['cf_dt',   '2026-09-25', 'string'],
      ['cf_bool', true,         'boolean'],
      ['cf_sel',  'b',          'string'],
      ['cf_ms',   ['x', 'y'],   'array'],
      ['cf_nodef', null,        'object'],   // null
    ]);
  });

  test('MUTATION CHECK — the options/validation reader would DESTROY these', () => {
    // Measured on 8.4.11 with this repo's mysql2 (3.24.3, no `jsonStrings`):
    // the driver has already parsed a scalar JSON column, so running it
    // through _parseJson JSON.parses an ALREADY-PARSED value. This is the
    // reason _defaultIn exists; if someone "tidies" it back to _parseJson,
    // these are the four ways it breaks.
    const _parseJson = v => {
      if (v == null) return null;
      if (typeof v === 'object') return v;
      try { return JSON.parse(v); } catch (_) { return null; }
    };
    expect(_parseJson('abc')).toBeNull();          // a text default vanishes
    expect(_parseJson('0001234')).toBeNull();      // the pilot's own shape
    expect(_parseJson('2026-09-25')).toBeNull();   // every date default
    expect(_parseJson('123')).toBe(123);           // text silently retyped
    // and the source must not be using it for this column
    const src = read('services/fieldDefService.js');
    expect(src).toMatch(/default_value:\s*_defaultIn\(r\.default_value\)/);
  });

  test('the column is in SELECT_COLS, or every read silently returns undefined', () => {
    expect(read('services/fieldDefService.js')).toMatch(/show_when, default_value, indexed/);
  });
});

// ═════════════════════════════════════════════════════════════
// 2. Def-save validation
// ═════════════════════════════════════════════════════════════

describe('S6 — a def cannot store a default its own field would reject', () => {
  const base = o => ({ entity: 'case', field_key: 'cf_new', label: 'New', field_type: 'text', ...o });
  const v = body => fieldDefs.validateDef(world(), body, { isCreate: false });

  test.each([
    ['text default on a number field',   { field_type: 'number', default_value: 'abc' },      /default_value: cf_new: must be a number/],
    ['number over DECIMAL(18,4)',        { field_type: 'number', default_value: 1e14 },       /default_value: .*between/],
    ['text over the 255 cap',            { default_value: 'z'.repeat(256) },                  /default_value: .*255 characters or fewer/],
    ['breaks the field\'s own max_len',  { default_value: 'abcdef', validation: { max_len: 3 } }, /default_value: .*3 characters or fewer/],
    ['breaks the field\'s own pattern',  { default_value: 'nope', validation: { pattern: '\\d+' } }, /default_value: .*must match the pattern/],
    ['breaks the field\'s own min',      { field_type: 'number', default_value: 1, validation: { min: 10 } }, /default_value: .*at least 10/],
    ['breaks the field\'s own max',      { field_type: 'number', default_value: 99, validation: { max: 10 } }, /default_value: .*at most 10/],
    ['not a real calendar date',         { field_type: 'date', default_value: '2026-02-30' }, /default_value: .*not a real calendar date/],
    ['a date that is not YYYY-MM-DD',    { field_type: 'date', default_value: '09/25/2026' }, /default_value: .*written YYYY-MM-DD/],
    ['non-boolean on a boolean field',   { field_type: 'boolean', default_value: 'maybe' },   /default_value: .*must be true or false/],
    ['unknown select option',            { field_type: 'select', default_value: 'zz', options: [{ value: 'a', label: 'A' }] }, /default_value: .*not one of its options/],
    ['multiselect default that is not an array', { field_type: 'multiselect', default_value: 'x', options: [{ value: 'x', label: 'X' }] }, /default_value: .*must be an array/],
    ['multiselect with an unknown member', { field_type: 'multiselect', default_value: ['x', 'q'], options: [{ value: 'x', label: 'X' }] }, /default_value: .*not one of its options/],
  ].map(([n, o, re]) => [n, o, re]))('rejects: %s', async (_n, o, re) => {
    await expect(v(base(o))).rejects.toThrow(re);
  });

  test('the error says default_value, so the editor does not read it as a value error', async () => {
    const e = await rejects(v(base({ field_type: 'number', default_value: 'abc' })));
    expect(e.status).toBe(400);
    expect(e.message.startsWith('default_value:')).toBe(true);
  });

  test.each([
    ['text',        { default_value: '0001234' },                           '0001234'],
    ['a numeric-looking TEXT default stays a string', { default_value: '123' }, '123'],
    ['number',      { field_type: 'number', default_value: 42.5 },          42.5],
    ['number as a decimal STRING → a JSON number', { field_type: 'number', default_value: '7.25' }, 7.25],
    ['boolean true',  { field_type: 'boolean', default_value: true },        true],
    ['boolean FALSE (not folded to "no default")', { field_type: 'boolean', default_value: false }, false],
    ['boolean from the string "false"', { field_type: 'boolean', default_value: 'false' },  false],
    ['date',        { field_type: 'date', default_value: '2026-09-25' },     '2026-09-25'],
    ['number ZERO (not folded to "no default")', { field_type: 'number', default_value: 0 }, 0],
  ])('accepts and normalizes: %s', async (_n, o, want) => {
    await expect(v(base(o))).resolves.toMatchObject({ default_value: want });
  });

  test('a multiselect default is stored in the DEF\'s option order, not the input order', async () => {
    // So an equal set never diffs as changed — the same rule validateValue
    // applies to a written multiselect value.
    await expect(v(base({
      field_type: 'multiselect', default_value: ['y', 'x'],
      options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }],
    }))).resolves.toMatchObject({ default_value: ['x', 'y'] });
  });

  test.each([
    ['omitted',   {}],
    ['null',      { default_value: null }],
    ['empty string', { default_value: '' }],
  ])('%s means NO DEFAULT (stored NULL)', async (_n, o) => {
    await expect(v(base(o))).resolves.toMatchObject({ default_value: null });
  });

  test('an empty multiselect array means no default', async () => {
    await expect(v(base({ field_type: 'multiselect', default_value: [],
      options: [{ value: 'x', label: 'X' }] }))).resolves.toMatchObject({ default_value: null });
  });

  test('a RETIRED option cannot become a default — pickers hide it', async () => {
    await expect(v(base({
      field_type: 'select', default_value: 'r',
      options: [{ value: 'a', label: 'A' }, { value: 'r', label: 'R', active: false }],
    }))).rejects.toThrow(/default_value: "r" is retired/);
  });

  test('…and the same for a multiselect member', async () => {
    await expect(v(base({
      field_type: 'multiselect', default_value: ['x', 'r'],
      options: [{ value: 'x', label: 'X' }, { value: 'r', label: 'R', active: false }],
    }))).rejects.toThrow(/default_value: "r" is retired/);
  });

  test('a broken options array does not add a second, misleading default error', async () => {
    const e = await rejects(v(base({ field_type: 'select', options: [], default_value: 'a' })));
    expect(e.message).toMatch(/options is required for select/);
    expect(e.message).not.toMatch(/default_value/);
  });

  test('an unrelated problem still reports the default in the SAME message', async () => {
    // The file collects every shape problem into one string on purpose.
    const e = await rejects(v(base({ label: '   ', field_type: 'number', default_value: 'abc' })));
    expect(e.message).toMatch(/label is required/);
    expect(e.message).toMatch(/default_value/);
  });

  test('createDef binds the default as JSON TEXT, so a string stays a string', async () => {
    const db = world({ defs: [] });
    await fieldDefs.createDef(db, { entity: 'case', field_key: 'cf_zz', label: 'Z',
      field_type: 'text', default_value: '123' });
    const ins = db.state.inserts.find(i => i.table === 'field_defs');
    // The quoting is what preserves the type through the JSON column.
    expect(ins.params).toContain('"123"');
  });
});

// ═════════════════════════════════════════════════════════════
// 3. updateDef — the merged-row re-validation
// ═════════════════════════════════════════════════════════════

describe('S6 — a patch is validated against the STORED default', () => {
  test('default_value is patchable', () => {
    expect(read('services/fieldDefService.js'))
      .toMatch(/const PATCHABLE = \['label', 'field_type', 'options', 'validation', 'show_when',\s*'default_value', 'sort_order'\]/);
  });

  test('a retype whose stored default no longer fits is REFUSED, naming the default', async () => {
    const db = world({ defs: [def({ entity: 'case', field_key: 'cf_word', field_type: 'text', default_value: 'abc' })] });
    const id = db.state.defs[0].id;
    const e = await rejects(fieldDefs.updateDef(db, id, { field_type: 'number' }));
    expect(e.message).toMatch(/default_value: cf_word: must be a number/);
    expect(db.state.defs[0].field_type).toBe('text');    // and nothing changed
  });

  test('a NUMERIC-LOOKING text default survives a pre-data retype — and is CONVERTED', async () => {
    // Deliberate, and worth pinning because it loses information: validateValue
    // accepts a plain decimal string for a number field, so '0001234' becomes
    // the number 1234 and the leading zeros are gone. Identical to what would
    // happen to a written VALUE, and a retype is only legal before any record
    // holds data (S2's field_type lock), so no stored value is harmed. An admin
    // who needs the zeros keeps the field text — the §7 pilot's whole argument.
    const db = world();                                   // cf_txt default '0001234'
    await fieldDefs.updateDef(db, 1, { field_type: 'number' });
    expect(db.state.defs.find(d => d.id === 1).default_value).toBe(1234);
  });

  test('clearing the default in the same patch lets that retype through', async () => {
    const db = world();
    await expect(fieldDefs.updateDef(db, 1, { field_type: 'number', default_value: null }))
      .resolves.toMatchObject({ field_key: 'cf_txt' });
    expect(db.state.defs.find(d => d.id === 1).default_value).toBeNull();
  });

  test('RETIRING the option a default names is refused', async () => {
    const db = world();                                   // cf_sel default 'b'
    const e = await rejects(fieldDefs.updateDef(db, 5, {
      options: [{ value: 'a', label: 'A', active: true }, { value: 'b', label: 'B', active: false }] }));
    expect(e.message).toMatch(/default_value: "b" is retired/);
    expect(db.state.defs.find(d => d.id === 5).default_value).toBe('b');  // untouched
  });

  test('REMOVING it is refused too (and by the option lock, whichever bites first)', async () => {
    const db = world();
    const e = await rejects(fieldDefs.updateDef(db, 5, { options: [{ value: 'a', label: 'A', active: true }] }));
    expect(e.message).toMatch(/default_value/);
  });

  test('setting a default needs no post-data lock — it touches no stored record', async () => {
    // Contrast with field_type and option values, which DO lock once records
    // hold data (S2). A record already holding a value for the key must not
    // stop an admin adding a default for FUTURE records.
    const db = world({ defs: DEFS(), contacts: { 1: { contact_id: 1, custom: { cf_nodef: 'held' } } } });
    await expect(fieldDefs.updateDef(db, 7, { default_value: 'later' }))
      .resolves.toMatchObject({ field_key: 'cf_nodef' });
    expect(db.state.contacts[1].custom).toEqual({ cf_nodef: 'held' });   // and it did NOT change
  });

  test('a patch that omits default_value keeps the stored one', async () => {
    const db = world();
    await fieldDefs.updateDef(db, 1, { label: 'Renamed' });
    expect(db.state.defs.find(d => d.id === 1).default_value).toBe('0001234');
  });

  test('…and does not write the column when nothing about it changed', async () => {
    // The re-normalization below must not turn every label edit into a
    // default_value write — updated_at churn and a pointless JSON bind.
    const db = world();
    await fieldDefs.updateDef(db, 1, { label: 'Renamed' });
    const u = db.state.updates.find(x => x.table === 'field_defs');
    expect(u.cols).toEqual(['label']);
  });

  test('a re-normalized default IS persisted, so the column never disagrees with the type', async () => {
    // Found by test, 2026-09-25: without this the column would keep the JSON
    // STRING "0001234" while the def said `number`, and the stamp would write a
    // string into a key whose virtual column is DECIMAL(18,4).
    const db = world();
    await fieldDefs.updateDef(db, 1, { field_type: 'number' });
    const u = db.state.updates.find(x => x.table === 'field_defs');
    expect(u.cols).toEqual(['field_type', 'default_value']);
    expect(db.state.defs.find(d => d.id === 1).default_value).toBe(1234);
  });

  test('a normalized multiselect default is persisted in the def\'s option order', async () => {
    const db = world({ defs: [def({
      entity: 'case', field_key: 'cf_pick', field_type: 'multiselect', default_value: ['y', 'x'],
      options: [{ value: 'x', label: 'X', active: true }, { value: 'y', label: 'Y', active: true }] })] });
    const id = db.state.defs[0].id;
    await fieldDefs.updateDef(db, id, { label: 'Pick' });
    expect(db.state.defs[0].default_value).toEqual(['x', 'y']);
  });
});

// ═════════════════════════════════════════════════════════════
// 4. defaultsObject / customCreateValue
// ═════════════════════════════════════════════════════════════

describe('S6 — the stamping helpers', () => {
  test('defaultsObject returns only the active defs that HAVE a default', async () => {
    const db = world();
    expect(await fieldDefs.defaultsObject(db, 'contact')).toEqual({
      cf_txt: '0001234', cf_num: 42.5, cf_dt: '2026-09-25',
      cf_bool: true, cf_sel: 'b', cf_ms: ['x', 'y'],
    });
    expect(await fieldDefs.defaultsObject(db, 'case')).toEqual({
      cf_ctxt: 'seed', cf_cbool: false, cf_chid: 'hid',
    });
  });

  test('boolean false and number 0 are DEFAULTS, not absences', async () => {
    // The falsy trap: `if (def.default_value)` would drop both.
    const db = world({ defs: [
      def({ entity: 'case', field_key: 'cf_ff', field_type: 'boolean', default_value: false }),
      def({ entity: 'case', field_key: 'cf_zz', field_type: 'number',  default_value: 0 }),
    ] });
    expect(await fieldDefs.defaultsObject(db, 'case')).toEqual({ cf_ff: false, cf_zz: 0 });
  });

  test('an INACTIVE def contributes nothing', async () => {
    const db = world({ defs: [
      def({ entity: 'case', field_key: 'cf_on',  field_type: 'text', default_value: 'y' }),
      def({ entity: 'case', field_key: 'cf_off', field_type: 'text', default_value: 'n', active: 0 }),
    ] });
    expect(await fieldDefs.defaultsObject(db, 'case')).toEqual({ cf_on: 'y' });
  });

  test('a show_when-hidden def IS included — a default is data, not display', async () => {
    const db = world();
    expect(await fieldDefs.defaultsObject(db, 'case')).toHaveProperty('cf_chid', 'hid');
  });

  test('no defaults → {} → customCreateValue returns null, so `custom` is omitted', async () => {
    const db = world({ defs: [def({ entity: 'case', field_key: 'cf_aa', field_type: 'text' })] });
    expect(await fieldDefs.defaultsObject(db, 'case')).toEqual({});
    expect(fieldDefs.customCreateValue({})).toBeNull();
    expect(fieldDefs.customCreateValue(null)).toBeNull();
  });

  test('customCreateValue emits JSON text for a bound ?', () => {
    expect(JSON.parse(fieldDefs.customCreateValue({ cf_aa: '1', cf_bb: true })))
      .toEqual({ cf_aa: '1', cf_bb: true });
  });

  test('customCreateValue refuses a malformed key with a 500 — these become JSON paths', () => {
    for (const k of ['custom', 'cf_', 'CF_X', 'cf_x$', "cf_a'; DROP", 'contact_ssn']) {
      expect(() => fieldDefs.customCreateValue({ [k]: 'v' }))
        .toThrow(/refusing malformed key/);
    }
  });

  test('it reads through the def CACHE — no query per create', async () => {
    const db = world();
    await fieldDefs.defaultsObject(db, 'contact');
    const first = db.state.sql.filter(s => /FROM field_defs/.test(s)).length;
    await fieldDefs.defaultsObject(db, 'contact');
    await fieldDefs.defaultsObject(db, 'contact');
    expect(db.state.sql.filter(s => /FROM field_defs/.test(s)).length).toBe(first);
  });
});

// ═════════════════════════════════════════════════════════════
// 5. createContact — the contact stamp site
// ═════════════════════════════════════════════════════════════

describe('S6 — createContact stamps defaults into the INSERT', () => {
  const make = (db, over = {}) =>
    contactService.createContact(db, { fname: 'Ada', lname: 'Lovelace', ...over }, { userId: 3 });

  test('the bag is born with every default, in its own JSON shape', async () => {
    const db = world();
    const out = await make(db);
    expect(db.state.contacts[out.contact_id].custom).toEqual({
      cf_txt: '0001234', cf_num: 42.5, cf_dt: '2026-09-25',
      cf_bool: true, cf_sel: 'b', cf_ms: ['x', 'y'],
    });
  });

  test('a def with NO default leaves its key ABSENT — not null, not empty', async () => {
    const db = world();
    const out = await make(db);
    expect(Object.prototype.hasOwnProperty.call(db.state.contacts[out.contact_id].custom, 'cf_nodef'))
      .toBe(false);
  });

  test('the virtual columns agree with the stamped bag', async () => {
    const db = world();
    const out = await make(db);
    const [[row]] = await db.query('SELECT * FROM contacts WHERE contact_id = ?', [out.contact_id]);
    expect([row.cf_txt, row.cf_num, row.cf_dt, row.cf_bool, row.cf_sel, row.cf_ms, row.cf_nodef])
      .toEqual(['0001234', '42.5000', '2026-09-25', 1, 'b', ['x', 'y'], null]);
  });

  test('ONE write — `custom` rides the INSERT, and no UPDATE follows it', async () => {
    const db = world();
    await make(db);
    const ins = db.state.inserts.filter(i => i.table === 'contacts');
    expect(ins).toHaveLength(1);
    expect(ins[0].cols).toMatch(/`custom`/);
    expect(db.state.sql.filter(s => /^UPDATE contacts/.test(s))).toHaveLength(0);
  });

  test('with no defaults configured the INSERT is the pre-S6 one — `custom` unnamed', async () => {
    const db = world({ defs: [def({ field_key: 'cf_none', field_type: 'text' })] });
    await make(db);
    const ins = db.state.inserts.find(i => i.table === 'contacts');
    expect(ins.cols).not.toMatch(/custom/);
    expect(ins.row.custom).toBeUndefined();   // nothing was bound for it
  });

  test('contact.created carries the stamped values — the envelope is a post-commit SELECT *', async () => {
    const db = world();
    const out = await make(db);
    await settle();
    const ev = db.state.events.find(e => e.type === 'contact.created');
    expect(ev).toBeTruthy();
    expect(ev.envelope.data.cf_txt).toBe('0001234');
    expect(ev.envelope.data.cf_bool).toBe(1);        // the COLUMN's shape (S4's rule)
    expect(ev.envelope.data.contact_id).toBe(out.contact_id);
  });

  test('an explicit cf_ key is REFUSED with a 400 naming it — never silently defaulted', async () => {
    const db = world();
    const e = await rejects(make(db, { cf_txt: 'mine' }));
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/cf_txt/);
    expect(e.message).toMatch(/PATCH \/api\/contacts\/:id/);
    expect(db.state.inserts.filter(i => i.table === 'contacts')).toHaveLength(0);
  });

  test('…however it is cased, and even for an UNKNOWN cf_ key', async () => {
    for (const k of ['CF_TXT', 'cf_txt', 'cf_never_defined']) {
      const db = world();
      const e = await rejects(make(db, { [k]: 'x' }));
      expect(e.status).toBe(400);
      expect(e.message).toMatch(new RegExp(k));
    }
  });

  test('a non-cf_ unknown key is still ignored, exactly as before S6', async () => {
    // The refusal is scoped to the cf_ namespace on purpose: POST /api/contacts
    // hands req.body over wholesale, and rejecting stray keys would be a
    // behaviour break with nothing to do with custom fields.
    const db = world();
    await expect(make(db, { some_stray_key: 'x' })).resolves.toMatchObject({ contact_name: 'Ada Lovelace' });
  });

  test('MUTATION CHECK — with the stamp removed the bag is empty', async () => {
    const db = world();
    const real = fieldDefs.customCreateValue;
    fieldDefs.customCreateValue = () => null;
    try {
      const out = await make(db);
      expect(db.state.contacts[out.contact_id].custom).toEqual({});
    } finally { fieldDefs.customCreateValue = real; }
  });
});

// ═════════════════════════════════════════════════════════════
// 6. NEVER RETROACTIVE
// ═════════════════════════════════════════════════════════════

describe('S6 — never retroactive', () => {
  test('a def GAINING a default writes to no existing row', async () => {
    const db = world({
      defs: DEFS(),
      cases:    { A: { case_id: 'A', custom: {} } },
      contacts: { 1: { contact_id: 1, custom: { cf_txt: 'theirs' } } },
    });
    await fieldDefs.updateDef(db, 7, { default_value: 'LATE' });   // cf_nodef
    expect(db.state.cases.A.custom).toEqual({});
    expect(db.state.contacts[1].custom).toEqual({ cf_txt: 'theirs' });
    // and structurally: the only write was to field_defs
    expect(db.state.sql.filter(s => /^UPDATE (cases|contacts)/.test(s))).toHaveLength(0);
    expect(db.state.sql.filter(s => /^INSERT INTO (cases|contacts)/.test(s))).toHaveLength(0);
  });

  test('a def CHANGING its default writes to no existing row either', async () => {
    const db = world({ defs: DEFS(), contacts: { 1: { contact_id: 1, custom: { cf_txt: 'theirs' } } } });
    await fieldDefs.updateDef(db, 1, { default_value: 'CHANGED' });
    expect(db.state.contacts[1].custom).toEqual({ cf_txt: 'theirs' });
  });

  test('the NEXT create does get the new default', async () => {
    const db = world();
    await fieldDefs.updateDef(db, 7, { default_value: 'LATE' });
    const out = await contactService.createContact(db, { fname: 'Grace', lname: 'Hopper' }, { userId: 3 });
    expect(db.state.contacts[out.contact_id].custom.cf_nodef).toBe('LATE');
  });

  test('and after CLEARING a default the next create leaves the key absent', async () => {
    const db = world();
    await fieldDefs.updateDef(db, 1, { default_value: null });    // cf_txt
    const out = await contactService.createContact(db, { fname: 'Mary', lname: 'Jackson' }, { userId: 3 });
    expect(Object.prototype.hasOwnProperty.call(db.state.contacts[out.contact_id].custom, 'cf_txt'))
      .toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════
// 7. The case side — two sites, no chokepoint (S6 report, 2026-09-25)
// ═════════════════════════════════════════════════════════════

describe('S6-B — caseService.createCase is THE case INSERT', () => {
  // Behaviour on the case paths is proved on a real engine (design doc §8):
  // createCase runs on the pool with no transaction, inside a collision-retry
  // loop, and its two callers keep their own linking, logging and emit.
  test('createCase exists and is exported, with the firm-now sentinel', () => {
    const caseService = require('../services/caseService');
    expect(typeof caseService.createCase).toBe('function');
    expect(caseService.NOW_FIRM).toBeDefined();
    expect(Object.isFrozen(caseService.NOW_FIRM)).toBe(true);
  });

  test('it stamps defaults, and the INSERT names `custom` exactly once', async () => {
    const caseService = require('../services/caseService');
    const db = world();
    const out = await caseService.createCase(db, { case_type: 'Bankruptcy' });
    expect(out.case_id).toEqual(expect.any(String));
    expect(db.state.cases[out.case_id].custom)
      .toEqual({ cf_ctxt: 'seed', cf_cbool: false, cf_chid: 'hid' });
    const ins = db.state.inserts.filter(i => i.table === 'cases');
    expect(ins).toHaveLength(1);
    expect(ins[0].cols.match(/custom/g)).toHaveLength(1);
    expect(db.state.sql.filter(x => /^UPDATE cases/.test(x))).toHaveLength(0);
  });

  test('it returns the stamped values in the COLUMN\'s shape for the envelope', async () => {
    // S4's rule: case.created and contact.created must agree per type. The
    // contact side gets this free from its SELECT *; here it is a read-back.
    const caseService = require('../services/caseService');
    const db = world();
    const out = await caseService.createCase(db, { case_type: 'X' });
    expect(out.custom_fields).toEqual({ cf_ctxt: 'seed', cf_cbool: 0, cf_chid: 'hid' });
    expect(out.custom_fields.cf_cbool).not.toBe(false);   // 0, the TINYINT, not the JSON boolean
  });

  test('with nothing defaulted it returns {} and omits `custom` entirely', async () => {
    const caseService = require('../services/caseService');
    const db = world({ defs: [def({ entity: 'case', field_key: 'cf_none', field_type: 'text' })] });
    const out = await caseService.createCase(db, { case_type: 'X' });
    expect(out.custom_fields).toEqual({});
    expect(db.state.inserts.find(i => i.table === 'cases').cols).not.toMatch(/custom/);
  });

  test('the firm-now sentinel becomes SQL, never a bound parameter', async () => {
    const caseService = require('../services/caseService');
    const db = world();
    await caseService.createCase(db, { case_open_date: caseService.NOW_FIRM, case_type: 'X' });
    const ins = db.state.inserts.find(i => i.table === 'cases');
    expect(ins.sql).toMatch(/CONVERT_TZ\(NOW\(\), 'UTC', 'America\/New_York'\)/);
    expect(ins.row.case_open_date).toBe("CONVERT_TZ(NOW(), 'UTC', 'America/New_York')");
  });

  test('undefined OMITS a column; null writes NULL explicitly', async () => {
    // Not cosmetic: `cases` is mostly NOT NULL with no DB defaults under a
    // non-strict sql_mode, so omitting and writing NULL are different writes.
    const caseService = require('../services/caseService');
    const db = world();
    await caseService.createCase(db, { case_type: 'X', case_subtype: undefined, case_stage: null });
    const ins = db.state.inserts.find(i => i.table === 'cases');
    expect(ins.cols).not.toMatch(/case_subtype/);
    expect(ins.cols).toMatch(/case_stage/);
    expect(ins.row.case_stage).toBeNull();
  });

  test('it mints the id and refuses one from the caller', async () => {
    const caseService = require('../services/caseService');
    const e = await rejects(caseService.createCase(world(), { case_id: 'MINE', case_type: 'X' }));
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/case_id is minted here/);
  });

  test('it gates unknown columns instead of letting MySQL 500', async () => {
    const caseService = require('../services/caseService');
    const e = await rejects(caseService.createCase(world(), { nope: 1 }));
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/unknown column\(s\): nope/);
  });

  test('it refuses an explicit cf_ key, the same fence as createContact', async () => {
    const caseService = require('../services/caseService');
    const e = await rejects(caseService.createCase(world(), { case_type: 'X', cf_ctxt: 'mine' }));
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/cf_ctxt/);
    expect(e.message).toMatch(/PATCH \/api\/cases\/:id/);
  });

  test('both services share ONE guard, so the two fences cannot drift', () => {
    for (const f of ['services/caseService.js', 'services/contactService.js']) {
      expect(read(f)).toMatch(/fieldDefs\.assertNoCustomAtCreate\(/);
    }
  });

  test('MUTATION CHECK — with the stamp removed the bag is empty', async () => {
    const caseService = require('../services/caseService');
    const db = world();
    const real = fieldDefs.customCreateValue;
    fieldDefs.customCreateValue = () => null;
    try {
      const out = await caseService.createCase(db, { case_type: 'X' });
      expect(db.state.cases[out.case_id].custom).toEqual({});
      expect(out.custom_fields).toEqual({});
    } finally { fieldDefs.customCreateValue = real; }
  });

  test('both callers go THROUGH it — neither composes an INSERT any more', () => {
    for (const f of ['services/intakeService.js', 'routes/api.intake.petition.js']) {
      const src = read(f);
      expect(src).toMatch(/caseService\.createCase\(/);
      expect(src).not.toMatch(/INSERT INTO cases/i);
      expect(src).not.toMatch(/generateCaseId/);          // the id is minted inside
    }
  });

  test('both spread the stamped values into their case.created data', () => {
    // Without this the two entities' envelopes disagree for cf_ keys, which is
    // exactly the bug class S4 fixed for case.updated.
    for (const f of ['services/intakeService.js', 'routes/api.intake.petition.js']) {
      expect(read(f)).toMatch(/\.\.\.created\.custom_fields,/);
    }
  });

  test('the petition route still stamps in the CREATE branch only', () => {
    const src = read('routes/api.intake.petition.js');
    const stampBranch  = src.indexOf('── STAMP the waiting case ──');
    const createBranch = src.indexOf('── CREATE a new Filed case ──');
    expect(stampBranch).toBeGreaterThan(0);
    expect(src.indexOf('caseService.createCase(')).toBeGreaterThan(createBranch);
    // the sibling branch UPDATEs an existing case and must not touch `custom`
    expect(src.slice(stampBranch, createBranch)).toMatch(/UPDATE cases/);
    expect(src.slice(stampBranch, createBranch)).not.toMatch(/custom/);
  });

  test('intakeCase keeps its own linking, log row and extra.case_relate_id', () => {
    // createCase deliberately does NOT absorb these: the two callers differ,
    // and moving the emit would fire it before the link exists and drop a key
    // from a live envelope.
    const src = read('services/intakeService.js');
    expect(src).toMatch(/INSERT INTO case_relate/);
    expect(src).toMatch(/INSERT INTO log/);
    expect(src).toMatch(/extra: \{ case_relate_id: relateResult\.insertId \}/);
  });
});

// ═════════════════════════════════════════════════════════════
// 8. Structural guards
// ═════════════════════════════════════════════════════════════

describe('S6 — structural guards', () => {
  test('contactService holds the ONLY INSERT INTO contacts, so no create bypasses defaults', () => {
    // The S6 census (2026-09-25) found every contact entrance converging on
    // createContact — including routes/booking.js, which the S6 prompt and the
    // design doc's fence list both describe as a bypass WRITER (it is, for
    // core-column updates; it is NOT for creation). This guard is what makes
    // that claim keep paying: add a second contacts INSERT and it fails.
    const hits = [];
    const walk = dir => {
      for (const f of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
        const rel = `${dir}/${f.name}`;
        if (f.isDirectory()) { walk(rel); continue; }
        if (!f.name.endsWith('.js')) continue;
        const src = read(rel);
        // Statement, not prose: an INSERT followed by a column list.
        if (/INSERT\s+INTO\s+`?contacts`?\s*\(/i.test(src)) hits.push(rel);
      }
    };
    for (const d of ['services', 'routes', 'lib', 'scripts', 'startup']) walk(d);
    expect(hits).toEqual(['services/contactService.js']);
  });

  test('caseService holds the ONLY INSERT INTO cases (S6-B extraction)', () => {
    // Before 2026-09-25 this was two sites with no chokepoint between them —
    // which is why S6's defaults had to be written twice. Fred ruled the
    // extraction; this is what stops a third site appearing quietly.
    const hits = [];
    const walk = dir => {
      for (const f of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
        const rel = `${dir}/${f.name}`;
        if (f.isDirectory()) { walk(rel); continue; }
        if (!f.name.endsWith('.js')) continue;
        if (/INSERT\s+INTO\s+`?cases`?\s*[(\$]/i.test(read(rel))) hits.push(rel);
      }
    };
    for (const d of ['services', 'routes', 'lib', 'scripts', 'startup']) walk(d);
    expect(hits).toEqual(['services/caseService.js']);
  });

  test('S2\'s no-raw-JSON-path rule still holds across the S6 edits', () => {
    // The S2 grep, re-run over exactly the files S6 touched: nothing may read a
    // key back out of the bag in SQL. S6 only ever WRITES the whole object.
    for (const f of ['services/fieldDefService.js', 'services/contactService.js',
                     'services/intakeService.js', 'routes/api.intake.petition.js',
                     'services/caseService.js']) {
      const src = read(f);
      expect(src).not.toMatch(/custom\s*->>/);
      expect(src).not.toMatch(/JSON_UNQUOTE\s*\(\s*JSON_EXTRACT\s*\(\s*`?custom/);
    }
  });

  test('the migration spells its algorithm and carries the semantics', () => {
    const sql = read('ref/migrations/2026-09-25_field_defs_default_value.sql');
    expect(sql).toMatch(/ADD COLUMN `default_value` json DEFAULT NULL/);
    expect(sql).toMatch(/ALGORITHM=INSTANT;/);
    for (const claim of [/NEVER retroactive/, /ONCE, at record creation/, /regardless of show_when/i]) {
      expect(sql).toMatch(claim);
    }
  });
});

// ═════════════════════════════════════════════════════════════
// 9. The editor (caseconfig/fields.html)
// ═════════════════════════════════════════════════════════════

describe('S6 — the Fields editor sends and clears default_value', () => {
  const html = () => read('public/caseconfig/fields.html');

  test('both writes carry default_value', () => {
    const src = html();
    // per-card Save (PATCH) and the Add form (POST)
    expect(src.match(/default_value: cfDefaultOut\(t\)/g) || []).toHaveLength(2);
  });

  test('it is ALWAYS sent, never omitted the way show_when can be', () => {
    // show_when has an "advanced shape" escape hatch; a default cannot take a
    // shape this editor can't show, so the shown state is the sent state and
    // blanking the box genuinely clears the stored default.
    const src = html();
    expect(src).toMatch(/if \(sw !== undefined\) body\.show_when = sw;/);   // the contrast
    expect(src).not.toMatch(/default_value !== undefined/);
  });

  test('the load path adopts the stored default without parsing it', () => {
    expect(html()).toMatch(/default_value: d\.default_value === undefined \? null : d\.default_value/);
  });

  test('a per-type control exists for every one of the six types', () => {
    const src = html();
    const body = src.slice(src.indexOf('function cfDefaultBody'), src.indexOf('function cfDefaultOut'));
    expect(body).toMatch(/CF_OPTION_TYPES\.includes\(t\.field_type\)/);   // select + multiselect
    expect(body).toMatch(/'boolean'/);
    expect(body).toMatch(/'date'/);
    expect(body).toMatch(/'number'/);
    expect(body).toMatch(/type="text" data-cf-dv/);                       // text fallback
    expect(body).toMatch(/multiple/);                                     // multiselect
  });

  test('select/multiselect offer ACTIVE options only', () => {
    const src = html();
    const body = src.slice(src.indexOf('function cfDefaultBody'), src.indexOf('function cfDefaultOut'));
    expect(body).toMatch(/t\.options\.filter\(o => o\.active !== false/);
  });

  test('the control tells staff the rule they will trip on', () => {
    // "never changes records that already exist" has to be on the screen, not
    // only in the manual — it is the whole semantics.
    const src = html();
    expect(src).toMatch(/stamped once, when the record is created/);
    expect(src).toMatch(/never changes records that already exist/);
  });

  test('cfBlank seeds default_value, so the Add form has a slot to fill', () => {
    expect(html()).toMatch(/default_value: null,/);
  });

  test('the inline script still parses', () => {
    // The whole page is one inline block; a syntax error here is a blank tab.
    const blocks = html().match(/<script>([\s\S]*?)<\/script>/g) || [];
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      const body = b.replace(/^<script>/, '').replace(/<\/script>$/, '');
      expect(() => new Function(body)).not.toThrow();
    }
  });
});

// ═════════════════════════════════════════════════════════════
// 10. Renderer prefill — the S6 finding, pinned
// ═════════════════════════════════════════════════════════════

describe('S6 — there is no pre-create custom-fields form to prefill', () => {
  test('both mounts require an existing record id', () => {
    // The census found no new-record form that renders custom fields: the case
    // page needs a case, and the contact form PATCHes a contact id. So a
    // render-time prefill would have nowhere to live — which is just as well,
    // because a form showing a value the DB does not hold is the lie surface
    // the ruling closed. If a real create form ever mounts this section, this
    // test is where the question comes back.
    expect(read('public/forms/contact-form.html')).toMatch(/patchPath: `\/api\/contacts\/\$\{contactId\}`/);
    expect(read('public/case.html')).toMatch(/patchPath:/);
  });

  test('the renderer stamps nothing itself — it has no notion of a default', () => {
    expect(read('public/js/yc-custom-fields.js')).not.toMatch(/default_value/);
  });
});
