// tests/validateCaseTrustee.test.js — FIL-1 validate_case_trustee.
//
// House stub-db pattern: a SCRIPTED queue of {match, rows} steps consumed in
// order with .shift(), wired through tests/helpers/scriptGuard so BOTH drift
// directions fail the test (over-consumption via guard.overrun, unconsumed
// steps via the global afterEach in scriptGuard.setup). A statement that
// arrives out of scripted order throws with both sides printed. Service
// boundaries (settings/task/log/email) are jest mocks, with
// jest.requireActual contract tests pinning the mocked names to the real
// modules so signature drift fails HERE, not in production.
'use strict';

const { scriptGuard } = require('./helpers/scriptGuard');

jest.mock('../services/settingsService', () => ({
  getSetting:  jest.fn(),
  getSettings: jest.fn(),
}));
jest.mock('../services/taskService', () => ({
  createTask: jest.fn(),
}));
jest.mock('../services/logService', () => ({
  createLogEntry: jest.fn(),
}));
jest.mock('../services/emailService', () => ({
  sendEmail: jest.fn(),
}));

const { getSettings }  = require('../services/settingsService');
const taskService      = require('../services/taskService');
const logService       = require('../services/logService');
const emailService     = require('../services/emailService');
const fns              = require('../lib/internal_functions/trustee');

const validate = fns.validate_case_trustee;

// ── scripted stub db (scriptGuard-wired) ───────────────────────────────────
function makeDb(script) {
  const calls = [];
  const guard = scriptGuard('validateCaseTrustee stubDb', script);
  return {
    calls, script, guard,
    async query(sql, params) {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: flat, params });
      if (!script.length) guard.overrun(flat);
      const step = script.shift();
      if (!step.match.test(flat)) {
        throw new Error(`script order mismatch: expected ${step.match} got: ${flat}`);
      }
      if (step.assertParams) step.assertParams(params);
      return [step.rows !== undefined ? step.rows : { affectedRows: 1 }, []];
    },
  };
}

const ROSTER = JSON.stringify([
  { name: 'Michael A. Stevenson', lname: 'Stevenson', case_type: 7,  link: 'https://z/stev' },
  { name: 'Stuart A. Gold',       lname: 'Gold',      case_type: 7,  link: 'https://z/gold' },
  { name: 'Krispen S. Carroll',   lname: 'Carroll',   case_type: 13, link: 'https://z/car'  },
]);

function caseStep(row) {
  return {
    match: /^SELECT case_id, case_trustee, case_chapter, case_341_link, case_number, case_number_full FROM cases WHERE case_id = \? LIMIT 1$/,
    rows: [row],
  };
}
const baseCase = (over = {}) => ({
  case_id: 'AB12CD34', case_trustee: 'Michael Stevenson', case_chapter: '7',
  case_341_link: '', case_number: '26-40001', case_number_full: '26-40001-mar',
  ...over,
});

function settingsLive(live = '1', roster = ROSTER) {
  getSettings.mockResolvedValueOnce({
    trustee_validation_live: live,
    'fe-trustees': roster,
  });
}

// Explicit in-test drain assertion; the scriptGuard global afterEach is the
// backstop that catches it even when a test forgets to call this.
function drained(db) {
  expect(db.script).toEqual([]);
}

beforeEach(() => jest.clearAllMocks());

// ── contract tests: the mocked names exist on the real modules ─────────────
describe('mock boundary contracts', () => {
  test('settingsService really exports getSettings(db, keys)', () => {
    const real = jest.requireActual('../services/settingsService');
    expect(typeof real.getSettings).toBe('function');
    expect(real.getSettings.length).toBe(2);
  });
  test('taskService really exports createTask(db, opts)', () => {
    const real = jest.requireActual('../services/taskService');
    expect(typeof real.createTask).toBe('function');
    expect(real.createTask.length).toBe(2);
  });
  test('logService really exports createLogEntry(db, opts)', () => {
    const real = jest.requireActual('../services/logService');
    expect(typeof real.createLogEntry).toBe('function');
  });
  test('emailService really exports sendEmail(db, opts)', () => {
    const real = jest.requireActual('../services/emailService');
    expect(typeof real.sendEmail).toBe('function');
    expect(real.sendEmail.length).toBe(2);
  });
});

// ── live-mode behavior ─────────────────────────────────────────────────────
describe('live mode (trustee_validation_live=1)', () => {
  test('fuzzy match canonicalizes trustee AND writes the roster link in one UPDATE, then logs', async () => {
    settingsLive('1');
    const db = makeDb([
      caseStep(baseCase()),
      {
        match: /^UPDATE cases SET case_trustee = \?, case_341_link = \? WHERE case_id = \?$/,
        assertParams: (p) => expect(p).toEqual(['Michael A. Stevenson', 'https://z/stev', 'AB12CD34']),
      },
    ]);
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(r.output).toMatchObject({
      status: 'matched', method: 'lname',
      canonical: 'Michael A. Stevenson',
      trustee_updated: true, link_updated: true, dry_run: false,
      alert_task_id: null,
    });
    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
    expect(logService.createLogEntry.mock.calls[0][1]).toMatchObject({
      type: 'status', link_type: 'case', link_id: 'AB12CD34', by: 0,
    });
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(emailService.sendEmail).not.toHaveBeenCalled();   // no dry email live
  });

  test('IDEMPOTENT: already-canonical trustee + same link → no UPDATE, no log', async () => {
    settingsLive('1');
    const db = makeDb([
      caseStep(baseCase({ case_trustee: 'Michael A. Stevenson', case_341_link: 'https://z/stev' })),
    ]);
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(r.output).toMatchObject({
      status: 'matched', trustee_updated: false, link_updated: false,
    });
    expect(logService.createLogEntry).not.toHaveBeenCalled();
  });

  test('link-only delta: canonical name already stored, link missing → only the link is written', async () => {
    settingsLive('1');
    const db = makeDb([
      caseStep(baseCase({ case_trustee: 'Stuart A. Gold' })),
      {
        match: /^UPDATE cases SET case_341_link = \? WHERE case_id = \?$/,
        assertParams: (p) => expect(p).toEqual(['https://z/gold', 'AB12CD34']),
      },
    ]);
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(r.output).toMatchObject({ trustee_updated: false, link_updated: true, method: 'exact' });
  });

  test('no match → alert task to alert_to (22), dedupe key stamped, NOTHING written to cases', async () => {
    settingsLive('1');
    taskService.createTask.mockResolvedValueOnce({ task_id: 901, action_token: 't', action_url: 'u' });
    const db = makeDb([
      caseStep(baseCase({ case_trustee: 'Jane Q. Nobody' })),
      {
        match: /^SELECT task_id FROM tasks WHERE task_dedupe_key = \? AND task_status IN \(\?, \?, \?\) ORDER BY task_id DESC LIMIT 1$/,
        assertParams: (p) => expect(p[0]).toBe('trustee-val:AB12CD34'),
        rows: [],
      },
      {
        match: /^UPDATE tasks SET task_dedupe_key = \? WHERE task_id = \?$/,
        assertParams: (p) => expect(p).toEqual(['trustee-val:AB12CD34', 901]),
      },
    ]);
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(r.output).toMatchObject({ status: 'no_match', alert_task_id: 901, alert_deduped: false });
    const t = taskService.createTask.mock.calls[0][1];
    expect(t).toMatchObject({ from: 0, to: 22, link_type: 'case', link_id: 'AB12CD34', source: 'trustee_validation' });
    expect(t.title.length).toBeLessThanOrEqual(100);
    expect(t.desc.length).toBeLessThanOrEqual(1000);
    expect(t.desc).toMatch(/select the correct trustee in the Case Info form/);
  });

  test('re-run with the alert still open TOUCHES it — no second task (dedupe)', async () => {
    settingsLive('1');
    const db = makeDb([
      caseStep(baseCase({ case_trustee: 'Jane Q. Nobody' })),
      {
        match: /^SELECT task_id FROM tasks WHERE task_dedupe_key = \?/,
        rows: [{ task_id: 901 }],
      },
      { match: /^UPDATE tasks SET task_last_update = NOW\(\) WHERE task_id = \?$/,
        assertParams: (p) => expect(p).toEqual([901]) },
    ]);
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(r.output).toMatchObject({ alert_task_id: 901, alert_deduped: true });
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  test('ambiguous roster hit alerts and never writes', async () => {
    settingsLive('1', JSON.stringify([
      { name: 'A McDonald', lname: 'McDonald', case_type: 13, link: 'x' },
      { name: 'B McDonald', lname: 'McDonald', case_type: 13, link: 'y' },
    ]));
    taskService.createTask.mockResolvedValueOnce({ task_id: 902 });
    const db = makeDb([
      caseStep(baseCase({ case_trustee: 'McDonald', case_chapter: '13' })),
      { match: /^SELECT task_id FROM tasks/, rows: [] },
      { match: /^UPDATE tasks SET task_dedupe_key/ },
    ]);
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(r.output.status).toBe('ambiguous');
    expect(taskService.createTask.mock.calls[0][1].desc).toMatch(/MORE THAN ONE/);
  });

  test('empty case_trustee → no_trustee alert', async () => {
    settingsLive('1');
    taskService.createTask.mockResolvedValueOnce({ task_id: 903 });
    const db = makeDb([
      caseStep(baseCase({ case_trustee: '' })),
      { match: /^SELECT task_id FROM tasks/, rows: [] },
      { match: /^UPDATE tasks SET task_dedupe_key/ },
    ]);
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(r.output.status).toBe('no_trustee');
  });

  test('unparseable roster → no_roster alert, no throw', async () => {
    settingsLive('1', '{"broken":[');
    taskService.createTask.mockResolvedValueOnce({ task_id: 904 });
    const db = makeDb([
      caseStep(baseCase()),
      { match: /^SELECT task_id FROM tasks/, rows: [] },
      { match: /^UPDATE tasks SET task_dedupe_key/ },
    ]);
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(r.output.status).toBe('no_roster');
  });
});

// ── dry-run behavior ───────────────────────────────────────────────────────
describe('dry run (gate absent/0, or dry_run param)', () => {
  test("gate '0': matched run writes NOTHING, reports would_update, sends summary email", async () => {
    settingsLive('0');
    const db = makeDb([caseStep(baseCase())]);   // NO UPDATE step scripted
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(r.output).toMatchObject({
      status: 'matched', dry_run: true,
      trustee_updated: false, link_updated: false,
      would_update: ['case_trustee', 'case_341_link'],
    });
    expect(logService.createLogEntry).not.toHaveBeenCalled();
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const mail = emailService.sendEmail.mock.calls[0][1];
    expect(mail).toMatchObject({ to: 'it@4lsg.com', from: 'IT@metrodetroitbankruptcylaw.com' });
    expect(mail.subject).toMatch(/^\[TrusteeVal DRY\] 26-40001-mar — matched$/);
  });

  test('gate absent (null) is also dry', async () => {
    getSettings.mockResolvedValueOnce({ trustee_validation_live: null, 'fe-trustees': ROSTER });
    const db = makeDb([caseStep(baseCase())]);
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(r.output.dry_run).toBe(true);
  });

  test('dry no-match: alert goes to dry_run_alert_to with [DRY RUN] title and a -dry dedupe key', async () => {
    settingsLive('0');
    taskService.createTask.mockResolvedValueOnce({ task_id: 905 });
    const db = makeDb([
      caseStep(baseCase({ case_trustee: 'Jane Q. Nobody' })),
      {
        match: /^SELECT task_id FROM tasks WHERE task_dedupe_key = \?/,
        assertParams: (p) => expect(p[0]).toBe('trustee-val-dry:AB12CD34'),
        rows: [],
      },
      {
        match: /^UPDATE tasks SET task_dedupe_key = \? WHERE task_id = \?$/,
        assertParams: (p) => expect(p).toEqual(['trustee-val-dry:AB12CD34', 905]),
      },
    ]);
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    const t = taskService.createTask.mock.calls[0][1];
    expect(t.to).toBe(6);
    expect(t.title).toMatch(/^\[DRY RUN\] /);
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(r.output).toMatchObject({ dry_run: true, alert_task_id: 905 });
  });

  test("dry_run param forces dry even when the gate is '1'", async () => {
    settingsLive('1');
    const db = makeDb([caseStep(baseCase())]);
    const r = await validate({ case_id: 'AB12CD34', dry_run: true }, db);
    drained(db);
    expect(r.output.dry_run).toBe(true);
  });

  test('summary-email failure never fails the run', async () => {
    settingsLive('0');
    emailService.sendEmail.mockRejectedValueOnce(new Error('smtp down'));
    const db = makeDb([caseStep(baseCase())]);
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(r.success).toBe(true);
  });
});

describe('errors', () => {
  test('missing case_id throws', async () => {
    await expect(validate({}, makeDb([]))).rejects.toThrow(/requires case_id/);
  });
  test('unknown case throws', async () => {
    settingsLive('1');
    const db = makeDb([{ match: /^SELECT case_id, case_trustee/, rows: [] }]);
    await expect(validate({ case_id: 'NOPE' }, db)).rejects.toThrow(/not found/);
  });
});
