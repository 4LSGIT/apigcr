// routes/ringcentral.js
//
/**
 * RingCentral Routes — TRAP SHIMS
 * ------------------------------------------------------
 * Pre-Connections legacy SMS/MMS routes. Internal callers all migrated to
 * /internal/sms/send and /internal/mms/send. We don't know whether anything
 * external still hits these endpoints, so we keep them as trap shims:
 *
 *   - legacyTrap middleware writes every inbound request (incl. headers,
 *     body, query) to legacy_route_log. Review the table to identify
 *     callers.
 *   - alertOnce sends a throttled email to IT_EMAIL on each distinct
 *     caller (1/hr per route+ip+ua) so a hit doesn't sit unnoticed.
 *   - Actual send goes through phoneService — same outcome as before.
 *
 * After ~1 week of empty traps:
 *   1. Delete this file.
 *   2. DROP TABLE legacy_route_log.
 *   3. Delete lib/legacyTrap.js if no other legacy routes use it.
 *
 * The legacy OAuth callback, authorize, and status routes are gone —
 * Connections owns OAuth now.
 */

const express      = require("express");
const router       = express.Router();
const phoneService = require("../services/phoneService");
const emailService = require("../services/emailService");
const trap         = require("../lib/legacyTrap");

// In-memory throttle so a misconfigured cron can't bury IT in 1500
// emails overnight. 1 hour per (route, ip, user-agent) tuple.
const ALERT_THROTTLE_MS = 60 * 60 * 1000;
const lastAlertAt = new Map();

function checkApiKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.key;
  if (key !== process.env.RINGCENTRAL_API_KEY) {
    return res.status(403).json({ error: "Invalid API Key" });
  }
  next();
}

function alertOnce(req, kind) {
  const ua = req.get("user-agent") || "unknown";
  const ip = req.ip || "unknown";
  const k  = `${kind}|${ip}|${ua}`;
  const now = Date.now();
  if ((now - (lastAlertAt.get(k) || 0)) < ALERT_THROTTLE_MS) return;
  lastAlertAt.set(k, now);

  const to   = process.env.IT_EMAIL;
  const from = process.env.AUTO_EMAIL;
  if (!to || !from) {
    console.warn("[LEGACY-RINGCENTRAL] IT_EMAIL or AUTO_EMAIL not set; alert skipped");
    return;
  }

  emailService.sendEmail(req.db, {
    from,
    to,
    subject: `[YisraCase] Legacy route hit: /ringcentral/${kind}`,
    text:
      `Deprecated route /ringcentral/${kind} was called.\n\n` +
      `Environment:  ${process.env.ENVIRONMENT || "unknown"}\n` +
      `Time:         ${new Date().toISOString()}\n` +
      `IP:           ${ip}\n` +
      `User-Agent:   ${ua}\n` +
      `From:         ${req.body?.from || req.query?.from || "n/a"}\n` +
      `To:           ${req.body?.to   || req.query?.to   || "n/a"}\n\n` +
      `Full request (incl. headers and body) logged in legacy_route_log.\n\n` +
      `Throttled to once per hour per distinct caller (route+ip+UA).`
  }).catch(e => console.error("[LEGACY-RINGCENTRAL] alert email failed:", e.message));
}

// Order: trap → checkApiKey → alertOnce → handler.
//   - trap runs first so even rejected (bad-key) hits are recorded —
//     useful for distinguishing real callers from probes.
//   - alertOnce only fires on authenticated hits to keep signal high.

router.all(
  "/ringcentral/send-sms",
  trap("/ringcentral/send-sms"),
  checkApiKey,
  async (req, res) => {
    alertOnce(req, "send-sms");
    try {
      const { from, to, message } = { ...req.query, ...req.body };
      const result = await phoneService.sendSms(req.db, from, to, message);
      res.json(result);
    } catch (err) {
      console.error("Legacy RC SMS send failed:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

router.post(
  "/ringcentral/send-mms",
  trap("/ringcentral/send-mms"),
  checkApiKey,
  async (req, res) => {
    alertOnce(req, "send-mms");
    try {
      const { from, to, text, attachment_url } = req.body || {};
      if (!attachment_url) {
        console.warn(
          "[LEGACY-RINGCENTRAL] /ringcentral/send-mms hit WITHOUT attachment_url — " +
          "if caller is uploading a file, it needs migration to URL-based attachments"
        );
        return res.status(400).json({ error: "attachment_url is required (file uploads no longer supported)" });
      }
      const result = await phoneService.sendMms(req.db, from, to, text || "", attachment_url);
      res.json(result);
    } catch (err) {
      console.error("Legacy RC MMS send failed:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;