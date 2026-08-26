// tests/dropboxService.normalizePath.test.js
//
/**
 * services/dropboxService.js — path normalization.
 *
 * TWO jobs, and the second is the reason this file exists at all.
 *
 * 1. HANDLE PASSTHROUGH (Documents S1). Dropbox accepts "id:…", "rev:…" and
 *    "ns:…" handles anywhere a `path` argument goes, and the "id:" handle
 *    SURVIVES MOVE AND RENAME — which is the entire reason documents.external_id
 *    stores one. normalizePath used to prefix a slash to anything not already
 *    starting with one, turning 'id:abc' into '/id:abc', which the API rejects
 *    with path/not_found. Verified live against the firm's Dropbox on
 *    2026-08-26:
 *       files/get_metadata { path: "id:glkBw_soyGAAAAAAAADg3g" }  -> 200
 *       files/get_metadata { path: "/id:glkBw_soyGAAAAAAAADg3g" } -> 409 path/not_found
 *
 * 2. REGRESSION PINS for everything that behaviour sits on top of. There was
 *    NO dropboxService suite on main before this file, so the pre-existing
 *    contract — above all SPACE PRESERVATION — was unpinned while being edited.
 *    The firm uses leading and embedded spaces in folder names as a manual
 *    sort convention ("/  Law Office/   Cases/  Active Cases"); a helper that
 *    "helpfully" trims them silently points every path at nothing.
 *
 * No DB, no network — these are pure functions.
 *
 * Run:
 *   npx jest tests/dropboxService.normalizePath.test.js
 */

'use strict';

// credentialInjection (reached via dropboxService) throws at REQUIRE time
// without this. Any key works — nothing here decrypts anything.
process.env.CREDENTIALS_ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY ||
  require('crypto').randomBytes(32).toString('base64');

const dropbox = require('../services/dropboxService');
const { normalizePath, joinPath } = dropbox;

// Real values, so a reader can see the shapes this is actually defending.
const REAL_FILE_ID = 'id:glkBw_soyGAAAAAAAADg3g';
const REAL_REV     = 'rev:61faaf991c23e5df25139';
const FIRM_PATH    = '/  Law Office/   Cases/  Active Cases';

describe('normalizePath — handle passthrough', () => {
  test.each([
    ['file id',          REAL_FILE_ID],
    ['short id',         'id:abc'],
    ['rev handle',       REAL_REV],
    ['namespace handle', 'ns:12345'],
    ['namespace + sub',  'ns:12345/  Law Office'],
  ])('%s passes through byte-identical', (_label, handle) => {
    expect(normalizePath(handle)).toBe(handle);
  });

  test('no leading slash is added (the bug this closes)', () => {
    expect(normalizePath(REAL_FILE_ID).startsWith('/')).toBe(false);
    expect(normalizePath(REAL_FILE_ID)).not.toBe('/' + REAL_FILE_ID);
  });

  test('slash logic is skipped entirely for handles', () => {
    // A handle is OPAQUE. We do not collapse, strip or otherwise tidy it —
    // whatever Dropbox minted is what Dropbox gets back.
    expect(normalizePath('id:abc//def')).toBe('id:abc//def');
    expect(normalizePath('id:abc/')).toBe('id:abc/');
  });

  test('the prefix must be at the START — a name that merely contains one is a path', () => {
    // "id: notes.txt" sitting in a folder is a FILE NAME, not a handle.
    expect(normalizePath('  Law Office/id:notes.txt')).toBe('/  Law Office/id:notes.txt');
    expect(normalizePath('/rev: draft.docx')).toBe('/rev: draft.docx');
  });

  test('the three prefixes are exactly id:/rev:/ns: — nothing else is special', () => {
    expect(normalizePath('idx:abc')).toBe('/idx:abc');
    expect(normalizePath('nsx:abc')).toBe('/nsx:abc');
    expect(normalizePath('ID:abc')).toBe('/ID:abc'); // Dropbox mints lowercase
  });
});

describe('normalizePath — pre-existing behaviour (regression pins)', () => {
  test('SPACES ARE PRESERVED — leading, embedded, and trailing', () => {
    expect(normalizePath(FIRM_PATH)).toBe(FIRM_PATH);
    expect(normalizePath('  Law Office/   Cases')).toBe('/  Law Office/   Cases');
    expect(normalizePath('/a/ b ')).toBe('/a/ b ');
  });

  test('a leading slash is added when missing', () => {
    expect(normalizePath('a/b')).toBe('/a/b');
  });

  test('runs of slashes collapse', () => {
    expect(normalizePath('/a//b///c')).toBe('/a/b/c');
  });

  test('a single trailing slash is stripped', () => {
    expect(normalizePath('/a/b/')).toBe('/a/b');
  });

  test('root normalizes to the empty string (the API root convention)', () => {
    expect(normalizePath('/')).toBe('');
    expect(normalizePath('')).toBe('');
    expect(normalizePath(null)).toBe('');
    expect(normalizePath(undefined)).toBe('');
  });
});

describe('joinPath — unchanged by the passthrough', () => {
  test('segments keep their leading spaces', () => {
    expect(joinPath('/  Law Office', '   Cases', '  Active Cases')).toBe(FIRM_PATH);
  });

  test('empty and nullish segments are skipped', () => {
    expect(joinPath('/a', '', null, undefined, 'b')).toBe('/a/b');
  });

  test('a handle base is NOT a usable join base — documented, not supported', () => {
    // Dropbox does not resolve "id:abc/Sub" (only ns: handles take a suffix),
    // and it did not before the passthrough either ("/id:abc/Sub"). Both fail
    // loudly with path/not_found. Pinned so the next reader knows the output
    // shape is deliberate rather than an oversight, and composes destinations
    // from a resolved path_display instead.
    expect(joinPath('id:abc', 'Sub')).toBe('id:abc/Sub');
  });
});
