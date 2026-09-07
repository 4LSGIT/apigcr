// tests/createTaskDedupe.test.js — FIL-3 create_task dedupe_key.
//
// House stub-db pattern (scriptGuard-wired, see tests/helpers/scriptGuard.js):
// scripted {match, rows} steps consumed in order; drift in either direction
// fails the test. taskService is a jest mock with a requireActual contract
// test pinning the mocked name to the real module.
//
// WHAT IS UNDER TEST
//   dedupe_key on lib/internal_functions/tasks.js create_task:
//     - key + OPEN task with the key  → touch task_last_update, NO create,
//       output {task_id: existing, deduped: true}
//     - key + no open task            → normal create, then key stamped,
//       output {task_id: new, deduped: false}
//     - no key                        → byte-identical legacy behavior
//       (no dedupe SELECT, no stamp UPDATE)
//     - over-length key               → clipped to 64 chars (63 + ellipsis),
//       same clip shape trustee.js uses
'use strict';

const { scriptGuard } = require('./helpers/scriptGuard');

jest.mock('../services/taskService', () => ({
  createTask: jest.fn(),
}));

const taskService = require('../services/taskService');
const fns         = require('../lib/internal_functions/tasks');

const createTask = fns.create_task;

// ── scripted stub db ───────────────────────────────────────────────────────
function makeDb(script) {
  const calls = [];
  const guard = scriptGuard('createTaskDedupe stubDb', script);
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

const DEDUPE_SELECT_RE =
  /^SELECT task_id FROM tasks WHERE task_dedupe_key = \? AND task_status IN \('Pending', 'Due Today', 'Overdue'\) ORDER BY task_id DESC LIMIT 1$/;
const TOUCH_RE = /^UPDATE tasks SET task_last_update = NOW\(\) WHERE task_id = \?$/;
const STAMP_RE = /^UPDATE tasks SET task_dedupe_key = \? WHERE task_id = \?$/;

function drained(db) {
  expect(db.script).toEqual([]);
}

beforeEach(() => {
  jest.clearAllMocks();
  taskService.createTask.mockResolvedValue({
    task_id: 4321, action_token: 'tok', action_url: 'https://x/t/tok',
  });
});

// ── contract test: the mocked name exists on the real module ───────────────
describe('mock boundary contract', () => {
  test('taskService really exports createTask(db, opts)', () => {
    const real = jest.requireActual('../services/taskService');
    expect(typeof real.createTask).toBe('function');
    expect(real.createTask.length).toBe(2);
  });
});

describe('dedupe_key present', () => {
  test('open task with the key → touched, NOT recreated, deduped:true, no assignment email path', async () => {
    const db = makeDb([
      { match: DEDUPE_SELECT_RE, rows: [{ task_id: 777 }],
        assertParams: (p) => expect(p).toEqual(['cs-filed:AB12CD34']) },
      { match: TOUCH_RE,
        assertParams: (p) => expect(p).toEqual([777]) },
    ]);
    const res = await createTask(
      { title: 'CS filed', assigned_to: 22, link_type: 'case', link_id: 'AB12CD34',
        source: 'case_filed', dedupe_key: 'cs-filed:AB12CD34' },
      db
    );
    expect(res.output).toEqual(expect.objectContaining({ task_id: 777, deduped: true }));
    expect(res.output.action_url).toBeNull();
    expect(taskService.createTask).not.toHaveBeenCalled();   // no create, no email
    drained(db);
  });

  test('no open task with the key → created via service, then key stamped, deduped:false', async () => {
    const db = makeDb([
      { match: DEDUPE_SELECT_RE, rows: [] },
      { match: STAMP_RE,
        assertParams: (p) => expect(p).toEqual(['cs-filed:AB12CD34', 4321]) },
    ]);
    const res = await createTask(
      { title: 'CS filed', assigned_to: 22, link_type: 'case', link_id: 'AB12CD34',
        source: 'case_filed', dedupe_key: 'cs-filed:AB12CD34' },
      db
    );
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    const opts = taskService.createTask.mock.calls[0][1];
    expect(opts).toEqual(expect.objectContaining({
      to: 22, link_type: 'case', link_id: 'AB12CD34', source: 'case_filed',
    }));
    expect(res.output).toEqual(expect.objectContaining({
      task_id: 4321, deduped: false, action_url: 'https://x/t/tok',
    }));
    drained(db);
  });

  test('a COMPLETED task with the key does not block — the SELECT only sees open statuses', async () => {
    // The status filter lives in the SQL; a completed row simply never comes
    // back. Scripted as an empty hit + normal create.
    const db = makeDb([
      { match: DEDUPE_SELECT_RE, rows: [] },
      { match: STAMP_RE },
    ]);
    const res = await createTask(
      { title: 'Recurred after completion', assigned_to: 22, dedupe_key: 'cs-filed:ZZ99' },
      db
    );
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    expect(res.output.deduped).toBe(false);
    drained(db);
  });

  test('over-length key is clipped to 64 chars (63 + …) in BOTH the lookup and the stamp', async () => {
    const longKey = 'k'.repeat(80);
    const clipped = 'k'.repeat(63) + '…';
    const db = makeDb([
      { match: DEDUPE_SELECT_RE,
        assertParams: (p) => { expect(p[0]).toBe(clipped); expect(p[0].length).toBe(64); },
        rows: [] },
      { match: STAMP_RE,
        assertParams: (p) => expect(p[0]).toBe(clipped) },
    ]);
    await createTask({ title: 'T', assigned_to: 22, dedupe_key: longKey }, db);
    drained(db);
  });

  test('blank / whitespace-only key behaves as no key at all', async () => {
    const db = makeDb([]);   // no dedupe SELECT, no stamp
    const res = await createTask({ title: 'T', assigned_to: 22, dedupe_key: '   ' }, db);
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    expect(res.output.deduped).toBe(false);
    drained(db);
  });
});

describe('no dedupe_key — legacy behavior untouched', () => {
  test('creates via the service with zero direct db.query calls', async () => {
    const db = makeDb([]);
    const res = await createTask(
      { title: 'Plain task', assigned_to: 6, description: 'x' },
      db
    );
    expect(db.calls).toEqual([]);
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    expect(res.output).toEqual(expect.objectContaining({
      task_id: 4321, deduped: false,
    }));
    drained(db);
  });

  test('required-param guards still fire before any db work', async () => {
    const db = makeDb([]);
    await expect(createTask({ assigned_to: 6, dedupe_key: 'x:y' }, db))
      .rejects.toThrow('create_task requires title');
    await expect(createTask({ title: 'T', dedupe_key: 'x:y' }, db))
      .rejects.toThrow('create_task requires assigned_to');
    expect(db.calls).toEqual([]);
    drained(db);
  });
});

describe('__meta', () => {
  test('dedupe_key is declared with placeholderAllowed so the workflow editor accepts {{tokens}}', () => {
    const spec = fns.create_task.__meta.params.find((p) => p.name === 'dedupe_key');
    expect(spec).toBeDefined();
    expect(spec.type).toBe('string');
    expect(spec.required).toBe(false);
    expect(spec.placeholderAllowed).toBe(true);
  });
});
