// tests/storageDefaults.test.js
//
/**
 * storage-seam D2 — the storage defaults live in ONE place and the credential
 * has none.
 *
 *   - lib/storageDefaults.js is the registry's `default` for each storage key,
 *     and what every writer exports as its DEFAULT — no literal in a writer;
 *   - dropboxService._resolveCredential REFUSES without a row (no "8" fallback):
 *     the old default was 4LSG's credential, and on another tenant it would be
 *     a missing row or someone else's credential; opts still win, a row still wins.
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');

const { STORAGE_DEFAULTS } = require('../lib/storageDefaults');
const registry = require('../lib/settingsRegistry');
const dropbox = require('../services/dropboxService');

const STORAGE_KEYS = [
  'dropbox_unsorted_uploads_path', 'dropbox_unsorted_forms_path', 'dropbox_unsorted_generated_path',
  'dropbox_unsorted_esign_path', 'dropbox_unsorted_court_docs_path',
  'storage_folders',   // D3c: the v3 tree — the PLATFORM default (nested contact → case); 4LSG's row is seeded case-only. dropbox_case_folder_templates is no longer a registry key (D3c-3); its leaf stays as the code default behind storage_folders.case
];

test('the registry default of every storage key IS the leaf value, frozen; the credential has none', () => {
  for (const k of STORAGE_KEYS) {
    expect(registry.defaultOf(k)).toBe(STORAGE_DEFAULTS[k]);
    expect(registry.get(k).default).toBe(STORAGE_DEFAULTS[k]);
  }
  expect(Object.isFrozen(STORAGE_DEFAULTS)).toBe(true);
  expect(Object.isFrozen(STORAGE_DEFAULTS.dropbox_case_folder_templates.active.subfolders)).toBe(true);
  expect(Object.isFrozen(STORAGE_DEFAULTS.storage_folders.case.active)).toBe(true);
  // D3c-1: the platform default is the nested tree (design §6; Fred 2026-11-17: {{case_type_full}}, contact /Clients/{{lfm_name}}) — NOT 4LSG's layout
  expect(STORAGE_DEFAULTS.storage_folders).toEqual({
    case: { potential: { default: '{{contact_folder}}/{{number}} - {{case_type_full}}', subfolders: [] }, active: { default: '{{contact_folder}}/{{number}} - {{case_type_full}}', subfolders: [] } },
    contact: { default: '/Clients/{{lfm_name}}', subfolders: [] },
  });
  expect(registry.get('storage_folders')).toMatchObject({ kind: 'firm', home: 'firm', section: 'storage', type: 'json', editor: 'storageFolders' });
  expect(registry.get('storage_folders').edit).not.toBe('console');   // D3c-3: a UI row (the editor), no longer console-only
  expect(registry.get('dropbox_case_folder_templates')).toBeFalsy();   // D3c-3: retired (the registry answers null for an unknown key)
  expect(registry.defaultOf('dropbox_credential_id')).toBeUndefined();
  expect(registry.defaultOf('no_such_key')).toBeUndefined();
  expect(registry.get('dropbox_unsorted_court_docs_path')).toMatchObject({ kind: 'firm', home: 'firm', section: 'storage', type: 'string' });
  // D3e: the provider is the firm's choice (Document storage); D3e-2 (Fred, 2026-11-18): the credential it connects
  // with is platform wiring and lives with the other integration credentials on System → Integrations
  expect(registry.get('storage_provider')).toMatchObject({ kind: 'firm', home: 'firm', section: 'storage', type: 'enum', options: ['dropbox'], default: 'dropbox' });
  expect(registry.get('dropbox_credential_id')).toMatchObject({ kind: 'system', home: 'system', section: 'integrations', type: 'credential' });
});

test('every writer exports the registry default as its DEFAULT — the literal left the services', () => {
  expect(require('../services/uploadTargetService').DEFAULT_UNSORTED_PATH).toBe(STORAGE_DEFAULTS.dropbox_unsorted_uploads_path);
  expect(require('../services/formPdfService').DEFAULT_UNSORTED_PATH).toBe(STORAGE_DEFAULTS.dropbox_unsorted_forms_path);
  expect(require('../services/documentGenerateService').DEFAULT_UNSORTED_PATH).toBe(STORAGE_DEFAULTS.dropbox_unsorted_generated_path);
  expect(require('../services/esignFilingService').DEFAULT_UNSORTED_PATH).toBe(STORAGE_DEFAULTS.dropbox_unsorted_esign_path);
  expect(require('../services/caseService').DEFAULT_CASE_FOLDER_TEMPLATES).toBe(STORAGE_DEFAULTS.dropbox_case_folder_templates);
  // every double space, byte for byte (the firm's manual sort order)
  expect(STORAGE_DEFAULTS.dropbox_unsorted_uploads_path).toBe('/  Law Office/   Cases/  Unsorted Client Uploads');
  expect(STORAGE_DEFAULTS.dropbox_unsorted_court_docs_path).toBe('/  Law Office/   Cases/ _Unfiled Court Docs');
  expect(STORAGE_DEFAULTS.dropbox_case_folder_templates.potential.default).toBe('/  Law Office/   Cases/  Potential Cases/  Potential - {{case_type}}/ {{lfm_name}} - {{case_id}} - {{date}}');
});

describe('_resolveCredential fails closed', () => {
  const dbWith = (rows) => ({ query: jest.fn(async () => [rows, []]) });
  test('opts win without a query; a row wins; the row is returned as stored', async () => {
    const db = dbWith([{ value: '21' }]);
    expect(await dropbox._resolveCredential(db, { credentialId: 5 })).toBe(5);
    expect(db.query).not.toHaveBeenCalled();
    expect(await dropbox._resolveCredential(db, {})).toBe('21');
    expect(db.query.mock.calls[0][0]).toMatch(/dropbox_credential_id/);
  });
  test('no row, or a blank row, REFUSES with a coded, named error — never a default', async () => {
    for (const rows of [[], [{ value: '' }], [{ value: '   ' }], [{ value: null }]]) {
      const err = await dropbox._resolveCredential(dbWith(rows), {}).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe('STORAGE_CREDENTIAL_MISSING');
      expect(err.message).toBe(dropbox.CREDENTIAL_MISSING);
      expect(err.message).toMatch(/dropbox_credential_id/);
    }
    expect(dropbox.DEFAULT_CREDENTIAL_ID).toBeUndefined();
  });
  test('a failing lookup is the caller\'s error, not a silent default', async () => {
    const db = { query: jest.fn(async () => { throw new Error('ECONNREFUSED'); }) };
    await expect(dropbox._resolveCredential(db, {})).rejects.toThrow('ECONNREFUSED');
  });
});
