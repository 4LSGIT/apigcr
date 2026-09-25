// tests/customFields.s5.test.js
//
/**
 * Custom-fields arc S5-A — the PILOT MIGRATION (ref/CUSTOM_FIELDS_DESIGN.md
 * §7 S5). S0–S4 built the machine on an empty registry; S5 is the first time
 * real production data moves into it, and the first time a real column is
 * retired. The proof obligations:
 *
 *   1. WRITE FREEZE. `cases.clio_matter` and `contacts.contact_clio_id` still
 *      EXIST and still READ through the soak, but no write may reach them
 *      again — one write to the old column and one to the cf_ key and there
 *      is no way to tell which is current. Both chokepoints must reject them
 *      with an error that NAMES THE cf_ KEY (a bare "blocked column" would
 *      send the caller looking for a permission problem), as a 400, however
 *      the key is cased, and whatever else is in the payload. The cf_ keys
 *      themselves must go through untouched — the freeze must not be a
 *      blanket refusal of anything Clio-shaped.
 *
 *   2. REPOINTED READS. The consumers the census found must name the cf_ key
 *      and not the frozen column: lookup_contact's SELECT list, the trigger
 *      builder's event-field catalog, the report manifest's note. And
 *      lookup_contact must SURVIVE the cf_ column being absent — it is a
 *      VIRTUAL column the reconciler owns, so a not-yet-created or
 *      deactivated def must not take every automation's contact read down
 *      with it (the S4 "never fatal" doctrine).
 *
 *   3. BACKFILL ROUND TRIP. old column → JSON_SET → virtual column, value
 *      for value, including the shapes that bite: leading zeros, a full-width
 *      value, case variants, and '' (which must leave the key ABSENT, not
 *      present-and-empty). Plus the mutation check: the migration's own
 *      verification queries must FAIL on a poisoned row — including the
 *      poison the COUNT query cannot see, where the totals still balance but
 *      the values landed on the wrong rows.
 *
 * Harness: the arc's dispatch-on-SQL-text world (S2/S3/S4), with S3's virtual
 * columns computed off the bag with JSON_VALUE semantics. The same migration,
 * the same reconciler DDL and the same verification queries were also run
 * against a real MySQL 8.4.11 clone of `cases`/`contacts` carrying the REAL
 * `after_contact_update` trigger — see the S5-A report for that run (it is
 * what proves the trigger stays silent, `contact_updated` is not bumped, and
 * `cf_x = 'abcdef'` matches case-insensitively where `custom->>'$.x'` does
 * not).
 *
 *   npx jest tests/customFields.s5.test.js
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
const caseService    = require('../services/caseService');
const contactService = require('../services/contactService');

const REPO = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(REPO, p), 'utf8');

// ─────────────────────────────────────────────────────────────
// Fixtures — the two PILOT defs, exactly as scripts/customFieldsS5Seed
// creates them.
// ─────────────────────────────────────────────────────────────

const { PILOT_DEFS } = require('../scripts/customFieldsS5Seed');

let nextDefId = 1;
function def(o) {
  return {
    id: nextDefId++, entity: 'case', label: o.field_key, options: null, validation: null,
    show_when: null, indexed: 0, sort_order: 10, active: 1,
    created_at: '2026-09-25 10:00:00', updated_at: '2026-09-25 10:00:00', ...o,
  };
}
const DEFS = () => [
  def({ entity: 'case',    field_key: 'cf_clio_matter', field_type: 'text', label: 'Clio Matter ID' }),
  def({ entity: 'contact', field_key: 'cf_clio_id',     field_type: 'text', label: 'Clio Contact ID' }),
];

// The frozen columns are still REAL columns on both tables — the freeze is an
// app rule, not their absence. A world that omitted them would pass the
// rejection tests for the wrong reason (unknown column, not frozen column).
const COLUMNS = {
  cases:    ['case_id', 'case_stage', 'case_notes', 'clio_matter', 'case_clio_id', 'custom'],
  contacts: ['contact_id', 'contact_kind', 'contact_fname', 'contact_lname', 'contact_name',
             'contact_notes', 'contact_clio_id', 'contact_updated', 'custom'],
};

const norm  = sql => String(sql).replace(/\s+/g, ' ').trim();
const clone = o => JSON.parse(JSON.stringify(o));

/** S3's generated column in JS: JSON_VALUE(... RETURNING CHAR(255)). */
function projectText(v) {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v.slice(0, 255) : String(v);
}
function virtualize(row, defs, entity) {
  const bag = row && row.custom && typeof row.custom === 'object' ? row.custom : {};
  const out = { ...row };
  for (const d of defs.filter(d => d.entity === entity && d.active)) {
    out[d.field_key] = projectText(
      Object.prototype.hasOwnProperty.call(bag, d.field_key) ? bag[d.field_key] : undefined);
  }
  return out;
}

function world({ defs = DEFS(), cases = {}, contacts = {} } = {}) {
  const state = { defs: clone(defs), cases: clone(cases), contacts: clone(contacts),
                  sql: [], updates: [] };
  const query = async (sql, params = []) => {
    const s = norm(sql);
    state.sql.push(s);
    if (/FROM field_defs WHERE entity = \? ORDER BY sort_order ASC, id ASC$/.test(s)) {
      return [state.defs.filter(d => d.entity === params[0]).map(clone)];
    }
    if (/^SELECT COLUMN_NAME FROM information_schema.COLUMNS/.test(s)) {
      return [(COLUMNS[params[0]] || []).map(c => ({ COLUMN_NAME: c }))];
    }
    throw new Error('world: unscripted query — ' + s);
  };
  const conn = { query, beginTransaction: async () => {}, commit: async () => {},
                 rollback: async () => {}, release: () => {}, destroy: () => {} };
  return { state, query, getConnection: async () => conn, withTransaction: async fn => fn(conn) };
}

beforeEach(() => { fieldDefs.bump(); });

// ═════════════════════════════════════════════════════════════
// 1. The pilot defs themselves
// ═════════════════════════════════════════════════════════════

describe('S5 — the two pilot definitions', () => {
  test('are exactly the ruled pair: cf_ keys, text type, both entities', () => {
    expect(PILOT_DEFS.map(d => [d.entity, d.field_key, d.label, d.field_type])).toEqual([
      ['case',    'cf_clio_matter', 'Clio Matter ID',  'text'],
      ['contact', 'cf_clio_id',     'Clio Contact ID', 'text'],
    ]);
  });

  test('pass the registry validator that guards every def', async () => {
    // Not a formality: `clio_matter` / `contact_clio_id` CANNOT be validated
    // (^cf_ rejects them), which is the whole reason S5 repoints consumers
    // instead of keeping the names. Prove both halves.
    const db = world();
    for (const { _from, ...body } of PILOT_DEFS) {
      await expect(fieldDefs.validateDef(db, body, { isCreate: false })).resolves.toMatchObject({
        entity: body.entity, field_key: body.field_key, field_type: 'text',
      });
    }
    for (const bad of [
      { entity: 'case',    field_key: 'clio_matter',     label: 'x', field_type: 'text' },
      { entity: 'contact', field_key: 'contact_clio_id', label: 'x', field_type: 'text' },
    ]) {
      await expect(fieldDefs.validateDef(world(), bad, { isCreate: false }))
        .rejects.toThrow(/field_key must match/);
    }
  });

  test('are text, not number — a Clio id is an identifier (leading zeros survive)', () => {
    // §3 locks field_type once data exists, so this is a one-way door. The
    // live data settles it: '0001234' must round-trip, and it cannot as a
    // DECIMAL(18,4).
    expect(PILOT_DEFS.every(d => d.field_type === 'text')).toBe(true);
    expect(projectText('0001234')).toBe('0001234');
  });
});

// ═════════════════════════════════════════════════════════════
// 2. The write freeze
// ═════════════════════════════════════════════════════════════

describe('S5 — write freeze on cases.clio_matter', () => {
  const db = () => world({ cases: { C1: { case_id: 'C1', clio_matter: 'old', custom: {} } } });

  test('rejects clio_matter with a 400 that names cf_clio_matter', async () => {
    await expect(caseService.updateCase(db(), 'C1', { clio_matter: '999' }))
      .rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('"clio_matter" is retired — write "cf_clio_matter" instead'),
      });
  });

  test('rejects it however it is cased — MySQL column names are case-insensitive', async () => {
    for (const k of ['CLIO_MATTER', 'Clio_Matter']) {
      await expect(caseService.updateCase(db(), 'C1', { [k]: '999' }))
        .rejects.toMatchObject({ status: 400, message: expect.stringContaining('cf_clio_matter') });
    }
  });

  test('rejects the whole patch, not just the frozen key', async () => {
    // A partial apply would be the worst outcome: the caller sees an error and
    // half their edit landed.
    const w = db();
    await expect(caseService.updateCase(w, 'C1', { case_stage: 'filed', clio_matter: '999' }))
      .rejects.toMatchObject({ status: 400 });
    expect(w.state.updates).toHaveLength(0);
  });

  test('MUTATION CHECK — without the freeze the write would sail through', async () => {
    // Break the code, watch the test fail: this asserts the freeze is what
    // rejects it, not the S2 unknown-column gate. `clio_matter` IS a real
    // writable column in this world, so if the freeze were deleted the patch
    // would be accepted.
    const cols = await fieldDefs.writableColumns(db(), 'case');
    expect(cols.has('clio_matter')).toBe(true);
    const src = read('services/caseService.js');
    expect(src).toContain("const FROZEN = new Map([['clio_matter', 'cf_clio_matter']]);");
  });

  test('case_clio_id is NOT frozen — it is dead (0 rows) and simply dropped in S5-B', async () => {
    // Freezing it would be noise: nothing to diverge from.
    await expect(caseService.updateCase(db(), 'C1', { case_clio_id: 'x' }))
      .rejects.not.toMatchObject({ message: expect.stringContaining('is retired') });
  });
});

describe('S5 — write freeze on contacts.contact_clio_id', () => {
  const db = () => world({
    contacts: { 7: { contact_id: 7, contact_kind: 'person', contact_clio_id: 'old', custom: {} } },
  });

  test('rejects contact_clio_id with a 400 that names cf_clio_id', async () => {
    await expect(contactService.updateContact(db(), 7, { contact_clio_id: '555' }))
      .rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('"contact_clio_id" is retired — write "cf_clio_id" instead'),
      });
  });

  test('rejects it however it is cased', async () => {
    for (const k of ['CONTACT_CLIO_ID', 'Contact_Clio_Id']) {
      await expect(contactService.updateContact(db(), 7, { [k]: '555' }))
        .rejects.toMatchObject({ status: 400, message: expect.stringContaining('cf_clio_id') });
    }
  });

  test('fires even when the payload also carries aggregates', async () => {
    // The ALLOWED check runs on scalarFields, AFTER the aggregate strip. The
    // freeze runs on coreFields, BEFORE it — so an aggregate in the payload
    // cannot route a frozen key around it.
    await expect(contactService.updateContact(db(), 7, {
      contact_clio_id: '555', phones: [{ phone: '2485551212' }],
    })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('cf_clio_id') });
  });

  test('MUTATION CHECK — the key is still on the ALLOWED list, so only the freeze stops it', () => {
    const src = read('services/contactService.js');
    expect(src).toMatch(/ALLOWED = new Set\(\[[\s\S]*'contact_clio_id'/);
    expect(src).toContain("const FROZEN_COLUMNS = new Map([['contact_clio_id', 'cf_clio_id']]);");
  });
});

describe('S5 — the freeze is not a blanket refusal', () => {
  test('the cf_ keys themselves reach splitCustomFields and validate', async () => {
    const dbC = world();
    await expect(fieldDefs.splitCustomFields(dbC, 'case', { cf_clio_matter: '12345' }))
      .resolves.toMatchObject({ customSets: { cf_clio_matter: '12345' }, customKeys: ['cf_clio_matter'] });
    await expect(fieldDefs.splitCustomFields(world(), 'contact', { cf_clio_id: '555111' }))
      .resolves.toMatchObject({ customSets: { cf_clio_id: '555111' }, customKeys: ['cf_clio_id'] });
  });

  test('clearing a pilot field is a JSON_REMOVE, never a stored empty string', async () => {
    // §3: absent is how "no value" is spelled. This is what makes the
    // migration's `WHERE <col> <> ''` and `cf_x IS NULL` agree.
    const out = await fieldDefs.splitCustomFields(world(), 'contact', { cf_clio_id: '' });
    expect(out.customRemoves).toEqual(['cf_clio_id']);
    expect(out.customSets).toEqual({});
  });
});

// ═════════════════════════════════════════════════════════════
// 3. Repointed reads
// ═════════════════════════════════════════════════════════════

describe('S5 — consumers repointed off the frozen columns', () => {
  test('lookup_contact selects cf_clio_id and no longer selects contact_clio_id', () => {
    const src = read('lib/internal_functions/contacts.js');
    expect(src).toContain('cf_clio_id FROM contacts WHERE contact_id = ?');
    // Prose may still explain the move; no SELECT list may still name it.
    const selects = src.match(/SELECT [^`]*?FROM contacts/g) || [];
    expect(selects.length).toBeGreaterThan(0);
    for (const sel of selects) expect(sel).not.toContain('contact_clio_id');
    const coreCols = src.match(/const CORE_COLS = '([^']+)'/);
    expect(coreCols).not.toBeNull();
    expect(coreCols[1].split(', ')).not.toContain('contact_clio_id');
  });

  test('the trigger event-field catalog offers data.cf_clio_id, not the frozen path', () => {
    const src = read('services/triggerService.js');
    expect(src).toContain("path: 'data.cf_clio_id'");
    expect(src).not.toContain('data.contact_clio_id');
  });

  test('the report manifest marks clio_matter retired and points at the cf_ key', () => {
    const { TABLES } = require('../lib/reportSchema/manifest');
    const note = TABLES.cases.columns.clio_matter.note;
    expect(note).toMatch(/RETIRED/);
    expect(note).toContain('cf_clio_matter');
  });

  test('wf37\'s repoint script asserts its base before writing and its draft before publishing', () => {
    // The wf27 v6 rule (CLAUDE.md): a printed diff is not a check.
    const src = read('scripts/customFieldsS5Wf37Repoint.js');
    expect(src).toContain('BASE OK');
    expect(src).toContain('DRAFT OK');
    // It must never PUT the step list — only PATCH one step at a time.
    expect(src).toMatch(/\/steps\/\$\{e\.step\}`, 'PATCH'/);
    expect(src).not.toMatch(/'PUT'/);
    // And it must leave step 32's log payload key alone.
    expect(src).toContain('clio_matter');
  });
});

describe('S5 — lookup_contact survives an absent cf_ column', () => {
  const fns = require('../lib/internal_functions');

  test('returns the row WITH cf_clio_id when the column exists', async () => {
    const db = { query: async sql => {
      expect(norm(sql)).toContain('cf_clio_id');
      return [[{ contact_id: 7, contact_name: 'A One', cf_clio_id: '555111' }]];
    } };
    const out = await fns.lookup_contact({ contact_id: 7 }, db);
    expect(out.output.cf_clio_id).toBe('555111');
  });

  test('retries core-only on ER_BAD_FIELD_ERROR instead of taking the automation down', async () => {
    // The def can be absent (not yet created) or deactivated (the reconciler
    // DROPs the column). Neither may break every contact read.
    const seen = [];
    const db = { query: async sql => {
      seen.push(norm(sql));
      if (seen.length === 1) {
        const e = new Error("Unknown column 'cf_clio_id' in 'field list'");
        e.code = 'ER_BAD_FIELD_ERROR';
        throw e;
      }
      return [[{ contact_id: 7, contact_name: 'A One' }]];
    } };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await fns.lookup_contact({ contact_id: 7 }, db);
    warn.mockRestore();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('cf_clio_id');
    expect(seen[1]).not.toContain('cf_clio_id');
    expect(out.output.contact_name).toBe('A One');
    expect('cf_clio_id' in out.output).toBe(false);
  });

  test('any OTHER error still propagates — the guard is not a swallow-all', async () => {
    const db = { query: async () => {
      const e = new Error('Deadlock found when trying to get lock');
      e.code = 'ER_LOCK_DEADLOCK';
      throw e;
    } };
    await expect(fns.lookup_contact({ contact_id: 7 }, db)).rejects.toThrow(/Deadlock/);
  });
});

// ═════════════════════════════════════════════════════════════
// 4. The backfill round trip
// ═════════════════════════════════════════════════════════════

describe('S5 — backfill round trip: old column → JSON_SET → virtual column', () => {
  // The shapes that bite, mirroring the real-engine seed.
  const ROWS = [
    { id: 'C1', old: '1234567890' },
    { id: 'C2', old: '' },                        // stays absent
    { id: 'C3', old: '0001234' },                 // leading zeros
    { id: 'C4', old: 'ABCdef' },
    { id: 'C5', old: 'abcDEF' },                  // case variant of C4
    { id: 'C6', old: '99' },
    { id: 'C7', old: '12345678901234567890' },    // full varchar(20)
    { id: 'C8', old: '' },
  ];

  /** The migration's UPDATE, in JS: JSON_SET only where the column is non-''. */
  const migrate = rows => rows.map(r =>
    ({ ...r, custom: r.old !== '' ? { cf_clio_matter: r.old } : {} }));
  /** The virtual column off the migrated bag. */
  const colOf = r => projectText(
    Object.prototype.hasOwnProperty.call(r.custom, 'cf_clio_matter') ? r.custom.cf_clio_matter : undefined);
  /** V2 / V4: NOT (cf_x <=> NULLIF(old,'')). */
  const mismatches = rows => rows.filter(r => colOf(r) !== (r.old === '' ? null : r.old)).length;

  test('every value survives; empties leave the key ABSENT', () => {
    const after = migrate(ROWS);
    expect(after.map(colOf)).toEqual(
      ['1234567890', null, '0001234', 'ABCdef', 'abcDEF', '99', '12345678901234567890', null]);
    expect(after.filter(r => 'cf_clio_matter' in r.custom)).toHaveLength(6);
    // Not present-and-empty — that is the distinction the whole design rests on.
    expect(after.find(r => r.id === 'C2').custom).toEqual({});
  });

  test('V1/V3 counts agree and no bag grew a second key', () => {
    const after = migrate(ROWS);
    expect(after.filter(r => r.old !== '')).toHaveLength(6);
    expect(after.filter(r => colOf(r) !== null)).toHaveLength(6);
    expect(after.filter(r => Object.keys(r.custom).length > 1)).toHaveLength(0);
  });

  test('V2/V4 report zero mismatches on a clean migration', () => {
    expect(mismatches(migrate(ROWS))).toBe(0);
  });

  test('MUTATION CHECK — a poisoned value makes V2 bite', () => {
    const after = migrate(ROWS);
    after[0].custom.cf_clio_matter = 'WRONG';
    expect(mismatches(after)).toBe(1);
  });

  test('MUTATION CHECK — a dropped key makes V2 bite', () => {
    const after = migrate(ROWS);
    delete after[2].custom.cf_clio_matter;
    expect(mismatches(after)).toBe(1);
  });

  test('MUTATION CHECK — right counts, wrong rows: the COUNT query passes, V2 does not', () => {
    // This is why the migration ships V2/V4 and not just V1/V3. A swap keeps
    // both totals at 6 and would sail through a count-only check.
    const after = migrate(ROWS);
    after[1].custom.cf_clio_matter = 'x';            // C2 was ''
    delete after[2].custom.cf_clio_matter;           // C3 had a value
    expect(after.filter(r => r.old !== '')).toHaveLength(6);
    expect(after.filter(r => colOf(r) !== null)).toHaveLength(6);   // balanced
    expect(mismatches(after)).toBe(2);                               // caught
  });

  test('the migration file ships all four verification queries and the rollback', () => {
    const sql = read('ref/migrations/2026-09-25_clio_pilot_backfill.sql');
    expect(sql).toContain("JSON_SET(`custom`, '$.cf_clio_matter', `clio_matter`)");
    expect(sql).toContain("JSON_SET(`custom`, '$.cf_clio_id', `contact_clio_id`)");
    expect(sql).toContain("WHERE `clio_matter` <> ''");
    expect(sql).toContain("WHERE `contact_clio_id` <> ''");
    expect(sql).toContain('NOT (`cf_clio_matter` <=> NULLIF(`clio_matter`, \'\'))');
    expect(sql).toContain('NOT (`cf_clio_id` <=> NULLIF(`contact_clio_id`, \'\'))');
    expect(sql).toContain('JSON_REMOVE(`custom`, \'$.cf_clio_matter\')');
    // It must NOT touch the old columns — Phase B owns the drop.
    expect(sql).not.toMatch(/^\s*(ALTER TABLE|DROP)/m);
  });
});

// ═════════════════════════════════════════════════════════════
// 5. The wf37 repoint script, driven against the route's REAL shape
//
// The first cut of this script read `wf.name` / `wf.steps` off the top level
// of GET /workflows/:id. That route answers
// `{ success, workflow, steps, editing_version, has_draft }` — steps ARE top
// level, the metadata is NOT — so the guard passed and the dry run aborted on
// `name is "undefined"`. Nothing was written (the assertions did their job),
// but the shape was assumed from the handler's QUERY rather than its
// res.json. These tests drive the real script against the real envelope.
// ═════════════════════════════════════════════════════════════

describe('S5 — wf37 repoint script against the real route envelope', () => {
  // wf37 v1 as it stands live (the four steps verbatim; the other 34 are
  // filler, which is exactly what the "byte-identical" assertion must cover).
  const STEP = (n, label, config, note = '') =>
    ({ step_number: n, label, note, type: 'internal_function', config: JSON.stringify(config) });

  const LIVE_STEPS = () => {
    const steps = [];
    for (let n = 1; n <= 38; n++) {
      if (n === 3) steps.push(STEP(3, 'Have a Clio contact id?',
        { function_name: 'evaluate_condition', params: { else: 8, then: 4, operator: 'is_not_empty', variable: 'clioContactId' } },
        'HARD GUARD. An empty client_id is NOT ignored by Clio'));
      else if (n === 8) steps.push(STEP(8, 'Match tier 1: Clio id',
        { function_name: 'query_db', params: { from: 'contacts', limit: 5,
          where: [{ op: '=', value: '{{clioContactId}}', column: 'contacts.contact_clio_id' }],
          format: 'raw', select: ['contacts.contact_id', 'contacts.contact_name'],
          count_var: 'clioIdCount', output_var: 'clioIdMatches' } }, 'Exact, and free'));
      else if (n === 28) steps.push(STEP(28, 'Write contacts.contact_clio_id',
        { function_name: 'update_contact', params: { fields: { contact_clio_id: '{{clioContactId}}' }, contact_id: '{{contactId}}' } },
        'Self-healing'));
      else if (n === 32) steps.push(STEP(32, 'Log to timeline',
        { function_name: 'create_log', params: { type: 'other', data: { clio_matter: '{{clioMatterNo}}', source: 'clio_payment_failed' } } }));
      else steps.push(STEP(n, `step ${n}`, { function_name: 'noop', params: {} }, `note ${n}`));
    }
    return steps;
  };

  /** The route's envelope, verbatim: metadata nested, steps top level. */
  const envelope = (steps, over = {}) => ({
    success: true,
    workflow: { id: 37, name: 'Payment Failed — Intake', active: 0,
      current_version: 1, draft_version: null, step_count: steps.length,
      in_flight_executions: 0, ...over },
    steps,
    editing_version: over.draft_version ?? 1,
    has_draft: over.draft_version != null,
  });

  /** Load the IIFE fresh and hand it a scripted apiSend. */
  function load(send) {
    delete globalThis.s5Wf37Repoint;
    jest.isolateModules(() => {
      jest.resetModules();
      globalThis.apiSend = send;
      require('../scripts/customFieldsS5Wf37Repoint.js');
    });
    return globalThis.s5Wf37Repoint;
  }

  let log;
  beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { log.mockRestore(); delete globalThis.apiSend; });

  test('DRY RUN passes the base assertion against the real envelope', async () => {
    const run = load(async (url, method) => {
      expect(method).toBe('GET');
      return envelope(LIVE_STEPS());
    });
    await expect(run()).resolves.toEqual({ applied: false });
    const out = log.mock.calls.map(c => String(c[0])).join('\n');
    expect(out).toContain('BASE OK — wf37 v1, 38 steps, no draft, 0 in flight');
  });

  test('REGRESSION — a FLAT response aborts with a shape error, never "undefined"', async () => {
    // What the first cut assumed. It must fail loudly and name the cause.
    const flat = envelope(LIVE_STEPS());
    const run = load(async () => ({ ...flat.workflow, steps: flat.steps }));
    await expect(run()).rejects.toThrow(/response has no \.workflow — the route's shape changed/);
  });

  test('apply PATCHes exactly 3 steps, then asserts the whole draft', async () => {
    let steps = LIVE_STEPS();
    const patched = [];
    const run = load(async (url, method, body) => {
      if (method === 'GET') {
        return envelope(steps, patched.length ? { draft_version: 2 } : {});
      }
      const n = Number(url.split('/steps/')[1]);
      patched.push(n);
      steps = steps.map(s => Number(s.step_number) !== n ? s : {
        ...s,
        label:  body.label !== undefined ? body.label : s.label,
        note:   body.note  !== undefined ? body.note  : s.note,
        config: body.config !== undefined ? JSON.stringify(body.config) : s.config,
      });
      return { message: `Step ${n} updated` };
    });

    await expect(run('apply')).resolves.toMatchObject({ applied: true, published: false, draft_version: 2 });
    expect(patched.sort((a, b) => a - b)).toEqual([3, 8, 28]);

    const byNum = new Map(steps.map(s => [Number(s.step_number), JSON.parse(s.config)]));
    expect(byNum.get(8).params.where[0].column).toBe('contacts.cf_clio_id');
    expect(byNum.get(28).params.fields).toEqual({ cf_clio_id: '{{clioContactId}}' });
    // #3 is note-only, and #32's log payload key survives untouched.
    expect(byNum.get(3).params.variable).toBe('clioContactId');
    expect(byNum.get(32).params.data.clio_matter).toBe('{{clioMatterNo}}');
  });

  test('aborts before ANY write when the live base has drifted', async () => {
    const drifted = LIVE_STEPS().map(s => Number(s.step_number) !== 8 ? s : { ...s, label: 'Match tier 1: something else' });
    const calls = [];
    const run = load(async (url, method) => { calls.push(method); return envelope(drifted); });
    await expect(run('publish')).rejects.toThrow(/step #8 label is/);
    expect(calls).toEqual(['GET']);          // nothing was written
  });

  test('aborts when a draft is already open — never edits someone else\'s work', async () => {
    const run = load(async () => envelope(LIVE_STEPS(), { draft_version: 5 }));
    await expect(run()).rejects.toThrow(/an UNPUBLISHED DRAFT already exists \(v5\)/);
  });

  test('aborts when an execution is in flight', async () => {
    const run = load(async () => envelope(LIVE_STEPS(), { in_flight_executions: 2 }));
    await expect(run()).rejects.toThrow(/2 execution\(s\) in flight/);
  });

  // ── publish-draft: finishing an apply that already ran ──────────────────
  // 'publish' re-enters at the base assertion, which refuses to run while a
  // draft is open — so after an 'apply' there was no way to publish from the
  // script at all. Hit for real on 2026-09-25.

  /** The draft an 'apply' leaves behind: the three edits applied. */
  const REPOINTED = () => LIVE_STEPS().map(s => {
    const n = Number(s.step_number);
    if (n === 8) return { ...s, label: 'Match tier 1: Clio id',
      note: 'Exact, and free once the Clio id is populated. 245 contacts carried a Clio id at the S5 migration; tiers 2/3 write it back so this tier grows on its own. Reads the cf_clio_id custom field (S5, 2026-09-25) — the contact_clio_id column is frozen and dropped in S5-B.',
      config: JSON.stringify({ function_name: 'query_db', params: { count_var: 'clioIdCount', format: 'raw',
        from: 'contacts', limit: 5, output_var: 'clioIdMatches',
        select: ['contacts.contact_id', 'contacts.contact_name'],
        where: [{ column: 'contacts.cf_clio_id', op: '=', value: '{{clioContactId}}' }] } }) };
    if (n === 28) return { ...s, label: "Write the contact's Clio id",
      note: 'Self-healing: a tier-2/3 match teaches the system the mapping so the next failure for this client is an exact tier-1 hit. Writes the cf_clio_id custom field (S5, 2026-09-25); update_contact REFUSES contact_clio_id from here on.',
      config: JSON.stringify({ function_name: 'update_contact', params: { contact_id: '{{contactId}}', fields: { cf_clio_id: '{{clioContactId}}' } } }) };
    if (n === 3) return { ...s,
      note: 'HARD GUARD. An empty client_id is NOT ignored by Clio — it returns all 549 matters, so data[0].id would attach both tasks to an unrelated 2018 case. Also guards the tier-1 lookup: a contact with no Clio id reads NULL from cf_clio_id (the key is absent from the bag, never empty), so an unguarded blank would still be a pointless query.' };
    return s;
  });

  test('publish-draft re-asserts the draft, publishes, and leaves the workflow INACTIVE', async () => {
    let published = false;
    const run = load(async (url, method) => {
      if (method === 'POST') { published = true; return { success: true, version: 2 }; }
      return published
        ? envelope(REPOINTED(), { current_version: 2, draft_version: null })
        : envelope(REPOINTED(), { draft_version: 2 });
    });
    await expect(run('publish-draft')).resolves.toEqual({
      applied: false, published: true, current_version: 2, active: 0,
    });
    const out = log.mock.calls.map(c => String(c[0])).join('\n');
    expect(out).toContain('DRAFT v2 RE-ASSERTED');
    expect(out).toContain('STILL INACTIVE');
  });

  test('publish-draft REFUSES a draft that is not the S5 repoint', async () => {
    // Someone else's draft must never be published by this script.
    const someoneElses = REPOINTED().map(s => Number(s.step_number) !== 8 ? s
      : { ...s, config: JSON.stringify({ function_name: 'query_db', params: { from: 'contacts', where: [{ column: 'contacts.contact_email', op: '=', value: 'x' }] } }) });
    const calls = [];
    const run = load(async (url, method) => { calls.push(method); return envelope(someoneElses, { draft_version: 2 }); });
    await expect(run('publish-draft')).rejects.toThrow(/this draft is NOT the S5 repoint — refusing to publish it/);
    expect(calls).toEqual(['GET']);            // never POSTed
  });

  test('publish-draft with no draft open says so instead of publishing nothing', async () => {
    const run = load(async () => envelope(LIVE_STEPS()));
    await expect(run('publish-draft')).rejects.toThrow(/there is no draft to publish/);
  });

  test('publish-draft FAILS LOUDLY if publishing somehow enabled the workflow', async () => {
    // The guarantee being asserted is "publish != enable". If that ever stops
    // being true, this must not pass quietly.
    let published = false;
    const run = load(async (url, method) => {
      if (method === 'POST') { published = true; return { success: true }; }
      return published
        ? envelope(REPOINTED(), { current_version: 2, draft_version: null, active: 1 })
        : envelope(REPOINTED(), { draft_version: 2 });
    });
    await expect(run('publish-draft')).rejects.toThrow(/came back active=1 — publishing must NOT enable it/);
  });

  test('an unknown mode is rejected, and names publish-draft', async () => {
    const run = load(async () => envelope(LIVE_STEPS()));
    await expect(run('yolo')).rejects.toThrow(/unknown mode "yolo".*publish-draft/);
  });
});
