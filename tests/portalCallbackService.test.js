// tests/portalCallbackService.test.js
//
// Slice 3.5 assertions for services/portalCallbackService.js and the
// portal_callback_reminder internal function — the callback contract:
// window math vs firm_blocks (per-window Shabbos/yom-tov precision),
// past-window rejection, one-open-request dedupe (both link shapes),
// canonical createTask usage, reminder-job shape, escaping of hostile
// client text, reminder skip-on-Deleted, cancel semantics, projection.
//
// Stub pattern from tests/portalDocsService.test.js (scripted mysql2 pool);
// taskService / phoneService / emailService / gcalService / settingsService
// are jest-mocked so these tests exercise portalCallbackService's rules,
// not the adapters. timezoneService is partially mocked: nowLocal is pinned
// to Mon 2026-08-10 10:00 firm-local so the horizon and past-window math
// are deterministic.
//
// Run:
//   npx jest tests/portalCallbackService.test.js

'use strict';

const { DateTime } = require('luxon');

jest.mock('../services/taskService', () => ({
  createTask:   jest.fn(),
  deleteTask:   jest.fn(),
  getTask:      jest.fn(),
  getSmsFrom:   jest.fn(),
  getFromEmail: jest.fn(),
}));
jest.mock('../services/phoneService', () => ({
  sendSms: jest.fn(),
}));
jest.mock('../services/emailService', () => ({
  sendEmail: jest.fn(),
}));
jest.mock('../services/gcalService', () => ({
  createEvent: jest.fn(),
}));
jest.mock('../services/settingsService', () => ({
  getSetting:  jest.fn(),
  getSettings: jest.fn(),
}));
jest.mock('../services/timezoneService', () => {
  const actual = jest.requireActual('../services/timezoneService');
  const { DateTime } = require('luxon');
  return {
    ...actual,
    // Monday 2026-08-10 10:00 firm-local — fixed "now" for all tests.
    nowLocal: jest.fn(() =>
      DateTime.fromISO('2026-08-10T10:00:00', { zone: actual.FIRM_TZ })),
  };
});

const taskService  = require('../services/taskService');
const phoneService = require('../services/phoneService');
const emailService = require('../services/emailService');
const gcalService  = require('../services/gcalService');
const { getSetting } = require('../services/settingsService');
const { FIRM_TZ }  = require('../services/timezoneService');

const svc = require('../services/portalCallbackService');
const reminderFns = require('../lib/internal_functions/portalCallback.js');
// T9 script-drift guard: registers this file's scripted stubs so a global
// afterEach can fail on over- OR under-consumption of the script array.
// See tests/helpers/scriptGuard.js.
const { scriptGuard } = require('./helpers/scriptGuard');

// ─────────────────────────────────────────────────────────────────────────────
// Stubs / fixtures
// ─────────────────────────────────────────────────────────────────────────────

// Plain pool stub: query() shifts the next scripted [rows] result.
function stubDb(script) {
  const calls = [];
  const guard = scriptGuard('stubDb', script);
  return {
    calls,
    guard,                       // escape hatches: expectOverruns() / allowLeftovers()
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) guard.overrun(sql);
      return [script.shift()];
    },
  };
}

// Live-shaped firm_blocks rows for the pinned week (naive firm-local wall
// strings — the service's fetch is DATE_FORMAT so rows are strings):
//   Shabbos: Fri 2026-08-14 19:55 → Sat 2026-08-15 21:46
const SHABBOS = { s: '2026-08-14 19:55:00', e: '2026-08-15 21:46:00' };

const CONTACT_ID = 777;
const CASES_ONE  = [{ case_id: 'AbCdEf12' }];
const CASES_TWO  = [{ case_id: 'AbCdEf12' }, { case_id: 'ZyXwVu98' }];

function validBody(over = {}) {
  return Object.assign({
    date: '2026-08-13',     // Thursday — unblocked
    window: '14-16',
    phone: '(248) 555-1212',
    message: 'Question about my filing.',
  }, over);
}

// Scripted results for a clean createRequest run:
//   1 firm_blocks (validation) → 2 case ids → 3 open-request → 4 contact →
//   5 scheduled_jobs INSERT
function createScript({ blocks = [], cases = CASES_ONE, open = [] } = {}) {
  return [
    blocks,                                   // _fetchBlocks (requested window)
    cases,                                    // _visibleCaseIds
    open,                                     // _openRequest
    [{ contact_name: 'Test Client' }],        // contacts
    { insertId: 55 },                         // scheduled_jobs INSERT
  ];
}

afterEach(() => jest.clearAllMocks());

beforeEach(() => {
  getSetting.mockResolvedValue('1');                       // portal_callback_task_to
  taskService.createTask.mockResolvedValue({ task_id: 42, action_token: 't', action_url: 'u' });
  gcalService.createEvent.mockResolvedValue({ id: 'evt1' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Window grid — firm_blocks precision + past cutoff
// ─────────────────────────────────────────────────────────────────────────────

describe('_buildGrid', () => {
  test('per-window Shabbos precision: Fri 6–8 blocked (19:55 start), Fri 4–6 open; all Sat windows blocked', async () => {
    const db = stubDb([[SHABBOS]]);
    const days = await svc._buildGrid(db);

    const fri = days.find(d => d.date === '2026-08-14');
    const sat = days.find(d => d.date === '2026-08-15');
    expect(fri).toBeTruthy();
    expect(sat).toBeTruthy();

    const w = (day, key) => day.windows.find(x => x.key === key);
    expect(w(fri, '16-18').available).toBe(true);   // ends 18:00 < 19:55
    expect(w(fri, '18-20').available).toBe(false);  // 19:55 < 20:00 → overlap
    expect(w(fri, '20-22').available).toBe(false);
    for (const win of sat.windows) {
      expect(win.available).toBe(false);            // block runs to 21:46 Sat
    }
  });

  test('past cutoff: today\'s elapsed/started windows are unavailable, later ones open', async () => {
    const db = stubDb([[]]);
    const days = await svc._buildGrid(db);
    const mon = days[0];
    expect(mon.date).toBe('2026-08-10');
    const w = key => mon.windows.find(x => x.key === key);
    // now = 10:00 — every window today starts later; 12-14 opens at 12:00 > 10:00.
    expect(w('12-14').available).toBe(true);
    // Boundary sanity: a grid built at "now = 13:00" drops the started 12-14
    // window but keeps 14-16 (starts 14:00 > 13:00).
    const later = DateTime.fromISO('2026-08-10T13:00:00', { zone: FIRM_TZ });
    const db2 = stubDb([[]]);
    const days2 = await svc._buildGrid(db2, later);
    expect(days2[0].windows.find(x => x.key === '12-14').available).toBe(false);
    expect(days2[0].windows.find(x => x.key === '14-16').available).toBe(true);
  });

  test('horizon is exactly HORIZON_DAYS days starting today', async () => {
    const db = stubDb([[]]);
    const days = await svc._buildGrid(db);
    expect(days).toHaveLength(svc.HORIZON_DAYS);
    expect(days[0].date).toBe('2026-08-10');
    expect(days[svc.HORIZON_DAYS - 1].date).toBe('2026-08-16');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createRequest — validation
// ─────────────────────────────────────────────────────────────────────────────

describe('createRequest validation', () => {
  test('unknown window key → 400', async () => {
    const db = stubDb([]);
    await expect(svc.createRequest(db, CONTACT_ID, validBody({ window: '13-15' })))
      .rejects.toMatchObject({ status: 400 });
  });

  test('date outside the 7-day horizon → 400', async () => {
    const db = stubDb([]);
    await expect(svc.createRequest(db, CONTACT_ID, validBody({ date: '2026-08-17' })))
      .rejects.toMatchObject({ status: 400 });
    await expect(svc.createRequest(db, CONTACT_ID, validBody({ date: '2026-08-09' })))
      .rejects.toMatchObject({ status: 400 });
  });

  test('already-started window today → 400', async () => {
    // now pinned to Mon 10:00; Monday has no started window, so pin a
    // request for a window that starts before now on a later mocked now is
    // covered in the grid test — here use the same-day guard via an
    // artificial 12-14 on Monday with now moved by the grid test only.
    // Direct check: Monday 12-14 starts 12:00 > 10:00 → passes time gate,
    // so instead assert the guard message shape using yesterday-equivalent:
    // Monday with window already started can only occur when now >= start;
    // emulate by requesting Monday 12-14 after re-pinning nowLocal.
    const tz = require('../services/timezoneService');
    tz.nowLocal.mockReturnValueOnce(
      DateTime.fromISO('2026-08-10T12:30:00', { zone: FIRM_TZ }));
    const db = stubDb([]);
    await expect(svc.createRequest(db, CONTACT_ID,
      validBody({ date: '2026-08-10', window: '12-14' })))
      .rejects.toMatchObject({ status: 400 });
  });

  test('firm-blocked window → 400', async () => {
    const db = stubDb([[SHABBOS]]);
    await expect(svc.createRequest(db, CONTACT_ID,
      validBody({ date: '2026-08-14', window: '18-20' })))
      .rejects.toMatchObject({ status: 400 });
  });

  test('invalid phone → 400; 11-digit leading-1 accepted', async () => {
    const db = stubDb([]);
    await expect(svc.createRequest(db, CONTACT_ID, validBody({ phone: '555-1212' })))
      .rejects.toMatchObject({ status: 400 });
    expect(svc._normalizePhone('1 (248) 555-1212')).toBe('2485551212');
    expect(svc._normalizePhone('22485551212')).toBe(null);
  });

  test('empty message → 400; over-cap message → 400', async () => {
    const db = stubDb([]);
    await expect(svc.createRequest(db, CONTACT_ID, validBody({ message: '   ' })))
      .rejects.toMatchObject({ status: 400 });
    const db2 = stubDb([]);
    await expect(svc.createRequest(db2, CONTACT_ID,
      validBody({ message: 'x'.repeat(801) })))
      .rejects.toMatchObject({ status: 400 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createRequest — dedupe (both link shapes reachable by the lookup)
// ─────────────────────────────────────────────────────────────────────────────

describe('createRequest dedupe', () => {
  test('open request exists → 409 carrying the pending shape', async () => {
    const db = stubDb([
      [],                                                  // blocks
      CASES_ONE,                                           // case ids
      [{ task_id: 9, task_to: 1, start_date: '2026-08-12',
         created_at: '2026-08-10 09:00:00' }],             // open request
      [{ data: JSON.stringify({ params: { window_label: '2:00–4:00 PM',
                                          date: '2026-08-12' } }) }], // job
    ]);
    await expect(svc.createRequest(db, CONTACT_ID, validBody()))
      .rejects.toMatchObject({
        status: 409,
        pending: expect.objectContaining({
          task_id: 9, window_label: '2:00–4:00 PM', date: '2026-08-12',
        }),
      });
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  test('open-request lookup covers BOTH link shapes: contact branch + every visible case id', async () => {
    const db = stubDb(createScript({ cases: CASES_TWO }));
    await svc.createRequest(db, CONTACT_ID, validBody());
    const lookup = db.calls.find(c => c.sql.includes("task_source = ?"));
    expect(lookup).toBeTruthy();
    expect(lookup.sql).toContain("task_link_type = 'contact'");
    expect(lookup.sql).toContain("task_link_type = 'case'");
    expect(lookup.params).toEqual(expect.arrayContaining([
      'portal_callback', String(CONTACT_ID), 'AbCdEf12', 'ZyXwVu98',
    ]));
  });

  test('no visible cases → lookup has no case branch and still works', async () => {
    const db = stubDb(createScript({ cases: [] }));
    await svc.createRequest(db, CONTACT_ID, validBody());
    const lookup = db.calls.find(c => c.sql.includes("task_source = ?"));
    expect(lookup.sql).not.toContain("task_link_type = 'case'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createRequest — canonical task + reminder job
// ─────────────────────────────────────────────────────────────────────────────

describe('createRequest task + reminder job', () => {
  test('canonical createTask: from 0, settings assignee, source, start DATE, NO due; single-case auto-link', async () => {
    getSetting.mockResolvedValue('22');
    const db = stubDb(createScript({ cases: CASES_ONE }));
    await svc.createRequest(db, CONTACT_ID, validBody());

    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    const args = taskService.createTask.mock.calls[0][1];
    expect(args).toMatchObject({
      from: 0,
      to: 22,
      source: 'portal_callback',
      start: '2026-08-13',
      due: null,
      link_type: 'case',
      link_id: 'AbCdEf12',
    });
    expect(args.title.length).toBeLessThanOrEqual(100);
    expect(args.title).toContain('Test Client');
    expect(args.title).toContain('2:00–4:00 PM');
    expect(args.desc.length).toBeLessThanOrEqual(1000);
    expect(args.desc).toContain('(248) 555-1212');
    expect(args.desc).toContain('Question about my filing.');
  });

  test('multi-case contact → task links to the contact, not a case', async () => {
    const db = stubDb(createScript({ cases: CASES_TWO }));
    await svc.createRequest(db, CONTACT_ID, validBody());
    expect(taskService.createTask.mock.calls[0][1]).toMatchObject({
      link_type: 'contact',
      link_id: String(CONTACT_ID),
    });
  });

  test('reminder job: one_time at window start (UTC), deterministic name, internal_function payload', async () => {
    const db = stubDb(createScript());
    await svc.createRequest(db, CONTACT_ID, validBody());

    const ins = db.calls.find(c => c.sql.startsWith('INSERT INTO scheduled_jobs'));
    expect(ins).toBeTruthy();
    const [when, name, dataJson] = ins.params;
    const expectedUTC = DateTime
      .fromISO('2026-08-13T14:00:00', { zone: FIRM_TZ }).toUTC().toJSDate();
    expect(when).toEqual(expectedUTC);
    expect(name).toBe('Portal callback reminder — task #42');
    const data = JSON.parse(dataJson);
    expect(data).toMatchObject({
      type: 'internal_function',
      function_name: 'portal_callback_reminder',
      params: {
        task_id: 42, contact_id: CONTACT_ID, phone: '2485551212',
        window_label: '2:00–4:00 PM', date: '2026-08-13',
      },
    });
  });

  test('misconfigured assignee setting → throws (never assigns to 0/NaN)', async () => {
    getSetting.mockResolvedValue(null);
    // 4 of createScript()'s 5 entries: the throw lands after the contacts read
    // and before the scheduled_jobs INSERT, so the INSERT result is never used.
    // Scripting it anyway would hide a regression that ran the INSERT.
    const db = stubDb(createScript().slice(0, 4));
    await expect(svc.createRequest(db, CONTACT_ID, validBody()))
      .rejects.toThrow(/portal_callback_task_to/);
    expect(taskService.createTask).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Escaping — hostile client text inert on staff surfaces
// ─────────────────────────────────────────────────────────────────────────────

describe('escaping', () => {
  const HOSTILE = `<script>alert('x')</script><img src=x onerror=alert(1)>`;

  test('GCal event description escapes the message', async () => {
    const db = stubDb(createScript());
    const ctx = await svc.createRequest(db, CONTACT_ID,
      validBody({ message: HOSTILE }));
    await svc.fireCreateSideEffects(db, ctx);

    const call = gcalService.createEvent.mock.calls[0][1];
    expect(call.event).toEqual({ transparency: 'transparent' });
    expect(call.description).not.toContain('<script>');
    expect(call.description).toContain('&lt;script&gt;');
    expect(call.description).not.toContain('<img');
  });

  test('cancel-notification email escapes the contact name', async () => {
    taskService.deleteTask.mockResolvedValue({});
    taskService.getFromEmail.mockResolvedValue('automations@x.com');
    const db = stubDb([
      [],                                                       // case ids
      [{ task_id: 9, task_to: 1, start_date: '2026-08-12',
         created_at: '2026-08-10 09:00:00' }],                  // open
      [{ data: JSON.stringify({ params: { window_label: '2:00–4:00 PM',
                                          date: '2026-08-12' } }) }],
      [{ contact_name: `<b>Evil</b>` }],                        // contact
    ]);
    const ctx = await svc.cancelRequest(db, CONTACT_ID);

    const db2 = stubDb([
      [{ email: 'ss@x.com', phone: null, allow_sms: 0 }],       // assignee
    ]);
    await svc.fireCancelSideEffects(db2, ctx);
    const mail = emailService.sendEmail.mock.calls[0][1];
    expect(mail.html).not.toContain('<b>Evil</b>');
    expect(mail.html).toContain('&lt;b&gt;Evil&lt;/b&gt;');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cancelRequest
// ─────────────────────────────────────────────────────────────────────────────

describe('cancelRequest', () => {
  test('no open request → null (route maps to uniform 404)', async () => {
    const db = stubDb([
      [],   // case ids
      [],   // open lookup — nothing
    ]);
    expect(await svc.cancelRequest(db, CONTACT_ID)).toBe(null);
    expect(taskService.deleteTask).not.toHaveBeenCalled();
  });

  test('open request → canonical soft-delete with automation actor', async () => {
    taskService.deleteTask.mockResolvedValue({});
    const db = stubDb([
      [],
      [{ task_id: 9, task_to: 1, start_date: '2026-08-12',
         created_at: '2026-08-10 09:00:00' }],
      [{ data: JSON.stringify({ params: { window_label: '2:00–4:00 PM',
                                          date: '2026-08-12' } }) }],
      [{ contact_name: 'Test Client' }],
    ]);
    const ctx = await svc.cancelRequest(db, CONTACT_ID);
    expect(taskService.deleteTask).toHaveBeenCalledWith(db, 9, 0,
      expect.objectContaining({ source: 'portal_callback', canceled_by: 'client' }));
    expect(ctx).toMatchObject({ task_id: 9, assignee: 1, name: 'Test Client' });
  });

  test('ownership: the open-request lookup is scoped to the authed contact', async () => {
    const db = stubDb([[], []]);
    await svc.cancelRequest(db, CONTACT_ID);
    const lookup = db.calls.find(c => c.sql.includes('task_source = ?'));
    expect(lookup.params).toEqual(expect.arrayContaining([String(CONTACT_ID)]));
  });

  test('cancel SMS path when the assignee allows SMS', async () => {
    taskService.getSmsFrom.mockResolvedValue('2485550000');
    const db = stubDb([
      [{ email: 'ss@x.com', phone: '2485559999', allow_sms: 1 }],
    ]);
    await svc.fireCancelSideEffects(db, {
      assignee: 1, name: 'Test Client',
      day_label: 'Wed Aug 12', window_label: '2:00–4:00 PM',
    });
    expect(phoneService.sendSms).toHaveBeenCalledWith(
      db, '2485550000', '2485559999',
      expect.stringContaining('Callback request canceled: Test Client'));
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getState — projection
// ─────────────────────────────────────────────────────────────────────────────

describe('getState projection', () => {
  test('exposes only pending/days/phone; phone normalized; no grid while pending', async () => {
    const db = stubDb([
      CASES_ONE,                                               // case ids
      [{ task_id: 9, task_to: 1, start_date: '2026-08-12',
         created_at: '2026-08-10 09:00:00' }],                 // open
      [{ data: JSON.stringify({ params: { window_label: '2:00–4:00 PM',
                                          date: '2026-08-12' } }) }],
      [{ contact_phone: '12485551212' }],                      // contact
    ]);
    const out = await svc.getState(db, CONTACT_ID);
    expect(Object.keys(out).sort()).toEqual(['days', 'pending', 'phone']);
    expect(out.phone).toBe('2485551212');
    expect(out.days).toEqual([]);
    expect(out.pending).toMatchObject({
      task_id: 9, window_label: '2:00–4:00 PM', day_label: 'Wed Aug 12',
    });
    // Nothing internal leaks through the pending shape.
    expect(JSON.stringify(out)).not.toContain('task_to');
  });

  test('no pending → grid present, phone falls back to empty when unparseable', async () => {
    const db = stubDb([
      [],                                                      // case ids
      [],                                                      // open — none
      [],                                                      // blocks (grid)
      [{ contact_phone: '555' }],                              // junk phone
    ]);
    const out = await svc.getState(db, CONTACT_ID);
    expect(out.pending).toBe(null);
    expect(out.days).toHaveLength(svc.HORIZON_DAYS);
    expect(out.phone).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// portal_callback_reminder internal function
// ─────────────────────────────────────────────────────────────────────────────

describe('portal_callback_reminder', () => {
  const fn = reminderFns.portal_callback_reminder;
  const PARAMS = {
    task_id: 42, contact_id: CONTACT_ID,
    phone: '2485551212', window_label: '2:00–4:00 PM', date: '2026-08-13',
  };

  test('skips silently when the task is Deleted (client cancel — no job plumbing needed)', async () => {
    taskService.getTask.mockResolvedValue({ status: 'Deleted', to: { id: 1 } });
    const db = stubDb([]);
    const out = await fn(PARAMS, db);
    expect(out).toMatchObject({ success: true, skipped: true });
    expect(phoneService.sendSms).not.toHaveBeenCalled();
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  test('SMS to the CURRENT assignee with name, phone, window, and contact deep-link', async () => {
    taskService.getTask.mockResolvedValue({
      status: 'Pending', title: 't', to: { id: 22 },
    });
    taskService.getSmsFrom.mockResolvedValue('2485550000');
    const db = stubDb([
      [{ contact_name: 'Test Client' }],                       // contact
      [{ email: 'r@x.com', phone: '2485558888', allow_sms: 1 }], // assignee 22
    ]);
    const out = await fn(PARAMS, db);
    expect(out).toMatchObject({ success: true, output: { notified: 'sms' } });
    const [, from, to, body] = phoneService.sendSms.mock.calls[0];
    expect(from).toBe('2485550000');
    expect(to).toBe('2485558888');
    expect(body).toContain('Callback now: Test Client');
    expect(body).toContain('(248) 555-1212');
    expect(body).toContain('2:00–4:00 PM');
    expect(body).toContain(`/?contact=${CONTACT_ID}`);
  });

  test('email fallback when the assignee disallows SMS — hostile name escaped', async () => {
    taskService.getTask.mockResolvedValue({
      status: 'Pending', title: 't', to: { id: 1 },
    });
    taskService.getFromEmail.mockResolvedValue('automations@x.com');
    const db = stubDb([
      [{ contact_name: `<i>Evil</i>` }],
      [{ email: 'ss@x.com', phone: '2485559999', allow_sms: 0 }],
    ]);
    const out = await fn(PARAMS, db);
    expect(out).toMatchObject({ success: true, output: { notified: 'email' } });
    const mail = emailService.sendEmail.mock.calls[0][1];
    expect(mail.to).toBe('ss@x.com');
    expect(mail.html).not.toContain('<i>Evil</i>');
    expect(mail.html).toContain('&lt;i&gt;Evil&lt;/i&gt;');
    expect(phoneService.sendSms).not.toHaveBeenCalled();
  });

  test('missing task → skip, not throw (job retry would be pointless)', async () => {
    taskService.getTask.mockResolvedValue(null);
    const out = await fn(PARAMS, stubDb([]));
    expect(out).toMatchObject({ success: true, skipped: true });
  });
});
