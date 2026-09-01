// tests/esignPrefill.notice.test.js
//
// G4 — the Notice of Filing resolvers, and the template that consumes them.
//
//   1. composeCsz            the truth table, both source shapes
//   2. ssn_last4 / ssn_masked  digits-only, the length gate, the mask
//   3. case.judge/trustee/file_date
//   4. debtor1/2 address     including debtor2-absent -> all ''
//   5. trustee.*             exact match, case-insensitive, no match,
//                            non-array setting, missing case_trustee, memoization
//   6. ref/templates/notice_of_bankruptcy_filing.json through the REAL
//      validateTemplateInput with the REAL RESOLVER_NAMES
//
// firmConfig is mocked the way tests/esignSend.test.js does it (a jest.fn cfg),
// because the trustee resolvers read the fe-trustees setting through cfgJson,
// which is cfg() + JSON.parse. Mocking cfg alone therefore controls both.

jest.mock('../lib/firmConfig', () => ({
  cfg: jest.fn(() => null),
  cfgJson: jest.fn((key, fallback = null) => {
    // Mirror the real implementation's contract exactly: read through cfg,
    // NEVER throw, fall back on unset or unparseable. A test that stubbed this
    // to return objects directly would not prove the malformed-JSON path.
    const raw = require('../lib/firmConfig').cfg(key);
    if (raw == null || String(raw).trim() === '') return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  }),
}));

const { cfg } = require('../lib/firmConfig');
const prefill = require('../services/esignPrefillService');
const templateService = require('../services/esignTemplateService');

const R = prefill.RESOLVERS;
const { _composeCsz: composeCsz, _ssnLast4: ssnLast4, _ssnMasked: ssnMasked } = prefill;

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES
// ─────────────────────────────────────────────────────────────────────────────

// Two real roster entries, verbatim in shape from the live fe-trustees setting
// (read 2026-09-01). The McDonald PAIR is the whole reason matching is
// exact-name: a surname match returns whichever comes first and puts the wrong
// trustee's address on a mailed notice.
const TRUSTEES = [
  { name: 'Krispen S. Carroll', lname: 'Carroll', case_type: 13,
    email: 'notice@det13ksc.com', phone: '(313) 962-5035',
    address1: '719 Griswold Street', address2: 'Suite 1100',
    city: 'Detroit', state: 'MI', zip: '48226', link: 'https://example.test/z' },
  { name: 'Thomas W. McDonald', lname: 'McDonald', case_type: 12,
    email: 'ch12@example.test', phone: '(989) 555-0112',
    address1: 'P.O. Box 5856', address2: '',
    city: 'Saginaw', state: 'MI', zip: '48603', link: '' },
  { name: 'Thomas W. Jr. McDonald', lname: 'McDonald', case_type: 13,
    email: 'ch13@example.test', phone: '(989) 555-0113',
    address1: '3144 Davenport Ave', address2: '',
    city: 'Saginaw', state: 'MI', zip: '48602', link: '' },
];

const CASE_ROW = {
  case_id: 'AbC12dEf',
  case_chapter: '13',
  case_number: '26-41234',
  case_number_full: '26-41234-tjt',
  case_judge: 'Thomas J. Tucker',
  case_trustee: 'Krispen S. Carroll',
  // mysql2 reads a DATE column as midnight labeled UTC — the fixture must too,
  // or the test proves the wrong thing about formatDate's UTC getters.
  case_file_date: new Date('2026-08-14T00:00:00.000Z'),
};

const DEBTOR1 = {
  contact_id: 101, contact_name: 'John Q Smith',
  contact_email: 'john@example.test', contact_phone: '3135551234',
  contact_address: '1234 Maple Avenue, Apt 3B',
  contact_city: 'Southfield', contact_state: 'MI', contact_zip: '48075',
  contact_ssn: '123-45-6789',
};

const DEBTOR2 = {
  contact_id: 102, contact_name: 'Jane A Smith',
  contact_email: 'jane@example.test', contact_phone: '3135555678',
  contact_address: '1234 Maple Avenue, Apt 3B',
  contact_city: 'Southfield', contact_state: 'MI', contact_zip: '48075',
  contact_ssn: '987654321',
};

/** A fresh context per call — _trusteeEntry memoizes ON the object. */
const ctx = (over = {}) => ({
  caseRow: CASE_ROW, debtor1: DEBTOR1, debtor2: DEBTOR2, ...over,
});

beforeEach(() => {
  cfg.mockReset();
  cfg.mockImplementation((key) =>
    key === 'fe-trustees' ? JSON.stringify(TRUSTEES) : null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. composeCsz
// ─────────────────────────────────────────────────────────────────────────────

describe('composeCsz', () => {
  // The truth table from the spec, over the CONTACTS shape.
  test.each([
    ['all three',      { contact_city: 'Southfield', contact_state: 'MI', contact_zip: '48075' }, 'Southfield, MI 48075'],
    ['city + state',   { contact_city: 'Southfield', contact_state: 'MI', contact_zip: '' },      'Southfield, MI'],
    ['city + zip',     { contact_city: 'Southfield', contact_state: '',   contact_zip: '48075' }, 'Southfield 48075'],
    ['city only',      { contact_city: 'Southfield', contact_state: '',   contact_zip: '' },      'Southfield'],
    ['state + zip',    { contact_city: '',           contact_state: 'MI', contact_zip: '48075' }, 'MI 48075'],
    ['state only',     { contact_city: '',           contact_state: 'MI', contact_zip: '' },      'MI'],
    ['zip only',       { contact_city: '',           contact_state: '',   contact_zip: '48075' }, '48075'],
    ['all blank',      { contact_city: '',           contact_state: '',   contact_zip: '' },      ''],
  ])('%s', (_name, src, expected) => {
    expect(composeCsz(src)).toBe(expected);
  });

  test('the same function serves a fe-trustees entry (unprefixed keys)', () => {
    expect(composeCsz({ city: 'Detroit', state: 'MI', zip: '48226' })).toBe('Detroit, MI 48226');
    expect(composeCsz({ city: 'Oxford', state: 'MI', zip: '' })).toBe('Oxford, MI');
  });

  test('never emits a bare comma or a leading separator', () => {
    for (const out of [
      composeCsz({ city: '', state: '', zip: '48075' }),
      composeCsz({ city: '', state: 'MI', zip: '' }),
      composeCsz({ city: 'Detroit', state: '', zip: '' }),
    ]) {
      expect(out).not.toMatch(/^[,\s]/);
      expect(out).not.toMatch(/,\s*$/);
    }
  });

  test('whitespace-only pieces are treated as absent, and values are trimmed', () => {
    expect(composeCsz({ contact_city: '  ', contact_state: 'MI', contact_zip: ' 48075 ' }))
      .toBe('MI 48075');
  });

  test('null / undefined / non-object -> empty string, never a throw', () => {
    expect(composeCsz(null)).toBe('');
    expect(composeCsz(undefined)).toBe('');
    expect(composeCsz('nope')).toBe('');
    expect(composeCsz({})).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SSN
// ─────────────────────────────────────────────────────────────────────────────

describe('ssn_last4 / ssn_masked', () => {
  test.each([
    ['dashed',            '123-45-6789', '6789'],
    ['undashed',          '123456789',   '6789'],
    ['spaced',            '123 45 6789', '6789'],
    ['exactly four',      '6789',        '6789'],
    ['eight digits',      '12345678',    '5678'],  // >= 4: still yields a last-4
    ['three digits',      '123',         ''],      // the length gate
    ['dashes only',       '---',         ''],
    ['blank',             '',            ''],
    ['letters',           'n/a',         ''],
  ])('last4: %s', (_n, raw, expected) => {
    expect(ssnLast4({ contact_ssn: raw })).toBe(expected);
  });

  test('masked wraps last4, and collapses to "" rather than a partial mask', () => {
    expect(ssnMasked({ contact_ssn: '123-45-6789' })).toBe('xxx-xx-6789');
    expect(ssnMasked({ contact_ssn: '123456789' })).toBe('xxx-xx-6789');
    // The rule that matters: never 'xxx-xx-' with nothing after it.
    expect(ssnMasked({ contact_ssn: '123' })).toBe('');
    expect(ssnMasked({ contact_ssn: '' })).toBe('');
    expect(ssnMasked(null)).toBe('');
    expect(ssnMasked({})).toBe('');
  });

  test('no resolver anywhere exposes a full SSN', async () => {
    // The design invariant, asserted rather than trusted. Every resolver is run
    // over a context whose debtors carry a known SSN; none of the 37 outputs may
    // contain the first five digits.
    const c = ctx();
    for (const name of prefill.RESOLVER_NAMES) {
      const out = await R[name](c);
      const flat = Array.isArray(out) ? out.join(' ') : String(out);
      expect(flat).not.toContain('12345');
      expect(flat).not.toContain('123-45');
      expect(flat).not.toContain('98765');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. case.judge / case.trustee / case.file_date
// ─────────────────────────────────────────────────────────────────────────────

describe('case.judge / case.trustee / case.file_date', () => {
  test('present values pass through, the date as MM/DD/YYYY', async () => {
    expect(await R['case.judge'](ctx())).toBe('Thomas J. Tucker');
    expect(await R['case.trustee'](ctx())).toBe('Krispen S. Carroll');
    expect(await R['case.file_date'](ctx())).toBe('08/14/2026');
  });

  test('a DATE column is read in UTC — no off-by-one day', async () => {
    // The trap formatDate's header documents: reading a midnight-fake-UTC Date
    // in FIRM_TZ (America/Detroit, UTC-4) shifts the calendar date back one.
    const c = ctx({ caseRow: { ...CASE_ROW, case_file_date: new Date('2026-01-01T00:00:00.000Z') } });
    expect(await R['case.file_date'](c)).toBe('01/01/2026');
  });

  test('blank / missing / no caseRow -> "" and never undefined', async () => {
    const blank = ctx({ caseRow: { case_judge: '', case_trustee: '   ', case_file_date: null } });
    expect(await R['case.judge'](blank)).toBe('');
    expect(await R['case.trustee'](blank)).toBe('');
    expect(await R['case.file_date'](blank)).toBe('');

    const none = ctx({ caseRow: null });
    for (const n of ['case.judge', 'case.trustee', 'case.file_date']) {
      expect(await R[n](none)).toBe('');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. debtor addresses
// ─────────────────────────────────────────────────────────────────────────────

describe('debtor address resolvers', () => {
  test('debtor1 and debtor2 read the contacts mirror columns', async () => {
    expect(await R['debtor1.address_street'](ctx())).toBe('1234 Maple Avenue, Apt 3B');
    expect(await R['debtor1.address_csz'](ctx())).toBe('Southfield, MI 48075');
    expect(await R['debtor2.address_street'](ctx())).toBe('1234 Maple Avenue, Apt 3B');
    expect(await R['debtor2.address_csz'](ctx())).toBe('Southfield, MI 48075');
  });

  test('debtor2 absent -> all four resolve to "" (the solo-filing case)', async () => {
    const solo = ctx({ debtor2: null });
    for (const n of ['debtor2.address_street', 'debtor2.address_csz',
                     'debtor2.ssn_last4', 'debtor2.ssn_masked']) {
      expect(await R[n](solo)).toBe('');
    }
  });

  test('partial address: street present, city/state/zip blank', async () => {
    const partial = ctx({ debtor1: {
      ...DEBTOR1, contact_city: '', contact_state: '', contact_zip: '' } });
    expect(await R['debtor1.address_street'](partial)).toBe('1234 Maple Avenue, Apt 3B');
    expect(await R['debtor1.address_csz'](partial)).toBe('');
  });

  test('street blank but csz present — the template collapses one line, not both', async () => {
    const partial = ctx({ debtor1: { ...DEBTOR1, contact_address: '' } });
    expect(await R['debtor1.address_street'](partial)).toBe('');
    expect(await R['debtor1.address_csz'](partial)).toBe('Southfield, MI 48075');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. trustee.*
// ─────────────────────────────────────────────────────────────────────────────

describe('trustee resolvers', () => {
  test('exact match populates the whole block', async () => {
    const c = ctx();
    expect(await R['trustee.name'](c)).toBe('Krispen S. Carroll');
    expect(await R['trustee.address_street'](c)).toBe('719 Griswold Street, Suite 1100');
    expect(await R['trustee.address_csz'](c)).toBe('Detroit, MI 48226');
    expect(await R['trustee.phone'](c)).toBe('(313) 962-5035');
    expect(await R['trustee.email'](c)).toBe('notice@det13ksc.com');
  });

  test('match is case-insensitive and ignores surrounding whitespace', async () => {
    for (const spelling of ['krispen s. carroll', 'KRISPEN S. CARROLL', '  Krispen S. Carroll  ']) {
      const c = ctx({ caseRow: { ...CASE_ROW, case_trustee: spelling } });
      expect(await R['trustee.name'](c)).toBe('Krispen S. Carroll');
    }
  });

  test('MATCHING IS EXACT-NAME: the two McDonalds never cross-contaminate', async () => {
    // The reason this rule exists. A surname match would return whichever entry
    // came first and put the Chapter 12 trustee's address on a Chapter 13
    // notice — silently, on a document a creditor acts on.
    const ch12 = ctx({ caseRow: { ...CASE_ROW, case_trustee: 'Thomas W. McDonald' } });
    expect(await R['trustee.email'](ch12)).toBe('ch12@example.test');
    expect(await R['trustee.address_street'](ch12)).toBe('P.O. Box 5856');

    const ch13 = ctx({ caseRow: { ...CASE_ROW, case_trustee: 'Thomas W. Jr. McDonald' } });
    expect(await R['trustee.email'](ch13)).toBe('ch13@example.test');
    expect(await R['trustee.address_street'](ch13)).toBe('3144 Davenport Ave');
  });

  test('a near miss is a MISS — no fuzzy fallback', async () => {
    // The two live stale short forms are this shape. They must resolve empty so
    // somebody fixes the case, not silently pick a plausible neighbour.
    for (const stale of ['McDonald', 'Carroll', 'K. Carroll', 'Krispen Carroll']) {
      const c = ctx({ caseRow: { ...CASE_ROW, case_trustee: stale } });
      expect(await R['trustee.name'](c)).toBe('');
      expect(await R['trustee.phone'](c)).toBe('');
    }
  });

  test('empty address2 does not leave a trailing comma', async () => {
    const c = ctx({ caseRow: { ...CASE_ROW, case_trustee: 'Thomas W. McDonald' } });
    expect(await R['trustee.address_street'](c)).toBe('P.O. Box 5856');
  });

  test('address1 blank but address2 present -> address2 alone, no leading comma', async () => {
    cfg.mockImplementation((k) => k === 'fe-trustees'
      ? JSON.stringify([{ name: 'Odd Entry', address1: '', address2: 'Suite 9' }]) : null);
    const c = ctx({ caseRow: { ...CASE_ROW, case_trustee: 'Odd Entry' } });
    expect(await R['trustee.address_street'](c)).toBe('Suite 9');
  });

  test('case_trustee blank -> "" without even reading the setting', async () => {
    const c = ctx({ caseRow: { ...CASE_ROW, case_trustee: '' } });
    expect(await R['trustee.name'](c)).toBe('');
    expect(cfg).not.toHaveBeenCalledWith('fe-trustees');
  });

  test('no caseRow at all (a contact-linked render) -> all trustee.* empty', async () => {
    const c = ctx({ caseRow: null });
    for (const n of ['trustee.name', 'trustee.address_street', 'trustee.address_csz',
                     'trustee.phone', 'trustee.email']) {
      expect(await R[n](c)).toBe('');
    }
  });

  test.each([
    ['unset setting',        null],
    ['blank setting',        ''],
    ['malformed JSON',       '{not json'],
    ['a JSON object',        '{"name":"Krispen S. Carroll"}'],
    ['a JSON string',        '"Krispen S. Carroll"'],
    ['a JSON number',        '42'],
  ])('non-array setting (%s) -> "" and never a throw', async (_n, raw) => {
    cfg.mockImplementation((k) => (k === 'fe-trustees' ? raw : null));
    const c = ctx();
    expect(await R['trustee.name'](c)).toBe('');
    expect(await R['trustee.phone'](c)).toBe('');
  });

  test('junk entries inside the array are skipped, not fatal', async () => {
    cfg.mockImplementation((k) => k === 'fe-trustees'
      ? JSON.stringify([null, 'a string', 42, { no_name: true }, TRUSTEES[0]]) : null);
    expect(await R['trustee.name'](ctx())).toBe('Krispen S. Carroll');
  });

  test('the roster is parsed ONCE per context, not once per resolver', async () => {
    const c = ctx();
    await R['trustee.name'](c);
    await R['trustee.address_street'](c);
    await R['trustee.address_csz'](c);
    await R['trustee.phone'](c);
    await R['trustee.email'](c);
    const reads = cfg.mock.calls.filter(([k]) => k === 'fe-trustees').length;
    expect(reads).toBe(1);
  });

  test('the memo key is non-enumerable — it never leaks into the context', async () => {
    const c = ctx();
    await R['trustee.name'](c);
    expect(Object.keys(c)).toEqual(['caseRow', 'debtor1', 'debtor2']);
    expect(JSON.parse(JSON.stringify(c))).not.toHaveProperty('trusteeEntry');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Every new resolver is on the whitelist, and none of them throws
// ─────────────────────────────────────────────────────────────────────────────

describe('whitelist integrity', () => {
  const NEW = [
    'case.judge', 'case.trustee', 'case.file_date',
    'debtor1.address_street', 'debtor1.address_csz', 'debtor1.ssn_last4', 'debtor1.ssn_masked',
    'debtor2.address_street', 'debtor2.address_csz', 'debtor2.ssn_last4', 'debtor2.ssn_masked',
    'trustee.name', 'trustee.address_street', 'trustee.address_csz',
    'trustee.phone', 'trustee.email',
  ];

  test('all 16 are in RESOLVER_NAMES (which feeds template validation + the dropdown)', () => {
    for (const n of NEW) expect(prefill.RESOLVER_NAMES.has(n)).toBe(true);
  });

  test.each([
    ['fully empty context', {}],
    ['all nulls',           { caseRow: null, debtor1: null, debtor2: null }],
    ['empty row objects',   { caseRow: {}, debtor1: {}, debtor2: {} }],
  ])('every resolver returns "" on a %s — never undefined, never a throw', async (_n, c) => {
    for (const name of prefill.RESOLVER_NAMES) {
      // firm.name / attorney.name carry deliberate literal fallbacks; everything
      // else must degrade to ''.
      const out = await R[name]({ ...c });
      expect(typeof out).toBe('string');
      if (!['firm.name', 'attorney.name'].includes(name)) expect(out).toBe('');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. THE TEMPLATE — the committed JSON, through the real validator
// ─────────────────────────────────────────────────────────────────────────────

describe('ref/templates/notice_of_bankruptcy_filing.json', () => {
  const fs = require('fs');
  const path = require('path');
  const FILE = path.join(__dirname, '..', 'ref', 'templates',
                         'notice_of_bankruptcy_filing.json');

  const tpl = JSON.parse(fs.readFileSync(FILE, 'utf8'));

  test('validates with zero warnings against the REAL resolver whitelist', () => {
    const out = templateService.validateTemplateInput({
      name: tpl.name,
      kind: tpl.kind,
      body: tpl.body,
      templateType: tpl.template_type,
      purpose: tpl.purpose,
      fileSubfolder: tpl.file_subfolder,
      prefillSchema: tpl.prefill_schema,
      placementJson: tpl.placement_json ?? null,
    }, prefill.RESOLVER_NAMES);

    // Zero warnings is the strong claim: it means no declared-but-unused key.
    expect(out.warnings).toEqual([]);
    expect(out.clean.purpose).toBe('generate');
    expect(out.clean.templateType).toBe('html');
  });

  test('body placeholders and schema keys are the same set, both ways', () => {
    const inBody = templateService.extractPlaceholders(tpl.body);
    const keys = tpl.prefill_schema.map((e) => e.key);
    expect([...inBody].sort()).toEqual([...keys].sort());
  });

  test('every resolver named by the schema exists', () => {
    for (const e of tpl.prefill_schema) {
      expect(prefill.RESOLVER_NAMES.has(e.resolver)).toBe(true);
    }
  });

  test('the five required keys are the ones a notice cannot be issued without', () => {
    const required = tpl.prefill_schema.filter((e) => e.required).map((e) => e.key).sort();
    expect(required).toEqual(
      ['chapter', 'debtor1_name', 'debtor1_street', 'docket', 'file_date', 'judge'].sort());
  });

  test('nothing optional is required — the joint debtor and the trustee may be absent', () => {
    const req = new Set(tpl.prefill_schema.filter((e) => e.required).map((e) => e.key));
    for (const k of ['debtor2_name', 'debtor2_street', 'debtor2_csz', 'debtor2_ssn',
                     'trustee_name', 'trustee_street', 'trustee_csz', 'trustee_phone',
                     'debtor1_csz', 'debtor1_ssn', 'firm_addr2']) {
      expect(req.has(k)).toBe(false);
    }
  });

  test('the body is SELF-CONTAINED — no external refs for the network-locked renderer', () => {
    // pdfRenderService aborts every non-data:/about: request and throws
    // ESIGN_RENDER_EXTERNAL_REF. An http(s) url in src/href/url() here would
    // fail EVERY generate, not just look wrong.
    const external = tpl.body.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi) || [];
    const cssUrls = tpl.body.match(/url\(\s*["']?https?:\/\/[^)"']+/gi) || [];
    expect(external).toEqual([]);
    expect(cssUrls).toEqual([]);
    expect(tpl.body).toContain('src="data:image/png;base64,');
  });

  test('the collapse idiom is present and every placeholder span is whitespace-free', () => {
    expect(tpl.body).toContain('.l:has(> span:empty)');
    expect(tpl.body).toContain('.blk:has(> .drv > span:empty)');
    // :empty does not match an element containing a whitespace text node, so a
    // space between the span tag and the placeholder silently defeats the whole
    // mechanism and prints orphan labels on a client-facing document.
    expect(tpl.body).not.toMatch(/<span[^>]*>\s+\{\{/);
    expect(tpl.body).not.toMatch(/\}\}\s+<\/span>/);
  });

  test('no court seal, and the document says who issued it', () => {
    // A firm-issued notice bearing the court's seal misrepresents the sender.
    // Both source notices Fred supplied DO carry the seal — the court's own
    // and the firm's Jotform copy of it. This one deliberately does not, and
    // says so in the closing line.
    //
    // Compared on collapsed whitespace: the disclaimer wraps across source
    // lines, so a literal substring match here breaks on a re-wrap rather than
    // on a real change.
    const flat = tpl.body.replace(/\s+/g, ' ');
    expect(flat.toLowerCase()).not.toContain('seal of the united states');
    expect(flat).toContain('does not bear the seal of the Court');
    expect(flat).toContain('United States Bankruptcy Court');
    expect(flat).toContain('This notice is provided by {{firm_name}} as a courtesy.');
  });

  // ── VERBATIM WORDING (G4.1) ────────────────────────────────────────────────
  // These three paragraphs are quoted from the court's own Notice of Bankruptcy
  // Case Filing, by way of the firm's Jotform version. They are not ours to
  // paraphrase: the automatic-stay language in particular is what a creditor
  // reads and acts on. If a test here fails, the question is not "update the
  // test" — it is "who changed the legal text, and did SS approve it?"
  describe('verbatim wording', () => {
    // The body wraps paragraphs across source lines; compare on collapsed
    // whitespace so re-wrapping the file is not a test failure.
    const flat = tpl.body.replace(/\s+/g, ' ');
    const has = (s) => expect(flat).toContain(s.replace(/\s+/g, ' ').trim());

    test('automatic stay paragraph', () => {
      has(`In most instances, the filing of the bankruptcy case automatically
           stays certain collection and other actions against the debtor and the
           debtor's property. Under certain circumstances, the stay may be
           limited to 30 days or not exist at all, although the debtor can
           request the court to extend or impose a stay. If you attempt to
           collect a debt or take other action in violation of the Bankruptcy
           Code, you may be penalized. Consult a lawyer to determine your rights
           in this case.`);
    });

    test("clerk's office paragraph, with the live URL and street address", () => {
      has(`If you would like to view the bankruptcy petition and other documents
           filed by the debtor, they are available at http://www.mieb.uscourts.gov
           or at the Bankruptcy Court Clerk's Office, 211 West Fort Street,
           Detroit, MI 48226.`);
    });

    test('creditor paragraph', () => {
      has(`You may be a creditor of the debtor. If so, you will receive an
           additional notice from the court setting forth important deadlines.`);
    });

    test('opening sentence carries chapter and file date, and claims no filed TIME', () => {
      has(`Please take note that a bankruptcy case concerning the debtor(s)
           listed below was filed under Chapter {{chapter}} of the United States
           Bankruptcy Code, on {{file_date}}.`);
      // cases.case_file_date is a DATE column — there is no time to print, and
      // the firm's Jotform version's "at 10:25 AM" cannot be honoured.
      expect(flat).not.toMatch(/\{\{file_date\}\} at /);
    });

    test('assignment line, lead-in, and both column captions', () => {
      has('The case was assigned case number {{docket}} to Judge {{judge}}.');
      has('Notice from {{firm_name}}');
      has("The case was filed by the debtor's attorney:");
      has('The bankruptcy trustee is:');
    });

    test('the trustee caption lives INSIDE the collapsing block', () => {
      // Otherwise a Chapter 7 with no appointed trustee prints the heading
      // "The bankruptcy trustee is:" over four blank lines. The caption must be
      // a sibling of the .drv line under the same .blk.
      const col = flat.match(/<div class="blk">.*?<\/div> <\/div>/);
      expect(col).not.toBeNull();
      expect(col[0]).toContain('The bankruptcy trustee is:');
      expect(col[0]).toContain('drv');
      expect(col[0]).toContain('{{trustee_name}}');
    });
  });

  test('ONE PAGE: the size budget has not been loosened', () => {
    // Not a page count — jest has no chromium. This guards the three numbers
    // the one-page fit was measured against (2026-09-01: worst case, a joint
    // Ch13 with two SSNs and a full trustee block, rendered with ~1.9in to
    // spare). Loosening any of them without re-rendering is how a second page
    // appears carrying nothing but the closing disclaimer.
    expect(tpl.body).toContain('font-size: 10.5pt');
    expect(tpl.body).toContain('line-height: 1.34');
    expect(tpl.body).toContain('ONE PAGE IS A REQUIREMENT');
    // A forced break would defeat the whole budget.
    expect(tpl.body).not.toMatch(/(page-)?break-(before|after)\s*:/);
  });
});
