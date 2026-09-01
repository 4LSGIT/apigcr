// tests/documentGenerateFn.test.js
//
/**
 * G2 — lib/internal_functions/documents.js :: document_generate_from_template.
 *
 * The workflow wrapper over documentGenerateService. Thin by design, so what is
 * under test is the WIRING and the one piece of policy that lives only here:
 *
 *   1. registration + meta (workflowOnly, documents category);
 *   2. the happy path's output mapping and output_var;
 *   3. on_missing:'task' — the human path. A staff task LINKED TO THE CASE, and
 *      a SUCCESS with generated:false so the automation carries on;
 *   4. on_missing:'fail' (the default) — rethrow, so the step's error_policy
 *      decides;
 *   5. every OTHER error rethrows regardless of on_missing. A task is the right
 *      answer to "a human needs to type a number", not to "the template is
 *      inactive" or "chromium fell over".
 *
 *   npx jest tests/documentGenerateFn.test.js
 */

'use strict';

jest.mock('../services/documentGenerateService', () => ({
  generateFromTemplate: jest.fn(),
}));
jest.mock('../services/esignAlertService', () => ({
  raiseTask: jest.fn(async () => ({ ok: true, taskId: 1234 })),
  resolveAlertAssignee: jest.fn(async () => 22),
}));
jest.mock('../services/esignTemplateService', () => ({
  getTemplate: jest.fn(async () => ({ id: 8, name: 'Discharge Notice' })),
}));

const generateService      = require('../services/documentGenerateService');
const esignAlertService    = require('../services/esignAlertService');
const esignTemplateService = require('../services/esignTemplateService');
const internalFunctions    = require('../lib/internal_functions');

const fn = internalFunctions.document_generate_from_template;
const db = { query: jest.fn(async () => [[]]) };

const VERDICT = {
  path: '/Clients/Smith, John/Notices/2026-09-01 Discharge Notice – Smith.pdf',
  file_name: '2026-09-01 Discharge Notice – Smith.pdf',
  placement: 'case',
  placement_note: null,
  temp_link: 'https://dl/x',
  temp_link_expires_note: 'Dropbox temporary link — expires ~4 hours after creation',
  warnings: [],
  credential_id: 8,
  document_id: 909,
  template_id: 8,
  template_name: 'Discharge Notice',
  document_name: 'Discharge Notice – Smith',
  link_type: 'case',
  link_id: 'AbC12dEf',
  missing_optional: [],
};

const PARAMS = { template_id: 8, linkable_type: 'case', linkable_id: 'AbC12dEf' };

function missingPrefillError(missing = ['fee']) {
  const err = new Error(
    `Required value(s) are still empty: ${missing.join(', ')}. Fill them in and send again.`);
  err.code = 'ESIGN_MISSING_PREFILL';
  err.missing = missing;
  return err;
}

beforeEach(() => {
  jest.clearAllMocks();
  generateService.generateFromTemplate.mockResolvedValue(VERDICT);
  esignAlertService.raiseTask.mockResolvedValue({ ok: true, taskId: 1234 });
  esignTemplateService.getTemplate.mockResolvedValue({ id: 8, name: 'Discharge Notice' });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. REGISTRATION + META
// ─────────────────────────────────────────────────────────────────────────────

describe('registration', () => {
  test('auto-registered, workflow-only, documents category', () => {
    expect(typeof fn).toBe('function');
    const meta = fn.__meta;
    // Chromium renders serialize on a 1GiB container. Sequences fan out; a
    // sequence step doing this across a contact list would queue-stack them.
    expect(meta.workflowOnly).toBe(true);
    expect(meta.category).toBe('documents');
  });

  test('the three id-ish params are required and placeholder-friendly', () => {
    const byName = new Map(fn.__meta.params.map((p) => [p.name, p]));
    for (const n of ['template_id', 'linkable_type', 'linkable_id']) {
      expect(byName.get(n).required).toBe(true);
    }
    expect(byName.get('template_id').placeholderAllowed).toBe(true);
    expect(byName.get('linkable_id').placeholderAllowed).toBe(true);
    expect(byName.get('linkable_type').enum).toEqual(['case', 'contact']);
    expect(byName.get('on_missing').enum).toEqual(['fail', 'task']);
  });

  test('the example is a valid param set', () => {
    expect(internalFunctions.__validateParamsAgainstMeta(fn.__meta, fn.__meta.example))
      .toBeNull();
  });

  test('the description tells an author how to attach the result to an email', () => {
    const outputVar = fn.__meta.params.find((p) => p.name === 'output_var');
    expect(outputVar.description).toContain('attachment_urls');
    expect(outputVar.description).toContain('temp_link');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. HAPPY PATH
// ─────────────────────────────────────────────────────────────────────────────

describe('happy path', () => {
  test('calls the service with createdBy 0 (the automations user)', async () => {
    await fn({ ...PARAMS, values: { fee: '1500' }, document_name: 'Notice' }, db);

    expect(generateService.generateFromTemplate).toHaveBeenCalledWith(db, {
      templateId: 8,
      linkableType: 'case',
      linkableId: 'AbC12dEf',
      values: { fee: '1500' },
      documentName: 'Notice',
      createdBy: 0,
    });
  });

  test('maps the verdict to output', async () => {
    const res = await fn(PARAMS, db);

    expect(res.success).toBe(true);
    expect(res.output).toEqual({
      generated: true,
      path: VERDICT.path,
      file_name: VERDICT.file_name,
      temp_link: 'https://dl/x',
      temp_link_expires_note: VERDICT.temp_link_expires_note,
      document_id: 909,
      placement: 'case',
      placement_note: null,
      warnings: [],
      template_id: 8,
      document_name: 'Discharge Notice – Smith',
    });
  });

  test('output_var copies the output for later steps', async () => {
    const res = await fn({ ...PARAMS, output_var: 'notice' }, db);
    expect(res.set_vars.notice).toEqual(res.output);
    // The email-attachment idiom the description promises.
    expect(res.set_vars.notice.temp_link).toBe('https://dl/x');
    expect(res.set_vars.notice.file_name).toBe(VERDICT.file_name);
  });

  test('no output_var → set_vars is empty, not absent', async () => {
    const res = await fn(PARAMS, db);
    expect(res.set_vars).toEqual({});
  });

  test('a non-object `values` is dropped rather than passed through', async () => {
    await fn({ ...PARAMS, values: 'fee=1500' }, db);
    expect(generateService.generateFromTemplate.mock.calls[0][1].values).toBeNull();
  });

  test('an unsorted placement still reports generated:true — it IS filed', async () => {
    generateService.generateFromTemplate.mockResolvedValue({
      ...VERDICT,
      placement: 'unsorted',
      placement_note: 'could not be filed to the case folder',
      warnings: ['could not be filed to the case folder'],
      temp_link: null, temp_link_expires_note: null, document_id: null,
    });

    const res = await fn(PARAMS, db);
    expect(res.output.generated).toBe(true);
    expect(res.output.placement).toBe('unsorted');
    expect(res.output.warnings).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. INPUT GUARDS (runtime — hook/ingest paths reach here without save-time validation)
// ─────────────────────────────────────────────────────────────────────────────

describe('runtime input guards', () => {
  test.each([
    ['missing',     undefined],
    ['zero',        0],
    ['non-numeric', 'eight'],
    ['unresolved placeholder', '{{vars.tid}}'],
  ])('template_id %s throws before any work', async (_l, template_id) => {
    await expect(fn({ ...PARAMS, template_id }, db))
      .rejects.toThrow(/positive integer template_id/);
    expect(generateService.generateFromTemplate).not.toHaveBeenCalled();
  });

  test.each([
    ['null',       null],
    ['empty',      ''],
    ['whitespace', '  '],
  ])('linkable_id %s throws, naming the placeholder as the likely cause', async (_l, linkable_id) => {
    await expect(fn({ ...PARAMS, linkable_id }, db))
      .rejects.toThrow(/requires linkable_id.*placeholder resolved/s);
    expect(generateService.generateFromTemplate).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. on_missing
// ─────────────────────────────────────────────────────────────────────────────

describe("on_missing 'task'", () => {
  beforeEach(() => {
    generateService.generateFromTemplate.mockRejectedValue(missingPrefillError(['fee', 'trustee']));
  });

  test('raises a task and reports the skip as a SUCCESS', async () => {
    const res = await fn({ ...PARAMS, on_missing: 'task' }, db);

    expect(res.success).toBe(true);
    expect(res.output).toEqual({
      generated: false,
      skipped: 'missing_prefill',
      missing: ['fee', 'trustee'],
      task_id: 1234,
      template_id: 8,
    });
  });

  test('the task LINKS TO THE CASE — the improvement over the esign twin', async () => {
    await fn({ ...PARAMS, on_missing: 'task' }, db);

    expect(esignAlertService.raiseTask).toHaveBeenCalledTimes(1);
    expect(esignAlertService.raiseTask).toHaveBeenCalledWith(db, expect.objectContaining({
      linkableType: 'case',
      linkableId: 'AbC12dEf',
    }));
  });

  test('the task names the template and every missing key, and says what to do', async () => {
    await fn({ ...PARAMS, on_missing: 'task' }, db);

    const arg = esignAlertService.raiseTask.mock.calls[0][1];
    expect(arg.title).toBe('Document generate needs values: "Discharge Notice" (#8)');
    expect(arg.desc).toContain('• fee');
    expect(arg.desc).toContain('• trustee');
    expect(arg.desc).toContain('Nothing was generated.');
    expect(arg.desc).toContain('generate it by hand from the Documents tab');
  });

  test('a template-name lookup failure degrades to "#id" — the name is garnish', async () => {
    esignTemplateService.getTemplate.mockRejectedValue(new Error('db gone'));

    const res = await fn({ ...PARAMS, on_missing: 'task' }, db);

    expect(esignAlertService.raiseTask.mock.calls[0][1].title)
      .toBe('Document generate needs values: #8');
    expect(res.output.generated).toBe(false);
  });

  test('a task that could not be raised still reports the skip, with task_id null', async () => {
    esignAlertService.raiseTask.mockResolvedValue({ ok: false, reason: 'no_assignee' });

    const res = await fn({ ...PARAMS, on_missing: 'task' }, db);

    expect(res.success).toBe(true);
    expect(res.output.task_id).toBeNull();
    expect(res.output.skipped).toBe('missing_prefill');
  });

  test('an error with no .missing array still produces a task', async () => {
    const err = new Error('Required value(s) are still empty.');
    err.code = 'ESIGN_MISSING_PREFILL';
    generateService.generateFromTemplate.mockRejectedValue(err);

    const res = await fn({ ...PARAMS, on_missing: 'task' }, db);
    expect(res.output.missing).toEqual([]);
    expect(esignAlertService.raiseTask).toHaveBeenCalled();
  });
});

describe("on_missing 'fail' (the default)", () => {
  beforeEach(() => {
    generateService.generateFromTemplate.mockRejectedValue(missingPrefillError());
  });

  test('rethrows so the step error_policy decides', async () => {
    await expect(fn(PARAMS, db)).rejects.toMatchObject({ code: 'ESIGN_MISSING_PREFILL' });
    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();
  });

  test('an explicit fail behaves the same', async () => {
    await expect(fn({ ...PARAMS, on_missing: 'fail' }, db)).rejects.toThrow(/still empty/);
    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();
  });

  test('an unrecognised on_missing falls back to fail, not to task', async () => {
    // Fail-closed: a typo must not silently convert a hard stop into a task
    // the workflow then walks straight past.
    await expect(fn({ ...PARAMS, on_missing: 'taks' }, db)).rejects.toThrow(/still empty/);
    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();
  });
});

describe('every other error rethrows, whatever on_missing says', () => {
  test.each([
    ['ESIGN_TEMPLATE_PURPOSE',  'is a signature-only template'],
    ['ESIGN_TEMPLATE_INACTIVE', 'is inactive'],
    ['ESIGN_NOT_FOUND',         'not found'],
    ['ESIGN_BAD_LINKABLE',      'No case or contact was selected'],
    ['ESIGN_RENDER_FAILED',     'chromium exited'],
  ])('%s', async (code, message) => {
    const err = new Error(message);
    err.code = code;
    generateService.generateFromTemplate.mockRejectedValue(err);

    await expect(fn({ ...PARAMS, on_missing: 'task' }, db)).rejects.toMatchObject({ code });
    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();
  });

  test('a plain uncoded error rethrows too', async () => {
    generateService.generateFromTemplate.mockRejectedValue(new Error('dropbox is down'));
    await expect(fn({ ...PARAMS, on_missing: 'task' }, db)).rejects.toThrow('dropbox is down');
    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();
  });
});
