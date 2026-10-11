// routes/mailboxIngest.js
//
/**
 * Mailbox ingest job endpoint — mailbox-system arc, slice S1
 *
 *   ALL /mailbox-ingest    one lock-guarded IMAP poll pass
 *                          (services/mailbox/mailboxIngestService.runIngest)
 *
 * Shaped like /process-jobs (routes/process_jobs.js) on purpose — design D4 +
 * §6: a cron-fired entry, ticked every 5 min by Cloud Scheduler with an
 * x-api-key, auth by jwtOrApiKey, router.all (GET or POST). A signed-in
 * staff JWT may also run it (apiSend('/mailbox-ingest','POST') from a
 * console) — it is idempotent and lock-guarded, so a manual run is a no-op
 * when there is nothing new.
 *
 * Response: 200 with the run summary on every path the worker handles —
 * including {skipped:true} when another run holds the lock (overlap is
 * normal; the scheduler must not see it as a failure) and runs where
 * individual mailboxes failed (those are recorded in ingest_state and
 * alerted after a streak). 500 only when the run could not start at all
 * (no DB connection / lock query failed).
 *
 * STAFF-TRIGGERED RUNS (S3 follow-up, 2026-10-12): the comms hub's Refresh
 * button POSTs here so new mail need not wait for the tick. Staff JWT runs
 * are throttled to STAFF_RUN_MAX per STAFF_RUN_WINDOW_MS for all staff
 * together (per instance, lib/rateLimiter) — each run logs into every
 * mailbox's IMAP server — and a throttled call is a 200 {skipped:true,
 * throttled:true}. The scheduler's x-api-key tick is never throttled. A staff
 * caller who is not an SU gets the run's COUNTS only (STAFF_SUMMARY_KEYS):
 * `details` names every mailbox's folders and its last error, readable by
 * that person or not.
 *
 * The work happens INSIDE the request on purpose: Cloud Run allocates CPU to
 * in-flight requests only. The run's budget (MAILBOX_INGEST_BUDGET_MS,
 * default 240 s) sits well inside the service's 900 s request timeout and the
 * scheduler job's attempt deadline.
 *
 * YC3 (tenancy invariant 6): like /process-jobs, this entry will need explicit
 * tenant identity — it rides P0-8, not a special case here.
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { makeLimiter } = require('../lib/rateLimiter');
const { runIngest } = require('../services/mailbox/mailboxIngestService');
const { isSuperuser } = require('../services/mailboxService');

const STAFF_RUN_WINDOW_MS = 30_000;
const STAFF_RUN_MAX = 1;
const STAFF_SUMMARY_KEYS = Object.freeze([
  'skipped', 'reason', 'lockLost', 'mailboxes', 'folders', 'fetched', 'stored', 'backfilled',
  'emitted', 'duplicates', 'errors', 'durationMs',
]);
let staffRunLimited = makeLimiter(STAFF_RUN_WINDOW_MS, STAFF_RUN_MAX);

router.all('/mailbox-ingest', jwtOrApiKey, async function runMailboxIngest(req, res) {
  const staff = !!(req.auth && req.auth.type === 'jwt');
  if (staff && staffRunLimited('staff')) {
    return res.json({ skipped: true, throttled: true, reason: 'a staff-triggered check ran moments ago' });
  }
  try {
    const out = await runIngest(req.db);
    if (staff && !(await isSuperuser(req.db, req.auth.userId))) {
      const counts = {};
      for (const k of STAFF_SUMMARY_KEYS) if (k in (out || {})) counts[k] = out[k];
      return res.json(counts);
    }
    res.json(out);
  } catch (err) {
    // code + message only: a mysql2 error object carries the formatted SQL.
    console.error('[mailbox-ingest] run failed:', err && err.code ? err.code : '', err && err.message);
    res.status(500).json({
      error: 'Mailbox ingest run failed',
      code: (err && (err.code || err.errno)) || null,
      detail: String((err && err.message) || '').slice(0, 300),
    });
  }
});

// Test hook (the api.mail.js _resetSendRateLimit precedent).
router._resetStaffThrottle = () => { staffRunLimited = makeLimiter(STAFF_RUN_WINDOW_MS, STAFF_RUN_MAX); };

module.exports = router;
