/**
 * Internal Email Route
 * POST /internal/email/send
 *
 * Thin HTTP wrapper around emailService.
 * Protected by jwtOrApiKey — internal use only.
 *
 * Body:
 *   from         string  - must match a row in email_credentials
 *   to           string  - recipient address
 *   subject      string
 *   text         string  - plain text body (required even with html)
 *   html         string  - optional HTML body
 *   attachments      array   - optional nodemailer attachments (smtp only)
 *   attachment_urls  array   - optional [{ url, name }] for Pabbly/Gmail
 *                             also accepts a single { url, name } object
 *                             or legacy comma-separated URL string
 */

const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../../lib/auth.jwtOrApiKey");
const emailService = require("../../services/emailService");

router.post("/internal/email/send", jwtOrApiKey, async (req, res) => {
  const { from, to, subject, text, html, attachments, attachment_urls } = req.body;

  if (!from || !to || !subject || !text) {
    return res.status(400).json({
      status: "error",
      message: "Missing required fields: from, to, subject, text"
    });
  }

  try {
    const result = await emailService.sendEmail(req.db, {
      from, to, subject, text, html, attachments, attachment_urls
    });
    res.json({ status: "success", messageId: result.messageId });
  } catch (err) {
    console.error("Internal email error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

module.exports = router;