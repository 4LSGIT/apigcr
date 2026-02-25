// routes/scheduled_jobs.js
const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const ms = require("ms"); // npm install ms - for parsing "5m", "2h", etc.

// Helper: parse delay string to milliseconds
function parseDelay(delayStr) {
  if (!delayStr) return 5000; // default 5 seconds
  const parsed = ms(delayStr);
  if (parsed === undefined) {
    throw new Error(`Invalid delay format: "${delayStr}". Examples: 30s, 5m, 2h, 1d`);
  }
  return parsed;
}

router.post("/scheduled-jobs", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const {
    type,               // required: "one_time" | "recurring"
    job_type,           // required: "webhook" | "internal_function" | "custom_code"
    name,               // optional but recommended
    delay,              // string e.g. "10m", "1h", "30s" - from now
    scheduled_time,     // ISO string e.g. "2026-02-15T14:30:00Z"
    recurrence_rule,    // cron string, only used if type = "recurring"
    max_attempts = 3,
    backoff_seconds = 300,

    // job-specific payload
    url, method = "GET", headers = {}, body,           // webhook
    function_name, params = {},                        // internal_function
    code, input = {},                                  // custom_code
  } = req.body;

  // --------------
  // 1. Validation
  // --------------

  if (!["one_time", "recurring"].includes(type)) {
    return res.status(400).json({ error: "type must be 'one_time' or 'recurring'" });
  }

  if (!["webhook", "internal_function", "custom_code"].includes(job_type)) {
    return res.status(400).json({ error: "job_type must be webhook, internal_function or custom_code" });
  }

  // Build job.data
  let jobData = { type: job_type };

  if (job_type === "webhook") {
    if (!url) return res.status(400).json({ error: "url is required for webhook" });
    jobData.url = url;
    jobData.method = method;
    jobData.headers = headers;
    jobData.body = body;
  } else if (job_type === "internal_function") {
    if (!function_name) return res.status(400).json({ error: "function_name is required" });
    jobData.function_name = function_name;
    jobData.params = params;
  } else if (job_type === "custom_code") {
    if (!code) return res.status(400).json({ error: "code is required" });
    jobData.code = code;
    jobData.input = input;
  }

  // --------------
  // 2. Calculate scheduled_time
  // --------------

  let finalScheduledTime;

  if (scheduled_time) {
    // Prefer explicit datetime
    const dt = new Date(scheduled_time);
    if (isNaN(dt.getTime())) {
      return res.status(400).json({ error: "Invalid scheduled_time format (use ISO)" });
    }
    finalScheduledTime = dt;
  } else if (delay) {
    // Parse human duration
    const msDelay = parseDelay(delay);
    finalScheduledTime = new Date(Date.now() + msDelay);
  } else {
    // Default: very soon
    finalScheduledTime = new Date(Date.now() + 5000);
  }

  // --------------
  // 3. Insert
  // --------------

  try {
    const [result] = await db.query(
      `
      INSERT INTO scheduled_jobs
      (type, scheduled_time, status, name, data, recurrence_rule, max_attempts, backoff_seconds)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
      `,
      [
        type,
        finalScheduledTime,
        name || `${job_type} job`,
        JSON.stringify(jobData),
        type === "recurring" ? recurrence_rule : null,
        max_attempts,
        backoff_seconds,
      ]
    );

    res.status(201).json({
      id: result.insertId,
      message: "Job created",
      scheduled_time: finalScheduledTime.toISOString(),
      type,
      job_type,
    });
  } catch (err) {
    console.error("Failed to create job:", err);
    res.status(500).json({ error: "Failed to create job", detail: err.message });
  }
});




// GET /scheduled-jobs/:id
router.get("/scheduled-jobs/:id", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const includeHistory = req.query.history === "true";

  try {
    // 1. Get job metadata
    const [jobs] = await db.query(
      `SELECT * FROM scheduled_jobs WHERE id = ?`,
      [id]
    );

    if (jobs.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    const job = jobs[0];

    // Parse JSON data field
    let parsedData = job.data;
    try {
      parsedData = typeof job.data === "string"
        ? JSON.parse(job.data)
        : job.data;
    } catch (err) {
      parsedData = null;
    }

    // 2. Get execution stats
    const [statsRows] = await db.query(
      `
      SELECT 
        COUNT(*) AS total_runs,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS total_failures
      FROM job_results
      WHERE job_id = ?
      `,
      [id]
    );

    const stats = statsRows[0];

    // 3. Get latest execution
    const [latestRows] = await db.query(
      `
      SELECT *
      FROM job_results
      WHERE job_id = ?
      ORDER BY execution_number DESC, attempt DESC
      LIMIT 1
      `,
      [id]
    );

    let latestExecution = null;

    if (latestRows.length > 0) {
      latestExecution = latestRows[0];

      if (latestExecution.output_data) {
        try {
          latestExecution.output_data =
            typeof latestExecution.output_data === "string"
              ? JSON.parse(latestExecution.output_data)
              : latestExecution.output_data;
        } catch {
          latestExecution.output_data = null;
        }
      }
    }

    // 4. Optional full history
    let history = undefined;

    if (includeHistory) {
      const [historyRows] = await db.query(
        `
        SELECT *
        FROM job_results
        WHERE job_id = ?
        ORDER BY execution_number DESC, attempt DESC
        `,
        [id]
      );

      history = historyRows.map((row) => {
        if (row.output_data) {
          try {
            row.output_data =
              typeof row.output_data === "string"
                ? JSON.parse(row.output_data)
                : row.output_data;
          } catch {
            row.output_data = null;
          }
        }
        return row;
      });
    }

    // 5. Response
    res.json({
      id: job.id,
      name: job.name,
      type: job.type,
      status: job.status,
      scheduled_time: job.scheduled_time,
      recurrence_rule: job.recurrence_rule,
      attempts: job.attempts,
      max_attempts: job.max_attempts,
      backoff_seconds: job.backoff_seconds,
      execution_count: job.execution_count,
      created_at: job.created_at,
      updated_at: job.updated_at,

      data: parsedData,

      stats: {
        total_runs: stats.total_runs || 0,
        total_failures: stats.total_failures || 0,
      },

      latest_execution: latestExecution,

      ...(includeHistory && { history }),
    });

  } catch (err) {
    console.error("Failed to fetch job:", err);
    res.status(500).json({
      error: "Failed to fetch job",
      detail: err.message,
    });
  }
});

module.exports = router;