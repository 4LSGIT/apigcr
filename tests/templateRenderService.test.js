/**
 * Tests for services/templateRenderService.js — the G1 extraction of the
 * template → PDF path out of esignSendService.
 *
 * Scope: the three functions the extraction NEWLY exposes as their own units
 * (resolveTemplateValues, fillBlanks, renderTemplateToPdf). interpolateTemplate
 * and previewFromTemplate keep their existing coverage in
 * tests/esignTemplates.test.js, which exercises the re-exports and therefore
 * also proves the delegations still work.
 *
 * NO network, NO real DB, NO real chromium: pdfRenderService is mocked whole
 * and esignTemplateService.getTemplatePdf is mocked over the real module. The
 * pdf-fill path is REAL — services/esign/pdfFill runs against real pdf-lib, so
 * "the pdf branch draws ink" is a fact about the code, not about a stub.
 *
 *   npx jest tests/templateRenderService.test.js
 */

jest.mock('../services/pdfRenderService', () => ({
  renderHtmlToPdf: jest.fn(),
}));

jest.mock('../services/esignTemplateService', () => {
  const actual = jest.requireActual('../services/esignTemplateService');
  return { ...actual, getTemplatePdf: jest.fn() };
});

// firmConfig env fallbacks — resolvers read cfg(), which under jest with no
// injected db serves these. (Same seeding as tests/esignTemplates.test.js.)
process.env.FIRM_PHONE = '2484179800';
process.env.FIRM_EMAIL = 'office@4lsg.com';
process.env.FIRM_URL   = 'https://legalsolutions.group';

const pdfRenderService = require('../services/pdfRenderService');
const templateService  = require('../services/esignTemplateService');
const render           = require('../services/templateRenderService');

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal classic PDF — same builder the esign suites use. */
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

/** Deflate-aware content-stream scrape, so drawn text can be asserted. */
const zlib = require('zlib');
function inflateStreams(buf) {
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
    try { text += zlib.inflateSync(raw).toString('latin1') + '\n'; }
    catch { text += raw.toString('latin1') + '\n'; }
    i = e + 9;
  }
  return text;
}
const hexOf = (v) => Buffer.from(v, 'latin1').toString('hex').toUpperCase();

const CASE_ROW = { case_id: 'AbC12dEf', case_number: '26-41234', case_chapter: '7' };
const DEBTOR1  = { contact_id: 101, contact_name: 'John Q Smith', contact_email: 'john@example.com' };

/** A db whose query() dispatches on SQL substrings; unmatched returns [[]]. */
function makeDb() {
  const rules = [];
  const calls = [];
  return {
    calls,
    when(substr, rows) { rules.push({ substr, rows }); return this; },
    query: jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      for (const r of rules) if (sql.includes(r.substr)) return [r.rows];
      return [[]];
    }),
  };
}

/** db wired for a case context with one Primary and no Secondary. */
function caseDb() {
  return makeDb()
    .when('SELECT * FROM cases WHERE case_id', [CASE_ROW])
    .when("case_relate_type = 'Primary'", [DEBTOR1])
    .when("case_relate_type = 'Secondary'", []);
}

function htmlTemplate(overrides = {}) {
  return {
    id: 7,
    name: 'Retainer Agreement',
    kind: 'retainer_custom',
    template_type: 'html',
    body: '<p>{{debtor_name}} owes {{fee}}.</p>',
    prefill_schema: [
      { key: 'debtor_name', label: 'Debtor name', type: 'text',
        resolver: 'debtor1.name', default: null, required: true },
      { key: 'fee', label: 'Fee', type: 'money',
        resolver: null, default: '1500', required: true },
    ],
    placement_json: {
      coord_space: 'pdf_user_space',
      fields: [{ page: 1, x: 100, y: 100, w: 180, h: 30, type: 'signature', signer: 1 }],
    },
    expiration_days: 30,
    active: true,
    ...overrides,
  };
}

function pdfTemplate(overrides = {}) {
  return htmlTemplate({
    template_type: 'pdf',
    body: '',
    placement_json: {
      coord_space: 'pdf_user_space',
      fields: [
        { page: 1, x: 100, y: 600, w: 220, h: 18, type: 'text', key: 'debtor_name' },
        { page: 1, x: 100, y: 100, w: 180, h: 30, type: 'signature', signer: 1 },
      ],
    },
    ...overrides,
  });
}

const LINKED = { linkableType: 'case', linkableId: 'AbC12dEf' };

beforeEach(() => {
  jest.clearAllMocks();
  pdfRenderService.renderHtmlToPdf.mockResolvedValue(buildPdf(1));
  templateService.getTemplatePdf.mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveTemplateValues
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveTemplateValues', () => {
  test('resolves against the linkable and formats by declared type', async () => {
    const r = await render.resolveTemplateValues(caseDb(), htmlTemplate(), LINKED);

    expect(r.merged).toEqual({ debtor_name: 'John Q Smith', fee: '$1,500.00' });
    expect(r.missingRequired).toEqual([]);
    expect(r.context.debtor1.contact_name).toBe('John Q Smith');
    expect(r.template.id).toBe(7);
    expect(typeof r.interpolate).toBe('function');
  });

  test('caller values WIN over resolved prefills, formatted by declared type', async () => {
    const r = await render.resolveTemplateValues(caseDb(), htmlTemplate(), {
      ...LINKED, values: { debtor_name: 'Override Name', fee: '2500' },
    });

    expect(r.merged.debtor_name).toBe('Override Name');
    expect(r.merged.fee).toBe('$2,500.00');   // raw '2500' formatted as money
  });

  test('undeclared caller keys are DROPPED — no type, no placeholder, no business', async () => {
    const r = await render.resolveTemplateValues(caseDb(), htmlTemplate(), {
      ...LINKED, values: { hack: '<script>alert(1)</script>', fee: '900' },
    });

    expect(Object.keys(r.merged).sort()).toEqual(['debtor_name', 'fee']);
    expect(r.merged).not.toHaveProperty('hack');
    expect(r.merged.fee).toBe('$900.00');     // the declared sibling still applied
  });

  test('missingRequired lists empty required keys, and only required ones', async () => {
    const t = htmlTemplate({
      prefill_schema: [
        { key: 'debtor_name', label: 'D', type: 'text', resolver: 'debtor1.name', required: true },
        { key: 'fee',      label: 'F', type: 'money', resolver: null, default: null, required: true },
        { key: 'optional', label: 'O', type: 'text',  resolver: null, default: null, required: false },
      ],
    });
    const r = await render.resolveTemplateValues(caseDb(), t, LINKED);

    expect(r.merged.fee).toBe('');
    expect(r.merged.optional).toBe('');
    expect(r.missingRequired).toEqual(['fee']);   // 'optional' is empty but not required
  });

  test('an EMPTY OPTIONS ARRAY counts as missing for a required options row', async () => {
    const t = htmlTemplate({
      prefill_schema: [
        { key: 'dates',  label: 'Dates', type: 'options', resolver: null, default: null, required: true },
        { key: 'filled', label: 'Filled', type: 'options', resolver: null, default: 'a\nb', required: true },
      ],
    });
    const r = await render.resolveTemplateValues(caseDb(), t, LINKED);

    expect(r.merged.dates).toEqual([]);
    expect(r.merged.filled).toEqual(['a', 'b']);
    expect(r.missingRequired).toEqual(['dates']);
  });

  test('a caller value can SATISFY a required key', async () => {
    const t = htmlTemplate({
      prefill_schema: [
        { key: 'fee', label: 'F', type: 'money', resolver: null, default: null, required: true },
      ],
    });
    const r = await render.resolveTemplateValues(caseDb(), t, { ...LINKED, values: { fee: '1800' } });

    expect(r.merged.fee).toBe('$1,800.00');
    expect(r.missingRequired).toEqual([]);
  });

  test('no linkable → authoring-time resolution: defaults only, resolvers skipped', async () => {
    const db = makeDb();
    const r = await render.resolveTemplateValues(db, htmlTemplate(), { values: null });

    expect(r.merged).toEqual({ debtor_name: '', fee: '$1,500.00' });
    expect(r.missingRequired).toEqual(['debtor_name']);
    expect(db.calls).toHaveLength(0);           // resolvers never ran, so no context load
  });

  test('the returned interpolate() closes over the TEMPLATE body', async () => {
    const r = await render.resolveTemplateValues(caseDb(), htmlTemplate(), LINKED);
    expect(r.interpolate(r.merged)).toBe('<p>John Q Smith owes $1,500.00.</p>');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fillBlanks
// ─────────────────────────────────────────────────────────────────────────────

describe('fillBlanks', () => {
  const t = htmlTemplate({
    prefill_schema: [
      { key: 'a', label: 'A', type: 'text' },
      { key: 'b', label: 'B', type: 'text' },
      { key: 'c', label: 'C', type: 'text' },
    ],
  });

  test('null and undefined become empty strings and are reported missing', () => {
    const { filled, missing } = render.fillBlanks(t, { a: null, b: undefined, c: 'kept' });

    expect(filled).toEqual({ a: '', b: '', c: 'kept' });
    expect(missing).toEqual(['a', 'b']);
  });

  test('a key absent from merged entirely is filled and reported', () => {
    const { filled, missing } = render.fillBlanks(t, { c: 'kept' });

    expect(filled).toEqual({ a: '', b: '', c: 'kept' });
    expect(missing).toEqual(['a', 'b']);
  });

  test('non-empty values are untouched and never reported', () => {
    const { filled, missing } = render.fillBlanks(t, { a: 'x', b: '$1.00', c: '0' });

    expect(filled).toEqual({ a: 'x', b: '$1.00', c: '0' });
    expect(missing).toEqual([]);
  });

  test('it copies rather than mutating the caller\'s map', () => {
    const merged = { a: null, c: 'kept' };
    const { filled } = render.fillBlanks(t, merged);

    expect(merged).toEqual({ a: null, c: 'kept' });
    expect(filled).not.toBe(merged);
  });

  test('an empty options array is left alone and is NOT reported missing', () => {
    const optT = htmlTemplate({
      prefill_schema: [{ key: 'dates', label: 'Dates', type: 'options' }],
    });
    const { filled, missing } = render.fillBlanks(optT, { dates: [] });

    expect(filled.dates).toEqual([]);
    expect(missing).toEqual([]);
  });

  test('keys outside the schema survive the copy but are never reported', () => {
    const { filled, missing } = render.fillBlanks(t, { a: 'x', b: 'y', c: 'z', extra: 'e' });

    expect(filled.extra).toBe('e');
    expect(missing).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderTemplateToPdf
// ─────────────────────────────────────────────────────────────────────────────

describe('renderTemplateToPdf — html', () => {
  test('chromium receives the INTERPOLATED, ESCAPED body', async () => {
    const out = await render.renderTemplateToPdf(caseDb(), htmlTemplate(), {
      debtor_name: 'Smith & Sons', fee: '$1,500.00',
    });

    expect(pdfRenderService.renderHtmlToPdf).toHaveBeenCalledTimes(1);
    const html = pdfRenderService.renderHtmlToPdf.mock.calls[0][0];
    expect(html).toBe('<p>Smith &amp; Sons owes $1,500.00.</p>');
    expect(html).not.toContain('{{');

    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('the stored blob is never read for an html template', async () => {
    await render.renderTemplateToPdf(caseDb(), htmlTemplate(), { debtor_name: 'X', fee: 'Y' });
    expect(templateService.getTemplatePdf).not.toHaveBeenCalled();
  });

  test('a hole in the value map throws ESIGN_UNDECLARED_PLACEHOLDER, nothing rendered', async () => {
    await expect(render.renderTemplateToPdf(caseDb(), htmlTemplate(), { debtor_name: 'X' }))
      .rejects.toMatchObject({ code: 'ESIGN_UNDECLARED_PLACEHOLDER' });
    expect(pdfRenderService.renderHtmlToPdf).not.toHaveBeenCalled();
  });
});

describe('renderTemplateToPdf — pdf', () => {
  test('fills the stored blob via pdf-lib; chromium never runs', async () => {
    const blob = buildPdf(1);
    templateService.getTemplatePdf.mockResolvedValue({
      buffer: blob, size: blob.length, original_name: 'retainer.pdf',
    });

    const db = caseDb();
    const out = await render.renderTemplateToPdf(db, pdfTemplate(), {
      debtor_name: 'John Q Smith', fee: '$1,500.00',
    });

    expect(pdfRenderService.renderHtmlToPdf).not.toHaveBeenCalled();
    expect(templateService.getTemplatePdf).toHaveBeenCalledWith(db, 7);

    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.equals(blob)).toBe(false);                       // pdf-lib rewrote it
    expect(inflateStreams(out)).toContain(hexOf('John Q Smith')); // ink on the page
  });

  test('blanks stay blank rather than erroring', async () => {
    const blob = buildPdf(1);
    templateService.getTemplatePdf.mockResolvedValue({ buffer: blob, size: blob.length });

    const out = await render.renderTemplateToPdf(caseDb(), pdfTemplate(), { debtor_name: '' });

    expect(Buffer.isBuffer(out)).toBe(true);
    expect(inflateStreams(out)).not.toContain(hexOf('John Q Smith'));
  });

  test('no stored source → ESIGN_TEMPLATE_NO_PDF naming the template', async () => {
    templateService.getTemplatePdf.mockResolvedValue(null);

    await expect(render.renderTemplateToPdf(caseDb(), pdfTemplate(), { debtor_name: 'X' }))
      .rejects.toMatchObject({
        code: 'ESIGN_TEMPLATE_NO_PDF',
        message: expect.stringContaining('Retainer Agreement'),
      });
  });

  test('the body is never interpolated for a pdf template (a stale {{…}} cannot throw)', async () => {
    const blob = buildPdf(1);
    templateService.getTemplatePdf.mockResolvedValue({ buffer: blob, size: blob.length });

    // body carries a placeholder with NO matching value — html would throw here.
    const t = pdfTemplate({ body: '<p>{{ghost}}</p>' });
    await expect(render.renderTemplateToPdf(caseDb(), t, { debtor_name: 'John Q Smith' }))
      .resolves.toBeInstanceOf(Buffer);
  });
});
