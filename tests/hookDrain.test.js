/**
 * tests/hookDrain.test.js
 *
 * lib/hookDrain.js — the request-bound half of the ack-first webhook receiver
 * (async hook receiver S1, 2026-10-28).
 *
 * WHAT IS LOCKED SHUT
 *   1. THE CLAIM IS THE IDEMPOTENCY PRIMITIVE. One conditional UPDATE
 *      (status = 'received' AND claimed_at IS NULL); the pipeline runs only
 *      on affectedRows === 1. A double delivery, a claimed row, a final row
 *      and a never-queued id all come back already_claimed with nothing run.
 *   2. THE RUN HANDS THE ROW IN. executeHook gets { hook, executionId } —
 *      serial, no splitPhase — so it skips its own INSERT and the capture
 *      intercept and stamps the row the receiver wrote.
 *   3. BUSY IS A DELAY, NOT A LOSS. A failed result with busy:true (the body
 *      never ran) re-queues the row — status received, claimed_at NULL, the
 *      filter/transform columns cleared, attempts kept — while attempts <
 *      MAX_ATTEMPTS; on the last attempt it stays failed.
 *   4. A VANISHED HOOK FAILS THE ROW AND ALERTS; nothing runs.
 *   5. A PIPELINE THAT THROWS FAILS THE ROW with the error; the drain never
 *      throws out of _run (a claim that throws does propagate — the route
 *      turns it into a 500 and Cloud Tasks retries).
 *   6. drainBatch TAKES ONLY QUEUED ROWS PAST THE DOORBELL GRACE, oldest
 *      first, and skips a row a doorbell claimed meanwhile.
 *   7. sweepStale: a stale 'processing' claim is FAILED and never re-run
 *      (targets may have fired); a stale 'received' claim is re-queued while
 *      attempts < MAX, else abandoned; fresh claims are untouched. Both
 *      terminal outcomes raise their own ERROR alert naming the rows — the
 *      alert sweep's id watermark can already be past a row that fails late.
 *   8. NO TRANSACTIONS in the drain (it dispatches side effects).
 *   9. drainBatch has a WALL-CLOCK BUDGET: it stops claiming once the pass is
 *      over budget (checked before each claim, so a claimed row always runs)
 *      and reports what it deferred — a saturated lane must not hold the
 *      /process-jobs tick for minutes.
 *  10. BUSY on the last attempt raises a WARNING alert (the transient class;
 *      the sandbox's own saturation alert owns the escalation).
 *
 * In-memory hook_executions stub; hookService and alerting mocked at the
 * module boundary. The claim's SQL semantics are modelled on the real table
 * (scripts/hookAsyncReceiverS0.js proved the primitive on MySQL 8.4).
 *
 * Run: npx jest tests/hookDrain.test.js
 */
'use strict';

jest.mock('../services/hookService', () => ({
  getHookBySlug: jest.fn(),
  executeHook: jest.fn(),
}));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));

const hookService = require('../services/hookService');
const { alert } = require('../lib/alerting');
const drain = require('../lib/hookDrain');

const HOOK = { id: 23, slug: 'rc-call', capture_mode: 'off', targets: [] };
const CATCHALL = { id: 99, slug: '_catchall', capture_mode: 'off', targets: [] };
const MIN = 60 * 1000;

// ─────────────────────────────────────────────────────────────
// Stub pool with an in-memory hook_executions
// ─────────────────────────────────────────────────────────────
function makeDb(rows = []) {
  const calls = [];
  const table = new Map();
  for (const r of rows) {
    table.set(r.id, {
      status: 'received', claimed_at: null, completed_at: null, attempts: 0,
      filter_passed: null, transform_output: null, error: null,
      created_at: new Date(Date.now() - 60 * 1000),
      slug: 'rc-call', hook_id: 23, raw_input: JSON.stringify({ body: { uuid: `u${r.id}` }, headers: {}, query: {}, method: 'POST', meta: { slug: 'rc-call' } }),
      ...r,
    });
  }
  const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
  const db = {
    calls, table,
    async query(sql, params = []) {
      const s = norm(sql);
      calls.push({ sql: s, params });
      // the claim
      if (/^UPDATE hook_executions SET claimed_at = NOW\(3\), attempts = attempts \+ 1 WHERE id = \? AND status = 'received' AND claimed_at IS NULL$/.test(s)) {
        const row = table.get(params[0]);
        if (!row || row.status !== 'received' || row.claimed_at !== null) return [{ affectedRows: 0 }];
        row.claimed_at = new Date(); row.attempts += 1;
        return [{ affectedRows: 1 }];
      }
      if (/^SELECT id, hook_id, slug, raw_input, attempts FROM hook_executions WHERE id = \?$/.test(s)) {
        const row = table.get(params[0]);
        return [row ? [{ id: params[0], hook_id: row.hook_id, slug: row.slug, raw_input: row.raw_input, attempts: row.attempts }] : []];
      }
      // _fail
      if (/^UPDATE hook_executions SET status = 'failed', completed_at = NOW\(3\), error = \? WHERE id = \?$/.test(s)) {
        const row = table.get(params[1]);
        if (row) { row.status = 'failed'; row.completed_at = new Date(); row.error = params[0]; }
        return [{ affectedRows: row ? 1 : 0 }];
      }
      // _requeue
      if (/^UPDATE hook_executions SET status = 'received', claimed_at = NULL, completed_at = NULL, filter_passed = NULL, transform_output = NULL, error = \? WHERE id = \?$/.test(s)) {
        const row = table.get(params[1]);
        if (row) Object.assign(row, { status: 'received', claimed_at: null, completed_at: null, filter_passed: null, transform_output: null, error: params[0] });
        return [{ affectedRows: row ? 1 : 0 }];
      }
      // drainBatch SELECT
      if (/^SELECT id FROM hook_executions WHERE status = 'received' AND claimed_at IS NULL AND created_at < NOW\(\) - INTERVAL \? SECOND ORDER BY id LIMIT \?$/.test(s)) {
        const [grace, limit] = params;
        const cutoff = Date.now() - grace * 1000;
        const ids = [...table.entries()]
          .filter(([, r]) => r.status === 'received' && r.claimed_at === null && r.created_at.getTime() < cutoff)
          .map(([id]) => id).sort((a, b) => a - b).slice(0, limit);
        return [ids.map((id) => ({ id }))];
      }
      // sweepStale — the doomed-rows read, then three UPDATEs
      if (/^SELECT id, slug, status FROM hook_executions WHERE status IN \('processing', 'received'\) AND claimed_at IS NOT NULL AND completed_at IS NULL AND claimed_at < NOW\(3\) - INTERVAL \? MINUTE AND \(status = 'processing' OR attempts >= \?\) ORDER BY id LIMIT 50$/.test(s)) {
        const cutoff = Date.now() - params[0] * MIN;
        return [[...table.entries()]
          .filter(([, r]) => ['processing', 'received'].includes(r.status) && r.claimed_at && !r.completed_at && r.claimed_at.getTime() < cutoff && (r.status === 'processing' || r.attempts >= params[1]))
          .sort((a, b) => a[0] - b[0]).map(([id, r]) => ({ id, slug: r.slug, status: r.status }))];
      }
      if (/^UPDATE hook_executions SET status = 'failed', completed_at = NOW\(3\), error = CONCAT_WS\('; ', error, 'instance died mid-delivery/.test(s)) {
        const cutoff = Date.now() - params[0] * MIN; let n = 0;
        for (const r of table.values()) if (r.status === 'processing' && r.claimed_at && !r.completed_at && r.claimed_at.getTime() < cutoff) { r.status = 'failed'; r.completed_at = new Date(); r.error = [r.error, 'instance died mid-delivery'].filter(Boolean).join('; '); n++; }
        return [{ affectedRows: n }];
      }
      if (/^UPDATE hook_executions SET status = 'failed', completed_at = NOW\(3\), error = CONCAT_WS\('; ', error, 'abandoned/.test(s)) {
        const cutoff = Date.now() - params[0] * MIN; let n = 0;
        for (const r of table.values()) if (r.status === 'received' && r.claimed_at && !r.completed_at && r.claimed_at.getTime() < cutoff && r.attempts >= params[1]) { r.status = 'failed'; r.completed_at = new Date(); r.error = [r.error, 'abandoned'].filter(Boolean).join('; '); n++; }
        return [{ affectedRows: n }];
      }
      if (/^UPDATE hook_executions SET claimed_at = NULL WHERE status = 'received' AND claimed_at IS NOT NULL AND completed_at IS NULL AND claimed_at < NOW\(3\) - INTERVAL \? MINUTE AND attempts < \?$/.test(s)) {
        const cutoff = Date.now() - params[0] * MIN; let n = 0;
        for (const r of table.values()) if (r.status === 'received' && r.claimed_at && !r.completed_at && r.claimed_at.getTime() < cutoff && r.attempts < params[1]) { r.claimed_at = null; n++; }
        return [{ affectedRows: n }];
      }
      throw new Error(`unexpected SQL in stub: ${s}`);
    },
  };
  return db;
}

// executeHook stand-in that stamps the row the way the real one does.
function pipeline(outcome) {
  return jest.fn(async (db, slug, input, opts) => {
    const row = db.table.get(opts.executionId);
    if (outcome.status === 'failed' && outcome.busy) {
      Object.assign(row, { status: 'failed', filter_passed: null, completed_at: new Date(), error: outcome.error });
    } else if (outcome.status === 'delivered') {
      Object.assign(row, { status: 'delivered', filter_passed: 1, completed_at: new Date() });
    }
    return { executionId: opts.executionId, ...outcome };
  });
}

beforeEach(() => {
  hookService.getHookBySlug.mockReset().mockImplementation(async (db, slug) => (slug === 'rc-call' ? HOOK : null));
  hookService.executeHook.mockReset();
  alert.mockClear();
});

describe('drainOne — claim, run, hand the row in', () => {
  test('claims the queued row and runs executeHook with { hook, executionId }, serial', async () => {
    const db = makeDb([{ id: 10 }]);
    hookService.executeHook.mockImplementation(pipeline({ status: 'delivered' }));
    const out = await drain.drainOne(db, 10);
    expect(out).toEqual({ processed: 1, results: [{ id: 10, status: 'delivered' }] });
    expect(hookService.executeHook).toHaveBeenCalledTimes(1);
    const [, slug, input, opts] = hookService.executeHook.mock.calls[0];
    expect(slug).toBe('rc-call');
    expect(input.body).toEqual({ uuid: 'u10' });
    expect(opts).toEqual({ hook: HOOK, executionId: 10 });
    expect(opts.splitPhase).toBeUndefined();
    const row = db.table.get(10);
    expect(row.attempts).toBe(1);
    expect(row.claimed_at).toBeInstanceOf(Date);
    expect(row.status).toBe('delivered');
  });

  test('double delivery: the second drainOne claims nothing and runs nothing', async () => {
    const db = makeDb([{ id: 10 }]);
    hookService.executeHook.mockImplementation(pipeline({ status: 'delivered' }));
    const [a, b] = await Promise.all([drain.drainOne(db, 10), drain.drainOne(db, 10)]);
    const outcomes = [a, b].map((o) => o.results[0].status).sort();
    expect(outcomes).toEqual(['already_claimed', 'delivered']);
    expect(hookService.executeHook).toHaveBeenCalledTimes(1);
    expect(db.table.get(10).attempts).toBe(1);
  });

  test('a final row, a claimed row and an unknown id are already_claimed, nothing runs', async () => {
    const db = makeDb([{ id: 1, status: 'delivered' }, { id: 2, claimed_at: new Date() }]);
    for (const id of [1, 2, 777]) {
      expect(await drain.drainOne(db, id)).toEqual({ processed: 0, results: [{ id, status: 'already_claimed' }] });
    }
    expect(hookService.executeHook).not.toHaveBeenCalled();
  });

  test('BUSY before any target → re-queued (received, unclaimed, columns cleared, attempts kept) and claimable again', async () => {
    const db = makeDb([{ id: 10 }]);
    const BUSY = 'Transform code error [GUEST_CODE_BUSY]: code sandbox busy: no hooks slot within 10000ms — failed closed, the body did not run';
    hookService.executeHook.mockImplementation(pipeline({ status: 'failed', busy: true, error: BUSY }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await drain.drainOne(db, 10);
      expect(out).toEqual({ processed: 1, results: [{ id: 10, status: 'requeued', attempts: 1 }] });
    } finally { warn.mockRestore(); }
    const row = db.table.get(10);
    expect(row).toMatchObject({ status: 'received', claimed_at: null, completed_at: null, filter_passed: null, transform_output: null, attempts: 1 });
    expect(row.error).toBe(`${BUSY} — re-queued for the next drain (attempt 1 of 3)`);
    expect(row.error).toContain('[GUEST_CODE_BUSY]');   // the alert sweep's warning tag survives
    expect(row.error).not.toContain('; ');               // …in one part
    expect(alert).not.toHaveBeenCalled();                // a re-queue is not an incident

    // The next drain claims it again (attempt 2) and, with the lane free, delivers.
    hookService.executeHook.mockImplementation(pipeline({ status: 'delivered' }));
    const again = await drain.drainOne(db, 10);
    expect(again.results[0].status).toBe('delivered');
    expect(db.table.get(10).attempts).toBe(2);
  });

  test('BUSY on the last attempt stays failed', async () => {
    const db = makeDb([{ id: 10, attempts: 2 }]);
    hookService.executeHook.mockImplementation(pipeline({ status: 'failed', busy: true, error: 'Filter code error [GUEST_CODE_BUSY]: busy' }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await drain.drainOne(db, 10);
      expect(out.results[0]).toEqual({ id: 10, status: 'failed' });
    } finally { warn.mockRestore(); }
    expect(db.table.get(10)).toMatchObject({ status: 'failed', attempts: 3 });
    expect(db.table.get(10).claimed_at).toBeInstanceOf(Date);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1]).toMatchObject({ source: 'hook', kind: 'drain_busy_exhausted', severity: 'warning', group_key: 'hook:drain_busy_exhausted:rc-call' });
    expect(alert.mock.calls[0][1].message).toMatch(/hook_executions 10 got no sandbox slot on 3 attempts/);
  });

  test('a non-BUSY failure is final — no re-queue', async () => {
    const db = makeDb([{ id: 10 }]);
    hookService.executeHook.mockImplementation(async (db, slug, input, opts) => {
      Object.assign(db.table.get(opts.executionId), { status: 'failed', completed_at: new Date(), error: 'Transform code error: boom' });
      return { status: 'failed', error: 'Transform code error: boom', executionId: opts.executionId };
    });
    const out = await drain.drainOne(db, 10);
    expect(out.results[0]).toEqual({ id: 10, status: 'failed' });
    expect(db.table.get(10).status).toBe('failed');
  });

  test('the hook is gone (and no catch-all): failed with the reason, alerted, nothing runs', async () => {
    hookService.getHookBySlug.mockResolvedValue(null);
    const db = makeDb([{ id: 10 }]);
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = await drain.drainOne(db, 10);
      expect(out.results[0]).toEqual({ id: 10, status: 'failed', error: 'no hook' });
    } finally { err.mockRestore(); }
    expect(hookService.executeHook).not.toHaveBeenCalled();
    expect(db.table.get(10)).toMatchObject({ status: 'failed' });
    expect(db.table.get(10).error).toMatch(/^no active hook for slug "rc-call" and no catch-all/);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1]).toMatchObject({ source: 'hook', kind: 'drain_no_hook', severity: 'error', group_key: 'hook:drain_no_hook:rc-call' });
    // the catch-all was tried
    expect(hookService.getHookBySlug.mock.calls.map((c) => c[1])).toEqual(['rc-call', '_catchall']);
  });

  test('the hook is gone but the catch-all exists: it runs under the catch-all', async () => {
    hookService.getHookBySlug.mockImplementation(async (db, slug) => (slug === '_catchall' ? CATCHALL : null));
    const db = makeDb([{ id: 10 }]);
    hookService.executeHook.mockImplementation(pipeline({ status: 'delivered' }));
    await drain.drainOne(db, 10);
    expect(hookService.executeHook.mock.calls[0][3]).toEqual({ hook: CATCHALL, executionId: 10 });
    expect(hookService.executeHook.mock.calls[0][1]).toBe('rc-call'); // the attempted slug is kept on the row
  });

  test('a pipeline that throws fails the row with the error; the drain does not throw', async () => {
    const db = makeDb([{ id: 10 }]);
    hookService.executeHook.mockRejectedValue(new Error('ECONNRESET'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = await drain.drainOne(db, 10);
      expect(out.results[0]).toEqual({ id: 10, status: 'failed', error: 'ECONNRESET' });
    } finally { err.mockRestore(); }
    expect(db.table.get(10)).toMatchObject({ status: 'failed', error: 'pipeline error: ECONNRESET' });
  });

  test('bad raw_input fails the row without running anything', async () => {
    const db = makeDb([{ id: 10, raw_input: '{not json' }, { id: 11, raw_input: '[1,2]' }]);
    const r1 = await drain.drainOne(db, 10);
    const r2 = await drain.drainOne(db, 11);
    expect(r1.results[0]).toEqual({ id: 10, status: 'failed', error: 'bad raw_input' });
    expect(r2.results[0]).toEqual({ id: 11, status: 'failed', error: 'bad raw_input' });
    expect(hookService.executeHook).not.toHaveBeenCalled();
  });

  test('a claim that throws propagates (the route answers 500, Cloud Tasks retries) — nothing ran', async () => {
    const db = makeDb([{ id: 10 }]);
    db.query = async () => { throw new Error('ER_LOCK_WAIT_TIMEOUT'); };
    await expect(drain.drainOne(db, 10)).rejects.toThrow('ER_LOCK_WAIT_TIMEOUT');
    expect(hookService.executeHook).not.toHaveBeenCalled();
  });
});

describe('drainBatch — the cron fallback', () => {
  test('takes queued rows past the grace, oldest first, skips a row a doorbell took meanwhile, leaves fresh and final rows', async () => {
    const old = new Date(Date.now() - 5 * MIN);
    const db = makeDb([
      { id: 3, created_at: old },
      { id: 1, created_at: old },
      { id: 2, created_at: old, claimed_at: new Date() },          // a doorbell has it
      { id: 4, created_at: new Date() },                            // fresh: its doorbell is still in flight
      { id: 5, created_at: old, status: 'delivered' },              // final
    ]);
    hookService.executeHook.mockImplementation(pipeline({ status: 'delivered' }));
    const out = await drain.drainBatch(db);
    expect(out.processed).toBe(2);
    expect(out.results.map((r) => r.id)).toEqual([1, 3]);
    expect(hookService.executeHook).toHaveBeenCalledTimes(2);
    expect(db.table.get(4).status).toBe('received');
    expect(db.table.get(4).claimed_at).toBeNull();
    // the SELECT asked for exactly the grace and the batch size
    const sel = db.calls.find((c) => /^SELECT id FROM hook_executions/.test(c.sql));
    expect(sel.params).toEqual([drain.DOORBELL_GRACE_SECONDS, drain.CRON_BATCH]);
  });

  test('wall-clock budget: stops claiming once over budget, reports the deferred rows, never leaves a claimed row unrun', async () => {
    const old = new Date(Date.now() - 5 * MIN);
    const db = makeDb([1, 2, 3, 4].map((id) => ({ id, created_at: old })));
    hookService.executeHook.mockImplementation(async (db, slug, input, opts) => {
      await new Promise((r) => setTimeout(r, 40));
      Object.assign(db.table.get(opts.executionId), { status: 'delivered', completed_at: new Date() });
      return { status: 'delivered', executionId: opts.executionId };
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let out;
    try { out = await drain.drainBatch(db, { budgetMs: 30 }); } finally { warn.mockRestore(); }
    expect(out.processed).toBe(1);
    expect(out.deferred).toBe(3);
    expect(out.results.map((r) => r.id)).toEqual([1]);
    // the deferred rows are untouched — still queued for the next tick
    for (const id of [2, 3, 4]) expect(db.table.get(id)).toMatchObject({ status: 'received', claimed_at: null, attempts: 0 });
    // the default budget is generous enough for a healthy pass and short enough for a tick
    expect(drain.CRON_BUDGET_MS).toBe(20000);
  });

  test('a row claimed between the SELECT and the claim is skipped, not an error', async () => {
    const old = new Date(Date.now() - 5 * MIN);
    const db = makeDb([{ id: 1, created_at: old }]);
    const realQuery = db.query.bind(db);
    db.query = async (sql, params) => {
      const out = await realQuery(sql, params);
      if (/^SELECT id FROM hook_executions/.test(String(sql).replace(/\s+/g, ' '))) db.table.get(1).claimed_at = new Date(); // doorbell wins
      return out;
    };
    const out = await drain.drainBatch(db);
    expect(out).toEqual({ processed: 0, results: [], deferred: 0 });
    expect(hookService.executeHook).not.toHaveBeenCalled();
  });
});

describe('sweepStale — claims whose instance died', () => {
  test('stale processing → failed, never re-run; stale received → re-queued while attempts < MAX, else abandoned; fresh claims untouched', async () => {
    const stale = new Date(Date.now() - (drain.STALE_CLAIM_MINUTES + 1) * MIN);
    const fresh = new Date(Date.now() - 2 * MIN);
    const db = makeDb([
      { id: 1, status: 'processing', claimed_at: stale, attempts: 1, error: 'wf 20: timeout' },
      { id: 2, status: 'received', claimed_at: stale, attempts: 1 },
      { id: 3, status: 'received', claimed_at: stale, attempts: drain.MAX_ATTEMPTS },
      { id: 4, status: 'received', claimed_at: fresh, attempts: 1 },
      { id: 5, status: 'processing', claimed_at: fresh, attempts: 1 },
      { id: 6, status: 'delivered', claimed_at: stale, completed_at: stale, attempts: 1 },
    ]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let out;
    try { out = await drain.sweepStale(db); } finally { warn.mockRestore(); }
    expect(out).toEqual({ diedMidDelivery: 1, abandoned: 1, recovered: 1 });
    // each terminal outcome alerted ONCE, as an error, naming its rows
    expect(alert).toHaveBeenCalledTimes(2);
    const kinds = Object.fromEntries(alert.mock.calls.map((c) => [c[1].kind, c[1]]));
    expect(kinds.drain_died_mid_delivery).toMatchObject({ source: 'hook', severity: 'error', group_key: 'hook:drain_died_mid_delivery' });
    expect(kinds.drain_died_mid_delivery.message).toMatch(/1 \(rc-call\)/);
    expect(kinds.drain_died_mid_delivery.message).not.toMatch(/\b3 \(rc-call\)/);
    expect(kinds.drain_abandoned).toMatchObject({ source: 'hook', severity: 'error', group_key: 'hook:drain_abandoned' });
    expect(kinds.drain_abandoned.message).toMatch(/\b3 \(rc-call\)/);
    expect(db.table.get(1)).toMatchObject({ status: 'failed', error: 'wf 20: timeout; instance died mid-delivery' });
    expect(db.table.get(2)).toMatchObject({ status: 'received', claimed_at: null, attempts: 1 });
    expect(db.table.get(3)).toMatchObject({ status: 'failed' });
    expect(db.table.get(4)).toMatchObject({ status: 'received', claimed_at: fresh });
    expect(db.table.get(5)).toMatchObject({ status: 'processing', claimed_at: fresh });
    expect(db.table.get(6)).toMatchObject({ status: 'delivered' });
    // order: mid-delivery first, abandon, then revive — a revived row is never one that was just abandoned
    const order = db.calls.map((c) => (/^SELECT id, slug, status/.test(c.sql) ? 'read' : /died mid-delivery/.test(c.sql) ? 'mid' : /abandoned/.test(c.sql) ? 'dead' : /SET claimed_at = NULL/.test(c.sql) ? 'revive' : 'other'));
    expect(order).toEqual(['read', 'mid', 'dead', 'revive']);
    expect(hookService.executeHook).not.toHaveBeenCalled();
  });

  test('nothing stale: no alert, nothing touched', async () => {
    const db = makeDb([{ id: 4, status: 'received', claimed_at: new Date(), attempts: 1 }]);
    expect(await drain.sweepStale(db)).toEqual({ diedMidDelivery: 0, abandoned: 0, recovered: 0 });
    expect(alert).not.toHaveBeenCalled();
  });

  test('a sweep that throws is non-fatal', async () => {
    const db = { query: async () => { throw new Error('boom'); } };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(drain.sweepStale(db)).resolves.toEqual({ diedMidDelivery: 0, abandoned: 0, recovered: 0 });
    } finally { warn.mockRestore(); }
  });
});

describe('no transactions in the drain', () => {
  test('neither drainOne nor drainBatch nor sweepStale opens a transaction', async () => {
    const db = makeDb([{ id: 10, created_at: new Date(Date.now() - 5 * MIN) }]);
    hookService.executeHook.mockImplementation(pipeline({ status: 'delivered' }));
    await drain.drainBatch(db);
    await drain.sweepStale(db);
    expect(db.calls.some((c) => /START TRANSACTION|BEGIN|COMMIT|ROLLBACK/i.test(c.sql))).toBe(false);
    expect(db.withTransaction).toBeUndefined();
    const src = require('fs').readFileSync(require.resolve('../lib/hookDrain'), 'utf8');
    // call forms only — the header names withTransaction to say why it is absent
    expect(src).not.toMatch(/withTransaction\s*\(|beginTransaction\s*\(/);
  });
});
