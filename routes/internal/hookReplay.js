// routes/internal/hookReplay.js
//
/**
 * POST /internal/hook-replay — run a hook event captured during maintenance.
 *
 * The Cloud Tasks push target for the hook spool (lib/hookSpool.js). While
 * MAINTENANCE_MODE=1 the receiver (routes/api.hooks.js) stores each
 * authenticated event as a task on a paused queue instead of executing it;
 * when the queue is resumed, each task lands here and goes through the normal
 * pipeline — same hookService.executeHook the live receiver calls.
 *
 * Body: { spool_id, slug, input }   (exactly what hookSpool.put() stored)
 *
 * AUTH — the INTERNAL api key only. jwtOrApiKey also admits staff JWTs and
 *   DB-issued API keys; neither may post here. The event skipped per-hook
 *   authentication on the way in (it was authenticated when captured), so
 *   this endpoint is "run any hook with any payload" and only the app itself
 *   holds that.
 *
 * NOT REACHABLE DURING MAINTENANCE — lib/maintenance's gate 503s it like every
 *   other route, so a queue resumed too early retries instead of executing
 *   against a frozen database.
 *
 * IDEMPOTENT — Cloud Tasks delivers at least once. executeHook inserts the
 *   hook_executions row (raw_input carries meta.spool_id) BEFORE it runs any
 *   target, so "a row with this spool_id exists" means "this event's pipeline
 *   has started". A redelivery is answered 200 without running again. That
 *   gives the same at-most-once pipeline semantics as the live receiver, which
 *   never re-runs an event either.
 *
 * RESPONSES — Cloud Tasks retries on ANY non-2xx and deletes the task on 2xx,
 * so a 2xx here means "this event is finished with", nothing less.
 *   200  executed, or already executed, or dropped because no hook can take it
 *        (retrying cannot fix a missing hook: the payload is written to the
 *        log and alerted instead)
 *   400  malformed body. Never produced by hookSpool.put(); a hand-made task
 *        would sit in the queue retrying until someone deletes it.
 *   401  unknown key (from jwtOrApiKey) / 403 a valid credential that is not
 *        the internal key. Retried — which is right for the one real cause, a
 *        key rotated between capture and replay: restore the key and the
 *        tasks go through.
 *   500  could not start the pipeline (e.g. a DB blip before the execution row
 *        was written) — safe to retry, nothing ran
 *   503  (from lib/maintenance's gate, not from here) queue resumed during
 *        the freeze — retried
 * The spool queue has unlimited attempts (lib/hookSpool.js), so none of the
 * retried cases can run a task out of attempts and lose it.
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../../lib/auth.jwtOrApiKey');
const hookService = require('../../services/hookService');
const hookSpool = require('../../lib/hookSpool');
const { alert } = require('../../lib/alerting');

// Same reserved slug the live receiver falls back to (routes/api.hooks.js).
const CATCHALL_SLUG = '_catchall';

function isInternalKey(auth) {
  return !!auth && auth.type === 'api_key' && auth.key_label === 'internal' && auth.key_id == null;
}

router.post(hookSpool.REPLAY_PATH, jwtOrApiKey, async (req, res) => {
  if (!isInternalKey(req.auth)) {
    return res.status(403).json({ status: 'error', message: 'internal key required' });
  }

  const body = req.body || {};
  const { slug, input } = body;
  const spoolId = body.spool_id;
  if (
    typeof slug !== 'string' || !slug ||
    !hookSpool.isSpoolId(spoolId) ||
    !input || typeof input !== 'object' || Array.isArray(input) ||
    !input.meta || input.meta.spool_id !== spoolId
  ) {
    return res.status(400).json({ status: 'error', message: 'malformed spool task' });
  }

  const db = req.db;

  try {
    // ── idempotency ────────────────────────────────────────────────────────
    // Bounded to recent rows: a spooled event is replayed within hours, and
    // Cloud Tasks keeps a task 31 days at most. No index serves this (it is a
    // scan with a JSON extract per recent row); measured 27 ms on production's
    // 31k-row table, 2026-10-12, and it runs once per replayed event, one at a
    // time. Revisit only if hook_executions grows by orders of magnitude.
    const [dupes] = await db.query(
      `SELECT id FROM hook_executions
        WHERE created_at > NOW() - INTERVAL 35 DAY
          AND JSON_UNQUOTE(JSON_EXTRACT(raw_input, '$.meta.spool_id')) = ?
        LIMIT 1`,
      [spoolId]
    );
    if (dupes && dupes.length) {
      return res.json({ status: 'already_replayed', spool_id: spoolId, execution_id: dupes[0].id });
    }

    // ── resolve the hook exactly as the live receiver does ─────────────────
    let hook = await hookService.getHookBySlug(db, slug);
    if (!hook) hook = await hookService.getHookBySlug(db, CATCHALL_SLUG);
    if (!hook) {
      // Hook deleted/deactivated between capture and replay and no catch-all.
      // Nothing can take the event, and answering 2xx makes Cloud Tasks delete
      // the task — so THIS LOG LINE IS THE LAST COPY OF THE PAYLOAD. It holds
      // exactly what hook_executions.raw_input would have held. (Cloud Logging
      // truncates an entry past 256 KB; the largest hook payload on record is
      // 24 KB.)
      let payload;
      try { payload = JSON.stringify({ spool_id: spoolId, slug, input }); }
      catch (_) { payload = '[unserializable]'; }
      console.error(`[hook-replay] DROPPED spooled event ${spoolId}: no active hook for slug "${slug}" and no catch-all. PAYLOAD ${payload}`);
      try {
        alert(db, {
          source: 'hook', kind: 'spool_replay_dropped', severity: 'error',
          group_key: `hook:spool_replay_dropped:${slug}`,
          title: `Spooled hook event dropped — no hook for "${slug}"`,
          message: `spool_id ${spoolId}, received ${input.meta.received_at || 'unknown'}. ` +
                   `Nothing ran. The full payload is in the Cloud Run log: search for "DROPPED spooled event ${spoolId}".`,
        });
      } catch (_) { /* alerting must never fail the replay */ }
      return res.json({ status: 'dropped_no_hook', spool_id: spoolId, slug });
    }

    const replayInput = {
      ...input,
      meta: { ...input.meta, replayed_at: new Date().toISOString() },
    };

    // splitPhase like the live receiver, but the slow phase is AWAITED: inside
    // a Cloud Tasks request the instance has CPU for as long as we hold the
    // response, and there is no sender waiting on us.
    const result = await hookService.executeHook(db, slug, replayInput, { hook, splitPhase: true });
    if (result && result.detached) {
      try { await result.detached; } catch (err) {
        // Target failures are recorded on the execution/delivery rows by the
        // pipeline itself. The event HAS run — do not ask for a retry.
        console.error(`[hook-replay] slow-phase error for ${slug} (${spoolId}):`, err);
      }
    }
    return res.json({
      status: 'replayed', spool_id: spoolId, slug,
      result: (result && result.status) || null,
      execution_id: (result && (result.executionId || result.execution_id)) || null,
    });
  } catch (err) {
    console.error(`[hook-replay] could not run spooled event ${spoolId} for ${slug}:`, err);
    return res.status(500).json({ status: 'error', message: 'replay failed', spool_id: spoolId });
  }
});

module.exports = router;
module.exports.isInternalKey = isInternalKey;
