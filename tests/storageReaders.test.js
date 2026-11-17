// tests/storageReaders.test.js
//
/**
 * storage-seam D1g — the READERS are on the seam too. parse_pdf and query_ai
 * download a file by its Dropbox path or shared link; registerLandedInFolder
 * lists the folder a browser just uploaded into; Casey inspects folders. None
 * of them requires dropboxService any more; the only direct callers left are
 * the provider itself, the Dropbox-native admin API and the sync engine (D4).
 *
 * parse_pdf is driven for real over the recording fake (the PDF parser mocked:
 * the bytes are the point); the recorded downloadFile call is the old one:
 * path OR sharedLink, credentialId only when given.
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');

jest.mock('../services/dropboxService', () => require('./helpers/recordingDropbox').factory());
jest.mock('../services/pdfService', () => ({
  ...jest.requireActual('../services/pdfService'),
  parsePdf: jest.fn(async (buf) => ({ text: `parsed ${buf.length} bytes`, pages: 1 })),
  fetchPdfFromUrl: jest.fn(async () => Buffer.from('%PDF from url')),
}));

const fs = require('fs');
const path = require('path');
const fake = require('../services/dropboxService').__fake;
const pdfFns = require('../lib/internal_functions/pdf');

const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('no reader requires dropboxService any more; each reaches storage through documentSourceService', () => {
  for (const f of ['services/documentIngestService.js', 'services/assistantService.js', 'lib/internal_functions/pdf.js', 'lib/internal_functions/ai.js']) {
    const src = SRC(f);
    expect({ f, requires: /require\(['"](\.\.\/)*(\.\/)?(services\/)?dropboxService['"]\)/.test(src) }).toEqual({ f, requires: false });
    expect(src).toMatch(/documentSourceService/);
  }
  expect(SRC('lib/internal_functions/pdf.js')).toMatch(/storage\.download\(db, dropbox_path \? dropbox_path : \{ humanLink: dropbox_link \}/);
  expect(SRC('lib/internal_functions/ai.js')).toMatch(/storage\.download\(db, file_dropbox_path \? file_dropbox_path : \{ humanLink: file_dropbox_link \}/);
  expect(SRC('services/assistantService.js')).toMatch(/caseFolderStorage\(\)/);
  expect(SRC('services/assistantService.js')).not.toMatch(/caseFolderDropbox/);
});

describe('parse_pdf downloads through the seam — the recorded provider call is the old one', () => {
  const db = { query: jest.fn(async () => [[]]) };
  beforeEach(() => {
    fake.reset();
    fake.seed({ folders: ['/  Active/ Case A/court docs'], files: [{ path: '/  Active/ Case A/court docs/Order.pdf', bytes: '%PDF-1.7 order' }], links: ['/  Active/ Case A'] });
  });
  test('by path, with and without a credential override', async () => {
    const r = await pdfFns.parse_pdf({ dropbox_path: '/  Active/ Case A/court docs/Order.pdf' }, db);
    expect(r.output.text).toBe('parsed 14 bytes');
    expect(fake.calls.filter((c) => c.fn === 'downloadFile')).toEqual([{ fn: 'downloadFile', args: [{ path: '/  Active/ Case A/court docs/Order.pdf' }] }]);
    fake.calls.length = 0;
    await pdfFns.parse_pdf({ dropbox_path: '/  Active/ Case A/court docs/Order.pdf', credential_id: 21 }, db);
    expect(fake.calls.filter((c) => c.fn === 'downloadFile')).toEqual([{ fn: 'downloadFile', args: [{ path: '/  Active/ Case A/court docs/Order.pdf', credentialId: 21 }] }]);
  });
  test('by shared link — the provider resolves it (a link to a FOLDER is the provider\'s own refusal)', async () => {
    const fileLink = fake.linkFor('/  Active/ Case A/court docs/Order.pdf');
    await pdfFns.parse_pdf({ dropbox_link: fileLink }, db);
    expect(fake.calls.filter((c) => c.fn === 'downloadFile')).toEqual([{ fn: 'downloadFile', args: [{ sharedLink: fileLink }] }]);
    const folderLink = fake.linkFor('/  Active/ Case A');
    await expect(pdfFns.parse_pdf({ dropbox_link: folderLink }, db)).rejects.toThrow();
  });
  test('a URL source never touches storage', async () => {
    await pdfFns.parse_pdf({ url: 'https://court.example/1.pdf' }, db);
    expect(fake.calls.filter((c) => c.fn === 'downloadFile')).toEqual([]);
  });
});
