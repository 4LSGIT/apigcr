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
const { runIngest } = require('../services/mailbox/mailboxIngestService');

router.all('/mailbox-ingest', jwtOrApiKey, async (req, res) => {
  try {
    const out = await runIngest(req.db);
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

module.exports = router;
