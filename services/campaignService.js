/**
 * Campaign Service
 * ------------------------------------------------------
 * Handles:
 * - Sending email campaigns via SMTP
 * - Sending SMS campaigns via RingCentral
 * - Placeholder resolution (body + subject)
 * - Logging results
 * - Rate limiting (emails)
 */

const nodemailer = require("nodemailer");
const unplacehold = require("../lib/unplacehold");
const { sendSms } = require("./ringcentralService"); // existing RingCentral service

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendWithRetry(fn, retries = 2) {
  let attempt = 0, lastErr;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      attempt++;
      if (attempt > retries) break;
      await sleep(500 * attempt);
    }
  }
  throw lastErr;
}

async function sendCampaign(db, campaign_id) {
  // 1. Load campaign
  const [[campaign]] = await db.query(
    "SELECT * FROM campaigns WHERE campaign_id=?",
    [campaign_id]
  );
  if (!campaign) throw new Error("Campaign not found");

  const contactIds = campaign.contact_ids
    .split(",")
    .map(id => parseInt(id.trim()))
    .filter(Boolean);

  let failures = 0;

  // Prepare SMTP transporter if email campaign
  let transporter = null;
  if (campaign.type === "email") {
    const [[smtp]] = await db.query(
      "SELECT * FROM email_credentials WHERE email=?",
      [campaign.sender]
    );
    if (!smtp) throw new Error("No SMTP credentials for sender");

    transporter = nodemailer.createTransport({
      host: smtp.smtp_host,
      port: smtp.smtp_port,
      secure: !!smtp.smtp_secure,
      auth: { user: smtp.smtp_user, pass: smtp.smtp_pass }
    });
  }

  // 2. Loop through contacts
  for (const contact_id of contactIds) {
    try {
      // Resolve placeholders in both body and subject
      const bodyResult = await unplacehold({ db, text: campaign.body, contact_id, strict: true });
      const subjectResult = await unplacehold({ db, text: campaign.subject, contact_id, strict: true });

      if (bodyResult.status === "failed" || subjectResult.status === "failed") {
        throw new Error("Unresolved placeholders");
      }

      if (campaign.type === "email") {
        const [[contact]] = await db.query(
          "SELECT contact_email FROM contacts WHERE contact_id=?",
          [contact_id]
        );
        if (!contact?.contact_email) throw new Error("Contact email not found");

        await sendWithRetry(() =>
          transporter.sendMail({
            from: campaign.sender,
            to: contact.contact_email,
            subject: subjectResult.text, // resolved subject
            html: bodyResult.text        // resolved body
          })
        );

        await db.query(
          "INSERT INTO campaign_results (campaign_id, contact_id, status) VALUES (?,?,?)",
          [campaign_id, contact_id, "sent"]
        );

        await sleep(500); // email rate limit

      } else if (campaign.type === "sms") {
        const [[contact]] = await db.query(
          "SELECT contact_phone FROM contacts WHERE contact_id=?",
          [contact_id]
        );
        if (!contact?.contact_phone) throw new Error("Contact phone not found");

        await sendSms(db, campaign.sender, contact.contact_phone, bodyResult.text);

        await db.query(
          "INSERT INTO campaign_results (campaign_id, contact_id, status) VALUES (?,?,?)",
          [campaign_id, contact_id, "sent"]
        );
      }

    } catch (err) {
      failures++;
      await db.query(
        "INSERT INTO campaign_results (campaign_id, contact_id, status, error) VALUES (?,?,?,?)",
        [campaign_id, contact_id, "failed", err.message]
      );
    }
  }

  return { total: contactIds.length, failures };
}

module.exports = { sendCampaign };
