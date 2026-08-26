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
    for (const fn of ['stat', 'tempViewUrl', 'download', 'move', 'rename', 'remove', 'ensureSharedLink']) {
      expect(typeof p[fn]).toBe('function');
    }
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
