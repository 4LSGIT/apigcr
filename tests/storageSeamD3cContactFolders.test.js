// tests/storageSeamD3cContactFolders.test.js
//
/**
 * storage-seam D3c-2 — contact folders, over scripted db / provider stubs:
 *   - contactFolderTemplates: storage_folders.contact → the block; null, a row
 *     without it, a non-object, a blank default, NO row → null (the platform
 *     default reaches a tenant through the provisioned row, never this code).
 *   - ensureContactFolder: { enabled:false } makes NO provider call and NO
 *     binding write; a bound contact returns its binding (no provider call when
 *     the binding carries a path); an unbound one is adopted or created and
 *     bound (kind 'contact'); an unknown contact throws.
 *   - entityFolderService.contactFolder's shape.
 * The real-provider behaviour (created, reused, nested under via
 * {{contact_folder}}) is tests/storageReplay.test.js scenario 18.
 */

'use strict';

jest.mock('../services/documentSourceService', () => {
  const provider = {
    context: jest.fn(async () => ({ credentialId: 8 })),
    stat: jest.fn(), ensureSharedLink: jest.fn(), ensureFolder: jest.fn(), resolveHumanLink: jest.fn(),
    isNotFound: (e) => !!(e && e.notFound),
  };
  return { get: () => provider, __provider: provider };
});
jest.mock('../services/timezoneService', () => ({ nowLocal: () => ({ toFormat: () => '2026-11-18' }) }));

const caseService = require('../services/caseService');
const entityFolders = require('../services/entityFolderService');
const provider = require('../services/documentSourceService').__provider;

function dbWith({ settings = {}, binding, contact } = {}) {
  const writes = [];
  return {
    writes,
    query: jest.fn(async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      let m = s.match(/FROM app_settings WHERE `key` = '([a-z_]+)'/);
      if (m) return [settings[m[1]] == null ? [] : [{ value: settings[m[1]] }], []];
      if (/^SELECT \* FROM entity_folders WHERE entity_kind = \?/.test(s)) return [binding && params[0] === 'contact' ? [binding] : [], []];
      if (/^SELECT contact_id, contact_name, contact_lfm_name FROM contacts WHERE contact_id = \?/.test(s)) return [contact ? [contact] : [], []];
      if (/^INSERT INTO entity_folders/.test(s)) { writes.push(params); return [{ affectedRows: 1 }]; }
      throw new Error('unexpected SQL: ' + s.slice(0, 80));
    }),
  };
}
const TREE = { case: { potential: { default: '{{contact_folder}}/{{number}}', subfolders: [] } }, contact: { default: '/Clients/{{lfm_name}}', subfolders: ['Intake'] } };
beforeEach(() => { for (const k of ['stat', 'ensureSharedLink', 'ensureFolder', 'resolveHumanLink']) provider[k].mockReset(); });

describe('contactFolderTemplates', () => {
  test.each([
    ['the block', { storage_folders: JSON.stringify(TREE) }, TREE.contact],
    ['contact: null', { storage_folders: JSON.stringify({ case: TREE.case, contact: null }) }, null],
    ['no contact key', { storage_folders: JSON.stringify({ case: TREE.case }) }, null],
    ['not an object', { storage_folders: JSON.stringify({ contact: 'x' }) }, null],
    ['a blank default', { storage_folders: JSON.stringify({ contact: { default: '  ' } }) }, null],
    ['no row', {}, null],
    ['bad JSON', { storage_folders: '{nope' }, null],
  ])('%s', async (_l, settings, out) => {
    expect(await caseService.contactFolderTemplates(dbWith({ settings }))).toEqual(out);
  });
});

describe('ensureContactFolder', () => {
  test('contact folders off: { enabled:false }, no provider call, no binding write', async () => {
    const db = dbWith({ settings: { storage_folders: JSON.stringify({ contact: null }) } });
    expect(await caseService.ensureContactFolder(db, 502)).toEqual({ enabled: false });
    expect(db.writes).toEqual([]);
    for (const k of ['stat', 'ensureSharedLink', 'ensureFolder', 'resolveHumanLink']) expect(provider[k]).not.toHaveBeenCalled();
  });
  test('a bound contact with a path: its binding, no provider call; with a link only: the path resolved from the link', async () => {
    const settings = { storage_folders: JSON.stringify(TREE) };
    const b = { human_link: 'https://l/1', external_id: 'id:c1', path_lower: '/clients/doe, jane', path_display: '/Clients/Doe, Jane' };
    expect(await caseService.ensureContactFolder(dbWith({ settings, binding: b }), 502)).toEqual({ enabled: true, existed: true, path: '/Clients/Doe, Jane', shared_link: 'https://l/1' });
    expect(provider.resolveHumanLink).not.toHaveBeenCalled();
    provider.resolveHumanLink.mockResolvedValue('/clients/doe, jane');
    expect(await caseService.ensureContactFolder(dbWith({ settings, binding: { human_link: 'https://l/1' } }), 502)).toMatchObject({ existed: true, path: '/clients/doe, jane' });
    expect(provider.resolveHumanLink).toHaveBeenCalledWith(expect.anything(), 'https://l/1', { expectFolder: true }, { credentialId: 8 });
  });
  test('an unbound contact: created from the template with its subfolders, bound as kind contact with link + handle + path', async () => {
    provider.stat.mockRejectedValue(Object.assign(new Error('nf'), { notFound: true }));
    provider.ensureFolder.mockResolvedValue({ path: '/Clients/Doe, Jane', existed: false, subfolders: ['Intake'], humanLink: 'https://l/new', externalId: 'id:new' });
    const db = dbWith({ settings: { storage_folders: JSON.stringify(TREE) }, contact: { contact_id: 502, contact_name: 'Jane Doe', contact_lfm_name: 'Doe, Jane' } });
    const r = await caseService.ensureContactFolder(db, 502);
    expect(r).toEqual({ enabled: true, existed: false, path: '/Clients/Doe, Jane', shared_link: 'https://l/new', folder_existed: false, subfolders_created: ['Intake'] });
    expect(provider.ensureFolder).toHaveBeenCalledWith(expect.anything(), { path: '/Clients/Doe, Jane' }, { subfolders: ['Intake'], humanLink: true });
    expect(db.writes).toEqual([['contact', '502', 'dropbox', 'id:new', '/clients/doe, jane', '/Clients/Doe, Jane', 'https://l/new']]);
  });
  test('an existing folder at the templated path is adopted (link taken), never duplicated; an unknown contact throws', async () => {
    provider.stat.mockResolvedValue({ '.tag': 'folder', id: 'id:old' });
    provider.ensureSharedLink.mockResolvedValue('https://l/old');
    const db = dbWith({ settings: { storage_folders: JSON.stringify(TREE) }, contact: { contact_id: 502, contact_name: 'Jane Doe', contact_lfm_name: 'Doe, Jane' } });
    expect(await caseService.ensureContactFolder(db, 502)).toMatchObject({ existed: false, folder_existed: true, shared_link: 'https://l/old', path: '/Clients/Doe, Jane' });
    expect(provider.ensureFolder).not.toHaveBeenCalled();
    expect(db.writes[0][3]).toBe('id:old');
    await expect(caseService.ensureContactFolder(dbWith({ settings: { storage_folders: JSON.stringify(TREE) } }), 999)).rejects.toThrow(/contact 999 not found/);
  });
});

test('entityFolderService.contactFolder: bound iff the row carries a link; the handle and paths ride along', async () => {
  const one = (row) => ({ query: jest.fn(async () => [row ? [row] : [], []]) });
  expect(await entityFolders.contactFolder(one({ human_link: ' https://l ', external_id: 'id:1', path_lower: '/a', path_display: '/A' }), 5)).toEqual({ bound: true, link: 'https://l', externalId: 'id:1', pathLower: '/a', pathDisplay: '/A' });
  expect(await entityFolders.contactFolder(one({ human_link: null, external_id: null, path_lower: null, path_display: null }), 5)).toEqual({ bound: false, link: null, externalId: null, pathLower: null, pathDisplay: null });
  expect(await entityFolders.contactFolder(one(null), 5)).toMatchObject({ bound: false });
  const db = one(null); await entityFolders.contactFolder(db, 7, { source: 'gcs' });
  expect(db.query.mock.calls[0][1]).toEqual(['contact', '7', 'gcs']);
});
