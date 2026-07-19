/**
 * Tests for services/esignSendService.js + routes/api.esign.actions.js — the
 * Phase 2A send/action layer.
 *
 * NO network, NO real DB. esignService, the provider factory and the filing
 * service are jest-mocked; what is under test is the ORCHESTRATION — what gets
 * stamped, what reaches the provider, what happens to the row when the vendor
 * says no, and which of those failures are allowed to fail the request.
 *
 * ── pdf-lib IS REAL HERE ────────────────────────────────────────────────────
 * Stamping is the one piece of this slice with no external dependency, so it
 * is exercised for real against a PDF this file builds byte by byte.
 *
 * ── WHY THE FOOTER IS VERIFIED VIA CONTENT STREAMS, NOT pdf-parse ───────────
 * The obvious assertion — run the output through pdf-parse and look for the
 * tracking id — does not work in this repo, and fails in the worst way: by
 * PASSING for the wrong reason.
 *
 * pdf-parse@1.1.4 bundles pdf.js v1.10.100 (2018). Measured on 2026-07-19:
 *   - REAL PDFs round-trip through pdf-lib and read back correctly.
 *   - SYNTHETIC minimal PDFs — pdf-lib's own PDFDocument.create() output, and
 *     hand-rolled ones — are rejected with 'bad XRef entry', regardless of
 *     xref EOL style, trailer /ID, or header version.
 *   - That old pdf.js carries GLOBAL state across calls in one process. After
 *     a failure it enters object-indexing recovery mode and the NEXT document
 *     parses \"successfully\" — so a suite that parses several documents gets
 *     order-dependent results and green tests that prove nothing.
 *
 * So the footer is verified where it actually lands: inflate every stream in
 * the output and look for the text pdf-lib wrote. pdf-lib emits drawn text as
 * an uppercase hex string (`<446F63...> Tj`), so the expected value is the hex
 * encoding of the footer. This is a STRONGER assertion than text extraction —
 * it counts occurrences, which proves the footer is on EVERY page rather than
 * merely somewhere in the document.
 *
 *   npx jest tests/esignSend.test.js
 */

const zlib = require('zlib');

jest.mock('../services/esignService', () => ({
  createRequest:   jest.fn(),
  markSent:        jest.fn(),
  applyStatus:     jest.fn(),
  appendEvent:     jest.fn(async () => ({ ok: true })),
  getById:         jest.fn(),
  listOutstanding: jest.fn(async () => []),
  setPdfPaths:     jest.fn(),
  setLogHook:      jest.fn(),
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
  recordCreditSpend: jest.fn(async () => ({ ok: true, balance: 95, previous: 100 })),
}));

// Real sniffBuffer / buildFilename; only the Dropbox-touching call is stubbed.
jest.mock('../services/esignFilingService', () => {
  const actual = jest.requireActual('../services/esignFilingService');
  return { ...actual, fileExternalDocument: jest.fn() };
});

const esignService       = require('../services/esignService');
const esignFilingService = require('../services/esignFilingService');
const { getProvider, recordCreditSpend } = require('../services/esign');
const svc = require('../services/esignSendService');

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES
// ─────────────────────────────────────────────────────────────────────────────

const TRACKING = 'YC-AbC12dEf-retainer_prepetition-9F3A21BC';

/**
 * A minimal but structurally complete PDF: classic uncompressed objects, a
 * 20-byte-per-entry cross-reference table, real byte offsets.
 *
 * Built here rather than checked in as a binary so the fixture is readable and
 * the page count is a parameter.
 */
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

/** Inflate every stream in a PDF and concatenate the results. */
function inflateAllStreams(buf) {
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

/** How pdf-lib will have written `Doc Ctrl: <id>` into a content stream. */
function footerHex(trackingId) {
  return Buffer.from(`Doc Ctrl: ${trackingId}`, 'latin1').toString('hex').toUpperCase();
}

function countFooters(pdfBuffer, trackingId) {
  return inflateAllStreams(pdfBuffer).split(footerHex(trackingId)).length - 1;
}

function makeRow(over = {}) {
  return {
    id: 42,
    provider: 'zoho_sign',
    provider_id: null,
    linkable_type: 'case',
    linkable_id: 'AbC12dEf',
    kind: 'retainer_prepetition',
    status: 'draft',
    document_name: 'Retainer Agreement',
    tracking_id: TRACKING,
    recipients: [{ name: 'John Smith', email: 'john@example.com', order: 1, status: 'pending' }],
    placement_json: null,
    template_id: null,
    seq_instance_id: null,
    signed_pdf_path: null,
    cert_pdf_path: null,
    sent_at: null,
    completed_at: null,
    expires_at: null,
    created_by: 1,
    created_at: '2026-07-19 10:00:00',
    updated_at: '2026-07-19 10:00:00',
    ...over,
  };
}

function makeDb({ caseExists = true, contactExists = true, rows = [], events = [] } = {}) {
  return {
    query: jest.fn(async (sql) => {
      if (/FROM cases/i.test(sql))                  return [caseExists ? [{ case_id: 'AbC12dEf' }] : []];
      if (/FROM contacts/i.test(sql))               return [contactExists ? [{ contact_id: 22 }] : []];
      if (/UPDATE signing_requests/i.test(sql))     return [{ affectedRows: 1 }];
      if (/FROM signing_request_events/i.test(sql)) return [events];
      if (/FROM signing_requests/i.test(sql))       return [rows];
      return [[]];
    }),
  };
}

function makeProvider(over = {}) {
  return {
    sendForSignature: jest.fn(async () => ({
      providerId: 'ZS-9001', status: 'sent', providerStatus: 'inprogress', testing: true, raw: {},
    })),
    recall: jest.fn(async () => ({ status: 'recalled', reasonSentToProvider: false, raw: {} })),
    remind: jest.fn(async () => ({ ok: true, remindedAll: true, raw: {} })),
    ...over,
  };
}

const GOOD_SEND = {
  linkableType: 'case',
  linkableId: 'AbC12dEf',
  kind: 'retainer_prepetition',
  documentName: 'Retainer Agreement',
  recipients: [{ name: 'John Smith', email: 'John@Example.com', order: 1 }],
  createdBy: 1,
};

let provider;

beforeEach(() => {
  jest.clearAllMocks();
  provider = makeProvider();
  getProvider.mockResolvedValue(provider);
  recordCreditSpend.mockResolvedValue({ ok: true, balance: 95, previous: 100 });
  esignService.createRequest.mockResolvedValue(makeRow());
  esignService.markSent.mockImplementation(async (db, id, { providerId, sentAt, expiresAt }) =>
    makeRow({ id, status: 'sent', provider_id: providerId, sent_at: sentAt, expires_at: expiresAt }));
  esignService.applyStatus.mockImplementation(async (db, id, { status }) =>
    ({ changed: true, request: makeRow({ id, status }) }));
  esignService.getById.mockResolvedValue(makeRow());
  esignService._normalizeRecipients.mockImplementation((r) => r || []);
  esignFilingService.fileExternalDocument.mockResolvedValue({
    filed: true, skipped: false, reason: null, note: null,
    signedPdfPath: '/Clients/Smith/Signed Documents/2026-07-19 Retainer Agreement (signed - external).pdf',
    certPdfPath: null, warnings: [],
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// stampTrackingFooter
// ─────────────────────────────────────────────────────────────────────────────

describe('stampTrackingFooter', () => {
  test('output is a loadable PDF with the page count unchanged', async () => {
    const { PDFDocument } = require('pdf-lib');
    const src = buildPdf(3);
    const out = await svc.stampTrackingFooter(src, TRACKING);

    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.subarray(0, 4).toString()).toBe('%PDF');

    const reloaded = await PDFDocument.load(out, { updateMetadata: false });
    expect(reloaded.getPageCount()).toBe(3);
  });

  test('the tracking id lands on EVERY page, once each', async () => {
    for (const pages of [1, 2, 5]) {
      const out = await svc.stampTrackingFooter(buildPdf(pages), TRACKING);
      expect(countFooters(out, TRACKING)).toBe(pages);
    }
  });

  test('the original page content survives', async () => {
    const out = await svc.stampTrackingFooter(buildPdf(2), TRACKING);
    expect(inflateAllStreams(out)).toContain('Body page 2');
  });

  test('an unrelated tracking id is NOT found (the assertion can fail)', async () => {
    const out = await svc.stampTrackingFooter(buildPdf(1), TRACKING);
    expect(countFooters(out, 'YC-NOPE-nope-00000000')).toBe(0);
  });

  test('metadata is left alone — no pdf-lib Producer/ModDate stamp', async () => {
    const { PDFDocument } = require('pdf-lib');
    const out = await svc.stampTrackingFooter(buildPdf(1), TRACKING);
    const doc = await PDFDocument.load(out, { updateMetadata: false });
    // The fixture has no Info dict at all; pdf-lib must not have invented one.
    expect(doc.getProducer()).toBeUndefined();
    expect(doc.getModificationDate()).toBeUndefined();
  });

  test.each([
    ['not a PDF at all',   Buffer.from('this is a text file, not a pdf')],
    ['a ZIP',              Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])],
    ['an empty buffer',    Buffer.alloc(0)],
  ])('rejects %s with ESIGN_BAD_PDF', async (_label, buf) => {
    await expect(svc.stampTrackingFooter(buf, TRACKING))
      .rejects.toMatchObject({ code: 'ESIGN_BAD_PDF' });
  });

  test('rejects a non-Buffer', async () => {
    await expect(svc.stampTrackingFooter('%PDF-1.4 pretend', TRACKING))
      .rejects.toMatchObject({ code: 'ESIGN_BAD_PDF' });
  });

  test('rejects anything over 20MB with ESIGN_PDF_TOO_LARGE', async () => {
    // Valid PDF magic so the size check is provably what rejects it.
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(svc.MAX_PDF_BYTES + 1)]);
    await expect(svc.stampTrackingFooter(big, TRACKING))
      .rejects.toMatchObject({ code: 'ESIGN_PDF_TOO_LARGE' });
  });

  test('the size check runs before parsing (a huge non-PDF still reports size)', async () => {
    const big = Buffer.alloc(svc.MAX_PDF_BYTES + 1);
    await expect(svc.stampTrackingFooter(big, TRACKING))
      .rejects.toMatchObject({ code: 'ESIGN_PDF_TOO_LARGE' });
  });

  test('requires a tracking id', async () => {
    await expect(svc.stampTrackingFooter(buildPdf(1), ''))
      .rejects.toMatchObject({ code: 'ESIGN_BAD_PDF' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateSendInput
// ─────────────────────────────────────────────────────────────────────────────

describe('document_name rules', () => {
  const good = [
    'Retainer Agreement – Smith',
    'Retainer Agreement',
    'Chapter 7 Schedules',
    'Fee Agreement (post-petition)',
    'Statement of Financial Affairs',
    'Amended Schedule I/J',
  ];
  test.each(good)('accepts %s', (name) => {
    expect(svc._validateDocumentName(name)).toBe(name);
  });

  const bad = [
    ['a filename',            '472304-Ch7_Form122A_smith.pdf'],
    ['a request_ prefix',     'request_88213 retainer'],
    ['a hex/uuid fragment',   'Retainer 3f9ac1de88bb04'],
    ['a long single token',   'Retainer_Agreement_Smith_2026'],
    ['too short',             'ab'],
    ['no letters',            '2026-07-19 1234'],
    ['blank',                 '   '],
    ['over 120 chars',        'A'.repeat(121)],
  ];
  test.each(bad)('rejects %s', (_label, name) => {
    expect(() => svc._validateDocumentName(name))
      .toThrow(expect.objectContaining({ code: 'ESIGN_BAD_NAME' }));
  });

  test('the message is safe to show the user verbatim', () => {
    try {
      svc._validateDocumentName('472304-Ch7_Form122A_smith.pdf');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('ESIGN_BAD_NAME');
      expect(e.message).toMatch(/document name/i);
      expect(e.message).not.toMatch(/undefined|\[object|Error:/);
    }
  });
});

describe('recipient rules', () => {
  test('lowercases and trims the email', () => {
    const out = svc._validateRecipients([{ name: ' John Smith ', email: '  John@Example.COM ', order: 1 }]);
    expect(out[0]).toEqual({ name: 'John Smith', email: 'john@example.com', order: 1 });
  });

  test('accepts up to five signers with contiguous orders', () => {
    const five = [1, 2, 3, 4, 5].map((n) => ({ name: `S${n}`, email: `s${n}@x.com`, order: n }));
    expect(svc._validateRecipients(five)).toHaveLength(5);
  });

  test.each([
    ['an empty list',        []],
    ['a non-array',          null],
    ['six signers',          [1, 2, 3, 4, 5, 6].map((n) => ({ name: `S${n}`, email: `s${n}@x.com`, order: n }))],
    ['a missing name',       [{ name: '', email: 'a@x.com', order: 1 }]],
    ['an over-long name',    [{ name: 'x'.repeat(101), email: 'a@x.com', order: 1 }]],
    ['a malformed email',    [{ name: 'A', email: 'not-an-email', order: 1 }]],
    ['a missing order',      [{ name: 'A', email: 'a@x.com' }]],
    ['a gap in the order',   [{ name: 'A', email: 'a@x.com', order: 1 }, { name: 'B', email: 'b@x.com', order: 3 }]],
    ['a repeated order',     [{ name: 'A', email: 'a@x.com', order: 1 }, { name: 'B', email: 'b@x.com', order: 1 }]],
    ['a zero-based order',   [{ name: 'A', email: 'a@x.com', order: 0 }]],
    ['a duplicate email',    [{ name: 'A', email: 'a@x.com', order: 1 }, { name: 'B', email: 'A@X.com', order: 2 }]],
  ])('rejects %s', (_label, recips) => {
    expect(() => svc._validateRecipients(recips))
      .toThrow(expect.objectContaining({ code: 'ESIGN_BAD_RECIPIENTS' }));
  });
});

describe('expiration rules', () => {
  test('defaults to 14', () => {
    expect(svc._validateExpirationDays(null)).toBe(svc.DEFAULT_EXPIRATION_DAYS);
    expect(svc._validateExpirationDays('')).toBe(14);
  });
  test.each([1, 14, 30, 90])('accepts %i', (n) => {
    expect(svc._validateExpirationDays(n)).toBe(n);
  });
  test.each([0, -1, 91, 1.5, 'soon'])('rejects %p', (n) => {
    expect(() => svc._validateExpirationDays(n))
      .toThrow(expect.objectContaining({ code: 'ESIGN_BAD_EXPIRATION' }));
  });
});

describe('validateSendInput', () => {
  test('accepts a well-formed request and returns the normalized shape', async () => {
    const out = await svc.validateSendInput(makeDb(), GOOD_SEND);
    expect(out.documentName).toBe('Retainer Agreement');
    expect(out.recipients[0].email).toBe('john@example.com');
    expect(out.expirationDays).toBe(14);
  });

  test('rejects an unknown kind', async () => {
    await expect(svc.validateSendInput(makeDb(), { ...GOOD_SEND, kind: 'mortgage' }))
      .rejects.toMatchObject({ code: 'ESIGN_BAD_KIND' });
  });

  test.each(svc.KINDS)('accepts kind %s', async (kind) => {
    await expect(svc.validateSendInput(makeDb(), { ...GOOD_SEND, kind })).resolves.toBeTruthy();
  });

  test('rejects a case that does not exist', async () => {
    await expect(svc.validateSendInput(makeDb({ caseExists: false }), GOOD_SEND))
      .rejects.toMatchObject({ code: 'ESIGN_BAD_LINKABLE' });
  });

  test('rejects a contact that does not exist', async () => {
    await expect(svc.validateSendInput(makeDb({ contactExists: false }), {
      ...GOOD_SEND, linkableType: 'contact', linkableId: '999',
    })).rejects.toMatchObject({ code: 'ESIGN_BAD_LINKABLE' });
  });

  test('binds linkable_id as a STRING (idx_sr_linkable)', async () => {
    const db = makeDb();
    await svc.validateSendInput(db, { ...GOOD_SEND, linkableType: 'contact', linkableId: 22 });
    const call = db.query.mock.calls.find((c) => /FROM contacts/i.test(c[0]));
    expect(typeof call[1][0]).toBe('string');
  });

  test('rejects an unknown linkable type', async () => {
    await expect(svc.validateSendInput(makeDb(), { ...GOOD_SEND, linkableType: 'appt' }))
      .rejects.toMatchObject({ code: 'ESIGN_BAD_LINKABLE' });
  });

  test('reuses the shared placement validator', async () => {
    await expect(svc.validateSendInput(makeDb(), {
      ...GOOD_SEND,
      placements: { fields: [{ page: 1, x: 0, y: 0, w: 1, h: 1, type: 'notarize', signer: 1 }] },
    })).rejects.toMatchObject({ code: 'ESIGN_INVALID_INPUT' });
  });

  test('rejects a field bound to a signer who is not on the envelope', async () => {
    await expect(svc.validateSendInput(makeDb(), {
      ...GOOD_SEND,
      placements: { fields: [{ page: 1, x: 0, y: 0, w: 1, h: 1, type: 'signature', signer: 3 }] },
    })).rejects.toMatchObject({ code: 'ESIGN_BAD_PLACEMENTS' });
  });

  test('accepts a field bound to a signer who IS on the envelope', async () => {
    await expect(svc.validateSendInput(makeDb(), {
      ...GOOD_SEND,
      placements: { fields: [{ page: 1, x: 0, y: 0, w: 1, h: 1, type: 'signature', signer: 1 }] },
    })).resolves.toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendPipeline
// ─────────────────────────────────────────────────────────────────────────────

describe('sendPipeline — happy path', () => {
  test('creates a draft, sends, and marks it sent', async () => {
    const out = await svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(2) });

    expect(esignService.createRequest).toHaveBeenCalledTimes(1);
    expect(provider.sendForSignature).toHaveBeenCalledTimes(1);
    expect(esignService.markSent).toHaveBeenCalledWith(
      expect.anything(), 42, expect.objectContaining({ providerId: 'ZS-9001' })
    );
    expect(out.row.status).toBe('sent');
  });

  test('the provider receives the STAMPED buffer, not the caller’s', async () => {
    const src = buildPdf(2);
    await svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: src });

    const sent = provider.sendForSignature.mock.calls[0][0].pdfBuffer;
    expect(sent).not.toBe(src);
    expect(sent.equals(src)).toBe(false);
    // and it is stamped with THIS row's tracking id, once per page
    expect(countFooters(sent, TRACKING)).toBe(2);
  });

  test('the footer is stamped BEFORE the provider is called', async () => {
    const order = [];
    provider.sendForSignature.mockImplementation(async ({ pdfBuffer }) => {
      order.push(countFooters(pdfBuffer, TRACKING) > 0 ? 'stamped' : 'unstamped');
      return { providerId: 'ZS-9001', status: 'sent', providerStatus: 'inprogress', testing: true, raw: {} };
    });
    await svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(1) });
    expect(order).toEqual(['stamped']);
  });

  test('expiry is derived from expirationDays', async () => {
    await svc.sendPipeline(makeDb(), { ...GOOD_SEND, expirationDays: 30, pdfBuffer: buildPdf(1) });
    const { sentAt, expiresAt } = esignService.markSent.mock.calls[0][2];
    const days = Math.round((expiresAt - sentAt) / (24 * 60 * 60 * 1000));
    expect(days).toBe(30);
    expect(provider.sendForSignature.mock.calls[0][0].expirationDays).toBe(30);
  });

  test('a placement-free send still reaches the provider (Zoho decides)', async () => {
    await svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(1) });
    expect(provider.sendForSignature.mock.calls[0][0].placements).toEqual({ fields: [] });
  });
});

describe('sendPipeline — credits', () => {
  test('a TEST send spends nothing', async () => {
    await svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(1) });   // testing:true
    expect(recordCreditSpend).not.toHaveBeenCalled();
  });

  test('a REAL send spends credits', async () => {
    provider.sendForSignature.mockResolvedValue({
      providerId: 'ZS-9002', status: 'sent', providerStatus: 'inprogress', testing: false, raw: {},
    });
    const out = await svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(1) });
    expect(recordCreditSpend).toHaveBeenCalledTimes(1);
    expect(out.testing).toBe(false);
  });

  test('a credit-accounting failure does NOT fail the send', async () => {
    provider.sendForSignature.mockResolvedValue({
      providerId: 'ZS-9002', status: 'sent', providerStatus: 'inprogress', testing: false, raw: {},
    });
    recordCreditSpend.mockResolvedValue({ ok: false, reason: 'error', error: 'app_settings unreachable' });

    const out = await svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(1) });

    expect(out.row.status).toBe('sent');
    expect(esignService.appendEvent).toHaveBeenCalledWith(
      expect.anything(), 42, expect.objectContaining({ event: 'credit_spend_failed' })
    );
  });

  test('a credit-accounting THROW does not fail the send either', async () => {
    provider.sendForSignature.mockResolvedValue({
      providerId: 'ZS-9002', status: 'sent', providerStatus: 'inprogress', testing: false, raw: {},
    });
    recordCreditSpend.mockRejectedValue(new Error('boom'));

    const out = await svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(1) });
    expect(out.row.status).toBe('sent');
  });

  test('an unset balance is not treated as a failure worth an event', async () => {
    provider.sendForSignature.mockResolvedValue({
      providerId: 'ZS-9002', status: 'sent', providerStatus: 'inprogress', testing: false, raw: {},
    });
    recordCreditSpend.mockResolvedValue({ ok: false, reason: 'balance_unset' });
    await svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(1) });
    const events = esignService.appendEvent.mock.calls.map((c) => c[2].event);
    expect(events).not.toContain('credit_spend_failed');
  });
});

describe('sendPipeline — provider failure', () => {
  function providerErr() {
    const e = new Error('zoho_sign: POST /requests → 500: upstream');
    e.code = 'ESIGN_PROVIDER_ERROR';
    e.httpStatus = 500;
    e.providerCode = 9043;
    return e;
  }

  test('the row stays a draft and markSent is never called', async () => {
    provider.sendForSignature.mockRejectedValue(providerErr());
    await expect(svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(1) }))
      .rejects.toMatchObject({ code: 'ESIGN_PROVIDER_ERROR' });
    expect(esignService.markSent).not.toHaveBeenCalled();
    expect(esignService.applyStatus).not.toHaveBeenCalled();
  });

  test('a send_failed event records the vendor diagnosis', async () => {
    provider.sendForSignature.mockRejectedValue(providerErr());
    await expect(svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(1) })).rejects.toThrow();
    expect(esignService.appendEvent).toHaveBeenCalledWith(
      expect.anything(), 42,
      expect.objectContaining({
        event: 'send_failed',
        payload: expect.objectContaining({ code: 'ESIGN_PROVIDER_ERROR', provider_code: 9043 }),
      })
    );
  });

  test('the draft id travels on the error so the caller can retry the same row', async () => {
    provider.sendForSignature.mockRejectedValue(providerErr());
    await expect(svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(1) }))
      .rejects.toMatchObject({ draftId: 42 });
  });

  test('no credit is spent when the send failed', async () => {
    provider.sendForSignature.mockRejectedValue(providerErr());
    await expect(svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(1) })).rejects.toThrow();
    expect(recordCreditSpend).not.toHaveBeenCalled();
  });
});

describe('sendPipeline — draftId reuse', () => {
  test('reuses the existing row and does NOT mint a second one', async () => {
    esignService.getById.mockResolvedValue(makeRow({ status: 'draft' }));
    const out = await svc.sendPipeline(makeDb(), {
      draftId: 42, createdBy: 1, pdfBuffer: buildPdf(1),
    });
    expect(esignService.createRequest).not.toHaveBeenCalled();
    expect(out.row.id).toBe(42);
  });

  test('keeps the ORIGINAL tracking id (the client may already hold it)', async () => {
    esignService.getById.mockResolvedValue(makeRow({ status: 'draft' }));
    await svc.sendPipeline(makeDb(), { draftId: 42, createdBy: 1, pdfBuffer: buildPdf(1) });
    const sent = provider.sendForSignature.mock.calls[0][0].pdfBuffer;
    expect(countFooters(sent, TRACKING)).toBe(1);
  });

  test('refuses a row that is no longer a draft', async () => {
    esignService.getById.mockResolvedValue(makeRow({ status: 'sent' }));
    await expect(svc.sendPipeline(makeDb(), { draftId: 42, createdBy: 1, pdfBuffer: buildPdf(1) }))
      .rejects.toMatchObject({ code: 'ESIGN_NOT_DRAFT' });
  });

  test('404s on a draft id that does not exist', async () => {
    esignService.getById.mockResolvedValue(null);
    await expect(svc.sendPipeline(makeDb(), { draftId: 999, createdBy: 1, pdfBuffer: buildPdf(1) }))
      .rejects.toMatchObject({ code: 'ESIGN_NOT_FOUND' });
  });

  test('a corrected recipient is persisted, not just handed to the provider', async () => {
    esignService.getById.mockResolvedValue(makeRow({ status: 'draft' }));
    const db = makeDb();
    await svc.sendPipeline(db, {
      draftId: 42, createdBy: 1, pdfBuffer: buildPdf(1),
      recipients: [{ name: 'John Smith', email: 'correct@example.com', order: 1 }],
    });
    const upd = db.query.mock.calls.find((c) => /UPDATE signing_requests/i.test(c[0]));
    expect(upd).toBeTruthy();
    expect(JSON.stringify(upd[1])).toContain('correct@example.com');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resendPipeline
// ─────────────────────────────────────────────────────────────────────────────

describe('resendPipeline — bounced (same row)', () => {
  beforeEach(() => {
    esignService.getById.mockResolvedValue(makeRow({ status: 'bounced', provider_id: 'ZS-OLD' }));
  });

  test('re-sends on the SAME row with the SAME tracking id', async () => {
    const out = await svc.resendPipeline(makeDb(), 42, {
      pdfBuffer: buildPdf(1), createdBy: 1,
      recipients: [{ name: 'John Smith', email: 'fixed@example.com', order: 1 }],
    });

    expect(out.mode).toBe('same_row');
    expect(esignService.createRequest).not.toHaveBeenCalled();
    expect(esignService.markSent).toHaveBeenCalledWith(
      expect.anything(), 42, expect.objectContaining({ providerId: 'ZS-9001' })
    );
    const sent = provider.sendForSignature.mock.calls[0][0].pdfBuffer;
    expect(countFooters(sent, TRACKING)).toBe(1);
  });

  test('the corrected address is persisted', async () => {
    const db = makeDb();
    await svc.resendPipeline(db, 42, {
      pdfBuffer: buildPdf(1), createdBy: 1,
      recipients: [{ name: 'John Smith', email: 'fixed@example.com', order: 1 }],
    });
    const upd = db.query.mock.calls.find((c) => /UPDATE signing_requests/i.test(c[0]));
    expect(JSON.stringify(upd[1])).toContain('fixed@example.com');
  });

  test('a bad corrected address is refused before anything is sent', async () => {
    await expect(svc.resendPipeline(makeDb(), 42, {
      pdfBuffer: buildPdf(1), createdBy: 1,
      recipients: [{ name: 'John Smith', email: 'still-broken', order: 1 }],
    })).rejects.toMatchObject({ code: 'ESIGN_BAD_RECIPIENTS' });
    expect(provider.sendForSignature).not.toHaveBeenCalled();
  });
});

describe('resendPipeline — terminal (duplicate as new)', () => {
  test.each(['declined', 'recalled', 'expired'])('duplicates a %s request', async (status) => {
    esignService.getById
      .mockResolvedValueOnce(makeRow({ id: 42, status }))     // the terminal row
      .mockResolvedValue(makeRow({ id: 77, status: 'draft' })); // the new draft, for sendPipeline
    esignService.createRequest.mockResolvedValue(makeRow({ id: 77, status: 'draft' }));

    const out = await svc.resendPipeline(makeDb(), 42, { pdfBuffer: buildPdf(1), createdBy: 1 });

    expect(out.mode).toBe('duplicated');
    expect(out.supersededId).toBe(42);
    expect(esignService.createRequest).toHaveBeenCalledTimes(1);
  });

  test('both rows get cross-referencing events', async () => {
    esignService.getById
      .mockResolvedValueOnce(makeRow({ id: 42, status: 'declined' }))
      .mockResolvedValue(makeRow({ id: 77, status: 'draft' }));
    esignService.createRequest.mockResolvedValue(makeRow({ id: 77, status: 'draft' }));

    await svc.resendPipeline(makeDb(), 42, { pdfBuffer: buildPdf(1), createdBy: 1 });

    const byEvent = Object.fromEntries(
      esignService.appendEvent.mock.calls.map((c) => [c[2].event, { id: c[1], payload: c[2].payload }])
    );
    expect(byEvent.superseded_by.id).toBe(42);
    expect(byEvent.superseded_by.payload.new_request_id).toBe(77);
    expect(byEvent.duplicates.id).toBe(77);
    expect(byEvent.duplicates.payload.previous_request_id).toBe(42);
  });

  test('the new row carries the old row’s kind and link', async () => {
    esignService.getById
      .mockResolvedValueOnce(makeRow({ id: 42, status: 'expired' }))
      .mockResolvedValue(makeRow({ id: 77, status: 'draft' }));
    esignService.createRequest.mockResolvedValue(makeRow({ id: 77, status: 'draft' }));

    await svc.resendPipeline(makeDb(), 42, { pdfBuffer: buildPdf(1), createdBy: 1 });

    expect(esignService.createRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        linkableType: 'case', linkableId: 'AbC12dEf', kind: 'retainer_prepetition',
      })
    );
  });
});

describe('resendPipeline — refused states', () => {
  test.each(['draft', 'sent', 'viewed'])('refuses a %s request', async (status) => {
    esignService.getById.mockResolvedValue(makeRow({ status }));
    await expect(svc.resendPipeline(makeDb(), 42, { pdfBuffer: buildPdf(1), createdBy: 1 }))
      .rejects.toMatchObject({ code: 'ESIGN_RESEND_INVALID_STATE' });
    expect(provider.sendForSignature).not.toHaveBeenCalled();
  });

  test('404s on an unknown id', async () => {
    esignService.getById.mockResolvedValue(null);
    await expect(svc.resendPipeline(makeDb(), 999, { pdfBuffer: buildPdf(1), createdBy: 1 }))
      .rejects.toMatchObject({ code: 'ESIGN_NOT_FOUND' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// recall / remind
// ─────────────────────────────────────────────────────────────────────────────

describe('recallPipeline', () => {
  test('a DRAFT is recalled without touching the provider', async () => {
    esignService.getById.mockResolvedValue(makeRow({ status: 'draft', provider_id: null }));
    await svc.recallPipeline(makeDb(), 42, { reason: 'Wrong client', createdBy: 1 });

    expect(getProvider).not.toHaveBeenCalled();
    expect(esignService.applyStatus).toHaveBeenCalledWith(
      expect.anything(), 42, { status: 'recalled' }
    );
  });

  test('a SENT request is recalled at the provider first', async () => {
    esignService.getById.mockResolvedValue(makeRow({ status: 'sent', provider_id: 'ZS-9001' }));
    await svc.recallPipeline(makeDb(), 42, { reason: 'Superseded', createdBy: 1 });

    expect(provider.recall).toHaveBeenCalledWith('ZS-9001', 'Superseded');
    expect(esignService.applyStatus).toHaveBeenCalled();
  });

  test('the reason is stored locally and flagged as NOT sent to the provider', async () => {
    esignService.getById.mockResolvedValue(makeRow({ status: 'sent', provider_id: 'ZS-9001' }));
    await svc.recallPipeline(makeDb(), 42, { reason: 'Client changed their mind', createdBy: 7 });

    expect(esignService.appendEvent).toHaveBeenCalledWith(
      expect.anything(), 42,
      expect.objectContaining({
        event: 'recalled',
        payload: expect.objectContaining({
          reason: 'Client changed their mind',
          reasonSentToProvider: false,
          by: 7,
        }),
      })
    );
  });

  test.each([
    ['a blank reason', ''],
    ['no reason',      null],
    ['an over-long reason', 'x'.repeat(501)],
  ])('refuses %s', async (_label, reason) => {
    esignService.getById.mockResolvedValue(makeRow({ status: 'sent', provider_id: 'ZS-9001' }));
    await expect(svc.recallPipeline(makeDb(), 42, { reason }))
      .rejects.toMatchObject({ code: 'ESIGN_BAD_REASON' });
  });

  test.each(['signed', 'declined', 'expired', 'recalled', 'satisfied_external'])(
    'refuses to recall a %s request', async (status) => {
      esignService.getById.mockResolvedValue(makeRow({ status, provider_id: 'ZS-9001' }));
      await expect(svc.recallPipeline(makeDb(), 42, { reason: 'too late' }))
        .rejects.toMatchObject({ code: 'ESIGN_RECALL_INVALID_STATE' });
      expect(provider.recall).not.toHaveBeenCalled();
    });

  test('a provider failure propagates rather than half-recalling the row', async () => {
    esignService.getById.mockResolvedValue(makeRow({ status: 'sent', provider_id: 'ZS-9001' }));
    const e = new Error('zoho said no'); e.code = 'ESIGN_PROVIDER_ERROR';
    provider.recall.mockRejectedValue(e);

    await expect(svc.recallPipeline(makeDb(), 42, { reason: 'x' }))
      .rejects.toMatchObject({ code: 'ESIGN_PROVIDER_ERROR' });
    expect(esignService.applyStatus).not.toHaveBeenCalled();
  });
});

describe('remindPipeline', () => {
  test.each(['sent', 'viewed'])('reminds a %s request', async (status) => {
    esignService.getById.mockResolvedValue(makeRow({ status, provider_id: 'ZS-9001' }));
    const out = await svc.remindPipeline(makeDb(), 42, { createdBy: 1 });

    expect(provider.remind).toHaveBeenCalledWith('ZS-9001');
    expect(out.remindedAll).toBe(true);
  });

  test('appends a reminded event (the log hook allowlist picks it up)', async () => {
    esignService.getById.mockResolvedValue(makeRow({ status: 'sent', provider_id: 'ZS-9001' }));
    await svc.remindPipeline(makeDb(), 42, { createdBy: 3 });
    expect(esignService.appendEvent).toHaveBeenCalledWith(
      expect.anything(), 42,
      expect.objectContaining({ event: 'reminded', payload: expect.objectContaining({ remindedAll: true }) })
    );
  });

  test.each(['draft', 'bounced', 'signed', 'declined', 'expired', 'recalled', 'satisfied_external'])(
    'refuses to remind a %s request', async (status) => {
      esignService.getById.mockResolvedValue(makeRow({ status, provider_id: 'ZS-9001' }));
      await expect(svc.remindPipeline(makeDb(), 42, {}))
        .rejects.toMatchObject({ code: 'ESIGN_REMIND_INVALID_STATE' });
      expect(provider.remind).not.toHaveBeenCalled();
    });

  test('refuses when the row carries no provider id', async () => {
    esignService.getById.mockResolvedValue(makeRow({ status: 'sent', provider_id: null }));
    await expect(svc.remindPipeline(makeDb(), 42, {}))
      .rejects.toMatchObject({ code: 'ESIGN_REMIND_INVALID_STATE' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// satisfied externally
// ─────────────────────────────────────────────────────────────────────────────

describe('markSatisfiedExternal', () => {
  beforeEach(() => {
    esignService.getById.mockResolvedValue(makeRow({ status: 'sent', provider_id: 'ZS-9001' }));
    esignService.applyStatus.mockResolvedValue({
      changed: true, request: makeRow({ status: 'satisfied_external', completed_at: new Date() }),
    });
  });

  test('applies the status BEFORE anything that can fail', async () => {
    const out = await svc.markSatisfiedExternal(makeDb(), 42, { note: 'Signed in office', createdBy: 1 });
    expect(esignService.applyStatus).toHaveBeenCalledWith(
      expect.anything(), 42, { status: 'satisfied_external' }
    );
    expect(out.changed).toBe(true);
  });

  test('with no PDF, nothing is filed', async () => {
    const out = await svc.markSatisfiedExternal(makeDb(), 42, { note: 'Faxed back', createdBy: 1 });
    expect(esignFilingService.fileExternalDocument).not.toHaveBeenCalled();
    expect(out.filed).toBe(false);
  });

  test('with a PDF, it is filed and the path is returned', async () => {
    const out = await svc.markSatisfiedExternal(makeDb(), 42, { pdfBuffer: buildPdf(1), createdBy: 1 });
    expect(esignFilingService.fileExternalDocument).toHaveBeenCalledTimes(1);
    expect(out.filed).toBe(true);
    expect(out.signedPdfPath).toMatch(/\(signed - external\)\.pdf$/);
  });

  test('the filed copy is NOT footer-stamped (it is an executed instrument)', async () => {
    const src = buildPdf(1);
    await svc.markSatisfiedExternal(makeDb(), 42, { pdfBuffer: src, createdBy: 1 });
    const passed = esignFilingService.fileExternalDocument.mock.calls[0][2].buffer;
    expect(passed.equals(src)).toBe(true);
  });

  test('a live envelope is recalled best-effort', async () => {
    await svc.markSatisfiedExternal(makeDb(), 42, { createdBy: 1 });
    expect(provider.recall).toHaveBeenCalledWith('ZS-9001', expect.any(String));
  });

  test('a failed recall becomes a warning, not a failure', async () => {
    const e = new Error('zoho down'); e.code = 'ESIGN_PROVIDER_ERROR';
    provider.recall.mockRejectedValue(e);

    const out = await svc.markSatisfiedExternal(makeDb(), 42, { createdBy: 1 });

    expect(out.changed).toBe(true);
    expect(out.warnings.join(' ')).toMatch(/could not be cancelled/i);
    expect(esignService.appendEvent).toHaveBeenCalledWith(
      expect.anything(), 42, expect.objectContaining({ event: 'recall_failed' })
    );
  });

  test('a failed filing becomes a warning, not a failure', async () => {
    esignFilingService.fileExternalDocument.mockResolvedValue({
      filed: false, skipped: true, reason: 'no_case_dropbox',
      note: 'Case "AbC12dEf" has no Dropbox folder link.',
      signedPdfPath: null, warnings: [],
    });
    const out = await svc.markSatisfiedExternal(makeDb(), 42, { pdfBuffer: buildPdf(1), createdBy: 1 });

    expect(out.changed).toBe(true);
    expect(out.filed).toBe(false);
    expect(out.warnings.join(' ')).toMatch(/Dropbox folder link/);
  });

  test('the note and outcome land in the audit trail', async () => {
    await svc.markSatisfiedExternal(makeDb(), 42, { note: 'Wet signature on file', createdBy: 9 });
    expect(esignService.appendEvent).toHaveBeenCalledWith(
      expect.anything(), 42,
      expect.objectContaining({
        event: 'satisfied_external',
        payload: expect.objectContaining({ note: 'Wet signature on file', by: 9 }),
      })
    );
  });

  test.each(['draft', 'signed', 'declined', 'expired', 'recalled', 'satisfied_external'])(
    'refuses a %s request', async (status) => {
      esignService.getById.mockResolvedValue(makeRow({ status }));
      await expect(svc.markSatisfiedExternal(makeDb(), 42, {}))
        .rejects.toMatchObject({ code: 'ESIGN_SATISFY_INVALID_STATE' });
    });

  test('an oversized upload warns instead of filing', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(svc.MAX_PDF_BYTES + 1)]);
    const out = await svc.markSatisfiedExternal(makeDb(), 42, { pdfBuffer: big, createdBy: 1 });
    expect(esignFilingService.fileExternalDocument).not.toHaveBeenCalled();
    expect(out.changed).toBe(true);
    expect(out.warnings.join(' ')).toMatch(/larger than/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reads
// ─────────────────────────────────────────────────────────────────────────────

describe('listRequests', () => {
  test('shapes rows for the UI and hides the signer IP and raw payload', async () => {
    const raw = makeRow({
      status: 'sent',
      sent_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      recipients: [{ name: 'John', email: 'j@x.com', order: 1, status: 'viewed', ip: '203.0.113.9' }],
      raw_payload: { secret: true },
    });
    const rows = await svc.listRequests(makeDb({ rows: [raw] }), {});

    expect(rows).toHaveLength(1);
    expect(rows[0].recipients[0]).toEqual({ name: 'John', email: 'j@x.com', status: 'viewed' });
    expect(rows[0].raw_payload).toBeUndefined();
    expect(rows[0].days_pending).toBe(3);
  });

  test('days_pending is null before a request has been sent', async () => {
    const rows = await svc.listRequests(makeDb({ rows: [makeRow({ status: 'draft', sent_at: null })] }), {});
    expect(rows[0].days_pending).toBeNull();
  });

  test('outstanding=true routes through esignService.listOutstanding', async () => {
    esignService.listOutstanding.mockResolvedValue([makeRow({ status: 'sent', sent_at: new Date() })]);
    const rows = await svc.listRequests(makeDb(), { outstanding: true, linkableType: 'case', linkableId: 'AbC12dEf' });
    expect(esignService.listOutstanding).toHaveBeenCalledWith(
      expect.anything(), { linkableType: 'case', linkableId: 'AbC12dEf' }
    );
    expect(rows).toHaveLength(1);
  });

  test('linkable_id is bound as a STRING', async () => {
    const db = makeDb({ rows: [] });
    await svc.listRequests(db, { linkableType: 'contact', linkableId: 22 });
    const call = db.query.mock.calls.find((c) => /FROM signing_requests/i.test(c[0]));
    expect(call[1]).toContain('22');
    expect(typeof call[1][call[1].length - 1]).toBe('string');
  });

  test('rejects an unknown status filter', async () => {
    await expect(svc.listRequests(makeDb(), { status: 'pending' }))
      .rejects.toMatchObject({ code: 'ESIGN_BAD_STATUS' });
  });

  test('_daysPending floors and never goes negative', () => {
    expect(svc._daysPending(null)).toBeNull();
    expect(svc._daysPending(new Date(Date.now() + 60_000))).toBe(0);
    expect(svc._daysPending(new Date(Date.now() - 47 * 3600 * 1000))).toBe(1);
  });
});

describe('getRequestDetail', () => {
  test('returns the request plus its full event list with parsed payloads', async () => {
    esignService.getById.mockResolvedValue(makeRow({ status: 'sent', provider_id: 'ZS-9001' }));
    const db = makeDb({
      events: [
        { id: 1, event: 'created', recipient_email: null, payload: '{"kind":"retainer_prepetition"}', occurred_at: 'a', created_at: 'a' },
        { id: 2, event: 'sent',    recipient_email: null, payload: { provider_id: 'ZS-9001' },        occurred_at: 'b', created_at: 'b' },
      ],
    });

    const out = await svc.getRequestDetail(db, 42);

    expect(out.request.provider_id).toBe('ZS-9001');
    expect(out.events).toHaveLength(2);
    expect(out.events[0].payload).toEqual({ kind: 'retainer_prepetition' });
    expect(out.events[1].payload).toEqual({ provider_id: 'ZS-9001' });
  });

  test('404s on an unknown id', async () => {
    esignService.getById.mockResolvedValue(null);
    await expect(svc.getRequestDetail(makeDb(), 999))
      .rejects.toMatchObject({ code: 'ESIGN_NOT_FOUND' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

describe('routes/api.esign.actions.js', () => {
  const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
  const actions = require('../routes/api.esign.actions');

  /** [{ path, methods, handles }] for every route on a router. */
  function routesOf(router) {
    return router.stack
      .filter((l) => l.route)
      .map((l) => ({
        path: l.route.path,
        methods: Object.keys(l.route.methods),
        handles: l.route.stack.map((h) => h.handle),
      }));
  }

  test('every action route is behind jwtOrApiKey', () => {
    const routes = routesOf(actions);
    expect(routes.length).toBeGreaterThanOrEqual(7);
    for (const r of routes) {
      expect(r.handles).toContain(jwtOrApiKey);
    }
  });

  test('the expected endpoints exist', () => {
    const sigs = routesOf(actions).map((r) => `${r.methods[0].toUpperCase()} ${r.path}`).sort();
    expect(sigs).toEqual([
      'GET /api/esign',
      'GET /api/esign/:id(\\d+)',   // digits-only since 2B — see the route's comment
      'POST /api/esign/:id/recall',
      'POST /api/esign/:id/remind',
      'POST /api/esign/:id/resend',
      'POST /api/esign/:id/satisfied-external',
      'POST /api/esign/send',
    ]);
  });

  test('POST /api/esign/send is registered before GET /api/esign/:id cannot shadow it', () => {
    // Different verbs, so no shadowing is possible — asserted so a future
    // refactor to a shared verb has to think about it.
    const send = routesOf(actions).find((r) => r.path === '/api/esign/send');
    expect(send.methods).toEqual(['post']);
  });

  test('the PUBLIC webhook route is untouched — still no auth middleware', () => {
    const webhook = require('../routes/api.esign');
    const routes = routesOf(webhook);
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/webhooks/esign/zoho');
    expect(routes[0].handles).not.toContain(jwtOrApiKey);
  });

  test.each([
    ['ESIGN_BAD_NAME',              400],
    ['ESIGN_BAD_RECIPIENTS',        400],
    ['ESIGN_BAD_KIND',              400],
    ['ESIGN_BAD_LINKABLE',          400],
    ['ESIGN_BAD_PLACEMENTS',        400],
    ['ESIGN_INVALID_INPUT',         400],
    ['ESIGN_BAD_PDF',               400],
    ['ESIGN_PDF_TOO_LARGE',         413],
    ['ESIGN_NOT_FOUND',             404],
    ['ESIGN_NOT_DRAFT',             409],
    ['ESIGN_RESEND_INVALID_STATE',  409],
    ['ESIGN_REMIND_INVALID_STATE',  409],
    ['ESIGN_RECALL_INVALID_STATE',  409],
    ['ESIGN_SATISFY_INVALID_STATE', 409],
    ['INVALID_ESIGN_TRANSITION',    409],
    ['ESIGN_PROVIDER_ERROR',        502],
    ['ESIGN_AUTH_ERROR',            502],
    ['ESIGN_NOT_CONFIGURED',        503],
    ['SOMETHING_UNEXPECTED',        500],
  ])('%s maps to HTTP %i', (code, status) => {
    expect(actions._errorToStatus(code)).toBe(status);
  });

  test('created_by falls back to 0 for an api_key caller (no user id)', () => {
    expect(actions._resolveCreatedBy({ auth: { type: 'api_key', key_label: 'internal' } })).toBe(0);
    expect(actions._resolveCreatedBy({ auth: { type: 'jwt', userId: 22 } })).toBe(22);
    expect(actions._resolveCreatedBy({ auth: { type: 'jwt', userId: '22' } })).toBe(22);
    expect(actions._resolveCreatedBy({})).toBe(0);
  });
});