// tests/documentGenerateService.test.js
//
/**
 * G2 — services/documentGenerateService.js.
 *
 * The non-esign twin of sendFromTemplate: template in, filed PDF out, no
 * envelope. What is under test:
 *   1. the PURPOSE guard — a signature-only template is refused, and refused
 *      BEFORE anything is rendered or filed;
 *   2. required values are a hard stop carrying `.missing`, while NON-required
 *      blanks render and are merely reported (the deliberate asymmetry with
 *      the send path);
 *   3. the happy path renders through templateRenderService and files through
 *      filePlacementService with the TEMPLATE'S subfolder and a date-first
 *      filename;
 *   4. no envelope, no provider, no credits — the negative that defines this
 *      module.
 *
 * pdfRenderService and filePlacementService are mocked: what is under test is
 * the ORCHESTRATION, and both have their own suites
 * (tests/esignTemplates.test.js, tests/filePlacementService.test.js).
 *
 *   npx jest tests/documentGenerateService.test.js
 */

'use strict';

jest.mock('../services/pdfRenderService', () => ({
  renderHtmlToPdf: jest.fn(async () => Buffer.from('%PDF-1.7 generated')),
}));

jest.mock('../services/filePlacementService', () => ({
  placeAndRegister: jest.fn(async () => ({
    path: '/Clients/Smith, John/Notices/2026-09-01 Discharge Notice – Smith.pdf',
    file_name: '2026-09-01 Discharge Notice – Smith.pdf',
    placement: 'case',
    placement_note: null,
    temp_link: 'https://dl/x',
    temp_link_expires_note: 'Dropbox temporary link — expires ~4 hours after creation',
    warnings: [],
    credential_id: 8,
    document_id: 909,
  })),
  identityPrefixFor: jest.fn(async () => 'AbC12dEf - Smith, John - '),
  // The real one — the filename rule under test is "sanitized the same way
  // formPdfService does", and mocking it away would test nothing.
  sanitizeNameFragment: jest.requireActual('../services/filePlacementService').sanitizeNameFragment,
}));

// Never reached on the happy path, but present so a regression that DID reach
// for the provider fails loudly instead of hitting the network.
jest.mock('../services/esign', () => ({
  getProvider: jest.fn(() => { throw new Error('the generate path must not touch the provider'); }),
  recordCreditSpend: jest.fn(() => { throw new Error('the generate path must not spend credits'); }),
}));
jest.mock('../services/esignService', () => ({
  createRequest: jest.fn(() => { throw new Error('the generate path must not create rows'); }),
  LINKABLE_TYPES: ['case', 'contact'],
  TERMINAL: new Set(),
}));

process.env.FIRM_PHONE = '2484179800';
process.env.FIRM_EMAIL = 'office@4lsg.com';
process.env.FIRM_URL   = 'https://legalsolutions.group';

const pdfRenderService     = require('../services/pdfRenderService');
const filePlacementService = require('../services/filePlacementService');
const esignTemplateService = require('../services/esignTemplateService');
const generateService      = require('../services/documentGenerateService');

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES
// ─────────────────────────────────────────────────────────────────────────────

const CASE_ROW = {
  case_id: 'AbC12dEf',
  case_number: '26-41234',
  case_number_full: '26-41234-tjt',
  case_chapter: '7',
  case_open_date: new Date('2026-03-15T00:00:00.000Z'),
};
const DEBTOR1 = {
  contact_id: 101, contact_name: 'John Q Smith',
  contact_email: 'john@example.com', contact_phone: '3135551234',
};

function templateRow(over = {}) {
  return {
    id: 8,
    name: 'Discharge Notice',
    kind: 'notice',
    template_type: 'html',
    purpose: 'generate',
    file_subfolder: 'Notices',
    body: '<p>Dear {{debtor_name}}, case {{case_no}} is discharged. {{note}}</p>',
    prefill_schema: [
      { key: 'debtor_name', label: 'Debtor', type: 'text',
        resolver: 'debtor1.name', default: null, required: true },
      { key: 'case_no', label: 'Case number', type: 'text',
        resolver: 'case.case_number', default: null, required: true },
      { key: 'note', label: 'Note', type: 'text',
        resolver: null, default: null, required: false },
    ],
    placement_json: { coord_space: 'pdf_user_space', fields: [] },
    reminder_seq_id: null,
    completion_targets: null,
    reminders_off: false,
    expiration_days: 14,
    active: true,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

/**
 * A template carrying a required key NO resolver can fill ("fee"), so the
 * missing-required path can be exercised with the case context fully wired —
 * i.e. one specific key missing, rather than everything missing because the
 * case row was withheld.
 */
function templateWithManualKey(over = {}) {
  const base = templateRow();
  return {
    ...base,
    body: '<p>Dear {{debtor_name}}, case {{case_no}} is discharged. Fee: {{fee}}. {{note}}</p>',
    prefill_schema: [
      ...base.prefill_schema,
      { key: 'fee', label: 'Fee', type: 'money', resolver: null, default: null, required: true },
    ],
    ...over,
  };
}

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

/** db wired for the full case context + template. */
function wiredDb(template = templateRow()) {
  return makeDb()
    .when('FROM contract_templates WHERE id', template ? [template] : [])
    .when('SELECT * FROM cases WHERE case_id', [CASE_ROW])
    .when("case_relate_type = 'Primary'", [DEBTOR1])
    .when("case_relate_type = 'Secondary'", []);
}

const ARGS = { templateId: 8, linkableType: 'case', linkableId: 'AbC12dEf' };

const placeArgs = () => filePlacementService.placeAndRegister.mock.calls[0][1];

beforeEach(() => {
  jest.clearAllMocks();
  pdfRenderService.renderHtmlToPdf.mockResolvedValue(Buffer.from('%PDF-1.7 generated'));
  filePlacementService.placeAndRegister.mockResolvedValue({
    path: '/Clients/Smith, John/Notices/2026-09-01 Discharge Notice – Smith.pdf',
    file_name: '2026-09-01 Discharge Notice – Smith.pdf',
    placement: 'case',
    placement_note: null,
    temp_link: 'https://dl/x',
    temp_link_expires_note: 'Dropbox temporary link — expires ~4 hours after creation',
    warnings: [],
    credential_id: 8,
    document_id: 909,
  });
  filePlacementService.identityPrefixFor.mockResolvedValue('AbC12dEf - Smith, John - ');
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE PURPOSE GUARD
// ─────────────────────────────────────────────────────────────────────────────

describe('purpose guard', () => {
  test("refuses a signature-only template with ESIGN_TEMPLATE_PURPOSE", async () => {
    const db = wiredDb(templateRow({ purpose: 'esign' }));

    await expect(generateService.generateFromTemplate(db, ARGS)).rejects.toMatchObject({
      code: 'ESIGN_TEMPLATE_PURPOSE',
      message: expect.stringMatching(
        /"Discharge Notice" is a signature-only template; set its purpose to generate or both/),
    });
  });

  test('the refusal happens before ANY render or filing', async () => {
    const db = wiredDb(templateRow({ purpose: 'esign' }));
    await expect(generateService.generateFromTemplate(db, ARGS)).rejects.toThrow();
    expect(pdfRenderService.renderHtmlToPdf).not.toHaveBeenCalled();
    expect(filePlacementService.placeAndRegister).not.toHaveBeenCalled();
  });

  test.each(['generate', 'both'])("purpose '%s' is allowed through", async (purpose) => {
    const db = wiredDb(templateRow({ purpose }));
    const out = await generateService.generateFromTemplate(db, ARGS);
    expect(out.path).toBeTruthy();
  });

  test('an INACTIVE template reports inactive, not purpose — state before picker', async () => {
    const db = wiredDb(templateRow({ active: false }));
    await expect(generateService.generateFromTemplate(db, ARGS))
      .rejects.toMatchObject({ code: 'ESIGN_TEMPLATE_INACTIVE' });
  });

  test('a missing template is ESIGN_NOT_FOUND', async () => {
    const db = wiredDb(null);
    await expect(generateService.generateFromTemplate(db, ARGS))
      .rejects.toMatchObject({ code: 'ESIGN_NOT_FOUND' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. INPUT
// ─────────────────────────────────────────────────────────────────────────────

describe('input validation', () => {
  test.each([
    ['appt',      'appt'],
    ['undefined', undefined],
    ['empty',     ''],
  ])('linkable_type %s → ESIGN_BAD_LINKABLE', async (_l, linkableType) => {
    const db = wiredDb();
    await expect(generateService.generateFromTemplate(db, { ...ARGS, linkableType }))
      .rejects.toMatchObject({ code: 'ESIGN_BAD_LINKABLE' });
  });

  test.each([
    ['null',       null],
    ['empty',      ''],
    ['whitespace', '   '],
  ])('linkable_id %s → ESIGN_BAD_LINKABLE', async (_l, linkableId) => {
    const db = wiredDb();
    await expect(generateService.generateFromTemplate(db, { ...ARGS, linkableId }))
      .rejects.toMatchObject({
        code: 'ESIGN_BAD_LINKABLE',
        message: expect.stringMatching(/No case or contact was selected/),
      });
  });

  test('a non-integer template_id is refused before the DB is touched', async () => {
    const db = wiredDb();
    await expect(generateService.generateFromTemplate(db, { ...ARGS, templateId: 'eight' }))
      .rejects.toMatchObject({ code: 'ESIGN_BAD_TEMPLATE' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('linkable_id is trimmed on the way through', async () => {
    const db = wiredDb();
    const out = await generateService.generateFromTemplate(db, { ...ARGS, linkableId: ' AbC12dEf ' });
    expect(out.link_id).toBe('AbC12dEf');
    expect(placeArgs().linkId).toBe('AbC12dEf');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. VALUES — required stops, optional blanks do not
// ─────────────────────────────────────────────────────────────────────────────

describe('required values', () => {
  test('a required key no resolver can fill throws ESIGN_MISSING_PREFILL with .missing', async () => {
    const db = wiredDb(templateWithManualKey());

    await expect(generateService.generateFromTemplate(db, ARGS)).rejects.toMatchObject({
      code: 'ESIGN_MISSING_PREFILL',
      missing: ['fee'],
      // Wording is shared with sendFromTemplate on purpose — a staff member
      // reads the same sentence whichever path stopped.
      message: expect.stringMatching(/Required value\(s\) are still empty: fee/),
    });
  });

  test('every missing key is named, not just the first', async () => {
    // No case row and no debtor: both resolver-backed required keys come up
    // empty and the caller gets the whole list in one pass.
    const db = makeDb().when('FROM contract_templates WHERE id', [templateRow()]);

    await expect(generateService.generateFromTemplate(db, ARGS)).rejects.toMatchObject({
      code: 'ESIGN_MISSING_PREFILL',
      missing: ['debtor_name', 'case_no'],
    });
  });

  test('nothing is rendered or filed when a required value is missing', async () => {
    const db = wiredDb(templateWithManualKey());
    await expect(generateService.generateFromTemplate(db, ARGS)).rejects.toThrow();
    expect(pdfRenderService.renderHtmlToPdf).not.toHaveBeenCalled();
    expect(filePlacementService.placeAndRegister).not.toHaveBeenCalled();
  });

  test('a caller-supplied value satisfies a required key the resolvers could not', async () => {
    const db = wiredDb(templateWithManualKey());

    const out = await generateService.generateFromTemplate(db, {
      ...ARGS, values: { fee: '1500' },
    });

    expect(out.path).toBeTruthy();
    // 'money' formatting is applied on the way in — the value is not echoed raw.
    expect(pdfRenderService.renderHtmlToPdf.mock.calls[0][0]).toMatch(/Fee: \$?1,?500/);
  });
});

describe('optional blanks', () => {
  test('a non-required empty key RENDERS as blank and is reported in missing_optional', async () => {
    const db = wiredDb();

    const out = await generateService.generateFromTemplate(db, ARGS);

    expect(out.missing_optional).toEqual(['note']);
    const html = pdfRenderService.renderHtmlToPdf.mock.calls[0][0];
    // The placeholder is GONE, not left on the page as literal braces.
    expect(html).not.toContain('{{note}}');
    expect(html).toContain('John Q Smith');
    expect(html).toContain('26-41234');
  });

  test('a filled optional key drops out of missing_optional', async () => {
    const db = wiredDb();
    const out = await generateService.generateFromTemplate(db, {
      ...ARGS, values: { note: 'Keep this letter.' },
    });
    expect(out.missing_optional).toEqual([]);
    expect(pdfRenderService.renderHtmlToPdf.mock.calls[0][0]).toContain('Keep this letter.');
  });

  test('values are HTML-escaped — a prefill is data, never markup', async () => {
    const db = wiredDb();
    await generateService.generateFromTemplate(db, {
      ...ARGS, values: { note: '<script>alert(1)</script>' },
    });
    const html = pdfRenderService.renderHtmlToPdf.mock.calls[0][0];
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE HAPPY PATH
// ─────────────────────────────────────────────────────────────────────────────

describe('html happy path', () => {
  test('renders through pdfRenderService and files through placeAndRegister', async () => {
    const db = wiredDb();

    const out = await generateService.generateFromTemplate(db, { ...ARGS, createdBy: 9 });

    expect(pdfRenderService.renderHtmlToPdf).toHaveBeenCalledTimes(1);
    expect(filePlacementService.placeAndRegister).toHaveBeenCalledTimes(1);
    expect(placeArgs().content).toEqual(Buffer.from('%PDF-1.7 generated'));
    expect(placeArgs().createdBy).toBe(9);
    expect(out.document_id).toBe(909);
    expect(out.placement).toBe('case');
  });

  test("the subfolder is the TEMPLATE'S file_subfolder", async () => {
    const db = wiredDb(templateRow({ file_subfolder: 'Court Notices' }));
    await generateService.generateFromTemplate(db, ARGS);
    expect(placeArgs().subfolder).toBe('Court Notices');
  });

  test('the filename is "{YYYY-MM-DD} {document name}.pdf"', async () => {
    const db = wiredDb();
    await generateService.generateFromTemplate(db, ARGS);
    expect(placeArgs().fileName).toMatch(/^\d{4}-\d{2}-\d{2} .+\.pdf$/);
    // Default document name = "{template} – {debtor surname}".
    expect(placeArgs().fileName).toContain('Discharge Notice – Smith');
  });

  test('an explicit document_name wins, sanitized as a path fragment', async () => {
    const db = wiredDb();
    const out = await generateService.generateFromTemplate(db, {
      ...ARGS, documentName: 'Notice: 26/41234 <final>',
    });
    expect(out.document_name).toBe('Notice: 26/41234 <final>');   // reported verbatim
    expect(placeArgs().fileName).toMatch(/^\d{4}-\d{2}-\d{2} Notice- 26-41234 -final-\.pdf$/);
    expect(placeArgs().fileName).not.toMatch(/[/\\:*?"<>|]/);
  });

  test('a blank document_name falls back to the default rather than to ""', async () => {
    const db = wiredDb();
    await generateService.generateFromTemplate(db, { ...ARGS, documentName: '   ' });
    expect(placeArgs().fileName).toContain('Discharge Notice – Smith');
  });

  test('the caller-specific plumbing reaches the ladder', async () => {
    const db = wiredDb();
    await generateService.generateFromTemplate(db, ARGS);
    expect(placeArgs()).toMatchObject({
      linkType: 'case',
      linkId: 'AbC12dEf',
      unsortedPathKey: 'dropbox_unsorted_generated_path',
      unsortedDefault: '/  Law Office/   Cases/  Unsorted Generated Documents',
      unsortedFilenamePrefix: 'AbC12dEf - Smith, John - ',
      eventSource: 'generated_doc',
      taskSource: 'doc_gen',
      logTag: '[DOC GEN]',
    });
    // Prose labels, so the bin the staff task names is the right one.
    expect(placeArgs().artifactLabel).toBe('generated document');
    expect(placeArgs().binLabel).toContain('generated-documents');
  });

  test('the bin default keeps the firm\'s leading-space sort convention', () => {
    expect(generateService.DEFAULT_UNSORTED_PATH)
      .toBe('/  Law Office/   Cases/  Unsorted Generated Documents');
    expect(generateService.DEFAULT_UNSORTED_PATH.startsWith('/  Law Office')).toBe(true);
    expect(generateService.UNSORTED_PATH_KEY).toBe('dropbox_unsorted_generated_path');
  });

  test('the verdict is returned WHOLE, with the template identity added', async () => {
    const db = wiredDb();
    const out = await generateService.generateFromTemplate(db, ARGS);
    expect(out).toMatchObject({
      path: '/Clients/Smith, John/Notices/2026-09-01 Discharge Notice – Smith.pdf',
      file_name: '2026-09-01 Discharge Notice – Smith.pdf',
      placement: 'case',
      temp_link: 'https://dl/x',
      credential_id: 8,
      document_id: 909,
      template_id: 8,
      template_name: 'Discharge Notice',
      link_type: 'case',
      link_id: 'AbC12dEf',
    });
    expect(out.document_name).toBe('Discharge Notice – Smith');
  });

  test('an unsorted verdict passes its note and warnings straight through', async () => {
    filePlacementService.placeAndRegister.mockResolvedValue({
      path: '/bin/AbC12dEf - Smith, John/n.pdf', file_name: 'n.pdf',
      placement: 'unsorted', placement_note: 'could not be filed to the case folder',
      temp_link: null, temp_link_expires_note: null,
      warnings: ['could not be filed to the case folder'],
      credential_id: 8, document_id: null,
    });
    const db = wiredDb();
    const out = await generateService.generateFromTemplate(db, ARGS);
    expect(out.placement).toBe('unsorted');
    expect(out.placement_note).toContain('could not be filed');
    expect(out.temp_link).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. pdf-type templates
// ─────────────────────────────────────────────────────────────────────────────

describe('pdf-type templates', () => {
  test('a pdf template with no source PDF is ESIGN_TEMPLATE_NO_PDF', async () => {
    const db = wiredDb(templateRow({ template_type: 'pdf', body: '' }));
    await expect(generateService.generateFromTemplate(db, ARGS))
      .rejects.toMatchObject({ code: 'ESIGN_TEMPLATE_NO_PDF' });
    expect(filePlacementService.placeAndRegister).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE DEFINING NEGATIVE
// ─────────────────────────────────────────────────────────────────────────────

describe('no envelope', () => {
  test('creates no signing_requests row, calls no provider, spends no credits', async () => {
    // Every one of those mocks THROWS if touched (see the top of this file),
    // so a clean run is the assertion. Belt and braces on the row anyway.
    const db = wiredDb();
    const out = await generateService.generateFromTemplate(db, ARGS);

    expect(out.path).toBeTruthy();
    expect(db.calls.some((c) => /INSERT INTO signing_requests/i.test(c.sql))).toBe(false);
    expect(db.calls.every((c) => /^\s*SELECT/i.test(c.sql))).toBe(true);
  });

  test('the template row itself is never written', async () => {
    const db = wiredDb();
    await generateService.generateFromTemplate(db, ARGS);
    expect(db.calls.some((c) => /UPDATE contract_templates/i.test(c.sql))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. DEPLOY-ORDER INSURANCE
// ─────────────────────────────────────────────────────────────────────────────

describe('un-migrated tolerance', () => {
  test('a row with no file_subfolder falls back rather than filing to the case ROOT', async () => {
    // Only reachable if the backend ships ahead of its migration. Silently
    // dropping the subfolder would scatter documents into case folder roots
    // and nobody would notice until someone went looking.
    const row = templateRow();
    delete row.file_subfolder;
    const db = wiredDb(row);

    await generateService.generateFromTemplate(db, ARGS);

    expect(placeArgs().subfolder).toBe(esignTemplateService.DEFAULT_FILE_SUBFOLDER);
    expect(placeArgs().subfolder).toBe('Generated Documents');
  });
});
