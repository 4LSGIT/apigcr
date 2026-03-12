/**
 * Internal SMS Route
 * POST /internal/sms/send
 *
 * Thin HTTP wrapper around smsService.
 * Protected by jwtOrApiKey — internal use only.
 *
 * Body:
 *   from     string  - 10-digit number matching phone_lines table
 *   to       string  - recipient number (any common format)
 *   message  string  - text content
 */

const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../../lib/auth.jwtOrApiKey");
const smsService = require("../../services/smsService");

router.post("/internal/sms/send", jwtOrApiKey, async (req, res) => {
  const { from, to, message } = req.body;

  if (!from || !to || !message) {
    return res.status(400).json({
      status: "error",
      message: "Missing required fields: from, to, message"
    });
  }

  try {
    const result = await smsService.sendSms(req.db, from, to, message);
    res.json({ status: "success", data: result });
  } catch (err) {
    console.error("Internal SMS error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

module.exports = router;