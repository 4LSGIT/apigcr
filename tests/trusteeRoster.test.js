// tests/trusteeRoster.test.js
//
/**
 * Slice 7 — lib/trusteeRoster, and the behavior-preservation proofs the
 * cutover hangs on:
 *
 *   1. _buildEntry / _chapters   — shape contract, chapter explosion
 *   2. loadTrusteeRoster         — SQL, ordering, explosion end-to-end over
 *                                  a stub db (dispatch-on-SQL-text idiom,
 *                                  tests/contactOrgKind.test.js style)
 *   3. GOLDEN EQUIVALENCE        — a setting-shaped fixture roster vs the
 *                                  builder over equivalent stubbed rows:
 *                                  deep-equal, entry for entry
 *   4. McDONALD VARIANT PROOF    — both retired name variants still match
 *                                  the built roster (chaptered), and which
 *                                  lane each uses
 *   5. buildContext (esign)      — the roster lands on the ctx under
 *                                  _TRUSTEE_ROSTER; a loader failure
 *                                  degrades to an absent key, never a throw
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

const { loadTrusteeRoster, _buildEntry, _chapters } = require('../lib/trusteeRoster');
const { matchTrustee } = require('../lib/trusteeMatch');

// ── stub rows: the contacts+role join shape the builder SELECTs ────────────
const ROW = (over = {}) => ({
  contact_id: 2085,
  attrs: { chapter: 13, zoom_link: 'https://z/carr' },
  contact_name: 'Krispen S. Carroll', contact_lname: 'Carroll',
  contact_email: 'reception@det13ksc.com', contact_phone: '3139625035',
  contact_address: '719 Griswold Street, Suite 1100',
  contact_city: 'Detroit', contact_state: 'MI', contact_zip: '48226',
  ...over,
});

function rosterDb(rows) {
  return {
    query: async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ');
      expect(s).toMatch(/FROM contact_roles cr JOIN contacts c/);
      expect(s).toMatch(/cr\.role = 'trustee' AND cr\.active = 1/);
      return [rows];
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. _buildEntry / _chapters
// ─────────────────────────────────────────────────────────────────────────────

describe('_buildEntry', () => {
  test('produces EXACTLY the legacy fe-trustees key set', () => {
    const e = _buildEntry(ROW(), 13);
    expect(Object.keys(e).sort()).toEqual([
      'address1', 'address2', 'case_type', 'city', 'contact_id',
      'email', 'link', 'lname', 'name', 'phone', 'state', 'zip',
    ]);
  });

  test('field mapping: contacts columns + attrs, address2 always empty', () => {
    expect(_buildEntry(ROW(), 13)).toEqual({
      name: 'Krispen S. Carroll', lname: 'Carroll', case_type: 13,
      link: 'https://z/carr', email: 'reception@det13ksc.com',
      phone: '3139625035', address1: '719 Griswold Street, Suite 1100',
      address2: '', city: 'Detroit', state: 'MI', zip: '48226',
      contact_id: 2085,
    });
  });

  test('attrs arrives as a JSON STRING (driver variance) — still parsed', () => {
    const e = _buildEntry(ROW({ attrs: '{"chapter":7,"zoom_link":"https://z/x"}' }), 7);
    expect(e.link).toBe('https://z/x');
  });

  test('null chapter → case_type null (eligible for every chapter per rule 0)', () => {
    const e = _buildEntry(ROW({ attrs: {} }), null);
    expect(e.case_type).toBeNull();
    expect(e.link).toBe('');
  });
});

describe('_chapters', () => {
  test.each([
    ['scalar',        { chapter: 7 },        [7]],
    ['array',         { chapter: [12, 13] }, [12, 13]],
    ['missing',       {},                    [null]],
    ['empty string',  { chapter: '' },       [null]],
    ['empty array',   { chapter: [] },       [null]],
    ['string attrs',  '{"chapter":[7,11]}',  [7, 11]],
    ['garbage attrs', '{oops',               [null]],
  ])('%s', (_n, attrs, want) => {
    expect(_chapters(attrs)).toEqual(want);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. loadTrusteeRoster — explosion + ordering over the stub db
// ─────────────────────────────────────────────────────────────────────────────

describe('loadTrusteeRoster', () => {
  test('a chapter ARRAY explodes into one entry per chapter, same contact_id and name', async () => {
    const roster = await loadTrusteeRoster(rosterDb([
      ROW({ contact_id: 2082, contact_name: 'Thomas W. McDonald',
            contact_lname: 'McDonald',
            attrs: { chapter: [12, 13], zoom_link: 'https://z/mcd' } }),
    ]));
    expect(roster).toHaveLength(2);
    expect(roster.map((e) => e.case_type)).toEqual([12, 13]);
    expect(new Set(roster.map((e) => e.contact_id))).toEqual(new Set([2082]));
    expect(new Set(roster.map((e) => e.name))).toEqual(new Set(['Thomas W. McDonald']));
  });

  test('stable order: name (ci), then numeric case_type', async () => {
    const roster = await loadTrusteeRoster(rosterDb([
      ROW({ contact_id: 3, contact_name: 'alpha Person', attrs: { chapter: 13 } }),
      ROW({ contact_id: 1, contact_name: 'Beta Person',  attrs: { chapter: [13, 7] } }),
    ]));
    expect(roster.map((e) => [e.name, e.case_type])).toEqual([
      ['alpha Person', 13], ['Beta Person', 7], ['Beta Person', 13],
    ]);
  });

  test('empty result set → [] (matchTrustee maps it to no_roster)', async () => {
    const roster = await loadTrusteeRoster(rosterDb([]));
    expect(roster).toEqual([]);
    expect(matchTrustee({ extracted: 'Anyone', chapter: '7', roster }).status)
      .toBe('no_roster');
  });

  test('a query failure THROWS — callers own their degrade policy', async () => {
    const db = { query: async () => { throw new Error('pool exhausted'); } };
    await expect(loadTrusteeRoster(db)).rejects.toThrow(/pool exhausted/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GOLDEN EQUIVALENCE — setting-shaped fixture vs builder-built
// ─────────────────────────────────────────────────────────────────────────────

describe('golden equivalence with the setting-era shape', () => {
  // A setting-era roster whose data happens to sit in contacts exactly the
  // way the seed left it (digits phone, joined address, lowercased email) —
  // over ALIGNED data the two loaders must be indistinguishable.
  const SETTING_SHAPED = [
    { name: 'Basil T. Simon', lname: 'Simon', case_type: 7,
      link: 'https://z/simon', email: 'bsimon@sszpc.com', phone: '3139626400',
      address1: '645 Griswold, Suite 3466', address2: '',
      city: 'Detroit', state: 'MI', zip: '48226', contact_id: 2066 },
    { name: 'Thomas W. McDonald', lname: 'McDonald', case_type: 12,
      link: 'https://z/mcd', email: 'tom@mcdonald13.org', phone: '9897926766',
      address1: '3144 Davenport Avenue', address2: '',
      city: 'Saginaw', state: 'MI', zip: '48602', contact_id: 2082 },
    { name: 'Thomas W. McDonald', lname: 'McDonald', case_type: 13,
      link: 'https://z/mcd', email: 'tom@mcdonald13.org', phone: '9897926766',
      address1: '3144 Davenport Avenue', address2: '',
      city: 'Saginaw', state: 'MI', zip: '48602', contact_id: 2082 },
  ];

  const STUB_ROWS = [
    { contact_id: 2066, attrs: { chapter: 7, zoom_link: 'https://z/simon' },
      contact_name: 'Basil T. Simon', contact_lname: 'Simon',
      contact_email: 'bsimon@sszpc.com', contact_phone: '3139626400',
      contact_address: '645 Griswold, Suite 3466',
      contact_city: 'Detroit', contact_state: 'MI', contact_zip: '48226' },
    { contact_id: 2082, attrs: { chapter: [12, 13], zoom_link: 'https://z/mcd' },
      contact_name: 'Thomas W. McDonald', contact_lname: 'McDonald',
      contact_email: 'tom@mcdonald13.org', contact_phone: '9897926766',
      contact_address: '3144 Davenport Avenue',
      contact_city: 'Saginaw', contact_state: 'MI', contact_zip: '48602' },
  ];

  test('builder output deep-equals the setting-shaped roster, entry for entry', async () => {
    const built = await loadTrusteeRoster(rosterDb(STUB_ROWS));
    expect(built).toEqual(SETTING_SHAPED);
  });

  test('matchTrustee verdicts are IDENTICAL over both rosters for every live case_trustee shape', async () => {
    const built = await loadTrusteeRoster(rosterDb(STUB_ROWS));
    const probes = [
      ['Basil T. Simon', '7'],   ['Basil T.  Simon', '7'],   // double-space live row
      ['Simon', '7'],            ['B. Simon', '7'],
      ['Thomas W. McDonald', '12'], ['Thomas W. McDonald', '13'],
      ['Nobody At All', '7'],    ['Basil T. Simon', '13'],   // chapter_mismatch
    ];
    for (const [extracted, chapter] of probes) {
      const a = matchTrustee({ extracted, chapter, roster: SETTING_SHAPED });
      const b = matchTrustee({ extracted, chapter, roster: built });
      expect({ probe: [extracted, chapter], status: b.status, method: b.method || null,
               name: b.entry ? b.entry.name : null })
        .toEqual({ probe: [extracted, chapter], status: a.status, method: a.method || null,
                   name: a.entry ? a.entry.name : null });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. McDONALD VARIANT PROOF — the retired spellings against the BUILT roster
// ─────────────────────────────────────────────────────────────────────────────

describe('McDonald retired-variant matching (cutover proof)', () => {
  let roster;
  beforeAll(async () => {
    roster = await loadTrusteeRoster(rosterDb([
      ROW({ contact_id: 2082, contact_name: 'Thomas W. McDonald',
            contact_lname: 'McDonald',
            attrs: { chapter: [12, 13], zoom_link: 'https://z/mcd' } }),
      ROW(), // Carroll ch13 — a second ch13 entry, so the lname pass is honest
    ]));
  });

  test("'Thomas W. McDonald' on a Ch12 case → matched via the EXACT lane", () => {
    const r = matchTrustee({ extracted: 'Thomas W. McDonald', chapter: '12', roster });
    expect(r).toMatchObject({ status: 'matched', method: 'exact' });
    expect(r.entry.contact_id).toBe(2082);
    expect(r.entry.case_type).toBe(12);
  });

  test("'Thomas W. Jr. McDonald' (retired spelling) on a Ch13 case → matched via the LNAME lane", () => {
    const r = matchTrustee({ extracted: 'Thomas W. Jr. McDonald', chapter: '13', roster });
    expect(r).toMatchObject({ status: 'matched', method: 'lname' });
    expect(r.entry.contact_id).toBe(2082);
    expect(r.entry.case_type).toBe(13);
  });

  test('UNCHAPTERED McDonald is now AMBIGUOUS (two exploded same-name entries) — alert, never guess', () => {
    // Pre-cutover the ch12 spelling exact-hit its single entry unchaptered.
    // Post-cutover the exploded pair share one name, so no chapter → the
    // safe failure mode. Pinned so the change is a documented decision, not
    // drift.
    const r = matchTrustee({ extracted: 'Thomas W. McDonald', chapter: '', roster });
    expect(r.status).toBe('ambiguous');
    expect(r.candidates).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. esign buildContext loads the roster onto the ctx
// ─────────────────────────────────────────────────────────────────────────────

describe('esignPrefillService.buildContext roster injection', () => {
  const prefill = require('../services/esignPrefillService');

  // db stub: dispatch on SQL text; the roster query flows to rosterRows.
  function ctxDb(caseRow, rosterRows) {
    return {
      query: async (sql) => {
        const s = String(sql).replace(/\s+/g, ' ');
        if (/FROM cases WHERE case_id/.test(s)) return [[caseRow]];
        if (/FROM case_relate/.test(s)) return [[]];
        if (/FROM contact_roles cr JOIN contacts c/.test(s)) {
          if (rosterRows instanceof Error) throw rosterRows;
          return [rosterRows];
        }
        throw new Error(`unexpected SQL: ${s}`);
      },
    };
  }

  test('a case naming a trustee gets the roster under _TRUSTEE_ROSTER, and trustee.* resolves from it', async () => {
    const db = ctxDb({ case_id: 'AB12CD34', case_trustee: 'Krispen S. Carroll' }, [ROW()]);
    const ctx = await prefill.buildContext(db, { linkableType: 'case', linkableId: 'AB12CD34' });
    expect(Array.isArray(ctx[prefill._TRUSTEE_ROSTER])).toBe(true);
    expect(Object.keys(ctx)).toEqual(['caseRow', 'debtor1', 'debtor2']); // non-enumerable
    expect(await prefill.RESOLVERS['trustee.name'](ctx)).toBe('Krispen S. Carroll');
    // Token identity across the shape change (proof F): the seed stored the
    // joined street in ONE column and digits-only phone; the resolvers emit
    // byte-identical documents from either era's entry shape.
    expect(await prefill.RESOLVERS['trustee.address_street'](ctx))
      .toBe('719 Griswold Street, Suite 1100');
    expect(await prefill.RESOLVERS['trustee.address_csz'](ctx)).toBe('Detroit, MI 48226');
    expect(await prefill.RESOLVERS['trustee.phone'](ctx)).toBe('(313) 962-5035');
    expect(await prefill.RESOLVERS['trustee.email'](ctx)).toBe('reception@det13ksc.com');
  });

  test('no case_trustee on the case → the roster is NOT loaded', async () => {
    const db = ctxDb({ case_id: 'AB12CD34', case_trustee: '' },
      new Error('roster query must not run'));
    const ctx = await prefill.buildContext(db, { linkableType: 'case', linkableId: 'AB12CD34' });
    expect(ctx[prefill._TRUSTEE_ROSTER]).toBeUndefined();
  });

  test('roster load failure NEVER throws out of buildContext — trustee.* degrade to ""', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = ctxDb({ case_id: 'AB12CD34', case_trustee: 'Krispen S. Carroll' },
        new Error('pool exhausted'));
      const ctx = await prefill.buildContext(db, { linkableType: 'case', linkableId: 'AB12CD34' });
      expect(ctx[prefill._TRUSTEE_ROSTER]).toBeUndefined();
      expect(await prefill.RESOLVERS['trustee.name'](ctx)).toBe('');
    } finally {
      warn.mockRestore();
    }
  });
});
