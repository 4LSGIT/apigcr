/**
 * Tests for services/taskService.js — the status-transition half:
 * completeTask / deleteTask, their logExtra payloads, and the completion
 * email's optional note block.
 *
 * NOTE (Slice 3): this file is NEW. There was no tests/taskService.test.js on
 * main — the Slice-3 prompt's "extend the existing 32" was wrong. Nothing was
 * extended; nothing pre-existing was lost.
 *
 * What matters here:
 *   - completed = acted, deleted = dismissed. Both verbs merge a caller-supplied
 *     logExtra ({ via, note }) into the log row's data. That merge IS the
 *     acted-vs-dismissed signal for the 60-day metric, so it gets pinned.
 *   - deleteTask's payload with NO 4th arg must stay byte-identical to what it
 *     wrote before Slice 3 (back-compat for every existing caller).
 *   - The note reaches the assigner's completion email HTML-ESCAPED, with the
 *     escape running BEFORE the \n→<br> pass, while the MIME subject stays RAW.
 *
 * NO network, NO real DB: db is a stateful stub whose query() dispatches on SQL
 * text; logService.createLogEntry, emailService.sendEmail and
 * settingsService.getSetting are monkey-patched on the require cache (taskService
 * lazy-requires email/settings per call and property-looks-up createLogEntry, so
 * patching the cached module objects intercepts cleanly — no jest.mock needed,
 * consistent with the other suites here).
 */
/*
npx jest tests/taskService.test.js

(jest is already a committed devDependency — package.json "jest": "^30.4.2".
 No install/uninstall dance needed; the older suites' header comments predate
 that and are stale.)
*/

// credentialCrypto (pulled in via emailService → adapters/email/smtp →
// credentialInjection) throws at REQUIRE time without this. Any random key
// works — nothing here decrypts real data. Must be set before the requires.
// Same pattern as tests/oauthService.test.js:13.
process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

const taskService     = require('../services/taskService');
const logService      = require('../services/logService');
const emailService    = require('../services/emailService');
const settingsService = require('../services/settingsService');

// ─────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────

const realCreateLogEntry = logService.createLogEntry;
const realSendEmail      = emailService.sendEmail;
const realGetSetting     = settingsService.getSetting;

let createLogEntry;  // jest.fn — captures the log payload
let sendEmail;       // jest.fn — captures the outbound email

beforeEach(() => {
  createLogEntry = jest.fn(async () => ({ log_id: 1 }));
  sendEmail      = jest.fn(async () => ({ ok: true }));

  logService.createLogEntry  = createLogEntry;
  emailService.sendEmail     = sendEmail;
  settingsService.getSetting = jest.fn(async () => 'automations@4lsg.com');
});

afterEach(() => { jest.clearAllMocks(); });

afterAll(() => {
  logService.createLogEntry  = realCreateLogEntry;
  emailService.sendEmail     = realSendEmail;
  settingsService.getSetting = realGetSetting;
});

const TASK_ID = 7;
const ASSIGNEE_ID = 22;   // task_to   — Rena
const ASSIGNER_ID = 1;    // task_from — Stuart

/**
 * Stateful db stub. query() dispatches on SQL text; the status UPDATE mutates
 * the row so the getTask at the end of the transition returns the NEW status
 * (that return value is what the routes render).
 *
 * Row shape = the raw joined row getTask/shapeRow expect.
 */
function makeDb(overrides = {}) {
  const state = {
    task: {
      task_id:           TASK_ID,
      task_status:       'Pending',
      task_title:        'File the 341 notice',
      task_desc:         'Some description',
      task_due:          null,
      task_start:        null,
      task_date:         '2026-07-01',
      task_notification: 1,
      task_due_job_id:   null,
      task_link:         '',
      task_link_type:    null,
      task_link_id:      null,
      task_action_token: 'AbC123dEf456GhI789jkl',
      task_source:       null,
      from_id: ASSIGNER_ID, from_name: 'Stuart',
      to_id:   ASSIGNEE_ID, to_name:   'Rena',
      contact_id: null, contact_name: null,
      case_id: null, case_number: null, case_number_full: null,
      ...overrides,
    },
    actorName:     'Rena',
    assignerEmail: 'ssandweiss@example.com',
  };

  const query = jest.fn(async (sql, params) => {
    // cancelDueReminder's read — must be tested BEFORE the generic tasks match
    if (/SELECT\s+task_due_job_id/i.test(sql)) {
      return [[{ task_due_job_id: state.task.task_due_job_id }]];
    }
    if (/UPDATE tasks SET task_status/i.test(sql)) {
      const literal = sql.match(/task_status\s*=\s*'([^']+)'/i);
      state.task.task_status = literal ? literal[1] : params[0];
      return [{ affectedRows: 1 }];
    }
    if (/UPDATE tasks SET task_due_job_id/i.test(sql)) {
      state.task.task_due_job_id = null;
      return [{ affectedRows: 1 }];
    }
    if (/UPDATE scheduled_jobs/i.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM tasks t/i.test(sql))           return [[{ ...state.task }]];   // getTask
    if (/SELECT user_name FROM users/i.test(sql)) return [[{ user_name: state.actorName }]];
    if (/SELECT email FROM users/i.test(sql))     return [[{ email: state.assignerEmail }]];
    throw new Error(`unexpected sql in stub: ${sql}`);
  });

  return { query, state };
}

/** The `data` object handed to createLogEntry on the Nth call. */
function logData(n = 0) {
  return createLogEntry.mock.calls[n][1].data;
}

/** notifyCompletion is fire-and-forget — let its promise chain drain. */
const flush = () => new Promise(r => setImmediate(r));

/** The html of the Nth sendEmail call. */
function sentHtml(n = 0) { return sendEmail.mock.calls[n][1].html; }
function sentSubject(n = 0) { return sendEmail.mock.calls[n][1].subject; }

// ─────────────────────────────────────────────────────────────
// 1. deleteTask — logExtra merge + back-compat
// ─────────────────────────────────────────────────────────────

describe('deleteTask logExtra', () => {
  test('merges logExtra alongside previous_status', async () => {
    const db = makeDb();

    await taskService.deleteTask(db, TASK_ID, ASSIGNEE_ID, {
      via: 'email_link',
      note: 'Client withdrew, not needed',
    });

    expect(createLogEntry).toHaveBeenCalledTimes(1);
    expect(logData()).toEqual({
      action:          'deleted',
      task_id:         TASK_ID,
      task_title:      'File the 341 notice',
      previous_status: 'Pending',
      via:             'email_link',
      note:            'Client withdrew, not needed',
    });
  });

  test('no 4th arg → payload is exactly the pre-Slice-3 shape (back-compat)', async () => {
    const db = makeDb();

    await taskService.deleteTask(db, TASK_ID, ASSIGNEE_ID);

    // toEqual is exact: any stray key (via:undefined, note:'') fails here.
    expect(logData()).toEqual({
      action:          'deleted',
      task_id:         TASK_ID,
      task_title:      'File the 341 notice',
      previous_status: 'Pending',
    });
  });

  test('null logExtra is tolerated (no throw, no stray keys)', async () => {
    const db = makeDb();
    await expect(taskService.deleteTask(db, TASK_ID, ASSIGNEE_ID, null)).resolves.toBeTruthy();
    expect(logData()).toEqual({
      action:          'deleted',
      task_id:         TASK_ID,
      task_title:      'File the 341 notice',
      previous_status: 'Pending',
    });
  });

  test('previous_status records the status it was in, and the row ends Deleted', async () => {
    const db = makeDb({ task_status: 'Overdue' });

    const updated = await taskService.deleteTask(db, TASK_ID, ASSIGNEE_ID, { via: 'app' });

    expect(logData().previous_status).toBe('Overdue');
    expect(updated.status).toBe('Deleted');
  });

  test('deleting an already-Deleted task throws "already deleted" (the /t/ race branch keys off this string)', async () => {
    const db = makeDb({ task_status: 'Deleted' });
    await expect(taskService.deleteTask(db, TASK_ID, ASSIGNEE_ID, { via: 'email_link' }))
      .rejects.toThrow(/already deleted/);
    expect(createLogEntry).not.toHaveBeenCalled();
  });

  test('deleteTask never emails anyone (cancel is silent)', async () => {
    const db = makeDb({ task_notification: 1 });
    await taskService.deleteTask(db, TASK_ID, ASSIGNEE_ID, { via: 'email_link', note: 'nope' });
    await flush();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// 2. completeTask — logExtra merge
// ─────────────────────────────────────────────────────────────

describe('completeTask logExtra', () => {
  test('merges via + note into the completed log row', async () => {
    const db = makeDb();

    const updated = await taskService.completeTask(db, TASK_ID, ASSIGNEE_ID, {
      via: 'email_link',
      note: 'Filed, but the trustee wants an amended schedule.',
    });

    expect(logData()).toEqual({
      action:     'completed',
      task_id:    TASK_ID,
      task_title: 'File the 341 notice',
      via:        'email_link',
      note:       'Filed, but the trustee wants an amended schedule.',
    });
    expect(updated.status).toBe('Completed');
  });

  test('completing a Deleted task throws "Cannot complete a deleted task" (the /t/ race branch keys off this string)', async () => {
    const db = makeDb({ task_status: 'Deleted' });
    await expect(taskService.completeTask(db, TASK_ID, ASSIGNEE_ID, { via: 'email_link' }))
      .rejects.toThrow(/Cannot complete a deleted task/);
  });

  test('completing an already-Completed task throws "already completed"', async () => {
    const db = makeDb({ task_status: 'Completed' });
    await expect(taskService.completeTask(db, TASK_ID, ASSIGNEE_ID))
      .rejects.toThrow(/already completed/);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. The note in the completion email
// ─────────────────────────────────────────────────────────────

describe('completion email note block', () => {
  test('notify=1 + note → note renders in the email, labeled with the assignee', async () => {
    const db = makeDb({ task_notification: 1 });

    await taskService.completeTask(db, TASK_ID, ASSIGNEE_ID, {
      via: 'app',
      note: 'Done, but heads-up: the trustee wants an amended Schedule I.',
    });
    await flush();

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const html = sentHtml();
    expect(html).toContain('Note from Rena');
    expect(html).toContain('Done, but heads-up: the trustee wants an amended Schedule I.');
  });

  test('note is HTML-ESCAPED — a <script> payload cannot reach the inbox live', async () => {
    const db = makeDb({ task_notification: 1 });

    await taskService.completeTask(db, TASK_ID, ASSIGNEE_ID, {
      via: 'email_link',
      note: `<script>alert('xss')</script> & "quoted"`,
    });
    await flush();

    const html = sentHtml();
    expect(html).toContain('&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;');
    expect(html).toContain('&amp;');
    expect(html).not.toContain('<script>');
  });

  test('escape runs BEFORE \\n→<br> — newlines become real <br> tags, not &lt;br&gt;', async () => {
    const db = makeDb({ task_notification: 1 });

    await taskService.completeTask(db, TASK_ID, ASSIGNEE_ID, {
      via: 'app',
      note: 'line one\nline <two>',
    });
    await flush();

    const html = sentHtml();
    expect(html).toContain('line one<br>line &lt;two&gt;');
    expect(html).not.toContain('&lt;br&gt;');
  });

  test('MIME subject stays RAW while the HTML <title> is escaped', async () => {
    const db = makeDb({ task_notification: 1, task_title: 'Smith & Jones <urgent>' });

    await taskService.completeTask(db, TASK_ID, ASSIGNEE_ID, { via: 'app', note: 'ok' });
    await flush();

    // Header: raw. Escaping it would put a literal &amp; in the inbox.
    expect(sentSubject()).toBe('Task Completed: Smith & Jones <urgent>');
    // <title> inside the HTML: escaped.
    expect(sentHtml()).toContain('<title>Task Completed: Smith &amp; Jones &lt;urgent&gt;</title>');
  });

  test('notify=0 + note → NO completion email at all (existing behavior guard)', async () => {
    const db = makeDb({ task_notification: 0 });

    await taskService.completeTask(db, TASK_ID, ASSIGNEE_ID, { via: 'app', note: 'silently noted' });
    await flush();

    expect(sendEmail).not.toHaveBeenCalled();
    // …but the note is still in the log.
    expect(logData().note).toBe('silently noted');
  });

  test('no note → no "Note from" block anywhere in the email', async () => {
    const db = makeDb({ task_notification: 1 });

    await taskService.completeTask(db, TASK_ID, ASSIGNEE_ID, { via: 'app' });
    await flush();

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sentHtml()).not.toContain('Note from');
  });

  test('no logExtra at all → still emails, still no note block (back-compat)', async () => {
    const db = makeDb({ task_notification: 1 });

    await taskService.completeTask(db, TASK_ID, ASSIGNEE_ID);
    await flush();

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sentHtml()).not.toContain('Note from');
    expect(logData()).toEqual({
      action:     'completed',
      task_id:    TASK_ID,
      task_title: 'File the 341 notice',
    });
  });

  test('a failing email never fails the completion (fire-and-forget)', async () => {
    const db = makeDb({ task_notification: 1 });
    emailService.sendEmail = jest.fn(async () => { throw new Error('smtp down'); });

    const updated = await taskService.completeTask(db, TASK_ID, ASSIGNEE_ID, { via: 'app', note: 'x' });
    await flush();

    expect(updated.status).toBe('Completed');
  });
});