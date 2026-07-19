/**
 * Tests for services/esignAlertService.js — the one place e-sign talks to a
 * human (Phase 1C).
 *
 * Two things here are load-bearing and neither is obvious:
 *
 *   1. tasks.task_link_id is varchar(20); signing_requests.linkable_id is
 *      varchar(64); sql_mode has no STRICT_TRANS_TABLES. An over-length id
 *      would truncate SILENTLY and produce a link to nothing — or to a
 *      different row sharing the first 20 characters. Undetectable after the
 *      fact, so it is refused up front.
 *
 *   2. Nothing here may throw. An alert describes work that already happened;
 *      turning a notification failure into an exception would convert "filed
 *      but nobody was told" into "the webhook 500'd and Zoho retries forever".
 *
 *   npx jest tests/esignAlert.test.js
 */

jest.mock('../services/taskService', () => ({
  createTask: jest.fn(async () => ({ task_id: 4242, action_token: 'tok', action_url: 'https://app/x' })),
}));

jest.mock('../services/settingsService', () => ({
  getSetting: jest.fn(async () => '22'),
  getSettings: jest.fn(async () => ({})),
}));

const taskService = require('../services/taskService');
const { getSetting } = require('../services/settingsService');
const alerts = require('../services/esignAlertService');

beforeEach(() => {
  jest.clearAllMocks();
  getSetting.mockResolvedValue('22');
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

const db = {};

// ─────────────────────────────────────────────────────────────
describe('assignee resolution', () => {
  test('reads office_alerts_to — the same setting wf30/wf31 use', async () => {
    expect(await alerts.resolveAlertAssignee(db)).toBe(22);
    expect(getSetting).toHaveBeenCalledWith(db, 'office_alerts_to');
  });

  // The live value is the single id "22" today, which is why wf30 gets away
  // with passing the raw string into create_task. A future "22,6" must not
  // silently break task creation.
  test('takes the first id from a comma-separated roster', async () => {
    getSetting.mockResolvedValue('22, 6, 1');
    expect(await alerts.resolveAlertAssignee(db)).toBe(22);
  });

  test('skips unusable leading entries', async () => {
    getSetting.mockResolvedValue(' , abc, 0, 6 ');
    expect(await alerts.resolveAlertAssignee(db)).toBe(6);
  });

  test('returns null when nothing usable is configured', async () => {
    for (const v of ['', '   ', 'nobody', null, undefined]) {
      getSetting.mockResolvedValue(v);
      expect(await alerts.resolveAlertAssignee(db)).toBeNull();
    }
  });

  test('a settings read failure returns null rather than throwing', async () => {
    getSetting.mockRejectedValue(new Error('db down'));
    expect(await alerts.resolveAlertAssignee(db)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
describe('raiseTask', () => {
  test('creates a task from the automations user, tagged esign', async () => {
    const out = await alerts.raiseTask(db, {
      title: 'File signed doc manually: Retainer',
      desc: 'Something needs doing.',
      linkableType: 'case', linkableId: 'AbC12dEf',
    });

    expect(out).toMatchObject({ ok: true, taskId: 4242 });
    expect(taskService.createTask).toHaveBeenCalledWith(db, expect.objectContaining({
      from: 0, to: 22, source: 'esign',
      link_type: 'case', link_id: 'AbC12dEf',
      send_assignment_email: true,
    }));
  });

  test('no assignee means no task, and a warning rather than a throw', async () => {
    getSetting.mockResolvedValue('');
    const out = await alerts.raiseTask(db, { title: 'x', desc: 'y' });

    expect(out).toEqual({ ok: false, reason: 'no_assignee' });
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  test('a taskService failure is swallowed and reported', async () => {
    taskService.createTask.mockRejectedValue(new Error('task_title too long'));
    const out = await alerts.raiseTask(db, { title: 'x', desc: 'y' });
    expect(out).toMatchObject({ ok: false, reason: 'error' });
  });
});

// ─────────────────────────────────────────────────────────────
describe('length safety', () => {
  // taskService THROWS above these rather than truncating, because sql_mode
  // is not strict. Clipping here means a long document name loses characters,
  // not the whole alert.
  test('clips an over-long title instead of letting taskService throw', async () => {
    await alerts.raiseTask(db, { title: 'T'.repeat(400), desc: 'ok' });
    const { title } = taskService.createTask.mock.calls[0][1];
    expect(title.length).toBeLessThanOrEqual(alerts.MAX_TITLE);
    expect(title).toMatch(/truncated/);
  });

  test('clips an over-long description', async () => {
    await alerts.raiseTask(db, { title: 'ok', desc: 'D'.repeat(5000) });
    const { desc } = taskService.createTask.mock.calls[0][1];
    expect(desc.length).toBeLessThanOrEqual(alerts.MAX_DESC);
  });

  test('leaves normal lengths untouched', async () => {
    await alerts.raiseTask(db, { title: 'Short title', desc: 'Short body' });
    expect(taskService.createTask.mock.calls[0][1]).toMatchObject({
      title: 'Short title', desc: 'Short body',
    });
  });
});

// ─────────────────────────────────────────────────────────────
describe('the varchar(20) link trap', () => {
  test('a real case id links normally', async () => {
    await alerts.raiseTask(db, { title: 'x', desc: 'y', linkableType: 'case', linkableId: 'AbC12dEf' });
    expect(taskService.createTask.mock.calls[0][1]).toMatchObject({
      link_type: 'case', link_id: 'AbC12dEf',
    });
  });

  test('exactly 20 characters still links', async () => {
    const id = 'A'.repeat(20);
    await alerts.raiseTask(db, { title: 'x', desc: 'y', linkableType: 'case', linkableId: id });
    expect(taskService.createTask.mock.calls[0][1].link_id).toBe(id);
  });

  // A silently truncated link is worse than no link: it points somewhere
  // plausible and wrong, and nothing surfaces the error.
  test('21 characters drops the link and says so in the description', async () => {
    const id = 'A'.repeat(21);
    await alerts.raiseTask(db, { title: 'x', desc: 'Body.', linkableType: 'case', linkableId: id });

    const arg = taskService.createTask.mock.calls[0][1];
    expect(arg.link_type).toBeNull();
    expect(arg.link_id).toBeNull();
    expect(arg.desc).toMatch(/Not linked automatically/);
    expect(arg.desc).toMatch(/21 characters/);
  });

  test('an absent linkable simply produces an unlinked task', async () => {
    await alerts.raiseTask(db, { title: 'x', desc: 'y' });
    expect(taskService.createTask.mock.calls[0][1]).toMatchObject({ link_type: null, link_id: null });
  });

  test('an empty-string id is treated as absent, not as a link', async () => {
    await alerts.raiseTask(db, { title: 'x', desc: 'y', linkableType: 'case', linkableId: '' });
    expect(taskService.createTask.mock.calls[0][1].link_id).toBeNull();
  });
});
