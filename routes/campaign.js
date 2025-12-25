/**
 * Campaign Route
 * ------------------------------------------------------
 * - POST /campaigns/trigger
 * - Authenticates user
 * - Enqueues campaign job in Bull
 * - Returns immediately with job queued
 */

const express = require("express");
const router = express.Router();
const Bull = require("bull");
const { sendCampaign } = require("../services/campaignService");

// Redis connection for Bull
const campaignQueue = new Bull("campaignQueue", {
  redis: { host: "127.0.0.1", port: 6379 }
});

// -------------------- Job Processor --------------------
campaignQueue.process(async (job) => {
  const { db, campaign_id } = job.data;
  return sendCampaign(db, campaign_id);
});

// -------------------- POST /campaigns/trigger --------------------
router.post("/campaigns/trigger", async (req, res) => {
  const { username, password, campaign_id } = req.body;

  if (!username || !password || !campaign_id) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  try {
    // Authenticate user
    const [[auth]] = await req.db.query(
      "SELECT user_auth FROM users WHERE username=? AND password=?",
      [username, password]
    );

    if (!auth?.user_auth?.startsWith("authorized")) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Enqueue campaign job
    await campaignQueue.add({ db: req.db, campaign_id });

    res.json({ status: "queued", campaign_id });

  } catch (err) {
    console.error("Campaign trigger error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
