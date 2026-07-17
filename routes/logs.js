// routes/logs.js
//
// ─────────────────────────────────────────────────────────────────────────
// Slice 1.2c CANARY (2026-05-28) — DEPRECATED ROUTE
//
// /logEmail was the legacy Pabbly-fed inbound email logger and (after the
// Slice 1.2b GAS cutover) was kept active as a fallback. As of 2026-05-28,
// verified zero traffic in the prior 24h: every gmail-firm email_log row
// in the window had a corresponding email_ingest_executions reference
// (via POST /api/email/ingest), proving the new path is the only writer.
//
// The handler below intercepts ANY hit on this route, logs a [CANARY-1.2c]
// diagnostic to stderr (Cloud Run alerts Fred on the error), and returns
// HTTP 410 Gone with a redirect message. After a watch period of silence
// (~1 week), this entire route file is destructively removed.
//
// To temporarily restore the legacy handler: comment out the canary block
// inside the route handler. The original handler body is preserved intact
// below it, unreachable but unchanged.
// ─────────────────────────────────────────────────────────────────────────
//
// Inbound email logger. Called by Pabbly's email-router when an email
// arrives at one of the firm's monitored inboxes. Writes:
//
//   1. email_log row — raw bytes for forensics (dedup'd by message_id;
//      race-safe via ER_DUP_ENTRY catch on the unique-keyed INSERT).
//   2. log row via logService — surfaces in case/contact via the
//      Phase-A contact-log reader's date-windowed EXISTS join on
//      contact_emails. link_type='email' + link_id=<value> means the
//      row is orphan-safe (written regardless of whether the sender
//      matches a known contact).
//
// Track A.1 Phase B (Slice 4-D follow-up):
//   - Multi-domain firm support via EMAIL_DOMAINS (comma-separated).
//     EMAIL_DOMAIN (singular) still honored as a fallback.
//   - log row writes go through logService.createLogEntry with
//     link_type='email' (populates log_link_type / log_link_id /
//     log_direction; no longer drops orphan-sender rows).
//   - Inline UPDATE on appts.appt_status replaced with sequence-engine
//     cancellation, fire-and-forget after 200. Uses
//     resolveContactsByValue so child-table-only emails are covered
//     (the legacy contacts.contact_email lookup missed those).
//   - log_data is passed to logService as an object — logService
//     re-stringifies cleanly so truncated rows produce well-formed
//     JSON instead of the legacy broken-quote-and-close fallback.

const express        = require("express");
const router         = express.Router();
const trap           = require("../lib/legacyTrap");
const logService     = require("../services/logService");
const contactService = require("../services/contactService");

// Lazy-require to avoid the circular dependency
// (sequenceEngine → job_executor → internal_functions). Mirrors
// apptService.js (lib/sequenceEngine.js is the same module either path).
function getSequenceEngine() {
  return require("../lib/sequenceEngine");
}

// ─────────────────────────────────────────────────────────────
// Internal-domain detection
// ─────────────────────────────────────────────────────────────
//
// EMAIL_DOMAINS (plural, comma-separated) is the canonical env var.
// EMAIL_DOMAIN (singular) is honored as a fallback for back-compat.
// Each entry is normalized to leading-'@' lowercase form ('4lsg.com'
// and '@4lsg.com' both accepted as input). If neither env var is set,
// default to ['@4lsg.com'] — same as the legacy default.
//
// Read via firmConfig per call (email_domains setting → EMAIL_DOMAINS /
// EMAIL_DOMAIN env), memoized on the raw value — live-editable, parsed once
// per distinct value.

const { cfg } = require("../lib/firmConfig");

function _parseDomainList(raw) {
  return String(raw)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => (s.startsWith("@") ? s : "@" + s))
    .map(s => s.toLowerCase());
}

let _domainsRaw = null;
let _domainsParsed = ["@4lsg.com"];
function internalDomains() {
  const raw = cfg("email_domains");
  if (raw !== _domainsRaw) {
    _domainsRaw = raw;
    _domainsParsed = (raw && raw.trim()) ? _parseDomainList(raw) : ["@4lsg.com"];
    console.log(`[logEmail] internal domains: ${JSON.stringify(_domainsParsed)}`);
  }
  return _domainsParsed;
}

function isInternalDomain(email) {
  if (!email || typeof email !== "string") return false;
  const lower = email.toLowerCase();
  return internalDomains().some(d => lower.endsWith(d));
}

// ─────────────────────────────────────────────────────────────
// log_data size guard
// ─────────────────────────────────────────────────────────────
//
// log_data is a MySQL `text` column (65,535-byte hard limit). The
// final marshaled JSON includes the capitalized {From,To,Subject,
// Message} keys plus the lowercase {from,to,subject} that logService
// folds in. Aim for ≤65,000 bytes to leave headroom for the column
// boundary and any minor row-level overhead.
//
// 90 days of production data: 11 rows (0.17%) had body_plain > 60k
// chars; max ever was 65,372 chars. The 50,000-char soft cap below
// covers all of those with the truncation marker visible in the UI.
// The belt-and-braces loop handles pathological JSON-escape inflation
// (heavy control-char or quote density) that the static cap can't
// predict — extremely rare in practice but defensive against an
// unbounded write that would 500 the route and trigger Pabbly retries.

const LOG_DATA_HARD_CAP = 65000;
const MESSAGE_SOFT_CAP  = 50000;

function fitLogData(logObj, fromVal, toVal, subjectVal) {
  // Apply the soft cap to Message first.
  let m = logObj.Message || "";
  if (m.length > MESSAGE_SOFT_CAP) {
    m = m.substring(0, MESSAGE_SOFT_CAP) + "…[truncated]";
    logObj.Message = m;
  }

  // Preview the full marshaled blob, including the lowercase keys
  // that logService will fold in. Trim Message further until it fits.
  // Bounded: each iteration cuts ≥500 chars, so this terminates in
  // O(message_length / 500) steps even on pathological input.
  const buildPreview = () =>
    JSON.stringify({
      ...logObj,
      from: fromVal, to: toVal, subject: subjectVal,
    });

  let preview = buildPreview();
  while (preview.length > LOG_DATA_HARD_CAP && (logObj.Message || "").length > 100) {
    const excess = preview.length - LOG_DATA_HARD_CAP;
    const cut    = Math.max(500, Math.ceil(excess * 1.1));
    const cur    = logObj.Message.replace(/…\[truncated\]$/, "");
    logObj.Message = cur.substring(0, Math.max(50, cur.length - cut)) + "…[truncated]";
    preview = buildPreview();
  }
  return logObj;
}

// ─────────────────────────────────────────────────────────────
// POST /logEmail
// ─────────────────────────────────────────────────────────────

router.post("/logEmail", trap("logEmail"), async (req, res) => {
  // ─────────────────────────────────────────────────────────────────────────
  // Slice 1.2c CANARY — DEPRECATED ROUTE
  //
  // If you're seeing this canary fire, an adapter is still POSTing to the
  // legacy /logEmail endpoint. All gmail-firm inbound traffic must use
  // POST /api/email/ingest with X-Email-Ingest-Key. The console.error below
  // is the GCR alerting signal.
  //
  // To restore legacy behavior temporarily, comment out this entire block.
  // ─────────────────────────────────────────────────────────────────────────
  const canaryDiag = {
    messageID: req.body && req.body.messageID ? String(req.body.messageID) : null,
    from:      req.body && req.body.from      ? String(req.body.from)      : null,
    to:        req.body && req.body.to        ? String(req.body.to)        : null,
    subject:   req.body && req.body.subject   ? String(req.body.subject).slice(0, 80) : null,
    remote_ip: req.ip,
    ua:        req.headers && req.headers["user-agent"] ? req.headers["user-agent"].slice(0, 120) : null,
  };
  console.error(
    `[logEmail][CANARY-1.2c] DEPRECATED ROUTE HIT — investigate caller. ${JSON.stringify(canaryDiag)}`
  );
throw new Error(
  `[CANARY-1.2c] Deprecated /logEmail route hit: ${JSON.stringify(canaryDiag)}`
);
  return res.status(410).json({
    error:   "Gone",
    message: "/logEmail is deprecated (Slice 1.2c canary). Use POST /api/email/ingest with X-Email-Ingest-Key. The legacy route will be removed after the watch period.",
  });

  // ── LEGACY HANDLER (UNREACHABLE during the canary; preserved for revert) ──

  const db = req.db;
  const { to, from, subject, body_plain, attachments, messageID } = req.body;

  if (!messageID) {
    return res.status(400).json({ error: "messageID is required" });
  }

  try {
    // ── 1. Duplicate check on (source, message_id) ──
    // The pre-SELECT is the friendly path for normal Pabbly retries.
    // The INSERT below also catches ER_DUP_ENTRY for the race window
    // between this SELECT and the INSERT (two concurrent identical
    // messageIDs); both paths return the same "already processed" 200.
    //
    // Email Ingest Slice 1.1: filter is now scoped to source='gmail-firm'
    // because the UNIQUE on email_log is composite (source, message_id).
    // Without the source filter, a future ingest path (e.g. siteground-php)
    // forwarding the same RFC message_id from a different in-route would
    // be falsely flagged as a duplicate of this Gmail-side row.
    const [existing] = await db.query(
      "SELECT message_id FROM email_log WHERE source = 'gmail-firm' AND message_id = ?",
      [messageID]
    );
    if (existing.length > 0) {
      return res.status(200).json({ message: "Email already processed" });
    }

    // ── 2. Firm-to-firm skip ──
    // Both sides on a firm domain → don't log. (e.g. SS at @4lsg.com →
    // shoshana at @metrodetroitbankruptcylaw.com.)
    if (isInternalDomain(from) && isInternalDomain(to)) {
      return res.status(200).json({ message: "Internal Email not logged" });
    }

    // ── 3. Forensic email_log row (race-safe) ──
    const attachmentsStr =
      attachments && Array.isArray(attachments)
        ? JSON.stringify(attachments)
        : "[]";

    try {
      await db.query(
        `INSERT INTO email_log
           (source, message_id, from_email, to_email, subject, body, attachments, processed_at)
         VALUES ('gmail-firm', ?, ?, ?, ?, ?, ?,
                 CONVERT_TZ(NOW(), @@session.time_zone, 'EST5EDT'))`,
        [messageID, from, to, subject, body_plain, attachmentsStr]
      );
    } catch (insertErr) {
      // Race: another request inserted between our SELECT above and
      // this INSERT. Same outcome as the pre-check — already processed.
      if (insertErr.code === "ER_DUP_ENTRY") {
        return res.status(200).json({ message: "Email already processed" });
      }
      throw insertErr;
    }

    // ── 4. Identify "the contact" side of the conversation ──
    // If from is internal, the contact is the to side; otherwise the
    // from side is the contact. Defensive against null/missing fields
    // (Pabbly always sends both, but belt-and-braces — a null here
    // would have crashed the legacy .endsWith() call).
    const contactEmail = (isInternalDomain(from) ? (to || "") : (from || ""))
      .toString()
      .trim()
      .toLowerCase();

    // ── 5. Build the log_data object ──
    // Capitalized From/To/Subject/Message preserved for any reader
    // that depends on the legacy shape. logService folds in lowercase
    // from/to/subject (we pass them as typed params below); both
    // shapes coexist in the final blob so modern readers iterating
    // generically over keys see normalized lowercase too.
    //
    // Passed as an OBJECT (not pre-stringified). logService re-
    // stringifies after folding — guarantees valid JSON output even
    // for truncated rows (legacy code used a broken-quote-and-close
    // pattern that produced malformed JSON for some truncation points).
    let message = body_plain || "";
    if (attachments && Array.isArray(attachments)) {
      attachments.forEach((a, i) => {
        message += `\nAttachment ${i + 1}: ${a}`;
      });
    }

    const logObj = fitLogData(
      { From: from, To: to, Subject: subject, Message: message },
      from, to, subject
    );

    // ── 6. Write the log row via logService ──
    // Orphan-safe: row exists regardless of whether contactEmail
    // matches any contact in contacts / contact_emails. Surfaces in
    // case/contact only when the Phase-A contact reader's
    // date-windowed EXISTS picks it up.
    let logId = null;
    try {
      const r = await logService.createLogEntry(db, {
        type:      "email",
        link_type: "email",
        link_id:   contactEmail,
        by:        0,
        data:      logObj,
        from,
        to,
        subject,
        direction: "incoming",
      });
      logId = r.log_id;
    } catch (logErr) {
      if (logErr.code === "INVALID_LOG_LINK_ID") {
        // Bad email shape (sender field not a valid email). email_log
        // row above is the forensic trail. Warn and continue — caller
        // still gets a 200, sequence cancellation below will no-op
        // (resolveContactsByValue normalizes empty/invalid emails to
        // null and skips the search).
        console.warn(
          `[logEmail] INVALID_LOG_LINK_ID for messageID=${messageID} ` +
          `contactEmail=${JSON.stringify(contactEmail)} — ${logErr.message}`
        );
      } else {
        throw logErr;
      }
    }

    // ── 7. Respond 200 BEFORE the sequence-cancellation work ──
    // Pabbly retries on non-2xx; we don't want sequence-engine latency
    // (or transient errors) to cause double-delivery. The work below
    // is non-critical: if it fails, the user's next inbound interaction
    // (or a manual nudge) will still cancel the sequence.
    res.status(200).json({
      message: "Email data logged successfully",
      log_id:  logId,
    });

    // ── 8. Fire-and-forget: cancel no_show sequences for matched contact(s) ──
    // resolveContactsByValue scans both contact_emails (child_active +
    // child_ended) AND contacts.contact_email / contact_email2 — that
    // closes the orphan-loss hole in the legacy contacts.contact_email-
    // only UPDATE.
    //
    // Errors here never escalate to the caller. req.db is the promise
    // pool (no per-request connection lifetime), so it stays usable
    // after res has been sent.
    (async () => {
      try {
        const result = await contactService.resolveContactsByValue(
          db,
          { email: contactEmail },
          { include_ended: true, include_legacy_secondary: true }
        );
        if (!result || !result.matches || !result.matches.length) return;

        const seq = getSequenceEngine();
        for (const m of result.matches) {
          try {
            await seq.cancelSequences(
              db,
              m.contact_id,
              "no_show",
              "inbound_email_reply"
            );
          } catch (cancelErr) {
            console.error(
              `[logEmail] cancelSequences failed for contact_id=${m.contact_id}:`,
              cancelErr.message
            );
          }
        }
      } catch (resolveErr) {
        console.error(
          "[logEmail] resolveContactsByValue/cancel failed:",
          resolveErr.message
        );
      }
    })();
  } catch (err) {
    console.error("Email log failure:", err);
    // res.json above is conditional; if we hit this catch it means an
    // error fired BEFORE the 200 send. Headers are clean to send 500.
    res.status(500).json({
      error:   "Database operation failed",
      details: err.message,
    });
  }
});

module.exports = router;