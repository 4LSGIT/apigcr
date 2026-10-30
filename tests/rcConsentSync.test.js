/**
 * tests/rcConsentSync.test.js — YisraMail P2 (ref/YISRAMAIL_DESIGN.md §4.6)
 *
 * The read-only RingCentral consent reconcile:
 *   - the adapter's translation (services/adapters/phone/ringcentral.js
 *     listConsents / _mapConsentRecord — the ONLY place RC's consent
 *     vocabulary exists): the request it sends and what it returns;
 *   - phoneConsentService.syncRcConsents: fail-closed on
 *     sms_rc_consent_sync_enabled, the dry run, the lock, pagination by
 *     nextPageToken, one provider_optout per opted-out pair keyed
 *     '<provider>:consent:<from>:<to>:<lastModified>', the state guard (an old
 *     opt-out never overwrites a newer START), and an RC failure alerting
 *     warning-then-error.
 *
 * FIXTURE PROVENANCE: the record / paging shapes below are RingCentral's own
 * spec types (ringcentral-extensible 1.8.6: SmsOptRecord {from, to,
 * optStatus, source, lastModifiedTime}, NonEnumeratedPagingModel
 * {nextPageToken …}) — NOT a captured live response. P2 step 0 (c),
 * 2026-10-29, got no records: both POST …/sms/consents/search and GET
 * …/sms/consents answered 403 CMN-408 (RC_403_BODY below is that body
 * verbatim) — the connected RC user lacks the permission. RC_FIXTURE is
 * replaced by a real capture before sms_rc_consent_sync_enabled is ever '1'.
 */
'use strict';

jest.mock('../services/settingsService', () => ({ getSetting: jest.fn(), getSettings: jest.fn() }));
jest.mock('../services/taskService', () => ({ createTask: jest.fn(async () => ({ task_id: 7000 })) }));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));
jest.mock('../lib/credentialInjection', () => ({ buildHeadersForCredential: jest.fn(async () => ({ Authorization: 'Bearer t' })) }));

const settingsService = require('../services/settingsService');
const alerting = require('../lib/alerting');
const rc = require('../services/adapters/phone/ringcentral');
const phoneService = require('../services/phoneService');
const svc = require('../services/phoneConsentService');
const { makePhoneConsentWorld } = require('./helpers/phoneConsentWorld');

const PAT = '3135550001';
const RC_403_BODY = '{"errorCode":"CMN-408","message":"Unauthorized access","errors":[{"errorCode":"CMN-408","message":"Unauthorized access"}]}';   // captured live, step 0 (c)
const RC_FIXTURE = {   // SDK-shaped (see header) — replaced by a real capture
  records: [
    { from: '+12485592400', to: '+13135550001', optStatus: 'OptOut', source: 'Recipient', lastModifiedTime: '2026-10-01T12:00:00.000Z' },
    { from: '+12486213656', to: '+13135550002', optStatus: 'OptOut', source: 'Carrier', lastModifiedTime: '2026-09-15T08:30:00.000Z' },
  ],
  paging: { perPage: 1000, pageToken: 'p1', nextPageToken: 'p2' },
};

describe('ringcentral listConsents (the adapter owns the vocabulary)', () => {
  let fetchSpy;
  afterEach(() => fetchSpy && fetchSpy.mockRestore());

  test('POSTs the search with optStatus, coverage PhoneNumber+Account, perPage, pageToken; maps the records', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(RC_FIXTURE), { status: 200, headers: { 'x-rate-limit-group': 'Light' } }));
    const r = await rc.listConsents({}, { credentialId: 9, status: 'opt_out', pageToken: 'p1', perPage: 5000 });
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://platform.ringcentral.com/restapi/v2/accounts/~/sms/consents/search');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ optStatus: 'OptOut', coverage: ['PhoneNumber', 'Account'], perPage: 1000, pageToken: 'p1' });
    expect(opts.headers).toMatchObject({ Authorization: 'Bearer t', 'Content-Type': 'application/json' });
    expect(r).toMatchObject({ status: 200, nextPageToken: 'p2', errorText: null });
    expect(r.rate.group).toBe('Light');
    expect(r.records).toEqual([
      { from: '2485592400', to: '3135550001', status: 'opt_out', source: 'Recipient', at: '2026-10-01T12:00:00.000Z' },
      { from: '2486213656', to: '3135550002', status: 'opt_out', source: 'Carrier', at: '2026-09-15T08:30:00.000Z' },
    ]);
  });

  test('a non-200 is returned, never thrown; a 200 without records is shape drift (502)', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(RC_403_BODY, { status: 403 }))
      .mockResolvedValueOnce(new Response('{"items":[]}', { status: 200 }));
    expect(await rc.listConsents({}, { credentialId: 9 })).toMatchObject({ status: 403, records: [], errorText: expect.stringContaining('CMN-408') });
    expect(await rc.listConsents({}, { credentialId: 9 })).toMatchObject({ status: 502, records: [] });
  });

  test('_mapConsentRecord: an unknown optStatus maps to null; no recipient → dropped', () => {
    expect(rc._mapConsentRecord({ to: '+13135550001', optStatus: 'Maybe' }).status).toBeNull();
    expect(rc._mapConsentRecord({ from: '+12485592400' })).toBeNull();
    expect(rc.capabilities.consentList).toBe(true);
    expect(require('../services/adapters/phone/quo').capabilities.consentList).toBeUndefined();
  });
});

// ─── syncRcConsents ─────────────────────────────────────────────────────────

function world({ locked = false, states = [] } = {}) {
  return makePhoneConsentWorld({
    contacts: [{ contact_id: 1, contact_name: 'Pat Client' }],
    phones: [{ id: 11, contact_id: 1, phone: PAT }],
    states,
    extra: async (s) => {
      if (/GET_LOCK/.test(s)) return [[{ got: locked ? 0 : 1 }]];
      if (/RELEASE_LOCK/.test(s)) return [[{ r: 1 }]];
      if (/^SELECT provider, credential_id FROM phone_lines/.test(s)) return [[{ provider: 'ringcentral', credential_id: 9 }, { provider: 'quo', credential_id: 10 }]];
      if (/system_alerts/.test(s)) return [[]];
      return undefined;
    },
  });
}

let spy;
function arm(pages) {
  const calls = [];
  spy = jest.spyOn(phoneService, 'getAdapter').mockImplementation((p) => (p === 'ringcentral' ? {
    capabilities: { consentList: true },
    async listConsents(_db, args) {
      calls.push(args);
      const i = args.pageToken ? Number(args.pageToken.slice(1)) - 1 : 0;
      return pages[i];
    },
  } : { capabilities: { sms: true } }));
  return calls;
}
const page = (records, next = null) => ({ status: 200, records, nextPageToken: next, rate: {}, errorText: null });
const recOut = (to, at, from = '2485592400') => ({ from, to, status: 'opt_out', source: 'Recipient', at });

beforeEach(() => {
  jest.clearAllMocks();
  settingsService.getSetting.mockImplementation(async (_db, k) => ({ [svc.RC_SYNC_ENABLED_KEY]: '1' }[k] ?? null));
  settingsService.getSettings.mockImplementation(async (_db, keys) => Object.fromEntries(keys.map((k) => [k, k === svc.ASSIGNEE_KEY ? '22' : null])));
});
afterEach(() => { if (spy) spy.mockRestore(); spy = null; });

test('fail-closed: the setting not "1" → skipped, nothing listed', async () => {
  settingsService.getSetting.mockImplementation(async () => null);
  const calls = arm([page([])]);
  const out = await svc.syncRcConsents(world().pdb);
  expect(out).toMatchObject({ enabled: false, skipped: `${svc.RC_SYNC_ENABLED_KEY} is not "1"`, groups: 0 });
  expect(calls).toEqual([]);
});

test('the lock held elsewhere → skipped, nothing listed', async () => {
  const calls = arm([page([])]);
  const out = await svc.syncRcConsents(world({ locked: true }).pdb);
  expect(out.skipped).toBe('locked');
  expect(calls).toEqual([]);
});

test('pages by nextPageToken; one provider_optout per pair, keyed by pair + last-modified; a re-run records nothing', async () => {
  const W = world();
  const calls = arm([
    page([recOut(PAT, '2026-10-01T12:00:00.000Z'), recOut('3135550002', '2026-09-15T08:30:00.000Z', '2486213656')], 'p2'),
    page([recOut('3135550003', '2026-08-01T00:00:00.000Z'), { from: '*', to: '72345', status: 'opt_out', source: 'Api', at: null }, recOut('3135550004', null)]),
  ]);
  const out = await svc.syncRcConsents(W.pdb);
  expect(calls.map((c) => [c.status, c.pageToken, c.perPage])).toEqual([['opt_out', null, 1000], ['opt_out', 'p2', 1000]]);
  expect(out).toMatchObject({ enabled: true, groups: 1, pages: 2, listed: 5, recorded: 4, ignored: 1, duplicates: 0 });
  expect(W.events.map((e) => [e.source, e.destination, e.provider_event_id, e.line_number])).toEqual([
    ['provider_optout', PAT, `ringcentral:consent:2485592400:${PAT}:2026-10-01T12:00:00.000Z`, '2485592400'],
    ['provider_optout', '3135550002', 'ringcentral:consent:2486213656:3135550002:2026-09-15T08:30:00.000Z', '2486213656'],
    ['provider_optout', '3135550003', 'ringcentral:consent:2485592400:3135550003:2026-08-01T00:00:00.000Z', '2485592400'],
    ['provider_optout', '3135550004', 'ringcentral:consent:2485592400:3135550004:unknown', '2485592400'],
  ]);
  expect(new Date(W.events[0].occurred_at).toISOString()).toBe('2026-10-01T12:00:00.000Z');
  expect(W.events[0].evidence).toMatchObject({ via: 'consent_reconcile', provider: 'ringcentral', provider_source: 'Recipient' });

  arm([page([recOut(PAT, '2026-10-01T12:00:00.000Z')])]);
  const again = await svc.syncRcConsents(W.pdb);
  expect(again).toMatchObject({ recorded: 0, duplicates: 1 });
  expect(W.events).toHaveLength(4);
});

test('the guard: an OLD opt-out from the list never overwrites a newer START', async () => {
  const W = world({ states: [{ channel: 'sms', destination: PAT, scope: 'all', state: 'opted_in', occurred_at: new Date('2026-10-20T00:00:00Z'), last_event_id: 0 }] });
  arm([page([recOut(PAT, '2026-10-01T12:00:00.000Z')])]);
  const out = await svc.syncRcConsents(W.pdb);
  expect(out.recorded).toBe(1);                         // the proof is kept…
  expect(W.state('sms', PAT, 'all').state).toBe('opted_in');   // …the newer decision stands
});

test('dry run: counts what would be recorded, writes nothing, runs with the setting off', async () => {
  settingsService.getSetting.mockImplementation(async () => null);
  const W = world();
  arm([page([recOut(PAT, '2026-10-01T12:00:00.000Z'), recOut('3135550002', '2026-09-15T08:30:00.000Z')])]);
  const out = await svc.syncRcConsents(W.pdb, { dryRun: true });
  expect(out).toMatchObject({ enabled: false, dry_run: true, skipped: null, would_record: 2, recorded: 0 });
  expect(W.events).toEqual([]);
});

test('an RC failure: recorded in errors, alerted warning first then error on a repeat; 429 parks without alerting', async () => {
  const W = world();
  arm([{ status: 403, records: [], nextPageToken: null, rate: {}, errorText: 'CMN-408' }]);
  const out = await svc.syncRcConsents(W.pdb);
  expect(out.errors[0]).toMatch(/listConsents 403 on page 1: CMN-408/);
  expect(alerting.alert.mock.calls[0][1]).toMatchObject({ severity: 'warning', group_key: 'sms_consent_reconcile:ringcentral:9' });

  alerting.alert.mockClear();
  const W2 = makePhoneConsentWorld({ extra: async (s) => {
    if (/GET_LOCK|RELEASE_LOCK/.test(s)) return [[{ got: 1 }]];
    if (/^SELECT provider, credential_id FROM phone_lines/.test(s)) return [[{ provider: 'ringcentral', credential_id: 9 }]];
    if (/FROM system_alerts/.test(s)) return [[{ hit: 1 }]];   // yesterday's alert is still there
    return undefined;
  } });
  arm([{ status: 500, records: [], nextPageToken: null, rate: {}, errorText: 'boom' }]);
  await svc.syncRcConsents(W2.pdb);
  expect(alerting.alert.mock.calls[0][1]).toMatchObject({ severity: 'error' });

  alerting.alert.mockClear();
  arm([{ status: 429, records: [], nextPageToken: null, rate: {}, errorText: '' }]);
  const parked = await svc.syncRcConsents(world().pdb);
  expect(parked.errors[0]).toMatch(/429 on page 1 \(parked\)/);
  expect(alerting.alert).not.toHaveBeenCalled();
});
