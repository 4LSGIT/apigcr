// tests/apptStatusGuards.test.js
//
/**
 * APPOINTMENT TRANSITION STATUS GUARDS — cancelAppt / rescheduleAppt /
 * rescheduleLater (Casey fix package, independent review 2026-10-21).
 *
 * A repeated transition (stale Ask Casey card, second tab, double-submitted
 * form, replayed request) must not run its side effects again: a second cancel
 * re-sent the client notice and teardown; a second reschedule of one row
 * minted a second successor. Contract:
 *   - already in the target state         → 409 appt_status_conflict, nothing written
 *   - raced into it after the pre-read    → the conditional UPDATE changes 0 rows
 *                                           → 409, no log row, no successor
 *   - native corrections stay allowed     → cancel from Attended, reschedule-later
 *                                           from Canceled
 *
 * ── STUB POSTURE ────────────────────────────────────────────────────────────
 *   apptService runs for real; collaborators mocked (followUpTask idiom). The
 *   db router evaluates the UPDATE's own status predicate against its row, so a
 *   service that drops `AND appt_status <> …` changes the row under a race and
 *   the race tests fail.
 *
 * Run: npx jest tests/apptStatusGuards.test.js
 */

'use strict';

jest.mock('../services/settingsService', () => ({ getSettings: jest.fn(async (_db, keys) => Object.fromEntries(keys.map((k) => [k, null]))) }));
jest.mock('../services/phoneService', () => ({ sendSms: jest.fn(async () => ({})) }));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => ({})) }));
jest.mock('../services/gcalService', () => ({
  createEvent: jest.fn(async () => ({ id: 'gcal-evt-1' })),
  deleteEvent: jest.fn(async () => ({})),
  _resolveTarget: jest.fn(async () => ({ calendarId: 'firm@example.com' })),
}));
jest.mock('../services/taskService', () => ({ createTask: jest.fn(async () => ({ task_id: 4242 })) }));
jest.mock('../services/logService', () => ({ createLogEntry: jest.fn(async () => ({ log_id: 1 })) }));
jest.mock('../services/resolverService', () => ({ resolve: jest.fn(async (s) => s) }));
jest.mock('../lib/sequenceEngine', () => ({
  cancelSequences: jest.fn(async () => ({})),
  cancelByApptId: jest.fn(async () => ({})),
  enrollContact: jest.fn(async () => ({})),
}));
jest.mock('../services/hookService', () => ({ executeHook: jest.fn(async () => ({})) }));
jest.mock('../lib/domainEvents', () => ({
  emit: jest.fn(() => Promise.resolve()),
  buildChanges: jest.fn(() => ({})),
  runAsAction: (_ruleId, fn) => fn(),
  MAX_DEPTH: 4,
}));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(() => Promise.resolve()) }));

const apptService = require('../services/apptService');
const logService = require('../services/logService');

function apptRow(overrides = {}) {
  return {
    appt_id: 3998, appt_client_id: 1001, appt_case_id: 'MY0PZ04I', appt_type: 'Initial Strategy Session',
    type_key: 'iss', appt_length: 15, appt_platform: 'telephone', appt_date: '2026-10-30 15:00:00',
    appt_status: 'Scheduled', appt_with: 1, appt_note: '', appt_gcal: '', appt_gcal_user: null,
    appt_view_id: null, appt_link_type: 'case', appt_link_id: 'MY0PZ04I', contact_name: 'test tester',
    ...overrides,
  };
}

// `raceTo`: the status another writer commits right after this call's
// pre-read — the pre-read still sees the old status.
function makeDb(seed = apptRow(), { raceTo = null } = {}) {
  const row = { ...seed };
  const calls = [];
  const unmatched = [];
  const snapshot = () => {
    const seen = { ...row };
    if (raceTo) row.appt_status = raceTo;
    return seen;
  };
  const query = async (sql, params = []) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    calls.push(flat);
    if (/^SELECT appts\.\*, contacts\.contact_phone/i.test(flat)
      || /^SELECT \* FROM appts WHERE appt_id = \?/i.test(flat)
      || /^SELECT appt_id, appt_client_id, appt_case_id, appt_type, type_key, appt_gcal/i.test(flat)) {
      return [Number(params[0]) === row.appt_id ? [snapshot()] : []];
    }
    if (/^SELECT appt_client_id, appt_case_id, appt_type, appt_date/i.test(flat)) return [[{ ...row }]];
    const update = /^UPDATE appts SET appt_status = '(Canceled|Rescheduled)'/i.exec(flat);
    if (update) {
      const guard = /AND appt_status <> '([A-Za-z ]+)'/i.exec(flat);
      if (guard && row.appt_status === guard[1]) return [{ affectedRows: 0 }];
      row.appt_status = update[1];
      return [{ affectedRows: 1 }];
    }
    unmatched.push(flat);
    return [[]];
  };
  return { row, calls, unmatched, query };
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const inserts = (db) => db.calls.filter((sql) => /^INSERT INTO appts\b/i.test(sql)).length;

beforeEach(() => jest.clearAllMocks());

describe('cancelAppt', () => {
  test('a second cancel is a 409 and writes nothing', async () => {
    const db = makeDb();
    await apptService.cancelAppt(db, { appt_id: 3998, actingUserId: 6, source: 'staff' });
    await flush();
    expect(db.row.appt_status).toBe('Canceled');
    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
    const updates = db.calls.filter((sql) => /^UPDATE appts/i.test(sql)).length;
    await expect(apptService.cancelAppt(db, { appt_id: 3998, actingUserId: 6, source: 'staff' }))
      .rejects.toMatchObject({ status: 409, code: 'appt_status_conflict' });
    await flush();
    expect(db.calls.filter((sql) => /^UPDATE appts/i.test(sql)).length).toBe(updates);
    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
  });

  test('a cancel that loses a race after its pre-read changes nothing and is a 409', async () => {
    const db = makeDb(apptRow(), { raceTo: 'Canceled' });
    await expect(apptService.cancelAppt(db, { appt_id: 3998, note: 'second tab', actingUserId: 6, source: 'staff' }))
      .rejects.toMatchObject({ status: 409 });
    await flush();
    expect(logService.createLogEntry).not.toHaveBeenCalled();
  });

  test('the native correction (cancel an Attended appointment) still works', async () => {
    const db = makeDb(apptRow({ appt_status: 'Attended' }));
    await expect(apptService.cancelAppt(db, { appt_id: 3998, actingUserId: 6, source: 'staff' })).resolves.toMatchObject({ appt_id: 3998 });
    expect(db.row.appt_status).toBe('Canceled');
  });
});

describe('rescheduleAppt', () => {
  test('rescheduling a Rescheduled appointment is a 409 before any write or successor', async () => {
    const db = makeDb(apptRow({ appt_status: 'Rescheduled' }));
    await expect(apptService.rescheduleAppt(db, { appt_id: 3998, newDate: '2026-11-02 10:00:00', actingUserId: 6, source: 'staff' }))
      .rejects.toMatchObject({ status: 409, code: 'appt_status_conflict' });
    expect(db.calls.some((sql) => /^UPDATE appts/i.test(sql))).toBe(false);
    expect(inserts(db)).toBe(0);
  });

  test('a reschedule that loses a race after its pre-read mints no second successor', async () => {
    const db = makeDb(apptRow(), { raceTo: 'Rescheduled' });
    await expect(apptService.rescheduleAppt(db, { appt_id: 3998, newDate: '2026-11-02 10:00:00', actingUserId: 6, source: 'staff' }))
      .rejects.toMatchObject({ status: 409 });
    await flush();
    expect(inserts(db)).toBe(0);
    expect(logService.createLogEntry).not.toHaveBeenCalled();
  });
});

describe('rescheduleLater', () => {
  test('a second reschedule-later is a 409 and writes nothing', async () => {
    const db = makeDb();
    await apptService.rescheduleLater(db, { appt_id: 3998, actingUserId: 6, source: 'staff' });
    await flush();
    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
    const updates = db.calls.filter((sql) => /^UPDATE appts/i.test(sql)).length;
    await expect(apptService.rescheduleLater(db, { appt_id: 3998, actingUserId: 6, source: 'staff' }))
      .rejects.toMatchObject({ status: 409 });
    expect(db.calls.filter((sql) => /^UPDATE appts/i.test(sql)).length).toBe(updates);
    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
  });

  test('a reschedule-later that loses a race is a 409 with no log row', async () => {
    const db = makeDb(apptRow(), { raceTo: 'Rescheduled' });
    await expect(apptService.rescheduleLater(db, { appt_id: 3998, actingUserId: 6, source: 'staff' }))
      .rejects.toMatchObject({ status: 409 });
    await flush();
    expect(logService.createLogEntry).not.toHaveBeenCalled();
  });

  test('the native correction (reschedule-later a Canceled appointment) still works', async () => {
    const db = makeDb(apptRow({ appt_status: 'Canceled' }));
    await expect(apptService.rescheduleLater(db, { appt_id: 3998, actingUserId: 6, source: 'staff' })).resolves.toMatchObject({ appt_id: 3998 });
    expect(db.row.appt_status).toBe('Rescheduled');
  });
});
