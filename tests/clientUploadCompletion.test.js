// tests/clientUploadCompletion.test.js
/**
 * services/clientUploadCompletionService — the one post-upload phase behind
 * the docReq page and the portal (2026-11-19). The notice renderer is REAL
 * (its output is what staff read); the world around it is scripted:
 * uploadTargetService (where), documentIngestService (what landed),
 * documentSourceService (the folder link), docsReviewerService (who),
 * emailService, docsIntakeLog, emailAttachmentFilingService.docsChecklist.
 *
 * Run: npx jest tests/clientUploadCompletion.test.js
 */

'use strict';

jest.mock('../services/uploadTargetService', () => ({
  inspectUploadDestination: jest.fn(),
  raiseUnsortedUploadTask: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/documentIngestService', () => ({ registerLandedInFolder: jest.fn() }));
jest.mock('../services/documentSourceService', () => {
  const provider = { ensureSharedLink: jest.fn(async (db, p) => `https://dbx/sh${encodeURIComponent(p)}`) };
  return { configured: () => 'dropbox', get: () => provider, _provider: provider };
});
jest.mock('../services/docsReviewerService', () => ({ resolveReviewer: jest.fn(), REVIEWER_SETTING: 'email_attachments_reviewer' }));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/docsIntakeLog', () => ({ logDocsIntake: jest.fn(async () => ({ log_id: 9 })) }));
jest.mock('../services/emailAttachmentFilingService', () => ({
  appUrl: () => 'https://app.test',
  docsChecklist: jest.fn(async () => null),
}));
jest.mock('../lib/firmConfig', () => ({ cfg: (k) => (k === 'email_automations' ? 'automations@firm.test' : null) }));

const uploadTarget = require('../services/uploadTargetService');
const ingest = require('../services/documentIngestService');
const sources = require('../services/documentSourceService');
const reviewerSvc = require('../services/docsReviewerService');
const emailService = require('../services/emailService');
const docsLog = require('../services/docsIntakeLog');
const filing = require('../services/emailAttachmentFilingService');
const svc = require('../services/clientUploadCompletionService');

const CASE = { case_id: 'PVXC1RMM', case_display: '26-44274' };
const FOLDER = '/cases/sims/Client Uploads';
const DEST_CASE = { case_id: 'PVXC1RMM', placement: 'case', sharedLink: 'https://dbx/case-folder' };
const DEST_UNSORTED = { case_id: 'PVXC1RMM', placement: 'unsorted', path: '/Unsorted/PVXC1RMM - Sims, Tristan', link: 'https://dbx/unsorted' };
const SB = { user_id: 5, name: 'Shoshana Beitner', email: 'sb@firm.test' };

let caseRow;
let primary;
const db = {
  query: jest.fn(async (sql) => {
    if (/FROM cases c WHERE/.test(sql)) return [caseRow ? [caseRow] : []];
    if (/case_relate_type = 'Primary'/.test(sql)) return [primary ? [primary] : []];
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  }),
};

const doc = (name, over = {}) => ({ id: 900 + name.length, name, path: `${FOLDER}/${name}`, path_lower: `${FOLDER}/${name}`.toLowerCase(), size: 1234, ...over });
const sent = () => emailService.sendEmail.mock.calls[0][1];
const logged = () => docsLog.logDocsIntake.mock.calls[0][1];

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  caseRow = { ...CASE };
  primary = { contact_name: 'Tristan P Sims' };
  uploadTarget.inspectUploadDestination.mockResolvedValue(DEST_CASE);
  ingest.registerLandedInFolder.mockResolvedValue({ registered: 2, scanned: 2, folder_path: FOLDER, documents: [doc('NFCU.pdf'), doc('Lease.pdf', { size: 2048 })] });
  reviewerSvc.resolveReviewer.mockResolvedValue(SB);
  filing.docsChecklist.mockResolvedValue(null);
});
afterEach(() => { console.log.mockRestore(); console.warn.mockRestore(); console.error.mockRestore(); });

const run = (over = {}) => svc.completeClientUpload(db, {
  source: 'docreq', caseId: 'PVXC1RMM', files: ['NFCU.pdf', 'Lease.pdf'], fileCount: 2, comment: 'Taxes & statements', ...over,
});

describe('the notice', () => {
  test('goes to the docs reviewer from the automations sender, in the upload shape: client, files linked to themselves, comment', async () => {
    const r = await run();
    expect(r.sent).toBe(true);
    expect(reviewerSvc.resolveReviewer).toHaveBeenCalledWith(db);
    expect(sent()).toMatchObject({ from: 'automations@firm.test', to: 'sb@firm.test' });
    expect(sent().subject).toBe('Client upload — Tristan P Sims (2 files) — filed to case PVXC1RMM');
    const html = sent().html;
    expect(html).toContain('Documents Needed page');
    expect(html).toContain('Uploaded through the Documents Needed page.');
    expect(html).toContain('Tristan P Sims');
    expect(html).toContain('Taxes &amp; statements');
    // each reported file links to itself: the Client Uploads folder's link opened on it
    const folderLink = `https://dbx/sh${encodeURIComponent(FOLDER)}`;
    expect(html).toContain(`href="${folderLink}?preview=NFCU.pdf"`);
    expect(html).toContain(`href="${folderLink}?preview=Lease.pdf"`);
    expect(html).toContain('>2 KB<');   // sizes from the registered rows
    expect(html).toContain('Open the Dropbox folder');
    expect(html).toContain('Open case PVXC1RMM in YisraCase');
    // upload nouns, not email nouns
    expect(html).toContain('>Client<');
    expect(html).toContain('Client comment');
    expect(html).not.toContain('Subject');
    expect(html).not.toContain('Comms');
    expect(sent().text).toContain('Client: Tristan P Sims');
    expect(sent().text).toContain('Files (2):');
  });

  test('portal: its own title and reason; the uploader passed in is the client; item names ride each file', async () => {
    await run({ source: 'portal', contactId: 42, clientName: 'Jane Doe', files: [{ name: 'NFCU.pdf', item_id: 7, item_name: 'Bank statements' }, { name: 'Lease.pdf' }] });
    expect(db.query).toHaveBeenCalledTimes(1);   // the case only — no Primary lookup
    expect(sent().subject).toBe('Client upload — Jane Doe (2 files) — filed to case PVXC1RMM');
    expect(sent().html).toContain('Client portal');
    expect(sent().html).toContain('Uploaded through the client portal.');
    expect(sent().html).toContain('Bank statements');
    expect(ingest.registerLandedInFolder.mock.calls[0][1]).toMatchObject({
      sharedLink: 'https://dbx/case-folder', subfolder: 'Client Uploads', eventSource: 'portal_upload',
      links: [{ type: 'case', id: 'PVXC1RMM' }, { type: 'contact', id: 42 }],
    });
  });

  test('the Docs Needed block comes from the shared checklist reader, with its open items', async () => {
    filing.docsChecklist.mockResolvedValue({ link: 'https://app.test/case/PVXC1RMM~checklists', lists: 1, items: 5, open_count: 3, open: ['Photo ID', 'Pay stubs', 'Tax return'] });
    await run();
    expect(filing.docsChecklist).toHaveBeenCalledWith(db, 'PVXC1RMM', 'https://app.test', expect.any(Array));
    expect(sent().html).toContain('Docs Needed list — 3 of 5 still needed:');
    expect(sent().html).toContain('Pay stubs');
    expect(sent().html).toContain('check them off the Docs Needed list');
    expect(sent().html).toContain('Open the Docs Needed list');
  });

  test('hostile client input is escaped everywhere it is printed', async () => {
    await run({ files: ['<img src=x onerror=1>.pdf'], fileCount: 1, comment: '"><script>alert(1)</script>' });
    const html = sent().html;
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=1&gt;.pdf');
    expect(html).toContain('&lt;script&gt;');
  });

  test('a name the folder does not hold (autorenamed on disk) is listed without a link; the true count shows the capped tail', async () => {
    ingest.registerLandedInFolder.mockResolvedValue({ registered: 1, scanned: 1, folder_path: FOLDER, documents: [doc('statement (1).pdf')] });
    await run({ files: ['statement.pdf'], fileCount: 52 });
    const html = sent().html;
    expect(html).toContain('statement.pdf');
    expect(html).not.toContain('preview=statement');
    expect(html).toContain('… and 51 more files not listed');
    expect(sent().subject).toBe('Client upload — Tristan P Sims (1 file) — filed to case PVXC1RMM');
  });

  test('unsorted placement: the amber wording, the bin folder link, a staff task', async () => {
    uploadTarget.inspectUploadDestination.mockResolvedValue(DEST_UNSORTED);
    ingest.registerLandedInFolder.mockResolvedValue({ registered: 2, scanned: 2, folder_path: DEST_UNSORTED.path, documents: [doc('NFCU.pdf'), doc('Lease.pdf')] });
    await run();
    expect(ingest.registerLandedInFolder.mock.calls[0][1]).toMatchObject({ folderPath: DEST_UNSORTED.path });
    expect(sent().subject).toBe('Client upload — Tristan P Sims (2 files) — UNSORTED, needs a case');
    expect(sent().html).toContain('Filed to Unsorted — needs a case');
    expect(sent().html).toContain(DEST_UNSORTED.path);
    expect(uploadTarget.raiseUnsortedUploadTask).toHaveBeenCalledWith(db, { caseId: 'PVXC1RMM', clientName: 'Tristan P Sims', fileCount: 2, path: DEST_UNSORTED.path, link: DEST_UNSORTED.link });
    expect(logged()).toMatchObject({ placement: 'unsorted', folderPath: DEST_UNSORTED.path });
  });
});

describe('the reviewer', () => {
  test('unset → no email, a warning, the log row still written', async () => {
    reviewerSvc.resolveReviewer.mockResolvedValue(null);
    const r = await run();
    expect(r.sent).toBe(false);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('email_attachments_reviewer'));
    expect(docsLog.logDocsIntake).toHaveBeenCalledTimes(1);
  });

  test('a failing settings read or a failing send never blocks the log row or the task', async () => {
    reviewerSvc.resolveReviewer.mockRejectedValueOnce(new Error('db down'));
    await run();
    expect(docsLog.logDocsIntake).toHaveBeenCalledTimes(1);
    emailService.sendEmail.mockRejectedValueOnce(new Error('smtp down'));
    uploadTarget.inspectUploadDestination.mockResolvedValue(DEST_UNSORTED);
    const r = await run();
    expect(r.sent).toBe(false);
    expect(r.warnings).toEqual(expect.arrayContaining([expect.stringContaining('smtp down')]));
    expect(docsLog.logDocsIntake).toHaveBeenCalledTimes(2);
    expect(uploadTarget.raiseUnsortedUploadTask).toHaveBeenCalledTimes(1);
  });
});

describe('the log row', () => {
  test('docreq: source, the files with what the registry knows, the true count, the comment, placement', async () => {
    await run({ fileCount: 7 });
    expect(logged()).toEqual({
      action: 'client_upload', source: 'docreq', caseId: 'PVXC1RMM', contactId: undefined,
      files: [
        { name: 'NFCU.pdf', path: `${FOLDER}/NFCU.pdf`, document_id: 908, item_id: null, item_name: null },
        { name: 'Lease.pdf', path: `${FOLDER}/Lease.pdf`, document_id: 909, item_id: null, item_name: null },
      ],
      fileCount: 7, comment: 'Taxes & statements', placement: 'case', folderPath: null,
    });
  });

  test('portal: the contact and the item association travel into the row', async () => {
    await run({ source: 'portal', contactId: 42, clientName: 'Jane', files: [{ name: 'NFCU.pdf', item_id: 7, item_name: 'Bank statements' }] , fileCount: 1 });
    expect(logged()).toMatchObject({ source: 'portal', contactId: 42, files: [{ name: 'NFCU.pdf', document_id: 908, item_id: 7, item_name: 'Bank statements' }] });
  });
});

describe('degraded worlds', () => {
  test('destination inspection fails → no registration, the notice still goes (no folder link), the row says placement unknown', async () => {
    uploadTarget.inspectUploadDestination.mockRejectedValue(new Error('dropbox down'));
    const r = await run();
    expect(ingest.registerLandedInFolder).not.toHaveBeenCalled();
    expect(r.sent).toBe(true);
    expect(sent().html).not.toContain('Open the Dropbox folder');
    expect(sent().html).toContain('Open case PVXC1RMM in YisraCase');
    expect(logged()).toMatchObject({ placement: null, folderPath: null });
    expect(r.warnings).toEqual(expect.arrayContaining([expect.stringContaining('dropbox down')]));
  });

  test('the folder link cannot be made → files unlinked, the case folder link shown instead', async () => {
    sources._provider.ensureSharedLink.mockRejectedValueOnce(new Error('no link'));
    await run();
    expect(sent().html).not.toContain('preview=');
    expect(sent().html).toContain('href="https://dbx/case-folder"');
  });

  test('the case vanished → nothing happens', async () => {
    caseRow = null;
    const r = await run();
    expect(r).toMatchObject({ dest: null, sent: false, log: null });
    expect(uploadTarget.inspectUploadDestination).not.toHaveBeenCalled();
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(docsLog.logDocsIntake).not.toHaveBeenCalled();
  });

  test('no Primary contact → "Unknown client"', async () => {
    primary = null;
    await run();
    expect(sent().subject).toMatch(/^Client upload — Unknown client /);
  });

  test('an unknown source throws (a programming error, not a client one)', async () => {
    await expect(svc.completeClientUpload(db, { source: 'fax', caseId: 'X', files: ['a'] })).rejects.toThrow(/unknown source/);
  });
});
