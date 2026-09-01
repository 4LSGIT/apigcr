// tests/esignTemplates.purpose.test.js
//
/**
 * G2 — contract_templates.purpose + file_subfolder.
 *
 * What is under test (2B's own coverage stays in tests/esignTemplates.test.js):
 *   1. validateTemplateInput accepts/rejects the two new fields, defaults them,
 *      and normalizes what it keeps;
 *   2. createTemplate and updateTemplate actually PERSIST them — including the
 *      partial-update rule that an absent field keeps its stored value;
 *   3. listTemplates composes the purpose predicate correctly against the
 *      activeOnly one. That is SQL-shape testing on purpose: the two clauses
 *      are ANDed into one WHERE and the bug this catches is a second WHERE
 *      keyword, which no amount of row-fixture assertion would notice.
 *   4. sendFromTemplate refuses a generate-only template.
 *
 * NO network, NO real DB. The db is a dispatcher over SQL substrings, the same
 * makeDb idiom tests/esignTemplates.test.js uses.
 *
 *   npx jest tests/esignTemplates.purpose.test.js
 */

'use strict';

jest.mock('../services/esignService', () => ({
  LINKABLE_TYPES: ['case', 'contact'],
  TERMINAL: new Set(),
}));
jest.mock('../services/esign', () => ({
  getProvider: jest.fn(),
  recordCreditSpend: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/pdfRenderService', () => ({
  renderHtmlToPdf: jest.fn(async () => Buffer.from('%PDF-1.7 fake')),
}));

const templateService = require('../services/esignTemplateService');
const prefillService  = require('../services/esignPrefillService');
const sendService     = require('../services/esignSendService');

const WL = prefillService.RESOLVER_NAMES;

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES
// ─────────────────────────────────────────────────────────────────────────────

function validInput(overrides = {}) {
  return {
    name: 'Discharge Notice',
    kind: 'notice',
    body: '<p>Dear {{debtor_name}}, your case is discharged.</p>',
    prefillSchema: [
      { key: 'debtor_name', label: 'Debtor name', type: 'text',
        resolver: 'debtor1.name', default: null, required: true },
    ],
    placementJson: { coord_space: 'pdf_user_space', fields: [] },
    expirationDays: 14,
    ...overrides,
  };
}

/** getTemplate-shaped row. */
function templateRow(overrides = {}) {
  const input = validInput();
  return {
    id: 8,
    name: input.name,
    kind: input.kind,
    template_type: 'html',
    purpose: 'generate',
    file_subfolder: 'Notices',
    body: input.body,
    prefill_schema: input.prefillSchema,
    placement_json: input.placementJson,
    reminder_seq_id: null,
    completion_targets: null,
    reminders_off: false,
    expiration_days: 14,
    active: true,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeDb() {
  const rules = [];
  const calls = [];
  return {
    calls,
    when(substr, rows) { rules.push({ substr, rows }); return this; },
    lastSql(substr) {
      const hit = [...calls].reverse().find((c) => c.sql.includes(substr));
      return hit ? hit.sql : null;
    },
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

/** Normalize whitespace so a SQL assertion is about clauses, not indentation. */
const flat = (sql) => String(sql).replace(/\s+/g, ' ').trim();

// ─────────────────────────────────────────────────────────────────────────────
// 1. VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe('purpose validation', () => {
  test('defaults to esign — the whole reason the migration is safe on live data', () => {
    const { clean } = templateService.validateTemplateInput(validInput(), WL);
    expect(clean.purpose).toBe('esign');
    expect(templateService.DEFAULT_PURPOSE).toBe('esign');
  });

  test.each(['esign', 'generate', 'both'])('accepts %s', (purpose) => {
    const { clean } = templateService.validateTemplateInput(validInput({ purpose }), WL);
    expect(clean.purpose).toBe(purpose);
  });

  test('rejects anything else, naming the legal set', () => {
    expect(() => templateService.validateTemplateInput(validInput({ purpose: 'generative' }), WL))
      .toThrow(/purpose "generative" is invalid.*esign, generate, both/s);
  });

  test('an explicit null falls back to the default rather than throwing', () => {
    // Destructuring defaults only cover `undefined`; a UI that clears a select
    // sends null, and that must mean "the default", not a 400.
    const { clean } = templateService.validateTemplateInput(validInput({ purpose: null }), WL);
    expect(clean.purpose).toBe('esign');
  });

  test('the rejection carries ESIGN_BAD_TEMPLATE, which the route maps to 400', () => {
    try {
      templateService.validateTemplateInput(validInput({ purpose: 'x' }), WL);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('ESIGN_BAD_TEMPLATE');
    }
  });

  test('PURPOSES is exported and frozen — the UI builds its select from it', () => {
    expect(templateService.PURPOSES).toEqual(['esign', 'generate', 'both']);
    expect(Object.isFrozen(templateService.PURPOSES)).toBe(true);
  });
});

describe('file_subfolder validation', () => {
  test('defaults to "Generated Documents"', () => {
    const { clean } = templateService.validateTemplateInput(validInput(), WL);
    expect(clean.fileSubfolder).toBe('Generated Documents');
    expect(templateService.DEFAULT_FILE_SUBFOLDER).toBe('Generated Documents');
  });

  test('is trimmed', () => {
    const { clean } = templateService.validateTemplateInput(
      validInput({ fileSubfolder: '  Notices  ' }), WL);
    expect(clean.fileSubfolder).toBe('Notices');
  });

  test('rejects empty and whitespace-only', () => {
    for (const v of ['', '   ']) {
      expect(() => templateService.validateTemplateInput(validInput({ fileSubfolder: v }), WL))
        .toThrow(/file_subfolder must be 1–64 characters/);
    }
  });

  test('rejects over 64 chars — sql_mode is not strict, so it would truncate silently', () => {
    expect(() => templateService.validateTemplateInput(
      validInput({ fileSubfolder: 'N'.repeat(65) }), WL))
      .toThrow(/file_subfolder must be 1–64 characters/);
    // 64 exactly is fine.
    const { clean } = templateService.validateTemplateInput(
      validInput({ fileSubfolder: 'N'.repeat(64) }), WL);
    expect(clean.fileSubfolder).toHaveLength(64);
  });

  test.each([
    ['forward slash — would create a nested tree nobody asked for', 'Notices/2026'],
    ['back slash',  'Notices\\2026'],
    ['colon',       'Notices: final'],
    ['asterisk',    'Notices*'],
    ['question',    'Notices?'],
    ['quote',       'Notices"'],
    ['less than',   '<Notices'],
    ['greater than', 'Notices>'],
    ['pipe',        'Notices|Letters'],
    ['control char', 'Notices\u0007'],
  ])('rejects %s', (_label, value) => {
    expect(() => templateService.validateTemplateInput(
      validInput({ fileSubfolder: value }), WL))
      .toThrow(/file_subfolder must be a single folder name/);
  });

  test('the illegal-character check is not order-dependent', () => {
    // A /g regex's lastIndex makes repeated .test() calls alternate true/false.
    // Two identical bad values in a row must both be refused.
    for (let i = 0; i < 3; i++) {
      expect(() => templateService.validateTemplateInput(
        validInput({ fileSubfolder: 'a/b' }), WL)).toThrow(/single folder name/);
    }
  });

  test('leading spaces survive nothing — they are a PATH convention, not a name one', () => {
    // The firm's leading-space sort convention applies to folders staff name by
    // hand at the top of the tree, not to a subfolder we compose. Trimmed.
    const { clean } = templateService.validateTemplateInput(
      validInput({ fileSubfolder: '  Notices' }), WL);
    expect(clean.fileSubfolder).toBe('Notices');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────

describe('createTemplate persists both columns', () => {
  test('the INSERT names them and binds the validated values', async () => {
    const db = makeDb()
      .when('INSERT INTO contract_templates', { insertId: 8 })
      .when('FROM contract_templates WHERE id', [templateRow()]);

    await templateService.createTemplate(
      db, validInput({ purpose: 'both', fileSubfolder: 'Notices' }), WL);

    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO contract_templates'));
    expect(flat(insert.sql)).toContain('purpose, file_subfolder');
    expect(insert.params).toContain('both');
    expect(insert.params).toContain('Notices');
  });

  test('placeholder count still matches the column list', async () => {
    const db = makeDb()
      .when('INSERT INTO contract_templates', { insertId: 8 })
      .when('FROM contract_templates WHERE id', [templateRow()]);

    await templateService.createTemplate(db, validInput(), WL);

    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO contract_templates'));
    const cols = flat(insert.sql).match(/\(([^)]*)\)\s*VALUES/i)[1].split(',').length;
    const marks = flat(insert.sql).match(/VALUES\s*\(([^)]*)\)/i)[1].split(',').length;
    // VALUES carries one literal `1` for active, so marks == params + 1.
    expect(cols).toBe(marks);
    expect(insert.params).toHaveLength(marks - 1);
  });
});

describe('updateTemplate persists both columns', () => {
  test('the UPDATE sets them', async () => {
    const db = makeDb().when('FROM contract_templates WHERE id', [templateRow()]);

    await templateService.updateTemplate(db, 8, { purpose: 'both' }, WL);

    const update = db.calls.find((c) => c.sql.includes('UPDATE contract_templates'));
    expect(flat(update.sql)).toContain('purpose = ?, file_subfolder = ?');
    expect(update.params).toContain('both');
  });

  test('an absent field KEEPS the stored value (the partial-update rule)', async () => {
    const db = makeDb().when('FROM contract_templates WHERE id',
      [templateRow({ purpose: 'generate', file_subfolder: 'Notices' })]);

    // Change only the name.
    await templateService.updateTemplate(db, 8, { name: 'Renamed Notice' }, WL);

    const update = db.calls.find((c) => c.sql.includes('UPDATE contract_templates'));
    expect(update.params).toContain('generate');
    expect(update.params).toContain('Notices');
    // …and specifically did NOT silently reset either to its default.
    expect(update.params).not.toContain('esign');
    expect(update.params).not.toContain('Generated Documents');
  });

  test('a merged update is validated, so an update cannot reach a state create would refuse', async () => {
    const db = makeDb().when('FROM contract_templates WHERE id', [templateRow()]);
    await expect(templateService.updateTemplate(db, 8, { fileSubfolder: 'a/b' }, WL))
      .rejects.toThrow(/single folder name/);
    expect(db.calls.some((c) => c.sql.includes('UPDATE contract_templates'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. listTemplates — the picker filter
// ─────────────────────────────────────────────────────────────────────────────

describe('listTemplates purpose filter', () => {
  const run = async (opts) => {
    const db = makeDb().when('FROM contract_templates', []);
    await templateService.listTemplates(db, opts);
    return flat(db.lastSql('FROM contract_templates'));
  };

  test('selects the two new columns', async () => {
    expect(await run({})).toContain('t.purpose, t.file_subfolder');
  });

  test('still ships no bodies', async () => {
    expect(await run({})).not.toContain('body');
  });

  test('default (activeOnly, no purpose) → the active clause alone', async () => {
    const sql = await run({});
    expect(sql).toContain('WHERE t.active = 1');
    expect(sql).not.toContain('t.purpose IN');
  });

  test("purpose 'esign' → esign ∪ both, ANDed onto activeOnly", async () => {
    const sql = await run({ purpose: 'esign' });
    expect(sql).toContain("WHERE t.active = 1 AND t.purpose IN ('esign','both')");
    expect(sql.match(/WHERE/g)).toHaveLength(1);   // one WHERE, not two
  });

  test("purpose 'generate' → generate ∪ both, ANDed onto activeOnly", async () => {
    const sql = await run({ purpose: 'generate' });
    expect(sql).toContain("WHERE t.active = 1 AND t.purpose IN ('generate','both')");
    expect(sql.match(/WHERE/g)).toHaveLength(1);
  });

  test('purpose WITHOUT activeOnly → the purpose clause carries its own WHERE', async () => {
    const sql = await run({ activeOnly: false, purpose: 'generate' });
    expect(sql).toContain("WHERE t.purpose IN ('generate','both')");
    expect(sql).not.toContain('t.active = 1');
    expect(sql.match(/WHERE/g)).toHaveLength(1);
  });

  test('neither → no WHERE at all (the manager view)', async () => {
    const sql = await run({ activeOnly: false, purpose: null });
    expect(sql).not.toContain('WHERE');
    expect(sql).toContain('ORDER BY t.name ASC');
  });

  test('an unrecognised purpose filters nothing rather than filtering everything', async () => {
    // Fail-open is right HERE: this is a picker convenience, and a typo'd query
    // string that silently returned zero templates would read as "we have none".
    const sql = await run({ activeOnly: false, purpose: 'nonsense' });
    expect(sql).not.toContain('t.purpose IN');
  });

  test("'both' is not a legal FILTER value — it is a template value", async () => {
    // Asking for purpose='both' means "templates offered in both pickers",
    // which no picker wants. It filters nothing rather than guessing.
    const sql = await run({ activeOnly: false, purpose: 'both' });
    expect(sql).not.toContain('t.purpose IN');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. sendFromTemplate refuses a generate-only template
// ─────────────────────────────────────────────────────────────────────────────

describe('sendFromTemplate purpose guard', () => {
  const RECIPIENTS = [{ name: 'John Smith', email: 'john@example.com', order: 1 }];

  test("purpose 'generate' is refused with ESIGN_TEMPLATE_PURPOSE", async () => {
    const db = makeDb()
      .when('FROM contract_templates WHERE id', [templateRow({ purpose: 'generate' })]);

    await expect(sendService.sendFromTemplate(db, {
      templateId: 8, linkableType: 'case', linkableId: 'AbC12dEf',
      recipients: RECIPIENTS, createdBy: 1,
    })).rejects.toMatchObject({
      code: 'ESIGN_TEMPLATE_PURPOSE',
      message: expect.stringMatching(/generate-only template and cannot be sent/),
    });
  });

  test('the refusal happens BEFORE any value resolution or render', async () => {
    const pdfRenderService = require('../services/pdfRenderService');
    pdfRenderService.renderHtmlToPdf.mockClear();
    const db = makeDb()
      .when('FROM contract_templates WHERE id', [templateRow({ purpose: 'generate' })]);

    await expect(sendService.sendFromTemplate(db, {
      templateId: 8, linkableType: 'case', linkableId: 'AbC12dEf',
      recipients: RECIPIENTS, createdBy: 1,
    })).rejects.toThrow();

    expect(pdfRenderService.renderHtmlToPdf).not.toHaveBeenCalled();
  });

  test("an INACTIVE generate template reports inactive first — state before picker", async () => {
    const db = makeDb().when('FROM contract_templates WHERE id',
      [templateRow({ purpose: 'generate', active: false })]);

    await expect(sendService.sendFromTemplate(db, {
      templateId: 8, linkableType: 'case', linkableId: 'AbC12dEf',
      recipients: RECIPIENTS, createdBy: 1,
    })).rejects.toMatchObject({ code: 'ESIGN_TEMPLATE_INACTIVE' });
  });

  test("purpose 'both' passes the guard (it fails later, on its own merits)", async () => {
    const db = makeDb()
      .when('FROM contract_templates WHERE id', [templateRow({ purpose: 'both' })]);

    // No case row is wired, so this gets past the purpose guard and dies
    // downstream — which is exactly the point: not on ESIGN_TEMPLATE_PURPOSE.
    await expect(sendService.sendFromTemplate(db, {
      templateId: 8, linkableType: 'case', linkableId: 'AbC12dEf',
      recipients: RECIPIENTS, createdBy: 1,
    })).rejects.not.toMatchObject({ code: 'ESIGN_TEMPLATE_PURPOSE' });
  });
});
