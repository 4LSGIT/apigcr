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
 * OPT-OUT (ruling 2026-10-27, services/optoutService.js): an API-key caller is
 * automation and is REFUSED (422 code 'opted_out') when the recipient's active
 * row is opted out; a staff-JWT caller is WARNED — 409 code 'opted_out' until
 * the body carries acknowledge_optout:true (public/js/optoutAck.js turns that
 * into a confirm). Checked before anything is sent.
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
const { optoutGate, overrideLine } = require("../../services/optoutService");

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
    const opt = await optoutGate(req.db, {
      channel: "sms", dest: to, acknowledged: req.body.acknowledge_optout,
      automation: !(req.auth && req.auth.type === "jwt"),
    });
    if (opt.refusal) return res.status(opt.refusal.status).json(opt.refusal.body);
    if (opt.overridden.length) console.log(`[internal/sms] user ${req.auth.userId} acknowledged opt-out for ${overrideLine(opt.overridden)}`);
    const result = await phoneService.sendSms(req.db, from, to, message);
    res.json({ status: "success", data: result });
  } catch (err) {
    console.error("Internal SMS error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

module.exports = router;
