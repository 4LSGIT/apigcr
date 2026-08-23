// lib/taskQueue.js
//
/**
 * Cloud Tasks accelerator — push dispatch for near-immediate scheduled jobs.
 *
 * WHY THIS EXISTS (P1, 2026-08)
 *   The background-CPU slice (2026-08-20) moved workflow starts from a
 *   detached advanceWorkflow to a queued scheduled_jobs row so the advance
 *   runs request-bound at full CPU. Correct — but /process-jobs is driven by
 *   a 60s Cloud Scheduler tick, so every hook-started workflow then waited a
 *   uniform 0–60s (measured live: mean ~35s, 76% of immediate resumes over
 *   20s; the work itself is ~530ms). Inbound SMS (Clio 2FA codes), call
 *   logging, and website lead intake all ride this path.
 *
 *   This module enqueues a Google Cloud Task that POSTs
 *   {app_url}/process-job/{id} ~2s after the row becomes due. The task
 *   handler claims THAT job with the same predicates as the cron batch and
 *   runs it inside a request at full CPU. The win COMPOUNDS on multi-hop
 *   workflows: scheduleSelfContinue re-queues at now+1s per hop, so every
 *   hop pays the queue wait separately — 15% of executions take 2+ resume
 *   jobs (live, 14d), meaning a 2-hop workflow waited ~70s and a 3-hop
 *   ~105s pre-slice. Post-slice: ~3s per hop. EXPECTED start latency: ~2-4s
 *   (a projection until measured post-rollout — verify against
 *   scheduled_jobs created_at→updated_at deltas). At ~50 jobs/day this
 *   sits deep inside the Cloud Tasks
 *   free tier (1M ops/month) — effectively $0.
 *
 * DESIGN INVARIANTS — do not weaken these
 *   1. The scheduled_jobs row stays. The 60s cron stays. A task is a latency
 *      accelerator bolted on top, never the scheduling authority. If Cloud
 *      Tasks is disabled, misconfigured, throttled, or down, behavior
 *      degrades to exactly the pre-slice 0–60s wait. Nothing is removed.
 *   2. enqueueJobDispatch NEVER rejects. It is called from inside
 *      scheduleResume / scheduleStepJob — the critical path for every
 *      workflow advance. A Cloud Tasks outage must not break scheduling.
 *      Catch everything, warn, return.
 *   3. Only near-immediate jobs are enqueued (callers gate on
 *      ACCEL_WINDOW_MS). Cloud Tasks is a DOORBELL, not a CALENDAR — the
 *      scheduled_jobs row is the calendar, and a task is worth creating
 *      exactly when a human is plausibly waiting. Note carefully what the
 *      reason is NOT: it is not cancellation safety. The targeted claim
 *      predicate (status='pending' AND active=1 AND scheduled_time<=NOW()
 *      AND not expired AND under max_executions) makes any stale task a
 *      wasted HTTP request, never a wrong execution. The reasons the
 *      window must stay narrow are structural:
 *        (a) Recurring rows are immortal — one id, rescheduled in place
 *            (job 867 has 2,000+ executions on a single row). Far-future
 *            named tasks against a reused id would collide with the ~1h
 *            completed-name retention and be silently swallowed.
 *        (b) Several writers reschedule rows in place (failure backoff,
 *            admin PATCH, sequence run-now, recurring resume). A task
 *            pinned days out has no reconciliation with any of them.
 *        (c) Cloud Tasks caps scheduleTime at 30 days; task reminders
 *            already reach 17 and staff set due dates freely.
 *        (d) Blast radius: as a bolt-on, any Cloud Tasks failure degrades
 *            to today's 0–60s. As the authority for all scheduling it
 *            would be a single point of failure — including for the error
 *            sweep that would report the outage.
 *        (e) The cron is irreducible anyway (recoverStuckJobs, heartbeat,
 *            crash recovery), so a far-future task buys "fires at :23
 *            instead of :24" — unobservable.
 *      Widening the window therefore requires defeating (a)–(c) with
 *      engineering AND accepting (d)–(e), for no visible benefit. Don't.
 *   4. Double-dispatch is safe WITHOUT this module's help: the targeted
 *      claim in routes/process_jobs.js (status='pending' ... FOR UPDATE) and
 *      the workflow_resume status guard are the real protection. The named
 *      task (d-{jobId}) is belt-and-braces dedupe at the queue layer only —
 *      note Cloud Tasks retains executed task names for ~1h+, so a name can
 *      briefly refuse re-creation after completion. Job ids are never
 *      reused, so this cannot bite.
 *
 * AUTH
 *   The task carries x-api-key: cfg('internal_api_key') — the same app-level
 *   credential lib/auth.jwtOrApiKey accepts on /process-jobs. The key is read
 *   at ENQUEUE time; the dual-slot verifier (internal_api_key_prev) makes
 *   key rotation safe for tasks already in flight. Cloud Run ingress is
 *   public (app-level auth), so no OIDC token is needed. If ingress is ever
 *   locked to IAM, add oidcToken:{serviceAccountEmail} to httpRequest here.
 *
 * CONFIG
 *   cloud_tasks_enabled  — firmConfig registry key (app_settings row, env
 *                          fallback CLOUD_TASKS_ENABLED). '1' = on. This is
 *                          the kill switch: flip the setting to '0' (NOT
 *                          blank — firmConfig's empty-string rule falls
 *                          through to env) and instances converge ≤60s.
 *   CLOUD_TASKS_LOCATION — queue region, e.g. us-central1 (env only).
 *   CLOUD_TASKS_QUEUE    — queue name (env, default 'yc-jobs').
 *   CLOUD_TASKS_TARGET_URL — optional base URL override; defaults to
 *                          cfg('app_url'). Project id comes from ADC.
 */

'use strict';

/**
 * Enqueue window: callers only accelerate jobs due within this horizon.
 * 90s = "immediate or scheduleSelfContinue-shaped", with margin for clock
 * skew and slow inserts. Lives here so the window has exactly one home.
 */
const ACCEL_WINDOW_MS = 90 * 1000;

/**
 * Safety buffer added to the task's scheduleTime:
 *   (a) the claim predicate is `scheduled_time <= NOW()` against MySQL's
 *       clock — a task firing a hair early finds 0 rows, burns itself as
 *       already_claimed, and the job waits for the cron (≤60s);
 *   (b) some callers insert the row while their own HTTP request is still
 *       in flight — 2s comfortably clears commit visibility.
 */
const DISPATCH_BUFFER_MS = 2000;

let client = null;            // lazy CloudTasksClient (ADC, like storageService)
let projectIdPromise = null;  // cached client.getProjectId()
let warnedOff = false;        // log the disabled/misconfigured state once, not per job

function resolveConfig() {
  // Deferred require: firmConfig lazily touches startup/db; loading it at
  // module time from here would recreate the load-order cycle jwtOrApiKey
  // already defers around.
  const { cfg } = require('./firmConfig');
  return {
    enabled: cfg('cloud_tasks_enabled') === '1',
    location: process.env.CLOUD_TASKS_LOCATION || null,
    queue: process.env.CLOUD_TASKS_QUEUE || 'yc-jobs',
    targetBase: process.env.CLOUD_TASKS_TARGET_URL || cfg('app_url'),
    apiKey: cfg('internal_api_key'),
  };
}

/**
 * Enqueue a push dispatch for scheduled_jobs row `jobId`.
 * Fire-and-forget from the caller's perspective: NEVER rejects.
 *
 * @param {number} jobId          scheduled_jobs.id (insertId of the fresh row)
 * @param {number|string|Date} scheduleTime  when the job is due (ms epoch,
 *                                ISO string, or Date). Task fires at
 *                                max(scheduleTime, now) + DISPATCH_BUFFER_MS.
 * @returns {Promise<boolean>}    true if a task was created — for tests and
 *                                logging only; callers must not branch on it.
 */
async function enqueueJobDispatch(jobId, scheduleTime) {
  try {
    const conf = resolveConfig();

    if (!conf.enabled) {
      if (!warnedOff) {
        warnedOff = true;
        console.log('[taskQueue] cloud_tasks_enabled != 1 — accelerator off, jobs ride the 60s cron');
      }
      return false;
    }
    if (!conf.location || !conf.targetBase || !conf.apiKey) {
      if (!warnedOff) {
        warnedOff = true;
        console.warn('[taskQueue] enabled but misconfigured (need CLOUD_TASKS_LOCATION + app_url/CLOUD_TASKS_TARGET_URL + internal_api_key) — accelerator off');
      }
      return false;
    }
    warnedOff = false; // healthy again — re-arm the one-shot warning

    if (!client) {
      const { CloudTasksClient } = require('@google-cloud/tasks');
      client = new CloudTasksClient();
    }
    if (!projectIdPromise) {
      // Never cache a rejection: a single metadata-server blip must not kill
      // the accelerator for the life of the instance. On failure, null the
      // cache so the NEXT enqueue retries; this call still fails (caught
      // below → warn → job rides the cron).
      projectIdPromise = client.getProjectId().catch((err) => {
        projectIdPromise = null;
        throw err;
      });
    }
    const projectId = await projectIdPromise;

    const dueMsRaw = new Date(scheduleTime).getTime();
    const dueMs = Number.isFinite(dueMsRaw) ? dueMsRaw : Date.now();
    const etaMs = Math.max(dueMs, Date.now()) + DISPATCH_BUFFER_MS;

    const url = String(conf.targetBase).replace(/\/+$/, '') + `/process-job/${jobId}`;
    const parent = client.queuePath(projectId, conf.location, conf.queue);
    const task = {
      // Named task: queue-layer dedupe on double enqueue of the SAME
      // (job, due-time) pair. The due-time suffix is load-bearing: several
      // paths reschedule an existing row to now (sequence run-now, admin
      // PATCH), and Cloud Tasks retains completed task names for ~1h — a
      // bare d-{jobId} would collide with the row's original task and be
      // silently swallowed as ALREADY_EXISTS, un-ringing the doorbell.
      // Distinct due time → distinct name → the reschedule dispatches.
      name: client.taskPath(projectId, conf.location, conf.queue, `d-${jobId}-${Math.floor(dueMs)}`),
      scheduleTime: { seconds: Math.ceil(etaMs / 1000) },
      httpRequest: {
        httpMethod: 'POST',
        url,
        headers: { 'x-api-key': conf.apiKey },
      },
    };

    // 15s deadline. Rationale changed (review, 2026-08-23): the hook path
    // enqueues from DETACHED post-response context (routes/api.hooks.js
    // responds, then runs the pipeline) — i.e. under Cloud Run's request-CPU
    // throttling, the very condition this slice dodges for the WORK. Nothing
    // awaits this call on a request path, so the deadline buys nothing in
    // snappiness; it exists only to eventually free the socket of a truly
    // hung RPC. Throttled headroom therefore beats a tight limit — 5s was
    // not a comfortable margin at 20–45× slowdown. Boot-time warmup()
    // (startup/init.js) pays the expensive one-time client setup at full
    // CPU so this per-job call is a small request on a warm channel.
    await client.createTask({ parent, task }, { timeout: 15000 });
    console.log(`[taskQueue] enqueued dispatch for job ${jobId} (eta ${new Date(etaMs).toISOString()})`);
    return true;
  } catch (err) {
    // gRPC 6 = ALREADY_EXISTS — the named task is already queued (or its name
    // is inside the post-execution retention window). Expected, silent.
    if (err && err.code === 6) return false;
    console.warn(`[taskQueue] enqueue failed for job ${jobId} (job falls back to the cron): ${err.message}`);
    return false;
  }
}

/**
 * Boot-time warmup — call once from startup/init.js. NEVER throws.
 *
 * WHY (review, 2026-08-23): every enqueue on the hook path — the whole
 * measured problem — runs in detached post-response context, CPU-throttled.
 * A cold CloudTasksClient does its expensive one-time work there (ADC token
 * acquisition, HTTP/2 + TLS handshake to cloudtasks.googleapis.com — crypto,
 * not just socket I/O), which at 20–45× throttling risks eating the RPC
 * deadline and silently degrading every first enqueue per instance to cron
 * latency. Container boot runs at full CPU: pay the setup cost here, once.
 *
 * The warm RPC is getQueue — one cheap read that (a) establishes the TLS
 * channel and auth token, and (b) VALIDATES the config: a typo'd region or
 * queue name surfaces as one loud boot log line instead of a silent per-job
 * warn stream. Runs on env config alone (location set), independent of the
 * cloud_tasks_enabled flag — the flag can flip at runtime via settings, and
 * warming an unused client costs one metadata call + one read RPC.
 *
 * IAM nuance: getQueue needs cloudtasks.queues.get (roles/cloudtasks.viewer),
 * which roles/cloudtasks.enqueuer does NOT include. Under enqueuer-only IAM
 * the RPC returns PERMISSION_DENIED — but the channel and token are already
 * established by then, so the warmup still did its job; we log that state
 * distinctly and recommend granting viewer for the config validation.
 *
 * @returns {Promise<boolean>} channel warmed (true even under
 *   PERMISSION_DENIED — see above); false = unconfigured or unreachable.
 */
async function warmup() {
  try {
    const location = process.env.CLOUD_TASKS_LOCATION;
    if (!location) return false; // accelerator not configured on this deployment
    const queue = process.env.CLOUD_TASKS_QUEUE || 'yc-jobs';

    if (!client) {
      const { CloudTasksClient } = require('@google-cloud/tasks');
      client = new CloudTasksClient();
    }
    if (!projectIdPromise) {
      projectIdPromise = client.getProjectId().catch((err) => {
        projectIdPromise = null;
        throw err;
      });
    }
    const projectId = await projectIdPromise;

    await client.getQueue(
      { name: client.queuePath(projectId, location, queue) },
      { timeout: 15000 }
    );
    console.log(`[taskQueue] warm — queue ${queue} (${location}) reachable and exists`);
    return true;
  } catch (err) {
    if (err && err.code === 7) {
      // PERMISSION_DENIED — channel + token established; only the existence
      // check was refused. Enqueues (cloudtasks.tasks.create) may still work.
      console.log('[taskQueue] warm — channel established (grant roles/cloudtasks.viewer to also validate the queue at boot)');
      return true;
    }
    if (err && err.code === 5) {
      console.warn(`[taskQueue] warmup: queue NOT FOUND — check CLOUD_TASKS_LOCATION/CLOUD_TASKS_QUEUE (${err.message})`);
      return false;
    }
    console.warn(`[taskQueue] warmup failed (first enqueue per instance will cold-start): ${err.message}`);
    return false;
  }
}

/** Test hook — inject a fake client / reset module state between tests. */
function _test({ client: c, resetWarn } = {}) {
  if (c !== undefined) { client = c; projectIdPromise = null; }
  if (resetWarn) warnedOff = false;
}

module.exports = { enqueueJobDispatch, warmup, ACCEL_WINDOW_MS, DISPATCH_BUFFER_MS, _test };
