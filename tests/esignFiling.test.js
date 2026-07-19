/**
 * Tests for services/esignFilingService.js — signed PDF → Dropbox (Phase 1C).
 *
 * NO network, NO real DB. dropboxService and esignService are jest-mocked;
 * what is under test is the DECISION LOGIC around them: where a document
 * belongs, what it is called, which failures are fatal, and — the one that
 * cost a design amendment — that the path we PERSIST is the path Dropbox
 * returned, not the path we asked for.
 *
 *   npx jest tests/esignFiling.test.js
 */

jest.mock('../services/dropboxService', () => ({
  _resolveCredential: jest.fn(async () => 8),
  resolveLocation:    jest.fn(async () => '/Clients/Smith, John'),
  createFolder:       jest.fn(async (db, { path }) => ({ path, existed: false })),
  uploadFile:         jest.fn(),
  joinPath: (...parts) => parts
    .filter((p) => p != null && p !== '')
    .map((p, i) => (i === 0 ? String(p).replace(/\/+$/, '') : String(p).replace(/^\/+|\/+$/g, '')))
    .join('/'),
}));

jest.mock('../services/esignService', () => ({
  setPdfPaths: jest.fn(async () => ({ changed: true })),
  setLogHook:  jest.fn(),
}));

const dropboxService = require('../services/dropboxService');
const esignService = require('../services/esignService');
const filing = require('../services/esignFilingService');

const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x41)]);
const ZIP_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0x42)]);

/** A signed request row, mid-Michigan-summer so the TZ conversion is visible. */
function makeRequest(over = {}) {
  return {
    id: 42,
    provider: 'zoho_sign',
    provider_id: 'ZS-9001',
    linkable_type: 'case',
    linkable_id: 'AbC12dEf',
    kind: 'retainer',
    document_name: 'Retainer Agreement',
    tracking_id: 'YC-ESIGN-0042',
    status: 'signed',
    signed_pdf_path: null,
    cert_pdf_path: null,
    completed_at: new Date('2026-07-20T01:30:00Z'),   // 21:30 on the 19th, Detroit
    recipients: [{ name: 'John Smith', email: 'john@example.com', order: 1 }],
    ...over,
  };
}

function makeDb({ caseDropbox = 'https://www.dropbox.com/scl/fo/abc/Smith?dl=0' } = {}) {
  return {
    query: jest.fn(async (sql) => {
      if (/FROM cases/i.test(sql)) {
        return [caseDropbox === null ? [] : [{ case_dropbox: caseDropbox }]];
      }
      return [[]];
    }),
  };
}

function makeProvider(over = {}) {
  return {
    downloadSignedPdf: jest.fn(async () => PDF_BYTES),
    downloadCompletionCertificate: jest.fn(async () => PDF_BYTES),
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  dropboxService.uploadFile.mockImplementation(async (db, { path }) => ({
    path_display: path, path_lower: String(path).toLowerCase(), name: path.split('/').pop(),
  }));
  dropboxService.resolveLocation.mockResolvedValue('/Clients/Smith, John');
  dropboxService.createFolder.mockImplementation(async (db, { path }) => ({ path, existed: false }));
  dropboxService._resolveCredential.mockResolvedValue(8);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

// ─────────────────────────────────────────────────────────────
describe('sniffBuffer', () => {
  test('recognises PDF, ZIP, and neither', () => {
    expect(filing.sniffBuffer(PDF_BYTES)).toBe('pdf');
    expect(filing.sniffBuffer(ZIP_BYTES)).toBe('zip');
    expect(filing.sniffBuffer(Buffer.from('<html>hello'))).toBe('unknown');
  });

  test('a truncated or absent body is unknown, not a crash', () => {
    expect(filing.sniffBuffer(Buffer.from([0x25]))).toBe('unknown');
    expect(filing.sniffBuffer(null)).toBe('unknown');
    expect(filing.sniffBuffer('not a buffer')).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────
describe('buildFilename', () => {
  test('dates in FIRM time, not UTC — 21:30 Detroit files under that day', () => {
    // 2026-07-20T01:30Z is still the 19th in Michigan. Filing it under the
    // 20th would send staff looking on the wrong day.
    const name = filing.buildFilename({
      completedAt: new Date('2026-07-20T01:30:00Z'),
      documentName: 'Retainer Agreement', suffix: 'signed', ext: 'pdf',
    });
    expect(name).toBe('2026-07-19 Retainer Agreement (signed).pdf');
  });

  test('strips characters Dropbox rejects in a name', () => {
    const name = filing.buildFilename({
      completedAt: new Date('2026-03-02T12:00:00Z'),
      documentName: 'Ch 7/13 "Retainer" *draft*', suffix: 'signed', ext: 'pdf',
    });
    expect(name).not.toMatch(/[/\\:*?"<>|]/);
    expect(name).toBe('2026-03-02 Ch 7-13 -Retainer- -draft- (signed).pdf');
  });

  test('an empty or missing name still yields a usable filename', () => {
    const name = filing.buildFilename({
      completedAt: new Date('2026-03-02T12:00:00Z'),
      documentName: '   ', suffix: 'certificate', ext: 'pdf',
    });
    expect(name).toBe('2026-03-02 document (certificate).pdf');
  });

  test('honours the name budget so the stored path can fit varchar(512)', () => {
    const name = filing.buildFilename({
      completedAt: new Date('2026-03-02T12:00:00Z'),
      documentName: 'X'.repeat(400), suffix: 'signed', ext: 'pdf', nameBudget: 20,
    });
    expect(name.length).toBeLessThanOrEqual(20 + '2026-03-02  (signed).pdf'.length);
  });
});

// ─────────────────────────────────────────────────────────────
describe('resolveTarget', () => {
  test('a contact-linked request is skipped, not failed', async () => {
    const out = await filing.resolveTarget(makeDb(), makeRequest({ linkable_type: 'contact', linkable_id: '551' }));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not_a_case');
    expect(out.note).toMatch(/contact/);
  });

  test('an empty case_dropbox is named exactly — 69 live cases have none', async () => {
    const out = await filing.resolveTarget(makeDb({ caseDropbox: '' }), makeRequest());
    expect(out.reason).toBe('no_case_dropbox');
    expect(out.note).toMatch(/case_dropbox/);
  });

  test('a missing case row is distinguished from an empty folder link', async () => {
    const out = await filing.resolveTarget(makeDb({ caseDropbox: null }), makeRequest());
    expect(out.reason).toBe('case_not_found');
  });
});

// ─────────────────────────────────────────────────────────────
describe('fileSignedDocuments — happy path', () => {
  test('files both documents into Signed Documents/ and records the paths', async () => {
    const db = makeDb();
    const provider = makeProvider();
    const out = await filing.fileSignedDocuments(db, makeRequest(), { provider });

    expect(out.filed).toBe(true);
    expect(out.warnings).toEqual([]);
    expect(dropboxService.createFolder).toHaveBeenCalledWith(
      db, expect.objectContaining({ path: '/Clients/Smith, John/Signed Documents' })
    );
    expect(out.signedPdfPath)
      .toBe('/Clients/Smith, John/Signed Documents/2026-07-19 Retainer Agreement (signed).pdf');
    expect(out.certPdfPath)
      .toBe('/Clients/Smith, John/Signed Documents/2026-07-19 Retainer Agreement (certificate).pdf');

    expect(esignService.setPdfPaths).toHaveBeenCalledWith(db, 42, {
      signedPdfPath: out.signedPdfPath, certPdfPath: out.certPdfPath,
    });
  });

  test('uploads with autorename so collisions resolve atomically', async () => {
    await filing.fileSignedDocuments(makeDb(), makeRequest(), { provider: makeProvider() });
    for (const call of dropboxService.uploadFile.mock.calls) {
      expect(call[1]).toMatchObject({ autorename: true, mode: 'add' });
    }
  });

  // THE AMENDMENT. autorename means Dropbox may hand back a different name;
  // persisting the requested string would leave the DB pointing at a file
  // that does not exist while the real one sits beside it unreferenced.
  test('persists the path DROPBOX RETURNED, never the one requested', async () => {
    dropboxService.uploadFile.mockImplementation(async (db, { path }) => ({
      path_display: path.replace(/\.pdf$/, ' (1).pdf'),
      path_lower: path.replace(/\.pdf$/, ' (1).pdf').toLowerCase(),
    }));

    const out = await filing.fileSignedDocuments(makeDb(), makeRequest(), { provider: makeProvider() });

    expect(out.signedPdfPath).toMatch(/\(signed\) \(1\)\.pdf$/);
    expect(esignService.setPdfPaths).toHaveBeenCalledWith(
      expect.anything(), 42,
      expect.objectContaining({ signedPdfPath: expect.stringMatching(/\(1\)\.pdf$/) })
    );
  });

  test('falls back to path_lower when path_display is absent', async () => {
    dropboxService.uploadFile.mockImplementation(async (db, { path }) => ({ path_lower: path.toLowerCase() }));
    const out = await filing.fileSignedDocuments(makeDb(), makeRequest(), { provider: makeProvider() });
    expect(out.signedPdfPath).toBe(out.signedPdfPath.toLowerCase());
    expect(out.filed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
describe('fileSignedDocuments — idempotency and skips', () => {
  test('a row that already carries a path is not re-downloaded', async () => {
    const provider = makeProvider();
    const out = await filing.fileSignedDocuments(
      makeDb(), makeRequest({ signed_pdf_path: '/Clients/Smith, John/Signed Documents/x.pdf' }), { provider }
    );

    expect(out.skipped).toBe(true);
    expect(out.reason).toBe('already_filed');
    expect(provider.downloadSignedPdf).not.toHaveBeenCalled();
    expect(dropboxService.uploadFile).not.toHaveBeenCalled();
  });

  test('a case with no Dropbox folder skips cleanly and explains itself', async () => {
    const provider = makeProvider();
    const out = await filing.fileSignedDocuments(makeDb({ caseDropbox: '' }), makeRequest(), { provider });

    expect(out.filed).toBe(false);
    expect(out.skipped).toBe(true);
    expect(out.reason).toBe('no_case_dropbox');
    expect(out.note).toMatch(/AbC12dEf/);
    expect(provider.downloadSignedPdf).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
describe('fileSignedDocuments — failure posture', () => {
  test('a Dropbox outage returns a verdict, it does not throw', async () => {
    dropboxService.resolveLocation.mockRejectedValue(new Error('dropbox: 503'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const out = await filing.fileSignedDocuments(makeDb(), makeRequest(), { provider: makeProvider() });
    expect(out.filed).toBe(false);
    expect(out.reason).toBe('dropbox_unreachable');
    expect(out.note).toMatch(/503/);
  });

  test('a failed signed download stops before uploading anything', async () => {
    const provider = makeProvider({
      downloadSignedPdf: jest.fn(async () => { throw new Error('Zoho 404'); }),
    });
    const out = await filing.fileSignedDocuments(makeDb(), makeRequest(), { provider });

    expect(out.reason).toBe('signed_download_failed');
    expect(dropboxService.uploadFile).not.toHaveBeenCalled();
    expect(esignService.setPdfPaths).not.toHaveBeenCalled();
  });

  // The signed document is the operative instrument. Losing the certificate
  // must never cost us the thing the client actually signed.
  test('a certificate failure is a warning, not a failed filing', async () => {
    const provider = makeProvider({
      downloadCompletionCertificate: jest.fn(async () => { throw new Error('cert not ready'); }),
    });
    const out = await filing.fileSignedDocuments(makeDb(), makeRequest(), { provider });

    expect(out.filed).toBe(true);
    expect(out.signedPdfPath).toBeTruthy();
    expect(out.certPdfPath).toBeNull();
    expect(out.warnings.join(' ')).toMatch(/certificate could not be saved/i);
    expect(esignService.setPdfPaths).toHaveBeenCalledWith(
      expect.anything(), 42, { signedPdfPath: out.signedPdfPath }
    );
  });

  test('a ZIP is filed as .zip with a warning, never silently mislabelled', async () => {
    const provider = makeProvider({ downloadSignedPdf: jest.fn(async () => ZIP_BYTES) });
    const out = await filing.fileSignedDocuments(makeDb(), makeRequest(), { provider });

    expect(out.filed).toBe(true);
    expect(out.signedPdfPath).toMatch(/\(signed\)\.zip$/);
    expect(out.warnings.join(' ')).toMatch(/ZIP archive/);
  });

  test('bytes that are neither PDF nor ZIP file anyway, with a warning', async () => {
    const provider = makeProvider({ downloadSignedPdf: jest.fn(async () => Buffer.from('<html>error</html>')) });
    const out = await filing.fileSignedDocuments(makeDb(), makeRequest(), { provider });

    expect(out.filed).toBe(true);
    expect(out.warnings.join(' ')).toMatch(/did not begin with a PDF or ZIP signature/);
  });

  // The files ARE in Dropbox at this point. That is a success with a
  // bookkeeping problem, not a failure.
  test('a setPdfPaths failure downgrades to a warning, not a lost filing', async () => {
    esignService.setPdfPaths.mockRejectedValueOnce(new Error('signed_pdf_path exceeds 512'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const out = await filing.fileSignedDocuments(makeDb(), makeRequest(), { provider: makeProvider() });
    expect(out.filed).toBe(true);
    expect(out.warnings.join(' ')).toMatch(/could not be recorded/);
    expect(out.warnings.join(' ')).toMatch(/Signed Documents/);
  });

  test('a case folder path long enough to overflow varchar(512) refuses early', async () => {
    dropboxService.resolveLocation.mockResolvedValue(`/${'x'.repeat(500)}`);
    const provider = makeProvider();
    const out = await filing.fileSignedDocuments(makeDb(), makeRequest(), { provider });

    expect(out.filed).toBe(false);
    expect(out.reason).toBe('path_too_long');
    expect(provider.downloadSignedPdf).not.toHaveBeenCalled();
  });

  test('a missing provider is reported, not thrown', async () => {
    const out = await filing.fileSignedDocuments(makeDb(), makeRequest(), {});
    expect(out.skipped).toBe(true);
    expect(out.reason).toBe('no_provider');
  });
});
