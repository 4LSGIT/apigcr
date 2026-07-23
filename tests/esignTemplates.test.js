/**
 * Tests for the Phase 2B template layer:
 *
 *   services/esignTemplateService.js   validation + CRUD
 *   services/esignPrefillService.js    resolver whitelist + formatting
 *   services/esignSendService.js       interpolateTemplate / sendFromTemplate /
 *                                      previewFromTemplate / kind union
 *   routes/api.esign.templates.js      surface + error mapping
 *
 * NO network, NO real DB, NO real chromium. esignService, the provider
 * factory, the filing service and pdfRenderService are jest-mocked; the db is
 * a dispatcher over SQL substrings. pdf-lib is REAL — the render mock returns
 * a real minimal PDF so 2A's footer stamping (which sendFromTemplate flows
 * through) runs for real.
 *
 *   npx jest tests/esignTemplates.test.js
 */

jest.mock('../services/esignService', () => ({
  createRequest:   jest.fn(),
  markSent:        jest.fn(),
  applyStatus:     jest.fn(),
  appendEvent:     jest.fn(async () => ({ ok: true })),
  getById:         jest.fn(),
  listOutstanding: jest.fn(async () => []),
  storeSourcePdf:  jest.fn(async (db, id, buffer) => ({ id, size: buffer.length })),
  getSourcePdf:    jest.fn(async () => null),
  hasSourcePdf:    jest.fn(async () => false),
  _normalizeRecipients: jest.fn((r) => r || []),
  LINKABLE_TYPES: ['case', 'contact'],
  STATUSES: [
    'draft', 'sent', 'viewed', 'signed', 'declined',
    'expired', 'recalled', 'bounced', 'satisfied_external',
  ],
  TERMINAL: new Set(['signed', 'declined', 'expired', 'recalled', 'satisfied_external']),
}));

jest.mock('../services/esign', () => ({
  getProvider:       jest.fn(),
  recordCreditSpend: jest.fn(async () => ({ ok: true })),
}));

jest.mock('../services/esignFilingService', () => {
  const actual = jest.requireActual('../services/esignFilingService');
  return { ...actual, fileExternalDocument: jest.fn() };
});

jest.mock('../services/pdfRenderService', () => ({
  renderHtmlToPdf: jest.fn(),
}));

// firmConfig env fallbacks — resolvers read cfg() which, under jest with no
// injected db, serves these.
process.env.FIRM_PHONE = '2484179800';
process.env.FIRM_EMAIL = 'office@4lsg.com';
process.env.FIRM_URL   = 'https://legalsolutions.group';

const esignService         = require('../services/esignService');
const { getProvider }      = require('../services/esign');
const pdfRenderService     = require('../services/pdfRenderService');
const templateService      = require('../services/esignTemplateService');
const prefillService       = require('../services/esignPrefillService');
const sendService          = require('../services/esignSendService');

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES
// ─────────────────────────────────────────────────────────────────────────────

const WL = prefillService.RESOLVER_NAMES;

/** Same minimal-classic-PDF builder as tests/esignSend.test.js. */
function buildPdf(pageCount = 1) {
  const objs = [];
  const kids = [];
  for (let i = 0; i < pageCount; i++) kids.push(`${4 + i * 2} 0 R`);
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;
  objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  for (let i = 0; i < pageCount; i++) {
    const p = 4 + i * 2;
    const c = p + 1;
    const s = `BT /F1 12 Tf 72 700 Td (Body page ${i + 1}) Tj ET`;
    objs[p] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
              `/Resources << /Font << /F1 3 0 R >> >> /Contents ${c} 0 R >>`;
    objs[c] = `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
  }
  const n = objs.length;
  let out = '%PDF-1.4\n';
  const offs = [];
  for (let i = 1; i < n; i++) {
    offs[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = out.length;
  out += `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (let i = 1; i < n; i++) out += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A valid template input in the SERVICE (camelCase) shape. */
function validTemplateInput(overrides = {}) {
  return {
    name: 'Retainer Agreement',
    kind: 'retainer_custom',
    body: '<h1>Retainer</h1><p>Between the firm and {{debtor_name}} for {{fee}}.</p>',
    prefillSchema: [
      { key: 'debtor_name', label: 'Debtor name', type: 'text',
        resolver: 'debtor1.name', default: null, required: true },
      { key: 'fee', label: 'Fee', type: 'money',
        resolver: null, default: '1500', required: true },
    ],
    placementJson: {
      coord_space: 'pdf_user_space',
      fields: [{ page: 1, x: 100, y: 100, w: 180, h: 30, type: 'signature', signer: 1 }],
    },
    expirationDays: 30,
    remindersOff: false,
    reminderSeqId: null,
    ...overrides,
  };
}

/** getTemplate-shaped row (parsed JSON, boolean active). */
function templateRow(overrides = {}) {
  const input = validTemplateInput();
  return {
    id: 7,
    name: input.name,
    kind: input.kind,
    template_type: 'html',
    body: input.body,
    prefill_schema: input.prefillSchema,
    placement_json: input.placementJson,
    reminder_seq_id: null,
    reminders_off: false,
    expiration_days: 30,
    active: true,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

const CASE_ROW = {
  case_id: 'AbC12dEf',
  case_number: '26-41234',
  case_number_full: '26-41234-tjt',
  case_chapter: '7',
  case_open_date: new Date('2026-03-15T00:00:00.000Z'),   // mysql2 fake-UTC DATE
};
const DEBTOR1 = {
  contact_id: 101, contact_name: 'John Q Smith',
  contact_email: 'john@example.com', contact_phone: '3135551234',
};
const DEBTOR2 = {
  contact_id: 102, contact_name: 'Jane Smith',
  contact_email: 'jane@example.com', contact_phone: '3135555678',
};

/**
 * A db whose query() dispatches on SQL substrings. Register with .when();
 * unmatched SQL returns [[]]. Every call is recorded for assertions.
 */
function makeDb() {
  const rules = [];
  const calls = [];
  return {
    calls,
    when(substr, rows) { rules.push({ substr, rows }); return this; },
    query: jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      for (const r of rules) {
        if (sql.includes(r.substr)) {
          return [typeof r.rows === 'function' ? r.rows(sql, params) : r.rows];
        }
      }
      return [[]];
    }),
  };
}

/** db wired for the full case context + template + send path. */
function wiredDb({ template = templateRow(), secondary = DEBTOR2 } = {}) {
  return makeDb()
    .when('FROM contract_templates WHERE id', template ? [template] : [])
    .when('SELECT DISTINCT kind FROM contract_templates', [{ kind: 'retainer_custom' }])
    .when('SELECT case_id FROM cases WHERE case_id', [{ case_id: CASE_ROW.case_id }])
    .when('SELECT * FROM cases WHERE case_id', [CASE_ROW])
    .when("case_relate_type = 'Primary'", [DEBTOR1])
    .when("case_relate_type = 'Secondary'", secondary ? [secondary] : []);
}

const RECIPIENTS = [{ name: 'John Q Smith', email: 'john@example.com', order: 1 }];

beforeEach(() => {
  jest.clearAllMocks();
  pdfRenderService.renderHtmlToPdf.mockResolvedValue(buildPdf(1));

  esignService.createRequest.mockImplementation(async (db, o) => ({
    id: 42,
    tracking_id: 'YC-AbC12dEf-retainer_custom-9F3A21BC',
    status: 'draft',
    linkable_type: o.linkableType,
    linkable_id: o.linkableId,
    kind: o.kind,
    document_name: o.documentName,
    recipients: o.recipients,
    placement_json: o.placementJson,
    template_id: o.templateId ?? null,
    provider: 'zoho',
  }));
  esignService.markSent.mockImplementation(async (db, id, o) => ({
    id, status: 'sent', tracking_id: 'YC-AbC12dEf-retainer_custom-9F3A21BC',
    document_name: 'x', sent_at: o.sentAt, expires_at: o.expiresAt,
  }));
  getProvider.mockResolvedValue({
    sendForSignature: jest.fn(async () => ({ providerId: 'zr-1', testing: true })),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe('validateTemplateInput', () => {
  test('a valid template passes and normalizes', () => {
    const { clean, warnings } = templateService.validateTemplateInput(validTemplateInput(), WL);
    expect(clean.name).toBe('Retainer Agreement');
    expect(clean.prefillSchema).toHaveLength(2);
    expect(warnings).toEqual([]);
  });

  test.each([
    ['name too short',   { name: 'ab' },                          'ESIGN_BAD_TEMPLATE'],
    ['name too long',    { name: 'x'.repeat(129) },               'ESIGN_BAD_TEMPLATE'],
    ['kind empty',       { kind: '  ' },                          'ESIGN_BAD_TEMPLATE'],
    ['kind too long',    { kind: 'k'.repeat(65) },                'ESIGN_BAD_TEMPLATE'],
    ['body empty',       { body: '   ' },                         'ESIGN_BAD_TEMPLATE'],
    ['expiration 0',     { expirationDays: 0 },                   'ESIGN_BAD_TEMPLATE'],
    ['expiration 91',    { expirationDays: 91 },                  'ESIGN_BAD_TEMPLATE'],
    ['expiration float', { expirationDays: 14.5 },                'ESIGN_BAD_TEMPLATE'],
    ['bad seq id',       { reminderSeqId: -3 },                   'ESIGN_BAD_TEMPLATE'],
    ['schema not array', { prefillSchema: {} },                   'ESIGN_BAD_PREFILL_SCHEMA'],
  ])('%s → %s', (_label, overrides, code) => {
    expect(() => templateService.validateTemplateInput(validTemplateInput(overrides), WL))
      .toThrow(expect.objectContaining({ code }));
  });

  test('kind is FREE vocabulary — anything non-empty ≤64 chars saves', () => {
    const { clean } = templateService.validateTemplateInput(
      validTemplateInput({ kind: 'reaffirmation_agreement_2026' }), WL);
    expect(clean.kind).toBe('reaffirmation_agreement_2026');
  });

  test('a body with no placeholders is rejected unless staticBody is explicit', () => {
    const noPh = validTemplateInput({
      body: '<p>Fully static text.</p>',
      prefillSchema: [],
    });
    expect(() => templateService.validateTemplateInput(noPh, WL))
      .toThrow(expect.objectContaining({ code: 'ESIGN_BAD_TEMPLATE' }));

    const { clean } = templateService.validateTemplateInput({ ...noPh, staticBody: true }, WL);
    expect(clean.body).toContain('Fully static');
  });

  test.each([
    ['uppercase',      'DebtorName'],
    ['leading digit',  '1name'],
    ['leading _',      '_name'],
    ['space',          'debtor name'],
    ['dot',            'debtor.name'],
    ['41 chars',       'a'.repeat(41)],
    ['empty',          ''],
  ])('prefill key rejected: %s', (_label, key) => {
    const input = validTemplateInput({
      body: '<p>{{debtor_name}}</p>',
      prefillSchema: [
        { key: 'debtor_name', label: 'D', type: 'text', resolver: null },
        { key, label: 'Bad', type: 'text', resolver: null },
      ],
    });
    expect(() => templateService.validateTemplateInput(input, WL))
      .toThrow(expect.objectContaining({ code: 'ESIGN_BAD_PREFILL_SCHEMA' }));
  });

  test('40-char key is legal (boundary)', () => {
    const key = 'a'.repeat(40);
    const input = validTemplateInput({
      body: `<p>{{${key}}}</p>`,
      prefillSchema: [{ key, label: 'L', type: 'text', resolver: null }],
    });
    expect(() => templateService.validateTemplateInput(input, WL)).not.toThrow();
  });

  test('duplicate keys rejected', () => {
    const input = validTemplateInput({
      body: '<p>{{fee}}</p>',
      prefillSchema: [
        { key: 'fee', label: 'Fee', type: 'money', resolver: null },
        { key: 'fee', label: 'Fee again', type: 'money', resolver: null },
      ],
    });
    expect(() => templateService.validateTemplateInput(input, WL))
      .toThrow(expect.objectContaining({ code: 'ESIGN_BAD_PREFILL_SCHEMA' }));
  });

  test.each([
    ['label empty', ''],
    ['label 81',    'x'.repeat(81)],
  ])('%s rejected', (_label, label) => {
    const input = validTemplateInput({
      body: '<p>{{fee}}</p>',
      prefillSchema: [{ key: 'fee', label, type: 'money', resolver: null }],
    });
    expect(() => templateService.validateTemplateInput(input, WL))
      .toThrow(expect.objectContaining({ code: 'ESIGN_BAD_PREFILL_SCHEMA' }));
  });

  test('unknown type rejected', () => {
    const input = validTemplateInput({
      body: '<p>{{fee}}</p>',
      prefillSchema: [{ key: 'fee', label: 'Fee', type: 'currency', resolver: null }],
    });
    expect(() => templateService.validateTemplateInput(input, WL))
      .toThrow(expect.objectContaining({ code: 'ESIGN_BAD_PREFILL_SCHEMA' }));
  });

  test('unknown resolver is rejected AT SAVE (ESIGN_BAD_RESOLVER)', () => {
    const input = validTemplateInput({
      body: '<p>{{debtor_name}}</p>',
      prefillSchema: [{ key: 'debtor_name', label: 'D', type: 'text',
                        resolver: 'debtor1.middle_name' }],
    });
    expect(() => templateService.validateTemplateInput(input, WL))
      .toThrow(expect.objectContaining({ code: 'ESIGN_BAD_RESOLVER' }));
  });

  test('undeclared placeholders throw, naming every offender — including malformed ones', () => {
    const input = validTemplateInput({
      body: '<p>{{debtor_name}} owes {{fee_amount}} by {{Due Date}}.</p>',
      prefillSchema: [{ key: 'debtor_name', label: 'D', type: 'text', resolver: null }],
    });
    try {
      templateService.validateTemplateInput(input, WL);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('ESIGN_UNDECLARED_PLACEHOLDER');
      expect(err.placeholders).toEqual(['fee_amount', 'Due Date']);
    }
  });

  test('declared-but-unused is a WARNING, not an error', () => {
    const input = validTemplateInput({
      body: '<p>{{debtor_name}}</p>',
      prefillSchema: [
        { key: 'debtor_name', label: 'D', type: 'text', resolver: null },
        { key: 'spare_key',   label: 'S', type: 'text', resolver: null },
      ],
    });
    const { warnings } = templateService.validateTemplateInput(input, WL);
    expect(warnings.join(' ')).toContain('spare_key');
  });

  test('placements go through the ONE shared validator (ESIGN_INVALID_INPUT)', () => {
    const input = validTemplateInput({
      placementJson: { fields: [{ page: 1, x: 'left', y: 0, w: 10, h: 10, type: 'signature', signer: 1 }] },
    });
    expect(() => templateService.validateTemplateInput(input, WL))
      .toThrow(expect.objectContaining({ code: 'ESIGN_INVALID_INPUT' }));
  });

  test('reminder_seq_id passes through unvalidated against any table (Phase 3 owns it)', () => {
    const { clean } = templateService.validateTemplateInput(
      validTemplateInput({ reminderSeqId: 99999 }), WL);
    expect(clean.reminderSeqId).toBe(99999);
  });
});

describe('extractPlaceholders', () => {
  test('deduplicates, trims, keeps order, and catches malformed keys', () => {
    expect(templateService.extractPlaceholders(
      '{{a}} {{ b }} {{a}} {{Bad Key}} {{c_1}}'
    )).toEqual(['a', 'b', 'Bad Key', 'c_1']);
  });
  test('empty/null body → []', () => {
    expect(templateService.extractPlaceholders('')).toEqual([]);
    expect(templateService.extractPlaceholders(null)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────────

describe('template CRUD', () => {
  test('createTemplate supplies BOTH JSON columns explicitly as strings (sql_mode landmine)', async () => {
    const db = makeDb()
      .when('INSERT INTO contract_templates', () => ({ insertId: 7 }))
      .when('FROM contract_templates WHERE id', [templateRow()]);

    await templateService.createTemplate(db, validTemplateInput(), WL);

    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO contract_templates'));
    expect(insert).toBeTruthy();
    expect(insert.sql).toContain('prefill_schema');
    expect(insert.sql).toContain('placement_json');
    const prefillParam   = insert.params[4];
    const placementParam = insert.params[5];
    expect(typeof prefillParam).toBe('string');
    expect(typeof placementParam).toBe('string');
    expect(JSON.parse(prefillParam)[0].key).toBe('debtor_name');
    expect(JSON.parse(placementParam).fields).toHaveLength(1);
  });

  test('updateTemplate merges partial input and validates the MERGED result', async () => {
    const db = makeDb().when('FROM contract_templates WHERE id', [templateRow()]);

    // Body edit that orphans a declared key's placeholder → merged validation
    // must throw undeclared for the NEW placeholder.
    await expect(
      templateService.updateTemplate(db, 7, { body: '<p>{{brand_new}}</p>' }, WL)
    ).rejects.toMatchObject({ code: 'ESIGN_UNDECLARED_PLACEHOLDER' });
  });

  test('deactivateTemplate flips active=0 and NEVER deletes', async () => {
    const db = makeDb().when('FROM contract_templates WHERE id', [templateRow()]);
    await templateService.deactivateTemplate(db, 7);

    const sqls = db.calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes('SET active = 0'))).toBe(true);
    expect(sqls.some((s) => /DELETE/i.test(s))).toBe(false);
  });

  test('listTemplates ships no bodies', async () => {
    const db = makeDb().when('FROM contract_templates', [
      { id: 1, name: 'A', kind: 'k', active: 1, expiration_days: 14, reminders_off: 0, updated_at: new Date() },
    ]);
    const rows = await templateService.listTemplates(db);
    const listSql = db.calls[0].sql;
    expect(listSql).not.toContain('body');
    expect(rows[0].active).toBe(true);
  });

  test('getTemplate parses JSON columns whether mysql2 hands back strings or objects', async () => {
    const raw = templateRow({
      prefill_schema: JSON.stringify(validTemplateInput().prefillSchema),
      placement_json: JSON.stringify(validTemplateInput().placementJson),
      active: 1, reminders_off: 0,
    });
    const db = makeDb().when('FROM contract_templates WHERE id', [raw]);
    const t = await templateService.getTemplate(db, 7);
    expect(Array.isArray(t.prefill_schema)).toBe(true);
    expect(t.placement_json.fields).toHaveLength(1);
    expect(t.active).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PREFILL RESOLVERS
// ─────────────────────────────────────────────────────────────────────────────

describe('prefill resolvers', () => {
  const ctx = { caseRow: CASE_ROW, debtor1: DEBTOR1, debtor2: DEBTOR2 };

  test.each([
    ['case.case_name',        'John Q Smith'],           // primary debtor's name — cases has no name column
    ['case.case_number',      '26-41234'],
    ['case.case_number_full', '26-41234-tjt'],
    ['case.chapter',          '7'],
    ['case.open_date',        '03/15/2026'],
    ['debtor1.name',          'John Q Smith'],
    ['debtor1.email',         'john@example.com'],
    ['debtor1.phone',         '(313) 555-1234'],
    ['debtor2.name',          'Jane Smith'],
    ['debtor2.email',         'jane@example.com'],
    ['debtor2.phone',         '(313) 555-5678'],
    ['attorney.name',         'Stuart Sandweiss'],
    ['firm.name',             'Legal Solutions Group'],
    ['firm.phone',            '(248) 417-9800'],
    ['firm.email',            'office@4lsg.com'],
    ['firm.website',          'https://legalsolutions.group'],
  ])('%s → %s', async (resolver, expected) => {
    expect(await prefillService.RESOLVERS[resolver](ctx)).toBe(expected);
  });

  test('missing joint debtor → empty string, never undefined', async () => {
    const solo = { caseRow: CASE_ROW, debtor1: DEBTOR1, debtor2: null };
    expect(await prefillService.RESOLVERS['debtor2.name'](solo)).toBe('');
    expect(await prefillService.RESOLVERS['debtor2.email'](solo)).toBe('');
    expect(await prefillService.RESOLVERS['debtor2.phone'](solo)).toBe('');
  });

  test('firm.address resolvers (firm-identity fold-in, 2026-07-20)', async () => {
    // Settings-backed as of the firm_identity patch: three resolvers over one
    // json_array setting. Under jest no db is injected and there is no env
    // fallback (empty REGISTRY descriptor), so the setting reads null →
    // '' — the unset contract: value lands in `missing`, and a template that
    // marks its address key required hard-fails the send instead of mailing
    // a contract with a blank address.
    expect(WL.has('firm.address')).toBe(true);
    expect(WL.has('firm.address_line1')).toBe(true);
    expect(WL.has('firm.address_line2')).toBe(true);
    expect(await prefillService.RESOLVERS['firm.address'](ctx)).toBe('');
    expect(await prefillService.RESOLVERS['firm.address_line1'](ctx)).toBe('');
    expect(await prefillService.RESOLVERS['firm.address_line2'](ctx)).toBe('');
  });

  test('firm.name / attorney.name fall back to the literals when the setting is unset', async () => {
    // A CLEARED setting degrades to the previous hardcoded behaviour — a
    // blank firm or attorney name on an executed retainer is worse than a
    // stale one. (Under jest cfg() serves env; there is no FIRM_NAME /
    // FIRM_ATTORNEY_NAME env, so this exercises exactly the unset path.)
    expect(await prefillService.RESOLVERS['firm.name'](ctx)).toBe('Legal Solutions Group');
    expect(await prefillService.RESOLVERS['attorney.name'](ctx)).toBe('Stuart Sandweiss');
  });

  test('case_number resolvers are verbatim passthrough — never parsed', async () => {
    const weird = { ...ctx, caseRow: { ...CASE_ROW, case_number_full: 'ADV 26-04012-mlo' } };
    expect(await prefillService.RESOLVERS['case.case_number_full'](weird))
      .toBe('ADV 26-04012-mlo');
  });

  test('buildContext picks Primary as debtor1 and Secondary as debtor2, ids bound as strings', async () => {
    const db = wiredDb();
    const c = await prefillService.buildContext(db, { linkableType: 'case', linkableId: 'AbC12dEf' });
    expect(c.debtor1.contact_id).toBe(101);
    expect(c.debtor2.contact_id).toBe(102);
    for (const call of db.calls) {
      expect(typeof call.params[0]).toBe('string');
    }
    const primarySql = db.calls.find((c2) => c2.sql.includes("'Primary'"));
    expect(primarySql.sql).toContain('ORDER BY cr.case_relate_client_id ASC');
  });

  test('contact linkable: the contact stands in as debtor1; case.* resolve empty', async () => {
    const db = makeDb().when('FROM contacts WHERE contact_id', [DEBTOR1]);
    const c = await prefillService.buildContext(db, { linkableType: 'contact', linkableId: '101' });
    expect(c.debtor1.contact_name).toBe('John Q Smith');
    expect(await prefillService.RESOLVERS['case.case_number'](c)).toBe('');
  });
});

describe('formatValue', () => {
  test.each([
    ['money',  '1500',      '$1,500.00'],
    ['money',  '1234.5',    '$1,234.50'],
    ['money',  '$2,500',    '$2,500.00'],
    ['money',  'waived',    'waived'],          // unparseable → passthrough, not a 500
    ['number', '1,250',     '1250'],
    ['number', 'n/a',       'n/a'],
    ['date',   '2026-03-15','03/15/2026'],
    ['date',   'TBD',       'TBD'],
    ['text',   '  hi  ',    'hi'],
  ])('%s(%s) → %s', (type, raw, expected) => {
    expect(prefillService.formatValue(type, raw)).toBe(expected);
  });

  test('DATE columns (fake-UTC midnight from mysql2) keep their calendar date', () => {
    expect(prefillService.formatValue('date', new Date('2026-03-15T00:00:00.000Z')))
      .toBe('03/15/2026');
  });
});

describe('resolvePrefills', () => {
  test('resolver values + defaults + missing, formatted by type', async () => {
    const db = wiredDb();
    const template = templateRow({
      prefill_schema: [
        { key: 'debtor_name', label: 'D', type: 'text',  resolver: 'debtor1.name', default: null, required: true },
        { key: 'fee',         label: 'F', type: 'money', resolver: null, default: '1500', required: true },
        { key: 'notes',       label: 'N', type: 'text',  resolver: null, default: null, required: false },
      ],
    });

    const out = await prefillService.resolvePrefills(db, template,
      { linkableType: 'case', linkableId: 'AbC12dEf' });

    expect(out.values).toEqual({
      debtor_name: 'John Q Smith',
      fee:         '$1,500.00',
      notes:       '',
    });
    expect(out.missing).toEqual(['notes']);
    expect(out.context.debtor1.contact_name).toBe('John Q Smith');
  });

  test('no linkable → resolvers skipped, defaults only (authoring-time)', async () => {
    const db = makeDb();   // must not be queried for case context
    const out = await prefillService.resolvePrefills(db, templateRow(), null);
    expect(out.values.debtor_name).toBe('');
    expect(out.values.fee).toBe('$1,500.00');
    expect(db.calls.filter((c) => c.sql.includes('FROM cases'))).toHaveLength(0);
  });

  test('a stored template naming a since-removed resolver fails LOUD', async () => {
    const db = wiredDb();
    const template = templateRow({
      prefill_schema: [{ key: 'x', label: 'X', type: 'text', resolver: 'firm.fax', required: false }],
    });
    await expect(
      prefillService.resolvePrefills(db, template, { linkableType: 'case', linkableId: 'AbC12dEf' })
    ).rejects.toMatchObject({ code: 'ESIGN_BAD_RESOLVER' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INTERPOLATION
// ─────────────────────────────────────────────────────────────────────────────

describe('interpolateTemplate', () => {
  test('replaces placeholders, tolerating inner whitespace', () => {
    expect(sendService.interpolateTemplate('<p>{{a}} and {{ b }}</p>', { a: '1', b: '2' }))
      .toBe('<p>1 and 2</p>');
  });

  test('values are HTML-escaped — data, never markup', () => {
    expect(sendService.interpolateTemplate('{{v}}', { v: `<b>&"x"</b>'` }))
      .toBe('&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;&#39;');
  });

  test('a key with no value throws ESIGN_UNDECLARED_PLACEHOLDER (send-time belt)', () => {
    expect(() => sendService.interpolateTemplate('{{ghost}}', {}))
      .toThrow(expect.objectContaining({ code: 'ESIGN_UNDECLARED_PLACEHOLDER' }));
  });

  test('empty-string values interpolate as empty, not as an error', () => {
    expect(sendService.interpolateTemplate('a{{v}}b', { v: '' })).toBe('ab');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEND FROM TEMPLATE
// ─────────────────────────────────────────────────────────────────────────────

describe('sendFromTemplate', () => {
  const args = (overrides = {}) => ({
    templateId: 7,
    linkableType: 'case',
    linkableId: 'AbC12dEf',
    recipients: RECIPIENTS,
    createdBy: 22,
    ...overrides,
  });

  test('happy path: resolves, interpolates, renders, and joins the 2A pipeline', async () => {
    const db = wiredDb();
    const out = await sendService.sendFromTemplate(db, args());

    // The renderer received INTERPOLATED, ESCAPED html — not the raw template.
    const html = pdfRenderService.renderHtmlToPdf.mock.calls[0][0];
    expect(html).toContain('John Q Smith');
    expect(html).toContain('$1,500.00');
    expect(html).not.toContain('{{');

    // The provider received a STAMPED PDF, not html and not the raw render.
    const provider = await getProvider.mock.results[0].value;
    const sent = provider.sendForSignature.mock.calls[0][0];
    expect(Buffer.isBuffer(sent.pdfBuffer)).toBe(true);
    expect(sent.pdfBuffer.slice(0, 5).toString('latin1')).toBe('%PDF-');
    expect(sent.pdfBuffer.toString('latin1')).toContain('endobj'); // a real, rewritten PDF
    expect(sent.pdfBuffer.equals(buildPdf(1))).toBe(false);        // stamping rewrote it

    expect(out.row.status).toBe('sent');
  });

  test('template defaults flow: kind, placements, expiration, document name', async () => {
    const db = wiredDb();
    await sendService.sendFromTemplate(db, args());

    const created = esignService.createRequest.mock.calls[0][1];
    expect(created.kind).toBe('retainer_custom');            // template's kind
    expect(created.documentName).toBe('Retainer Agreement – Smith'); // name – last token
    expect(created.placementJson.fields).toHaveLength(1);    // template's placement
    expect(created.templateId).toBe(7);                      // provenance stored

    const provider = await getProvider.mock.results[0].value;
    expect(provider.sendForSignature.mock.calls[0][0].expirationDays).toBe(30); // template's 30
  });

  test('explicit documentName and expirationDays override the template', async () => {
    const db = wiredDb();
    await sendService.sendFromTemplate(db, args({
      documentName: 'Fee Agreement for the Smiths', expirationDays: 10,
    }));

    expect(esignService.createRequest.mock.calls[0][1].documentName)
      .toBe('Fee Agreement for the Smiths');
    const provider = await getProvider.mock.results[0].value;
    expect(provider.sendForSignature.mock.calls[0][0].expirationDays).toBe(10);
  });

  test('caller values WIN over resolved prefills, formatted by declared type', async () => {
    const db = wiredDb();
    await sendService.sendFromTemplate(db, args({ values: { fee: '2500' } }));

    const html = pdfRenderService.renderHtmlToPdf.mock.calls[0][0];
    expect(html).toContain('$2,500.00');
    expect(html).not.toContain('$1,500.00');
  });

  test('undeclared caller keys are ignored, not interpolated', async () => {
    const db = wiredDb();
    await sendService.sendFromTemplate(db, args({ values: { hack: '<script>' } }));
    const html = pdfRenderService.renderHtmlToPdf.mock.calls[0][0];
    expect(html).not.toContain('script');
  });

  test('required key still empty → ESIGN_MISSING_PREFILL naming it; nothing rendered or sent', async () => {
    const template = templateRow({
      prefill_schema: [
        { key: 'debtor_name', label: 'D', type: 'text', resolver: 'debtor1.name', required: true },
        { key: 'fee', label: 'F', type: 'money', resolver: null, default: null, required: true },
      ],
    });
    const db = wiredDb({ template });

    await expect(sendService.sendFromTemplate(db, args())).rejects.toMatchObject({
      code: 'ESIGN_MISSING_PREFILL',
      missing: ['fee'],
    });
    expect(pdfRenderService.renderHtmlToPdf).not.toHaveBeenCalled();
    expect(esignService.createRequest).not.toHaveBeenCalled();
  });

  test('a caller value can SATISFY a required key', async () => {
    const template = templateRow({
      prefill_schema: [
        { key: 'debtor_name', label: 'D', type: 'text', resolver: 'debtor1.name', required: true },
        { key: 'fee', label: 'F', type: 'money', resolver: null, default: null, required: true },
      ],
    });
    const db = wiredDb({ template });
    await expect(sendService.sendFromTemplate(db, args({ values: { fee: '1800' } })))
      .resolves.toMatchObject({ testing: true });
  });

  test('inactive template → ESIGN_TEMPLATE_INACTIVE before any work', async () => {
    const db = wiredDb({ template: templateRow({ active: false }) });
    await expect(sendService.sendFromTemplate(db, args())).rejects.toMatchObject({
      code: 'ESIGN_TEMPLATE_INACTIVE',
    });
    expect(pdfRenderService.renderHtmlToPdf).not.toHaveBeenCalled();
  });

  test('unknown template → ESIGN_NOT_FOUND', async () => {
    const db = wiredDb({ template: null });
    await expect(sendService.sendFromTemplate(db, args())).rejects.toMatchObject({
      code: 'ESIGN_NOT_FOUND',
    });
  });

  test('the template kind passes validateSendInput via the active-kind union query', async () => {
    const db = wiredDb();
    await sendService.sendFromTemplate(db, args());
    expect(db.calls.some((c) => c.sql.includes('SELECT DISTINCT kind'))).toBe(true);
  });

  test('no debtor1 (contact-less data) → document name falls back to the template name', async () => {
    const db = makeDb()
      .when('FROM contract_templates WHERE id', [templateRow({
        prefill_schema: [{ key: 'debtor_name', label: 'D', type: 'text', resolver: 'debtor1.name',
                           default: 'TBD', required: false },
                         { key: 'fee', label: 'F', type: 'money', resolver: null, default: '1500', required: true }],
      })])
      .when('SELECT DISTINCT kind FROM contract_templates', [{ kind: 'retainer_custom' }])
      .when('SELECT case_id FROM cases WHERE case_id', [{ case_id: CASE_ROW.case_id }])
      .when('SELECT * FROM cases WHERE case_id', [CASE_ROW])
      .when("case_relate_type = 'Primary'", [])
      .when("case_relate_type = 'Secondary'", []);

    await sendService.sendFromTemplate(db, args());
    expect(esignService.createRequest.mock.calls[0][1].documentName).toBe('Retainer Agreement');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KIND UNION (ad-hoc sends)
// ─────────────────────────────────────────────────────────────────────────────

describe('validateSendInput — template kinds', () => {
  test('a static KIND asks the db nothing', async () => {
    const db = makeDb().when('SELECT case_id FROM cases WHERE case_id', [{ case_id: 'AbC12dEf' }]);
    await sendService.validateSendInput(db, {
      linkableType: 'case', linkableId: 'AbC12dEf', kind: 'schedules',
      documentName: 'Schedules Packet', recipients: RECIPIENTS,
    });
    expect(db.calls.some((c) => c.sql.includes('DISTINCT kind'))).toBe(false);
  });

  test('an active template kind is legal for an AD-HOC send too', async () => {
    const db = makeDb()
      .when('SELECT DISTINCT kind FROM contract_templates', [{ kind: 'reaff_2026' }])
      .when('SELECT case_id FROM cases WHERE case_id', [{ case_id: 'AbC12dEf' }]);
    await expect(sendService.validateSendInput(db, {
      linkableType: 'case', linkableId: 'AbC12dEf', kind: 'reaff_2026',
      documentName: 'Reaffirmation Agreement', recipients: RECIPIENTS,
    })).resolves.toMatchObject({ kind: 'reaff_2026' });
  });

  test('a kind on NO active template still fails, listing the union', async () => {
    const db = makeDb()
      .when('SELECT DISTINCT kind FROM contract_templates', [{ kind: 'reaff_2026' }]);
    await expect(sendService.validateSendInput(db, {
      linkableType: 'case', linkableId: 'AbC12dEf', kind: 'nonsense',
      documentName: 'X Y Z', recipients: RECIPIENTS,
    })).rejects.toMatchObject({
      code: 'ESIGN_BAD_KIND',
      message: expect.stringContaining('reaff_2026'),
    });
  });

  test('legalKinds() = KINDS ∪ active template kinds, deduplicated', async () => {
    const db = makeDb()
      .when('SELECT DISTINCT kind FROM contract_templates',
            [{ kind: 'reaff_2026' }, { kind: 'schedules' }]);
    const kinds = await sendService.legalKinds(db);
    expect(kinds).toEqual([...sendService.KINDS, 'reaff_2026']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PREVIEW
// ─────────────────────────────────────────────────────────────────────────────

describe('previewFromTemplate', () => {
  test('renders with blanks filled, reports missing, and touches NOTHING transactional', async () => {
    const template = templateRow({
      prefill_schema: [
        { key: 'debtor_name', label: 'D', type: 'text', resolver: 'debtor1.name', required: true },
        { key: 'fee', label: 'F', type: 'money', resolver: null, default: null, required: true },
      ],
      body: '<p>{{debtor_name}} — {{fee}}</p>',
    });
    const db = wiredDb({ template });

    const out = await sendService.previewFromTemplate(db, {
      templateId: 7, linkableType: 'case', linkableId: 'AbC12dEf',
    });

    expect(Buffer.isBuffer(out.pdfBuffer)).toBe(true);
    expect(out.missing).toEqual(['fee']);
    expect(out.template).toEqual({ id: 7, name: 'Retainer Agreement' });

    const html = pdfRenderService.renderHtmlToPdf.mock.calls[0][0];
    expect(html).toContain('John Q Smith');
    expect(html).not.toContain('{{');

    // The whole point: a preview creates no row, calls no vendor, spends nothing.
    expect(esignService.createRequest).not.toHaveBeenCalled();
    expect(getProvider).not.toHaveBeenCalled();
    expect(require('../services/esign').recordCreditSpend).not.toHaveBeenCalled();
  });

  test('no linkable → authoring-time preview (defaults + supplied values only)', async () => {
    const db = makeDb().when('FROM contract_templates WHERE id', [templateRow()]);
    const out = await sendService.previewFromTemplate(db, {
      templateId: 7, values: { debtor_name: 'Sample Debtor' },
    });
    const html = pdfRenderService.renderHtmlToPdf.mock.calls[0][0];
    expect(html).toContain('Sample Debtor');
    expect(html).toContain('$1,500.00');
    expect(out.missing).toEqual([]);
  });

  test('inactive templates ARE previewable (the author is reworking it)', async () => {
    const db = wiredDb({ template: templateRow({ active: false }) });
    await expect(sendService.previewFromTemplate(db, {
      templateId: 7, linkableType: 'case', linkableId: 'AbC12dEf',
    })).resolves.toMatchObject({ template: { id: 7 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

describe('routes/api.esign.templates.js', () => {
  const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
  const templatesRouter = require('../routes/api.esign.templates');

  function routesOf(router) {
    return router.stack
      .filter((l) => l.route)
      .map((l) => ({
        path: l.route.path,
        methods: Object.keys(l.route.methods),
        handles: l.route.stack.map((h) => h.handle),
      }));
  }

  test('every template route is behind jwtOrApiKey', () => {
    const routes = routesOf(templatesRouter);
    expect(routes.length).toBe(13);  // 2E: POST+GET /templates/:id/pdf, POST /resolve-prefills; 2026-07-22: POST /inline-images
    for (const r of routes) {
      expect(r.handles).toContain(jwtOrApiKey);
    }
  });

  test('the expected endpoints exist', () => {
    const sigs = routesOf(templatesRouter)
      .map((r) => `${r.methods[0].toUpperCase()} ${r.path}`).sort();
    expect(sigs).toEqual([
      'GET /api/esign/template-meta',
      'GET /api/esign/templates',
      'GET /api/esign/templates/:id',
      'GET /api/esign/templates/:id/pdf',
      'POST /api/esign/inline-images',
      'POST /api/esign/resolve-prefills',
      'POST /api/esign/send-from-template',
      'POST /api/esign/templates',
      'POST /api/esign/templates/:id/deactivate',
      'POST /api/esign/templates/:id/pdf',
      'POST /api/esign/templates/:id/prefills',
      'POST /api/esign/templates/:id/preview',
      'PUT /api/esign/templates/:id',
    ]);
  });

  // ── POST /:id/prefills (2C) ───────────────────────────────
  // Behavioral: returns {values, missing} and NOTHING else — resolvePrefills
  // also yields `context` (raw case + debtor rows, SSN included), which must
  // never reach the browser.
  test('prefills route returns values+missing only — context never leaks', async () => {
    const handler = routesOf(templatesRouter)
      .find((r) => r.path === '/api/esign/templates/:id/prefills').handles.slice(-1)[0];

    const req = {
      db: wiredDb({}),
      params: { id: '7' },
      body: { linkable_type: 'case', linkable_id: 'AbC12dEf' },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handler(req, res);

    expect(res.json).toHaveBeenCalledTimes(1);
    const body = res.json.mock.calls[0][0];
    expect(Object.keys(body).sort()).toEqual(['missing', 'values']);
    expect(body.values.debtor_name).toBe('John Q Smith');
    expect(res.status).not.toHaveBeenCalled();   // 200 path
  });

  test('prefills route with no linkable resolves defaults only (authoring mode)', async () => {
    const handler = routesOf(templatesRouter)
      .find((r) => r.path === '/api/esign/templates/:id/prefills').handles.slice(-1)[0];
    const req = { db: wiredDb({}), params: { id: '7' }, body: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handler(req, res);
    const body = res.json.mock.calls[0][0];
    // No case → resolver-backed keys come back empty and land in missing.
    expect(body.missing).toContain('debtor_name');
  });

  test('the actions router GET :id is digit-constrained so /templates falls through to this router', () => {
    const actions = require('../routes/api.esign.actions');
    const getById = actions.stack.filter((l) => l.route)
      .find((l) => l.route.path.startsWith('/api/esign/:id(') && l.route.methods.get);
    expect(getById).toBeTruthy();
    expect(getById.regexp.test('/api/esign/123')).toBe(true);
    expect(getById.regexp.test('/api/esign/templates')).toBe(false);
  });

  test.each([
    ['ESIGN_BAD_TEMPLATE',           400],
    ['ESIGN_BAD_PREFILL_SCHEMA',     400],
    ['ESIGN_BAD_RESOLVER',           400],
    ['ESIGN_UNDECLARED_PLACEHOLDER', 400],
    ['ESIGN_MISSING_PREFILL',        400],
    ['ESIGN_RENDER_EXTERNAL_REF',    400],
    ['ESIGN_INLINE_BAD_INPUT',       400],
    ['ESIGN_TEMPLATE_INACTIVE',      409],
    ['ESIGN_RENDER_NO_BROWSER',      502],
    ['ESIGN_RENDER_FAILED',          502],
    // inherited from the actions map
    ['ESIGN_NOT_FOUND',              404],
    ['ESIGN_BAD_KIND',               400],
    ['ESIGN_INVALID_INPUT',          400],
    ['SOMETHING_UNEXPECTED',         500],
  ])('%s maps to HTTP %i', (code, status) => {
    expect(templatesRouter._errorToStatus(code)).toBe(status);
  });

  // ── fail() forwards .urls (2026-07-22) ─────────────────────
  // ESIGN_RENDER_EXTERNAL_REF names the blocked urls; templateAdmin's
  // error-flow offer for the image inliner reads them from the error body,
  // so the route must forward them the way it already forwards `missing`.
  test('an ESIGN_RENDER_EXTERNAL_REF response body carries the blocked urls', async () => {
    const err = new Error('The template references external resources.');
    err.code = 'ESIGN_RENDER_EXTERNAL_REF';
    err.urls = ['https://cdn.example.com/logo.png'];
    // sendService is the REAL module in this suite — spy, don't reach for a
    // mock that isn't there. The route requires the same module instance.
    const spy = jest.spyOn(sendService, 'previewFromTemplate').mockRejectedValueOnce(err);

    const handler = routesOf(templatesRouter)
      .find((r) => r.path === '/api/esign/templates/:id/preview').handles.slice(-1)[0];
    const req = { db: wiredDb({}), params: { id: '7' }, body: {} };
    const res = {
      status: jest.fn().mockReturnThis(), json: jest.fn(),
      set: jest.fn(), send: jest.fn(),
    };
    await handler(req, res);
    spy.mockRestore();

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0]).toMatchObject({
      code: 'ESIGN_RENDER_EXTERNAL_REF',
      urls: ['https://cdn.example.com/logo.png'],
    });
  });
});
// ═════════════════════════════════════════════════════════════════════════════
// PHASE 2E — pdf-type templates
// ═════════════════════════════════════════════════════════════════════════════

const zlib2E = require('zlib');
function inflate2E(buf) {
  let text = '';
  let i = 0;
  for (;;) {
    const s = buf.indexOf('stream', i);
    if (s === -1) break;
    let start = s + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const e = buf.indexOf('endstream', start);
    if (e === -1) break;
    const raw = buf.subarray(start, e);
    try { text += zlib2E.inflateSync(raw).toString('latin1') + '\n'; }
    catch { text += raw.toString('latin1') + '\n'; }
    i = e + 9;
  }
  return text;
}
const hex2E = (v) => Buffer.from(v, 'latin1').toString('hex').toUpperCase();

/** A valid PDF-TYPE template: no body; the debtor name lands via a text field. */
function pdfTemplateInput(overrides = {}) {
  const base = validTemplateInput();
  return {
    ...base,
    templateType: 'pdf',
    body: '',
    placementJson: {
      coord_space: 'pdf_user_space',
      fields: [
        { page: 1, x: 100, y: 600, w: 220, h: 18, type: 'text', key: 'debtor_name' },
        { page: 1, x: 100, y: 100, w: 180, h: 30, type: 'signature', signer: 1 },
      ],
    },
    ...overrides,
  };
}
function pdfTemplateRow(overrides = {}) {
  const input = pdfTemplateInput();
  return templateRow({
    template_type: 'pdf',
    body: '',
    placement_json: input.placementJson,
    ...overrides,
  });
}
/** wiredDb + the stored template PDF blob. */
function pdfWiredDb({ template = pdfTemplateRow(), blob = buildPdf(1) } = {}) {
  const db = wiredDb({ template });
  if (blob) {
    db.when('FROM contract_template_pdfs WHERE template_id',
      [{ pdf: blob, size: blob.length, original_name: 'retainer.pdf' }]);
  }
  return db;
}

describe('POST /api/esign/resolve-prefills (2E) — leak guard', () => {
  test('returns values+missing only; context (raw contact rows) never leaks', async () => {
    const templatesRouter = require('../routes/api.esign.templates');
    const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
    const layer = templatesRouter.stack.find((l) =>
      l.route && l.route.path === '/api/esign/resolve-prefills');
    expect(layer.route.stack.map((h) => h.handle)).toContain(jwtOrApiKey);
    const handler = layer.route.stack.slice(-1)[0].handle;

    const req = {
      db: wiredDb({}),
      body: {
        linkable_type: 'case', linkable_id: 'AbC12dEf',
        schema: [
          { key: 'debtor_name', label: 'Debtor', type: 'text', resolver: 'debtor1.name', default: null, required: true },
        ],
      },
    };
    let sent;
    const res = { json: (o) => { sent = o; }, status() { return this; } };
    await handler(req, res);

    expect(sent.values.debtor_name).toBe('John Q Smith');
    expect(Object.keys(sent).sort()).toEqual(['missing', 'values']); // nothing else
  });
});

describe('validateTemplateInput — template_type (2E)', () => {
  test('pdf type: empty body is legal and forced to ""', () => {
    const { clean } = templateService.validateTemplateInput(
      pdfTemplateInput({ body: '<p>ignored {{stray}}</p>' }), WL);
    expect(clean.templateType).toBe('pdf');
    expect(clean.body).toBe(''); // whatever arrived, a pdf template stores no body
  });

  test('html default preserved; bad type throws', () => {
    const { clean } = templateService.validateTemplateInput(validTemplateInput(), WL);
    expect(clean.templateType).toBe('html');
    expect(() => templateService.validateTemplateInput(
      validTemplateInput({ templateType: 'docx' }), WL
    )).toThrow(expect.objectContaining({ code: 'ESIGN_BAD_TEMPLATE' }));
  });

  test('pdf: placement text key NOT in schema throws — the pdf mirror of body↔schema', () => {
    const bad = pdfTemplateInput();
    bad.placementJson.fields[0].key = 'not_declared';
    expect(() => templateService.validateTemplateInput(bad, WL))
      .toThrow(expect.objectContaining({ code: 'ESIGN_UNDECLARED_PLACEHOLDER' }));
  });

  test('pdf: declared-but-unplaced key warns, does not block', () => {
    const { warnings } = templateService.validateTemplateInput(pdfTemplateInput(), WL);
    // 'fee' is declared in the schema but has no text field
    expect(warnings.join(' ')).toContain('fee');
  });

  test('html: text placement fields are rejected — one injection mechanism per type', () => {
    const bad = validTemplateInput();
    bad.placementJson.fields.push({ page: 1, x: 10, y: 10, w: 80, h: 14, type: 'text', key: 'debtor_name' });
    expect(() => templateService.validateTemplateInput(bad, WL))
      .toThrow(/only valid on pdf-type/);
  });
});

describe('updateTemplate — template_type immutability (2E)', () => {
  test('sending a DIFFERENT type throws; the SAME type passes through', async () => {
    const db = wiredDb({ template: templateRow() })
      .when('UPDATE contract_templates', () => ({ affectedRows: 1 }));

    await expect(templateService.updateTemplate(db, 7, { templateType: 'pdf' }, WL))
      .rejects.toMatchObject({ code: 'ESIGN_BAD_TEMPLATE' });

    await expect(templateService.updateTemplate(
      db, 7, { templateType: 'html', name: 'Retainer Agreement v2' }, WL
    )).resolves.toBeTruthy();
  });
});

describe('setTemplatePdf / getTemplatePdf (2E)', () => {
  test('happy path: sniffed, capped, upserted with size + name', async () => {
    const blob = buildPdf(1);
    const db = pdfWiredDb({ blob: null });
    db.when('INSERT INTO contract_template_pdfs', () => ({ affectedRows: 1 }));

    const out = await templateService.setTemplatePdf(db, 7, blob, 'retainer.pdf');
    expect(out).toEqual({ template_id: 7, size: blob.length });

    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO contract_template_pdfs'));
    expect(insert.params).toEqual([7, blob, blob.length, 'retainer.pdf']);
    expect(insert.sql).toContain('ON DUPLICATE KEY UPDATE');
  });

  test('html-type template refuses a PDF', async () => {
    const db = wiredDb({ template: templateRow() }); // template_type html
    await expect(templateService.setTemplatePdf(db, 7, buildPdf(1), 'x.pdf'))
      .rejects.toMatchObject({ code: 'ESIGN_BAD_TEMPLATE' });
  });

  test('non-PDF bytes refused by the shared sniff', async () => {
    const db = pdfWiredDb({ blob: null });
    await expect(templateService.setTemplatePdf(db, 7, Buffer.from('not a pdf'), 'x.pdf'))
      .rejects.toMatchObject({ code: 'ESIGN_BAD_PDF' });
  });

  test('oversize refused with the named limit', async () => {
    const db = pdfWiredDb({ blob: null });
    const big = Buffer.alloc(templateService.MAX_TEMPLATE_PDF_BYTES + 1, 0x25);
    await expect(templateService.setTemplatePdf(db, 7, big, 'x.pdf'))
      .rejects.toMatchObject({ code: 'ESIGN_PDF_TOO_LARGE' });
  });

  test('getTemplatePdf: buffer round-trip, null when absent', async () => {
    const blob = buildPdf(1);
    const out = await templateService.getTemplatePdf(pdfWiredDb({ blob }), 7);
    expect(out.buffer.equals(blob)).toBe(true);
    expect(out.original_name).toBe('retainer.pdf');
    await expect(templateService.getTemplatePdf(pdfWiredDb({ blob: null }), 7)).resolves.toBeNull();
  });
});

describe('sendFromTemplate — pdf type (2E)', () => {
  function pdfArgs(over = {}) {
    return {
      templateId: 7,
      linkableType: 'case', linkableId: 'AbC12dEf',
      recipients: RECIPIENTS,
      values: { fee: '1500' },
      createdBy: 1,
      ...over,
    };
  }

  test('sends the stored blob, filled + stamped; chromium never runs', async () => {
    const db = pdfWiredDb();
    const out = await sendService.sendFromTemplate(db, pdfArgs());
    expect(out.testing).toBe(true);

    expect(pdfRenderService.renderHtmlToPdf).not.toHaveBeenCalled();

    // The provider received the STAMPED buffer with the resolved debtor name
    // drawn into the text field (resolver debtor1.name → DEBTOR1).
    const provider = await getProvider.mock.results[0].value;
    const sent = provider.sendForSignature.mock.calls[0][0];
    const streams = inflate2E(sent.pdfBuffer);
    expect(streams).toContain(hex2E('John Q Smith'));
    expect(streams).toContain(hex2E('Doc Ctrl: YC-AbC12dEf-retainer_custom-9F3A21BC'));

    // The STORED source is filled but UNSTAMPED — both resend branches re-stamp.
    const stored = esignService.storeSourcePdf.mock.calls[0];
    expect(stored[1]).toBe(42);
    const storedStreams = inflate2E(stored[2]);
    expect(storedStreams).toContain(hex2E('John Q Smith'));
    expect(storedStreams).not.toContain(hex2E('Doc Ctrl:'));
  });

  test('missing blob → ESIGN_TEMPLATE_NO_PDF, nothing sent', async () => {
    const db = pdfWiredDb({ blob: null });
    await expect(sendService.sendFromTemplate(db, pdfArgs()))
      .rejects.toMatchObject({ code: 'ESIGN_TEMPLATE_NO_PDF' });
    expect(esignService.createRequest).not.toHaveBeenCalled();
  });

  test('required-missing still gates BEFORE the blob is touched', async () => {
    // fee is required with a default; kill the default and the caller value.
    const t = pdfTemplateRow();
    t.prefill_schema = t.prefill_schema.map((e) =>
      e.key === 'fee' ? { ...e, default: null } : e);
    const db = pdfWiredDb({ template: t });
    await expect(sendService.sendFromTemplate(db, pdfArgs({ values: {} })))
      .rejects.toMatchObject({ code: 'ESIGN_MISSING_PREFILL' });
  });
});

describe('previewFromTemplate — pdf type (2E)', () => {
  test('fills via pdf-lib, no chromium, blanks stay blank', async () => {
    const db = pdfWiredDb();
    const out = await sendService.previewFromTemplate(db, {
      templateId: 7, linkableType: 'case', linkableId: 'AbC12dEf',
    });
    expect(pdfRenderService.renderHtmlToPdf).not.toHaveBeenCalled();
    expect(inflate2E(out.pdfBuffer)).toContain(hex2E('John Q Smith'));
    // fee has a default ('1500' money) so nothing is missing here
    expect(out.missing).toEqual([]);
  });

  test('missing blob → ESIGN_TEMPLATE_NO_PDF', async () => {
    await expect(sendService.previewFromTemplate(pdfWiredDb({ blob: null }), { templateId: 7 }))
      .rejects.toMatchObject({ code: 'ESIGN_TEMPLATE_NO_PDF' });
  });
});
