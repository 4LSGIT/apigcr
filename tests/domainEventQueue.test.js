/**
 * tests/domainEventQueue.test.js
 *
 * Split-phase domain event dispatch (2026-08-30) — lib/domainEvents.emit()
 * writes to domain_event_queue and rings a doorbell; lib/domainEventDrain.js
 * evaluates the tree from a request-bound handler.
 *
 * WHAT IS LOCKED SHUT
 *   1. emit() PERSISTS BEFORE IT RINGS. The row is the scheduling authority;
 *      the Cloud Task is a doorbell. Ordering matters — a doorbell that
 *      fires against a row that does not exist yet burns itself as
 *      already-claimed and the event silently waits for the cron.
 *   2. emit() NEVER THROWS AND NEVER REJECTS, still. 26 of 27 call sites
 *      ignore the returned promise; a rejection there is an
 *      unhandledRejection in production. Holds for a failed INSERT and for a
 *      failed doorbell alike.
 *   3. A DEAD DOORBELL IS NOT A LOST EVENT. enqueueDomainEventDispatch
 *      returning false (Cloud Tasks off/misconfigured/down) must still leave
 *      a drainable pending row — that is the entire fallback contract.
 *   4. THE DRAIN IS IDEMPOTENT UNDER DOUBLE DELIVERY. Cloud Tasks is
 *      at-least-once. The second delivery must claim nothing and dispatch
 *      nothing.
 *   5. THE DISPATCH BUDGET SURVIVES SERIALISATION. Counters are seeded from
 *      the ROOT row and flushed back as a delta, so a budget already spent
 *      by earlier nodes of the same tree is still spent. Reconstructing
 *      fresh per drain would turn a per-root budget into a per-node one
 *      (50 → 50^4 at MAX_DEPTH 4).
 *   6. THE STALE SWEEP RECOVERS, THEN GIVES UP. A row whose instance died
 *      returns to pending; past MAX_ATTEMPTS it goes to error rather than
 *      looping a poison envelope forever.
 *   7. NO TRANSACTIONS ANYWHERE IN THE DRAIN. The drain dispatches SMS /
 *      email / webhooks, and withTransaction both retries its callback and
 *      holds a pooled connection checked out for its duration.
 *
 * Stub pools throughout (the tests/triggerService.test.js pattern) — no
 * database.
 *
 * Run: npx jest tests/domainEventQueue.test.js
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY || 'x'.repeat(64);

jest.mock('../lib/taskQueue', () => ({
  enqueueDomainEventDispatch: jest.fn(async () => true),
  enqueueJobDispatch: jest.fn(async () => true),
  ACCEL_WINDOW_MS: 90000,
  DISPATCH_BUFFER_MS: 750,
}));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));

const taskQueue    = require('../lib/taskQueue');
const { alert }    = require('../lib/alerting');
const domainEvents = require('../lib/domainEvents');
const drain        = require('../lib/domainEventDrain');

// ─────────────────────────────────────────────────────────────
// Stub pool with an in-memory domain_event_queue
// ─────────────────────────────────────────────────────────────

function makeDb({ rules = {}, failInsert = false } = {}) {
  const calls = [];
  const queue = new Map();
  let nextQueueId = 1;
  let nextExecId  = 900;

  const db = {
    calls,
    queue,
    async query(sql, params) {
      calls.push({ sql, params });

      if (/INSERT INTO domain_event_queue/.test(sql)) {
        if (failInsert) throw new Error('ER_LOCK_WAIT_TIMEOUT: simulated');
        const id = nextQueueId++;
        queue.set(id, {
          id, event_type: params[0], root_id: params[1], envelope: params[2],
          status: 'pending', attempts: 0, dispatches: 0, claimed_at: null,
        });
        return [{ insertId: id, affectedRows: 1 }];
      }
      if (/UPDATE domain_event_queue/.test(sql) && /status = 'running'/.test(sql)) {
        const row = queue.get(params[0]);
        if (!row || row.status !== 'pending') return [{ affectedRows: 0 }];
        row.status = 'running';
        row.attempts++;
        row.claimed_at = new Date();
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE domain_event_queue/.test(sql) && /dispatches = dispatches \+/.test(sql)) {
        const row = queue.get(params[1]);
        if (row) row.dispatches += params[0];
        return [{ affectedRows: row ? 1 : 0 }];
      }
      if (/UPDATE domain_event_queue/.test(sql) && /status = 'error'/.test(sql)) {
        const row = queue.get(params[params.length - 1]);
        if (row) { row.status = 'error'; row.error_message = params[0]; }
        return [{ affectedRows: row ? 1 : 0 }];
      }
      if (/UPDATE domain_event_queue/.test(sql) && /status = 'done'/.test(sql)) {
        const row = queue.get(params[0]);
        if (row) row.status = 'done';
        return [{ affectedRows: row ? 1 : 0 }];
      }
      if (/SELECT dispatches FROM domain_event_queue/.test(sql)) {
        const row = queue.get(params[0]);
        return [row ? [{ dispatches: row.dispatches }] : []];
      }
      if (/SELECT id FROM domain_event_queue/.test(sql)) {
        return [[...queue.values()].filter(r => r.status === 'pending').map(r => ({ id: r.id }))];
      }
      if (/FROM domain_event_queue/.test(sql)) {
        const row = queue.get(params[0]);
        return [row ? [{ ...row }] : []];
      }

      if (/FROM trigger_rules/.test(sql))        return [(rules[params[0]] || []).map(r => ({ ...r }))];
      if (/FROM trigger_rule_actions/.test(sql)) {
        const out = [];
        for (const ev of Object.keys(rules)) {
          for (const r of rules[ev]) if (params.includes(r.id)) out.push(...(r._actions || []));
        }
        return [out];
      }
      if (/INSERT INTO trigger_execution/.test(sql)) return [{ insertId: nextExecId++, affectedRows: 1 }];
      if (/UPDATE trigger_executions/.test(sql))     return [{ affectedRows: 1 }];
      if (/UPDATE trigger_rules/.test(sql))          return [{ affectedRows: 1 }];

      throw new Error('stub: unscripted SQL: ' + String(sql).replace(/\s+/g, ' ').slice(0, 80));
    },
  };
  return db;
}

const queueInserts = (db) => db.calls.filter(c => /INSERT INTO domain_event_queue/.test(c.sql));
const ruleLoads    = (db) => db.calls.filter(c => /FROM trigger_rules/.test(c.sql));

beforeEach(() => {
  taskQueue.enqueueDomainEventDispatch.mockClear();
  taskQueue.enqueueDomainEventDispatch.mockImplementation(async () => true);
  alert.mockClear();
});

// ─────────────────────────────────────────────────────────────
// 1 + 2 — emit() persists, then rings; and never rejects
// ─────────────────────────────────────────────────────────────

describe('emit() — queue write', () => {

  test('writes exactly one row carrying the envelope, and evaluates nothing', async () => {
    const db = makeDb();
    await domainEvents.emit(db, 'appt.created', {
      contact_id: 7, case_id: 'AbCd1234', source: 'system',
    });

    expect(queueInserts(db)).toHaveLength(1);
    expect(ruleLoads(db)).toHaveLength(0);   // the whole point of the slice

    const [event_type, root_id, envelopeJson] = queueInserts(db)[0].params;
    expect(event_type).toBe('appt.created');
    expect(root_id).toBeNull();              // root emission
    const env = JSON.parse(envelopeJson);
    expect(env).toMatchObject({
      event: 'appt.created', depth: 0, chain: [], contact_id: 7, case_id: 'AbCd1234',
    });
  });

  test('persists BEFORE ringing the doorbell (row is the authority, task is a hint)', async () => {
    const db = makeDb();
    let insertedWhenRung = null;
    taskQueue.enqueueDomainEventDispatch.mockImplementation(async () => {
      insertedWhenRung = db.queue.size;
      return true;
    });

    await domainEvents.emit(db, 'appt.created', { contact_id: 1 });

    expect(insertedWhenRung).toBe(1);
    expect(taskQueue.enqueueDomainEventDispatch).toHaveBeenCalledWith(1);
  });

  test('INSERT failure → resolves undefined, alerts, never rejects', async () => {
    const db = makeDb({ failInsert: true });
    await expect(domainEvents.emit(db, 'appt.created', { contact_id: 1 }))
      .resolves.toBeUndefined();
    expect(alert.mock.calls.filter(c => c[1].kind === 'trigger_engine_error')).toHaveLength(1);
  });

  test('doorbell failure → still resolves, and the row is still drainable (cron fallback)', async () => {
    const db = makeDb();
    taskQueue.enqueueDomainEventDispatch.mockImplementation(async () => {
      throw new Error('Cloud Tasks unavailable');
    });

    await expect(domainEvents.emit(db, 'appt.created', { contact_id: 1 }))
      .resolves.toBeUndefined();

    // Lock 3: a dead doorbell must not be a lost event.
    expect([...db.queue.values()][0].status).toBe('pending');
    const out = await drain.drainBatch(db);
    expect(out.processed).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 4 — idempotency under at-least-once delivery
// ─────────────────────────────────────────────────────────────

describe('drainOne() — idempotency', () => {

  test('double delivery: the second claim wins nothing and dispatches nothing', async () => {
    const db = makeDb();
    await domainEvents.emit(db, 'appt.created', { contact_id: 1 });

    const first  = await drain.drainOne(db, 1);
    const second = await drain.drainOne(db, 1);

    expect(first.processed).toBe(1);
    expect(first.results[0].status).toBe('done');

    expect(second.processed).toBe(0);
    expect(second.results[0]).toEqual({ id: 1, status: 'already_claimed' });

    // The engine ran exactly once across both deliveries.
    expect(ruleLoads(db)).toHaveLength(1);
    expect([...db.queue.values()][0].attempts).toBe(1);
  });

  test('concurrent delivery: exactly one of two parallel drains claims the row', async () => {
    const db = makeDb();
    await domainEvents.emit(db, 'appt.created', { contact_id: 1 });

    const [a, b] = await Promise.all([drain.drainOne(db, 1), drain.drainOne(db, 1)]);
    expect([a.processed, b.processed].sort()).toEqual([0, 1]);
    expect(ruleLoads(db)).toHaveLength(1);
  });

  test('unknown id → already_claimed, not an error (Cloud Tasks must see 2xx)', async () => {
    const db = makeDb();
    const out = await drain.drainOne(db, 4242);
    expect(out).toEqual({ processed: 0, results: [{ id: 4242, status: 'already_claimed' }] });
  });
});

// ─────────────────────────────────────────────────────────────
// 5 — the dispatch budget survives serialisation
// ─────────────────────────────────────────────────────────────

describe('dispatch budget across the split', () => {

  test('counters seed from the ROOT row, so budget spent by earlier nodes stays spent', async () => {
    const db = makeDb();
    await domainEvents.emit(db, 'appt.created', { contact_id: 1 });

    // Simulate a tree that has already burned 48 of its 50 dispatches on
    // earlier nodes, drained in other requests.
    db.queue.get(1).dispatches = 48;

    let seen = null;
    const envelope = JSON.parse(db.queue.get(1).envelope);
    await domainEvents.runInEventScope(envelope, { dispatches: 0, budgetAlerted: false, rootId: 1 }, async () => {
      seen = domainEvents.currentCounters();
    });
    expect(seen.rootId).toBe(1);

    await drain.drainOne(db, 1);

    // Seeded, not reset: still 48 after a drain that dispatched nothing.
    expect(db.queue.get(1).dispatches).toBe(48);
  });

  test('runInEventScope restores depth and chain from the persisted envelope', async () => {
    const envelope = { event: 'appt.created', depth: 3, chain: [7, 9] };
    let inner = null;
    await domainEvents.runInEventScope(envelope, { dispatches: 0, budgetAlerted: false, rootId: 5 }, async () => {
      inner = domainEvents.buildEnvelope('appt.attended', {});
    });
    // Depth-capping and chain audit are unaffected by the process boundary.
    expect(inner.depth).toBe(3);
    expect(inner.chain).toEqual([7, 9]);
    // ...and the scope is gone once the drain returns.
    expect(domainEvents.buildEnvelope('x', {}).depth).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 6 — stale claim recovery
// ─────────────────────────────────────────────────────────────

describe('sweepStale()', () => {

  function sweepDb(rows) {
    const calls = [];
    return {
      calls,
      async query(sql, params) {
        calls.push({ sql: String(sql).replace(/\s+/g, ' '), params });
        const isAbandon = /status = 'error'/.test(sql);
        const match = rows.filter(r =>
          r.status === 'running' && (isAbandon ? r.attempts >= 3 : r.attempts < 3));
        for (const r of match) r.status = isAbandon ? 'error' : 'pending';
        return [{ affectedRows: match.length }];
      },
    };
  }

  test('recovers rows under the attempt cap and abandons rows over it', async () => {
    const rows = [
      { id: 1, status: 'running', attempts: 1 },   // recoverable
      { id: 2, status: 'running', attempts: 3 },   // out of attempts
    ];
    const db = sweepDb(rows);
    const out = await drain.sweepStale(db);

    expect(out).toEqual({ abandoned: 1, recovered: 1 });
    expect(rows.find(r => r.id === 1).status).toBe('pending');
    expect(rows.find(r => r.id === 2).status).toBe('error');

    // Window matches process_jobs' RECOVERY_WINDOW_MIN, and the cap is applied.
    for (const c of db.calls) {
      expect(c.sql).toContain("status = 'running'");
      expect(c.params[0]).toBe(drain.STALE_CLAIM_MINUTES);
      expect(c.params[1]).toBe(drain.MAX_ATTEMPTS);
    }
  });

  test('never throws — a failed sweep must not kill the poll cycle', async () => {
    const db = { async query() { throw new Error('db down'); } };
    await expect(drain.sweepStale(db)).resolves.toEqual({ abandoned: 0, recovered: 0 });
  });
});

// ─────────────────────────────────────────────────────────────
// 7 — no transactions on the drain path
// ─────────────────────────────────────────────────────────────

test('the drain never opens a transaction (side effects + checked-out connections)', async () => {
  const db = makeDb();
  // withTransaction is deliberately absent from the stub: if the drain ever
  // reached for it, this would throw rather than quietly work in prod and
  // fail at 60s on a SiteGround-closed socket.
  expect(db.withTransaction).toBeUndefined();

  await domainEvents.emit(db, 'appt.created', { contact_id: 1 });
  await expect(drain.drainOne(db, 1)).resolves.toMatchObject({ processed: 1 });
});

// ─────────────────────────────────────────────────────────────
// Failure isolation
// ─────────────────────────────────────────────────────────────

test('a row whose envelope is corrupt goes to error, alone, without throwing', async () => {
  const db = makeDb();
  await domainEvents.emit(db, 'appt.created', { contact_id: 1 });
  db.queue.get(1).envelope = '{ not json';

  const out = await drain.drainOne(db, 1);
  expect(out.results[0].status).toBe('error');
  expect(db.queue.get(1).status).toBe('error');
});
