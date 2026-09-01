// tests/filePlacementService.test.js
//
/**
 * G2 — services/filePlacementService.js, the SHARED placement ladder.
 *
 * This is the code X5 shipped inside formPdfService, lifted out so the
 * generate-a-document path files by the same rules. tests/formpdf.x5.test.js
 * and tests/formpdf.x51.test.js still exercise it end-to-end THROUGH the form
 * path and both pass unmodified — which is the real proof the lift was
 * behaviour-preserving. What THIS file adds is coverage of the ladder on its
 * own terms: every rung, with the caller-supplied parameters actually varied,
 * so a future caller with a different bin/subfolder/labels is covered before it
 * exists rather than after it breaks.
 *
 * MOCKED the same way formpdf.x51 mocks: dropboxService, caseService,
 * taskService, settingsService, esignAlertService, documentIngestService.
 * documentIngestService is mocked HERE (formpdf.x51 lets the real one fail
 * safely) because document_id is part of this module's contract and a real
 * registration failure would make every assertion read `null`.
 *
 *   npx jest tests/filePlacementService.test.js
 */

'use strict';

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
  resolveLocation:    jest.fn(async () => '/Clients/Smith, John'),
  createFolder:       jest.fn(async (db, { path }) => ({ path, existed: false })),
  uploadFile:         jest.fn(async (db, { path }) => ({ path_display: path, id: 'id:X' })),
  getTemporaryLink:   jest.fn(async () => ({ link: 'https://dl/x', metadata: null })),
  joinPath: (...a) => realJoinPath(...a),
}));

jest.mock('../services/settingsService', () => ({
  getSetting:  jest.fn(async () => null),
  getSettings: jest.fn(async () => ({})),
}));

jest.mock('../services/caseService', () => ({ ensureCaseDropboxFolder: jest.fn() }));
jest.mock('../services/taskService', () => ({ createTask: jest.fn(async () => ({ task_id: 77 })) }));
jest.mock('../services/esignAlertService', () => ({ resolveAlertAssignee: jest.fn(async () => 22) }));
jest.mock('../services/documentIngestService', () => ({
  registerWrittenSafe: jest.fn(async () => ({ ok: true, document: { id: 909 }, links: [] })),
}));

const dropboxService = require('../services/dropboxService');
const { getSetting } = require('../services/settingsService');
const caseService    = require('../services/caseService');
const taskService    = require('../services/taskService');
const ingest         = require('../services/documentIngestService');
const { resolveAlertAssignee } = require('../services/esignAlertService');
const fp             = require('../services/filePlacementService');

const db = { query: jest.fn() };

const BIN_KEY     = 'dropbox_unsorted_generated_path';
const BIN_DEFAULT = '/  Law Office/   Cases/  Unsorted Generated Documents';

/** A generate-shaped call. Overrides go on top. */
function call(over = {}) {
  return fp.placeAndRegister(db, {
    linkType: 'case',
    linkId: 'hjSFMabb',
    content: Buffer.from('%PDF-1.7 fake'),
    fileName: '2026-09-01 Discharge Notice.pdf',
    subfolder: 'Notices',
    unsortedPathKey: BIN_KEY,
    unsortedDefault: BIN_DEFAULT,
    unsortedFilenamePrefix: '',
    eventSource: 'generated_doc',
    taskSource: 'doc_gen',
    logTag: '[DOC GEN]',
    artifactLabel: 'generated document',
    binLabel: 'unsorted generated-documents folder',
    ...over,
  });
}

const uploadedPath = () => dropboxService.uploadFile.mock.calls[0][1].path;

beforeEach(() => {
  // clearAllMocks resets CALLS but keeps per-test mockResolvedValue overrides —
  // re-pin every default here or one test's override leaks into the next
  // (the formpdf suites carry the same note for the same reason).
  jest.clearAllMocks();
  resolveAlertAssignee.mockImplementation(async () => 22);
  dropboxService._resolveCredential.mockImplementation(async () => 8);
  dropboxService.resolveLocation.mockImplementation(async () => '/Clients/Smith, John');
  dropboxService.createFolder.mockImplementation(async (d, { path }) => ({ path, existed: false }));
  dropboxService.uploadFile.mockImplementation(async (d, { path }) => ({ path_display: path, id: 'id:X' }));
  dropboxService.getTemporaryLink.mockImplementation(async () => ({ link: 'https://dl/x', metadata: null }));
  getSetting.mockImplementation(async () => null);
  taskService.createTask.mockImplementation(async () => ({ task_id: 77 }));
  ingest.registerWrittenSafe.mockImplementation(async () => ({ ok: true, document: { id: 909 }, links: [] }));
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => {
    if (/case_dropbox/.test(sql)) return [[{ case_dropbox: 'https://www.dropbox.com/sh/case-link' }]];
    if (/contact_lfm_name/.test(sql)) return [[{ contact_lfm_name: 'Smith, John' }]];
    return [[]];
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RUNG 1 — the case folder
// ─────────────────────────────────────────────────────────────────────────────

describe('rung 1 — live case link', () => {
  test('files to <case folder>/<subfolder>/<file>, with the SUBFOLDER the caller named', async () => {
    const v = await call();

    expect(dropboxService.resolveLocation).toHaveBeenCalledWith(db, 8, {
      sharedLink: 'https://www.dropbox.com/sh/case-link', expectFolder: true,
    });
    // Created explicitly, not left to files/upload's implicit parents — a
    // failure here is legible, an implicit one is a mystery path.
    expect(dropboxService.createFolder).toHaveBeenCalledWith(db, {
      credentialId: 8, path: '/Clients/Smith, John/Notices',
    });
    expect(uploadedPath()).toBe('/Clients/Smith, John/Notices/2026-09-01 Discharge Notice.pdf');
    expect(v.placement).toBe('case');
    expect(v.placement_note).toBeNull();
    expect(v.warnings).toEqual([]);
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  test('the subfolder is a parameter, not a constant', async () => {
    await call({ subfolder: 'Forms' });
    expect(uploadedPath()).toBe('/Clients/Smith, John/Forms/2026-09-01 Discharge Notice.pdf');
  });

  test('NO identity prefix on the case rung, even when the caller supplies one', async () => {
    // Bin hygiene is a BIN concern. A file sitting in its own case folder is
    // already identified by the folder it is in.
    await call({ unsortedFilenamePrefix: 'hjSFMabb - Smith, John - ' });
    expect(uploadedPath()).not.toContain('hjSFMabb - Smith, John - ');
  });

  test('uploads add+autorename — never overwrite', async () => {
    await call();
    expect(dropboxService.uploadFile).toHaveBeenCalledWith(db, expect.objectContaining({
      mode: 'add', autorename: true, credentialId: 8,
    }));
  });

  test('credential_id rides the verdict', async () => {
    dropboxService._resolveCredential.mockResolvedValue(11);
    const v = await call();
    expect(v.credential_id).toBe(11);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RUNG 2 — auto-create the case folder
// ─────────────────────────────────────────────────────────────────────────────

describe('rung 2 — no case_dropbox', () => {
  beforeEach(() => {
    db.query.mockImplementation(async (sql) => {
      if (/case_dropbox/.test(sql)) return [[{ case_dropbox: null }]];
      if (/contact_lfm_name/.test(sql)) return [[{ contact_lfm_name: 'Smith, John' }]];
      return [[]];
    });
    caseService.ensureCaseDropboxFolder.mockResolvedValue({
      existed: false, path: '/Clients/Smith, John',
      shared_link: 'https://www.dropbox.com/sh/new-link',
    });
  });

  test('ensures the folder, warns, raises a task, then files to the case rung', async () => {
    const v = await call();

    expect(caseService.ensureCaseDropboxFolder).toHaveBeenCalledWith(db, 'hjSFMabb');
    expect(dropboxService.resolveLocation).toHaveBeenCalledWith(db, 8, expect.objectContaining({
      sharedLink: 'https://www.dropbox.com/sh/new-link',
    }));
    expect(v.placement).toBe('case');
    expect(v.warnings.join(' ')).toContain('created automatically');
    expect(v.warnings.join(' ')).toContain('merge the two and re-link');
  });

  test('the task carries the CALLER\'s task_source and links to the case', async () => {
    await call();
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    expect(taskService.createTask).toHaveBeenCalledWith(db, expect.objectContaining({
      source: 'doc_gen', link_type: 'case', link_id: 'hjSFMabb', from: 0, to: 22,
      title: 'Dropbox folder auto-created for case hjSFMabb',
    }));
  });

  test('the task is raised even if the upload then fails — the folder exists either way', async () => {
    dropboxService.uploadFile.mockRejectedValue(new Error('network down'));
    await expect(call()).rejects.toThrow(/could not upload/);
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
  });

  test('a failed auto-create degrades to rung 3 rather than throwing', async () => {
    caseService.ensureCaseDropboxFolder.mockRejectedValue(new Error('dropbox 429'));
    const v = await call();
    expect(v.placement).toBe('unsorted');
    expect(v.placement_note).toContain('auto-creating one failed (dropbox 429)');
  });

  test('no assignee → the task is DROPPED, the filing still happens', async () => {
    resolveAlertAssignee.mockResolvedValue(null);
    const v = await call();
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(v.placement).toBe('case');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RUNG 3 — the per-case unsorted subfolder
// ─────────────────────────────────────────────────────────────────────────────

describe('rung 3 — case rung unreachable', () => {
  beforeEach(() => {
    dropboxService.resolveLocation.mockRejectedValue(new Error('link revoked'));
  });

  test('per-case subfolder inside the CALLER\'s bin, named "{id} - {lfm}"', async () => {
    const v = await call();
    expect(uploadedPath()).toBe(
      '/  Law Office/   Cases/  Unsorted Generated Documents/hjSFMabb - Smith, John' +
      '/2026-09-01 Discharge Notice.pdf'
    );
    expect(v.placement).toBe('unsorted');
  });

  test('the placement note names the artifact and the bin the caller labelled', async () => {
    const v = await call();
    expect(v.placement_note).toContain('The generated document could not be filed to the case folder');
    expect(v.placement_note).toContain('unsorted generated-documents folder');
    expect(v.placement_note).toContain('link revoked');
    expect(v.placement_note).toContain('move it into the correct case folder');
    // The note also lands in warnings, so a caller reading only one gets it.
    expect(v.warnings).toContain(v.placement_note);
  });

  test('the move-task is raised AFTER the upload, and names the actual file', async () => {
    const order = [];
    dropboxService.uploadFile.mockImplementation(async (d, { path }) => {
      order.push('upload');
      return { path_display: path, id: 'id:X' };
    });
    taskService.createTask.mockImplementation(async () => {
      order.push('task');
      return { task_id: 77 };
    });

    await call();

    expect(order).toEqual(['upload', 'task']);
    const arg = taskService.createTask.mock.calls[0][1];
    expect(arg.title).toBe('Move generated document for case hjSFMabb out of Unsorted');
    expect(arg.desc).toContain('/hjSFMabb - Smith, John/2026-09-01 Discharge Notice.pdf');
    expect(arg.source).toBe('doc_gen');
  });

  test('an upload failure on this rung raises NO move task and throws', async () => {
    dropboxService.uploadFile.mockRejectedValue(new Error('network down'));
    await expect(call()).rejects.toThrow(
      /could not upload the generated document to Dropbox.*Dropbox itself is down/s
    );
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  test('moveTaskOnUnsortedCase:false suppresses the task but not the note', async () => {
    const v = await call({ moveTaskOnUnsortedCase: false });
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(v.placement_note).toContain('unsorted generated-documents folder');
  });

  test('a name-lookup failure degrades the subfolder to the bare case id', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/case_dropbox/.test(sql)) return [[{ case_dropbox: 'https://www.dropbox.com/sh/x' }]];
      throw new Error('contacts unavailable');
    });
    await call();
    expect(uploadedPath()).toContain('/  Unsorted Generated Documents/hjSFMabb/');
  });

  test('a missing case row lands here too, saying so', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/case_dropbox/.test(sql)) return [[]];
      if (/contact_lfm_name/.test(sql)) return [[{ contact_lfm_name: 'Smith, John' }]];
      return [[]];
    });
    const v = await call();
    expect(v.placement).toBe('unsorted');
    expect(v.placement_note).toContain('was not found');
    expect(caseService.ensureCaseDropboxFolder).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE BIN — setting vs default
// ─────────────────────────────────────────────────────────────────────────────

describe('the unsorted bin is the caller\'s', () => {
  test('falls back to the caller\'s hardcoded default, leading spaces intact', async () => {
    const v = await call({ linkType: 'contact', linkId: '1001' });
    expect(uploadedPath().startsWith('/  Law Office/   Cases/  Unsorted Generated Documents/'))
      .toBe(true);
    expect(v.placement).toBe('unsorted');
  });

  test('an app_settings override wins, keyed on the CALLER\'s key', async () => {
    getSetting.mockImplementation(async (d, key) =>
      key === BIN_KEY ? '/  Archive/  Generated\r\n' : null);

    await call({ linkType: 'contact', linkId: '1001' });

    expect(getSetting).toHaveBeenCalledWith(db, BIN_KEY);
    expect(uploadedPath().startsWith('/  Archive/  Generated/')).toBe(true);  // spaces intact
    expect(uploadedPath()).not.toContain('\r');                              // CRLF trimmed
  });

  test('a settings read that throws degrades to the default rather than failing', async () => {
    getSetting.mockRejectedValue(new Error('app_settings unreachable'));
    const v = await call({ linkType: 'contact', linkId: '1001' });
    expect(uploadedPath().startsWith(BIN_DEFAULT)).toBe(true);
    expect(v.placement).toBe('unsorted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NON-CASE — loose file, identity prefix, no task
// ─────────────────────────────────────────────────────────────────────────────

describe('contact / appt / unlinked', () => {
  test('contact → bin ROOT with the identity prefix, and NO task', async () => {
    const v = await call({
      linkType: 'contact', linkId: '1001',
      unsortedFilenamePrefix: 'contact 1001 - Doe, Jane - ',
    });

    expect(uploadedPath()).toBe(
      '/  Law Office/   Cases/  Unsorted Generated Documents/' +
      'contact 1001 - Doe, Jane - 2026-09-01 Discharge Notice.pdf'
    );
    expect(v.placement).toBe('unsorted');
    expect(taskService.createTask).not.toHaveBeenCalled();
    // Never touched the case machinery.
    expect(caseService.ensureCaseDropboxFolder).not.toHaveBeenCalled();
    expect(dropboxService.createFolder).not.toHaveBeenCalled();
  });

  test('the note explains what it IS linked to', async () => {
    const v = await call({ linkType: 'contact', linkId: '1001' });
    expect(v.placement_note).toContain('This generated document is linked to a contact (id 1001)');
    expect(v.placement_note).toContain('no case folder to file into');
  });

  test('appt and unlinked both land loose, with their own wording', async () => {
    const appt = await call({ linkType: 'appt', linkId: '450' });
    expect(appt.placement_note).toContain('an appointment (id 450)');
    expect(taskService.createTask).not.toHaveBeenCalled();

    jest.clearAllMocks();
    dropboxService.uploadFile.mockImplementation(async (d, { path }) => ({ path_display: path, id: 'id:X' }));
    dropboxService.getTemporaryLink.mockImplementation(async () => ({ link: 'https://dl/x' }));
    dropboxService._resolveCredential.mockImplementation(async () => 8);
    getSetting.mockImplementation(async () => null);
    ingest.registerWrittenSafe.mockImplementation(async () => ({ ok: true, document: { id: 909 } }));
    resolveAlertAssignee.mockImplementation(async () => 22);

    const none = await call({ linkType: null, linkId: null });
    expect(none.placement_note).toContain('nothing yet');
    expect(taskService.createTask).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTORENAME — the path Dropbox returns is the truth
// ─────────────────────────────────────────────────────────────────────────────

describe('autorename', () => {
  test('the verdict carries the path DROPBOX returned, not the one we asked for', async () => {
    dropboxService.uploadFile.mockResolvedValue({
      path_display: '/Clients/Smith, John/Notices/2026-09-01 Discharge Notice (1).pdf',
      id: 'id:X',
    });

    const v = await call();

    expect(dropboxService.uploadFile.mock.calls[0][1].path)
      .toBe('/Clients/Smith, John/Notices/2026-09-01 Discharge Notice.pdf');
    expect(v.path).toBe('/Clients/Smith, John/Notices/2026-09-01 Discharge Notice (1).pdf');
    expect(v.file_name).toBe('2026-09-01 Discharge Notice (1).pdf');
  });

  test('path_lower is the fallback when path_display is absent', async () => {
    dropboxService.uploadFile.mockResolvedValue({ path_lower: '/clients/x/notices/n.pdf' });
    const v = await call();
    expect(v.path).toBe('/clients/x/notices/n.pdf');
  });

  test('the temp link is minted for the ACTUAL path', async () => {
    dropboxService.uploadFile.mockResolvedValue({
      path_display: '/Clients/Smith, John/Notices/n (1).pdf', id: 'id:X',
    });
    await call();
    expect(dropboxService.getTemporaryLink).toHaveBeenCalledWith(db, {
      credentialId: 8, path: '/Clients/Smith, John/Notices/n (1).pdf',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRATION
// ─────────────────────────────────────────────────────────────────────────────

describe('registry write', () => {
  test('registers the returned ENTRY (post-autorename) with the caller\'s eventSource', async () => {
    const meta = { path_display: '/Clients/Smith, John/Notices/n.pdf', id: 'id:LANDED' };
    dropboxService.uploadFile.mockResolvedValue(meta);

    const v = await call({ createdBy: 9 });

    expect(ingest.registerWrittenSafe).toHaveBeenCalledWith(db, {
      entry: meta,
      links: [{ type: 'case', id: 'hjSFMabb' }],
      createdBy: 9,
      eventSource: 'generated_doc',
      credentialId: 8,
    });
    expect(v.document_id).toBe(909);
  });

  test('contact links register too', async () => {
    await call({ linkType: 'contact', linkId: '1001' });
    expect(ingest.registerWrittenSafe.mock.calls[0][1].links)
      .toEqual([{ type: 'contact', id: '1001' }]);
  });

  test('appt and unlinked register with NO links — inventing a relation is a schema decision', async () => {
    await call({ linkType: 'appt', linkId: '450' });
    expect(ingest.registerWrittenSafe.mock.calls[0][1].links).toEqual([]);
  });

  test('linkForRegistration:false registers the file but attaches nothing', async () => {
    await call({ linkForRegistration: false });
    expect(ingest.registerWrittenSafe).toHaveBeenCalledTimes(1);
    expect(ingest.registerWrittenSafe.mock.calls[0][1].links).toEqual([]);
  });

  test('a registration FAILURE costs document_id and nothing else', async () => {
    ingest.registerWrittenSafe.mockResolvedValue({ ok: false, error: 'entry.id is required' });
    const v = await call();
    expect(v.document_id).toBeNull();
    expect(v.path).toBeTruthy();
    expect(v.placement).toBe('case');
    // Emphatically NOT a warning: the file is filed, and the sync's next delta
    // registers it anyway. A warning here would cry wolf on every retry.
    expect(v.warnings).toEqual([]);
  });

  test('createdBy defaults to null — machine work has no actor', async () => {
    await call();
    expect(ingest.registerWrittenSafe.mock.calls[0][1].createdBy).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEMP LINK
// ─────────────────────────────────────────────────────────────────────────────

describe('temp link', () => {
  test('rides the verdict with its expiry note', async () => {
    const v = await call();
    expect(v.temp_link).toBe('https://dl/x');
    expect(v.temp_link_expires_note).toMatch(/expires ~4 hours/);
  });

  test('a failure does NOT fail the filing — null link + a warning instead', async () => {
    dropboxService.getTemporaryLink.mockRejectedValue(new Error('rate limited'));
    const v = await call();
    expect(v.path).toBeTruthy();
    expect(v.temp_link).toBeNull();
    expect(v.temp_link_expires_note).toBeNull();
    expect(v.warnings.join(' ')).toContain('temporary download link could not be created');
    expect(v.warnings.join(' ')).toContain('rate limited');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IDENTITY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

describe('casePrimaryName', () => {
  test('returns the primary contact, ordered Primary-first', async () => {
    expect(await fp.casePrimaryName(db, 'hjSFMabb')).toBe('Smith, John');
    const sql = db.query.mock.calls[0][0];
    expect(sql).toContain("(cr.case_relate_type = 'Primary') DESC");
  });

  test('never throws — a failed lookup is null', async () => {
    db.query.mockRejectedValue(new Error('db gone'));
    await expect(fp.casePrimaryName(db, 'hjSFMabb')).resolves.toBeNull();
  });
});

describe('identityPrefixFor', () => {
  test('a case uses its BARE id (the e-sign convention)', async () => {
    expect(await fp.identityPrefixFor(db, { linkType: 'case', linkId: 'hjSFMabb' }))
      .toBe('hjSFMabb - Smith, John - ');
  });

  test('a contact is type-prefixed', async () => {
    db.query.mockImplementation(async () => [[{ contact_lfm_name: 'Doe, Jane' }]]);
    expect(await fp.identityPrefixFor(db, { linkType: 'contact', linkId: '1001' }))
      .toBe('contact 1001 - Doe, Jane - ');
  });

  test('an unnamed entity degrades to "{id} - "', async () => {
    db.query.mockImplementation(async () => [[]]);
    expect(await fp.identityPrefixFor(db, { linkType: 'case', linkId: 'hjSFMabb' }))
      .toBe('hjSFMabb - ');
  });

  test('a lookup failure degrades too — a filename nicety never costs a filing', async () => {
    db.query.mockRejectedValue(new Error('db gone'));
    expect(await fp.identityPrefixFor(db, { linkType: 'contact', linkId: '1001' }))
      .toBe('contact 1001 - ');
  });

  test('no id → no prefix at all', async () => {
    expect(await fp.identityPrefixFor(db, { linkType: null, linkId: null })).toBe('');
    expect(await fp.identityPrefixFor(db, {})).toBe('');
  });

  test('an appt needs no lookup', async () => {
    expect(await fp.identityPrefixFor(db, { linkType: 'appt', linkId: '450' }))
      .toBe('appt 450 - ');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('the prefix is clipped to 80 chars', async () => {
    db.query.mockImplementation(async () => [[{ contact_lfm_name: 'Q'.repeat(120) }]]);
    const prefix = await fp.identityPrefixFor(db, { linkType: 'contact', linkId: '1001' });
    expect(prefix.length).toBeLessThanOrEqual(80);
    expect(prefix.endsWith(' - ')).toBe(true);
  });

  test('illegal path characters are scrubbed out of a name', async () => {
    db.query.mockImplementation(async () => [[{ contact_lfm_name: 'A/B:C' }]]);
    const prefix = await fp.identityPrefixFor(db, { linkType: 'contact', linkId: '1001' });
    expect(prefix).not.toMatch(/[/\\:*?"<>|]/);
  });
});

describe('sanitizeNameFragment', () => {
  test('scrubs the Dropbox-illegal set and collapses whitespace', () => {
    expect(fp.sanitizeNameFragment('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(fp.sanitizeNameFragment('  too   many   spaces  ')).toBe('too many spaces');
  });

  test('clips to max', () => {
    expect(fp.sanitizeNameFragment('x'.repeat(200), 10)).toHaveLength(10);
  });

  test('the empty-input fallback is a PARAMETER — the two lifted copies disagreed', () => {
    expect(fp.sanitizeNameFragment('')).toBe('document');
    expect(fp.sanitizeNameFragment('', 100, 'form')).toBe('form');
    // formPdfService pins 'form' through its own wrapper; assert that here so
    // the two stay wired together.
    const formPdfService = require('../services/formPdfService');
    expect(formPdfService.sanitizeNameFragment('')).toBe('form');
  });
});
