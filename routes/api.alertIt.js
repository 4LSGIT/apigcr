// routes/api.alertIt.js
//
// POST /api/alert/it — push an alert to IT from an AI session (triage, docs
// review, any session that finds something burning) without a human
// round-trip. Rides the readonly-key auth class (X-Readonly-Api-Key), same
// as /api/readonly/sql and /api/scratch.
//
// Body: { subject, message, severity? }
//   subject   required, string, ≤ 200 chars
//   message   required, string, ≤ 10,000 chars, PLAIN TEXT. There is no HTML
//             sanitizer in this repo; the email is sent text-only and
//             emailService.textToHtml escapes it, so markup renders inert.
//   severity  'info' | 'warn' | 'critical' (default 'info'; 'warning' is
//             accepted as an alias of 'warn').
//
// DELIVERY IS DERIVED FROM SEVERITY — THERE IS NO channel PARAM.
//   info / warn  → email only
//   critical     → email + SMS (phones are for fires)
// A `channel` key in the body is an explicit 400, not silently ignored: a
// caller sending channel expects channel semantics, and teaching the caller
// the contract via the error beats delivering something it didn't ask for.
//
// Recipients — settings, not code (reusing EXISTING settings; no new rows):
//   email to    cfg('email_it')  (app_settings email_it → IT_EMAIL env),
//               fallback 'it@4lsg.com' — same chain as api.issueReports.
//   email from  alert_from_email setting → cfg('email_automations')
//               (→ AUTO_EMAIL env). Same chain as lib/alerting's
//               sendAlertEmail, for the same delivery-independence reason.
//   sms to      alert_critical_sms_to (csv). Unset → SMS silently skipped
//               and noted in the response (spec'd behavior).
//   sms from    sms_staff_from → sms_default_from (the taskService /
//               lib/alerting chain).
//
// Semantics:
//   SYNCHRONOUS send — this is the one place respond-first is wrong: an
//   alert that fails must fail loudly. Any ATTEMPTED send that fails → 502
//   with the error (sent flags in the body tell the caller what did go out).
//   A send that was never attempted because its config is unset (SMS
//   recipient / SMS from-line) is a skip, not a failure — noted, still 200.
//
//   Rate limit 10/hour per key, in-memory sliding window keyed on
//   req.auth.keyId. Checked AFTER validation so a caller's malformed
//   attempts can't burn the quota it needs for the real alert. The 429 tells
//   the caller to fold overflow into one digest alert. In-memory means
//   per-instance; Cloud Run runs min-instances=1 so this is effectively
//   global, and an occasional second instance doubling the budget is
//   acceptable for an IT-alert path.
//
// Audit: every call — accept and reject — writes admin_audit_log with
// tool='it_alert' (auth-layer rejects are already logged by
// lib/auth.readonly under tool='readonlyKeys'). Audit failure never blocks
// the alert: delivery outranks the trail here.
//
// Out of scope (deliberate, per slice spec): templating, recipient lists,
// dedupe/quiet-hours. YAGNI until triage runs for a few weeks.

const express = require("express");
const router  = express.Router();
const { readonlyApiKeyAuth } = require("../lib/auth.readonly");
const { auditAdminAction }   = require("../lib/auth.superuser");
const { getSetting }         = require("../services/settingsService");
const { cfg }                = require("../lib/firmConfig");

const SUBJECT_MAX    = 200;
const MESSAGE_MAX    = 10_000;
const RATE_LIMIT     = 10;                 // alerts per window per key
const RATE_WINDOW_MS = 60 * 60 * 1000;     // 1 hour, sliding
const SMS_BODY_MAX   = 400;                // ≤ 3 segments; subject leads

const SEVERITIES = new Set(["info", "warn", "critical"]);

const ipOf = (req) =>
  req.headers["x-forwarded-for"]?.split(",").shift() || req.socket?.remoteAddress;

function trunc(s, n) {
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

// ── rate limiter (per-key, sliding window, in-memory) ────────────────────
// Same idiom as lib/auth.superuser's SU limiter, scoped to this route.
const hits = new Map(); // keyId → [epoch ms, …] within the window

function rateLimitCheck(keyId) {
  const now    = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const arr    = (hits.get(keyId) || []).filter((t) => t >= cutoff);
  if (arr.length >= RATE_LIMIT) {
    hits.set(keyId, arr);
    return { ok: false, retryInMs: arr[0] + RATE_WINDOW_MS - now };
  }
  arr.push(now);
  hits.set(keyId, arr);
  // Opportunistic prune of dead keys so the map can't grow unbounded.
  if (hits.size > 200) {
    for (const [k, a] of hits) {
      if (!a.length || a[a.length - 1] < cutoff) hits.delete(k);
    }
  }
  return { ok: true };
}

// ── audit ────────────────────────────────────────────────────────────────
async function audit(req, status, details, errorMessage, durationMs) {
  try {
    await auditAdminAction(req.db, {
      tool: "it_alert",
      userId: null,
      username: null,
      route: req.originalUrl,
      method: req.method,
      status,
      errorMessage: errorMessage ?? null,
      durationMs,
      ip: ipOf(req),
      userAgent: req.headers["user-agent"] || "unknown",
      details,
    });
  } catch (err) {
    console.error("[api.alertIt] audit write failed:", err.message);
  }
}

// ── route ────────────────────────────────────────────────────────────────
router.post("/api/alert/it", readonlyApiKeyAuth, async (req, res) => {
  const started  = Date.now();
  const db       = req.db;
  const keyId    = req.auth.keyId;
  const keyLabel = req.auth.label;

  // 1. Validate.
  const body = req.body || {};
  let { subject, message, severity } = body;
  const errors = [];

  if (typeof subject !== "string" || !subject.trim()) {
    errors.push("subject is required (non-empty string)");
  } else if (subject.length > SUBJECT_MAX) {
    errors.push(`subject exceeds ${SUBJECT_MAX} chars`);
  }
  if (typeof message !== "string" || !message.trim()) {
    errors.push("message is required (non-empty string, plain text)");
  } else if (message.length > MESSAGE_MAX) {
    errors.push(`message exceeds ${MESSAGE_MAX} chars`);
  }
  if (severity == null || severity === "") {
    severity = "info";
  } else {
    severity = String(severity).toLowerCase();
    if (severity === "warning") severity = "warn"; // codebase-wide spelling; cheap to accept
    if (!SEVERITIES.has(severity)) {
      errors.push("severity must be one of: info, warn, critical");
    }
  }
  if ("channel" in body) {
    errors.push(
      "channel is not accepted — delivery is derived from severity (critical → email + SMS, otherwise email only)"
    );
  }

  if (errors.length) {
    await audit(req, "rejected_validation", {
      keyId, keyLabel, errors,
      subject: typeof subject === "string" ? trunc(subject, SUBJECT_MAX) : null,
    }, null, Date.now() - started);
    return res.status(400).json({ error: errors.join("; ") });
  }
  subject = subject.trim();

  // 2. Rate limit (post-validation — malformed attempts don't burn quota).
  const rl = rateLimitCheck(keyId);
  if (!rl.ok) {
    await audit(req, "rejected_rate_limit", {
      keyId, keyLabel, severity, subject: trunc(subject, SUBJECT_MAX),
    }, null, Date.now() - started);
    return res.status(429).json({
      error:
        `Rate limit: ${RATE_LIMIT} IT alerts per hour per key. ` +
        `Fold further findings into a single digest alert instead of sending more.`,
      retryInMs: rl.retryInMs,
    });
  }

  const sent     = { email: false, sms: false };
  const notes    = [];
  const failures = [];
  const prefixed = `[YC-ALERT:${severity.toUpperCase()}] ${subject}`;

  // 3. Email — every severity.
  try {
    const from =
      ((await getSetting(db, "alert_from_email")) || "").trim() ||
      cfg("email_automations") || "";
    if (!from) {
      throw new Error(
        "no sender configured (alert_from_email setting / email_automations / AUTO_EMAIL env)"
      );
    }
    const to = cfg("email_it") || "it@4lsg.com";
    // Lazy require — circular-dep safety convention (see lib/alerting.js).
    const emailService = require("../services/emailService");
    // text-only: textToHtml escapes, so message markup renders inert.
    await emailService.sendEmail(db, { from, to, subject: prefixed, text: message });
    sent.email = true;
  } catch (err) {
    failures.push(`email: ${err.message}`);
  }

  // 4. SMS — critical only. Unset config = skip + note; attempted-and-failed
  //    = loud failure.
  let smsState = "not_applicable";
  if (severity === "critical") {
    try {
      const toSetting = ((await getSetting(db, "alert_critical_sms_to")) || "").trim();
      if (!toSetting) {
        smsState = "skipped_unset";
        notes.push("sms skipped: alert_critical_sms_to unset");
      } else {
        const from =
          (await getSetting(db, "sms_staff_from")) ||
          (await getSetting(db, "sms_default_from")) ||
          null;
        if (!from) {
          smsState = "skipped_no_from";
          notes.push("sms skipped: no sms_staff_from / sms_default_from line configured");
        } else {
          const phoneService = require("../services/phoneService");
          const smsBody = trunc(`${prefixed} — ${message}`, SMS_BODY_MAX);
          const recipients = toSetting.split(",").map((s) => s.trim()).filter(Boolean);
          const smsErrors = [];
          for (const to of recipients) {
            try {
              await phoneService.sendSms(db, from, to, smsBody);
            } catch (err) {
              smsErrors.push(`${to}: ${err.message}`);
            }
          }
          if (smsErrors.length) {
            failures.push(`sms: ${smsErrors.join("; ")}`);
            sent.sms = smsErrors.length < recipients.length; // partial truth
            smsState = sent.sms ? "partial" : "failed";
          } else {
            sent.sms = true;
            smsState = "sent";
          }
        }
      }
    } catch (err) {
      failures.push(`sms: ${err.message}`);
      smsState = "failed";
    }
  }

  // 5. Respond + audit.
  const details = {
    keyId, keyLabel, severity,
    subject: trunc(subject, SUBJECT_MAX),
    sent, sms: smsState,
    ...(notes.length ? { notes } : {}),
    ...(failures.length ? { failures } : {}),
  };

  if (failures.length) {
    await audit(req, "send_failed", details, failures.join(" | "), Date.now() - started);
    return res.status(502).json({
      ok: false, sent,
      error: failures.join(" | "),
      ...(notes.length ? { notes } : {}),
    });
  }

  await audit(req, "sent", details, null, Date.now() - started);
  return res.json({ ok: true, severity, sent, ...(notes.length ? { notes } : {}) });
});

// Test seam — jest resets the sliding window between tests.
router._test = {
  resetRateLimit() { hits.clear(); },
  RATE_LIMIT,
};

module.exports = router;
