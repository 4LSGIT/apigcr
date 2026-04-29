// routes/scheduled_jobs.js
const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const ms = require("ms"); //  for parsing "5m", "2h", etc.

// Helper: parse delay string to milliseconds
function parseDelay(delayStr) {
  if (!delayStr) return 5000; // default 5 seconds
  const parsed = ms(delayStr);
  if (parsed === undefined) {
    throw new Error(`Invalid delay format: "${delayStr}". Examples: 30s, 5m, 2h, 1d`);
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────
// Webhook job-data validation — shared by POST and PATCH.
//
// Mirrors the webhook validation in routes/workflows.js and
// routes/sequences.js (same allowed methods, same FK check on
// credential_id, same timeout cap). Kept local rather than imported
// because each engine's route file is the natural validation seam
// for its own create/update endpoints.
//
// `data` is the parsed jobData object (NOT the JSON string column).
// Returns null on success, or { status, error } on failure.
// ─────────────────────────────────────────────────────────────

const ALLOWED_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const PLACEHOLDER_RE = /\{\{.*?\}\}/;
const MAX_TIMEOUT_MS = 120000;

async function validateWebhookJobData(db, data) {
  if (!data || typeof data !== 'object') return null; // not our concern
  if (data.type !== 'webhook') return null;

  const { url, method, credential_id, headers, body, timeout_ms } = data;

  if (!url || typeof url !== 'string' || !url.trim()) {
    return { status: 400, error: 'webhook job: url is required (non-empty string)' };
  }
  // Allow {{...}} for forward-compat — scheduled jobs don't currently resolve
  // placeholders in URLs, but the syntax is harmless and matches the workflow
  // and sequence webhook routes.
  if (!PLACEHOLDER_RE.test(url)) {
    try { new URL(url); }
    catch { return { status: 400, error: `webhook job: url is not a valid URL: ${url}` }; }
  }
  if (method !== undefined && method !== null && method !== '') {
    const m = String(method).toUpperCase();
    if (!ALLOWED_HTTP_METHODS.includes(m)) {
      return { status: 400, error: `webhook job: method must be one of ${ALLOWED_HTTP_METHODS.join(', ')}` };
    }
  }
  if (credential_id !== undefined && credential_id !== null && credential_id !== '') {
    const n = Number(credential_id);
    if (!Number.isInteger(n) || n <= 0) {
      return { status: 400, error: 'webhook job: credential_id must be a positive integer' };
    }
    const [[row]] = await db.query(`SELECT id FROM credentials WHERE id = ?`, [n]);
    if (!row) {
      return { status: 400, error: `webhook job: credential_id ${n} does not exist in credentials table` };
    }
  }
  if (headers !== undefined && headers !== null) {
    if (typeof headers !== 'object' || Array.isArray(headers)) {
      return { status: 400, error: 'webhook job: headers must be a JSON object' };
    }
  }
  // body intentionally permissive — object, array, string, number all OK
  if (timeout_ms !== undefined && timeout_ms !== null) {
    const n = Number(timeout_ms);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_TIMEOUT_MS) {
      return { status: 400, error: `webhook job: timeout_ms must be a positive integer <= ${MAX_TIMEOUT_MS}` };
    }
  }
  return null;
}

router.post("/scheduled-jobs", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const {
    type,               // required: "one_time" | "recurring"
    job_type,           // required: "webhook" | "internal_function" | "custom_code"
    name,               // optional but recommended
    delay,              // string e.g. "10m", "1h", "30s" - from now
    scheduled_time,     // ISO string e.g. "2026-02-15T14:30:00Z"
    timezone,
    recurrence_rule,    // cron string, only used if type = "recurring"
    max_attempts = 3,
    backoff_seconds = 300,
    max_executions = null,  // optional: stop after N successful executions
    expires_at = null,      // optional: stop after this datetime (ISO string)

    // job-specific payload
    url, method = "GET", headers = {}, body,           // webhook
    credential_id,                                     // webhook (optional, FK → credentials.id)
    timeout_ms,                                        // webhook (optional, capped at 120000ms)
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

  if (max_executions !== null && (isNaN(parseInt(max_executions)) || parseInt(max_executions) < 1)) {
    return res.status(400).json({ error: "max_executions must be a positive integer" });
  }

  let finalExpiresAt = null;
  if (expires_at) {
    finalExpiresAt = new Date(expires_at);
    if (isNaN(finalExpiresAt.getTime())) {
      return res.status(400).json({ error: "expires_at must be a valid ISO datetime" });
    }
  }

  // Build job.data
  let jobData = { type: job_type };

  if (job_type === "webhook") {
    // Bare presence/string check first — validateWebhookJobData below does the
    // full check including URL parse, method enum, credential FK, timeout cap.
    if (!url) return res.status(400).json({ error: "url is required for webhook" });
    jobData.url = url;
    jobData.method = method;
    jobData.headers = headers;
    jobData.body = body;
    if (credential_id !== undefined && credential_id !== null && credential_id !== '') {
      // Coerce to integer here — validation below confirms FK
      jobData.credential_id = parseInt(credential_id, 10);
    }
    if (timeout_ms !== undefined && timeout_ms !== null && timeout_ms !== '') {
      jobData.timeout_ms = parseInt(timeout_ms, 10);
    }

    const v = await validateWebhookJobData(db, jobData);
    if (v) return res.status(v.status).json({ error: v.error });
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
    // If timezone is provided, interpret scheduled_time in that timezone and convert to UTC.
    // If no timezone, assume the value is already UTC (backward compatible).
    if (timezone) {
      const { DateTime } = require('luxon');
      const naive = scheduled_time.replace('T', ' ').replace('Z', '').slice(0, 19);
      const localDt = DateTime.fromSQL(naive, { zone: timezone });
      if (!localDt.isValid) {
        return res.status(400).json({ error: `Invalid scheduled_time or timezone: "${scheduled_time}" in "${timezone}"` });
      }
      finalScheduledTime = localDt.toUTC().toJSDate();
      console.log(`[SCHEDULED-JOBS] Converted ${naive} ${timezone} → ${finalScheduledTime.toISOString()} UTC`);
    } else {
      const dt = new Date(scheduled_time);
      if (isNaN(dt.getTime())) {
        return res.status(400).json({ error: "Invalid scheduled_time format (use ISO)" });
      }
      finalScheduledTime = dt;
    }
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
      (type, scheduled_time, status, name, data, recurrence_rule, max_attempts, backoff_seconds, max_executions, expires_at)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        type,
        finalScheduledTime,
        name || `${job_type} job`,
        JSON.stringify(jobData),
        type === "recurring" ? recurrence_rule : null,
        max_attempts,
        backoff_seconds,
        max_executions ? parseInt(max_executions) : null,
        finalExpiresAt || null,
      ]
    );

    res.status(201).json({
      id: result.insertId,
      message: "Job created",
      scheduled_time: finalScheduledTime.toISOString(),
      type,
      job_type,
      max_executions: max_executions ? parseInt(max_executions) : null,
      expires_at: finalExpiresAt ? finalExpiresAt.toISOString() : null,
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

      max_executions:  job.max_executions || null,
      expires_at:      job.expires_at || null,

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

// ─────────────────────────────────────────────────────────────
// GET /scheduled-jobs — list jobs
// ─────────────────────────────────────────────────────────────
router.get("/scheduled-jobs", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { status, type, page = 1, limit = 30, search } = req.query;
  const offset   = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit));
  const limitInt = Math.min(100, Math.max(1, parseInt(limit)));

  try {
    let query  = `SELECT id, type, status, name, scheduled_time, recurrence_rule,
                    attempts, max_attempts, execution_count, created_at, updated_at
                  FROM scheduled_jobs WHERE 1=1`;
    const params = [];

    if (status) { query += ` AND status = ?`;         params.push(status); }
    if (type)   { query += ` AND type = ?`;           params.push(type); }
    if (search) { query += ` AND name LIKE ?`;        params.push(`%${search}%`); }

    // Hide internal workflow/sequence jobs from the list by default
    if (!req.query.internal) {
      query += ` AND type NOT IN ('workflow_resume', 'sequence_step')`;
    }

    query += ` ORDER BY scheduled_time DESC LIMIT ? OFFSET ?`;
    params.push(limitInt, offset);

    const [rows] = await db.query(query, params);

    const countQuery  = query.replace(/SELECT .* FROM/, 'SELECT COUNT(*) as total FROM').replace(/ORDER BY.*$/, '');
    const countParams = params.slice(0, -2);
    const [[{ total }]] = await db.query(countQuery, countParams);

    res.json({
      success: true,
      jobs: rows,
      pagination: { page: parseInt(page), limit: limitInt, total, totalPages: Math.ceil(total / limitInt) }
    });
  } catch (err) {
    console.error("Failed to list jobs:", err);
    res.status(500).json({ error: "Failed to list jobs", detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /scheduled-jobs/:id — edit a job
// Only pending/failed jobs can be edited.
// ─────────────────────────────────────────────────────────────
router.patch("/scheduled-jobs/:id", jwtOrApiKey, async (req, res) => {
  const db  = req.db;
  const { id } = req.params;
  const { name, scheduled_time, timezone, recurrence_rule, max_attempts, backoff_seconds, data, max_executions, expires_at } = req.body;

  try {
    const [[job]] = await db.query(`SELECT id, status, type FROM scheduled_jobs WHERE id = ?`, [id]);
    if (!job) return res.status(404).json({ error: "Job not found" });

    if (!['pending', 'failed'].includes(job.status)) {
      return res.status(409).json({
        error: `Cannot edit a job with status '${job.status}'. Only pending or failed jobs can be edited.`
      });
    }

    const updates = [];
    const params  = [];

    if (name             !== undefined) { updates.push("name = ?");             params.push(name); }
    if (scheduled_time   !== undefined) {
      let dt;
      if (timezone) {
        const { DateTime } = require('luxon');
        const naive = scheduled_time.replace('T', ' ').replace('Z', '').slice(0, 19);
        const localDt = DateTime.fromSQL(naive, { zone: timezone });
        if (!localDt.isValid) return res.status(400).json({ error: `Invalid scheduled_time or timezone` });
        dt = localDt.toUTC().toJSDate();
      } else {
        dt = new Date(scheduled_time);
        if (isNaN(dt.getTime())) return res.status(400).json({ error: "Invalid scheduled_time" });
      }
      updates.push("scheduled_time = ?"); params.push(dt);
    }
    if (recurrence_rule  !== undefined) { updates.push("recurrence_rule = ?");  params.push(recurrence_rule); }
    if (max_attempts     !== undefined) { updates.push("max_attempts = ?");     params.push(parseInt(max_attempts)); }
    if (backoff_seconds  !== undefined) { updates.push("backoff_seconds = ?");  params.push(parseInt(backoff_seconds)); }
    if (data             !== undefined) {
      // Validate webhook job-data shape if the new data IS a webhook payload.
      // Non-webhook data (internal_function, custom_code) passes through with
      // existing permissive behavior — those types weren't validated before
      // and aren't part of this slice.
      const v = await validateWebhookJobData(db, data);
      if (v) return res.status(v.status).json({ error: v.error });
      updates.push("data = ?"); params.push(JSON.stringify(data));
    }
    if (max_executions   !== undefined) { updates.push("max_executions = ?");   params.push(max_executions !== null ? parseInt(max_executions) : null); }
    if (expires_at       !== undefined) {
      const dt = expires_at ? new Date(expires_at) : null;
      if (dt && isNaN(dt.getTime())) return res.status(400).json({ error: "Invalid expires_at" });
      updates.push("expires_at = ?"); params.push(dt || null);
    }

    if (!updates.length) return res.status(400).json({ error: "Nothing to update" });

    // If rescheduling a failed job, reset it to pending
    if (scheduled_time && job.status === 'failed') {
      updates.push("status = 'pending'");
      updates.push("attempts = 0");
    }

    params.push(id);
    await db.query(
      `UPDATE scheduled_jobs SET ${updates.join(", ")}, updated_at = NOW() WHERE id = ?`,
      params
    );

    res.json({ success: true, id: parseInt(id), message: "Job updated" });
  } catch (err) {
    console.error("Failed to edit job:", err);
    res.status(500).json({ error: "Failed to edit job", detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /scheduled-jobs/:id — cancel/delete a job
// Pending jobs → deleted. Running/completed/failed → marked cancelled (status update).
// ─────────────────────────────────────────────────────────────
router.delete("/scheduled-jobs/:id", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  try {
    const [[job]] = await db.query(`SELECT id, status, type FROM scheduled_jobs WHERE id = ?`, [id]);
    if (!job) return res.status(404).json({ error: "Job not found" });

    // Don't allow deleting internal engine jobs
    if (['workflow_resume', 'sequence_step'].includes(job.type)) {
      return res.status(403).json({ error: "Cannot delete internal engine jobs directly" });
    }

    if (job.status === 'pending') {
      await db.query(`DELETE FROM scheduled_jobs WHERE id = ?`, [id]);
      return res.json({ success: true, action: "deleted", message: "Pending job deleted" });
    }

    // For running/completed/failed — just mark as failed so it won't run again
    await db.query(
      `UPDATE scheduled_jobs SET status = 'failed', updated_at = NOW() WHERE id = ?`, [id]
    );
    res.json({ success: true, action: "cancelled", message: `Job marked as failed (was ${job.status})` });
  } catch (err) {
    console.error("Failed to delete job:", err);
    res.status(500).json({ error: "Failed to delete job", detail: err.message });
  }
});


module.exports = router;