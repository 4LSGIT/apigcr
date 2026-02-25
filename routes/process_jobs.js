// routes/process_jobs.js
const express = require("express");
const router = express.Router();
const axios = require("axios");
const vm = require("vm");
const { CronExpressionParser } = require("cron-parser");
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const internalFunctions = require("../lib/internal_functions");

/**
 * Execute one job
 * IMPORTANT: no DB writes here
 */
async function executeJob(job) {
  let jobData;
  try {
    jobData = typeof job.data === "string" ? JSON.parse(job.data) : job.data;
  } catch (err) {
    throw new Error(`Invalid job.data JSON: ${err.message}`);
  }

  const { type } = jobData;

  if (type === "webhook") {
    const { url, method = "GET", headers = {}, body } = jobData;
    if (!url) throw new Error('Webhook job missing "url"');

    const response = await axios({
      url,
      method,
      headers,
      data: body,
      timeout: 10000,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    return response.data;
  }

  if (type === "internal_function") {
    const { function_name, params = {} } = jobData;
    const fn = internalFunctions[function_name];
    if (!fn) throw new Error(`Unknown internal function: ${function_name}`);
    return await fn(params);
  }

  if (type === "custom_code") {
    const { code, input = {} } = jobData;
    if (!code) throw new Error('Custom code job missing "code"');

    const sandbox = {
      input,
      console: {
        log: (...args) => console.log(`[CUSTOM CODE ${job.id}]`, ...args),
      },
    };

    const script = new vm.Script(code);
    return script.runInNewContext(sandbox, { timeout: 5000 });
  }

  if (type === "workflow_resume") {
    return { note: "Resume stub executed" };
  }

  throw new Error(`Unsupported job type: ${type}`);
}

/**
 * Record job result (success or failure)
 * MUST be called with a transaction connection
 */
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
  // does not change attempts
  const [result] = await db.query(
    `
    UPDATE scheduled_jobs
    SET status = 'pending', updated_at = NOW()
    WHERE status = 'running'
      AND updated_at < NOW() - INTERVAL 10 MINUTE
    `,
  );
  if (result.affectedRows > 0) {
    console.warn(
      `[JOB RECOVERY] Recovered ${result.affectedRows} stuck running jobs`,
    );
  }
}

router.all("/process-jobs", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const BATCH_SIZE = 10; //lowered to fit google cloud run better

  let jobs = [];
  let connection;

  try {
    await recoverStuckJobs(db);
    /**
     * STEP 1: Atomically claim jobs
     */
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
      [BATCH_SIZE],
    );

    if (rows.length === 0) {
      await connection.commit();
      return res.json({ processed: 0, results: [] });
    }

    const jobIds = rows.map((j) => j.id);

    await connection.query(
      `
      UPDATE scheduled_jobs
      SET status = 'running', updated_at = NOW()
      WHERE id IN (?)
      `,
      [jobIds],
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

  /**
   * STEP 2: Execute jobs one by one
   */
  const results = [];

  for (const job of jobs) {
  const start = Date.now();
  const attempt = job.attempts + 1;
  const executionNumber = job.execution_count + 1;

  try {
    const output = await executeJob(job);

    const conn = await db.getConnection();
    await conn.beginTransaction();

    // Record successful attempt
    await recordResult(
      conn,
      job.id,
      executionNumber,
      attempt,
      true,
      output,
      Date.now() - start,
    );

    if (job.type === "recurring") {
      /**
       * RECURRING JOB SUCCESS
       * - finish this run
       * - advance to next schedule
       * - reset attempts
       * - increment execution_count
       */
      await rescheduleRecurring(conn, job);
    } else {
      /**
       * ONE-TIME JOB SUCCESS
       * - job is done forever
       */
      await conn.query(
        `
        UPDATE scheduled_jobs
        SET status='completed', attempts=?, updated_at=NOW(), execution_count = execution_count + 1
        WHERE id=?
        `,
        [attempt, job.id],
      );
    }

    await conn.commit();
    conn.release();

    results.push({
      id: job.id,
      status: job.type === "recurring" ? "advanced" : "completed",
    });

  } catch (err) {
    const conn = await db.getConnection();
    await conn.beginTransaction();

    // Record failed attempt
    await recordResult(
      conn,
      job.id,
      executionNumber,
      attempt,
      false,
      err.message,
      Date.now() - start,
    );

    if (attempt < job.max_attempts) {
      /**
       * RETRY (applies to both job types)
       */
      const delayMs =
        job.backoff_seconds * Math.pow(2, attempt - 1) * 1000;

      const nextTime = new Date(Date.now() + delayMs);

      await conn.query(
        `
        UPDATE scheduled_jobs
        SET status='pending', attempts=?, scheduled_time=?, updated_at=NOW() 
        WHERE id=?
        `,
        [attempt, nextTime, job.id],
      );

      results.push({
        id: job.id,
        status: "retry_scheduled",
        attempt,
        error: err.message,
      });

    } else {
      /**
       * TERMINAL FAILURE
       */
      if (job.type === "recurring") {
        /**
         * RECURRING JOB TERMINAL FAILURE
         * - this run failed permanently
         * - BUT the job continues
         */
        await rescheduleRecurring(conn, job);

        results.push({
          id: job.id,
          status: "advanced_after_failure",
          error: err.message,
        });
      } else {
        /**
         * ONE-TIME JOB TERMINAL FAILURE
         * - job is dead forever
         */
        await conn.query(
          `
          UPDATE scheduled_jobs
          SET status='failed', attempts=?, updated_at=NOW(), execution_count = execution_count + 1
          WHERE id=?
          `,
          [attempt, job.id],
        );

        results.push({
          id: job.id,
          status: "failed",
          error: err.message,
        });
      }
    }

    await conn.commit();
    conn.release();
  }
}


  res.json({ processed: jobs.length, results });
});

module.exports = router;
