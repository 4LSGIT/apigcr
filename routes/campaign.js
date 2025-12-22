const express = require("express");
const router = express.Router();
const nodemailer = require("nodemailer");
const unplacehold = require("../lib/unplacehold");

// small sleep helper for rate limiting
const sleep = ms => new Promise(r => setTimeout(r, ms));

// retry helper for SMTP sends
async function sendWithRetry(fn, retries = 2) {
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      attempt++;
      if (attempt > retries) break;
      await sleep(500 * attempt); // exponential-ish backoff
    }
  }
  throw lastErr;
}

// POST /campaigns/trigger
router.post("/campaigns/trigger", async (req, res) => {
  const { username, password, campaign_id } = req.body;

  if (!username || !password || !campaign_id) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  try {
    // 1. Auth check
    const [auth] = await req.db.promise().query(
      "SELECT user_auth FROM users WHERE username=? AND password=?",
      [username, password]
    );

    if (!auth.length || !auth[0].user_auth.startsWith("authorized")) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 2. Lock campaign (atomic)
    const [lock] = await req.db.promise().query(
      "UPDATE campaigns SET status='sending' WHERE campaign_id=? AND status='scheduled'",
      [campaign_id]
    );

    if (!lock.affectedRows) {
      return res.status(409).json({ error: "Campaign already processed or sending" });
    }

    // 3. Load campaign
    const [[campaign]] = await req.db.promise().query(
      "SELECT * FROM campaigns WHERE campaign_id=?",
      [campaign_id]
    );

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const contactIds = campaign.contact_ids
      .split(",")
      .map(id => parseInt(id.trim()))
      .filter(Boolean);

    // 4. Load SMTP credentials
    const [[smtp]] = await req.db.promise().query(
      "SELECT * FROM email_credentials WHERE email=?",
      [campaign.sender]
    );

    if (!smtp) {
      return res.status(500).json({ error: "No SMTP credentials found for sender" });
    }

    const transporter = nodemailer.createTransport({
      host: smtp.smtp_host,
      port: smtp.smtp_port,
      secure: !!smtp.smtp_secure,
      auth: { user: smtp.smtp_user, pass: smtp.smtp_pass }
    });

    let failures = 0;

    // 5. Loop over contacts
    for (const contact_id of contactIds) {
      try {
        // Resolve placeholders
        const result = await unplacehold({
          db: req.db,
          text: campaign.body,
          contact_id,
          strict: true
        });

        if (result.status === "failed") {
          throw new Error("Unresolved placeholders");
        }

        // Lookup contact email for sending
        const [[contact]] = await req.db.promise().query(
          "SELECT contact_email FROM contacts WHERE contact_id=?",
          [contact_id]
        );

        if (!contact?.contact_email) {
          throw new Error("Contact email not found");
        }

        // Send email with retry
        await sendWithRetry(() =>
          transporter.sendMail({
            from: campaign.sender,
            to: contact.contact_email,
            subject: campaign.subject,
            html: result.text
          })
        );

        // Log success
        await req.db.promise().query(
          "INSERT INTO campaign_results (campaign_id, contact_id, status) VALUES (?,?,?)",
          [campaign_id, contact_id, "sent"]
        );

        // Optional rate limiting (500ms between sends)
        await sleep(500);

      } catch (err) {
        failures++;
        await req.db.promise().query(
          "INSERT INTO campaign_results (campaign_id, contact_id, status, error) VALUES (?,?,?,?)",
          [campaign_id, contact_id, "failed", err.message]
        );
      }
    }

    // 6. Finalize campaign status
    await req.db.promise().query(
      "UPDATE campaigns SET status=? WHERE campaign_id=?",
      [failures ? "failed" : "sent", campaign_id]
    );

    res.json({ status: "completed", total: contactIds.length, failures });

  } catch (err) {
    console.error("Campaign trigger error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
