// routes/test_advance.js
const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const { advanceWorkflow } = require("../lib/workflow_engine"); // adjust path if needed

router.post("/test-advance/:executionId", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { executionId } = req.params;

  // Basic validation
  const idNum = parseInt(executionId, 10);
  if (isNaN(idNum) || idNum <= 0) {
    return res.status(400).json({ error: "Invalid executionId" });
  }

  try {
    console.log(`[TEST-ADVANCE] Starting manual advance for execution ${idNum} at ${new Date().toISOString()}`);

    const result = await advanceWorkflow(idNum, db);

    res.json({
      success: true,
      executionId: idNum,
      result
    });
  } catch (err) {
    console.error(`[TEST-ADVANCE] Failed for ${idNum}:`, err);
    res.status(500).json({
      error: "Advance failed",
      message: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined
    });
  }
});

module.exports = router;