// routes/api.keyRenewalRequests.js
//
// SESSION-KEY RENEWAL REQUESTS (key-renew-req, 2026-11-19). A Claude session
// whose ycro_ key expired (or is about to) asks the key's CREATOR to renew it:
// one email (an HTML "Review & renew" button, the plain link in the text part)
// into the Session Keys pane, where an SU approves with a
// TTL or denies. Approval runs the ordinary renew (routes/api.readonlyKeys.js
// renewKey — one copy of the caps), so the key's secret never changes: the
// session polls GET and retries with the same key once it reads `approved`.
//
// Session side — X-Readonly-Api-Key, readonlyApiKeyAuthAllowExpired (the ONE
// auth that admits an expired key; tests/keyScopes.test.js pins it to these
// two routes). No surface scope: a key asking about itself reaches no surface.
//   POST /api/readonly/renewal-request  { reason, ttlMinutes? }
//     reason      REQUIRED, plain text, 10–200 chars after trim — why the
//                 session needs the key back (shown escaped in email + pane)
//     ttlMinutes  optional; checked against the renew caps for this key NOW
//                 (400 over the cap, naming default + max); NULL = the default
//     A child key → 409 (its manager key renews it: /children/:id/renew).
//     One PENDING request per key (UNIQUE pending_key): a repeat returns the
//     pending one, duplicate:true, no second email — unless its email failed,
//     when the send is retried. Denied in the last hour → 429.
//     The email goes out synchronously; a failed send keeps the request
//     pending (the pane lists it) and answers 502 naming the error.
//   GET  /api/readonly/renewal-request  → this key's latest request
//
// SU side — superuserOnlyFor("readonlyKeys") (JWT SU + elevation):
//   GET  /api/readonly-keys/renewal-requests   ?status=pending|all &id=N &limit=N
//   POST /api/readonly-keys/renewal-requests/:id/approve  { ttlMinutes? }
//   POST /api/readonly-keys/renewal-requests/:id/deny
// Any SU may decide (renew is any-SU already). Approve = renewKey inside one
// transaction with the request row locked FOR UPDATE, so a double click renews
// once and the second click reads "already approved" (409).
//
// Audit (admin_audit_log, tool readonlyKeys): renewal_requested (userId null),
// renewed { via_request } — the same status the renew route writes —,
// renewal_denied.

const express = require("express");
const router = express.Router();
const { DateTime } = require("luxon");
const { readonlyApiKeyAuthAllowExpired } = require("../lib/auth.readonly");
const { superuserOnlyFor, auditAdminAction } = require("../lib/auth.superuser");
const { scopesFromColumn } = require("../lib/capabilities");
const { withTransaction } = require("../lib/withTransaction");
const { getSetting } = require("../services/settingsService");
const { cfg } = require("../lib/firmConfig");
const keys = require("./api.readonlyKeys");

const REASON_MIN = 10;
const REASON_MAX = 200;
const DENY_COOLDOWN_MIN = 60;
const LIST_MAX = 200;
const FIRM_TZ = process.env.FIRM_TIMEZONE || "America/Detroit";

const ipOf = (req) =>
  req.headers["x-forwarded-for"]?.split(",").shift() || req.socket?.remoteAddress;

const audit = (req, status, details, started, userId = null, username = null) =>
  auditAdminAction(req.db, {
    tool: "readonlyKeys",
    userId,
    username,
    route: req.originalUrl,
    method: req.method,
    status,
    durationMs: Date.now() - started,
    ip: ipOf(req),
    userAgent: req.headers["user-agent"] || "unknown",
    details,
  }).catch(err => console.error("[keyRenewalRequests] audit failed:", err.message));

const iso = (d) => (d == null ? null : new Date(d).toISOString());

/** "90 minutes", "4 hours", "1 day", "3 days", "1 day 6 hours". */
function fmtMinutes(min) {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return String(min);
  const days = Math.floor(m / 1440), hours = Math.floor((m % 1440) / 60), mins = m % 60;
  const part = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (mins && !days) return hours ? `${part(hours, "hour")} ${part(mins, "minute")}` : part(mins, "minute");
  const out = [];
  if (days) out.push(part(days, "day"));
  if (hours) out.push(part(hours, "hour"));
  if (mins) out.push(part(mins, "minute"));
  return out.join(" ");
}

const fmtFirm = (d) => d == null ? "never"
  : DateTime.fromJSDate(new Date(d)).setZone(FIRM_TZ).toFormat("ccc LLL d, yyyy h:mm a ZZZZ");

/** The pane's deep link: the panel tab routes adminReadonlyKeys to whichever page shows it (SU-gated by exec). */
function requestLink(id) {
  const base = (cfg("app_url") || "https://app.4lsg.com").replace(/\/+$/, "");
  return `${base}/?open=tabPanel~adminReadonlyKeys~renew-${id}`;
}

const escHtml = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * The notification email — pure. `text` for plain-text clients; `html` the
 * same rows in a table plus one button into the pane (inline styles, the
 * lib/alerting digest-button idiom). Every value is escaped: the label is
 * SU-set, the reason is the session's own words.
 */
function buildEmail({ request, key, caps, now = Date.now() }) {
  const expMs = new Date(key.expires_at).getTime();
  const scopes = scopesFromColumn(key.scopes);
  const asked = request.requested_ttl_min == null
    ? `the default (${fmtMinutes(caps.default_minutes)})`
    : fmtMinutes(request.requested_ttl_min);
  const link = requestLink(request.id);
  const subject = `[YisraCase] Session key #${key.id} "${key.label}" asks to be renewed`;
  const rows = [
    ["Key", `#${key.id} "${key.label}" (${key.key_prefix}…)`],
    ["Scopes", scopes === null ? "legacy (full historical surface)" : scopes.join(", ")],
    [expMs <= now ? "Expired" : "Expires", fmtFirm(key.expires_at)],
    ["Last used", fmtFirm(key.last_used_at)],
    ["Reason", request.reason],
    ["Asked for", `${asked} — the max for this key is ${fmtMinutes(caps.max_minutes)}`],
    ["From IP", request.request_ip || "unknown"],
  ];
  const lead = "A Claude session asks you to renew a session key you minted.";
  const foot = "The key's secret does not change: once approved, the session retries with the same key.";
  const text = [
    lead, "",
    ...rows.map(([l, v]) => `${(l + ":").padEnd(12)}${v}`),
    "",
    "Approve (choose the TTL) or deny — SU sign-in required:",
    link, "",
    foot,
    `Request #${request.id}.`,
  ].join("\n");
  const td = "padding:3px 14px 3px 0;color:#6b7280;white-space:nowrap;vertical-align:top";
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.45;color:#111827;max-width:560px">
  <p style="margin:0 0 12px">${escHtml(lead)}</p>
  <table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;font-size:13px;margin:0 0 18px">
${rows.map(([l, v]) => `    <tr><td style="${td}">${escHtml(l)}</td><td style="padding:3px 0;${l === "Reason" ? "font-weight:600;" : ""}">${escHtml(v)}</td></tr>`).join("\n")}
  </table>
  <a href="${escHtml(link)}" style="display:inline-block;padding:10px 22px;background:#2563eb;border:1px solid #2563eb;border-radius:6px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">Review &amp; renew key #${escHtml(key.id)}</a>
  <p style="margin:14px 0 0;font-size:12px;color:#6b7280">Opens the request in YisraCase — choose the TTL, then Approve or Deny (SU sign-in required). ${escHtml(foot)} Request #${escHtml(request.id)}.</p>
  <p style="margin:8px 0 0;font-size:11px;color:#9ca3af">Button not working? <a href="${escHtml(link)}" style="color:#6b7280">${escHtml(link)}</a></p>
</div>`;
  return { subject, text, html };
}

/** The session's view of a request row. */
const sessionShape = (r) => r && ({
  id: r.id,
  status: r.status,
  reason: r.reason,
  requestedTtlMinutes: r.requested_ttl_min,
  requestedAt: iso(r.requested_at),
  emailSent: r.email_error == null,
  decidedAt: iso(r.decided_at),
  grantedTtlMinutes: r.granted_ttl_min,
  newExpiresAt: iso(r.new_expires_at),
});

async function loadKey(db, id) {
  const [[k]] = await db.query(
    `SELECT k.id, k.label, k.key_prefix, k.scopes, k.expires_at, k.last_used_at, k.created_by,
            u.username AS creator_username, u.email AS creator_email
       FROM readonly_api_keys k
       LEFT JOIN users u ON u.user = k.created_by
      WHERE k.id = ?`, [id]);
  return k;
}

/** Send the notification; record the outcome on the row. → null on success, else the error text. */
async function notify(db, request, key, caps) {
  let error = null;
  try {
    const to = String(key.creator_email || "").trim();
    if (!to.includes("@")) {
      throw new Error(`the key's creator (user ${key.created_by}${key.creator_username ? ` ${key.creator_username}` : ""}) has no email address on file`);
    }
    const from = ((await getSetting(db, "alert_from_email")) || "").trim() || cfg("email_automations") || "";
    if (!from) throw new Error("no sender configured (alert_from_email setting / email_automations / AUTO_EMAIL env)");
    const { subject, text, html } = buildEmail({ request, key, caps });
    // Lazy require — circular-dep safety convention (see lib/alerting.js).
    const emailService = require("../services/emailService");
    await emailService.sendEmail(db, { from, to, subject, text, html });
  } catch (err) {
    error = String(err.message || err).slice(0, 500);
  }
  await db.query(`UPDATE key_renewal_requests SET email_error = ? WHERE id = ?`, [error, request.id]);
  return error;
}

const pendingFor = async (db, keyId) =>
  (await db.query(`SELECT * FROM key_renewal_requests WHERE key_id = ? AND status = 'pending'`, [keyId]))[0][0];

// ─── SESSION SIDE ────────────────────────────────────────────────────

router.post("/api/readonly/renewal-request", readonlyApiKeyAuthAllowExpired, async (req, res) => {
  const started = Date.now();
  const db = req.db;
  const keyId = req.auth.keyId;
  try {
    if (req.auth.parentKeyId != null) {
      return res.status(409).json({
        error: `a child key is renewed by its manager key, not by a request — the manager calls POST /api/readonly-keys/children/${keyId}/renew`,
        parentKeyId: req.auth.parentKeyId,
      });
    }
    const body = req.body || {};
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
      return res.status(400).json({
        error: `reason is required: one SHORT plain-text line (${REASON_MIN}–${REASON_MAX} characters) saying why the session needs this key back; got ${reason.length}`,
      });
    }
    const key = await loadKey(db, keyId);
    if (!key) return res.status(401).json({ error: "Invalid readonly API key" });
    const caps = keys.rootTtlCaps(key.scopes);
    let requestedTtl = null;
    if (body.ttlMinutes !== undefined && body.ttlMinutes !== null) {
      try {
        requestedTtl = keys._rules.rootTtlMinutes(body.ttlMinutes, { sensitive: caps.sensitive, strict: true });
      } catch (err) {
        if (err instanceof keys.Refusal) {
          return res.status(err.status).json({ ...err.body, defaultTtlMinutes: caps.default_minutes, maxTtlMinutes: caps.max_minutes });
        }
        throw err;
      }
    }

    // One pending per key: a repeat answers with it (and retries a failed email).
    let pending = await pendingFor(db, keyId);
    if (!pending) {
      const [[denied]] = await db.query(
        `SELECT decided_at FROM key_renewal_requests
          WHERE key_id = ? AND status = 'denied' AND decided_at > NOW() - INTERVAL ${DENY_COOLDOWN_MIN} MINUTE
          ORDER BY decided_at DESC LIMIT 1`, [keyId]);
      if (denied) {
        const retryInMin = Math.max(1, Math.ceil((new Date(denied.decided_at).getTime() + DENY_COOLDOWN_MIN * 60_000 - Date.now()) / 60_000));
        return res.status(429).json({
          error: `this key's last renewal request was denied less than ${DENY_COOLDOWN_MIN} minutes ago — ask again in ${retryInMin} minute(s), or ask your human directly`,
          retryInMinutes: retryInMin,
        });
      }
      try {
        const [r] = await db.query(
          `INSERT INTO key_renewal_requests
             (key_id, reason, requested_ttl_min, notify_user, key_expires_at, request_ip, user_agent)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [keyId, reason, requestedTtl, key.created_by, key.expires_at,
           (ipOf(req) || "").slice(0, 64) || null, String(req.headers["user-agent"] || "").slice(0, 255) || null]);
        const [[row]] = await db.query(`SELECT * FROM key_renewal_requests WHERE id = ?`, [r.insertId]);
        const emailError = await notify(db, row, key, caps);
        row.email_error = emailError;
        await audit(req, "renewal_requested", {
          key_id: keyId, request_id: row.id, requested_ttl_min: requestedTtl,
          notify_user: key.created_by, ...(emailError ? { email_error: emailError } : {}),
        }, started);
        if (emailError) {
          return res.status(502).json({
            ok: false, duplicate: false, request: sessionShape(row),
            error: `the request is recorded (#${row.id}, pending, listed in the Session Keys pane) but the email failed: ${emailError}`,
          });
        }
        return res.json({
          ok: true, duplicate: false, request: sessionShape(row), notified: key.creator_username,
          next: "poll GET /api/readonly/renewal-request every few minutes; once status is 'approved', retry with the SAME key",
        });
      } catch (err) {
        if (err.code !== "ER_DUP_ENTRY") throw err;
        pending = await pendingFor(db, keyId);   // a concurrent request won the UNIQUE
        if (!pending) throw err;
      }
    }

    if (pending.email_error != null) {
      const emailError = await notify(db, pending, key, caps);
      pending.email_error = emailError;
      if (emailError) {
        return res.status(502).json({
          ok: false, duplicate: true, request: sessionShape(pending),
          error: `request #${pending.id} is pending (listed in the Session Keys pane) but the email failed again: ${emailError}`,
        });
      }
    }
    return res.json({
      ok: true, duplicate: true, request: sessionShape(pending), notified: key.creator_username,
      next: "already pending — poll GET /api/readonly/renewal-request; once status is 'approved', retry with the SAME key",
    });
  } catch (err) {
    console.error("POST /api/readonly/renewal-request error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/readonly/renewal-request", readonlyApiKeyAuthAllowExpired, async (req, res) => {
  try {
    const [[row]] = await req.db.query(
      `SELECT * FROM key_renewal_requests WHERE key_id = ? ORDER BY id DESC LIMIT 1`, [req.auth.keyId]);
    const [[k]] = await req.db.query(`SELECT expires_at FROM readonly_api_keys WHERE id = ?`, [req.auth.keyId]);
    res.json({
      ok: true,
      keyId: req.auth.keyId,
      keyExpiresAt: iso(k && k.expires_at),
      expired: !!(k && new Date(k.expires_at).getTime() < Date.now()),
      request: sessionShape(row) || null,
    });
  } catch (err) {
    console.error("GET /api/readonly/renewal-request error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── SU SIDE ─────────────────────────────────────────────────────────

const idOf = (req) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

router.get("/api/readonly-keys/renewal-requests", ...superuserOnlyFor("readonlyKeys"), async (req, res) => {
  try {
    const status = String(req.query.status || "all").toLowerCase();
    if (!["all", "pending"].includes(status)) return res.status(400).json({ error: "status must be pending or all" });
    const where = [], params = [];
    if (status === "pending") where.push("r.status = 'pending'");
    if (req.query.id !== undefined) {
      const id = Number(req.query.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
      where.push("r.id = ?"); params.push(id);
    }
    const limit = Math.min(LIST_MAX, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const [rows] = await req.db.query(
      `SELECT r.id, r.key_id, r.reason, r.requested_ttl_min, r.notify_user, r.key_expires_at, r.status,
              r.requested_at, r.request_ip, r.user_agent, r.email_error, r.decided_by, r.decided_at,
              r.granted_ttl_min, r.new_expires_at,
              k.label AS key_label, k.key_prefix, k.scopes AS key_scopes, k.expires_at AS key_expires_now,
              k.revoked_at AS key_revoked_at, k.last_used_at AS key_last_used_at,
              nu.username AS notify_username, du.username AS decided_by_username
         FROM key_renewal_requests r
         JOIN readonly_api_keys k ON k.id = r.key_id
         LEFT JOIN users nu ON nu.user = r.notify_user
         LEFT JOIN users du ON du.user = r.decided_by
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY (r.status = 'pending') DESC, r.id DESC
        LIMIT ${limit}`, params);
    res.json({
      ok: true,
      requests: rows.map(r => ({ ...r, key_scopes: scopesFromColumn(r.key_scopes), caps: keys.rootTtlCaps(r.key_scopes) })),
    });
  } catch (err) {
    console.error("GET /api/readonly-keys/renewal-requests error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/readonly-keys/renewal-requests/:id/approve", ...superuserOnlyFor("readonlyKeys"), async (req, res) => {
  const started = Date.now();
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  const { ttlMinutes } = req.body || {};
  try {
    const out = await withTransaction(req.db, async (conn) => {
      const [[r]] = await conn.query(`SELECT * FROM key_renewal_requests WHERE id = ? FOR UPDATE`, [id]);
      if (!r) throw new keys.Refusal(404, { error: "Not found" });
      if (r.status !== "pending") {
        throw new keys.Refusal(409, { error: `request #${id} is already ${r.status}`, status: r.status });
      }
      const renewed = await keys.renewKey(conn, r.key_id, ttlMinutes);
      await conn.query(
        `UPDATE key_renewal_requests
            SET status = 'approved', decided_by = ?, decided_at = NOW(), granted_ttl_min = ?, new_expires_at = ?
          WHERE id = ? AND status = 'pending'`,
        [req.auth.userId, renewed.ttlMinutes, renewed.expiresAt, id]);
      return { keyId: r.key_id, ...renewed };
    }, { retries: 1 });   // pure DB span (CLAUDE.md: transactions)
    await audit(req, "renewed", {
      key_id: out.keyId,
      before: { expires_at: out.before.toISOString() },
      after: { expires_at: out.expiresAt.toISOString() },
      via_request: id,
    }, started, req.auth.userId, req.auth.username);
    res.json({ ok: true, id, keyId: out.keyId, status: "approved", ttlMinutes: out.ttlMinutes, expiresAt: out.expiresAt.toISOString() });
  } catch (err) {
    if (err instanceof keys.Refusal) return res.status(err.status).json(err.body);
    console.error("POST /api/readonly-keys/renewal-requests/:id/approve error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/readonly-keys/renewal-requests/:id/deny", ...superuserOnlyFor("readonlyKeys"), async (req, res) => {
  const started = Date.now();
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const [u] = await req.db.query(
      `UPDATE key_renewal_requests SET status = 'denied', decided_by = ?, decided_at = NOW()
        WHERE id = ? AND status = 'pending'`, [req.auth.userId, id]);
    if (!u.affectedRows) {
      const [[r]] = await req.db.query(`SELECT status FROM key_renewal_requests WHERE id = ?`, [id]);
      if (!r) return res.status(404).json({ error: "Not found" });
      return res.status(409).json({ error: `request #${id} is already ${r.status}`, status: r.status });
    }
    const [[r]] = await req.db.query(`SELECT key_id FROM key_renewal_requests WHERE id = ?`, [id]);
    await audit(req, "renewal_denied", { key_id: r.key_id, request_id: id }, started, req.auth.userId, req.auth.username);
    res.json({ ok: true, id, status: "denied" });
  } catch (err) {
    console.error("POST /api/readonly-keys/renewal-requests/:id/deny error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports._test = { buildEmail, fmtMinutes, requestLink, REASON_MIN, REASON_MAX, DENY_COOLDOWN_MIN };
