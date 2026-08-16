/**
 * Tests for the dedupe / auto-resolve half of services/esignAlertService.js.
 *
 * tests/esignAlert.test.js already covers assignee resolution, the length
 * clips and the varchar(20) link trap against a bare `db = {}`. This file adds
 * a db that actually behaves like the `tasks` table, because dedupe is the
 * first thing in this module that reads rows back.
 *
 * WHAT IS LOAD-BEARING HERE
 *
 *   1. An alerting bug must never SWALLOW an alert. Every failure inside the
 *      dedupe machinery — a dead pool, a missing task_dedupe_key column before
 *      the migration lands — has to fall through and create the task. A
 *      duplicate is a nuisance; a suppressed alert is a fault. That is the
 *      'a lookup failure still raises the alert' test, and it is the most
 *      important one in the file.
 *
 *   2. Per-occurrence alerts must NOT dedupe. "Signed doc received: <name>" is
 *      a different document every time and passes no key; if a future refactor
 *      ever gave every alert a key by default, that regression is silent and
 *      costs the firm real filings.
 *
 *   3. The ongoing marker must never eat the operator instructions. task_desc
 *      is varchar(1000), sql_mode is not strict, and raiseTask clips to exactly
 *      that — so a maximal description has NO room for a marker and the append
 *      has to decline rather than clip the "Action: ..." line off the end.
 *
 *   npx jest tests/esignAlertDedupe.test.js
 */

jest.mock('../services/taskService', () => ({
  createTask:   jest.fn(),
  completeTask: jest.fn(),
}));

jest.mock('../services/settingsService', () => ({
  getSetting:  jest.fn(async () => '22'),
  getSettings: jest.fn(async () => ({})),
}));

const taskService = require('../services/taskService');
const { getSetting } = require('../services/settingsService');
const alerts = require('../services/esignAlertService');

// ─────────────────────────────────────────────────────────────────────────────
// A `tasks` table that is just real enough.
//
// Matched by SQL shape rather than parsed, so a change to the queries in
// esignAlertService shows up here as a test failure rather than as a silent
// pass against a stub that answers everything.
// ─────────────────────────────────────────────────────────────────────────────
function makeDb({ failLookup = false, failStamp = false } = {}) {
  const rows = [];
  let nextId = 1000;

  const db = {
    rows,
    byId: (id) => rows.find((r) => r.task_id === id),

    /** Stands in for the INSERT inside taskService.createTask. */
    __create(opts) {
      const id = ++nextId;
      rows.push({
        task_id:         id,
        task_source:     opts.source || null,
        task_dedupe_key: null,
        task_status:     'Pending',
        task_title:      opts.title,
        task_desc:       opts.desc,
        task_last_update: 0,
      });
      return { task_id: id, action_token: `tok${id}`, action_url: `https://app/t/tok${id}` };
    },

    query: jest.fn(async (sql, params = []) => {
      // ── the dedupe lookup (raiseTask) and the resolve lookup ──────────────
      if (/SELECT\s+task_id, task_desc/i.test(sql)) {
        if (failLookup) throw new Error('pool exhausted');
        const [source, key, ...statuses] = params;
        let hits = rows.filter(
          (r) => r.task_source === source
            && r.task_dedupe_key === key
            && statuses.includes(r.task_status)
        );
        hits = hits.sort((a, b) =>
          /ORDER BY task_id DESC/i.test(sql) ? b.task_id - a.task_id : a.task_id - b.task_id);
        if (/LIMIT 1/i.test(sql)) hits = hits.slice(0, 1);
        // Copies, so a test cannot pass by mutating the store through the result.
        return [hits.map((r) => ({ task_id: r.task_id, task_desc: r.task_desc }))];
      }

      // ── stamping the key onto a freshly created task ──────────────────────
      if (/UPDATE tasks SET `task_dedupe_key`/i.test(sql)) {
        if (failStamp) throw new Error("Unknown column 'task_dedupe_key' in 'field list'");
        const [key, id] = params;
        const row = db.byId(id);
        if (row) row.task_dedupe_key = key;
        return [{ affectedRows: row ? 1 : 0 }];
      }

      // ── touch: description + timestamp ────────────────────────────────────
      if (/UPDATE tasks SET task_desc = \?, task_last_update = NOW\(\)/i.test(sql)) {
        const [desc, id] = params;
        const row = db.byId(id);
        if (row) { row.task_desc = desc; row.task_last_update += 1; }
        return [{ affectedRows: row ? 1 : 0 }];
      }

      // ── touch: timestamp only (description had no room for the marker) ────
      if (/UPDATE tasks SET task_last_update = NOW\(\)/i.test(sql)) {
        const [id] = params;
        const row = db.byId(id);
        if (row) row.task_last_update += 1;
        return [{ affectedRows: row ? 1 : 0 }];
      }

      // ── the auto-resolve note ─────────────────────────────────────────────
      if (/UPDATE tasks SET task_desc = \? WHERE task_id/i.test(sql)) {
        const [desc, id] = params;
        const row = db.byId(id);
        if (row) row.task_desc = desc;
        return [{ affectedRows: row ? 1 : 0 }];
      }

      throw new Error(`unexpected SQL in test db: ${String(sql).slice(0, 120)}`);
    }),
  };
  return db;
}

let db;

beforeEach(() => {
  jest.clearAllMocks();
  getSetting.mockResolvedValue('22');
  db = makeDb();

  taskService.createTask.mockImplementation(async (theDb, opts) => theDb.__create(opts));
  // Mirrors the real completeTask, including its refusal to close a task twice
  // — resolveTask has to survive that, since it is the shape a race takes.
  taskService.completeTask.mockImplementation(async (theDb, id) => {
    const row = theDb.byId(id);
    if (!row) throw new Error(`Task ${id} not found`);
    if (row.task_status === 'Completed') throw new Error('Task is already completed');
    if (row.task_status === 'Deleted')   throw new Error('Cannot complete a deleted task');
    row.task_status = 'Completed';
    return row;
  });

  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

const raise = (o) => alerts.raiseTask(db, o);
const ONGOING = /\[still occurring as of .* - seen (\d+)x\]$/;

// ─────────────────────────────────────────────────────────────────────────────
describe('a key creates at most one open task', () => {
  test('(1) the first occurrence creates a task and reports deduped:false', async () => {
    const out = await raise({ title: 'E-sign webhooks appear to be DOWN', desc: 'Body.', dedupeKey: 'webhook-down' });

    expect(out).toMatchObject({ ok: true, deduped: false });
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    expect(db.rows).toHaveLength(1);
    // Stamped by the follow-up UPDATE, not by createTask — createTask must not
    // learn about this column, or a missing migration would drop every alert.
    expect(db.rows[0].task_dedupe_key).toBe('webhook-down');
    expect(taskService.createTask.mock.calls[0][1]).not.toHaveProperty('dedupeKey');
  });

  test('(2) a second occurrence touches the open task instead of creating one', async () => {
    await raise({ title: 'DOWN', desc: 'Body.\n\nAction: check the logs.', dedupeKey: 'webhook-down' });
    const first = db.rows[0].task_id;

    const out = await raise({ title: 'DOWN', desc: 'Body.\n\nAction: check the logs.', dedupeKey: 'webhook-down' });

    expect(out).toMatchObject({ ok: true, deduped: true, taskId: first });
    expect(taskService.createTask).toHaveBeenCalledTimes(1);   // still just the one
    expect(db.rows).toHaveLength(1);

    const row = db.byId(first);
    expect(row.task_desc).toMatch(ONGOING);
    expect(row.task_desc).toMatch(/seen 2x/);
    expect(row.task_last_update).toBe(1);                      // bumped, not stale
    expect(row.task_desc).toContain('Action: check the logs.'); // body intact
  });

  test('the marker is replaced, never accumulated, and counts up', async () => {
    const o = { title: 'DOWN', desc: 'Body.', dedupeKey: 'webhook-down' };
    await raise(o);
    await raise(o);
    await raise(o);
    await raise(o);

    const desc = db.rows[0].task_desc;
    expect(desc.match(/still occurring/g)).toHaveLength(1);
    expect(desc).toMatch(/seen 4x/);
    expect(desc.length).toBeLessThanOrEqual(alerts.MAX_DESC);
  });

  test('(3) the same key raises again once the first task is closed', async () => {
    await raise({ title: 'DOWN', desc: 'Body.', dedupeKey: 'webhook-down' });
    db.rows[0].task_status = 'Completed';

    const out = await raise({ title: 'DOWN', desc: 'Body.', dedupeKey: 'webhook-down' });
    expect(out).toMatchObject({ ok: true, deduped: false });
    expect(db.rows).toHaveLength(2);
  });

  // Task 1077 was DELETED by the assignee rather than acted on. If Deleted
  // counted as open, the outage it described would have gone unreported.
  test('a task the assignee DELETED does not suppress the next occurrence', async () => {
    await raise({ title: 'DOWN', desc: 'Body.', dedupeKey: 'webhook-down' });
    db.rows[0].task_status = 'Deleted';

    const out = await raise({ title: 'DOWN', desc: 'Body.', dedupeKey: 'webhook-down' });
    expect(out).toMatchObject({ deduped: false });
    expect(db.rows).toHaveLength(2);
  });

  test('Overdue and Due Today still count as open', async () => {
    for (const status of ['Overdue', 'Due Today']) {
      db = makeDb();
      await raise({ title: 'DOWN', desc: 'Body.', dedupeKey: 'webhook-down' });
      db.rows[0].task_status = status;
      const out = await raise({ title: 'DOWN', desc: 'Body.', dedupeKey: 'webhook-down' });
      expect(out).toMatchObject({ deduped: true });
      expect(db.rows).toHaveLength(1);
    }
  });

  test('(4) different keys are different conditions', async () => {
    await raise({ title: 'DOWN', desc: 'a', dedupeKey: 'webhook-down' });
    await raise({ title: 'CREDITS', desc: 'b', dedupeKey: 'credits-low' });

    expect(db.rows).toHaveLength(2);
    expect(db.rows.map((r) => r.task_dedupe_key)).toEqual(['webhook-down', 'credits-low']);
  });

  test('dedupe is scoped to task_source, not to the key alone', async () => {
    await raise({ title: 'DOWN', desc: 'a', dedupeKey: 'webhook-down' });
    db.rows[0].task_source = 'court_review';       // another subsystem's task

    const out = await raise({ title: 'DOWN', desc: 'a', dedupeKey: 'webhook-down' });
    expect(out).toMatchObject({ deduped: false });
    expect(db.rows).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('un-keyed alerts are per-occurrence and must never merge', () => {
  // The regression guard. "Signed doc received: <name>" is a different
  // document every time; suppressing the second one loses a filing.
  test('(5) no key means always create, however many times', async () => {
    const o = { title: 'File signed doc manually: Retainer', desc: 'Body.' };
    const a = await raise(o);
    const b = await raise(o);

    expect(a).toMatchObject({ ok: true, deduped: false });
    expect(b).toMatchObject({ ok: true, deduped: false });
    expect(db.rows).toHaveLength(2);
    // Not one SELECT was issued — the dedupe path is never even entered.
    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringMatching(/SELECT\s+task_id, task_desc/i), expect.anything()
    );
  });

  test('an empty or whitespace key is treated as no key at all', async () => {
    for (const key of ['', '   ', null, undefined]) {
      db = makeDb();
      await raise({ title: 't', desc: 'd', dedupeKey: key });
      await raise({ title: 't', desc: 'd', dedupeKey: key });
      expect(db.rows).toHaveLength(2);
    }
  });

  // Same reasoning as MAX_TASK_LINK_ID: a silently truncated key would MERGE
  // two different conditions and suppress the second forever. Refuse it.
  test('an over-length key is refused rather than clipped', async () => {
    const key = 'k'.repeat(alerts.MAX_DEDUPE_KEY + 1);
    await raise({ title: 't', desc: 'd', dedupeKey: key });
    await raise({ title: 't', desc: 'd', dedupeKey: key });

    expect(db.rows).toHaveLength(2);                       // duplicated, not merged
    expect(db.rows[0].task_dedupe_key).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/UN-KEYED/));
  });

  test('a key of exactly the column width is accepted', async () => {
    const key = 'k'.repeat(alerts.MAX_DEDUPE_KEY);
    await raise({ title: 't', desc: 'd', dedupeKey: key });
    const out = await raise({ title: 't', desc: 'd', dedupeKey: key });
    expect(out).toMatchObject({ deduped: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('an alerting bug must never swallow an alert', () => {
  test('(8) a lookup failure falls through and raises the task anyway', async () => {
    db = makeDb({ failLookup: true });

    const out = await raise({ title: 'DOWN', desc: 'Body.', dedupeKey: 'webhook-down' });

    expect(out).toMatchObject({ ok: true, deduped: false });
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    expect(db.rows).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/raising the alert rather than suppressing it/)
    );
  });

  test('a repeated lookup failure duplicates rather than silences', async () => {
    db = makeDb({ failLookup: true });
    await raise({ title: 'DOWN', desc: 'B', dedupeKey: 'webhook-down' });
    await raise({ title: 'DOWN', desc: 'B', dedupeKey: 'webhook-down' });
    expect(db.rows).toHaveLength(2);
  });

  // Deploy order is SQL → backend. If it slips, the stamp fails and the task
  // still stands: behavior degrades to exactly what it was before this slice.
  test('a missing task_dedupe_key column does not lose the task', async () => {
    db = makeDb({ failStamp: true });

    const out = await raise({ title: 'DOWN', desc: 'Body.', dedupeKey: 'webhook-down' });

    expect(out).toMatchObject({ ok: true, deduped: false });
    expect(db.rows).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/task_dedupe_key/));
  });

  test('a touch failure still counts as deduped — the decision already stands', async () => {
    await raise({ title: 'DOWN', desc: 'B', dedupeKey: 'webhook-down' });
    const realQuery = db.query;
    db.query = jest.fn(async (sql, params) => {
      if (/^UPDATE/i.test(sql)) throw new Error('deadlock');
      return realQuery(sql, params);
    });

    const out = await raise({ title: 'DOWN', desc: 'B', dedupeKey: 'webhook-down' });
    expect(out).toMatchObject({ ok: true, deduped: true });
    expect(db.rows).toHaveLength(1);
  });

  test('taskService still throwing is reported, not raised', async () => {
    taskService.createTask.mockRejectedValue(new Error('task_title too long'));
    const out = await raise({ title: 'x', desc: 'y', dedupeKey: 'webhook-down' });
    expect(out).toMatchObject({ ok: false, reason: 'error' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the ongoing marker respects MAX_DESC', () => {
  // task_desc is varchar(1000) and sql_mode is not strict: an over-length write
  // would TRUNCATE SILENTLY, taking the operator instructions with it.
  test('(9) a maximal description is left alone and only the timestamp moves', async () => {
    const tail = '\n\nAction: check the Zoho Sign console.';
    const desc = 'x'.repeat(alerts.MAX_DESC - tail.length) + tail;
    expect(desc).toHaveLength(alerts.MAX_DESC);

    await raise({ title: 'DOWN', desc, dedupeKey: 'webhook-down' });
    const id = db.rows[0].task_id;
    expect(db.byId(id).task_desc).toHaveLength(alerts.MAX_DESC);

    const out = await raise({ title: 'DOWN', desc, dedupeKey: 'webhook-down' });

    expect(out).toMatchObject({ deduped: true });
    const row = db.byId(id);
    expect(row.task_desc).toHaveLength(alerts.MAX_DESC);
    expect(row.task_desc.endsWith(tail)).toBe(true);   // instructions survive
    expect(row.task_desc).not.toMatch(/still occurring/);
    expect(row.task_desc).not.toMatch(/truncated/);
    expect(row.task_last_update).toBe(1);              // still visibly ongoing
  });

  test('a near-maximal description takes the marker and stays within the column', async () => {
    const tail = '\n\nAction: check the Zoho Sign console.';
    const desc = 'x'.repeat(880 - tail.length) + tail;

    await raise({ title: 'DOWN', desc, dedupeKey: 'webhook-down' });
    await raise({ title: 'DOWN', desc, dedupeKey: 'webhook-down' });
    await raise({ title: 'DOWN', desc, dedupeKey: 'webhook-down' });

    const row = db.rows[0];
    expect(row.task_desc.length).toBeLessThanOrEqual(alerts.MAX_DESC);
    expect(row.task_desc).toContain('Action: check the Zoho Sign console.');
    expect(row.task_desc).toMatch(/seen 3x/);
    expect(row.task_desc.match(/still occurring/g)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('resolveTask', () => {
  test('(6) closes the open task carrying the key', async () => {
    await raise({ title: 'DOWN', desc: 'Body.\n\nAction: check the logs.', dedupeKey: 'webhook-down' });
    const id = db.rows[0].task_id;

    const out = await alerts.resolveTask(db, { dedupeKey: 'webhook-down' });

    expect(out).toMatchObject({ ok: true, count: 1, resolved: [id] });
    expect(db.byId(id).task_status).toBe('Completed');
    expect(db.byId(id).task_desc).toMatch(/\[auto-resolved .* - the condition cleared\]$/);
    expect(db.byId(id).task_desc).toContain('Action: check the logs.');
    // Goes through taskService so the task log and the due-reminder cancel
    // both happen — a bare UPDATE would skip them.
    expect(taskService.completeTask).toHaveBeenCalledWith(
      db, id, 0, expect.objectContaining({ via: 'auto_resolve' })
    );
  });

  test('(7) nothing open is a no-op, not an error', async () => {
    const out = await alerts.resolveTask(db, { dedupeKey: 'webhook-down' });
    expect(out).toEqual({ ok: true, resolved: [], count: 0 });
    expect(taskService.completeTask).not.toHaveBeenCalled();
  });

  test('an already-closed task is left alone', async () => {
    await raise({ title: 'DOWN', desc: 'B', dedupeKey: 'webhook-down' });
    db.rows[0].task_status = 'Completed';

    const out = await alerts.resolveTask(db, { dedupeKey: 'webhook-down' });
    expect(out).toMatchObject({ ok: true, count: 0 });
    expect(taskService.completeTask).not.toHaveBeenCalled();
  });

  test('it does not touch tasks carrying a different key', async () => {
    await raise({ title: 'DOWN', desc: 'a', dedupeKey: 'webhook-down' });
    await raise({ title: 'CREDITS', desc: 'b', dedupeKey: 'credits-low' });

    await alerts.resolveTask(db, { dedupeKey: 'webhook-down' });

    expect(db.rows[0].task_status).toBe('Completed');
    expect(db.rows[1].task_status).toBe('Pending');
  });

  test('it does not touch un-keyed per-document tasks', async () => {
    await raise({ title: 'Signed doc received: Retainer', desc: 'a' });
    await alerts.resolveTask(db, { dedupeKey: 'webhook-down' });
    expect(db.rows[0].task_status).toBe('Pending');
  });

  // Only reachable if the stamp landed on more than one row — a lookup that
  // errored on the night the second was raised, say.
  test('it closes every open task carrying the key, oldest first', async () => {
    db = makeDb({ failLookup: true });
    await raise({ title: 'DOWN', desc: 'a', dedupeKey: 'webhook-down' });
    await raise({ title: 'DOWN', desc: 'b', dedupeKey: 'webhook-down' });
    db.query.mockClear();
    const ids = db.rows.map((r) => r.task_id);

    // The lookup only failed while duplicates were being made; resolve reads fine.
    const healthy = makeDb();
    healthy.rows.push(...db.rows);
    const out = await alerts.resolveTask(healthy, { dedupeKey: 'webhook-down' });

    expect(out.resolved).toEqual(ids);
    expect(healthy.rows.every((r) => r.task_status === 'Completed')).toBe(true);
  });

  test('a lookup failure is reported, never thrown', async () => {
    db = makeDb({ failLookup: true });
    await expect(alerts.resolveTask(db, { dedupeKey: 'webhook-down' }))
      .resolves.toMatchObject({ ok: false, reason: 'error', count: 0 });
  });

  test('a completeTask failure on one row does not abandon the rest', async () => {
    const healthy = makeDb();
    healthy.rows.push(
      { task_id: 1, task_source: 'esign', task_dedupe_key: 'k', task_status: 'Pending', task_desc: 'a', task_last_update: 0 },
      { task_id: 2, task_source: 'esign', task_dedupe_key: 'k', task_status: 'Pending', task_desc: 'b', task_last_update: 0 },
    );
    taskService.completeTask.mockImplementationOnce(async () => { throw new Error('race: already completed'); });

    const out = await alerts.resolveTask(healthy, { dedupeKey: 'k' });
    expect(out).toMatchObject({ ok: true, count: 1, resolved: [2] });
  });

  test('no key is a refusal, not a mass close', async () => {
    await raise({ title: 'DOWN', desc: 'a', dedupeKey: 'webhook-down' });
    for (const key of [undefined, null, '', '   ']) {
      const out = await alerts.resolveTask(db, { dedupeKey: key });
      expect(out).toMatchObject({ ok: false, reason: 'no_key' });
    }
    expect(await alerts.resolveTask(db)).toMatchObject({ ok: false, reason: 'no_key' });
    expect(db.rows[0].task_status).toBe('Pending');
    expect(taskService.completeTask).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a full outage cycle', () => {
  test('seven silent nights produce one task, and the delivery closes it', async () => {
    const o = {
      title: 'E-sign webhooks appear to be DOWN',
      desc: 'Statuses are still correct.\n\nAction: check the Cloud Run logs.',
      dedupeKey: 'webhook-down',
    };

    for (let night = 0; night < 7; night++) await raise(o);

    expect(db.rows).toHaveLength(1);                       // not seven
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    expect(db.rows[0].task_desc).toMatch(/seen 7x/);
    expect(db.rows[0].task_last_update).toBe(6);

    // Zoho gets through both gates again.
    await alerts.resolveTask(db, { dedupeKey: 'webhook-down' });
    expect(db.rows[0].task_status).toBe('Completed');

    // …and the NEXT outage is a fresh task, not a reopened old one.
    const out = await raise(o);
    expect(out).toMatchObject({ deduped: false });
    expect(db.rows).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the key registry', () => {
  // Callers pass literals because several of them run against a jest mock of
  // this module and would read undefined off DEDUPE_KEYS. This is the guard
  // against those literals drifting from the documented set.
  test('documents the keys the callers hard-code', () => {
    expect(alerts.DEDUPE_KEYS).toEqual({
      WEBHOOK_DOWN:       'webhook-down',
      CREDITS_LOW:        'credits-low',
      RECONCILE_PROVIDER: 'reconcile-provider',
      RECONCILE_FAILURES: 'reconcile-failures',
    });
  });

  // Every key must survive the column, or a truncated one would merge two
  // different conditions and suppress the second forever.
  test('every registered key fits the column', () => {
    for (const key of Object.values(alerts.DEDUPE_KEYS)) {
      expect(key.length).toBeLessThanOrEqual(alerts.MAX_DEDUPE_KEY);
    }
  });

  test('open statuses match taskService.listTasks Incomplete', () => {
    expect(alerts.OPEN_STATUSES).toEqual(['Pending', 'Due Today', 'Overdue']);
  });
});
