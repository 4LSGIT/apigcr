// tests/apptService.providerCancelNotice.test.js
//
/**
 * PROVIDER CANCEL NOTICE — cancels no person made
 *
 * Fred's ruling 2026-10-13 (option a): when an appointment is canceled with no
 * acting user (an internal/API-key automation — the Calendly cancel workflow
 * wf50, the cancel_case_appts cascade), cancelAppt texts the appt's provider
 * (appt_with). Staff clicks stay silent. Client cancels stay on the existing
 * office alert (notifyStaffOfClientAction, roster ∪ provider) — and must not
 * double-text the provider.
 *
 * Before this, the only provider notice on a Calendly cancel was wf50's own
 * SMS step, hardcoded to Stuart's number regardless of appt_with.
 *
 * ── STUB POSTURE ────────────────────────────────────────────────────────────
 *   apptService runs for real; collaborators mocked; `db` is a SQL-matching
 *   router (tests/apptService.lineage.test.js idiom). Unrecognised SQL lands in
 *   db.unmatched and every test asserts it is empty — the notice is
 *   fire-and-forget, so a throwing stub would be swallowed and prove nothing.
 *
 * Run:
 *   npx jest tests/apptService.providerCancelNotice.test.js
 */

'use strict';

const settingsState = {};
jest.mock('../services/settingsService', () => ({
  getSettings: jest.fn(async (_db, keys) => {
    const out = {};
    for (const k of keys) out[k] = Object.prototype.hasOwnProperty.call(settingsState, k) ? settingsState[k] : null;
    return out;
  }),
}));

jest.mock('../services/phoneService', () => ({ sendSms: jest.fn(async () => ({})) }));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => ({})) }));
jest.mock('../services/gcalService', () => ({
  createEvent:    jest.fn(async () => ({ id: 'gcal-evt-1' })),
  deleteEvent:    jest.fn(async () => ({})),
  _resolveTarget: jest.fn(async () => ({ calendarId: 'firm@example.com' })),
}));
jest.mock('../services/taskService', () => ({
  createTask: jest.fn(async () => ({ task_id: 4242 })),
}));
jest.mock('../services/logService', () => ({
  createLogEntry: jest.fn(async () => ({ log_id: 1 })),
}));
jest.mock('../services/resolverService', () => ({ resolve: jest.fn(async (s) => s) }));
jest.mock('../lib/sequenceEngine', () => ({
  cancelSequences: jest.fn(async () => ({})),
  cancelByApptId:  jest.fn(async () => ({})),
  enrollContact:   jest.fn(async () => ({})),
}));
jest.mock('../services/hookService', () => ({ executeHook: jest.fn(async () => ({})) }));
jest.mock('../lib/domainEvents', () => ({
  emit:         jest.fn(() => Promise.resolve()),
  buildChanges: jest.fn(() => ({})),
  runAsAction:  (_ruleId, fn) => fn(),
  MAX_DEPTH:    4,
}));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(() => Promise.resolve()) }));

const apptService = require('../services/apptService');
const smsService  = require('../services/phoneService');
const { alert }   = require('../lib/alerting');

const calendarTypeService = require('../services/calendarTypeService');
beforeAll(() => calendarTypeService._primeCache(require('./fixtures/calendar_item_types.seed.json')));
afterAll(() => calendarTypeService.invalidate());

// ─────────────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────────────

// Production shape (verified 2026-10-14 from rc_messages_log): sms_default_from
// is Stuart's own line, sms_staff_from the firm's outbound staff line.
const DEFAULT_LINE = '2485592400';
const STAFF_LINE   = '2486213656';
const FROM         = STAFF_LINE;
const SS_PHONE     = '2485592400';
const RG_PHONE  = '2489655355';

function apptRow(overrides = {}) {
  return {
    appt_id:        3998,
    appt_client_id: 1001,
    appt_case_id:   'MY0PZ04I',
    appt_type:      'Initial Strategy Session',
    type_key:       'iss',
    appt_length:    15,
    appt_platform:  'telephone',
    appt_date:      '2026-10-30 15:00:00',
    appt_status:    'Scheduled',
    appt_with:      1,
    appt_note:      '',
    appt_gcal:      '',
    appt_gcal_user: null,
    appt_view_id:   null,
    appt_link_type: 'case',
    appt_link_id:   'MY0PZ04I',
    contact_name:   'test tester',
    ...overrides,
  };
}

const USERS = new Map([
  [1,  { user: 1,  phone: SS_PHONE, user_real_name: 'Stuart Sandweiss', user_fname: 'Stuart' }],
  [22, { user: 22, phone: RG_PHONE, user_real_name: 'Rena Grunberger',  user_fname: 'Rena' }],
  [9,  { user: 9,  phone: '',       user_real_name: 'No Phone',         user_fname: 'No' }],
]);

function makeDb(seed = apptRow()) {
  const calls = [];
  const unmatched = [];
  const row = { ...seed };

  const query = async (sql, params = []) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    calls.push({ sql: flat, params });

    // fetchApptWithContact
    if (/^SELECT appts\.\*, contacts\.contact_phone/i.test(flat)) {
      return [Number(params[0]) === row.appt_id ? [{ ...row }] : []];
    }
    // insertApptLog's fetch
    if (/^SELECT appt_client_id, appt_case_id, appt_type, appt_date/i.test(flat)) {
      return [Number(params[0]) === row.appt_id ? [{ ...row }] : []];
    }
    if (/^UPDATE appts SET appt_status = 'Canceled'/i.test(flat)) {
      row.appt_status = 'Canceled';
      return [{ affectedRows: 1 }];
    }
    // notifyProviderOfUnattendedCancel
    if (/^SELECT phone FROM users WHERE user = \? LIMIT 1$/i.test(flat)) {
      const u = USERS.get(Number(params[0]));
      return [u ? [{ phone: u.phone }] : []];
    }
    // notifyStaffOfClientAction — facts + recipient phones
    if (/^SELECT a\.appt_type, a\.appt_date, a\.appt_with, c\.contact_name, u\.user_real_name/i.test(flat)) {
      const u = USERS.get(Number(row.appt_with));
      return [[{
        appt_type: row.appt_type, appt_date: row.appt_date, appt_with: row.appt_with,
        contact_name: row.contact_name,
        provider_name: u?.user_real_name ?? null, provider_fname: u?.user_fname ?? null,
      }]];
    }
    if (/^SELECT user, phone FROM users WHERE user IN \(\?\)$/i.test(flat)) {
      const ids = params[0];
      return [ids.map((id) => USERS.get(Number(id))).filter(Boolean).map((u) => ({ user: u.user, phone: u.phone }))];
    }
    unmatched.push(flat);
    return [[]];
  };

  return { calls, unmatched, row, query };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

function setSetting(k, v) { settingsState[k] = v; }

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(settingsState)) delete settingsState[k];
  setSetting('sms_default_from', DEFAULT_LINE);
  setSetting('sms_staff_from',   STAFF_LINE);
});

const providerLookups = (db) => db.calls.filter((c) => /^SELECT phone FROM users WHERE user = \?/i.test(c.sql));

async function cancel(db, opts) {
  const res = await apptService.cancelAppt(db, { appt_id: 3998, ...opts });
  await flush();
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('cancelAppt → provider notice', () => {
  test('automation cancel (no user) texts the provider at appt_with\'s phone, with the note', async () => {
    const db = makeDb();
    await cancel(db, {
      actingUserId: 0, source: 'staff',
      note: 'Canceled via Calendly by invitee - reason: not bored!',
    });

    expect(smsService.sendSms).toHaveBeenCalledTimes(1);
    expect(smsService.sendSms).toHaveBeenCalledWith(
      db, FROM, SS_PHONE,
      'Appt canceled: test tester, Initial Strategy Session Fri Oct 30, 3:00 PM. ' +
      'Canceled via Calendly by invitee - reason: not bored!'
    );
    expect(alert).not.toHaveBeenCalled();
    expect(db.unmatched).toEqual([]);
  });

  test('routes by appt_with, not a fixed person', async () => {
    const db = makeDb(apptRow({ appt_with: 22 }));
    await cancel(db, { actingUserId: 0, source: 'system', note: 'Case dismissed' });

    expect(smsService.sendSms).toHaveBeenCalledTimes(1);
    expect(smsService.sendSms.mock.calls[0][2]).toBe(RG_PHONE);
    expect(providerLookups(db).map((c) => c.params[0])).toEqual([22]);
    expect(db.unmatched).toEqual([]);
  });

  test('no note → sentence ends at the date', async () => {
    const db = makeDb();
    await cancel(db, { actingUserId: 0, source: 'system' });
    expect(smsService.sendSms.mock.calls[0][3])
      .toBe('Appt canceled: test tester, Initial Strategy Session Fri Oct 30, 3:00 PM.');
    expect(db.unmatched).toEqual([]);
  });

  test('a long note is clamped', async () => {
    const db = makeDb();
    await cancel(db, { actingUserId: 0, source: 'system', note: 'y'.repeat(3000) });
    const body = smsService.sendSms.mock.calls[0][3];
    expect(body).toMatch(/PM\. y{200}$/);
    expect(db.unmatched).toEqual([]);
  });

  test('staff click (acting user) → silent, no provider lookup', async () => {
    const db = makeDb();
    await cancel(db, { actingUserId: 5, source: 'staff', note: 'called in' });
    expect(smsService.sendSms).not.toHaveBeenCalled();
    expect(providerLookups(db)).toEqual([]);
    expect(db.unmatched).toEqual([]);
  });

  test('client cancel with the office roster on → exactly ONE text to the provider (no double)', async () => {
    setSetting('office_alerts_to', '1');           // provider is also the roster
    const db = makeDb();
    await cancel(db, { actingUserId: 0, source: 'client', note: '[Canceled by client via manage link]' });

    const toProvider = smsService.sendSms.mock.calls.filter((c) => c[2] === SS_PHONE);
    expect(toProvider).toHaveLength(1);
    expect(toProvider[0][3]).toMatch(/^Client cancel: /);   // the office alert, not this notice
    // The office alert also sends from the staff line — before 2026-10-14 it
    // read sms_default_from alone and texted Stuart from his own number.
    expect(toProvider[0][1]).toBe(STAFF_LINE);
    expect(providerLookups(db)).toEqual([]);
    expect(db.unmatched).toEqual([]);
  });

  test('client cancel with the roster off → this notice stays silent too', async () => {
    const db = makeDb();
    await cancel(db, { actingUserId: 0, source: 'client' });
    expect(smsService.sendSms).not.toHaveBeenCalled();
    expect(providerLookups(db)).toEqual([]);
    expect(db.unmatched).toEqual([]);
  });

  test.each([
    ['appt_with 0',    { appt_with: 0 }],
    ['appt_with null', { appt_with: null }],
  ])('%s → silent, no lookup', async (_l, over) => {
    const db = makeDb(apptRow(over));
    await cancel(db, { actingUserId: 0, source: 'system' });
    expect(smsService.sendSms).not.toHaveBeenCalled();
    expect(providerLookups(db)).toEqual([]);
    expect(db.unmatched).toEqual([]);
  });

  test('provider has no phone → skipped, no alert', async () => {
    const db = makeDb(apptRow({ appt_with: 9 }));
    await cancel(db, { actingUserId: 0, source: 'system' });
    expect(smsService.sendSms).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    expect(db.unmatched).toEqual([]);
  });

  test('sms_staff_from unset → falls back to sms_default_from', async () => {
    delete settingsState.sms_staff_from;
    const db = makeDb();
    await cancel(db, { actingUserId: 0, source: 'system' });
    expect(smsService.sendSms).toHaveBeenCalledTimes(1);
    expect(smsService.sendSms.mock.calls[0][1]).toBe(DEFAULT_LINE);
    expect(db.unmatched).toEqual([]);
  });

  test('blank sms_staff_from is treated as unset', async () => {
    setSetting('sms_staff_from', '   ');
    const db = makeDb();
    await cancel(db, { actingUserId: 0, source: 'system' });
    expect(smsService.sendSms.mock.calls[0][1]).toBe(DEFAULT_LINE);
    expect(db.unmatched).toEqual([]);
  });

  test('both sender settings unset → skipped before any lookup', async () => {
    delete settingsState.sms_default_from;
    delete settingsState.sms_staff_from;
    const db = makeDb();
    await cancel(db, { actingUserId: 0, source: 'system' });
    expect(smsService.sendSms).not.toHaveBeenCalled();
    expect(providerLookups(db)).toEqual([]);
    expect(db.unmatched).toEqual([]);
  });

  test('send failure → warning alert, cancel unaffected', async () => {
    smsService.sendSms.mockRejectedValueOnce(new Error('RC 503'));
    const db = makeDb();
    const res = await cancel(db, { actingUserId: 0, source: 'system' });

    expect(res).toEqual({ appt_id: 3998, taskId: null });
    expect(db.row.appt_status).toBe('Canceled');
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1]).toMatchObject({
      kind: 'provider_cancel_notice_failed', severity: 'warning',
    });
    expect(alert.mock.calls[0][1].message).toMatch(/RC 503/);
    expect(db.unmatched).toEqual([]);
  });
});
