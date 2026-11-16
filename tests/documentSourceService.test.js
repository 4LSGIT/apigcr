// tests/documentSourceService.test.js
//
/**
 * services/documentSourceService.js — the storage-provider seam (Documents S1).
 *
 * The registry itself is four lines of Map, so the value here is in the
 * DROPBOX PROVIDER's delegation contract:
 *
 *   1. Every call addresses the file by its "id:" HANDLE in dropboxService's
 *      `path` slot. That only works because normalizePath passes handles
 *      through (see tests/dropboxService.normalizePath.test.js). If that
 *      passthrough regresses, these tests still pass — they assert the
 *      argument we send — which is exactly why the passthrough has its own
 *      suite pinning the live-verified behaviour.
 *
 *   2. `rename` is deliberately NOT a delegation to dropboxService.renamePath.
 *      That function derives the parent folder with
 *          const idx = current.lastIndexOf('/');
 *          const parent = current.slice(0, idx);
 *      On a handle there is no '/', so idx is -1 and slice(0,-1) CHOPS THE
 *      LAST CHARACTER OFF THE ID, producing "id:<truncated>/<newName>".
 *      Verified live 2026-08-26: Dropbox answers 409 path/not_found. Loud, not
 *      destructive, but useless. The provider resolves the handle to a real
 *      path first and moves instead. This suite pins that so nobody
 *      "simplifies" it back into a one-liner.
 *
 * dropboxService is monkey-patched on the require cache (the taskService.test.js
 * convention) — no network, no DB, no jest.mock.
 *
 * Run:
 *   npx jest tests/documentSourceService.test.js
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

const sources = require('../services/documentSourceService');
const dropbox = require('../services/dropboxService');

const FID  = 'id:glkBw_soyGAAAAAAAADg3g';
const DISP = '/  Law Office/   Cases/  Active Cases/  Active - Appeals/Appeal List - as of JUNE 1 24.xlsx';
const DB   = { /* opaque — the provider only passes it through */ };

const PATCHED = [
  'getMetadata', 'getTemporaryLink', 'downloadFile',
  'movePath', 'deletePath', 'getOrCreateSharedLink',
  // D1a
  'uploadFile', 'createFolderWithOptions', 'getTemporaryUploadLink', 'listFolderPage', 'listFolderContinue',
  // D1b
  'createFolder', '_resolveCredential', 'resolveLocation',
];
const real = {};

beforeAll(() => { for (const k of PATCHED) real[k] = dropbox[k]; });
afterAll(()  => { for (const k of PATCHED) dropbox[k] = real[k]; });

beforeEach(() => {
  dropbox.getMetadata           = jest.fn(async () => ({ '.tag': 'file', id: FID, path_display: DISP }));
  dropbox.getTemporaryLink      = jest.fn(async () => ({ link: 'https://dl.dropboxusercontent.com/x', metadata: { name: 'a.xlsx' } }));
  dropbox.downloadFile          = jest.fn(async () => ({ buffer: Buffer.from('bytes'), metadata: { name: 'a.xlsx' } }));
  dropbox.movePath              = jest.fn(async () => ({ metadata: { id: FID } }));
  dropbox.deletePath            = jest.fn(async () => ({ deleted: true, path: DISP }));
  dropbox.getOrCreateSharedLink = jest.fn(async () => 'https://www.dropbox.com/s/abc/x?dl=0');
  // D1a
  dropbox.uploadFile             = jest.fn(async (db, o) => ({ '.tag': 'file', id: 'id:new', name: 'n', path_display: o.path || `<${o.sharedLink}>/${o.subfolder || ''}/${o.filename}` }));
  dropbox.createFolderWithOptions = jest.fn(async (db, o) => ({ path: o.path, existed: false, subfolders_created: (o.subfolders || []).map((n) => ({ path: `${o.path}/${n}`, existed: false })), shared_link: o.shareLink ? 'https://www.dropbox.com/scl/fo/new?dl=0' : null }));
  dropbox.getTemporaryUploadLink = jest.fn(async (db, o) => ({ link: 'https://content.dropboxapi.com/apitul/1/x', path: `${o.path || '<link>'}/${o.subfolder ? o.subfolder + '/' : ''}${o.filename}` }));
  dropbox.listFolderPage         = jest.fn(async () => ({ entries: [{ '.tag': 'file', id: 'id:a' }], cursor: 'c1', has_more: true }));
  dropbox.listFolderContinue     = jest.fn(async () => ({ entries: [], cursor: 'c2', has_more: false }));
  // D1b
  dropbox.createFolder           = jest.fn(async (db, o) => ({ path: o.path, existed: false, metadata: { '.tag': 'folder', id: 'id:MADE', path_display: o.path } }));
  dropbox._resolveCredential     = jest.fn(async (db, o) => (o && o.credentialId != null ? o.credentialId : 8));
  dropbox.resolveLocation        = jest.fn(async (db, cred, o) => '/  law office/   cases/  active cases/ case a');
});

afterEach(() => { jest.clearAllMocks(); });

// ─────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────

describe('registry', () => {
  test("'dropbox' is registered at load", () => {
    expect(sources.list()).toContain('dropbox');
    expect(typeof sources.get('dropbox').stat).toBe('function');
  });

  test('an unknown source throws at LOOKUP, not three frames deeper', () => {
    expect(() => sources.get('gdrive')).toThrow("unknown document source 'gdrive'");
    expect(() => sources.get('')).toThrow('unknown document source');
    expect(() => sources.get(undefined)).toThrow('unknown document source');
  });

  test('GCS / GDrive are deliberately NOT stubbed', () => {
    // A stub that throws at call time is strictly worse than get() throwing
    // at registry time: it lets a caller get half way through a flow first.
    expect(sources.list()).toEqual(['dropbox']);
  });

  test('the dropbox provider implements the whole interface', () => {
    const p = sources.get('dropbox');
    for (const fn of ['stat', 'tempViewUrl', 'download', 'move', 'rename', 'remove', 'ensureSharedLink',
      'upload', 'ensureFolder', 'directUpload', 'listChanges', 'isCursorReset', 'isNotFound', 'isTransient',
      'context', 'resolveHumanLink', 'joinPath']) {
      expect(typeof p[fn]).toBe('function');
    }
    expect(p.capabilities).toEqual({ humanManaged: true, directUpload: true, humanLink: true, listChanges: true, changeNotify: false });
    expect(Object.isFrozen(p.capabilities)).toBe(true);
    expect(Object.isFrozen(p.nameRules)).toBe(true);
  });

  test('register rejects junk rather than poisoning the map', () => {
    expect(() => sources.register('', {})).toThrow('source is required');
    expect(() => sources.register('x', null)).toThrow('must be an object');
    expect(sources.list()).toEqual(['dropbox']);
  });
});

// ─────────────────────────────────────────────────────────────
// Dropbox provider — delegation
// ─────────────────────────────────────────────────────────────

describe('dropbox provider — delegation', () => {
  const p = () => sources.get('dropbox');

  test('stat addresses the file by its handle in the path slot', async () => {
    await p().stat(DB, FID);
    expect(dropbox.getMetadata).toHaveBeenCalledWith(DB, { path: FID });
  });

  test('tempViewUrl maps dropboxService\'s {link} onto the interface\'s {url}', async () => {
    // getTemporaryLink returns { link, metadata }; the provider interface
    // promises { url, metadata }. A silent shape mismatch here would surface
    // as `undefined` in the /view response body.
    const out = await p().tempViewUrl(DB, FID);
    expect(out).toEqual({ url: 'https://dl.dropboxusercontent.com/x', metadata: { name: 'a.xlsx' } });
    expect(dropbox.getTemporaryLink).toHaveBeenCalledWith(DB, { path: FID });
  });

  test('download passes {buffer, metadata} straight through', async () => {
    const out = await p().download(DB, FID);
    expect(out.buffer.toString()).toBe('bytes');
    expect(dropbox.downloadFile).toHaveBeenCalledWith(DB, { path: FID });
  });

  test('move sends the handle as fromPath and a literal destination as toPath', async () => {
    const dest = '/  Law Office/   Cases/ Closed Cases/  Smith, John - 123/Appeal.xlsx';
    await p().move(DB, FID, dest);
    expect(dropbox.movePath).toHaveBeenCalledWith(DB, { fromPath: FID, toPath: dest });
  });

  test('remove deletes by handle', async () => {
    await p().remove(DB, FID);
    expect(dropbox.deletePath).toHaveBeenCalledWith(DB, { path: FID });
  });

  test('ensureSharedLink returns the URL string', async () => {
    expect(await p().ensureSharedLink(DB, FID)).toBe('https://www.dropbox.com/s/abc/x?dl=0');
    expect(dropbox.getOrCreateSharedLink).toHaveBeenCalledWith(DB, { path: FID });
  });

  test('credentialId is forwarded when given and omitted when not', async () => {
    await p().stat(DB, FID, { credentialId: 8 });
    expect(dropbox.getMetadata).toHaveBeenCalledWith(DB, { path: FID, credentialId: 8 });

    await p().stat(DB, FID, { somethingElse: 'ignored' });
    expect(dropbox.getMetadata).toHaveBeenLastCalledWith(DB, { path: FID });
  });
});

// ─────────────────────────────────────────────────────────────
// rename — the divergence
// ─────────────────────────────────────────────────────────────

describe('dropbox provider — rename (does NOT delegate to renamePath)', () => {
  const p = () => sources.get('dropbox');

  test('resolves the handle, then moves to a SIBLING path', async () => {
    await p().rename(DB, FID, 'Appeal List - FINAL.xlsx');

    expect(dropbox.getMetadata).toHaveBeenCalledWith(DB, { path: FID });
    expect(dropbox.movePath).toHaveBeenCalledWith(DB, {
      fromPath: FID,
      toPath: '/  Law Office/   Cases/  Active Cases/  Active - Appeals/Appeal List - FINAL.xlsx',
    });
  });

  test('the parent folder keeps every leading space', async () => {
    await p().rename(DB, FID, 'x.pdf');
    const { toPath } = dropbox.movePath.mock.calls[0][1];
    expect(toPath.split('/').slice(1, 4)).toEqual(['  Law Office', '   Cases', '  Active Cases']);
  });

  test('the truncated-id path is never produced (the renamePath bug)', async () => {
    await p().rename(DB, FID, 'x.pdf');
    const { toPath } = dropbox.movePath.mock.calls[0][1];
    // What renamePath would have built: FID.slice(0,-1) + '/x.pdf'
    expect(toPath).not.toBe(FID.slice(0, -1) + '/x.pdf');
    expect(toPath.startsWith('id:')).toBe(false);
  });

  test('a new name may carry leading spaces (firm sort convention)', async () => {
    await p().rename(DB, FID, '  AAA - sort me first.pdf');
    expect(dropbox.movePath.mock.calls[0][1].toPath)
      .toBe('/  Law Office/   Cases/  Active Cases/  Active - Appeals/  AAA - sort me first.pdf');
  });

  test('a name containing "/" is refused — that is a move, not a rename', async () => {
    await expect(p().rename(DB, FID, 'sub/x.pdf'))
      .rejects.toThrow('must not contain "/"');
    expect(dropbox.movePath).not.toHaveBeenCalled();
  });

  test('a missing name is refused', async () => {
    await expect(p().rename(DB, FID, '')).rejects.toThrow('requires newName');
    await expect(p().rename(DB, FID, null)).rejects.toThrow('requires newName');
  });

  test('an unresolvable handle fails clearly instead of composing a junk path', async () => {
    // Team/shared content can come back with no path at all.
    dropbox.getMetadata = jest.fn(async () => ({ '.tag': 'file', id: FID }));
    await expect(p().rename(DB, FID, 'x.pdf')).rejects.toThrow('no resolvable path');
    expect(dropbox.movePath).not.toHaveBeenCalled();
  });

  test('falls back to path_lower when path_display is absent', async () => {
    dropbox.getMetadata = jest.fn(async () => ({ '.tag': 'file', id: FID, path_lower: '/  law office/a.xlsx' }));
    await p().rename(DB, FID, 'B.xlsx');
    expect(dropbox.movePath.mock.calls[0][1].toPath).toBe('/  law office/B.xlsx');
  });
});

// ─────────────────────────────────────────────────────────────
// D1a — writes, folders, direct upload, listing, declarations
// ─────────────────────────────────────────────────────────────

describe('dropbox provider — D1a writes and folders', () => {
  const p = () => sources.get('dropbox');
  const FOLDER = 'id:FOLDER0001';
  const folderMeta = () => { dropbox.getMetadata = jest.fn(async () => ({ '.tag': 'folder', id: FOLDER, path_display: '/  Law Office/   Cases/  Active Cases/ Case A' })); };

  test('upload by path: mode add + autorename, exactly as every writer uploads', async () => {
    await p().upload(DB, { path: '/  Bin/ x.pdf' }, Buffer.from('b'), { credentialId: 8 });
    expect(dropbox.uploadFile).toHaveBeenCalledWith(DB, { path: '/  Bin/ x.pdf', content: Buffer.from('b'), mode: 'add', autorename: true, credentialId: 8 });
  });

  test('upload into a folder by handle: resolve-then-join keeps every leading space, subfolder optional', async () => {
    folderMeta();
    await p().upload(DB, { folder: FOLDER, name: ' x.pdf', subfolder: 'Client Uploads' }, 'text');
    expect(dropbox.getMetadata).toHaveBeenCalledWith(DB, { path: FOLDER });
    expect(dropbox.uploadFile).toHaveBeenCalledWith(DB, { path: '/  Law Office/   Cases/  Active Cases/ Case A/Client Uploads/ x.pdf', content: 'text', mode: 'add', autorename: true });
    await p().upload(DB, { folder: FOLDER, name: 'y.pdf' }, 'text');
    expect(dropbox.uploadFile).toHaveBeenLastCalledWith(DB, { path: '/  Law Office/   Cases/  Active Cases/ Case A/y.pdf', content: 'text', mode: 'add', autorename: true });
  });

  test('upload inside a human link delegates the resolution to dropboxService', async () => {
    await p().upload(DB, { humanLink: 'https://www.dropbox.com/scl/fo/a?dl=0', name: 'z.pdf', subfolder: 'Forms' }, 'text');
    expect(dropbox.uploadFile).toHaveBeenCalledWith(DB, { sharedLink: 'https://www.dropbox.com/scl/fo/a?dl=0', filename: 'z.pdf', subfolder: 'Forms', content: 'text', mode: 'add', autorename: true });
    expect(dropbox.getMetadata).not.toHaveBeenCalled();
  });

  test('upload refuses: no content, a name with "/", a file handle as the folder, path AND name', async () => {
    await expect(p().upload(DB, { path: '/x' })).rejects.toThrow('requires content');
    await expect(p().upload(DB, { folder: FOLDER, name: 'a/b' }, 'x')).rejects.toThrow('must not contain "/"');
    await expect(p().upload(DB, { folder: FID, name: 'a.pdf' }, 'x')).rejects.toThrow('is not a folder');
    await expect(p().upload(DB, { path: '/x', name: 'a' }, 'x')).rejects.toThrow('not both');
    await expect(p().upload(DB, { name: 'a.pdf' }, 'x')).rejects.toThrow('needs path, folder or humanLink');
  });

  test('ensureFolder with subfolders or a link: createFolderWithOptions; the handle only on request (one get_metadata)', async () => {
    folderMeta();
    const r = await p().ensureFolder(DB, { path: '/  Law Office/   Cases/  Active Cases/ Case A/' }, { subfolders: ['Client Uploads', ' Docket'], humanLink: true, credentialId: 8 });
    expect(dropbox.createFolderWithOptions).toHaveBeenCalledWith(DB, { path: '/  Law Office/   Cases/  Active Cases/ Case A', subfolders: ['Client Uploads', ' Docket'], shareLink: true, credentialId: 8 });
    expect(dropbox.getMetadata).not.toHaveBeenCalled();
    expect(r).toEqual({
      externalId: null, path: '/  Law Office/   Cases/  Active Cases/ Case A', existed: false,
      subfolders: [{ path: '/  Law Office/   Cases/  Active Cases/ Case A/Client Uploads', existed: false }, { path: '/  Law Office/   Cases/  Active Cases/ Case A/ Docket', existed: false }],
      humanLink: 'https://www.dropbox.com/scl/fo/new?dl=0',
    });
    const h = await p().ensureFolder(DB, { path: '/  Bin' }, { subfolders: ['x'], handle: true });
    expect(dropbox.getMetadata).toHaveBeenCalledWith(DB, { path: '/  Bin' });
    expect(h.externalId).toBe(FOLDER);
  });

  test('ensureFolder plain (no subfolders, no link) is files/create_folder_v2 alone — the ladder\'s exact call — and a created folder carries its handle for free', async () => {
    const r = await p().ensureFolder(DB, { path: '/  Bin/ Forms' }, { credentialId: 8 });
    expect(dropbox.createFolder).toHaveBeenCalledWith(DB, { path: '/  Bin/ Forms', credentialId: 8 });
    expect(dropbox.createFolderWithOptions).not.toHaveBeenCalled();
    expect(dropbox.getMetadata).not.toHaveBeenCalled();
    expect(r).toEqual({ externalId: 'id:MADE', path: '/  Bin/ Forms', existed: false, subfolders: [], humanLink: null });
  });

  test('ensureFolder under a parent handle; an adopted folder reports existed, null handle unless asked, and the REQUESTED path (not a display path)', async () => {
    folderMeta();
    dropbox.createFolder = jest.fn(async (db, o) => ({ path: o.path, existed: true }));
    const r = await p().ensureFolder(DB, { parent: FOLDER, name: ' Signed Documents' });
    expect(dropbox.createFolder).toHaveBeenCalledWith(DB, { path: '/  Law Office/   Cases/  Active Cases/ Case A/ Signed Documents' });
    expect(r).toEqual({ externalId: null, path: '/  Law Office/   Cases/  Active Cases/ Case A/ Signed Documents', existed: true, humanLink: null, subfolders: [] });
    const h = await p().ensureFolder(DB, { parent: FOLDER, name: ' Signed Documents' }, { handle: true });
    expect(h.externalId).toBe(FOLDER);
  });

  test('context resolves the credential once; resolveHumanLink reuses it and never re-reads when given one', async () => {
    const ctx = await p().context(DB);
    expect(ctx).toEqual({ credentialId: 8 });
    expect(dropbox._resolveCredential).toHaveBeenCalledWith(DB, {});
    expect(await p().context(DB, { credentialId: 21 })).toEqual({ credentialId: 21 });
    const path = await p().resolveHumanLink(DB, 'https://www.dropbox.com/scl/fo/a?dl=0', { expectFolder: true }, ctx);
    expect(dropbox.resolveLocation).toHaveBeenCalledWith(DB, 8, { sharedLink: 'https://www.dropbox.com/scl/fo/a?dl=0', expectFolder: true });
    expect(dropbox._resolveCredential).toHaveBeenCalledTimes(2);
    expect(path).toBe('/  law office/   cases/  active cases/ case a');
    await p().resolveHumanLink(DB, 'https://www.dropbox.com/scl/fo/a?dl=0');
    expect(dropbox._resolveCredential).toHaveBeenCalledTimes(3);
    expect(dropbox.resolveLocation).toHaveBeenLastCalledWith(DB, 8, { sharedLink: 'https://www.dropbox.com/scl/fo/a?dl=0', expectFolder: false });
    await expect(p().resolveHumanLink(DB, '')).rejects.toThrow('requires humanLink');
    expect(p().joinPath('/  A/', ' b', undefined, 'c.pdf')).toBe('/  A/ b/c.pdf');
  });

  test('ensureFolder refuses the root and ambiguous destinations', async () => {
    await expect(p().ensureFolder(DB, { path: '/' })).rejects.toThrow('refuses the root');
    await expect(p().ensureFolder(DB, {})).rejects.toThrow('needs path or parent + name');
    await expect(p().ensureFolder(DB, { path: '/a', name: 'b' })).rejects.toThrow('not both');
    await expect(p().ensureFolder(DB, { parent: FOLDER, name: 'a/b' })).rejects.toThrow('must not contain "/"');
    expect(dropbox.createFolderWithOptions).not.toHaveBeenCalled();
  });

  test('directUpload: a POST target with the destination path; humanLink, folder handle and path forms; duration passthrough', async () => {
    const a = await p().directUpload(DB, { humanLink: 'https://www.dropbox.com/scl/fo/a?dl=0', filename: 'W2.pdf', subfolder: 'Client Uploads' });
    expect(dropbox.getTemporaryUploadLink).toHaveBeenCalledWith(DB, { sharedLink: 'https://www.dropbox.com/scl/fo/a?dl=0', subfolder: 'Client Uploads', filename: 'W2.pdf' });
    expect(a).toEqual({ url: 'https://content.dropboxapi.com/apitul/1/x', method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, path: '<link>/Client Uploads/W2.pdf', expiresInSec: 7200 });
    folderMeta();
    await p().directUpload(DB, { folder: FOLDER, filename: 'W2.pdf', subfolder: 'Client Uploads' }, { durationSec: 600, credentialId: 8 });
    expect(dropbox.getTemporaryUploadLink).toHaveBeenLastCalledWith(DB, { path: '/  Law Office/   Cases/  Active Cases/ Case A/Client Uploads', filename: 'W2.pdf', duration: 600, credentialId: 8 });
    await p().directUpload(DB, { folder: FOLDER, filename: 'W2.pdf' });
    expect(dropbox.getTemporaryUploadLink).toHaveBeenLastCalledWith(DB, { path: '/  Law Office/   Cases/  Active Cases/ Case A', filename: 'W2.pdf' });
    const c = await p().directUpload(DB, { path: '/  Bin/', filename: 'W2.pdf', subfolder: 'deadLnk1 - Lee, Ann' });
    expect(dropbox.getTemporaryUploadLink).toHaveBeenLastCalledWith(DB, { path: '/  Bin/deadLnk1 - Lee, Ann', filename: 'W2.pdf' });
    expect(c.expiresInSec).toBe(7200);
    await expect(p().directUpload(DB, { path: '/x' })).rejects.toThrow('filename is required');
    await expect(p().directUpload(DB, { filename: 'a' })).rejects.toThrow('needs path, folder or humanLink');
  });

  test('listChanges: no cursor = the first recursive page of root; a cursor = the page after it; hasMore is a real boolean', async () => {
    const first = await p().listChanges(DB, { root: '/  Law Office/   Cases/  Active Cases', limit: 500 }, { credentialId: 8 });
    expect(dropbox.listFolderPage).toHaveBeenCalledWith(DB, { path: '/  Law Office/   Cases/  Active Cases', recursive: true, limit: 500, credentialId: 8 });
    expect(first).toEqual({ entries: [{ '.tag': 'file', id: 'id:a' }], cursor: 'c1', hasMore: true });
    const next = await p().listChanges(DB, { cursor: 'c1' });
    expect(dropbox.listFolderContinue).toHaveBeenCalledWith(DB, { cursor: 'c1' });
    expect(dropbox.listFolderPage).toHaveBeenCalledTimes(1);
    expect(next).toEqual({ entries: [], cursor: 'c2', hasMore: false });
    await expect(p().listChanges(DB, {})).rejects.toThrow('needs root or cursor');
  });

  test('the error predicates are dropboxService\'s own verdicts', () => {
    const reset = Object.assign(new Error('x'), { status: 409, errorSummary: 'reset/..' });
    const gone = Object.assign(new Error('x'), { status: 409, errorSummary: 'path/not_found/..' });
    expect([p().isCursorReset(reset), p().isCursorReset(gone)]).toEqual([true, false]);
    expect([p().isNotFound(gone), p().isNotFound(reset)]).toEqual([true, false]);
    expect(p().isTransient(Object.assign(new Error('x'), { status: 503 }))).toBe(true);
    expect(p().isTransient(gone)).toBe(false);
  });

  test('nameRules say what the writers already enforce: the e-sign illegal set, the segment-end trim, leading spaces kept', () => {
    const r = p().nameRules;
    expect(r).toMatchObject({ caseSensitive: false, leadingSpaces: 'preserved', maxSegmentChars: 255, duplicateNames: 'autorename' });
    expect(r.validateName('  Active Cases')).toEqual({ ok: true });
    expect(r.validateName('Legacy Signature Properties, Inc.')).toEqual({ ok: false, reason: 'ends with a period or a space' });
    expect(r.validateName('a/b')).toEqual({ ok: false, reason: 'illegal character' });
    expect(r.validateName('a:b')).toEqual({ ok: false, reason: 'illegal character' });
    expect(r.validateName('')).toEqual({ ok: false, reason: 'empty' });
    expect(r.validateName('x'.repeat(256))).toEqual({ ok: false, reason: 'longer than 255 characters' });
    expect(new RegExp(r.illegal).test('"')).toBe(true);
  });
});
