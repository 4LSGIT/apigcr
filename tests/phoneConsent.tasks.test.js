/**
 * tests/phoneConsent.tasks.test.js — YisraMail P2 (ref/YISRAMAIL_DESIGN.md §4.6)
 *
 * services/phoneConsentService.js end to end over an in-memory world
 * (tests/helpers/phoneConsentWorld.js — the consent store answered by
 * optoutService's own SQL, with the ledger's UNIQUE and the guarded upsert):
 *   - keyword recording (opt-out, opt-in only while opted out, a redelivery
 *     is a duplicate, attribution to the active row's contact, line + ts),
 *   - the stranded-client task: only for a TRANSITION into opted out, only on
 *     a contact with an open Primary/Secondary case, created AFTER the commit,
 *   - the review task: one open per number (task_dedupe_key), due on the
 *     third business day,
 *   - consent_task_user_id unset → no task, a warning alert, the event still
 *     recorded,
 *   - no confirmation job, ever: RC and Quo confirm every word themselves (Quo REVOKE + OPT OUT proven live 2026-10-30).
 * The real-engine twin (tests/phoneConsent.mysql.test.js) holds the SQL itself.
 * Collaborators mocked: settingsService, taskService.createTask,
 * calendarService.nextBusinessDay, lib/taskQueue, lib/alerting.
 */
'use strict';

jest.mock('../services/settingsService', () => ({ getSetting: jest.fn(), getSettings: jest.fn() }));
jest.mock('../services/taskService', () => ({ createTask: jest.fn() }));
jest.mock('../services/calendarService', () => ({ nextBusinessDay: jest.fn() }));
jest.mock('../lib/taskQueue', () => ({ enqueueJobDispatch: jest.fn(async () => {}) }));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));

const settingsService = require('../services/settingsService');
const taskService = require('../services/taskService');
const calendarService = require('../services/calendarService');
const taskQueue = require('../lib/taskQueue');
const alerting = require('../lib/alerting');
const svc = require('../services/phoneConsentService');
const { makePhoneConsentWorld } = require('./helpers/phoneConsentWorld');
const norm = (x) => String(x).replace(/\s+/g, ' ').trim();

const LINE_RC = '2485592400';
const LINE_QUO = '2484179800';
const PAT = '3135550001';    // client: active row, open Primary case
const SAM = '3135550002';    // contact with only a closed case
const ANN = '3135550003';    // contact related as 'Other'
const GHOST = '3135550009';  // no contact row at all

function setup({ assignee = '22', states = [], tasks = [], phones, users } = {}) {
  const W = makePhoneConsentWorld({
    contacts: [{ contact_id: 1, contact_name: 'Pat Client' }, { contact_id: 2, contact_name: 'Sam Former' }, { contact_id: 3, contact_name: 'Ann Other' }],
    phones: phones || [
      { id: 11, contact_id: 1, phone: PAT },
      { id: 12, contact_id: 2, phone: SAM },
      { id: 13, contact_id: 3, phone: ANN },
    ],
    states,
    cases: [
      { contact_id: 1, case_id: 'C100', relate_type: 'Primary', stage: 'Filed' },
      { contact_id: 2, case_id: 'C200', relate_type: 'Primary', stage: 'Closed' },
      { contact_id: 3, case_id: 'C300', relate_type: 'Other', stage: 'Open' },
    ],
    tasks,
    ...(users ? { users } : {}),
  });
  settingsService.getSetting.mockResolvedValue(null);
  settingsService.getSettings.mockImplementation(async (_db, keys) => Object.fromEntries(keys.map((k) => [k, { firm_name: 'Legal Solutions Group', [svc.ASSIGNEE_KEY]: assignee }[k] ?? null])));
  let nextTask = 7000;
  taskService.createTask.mockImplementation(async (_db, o) => {
    const task_id = nextTask++;
    W.order.push('task');
    W.tasks.push({ task_id, task_status: 'Pending', task_dedupe_key: null, ...o });
    return { task_id, action_token: 't', action_url: 'u' };
  });
  calendarService.nextBusinessDay.mockImplementation(async (from) => new Date(new Date(from).getTime() + 86400000));
  return W;
}

const inbound = (W, over = {}) => svc.handleInbound(W.pdb, {
  provider: 'ringcentral', providerRef: 'm-1', line: LINE_RC, from10: PAT, body: 'STOP',
  ts: '2026-10-29T22:30:22.899Z', firmToFirm: false, ...over,
});

beforeEach(() => jest.clearAllMocks());
afterEach(() => { /* each test asserts its own world */ });

describe('keyword recording', () => {
  test('STOP → one sms_keyword opt-out, scope all, the provider\'s time, line + contact attributed; cache synced', async () => {
    const W = setup();
    const r = await inbound(W);
    expect(r).toMatchObject({ kind: 'opt_out', recorded: true, state: 'opted_out' });
    expect(W.events).toHaveLength(1);
    expect(W.events[0]).toMatchObject({
      channel: 'sms', destination: PAT, scope: 'all', action: 'opt_out', source: 'sms_keyword',
      provider_event_id: 'ringcentral:m-1', contact_id: 1, line_number: LINE_RC,
      evidence: { keyword: 'stop', body: 'STOP', provider: 'ringcentral', provider_ref: 'm-1' },
    });
    expect(new Date(W.events[0].occurred_at).toISOString()).toBe('2026-10-29T22:30:22.899Z');
    expect(W.state('sms', PAT, 'all').state).toBe('opted_out');
    expect(W.phone(11).sms_optout).toBe(1);
    // lock order: the active row, then the state, and the held row is passed on (no second row lock)
    expect(W.locks.filter((l) => l.startsWith('row:'))).toEqual(['row:active']);
    expect(W.unhandled).toEqual([]);
    expect(W.unhandled2).toEqual([]);
  });

  test('a redelivered STOP (same message id) is a duplicate: no second event, no task, no job', async () => {
    const W = setup();
    await inbound(W);
    taskService.createTask.mockClear();
    const r = await inbound(W);
    expect(r).toMatchObject({ kind: 'opt_out', recorded: false });
    expect(W.events).toHaveLength(1);
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  test('START while opted out → opt_in recorded, cache cleared; START while not opted out → nothing', async () => {
    const W = setup();
    expect(await inbound(W, { body: 'start', providerRef: 'm-0' })).toMatchObject({ kind: 'opt_in', recorded: false, reason: 'not_opted_out' });
    expect(W.events).toHaveLength(0);
    await inbound(W);
    const r = await inbound(W, { body: 'Start', providerRef: 'm-2', ts: '2026-10-29T22:40:00.000Z' });
    expect(r).toMatchObject({ kind: 'opt_in', recorded: true, state: 'opted_in' });
    expect(W.events.map((e) => [e.action, e.source])).toEqual([['opt_out', 'sms_keyword'], ['opt_in', 'sms_keyword']]);
    expect(W.phone(11).sms_optout).toBe(0);
    // the opt-in decision read the state with a LOCKING read, after the row
    expect(W.locks.slice(-4)).toEqual(['row:active', 'state:share', 'state:update', 'cache:row']);
  });

  test('an opt-in with no state row honours the cache flag (the reader\'s dual-read)', async () => {
    const W = setup({ phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 1 }] });
    const r = await inbound(W, { body: 'UNSTOP' });
    expect(r).toMatchObject({ kind: 'opt_in', recorded: true });
    expect(W.phone(11).sms_optout).toBe(0);
  });

  test('a STOP older than an existing START: recorded, but the state stays opted_in (the guard)', async () => {
    const W = setup();
    await inbound(W, { providerRef: 'm-1', ts: '2026-10-29T10:00:00Z' });
    await inbound(W, { body: 'START', providerRef: 'm-2', ts: '2026-10-29T12:00:00Z' });
    const r = await inbound(W, { providerRef: 'm-late', ts: '2026-10-29T11:00:00Z' });
    expect(r).toMatchObject({ kind: 'opt_out', recorded: true, state: 'opted_in' });
    expect(W.events).toHaveLength(3);
    expect(W.state('sms', PAT, 'all').state).toBe('opted_in');
  });

  test('a deadlock on the span is retried ONCE, whole (rolled back, re-run); a second deadlock throws', async () => {
    const deadlock = () => Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 });
    const rowLock = norm(svc.ACTIVE_ROW_LOCK_SQL);
    let left = 1;
    const W = makePhoneConsentWorld({
      contacts: [{ contact_id: 1, contact_name: 'Pat Client' }],
      phones: [{ id: 11, contact_id: 1, phone: PAT }],
      extra: async (sql) => { if (sql === rowLock && left > 0) { left--; throw deadlock(); } return undefined; },
    });
    settingsService.getSetting.mockResolvedValue(null);
    const r = await inbound(W);
    expect(r).toMatchObject({ kind: 'opt_out', recorded: true, state: 'opted_out' });
    expect(W.events).toHaveLength(1);
    expect(W.order.slice(0, 4)).toEqual(['begin', 'rollback', 'begin', 'event:sms_keyword:opt_out']);

    left = 2;
    await expect(inbound(W, { providerRef: 'm-dl', ts: '2026-10-29T23:00:00Z' })).rejects.toMatchObject({ code: 'ER_LOCK_DEADLOCK' });
    expect(W.events).toHaveLength(1);
  });

  test('SUBSCRIBE: opt-in on RingCentral; on Quo a review only while opted out', async () => {
    const W = setup();
    await inbound(W);
    expect(await inbound(W, { body: 'subscribe', providerRef: 'm-2' })).toMatchObject({ kind: 'opt_in', recorded: true });
    // Quo, number now opted in → an ordinary reply
    expect(await inbound(W, { provider: 'quo', line: LINE_QUO, body: 'Resume', providerRef: 'AC1' })).toEqual({ kind: null, recorded: false });
    await inbound(W, { providerRef: 'm-3', ts: '2026-10-30T00:00:00Z' });
    const r = await inbound(W, { provider: 'quo', line: LINE_QUO, body: 'Resume', providerRef: 'AC2' });
    expect(r.kind).toBe('review');
    expect(taskService.createTask.mock.calls.at(-1)[1]).toMatchObject({ title: 'Possible text opt-in — review', source: 'consent_review' });
  });
});

describe('stranded-client task', () => {
  test('a client with an open case: one task, AFTER the commit, to consent_task_user_id, linked to the contact', async () => {
    const W = setup();
    const r = await inbound(W);
    expect(r.task_id).toBe(7000);
    expect(W.order).toEqual(['begin', 'event:sms_keyword:opt_out', 'commit', 'task']);
    const [, o] = taskService.createTask.mock.calls[0];
    expect(o).toMatchObject({ from: 0, to: 22, title: 'Client opted out of texts — reach by phone/email', source: 'consent', link_type: 'contact', link_id: 1 });
    expect(o.title.length).toBeLessThanOrEqual(100);
    expect(o.desc.length).toBeLessThanOrEqual(1000);
    expect(o.desc).toMatch(/Pat Client — \(313\) 555-0001/);
    expect(o.desc).toMatch(/START/);
    expect(o.log_extra).toMatchObject({ destination: PAT, line: LINE_RC, case_id: 'C100' });
  });

  test('no task for: a closed case, an Other relation, no contact row, or a number already opted out', async () => {
    const W = setup({ states: [{ channel: 'sms', destination: PAT, scope: 'all', state: 'opted_out', last_event_id: 0 }] });
    await inbound(W, { from10: SAM, providerRef: 'a' });
    await inbound(W, { from10: ANN, providerRef: 'b' });
    await inbound(W, { from10: GHOST, providerRef: 'c' });
    await inbound(W, { from10: PAT, providerRef: 'd' });   // re-sighting: was already opted out
    expect(W.events).toHaveLength(4);
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  test('a provider opt-out after the keyword is a re-sighting: recorded in the ledger, no second task', async () => {
    const W = setup();
    await inbound(W);
    const r = await svc.recordProviderOptOut(W.pdb, { destination: PAT, providerEventId: 'ringcentral:out-1', occurredAt: '2026-10-30T01:00:00Z', lineNumber: LINE_RC });
    expect(r).toMatchObject({ recorded: true, state: 'opted_out' });
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    // a second sighting of the same verdict never reaches a lock
    W.locks.length = 0;
    expect(await svc.recordProviderOptOut(W.pdb, { destination: PAT, providerEventId: 'ringcentral:out-1' })).toEqual({ recorded: false, duplicate: true });
    expect(W.locks).toEqual([]);
  });

  test('notify:false (a backfill) records but opens no task', async () => {
    const W = setup();
    const r = await svc.recordProviderOptOut(W.pdb, { destination: PAT, providerEventId: 'ringcentral:old', notify: false });
    expect(r.recorded).toBe(true);
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  test('consent_task_user_id unset: no task, one warning alert, the event still recorded', async () => {
    const W = setup({ assignee: null });
    const r = await inbound(W);
    expect(r).toMatchObject({ recorded: true, state: 'opted_out' });
    expect(r.task_id).toBeNull();
    expect(W.events).toHaveLength(1);
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(alerting.alert).toHaveBeenCalledTimes(1);
    expect(alerting.alert.mock.calls[0][1]).toMatchObject({ severity: 'warning', group_key: 'consent_task_unassigned' });
    expect(alerting.alert.mock.calls[0][1].dedup_key).toMatch(/^consent_task_unassigned:\d{4}-\d{2}-\d{2}$/);
  });

  test('an assignee who is no longer an active user counts as unset (P3\'s rule, unsubService.resolveAssignee)', async () => {
    const W = setup({ users: [{ user: 22, user_auth: 'disabled' }] });
    const r = await inbound(W);
    expect(r).toMatchObject({ recorded: true, state: 'opted_out', task_id: null });
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(alerting.alert.mock.calls[0][1]).toMatchObject({ source: 'consent', kind: 'consent_task_unassigned', severity: 'warning' });
  });
});

describe('review task', () => {
  test('a plain-language opt-out → one review task due on the 3rd business day; a second while open is absorbed', async () => {
    const W = setup();
    const r1 = await inbound(W, { body: 'Please stop texting me', providerRef: 'r1' });
    expect(r1).toEqual({ kind: 'review', recorded: false, task_id: 7000 });
    expect(W.events).toHaveLength(0);
    const [, o] = taskService.createTask.mock.calls[0];
    expect(o).toMatchObject({ from: 0, to: 22, title: 'Possible text opt-out — review', source: 'consent_review', link_type: 'contact', link_id: 1 });
    expect(o.desc).toMatch(/Please stop texting me/);
    expect(o.desc).toMatch(/tick "SMS opted out"/);
    expect(calendarService.nextBusinessDay).toHaveBeenCalledTimes(3);
    expect(o.due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(W.tasks[0].task_dedupe_key).toBe(`consent_review:${PAT}`);

    const r2 = await inbound(W, { body: 'wrong number', providerRef: 'r2' });
    expect(r2).toEqual({ kind: 'review', recorded: false, task_id: 7000 });
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    expect(W.order).toContain('touch:7000');

    W.tasks[0].task_status = 'Completed';
    const r3 = await inbound(W, { body: 'leave me alone', providerRef: 'r3' });
    expect(r3.task_id).toBe(7001);
  });

  test('the business-day calendar failing falls back to calendar +3 days', async () => {
    calendarService.nextBusinessDay.mockRejectedValue(new Error('hebcal down'));
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const now = new Date('2026-10-29T15:00:00Z');
    expect(await svc.reviewDueDate(now)).toBe('2026-11-01');
    spy.mockRestore();
  });

  test('no review for a number already opted out (nothing left to stop)', async () => {
    const W = setup();
    await inbound(W);
    taskService.createTask.mockClear();
    expect(await inbound(W, { body: 'stop texting me!!', providerRef: 'r9' })).toEqual({ kind: 'review', recorded: false, reason: 'already_opted_out' });
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  test('a review on a number no contact holds is unlinked', async () => {
    const W = setup();
    await inbound(W, { from10: GHOST, body: 'remove me', providerRef: 'g1' });
    expect(taskService.createTask.mock.calls[0][1]).toMatchObject({ link_type: null, link_id: null });
  });
});

describe('no confirmation text from YC (the providers confirm every word themselves)', () => {
  test('OPT OUT, REVOKE and STOP on Quo all record the opt-out and schedule NOTHING', async () => {
    const W = setup();
    const quo = (body, providerRef, from10) => inbound(W, { provider: 'quo', line: LINE_QUO, body, providerRef, ...(from10 ? { from10 } : {}) });
    expect(await quo('Opt out', 'A1')).toMatchObject({ kind: 'opt_out', recorded: true, state: 'opted_out' });
    expect(await quo('REVOKE', 'A2', SAM)).toMatchObject({ kind: 'opt_out', recorded: true, state: 'opted_out' });
    expect(await quo('STOP', 'A3', ANN)).toMatchObject({ kind: 'opt_out', recorded: true, state: 'opted_out' });
    expect(W.jobs).toEqual([]);
    expect(taskQueue.enqueueJobDispatch).not.toHaveBeenCalled();
    expect(W.unhandled2.filter((q) => /scheduled_jobs/i.test(q.sql))).toEqual([]);
  });

  test('the service exports no confirmation surface (retired 2026-10-30)', () => {
    for (const k of ['scheduleQuoConfirmation', 'confirmationText', 'CONFIRM_JOB_TYPE', 'CONFIRM_TEXT_KEY', 'QUO_CONFIRM_WORDS']) {
      expect(svc[k]).toBeUndefined();
    }
  });
});
