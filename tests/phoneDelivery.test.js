/**
 * tests/phoneDelivery.test.js — phone-delivery S1 (ref/PHONE_DELIVERY_DESIGN.md)
 *
 * CI half: the RC adapter's provider→normalized translation (the ONLY place
 * RC vocabulary exists), the core's pure decisions (stampDecision terminal
 * guard, buildIngestEvent's wf19-shaped event), and runSync's orchestration
 * over a scripted db + fixture adapter (statement TEXT only — the engine's
 * answers to the real SQL are pinned by tests/phoneDelivery.mysql.test.js,
 * the real-engine twin).
 *
 * Collaborators are fakes/mocks (settingsService, phoneIngestService, the
 * adapter, the db); the modules under test — phoneDeliveryService and the
 * ringcentral adapter's mapping exports — are never mocked.
 *
 * Mutation-checked (break the code, watch the test fail — run 2026-10-21):
 *   - stampDecision terminal guard removed            → 'terminal guard' test
 *   - stampDecision equality no-op removed            → 'no-op' test
 *   - _mapDelivery failed→reason fallback 'unknown' dropped → mapping table test
 *   - runSync skipAutomation literal 'backfill' dropped → backfill test
 *   - the UPDATE's terminal-guard call dropped (stamp always) → orchestration no-op test
 */
'use strict';

jest.mock('../services/settingsService', () => ({ getSetting: jest.fn() }));
jest.mock('../services/phoneIngestService', () => ({ ingestPhoneEvent: jest.fn() }));
jest.mock('../lib/actionDispatchers', () => ({ dispatchWorkflow: jest.fn() }));

const settingsService = require('../services/settingsService');
const phoneIngestService = require('../services/phoneIngestService');
const actionDispatchers = require('../lib/actionDispatchers');

/** Key-sensitive settings stub: keys absent from the map read as NULL (unset). */
const setSettings = (map) =>
  settingsService.getSetting.mockImplementation(async (_db, k) => (k in map ? map[k] : null));
const rc = require('../services/adapters/phone/ringcentral');
const phoneService = require('../services/phoneService');
const svc = require('../services/phoneDeliveryService');

// ─── RC adapter translation ─────────────────────────────────────────────────

describe('ringcentral _mapDelivery (design §3 table)', () => {
  test.each([
    ['Queued', null, 'pending', null],
    ['Sent', null, 'sent', null],
    ['Delivered', null, 'delivered', null],
    ['SendingFailed', 'SMS-RC-413', 'failed', 'opted_out'],
    ['DeliveryFailed', 'SMS-CAR-411', 'failed', 'unreachable'],
    ['DeliveryFailed', 'SMS-UP-430', 'failed', 'spam_content'],
    ['DeliveryFailed', 'SMS-UP-431', 'failed', 'sender_flagged'],
    ['DeliveryFailed', 'SMS-CAR-104', 'failed', 'unknown'],
    ['DeliveryFailed', null, 'failed', 'unknown'],
    ['SomethingNew', 'SMS-RC-413', 'pending', null],   // unknown status is never a verdict
  ])('%s + %s → %s/%s', (status, code, state, reason) => {
    const d = rc._mapDelivery(status, code);
    expect([d.state, d.reason]).toEqual([state, reason]);
    expect(d.provider_code).toBe(code);
  });

  test('a reason is only ever attached to failed', () => {
    expect(rc._mapDelivery('Delivered', 'SMS-RC-413').reason).toBeNull();
  });
});

describe('ringcentral _mapOutboundRecord', () => {
  const REC = {
    id: 3092550772018,
    type: 'SMS',
    direction: 'Outbound',
    subject: 'Hi Tonganyika!',
    creationTime: '2026-10-14T13:13:02.000Z',
    messageStatus: 'DeliveryFailed',
    deliveryErrorCode: 'SMS-CAR-411',
    from: { phoneNumber: '+12485592400' },
    to: [{ phoneNumber: '+12482405969' }],
    conversation: { id: '7504826788145480959' },
    attachments: [
      { id: 3092550772018, type: 'Text', contentType: 'text/plain' },   // synthetic — dropped
      { id: 99, type: 'MmsAttachment', contentType: 'image/jpeg' },
    ],
  };

  test('maps the whole record, strips +1, drops the synthetic attachment', () => {
    const r = rc._mapOutboundRecord(REC);
    expect(r).toEqual({
      provider: 'ringcentral',
      provider_ref: '3092550772018',
      from: '2485592400',
      to: '2482405969',
      body: 'Hi Tonganyika!',
      ts: '2026-10-14T13:13:02.000Z',
      conversation_id: '7504826788145480959',
      attachments: [{ id: '99', type: 'MmsAttachment', contentType: 'image/jpeg' }],
      delivery: { state: 'failed', reason: 'unreachable', provider_code: 'SMS-CAR-411' },
    });
  });

  test('per-recipient deliveryErrorCode is the fallback', () => {
    const r = rc._mapOutboundRecord({
      ...REC, deliveryErrorCode: undefined,
      to: [{ phoneNumber: '+12482405969', deliveryErrorCode: 'SMS-RC-413' }],
    });
    expect(r.delivery).toEqual({ state: 'failed', reason: 'opted_out', provider_code: 'SMS-RC-413' });
  });

  test.each([
    ['inbound', { ...REC, direction: 'Inbound' }],
    ['not sms', { ...REC, type: 'Fax' }],
    ['no id', { ...REC, id: null }],
  ])('refuses a record the sync must not touch: %s', (_label, rec) => {
    expect(rc._mapOutboundRecord(rec)).toBeNull();
  });

  test('_norm10 is conservative (wf19 step-3 semantics)', () => {
    expect(rc._norm10('+12485592400')).toBe('2485592400');
    expect(rc._norm10('+442012345678')).toBe('+442012345678');  // not +1 → untouched
    expect(rc._norm10('2485592400')).toBe('2485592400');
    expect(rc._norm10(null)).toBe('');
  });

  test('the adapter declares the read side; quo does not (yet)', () => {
    expect(rc.capabilities.outboundSync).toBe(true);
    expect(typeof rc.listOutbound).toBe('function');
    expect(require('../services/adapters/phone/quo').capabilities.outboundSync).toBe(false);
    // and service-side dispatch goes through the registry
    expect(phoneService.getAdapter('ringcentral')).toBe(rc);
    expect(phoneService.getAdapter('nope')).toBeNull();
  });
});

// ─── core pure decisions ────────────────────────────────────────────────────

const FRESH = { delivery_state: null, delivery_reason: null, delivery_code: null };

describe('stampDecision', () => {
  test('fresh row gets the verdict; failed defaults its reason to unknown', () => {
    expect(svc.stampDecision(FRESH, { state: 'failed', reason: null, provider_code: 'X' }))
      .toEqual({ state: 'failed', reason: 'unknown', code: 'X' });
    expect(svc.stampDecision(FRESH, { state: 'sent', reason: null, provider_code: null }))
      .toEqual({ state: 'sent', reason: null, code: null });
  });

  test('terminal guard: failed/delivered never downgrade to pending/sent', () => {
    const failed = { delivery_state: 'failed', delivery_reason: 'opted_out', delivery_code: 'SMS-RC-413' };
    expect(svc.stampDecision(failed, { state: 'sent', reason: null, provider_code: null })).toBeNull();
    expect(svc.stampDecision(failed, { state: 'pending', reason: null, provider_code: null })).toBeNull();
    // terminal → terminal is allowed (a late correction)
    expect(svc.stampDecision(failed, { state: 'delivered', reason: null, provider_code: null }))
      .toEqual({ state: 'delivered', reason: null, code: null });
  });

  test('no-op when nothing changed', () => {
    const cur = { delivery_state: 'failed', delivery_reason: 'opted_out', delivery_code: 'SMS-RC-413' };
    expect(svc.stampDecision(cur, { state: 'failed', reason: 'opted_out', provider_code: 'SMS-RC-413' })).toBeNull();
  });

  test('shape drift (a state outside the vocabulary) never writes', () => {
    expect(svc.stampDecision(FRESH, { state: 'Delivered', reason: null, provider_code: null })).toBeNull();
    expect(svc.stampDecision(FRESH, null)).toBeNull();
  });
});

describe('buildIngestEvent', () => {
  const R = {
    provider: 'ringcentral', provider_ref: '3092550772018',
    from: '2485592400', to: '2482405969', body: 'hello',
    ts: '2026-10-14T13:13:02.000Z', conversation_id: 'c1',
    attachments: [{ id: '99', type: 'MmsAttachment', contentType: 'image/jpeg' }],
    delivery: { state: 'failed', reason: 'unknown', provider_code: null },
  };

  test('the exact wf19 step-4 shape — recovered texts are indistinguishable', () => {
    expect(svc.buildIngestEvent(R)).toEqual({
      type: 'sms', direction: 'outgoing',
      from: '2485592400', to: '2482405969', message: 'hello', by: 0,
      link_type: 'phone', link_id: '2482405969',
      date: R.ts,   // the SEND time — createLogEntry stamps log_date from it (S3b/S4)
      data: { direction: 'outgoing', attachments: R.attachments },
      extra: {
        ts: R.ts, line: '2485592400', provider: 'ringcentral',
        conversation_id: 'c1',
        provider_event_id: '3092550772018', provider_message_id: '3092550772018',
      },
    });
  });

  test('backfill marks the event (design §6)', () => {
    expect(svc.buildIngestEvent(R, { backfill: true }).extra.backfill).toBe(true);
    expect(svc.buildIngestEvent(R).extra.backfill).toBeUndefined();
  });
});

// ─── runSync orchestration over a scripted db ───────────────────────────────

/** Scripted db: recognizes the few statements by text; records every call. */
function makeDb({ existingRows = [], locked = false, firmLines = null } = {}) {
  const calls = [];
  const db = {
    calls,
    async query(sql, params) {
      calls.push([sql, params]);
      if (/SELECT provider, credential_id/.test(sql)) {
        return [[{ provider: 'ringcentral', credential_id: 9 }, { provider: 'quo', credential_id: 10 }]];
      }
      if (/SELECT phone_number FROM phone_lines/.test(sql)) {
        return [(firmLines || ['2485592400', '2486213656']).map(phone_number => ({ phone_number }))];
      }
      if (/FROM phone_event_log/.test(sql)) return [existingRows];
      if (/INSERT (IGNORE )?INTO system_alerts/.test(sql)) return [{ affectedRows: 1, insertId: 1 }];
      return [{ affectedRows: 1 }];
    },
    async getConnection() {
      return {
        async query(sql) {
          if (/GET_LOCK/.test(sql)) return [[{ got: locked ? 0 : 1 }]];
          return [[]];
        },
        release() {},
        destroy() {},
      };
    },
  };
  return db;
}

const OUT_REC = (over = {}) => ({
  provider: 'ringcentral', provider_ref: 'ref-1',
  from: '2485592400', to: '2482405969', body: 'b', ts: '2026-10-20T00:00:00.000Z',
  conversation_id: 'c', attachments: [],
  delivery: { state: 'delivered', reason: null, provider_code: null },
  ...over,
});

function fixtureAdapter(pages) {
  const listCalls = [];
  return {
    listCalls,
    capabilities: { sms: true, mms: true, outboundSync: true },
    async listOutbound(db, args) {
      listCalls.push(args);
      const p = pages[Math.min(args.page - 1, pages.length - 1)];
      return { status: 200, records: [], page: args.page, totalPages: pages.length, rate: {}, errorText: null, ...p };
    },
  };
}

describe('runSync', () => {
  let getAdapterSpy;
  afterEach(() => { jest.clearAllMocks(); if (getAdapterSpy) getAdapterSpy.mockRestore(); });

  function arm(adapter) {
    getAdapterSpy = jest.spyOn(phoneService, 'getAdapter')
      .mockImplementation(p => (p === 'ringcentral' ? adapter : null));
  }

  test('fail-closed: setting off → skipped, nothing listed', async () => {
    settingsService.getSetting.mockResolvedValue(null);
    const db = makeDb();
    const out = await svc.runSync(db);
    expect([out.enabled, out.skipped, out.groups]).toEqual([false, `${svc.ENABLED_KEY} is not "1"`, 0]);
    expect(db.calls.length).toBe(0);
  });

  test('locked elsewhere → skipped', async () => {
    setSettings({ [svc.ENABLED_KEY]: '1' });
    const out = await svc.runSync(makeDb({ locked: true }));
    expect(out.skipped).toBe('locked');
  });

  test('unknown ref → ingested live (rules fire); known changed → stamped; unchanged → no write', async () => {
    setSettings({ [svc.ENABLED_KEY]: '1' });
    phoneIngestService.ingestPhoneEvent.mockResolvedValue({ log_id: 1 });
    const existing = [
      { id: 7, provider_ref: 'ref-known-changed', delivery_state: 'sent', delivery_reason: null, delivery_code: null },
      { id: 8, provider_ref: 'ref-known-same', delivery_state: 'delivered', delivery_reason: null, delivery_code: null },
    ];
    const adapter = fixtureAdapter([{
      records: [
        OUT_REC({ provider_ref: 'ref-new' }),
        OUT_REC({ provider_ref: 'ref-known-changed', delivery: { state: 'failed', reason: 'opted_out', provider_code: 'SMS-RC-413' } }),
        OUT_REC({ provider_ref: 'ref-known-same' }),
      ],
    }]);
    arm(adapter);
    const db = makeDb({ existingRows: existing });
    const out = await svc.runSync(db);

    // quo has no outboundSync-capable adapter here → one group runs
    expect([out.groups, out.listed, out.ingested, out.stamped, out.unchanged]).toEqual([1, 3, 1, 2, 1]);
    // live run never skips Layer 3
    expect(phoneIngestService.ingestPhoneEvent).toHaveBeenCalledTimes(1);
    expect(phoneIngestService.ingestPhoneEvent.mock.calls[0][2]).toEqual({ skipAutomation: false });
    // the new row is stamped too (by the unique key), and the changed one
    const updates = db.calls.filter(([s]) => /UPDATE phone_event_log/.test(s));
    expect(updates.map(([, p]) => [p[0], p[1], p[2], p[4]])).toEqual([
      ['delivered', null, null, 'ref-new'],
      ['failed', 'opted_out', 'SMS-RC-413', 'ref-known-changed'],
    ]);
  });

  test('backfill run: skipAutomation="backfill" and the event carries the marker (design §6)', async () => {
    setSettings({ [svc.ENABLED_KEY]: '1' });
    phoneIngestService.ingestPhoneEvent.mockResolvedValue({ log_id: 1 });
    const adapter = fixtureAdapter([{ records: [OUT_REC({ provider_ref: 'old-1' })] }]);
    arm(adapter);
    const out = await svc.runSync(makeDb(), { since: '2026-05-20T00:00:00Z', until: '2026-06-01T00:00:00Z', backfill: true });
    expect(out.backfill).toBe(true);
    const [, event, opts] = phoneIngestService.ingestPhoneEvent.mock.calls[0];
    expect(opts).toEqual({ skipAutomation: 'backfill' });
    expect(event.extra.backfill).toBe(true);
  });

  test('429 parks the group; a non-200 alerts and never reaches the next page', async () => {
    setSettings({ [svc.ENABLED_KEY]: '1' });
    const adapter429 = fixtureAdapter([{ status: 429, records: [] }]);
    arm(adapter429);
    let out = await svc.runSync(makeDb());
    expect([out.fetch_errors, out.pages]).toEqual([1, 0]);

    jest.clearAllMocks(); getAdapterSpy.mockRestore();
    setSettings({ [svc.ENABLED_KEY]: '1' });
    const adapter500 = fixtureAdapter([{ status: 500, errorText: 'boom', records: [] }]);
    arm(adapter500);
    const db = makeDb();
    out = await svc.runSync(db);
    expect(out.fetch_errors).toBe(1);
    expect(out.errors[0]).toMatch(/500.*boom/);
    expect(db.calls.some(([s]) => /system_alerts/.test(s))).toBe(true);
  });

  test('S3c failed-dispatch: fired exactly on the TRANSITION into failed, never on re-checks, refinements or backfill', async () => {
    const FAILED = { state: 'failed', reason: 'unreachable', provider_code: 'SMS-CAR-411' };
    const WF = { [svc.ENABLED_KEY]: '1', [svc.FAILED_WF_KEY]: '53' };
    phoneIngestService.ingestPhoneEvent.mockResolvedValue({ log_id: 1 });
    actionDispatchers.dispatchWorkflow.mockResolvedValue({ status: 'success' });

    // a) fresh row straight to failed (null → failed IS a transition) → one dispatch, pinned payload
    setSettings(WF);
    arm(fixtureAdapter([{ records: [OUT_REC({ provider_ref: 'f-1', delivery: FAILED })] }]));
    let out = await svc.runSync(makeDb());
    expect([out.dispatched, out.dispatch_errors]).toEqual([1, 0]);
    expect(actionDispatchers.dispatchWorkflow).toHaveBeenCalledTimes(1);
    const [tgt, cfg, init] = actionDispatchers.dispatchWorkflow.mock.calls[0];
    expect(cfg).toEqual({ workflow_id: 53 });
    expect(init).toEqual({
      kind: 'sms_delivery_failed', provider: 'ringcentral', provider_ref: 'f-1',
      to: '2482405969', from: '2485592400', body: 'b', ts: '2026-10-20T00:00:00.000Z',
      reason: 'unreachable', code: 'SMS-CAR-411',
    });

    // b) already failed, code refined → stamped but NOT a second failure
    jest.clearAllMocks(); getAdapterSpy.mockRestore();
    setSettings(WF);
    actionDispatchers.dispatchWorkflow.mockResolvedValue({ status: 'success' });
    const failedRow = { id: 7, provider_ref: 'f-1', delivery_state: 'failed', delivery_reason: 'unreachable', delivery_code: null };
    arm(fixtureAdapter([{ records: [OUT_REC({ provider_ref: 'f-1', delivery: FAILED })] }]));
    out = await svc.runSync(makeDb({ existingRows: [failedRow] }));
    expect([out.stamped, out.dispatched]).toEqual([1, 0]);
    expect(actionDispatchers.dispatchWorkflow).not.toHaveBeenCalled();

    // c) backfill never dispatches, even on a fresh failed verdict
    jest.clearAllMocks(); getAdapterSpy.mockRestore();
    setSettings(WF);
    phoneIngestService.ingestPhoneEvent.mockResolvedValue({ log_id: 1 });
    arm(fixtureAdapter([{ records: [OUT_REC({ provider_ref: 'f-2', delivery: FAILED })] }]));
    out = await svc.runSync(makeDb(), { since: '2026-05-20T00:00:00Z', until: '2026-06-01T00:00:00Z', backfill: true });
    expect([out.stamped, out.dispatched]).toEqual([1, 0]);
    expect(actionDispatchers.dispatchWorkflow).not.toHaveBeenCalled();

    // d) setting blank = off; e) a refused dispatch is counted, never thrown
    jest.clearAllMocks(); getAdapterSpy.mockRestore();
    setSettings({ [svc.ENABLED_KEY]: '1' });
    phoneIngestService.ingestPhoneEvent.mockResolvedValue({ log_id: 1 });
    arm(fixtureAdapter([{ records: [OUT_REC({ provider_ref: 'f-3', delivery: FAILED })] }]));
    out = await svc.runSync(makeDb());
    expect(actionDispatchers.dispatchWorkflow).not.toHaveBeenCalled();

    jest.clearAllMocks(); getAdapterSpy.mockRestore();
    setSettings(WF);
    phoneIngestService.ingestPhoneEvent.mockResolvedValue({ log_id: 1 });
    actionDispatchers.dispatchWorkflow.mockResolvedValue({ status: 'failed', error: 'workflow #53 is inactive' });
    arm(fixtureAdapter([{ records: [OUT_REC({ provider_ref: 'f-4', delivery: FAILED })] }]));
    out = await svc.runSync(makeDb());
    expect([out.dispatched, out.dispatch_errors]).toEqual([0, 1]);
    expect(out.errors[0]).toMatch(/failed-dispatch wf53.*inactive/);

    // f) LOOP GUARD (S3c-b): a failed text whose recipient is a firm's own
    // line never dispatches — the notification workflow texts staff lines,
    // and dispatching on a failed notification would send another, forever.
    jest.clearAllMocks(); getAdapterSpy.mockRestore();
    setSettings(WF);
    phoneIngestService.ingestPhoneEvent.mockResolvedValue({ log_id: 1 });
    actionDispatchers.dispatchWorkflow.mockResolvedValue({ status: 'success' });
    arm(fixtureAdapter([{ records: [OUT_REC({ provider_ref: 'f-5', to: '2485592400', delivery: FAILED })] }]));
    out = await svc.runSync(makeDb({ firmLines: ['2485592400', '2486213656'] }));
    expect([out.dispatched, out.dispatch_skipped_firm]).toEqual([0, 1]);
    expect(actionDispatchers.dispatchWorkflow).not.toHaveBeenCalled();
    expect(out.stamped).toBe(1);   // the verdict still stamps — only the dispatch is withheld
  });

  test('one bad record never stops the window', async () => {
    setSettings({ [svc.ENABLED_KEY]: '1' });
    phoneIngestService.ingestPhoneEvent
      .mockRejectedValueOnce(new Error('INVALID_LOG_LINK_ID'))
      .mockResolvedValue({ log_id: 2 });
    const adapter = fixtureAdapter([{ records: [OUT_REC({ provider_ref: 'bad' }), OUT_REC({ provider_ref: 'good' })] }]);
    arm(adapter);
    const out = await svc.runSync(makeDb());
    expect([out.ingest_errors, out.ingested]).toEqual([1, 1]);
  });
});
