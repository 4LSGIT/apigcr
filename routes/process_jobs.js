// routes/process_jobs.js
const express = require("express");
const router = express.Router();
//const axios = require("axios");
//const vm = require("vm");
const { CronExpressionParser } = require("cron-parser");
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
//const internalFunctions = require("../lib/internal_functions");
const { advanceWorkflow } = require("../lib/workflow_engine");
const { executeJob } = require("../lib/job_executor");


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

  const interval = CronExpressionParser.parse(job.recurrence_rule, {
    currentDate: new Date(job.scheduled_time),
  });

  const nextTime = interval.next().toDate();

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
  // Recover stuck scheduled jobs
  const [jobResult] = await db.query(`
    UPDATE scheduled_jobs
    SET status = 'pending', updated_at = NOW()
    WHERE status = 'running'
      AND updated_at < NOW() - INTERVAL 10 MINUTE
  `);
  if (jobResult.affectedRows > 0) {
    console.warn(`[JOB RECOVERY] Recovered ${jobResult.affectedRows} stuck running jobs`);
  }

  // Recover stuck workflow executions (e.g. server crashed mid-execution)
  const [execResult] = await db.query(`
    UPDATE workflow_executions
    SET status = 'active', updated_at = NOW()
    WHERE status = 'processing'
      AND updated_at < NOW() - INTERVAL 10 MINUTE
  `);
  if (execResult.affectedRows > 0) {
    console.warn(`[EXEC RECOVERY] Recovered ${execResult.affectedRows} stuck processing executions`);
  }
}

router.all("/process-jobs", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const BATCH_SIZE = 10;

  let jobs = [];
  let connection;

  try {
    await recoverStuckJobs(db);

    // STEP 1: Atomically claim jobs
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [rows] = await connection.query(
      `
      SELECT *
      FROM scheduled_jobs
      WHERE status = 'pending'
        AND scheduled_time <= NOW()
      ORDER BY scheduled_time
      LIMIT ?
      FOR UPDATE SKIP LOCKED
      `,
      [BATCH_SIZE]
    );

    if (rows.length === 0) {
      await connection.commit();
      return res.json({ processed: 0, results: [] });
    }

    const jobIds = rows.map((j) => j.id);

    await connection.query(
      `UPDATE scheduled_jobs SET status = 'running', updated_at = NOW() WHERE id IN (?)`,
      [jobIds]
    );

    await connection.commit();
    connection.release();
    connection = null;

    jobs = rows;
  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    console.error("[PROCESS-JOBS] Claim failed:", err);
    return res.status(500).json({ error: "Failed to claim jobs" });
  }

  // STEP 2: Execute jobs one by one
  const results = [];

  for (const job of jobs) {
    const start = Date.now();
    const attempt = job.attempts + 1;
    const executionNumber = job.execution_count + 1;

    let conn;
    try {
      conn = await db.getConnection();
      await conn.beginTransaction();

      // SPECIAL CASE: workflow_resume
      if (job.type === 'workflow_resume') {
        const data = typeof job.data === 'string' ? JSON.parse(job.data) : job.data;
        const { nextStep, executionId } = data || {};

        console.log(`[RESUME] Resuming execution ${executionId} at step ${nextStep}`);

        // Update execution
        await conn.query(
          `UPDATE workflow_executions 
           SET status = 'active', current_step_number = ?, updated_at = NOW()
           WHERE id = ?`,
          [nextStep, executionId]
        );

        // Mark this resume job as completed
        await conn.query(
          `UPDATE scheduled_jobs SET status = 'completed', updated_at = NOW() WHERE id = ?`,
          [job.id]
        );

        await conn.commit();
        conn.release();

        // Advance in background (non-blocking)
        (async () => {
          try {
            const advanceResult = await advanceWorkflow(executionId, db);
            console.log(`[RESUME ADVANCE] Execution ${executionId} finished with ${advanceResult.status}`);
          } catch (err) {
            console.error(`[RESUME ADVANCE] Failed for ${executionId}:`, err);
          }
        })();

        results.push({
          id: job.id,
          status: 'completed',
          note: `Resumed execution ${executionId} at step ${nextStep}`
        });

        continue; // next job in the batch
      }

      // NORMAL JOB TYPES (webhook, internal_function, custom_code)
      const output = await executeJob(job);

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

      await conn.commit();
      conn.release();

      results.push({
        id: job.id,
        status: job.type === "recurring" ? "advanced" : "completed",
      });

    } catch (err) {
      if (conn) {
        await conn.rollback();
        conn.release();
      }

      // Record failed attempt — conn2 is in its own try/finally so the
      // connection is always released even if recording or rescheduling throws.
      const conn2 = await db.getConnection();
      try {
        await conn2.beginTransaction();

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

          results.push({
            id: job.id,
            status: "retry_scheduled",
            attempt,
            error: err.message,
          });
        } else {
          if (job.type === "recurring") {
            await rescheduleRecurring(conn2, job);
            results.push({
              id: job.id,
              status: "advanced_after_failure",
              error: err.message,
            });
          } else {
            await conn2.query(
              `
              UPDATE scheduled_jobs
              SET status='failed', attempts=?, updated_at=NOW(), execution_count = execution_count + 1
              WHERE id=?
              `,
              [attempt, job.id]
            );
            results.push({
              id: job.id,
              status: "failed",
              error: err.message,
            });
          }
        }

        await conn2.commit();
      } catch (recordErr) {
        await conn2.rollback();
        console.error(`[PROCESS-JOBS] Failed to record result for job ${job.id}:`, recordErr);
        results.push({ id: job.id, status: "failed", error: err.message });
      } finally {
        conn2.release();
      }
    }
  }

  res.json({ processed: jobs.length, results });
});

module.exports = router;