// routes/workflows.js
const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const { advanceWorkflow, resolvePlaceholders } = require("../lib/workflow_engine");
const { executeJob } = require("../lib/job_executor");
// JSON columns may come back from mysql2 as either a string (unparsed)
// or a parsed object depending on driver version/config. Normalize to a
// string for INSERT so mysql2 doesn't SET-expand objects.
const toJson = v => v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v));

// ─────────────────────────────────────────────────────────────
// GET /workflows/functions — list available internal functions
// Used by workflowManager.html to populate dropdowns dynamically
// MUST be defined before any /:id routes to avoid param capture
// ─────────────────────────────────────────────────────────────

const SEQUENCE_EXCLUDED = new Set([
  'set_next', 'evaluate_condition',     // workflow control flow only
  'schedule_resume', 'wait_for', 'wait_until_time', // sequences have own timing
  'format_string',                      // workflow variable manipulation
  'set_test_var'                        // dev only
]);

router.get('/workflows/functions', jwtOrApiKey, (req, res) => {
  const allFunctions = Object.keys(require('../lib/internal_functions'));
  res.json({
    success: true,
    workflow: allFunctions,
    sequence: allFunctions.filter(f => !SEQUENCE_EXCLUDED.has(f))
  });
});

/**
 * POST /workflows/:id/start
 * Starts a new execution of the workflow
 * Body: { init_data?: object }
 * Returns the new execution ID and initial advance result
 */
router.post("/workflows/:id/start", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  // Accept BOTH formats from frontend:
  // 1. { init_data: { ... } } or { initData: { ... } }
  // 2. flat object { contactName: "...", ... } directly
  let initData = req.body.init_data || req.body.initData || req.body || {};

  console.log(`[START] Received payload:`, JSON.stringify(initData, null, 2));

  const workflowId = parseInt(id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [wfRows] = await connection.query(
      `SELECT id FROM workflows WHERE id = ?`,
      [workflowId]
    );
    if (wfRows.length === 0) {
      await connection.commit();
      return res.status(404).json({ error: "Workflow not found" });
    }

    const [result] = await connection.query(
      `
      INSERT INTO workflow_executions
      (workflow_id, status, init_data, variables, current_step_number)
      VALUES (?, 'active', ?, ?, 1)
      `,
      [workflowId, JSON.stringify(initData), JSON.stringify(initData)]
    );

    const executionId = result.insertId;

    await connection.commit();
    connection.release();

    res.status(202).json({
      success: true,
      executionId,
      workflowId,
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
    if (connection) {
      await connection.rollback();
      connection.release();
    }
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

    res.json({
      success: true,
      executions: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
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
      const [historyRows] = await db.query(
        `
        SELECT *
        FROM workflow_execution_steps
        WHERE workflow_execution_id = ?
        ORDER BY executed_at ASC
        `,
        [executionId]
      );

      history = historyRows.map(row => {
        if (row.output_data) {
          try {
            row.output_data = JSON.parse(row.output_data);
          } catch {}
        }
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

  // Valid sort fields to prevent injection
  const validSortFields = ['name', 'created_at', 'id'];
  const sort = validSortFields.includes(sortField) ? sortField : 'created_at';

  try {
    let query = `
      SELECT 
        id, name, description, created_at, updated_at,
        (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id) as step_count
      FROM workflows w
      WHERE 1=1
    `;
    const params = [];

    if (search) {
      query += ` AND (name LIKE ? OR description LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ` ORDER BY ${sort} ${sortDir} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const [rows] = await db.query(query, params);

    // Total count for pagination
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM workflows w
      WHERE 1=1
      ${search ? 'AND (name LIKE ? OR description LIKE ?)' : ''}
    `;
    const countParams = search ? [`%${search}%`, `%${search}%`] : [];
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
        id, name, description, created_at, updated_at,
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
 * Body: { name: string, description?: string }
 * Returns the new workflow ID + basic info
 */
router.post("/workflows", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { name, description = "" } = req.body;

  if (!name || typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ error: "Workflow name is required" });
  }

  try {
    const [result] = await db.query(
      `
      INSERT INTO workflows (name, description)
      VALUES (?, ?)
      `,
      [name.trim(), description.trim()]
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

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Verify workflow exists
    const [wfRows] = await connection.query(
      `SELECT id FROM workflows WHERE id = ?`,
      [workflowId]
    );
    if (wfRows.length === 0) {
      await connection.commit();
      return res.status(404).json({ error: "Workflow not found" });
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

    await connection.commit();
    connection.release();

    res.status(201).json({
      success: true,
      workflowId,
      stepNumber: targetStep,
      type,
      message: `Step ${targetStep} added to workflow ${workflowId}`
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    console.error("[ADD STEP] Failed:", err);
    res.status(500).json({ error: "Failed to add step", message: err.message });
  }
});





/**
 * POST /workflows/bulk
 * Create a workflow template and all steps in one transaction
 */
router.post("/workflows/bulk", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { name, description = "", steps } = req.body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "Workflow name is required" });
  }

  if (!Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: "At least one step is required" });
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

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [workflowResult] = await connection.query(
      `INSERT INTO workflows (name, description) VALUES (?, ?)`,
      [name.trim(), description.trim()]
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

    await connection.commit();
    connection.release();

    console.log(`[WORKFLOW CREATED] id=${workflowId} steps=${steps.length}`);

    return res.status(201).json({
      success: true,
      workflowId,
      name: name.trim(),
      stepCount: steps.length
    });

  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
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

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Verify workflow exists
    const [wfRows] = await connection.query(
      `SELECT id FROM workflows WHERE id = ?`,
      [workflowId]
    );
    if (wfRows.length === 0) {
      await connection.commit();
      return res.status(404).json({ error: "Workflow not found" });
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

    await connection.commit();
    connection.release();

    console.log(`[DELETE WORKFLOW] Deleted workflow ${workflowId} and all steps`);

    res.json({
      success: true,
      message: `Workflow ${workflowId} and all its steps deleted`
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
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

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Verify workflow exists
    const [wfRows] = await connection.query(
      `SELECT id FROM workflows WHERE id = ?`,
      [workflowId]
    );
    if (wfRows.length === 0) {
      await connection.commit();
      return res.status(404).json({ error: "Workflow not found" });
    }

    // Verify step exists
    const [stepRows] = await connection.query(
      `SELECT id FROM workflow_steps WHERE workflow_id = ? AND step_number = ?`,
      [workflowId, stepNum]
    );
    if (stepRows.length === 0) {
      await connection.commit();
      return res.status(404).json({ error: "Step not found" });
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

    await connection.commit();
    connection.release();

    console.log(`[DELETE STEP] Deleted step ${stepNum} from workflow ${workflowId} and renumbered`);

    res.json({
      success: true,
      message: `Step ${stepNum} deleted and subsequent steps renumbered`
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
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

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Verify workflow exists
    const [wfRows] = await connection.query(
      `SELECT id FROM workflows WHERE id = ?`,
      [workflowId]
    );
    if (wfRows.length === 0) {
      await connection.commit();
      return res.status(404).json({ error: "Workflow not found" });
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
        await connection.commit();
        return res.json({ success: true, message: "No change needed" });
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
      return res.status(400).json({ error: "Must provide either {fromStep, toStep} or {order: array}" });
    }

    await connection.commit();
    connection.release();

    console.log(`[REORDER] Workflow ${workflowId} steps reordered`);

    res.json({
      success: true,
      message: "Steps reordered successfully"
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    console.error("[REORDER STEPS] Failed:", err);
    res.status(500).json({ error: "Failed to reorder steps", message: err.message });
  }
});



/**
 * PUT /workflows/:id
 * Update workflow name and/or description
 * Body: { "name"?: string, "description"?: string }
 * Partial updates are supported (at least one field required)
 */
router.put("/workflows/:id", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { name, description } = req.body;

  const workflowId = parseInt(id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }

  // At least one field must be provided for a meaningful update
  if (name === undefined && description === undefined) {
    return res.status(400).json({ error: "At least one field (name or description) is required" });
  }

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Verify workflow exists
    const [wfRows] = await connection.query(
      `SELECT id FROM workflows WHERE id = ?`,
      [workflowId]
    );
    if (wfRows.length === 0) {
      await connection.commit();
      return res.status(404).json({ error: "Workflow not found" });
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

    const query = `
      UPDATE workflows 
      SET ${updates.join(", ")}, updated_at = NOW()
      WHERE id = ?
    `;
    params.push(workflowId);

    await connection.query(query, params);

    await connection.commit();
    connection.release();

    console.log(`[UPDATE WORKFLOW] Updated workflow ${workflowId}`);

    res.json({
      success: true,
      workflowId,
      message: "Workflow updated successfully"
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
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

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Verify workflow + step exist
    const [rows] = await connection.query(
      `SELECT id FROM workflow_steps WHERE workflow_id = ? AND step_number = ?`,
      [workflowId, stepNum]
    );
    if (rows.length === 0) {
      await connection.commit();
      return res.status(404).json({ error: "Step not found" });
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

    await connection.commit();
    connection.release();

    console.log(`[UPDATE STEP] Fully replaced step ${stepNum} in workflow ${workflowId}`);

    res.json({
      success: true,
      workflowId,
      stepNumber: stepNum,
      message: `Step ${stepNum} fully updated`
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
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

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Verify step exists
    const [rows] = await connection.query(
      `SELECT id FROM workflow_steps WHERE workflow_id = ? AND step_number = ?`,
      [workflowId, stepNum]
    );
    if (rows.length === 0) {
      await connection.commit();
      return res.status(404).json({ error: "Step not found" });
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

    await connection.commit();
    connection.release();

    console.log(`[PATCH STEP] Updated step ${stepNum} in workflow ${workflowId}`);

    res.json({
      success: true,
      workflowId,
      stepNumber: stepNum,
      message: `Step ${stepNum} partially updated`
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
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

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Get original workflow
    const [wfRows] = await connection.query(
      `SELECT name, description FROM workflows WHERE id = ?`,
      [originalId]
    );
    if (wfRows.length === 0) {
      await connection.commit();
      return res.status(404).json({ error: "Workflow not found" });
    }

    const original = wfRows[0];

    // Create new workflow
    const newName = customName?.trim() || `Copy of ${original.name}`;
    const [newWfResult] = await connection.query(
      `INSERT INTO workflows (name, description) VALUES (?, ?)`,
      [newName, original.description || ""]
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

    await connection.commit();
    connection.release();

    console.log(`[DUPLICATE] Workflow ${originalId} → ${newWorkflowId} (${steps.length} steps)`);

    res.status(201).json({
      success: true,
      originalWorkflowId: originalId,
      newWorkflowId,
      newName,
      stepCount: steps.length,
      message: `Workflow duplicated successfully`
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    console.error("[DUPLICATE WORKFLOW] Failed:", err);
    res.status(500).json({ 
      error: "Failed to duplicate workflow", 
      message: err.message 
    });
  }
});



/**
 * POST /executions/:id/cancel
 * Emergency cancel of a running workflow execution
 * Cancels the execution and deletes any pending resume jobs
 */
router.post("/executions/:id/cancel", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const executionId = parseInt(id, 10);
  if (isNaN(executionId) || executionId <= 0) {
    return res.status(400).json({ error: "Invalid execution ID" });
  }

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Verify execution exists and is still running
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
      await connection.commit();
      return res.status(400).json({ 
        error: "Cannot cancel", 
        message: "Execution not found or already finished" 
      });
    }

    // Mark as cancelled
    await connection.query(
      `
      UPDATE workflow_executions 
      SET status = 'cancelled', 
          updated_at = NOW(),
          completed_at = NOW()
      WHERE id = ?
      `,
      [executionId]
    );

    // Delete any pending resume jobs for this execution
    await connection.query(
      `
      DELETE FROM scheduled_jobs 
      WHERE type = 'workflow_resume' 
        AND workflow_execution_id = ? 
        AND status IN ('pending', 'running')
      `,
      [executionId]
    );

    await connection.commit();
    connection.release();

    console.log(`[CANCEL] Execution ${executionId} cancelled by user`);

    res.json({
      success: true,
      executionId,
      message: "Workflow execution cancelled successfully"
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    console.error("[CANCEL EXECUTION] Failed:", err);
    res.status(500).json({ 
      error: "Failed to cancel execution", 
      message: err.message 
    });
  }
});



/**
 * POST /workflows/test-step
 * Dry-run a single step in isolation — resolves placeholders against provided
 * variables and executes the step exactly as the engine would, but writes
 * nothing to the DB. Safe to call repeatedly during workflow development.
 *
 * Body:
 *   step      { type, config }          — step definition (no id/workflow_id needed)
 *   variables { key: value, ... }       — simulated workflow variables
 *   env       { executionId?, stepNumber? }  — optional env overrides for {{env.*}}
 *
 * Returns:
 *   { success, output, set_vars, next_step, delayed_until, error?, duration_ms }
 */
router.post("/workflows/test-step", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { step, variables = {}, env = {} } = req.body;
 
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
 
  // Build job data
  const jobData = { type: step.type, ...resolvedConfig };
 
  // Inject _variables for evaluate_condition
  if (step.type === "internal_function" && resolvedConfig.params) {
    jobData.params = { ...resolvedConfig.params, _variables: variables };
  }
 
  const strategy   = errorPolicy.strategy || "ignore";
  const maxRetries = Number(errorPolicy.max_retries) || 0;
  const backoffSec = Number(errorPolicy.backoff_seconds) || 5;
 
  const startTime = Date.now();
  let rawResult, success, errorMsg;
  let attempt = 1;
 
  // Execute with retry logic (mirrors executeStep in workflow_engine.js)
  while (true) {
    try {
      rawResult = await executeJob({ data: jobData }, db);
      success = true;
      break;
    } catch (err) {
      if (attempt > maxRetries) {
        success  = false;
        errorMsg = err.message;
        break;
      }
      await new Promise(r => setTimeout(r, backoffSec * 1000 * attempt));
      attempt++;
    }
  }
 
  const duration_ms = Date.now() - startTime;
 
  if (!success) {
    return res.json({
      success:      false,
      error:        errorMsg,
      duration_ms,
      attempts:     attempt,
      would_abort:  strategy === "abort" || strategy === "retry_then_abort"
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
    resolved_config: resolvedConfig   // handy for debugging placeholder resolution
  });
});


module.exports = router;