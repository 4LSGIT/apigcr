// lib/hookDrain.js
//
/**
 * Hook drain — the REQUEST-BOUND half of the ack-first webhook receiver
 * (async hook receiver S1, 2026-10-28).
 *
 * POST /hooks/:slug (routes/api.hooks.js) writes the event to hook_executions
 * (status 'received', claimed_at NULL), rings a Cloud Tasks doorbell
 * (lib/taskQueue.enqueueHookExecutionDispatch → POST /process-hook-execution/:id)
 * and answers the sender at once. THIS module is what runs the hook's filter,
 * transform and targets — from that route, or from the 60 s /process-jobs
 * cron when the doorbell never rang — so Cloud Run has CPU for the whole
 * pipeline and the sender never waits on a code body or a saturated sandbox.
 *
 * WHY. RingCentral requires the 200 within 3000 ms and blacklists a
 * subscription that fails that for ~10 minutes (silently; recovery = delete +
 * recreate). Before this, one slow hook body (up to 15 s) or a busy hooks lane
 * made every RC answer late for as long as it persisted. Measured 30 days
 * before the change: p99 0.65 s, max 1.46 s, 0 of 5,054 RC answers over 2 s —
 * the risk was a tail event, not the median. Research and numbers:
 * local/RESEARCH_async_hook_receiver_FINDINGS.md.
 *
 * THE ROW IS THE SCHEDULING AUTHORITY; THE TASK IS A DOORBELL. Same invariant
 * as domain_event_queue (lib/domainEventDrain.js) and scheduled_jobs
 * (lib/taskQueue.js). A doorbell that never lands costs one cron tick of
 * latency, never the event.
 *
 * ── IDEMPOTENCY ───────────────────────────────────────────────────────────
 * Cloud Tasks is at-least-once. The claim is ONE conditional UPDATE
 *     UPDATE hook_executions SET claimed_at = NOW(3), attempts = attempts + 1
 *      WHERE id = ? AND status = 'received' AND claimed_at IS NULL
 * and work proceeds only on affectedRows === 1: a double delivery, or a
 * doorbell racing the cron, makes the loser a no-op (proven on the live table
 * by scripts/hookAsyncReceiverS0.js's smoke). affectedRows is trustworthy here
 * because this is a plain conditional UPDATE, not an UPSERT (the mysql2
 * CLIENT_FOUND_ROWS trap does not apply).
 *
 * Synchronous runs — dry run, /live-test, /internal/hook-replay, the
 * kill-switch path — INSERT their row with claimed_at already set
 * (hookService.recordExecution claimed:true), so the drain can never pick up
 * a row that another caller is running.
 *
 * ── BUSY IS RETRIED HERE, NOT BY THE SENDER ────────────────────────────────
 * A code filter or hook transform that got no sandbox slot (GUEST_CODE_BUSY —
 * the body never ran, nothing was dispatched) used to fail the execution for
 * good (and, for Quo, earn the sender a 503 so it would redeliver). The row is
 * now re-queued — status back to 'received', claimed_at NULL, attempts kept —
 * and the cron fallback runs it again a tick later, up to MAX_ATTEMPTS. No
 * sender is asked to retry, RingCentral included, and no event is duplicated.
 *
 * ── STALE CLAIMS (the instance died mid-run) ──────────────────────────────
 * sweepStale, from the cron's housekeeping block:
 *   claimed, still 'received' after STALE_CLAIM_MINUTES, attempts < MAX →
 *     re-queued: the filter never finished, so nothing was dispatched;
 *   the same with attempts >= MAX → 'failed' (abandoned);
 *   claimed, 'processing' after STALE_CLAIM_MINUTES → 'failed', NEVER re-run:
 *     the transform was written and targets may have fired — a re-run would
 *     duplicate them. Both terminal outcomes raise their own ERROR alert
 *     naming the rows (the alert sweep's id watermark may already be past a
 *     row that fails this late); recovery is a replay by hand (Logs → Test
 *     tab → Live Test).
 *
 * ── NO TRANSACTIONS HERE, DELIBERATELY ─────────────────────────────────────
 * The claim is one atomic UPDATE; executeHook dispatches workflows, sequences,
 * HTTP targets and internal functions — withTransaction's retries would
 * re-dispatch, and a long-held pooled connection outlives the server's idle
 * sweep (the documents_refresh_case_cache incident, 2026-08-27; see
 * lib/domainEventDrain.js).
 */

'use strict';

/** Window after which a claimed, unfinished row is assumed to have died with its instance. */
const STALE_CLAIM_MINUTES = 15;
/** Claims per row, bumped AT claim time, so a run that kills its instance has spent one. */
const MAX_ATTEMPTS = 3;
/** Rows per cron pass. The fallback path; it only has to outrun ~170 events/day. */
const CRON_BATCH = 25;
/**
 * How long the cron leaves a fresh row to its doorbell before taking it. The
 * doorbell lands in ~1–3 s when it works (DISPATCH_BUFFER_MS + delivery); a
 * row older than this with no claim had its doorbell fail or never ring.
 */
const DOORBELL_GRACE_SECONDS = 20;
/**
 * Wall-clock budget for one cron pass of drainBatch. The pass runs INSIDE the
 * /process-jobs request, before the job claim; under a saturated lane every
 * row can wait the lane's full budget (10 s) before it is re-queued, so
 * without a cap 25 rows would hold the tick for minutes and starve the jobs
 * behind it. Rows left over wait for the next tick — the fallback only has to
 * outrun ~170 events/day.
 */
const CRON_BUDGET_MS = 20_000;
/** Same reserved slug the receiver and the maintenance replay fall back to. */
const CATCHALL_SLUG = '_catchall';

/** Raise an alert; never throws, never blocks (alerting is best-effort here). */
function _alert(db, payload) {
  try {
    const { alert } = require('./alerting');
    Promise.resolve(alert(db, payload)).catch(() => {});
  } catch (_) { /* alerting unavailable — the console line is the record */ }
}

/**
 * Claim one queued row. Returns the row, or null when it was not claimable
 * (already claimed, already final, or never queued) — a NORMAL outcome.
 */
async function _claim(db, id) {
  const [r] = await db.query(
    `UPDATE hook_executions
        SET claimed_at = NOW(3), attempts = attempts + 1
      WHERE id = ? AND status = 'received' AND claimed_at IS NULL`,
    [id]
  );
  if (r.affectedRows !== 1) return null;
  const [[row]] = await db.query(
    `SELECT id, hook_id, slug, raw_input, attempts FROM hook_executions WHERE id = ?`,
    [id]
  );
  return row || null;
}

/** Final failure of a claimed row. Never throws. */
async function _fail(db, id, message) {
  await db.query(
    `UPDATE hook_executions SET status = 'failed', completed_at = NOW(3), error = ? WHERE id = ?`,
    [String(message ?? '').slice(0, 2000), id]
  ).catch((err) => {
    console.error(`[hookDrain] failure write failed for execution ${id}: ${err.message}`);
  });
}

/**
 * Put a BUSY row back in the queue for the next cron tick. Nothing ran, so the
 * filter/transform columns are cleared; the error keeps the BUSY tag (the
 * alert sweep reads it) and says what happened.
 */
async function _requeue(db, row, error) {
  await db.query(
    `UPDATE hook_executions
        SET status = 'received', claimed_at = NULL, completed_at = NULL,
            filter_passed = NULL, transform_output = NULL, error = ?
      WHERE id = ?`,
    [`${String(error ?? '').slice(0, 1800)} — re-queued for the next drain (attempt ${row.attempts} of ${MAX_ATTEMPTS})`, row.id]
  );
}

/**
 * Run one claimed row through the normal pipeline. Never throws — a failure
 * fails the row (recorded on it) and is logged.
 */
async function _run(db, row) {
  let input;
  try {
    input = typeof row.raw_input === 'string' ? JSON.parse(row.raw_input) : row.raw_input;
  } catch (err) {
    await _fail(db, row.id, `raw_input not parseable JSON: ${err.message}`);
    return { id: row.id, status: 'failed', error: 'bad raw_input' };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    await _fail(db, row.id, 'raw_input missing or not an object');
    return { id: row.id, status: 'failed', error: 'bad raw_input' };
  }

  // Deferred require: hookService pulls in the dispatchers and engines;
  // loading it at module scope from a lib/ file risks the half-built-exports
  // trap (CLAUDE.md, lazy require convention).
  const hookService = require('../services/hookService');

  // Resolve the hook exactly as the receiver did (catch-all included). The
  // receiver authenticated the sender at receipt against the hook row it
  // found, so a row here has already passed auth.
  let hook = await hookService.getHookBySlug(db, row.slug);
  if (!hook) hook = await hookService.getHookBySlug(db, CATCHALL_SLUG);
  if (!hook) {
    const msg = `no active hook for slug "${row.slug}" and no catch-all at drain time — nothing ran; replay by hand once the hook exists`;
    await _fail(db, row.id, msg);
    console.error(`[hookDrain] execution ${row.id}: ${msg}`);
    _alert(db, {
      source: 'hook', kind: 'drain_no_hook', severity: 'error',
      group_key: `hook:drain_no_hook:${row.slug}`,
      title: `Queued hook event has no hook — "${row.slug}"`,
      message: `hook_executions ${row.id} was received for "${row.slug}" but the hook is gone or inactive. Nothing ran. The payload is the row's raw_input.`,
    });
    return { id: row.id, status: 'failed', error: 'no hook' };
  }

  let result;
  try {
    // Serial (not split-phase): everything runs inside THIS request, at full
    // CPU, with nobody waiting on the answer. executeHook writes every status
    // and completed_at itself; `executionId` tells it the row exists.
    result = await hookService.executeHook(db, row.slug, input, { hook, executionId: row.id });
  } catch (err) {
    await _fail(db, row.id, `pipeline error: ${err.message}`);
    console.error(`[hookDrain] execution ${row.id} (${row.slug}) threw:`, err);
    return { id: row.id, status: 'failed', error: err.message };
  }

  // BUSY-only failure before any target: nothing ran, so run it again later.
  if (result && result.status === 'failed' && result.busy === true) {
    if (Number(row.attempts) < MAX_ATTEMPTS) {
      await _requeue(db, row, result.error);
      console.warn(`[hookDrain] execution ${row.id} (${row.slug}): code sandbox busy — re-queued (attempt ${row.attempts} of ${MAX_ATTEMPTS})`);
      return { id: row.id, status: 'requeued', attempts: Number(row.attempts) };
    }
    console.warn(`[hookDrain] execution ${row.id} (${row.slug}): code sandbox busy on the last attempt — failed`);
    // The alert sweep (lib/alerting _scanHooks) walks failed rows by id; a row
    // that fails this LATE (minutes after rows with higher ids) can sit below
    // its watermark, so say it here. Warning: BUSY is the transient class and
    // guest_code_saturated:hooks owns the escalation.
    _alert(db, {
      source: 'hook', kind: 'drain_busy_exhausted', severity: 'warning',
      group_key: `hook:drain_busy_exhausted:${row.slug}`,
      title: `Hook "${row.slug}": code sandbox busy on every attempt`,
      message: `hook_executions ${row.id} got no sandbox slot on ${MAX_ATTEMPTS} attempts and is failed; nothing was delivered. Replay it from the Logs tab once the sandbox is quiet. ${result.error || ''}`.trim(),
    });
  }

  return { id: row.id, status: (result && result.status) || null };
}

/**
 * Drain exactly one row by id — the Cloud Tasks push target.
 *
 * A non-claimable id returns { processed: 0, results: [{ id, status:
 * 'already_claimed' }] } and the route answers 200, because Cloud Tasks
 * retries on any non-2xx and losing the race to the cron is normal. A claim
 * that THROWS (a DB blip) propagates: the route answers 500 and the task
 * retries, which is right — nothing ran.
 */
async function drainOne(db, id) {
  const row = await _claim(db, id);
  if (!row) return { processed: 0, results: [{ id, status: 'already_claimed' }] };
  const result = await _run(db, row);
  return { processed: 1, results: [result] };
}

/**
 * Drain queued rows the doorbell did not reach — the 60 s cron fallback.
 * Oldest first, one at a time (a bounded batch from a path that only exists
 * because something already went wrong; concurrency would multiply dispatches).
 */
async function drainBatch(db, { limit = CRON_BATCH, graceSeconds = DOORBELL_GRACE_SECONDS, budgetMs = CRON_BUDGET_MS } = {}) {
  const [rows] = await db.query(
    `SELECT id FROM hook_executions
      WHERE status = 'received' AND claimed_at IS NULL
        AND created_at < NOW() - INTERVAL ? SECOND
      ORDER BY id
      LIMIT ?`,
    [graceSeconds, limit]
  );
  const started = Date.now();
  const results = [];
  let deferred = 0;
  for (const { id } of rows) {
    // Budget is checked BEFORE each claim, so a row is never claimed and then
    // left unrun — the leftovers simply stay queued for the next tick.
    if (Date.now() - started >= budgetMs) { deferred = rows.length - results.length; break; }
    const claimed = await _claim(db, id);
    if (!claimed) continue; // a doorbell beat us to it — normal
    results.push(await _run(db, claimed));
  }
  if (deferred > 0) console.warn(`[hookDrain] cron pass hit its ${budgetMs} ms budget; ${deferred} queued row(s) wait for the next tick`);
  return { processed: results.length, results, deferred };
}

/**
 * Housekeeping for claims whose instance died. Batch path only (per-task
 * sweeps would multiply DB load for nothing). Never throws.
 */
async function sweepStale(db) {
  try {
    // Who is about to be failed — read BEFORE the UPDATEs so the alerts can
    // name the rows. The alert sweep (lib/alerting _scanHooks) walks failed
    // rows by id and may already be past these ids (they fail 15 min late),
    // so the sweep raises its own alerts (error: non-transient, needs a hand).
    const [doomed] = await db.query(
      `SELECT id, slug, status FROM hook_executions
        WHERE status IN ('processing', 'received') AND claimed_at IS NOT NULL AND completed_at IS NULL
          AND claimed_at < NOW(3) - INTERVAL ? MINUTE
          AND (status = 'processing' OR attempts >= ?)
        ORDER BY id LIMIT 50`,
      [STALE_CLAIM_MINUTES, MAX_ATTEMPTS]
    );
    // 'processing' = transform written, targets possibly fired: NEVER re-run.
    const [mid] = await db.query(
      `UPDATE hook_executions
          SET status = 'failed', completed_at = NOW(3),
              error = CONCAT_WS('; ', error, 'instance died mid-delivery (claimed, still processing after ${STALE_CLAIM_MINUTES} min) — targets may have fired; replay by hand only after checking the delivery logs')
        WHERE status = 'processing' AND claimed_at IS NOT NULL AND completed_at IS NULL
          AND claimed_at < NOW(3) - INTERVAL ? MINUTE`,
      [STALE_CLAIM_MINUTES]
    );
    if (mid.affectedRows > 0) {
      const ids = doomed.filter((r) => r.status === 'processing').map((r) => `${r.id} (${r.slug})`);
      console.warn(`[hookDrain] ${mid.affectedRows} execution(s) failed: died mid-delivery, not re-run — ${ids.join(', ')}`);
      _alert(db, {
        source: 'hook', kind: 'drain_died_mid_delivery', severity: 'error',
        group_key: 'hook:drain_died_mid_delivery',
        title: `${mid.affectedRows} hook execution(s) died mid-delivery`,
        message: `Claimed over ${STALE_CLAIM_MINUTES} min ago and still processing — the instance died after the transform was written; targets may have fired. NOT re-run. ` +
          `Check each row's delivery logs before replaying by hand: ${ids.join(', ')}`,
      });
    }
    const [dead] = await db.query(
      `UPDATE hook_executions
          SET status = 'failed', completed_at = NOW(3),
              error = CONCAT_WS('; ', error, 'abandoned: ${MAX_ATTEMPTS} stale claims (the instance died before the filter finished each time)')
        WHERE status = 'received' AND claimed_at IS NOT NULL AND completed_at IS NULL
          AND claimed_at < NOW(3) - INTERVAL ? MINUTE
          AND attempts >= ?`,
      [STALE_CLAIM_MINUTES, MAX_ATTEMPTS]
    );
    if (dead.affectedRows > 0) {
      const ids = doomed.filter((r) => r.status === 'received').map((r) => `${r.id} (${r.slug})`);
      console.warn(`[hookDrain] ${dead.affectedRows} execution(s) abandoned after ${MAX_ATTEMPTS} stale claims — ${ids.join(', ')}`);
      _alert(db, {
        source: 'hook', kind: 'drain_abandoned', severity: 'error',
        group_key: 'hook:drain_abandoned',
        title: `${dead.affectedRows} hook execution(s) abandoned`,
        message: `${MAX_ATTEMPTS} claims each died before the filter finished (instance lost each time). Nothing was delivered. Replay from the Logs tab: ${ids.join(', ')}`,
      });
    }
    const [revived] = await db.query(
      `UPDATE hook_executions
          SET claimed_at = NULL
        WHERE status = 'received' AND claimed_at IS NOT NULL AND completed_at IS NULL
          AND claimed_at < NOW(3) - INTERVAL ? MINUTE
          AND attempts < ?`,
      [STALE_CLAIM_MINUTES, MAX_ATTEMPTS]
    );
    if (revived.affectedRows > 0) {
      console.warn(`[hookDrain] re-queued ${revived.affectedRows} stale claimed execution(s) (>${STALE_CLAIM_MINUTES} min, filter never finished)`);
    }
    return { diedMidDelivery: mid.affectedRows, abandoned: dead.affectedRows, recovered: revived.affectedRows };
  } catch (err) {
    console.warn(`[hookDrain] stale sweep failed (non-fatal): ${err.message}`);
    return { diedMidDelivery: 0, abandoned: 0, recovered: 0 };
  }
}

module.exports = {
  drainOne, drainBatch, sweepStale,
  STALE_CLAIM_MINUTES, MAX_ATTEMPTS, CRON_BATCH, CRON_BUDGET_MS, DOORBELL_GRACE_SECONDS,
};
