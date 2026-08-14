/**
 * Tests for X5 — form submission → PDF (services/formPdfService.js and the
 * render_submission_pdf internal function).
 *
 * NO network, NO real DB, NO chromium. dropboxService / pdfRenderService /
 * formService lookups are jest-mocked; what is under test is:
 *   1. the PRINT HTML — the PDF must show what the SUBMITTER saw (showWhen
 *      with the renderer's exact semantics, option labels, masks, Yes/No
 *      checkboxes, "—" blanks, hidden/embed omitted) with every template-
 *      and submitter-sourced string escaped;
 *   2. the PLACEMENT LADDER — case folder /Forms, auto-create + merge-task,
 *      unsorted degrade (per-case subfolder for case-linked; identity-
 *      prefixed loose file for contact/appt/unlinked, NO task), and that
 *      the path we RETURN is the path Dropbox returned (autorename);
 *   3. the internal function's wiring (output mapping, output_var, error
 *      prefix, workflowOnly meta).
 *
 *   npx jest tests/formpdf.x5.test.js
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
  getTemporaryLink: jest.fn(async () => ({ link: 'https://dl.dropboxusercontent.com/temp/abc', metadata: null })),
  joinPath: (...a) => realJoinPath(...a),
}));

jest.mock('../services/pdfRenderService', () => ({
  renderHtmlToPdf: jest.fn(async () => Buffer.from('%PDF-1.7 fake')),
}));

jest.mock('../services/settingsService', () => ({
  getSetting: jest.fn(async () => null),   // logo off, unsorted default path
  getSettings: jest.fn(async () => ({})),
}));

jest.mock('../services/caseService', () => ({
  ensureCaseDropboxFolder: jest.fn(),
}));

jest.mock('../services/taskService', () => ({
  createTask: jest.fn(async () => ({ task_id: 77 })),
}));

jest.mock('../services/esignAlertService', () => ({
  resolveAlertAssignee: jest.fn(async () => 22),
}));

jest.mock('../services/formService', () => ({
  getSubmissionForRender: jest.fn(),
}));

const dropboxService = require('../services/dropboxService');
const pdfRenderService = require('../services/pdfRenderService');
const { getSetting } = require('../services/settingsService');
const caseService = require('../services/caseService');
const taskService = require('../services/taskService');
const formService = require('../services/formService');
const formPdfService = require('../services/formPdfService');

const db = { query: jest.fn() };

/** Minimal bundle in getSubmissionForRender's shape. */
function makeBundle(over = {}) {
  const { submission = {}, definition, ...rest } = over;
  return {
    submission: {
      id: 286,
      form_key: 'intake',
      link_type: 'case',
      link_id: 'hjSFMabb',
      status: 'submitted',
      version: 1,
      schema_version: 3,
      data: { client_name: 'John <Smith>' },
      created_at: new Date('2026-08-10T14:00:00Z'),   // 10:00 EDT on the 10th
      updated_at: new Date('2026-08-13T18:51:14Z'),   // adopt bump — must NOT drive the date
      ...submission,
    },
    title: 'Intake Form',
    link_type: 'case',
    definition: definition || {
      sections: [{
        title: 'Client',
        rows: [{ fields: [{ name: 'client_name', type: 'text', label: 'Full name' }] }],
      }],
    },
    definition_schema_version: 3,
    schema_matched: true,
    ...rest,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  formPdfService._resetLogoCacheForTest();
  // clearAllMocks keeps per-test mockRejectedValue overrides — re-pin defaults.
  dropboxService._resolveCredential.mockImplementation(async () => 8);
  dropboxService.resolveLocation.mockImplementation(async () => '/Clients/Smith, John');
  dropboxService.createFolder.mockImplementation(async (d, { path }) => ({ path, existed: false }));
  dropboxService.uploadFile.mockImplementation(async (d, { path }) => ({ path_display: path }));
  dropboxService.getTemporaryLink.mockImplementation(async () => ({
    link: 'https://dl.dropboxusercontent.com/temp/abc', metadata: null,
  }));
  getSetting.mockImplementation(async () => null);
  taskService.createTask.mockImplementation(async () => ({ task_id: 77 }));
  db.query.mockReset();
  // Default: case row with a live folder link; name lookups find John Smith.
  db.query.mockImplementation(async (sql) => {
    if (/case_dropbox/.test(sql)) return [[{ case_dropbox: 'https://www.dropbox.com/sh/case-link' }]];
    if (/contact_lfm_name/.test(sql)) return [[{ contact_lfm_name: 'Smith, John' }]];
    return [[]];
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Print HTML — what the submitter saw, escaped
// ─────────────────────────────────────────────────────────────────────────────

describe('buildSubmissionHtml', () => {
  test('escapes template- and submitter-sourced strings (labels, values, title)', () => {
    const html = formPdfService.buildSubmissionHtml(makeBundle({
      title: 'Intake <b>Form</b>',
      definition: {
        sections: [{
          title: 'Sec "quoted"',
          rows: [{ fields: [{ name: 'client_name', type: 'text', label: '<script>alert(1)</script>' }] }],
        }],
      },
    }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('John &lt;Smith&gt;');
    expect(html).toContain('Intake &lt;b&gt;Form&lt;/b&gt;');
    expect(html).toContain('Sec &quot;quoted&quot;');
  });

  test('showWhen eq: unmet hides the field, met shows it (renderer semantics)', () => {
    const definition = {
      sections: [{
        rows: [{
          fields: [
            { name: 'has_spouse', type: 'checkbox', label: 'Married?' },
            { name: 'spouse_name', type: 'text', label: 'Spouse name',
              showWhen: { field: 'has_spouse', op: 'eq', value: 'true' } },
          ],
        }],
      }],
    };
    const hidden = formPdfService.buildSubmissionHtml(makeBundle({
      definition, submission: { data: { has_spouse: false, spouse_name: 'Stale Value' } },
    }));
    expect(hidden).not.toContain('Spouse name');
    expect(hidden).not.toContain('Stale Value');   // collect() stored it; the PDF must not show it

    const shown = formPdfService.buildSubmissionHtml(makeBundle({
      definition, submission: { data: { has_spouse: true, spouse_name: 'Jane' } },
    }));
    expect(shown).toContain('Spouse name');
    expect(shown).toContain('Jane');
  });

  test('showWhen array = AND: every condition must hold', () => {
    const definition = {
      sections: [{
        rows: [{
          fields: [
            { name: 'a', type: 'text', label: 'A' },
            { name: 'b', type: 'text', label: 'B' },
            { name: 'both', type: 'text', label: 'Both',
              showWhen: [
                { field: 'a', op: 'notEmpty' },
                { field: 'b', op: 'eq', value: 'yes' },
              ] },
          ],
        }],
      }],
    };
    const one = formPdfService.buildSubmissionHtml(makeBundle({
      definition, submission: { data: { a: 'x', b: 'no', both: 'v' } },
    }));
    expect(one).not.toContain('>Both<');
    const both = formPdfService.buildSubmissionHtml(makeBundle({
      definition, submission: { data: { a: 'x', b: 'yes', both: 'v' } },
    }));
    expect(both).toContain('>Both<');
  });

  test('includes op matches ANY wanted value inside a checkgroup CSV', () => {
    const definition = {
      sections: [{
        rows: [{
          fields: [
            { name: 'debts', type: 'checkgroup', label: 'Debts',
              options: ['Medical', 'Credit cards', 'Taxes'] },
            { name: 'tax_years', type: 'text', label: 'Tax years',
              showWhen: { field: 'debts', op: 'includes', value: ['Taxes'] } },
          ],
        }],
      }],
    };
    const yes = formPdfService.buildSubmissionHtml(makeBundle({
      definition, submission: { data: { debts: 'Medical, Taxes', tax_years: '2022-2024' } },
    }));
    expect(yes).toContain('Tax years');
    const no = formPdfService.buildSubmissionHtml(makeBundle({
      definition, submission: { data: { debts: 'Medical', tax_years: '2022-2024' } },
    }));
    expect(no).not.toContain('Tax years');
  });

  test('checkbox prints Yes/No, never the blank dash', () => {
    const definition = {
      sections: [{
        rows: [{ fields: [
          { name: 'agreed', type: 'checkbox', label: 'Agreed' },
          { name: 'silent', type: 'checkbox', label: 'Silent' },
        ] }],
      }],
    };
    const html = formPdfService.buildSubmissionHtml(makeBundle({
      definition, submission: { data: { agreed: true } },
    }));
    expect(html).toMatch(/Agreed<\/td><td class="v">Yes/);
    expect(html).toMatch(/Silent<\/td><td class="v">No/);
  });

  test('select prints the option LABEL for the stored value; unknown values pass raw', () => {
    const definition = {
      sections: [{
        rows: [{ fields: [
          { name: 'chapter', type: 'select', label: 'Chapter',
            options: [{ value: 'ch7', label: 'Chapter 7' }, { value: 'ch13', label: 'Chapter 13' }] },
          { name: 'source', type: 'select', label: 'Source', options: [] },   // optionsFrom-style
        ] }],
      }],
    };
    const html = formPdfService.buildSubmissionHtml(makeBundle({
      definition, submission: { data: { chapter: 'ch13', source: 'Google Ads' } },
    }));
    expect(html).toContain('Chapter 13');
    expect(html).not.toContain('>ch13<');
    expect(html).toContain('Google Ads');
  });

  test('checkgroup prints mapped labels joined with commas', () => {
    const definition = {
      sections: [{
        rows: [{ fields: [
          { name: 'debts', type: 'checkgroup', label: 'Debts',
            options: [{ value: 'cc', label: 'Credit cards' }, { value: 'med', label: 'Medical' }] },
        ] }],
      }],
    };
    const html = formPdfService.buildSubmissionHtml(makeBundle({
      definition, submission: { data: { debts: 'cc, med, Something else' } },
    }));
    expect(html).toContain('Credit cards, Medical, Something else');
  });

  test('masked fields print the display format', () => {
    const definition = {
      sections: [{
        rows: [{ fields: [{ name: 'phone', type: 'text', label: 'Phone', mask: 'phone' }] }],
      }],
    };
    const html = formPdfService.buildSubmissionHtml(makeBundle({
      definition, submission: { data: { phone: '2484179800' } },
    }));
    expect(html).toContain('(248) 417-9800');
  });

  test('visible-but-blank prints an em dash', () => {
    const definition = {
      sections: [{ rows: [{ fields: [{ name: 'notes', type: 'textarea', label: 'Notes' }] }] }],
    };
    const html = formPdfService.buildSubmissionHtml(makeBundle({
      definition, submission: { data: {} },
    }));
    expect(html).toMatch(/Notes<\/td><td class="v">\u2014/);
  });

  test('hidden and embed fields never print; a section left with nothing is skipped whole', () => {
    const definition = {
      sections: [
        {
          title: 'Machinery',
          rows: [{ fields: [
            { name: 'secret_token', type: 'hidden' },
            { name: 'frame', type: 'embed', label: 'Embedded page', src: 'https://x.example/x' },
          ] }],
        },
        { title: 'Real', rows: [{ fields: [{ name: 'client_name', type: 'text', label: 'Name' }] }] },
      ],
    };
    const html = formPdfService.buildSubmissionHtml(makeBundle({
      definition, submission: { data: { secret_token: 'sekrit', client_name: 'John' } },
    }));
    expect(html).not.toContain('sekrit');
    expect(html).not.toContain('Embedded page');
    expect(html).not.toContain('Machinery');   // stray heading skipped
    expect(html).toContain('Real');
  });

  test('repeater renders a table (label headers, data rows); empty repeater says none', () => {
    const definition = {
      sections: [{
        title: 'Creditors',
        repeater: 'creditors',
        fields: [
          { name: 'who', type: 'text', label: 'Creditor' },
          { name: 'amount', type: 'text', label: 'Amount', mask: 'currency' },
          { name: 'secured', type: 'checkbox', label: 'Secured' },
        ],
      }],
    };
    const html = formPdfService.buildSubmissionHtml(makeBundle({
      definition,
      submission: { data: { creditors: [
        { who: 'Visa <Bank>', amount: '1234.5', secured: false },
        { who: 'Ally', amount: '9800', secured: true },
      ] } },
    }));
    expect(html).toContain('<th>Creditor</th>');
    expect(html).toContain('Visa &lt;Bank&gt;');
    expect(html).toContain('$1,234.50');
    expect(html).toMatch(/<td>Yes<\/td>/);

    const empty = formPdfService.buildSubmissionHtml(makeBundle({
      definition, submission: { data: { creditors: [] } },
    }));
    expect(empty).toContain('none');
  });

  test('tabs mode: sticky sections render, tab labels head their sections', () => {
    const definition = {
      stickyTop: [{ rows: [{ fields: [{ name: 'client_name', type: 'text', label: 'Name' }] }] }],
      tabs: [
        { label: 'Income & <Assets>', sections: [
          { rows: [{ fields: [{ name: 'income', type: 'text', label: 'Income' }] }] },
        ] },
      ],
    };
    const html = formPdfService.buildSubmissionHtml(makeBundle({
      definition, submission: { data: { client_name: 'John', income: '55000' } },
    }));
    expect(html).toContain('Income &amp; &lt;Assets&gt;');
    expect(html.indexOf('Name')).toBeLessThan(html.indexOf('Income'));
  });

  test('schema_matched:false adds the layout note; true does not', () => {
    const warned = formPdfService.buildSubmissionHtml(makeBundle({ schema_matched: false }));
    expect(warned).toContain('no longer available');
    const clean = formPdfService.buildSubmissionHtml(makeBundle({}));
    expect(clean).not.toContain('no longer available');
  });

  test('header carries submission id, FIRM-time created date, and the link label; logo only when given', () => {
    const bare = formPdfService.buildSubmissionHtml(makeBundle({}), { linkLabel: 'Case hjSFMabb \u2014 Smith, John' });
    expect(bare).toContain('Submission #286');
    // created_at in firm time drives the Submitted line — NOT updated_at
    // (adopt bumps it). The footer separately prints today's date, so the
    // negative assertion is scoped to the Submitted meta.
    expect(bare).toMatch(/Submitted Aug 10, 2026/);
    expect(bare).not.toMatch(/Submitted Aug 13/);
    expect(bare).toContain('Case hjSFMabb');
    expect(bare).not.toContain('<img');

    const withLogo = formPdfService.buildSubmissionHtml(makeBundle({}), { logoDataUri: 'data:image/png;base64,AAAA' });
    expect(withLogo).toContain('<img src="data:image/png;base64,AAAA"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The placement ladder
// ─────────────────────────────────────────────────────────────────────────────

describe('fileSubmissionPdf — placement ladder', () => {
  test('rung 1: live case link → <case folder>/Forms; verdict path is the path DROPBOX returned', async () => {
    formService.getSubmissionForRender.mockResolvedValue(makeBundle());
    dropboxService.uploadFile.mockResolvedValue({
      path_display: '/Clients/Smith, John/Forms/2026-08-10 Intake Form (#286) (1).pdf',   // autorenamed
    });

    const v = await formPdfService.fileSubmissionPdf(db, { submissionId: 286 });

    expect(dropboxService.resolveLocation).toHaveBeenCalledWith(db, 8, {
      sharedLink: 'https://www.dropbox.com/sh/case-link', expectFolder: true,
    });
    expect(dropboxService.createFolder).toHaveBeenCalledWith(db, {
      credentialId: 8, path: '/Clients/Smith, John/Forms',
    });
    expect(dropboxService.uploadFile).toHaveBeenCalledWith(db, expect.objectContaining({
      path: '/Clients/Smith, John/Forms/2026-08-10 Intake Form (#286).pdf',
      mode: 'add', autorename: true,
    }));
    expect(v.placement).toBe('case');
    expect(v.path).toBe('/Clients/Smith, John/Forms/2026-08-10 Intake Form (#286) (1).pdf');
    expect(v.file_name).toBe('2026-08-10 Intake Form (#286) (1).pdf');
    expect(v.temp_link).toBe('https://dl.dropboxusercontent.com/temp/abc');
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(pdfRenderService.renderHtmlToPdf).toHaveBeenCalledTimes(1);
  });

  test('rung 2: no case_dropbox → ensureCaseDropboxFolder + merge task, then case placement', async () => {
    formService.getSubmissionForRender.mockResolvedValue(makeBundle());
    db.query.mockImplementation(async (sql) => {
      if (/case_dropbox/.test(sql)) return [[{ case_dropbox: null }]];
      if (/contact_lfm_name/.test(sql)) return [[{ contact_lfm_name: 'Smith, John' }]];
      return [[]];
    });
    caseService.ensureCaseDropboxFolder.mockResolvedValue({
      existed: false, path: '/Clients/Smith, John', shared_link: 'https://www.dropbox.com/sh/new-link',
    });

    const v = await formPdfService.fileSubmissionPdf(db, { submissionId: 286 });

    expect(caseService.ensureCaseDropboxFolder).toHaveBeenCalledWith(db, 'hjSFMabb');
    expect(dropboxService.resolveLocation).toHaveBeenCalledWith(db, 8, expect.objectContaining({
      sharedLink: 'https://www.dropbox.com/sh/new-link',
    }));
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    expect(taskService.createTask).toHaveBeenCalledWith(db, expect.objectContaining({
      source: 'form_pdf', link_type: 'case', link_id: 'hjSFMabb',
    }));
    expect(v.placement).toBe('case');
    expect(v.warnings.join(' ')).toContain('created automatically');
  });

  test('rung 3: dead case link → unsorted PER-CASE subfolder + move task raised AFTER upload', async () => {
    formService.getSubmissionForRender.mockResolvedValue(makeBundle());
    dropboxService.resolveLocation.mockRejectedValue(new Error('shared link revoked'));

    const v = await formPdfService.fileSubmissionPdf(db, { submissionId: 286 });

    expect(dropboxService.uploadFile).toHaveBeenCalledWith(db, expect.objectContaining({
      path: '/  Law Office/   Cases/  Unsorted Form Submissions/hjSFMabb - Smith, John/2026-08-10 Intake Form (#286).pdf',
    }));
    expect(v.placement).toBe('unsorted');
    expect(v.placement_note).toContain('unsorted');
    // Move task raised once, after upload, naming the actual file
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    const taskArg = taskService.createTask.mock.calls[0][1];
    expect(taskArg.title).toContain('Move form PDF');
    expect(taskArg.desc).toContain('#286');
  });

  test('rung 3 note: an upload failure on the unsorted rung raises NO move task and throws', async () => {
    formService.getSubmissionForRender.mockResolvedValue(makeBundle());
    dropboxService.resolveLocation.mockRejectedValue(new Error('shared link revoked'));
    dropboxService.uploadFile.mockRejectedValue(new Error('network down'));

    await expect(formPdfService.fileSubmissionPdf(db, { submissionId: 286 }))
      .rejects.toThrow(/could not upload/);
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  test('contact-linked → unsorted loose file with identity prefix, NO task', async () => {
    formService.getSubmissionForRender.mockResolvedValue(makeBundle({
      submission: { link_type: 'contact', link_id: '1001' },
    }));
    db.query.mockImplementation(async (sql) => {
      if (/contact_lfm_name/.test(sql)) return [[{ contact_lfm_name: 'Doe, Jane' }]];
      return [[]];
    });

    const v = await formPdfService.fileSubmissionPdf(db, { submissionId: 286 });

    expect(dropboxService.uploadFile).toHaveBeenCalledWith(db, expect.objectContaining({
      path: '/  Law Office/   Cases/  Unsorted Form Submissions/contact 1001 - Doe, Jane - 2026-08-10 Intake Form (#286).pdf',
    }));
    expect(v.placement).toBe('unsorted');
    expect(taskService.createTask).not.toHaveBeenCalled();
    // never touched the case machinery
    expect(caseService.ensureCaseDropboxFolder).not.toHaveBeenCalled();
  });

  test('unlinked → "submission {id} - {guessed submitter name}" prefix', async () => {
    formService.getSubmissionForRender.mockResolvedValue(makeBundle({
      submission: { link_type: '', link_id: '', data: { client_name: 'Bob Roberts', notes: 'x' } },
    }));

    await formPdfService.fileSubmissionPdf(db, { submissionId: 286 });

    const uploaded = dropboxService.uploadFile.mock.calls[0][1].path;
    expect(uploaded).toContain('/submission 286 - Bob Roberts - 2026-08-10');
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  test('drafts are refused', async () => {
    formService.getSubmissionForRender.mockResolvedValue(makeBundle({
      submission: { status: 'draft' },
    }));
    await expect(formPdfService.fileSubmissionPdf(db, { submissionId: 286 }))
      .rejects.toThrow(/draft/);
    expect(pdfRenderService.renderHtmlToPdf).not.toHaveBeenCalled();
  });

  test('temp-link failure does NOT fail the filing — null link + warning instead', async () => {
    formService.getSubmissionForRender.mockResolvedValue(makeBundle());
    dropboxService.getTemporaryLink.mockRejectedValue(new Error('rate limited'));

    const v = await formPdfService.fileSubmissionPdf(db, { submissionId: 286 });
    expect(v.path).toBeTruthy();
    expect(v.temp_link).toBeNull();
    expect(v.temp_link_expires_note).toBeNull();
    expect(v.warnings.join(' ')).toContain('temporary download link could not be created');
  });

  test('filename override: sanitized, ".pdf" enforced, unsorted identity prefix still applied', async () => {
    formService.getSubmissionForRender.mockResolvedValue(makeBundle({
      submission: { link_type: 'appt', link_id: '450' },
    }));

    await formPdfService.fileSubmissionPdf(db, {
      submissionId: 286, filename: 'inta/ke:doc.PDF',
    });

    const uploaded = dropboxService.uploadFile.mock.calls[0][1].path;
    expect(uploaded).toContain('/appt 450 - inta-ke-doc.pdf');
  });

  test('non-integer submission id throws before any work', async () => {
    await expect(formPdfService.fileSubmissionPdf(db, { submissionId: 'abc' }))
      .rejects.toThrow(/positive integer/);
    expect(formService.getSubmissionForRender).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The internal function
// ─────────────────────────────────────────────────────────────────────────────

describe('render_submission_pdf internal function', () => {
  const internalFunctions = require('../lib/internal_functions');

  test('registered, workflow-only, pdf category', () => {
    expect(typeof internalFunctions.render_submission_pdf).toBe('function');
    const meta = internalFunctions.render_submission_pdf.__meta;
    expect(meta.workflowOnly).toBe(true);
    expect(meta.category).toBe('pdf');
    expect(meta.params.find((p) => p.name === 'submission_id').required).toBe(true);
  });

  test('maps the verdict to output and honors output_var', async () => {
    const verdict = {
      path: '/Clients/X/Forms/f.pdf', file_name: 'f.pdf', placement: 'case',
      placement_note: null, temp_link: 'https://dl/x',
      temp_link_expires_note: 'Dropbox temporary link \u2014 expires ~4 hours after creation',
      warnings: [], submission_id: 286, form_key: 'intake',
      link_type: 'case', link_id: 'hjSFMabb',
    };
    const spy = jest.spyOn(formPdfService, 'fileSubmissionPdf').mockResolvedValue(verdict);

    const res = await internalFunctions.render_submission_pdf(
      { submission_id: 286, output_var: 'intake_pdf' }, db
    );
    expect(spy).toHaveBeenCalledWith(db, { submissionId: 286 });
    expect(res.success).toBe(true);
    expect(res.output.temp_link).toBe('https://dl/x');
    expect(res.output.placement).toBe('case');
    expect(res.set_vars.intake_pdf).toEqual(res.output);
    spy.mockRestore();
  });

  test('errors propagate with the function-name prefix', async () => {
    const spy = jest.spyOn(formPdfService, 'fileSubmissionPdf')
      .mockRejectedValue(new Error('submission 9 is a draft \u2014 only submitted forms can be rendered'));
    await expect(internalFunctions.render_submission_pdf({ submission_id: 9 }, db))
      .rejects.toThrow(/^render_submission_pdf: submission 9 is a draft/);
    spy.mockRestore();
  });
});
