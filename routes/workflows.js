// routes/workflows.js
const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const {
  advanceWorkflow,
  executeSingleStep,
  resolvePlaceholders,
  resolveSingle,
  resolveExecutionContactId,
  InvalidContactIdError,
} = require("../lib/workflow_engine");
const { executeJob } = require("../lib/job_executor");
// JSON columns may come back from mysql2 as either a string (unparsed)
// or a parsed object depending on driver version/config. Normalize to a
// string for INSERT so mysql2 doesn't SET-expand objects.
const toJson = v => v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v));

// ─────────────────────────────────────────────────────────────
// Slice 2.1 — test_input validation helper.
//
// workflows.test_input is authorial documentation of the init_data shape a
// workflow expects. Nullable; no runtime validation against it at start
// time. At save time we only check shape: must be absent/null/undefined, or
// a plain JSON object (not an array, not a primitive).
//
// Returns null on success, or { status, error } on failure — caller handles
// res.status(...).json(...).
// ─────────────────────────────────────────────────────────────
function validateTestInput(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    return {
      status: 400,
      error: 'test_input must be a JSON object or null (arrays and primitives are not accepted)',
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Internal-function param validation — metadata-driven
//
// Save-time validation for the params block of an `internal_function` step.
// Drives off __meta blocks defined in lib/internal_functions.js — see the
// schema notes there. This file owns the specialized parse-checks for
// iso_datetime and duration types because they require parseUserDateTime
// and ms() which we already have imported here.
//
// Functions without __meta are passed through (engine validates at run
// time, same as before this slice).
//
// Returns null on success, or { status, error } on failure.
// ─────────────────────────────────────────────────────────────

const { parseUserDateTime } = require("../services/timezoneService");
const ms = require("ms");
const internalFunctions = require("../lib/internal_functions");

const PLACEHOLDER_RE = /\{\{[^}]+\}\}/;

function _wfHasPlaceholder(s) {
  return typeof s === 'string' && PLACEHOLDER_RE.test(s);
}

// iso_datetime fields accept three string shapes at runtime: date-leading
// strings (parseUserDateTime), duration strings (ms()), and plain numbers
// (ms-from-now). Validate accordingly when not a placeholder.
function _wfValidateIsoDatetimeString(label, v) {
  if (typeof v === 'number') return null;
  if (typeof v !== 'string') return { error: `${label} must be a string or number` };
  if (_wfHasPlaceholder(v)) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    try {
      const parsed = parseUserDateTime(v);
      if (!parsed) return { error: `${label} is empty after trim: "${v}"` };
    } catch (err) {
      return { error: `${label}: ${err.message}` };
    }
    return null;
  }
  if (ms(v) === undefined) {
    return { error: `${label}: "${v}" is not a valid duration or datetime (use "30s","10m","2h","1d", or an ISO datetime like "2026-05-01T14:30:00")` };
  }
  return null;
}

function _wfValidateDurationString(label, v) {
  if (typeof v === 'number') return null;
  if (typeof v !== 'string') return { error: `${label} must be a duration string or number` };
  if (_wfHasPlaceholder(v)) return null;
  if (ms(v) === undefined) {
    return { error: `${label}: "${v}" is not a valid duration (use "30s","10m","2h","1d", or a millisecond number)` };
  }
  return null;
}

function validateInternalFunctionParams(functionName, params) {
  if (!functionName) return null;
  if (params == null) return null; // function-level required-field check happens elsewhere/runtime

  const meta = internalFunctions.__getMeta(functionName);
  if (!meta) {
    // No metadata — preserve legacy permissive behavior (engine validates at run time)
    if (typeof params !== 'object' || Array.isArray(params)) {
      return { status: 400, error: 'params must be a JSON object' };
    }
    return null;
  }

  // Phase 1 — generic shape/type/group validation
  const metaErr = internalFunctions.__validateParamsAgainstMeta(meta, params);
  if (metaErr) return { status: 400, error: metaErr.error };

  // Phase 2 — specialized parse-checks for iso_datetime / duration string forms
  if (typeof params !== 'object' || params === null) return null; // already validated above
  for (const spec of meta.params) {
    if (!(spec.name in params)) continue;
    const v = params[spec.name];
    if (v === null || v === '' || v === 'null') continue; // nullishSkipsBlock handled by phase 1

    if (spec.type === 'iso_datetime') {
      const err = _wfValidateIsoDatetimeString(`${functionName} params.${spec.name}`, v);
      if (err) return { status: 400, error: err.error };
    } else if (spec.type === 'duration') {
      const err = _wfValidateDurationString(`${functionName} params.${spec.name}`, v);
      if (err) return { status: 400, error: err.error };
    }
  }

  return null;
}

/**
 * Convenience wrapper: validates an `internal_function` step's config block.
 * Skips silently for non-`internal_function` step types (those preserve
 * existing permissive behavior).
 */
function validateInternalFunctionConfig(stepType, config) {
  if (stepType !== 'internal_function') return null;
  if (config == null || typeof config !== 'object') return null;
  return validateInternalFunctionParams(config.function_name, config.params);
}

// ─────────────────────────────────────────────────────────────
// Webhook step config validation — async because credential FK check.
//
// Mirrors routes/sequences.js validateStepConfig 'webhook' branch and
// routes/scheduled_jobs.js validateWebhookJobData. Single source of truth
// would be nice but each engine has different config shapes (sequences put
// it in action_config, workflows in step.config, scheduled jobs in job
// data) so the gathering differs even though the field-level rules are
// identical. Kept duplicated rather than abstracted for readability.
//
// Returns null on success, or { status, error } on failure.
// ─────────────────────────────────────────────────────────────

const ALLOWED_HTTP_METHODS_WF = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MAX_TIMEOUT_MS_WF = 120000;

async function validateWebhookConfig(db, type, config) {
  if (type !== 'webhook') return null;
  if (config == null || typeof config !== 'object') return null;

  const { url, method, credential_id, headers, body, timeout_ms } = config;

  if (!url || typeof url !== 'string' || !url.trim()) {
    return { status: 400, error: 'webhook config.url is required (non-empty string)' };
  }
  // URL parse-check: skip if it has placeholders, since the universal resolver
  // runs at execution time (same pattern as sequence webhook validation).
  if (!/\{\{.*?\}\}/.test(url)) {
    try { new URL(url); }
    catch { return { status: 400, error: `webhook config.url is not a valid URL: ${url}` }; }
  }
  if (method !== undefined && method !== null && method !== '') {
    const m = String(method).toUpperCase();
    if (!ALLOWED_HTTP_METHODS_WF.includes(m)) {
      return { status: 400, error: `webhook config.method must be one of ${ALLOWED_HTTP_METHODS_WF.join(', ')}` };
    }
  }
  if (credential_id !== undefined && credential_id !== null && credential_id !== '') {
    const n = Number(credential_id);
    if (!Number.isInteger(n) || n <= 0) {
      return { status: 400, error: 'webhook config.credential_id must be a positive integer' };
    }
    const [[row]] = await db.query(`SELECT id FROM credentials WHERE id = ?`, [n]);
    if (!row) {
      return { status: 400, error: `webhook config.credential_id ${n} does not exist in credentials table` };
    }
  }
  if (headers !== undefined && headers !== null) {
    if (typeof headers !== 'object' || Array.isArray(headers)) {
      return { status: 400, error: 'webhook config.headers must be a JSON object' };
    }
  }
  // body intentionally permissive — object, array, string, number all OK
  if (timeout_ms !== undefined && timeout_ms !== null) {
    const n = Number(timeout_ms);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_TIMEOUT_MS_WF) {
      return { status: 400, error: `webhook config.timeout_ms must be a positive integer <= ${MAX_TIMEOUT_MS_WF}` };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// GET /workflows/functions — list available internal functions
// Used by the workflow/sequence editors to populate dropdowns dynamically.
// The sequence list is META-DRIVEN: functions carrying __meta.workflowOnly
// are excluded (workflow control flow / timing / variable manipulation live
// in the engine; sequences have their own timing). Functions WITHOUT meta
// default to sequence-eligible. There is no hardcoded exclusion list —
// declare workflowOnly: true on the function's __meta instead.
// MUST be defined before any /:id routes to avoid param capture
// ─────────────────────────────────────────────────────────────

router.get('/workflows/functions', jwtOrApiKey, (req, res) => {
  // Filter out the __-prefixed helpers (validateParamsAgainstMeta, getMeta, getAllMeta)
  // added alongside the metadata registry — those aren't callable functions.
  const meta = internalFunctions.__getAllMeta();
  const allFunctions = Object.keys(internalFunctions).filter(
    name => typeof internalFunctions[name] === 'function' && !name.startsWith('__')
  );
  res.json({
    success: true,
    workflow: allFunctions,
    sequence: allFunctions.filter(f => !(meta[f] && meta[f].workflowOnly)),
    meta,
  });
});

/**
 * POST /workflows/:id/start
 * Starts a new execution of the workflow.
 *
 * Body shapes accepted:
 *   1. Wrapped:  { init_data: { ... }, contact_id?: N }
 *               ─ initData = body.init_data (or body.initData)
 *               ─ body.contact_id at TOP LEVEL is the explicit contact-id
 *                 override (Slice 4.3 Part B). Only honored in wrapped form;
 *                 see (2) for why.
 *   2. Flat:     { contactName: "...", anyOtherField: ... }
 *               ─ the entire body IS the init_data (backward-compat shape).
 *               ─ contact_id is NOT extracted from flat bodies — doing so
 *                 would silently strip it from init_data for legacy callers.
 *                 Flat callers can still contact-tie via the template's
 *                 `default_contact_id_from` (set on the workflow row).
 *
 * contact_id precedence (handled by resolveExecutionContactId):
 *   explicit wrapped body.contact_id > workflow.default_contact_id_from > NULL
 *
 * Returns the new execution ID and kicks off advanceWorkflow in the background.
 */
router.post("/workflows/:id/start", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  // Detect wrapped body. A body with either `init_data` or `initData` at the
  // top level is treated as wrapped; the rest of the top-level keys are
  // out-of-band (and only `contact_id` is interpreted there).
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const isWrapped = Object.prototype.hasOwnProperty.call(body, 'init_data') ||
                    Object.prototype.hasOwnProperty.call(body, 'initData');

  const initData = isWrapped
    ? (body.init_data || body.initData || {})
    : body;

  // Explicit contact_id override — wrapped-body only. Flat bodies never
  // produce an explicit override; they can still be contact-tied via the
  // template default.
  const explicitContactId = isWrapped ? body.contact_id : undefined;

  console.log(`[START] Received payload (wrapped=${isWrapped}):`, JSON.stringify(initData, null, 2));

  const workflowId = parseInt(id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Load id + default_contact_id_from in one shot. Adding the column to the
    // SELECT is cheap; skipping it would force a separate round-trip.
    const [wfRows] = await connection.query(
      `SELECT id, active, default_contact_id_from FROM workflows WHERE id = ?`,
      [workflowId]
    );
    if (wfRows.length === 0) {
      return { respond: { status: 404, body: { error: "Workflow not found" } } };
    }
    const workflow = wfRows[0];

    // Inactive workflows cannot be started — manual or otherwise. Toggle the
    // workflow active in the editor first.
    if (!workflow.active) {
      return { respond: { status: 409, body: { error: "Workflow is inactive", message: "Activate the workflow before starting it." } } };
    }

    // Resolve contact_id via the shared helper. Throws on invalid explicit
    // override; we translate to a 400 below.
    let contactId;
    try {
      contactId = resolveExecutionContactId({
        explicitContactId,
        initData,
        defaultKey: workflow.default_contact_id_from,
      });
    } catch (e) {
      if (e instanceof InvalidContactIdError) {
        return { respond: { status: 400, body: { error: "Invalid contact_id", message: e.message } } };
      }
      throw e;
    }

    const [result] = await connection.query(
      `
      INSERT INTO workflow_executions
      (workflow_id, contact_id, status, init_data, variables, current_step_number)
      VALUES (?, ?, 'active', ?, ?, 1)
      `,
      [workflowId, contactId, JSON.stringify(initData), JSON.stringify(initData)]
    );

      return { executionId: result.insertId, contactId };
    });

    if (outcome.respond) {
      return res.status(outcome.respond.status).json(outcome.respond.body);
    }

    const { executionId, contactId } = outcome;

    res.status(202).json({
      success: true,
      executionId,
      workflowId,
      contactId,     // echo back so callers can verify the resolved value
      status: "processing",
      message: "Workflow execution started and is now processing"
    });

    // Background advance — no timeout needed; recoverStuckJobs handles hangs
    (async () => {
      try {
        const advanceResult = await advanceWorkflow(executionId, db);
        console.log(`[ASYNC ADVANCE] Completed: ${advanceResult.status}`);
      } catch (err) {
        console.error(`[ASYNC ADVANCE] Failed for execution ${executionId}:`, err.message);
      }
    })();

  } catch (err) {
    console.error(`[START] Failed:`, err);
    res.status(500).json({ error: "Failed to start workflow", message: err.message });
  }
});



// routes/workflows.js (add to existing router)
router.get("/executions", jwtOrApiKey, async (req, res) => {
  const db = req.db;

  // Query params with defaults
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const status = req.query.status || null;
  const workflowId = req.query.workflow_id ? parseInt(req.query.workflow_id) : null;
  const search = req.query.search || null; // basic text search on name/variables

  try {
    let query = `
      SELECT 
        e.id, e.workflow_id, w.name as workflow_name, e.status, 
        e.current_step_number, e.steps_executed_count,
        e.created_at, e.updated_at, e.completed_at,
        JSON_LENGTH(e.variables) as variable_count
      FROM workflow_executions e
      LEFT JOIN workflows w ON e.workflow_id = w.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ` AND e.status = ?`;
      params.push(status);
    }
    if (workflowId) {
      query += ` AND e.workflow_id = ?`;
      params.push(workflowId);
    }
    if (search) {
      query += ` AND (w.name LIKE ? OR JSON_SEARCH(e.variables, 'one', ?) IS NOT NULL)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ` ORDER BY e.created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const [rows] = await db.query(query, params);

    // Total count for pagination — must include the JOIN when search is active
    // because the WHERE clause references w.name
    const [countRows] = await db.query(
      `SELECT COUNT(*) as total FROM workflow_executions e` +
      (search ? ` LEFT JOIN workflows w ON e.workflow_id = w.id` : '') +
      ` WHERE 1=1` +
      (status ? ` AND e.status = ?` : '') +
      (workflowId ? ` AND e.workflow_id = ?` : '') +
      (search ? ` AND (w.name LIKE ? OR JSON_SEARCH(e.variables, 'one', ?) IS NOT NULL)` : ''),
      params.slice(0, -2) // exclude limit/offset
    );

    const total = countRows[0].total;

    // Flat envelope: { success, executions, total }. Matches the per-workflow
    // sibling (`GET /workflows/:id/executions`) and every cross-engine list
    // endpoint added since. Grep of the frontend (workflows.html, contact2.html,
    // automationManager.html sub-pages) turned up no consumer of the prior
    // `pagination: { page, limit, total, totalPages }` envelope — the single
    // live caller (`workflows.html` executions tab) hits the per-workflow
    // sibling, not this one. See Cookbook §3.9.
    res.json({
      success: true,
      executions: rows,
      total,
    });
  } catch (err) {
    console.error("[GET EXECUTIONS] Failed:", err);
    res.status(500).json({ error: "Failed to list executions", message: err.message });
  }
});




router.get("/executions/:id", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const includeHistory = req.query.history === "true";

  const executionId = parseInt(id, 10);
  if (isNaN(executionId) || executionId <= 0) {
    return res.status(400).json({ error: "Invalid execution ID" });
  }

  try {
    // Execution details
    const [execRows] = await db.query(
      `
      SELECT 
        e.*, w.name as workflow_name
      FROM workflow_executions e
      LEFT JOIN workflows w ON e.workflow_id = w.id
      WHERE e.id = ?
      `,
      [executionId]
    );

    if (execRows.length === 0) {
      return res.status(404).json({ error: "Execution not found" });
    }

    const execution = execRows[0];

    // Optional: full step history
    let history = null;
    if (includeHistory) {
      // LEFT JOIN: steps can be deleted after execution — ws.* is NULL then,
      // and the step_label fallback chain below handles it.
      const [historyRows] = await db.query(
        `
        SELECT h.*,
               ws.type   AS step_type,
               ws.config AS step_config_current
        FROM workflow_execution_steps h
        LEFT JOIN workflow_steps ws ON ws.id = h.step_id
        WHERE h.workflow_execution_id = ?
        ORDER BY h.executed_at ASC
        `,
        [executionId]
      );

      // string → try JSON.parse (mysql2 may already hand back objects for JSON columns)
      const tryParse = (v) => {
        if (typeof v !== 'string') return v;
        try { return JSON.parse(v); } catch { return v; }
      };

      history = historyRows.map(row => {
        if (row.output_data) row.output_data = tryParse(row.output_data);
        if (row.resolved_config) row.resolved_config = tryParse(row.resolved_config);

        // step_label: prefer the as-run function_name (exact), else the current
        // step config's function_name (may have been edited since the run),
        // else the step type, else null. step_label_source lets the UI caveat
        // the current_config case.
        const currentCfg = tryParse(row.step_config_current);
        let stepLabel = null;
        let labelSource = null;
        if (row.resolved_config && typeof row.resolved_config === 'object' && row.resolved_config.function_name) {
          stepLabel = row.resolved_config.function_name;
          labelSource = 'as_run';
        } else if (currentCfg && typeof currentCfg === 'object' && currentCfg.function_name) {
          stepLabel = currentCfg.function_name;
          labelSource = 'current_config';
        } else if (row.step_type) {
          stepLabel = row.step_type;
          labelSource = 'type';
        }
        row.step_label = stepLabel;
        row.step_label_source = labelSource;

        // Don't ship the full current config — it's not what ran and bloats
        // the payload. step_label already extracted what we need from it.
        delete row.step_config_current;

        return row;
      });
    }

    res.json({
      success: true,
      execution,
      history: includeHistory ? history : undefined
    });
  } catch (err) {
    console.error("[GET EXECUTION] Failed:", err);
    res.status(500).json({ error: "Failed to fetch execution", message: err.message });
  }
});



/**
 * GET /workflows/:id/executions
 * List all executions for a specific workflow
 * Query params (optional):
 *   - limit: number (default 50, max 200)
 *   - offset: number (default 0)  — preferred for paging; if omitted, derived from `page`
 *   - page: number (default 1)    — legacy; offset wins when present
 *   - status: string (e.g. active, completed, failed)
 *   - sort: string (created_at:desc or created_at:asc)
 * Response: { success, executions, total }
 */
router.get("/workflows/:id/executions", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;
 
  const workflowId = parseInt(id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }
 
  // Accept either ?limit/?offset (Slice 1 frontend idiom) or legacy ?page/?limit.
  // If ?offset is passed, it wins; otherwise derive offset from ?page.
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const offset = req.query.offset !== undefined
    ? Math.max(0, parseInt(req.query.offset) || 0)
    : (page - 1) * limit;
 
  const statusFilter = req.query.status || null;
  const sort = req.query.sort === 'created_at:asc' ? 'ASC' : 'DESC';
 
  try {
    let query = `
      SELECT 
        e.id,
        e.status,
        e.current_step_number,
        e.steps_executed_count,
        e.created_at,
        e.updated_at,
        e.completed_at,
        JSON_LENGTH(e.variables) as variable_count,
        (SELECT COUNT(*) 
         FROM workflow_execution_steps s 
         WHERE s.workflow_execution_id = e.id AND s.status = 'failed') as failed_steps
      FROM workflow_executions e
      WHERE e.workflow_id = ?
    `;
    const params = [workflowId];
    if (statusFilter) { query += ` AND e.status = ?`; params.push(statusFilter); }
    query += ` ORDER BY e.created_at ${sort} LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    const [rows] = await db.query(query, params);
 
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM workflow_executions e 
      WHERE e.workflow_id = ?
      ${statusFilter ? 'AND e.status = ?' : ''}
    `;
    const countParams = [workflowId];
    if (statusFilter) countParams.push(statusFilter);
    const [countRows] = await db.query(countQuery, countParams);
    const total = countRows[0].total;
 
    // Flat envelope: { success, executions, total }.
    // Prior version nested { pagination: { total } } but the Slice 1 frontend
    // read data.total directly → always undefined → pagination permanently broken.
    // Docs (09-api-reference.md) already describe the flat shape. No other
    // caller of this endpoint was found in a grep of the codebase.
    res.json({
      success: true,
      executions: rows.map(row => ({
        ...row,
        status_summary: row.status.startsWith('completed')
          ? (row.failed_steps > 0 ? 'completed_with_errors' : 'completed')
          : row.status
      })),
      total,
    });
  } catch (err) {
    console.error("[GET WORKFLOW EXECUTIONS] Failed:", err);
    res.status(500).json({ error: "Failed to fetch executions", message: err.message });
  }
});


/**
 * GET /workflows
 * List all workflow templates
 * Query params (optional):
 *   - page: number (default 1)
 *   - limit: number (default 20, max 100)
 *   - search: string (filter by name or description)
 *   - sort: string (name:asc, name:desc, created_at:desc, created_at:asc)
 */
router.get("/workflows", jwtOrApiKey, async (req, res) => {
  const db = req.db;

  // Query params with defaults
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const search = req.query.search || null;
  const sortField = req.query.sort?.split(':')[0] || 'created_at';
  const sortDir = req.query.sort?.split(':')[1]?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  // Optional active filter. When `active=true` is passed, only active workflows
  // are returned; `active=false` returns only inactive. Omitted → all.
  // The frontend's "show inactive" toggle (default off) passes active=true.
  const activeFilter = req.query.active === undefined
    ? null
    : (req.query.active === 'true' ? 1 : 0);

  // Valid sort fields to prevent injection
  const validSortFields = ['name', 'created_at', 'id'];
  const sort = validSortFields.includes(sortField) ? sortField : 'created_at';

  try {
    let query = `
      SELECT 
        id, name, description, active, test_input, created_at, updated_at,
        (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id) as step_count
      FROM workflows w
      WHERE 1=1
    `;
    const params = [];

    if (search) {
      query += ` AND (name LIKE ? OR description LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }
    if (activeFilter !== null) {
      query += ` AND active = ?`;
      params.push(activeFilter);
    }

    query += ` ORDER BY ${sort} ${sortDir} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const [rows] = await db.query(query, params);

    // Total count for pagination — mirror the same WHERE filters.
    let countQuery = `
      SELECT COUNT(*) as total 
      FROM workflows w
      WHERE 1=1
    `;
    const countParams = [];
    if (search) {
      countQuery += ` AND (name LIKE ? OR description LIKE ?)`;
      countParams.push(`%${search}%`, `%${search}%`);
    }
    if (activeFilter !== null) {
      countQuery += ` AND active = ?`;
      countParams.push(activeFilter);
    }
    const [countRows] = await db.query(countQuery, countParams);
    const total = countRows[0].total;

    res.json({
      success: true,
      workflows: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: offset + limit < total,
        hasPrev: page > 1
      }
    });
  } catch (err) {
    console.error("[GET WORKFLOWS] Failed:", err);
    res.status(500).json({ error: "Failed to list workflows", message: err.message });
  }
});


/**
 * GET /workflows/:id
 * Get details of a single workflow template including its steps
 * Query params (optional):
 *   - includeSteps: boolean (default true) - whether to include full step list
 */
router.get("/workflows/:id", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const includeSteps = req.query.includeSteps !== "false"; // default true

  const workflowId = parseInt(id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }

  try {
    // Workflow metadata
    const [wfRows] = await db.query(
      `
      SELECT 
        id, name, description, active, test_input, created_at, updated_at,
        (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id) as step_count
      FROM workflows w
      WHERE id = ?
      `,
      [workflowId]
    );

    if (wfRows.length === 0) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    const workflow = wfRows[0];

    // Optional: full steps list
    let steps = null;
    if (includeSteps) {
      const [stepRows] = await db.query(
        `
        SELECT 
          id, step_number, type, config, error_policy, created_at, updated_at
        FROM workflow_steps
        WHERE workflow_id = ?
        ORDER BY step_number ASC
        `,
        [workflowId]
      );

      steps = stepRows;
    }

    res.json({
      success: true,
      workflow,
      steps: includeSteps ? steps : undefined
    });
  } catch (err) {
    console.error("[GET WORKFLOW] Failed:", err);
    res.status(500).json({ error: "Failed to fetch workflow", message: err.message });
  }
});




/**
 * POST /workflows
 * Create a new workflow template
 * Body: { name: string, description?: string, test_input?: object|null }
 * Returns the new workflow ID + basic info
 *
 * Slice 2.1: `test_input` is authorial documentation of the init_data shape
 * this workflow expects. Nullable. Plain JSON object only — arrays/primitives
 * rejected with 400. Not validated at runtime against actual init_data.
 */
router.post("/workflows", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { name, description = "", test_input } = req.body;

  if (!name || typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ error: "Workflow name is required" });
  }

  // Slice 2.1 — test_input shape validation.
  {
    const v = validateTestInput(test_input);
    if (v) return res.status(v.status).json({ error: v.error });
  }

  try {
    const [result] = await db.query(
      `
      INSERT INTO workflows (name, description, test_input)
      VALUES (?, ?, ?)
      `,
      [name.trim(), description.trim(), toJson(test_input)]
    );

    const workflowId = result.insertId;

    console.log(`[CREATE WORKFLOW] Created workflow ${workflowId}: ${name}`);

    res.status(201).json({
      success: true,
      workflowId,
      name: name.trim(),
      description: description.trim(),
      message: "Workflow template created successfully"
    });
  } catch (err) {
    console.error("[CREATE WORKFLOW] Failed:", err);
    res.status(500).json({ 
      error: "Failed to create workflow", 
      message: err.message 
    });
  }
});




/**
 * POST /workflows/:id/steps
 * Add a new step to a workflow (at the end by default)
 * Body: { 
 *   stepNumber?: number (optional - if provided, inserts at that position and shifts others),
 *   type: "webhook" | "internal_function" | "custom_code",
 *   config: { ... },
 *   error_policy?: { strategy, max_retries, backoff_seconds }
 * }
 */
router.post("/workflows/:id/steps", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { stepNumber, type, config, error_policy = null } = req.body;

  const workflowId = parseInt(id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }

  if (!["webhook", "internal_function", "custom_code"].includes(type)) {
    return res.status(400).json({ error: "Invalid step type" });
  }
  if (!config || typeof config !== "object") {
    return res.status(400).json({ error: "config object is required" });
  }

  // Timing-extensions slice — validate wait_for / schedule_resume params
  {
    const v = validateInternalFunctionConfig(type, config);
    if (v) return res.status(v.status).json({ error: v.error, message: v.message });
  }

  // Webhook credential injection slice — validate URL, method, credential FK, timeout
  {
    const v = await validateWebhookConfig(db, type, config);
    if (v) return res.status(v.status).json({ error: v.error, message: v.message });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Verify workflow exists
    const [wfRows] = await connection.query(
      `SELECT id FROM workflows WHERE id = ?`,
      [workflowId]
    );
    if (wfRows.length === 0) {
      return { respond: { status: 404, body: { error: "Workflow not found" } } };
    }

    let targetStep = stepNumber;

    // If stepNumber not provided → add at the end
    if (!targetStep) {
      const [maxRow] = await connection.query(
        `SELECT MAX(step_number) as max FROM workflow_steps WHERE workflow_id = ?`,
        [workflowId]
      );
      targetStep = (maxRow[0].max || 0) + 1;
    }

    // Shift existing steps up if inserting in the middle.
    // Two-pass to avoid unique constraint collisions: first move all affected
    // steps to a safe temp range (+10000), then set their final positions.
    if (stepNumber) {
      await connection.query(
        `UPDATE workflow_steps 
         SET step_number = step_number + 10000 
         WHERE workflow_id = ? AND step_number >= ?`,
        [workflowId, targetStep]
      );
      await connection.query(
        `UPDATE workflow_steps 
         SET step_number = step_number - 10000 + 1 
         WHERE workflow_id = ? AND step_number >= ?`,
        [workflowId, targetStep + 10000]
      );
    }

    // Insert the new step
    await connection.query(
      `
      INSERT INTO workflow_steps 
      (workflow_id, step_number, type, config, error_policy)
      VALUES (?, ?, ?, ?, ?)
      `,
      [workflowId, targetStep, type, JSON.stringify(config), JSON.stringify(error_policy)]
    );

      return { targetStep };
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);

    res.status(201).json({
      success: true,
      workflowId,
      stepNumber: outcome.targetStep,
      type,
      message: `Step ${outcome.targetStep} added to workflow ${workflowId}`
    });
  } catch (err) {
    console.error("[ADD STEP] Failed:", err);
    res.status(500).json({ error: "Failed to add step", message: err.message });
  }
});





/**
 * POST /workflows/bulk
 * Create a workflow template and all steps in one transaction
 *
 * Slice 2.1: also accepts `test_input` (authorial init_data shape doc).
 */
router.post("/workflows/bulk", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { name, description = "", test_input, steps } = req.body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "Workflow name is required" });
  }

  if (!Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: "At least one step is required" });
  }

  // Slice 2.1 — test_input shape validation.
  {
    const v = validateTestInput(test_input);
    if (v) return res.status(v.status).json({ error: v.error });
  }

  // Validate all steps BEFORE opening a transaction — so bad input gets a
  // clean 400 rather than a rollback + 500.
  const VALID_TYPES = new Set(["webhook", "internal_function", "custom_code"]);
  const usedNumbers = new Set();
  const stepValues = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    if (!VALID_TYPES.has(step.type)) {
      return res.status(400).json({ error: `Invalid step type at index ${i}` });
    }

    if (!step.config || typeof step.config !== "object") {
      return res.status(400).json({ error: `Step ${i + 1} must contain a valid config object` });
    }

    // Timing-extensions slice — validate wait_for / schedule_resume params
    {
      const v = validateInternalFunctionConfig(step.type, step.config);
      if (v) return res.status(v.status).json({
        error: `Step ${i + 1}: ${v.error}`,
        message: v.message,
      });
    }

    // Webhook credential injection slice — validate URL, method, credential FK, timeout
    {
      const v = await validateWebhookConfig(db, step.type, step.config);
      if (v) return res.status(v.status).json({
        error: `Step ${i + 1}: ${v.error}`,
        message: v.message,
      });
    }

    const stepNumber = step.stepNumber ?? (i + 1);

    if (usedNumbers.has(stepNumber)) {
      return res.status(400).json({ error: `Duplicate stepNumber: ${stepNumber}` });
    }

    usedNumbers.add(stepNumber);

    stepValues.push([
      null,           // workflow_id — filled in after INSERT below
      stepNumber,
      step.type,
      JSON.stringify(step.config),
      step.error_policy ? JSON.stringify(step.error_policy) : null
    ]);
  }

  try {
    const workflowId = await db.withTransaction(async (connection) => {

    const [workflowResult] = await connection.query(
      `INSERT INTO workflows (name, description, test_input) VALUES (?, ?, ?)`,
      [name.trim(), description.trim(), toJson(test_input)]
    );

    const workflowId = workflowResult.insertId;

    // Patch in the real workflowId now that we have it
    const rows = stepValues.map(row => [workflowId, row[1], row[2], row[3], row[4]]);

    await connection.query(
      `
      INSERT INTO workflow_steps
      (workflow_id, step_number, type, config, error_policy)
      VALUES ?
      `,
      [rows]
    );

      return workflowId;
    });

    console.log(`[WORKFLOW CREATED] id=${workflowId} steps=${steps.length}`);

    return res.status(201).json({
      success: true,
      workflowId,
      name: name.trim(),
      stepCount: steps.length
    });

  } catch (err) {
    console.error("[WORKFLOW BULK CREATE ERROR]", err);
    return res.status(500).json({
      error: "Failed to create workflow",
      message: err.message
    });
  }
});



/**
 * DELETE /workflows/:id
 * Delete a workflow template and ALL its steps
 * (Executions are kept for history)
 */
router.delete("/workflows/:id", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const workflowId = parseInt(id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Verify workflow exists
    const [wfRows] = await connection.query(
      `SELECT id FROM workflows WHERE id = ?`,
      [workflowId]
    );
    if (wfRows.length === 0) {
      return { respond: { status: 404, body: { error: "Workflow not found" } } };
    }

    // Delete steps first (foreign key safety)
    await connection.query(
      `DELETE FROM workflow_steps WHERE workflow_id = ?`,
      [workflowId]
    );

    // Delete workflow
    await connection.query(
      `DELETE FROM workflows WHERE id = ?`,
      [workflowId]
    );

      return {};
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);

    console.log(`[DELETE WORKFLOW] Deleted workflow ${workflowId} and all steps`);

    res.json({
      success: true,
      message: `Workflow ${workflowId} and all its steps deleted`
    });
  } catch (err) {
    console.error("[DELETE WORKFLOW] Failed:", err);
    res.status(500).json({ error: "Failed to delete workflow", message: err.message });
  }
});




/**
 * DELETE /workflows/:id/steps/:stepNumber
 * Delete a specific step and automatically renumber all subsequent steps
 */
router.delete("/workflows/:id/steps/:stepNumber", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id, stepNumber } = req.params;

  const workflowId = parseInt(id, 10);
  const stepNum = parseInt(stepNumber, 10);

  if (isNaN(workflowId) || workflowId <= 0 || isNaN(stepNum) || stepNum <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID or step number" });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Verify workflow exists
    const [wfRows] = await connection.query(
      `SELECT id FROM workflows WHERE id = ?`,
      [workflowId]
    );
    if (wfRows.length === 0) {
      return { respond: { status: 404, body: { error: "Workflow not found" } } };
    }

    // Verify step exists
    const [stepRows] = await connection.query(
      `SELECT id FROM workflow_steps WHERE workflow_id = ? AND step_number = ?`,
      [workflowId, stepNum]
    );
    if (stepRows.length === 0) {
      return { respond: { status: 404, body: { error: "Step not found" } } };
    }

    // Delete the step
    await connection.query(
      `DELETE FROM workflow_steps WHERE workflow_id = ? AND step_number = ?`,
      [workflowId, stepNum]
    );

    // Renumber all higher steps down by 1.
    // ORDER BY ASC ensures MySQL processes lowest step first, so each
    // decrement lands in the slot just vacated — no unique constraint collision.
    await connection.query(
      `
      UPDATE workflow_steps 
      SET step_number = step_number - 1 
      WHERE workflow_id = ? AND step_number > ?
      ORDER BY step_number ASC
      `,
      [workflowId, stepNum]
    );

      return {};
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);

    console.log(`[DELETE STEP] Deleted step ${stepNum} from workflow ${workflowId} and renumbered`);

    res.json({
      success: true,
      message: `Step ${stepNum} deleted and subsequent steps renumbered`
    });
  } catch (err) {
    console.error("[DELETE STEP] Failed:", err);
    res.status(500).json({ error: "Failed to delete step", message: err.message });
  }
});



/**
 * PATCH /workflows/:id/steps/reorder
 * Reorder steps in a workflow
 * Two formats supported:
 * 1. Move single step: { "fromStep": 5, "toStep": 2 }
 * 2. Full new order: { "order": [3,1,4,2,5] }
 */
router.patch("/workflows/:id/steps/reorder", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { fromStep, toStep, order } = req.body;

  const workflowId = parseInt(id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Verify workflow exists
    const [wfRows] = await connection.query(
      `SELECT id FROM workflows WHERE id = ?`,
      [workflowId]
    );
    if (wfRows.length === 0) {
      return { respond: { status: 404, body: { error: "Workflow not found" } } };
    }

    // ────────────────────────────────────────────────
    // Case 1: Simple move (fromStep → toStep)
    // ────────────────────────────────────────────────
    if (fromStep !== undefined && toStep !== undefined) {
      const from = parseInt(fromStep, 10);
      const to = parseInt(toStep, 10);

      if (isNaN(from) || isNaN(to) || from < 1 || to < 1) {
        throw new Error("Invalid fromStep or toStep");
      }

      if (from === to) {
        return { respond: { status: 200, body: { success: true, message: "No change needed" } } };
      }

      // Shift steps between from and to.
      // ORDER BY direction ensures each step moves into a slot just vacated,
      // preventing unique constraint collisions.
      if (from < to) {
        // Moving step forward: shift intermediate steps down — process ASC
        // so lowest step moves first into the slot being freed by 'from'
        await connection.query(
          `UPDATE workflow_steps 
           SET step_number = step_number - 1 
           WHERE workflow_id = ? AND step_number > ? AND step_number <= ?
           ORDER BY step_number ASC`,
          [workflowId, from, to]
        );
      } else {
        // Moving step backward: shift intermediate steps up — process DESC
        // so highest step moves first into the slot being freed by 'from'
        await connection.query(
          `UPDATE workflow_steps 
           SET step_number = step_number + 1 
           WHERE workflow_id = ? AND step_number >= ? AND step_number < ?
           ORDER BY step_number DESC`,
          [workflowId, to, from]
        );
      }

      // Place the moved step
      await connection.query(
        `UPDATE workflow_steps 
         SET step_number = ? 
         WHERE workflow_id = ? AND step_number = ?`,
        [to, workflowId, from]
      );
    }

    // ────────────────────────────────────────────────
    // Case 2: Full new order array
    // ────────────────────────────────────────────────
    else if (Array.isArray(order) && order.length > 0) {
      if (order.some(n => !Number.isInteger(n) || n < 1)) {
        throw new Error("Invalid step numbers in order array");
      }

      // Two-pass approach to avoid unique constraint collisions.
      // A single pass can collide: e.g. moving old step 3 → 1 then old step 1 → 2
      // hits the row that was just renamed, not the original step 1.
      //
      // Pass 1: shift all steps into a safe temp range (+10000) so no final
      //         value can collide with any in-progress temp value.
      for (let i = 0; i < order.length; i++) {
        await connection.query(
          `UPDATE workflow_steps 
           SET step_number = ? 
           WHERE workflow_id = ? AND step_number = ?`,
          [order[i] + 10000, workflowId, order[i]]
        );
      }

      // Pass 2: set final positions from the temp range.
      for (let i = 0; i < order.length; i++) {
        await connection.query(
          `UPDATE workflow_steps 
           SET step_number = ? 
           WHERE workflow_id = ? AND step_number = ?`,
          [i + 1, workflowId, order[i] + 10000]
        );
      }
    } 
    else {
      return { respond: { status: 400, body: { error: "Must provide either {fromStep, toStep} or {order: array}" } } };
    }

      return {};
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);

    console.log(`[REORDER] Workflow ${workflowId} steps reordered`);

    res.json({
      success: true,
      message: "Steps reordered successfully"
    });
  } catch (err) {
    console.error("[REORDER STEPS] Failed:", err);
    res.status(500).json({ error: "Failed to reorder steps", message: err.message });
  }
});



/**
 * PUT /workflows/:id
 * Update workflow name and/or description and/or test_input
 * Body: { "name"?: string, "description"?: string, "test_input"?: object|null }
 * Partial updates are supported (at least one field required)
 *
 * Slice 2.1: `test_input` is accepted as a partial-update field. Pass `null`
 * to explicitly clear it. Omit from body to leave unchanged.
 */
router.put("/workflows/:id", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { name, description, test_input, active } = req.body;

  const workflowId = parseInt(id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }

  // At least one field must be provided for a meaningful update
  if (name === undefined && description === undefined && test_input === undefined && active === undefined) {
    return res.status(400).json({ error: "At least one field (name, description, test_input, or active) is required" });
  }

  // Slice 2.1 — test_input shape validation (only if present in body).
  if (test_input !== undefined) {
    const v = validateTestInput(test_input);
    if (v) return res.status(v.status).json({ error: v.error });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Verify workflow exists
    const [wfRows] = await connection.query(
      `SELECT id FROM workflows WHERE id = ?`,
      [workflowId]
    );
    if (wfRows.length === 0) {
      return { respond: { status: 404, body: { error: "Workflow not found" } } };
    }

    // Build dynamic update (only update fields that were sent)
    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push("name = ?");
      params.push((name || "").trim());
    }
    if (description !== undefined) {
      updates.push("description = ?");
      params.push((description || "").trim());
    }
    if (test_input !== undefined) {
      updates.push("test_input = ?");
      params.push(toJson(test_input));
    }
    if (active !== undefined) {
      updates.push("active = ?");
      params.push(active ? 1 : 0);
    }

    const query = `
      UPDATE workflows 
      SET ${updates.join(", ")}, updated_at = NOW()
      WHERE id = ?
    `;
    params.push(workflowId);

    await connection.query(query, params);

      return {};
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);

    console.log(`[UPDATE WORKFLOW] Updated workflow ${workflowId}`);

    res.json({
      success: true,
      workflowId,
      message: "Workflow updated successfully"
    });
  } catch (err) {
    console.error("[UPDATE WORKFLOW] Failed:", err);
    res.status(500).json({ 
      error: "Failed to update workflow", 
      message: err.message 
    });
  }
});


/**
 * PUT /workflows/:id/steps/:stepNumber
 * Full replace of a step (type + config + error_policy)
 * Body: { "type": "...", "config": {...}, "error_policy": {...} }
 */
router.put("/workflows/:id/steps/:stepNumber", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id, stepNumber } = req.params;
  const { type, config, error_policy } = req.body;

  const workflowId = parseInt(id, 10);
  const stepNum = parseInt(stepNumber, 10);

  if (isNaN(workflowId) || workflowId <= 0 || isNaN(stepNum) || stepNum <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID or step number" });
  }

  if (!["webhook", "internal_function", "custom_code"].includes(type)) {
    return res.status(400).json({ error: "Invalid step type" });
  }
  if (!config || typeof config !== "object") {
    return res.status(400).json({ error: "config object is required" });
  }

  // Timing-extensions slice — validate wait_for / schedule_resume params
  {
    const v = validateInternalFunctionConfig(type, config);
    if (v) return res.status(v.status).json({ error: v.error, message: v.message });
  }

  // Webhook credential injection slice — validate URL, method, credential FK, timeout
  {
    const v = await validateWebhookConfig(db, type, config);
    if (v) return res.status(v.status).json({ error: v.error, message: v.message });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Verify workflow + step exist
    const [rows] = await connection.query(
      `SELECT id FROM workflow_steps WHERE workflow_id = ? AND step_number = ?`,
      [workflowId, stepNum]
    );
    if (rows.length === 0) {
      return { respond: { status: 404, body: { error: "Step not found" } } };
    }

    await connection.query(
      `
      UPDATE workflow_steps 
      SET type = ?, config = ?, error_policy = ?, updated_at = NOW()
      WHERE workflow_id = ? AND step_number = ?
      `,
      [
        type,
        JSON.stringify(config),
        error_policy ? JSON.stringify(error_policy) : null,
        workflowId,
        stepNum
      ]
    );

      return {};
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);

    console.log(`[UPDATE STEP] Fully replaced step ${stepNum} in workflow ${workflowId}`);

    res.json({
      success: true,
      workflowId,
      stepNumber: stepNum,
      message: `Step ${stepNum} fully updated`
    });
  } catch (err) {
    console.error("[PUT STEP] Failed:", err);
    res.status(500).json({ error: "Failed to update step", message: err.message });
  }
});



/**
 * PATCH /workflows/:id/steps/:stepNumber
 * Partial update (only fields you send)
 * Body example: { "error_policy": { "strategy": "retry_then_abort", "max_retries": 3 } }
 * or { "config": { "url": "new-url" } }
 */
router.patch("/workflows/:id/steps/:stepNumber", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id, stepNumber } = req.params;
  const { type, config, error_policy } = req.body;

  const workflowId = parseInt(id, 10);
  const stepNum = parseInt(stepNumber, 10);

  if (isNaN(workflowId) || workflowId <= 0 || isNaN(stepNum) || stepNum <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID or step number" });
  }

  // At least one field must be provided
  if (type === undefined && config === undefined && error_policy === undefined) {
    return res.status(400).json({ error: "At least one field is required" });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Verify step exists
    const [rows] = await connection.query(
      `SELECT id, type, config FROM workflow_steps WHERE workflow_id = ? AND step_number = ?`,
      [workflowId, stepNum]
    );
    if (rows.length === 0) {
      return { respond: { status: 404, body: { error: "Step not found" } } };
    }

    // Timing-extensions slice — if type or config is being updated, validate
    // the resulting (type, config) pair. If only one of the two was supplied,
    // load the other from the existing row so we always validate the
    // combination, not a partial view. Mirrors the pattern used for
    // action_type/action_config validation in routes/sequences.js.
    if (type !== undefined || config !== undefined) {
      let typeToCheck   = type;
      let configToCheck = config;
      if (typeToCheck === undefined) typeToCheck = rows[0].type;
      if (configToCheck === undefined) {
        configToCheck = typeof rows[0].config === 'string'
          ? JSON.parse(rows[0].config)
          : rows[0].config;
      }
      const v = validateInternalFunctionConfig(typeToCheck, configToCheck);
      if (v) {
        return { respond: { status: v.status, body: { error: v.error, message: v.message } } };
      }
      // Webhook credential injection slice — same combination-check pattern.
      const wv = await validateWebhookConfig(db, typeToCheck, configToCheck);
      if (wv) {
        return { respond: { status: wv.status, body: { error: wv.error, message: wv.message } } };
      }
    }

    const updates = [];
    const params = [];

    if (type !== undefined) {
      updates.push("type = ?");
      params.push(type);
    }
    if (config !== undefined) {
      updates.push("config = ?");
      params.push(JSON.stringify(config));
    }
    if (error_policy !== undefined) {
      updates.push("error_policy = ?");
      params.push(error_policy ? JSON.stringify(error_policy) : null);
    }

    const query = `
      UPDATE workflow_steps 
      SET ${updates.join(", ")}, updated_at = NOW()
      WHERE workflow_id = ? AND step_number = ?
    `;
    params.push(workflowId, stepNum);

    await connection.query(query, params);

      return {};
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);

    console.log(`[PATCH STEP] Updated step ${stepNum} in workflow ${workflowId}`);

    res.json({
      success: true,
      workflowId,
      stepNumber: stepNum,
      message: `Step ${stepNum} partially updated`
    });
  } catch (err) {
    console.error("[PATCH STEP] Failed:", err);
    res.status(500).json({ error: "Failed to patch step", message: err.message });
  }
});



/**
 * POST /workflows/:id/duplicate
 * Duplicate a workflow + ALL its steps
 * Body (optional): { "name"?: string }  → if not provided, defaults to "Copy of Original Name"
 */
router.post("/workflows/:id/duplicate", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { name: customName } = req.body;

  const originalId = parseInt(id, 10);
  if (isNaN(originalId) || originalId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Get original workflow
    //
    // Slice 2.1: also SELECT test_input so the duplicate carries over the
    // authorial init_data shape doc. Symmetric with description carry-over.
    const [wfRows] = await connection.query(
      `SELECT name, description, test_input FROM workflows WHERE id = ?`,
      [originalId]
    );
    if (wfRows.length === 0) {
      return { respond: { status: 404, body: { error: "Workflow not found" } } };
    }

    const original = wfRows[0];

    // Create new workflow
    const newName = customName?.trim() || `Copy of ${original.name}`;
    const [newWfResult] = await connection.query(
      `INSERT INTO workflows (name, description, test_input) VALUES (?, ?, ?)`,
      [newName, original.description || "", toJson(original.test_input)]
    );
    const newWorkflowId = newWfResult.insertId;

    // Duplicate all steps
    const [steps] = await connection.query(
      `
      SELECT step_number, type, config, error_policy 
      FROM workflow_steps 
      WHERE workflow_id = ? 
      ORDER BY step_number ASC
      `,
      [originalId]
    );

    if (steps.length > 0) {
      const stepValues = steps.map(step => [
        newWorkflowId,
        step.step_number,
        step.type,
        toJson(step.config),
        toJson(step.error_policy)
      ]);

      await connection.query(
        `
        INSERT INTO workflow_steps 
        (workflow_id, step_number, type, config, error_policy)
        VALUES ?
        `,
        [stepValues]
      );
    }

      return { newWorkflowId, newName, stepCount: steps.length };
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);

    console.log(`[DUPLICATE] Workflow ${originalId} → ${outcome.newWorkflowId} (${outcome.stepCount} steps)`);

    res.status(201).json({
      success: true,
      originalWorkflowId: originalId,
      newWorkflowId: outcome.newWorkflowId,
      newName: outcome.newName,
      stepCount: outcome.stepCount,
      message: `Workflow duplicated successfully`
    });
  } catch (err) {
    console.error("[DUPLICATE WORKFLOW] Failed:", err);
    res.status(500).json({ 
      error: "Failed to duplicate workflow", 
      message: err.message 
    });
  }
});



/**
 * POST /executions/:id/cancel
 * Emergency cancel of a running workflow execution.
 *
 * Body: { reason: string }  — REQUIRED, min 3 chars after trim. Stored in
 *                             the new workflow_executions.cancel_reason column
 *                             (Slice 4.3 Part B). Mirrors the sequence-cancel
 *                             pattern — honest audit trail for manual stops.
 *
 * Side effects:
 *   - workflow_executions: status → 'cancelled', cancel_reason set,
 *     updated_at + completed_at = NOW()
 *   - scheduled_jobs: any pending/running 'workflow_resume' for this
 *     execution is deleted (not "failed" — deletion matches the legacy
 *     behaviour of this route, and cancelled resumes have no audit value).
 */
router.post("/executions/:id/cancel", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const executionId = parseInt(id, 10);
  if (isNaN(executionId) || executionId <= 0) {
    return res.status(400).json({ error: "Invalid execution ID" });
  }

  // Validate reason — required, min 3 chars after trim.
  const rawReason = (req.body && typeof req.body.reason === 'string') ? req.body.reason : '';
  const reason = rawReason.trim();
  if (reason.length < 3) {
    return res.status(400).json({
      error: "Reason required",
      message: "reason is required and must be at least 3 characters after trim",
    });
  }
  // Hard cap at the column width (500) — truncate rather than 400 here.
  // A 500-char reason is already aggressive; silently trimming is kinder
  // than refusing the cancel over overflow.
  const reasonStored = reason.length > 500 ? reason.slice(0, 500) : reason;

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Verify execution exists and is still cancellable.
    const [execRows] = await connection.query(
      `
      SELECT status 
      FROM workflow_executions 
      WHERE id = ? 
        AND status IN ('active', 'processing', 'delayed')
      `,
      [executionId]
    );

    if (execRows.length === 0) {
      return { respond: { status: 400, body: { error: "Cannot cancel", message: "Execution not found or already finished" } } };
    }

    // Mark as cancelled (with reason).
    await connection.query(
      `
      UPDATE workflow_executions 
      SET status        = 'cancelled', 
          cancel_reason = ?,
          updated_at    = NOW(),
          completed_at  = NOW()
      WHERE id = ?
      `,
      [reasonStored, executionId]
    );

    // Delete any pending resume jobs for this execution.
    await connection.query(
      `
      DELETE FROM scheduled_jobs 
      WHERE type = 'workflow_resume' 
        AND workflow_execution_id = ? 
        AND status IN ('pending', 'running')
      `,
      [executionId]
    );

      return {};
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);

    console.log(`[CANCEL] Execution ${executionId} cancelled by user — reason: ${reasonStored}`);

    res.json({
      success: true,
      executionId,
      cancel_reason: reasonStored,
      message: "Workflow execution cancelled successfully",
    });
  } catch (err) {
    console.error("[CANCEL EXECUTION] Failed:", err);
    res.status(500).json({
      error: "Failed to cancel execution",
      message: err.message,
    });
  }
});



/**
 * POST /executions/:id/resume
 * Slice 4 — resume a terminal execution from a chosen step, or redo one step.
 *
 * Body: { mode: 'resume' | 'single_step', step_number, variables? }
 *   - mode 'resume':      re-arm the execution at step_number and let
 *                         advanceWorkflow run it to completion (202, detached).
 *   - mode 'single_step': execute exactly that step synchronously via
 *                         executeSingleStep — records history, merges set_vars,
 *                         never navigates or changes status (200).
 *   - variables (optional): plain object — FULL REPLACE of
 *                         workflow_executions.variables before execution.
 *
 * Eligibility: any status EXCEPT live ('active','processing','delayed') —
 * failed, cancelled, completed, completed_with_errors are all resumable.
 * Deliberate: completed runs can contain mistakes that weren't recorded as
 * errors (wrong recipient, bad data) and operators need to redo them.
 *
 * We deliberately do NOT check workflows.active — resume is an operator
 * repair tool and must work on workflows that have since been deactivated.
 *
 * Final-status honesty: getWorkflowFinalStatus counts ALL history rows, so a
 * resumed execution that finishes cleanly will still end
 * 'completed_with_errors' if old failed rows exist. This is correct — history
 * is honest — do not "fix" it by filtering old rows.
 */
router.post("/executions/:id/resume", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const executionId = parseInt(id, 10);
  if (isNaN(executionId) || executionId <= 0) {
    return res.status(400).json({ error: "Invalid execution ID" });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const { mode, step_number, variables } = body;

  try {
    // 1. Execution exists.
    const [execRows] = await db.query(
      `SELECT id, workflow_id, status FROM workflow_executions WHERE id = ?`,
      [executionId]
    );
    if (execRows.length === 0) {
      return res.status(404).json({ error: "Execution not found" });
    }
    const execution = execRows[0];

    // 2. Not live. Everything else is eligible (see route doc above).
    if (['active', 'processing', 'delayed'].includes(execution.status)) {
      return res.status(409).json({
        error: "Cannot resume",
        message: `Cannot resume a live execution (status '${execution.status}')`,
      });
    }

    // 3. Mode.
    if (mode !== 'resume' && mode !== 'single_step') {
      return res.status(400).json({
        error: "Invalid mode",
        message: "mode must be 'resume' or 'single_step'",
      });
    }

    // 4. step_number is a positive integer AND exists on this workflow.
    const stepNum = Number(step_number);
    if (!Number.isInteger(stepNum) || stepNum <= 0) {
      return res.status(400).json({
        error: "Invalid step_number",
        message: "step_number must be a positive integer",
      });
    }
    const [stepRows] = await db.query(
      `SELECT id FROM workflow_steps WHERE workflow_id = ? AND step_number = ?`,
      [execution.workflow_id, stepNum]
    );
    if (stepRows.length === 0) {
      return res.status(400).json({
        error: "Step not found",
        message: `Workflow ${execution.workflow_id} has no step ${stepNum}`,
      });
    }

    // 5. variables, when present, must be a plain object. Semantics: FULL
    //    REPLACE of workflow_executions.variables (not a merge).
    const hasVariables = variables !== undefined;
    if (hasVariables && (
      variables === null ||
      typeof variables !== 'object' ||
      Array.isArray(variables)
    )) {
      return res.status(400).json({
        error: "Invalid variables",
        message: "variables must be a plain JSON object when provided",
      });
    }

    if (mode === 'resume') {
      if (hasVariables) {
        await db.query(
          `UPDATE workflow_executions
           SET status = 'active', current_step_number = ?, completed_at = NULL,
               variables = ?, updated_at = NOW()
           WHERE id = ?`,
          [stepNum, JSON.stringify(variables), executionId]
        );
      } else {
        await db.query(
          `UPDATE workflow_executions
           SET status = 'active', current_step_number = ?, completed_at = NULL,
               updated_at = NOW()
           WHERE id = ?`,
          [stepNum, executionId]
        );
      }

      console.log(`[RESUME] Execution ${executionId} resumed from step ${stepNum}${hasVariables ? ' (variables replaced)' : ''}`);

      res.status(202).json({
        success: true,
        executionId,
        mode: 'resume',
        resumed_from: stepNum,
      });

      // Background advance — mirrors POST /workflows/:id/start exactly.
      (async () => {
        try {
          const advanceResult = await advanceWorkflow(executionId, db);
          console.log(`[ASYNC ADVANCE] (resume) Completed: ${advanceResult.status}`);
        } catch (err) {
          console.error(`[ASYNC ADVANCE] (resume) Failed for execution ${executionId}:`, err.message);
        }
      })();
      return;
    }

    // mode === 'single_step' — replace variables FIRST so the template
    // context builds from them, then run synchronously.
    if (hasVariables) {
      await db.query(
        `UPDATE workflow_executions SET variables = ?, updated_at = NOW() WHERE id = ?`,
        [JSON.stringify(variables), executionId]
      );
    }

    const result = await executeSingleStep(executionId, stepNum, db);

    console.log(`[RESUME] Execution ${executionId} single-step redo of step ${stepNum}: ${result.success ? 'success' : 'failed'}`);

    return res.status(200).json({
      success: result.success,
      mode: 'single_step',
      step_number: stepNum,
      result,
    });
  } catch (err) {
    console.error("[RESUME EXECUTION] Failed:", err);
    res.status(500).json({
      error: "Failed to resume execution",
      message: err.message,
    });
  }
});



/**
 * POST /workflows/test-step
 * Test a single step in isolation — resolves placeholders against provided
 * variables, then either previews (dry_run) or executes the step.
 *
 * Body:
 *   step      { type, config, error_policy? }  — step definition (no id/workflow_id needed)
 *   variables { key: value, ... }              — simulated workflow variables
 *   env       { executionId?, stepNumber? }    — optional env overrides for {{env.*}}
 *   dry_run   boolean (optional)               — resolve-only, no execution, no side effects
 *
 * Dry-run returns:
 *   { success: true, dry_run: true, resolved_config, unresolved_placeholders,
 *     validation_error?, credential_note? }
 *
 * Live returns (unchanged shape, plus retries_skipped when the step's
 * error_policy declared max_retries > 0 — the tester never sleeps through
 * retry backoff; effective retries are forced to 0):
 *   { success, output, set_vars, next_step, delayed_until, error?,
 *     duration_ms, attempts, would_abort?, retries_skipped? }
 */
router.post("/workflows/test-step", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { step, variables = {}, env = {}, dry_run = false } = req.body;

  // Strip phantom step-output keys from incoming variables. The tester UI
  // historically seeded a variable row for every {{placeholder}} found in the
  // step config — including {{this.*}} step-output references — which then
  // arrive here as variables with empty values. resolveSingle checks
  // `key in variables` FIRST, so a phantom `this.output.x` key shadows the
  // real post-execution `this` resolution and set_vars silently resolve to "".
  // Step-output references are never legitimate *input* variables, so strip
  // them server-side regardless of which client (or cached client) sent them.
  for (const k of Object.keys(variables)) {
    if (k === 'this' || k.startsWith('this.')) delete variables[k];
  }

  if (!step || !step.type || !step.config) {
    return res.status(400).json({ error: "step.type and step.config are required" });
  }

  const VALID_TYPES = ["webhook", "internal_function", "custom_code"];
  if (!VALID_TYPES.includes(step.type)) {
    return res.status(400).json({ error: `Invalid step type: ${step.type}` });
  }

  // Parse config if it arrived as a string
  let config = step.config;
  if (typeof config === "string") {
    try { config = JSON.parse(config); }
    catch { return res.status(400).json({ error: "step.config is not valid JSON" }); }
  }

  // Parse error_policy if present
  let errorPolicy = step.error_policy || { strategy: "ignore" };
  if (typeof errorPolicy === "string") {
    try { errorPolicy = JSON.parse(errorPolicy); } catch { errorPolicy = { strategy: "ignore" }; }
  }

  const context = {
    variables,
    this: {},
    env: {
      executionId: env.executionId ?? "test",
      stepNumber:  env.stepNumber  ?? 1,
      now:         new Date().toISOString(),
      ...env
    }
  };

  // Resolve placeholders in config
  const resolvedConfig = resolvePlaceholders(config, context);

  // ── Dry run: resolve-only preview. No executeJob call, no side effects
  // for any step type. Always 200 — validation problems are surfaced as
  // data, not errors, so the author still sees the resolved view.
  if (dry_run) {
    const out = {
      success:         true,
      dry_run:         true,
      resolved_config: resolvedConfig,
      // Tokens in the ORIGINAL config that resolve to null (unknown variable,
      // this.* pre-execution, unknown env helper). Cannot scan resolvedConfig —
      // resolvePlaceholders blanks unresolved tokens to '' (resolveSingle
      // returns null, replace callback does `?? ''`), so tokens never survive
      // resolution. Probing the original tokens via resolveSingle also
      // correctly distinguishes an unset variable (null → flagged) from a
      // variable explicitly set to empty string ('' → not flagged).
      unresolved_placeholders: [...new Set(
        [...JSON.stringify(config).matchAll(/\{\{([^{}]+)\}\}/g)].map(m => m[1].trim())
      )].filter(k => resolveSingle(k, context) == null).map(k => `{{${k}}}`),
    };

    if (step.type === "internal_function") {
      const vErr = validateInternalFunctionParams(config.function_name, resolvedConfig.params);
      if (vErr) out.validation_error = vErr.error;
    }

    // NEVER resolve or echo credential headers here — that would leak
    // secrets into the preview. Just note that injection happens at send.
    if (step.type === "webhook" && (config.credential_id || resolvedConfig.credential_id)) {
      out.credential_note = "Credential headers are injected at send time and are not shown in preview.";
    }

    return res.json(out);
  }

  // ── Live run. The tester never honors retry backoff — a 3×30s policy
  // would hang this HTTP request for minutes. Effective retries are forced
  // to 0; retries_skipped flags when the step's policy declared any.
  const strategy       = errorPolicy.strategy || "ignore";
  const policyRetries  = Number(errorPolicy.max_retries) || 0;
  const retriesSkipped = policyRetries > 0;

  // Build job data
  const jobData = { type: step.type, ...resolvedConfig };

  // Inject _variables for evaluate_condition
  if (step.type === "internal_function" && resolvedConfig.params) {
    jobData.params = { ...resolvedConfig.params, _variables: variables };
  }

  const startTime = Date.now();
  let rawResult, success, errorMsg;
  const attempt = 1; // retries forced off in tester — see above

  try {
    rawResult = await executeJob({ data: jobData }, db);
    success = true;
  } catch (err) {
    success  = false;
    errorMsg = err.message;
  }

  const duration_ms = Date.now() - startTime;

  if (!success) {
    return res.json({
      success:      false,
      error:        errorMsg,
      duration_ms,
      attempts:     attempt,
      would_abort:  strategy === "abort" || strategy === "retry_then_abort",
      ...(retriesSkipped ? { retries_skipped: true } : {})
    });
  }

  // Resolve set_vars from config (static) + function return
  context.this = rawResult;
  let staticSetVars = {};
  if (config.set_vars) {
    staticSetVars = resolvePlaceholders(config.set_vars, context);
  }
  const set_vars = { ...staticSetVars, ...(rawResult?.set_vars || {}) };

  // Extract control signals
  const next_step    = rawResult?.next_step    ?? null;
  const delayed_until = rawResult?.delayed_until ?? null;

  res.json({
    success:      true,
    output:       rawResult,
    set_vars,
    next_step,
    delayed_until,
    duration_ms,
    attempts:     attempt,
    resolved_config: resolvedConfig,   // handy for debugging placeholder resolution
    ...(retriesSkipped ? { retries_skipped: true } : {})
  });
});

module.exports = router;