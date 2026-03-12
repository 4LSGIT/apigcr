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
// routes/workflows.js
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

    // Background advance with timeout guard
    (async () => {
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Advance timeout")), 15000)
        );

        const advanceResult = await Promise.race([
          advanceWorkflow(executionId, db),
          timeoutPromise
        ]);

        console.log(`[ASYNC ADVANCE] Completed: ${advanceResult.status}`);
      } catch (err) {
        console.log(`[ASYNC ADVANCE] Timeout or error: ${err.message}`);
        await db.query(
          `UPDATE workflow_executions SET status = 'failed', updated_at = NOW() WHERE id = ?`,
          [executionId]
        );
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