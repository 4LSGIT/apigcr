// routes/process_jobs.js
const express = require("express");
const router = express.Router();
const { CronExpressionParser } = require("cron-parser");
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const { advanceWorkflow, scheduleResume } = require("../lib/workflow_engine");
const { executeJob }      = require("../lib/job_executor");
const { executeStep }     = require("../lib/sequenceEngine");


/**
 * Heartbeat: "the poll cycle ran" — NOT "jobs succeeded". Individual job
 * failures are the error sweep's domain. Stamped on every successful exit
 * of the poll handler, including 0-jobs-claimed and batches with failures.
 * Fire-and-forget: must never delay or break the poller.
 */
function stampHeartbeat(db) {
  db.query(
    `INSERT INTO app_settings (\`key\`, \`value\`, is_secret, is_editable)
     VALUES ('process_jobs_last_heartbeat_at', ?, 0, 0)
     ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`)`,
    [new Date().toISOString()]
  ).catch(err => console.error('[process-jobs] heartbeat stamp failed:', err.message));
}

async function recordResult(
  connection,
  jobId,
  executionNumber,
  attempt,
  success,
  payload,
  duration,
) {
  const query = `
  INSERT INTO job_results
  (job_id, execution_number, attempt, status, output_data, error_message, duration_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`;

  await connection.query(query, [
    jobId,
    executionNumber,
    attempt,
    success ? "success" : "failed",
    success ? JSON.stringify(payload) : null,
    success ? null : payload,
    duration,
  ]);
}

/**
 * Reschedule recurring job
 * MUST be called with a transaction connection
 */
async function rescheduleRecurring(connection, job) {
  if (job.type !== "recurring" || !job.recurrence_rule) return;

  const nextExecutionCount = (job.execution_count || 0) + 1;

  // Check expiry limits before rescheduling
  if (job.max_executions && nextExecutionCount >= job.max_executions) {
    console.log(`[RECURRING] Job ${job.id} reached max_executions (${job.max_executions}) — marking completed`);
    await connection.query(
      `UPDATE scheduled_jobs SET status = 'completed', execution_count = ?, updated_at = NOW() WHERE id = ?`,
      [nextExecutionCount, job.id]
    );
    return;
  }

  const interval = CronExpressionParser.parse(job.recurrence_rule, {
    currentDate: new Date(job.scheduled_time),
  });

  const nextTime = interval.next().toDate();

  // Check if next scheduled time would be past the expiry
  if (job.expires_at && nextTime > new Date(job.expires_at)) {
    console.log(`[RECURRING] Job ${job.id} next run (${nextTime.toISOString()}) is past expires_at (${job.expires_at}) — marking completed`);
    await connection.query(
      `UPDATE scheduled_jobs SET status = 'completed', execution_count = ?, updated_at = NOW() WHERE id = ?`,
      [nextExecutionCount, job.id]
    );
    return;
  }

  await connection.query(
    `
    UPDATE scheduled_jobs
    SET
      scheduled_time = ?,
      status = 'pending',
      attempts = 0,
      execution_count = execution_count + 1,
      updated_at = NOW()
    WHERE id = ?
    `,
    [nextTime, job.id],
  );
}

async function recoverStuckJobs(db) {
  // Recovery window: how long a 'running' job or 'processing' execution can sit
  // without an updated_at refresh before being considered dead and reset.
  //
  // Trade-off:
  //  - Too short → a legitimately slow job (large batch of slow hook targets,
  //    long workflow branch) gets double-executed.
  //  - Too long  → a truly crashed job delays for longer.
  //
  // Worst-case legitimate job times today:
  //   - hook_retry:       ~30s  (single target, 30s fetch timeout)
  //   - sequence_step:    seconds (one SMS/email per step)
  //   - workflow_resume:  ~2-3 min (up to 20 steps per invocation; each step
  //                                  has its own retries with backoff)
  //   - batch of 10 normal jobs, each ~30s: ~5 min sequential
  //
  // 15 min leaves a safety margin ~3x the worst realistic case.
  // If adding long-running job types in the future, either shorten their
  // batches or implement a heartbeat that refreshes updated_at periodically.
  const RECOVERY_WINDOW_MIN = 15;

  // Recover stuck scheduled jobs
  const [jobResult] = await db.query(
    `UPDATE scheduled_jobs
     SET status = 'pending', updated_at = NOW()
     WHERE status = 'running'
       AND updated_at < NOW() - INTERVAL ? MINUTE`,
    [RECOVERY_WINDOW_MIN]
  );
  if (jobResult.affectedRows > 0) {
    console.warn(`[JOB RECOVERY] Recovered ${jobResult.affectedRows} stuck running jobs (>${RECOVERY_WINDOW_MIN}min)`);
  }

  // Recover stuck workflow executions (server crashed / Cloud Run instance
  // reaped mid-advance).
  //
  // Old behavior flipped 'processing' → 'active' and stopped. That only
  // works for executions that ALSO have a pending workflow_resume job (the
  // delayed path). Hook/manual/sequence-started executions used to advance
  // in a detached background call with NO scheduled job — a bare flip
  // stranded them at 'active' forever (observed 7×, 2026-03→2026-08:
  // executions 16, 17, 850, 4850, 5060, 6702, 8336). Each flipped row now
  // also gets an immediate workflow_resume job at its persisted step
  // pointer. (Background-CPU slice, 2026-08: hook/sequence/WF→WF starts are
  // now queued via scheduleResume rather than detached, so this recovery
  // path mostly covers manual starts and mid-advance crashes.)
  //
  // Correctness of the resume step depends on advanceWorkflow persisting
  // current_step_number at every advance (shipped together with this
  // change). GATE: rows with (steps_executed_count > 0 AND
  // current_step_number = 1) are flipped but NOT auto-resumed — that shape
  // is either a pre-deploy straggler with a stale pointer (resuming would
  // re-fire every step: Clio PATCHes, SMS, emails, ...) or a rare crash
  // while parked at step 1 via a set_next loop-back. Both surface through
  // the stuck-execution alert scan (lib/alerting.js) for manual triage.
  //
  // Concurrency: duplicate resumes from overlapping polls are harmless —
  // advanceWorkflow's claim-lock (status IN ('active','delayed') ... FOR
  // UPDATE) lets exactly one claim win; the loser returns 'skipped'.
  const [stuckExecs] = await db.query(
    `SELECT id, current_step_number, steps_executed_count
       FROM workflow_executions
      WHERE status = 'processing'
        AND updated_at < NOW() - INTERVAL ? MINUTE
      LIMIT 50`,
    [RECOVERY_WINDOW_MIN]
  );
  for (const ex of stuckExecs) {
    try {
      await db.query(
        `UPDATE workflow_executions
            SET status = 'active', updated_at = NOW()
          WHERE id = ? AND status = 'processing'`,
        [ex.id]
      );
      const staleFirstStepShape =
        (ex.steps_executed_count ?? 0) > 0 && ex.current_step_number === 1;
      if (staleFirstStepShape) {
        console.warn(`[EXEC RECOVERY] Execution ${ex.id} flipped to active WITHOUT auto-resume (step pointer 1 with ${ex.steps_executed_count} steps executed — needs manual triage; see stuck-execution alerts)`);
      } else {
        const resumeStep = ex.current_step_number || 1;
        await scheduleResume(ex.id, new Date(), resumeStep, db);
        console.warn(`[EXEC RECOVERY] Execution ${ex.id} recovered — resume scheduled at step ${resumeStep} (>${RECOVERY_WINDOW_MIN}min stale)`);
      }
    } catch (err) {
      console.error(`[EXEC RECOVERY] Failed to recover execution ${ex.id}: ${err.message}`);
    }
  }
}

/**
 * runJobPass — the whole poll/dispatch cycle, extracted (Cloud Tasks slice,
 * 2026-08) so the 60s cron batch and the per-job push dispatch share ONE
 * execution path. Do not fork this: a copy-pasted second dispatch loop will
 * diverge.
 *
 * Modes:
 *   jobId === null  (cron batch — the pre-slice behavior, unchanged):
 *     recoverStuckJobs housekeeping, claim up to batchSize due jobs
 *     (FOR UPDATE SKIP LOCKED), dispatch, stamp the heartbeat.
 *   jobId set       (targeted — POST /process-job/:id from a Cloud Task):
 *     claim ONLY that job with the same predicates. NO recoverStuckJobs
 *     (per-minute housekeeping; running it per task multiplies DB load for
 *     no benefit) and NO heartbeat (the heartbeat means "the POLL cycle
 *     ran" — routes/api.systemStatus.js uses its age to detect a dead
 *     Cloud Scheduler job; task traffic stamping it would mask exactly
 *     that failure). A job that is not claimable — already taken by the
 *     cron, completed, inactive, not yet due — is a NORMAL outcome, not an
 *     error: return processed:0 / already_claimed so Cloud Tasks (which
 *     retries on any non-2xx) treats the task as done.
 *
 * Claim errors propagate to the caller (the routes map them to HTTP 500 —
 * for a Cloud Task that means a retry, which is correct for a DB blip).
 * Everything after the claim handles its own errors per job, exactly as
 * before the extraction.
 */
async function runJobPass(db, { jobId = null, batchSize = 10 } = {}) {
  const targeted = jobId !== null;

  let jobs = [];

  // STEP 1: Atomically claim due jobs (pure-DB → retries: 3).
  //
  // Why retries: 3 — observed failure mode (7/2026): the MySQL server drops all
  // idle pooled connections at once (PROTOCOL_CONNECTION_LOST); each failed
  // attempt evicts one dead socket from the pool, so a single retry can pull a
  // second corpse and still fail. Three retries drains a small pool of stale
  // sockets and lands on a fresh dial. Claim is pure-DB and rolls back on
  // failure, so extra retries are side-effect-safe.

  // Housekeeping — must never kill the poll cycle. It re-runs on every poll,
  // so a skipped pass costs at most one minute of recovery delay.
  // Batch mode only: it is per-minute housekeeping, not per-job work.
  if (!targeted) {
    try {
      await recoverStuckJobs(db);
    } catch (recoveryErr) {
      console.warn(`[PROCESS-JOBS] recoverStuckJobs failed (non-fatal): ${recoveryErr.code || ""} ${recoveryErr.message}`);
    }
  }

  jobs = await db.withTransaction(async (connection) => {
    // Targeted and batch claims share every predicate. SKIP LOCKED in BOTH:
    // for the targeted claim it means a row currently being claimed by the
    // cron returns 0 rows immediately (→ already_claimed) instead of a lock
    // wait holding the Cloud Task's request open — same outcome, no stall.
    const [rows] = targeted
      ? await connection.query(
          `
          SELECT *
          FROM scheduled_jobs
          WHERE id = ?
            AND status = 'pending'
            AND active = 1
            AND scheduled_time <= NOW()
            AND (expires_at IS NULL OR expires_at > NOW())
            AND (max_executions IS NULL OR execution_count < max_executions)
          FOR UPDATE SKIP LOCKED
          `,
          [jobId]
        )
      : await connection.query(
          `
          SELECT *
          FROM scheduled_jobs
          WHERE status = 'pending'
            AND active = 1
            AND scheduled_time <= NOW()
            AND (expires_at IS NULL OR expires_at > NOW())
            AND (max_executions IS NULL OR execution_count < max_executions)
          ORDER BY scheduled_time
          LIMIT ?
          FOR UPDATE SKIP LOCKED
          `,
          [batchSize]
        );

    if (rows.length === 0) return [];

    const jobIds = rows.map((j) => j.id);

    await connection.query(
      `UPDATE scheduled_jobs SET status = 'running', updated_at = NOW() WHERE id IN (?)`,
      [jobIds]
    );

    return rows;
  }, { retries: 3 });

  if (jobs.length === 0) {
    if (targeted) {
      // The cron got there first (or the job is done/inactive/not due).
      // Expected — HTTP 200 so Cloud Tasks does not retry.
      return { processed: 0, results: [{ id: jobId, status: 'already_claimed' }] };
    }
    stampHeartbeat(db); // fire-and-forget — poll cycle ran (common path)
    return { processed: 0, results: [] };
  }

  // STEP 2: Execute jobs one by one
  const results = [];

  // Background-CPU slice (2026-08): workflow_resume / sequence_step /
  // hook_retry executors used to be FULLY detached — their async IIFEs
  // outlived res.json, so under Cloud Run's request-based billing they ran
  // CPU-throttled (observed 20–45× slowdowns; vm-watchdog aborts on trivial
  // custom_code). They still start immediately and run CONCURRENTLY with the
  // rest of the batch (same as before), but their promises are now collected
  // here and awaited before the response, keeping the request in flight —
  // and the instance un-throttled — until the work finishes.
  //
  // Crash semantics unchanged: each executor updates its own job status on
  // completion; a container death mid-work leaves the job 'running' for
  // recoverStuckJobs. A Cloud Run request-timeout kill behaves like a crash
  // (jobs recovered at the 15-min sweep) — timeoutSeconds must comfortably
  // exceed the worst batch; see the retry-ladder budget in lib/versionDiff.js
  // (300s/step) against the service's 900s timeout.
  //
  // Overlap is safe: the next minute's tick claims other pending jobs
  // (FOR UPDATE SKIP LOCKED) while this request is still open.
  const deferredWork = [];

  for (const job of jobs) {

    const start = Date.now();
    const attempt = job.attempts + 1;
    const executionNumber = job.execution_count + 1;

    try {
      // SPECIAL CASE: workflow_resume
      // NOTE: Job status is left as 'running' (set in STEP 1) and only
      // updated to 'completed'/'failed' AFTER the executor finishes (awaited via deferredWork).
      // This ensures that if the container crashes mid-execution, recoverStuckJobs
      // resets the job to 'pending' and it will be re-run on the next poll.
      // Tradeoff: re-run can cause duplicate step execution (executor is not
      // idempotent). Acceptable vs. silent loss of the whole workflow resume.
      if (job.type === 'workflow_resume') {
        const data = typeof job.data === 'string' ? JSON.parse(job.data) : job.data;
        const { nextStep, executionId } = data || {};

        console.log(`[RESUME] Resuming execution ${executionId} at step ${nextStep}`);

        // Update execution state in its own short transaction (pure-DB → retries: 3).
        //
        // STATUS GUARD (2026-08): only non-terminal, non-held statuses are
        // resumable. Without the guard, a REPLAYED resume job (recovered
        // from 'running' by recoverStuckJobs after a crash that landed
        // AFTER the execution completed but BEFORE the job's completed-mark
        // write) would resurrect a terminal execution to 'active' and
        // re-run steps from nextStep. 'active' is included because exec
        // recovery flips crashed 'processing' rows to 'active' before this
        // job runs; 'processing' covers a stale claim whose job was
        // recovered first. 'held' stays manual-resume-only.
        const guarded = await db.withTransaction(async (conn) => {
          const [r] = await conn.query(
            `UPDATE workflow_executions 
             SET status = 'active', current_step_number = ?, updated_at = NOW()
             WHERE id = ?
               AND status IN ('delayed', 'active', 'processing')`,
            [nextStep, executionId]
          );
          return r.affectedRows;
        }, { retries: 3 });

        if (guarded === 0) {
          // Terminal, held, or missing — resume is moot. Close the job so it
          // never replays; do NOT advance.
          console.warn(`[RESUME] Execution ${executionId} not resumable (terminal/held/missing) — closing job ${job.id} without advancing`);
          await db.query(
            `UPDATE scheduled_jobs SET status = 'completed', updated_at = NOW() WHERE id = ?`,
            [job.id]
          );
          results.push({
            id: job.id,
            status: 'skipped',
            note: `Execution ${executionId} not resumable (terminal/held/missing)`
          });
          continue; // next job in the batch
        }

        // Advance concurrently with the rest of the batch, but AWAITED before
        // the response (see deferredWork above) so the whole advance runs
        // request-bound at full CPU instead of throttled after res.json.
        // The job's scheduled_jobs.status update happens AFTER advanceWorkflow
        // returns, so a mid-execution crash leaves status='running' for
        // recoverStuckJobs to recover.
        deferredWork.push((async () => {
          try {
            const advanceResult = await advanceWorkflow(executionId, db);
            console.log(`[RESUME ADVANCE] Execution ${executionId} finished with ${advanceResult.status}`);
            await db.query(
              `UPDATE scheduled_jobs SET status = 'completed', updated_at = NOW() WHERE id = ?`,
              [job.id]
            );
          } catch (err) {
            console.error(`[RESUME ADVANCE] Failed for ${executionId}:`, err);
            try {
              await db.query(
                `UPDATE scheduled_jobs SET status = 'failed', updated_at = NOW() WHERE id = ?`,
                [job.id]
              );
            } catch (dbErr) {
              console.error(`[RESUME ADVANCE] Failed to mark job ${job.id} as failed:`, dbErr.message);
            }
          }
        })());

        results.push({
          id: job.id,
          status: 'dispatched',
          note: `Resuming execution ${executionId} at step ${nextStep}`
        });

        continue; // next job in the batch
      }

      // SPECIAL CASE: sequence_step
      // See workflow_resume comment above — same pattern: status stays 'running'
      // until the executor (awaited via deferredWork) finishes so a crash doesn't silently drop the step.
      // No claim transaction is needed: there is no pre-dispatch DB write here, so
      // the previous empty begin/commit was a no-op and has been removed.
      if (job.type === 'sequence_step') {
        const data = typeof job.data === 'string' ? JSON.parse(job.data) : job.data;
        const { enrollmentId, stepId, stepNumber } = data || {};

        console.log(`[SEQ STEP] enrollment=${enrollmentId} step=${stepId} n=${stepNumber ?? '-'}`);

        // Execute concurrently, awaited before the response (deferredWork)
        deferredWork.push((async () => {
          try {
            // stepNumber is the step's identity across content-only publishes
            // (executeStep resolves by it against the enrollment's pinned
            // version); stepId is the legacy fallback.
            const result = await executeStep(db, enrollmentId, stepId, stepNumber);
            console.log(`[SEQ STEP] enrollment=${enrollmentId} step=${stepId} → ${result.status}${result.reason ? ' ('+result.reason+')' : ''}`);
            await db.query(
              `UPDATE scheduled_jobs SET status = 'completed', updated_at = NOW() WHERE id = ?`,
              [job.id]
            );
          } catch (err) {
            console.error(`[SEQ STEP] Failed enrollment=${enrollmentId} step=${stepId}:`, err.message);
            try {
              await db.query(
                `UPDATE scheduled_jobs SET status = 'failed', updated_at = NOW() WHERE id = ?`,
                [job.id]
              );
            } catch (dbErr) {
              console.error(`[SEQ STEP] Failed to mark job ${job.id} as failed:`, dbErr.message);
            }
          }
        })());

        results.push({
          id:     job.id,
          status: 'dispatched',
          note:   `Sequence step enrollment=${enrollmentId} step=${stepId}`
        });

        continue; // next job in the batch
      }

      // SPECIAL CASE: hook_retry
      // See workflow_resume comment above — same pattern: status stays 'running'
      // until the executor (awaited via deferredWork) finishes so a crash doesn't silently drop the retry.
      // No claim transaction is needed: there is no pre-dispatch DB write here, so
      // the previous empty begin/commit was a no-op and has been removed.
      if (job.type === 'hook_retry') {
        const data = typeof job.data === 'string' ? JSON.parse(job.data) : job.data;

        console.log(`[HOOK RETRY] execution=${data.execution_id} target=${data.target_id}`);

        // Execute concurrently, awaited before the response (deferredWork)
        deferredWork.push((async () => {
          try {
            const hookService = require('../services/hookService');
            await hookService.executeRetry(db, data);
            console.log(`[HOOK RETRY] execution=${data.execution_id} target=${data.target_id} → done`);
            await db.query(
              `UPDATE scheduled_jobs SET status = 'completed', updated_at = NOW() WHERE id = ?`,
              [job.id]
            );
          } catch (err) {
            console.error(`[HOOK RETRY] Failed execution=${data.execution_id}:`, err.message);
            try {
              await db.query(
                `UPDATE scheduled_jobs SET status = 'failed', updated_at = NOW() WHERE id = ?`,
                [job.id]
              );
            } catch (dbErr) {
              console.error(`[HOOK RETRY] Failed to mark job ${job.id} as failed:`, dbErr.message);
            }
          }
        })());

        results.push({
          id:     job.id,
          status: 'dispatched',
          note:   `Hook retry execution=${data.execution_id} target=${data.target_id}`
        });

        continue;
      }

      // NORMAL JOB TYPES (webhook, internal_function, custom_code, campaign_send,
      // task_due_reminder, task_daily_digest)
      //
      // ── executeJob RUNS OUTSIDE THE TRANSACTION, DELIBERATELY ───────────
      // It used to run INSIDE the withTransaction callback below, and that
      // silently broke every job whose execution outlasts the server's idle
      // timeout. withTransaction checks a connection OUT of the pool and holds
      // it for the whole callback. A long job therefore left that connection
      // idle for its entire runtime while all its own work went to the pool —
      // and SiteGround closes an idle connection after 60s. The callback then
      // resumed onto a dead socket and died on the COMMIT-side writes with
      //     Can't add new command when connection is in closed state
      //
      // Two reasons nothing caught it:
      //   - a CHECKED-OUT connection is not in _freeConnections, so mysql2's
      //     idle sweeper cannot see it (it only ever inspects the free list);
      //   - `conn.query` is a raw PoolConnection method, NOT the wrapped
      //     promisePool.query, so startup/db.js's transient-retry never
      //     applied to it either.
      // Observed 2026-08-27 killing documents_refresh_case_cache six times at
      // ~220s (and documents_sync once at 132s). enableKeepAlive does not help
      // — wait_timeout counts server-side idle, not TCP liveness.
      //
      // The transaction only ever needed to make RECORD + RESCHEDULE atomic;
      // the side effect was never rollback-able anyway. Failure semantics are
      // unchanged: a record-time failure still fails the job and retries it on
      // a later poll, exactly as the { retries: 0 } note below describes.
      const rawOutput = await executeJob(job, db);

      // executeJob is NOT idempotent, so the recording transaction keeps
      // { retries: 0 } — a transient pre-commit failure must not re-run the
      // callback. Now that the callback contains only DB writes that is a
      // narrow window rather than the length of the job.
      const completion = await db.withTransaction(async (conn) => {
        // Edge cases where rawOutput can be undefined:
        //   - custom_code where the script body has no trailing expression
        //   - webhook with 204/empty response where axios returns undefined data
        // JSON.stringify(undefined) returns undefined, which recordResult would
        // store as NULL — indistinguishable from a failure row. Coerce so success
        // rows always round-trip as valid JSON.
        const output = rawOutput === undefined ? { success: true } : rawOutput;

        // Record successful attempt
        await recordResult(
          conn,
          job.id,
          executionNumber,
          attempt,
          true,
          output,
          Date.now() - start
        );

        if (job.type === "recurring") {
          await rescheduleRecurring(conn, job);
        } else {
          await conn.query(
            `
            UPDATE scheduled_jobs
            SET status='completed', attempts=?, updated_at=NOW(), execution_count = execution_count + 1
            WHERE id=?
            `,
            [attempt, job.id]
          );
        }

        return job.type === "recurring" ? "advanced" : "completed";
      }, { retries: 0 });

      results.push({
        id: job.id,
        status: completion,
      });

    } catch (err) {
      // Record failed attempt in its own transaction (pure-DB → retries: 3). The
      // results.push is moved outside the callback so a transient retry cannot
      // double-record into the results array.
      try {
        const outcome = await db.withTransaction(async (conn2) => {
          await recordResult(
            conn2,
            job.id,
            executionNumber,
            attempt,
            false,
            err.message,
            Date.now() - start
          );

          if (attempt < job.max_attempts) {
            const delayMs = job.backoff_seconds * Math.pow(2, attempt - 1) * 1000;
            const nextTime = new Date(Date.now() + delayMs);

            await conn2.query(
              `
              UPDATE scheduled_jobs
              SET status='pending', attempts=?, scheduled_time=?, updated_at=NOW() 
              WHERE id=?
              `,
              [attempt, nextTime, job.id]
            );

            return { status: "retry_scheduled", attempt, error: err.message };
          } else if (job.type === "recurring") {
            await rescheduleRecurring(conn2, job);
            return { status: "advanced_after_failure", error: err.message };
          } else {
            await conn2.query(
              `
              UPDATE scheduled_jobs
              SET status='failed', attempts=?, updated_at=NOW(), execution_count = execution_count + 1
              WHERE id=?
              `,
              [attempt, job.id]
            );
            return { status: "failed", error: err.message };
          }
        }, { retries: 3 });

        results.push({ id: job.id, ...outcome });
      } catch (recordErr) {
        console.error(`[PROCESS-JOBS] Failed to record result for job ${job.id}: ${recordErr.message}`);
        results.push({ id: job.id, status: "failed", error: err.message });
        // Job left as-is (still 'running' from STEP 1) — recoverStuckJobs resets it.
      }
    }
  }

  // Hold the request open until every deferred executor finishes — this is
  // what keeps the instance un-throttled for the whole batch. allSettled,
  // not all: each executor already handles its own errors and never rejects,
  // but a future rethrow must not skip the heartbeat/response.
  await Promise.allSettled(deferredWork);

  if (!targeted) {
    stampHeartbeat(db); // fire-and-forget — poll cycle ran (even if some jobs failed)
  }
  return { processed: jobs.length, results };
}

// ─────────────────────────────────────────────────────────────
// Routes — two thin wrappers over runJobPass
// ─────────────────────────────────────────────────────────────

// Cron batch — externally unchanged: same auth, same response shape, same
// 500 shape on claim failure.
router.all("/process-jobs", jwtOrApiKey, async (req, res) => {
  try {
    const out = await runJobPass(req.db);
    res.json(out);
  } catch (err) {
    console.error("[PROCESS-JOBS] Claim failed:", err);
    return res.status(500).json({
      error: "Failed to claim jobs",
      code: err.code || err.errno || null,
      detail: String(err.message || "").slice(0, 300),
    });
  }
});

// Targeted dispatch — Cloud Tasks push target (lib/taskQueue.js). One job,
// claimed with the batch's exact predicates; already-claimed is HTTP 200
// (Cloud Tasks retries on any non-2xx, and losing the race to the cron is a
// normal outcome). Malformed id → 400, which Cloud Tasks does NOT retry —
// correct for a request that can never succeed.
router.post("/process-job/:id", jwtOrApiKey, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "invalid job id" });
  }
  try {
    const out = await runJobPass(req.db, { jobId: id });
    res.json(out);
  } catch (err) {
    console.error(`[PROCESS-JOB ${id}] Claim failed:`, err);
    return res.status(500).json({
      error: "Failed to claim job",
      code: err.code || err.errno || null,
      detail: String(err.message || "").slice(0, 300),
    });
  }
});

module.exports = router;
