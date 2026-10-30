/**
 * tests/phoneDelivery.consent.test.js — YisraMail P2 (ref/YISRAMAIL_DESIGN.md §4.6)
 *
 * phoneDeliveryService.runSync → the consent ledger: a provider 'opted_out'
 * verdict (RingCentral SMS-RC/UP/CAR-413) is consent evidence.
 *   - a stamp INTO opted_out records ONE provider_optout event (scope all,
 *     '<provider>:<ref>', the text's send time, the sending line);
 *   - the next run re-lists the same verdict: nothing more is recorded (the
 *     ledger lookup), and no lock is taken;
 *   - a verdict whose earlier write failed is recorded on the next sighting
 *     even though the stamp itself no longer changes (self-healing);
 *   - a non-413 failure, a delivered text and an in-flight text record
 *     nothing;
 *   - a backfill records but opens no staff task; a live run does (once).
 * Real phoneDeliveryService + phoneConsentService + optoutService over the
 * in-memory world (tests/helpers/phoneConsentWorld.js); mocked: settings,
 * ingest, dispatch, tasks, alerting, the adapter (fixture).
 */
'use strict';

jest.mock('../services/settingsService', () => ({ getSetting: jest.fn(), getSettings: jest.fn() }));
jest.mock('../services/phoneIngestService', () => ({ ingestPhoneEvent: jest.fn(async () => ({ log_id: 1 })) }));
jest.mock('../lib/actionDispatchers', () => ({ dispatchWorkflow: jest.fn() }));
jest.mock('../services/taskService', () => ({ createTask: jest.fn(async () => ({ task_id: 7000 })) }));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));

const settingsService = require('../services/settingsService');
const taskService = require('../services/taskService');
const alerting = require('../lib/alerting');
const phoneService = require('../services/phoneService');
const delivery = require('../services/phoneDeliveryService');
const consent = require('../services/phoneConsentService');
const { makePhoneConsentWorld } = require('./helpers/phoneConsentWorld');

const LINE = '2485592400';
const PAT = '3135550001';

function world({ stamped = new Map() } = {}) {
  // phone_event_log rows by provider_ref: what the previous runs stamped.
  const rows = stamped;
  return makePhoneConsentWorld({
    contacts: [{ contact_id: 1, contact_name: 'Pat Client' }],
    phones: [{ id: 11, contact_id: 1, phone: PAT }],
    cases: [{ contact_id: 1, case_id: 'C100', relate_type: 'Primary', stage: 'Open' }],
    extra: async (s, p) => {
      if (/GET_LOCK|RELEASE_LOCK/.test(s)) return [[{ got: 1 }]];
      if (/^SELECT provider, credential_id FROM phone_lines/.test(s)) return [[{ provider: 'ringcentral', credential_id: 9 }]];
      if (/^SELECT phone_number FROM phone_lines/.test(s)) return [[{ phone_number: LINE }]];
      if (/^SELECT id, provider_ref, delivery_state/.test(s)) {
        return [p[1].filter((ref) => rows.has(ref)).map((ref, i) => ({ id: i + 1, provider_ref: ref, ...rows.get(ref) }))];
      }
      if (/^UPDATE phone_event_log SET delivery_state/.test(s)) {
        rows.set(p[4], { delivery_state: p[0], delivery_reason: p[1], delivery_code: p[2] });
        return [{ affectedRows: 1 }];
      }
      if (/system_alerts/.test(s)) return [[]];
      return undefined;
    },
  });
}

const REC = (over = {}) => ({
  provider: 'ringcentral', provider_ref: 'out-1', from: LINE, to: PAT, body: 'Your payment is due',
  ts: '2026-10-28T14:00:00.000Z', conversation_id: 'c', attachments: [],
  delivery: { state: 'failed', reason: 'opted_out', provider_code: 'SMS-RC-413' },
  ...over,
});

let spy;
function arm(records) {
  spy = jest.spyOn(phoneService, 'getAdapter').mockImplementation((p) => (p === 'ringcentral' ? {
    capabilities: { sms: true, outboundSync: true },
    async listOutbound() { return { status: 200, records, page: 1, totalPages: 1, rate: {}, errorText: null }; },
  } : null));
}

beforeEach(() => {
  jest.clearAllMocks();
  settingsService.getSetting.mockImplementation(async (_db, k) => ({ [delivery.ENABLED_KEY]: '1' }[k] ?? null));
  settingsService.getSettings.mockImplementation(async (_db, keys) => Object.fromEntries(keys.map((k) => [k, k === consent.ASSIGNEE_KEY ? '22' : null])));
});
afterEach(() => { if (spy) spy.mockRestore(); });

test('a stamp into opted_out records ONE provider_optout event; the next run records nothing and takes no lock', async () => {
  const W = world();
  arm([REC()]);
  const out1 = await delivery.runSync(W.pdb);
  expect(out1).toMatchObject({ stamped: 1, consent_recorded: 1, consent_errors: 0 });
  expect(W.events).toHaveLength(1);
  expect(W.events[0]).toMatchObject({
    channel: 'sms', destination: PAT, scope: 'all', action: 'opt_out', source: 'provider_optout',
    provider_event_id: 'ringcentral:out-1', line_number: LINE, contact_id: 1,
    evidence: { via: 'delivery_verdict', provider: 'ringcentral', provider_ref: 'out-1', delivery_code: 'SMS-RC-413', delivery_reason: 'opted_out' },
  });
  expect(new Date(W.events[0].occurred_at).toISOString()).toBe('2026-10-28T14:00:00.000Z');
  expect(W.state('sms', PAT, 'all').state).toBe('opted_out');
  expect(taskService.createTask).toHaveBeenCalledTimes(1);   // a client with an open case, stranded

  W.locks.length = 0;
  const out2 = await delivery.runSync(W.pdb);
  expect(out2).toMatchObject({ stamped: 0, unchanged: 1, consent_recorded: 0 });
  expect(W.events).toHaveLength(1);
  expect(W.locks).toEqual([]);
  expect(taskService.createTask).toHaveBeenCalledTimes(1);
  expect(W.unhandled).toEqual([]);
  expect(W.unhandled2).toEqual([]);
});

test('an earlier failed write heals on the next sighting, though the stamp no longer changes', async () => {
  const W = world({ stamped: new Map([['out-1', { delivery_state: 'failed', delivery_reason: 'opted_out', delivery_code: 'SMS-RC-413' }]]) });
  arm([REC()]);
  const out = await delivery.runSync(W.pdb);
  expect(out).toMatchObject({ stamped: 0, unchanged: 1, consent_recorded: 1 });
  expect(W.events.map((e) => e.provider_event_id)).toEqual(['ringcentral:out-1']);
});

test('a non-413 failure, a delivered text and an in-flight text record nothing', async () => {
  const W = world();
  arm([
    REC({ provider_ref: 'u1', delivery: { state: 'failed', reason: 'unreachable', provider_code: 'SMS-CAR-411' } }),
    REC({ provider_ref: 'u2', delivery: { state: 'failed', reason: 'unknown', provider_code: 'SMS-CAR-104' } }),
    REC({ provider_ref: 'd1', delivery: { state: 'delivered', reason: null, provider_code: null } }),
    REC({ provider_ref: 'p1', delivery: { state: 'pending', reason: null, provider_code: null } }),
  ]);
  const out = await delivery.runSync(W.pdb);
  expect(out.stamped).toBe(4);
  expect(out.consent_recorded).toBe(0);
  expect(W.events).toEqual([]);
});

test('a backfill records the verdict but opens no task', async () => {
  const W = world();
  arm([REC()]);
  const out = await delivery.runSync(W.pdb, { since: '2026-06-01T00:00:00Z', until: '2026-10-29T00:00:00Z', backfill: true });
  expect(out.consent_recorded).toBe(1);
  expect(taskService.createTask).not.toHaveBeenCalled();
});

test('a consent write that throws: counted, alerted at error, the window and the stamp go on', async () => {
  const W = world();
  arm([REC({ to: PAT }), REC({ provider_ref: 'd2', delivery: { state: 'delivered', reason: null, provider_code: null } })]);
  const real = consent.recordProviderOptOut;
  const s2 = jest.spyOn(consent, 'recordProviderOptOut').mockRejectedValue(new Error('lock wait timeout'));
  const out = await delivery.runSync(W.pdb);
  expect(out).toMatchObject({ consent_errors: 1, stamped: 2 });
  expect(out.errors.some((e) => /consent ringcentral\/out-1: lock wait timeout/.test(e))).toBe(true);
  expect(alerting.alert.mock.calls.some(([, o]) => o.group_key === 'phone_delivery_consent' && o.severity === 'error')).toBe(true);
  s2.mockRestore();
  expect(consent.recordProviderOptOut).toBe(real);
});
