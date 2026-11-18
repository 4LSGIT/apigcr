// tests/storageSeamD3eConfiguredProvider.test.js
//
/**
 * storage-seam D3e — the CONFIGURED provider (app_settings storage_provider),
 * documentSourceService.configured(): a process-cached name every writer and
 * reader resolves its provider through (`sources.get(sources.configured())`).
 *   - the default is 'dropbox'; an absent / blank row keeps the default;
 *   - a value naming no registered provider is REFUSED (warned, previous kept);
 *   - refreshConfigured(db) reads the row through settingsService and never
 *     throws (a failed read keeps the current value);
 *   - the wiring: server.js refreshes at boot; the settings API's write path
 *     refreshes after a changed storage_provider row (pinned by text — the
 *     route's writeValue is driven in tests/appSettingsRegistry.test.js);
 *   - no writer names 'dropbox' as its provider any more (the sync engine does,
 *     by design: it is Dropbox-native until D4).
 */

'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../services/settingsService', () => ({ getSetting: jest.fn() }));
const settings = require('../services/settingsService');
const sources = require('../services/documentSourceService');

afterEach(() => { sources._setConfigured('dropbox'); jest.clearAllMocks(); });

test('the default is dropbox; the built-in provider is registered under it', () => {
  expect(sources.CONFIGURED_KEY).toBe('storage_provider');
  expect(sources.configured()).toBe('dropbox');
  expect(sources.list()).toContain('dropbox');
  expect(sources.get(sources.configured())).toBe(sources.get('dropbox'));
});

test('_setConfigured: blank → the default; a registered name is taken; an unregistered name is refused with a warning and the previous value kept', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    sources.register('gcs_test', { stat: async () => null });
    expect(sources._setConfigured('gcs_test')).toBe(true);
    expect(sources.configured()).toBe('gcs_test');
    expect(sources._setConfigured('box')).toBe(false);
    expect(sources.configured()).toBe('gcs_test');
    expect(warn.mock.calls.some((c) => /storage_provider "box" names no registered provider/.test(String(c[0])))).toBe(true);
    expect(sources._setConfigured('  ')).toBe(true);
    expect(sources.configured()).toBe('dropbox');
    expect(sources._setConfigured(null)).toBe(true);
    expect(sources.configured()).toBe('dropbox');
  } finally { warn.mockRestore(); }
});

test('refreshConfigured reads app_settings storage_provider through settingsService; a failed read keeps the current value and never throws', async () => {
  settings.getSetting.mockResolvedValueOnce(' dropbox ');
  expect(await sources.refreshConfigured({})).toBe(true);
  expect(settings.getSetting).toHaveBeenCalledWith({}, 'storage_provider');
  expect(sources.configured()).toBe('dropbox');
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    settings.getSetting.mockRejectedValueOnce(new Error('pool is on fire'));
    expect(await sources.refreshConfigured({})).toBe(false);
    expect(sources.configured()).toBe('dropbox');
    settings.getSetting.mockResolvedValueOnce('nope');
    expect(await sources.refreshConfigured({})).toBe(false);
    expect(sources.configured()).toBe('dropbox');
  } finally { warn.mockRestore(); }
});

test('the wiring: boot refreshes once the pool exists; the settings write path refreshes after a changed storage_provider row', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  expect(server).toMatch(/const db = require\("\.\/startup\/db"\);\n[^\n]*\n?require\('\.\/services\/documentSourceService'\)\.refreshConfigured\(db\)/);
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'api.appSettings.js'), 'utf8');
  expect(route).toMatch(/if \(out\.changed && key === 'storage_provider'\) await require\('\.\.\/services\/documentSourceService'\)\.refreshConfigured\(req\.db\);/);
});

test('no writer or reader names dropbox as its provider any more — every one resolves through configured(); the sync engine (Dropbox-native until D4) is the one exception', () => {
  const root = path.join(__dirname, '..');
  const files = [];
  for (const dir of ['services', 'routes', 'lib']) {
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
    walk(path.join(root, dir));
  }
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    if (/documentSourceService'\)\.get\('dropbox'\)|sources\.get\('dropbox'\)|documentSources\(\)\.get\('dropbox'\)|STORAGE_SOURCE = 'dropbox'|SOURCE_PROVIDER = 'dropbox'/.test(src)) offenders.push(path.relative(root, f));
    if (/^const SOURCE = 'dropbox';/m.test(src) && !/documentSyncService\.js$/.test(f)) offenders.push(path.relative(root, f));
  }
  expect(offenders).toEqual([]);
});
