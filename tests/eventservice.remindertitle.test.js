/**
 * tests/eventservice.remindertitle.test.js
 *
 * Tests for the reminder-title CLAMP in services/eventService.js
 * (spawnReminderTask).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The create_task-as-notification slice made taskService.createTask THROW on a
 * title > 100 chars instead of letting MySQL truncate it silently (session
 * sql_mode lacks STRICT_TRANS_TABLES). That is right everywhere there is an
 * author to see the failure — a workflow step goes red, POST /api/tasks 500s.
 *
 * spawnReminderTask has nobody watching. Its title is MACHINE-derived:
 *     `Reminder: ${event.event_title}`      // event_title is varchar(200)
 * …so it can reach 210 chars, and BOTH callers swallow the throw
 * (createEvent:900 `.catch()`, updateEvent:1094 try/catch). Before the clamp,
 * an overlong title produced NO reminder task at all — a silently missing
 * bankruptcy deadline, console.error only.
 *
 * So: clamp here, throw everywhere else.
 *
 * HARNESS
 * -------
 * taskService is deliberately NOT mocked. The whole point is to drive the REAL
 * createTask and prove the clamped title clears the REAL 100-char guard —
 * mocking taskService would make these tests pass against a guard that never
 * ran. Everything else is mocked with explicit factories (a bare automock makes
 * jest require the real module to derive its shape, which pulls in
 * credentialCrypto and throws without CREDENTIALS_ENCRYPTION_KEY).
 *
 * db is a stub whose query() dispatches on SQL text and THROWS on anything
 * unrouted; unrouted SQL is also recorded, because createTask's setImmediate
 * body and notifyAssignment both wrap themselves in try/catch and would
 * otherwise swallow a mock miss and make it look like success.
 *
 * Run:
 *   npx jest tests/eventservice.remindertitle.test.js
 */

process.env.CREDENTIALS_ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY ||
  require('crypto').randomBytes(32).toString('base64');

// NOT mocked: taskService — see harness note above.
jest.mock('../services/gcalService',     () => ({ createEvent: jest.fn(), deleteEvent: jest.fn() }));
jest.mock('../services/logService',      () => ({ createLogEntry: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/emailService',    () => ({ sendEmail: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('../services/phoneService',    () => ({ sendSms:   jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('../services/settingsService', () => ({ getSetting: jest.fn().mockResolvedValue('automations@4lsg.com') }));

const eventService = require('../services/eventService');

const TASK_ID = 999;

/** Column index into createTask's INSERT params (matches its VALUES order). */
const COL_TITLE = 2;

function makeDb() {
  const unrouted = [];
  const query = jest.fn(async (sql) => {
    const s = String(sql);
    if (/INSERT INTO tasks/i.test(s))               return [{ insertId: TASK_ID }];
    if (/INSERT INTO scheduled_jobs/i.test(s))      return [{ insertId: 555 }];
    if (/UPDATE tasks SET task_due_job_id/i.test(s))return [{ affectedRows: 1 }];
    if (/SELECT email, phone, allow_sms FROM users/i.test(s)) {
      return [[{ email: 'rena@4lsg.com', phone: null, allow_sms: 0 }]];
    }
    if (/FROM tasks t/i.test(s)) {
      return [[{
        task_id: TASK_ID, task_status: 'Pending',
        task_title: 'stub', task_desc: '', task_due: null, task_start: null,
        task_date: '2026-07-14 09:00:00', task_notification: 0, task_source: null,
        task_action_token: 'stub-token-000000000x',
        from_id: 0, from_name: 'Automations', to_id: 22, to_name: 'Rena',
        task_link_type: 'event', task_link_id: '70',
        contact_id: null, contact_name: null,
        case_id: null, case_number: null, case_number_full: null,
      }]];
    }
    unrouted.push(s);
    throw new Error('unrouted SQL: ' + s);
  });
  return { query, unrouted };
}

const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r));
};

/** The title actually written to tasks.task_title. */
function insertedTitle(db) {
  const call = db.query.mock.calls.find(([sql]) => /INSERT INTO tasks/i.test(String(sql)));
  expect(call).toBeDefined();            // harness guard: a miss must fail loudly
  return call[1][COL_TITLE];
}

const evt = (event_title, event_id = 70) => ({ event_id, event_title });

afterEach(() => { jest.clearAllMocks(); });

// ─────────────────────────────────────────────────────────────
// The clamp
// ─────────────────────────────────────────────────────────────

describe('spawnReminderTask — title clamp (createTask throws above 100)', () => {
  test('derived title of exactly 101 chars → CLAMPED to 100, task created, NO throw', async () => {
    // 'Reminder: ' is 10 chars, so a 91-char event_title derives exactly 101.
    const eventTitle = 'E'.repeat(91);
    const db = makeDb();

    const taskId = await eventService.spawnReminderTask(
      db, evt(eventTitle), { to: 22, date: null }, 0
    );
    await flush();

    // It did NOT throw, and a task really was created.
    expect(taskId).toBe(TASK_ID);

    const written = insertedTitle(db);
    expect(written).toHaveLength(100);              // fits varchar(100)
    expect(written.endsWith('…')).toBe(true);       // clamp marker
    expect(written).toBe('Reminder: ' + 'E'.repeat(89) + '…');
    expect(db.unrouted).toEqual([]);
  });

  test('the REAL createTask guard is what the clamped title has to clear', async () => {
    // Regression guard on the guard: a 101-char title must still be rejected by
    // createTask. If this ever stops throwing, the clamp above is load-bearing
    // for nothing and the test above would pass vacuously.
    const taskService = require('../services/taskService');
    const db = makeDb();
    await expect(
      taskService.createTask(db, { from: 0, to: 22, title: 'x'.repeat(101) })
    ).rejects.toThrow('createTask: title exceeds 100 chars');
    expect(db.query).not.toHaveBeenCalled();
  });

  // ── The live worst case, pinned ────────────────────────────────────────────
  // Real strings from the production DB (2026-07-14):
  //   - the longest event_title prefix the court pipeline emits, and
  //   - the longest contact_name, which is a JOINT filing — structurally ~2x a
  //     single-debtor name because of the "A & B" pattern, so the longest task
  //     titles in the system are SYSTEMATICALLY the joint filings.
  const CCD_JOINT =
    'Confirmation Certificate Deadline - 26-46899-lsg - Benjamin Boateng & Dayvonna Clay-Miller';

  test('the live worst case derives EXACTLY 100 chars — zero headroom, unclamped', async () => {
    // This is the whole argument for the clamp, made executable: today's worst
    // real case sits precisely ON the limit. It does not throw — but there is
    // not one character of room left.
    expect(('Reminder: ' + CCD_JOINT)).toHaveLength(100);

    const db = makeDb();
    const taskId = await eventService.spawnReminderTask(
      db, evt(CCD_JOINT), { to: 22, date: null }, 0
    );
    await flush();

    expect(taskId).toBe(TASK_ID);
    const written = insertedTitle(db);
    expect(written).toHaveLength(100);
    expect(written).not.toContain('…');            // exactly at the boundary
    expect(db.unrouted).toEqual([]);
  });

  test('ONE more character (a "Jr.", a middle initial, a longer surname) → clamped, NOT lost', async () => {
    // Pre-clamp this threw, both callers swallowed it, and the bankruptcy
    // deadline reminder was silently never created. Now it is clamped.
    const oneCharLonger = CCD_JOINT + 'x';
    expect(('Reminder: ' + oneCharLonger).length).toBe(101);

    const db = makeDb();
    const taskId = await eventService.spawnReminderTask(
      db, evt(oneCharLonger), { to: 22, date: null }, 0
    );
    await flush();

    expect(taskId).toBe(TASK_ID);                  // the reminder task EXISTS
    const written = insertedTitle(db);
    expect(written).toHaveLength(100);
    expect(written.endsWith('…')).toBe(true);
    expect(written).toContain('Confirmation Certificate Deadline');
    expect(db.unrouted).toEqual([]);
  });

  test('an explicit reminder.title is clamped too (also unbounded free text)', async () => {
    // reminder.title comes from automation/UI config — create_event's __meta
    // declares `reminder` as type:'object' with NO length check on .title.
    const db = makeDb();
    const taskId = await eventService.spawnReminderTask(
      db, evt('short'), { to: 22, date: null, title: 'T'.repeat(250) }, 0
    );
    await flush();

    expect(taskId).toBe(TASK_ID);
    expect(insertedTitle(db)).toHaveLength(100);
    expect(insertedTitle(db)).toBe('T'.repeat(99) + '…');
  });
});

// ─────────────────────────────────────────────────────────────
// Regression — the clamp must not touch anything that already fit
// ─────────────────────────────────────────────────────────────

describe('spawnReminderTask — titles that already fit are untouched', () => {
  test('the longest LIVE reminder title (73 chars) passes through byte-identical', async () => {
    // task 1054 in production.
    const eventTitle = 'Docs due to trustee - 26-46899-lsg - Aboghene Enita Uwedjojevwe';
    const db = makeDb();

    await eventService.spawnReminderTask(db, evt(eventTitle), { to: 22, date: null }, 0);
    await flush();

    const written = insertedTitle(db);
    expect(written).toBe(`Reminder: ${eventTitle}`);
    expect(written).toHaveLength(73);
    expect(written).not.toContain('…');
  });

  test('a derived title of exactly 100 chars is NOT clamped (boundary)', async () => {
    const eventTitle = 'E'.repeat(90);              // 10 + 90 = 100
    const db = makeDb();

    await eventService.spawnReminderTask(db, evt(eventTitle), { to: 22, date: null }, 0);
    await flush();

    const written = insertedTitle(db);
    expect(written).toHaveLength(100);
    expect(written).not.toContain('…');             // clamp is > 100, not >= 100
    expect(written).toBe('Reminder: ' + 'E'.repeat(90));
  });

  test('a short explicit reminder.title still wins over the derived default', async () => {
    const db = makeDb();
    await eventService.spawnReminderTask(
      db, evt('Some event'), { to: 22, date: null, title: '  Call the trustee  ' }, 0
    );
    await flush();

    expect(insertedTitle(db)).toBe('Call the trustee');   // trimmed, not clamped
  });

  test('missing reminder.to → null, no task, no db traffic (regression)', async () => {
    const db = makeDb();
    const taskId = await eventService.spawnReminderTask(db, evt('x'), { date: null }, 0);
    expect(taskId).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});