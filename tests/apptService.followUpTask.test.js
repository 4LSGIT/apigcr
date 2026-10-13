// tests/apptService.followUpTask.test.js
//
/**
 * FOLLOW-UP TASK ASSIGNEE — cancelAppt / rescheduleLater
 *
 * Pins the fix for a silent loss found live 2026-10-13: an automation caller
 * with no user (the Calendly cancel workflow wf50 → POST /api/appts/cancel on
 * the internal API key, so req.auth has no userId) asked for a follow-up task
 * with create_task:true; cancelAppt passed to:0, createTask threw "requires
 * to", the catch swallowed it into console.error, and the route answered a
 * plain "Canceled". Every Calendly cancel since 2026-09-06 lost its task.
 *
 * Contract now:
 *   - acting user > 0           → task to the acting user (staff click, unchanged)
 *   - no acting user            → task to app_setting default_task_assignee
 *   - neither usable            → no task + error-severity alert (config fault)
 *   - createTask itself throws  → no task + warning alert; the cancel still succeeds
 *   - task_from stays the acting user (0 for automations — house convention)
 *
 * ── STUB POSTURE ────────────────────────────────────────────────────────────
 *   apptService runs for real. Collaborators are mocked; `db` is a SQL-matching
 *   router (tests/apptService.lineage.test.js idiom). Anything the router does
 *   not recognise lands in db.unmatched and every test asserts it is empty —
 *   cancelAppt's side effects are fire-and-forget, so a throwing stub would be
 *   swallowed and prove nothing.
 *
 * Run:
 *   npx jest tests/apptService.followUpTask.test.js
 */

'use strict';

// Mutable settings store the getSettings mock reads (keys absent ⇒ null).
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

const apptService   = require('../services/apptService');
const taskService   = require('../services/taskService');
const logService    = require('../services/logService');
const { getSettings } = require('../services/settingsService');
const { alert }     = require('../lib/alerting');

const calendarTypeService = require('../services/calendarTypeService');
beforeAll(() => calendarTypeService._primeCache(require('./fixtures/calendar_item_types.seed.json')));
afterAll(() => calendarTypeService.invalidate());

// ─────────────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────────────

const CONTACT_ID = 1001;

function apptRow(overrides = {}) {
  return {
    appt_id:        3998,
    appt_client_id: CONTACT_ID,
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
    // rescheduleLater's fetch
    if (/^SELECT appt_id, appt_client_id, appt_case_id, appt_type, type_key, appt_gcal/i.test(flat)) {
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
    if (/^UPDATE appts SET appt_status = 'Rescheduled'/i.test(flat)) {
      row.appt_status = 'Rescheduled';
      return [{ affectedRows: 1 }];
    }
    unmatched.push(flat);
    return [[]];
  };

  return { calls, unmatched, row, query };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

function setSetting(key, value) { settingsState[key] = value; }
function clearSettings() { for (const k of Object.keys(settingsState)) delete settingsState[k]; }

beforeEach(() => {
  jest.clearAllMocks();
  clearSettings();
});

/** The `Task` field of the single appt log row written (or undefined). */
function loggedTask() {
  expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
  return logService.createLogEntry.mock.calls[0][1].data.Task;
}

function alertKinds() {
  return alert.mock.calls.map((c) => c[1].kind);
}

// ─────────────────────────────────────────────────────────────────────────────
// cancelAppt
// ─────────────────────────────────────────────────────────────────────────────

describe('cancelAppt follow-up task', () => {
  test('automation caller (no user) → task goes to default_task_assignee, task_from stays 0', async () => {
    setSetting('default_task_assignee', '22');
    const db = makeDb();

    const res = await apptService.cancelAppt(db, {
      appt_id: 3998, actingUserId: 0, create_task: true, source: 'staff',
      note: 'Canceled via Calendly by invitee - reason: not bored!',
    });
    await flush();

    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    const args = taskService.createTask.mock.calls[0][1];
    expect(args.to).toBe(22);
    expect(args.from).toBe(0);
    expect(args.title).toBe('Appointment Cancellation Follow-up');
    expect(args.link_type).toBe('contact');
    expect(args.link_id).toBe(CONTACT_ID);
    expect(args.desc).toBe(
      'Initial Strategy Session on Fri Oct 30, 3:00 PM was canceled.\n' +
      'Note: Canceled via Calendly by invitee - reason: not bored!'
    );

    expect(res).toEqual({ appt_id: 3998, taskId: 4242 });
    expect(loggedTask()).toBe('4242');
    expect(db.row.appt_status).toBe('Canceled');
    expect(alert).not.toHaveBeenCalled();
    expect(db.unmatched).toEqual([]);
  });

  test('staff caller → task goes to the acting user, setting not consulted', async () => {
    setSetting('default_task_assignee', '22');
    const db = makeDb();

    const res = await apptService.cancelAppt(db, {
      appt_id: 3998, actingUserId: 5, create_task: true, source: 'staff',
    });
    await flush();

    const args = taskService.createTask.mock.calls[0][1];
    expect(args.to).toBe(5);
    expect(args.from).toBe(5);
    expect(args.desc).toBe('Initial Strategy Session on Fri Oct 30, 3:00 PM was canceled.');
    expect(res.taskId).toBe(4242);
    expect(getSettings.mock.calls.some((c) => c[1].includes('default_task_assignee'))).toBe(false);
    expect(db.unmatched).toEqual([]);
  });

  test.each([
    ['unset',          undefined],
    ['empty string',   ''],
    ['zero',           '0'],
    ['negative',       '-3'],
    ['not a number',   'RG'],
  ])('no user + default_task_assignee %s → no task, error alert, cancel still succeeds', async (_label, value) => {
    if (value !== undefined) setSetting('default_task_assignee', value);
    const db = makeDb();

    const res = await apptService.cancelAppt(db, {
      appt_id: 3998, actingUserId: 0, create_task: true, source: 'staff',
    });
    await flush();

    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(res).toEqual({ appt_id: 3998, taskId: null });
    expect(loggedTask()).toBeUndefined();
    expect(db.row.appt_status).toBe('Canceled');
    expect(alertKinds()).toEqual(['appt_followup_no_assignee']);
    expect(alert.mock.calls[0][1].severity).toBe('error');
    expect(db.unmatched).toEqual([]);
  });

  test('createTask throws → warning alert, cancel still returns, no Task logged', async () => {
    setSetting('default_task_assignee', '22');
    taskService.createTask.mockRejectedValueOnce(new Error('createTask: title exceeds 100 chars'));
    const db = makeDb();

    const res = await apptService.cancelAppt(db, {
      appt_id: 3998, actingUserId: 0, create_task: true, source: 'staff',
    });
    await flush();

    expect(res).toEqual({ appt_id: 3998, taskId: null });
    expect(loggedTask()).toBeUndefined();
    expect(alertKinds()).toEqual(['appt_followup_task_failed']);
    expect(alert.mock.calls[0][1].severity).toBe('warning');
    expect(alert.mock.calls[0][1].message).toMatch(/assignee=22/);
    expect(db.unmatched).toEqual([]);
  });

  test('create_task false → no task and no assignee lookup', async () => {
    setSetting('default_task_assignee', '22');
    const db = makeDb();

    const res = await apptService.cancelAppt(db, { appt_id: 3998, actingUserId: 0, source: 'staff' });
    await flush();

    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(getSettings.mock.calls.some((c) => c[1].includes('default_task_assignee'))).toBe(false);
    expect(res.taskId).toBeNull();
    expect(alert).not.toHaveBeenCalled();
    expect(db.unmatched).toEqual([]);
  });

  test('a long note is clamped so desc stays inside createTask\'s 1000-char cap', async () => {
    setSetting('default_task_assignee', '22');
    const db = makeDb();

    await apptService.cancelAppt(db, {
      appt_id: 3998, actingUserId: 0, create_task: true, source: 'staff',
      note: 'x'.repeat(5000),
    });
    await flush();

    const { desc } = taskService.createTask.mock.calls[0][1];
    expect(desc.length).toBeLessThanOrEqual(1000);
    expect(desc).toMatch(/\nNote: x{500}$/);
    expect(db.unmatched).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rescheduleLater
// ─────────────────────────────────────────────────────────────────────────────

describe('rescheduleLater follow-up task', () => {
  test('automation caller → default_task_assignee, reschedule wording', async () => {
    setSetting('default_task_assignee', '22');
    const db = makeDb();

    const res = await apptService.rescheduleLater(db, {
      appt_id: 3998, actingUserId: 0, create_task: true,
    });
    await flush();

    const args = taskService.createTask.mock.calls[0][1];
    expect(args.to).toBe(22);
    expect(args.from).toBe(0);
    expect(args.title).toBe('Appointment Reschedule Follow-up');
    expect(args.desc).toBe(
      'Initial Strategy Session on Fri Oct 30, 3:00 PM was marked rescheduled without a new appointment.'
    );
    expect(res).toEqual({ appt_id: 3998, taskId: 4242 });
    expect(loggedTask()).toBe('4242');
    expect(db.row.appt_status).toBe('Rescheduled');
    expect(db.unmatched).toEqual([]);
  });

  test('no user + no setting → no task, error alert', async () => {
    const db = makeDb();

    const res = await apptService.rescheduleLater(db, {
      appt_id: 3998, actingUserId: 0, create_task: true,
    });
    await flush();

    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(res.taskId).toBeNull();
    expect(alertKinds()).toEqual(['appt_followup_no_assignee']);
    expect(db.unmatched).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveFollowUpAssignee
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveFollowUpAssignee', () => {
  const db = { query: async () => { throw new Error('no SQL expected'); } };

  test('acting user wins', async () => {
    setSetting('default_task_assignee', '22');
    await expect(apptService.resolveFollowUpAssignee(db, 7)).resolves.toBe(7);
    await expect(apptService.resolveFollowUpAssignee(db, '7')).resolves.toBe(7);
  });

  test('falls back to the setting, tolerating whitespace', async () => {
    setSetting('default_task_assignee', ' 22 ');
    await expect(apptService.resolveFollowUpAssignee(db, 0)).resolves.toBe(22);
    await expect(apptService.resolveFollowUpAssignee(db, undefined)).resolves.toBe(22);
  });

  test('null when neither is usable', async () => {
    await expect(apptService.resolveFollowUpAssignee(db, 0)).resolves.toBeNull();
    setSetting('default_task_assignee', 'abc');
    await expect(apptService.resolveFollowUpAssignee(db, -1)).resolves.toBeNull();
  });
});
