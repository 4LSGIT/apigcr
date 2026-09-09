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
jest.mock('../lib/trusteeRoster', () => ({
  loadTrusteeRoster: jest.fn(),
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
jest.mock('../lib/domainEvents', () => ({
  emit: jest.fn(),   // fire-and-forget in production; a plain spy here
}));

const { getSettings }  = require('../services/settingsService');
const { loadTrusteeRoster } = require('../lib/trusteeRoster');
const taskService      = require('../services/taskService');
const logService       = require('../services/logService');
const emailService     = require('../services/emailService');
const domainEvents     = require('../lib/domainEvents');
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

// Slice 7: the roster arrives PARSED from lib/trusteeRoster (contacts +
// contact_roles), each entry carrying its contact_id — the twin source.
const ROSTER = [
  { name: 'Michael A. Stevenson', lname: 'Stevenson', case_type: 7,  link: 'https://z/stev', contact_id: 2075 },
  { name: 'Stuart A. Gold',       lname: 'Gold',      case_type: 7,  link: 'https://z/gold', contact_id: 2078 },
  { name: 'Krispen S. Carroll',   lname: 'Carroll',   case_type: 13, link: 'https://z/car',  contact_id: 2085 },
];

function caseStep(row) {
  return {
    match: /^SELECT case_id, case_trustee, case_chapter, case_341_link, case_trustee_contact_id, case_number, case_number_full FROM cases WHERE case_id = \? LIMIT 1$/,
    rows: [row],
  };
}
const baseCase = (over = {}) => ({
  case_id: 'AB12CD34', case_trustee: 'Michael Stevenson', case_chapter: '7',
  case_341_link: '', case_trustee_contact_id: null,
  case_number: '26-40001', case_number_full: '26-40001-mar',
  ...over,
});

function settingsLive(live = '1', roster = ROSTER) {
  getSettings.mockResolvedValueOnce({ trustee_validation_live: live });
  loadTrusteeRoster.mockResolvedValueOnce(roster);
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
  test('trusteeRoster really exports loadTrusteeRoster(db)', () => {
    const real = jest.requireActual('../lib/trusteeRoster');
    expect(typeof real.loadTrusteeRoster).toBe('function');
    expect(real.loadTrusteeRoster.length).toBe(1);
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
  test('domainEvents really exports emit(db, eventType, payload)', () => {
    const real = jest.requireActual('../lib/domainEvents');
    expect(typeof real.emit).toBe('function');
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
        match: /^UPDATE cases SET case_trustee = \?, case_341_link = \?, case_trustee_contact_id = \? WHERE case_id = \?$/,
        assertParams: (p) => expect(p).toEqual(['Michael A. Stevenson', 'https://z/stev', 2075, 'AB12CD34']),
      },
    ]);
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(r.output).toMatchObject({
      status: 'matched', method: 'lname',
      canonical: 'Michael A. Stevenson',
      trustee_updated: true, link_updated: true, twin_updated: true, dry_run: false,
      alert_task_id: null,
    });
    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
    expect(logService.createLogEntry.mock.calls[0][1]).toMatchObject({
      type: 'status', link_type: 'case', link_id: 'AB12CD34', by: 0,
    });
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(emailService.sendEmail).not.toHaveBeenCalled();   // no dry email live
    // FIL-3: live matched run announces trustee arrival for downstream chains
    expect(domainEvents.emit).toHaveBeenCalledTimes(1);
    const [, evType, evPayload] = domainEvents.emit.mock.calls[0];
    expect(evType).toBe('case.trustee_validated');
    expect(evPayload).toMatchObject({
      case_id: 'AB12CD34',
      source: 'system',
      data: {
        status: 'matched', method: 'lname',
        canonical: 'Michael A. Stevenson',
        trustee_updated: true, link_updated: true,
        docket: '26-40001-mar', case_chapter: '7',
      },
    });
  });

  test('IDEMPOTENT: already-canonical trustee + same link → no UPDATE, no log', async () => {
    settingsLive('1');
    const db = makeDb([
      caseStep(baseCase({ case_trustee: 'Michael A. Stevenson', case_341_link: 'https://z/stev',
                          case_trustee_contact_id: 2075 })),
    ]);
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(r.output).toMatchObject({
      status: 'matched', trustee_updated: false, link_updated: false, twin_updated: false,
    });
    expect(logService.createLogEntry).not.toHaveBeenCalled();
    // FIL-3: the arrival signal fires even with nothing to write — "trustee
    // known and valid" is the event, not "a column changed". Consumers carry
    // their own send-once guards.
    expect(domainEvents.emit).toHaveBeenCalledTimes(1);
    expect(domainEvents.emit.mock.calls[0][1]).toBe('case.trustee_validated');
    expect(domainEvents.emit.mock.calls[0][2].data).toMatchObject({
      trustee_updated: false, link_updated: false,
    });
  });

  test('link-only delta: canonical name already stored, link missing → only the link is written', async () => {
    settingsLive('1');
    const db = makeDb([
      caseStep(baseCase({ case_trustee: 'Stuart A. Gold', case_trustee_contact_id: 2078 })),
      {
        match: /^UPDATE cases SET case_341_link = \? WHERE case_id = \?$/,
        assertParams: (p) => expect(p).toEqual(['https://z/gold', 'AB12CD34']),
      },
    ]);
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(r.output).toMatchObject({ trustee_updated: false, link_updated: true, twin_updated: false, method: 'exact' });
  });

  test('live matched run with link-only delta also emits (single signal per validation)', async () => {
    // covered structurally by the link-only test below via the afterEach-free
    // spy; asserted here explicitly so a future "only emit when trustee text
    // changed" refactor fails a named test.
    settingsLive('1');
    const db = makeDb([
      caseStep(baseCase({ case_trustee: 'Stuart A. Gold', case_trustee_contact_id: 2078 })),
      { match: /^UPDATE cases SET case_341_link = \? WHERE case_id = \?$/ },
    ]);
    await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(domainEvents.emit).toHaveBeenCalledTimes(1);
    expect(domainEvents.emit.mock.calls[0][2].data).toMatchObject({
      status: 'matched', method: 'exact', canonical: 'Stuart A. Gold',
    });
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
    settingsLive('1', [
      { name: 'A McDonald', lname: 'McDonald', case_type: 13, link: 'x', contact_id: 1 },
      { name: 'B McDonald', lname: 'McDonald', case_type: 13, link: 'y', contact_id: 2 },
    ]);
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

  test('empty roster (no active trustee roles) → no_roster alert, no throw', async () => {
    settingsLive('1', []);
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
describe('live non-matched statuses never emit', () => {
  test('no_match raises the alert and emits NOTHING', async () => {
    settingsLive('1');
    taskService.createTask.mockResolvedValueOnce({ task_id: 902, action_token: 't', action_url: 'u' });
    const db = makeDb([
      caseStep(baseCase({ case_trustee: 'Totally Unknown Person' })),
      { match: /^SELECT task_id FROM tasks WHERE task_dedupe_key = \? AND task_status IN \(\?, \?, \?\) ORDER BY task_id DESC LIMIT 1$/, rows: [] },
      { match: /^UPDATE tasks SET task_dedupe_key = \? WHERE task_id = \?$/ },
    ]);
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(r.output.status).toBe('no_match');
    expect(domainEvents.emit).not.toHaveBeenCalled();
  });
});

describe('dry run (gate absent/0, or dry_run param)', () => {
  test('dry runs NEVER emit case.trustee_validated — the gate cannot arm downstream chains', async () => {
    settingsLive('0');
    const db = makeDb([caseStep(baseCase())]);
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(r.output.status).toBe('matched');
    expect(r.output.dry_run).toBe(true);
    expect(domainEvents.emit).not.toHaveBeenCalled();
  });

  test("gate '0': matched run writes NOTHING, reports would_update, sends summary email", async () => {
    settingsLive('0');
    const db = makeDb([caseStep(baseCase())]);   // NO UPDATE step scripted
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(r.output).toMatchObject({
      status: 'matched', dry_run: true,
      trustee_updated: false, link_updated: false,
      would_update: ['case_trustee', 'case_341_link', 'case_trustee_contact_id'],
    });
    expect(logService.createLogEntry).not.toHaveBeenCalled();
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const mail = emailService.sendEmail.mock.calls[0][1];
    expect(mail).toMatchObject({ to: 'it@4lsg.com', from: 'IT@metrodetroitbankruptcylaw.com' });
    expect(mail.subject).toMatch(/^\[TrusteeVal DRY\] 26-40001-mar — matched$/);
  });

  test('gate absent (null) is also dry', async () => {
    getSettings.mockResolvedValueOnce({ trustee_validation_live: null });
    loadTrusteeRoster.mockResolvedValueOnce(ROSTER);
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

// ── slice 7: the contact_id twin ───────────────────────────────────────────
describe('case_trustee_contact_id twin (slice 7)', () => {
  test('TWIN-ONLY delta: canonical name + link already stored, twin NULL → twin rides an UPDATE, NO log row', async () => {
    settingsLive('1');
    const db = makeDb([
      caseStep(baseCase({ case_trustee: 'Michael A. Stevenson', case_341_link: 'https://z/stev' })),
      {
        match: /^UPDATE cases SET case_trustee_contact_id = \? WHERE case_id = \?$/,
        assertParams: (p) => expect(p).toEqual([2075, 'AB12CD34']),
      },
    ]);
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(r.output).toMatchObject({
      status: 'matched', trustee_updated: false, link_updated: false, twin_updated: true,
    });
    // The header's idempotency promise is about what STAFF see: twin-only
    // backstop writes are unlogged, same as courtExecutor's twin writes.
    expect(logService.createLogEntry).not.toHaveBeenCalled();
    // FIL-3 emission semantics unchanged: matched live run emits, once.
    expect(domainEvents.emit).toHaveBeenCalledTimes(1);
    expect(domainEvents.emit.mock.calls[0][1]).toBe('case.trustee_validated');
  });

  test('an entry with no usable contact_id never writes the twin (never guess)', async () => {
    settingsLive('1', [
      { name: 'Michael A. Stevenson', lname: 'Stevenson', case_type: 7, link: 'https://z/stev' },
    ]);
    const db = makeDb([
      caseStep(baseCase({ case_trustee: 'Michael A. Stevenson', case_341_link: 'https://z/stev' })),
      // no UPDATE step — nothing to write
    ]);
    const r = await validate({ case_id: 'AB12CD34' }, db);
    drained(db);
    expect(r.output).toMatchObject({ status: 'matched', twin_updated: false });
  });

  test('roster load failure PROPAGATES — a DB blip fails the run for retry, never a phantom no_roster alert', async () => {
    getSettings.mockResolvedValueOnce({ trustee_validation_live: '1' });
    loadTrusteeRoster.mockRejectedValueOnce(new Error('pool exhausted'));
    const db = makeDb([caseStep(baseCase())]);
    await expect(validate({ case_id: 'AB12CD34' }, db)).rejects.toThrow(/pool exhausted/);
    expect(taskService.createTask).not.toHaveBeenCalled();
    drained(db);
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
