// tests/calendarTypeService.test.js
//
/**
 * Unified Events U2 — services/calendarTypeService.js
 *
 * Pins three promises:
 *   1. RESOLUTION ORDER  key → label → alias (ci + trim), null for blank,
 *      null + ONE warning for unmapped. Inactive types still resolve.
 *   2. CACHE + FAIL-SOFT  TTL, force, invalidate, prime; a registry read
 *      failure yields an empty registry (or the last good one) and NEVER throws.
 *   3. PARITY WITH THE FROZEN E1 VOCABULARY  every (raw → key) pair in
 *      typeKeyVocabulary.EVENT_TYPE_KEYS / APPT_TYPE_KEYS resolves to the SAME
 *      key against the seed the generator writes. This is the guarantee that
 *      write-time resolution == backfill == E1's original derivation. If it
 *      fails, the SEED is wrong (scripts/calendarTypeSeed.js) — fix the seed,
 *      not the test.
 *
 *      U3 MOVED THE SOURCE, NOT THE CONTENT. The maps used to live in
 *      services/caseEventService.js; that service now reads the `type_key`
 *      COLUMN and imports no vocabulary at all. The maps themselves are
 *      byte-identical in their new home (scripts/typeKeyVocabulary.js), so this
 *      test asserts exactly what it asserted at U2.
 *
 * The seed is read from tests/fixtures/calendar_item_types.seed.json (written
 * by scripts/genTypeKeyBackfill.js --write; byte-checked in
 * tests/genTypeKeyBackfill.test.js).
 *
 * Run:  npx jest tests/calendarTypeService.test.js
 */

'use strict';

const path = require('path');
const svc  = require('../services/calendarTypeService');
const SEED = require('./fixtures/calendar_item_types.seed.json');
const vocabulary = require('../scripts/typeKeyVocabulary');

/** A db whose ONLY query is the registry SELECT; JSON columns as MySQL strings. */
function registryDb(rows = SEED, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (fail) throw new Error('ER_NO_SUCH_TABLE: calendar_item_types');
      if (!/FROM calendar_item_types/.test(sql)) throw new Error('unexpected query: ' + sql);
      return [rows.map((r) => ({
        ...r,
        ingest_aliases: JSON.stringify(r.ingest_aliases || []),
        case_types:     r.case_types == null ? null : JSON.stringify(r.case_types),
      }))];
    },
  };
}

beforeEach(() => {
  svc.invalidate();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  console.warn.mockRestore();
  svc.invalidate();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('resolveTypeKey — match order', () => {
  test('exact key (ci, trim)', async () => {
    const db = registryDb();
    expect(await svc.resolveTypeKey(db, 'confirmation_hearing'))
      .toEqual({ type_key: 'confirmation_hearing', kind: 'hearing', matched: 'key' });
    expect(await svc.resolveTypeKey(db, '  Confirmation_Hearing '))
      .toEqual({ type_key: 'confirmation_hearing', kind: 'hearing', matched: 'key' });
  });

  test('label (ci, trim)', async () => {
    const db = registryDb();
    expect(await svc.resolveTypeKey(db, 'Confirmation Hearing'))
      .toEqual({ type_key: 'confirmation_hearing', kind: 'hearing', matched: 'label' });
    // the dominant live spelling of the second-commonest appt type
    expect(await svc.resolveTypeKey(db, 'Pre-filing Meeting'))
      .toEqual({ type_key: 'pre_filing', kind: 'meeting', matched: 'label' });
    expect(await svc.resolveTypeKey(db, 'Meeting'))            // 108 live rows spell it this way
      .toEqual({ type_key: 'meeting', kind: 'meeting', matched: 'key' });   // key 'meeting' matches first (ci)
  });

  test('ingest alias (ci, trim)', async () => {
    const db = registryDb();
    expect(await svc.resolveTypeKey(db, 'Show Cause'))
      .toEqual({ type_key: 'show_cause', kind: 'hearing', matched: 'alias' });
    expect(await svc.resolveTypeKey(db, 'court date'))
      .toEqual({ type_key: 'hearing', kind: 'hearing', matched: 'alias' });
    expect(await svc.resolveTypeKey(db, 'Tax Consultation'))     // booking_views id 6
      .toEqual({ type_key: 'tax_consult', kind: 'meeting', matched: 'alias' });
    expect(await svc.resolveTypeKey(db, 'Potato Hunting'))       // booking_views id 2
      .toEqual({ type_key: 'test', kind: 'other', matched: 'alias' });
  });

  test('inactive types still resolve — active gates pickers, not identity', async () => {
    const db = registryDb();
    const r = await svc.resolveTypeKey(db, 'Pizza Party');
    expect(r.type_key).toBe('test');
    expect(SEED.find((s) => s.type_key === 'test').active).toBe(0);
  });

  test('NULL / blank → nulls, NO warning (absent data is not an unknown string)', async () => {
    const db = registryDb();
    for (const v of [null, undefined, '', '   ']) {
      expect(await svc.resolveTypeKey(db, v)).toEqual({ type_key: null, kind: null, matched: null });
    }
    expect(console.warn).not.toHaveBeenCalled();
  });

  test('unmapped → nulls + exactly ONE warning per raw per process', async () => {
    const db = registryDb();
    expect(await svc.resolveTypeKey(db, 'Mediation')).toEqual({ type_key: null, kind: null, matched: null });
    expect(await svc.resolveTypeKey(db, 'Mediation')).toEqual({ type_key: null, kind: null, matched: null });
    expect(await svc.resolveTypeKey(db, ' mediation ')).toEqual({ type_key: null, kind: null, matched: null });
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn.mock.calls[0][0]).toMatch(/unmapped type/);
  });
});

describe('getType — keys only', () => {
  test('finds by key (ci), never by label or alias', async () => {
    const db = registryDb();
    expect((await svc.getType(db, 'ISS')).type_key).toBe('iss');
    expect(await svc.getType(db, 'Initial Strategy Session')).toBeNull();
    expect(await svc.getType(db, 'Show Cause')).toBeNull();
    expect(await svc.getType(db, '')).toBeNull();
    expect(await svc.getType(db, null)).toBeNull();
  });
});

describe('listTypes — picker filters', () => {
  test('kind CSV / array, active, case_type; registry order', async () => {
    const db = registryDb();
    const hearings = await svc.listTypes(db, { kind: 'hearing' });
    expect(hearings.map((r) => r.type_key)).toEqual(['confirmation_hearing', 'show_cause', 'hearing', 'trial']);

    const evKinds = await svc.listTypes(db, { kind: ['hearing', 'deadline', 'conference', 'other'], active: '1' });
    expect(evKinds.some((r) => r.kind === 'meeting')).toBe(false);
    expect(evKinds.some((r) => r.type_key === 'test')).toBe(false);   // inactive excluded
    expect(evKinds.some((r) => r.type_key === 'internal')).toBe(true);

    const inactive = await svc.listTypes(db, { active: '0' });
    expect(inactive.map((r) => r.type_key)).toEqual(['test']);

    const civ = await svc.listTypes(db, { kind: 'meeting', case_type: 'civil litigation' });
    expect(civ.some((r) => r.type_key === 'pre_lawsuit')).toBe(true);
    expect(civ.some((r) => r.type_key === 'pre_filing')).toBe(false);   // scoped to Bankruptcy
    expect(civ.some((r) => r.type_key === 'iss')).toBe(true);           // NULL = all case types

    const all = await svc.listTypes(db);
    expect(all).toHaveLength(SEED.length);
    // sorted by sort_order then type_key
    const orders = all.map((r) => r.sort_order);
    expect(orders).toEqual(orders.slice().sort((a, b) => a - b));
  });

  test('returned rows are copies — mutating them cannot poison the cache', async () => {
    const db = registryDb();
    const [row] = await svc.listTypes(db, { kind: 'hearing' });
    row.ingest_aliases.push('POISON');
    row.label = 'POISON';
    expect((await svc.getType(db, 'confirmation_hearing')).label).toBe('Confirmation Hearing');
    expect(await svc.resolveTypeKey(db, 'POISON')).toEqual({ type_key: null, kind: null, matched: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('cache', () => {
  test('one query per TTL; force bypasses; invalidate drops', async () => {
    const db = registryDb();
    await svc.resolveTypeKey(db, 'iss');
    await svc.resolveTypeKey(db, 'ss');
    await svc.listTypes(db);
    expect(db.calls).toHaveLength(1);

    await svc.loadRegistry(db, { force: true });
    expect(db.calls).toHaveLength(2);

    svc.invalidate();
    await svc.getType(db, 'iss');
    expect(db.calls).toHaveLength(3);
  });

  test('TTL expiry triggers a reload', async () => {
    const db = registryDb();
    const realNow = Date.now;
    try {
      let t = 1_000_000;
      Date.now = () => t;
      await svc.resolveTypeKey(db, 'iss');
      t += svc._TTL_MS - 1;
      await svc.resolveTypeKey(db, 'iss');
      expect(db.calls).toHaveLength(1);
      t += 2;
      await svc.resolveTypeKey(db, 'iss');
      expect(db.calls).toHaveLength(2);
    } finally {
      Date.now = realNow;
    }
  });

  test('_primeCache: no query is ever issued; primed cache does not expire', async () => {
    svc._primeCache(SEED);
    const db = { query: jest.fn(async () => { throw new Error('must not be called'); }) };
    expect((await svc.resolveTypeKey(db, '341 Meeting')).type_key).toBe('meeting_341');
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 10 * svc._TTL_MS;
      expect((await svc.resolveTypeKey(db, '341')).type_key).toBe('meeting_341');
    } finally { Date.now = realNow; }
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('fail-soft (Fred, U2 R1.2)', () => {
  test('registry read failure with no cache → empty registry, nulls, ONE throttled warning, no throw', async () => {
    const db = registryDb(SEED, { fail: true });
    await expect(svc.resolveTypeKey(db, 'Initial Strategy Session')).resolves
      .toEqual({ type_key: null, kind: null, matched: null });
    await expect(svc.listTypes(db)).resolves.toEqual([]);
    await expect(svc.getType(db, 'iss')).resolves.toBeNull();
    const loadWarns = console.warn.mock.calls.filter((c) => /registry load failed/.test(c[0]));
    expect(loadWarns).toHaveLength(1);
    expect(loadWarns[0][0]).toMatch(/EMPTY registry/);
  });

  test('a failed REFRESH keeps serving the last good registry', async () => {
    const good = registryDb();
    await svc.resolveTypeKey(good, 'iss');
    const bad = registryDb(SEED, { fail: true });
    await svc.loadRegistry(bad, { force: true });   // refresh fails
    expect((await svc.resolveTypeKey(bad, 'iss')).type_key).toBe('iss');
    const loadWarns = console.warn.mock.calls.filter((c) => /registry load failed/.test(c[0]));
    expect(loadWarns).toHaveLength(1);
    expect(loadWarns[0][0]).toMatch(/last good cache/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('write-path helpers', () => {
  test('resolveForCreate: a given key that exists wins; an unknown given key falls back to the label (+1 warn)', async () => {
    const db = registryDb();
    expect(await svc.resolveForCreate(db, 'ss', 'Initial Strategy Session'))
      .toEqual({ type_key: 'ss', kind: 'meeting', matched: 'key' });
    expect(await svc.resolveForCreate(db, 'nope', 'Initial Strategy Session'))
      .toEqual({ type_key: 'iss', kind: 'meeting', matched: 'label' });
    expect(await svc.resolveForCreate(db, '', 'Show Cause'))
      .toEqual({ type_key: 'show_cause', kind: 'hearing', matched: 'alias' });
    expect(await svc.resolveForCreate(db, null, null))
      .toEqual({ type_key: null, kind: null, matched: null });
    expect(console.warn.mock.calls.filter((c) => /unknown type_key "nope"/.test(c[0]))).toHaveLength(1);
  });

  test('applyApptTypePatch: label-only patch gains the key; given key validated + canonicalized; blank key derives or nulls', async () => {
    const db = registryDb();
    expect(await svc.applyApptTypePatch(db, { appt_type: 'Pre-filing Meeting', appt_note: 'x' }))
      .toEqual({ appt_type: 'Pre-filing Meeting', appt_note: 'x', type_key: 'pre_filing' });
    expect(await svc.applyApptTypePatch(db, { type_key: ' ISS ' }))
      .toEqual({ type_key: 'iss' });
    expect(await svc.applyApptTypePatch(db, { type_key: 'iss', appt_type: 'Strategy Session' }))
      .toEqual({ type_key: 'iss', appt_type: 'Strategy Session' });   // given key wins; label untouched
    expect(await svc.applyApptTypePatch(db, { type_key: '', appt_type: 'Strategy Session' }))
      .toEqual({ type_key: 'ss', appt_type: 'Strategy Session' });
    expect(await svc.applyApptTypePatch(db, { type_key: null }))
      .toEqual({ type_key: null });
    expect(await svc.applyApptTypePatch(db, { appt_type: 'Mediation' }))
      .toEqual({ appt_type: 'Mediation', type_key: null });
    expect(await svc.applyApptTypePatch(db, { appt_note: 'only' }))
      .toEqual({ appt_note: 'only' });

    await expect(svc.applyApptTypePatch(db, { type_key: 'bogus' }, { errorPrefix: 'PATCH /api/appts' }))
      .rejects.toMatchObject({ status: 400, message: 'PATCH /api/appts: unknown type_key "bogus"' });
  });

  test('applyApptTypePatch does not mutate its input', async () => {
    const db = registryDb();
    const input = { appt_type: 'Strategy Session' };
    await svc.applyApptTypePatch(db, input);
    expect(input).toEqual({ appt_type: 'Strategy Session' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PARITY WITH E1 — the load-bearing test of this slice
// ─────────────────────────────────────────────────────────────────────────────
describe('parity: the frozen E1 vocabulary → registry seed', () => {
  beforeEach(() => svc._primeCache(SEED));

  test('every E1 EVENT raw resolves to the same type_key AND kind', async () => {
    const db = { query: async () => { throw new Error('primed — no query expected'); } };
    const misses = [];
    for (const [raw, [key, kind]] of vocabulary.EVENT_TYPE_KEYS.entries()) {
      const r = await svc.resolveTypeKey(db, raw);
      if (r.type_key !== key || r.kind !== kind) misses.push({ raw, e1: [key, kind], registry: [r.type_key, r.kind] });
    }
    expect(misses).toEqual([]);
    expect(vocabulary.EVENT_TYPE_KEYS.size).toBeGreaterThan(20);   // the loop ran
  });

  test('every E1 APPT raw resolves to the same type_key (kind is meeting-by-table on appts)', async () => {
    const db = { query: async () => { throw new Error('primed — no query expected'); } };
    const misses = [];
    let skipped = 0;
    for (const [raw, [key]] of vocabulary.APPT_TYPE_KEYS.entries()) {
      // ONE explicit exclusion (U2 §2): E1 carries the LITERAL string 'None'
      // (0 live rows; SQL NULL is handled separately). It is NOT an alias and
      // must not become one — skip it rather than teach the registry a lie.
      if (raw === 'none') { skipped += 1; continue; }
      const r = await svc.resolveTypeKey(db, raw);
      if (r.type_key !== key) misses.push({ raw, e1: key, registry: r.type_key });
    }
    expect(misses).toEqual([]);
    expect(skipped).toBe(1);
    expect(await svc.resolveTypeKey(db, 'None')).toEqual({ type_key: null, kind: null, matched: null });
  });

  test('every E1 row-override key exists in the seed with the same kind', () => {
    for (const [, [key, kind]] of vocabulary.EVENT_ROW_OVERRIDES.entries()) {
      const row = SEED.find((s) => s.type_key === key);
      expect(row).toBeDefined();
      expect(row.kind).toBe(kind);
    }
  });

  test('registry kind enum == events.kind enum order (E0a) — D1', () => {
    expect(svc.KINDS).toEqual(['hearing', 'meeting', 'deadline', 'conference', 'other']);
    for (const s of SEED) expect(svc.KINDS).toContain(s.kind);
  });

  test('no alias equals its own row label under ci (D5), and no alias is claimed twice', () => {
    const seen = new Map();
    for (const s of SEED) {
      for (const a of s.ingest_aliases) {
        expect(svc._norm(a)).not.toBe(svc._norm(s.label));
        expect(seen.has(svc._norm(a))).toBe(false);
        seen.set(svc._norm(a), s.type_key);
      }
    }
    // and no alias collides with another row's key or label
    for (const s of SEED) {
      expect(seen.has(svc._norm(s.type_key)) && seen.get(svc._norm(s.type_key)) !== s.type_key).toBe(false);
      expect(seen.has(svc._norm(s.label))    && seen.get(svc._norm(s.label))    !== s.type_key).toBe(false);
    }
    expect(SEED).toHaveLength(34);
    expect(path.basename(require.resolve('./fixtures/calendar_item_types.seed.json'))).toBe('calendar_item_types.seed.json');
  });
});
