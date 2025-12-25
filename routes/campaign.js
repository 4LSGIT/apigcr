/**
 * Campaign Route (MySQL-based background processing)
 * ------------------------------------------------------
 * - POST /campaigns/trigger
 * - Authenticates user
 * - Atomically locks campaign
 * - Responds immediately
 * - Processes campaign in background
 */

const express = require("express");
const router = express.Router();
const { sendCampaign } = require("../services/campaignService");

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

    // Atomically lock the campaign
    const [lock] = await req.db.query(
      "UPDATE campaigns SET status='sending' WHERE campaign_id=? AND status='scheduled'",
      [campaign_id]
    );

    if (!lock.affectedRows) {
      return res.status(400).json({ error: "Campaign already processed or sending" });
    }

    // Respond immediately
    res.json({ status: "queued", campaign_id });

    // Process campaign in background
    (async () => {
      try {
        const result = await sendCampaign(req.db, campaign_id);

        // Determine final status
        let finalStatus = "sent";
        if (result.failures && result.failures < result.total) finalStatus = "partial fail";
        if (result.failures && result.failures === result.total) finalStatus = "failed";

        await req.db.query(
          "UPDATE campaigns SET status=? WHERE campaign_id=?",
          [finalStatus, campaign_id]
        );

        console.log(`Campaign ${campaign_id} processed:`, result);
      } catch (err) {
        console.error("Background campaign send failed:", err);
        // Update campaign to failed
        await req.db.query(
          "UPDATE campaigns SET status='failed' WHERE campaign_id=?",
          [campaign_id]
        );
      }
    })();

  } catch (err) {
    console.error("Campaign trigger error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
