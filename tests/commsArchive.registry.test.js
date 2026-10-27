// tests/commsArchive.registry.test.js
//
/**
 * The comms archive sweeps reach the phone adapters through phoneService's
 * registry, never by requiring them (Fred's ruling 2026-10-27, docs-debt
 * 20261014_comms_archive_adapter_registry option (a);
 * ref/COMMS_ARCHIVE_DESIGN.md §3). The adapter declares
 * capabilities.archiveFetch; commsArchiveCommon.archiveAdapter checks it and
 * every function the calling sweep uses, and reports a failure instead of
 * returning a quiet null.
 *
 * Runs everywhere (no MySQL). The sweeps' REACTION to a failed check — the
 * alert, the stopped provider, no row claimed — is real-engine:
 * tests/commsArchive.registry.mysql.test.js.
 *   npx jest tests/commsArchive.registry.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const phoneService = require('../services/phoneService');
const common = require('../services/commsArchiveCommon');
const sweep = require('../services/commsArchiveSweep');
const media = require('../services/commsArchiveMediaSweep');
const rcAdapter = require('../services/adapters/phone/ringcentral');
const quoAdapter = require('../services/adapters/phone/quo');

const ROOT = path.join(__dirname, '..');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const RC_ALL = [...new Set([...sweep.RC_FNS, ...media.RC_FNS])];

afterEach(() => jest.restoreAllMocks());

/** The argument text of every require(…) call in `s` (balanced parens, so require(path.join(…)) is whole). */
function requireArgs(s) {
  const out = [];
  const re = /\brequire\s*\(/g;
  let m;
  while ((m = re.exec(s))) {
    let depth = 1, i = re.lastIndex;
    for (; i < s.length && depth; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
    }
    out.push(s.slice(re.lastIndex, i - 1));
  }
  return out;
}

describe('source guard', () => {
  const SWEEPS = ['services/commsArchiveSweep.js', 'services/commsArchiveMediaSweep.js'];

  test.each(SWEEPS)('%s never requires a phone adapter directly — in any spelling', (rel) => {
    const s = src(rel);
    expect(s).not.toMatch(/require\(\s*['"`][^'"`]*adapters\/phone/);
    // require(path.join(__dirname, 'adapters', 'phone', …)) and kin: 'adapters' + 'phone' inside one require
    const hits = requireArgs(s).filter(a => /adapters/.test(a) && /phone/.test(a));
    expect(hits).toEqual([]);
    // …or a path assembled beforehand: a bare 'adapters' segment has no other use in a sweep
    expect(s).not.toMatch(/['"`]adapters['"`]/);
  });

  test.each(SWEEPS)('%s reaches adapters ONLY through common.archiveAdapter — never phoneService.getAdapter itself', (rel) => {
    const s = src(rel);
    expect(s).not.toMatch(/\bgetAdapter\(/);
    expect(s).toMatch(/common\.archiveAdapter\(/);
  });

  test('the cliff sweep resolves RingCentral, the media sweep BOTH providers, through the checked path', () => {
    expect(src('services/commsArchiveSweep.js')).toMatch(/common\.archiveAdapter\('ringcentral', RC_FNS\)/);
    const m = src('services/commsArchiveMediaSweep.js');
    expect(m).toMatch(/const registryAdapter = async \(p, fns\) => \{\s*const r = common\.archiveAdapter\(p, fns\);/);
    expect(m).toContain("registryAdapter('ringcentral', RC_FNS)");
    expect(m).toContain("registryAdapter('quo', QUO_FNS)");
  });
});

describe('the adapters declare what the sweeps call', () => {
  test.each([
    ['ringcentral', rcAdapter, RC_ALL],
    ['quo', quoAdapter, media.QUO_FNS],
  ])('%s: capabilities.archiveFetch, every promised function, and the comment lists exactly them', (provider, adapter, fns) => {
    expect(adapter.capabilities.archiveFetch).toBe(true);
    for (const f of fns) expect(typeof adapter[f]).toBe('function');
    // The one-line promise above `capabilities` names the same set the sweeps use.
    const line = src(`services/adapters/phone/${provider}.js`).split('\n').find(l => /\/\/ archiveFetch \(/.test(l));
    expect(line).toBeTruthy();
    const listed = line.replace(/^.*\):\s*/, '').replace(/\.\s*$/, '').split(/,\s*/);
    expect([...listed].sort()).toEqual([...fns].sort());
  });

  test('the sweeps\' lists are the functions they actually call', () => {
    const calls = (rel, name) => [...new Set([...src(rel).matchAll(new RegExp(`\\b${name}\\.(\\w+)\\(`, 'g'))].map(m => m[1]))].sort();
    expect(calls('services/commsArchiveSweep.js', 'rc')).toEqual([...sweep.RC_FNS].sort());
    expect(calls('services/commsArchiveMediaSweep.js', 'rc')).toEqual([...media.RC_FNS].sort());
    // Quo's checkArchiveAuth is reached as `adapter.` (row.provider picks rc or quo)
    expect(calls('services/commsArchiveMediaSweep.js', 'quo')).toEqual([...media.QUO_FNS].filter(f => f !== 'checkArchiveAuth').sort());
    expect(calls('services/commsArchiveMediaSweep.js', 'adapter')).toEqual(['checkArchiveAuth']);
  });
});

describe('archiveAdapter', () => {
  test('production path: the registry\'s own adapter objects, through phoneService.getAdapter', () => {
    const spy = jest.spyOn(phoneService, 'getAdapter');
    expect(common.archiveAdapter('ringcentral', RC_ALL)).toEqual({ adapter: rcAdapter });
    expect(common.archiveAdapter('quo', media.QUO_FNS)).toEqual({ adapter: quoAdapter });
    expect(spy.mock.calls).toEqual([['ringcentral'], ['quo']]);
  });

  const fake = (over = {}) => ({
    capabilities: { sms: true, archiveFetch: true },
    checkArchiveAuth() {}, fetchRecordingContent() {}, findSessionRecordings() {},
    ...over,
  });
  const FNS = ['checkArchiveAuth', 'findSessionRecordings', 'fetchRecordingContent'];

  test('a well-formed adapter from the registry is returned as is', () => {
    const a = fake();
    jest.spyOn(phoneService, 'getAdapter').mockReturnValue(a);
    expect(common.archiveAdapter('ringcentral', FNS)).toEqual({ adapter: a });
  });

  test.each([
    ['no adapter in the registry', null, /no ringcentral adapter in phoneService's registry/],
    ['archiveFetch false', fake({ capabilities: { sms: true, archiveFetch: false } }), /does not declare capabilities\.archiveFetch/],
    ['archiveFetch truthy but not true', fake({ capabilities: { archiveFetch: 1 } }), /does not declare capabilities\.archiveFetch/],
    ['no capabilities at all', fake({ capabilities: undefined }), /does not declare capabilities\.archiveFetch/],
    ['a promised function missing', fake({ fetchRecordingContent: undefined }), /declares archiveFetch but lacks fetchRecordingContent$/],
    ['a promised function not a function', fake({ findSessionRecordings: 'x', fetchRecordingContent: null }), /lacks findSessionRecordings, fetchRecordingContent$/],
  ])('fails LOUD — an error, never an adapter: %s', (_label, returned, msg) => {
    jest.spyOn(phoneService, 'getAdapter').mockReturnValue(returned);
    const r = common.archiveAdapter('ringcentral', FNS);
    expect(r.adapter).toBeUndefined();
    expect(r.error).toMatch(msg);
  });
});

describe('adapterAlert', () => {
  test('error severity from the first occurrence, one row per provider per sweep per day', async () => {
    const sent = [];
    jest.spyOn(require('../lib/alerting'), 'alert').mockImplementation(async (_db, o) => { sent.push(o); });
    await common.adapterAlert({}, { provider: 'quo', sweep: 'comms_archive_media_sweep', error: 'boom' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: 'comms_archive_adapter', group_key: 'comms_archive_adapter:quo', severity: 'error',
      context: { provider: 'quo', sweep: 'comms_archive_media_sweep', error: 'boom' },
      dedup_key: `comms_archive_adapter:quo:comms_archive_media_sweep:${new Date().toISOString().slice(0, 10)}`,
    });
    expect(sent[0].message).toMatch(/^boom \(comms_archive_media_sweep\)\. No quo row was claimed/);
  });
});
