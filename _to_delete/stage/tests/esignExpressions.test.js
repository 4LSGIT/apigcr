// tests/esignExpressions.test.js
//
// Phase 2E, slice B2 — expression resolvers.
//
//   1. resolverService.scanExpressionRefs   — pure static scan
//   2. esignPrefillService expression layer — detection, pure validation,
//      refs construction, runtime delegation semantics
//   3. esignTemplateService                — save-time acceptance/rejection,
//      batched information_schema existence check
//
// The 15 bespoke resolvers are ADDITIVELY extended, never changed — several
// assertions here exist purely to prove that.

const resolverService = require('../services/resolverService');
const prefill         = require('../services/esignPrefillService');
const templateService = require('../services/esignTemplateService');

const { RESOLVER_NAMES } = prefill;

// ─────────────────────────────────────────────────────────────────────────────
// 1. scanExpressionRefs
// ─────────────────────────────────────────────────────────────────────────────

describe('resolverService.scanExpressionRefs', () => {
  test('simple table.column with modifier', () => {
    const out = resolverService.scanExpressionRefs('{{cases.case_open_date|date:MM/DD/YYYY}}');
    expect(out.refs).toEqual([{ table: 'cases', column: 'case_open_date' }]);
    expect(out.triggerData).toBe(false);
    expect(out.placeholderCount).toBe(1);
  });

  test('multiple placeholders with surrounding literal text', () => {
    const out = resolverService.scanExpressionRefs(
      '{{cases.case_number}} / Ch {{cases.case_chapter}}'
    );
    expect(out.refs).toEqual([
      { table: 'cases', column: 'case_number' },
      { table: 'cases', column: 'case_chapter' },
    ]);
    expect(out.placeholderCount).toBe(2);
  });

  test('nested default carries its real-table ref out', () => {
    const out = resolverService.scanExpressionRefs(
      '{{contacts.contact_address|default:{{cases.case_number}}}}'
    );
    expect(out.refs).toEqual([
      { table: 'contacts', column: 'contact_address' },
      { table: 'cases', column: 'case_number' },
    ]);
  });

  test('trigger_data is flagged, not listed as a ref', () => {
    const out = resolverService.scanExpressionRefs('{{trigger_data.amount}}');
    expect(out.triggerData).toBe(true);
    expect(out.refs).toEqual([]);
  });

  test('no placeholders → empty scan (pure, no throw)', () => {
    expect(resolverService.scanExpressionRefs('just text')).toEqual({
      refs: [], triggerData: false, placeholderCount: 0,
    });
    expect(resolverService.scanExpressionRefs(null).placeholderCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Detection + pure validation
// ─────────────────────────────────────────────────────────────────────────────

describe('isExpressionResolver', () => {
  test('braced strings are expressions; bespoke names are not', () => {
    expect(prefill.isExpressionResolver('{{cases.case_number}}')).toBe(true);
    expect(prefill.isExpressionResolver('{{a}} and {{b}}')).toBe(true);
    for (const name of RESOLVER_NAMES) {
      expect(prefill.isExpressionResolver(name)).toBe(false);
    }
    expect(prefill.isExpressionResolver('debtor1.name')).toBe(false);
    expect(prefill.isExpressionResolver('{{}}')).toBe(false); // too short to hold anything
    expect(prefill.isExpressionResolver(null)).toBe(false);
  });
});

describe('validateExpressionResolver', () => {
  test('valid expression returns its refs', () => {
    expect(prefill.validateExpressionResolver('{{cases.case_filed_date|date:MM/DD/YYYY}}'))
      .toEqual([{ table: 'cases', column: 'case_filed_date' }]);
  });

  test('disallowed table → ESIGN_BAD_RESOLVER', () => {
    expect(() => prefill.validateExpressionResolver('{{app_settings.value}}'))
      .toThrow(expect.objectContaining({ code: 'ESIGN_BAD_RESOLVER' }));
  });

  test('blocked column (contact_ssn) → ESIGN_BAD_RESOLVER', () => {
    expect(() => prefill.validateExpressionResolver('{{contacts.contact_ssn}}'))
      .toThrow(expect.objectContaining({ code: 'ESIGN_BAD_RESOLVER' }));
  });

  test('blocked column inside a nested default is still caught', () => {
    expect(() => prefill.validateExpressionResolver(
      '{{contacts.contact_fname|default:{{contacts.contact_ssn}}}}'
    )).toThrow(expect.objectContaining({ code: 'ESIGN_BAD_RESOLVER' }));
  });

  test('trigger_data → ESIGN_BAD_RESOLVER (no trigger at send time)', () => {
    expect(() => prefill.validateExpressionResolver('{{trigger_data.amount}}'))
      .toThrow(/trigger_data/);
  });

  test('no placeholder / no table.column shape → ESIGN_BAD_RESOLVER', () => {
    expect(() => prefill.validateExpressionResolver('{{unclosed')).toThrow();
    expect(() => prefill.validateExpressionResolver('{{noTableDot}}')).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Refs construction + runtime semantics
// ─────────────────────────────────────────────────────────────────────────────

describe('buildExpressionRefs', () => {
  test('case linkable: cases anchor as STRING + contacts anchor from debtor1', () => {
    const refs = prefill.buildExpressionRefs(
      { linkableType: 'case', linkableId: 'AbC12dEf' },
      { debtor1: { contact_id: 1001 }, debtor2: null, caseRow: {} }
    );
    expect(refs).toEqual({
      cases:    { case_id: 'AbC12dEf' },
      contacts: { contact_id: 1001 },
    });
  });

  test('case with no Primary: cases only', () => {
    const refs = prefill.buildExpressionRefs(
      { linkableType: 'case', linkableId: 'AbC12dEf' },
      { debtor1: null, debtor2: null, caseRow: {} }
    );
    expect(refs).toEqual({ cases: { case_id: 'AbC12dEf' } });
  });

  test('contact linkable: contacts only, no cases', () => {
    const refs = prefill.buildExpressionRefs(
      { linkableType: 'contact', linkableId: '1001' },
      { debtor1: { contact_id: 1001 }, debtor2: null, caseRow: null }
    );
    expect(refs).toEqual({ contacts: { contact_id: 1001 } });
  });
});

describe('resolveExpression semantics', () => {
  // db mocked at the resolverService boundary: what matters HERE is the
  // esign-layer policy over resolve()'s outcomes, not resolve()'s SQL.
  const realResolve = resolverService.resolve;
  afterEach(() => { resolverService.resolve = realResolve; });

  test('clean success passes the text through', async () => {
    resolverService.resolve = async () => ({ status: 'success', text: '24-12345', unresolved: [] });
    await expect(prefill.resolveExpression({}, '{{cases.case_number}}', {}))
      .resolves.toBe('24-12345');
  });

  test('ANY unresolved placeholder → "" (a literal {{…}} never reaches a legal doc)', async () => {
    resolverService.resolve = async () => ({
      status: 'partial', text: '24-12345 ({{cases.nope}})', unresolved: ['{{cases.nope}}'],
    });
    await expect(prefill.resolveExpression({}, 'x', {})).resolves.toBe('');
  });

  test('failed resolve → ""', async () => {
    resolverService.resolve = async () => ({ status: 'failed', text: 'x', unresolved: [], errors: ['boom'] });
    await expect(prefill.resolveExpression({}, 'x', {})).resolves.toBe('');
  });

  test('resolvePrefills: expression "" falls to default, then missing — same chain as bespoke', async () => {
    resolverService.resolve = async () => ({ status: 'success', text: '', unresolved: [] });

    const template = {
      prefill_schema: [
        { key: 'a', label: 'A', type: 'text', resolver: '{{cases.case_number}}', default: 'fallback', required: false },
        { key: 'b', label: 'B', type: 'text', resolver: '{{cases.case_number}}', default: null,       required: true  },
      ],
    };
    // db only serves buildContext here; empty results everywhere.
    const db = { query: async () => [[]] };
    const { values, missing } = await prefill.resolvePrefills(
      db, template, { linkableType: 'case', linkableId: 'AbC12dEf' }
    );
    expect(values.a).toBe('fallback');
    expect(values.b).toBe('');
    expect(missing).toEqual(['b']);
  });

  test('resolvePrefills: expression value is formatted by declared type', async () => {
    resolverService.resolve = async () => ({ status: 'success', text: '1500', unresolved: [] });
    const template = {
      prefill_schema: [
        { key: 'fee', label: 'Fee', type: 'money', resolver: '{{cases.case_fee}}', default: null, required: false },
      ],
    };
    const db = { query: async () => [[]] };
    const { values } = await prefill.resolvePrefills(
      db, template, { linkableType: 'case', linkableId: 'AbC12dEf' }
    );
    expect(values.fee).toBe('$1,500.00');
  });

  test('bespoke resolvers untouched: unknown NAME still throws at resolve time', async () => {
    const template = {
      prefill_schema: [
        { key: 'x', label: 'X', type: 'text', resolver: 'not.a.resolver', default: null, required: false },
      ],
    };
    const db = { query: async () => [[]] };
    await expect(prefill.resolvePrefills(db, template, { linkableType: 'case', linkableId: 'A' }))
      .rejects.toMatchObject({ code: 'ESIGN_BAD_RESOLVER' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Save-time — validateTemplateInput + assertExpressionColumnsExist
// ─────────────────────────────────────────────────────────────────────────────

function schemaEntry(over = {}) {
  return { key: 'fee_total', label: 'Fee total', type: 'money', resolver: null, default: null, required: false, ...over };
}
function templateInput(over = {}) {
  return {
    name: 'Retainer',
    kind: 'retainer_prepetition',
    body: 'Fee: {{fee_total}}',
    prefillSchema: [schemaEntry()],
    placementJson: { fields: [] },
    expirationDays: 14,
    remindersOff: false,
    reminderSeqId: null,
    ...over,
  };
}

describe('save-time expression validation', () => {
  test('a valid expression resolver saves (validateTemplateInput passes)', () => {
    const { clean } = templateService.validateTemplateInput(
      templateInput({ prefillSchema: [schemaEntry({ resolver: '{{cases.case_number}}' })] }),
      RESOLVER_NAMES
    );
    expect(clean.prefillSchema[0].resolver).toBe('{{cases.case_number}}');
  });

  test('bespoke names still validate exactly as before', () => {
    const { clean } = templateService.validateTemplateInput(
      templateInput({ prefillSchema: [schemaEntry({ resolver: 'debtor1.name' })] }),
      RESOLVER_NAMES
    );
    expect(clean.prefillSchema[0].resolver).toBe('debtor1.name');
  });

  test('unknown non-expression resolver still rejected', () => {
    expect(() => templateService.validateTemplateInput(
      templateInput({ prefillSchema: [schemaEntry({ resolver: 'made.up' })] }),
      RESOLVER_NAMES
    )).toThrow(expect.objectContaining({ code: 'ESIGN_BAD_RESOLVER' }));
  });

  test('expression with blocked column rejected at save', () => {
    expect(() => templateService.validateTemplateInput(
      templateInput({ prefillSchema: [schemaEntry({ resolver: '{{contacts.contact_ssn}}' })] }),
      RESOLVER_NAMES
    )).toThrow(expect.objectContaining({ code: 'ESIGN_BAD_RESOLVER' }));
  });
});

describe('assertExpressionColumnsExist', () => {
  test('no expressions → no query at all', async () => {
    const db = { query: jest.fn() };
    await templateService.assertExpressionColumnsExist(db, [schemaEntry({ resolver: 'debtor1.name' })]);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('all columns exist → passes; one batched query with deduped pairs', async () => {
    const db = {
      query: jest.fn(async () => [[
        { t: 'cases', c: 'case_number' },
        { t: 'contacts', c: 'contact_fname' },
      ]]),
    };
    await templateService.assertExpressionColumnsExist(db, [
      schemaEntry({ key: 'a', resolver: '{{cases.case_number}}' }),
      schemaEntry({ key: 'b', resolver: '{{cases.case_number}} {{contacts.contact_fname}}' }),
    ]);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/information_schema\.columns/);
    expect(params).toEqual(['cases', 'case_number', 'contacts', 'contact_fname']); // deduped
  });

  test('missing column → ESIGN_BAD_RESOLVER naming it', async () => {
    const db = { query: jest.fn(async () => [[]]) };
    await expect(templateService.assertExpressionColumnsExist(db, [
      schemaEntry({ resolver: '{{cases.case_numbr}}' }),
    ])).rejects.toMatchObject({
      code: 'ESIGN_BAD_RESOLVER',
      message: expect.stringContaining('cases.case_numbr'),
    });
  });
});
