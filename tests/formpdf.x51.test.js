/**
 * Tests for X5.1 — PDF wiring.
 *
 * What is under test here (X5's own coverage stays in formpdf.x5.test.js):
 *   1. the form-PDF unsorted bin is its OWN setting, honored when present and
 *      defaulted when absent, with the firm's leading spaces intact;
 *   2. renderSubmissionPdf — the staff Download/Print path — renders the same
 *      bytes as the filing path while touching NO Dropbox and raising NO task
 *      (pressing Download five times must not file five copies);
 *   3. onSubmit.pdf validation;
 *   4. the external dispatcher injects `make_pdf` from the PUBLISHED
 *      definition, always defined, never from the request body.
 *
 *   npx jest tests/formpdf.x51.test.js
 */

const realJoinPath = (base, ...segments) => {
  const norm = (p) => {
    if (p == null) return '';
    let s = String(p);
    if (!s.startsWith('/')) s = '/' + s;
    s = s.replace(/\/{2,}/g, '/');
    if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
    return s === '/' ? '' : s;
  };
  let out = norm(base);
  for (const seg of segments) {
    if (seg == null || seg === '') continue;
    out = norm(`${out}/${seg}`);
  }
  return out;
};

jest.mock('../services/dropboxService', () => ({
  _resolveCredential: jest.fn(async () => 8),
  resolveLocation: jest.fn(async () => '/Clients/Smith, John'),
  createFolder: jest.fn(async (db, { path }) => ({ path, existed: false })),
  uploadFile: jest.fn(async (db, { path }) => ({ path_display: path })),
  getTemporaryLink: jest.fn(async () => ({ link: 'https://dl/x', metadata: null })),
  joinPath: (...a) => realJoinPath(...a),
}));

jest.mock('../services/pdfRenderService', () => ({
  renderHtmlToPdf: jest.fn(async () => Buffer.from('%PDF-1.7 fake')),
}));

jest.mock('../services/settingsService', () => ({
  getSetting: jest.fn(async () => null),
  getSettings: jest.fn(async () => ({})),
}));

jest.mock('../services/caseService', () => ({ ensureCaseDropboxFolder: jest.fn() }));
jest.mock('../services/taskService', () => ({ createTask: jest.fn(async () => ({ task_id: 77 })) }));
jest.mock('../services/esignAlertService', () => ({ resolveAlertAssignee: jest.fn(async () => 22) }));
jest.mock('../services/formService', () => ({ getSubmissionForRender: jest.fn() }));

const dropboxService = require('../services/dropboxService');
const pdfRenderService = require('../services/pdfRenderService');
const { getSetting } = require('../services/settingsService');
const taskService = require('../services/taskService');
const formService = require('../services/formService');
const formPdfService = require('../services/formPdfService');

const db = { query: jest.fn() };

function makeBundle(over = {}) {
  const { submission = {}, ...rest } = over;
  return {
    submission: {
      id: 286, form_key: 'intake', link_type: 'case', link_id: 'hjSFMabb',
      status: 'submitted', version: 1, schema_version: 3,
      data: { client_name: 'John Smith' },
      created_at: new Date('2026-08-10T14:00:00Z'),
      ...submission,
    },
    title: 'Intake Form',
    link_type: 'case',
    definition: {
      sections: [{ rows: [{ fields: [{ name: 'client_name', type: 'text', label: 'Name' }] }] }],
    },
    definition_schema_version: 3,
    schema_matched: true,
    ...rest,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  formPdfService._resetLogoCacheForTest();
  dropboxService._resolveCredential.mockImplementation(async () => 8);
  dropboxService.resolveLocation.mockImplementation(async () => '/Clients/Smith, John');
  dropboxService.createFolder.mockImplementation(async (d, { path }) => ({ path, existed: false }));
  dropboxService.uploadFile.mockImplementation(async (d, { path }) => ({ path_display: path }));
  dropboxService.getTemporaryLink.mockImplementation(async () => ({ link: 'https://dl/x', metadata: null }));
  getSetting.mockImplementation(async () => null);
  taskService.createTask.mockImplementation(async () => ({ task_id: 77 }));
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => {
    if (/case_dropbox/.test(sql)) return [[{ case_dropbox: 'https://www.dropbox.com/sh/case-link' }]];
    if (/contact_lfm_name/.test(sql)) return [[{ contact_lfm_name: 'Smith, John' }]];
    return [[]];
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The bin is its own setting
// ─────────────────────────────────────────────────────────────────────────────

describe('form-PDF unsorted bin', () => {
  test('is a distinct setting key from the client-uploads bin', () => {
    expect(formPdfService.UNSORTED_PATH_KEY).toBe('dropbox_unsorted_forms_path');
    expect(formPdfService.DEFAULT_UNSORTED_PATH)
      .toBe('/  Law Office/   Cases/  Unsorted Form Submissions');
    // The firm's leading-space sort convention is load-bearing in Dropbox.
    expect(formPdfService.DEFAULT_UNSORTED_PATH.startsWith('/  Law Office')).toBe(true);
  });

  test('an app_settings override wins, with leading/embedded spaces preserved', async () => {
    formService.getSubmissionForRender.mockResolvedValue(makeBundle({
      submission: { link_type: 'contact', link_id: '1001' },
    }));
    getSetting.mockImplementation(async (d, key) =>
      key === 'dropbox_unsorted_forms_path' ? '/  Archive/  Form PDFs\r\n' : null);

    await formPdfService.fileSubmissionPdf(db, { submissionId: 286 });

    const uploaded = dropboxService.uploadFile.mock.calls[0][1].path;
    expect(uploaded.startsWith('/  Archive/  Form PDFs/')).toBe(true);   // spaces intact
    expect(uploaded).not.toContain('\r');                                // CRLF trimmed
  });

  test('case-linked rung 3 keeps the per-case subfolder INSIDE the form bin', async () => {
    formService.getSubmissionForRender.mockResolvedValue(makeBundle());
    dropboxService.resolveLocation.mockRejectedValue(new Error('link revoked'));

    const v = await formPdfService.fileSubmissionPdf(db, { submissionId: 286 });

    expect(dropboxService.uploadFile.mock.calls[0][1].path).toBe(
      '/  Law Office/   Cases/  Unsorted Form Submissions/hjSFMabb - Smith, John' +
      '/2026-08-10 Intake Form (#286).pdf'
    );
    expect(v.placement_note).toContain('form-submissions');
    expect(v.placement_note).not.toContain('client-uploads');
  });

  test('a name-lookup failure degrades the subfolder to the bare case id', async () => {
    formService.getSubmissionForRender.mockResolvedValue(makeBundle());
    dropboxService.resolveLocation.mockRejectedValue(new Error('link revoked'));
    db.query.mockImplementation(async (sql) => {
      if (/case_dropbox/.test(sql)) return [[{ case_dropbox: 'https://www.dropbox.com/sh/x' }]];
      throw new Error('contacts unavailable');
    });

    await formPdfService.fileSubmissionPdf(db, { submissionId: 286 });

    expect(dropboxService.uploadFile.mock.calls[0][1].path).toContain(
      '/  Unsorted Form Submissions/hjSFMabb/'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. renderSubmissionPdf — the staff Download/Print path
// ─────────────────────────────────────────────────────────────────────────────

describe('renderSubmissionPdf', () => {
  test('returns bytes + filename and touches NOTHING in Dropbox', async () => {
    formService.getSubmissionForRender.mockResolvedValue(makeBundle());

    const out = await formPdfService.renderSubmissionPdf(db, { submissionId: 286 });

    expect(Buffer.isBuffer(out.buffer)).toBe(true);
    expect(out.fileName).toBe('2026-08-10 Intake Form (#286).pdf');
    expect(out.submission.id).toBe(286);
    expect(dropboxService.uploadFile).not.toHaveBeenCalled();
    expect(dropboxService.createFolder).not.toHaveBeenCalled();
    expect(dropboxService.getTemporaryLink).not.toHaveBeenCalled();
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  test('repeat downloads never file anything (the point of splitting the two)', async () => {
    formService.getSubmissionForRender.mockResolvedValue(makeBundle());
    await formPdfService.renderSubmissionPdf(db, { submissionId: 286 });
    await formPdfService.renderSubmissionPdf(db, { submissionId: 286 });
    await formPdfService.renderSubmissionPdf(db, { submissionId: 286 });
    expect(pdfRenderService.renderHtmlToPdf).toHaveBeenCalledTimes(3);
    expect(dropboxService.uploadFile).not.toHaveBeenCalled();
  });

  test('download and filing render the SAME html — one render path', async () => {
    formService.getSubmissionForRender.mockResolvedValue(makeBundle());

    await formPdfService.renderSubmissionPdf(db, { submissionId: 286 });
    const downloadHtml = pdfRenderService.renderHtmlToPdf.mock.calls[0][0];

    formPdfService._resetLogoCacheForTest();
    await formPdfService.fileSubmissionPdf(db, { submissionId: 286 });
    const filedHtml = pdfRenderService.renderHtmlToPdf.mock.calls[1][0];

    // The footer stamps "Generated <now>"; everything above it must match.
    const strip = (h) => h.replace(/<div class="ftr">[\s\S]*$/, '');
    expect(strip(downloadHtml)).toBe(strip(filedHtml));
  });

  test('the downloaded name carries no unsorted identity prefix', async () => {
    formService.getSubmissionForRender.mockResolvedValue(makeBundle({
      submission: { link_type: '', link_id: '', data: { client_name: 'Bob Roberts' } },
    }));
    const out = await formPdfService.renderSubmissionPdf(db, { submissionId: 286 });
    expect(out.fileName).toBe('2026-08-10 Intake Form (#286).pdf');
    expect(out.fileName).not.toContain('submission 286 -');
  });

  test('drafts are refused before any render', async () => {
    formService.getSubmissionForRender.mockResolvedValue(makeBundle({
      submission: { status: 'draft' },
    }));
    await expect(formPdfService.renderSubmissionPdf(db, { submissionId: 286 }))
      .rejects.toThrow(/draft/);
    expect(pdfRenderService.renderHtmlToPdf).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. onSubmit.pdf validation
// ─────────────────────────────────────────────────────────────────────────────

describe('onSubmit.pdf validation', () => {
  const formTemplateService = require('../services/formTemplateService');

  const withOnSubmit = (onSubmit) => ({
    schemaVersion: 1,
    sections: [{ rows: [{ fields: [{ name: 'a', type: 'text', label: 'A' }] }] }],
    onSubmit,
  });

  test('true and false both validate', () => {
    expect(() => formTemplateService.validateDefinition(withOnSubmit({ pdf: true }))).not.toThrow();
    expect(() => formTemplateService.validateDefinition(withOnSubmit({ pdf: false }))).not.toThrow();
  });

  test('a non-boolean is rejected — "true" the string is the likely mistake', () => {
    expect(() => formTemplateService.validateDefinition(withOnSubmit({ pdf: 'true' })))
      .toThrow(/onSubmit\.pdf must be true or false/);
    expect(() => formTemplateService.validateDefinition(withOnSubmit({ pdf: { enabled: true } })))
      .toThrow(/onSubmit\.pdf must be true or false/);
  });

  test('absent stays valid (every pre-X5.1 definition)', () => {
    expect(() => formTemplateService.validateDefinition(withOnSubmit({}))).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. make_pdf reaches the workflow from the DEFINITION, not the request
// ─────────────────────────────────────────────────────────────────────────────

describe('make_pdf injection (external dispatcher)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../routes/api.ext.forms.js'), 'utf8');

  test('the system block derives make_pdf from the published definition', () => {
    expect(src).toContain('make_pdf: !!(def.onSubmit && def.onSubmit.pdf)');
  });

  test('it sits in the system block that overrides submitted values', () => {
    // The assembly is Object.assign(body.values, entry.initData, {system}).
    // make_pdf must be in the LAST object, or a submitter could send a
    // make_pdf field and drive server-side rendering from the request body.
    const systemBlock = src.slice(src.indexOf('submission_id: submitResult.id'));
    expect(systemBlock.indexOf('make_pdf')).toBeGreaterThan(-1);
    expect(systemBlock.indexOf('make_pdf')).toBeLessThan(systemBlock.indexOf('_values: body.values'));
  });

  test('the internal dispatcher mirrors it', () => {
    const yc = fs.readFileSync(require.resolve('../public/js/yc-forms.js'), 'utf8');
    expect(yc).toContain('make_pdf:      !!this.config.onSubmit.pdf');
  });
});
