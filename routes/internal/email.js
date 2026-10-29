// routes/internal/email.js
//
/**
 * Internal Email Route
 * POST /internal/email/send
 *
 * Thin HTTP wrapper around emailService.
 * Protected by jwtOrApiKey — internal use only. Despite the path this is also
 * a live STAFF send path (public/communicate.html, public/sendingform*.html).
 *
 * OPT-OUT (ruling 2026-10-27, services/optoutService.js): an API-key caller is
 * automation and is REFUSED (422 code 'opted_out') when any address in `to` is
 * opted out; a staff-JWT caller is WARNED — 409 code 'opted_out' until the
 * body carries acknowledge_optout:true (public/js/optoutAck.js turns that into
 * a confirm). Checked before anything is sent. This mail is operational and an
 * email opt-out is marketing-only (YisraMail D18), so the gate never refuses
 * today; it stays for C7's promotional sends.
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
 *   signature        boolean - optional, default false. Append the sender's
 *                             stored signature (email_credentials
 *                             .signature_html/_text). No-op when the sender
 *                             has no signature configured.
 */

const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../../lib/auth.jwtOrApiKey");
const emailService = require("../../services/emailService");
const { optoutGate } = require("../../services/optoutService");

router.post("/internal/email/send", jwtOrApiKey, async (req, res) => {
  const { from, to, subject, text, html, attachments, attachment_urls, signature } = req.body;

  if (!from || !to || !subject || !text) {
    return res.status(400).json({
      status: "error",
      message: "Missing required fields: from, to, subject, text"
    });
  }

  try {
    const opt = await optoutGate(req.db, {
      channel: "email", dest: to, acknowledged: req.body.acknowledge_optout,
      automation: !(req.auth && req.auth.type === "jwt"),
    });
    if (opt.refusal) return res.status(opt.refusal.status).json(opt.refusal.body);
    if (opt.overridden.length) console.log(`[internal/email] user ${req.auth.userId} acknowledged opt-out for contact(s) ${opt.overridden.map((r) => r.contact_id).join(",")}`);
    const result = await emailService.sendEmail(req.db, {
      from, to, subject, text, html, attachments, attachment_urls,
      signature: signature === true
    });
    res.json({ status: "success", messageId: result.messageId });
  } catch (err) {
    console.error("Internal email error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

module.exports = router;