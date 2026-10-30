/**
 * tests/phoneIngest.consent.test.js — YisraMail P2 call site
 * (ref/YISRAMAIL_DESIGN.md §4.6): phoneIngestService.ingestPhoneEvent step 2b.
 *
 * Pinned:
 *   - POSITION: a true redelivery short-circuited at 1b never reaches the
 *     consent handler; a fresh inbound text reaches it AFTER the catch-all
 *     write and BEFORE Layer 2 (suppression) and Layer 3 (rules) — order
 *     asserted over one recording world;
 *   - only INCOMING SMS: outgoing texts and calls never reach it;
 *   - what it is handed (provider, ref, line, sender, body, ts, firmToFirm);
 *   - a handler THROW is logged + alerted at error and the pipeline carries
 *     on: suppression, rules and the log write all still run (the
 *     layer-independence invariant);
 *   - the executions row's metadata carries `consent` for a match (and the
 *     error), and stays NULL for an ordinary text.
 *
 * The module under test (phoneIngestService) is never mocked; its
 * collaborators are (logService, suppression, rules, phoneConsentService,
 * lib/alerting). Mutation-checked — see the report table.
 */
'use strict';

jest.mock('../services/logService', () => ({ createLogEntry: jest.fn() }));
jest.mock('../services/phoneIngestSuppressionService', () => ({ evaluateSuppressions: jest.fn() }));
jest.mock('../services/phoneIngestRuleService', () => ({ evaluateRules: jest.fn() }));
jest.mock('../services/phoneConsentService', () => ({ handleInbound: jest.fn() }));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));

const logService = require('../services/logService');
const suppression = require('../services/phoneIngestSuppressionService');
const rules = require('../services/phoneIngestRuleService');
const consent = require('../services/phoneConsentService');
const alerting = require('../lib/alerting');
const { ingestPhoneEvent, resetFirmNumberCache } = require('../services/phoneIngestService');

const LINE = '2485592400';
const CLIENT = '3135550001';

function world({ precheckRows = [] } = {}) {
  const order = [];
  const calls = [];
  const db = {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM phone_lines/.test(sql)) return [[{ phone_number: LINE }, { phone_number: '2486213656' }]];
      if (/EXISTS\(SELECT 1 FROM phone_ingest_executions/.test(sql)) { order.push('precheck'); return [precheckRows]; }
      if (/INSERT INTO phone_event_log/.test(sql)) { order.push('catchall'); return [{ insertId: 4300, affectedRows: 1 }]; }
      if (/UPDATE phone_event_log/.test(sql)) return [{ affectedRows: 1 }];
      if (/INSERT INTO phone_ingest_executions/.test(sql)) { order.push('execution'); return [{ insertId: 900 }]; }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  suppression.evaluateSuppressions.mockImplementation(async () => { order.push('suppression'); return { suppressed: false, matchedRuleIds: [] }; });
  rules.evaluateRules.mockImplementation(async () => { order.push('rules'); return { matchedRuleIds: [], actionOutcomes: [], parseWarnings: [] }; });
  logService.createLogEntry.mockImplementation(async () => { order.push('log'); return { log_id: 60001 }; });
  consent.handleInbound.mockImplementation(async () => { order.push('consent'); return { kind: null, recorded: false }; });
  return { db, order, calls };
}

function sms(over = {}, extra = {}) {
  return {
    type: 'sms', link_type: 'phone', link_id: CLIENT, by: 0,
    direction: 'incoming', from: CLIENT, to: LINE, message: 'STOP',
    extra: { provider: 'ringcentral', provider_event_id: 'evt-1', provider_message_id: '3105018826018', ts: '2026-10-29T22:30:22.899Z', line: LINE, ...extra },
    ...over,
  };
}

function execMetadata(calls) {
  const c = calls.find((x) => /INSERT INTO phone_ingest_executions/.test(x.sql));
  const cols = c.sql.match(/\(([^)]+)\)\s+VALUES/)[1].split(',').map((s) => s.trim());
  const m = c.params[cols.indexOf('metadata')];
  return m == null ? null : JSON.parse(m);
}

beforeEach(() => {
  jest.clearAllMocks();
  resetFirmNumberCache();
});

describe('position', () => {
  test('a fresh inbound text: catch-all → consent → suppression → rules → log', async () => {
    const W = world();
    await ingestPhoneEvent(W.db, sms());
    expect(W.order).toEqual(['precheck', 'catchall', 'consent', 'suppression', 'rules', 'log', 'execution']);
  });

  test('a true redelivery stops at 1b: the handler is never called', async () => {
    const W = world({ precheckRows: [{ id: 77, log_id: 5, suppressed: 0, has_execution: 1 }] });
    const out = await ingestPhoneEvent(W.db, sms());
    expect(out.duplicate).toBe(true);
    expect(consent.handleInbound).not.toHaveBeenCalled();
    expect(W.order).toEqual(['precheck', 'execution']);
  });
});

describe('who reaches it', () => {
  test('outgoing texts and calls never do', async () => {
    const W = world();
    await ingestPhoneEvent(W.db, sms({ direction: 'outgoing', from: LINE, to: CLIENT, link_id: CLIENT }));
    await ingestPhoneEvent(W.db, sms({ type: 'call' }, { provider_call_id: 'c1' }));
    await ingestPhoneEvent(W.db, sms({ direction: undefined }));
    expect(consent.handleInbound).not.toHaveBeenCalled();
  });

  test('an incoming text hands over provider, ref, line, sender, body, ts and firmToFirm', async () => {
    const W = world();
    await ingestPhoneEvent(W.db, sms({ from: '+13135550001' }));
    expect(consent.handleInbound).toHaveBeenCalledTimes(1);
    const [db, arg] = consent.handleInbound.mock.calls[0];
    expect(db).toBe(W.db);
    expect(arg).toEqual({
      provider: 'ringcentral', providerRef: '3105018826018', line: LINE, from10: CLIENT,
      body: 'STOP', ts: '2026-10-29T22:30:22.899Z', firmToFirm: false,
    });
  });

  test('a firm line texting a firm line is handed firmToFirm: true', async () => {
    const W = world();
    await ingestPhoneEvent(W.db, sms({ from: '2486213656', link_id: '2486213656' }));
    expect(consent.handleInbound.mock.calls[0][1].firmToFirm).toBe(true);
  });
});

describe('failure is contained', () => {
  test('a throw: logged, alerted at error, and suppression / rules / the log write still run', async () => {
    const W = world();
    consent.handleInbound.mockImplementation(async () => { W.order.push('consent'); throw new Error('deadlock on the moon'); });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const out = await ingestPhoneEvent(W.db, sms());
    expect(out.log_id).toBe(60001);
    expect(W.order).toEqual(['precheck', 'catchall', 'consent', 'suppression', 'rules', 'log', 'execution']);
    expect(spy.mock.calls.some((c) => /\[phone_log\] consent handler failed: deadlock on the moon/.test(c[0]))).toBe(true);
    expect(alerting.alert).toHaveBeenCalledTimes(1);
    expect(alerting.alert.mock.calls[0][1]).toMatchObject({ severity: 'error', group_key: 'phone_consent_inbound', dedup_key: 'phone_consent_inbound:ringcentral:3105018826018' });
    expect(execMetadata(W.calls)).toEqual({ consent: { kind: null, recorded: false, error: 'deadlock on the moon' } });
    spy.mockRestore();
  });
});

describe('metadata', () => {
  test('a recorded keyword lands as metadata.consent', async () => {
    const W = world();
    consent.handleInbound.mockResolvedValue({ kind: 'opt_out', recorded: true, state: 'opted_out', task_id: 5 });
    await ingestPhoneEvent(W.db, sms());
    expect(execMetadata(W.calls)).toEqual({ consent: { kind: 'opt_out', recorded: true } });
  });

  test('an ordinary text keeps the NULL baseline', async () => {
    const W = world();
    await ingestPhoneEvent(W.db, sms({ message: 'see you at 3' }));
    expect(execMetadata(W.calls)).toBeNull();
  });

  test('a suppressed text still records the consent outcome beside suppressed_by', async () => {
    const W = world();
    suppression.evaluateSuppressions.mockResolvedValue({ suppressed: true, matchedRuleIds: [3] });
    consent.handleInbound.mockResolvedValue({ kind: 'review', recorded: false, task_id: 9 });
    const out = await ingestPhoneEvent(W.db, sms({ message: 'wrong number' }));
    expect(out.suppressed).toBe(true);
    expect(execMetadata(W.calls)).toEqual({ suppressed_by: [3], consent: { kind: 'review', recorded: false } });
  });
});
