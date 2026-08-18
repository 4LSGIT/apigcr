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
  // delayed path). Hook/manual/sequence-started executions advance in a
  // detached background call with NO scheduled job — a bare flip stranded
  // them at 'active' forever (observed 7×, 2026-03→2026-08: executions 16,
  // 17, 850, 4850, 5060, 6702, 8336). Each flipped row now also gets an
  // immediate workflow_resume job at its persisted step pointer.
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

router.all("/process-jobs", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const BATCH_SIZE = 10;

  let jobs = [];

  // STEP 1: Atomically claim a batch of due jobs (pure-DB → retries: 3).
  //
  // Why retries: 3 — observed failure mode (7/2026): the MySQL server drops all
  // idle pooled connections at once (PROTOCOL_CONNECTION_LOST); each failed
  // attempt evicts one dead socket from the pool, so a single retry can pull a
  // second corpse and still fail. Three retries drains a small pool of stale
  // sockets and lands on a fresh dial. Claim is pure-DB and rolls back on
  // failure, so extra retries are side-effect-safe.
  try {
    // Housekeeping — must never kill the poll cycle. It re-runs on every poll,
    // so a skipped pass costs at most one minute of recovery delay.
    try {
      await recoverStuckJobs(db);
    } catch (recoveryErr) {
      console.warn(`[PROCESS-JOBS] recoverStuckJobs failed (non-fatal): ${recoveryErr.code || ""} ${recoveryErr.message}`);
    }

    jobs = await db.withTransaction(async (connection) => {
      const [rows] = await connection.query(
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
        [BATCH_SIZE]
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
      stampHeartbeat(db); // fire-and-forget — poll cycle ran (common path)
      return res.json({ processed: 0, results: [] });
    }
  } catch (err) {
    console.error("[PROCESS-JOBS] Claim failed:", err);
    return res.status(500).json({
      error: "Failed to claim jobs",
      code: err.code || err.errno || null,
      detail: String(err.message || "").slice(0, 300),
    });
  }

  // STEP 2: Execute jobs one by one
  const results = [];

  for (const job of jobs) {
    const start = Date.now();
    const attempt = job.attempts + 1;
    const executionNumber = job.execution_count + 1;

    try {
      // SPECIAL CASE: workflow_resume
      // NOTE: Job status is left as 'running' (set in STEP 1) and only
      // updated to 'completed'/'failed' AFTER the detached executor finishes.
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

        // Advance in background (non-blocking).
        // The job's scheduled_jobs.status update happens AFTER advanceWorkflow
        // returns, so a mid-execution crash leaves status='running' for
        // recoverStuckJobs to recover.
        (async () => {
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
        })();

        results.push({
          id: job.id,
          status: 'dispatched',
          note: `Resuming execution ${executionId} at step ${nextStep}`
        });

        continue; // next job in the batch
      }

      // SPECIAL CASE: sequence_step
      // See workflow_resume comment above — same pattern: status stays 'running'
      // until detached executor finishes so a crash doesn't silently drop the step.
      // No claim transaction is needed: there is no pre-dispatch DB write here, so
      // the previous empty begin/commit was a no-op and has been removed.
      if (job.type === 'sequence_step') {
        const data = typeof job.data === 'string' ? JSON.parse(job.data) : job.data;
        const { enrollmentId, stepId, stepNumber } = data || {};

        console.log(`[SEQ STEP] enrollment=${enrollmentId} step=${stepId} n=${stepNumber ?? '-'}`);

        // Execute in background (non-blocking)
        (async () => {
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
        })();

        results.push({
          id:     job.id,
          status: 'dispatched',
          note:   `Sequence step enrollment=${enrollmentId} step=${stepId}`
        });

        continue; // next job in the batch
      }

      // SPECIAL CASE: hook_retry
      // See workflow_resume comment above — same pattern: status stays 'running'
      // until detached executor finishes so a crash doesn't silently drop the retry.
      // No claim transaction is needed: there is no pre-dispatch DB write here, so
      // the previous empty begin/commit was a no-op and has been removed.
      if (job.type === 'hook_retry') {
        const data = typeof job.data === 'string' ? JSON.parse(job.data) : job.data;

        console.log(`[HOOK RETRY] execution=${data.execution_id} target=${data.target_id}`);

        (async () => {
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
        })();

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
      // executeJob runs the external side effect on the pool and is NOT idempotent,
      // so this transaction uses { retries: 0 } — a transient pre-commit failure must
      // not re-run the callback and re-fire it. (Behaviour matches the pre-migration
      // code: on a record-time failure the job is failed and retried on a later poll.)
      const completion = await db.withTransaction(async (conn) => {
        const rawOutput = await executeJob(job, db);
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

  stampHeartbeat(db); // fire-and-forget — poll cycle ran (even if some jobs failed)
  res.json({ processed: jobs.length, results });
});

module.exports = router;