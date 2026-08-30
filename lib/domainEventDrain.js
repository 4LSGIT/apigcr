// lib/domainEventDrain.js
//
/**
 * Domain event drain — the REQUEST-BOUND half of split-phase dispatch.
 *
 * lib/domainEvents.emit() persists an envelope to domain_event_queue and
 * rings a Cloud Tasks doorbell. This module is what actually evaluates the
 * trigger tree, and it runs inside a request (POST /process-domain-event/:id,
 * or the batch pass inside the 60s /process-jobs cron) so Cloud Run has CPU
 * allocated for the whole thing. See lib/domainEvents.js for why.
 *
 * ── NO TRANSACTIONS HERE, DELIBERATELY ────────────────────────────────────
 * The claim is a single conditional UPDATE, which is already atomic — a
 * transaction would buy nothing. More importantly, processEvent DISPATCHES
 * ACTIONS: SMS, email, webhooks, workflow starts. Two standing invariants
 * both forbid wrapping that:
 *
 *   - withTransaction retries are only safe when the span contains no non-DB
 *     side effects. A retry here would re-send.
 *   - withTransaction checks a connection OUT of the pool and holds it for
 *     the whole callback. A checked-out connection is invisible to mysql2's
 *     idle sweeper (it only inspects the free list) and to startup/db.js's
 *     transient-retry wrapper, so a long drain would resume onto a socket
 *     SiteGround closed at 60s and die on the completion write. That is the
 *     exact bug that took out documents_refresh_case_cache six times on
 *     2026-08-27, and the reason executeJob was hoisted out of its
 *     withTransaction in routes/process_jobs.js.
 *
 * Same reason bookUnderLock keeps its own dedicated connection. Do not
 * "tidy" any of this into a transaction.
 *
 * ── IDEMPOTENCY ───────────────────────────────────────────────────────────
 * Cloud Tasks is at-least-once. The claim is
 *     UPDATE ... SET status='running' WHERE id=? AND status='pending'
 * and work proceeds only on affectedRows === 1, so a double delivery makes
 * the loser a no-op. affectedRows is trustworthy HERE specifically because
 * this is a plain conditional UPDATE — the known mysql2 trap is that
 * CLIENT_FOUND_ROWS makes affectedRows useless for detecting duplicates on
 * an UPSERT. There is no INSERT ... ON DUPLICATE KEY in this file.
 *
 * ── DISPATCH BUDGET ACROSS THE SPLIT ──────────────────────────────────────
 * triggerService enforces MAX_DISPATCHES_PER_ROOT (50) against a `counters`
 * object that emit() used to share BY REFERENCE down a whole in-process
 * trigger tree. That object cannot survive serialisation.
 *
 * Reconstructing it fresh per drained event would silently turn a per-ROOT
 * budget into a per-NODE one: with MAX_DEPTH 4 the worst case goes from 50
 * dispatches to 50^4 ≈ 6.25M. That is not an acceptable circuit breaker.
 *
 * So the accumulator is persisted instead. Each drain:
 *   1. resolves rootId = row.root_id || row.id
 *   2. seeds counters.dispatches from the ROOT row's `dispatches` column
 *   3. runs processEvent
 *   4. flushes the delta with an atomic `dispatches = dispatches + ?`
 *
 * Residual slack, stated honestly: two SIBLING events draining concurrently
 * both seed from the same pre-flush value, so the budget can overshoot by up
 * to (concurrent siblings x 50) rather than capping exactly at 50. It is a
 * circuit breaker, not an accountant — it still trips, still within one
 * level of fan-out, and the alternative (a lock or a per-dispatch write)
 * costs more than the precision is worth.
 */

'use strict';

const domainEvents = require('./domainEvents');

/**
 * How long a 'running' row may sit without completing before the sweep
 * assumes the instance died and returns it to 'pending'.
 *
 * Deliberately EQUAL to routes/process_jobs.js's RECOVERY_WINDOW_MIN. Same
 * question, same failure mode (Cloud Run reaped the instance mid-work), and
 * two different windows would only ever be a thing to get wrong later.
 * Worst realistic legitimate drain is far shorter than a workflow_resume's
 * ~2-3 min, so 15 min is a wide margin.
 */
const STALE_CLAIM_MINUTES = 15;

/**
 * Attempts cap for the stale sweep. Note attempts is bumped at CLAIM time,
 * so a row that kills its instance has already spent the attempt and cannot
 * loop forever — which is the whole point. On the cap the row goes to
 * 'error' and stays there for a human; re-dispatching actions that may have
 * already half-run is the bounded-retry design and is deliberately not done.
 */
const MAX_ATTEMPTS = 3;

/**
 * Rows drained per cron pass. The cron is the FALLBACK path (doorbell
 * failed, Cloud Tasks disabled, backlog); it is not the hot path, so this
 * only needs to outrun the emission rate, not the doorbell. 25/tick = 1,500
 * an hour, comfortably above live volume (order 10^2/day). Bounded so a
 * backlog drains over several ticks instead of one request trying to do all
 * of it and hitting Cloud Run's timeout — same shape as the job batch's
 * LIMIT 10.
 */
const CRON_BATCH = 25;

/**
 * Claim one pending row. Returns the row, or null if it was not claimable
 * (already running/done, or the cron got there first). Not-claimable is a
 * NORMAL outcome, not an error.
 */
async function _claim(db, id) {
  const [r] = await db.query(
    `UPDATE domain_event_queue
        SET status = 'running', claimed_at = NOW(), attempts = attempts + 1
      WHERE id = ? AND status = 'pending'`,
    [id]
  );
  if (r.affectedRows !== 1) return null;

  const [[row]] = await db.query(
    `SELECT id, event_type, root_id, envelope, attempts
       FROM domain_event_queue WHERE id = ?`,
    [id]
  );
  return row || null;
}

/**
 * Evaluate one claimed row: reconstruct the scope, run the trigger tree,
 * flush the budget, close the row. Never throws — a failure marks the row
 * 'error' and alerts, mirroring emit()'s old catch.
 */
async function _run(db, row) {
  const rootId = row.root_id || row.id;

  let envelope;
  try {
    // mysql2 returns JSON columns already parsed, but a stubbed pool (tests)
    // or a future driver change may hand back a string. Both are cheap to
    // accept; neither is worth a crash.
    envelope = typeof row.envelope === 'string' ? JSON.parse(row.envelope) : row.envelope;
  } catch (err) {
    await _fail(db, row, `envelope not parseable JSON: ${err.message}`);
    return { id: row.id, status: 'error', error: 'bad envelope' };
  }
  if (!envelope || typeof envelope !== 'object') {
    await _fail(db, row, 'envelope missing or not an object');
    return { id: row.id, status: 'error', error: 'bad envelope' };
  }

  // Seed the dispatch budget from the root row. A read failure must not stop
  // the event — seeding 0 is the permissive direction, and being permissive
  // about a circuit breaker beats dropping real automation.
  let seed = 0;
  try {
    const [[r]] = await db.query(
      `SELECT dispatches FROM domain_event_queue WHERE id = ?`, [rootId]
    );
    seed = r ? Number(r.dispatches) || 0 : 0;
  } catch (err) {
    console.warn(`[domainEventDrain] budget seed read failed for root ${rootId} (starting at 0): ${err.message}`);
  }

  const counters = { dispatches: seed, budgetAlerted: false, rootId };

  let outcome;
  try {
    const triggerService = require('../services/triggerService');
    outcome = await domainEvents.runInEventScope(envelope, counters, () =>
      triggerService.processEvent(db, envelope)
    );
  } catch (err) {
    await _flushBudget(db, rootId, counters.dispatches - seed);
    await _fail(db, row, err.message);
    console.error(`[domainEventDrain] processing failed for ${row.event_type} (queue ${row.id}):`, err.message);
    try {
      const { alert } = require('./alerting');
      alert(db, {
        source: 'app', kind: 'trigger_engine_error', severity: 'warning',
        group_key: 'trigger_engine',
        title:   `Trigger engine failed on ${row.event_type}`,
        message: err.message,
        context: { event: row.event_type, depth: envelope.depth, queue_id: row.id, phase: 'drain' },
      }).catch(() => {});
    } catch (_) { /* alerting unavailable — already console.error'd */ }
    return { id: row.id, status: 'error', error: err.message };
  }

  await _flushBudget(db, rootId, counters.dispatches - seed);

  await db.query(
    `UPDATE domain_event_queue SET status = 'done', completed_at = NOW() WHERE id = ?`,
    [row.id]
  ).catch((err) => {
    // The tree ALREADY RAN. Losing the completion write leaves the row
    // 'running' for the stale sweep, which will re-drain it — duplicate
    // dispatches. Same trade routes/process_jobs.js documents for
    // workflow_resume: re-run beats silent loss. Loud, so it is findable.
    console.error(`[domainEventDrain] completion write failed for queue ${row.id} (will be re-drained by the stale sweep): ${err.message}`);
  });

  return { id: row.id, status: 'done', event: row.event_type, outcome: outcome?.status ?? null };
}

/** Atomic budget flush onto the ROOT row. Never throws. */
async function _flushBudget(db, rootId, delta) {
  if (!(delta > 0)) return;
  await db.query(
    `UPDATE domain_event_queue SET dispatches = dispatches + ? WHERE id = ?`,
    [delta, rootId]
  ).catch((err) => {
    console.warn(`[domainEventDrain] budget flush failed for root ${rootId} (+${delta}): ${err.message}`);
  });
}

/** Mark a row failed. Never throws. */
async function _fail(db, row, message) {
  await db.query(
    `UPDATE domain_event_queue
        SET status = 'error', completed_at = NOW(), error_message = ?
      WHERE id = ?`,
    [String(message ?? '').slice(0, 2000), row.id]
  ).catch((err) => {
    console.error(`[domainEventDrain] error-mark write failed for queue ${row.id}: ${err.message}`);
  });
}

/**
 * Drain exactly one row by id — the Cloud Tasks push target.
 *
 * A non-claimable id returns { processed: 0, results: [{ id, status:
 * 'already_claimed' }] } and the route answers 200, because Cloud Tasks
 * retries on any non-2xx and losing the race to the cron is normal. Same
 * contract as runJobPass's targeted mode.
 */
async function drainOne(db, id) {
  const row = await _claim(db, id);
  if (!row) return { processed: 0, results: [{ id, status: 'already_claimed' }] };
  const result = await _run(db, row);
  return { processed: 1, results: [result] };
}

/**
 * Drain up to CRON_BATCH pending rows — the 60s cron fallback.
 *
 * Rows are claimed and run ONE AT A TIME rather than fanned out. Concurrency
 * here would multiply side-effect dispatches against the same downstream
 * services from a path that only exists because something already went
 * wrong; the batch is bounded, so serial is fast enough.
 */
async function drainBatch(db, { limit = CRON_BATCH } = {}) {
  const [rows] = await db.query(
    `SELECT id FROM domain_event_queue
      WHERE status = 'pending'
      ORDER BY id
      LIMIT ?`,
    [limit]
  );
  const results = [];
  for (const { id } of rows) {
    const claimed = await _claim(db, id);
    if (!claimed) continue; // a doorbell beat us to it — normal
    results.push(await _run(db, claimed));
  }
  return { processed: results.length, results };
}

/**
 * Return rows stuck in 'running' past the window to 'pending' so they get
 * re-drained, or to 'error' once out of attempts.
 *
 * Batch-path housekeeping only, same as recoverStuckJobs — running it per
 * task would multiply DB load by the task rate for no benefit. Never throws:
 * a failed sweep costs at most one minute of recovery delay.
 */
async function sweepStale(db) {
  try {
    const [dead] = await db.query(
      `UPDATE domain_event_queue
          SET status = 'error', completed_at = NOW(),
              error_message = 'abandoned: exceeded max attempts after stale claims'
        WHERE status = 'running'
          AND claimed_at < NOW() - INTERVAL ? MINUTE
          AND attempts >= ?`,
      [STALE_CLAIM_MINUTES, MAX_ATTEMPTS]
    );
    if (dead.affectedRows > 0) {
      console.warn(`[domainEventDrain] ${dead.affectedRows} queue row(s) abandoned after ${MAX_ATTEMPTS} attempts`);
    }

    const [revived] = await db.query(
      `UPDATE domain_event_queue
          SET status = 'pending'
        WHERE status = 'running'
          AND claimed_at < NOW() - INTERVAL ? MINUTE
          AND attempts < ?`,
      [STALE_CLAIM_MINUTES, MAX_ATTEMPTS]
    );
    if (revived.affectedRows > 0) {
      console.warn(`[domainEventDrain] recovered ${revived.affectedRows} stale running queue row(s) (>${STALE_CLAIM_MINUTES}min)`);
    }
    return { abandoned: dead.affectedRows, recovered: revived.affectedRows };
  } catch (err) {
    console.warn(`[domainEventDrain] stale sweep failed (non-fatal): ${err.message}`);
    return { abandoned: 0, recovered: 0 };
  }
}

module.exports = {
  drainOne, drainBatch, sweepStale,
  STALE_CLAIM_MINUTES, MAX_ATTEMPTS, CRON_BATCH,
};
