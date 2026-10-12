// routes/internal/sms.js
//
/**
 * Internal SMS Route
 * POST /internal/sms/send
 *
 * Thin HTTP wrapper around phoneService.
 * Protected by jwtOrApiKey. Despite the /internal path this is ALSO the live
 * staff SMS send path: public/communicate.html (contact Communicate tab) and
 * public/sendingform*.html call it with the staff JWT.
 *
 * GRANT GATE (mailbox-system arc S-PH, ruling 2026-10-12): a STAFF-JWT caller
 * must hold can_send on the line `from` names (SU: always; the attorney READ
 * bypass does not send): phoneCommsService.staffSendGate, the same rule as
 * the comms hub's POST /api/phone-lines/:id/sms. API-key callers (automations,
 * the internal key) stay grant-blind (D6). Checked before anything is sent.
 *
 * Body:
 *   from     string  - 10-digit number matching phone_lines table
 *   to       string  - recipient number (any common format)
 *   message  string  - text content
 */

const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../../lib/auth.jwtOrApiKey");
const phoneService = require("../../services/phoneService");
const { staffSendGate } = require("../../services/phoneCommsService");

router.post("/internal/sms/send", jwtOrApiKey, async (req, res) => {
  const { from, to, message } = req.body;

  if (!from || !to || !message) {
    return res.status(400).json({
      status: "error",
      message: "Missing required fields: from, to, message"
    });
  }

  try {
    if (req.auth && req.auth.type === "jwt") {
      const gate = await staffSendGate(req.db, req.auth.userId, from);
      if (!gate.ok) return res.status(gate.status).json({ status: "error", message: gate.message });
    }
    const result = await phoneService.sendSms(req.db, from, to, message);
    res.json({ status: "success", data: result });
  } catch (err) {
    console.error("Internal SMS error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

module.exports = router;
