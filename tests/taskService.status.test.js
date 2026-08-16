/**
 * tests/taskService.status.test.js
 *
 * Pins the C2/C3 status-at-write behaviour added by the task UI/UX overhaul:
 *
 *   C2a — createTask computes task_status from `due` (past → 'Overdue',
 *         today → 'Due Today', future/absent → 'Pending') instead of the old
 *         hardcoded 'Pending' literal.
 *   C2b — updateTask recomputes task_status when task_due changes on an OPEN
 *         task, NEVER touches a terminal (Completed/Deleted) task's status,
 *         and never overrides an explicitly-passed task_status.
 *   C3  — "today" is the FIRM's calendar day (FIRM_TIMEZONE, default
 *         America/Detroit), not the UTC server day. Pinned by freezing the
 *         clock at 01:00 UTC — still "yesterday" in Detroit — and asserting
 *         a task due on the UTC date is NOT yet Due Today.
 *
 * Same stub conventions as tests/taskService.test.js: no network, no real DB;
 * db.query dispatches on SQL text; logService.createLogEntry is patched on
 * the require cache.
 *
 * Also pins the start-date ("defer until") behaviour:
 *   S1 — createTask schedules a start reminder only when task_start is set,
 *        is in the future, and differs from the due date (start === due would
 *        double-notify on the same morning).
 *   S2 — listTasks' defer filter and its deferred-sorts-last ordering.
 *
 * Run:  npx jest tests/taskService.status.test.js
 */

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');
// Deterministic zone for the C3 assertions regardless of the CI box's env.
process.env.FIRM_TIMEZONE = 'America/Detroit';

const { DateTime }  = require('luxon');
const taskService   = require('../services/taskService');
const logService    = require('../services/logService');

const realCreateLogEntry = logService.createLogEntry;

beforeEach(() => {
  logService.createLogEntry = jest.fn(async () => ({ log_id: 1 }));
});
afterEach(() => { jest.useRealTimers(); jest.clearAllMocks(); });
afterAll(() => { logService.createLogEntry = realCreateLogEntry; });

// Firm-tz calendar dates relative to "now" (real or faked clock).
const firmToday = (plusDays = 0) =>
  DateTime.now().setZone('America/Detroit').plus({ days: plusDays }).toISODate();

// ─────────────────────────────────────────────────────────────
// DB stubs
// ─────────────────────────────────────────────────────────────

/** Stub for createTask: captures the INSERT params; getTask returns a shaped
 *  row so post-insert side effects don't explode. */
function makeCreateDb() {
  const captured = {};
  return {
    captured,
    query: async (sql, params) => {
      if (/INSERT INTO tasks/i.test(sql)) {
        captured.sql = sql;
        captured.params = params;
        return [{ insertId: 77 }];
      }
      if (/FROM tasks t/i.test(sql)) {
        // getTask — minimal shaped row
        return [[{
          task_id: 77, task_status: 'Pending', task_title: 't', task_desc: '',
          task_due: null, task_start: null, task_date: new Date(),
          task_notification: 0, task_action_token: 'tok', task_source: null,
          task_link_type: null, task_link_id: null, task_link: '',
          from_id: 1, from_name: 'A', to_id: 2, to_name: 'B',
          contact_id: null, contact_name: null,
          case_id: null, case_number: null, case_number_full: null
        }]];
      }
      if (/SELECT user_name FROM users/i.test(sql)) return [[{ user_name: 'X' }]];
      return [[]];
    }
  };
}

/** Stub for updateTask: current status is `status`; captures the UPDATE. */
function makeUpdateDb(status) {
  const captured = {};
  return {
    captured,
    query: async (sql, params) => {
      if (/SELECT task_status FROM tasks/i.test(sql)) {
        return [[{ task_status: status }]];
      }
      if (/UPDATE tasks SET/i.test(sql)) {
        captured.sql = sql;
        captured.params = params;
        return [{ affectedRows: 1 }];
      }
      if (/SELECT task_due_job_id/i.test(sql)) return [[{ task_due_job_id: null }]];
      if (/FROM tasks t/i.test(sql)) {
        return [[{
          task_id: 5, task_status: status, task_title: 't', task_desc: '',
          task_due: null, task_start: null, task_date: new Date(),
          task_notification: 0, task_action_token: 'tok', task_source: null,
          task_link_type: null, task_link_id: null, task_link: '',
          from_id: 1, from_name: 'A', to_id: 2, to_name: 'B',
          contact_id: null, contact_name: null,
          case_id: null, case_number: null, case_number_full: null
        }]];
      }
      return [[]];
    }
  };
}

const insertedStatus = (cap) => {
  // task_status is the 9th bound value (see the INSERT column list).
  const cols = cap.sql.match(/\(([^)]*)\)/)[1].split(',').map(s => s.trim());
  return cap.params[cols.indexOf('task_status')];
};

// ─────────────────────────────────────────────────────────────
// C2a — createTask status
// ─────────────────────────────────────────────────────────────

describe('createTask computes initial status (C2a)', () => {
  test('past due → Overdue at creation, not Pending', async () => {
    const db = makeCreateDb();
    await taskService.createTask(db, { to: 2, title: 'x', due: firmToday(-3) });
    expect(insertedStatus(db.captured)).toBe('Overdue');
  });

  test('due today (firm time) → Due Today at creation', async () => {
    const db = makeCreateDb();
    await taskService.createTask(db, { to: 2, title: 'x', due: firmToday(0) });
    expect(insertedStatus(db.captured)).toBe('Due Today');
  });

  test('future due → Pending', async () => {
    const db = makeCreateDb();
    await taskService.createTask(db, { to: 2, title: 'x', due: firmToday(5) });
    expect(insertedStatus(db.captured)).toBe('Pending');
  });

  test('no due date (machine-notice shape) → Pending — dedupe unaffected', async () => {
    const db = makeCreateDb();
    await taskService.createTask(db, { to: 2, title: 'x', source: 'esign', send_assignment_email: false });
    expect(insertedStatus(db.captured)).toBe('Pending');
  });
});

// ─────────────────────────────────────────────────────────────
// C2b — updateTask recompute + terminal guard
// ─────────────────────────────────────────────────────────────

describe('updateTask status recompute (C2b)', () => {
  test('due → yesterday on a Pending task rewrites task_status to Overdue', async () => {
    const db = makeUpdateDb('Pending');
    await taskService.updateTask(db, 5, { task_due: firmToday(-1) }, 1);
    expect(db.captured.sql).toMatch(/`task_status` = \?/);
    expect(db.captured.params).toContain('Overdue');
  });

  test('CRITICAL: due change on a Completed task does NOT touch task_status', async () => {
    const db = makeUpdateDb('Completed');
    await taskService.updateTask(db, 5, { task_due: firmToday(-1) }, 1);
    expect(db.captured.sql).not.toMatch(/task_status/);
  });

  test('due change on a Deleted task does NOT touch task_status', async () => {
    const db = makeUpdateDb('Deleted');
    await taskService.updateTask(db, 5, { task_due: firmToday(-1) }, 1);
    expect(db.captured.sql).not.toMatch(/task_status/);
  });

  test('explicitly-passed task_status wins — no recompute override', async () => {
    const db = makeUpdateDb('Pending');
    await taskService.updateTask(db, 5, { task_due: firmToday(-1), task_status: 'Pending' }, 1);
    // exactly one task_status assignment, bound to the caller's value
    expect(db.captured.sql.match(/task_status/g).length).toBe(1);
    expect(db.captured.params.filter(p => p === 'Pending').length).toBe(1);
    expect(db.captured.params).not.toContain('Overdue');
  });

  test('patch without task_due never reads or writes status', async () => {
    const db = makeUpdateDb('Pending');
    await taskService.updateTask(db, 5, { task_title: 'renamed' }, 1);
    expect(db.captured.sql).not.toMatch(/task_status/);
  });
});

// ─────────────────────────────────────────────────────────────
// C3 — firm-timezone day boundary
// ─────────────────────────────────────────────────────────────

describe('computeStatus uses the FIRM calendar day (C3)', () => {
  test('01:00 UTC = 20/21:00 Detroit YESTERDAY — a task due on the UTC date is still Pending', async () => {
    // Freeze: 2026-06-10T01:00Z → Detroit local 2026-06-09 21:00 (EDT).
    jest.useFakeTimers({ now: new Date('2026-06-10T01:00:00Z'), doNotFake: ['setImmediate', 'setTimeout'] });
    const db = makeCreateDb();
    await taskService.createTask(db, { to: 2, title: 'x', due: '2026-06-10' });
    // Old UTC math would say Due Today; firm time says tomorrow → Pending.
    expect(insertedStatus(db.captured)).toBe('Pending');
  });

  test('same instant, task due on the DETROIT date → Due Today', async () => {
    jest.useFakeTimers({ now: new Date('2026-06-10T01:00:00Z'), doNotFake: ['setImmediate', 'setTimeout'] });
    const db = makeCreateDb();
    await taskService.createTask(db, { to: 2, title: 'x', due: '2026-06-09' });
    expect(insertedStatus(db.captured)).toBe('Due Today');
  });
});


// ─────────────────────────────────────────────────────────────
// Start dates — scheduling rules (S1)
// ─────────────────────────────────────────────────────────────

/** createTask stub that also records scheduled_jobs inserts. */
function makeStartDb() {
  const jobs = [];
  return {
    jobs,
    query: async (sql, params) => {
      if (/INSERT INTO scheduled_jobs/i.test(sql)) {
        jobs.push(JSON.parse(params[2]));
        return [{ insertId: 900 + jobs.length }];
      }
      if (/INSERT INTO tasks/i.test(sql)) return [{ insertId: 77 }];
      if (/UPDATE tasks SET task_(start|due)_job_id/i.test(sql)) return [{ affectedRows: 1 }];
      if (/FROM tasks t/i.test(sql)) {
        return [[{
          task_id: 77, task_status: 'Pending', task_title: 't', task_desc: '',
          task_due: null, task_start: null, task_date: new Date(),
          task_notification: 0, task_action_token: 'tok', task_source: null,
          task_link_type: null, task_link_id: null, task_link: '',
          from_id: 1, from_name: 'A', to_id: 2, to_name: 'B',
          contact_id: null, contact_name: null,
          case_id: null, case_number: null, case_number_full: null
        }]];
      }
      if (/SELECT user_name FROM users/i.test(sql)) return [[{ user_name: 'X' }]];
      return [[]];
    }
  };
}

// createTask fires its reminders from setImmediate; let the queue drain.
const drain = () => new Promise(r => setImmediate(() => setImmediate(r)));

describe('start-date reminders (S1)', () => {
  test('future start + later due → BOTH a start and a due reminder', async () => {
    const db = makeStartDb();
    await taskService.createTask(db, {
      to: 2, title: 'x', start: firmToday(200), due: firmToday(207),
      send_assignment_email: false
    });
    await drain();
    const types = db.jobs.map(j => j.type).sort();
    expect(types).toEqual(['task_due_reminder', 'task_start_reminder']);
  });

  test('start === due → due reminder ONLY (no double-notify the same morning)', async () => {
    const db = makeStartDb();
    await taskService.createTask(db, {
      to: 2, title: 'x', start: firmToday(30), due: firmToday(30),
      send_assignment_email: false
    });
    await drain();
    expect(db.jobs.map(j => j.type)).toEqual(['task_due_reminder']);
  });

  test('start in the PAST schedules nothing (no reminder for a day already gone)', async () => {
    const db = makeStartDb();
    await taskService.createTask(db, {
      to: 2, title: 'x', start: firmToday(-10), due: firmToday(10),
      send_assignment_email: false
    });
    await drain();
    expect(db.jobs.map(j => j.type)).toEqual(['task_due_reminder']);
  });

  test('start with NO due date → start reminder only (deferred, open-ended work)', async () => {
    const db = makeStartDb();
    await taskService.createTask(db, {
      to: 2, title: 'x', start: firmToday(365), send_assignment_email: false
    });
    await drain();
    expect(db.jobs.map(j => j.type)).toEqual(['task_start_reminder']);
  });

  test('no dates at all → no reminders, still a valid task', async () => {
    const db = makeStartDb();
    await taskService.createTask(db, { to: 2, title: 'x', send_assignment_email: false });
    await drain();
    expect(db.jobs).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// listTasks defer filter + ordering (S2)
// ─────────────────────────────────────────────────────────────

function makeListDb() {
  const seen = [];
  return {
    seen,
    query: async (sql, params) => {
      seen.push({ sql, params });
      if (/COUNT\(\*\)/i.test(sql)) return [[{ total: 0 }]];
      return [[]];
    }
  };
}

describe('listTasks defer filter (S2)', () => {
  test("defer:'active' keeps NULL starts and anything already started", async () => {
    const db = makeListDb();
    await taskService.listTasks(db, { defer: 'active' });
    expect(db.seen[0].sql).toMatch(/task_start IS NULL OR t\.task_start <= \?/);
  });

  test("defer:'scheduled' selects only future starts", async () => {
    const db = makeListDb();
    await taskService.listTasks(db, { defer: 'scheduled' });
    expect(db.seen[0].sql).toMatch(/t\.task_start > \?/);
    expect(db.seen[0].sql).not.toMatch(/task_start IS NULL OR/);
  });

  test("absent / 'all' applies no start filter", async () => {
    for (const defer of [null, 'all']) {
      const db = makeListDb();
      await taskService.listTasks(db, { defer });
      expect(db.seen[0].sql).not.toMatch(/task_start/);
    }
  });

  test('deferred work always sorts below in-play work, even unfiltered', async () => {
    const db = makeListDb();
    await taskService.listTasks(db, {});
    const rowsQuery = db.seen[1];
    expect(rowsQuery.sql).toMatch(/\(t\.task_start IS NOT NULL AND t\.task_start > \?\)/);
    // ORDER BY's date param binds AFTER the WHERE params and BEFORE limit/offset.
    expect(rowsQuery.params.slice(-3)[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
