// tests/internalFn.cancelCaseAppts.test.js
//
// Guards the cancel_case_appointments contract in
// lib/internal_functions/appointments.js — the terminal-stage cascade action
// (case dismissed / closed → sweep future Scheduled appts).
//
// The three load-bearing promises:
//   1. ALWAYS SILENT — every cancelAppt call carries sms:false, email:false,
//      and there is no param that can flip that. (A wrong auto-cancel that
//      texts the client is a client-facing incident.)
//   2. Per-appt errors are ISOLATED — an already-Canceled race must not abort
//      the sweep; it lands in output.failed, and later rows still cancel.
//   3. Only Scheduled rows at/after the cutoff are targeted, and the cutoff
//      defaults to firm-local now (appt_date is stored naive firm-local).
//
// apptService and timezoneService are mocked — this file asserts marshalling
// and control flow, not DB behaviour.
//
// Run:
//   npx jest tests/internalFn.cancelCaseAppts.test.js

'use strict';

jest.mock('../services/apptService', () => ({
  cancelAppt: jest.fn(async () => ({ appt_id: 1, taskId: null })),
}));

jest.mock('../services/timezoneService', () => ({
  nowLocal: jest.fn(() => ({
    toFormat: () => '2026-08-24 12:00:00',
  })),
}));

const apptService = require('../services/apptService');
const fns = require('../lib/internal_functions/appointments');

function mkDb(rows) {
  return { query: jest.fn(async () => [rows]) };
}

const ROWS = [
  { appt_id: 101, appt_type: '341 Meeting',   appt_date: '2026-09-01 10:00:00' },
  { appt_id: 102, appt_type: 'Status Update', appt_date: '2026-09-15 14:00:00' },
];

beforeEach(() => {
  apptService.cancelAppt.mockClear();
  apptService.cancelAppt.mockImplementation(async () => ({ appt_id: 1, taskId: null }));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe('cancel_case_appointments — input validation', () => {
  test('missing case_id throws before any query', async () => {
    const db = mkDb(ROWS);
    await expect(fns.cancel_case_appointments({}, db)).rejects.toThrow(/requires case_id/);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('cancel_case_appointments — selection SQL', () => {
  test('targets only Scheduled rows on the case at/after the cutoff; default cutoff is firm-local now', async () => {
    const db = mkDb(ROWS);
    await fns.cancel_case_appointments({ case_id: 'ABC12345' }, db);

    const [sql, bind] = db.query.mock.calls[0];
    expect(sql).toMatch(/appt_case_id = \?/);
    expect(sql).toMatch(/appt_status\s+= 'Scheduled'/);
    expect(sql).toMatch(/appt_date\s+>= \?/);
    expect(bind).toEqual(['ABC12345', '2026-08-24 12:00:00']);
  });

  test('explicit `from` overrides the default cutoff (backfill sweep of stale past rows)', async () => {
    const db = mkDb(ROWS);
    await fns.cancel_case_appointments({ case_id: 'ABC12345', from: '2026-08-01' }, db);
    expect(db.query.mock.calls[0][1]).toEqual(['ABC12345', '2026-08-01']);
  });

  test('blank `from` (blanked {{placeholder}}) degrades to the default, not an empty bound', async () => {
    const db = mkDb(ROWS);
    await fns.cancel_case_appointments({ case_id: 'ABC12345', from: '   ' }, db);
    expect(db.query.mock.calls[0][1]).toEqual(['ABC12345', '2026-08-24 12:00:00']);
  });

  test('appt_type CSV narrows via IN (…) with trimmed tokens', async () => {
    const db = mkDb(ROWS);
    await fns.cancel_case_appointments(
      { case_id: 'ABC12345', appt_type: ' 341 Meeting , Status Update ' }, db
    );
    const [sql, bind] = db.query.mock.calls[0];
    expect(sql).toMatch(/appt_type IN \(\?, \?\)/);
    expect(bind).toEqual(['ABC12345', '2026-08-24 12:00:00', '341 Meeting', 'Status Update']);
  });
});

describe('cancel_case_appointments — ALWAYS SILENT', () => {
  test('every cancelAppt call is sms:false email:false with cancel_gcal:true', async () => {
    const db = mkDb(ROWS);
    await fns.cancel_case_appointments({ case_id: 'ABC12345', note: 'Auto: dismissed' }, db);

    expect(apptService.cancelAppt).toHaveBeenCalledTimes(2);
    for (const [, args] of apptService.cancelAppt.mock.calls) {
      expect(args.sms).toBe(false);
      expect(args.email).toBe(false);
      expect(args.cancel_gcal).toBe(true);
      expect(args.note).toBe('Auto: dismissed');
      expect(args.source).toBe('system');
    }
  });

  test('there is no notify escape hatch — sms/email params are not honored', async () => {
    const db = mkDb([ROWS[0]]);
    // A caller trying to force notification gets silence anyway.
    await fns.cancel_case_appointments(
      { case_id: 'ABC12345', sms: true, email: true, confirm_message: 'hi' }, db
    );
    const [, args] = apptService.cancelAppt.mock.calls[0];
    expect(args.sms).toBe(false);
    expect(args.email).toBe(false);
  });
});

describe('cancel_case_appointments — per-appt error isolation', () => {
  test('an already-Canceled throw lands in output.failed and later rows still cancel', async () => {
    apptService.cancelAppt
      .mockRejectedValueOnce(new Error('Appointment is already Canceled'))
      .mockResolvedValueOnce({ appt_id: 102, taskId: null });

    const db = mkDb(ROWS);
    const res = await fns.cancel_case_appointments({ case_id: 'ABC12345' }, db);

    expect(apptService.cancelAppt).toHaveBeenCalledTimes(2);   // did NOT abort
    expect(res.success).toBe(true);
    expect(res.output.canceled_count).toBe(1);
    expect(res.output.failed_count).toBe(1);
    expect(res.output.failed[0]).toEqual({ appt_id: 101, error: 'Appointment is already Canceled' });
    expect(res.output.canceled[0].appt_id).toBe(102);
  });
});

describe('cancel_case_appointments — output shape', () => {
  test('empty match is a clean success (terminal advance on an appt-less case is the common path)', async () => {
    const db = mkDb([]);
    const res = await fns.cancel_case_appointments({ case_id: 'ABC12345' }, db);
    expect(apptService.cancelAppt).not.toHaveBeenCalled();
    expect(res).toEqual({
      success: true,
      output: {
        case_id: 'ABC12345',
        canceled_count: 0,
        failed_count: 0,
        canceled: [],
        failed: [],
      },
    });
  });

  test('canceled rows carry appt_id/appt_type/appt_date for set_vars capture', async () => {
    const db = mkDb(ROWS);
    const res = await fns.cancel_case_appointments({ case_id: 'ABC12345' }, db);
    expect(res.output.canceled).toEqual([
      { appt_id: 101, appt_type: '341 Meeting',   appt_date: '2026-09-01 10:00:00' },
      { appt_id: 102, appt_type: 'Status Update', appt_date: '2026-09-15 14:00:00' },
    ]);
  });
});
