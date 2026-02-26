// routes/workflows.js
const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const { advanceWorkflow } = require("../lib/workflow_engine"); // adjust path

/**
 * POST /workflows/:id/start
 * Starts a new execution of the workflow
 * Body: { init_data?: object }
 * Returns the new execution ID and initial advance result
 */
router.post("/workflows/:id/start", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { init_data = {} } = req.body;

  const workflowId = parseInt(id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // 1. Verify workflow exists
    const [wfRows] = await connection.query(
      `SELECT id FROM workflows WHERE id = ?`,
      [workflowId]
    );
    if (wfRows.length === 0) {
      await connection.commit();
      return res.status(404).json({ error: "Workflow not found" });
    }

    // 2. Create new execution
    const [insertResult] = await connection.query(
      `
      INSERT INTO workflow_executions
      (workflow_id, status, init_data, variables, current_step_number)
      VALUES (?, 'active', ?, ?, 1)
      `,
      [workflowId, JSON.stringify(init_data), JSON.stringify(init_data)] // merge init → variables
    );

    const executionId = insertResult.insertId;

    await connection.commit();
    connection.release();
    connection = null;

    console.log(`[WORKFLOW START] Created execution ${executionId} for workflow ${workflowId}`);

    // 3. Immediately advance (kick off the first step(s))
    const advanceResult = await advanceWorkflow(executionId, db);

    res.status(201).json({
      success: true,
      executionId,
      workflowId,
      status: advanceResult.status,
      message: advanceResult.message || "Execution started and advanced",
      advanceResult
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    console.error(`[WORKFLOW START] Failed for workflow ${workflowId}:`, err);
    res.status(500).json({
      error: "Failed to start workflow",
      message: err.message
    });
  }
});

/**
 * Optional: GET /workflows (list all)
 */
router.get("/workflows", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  try {
    const [rows] = await db.query(
      `SELECT id, name, description, created_at FROM workflows ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to list workflows" });
  }
});

module.exports = router;