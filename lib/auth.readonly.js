// lib/auth.readonly.js
//
// Middleware for the temp readonly-API-key auth path. Separate from
// jwtOrApiKey because:
//   - it accepts a *different* header (X-Readonly-Api-Key) so the wrong
//     credential type can't accidentally satisfy the wrong route
//   - the keys are DB-backed with per-key expiry/revocation/log, not
//     a single shared env-var like INTERNAL_API_KEY
//
// Sets req.auth = {
//   type:  'readonly_apikey',  // current convention (matches jwtOrApiKey's auth.type)
//   kind:  'readonly_apikey',  // future-shape for the requireAuth refactor
//   keyId,
//   label,
// }
//
// Auth failures (missing/invalid/expired/revoked key) log a row to
// admin_audit_log via auditAdminAction so attempts are visible to SU.
// Successful calls do NOT log here — the per-query row in
// readonly_query_log carries the audit weight for queries.

const crypto = require("crypto");
const { auditAdminAction } = require("./auth.superuser");

function hashKey(plain) {
  return crypto.createHash("sha256").update(String(plain)).digest("hex");
}

const ipOf = (req) =>
  req.headers["x-forwarded-for"]?.split(",").shift() || req.socket?.remoteAddress;

async function logAuthReject(req, status, extra = {}) {
  try {
    await auditAdminAction(req.db, {
      tool: "readonlyKeys",
      userId: null,
      username: null,
      route: req.originalUrl,
      method: req.method,
      status,
      ip: ipOf(req),
      userAgent: req.headers["user-agent"] || "unknown",
      details: extra,
    });
  } catch (err) {
    console.error("[auth.readonly] audit log failed:", err.message);
  }
}

async function readonlyApiKeyAuth(req, res, next) {
  const raw = req.headers["x-readonly-api-key"];
  if (!raw || typeof raw !== "string") {
    await logAuthReject(req, "rejected_no_key");
    return res.status(401).json({ error: "Readonly API key required (X-Readonly-Api-Key header)" });
  }

  let row;
  try {
    const [rows] = await req.db.query(
      `SELECT id, label, expires_at, revoked_at
         FROM readonly_api_keys
        WHERE key_hash = ?
        LIMIT 1`,
      [hashKey(raw)]
    );
    row = rows[0];
  } catch (err) {
    console.error("[auth.readonly] lookup failed:", err.message);
    return res.status(500).json({ error: "Auth lookup failed" });
  }

  if (!row) {
    await logAuthReject(req, "rejected_unknown_key", { keyPrefix: String(raw).slice(0, 12) });
    return res.status(401).json({ error: "Invalid readonly API key" });
  }
  if (row.revoked_at) {
    await logAuthReject(req, "rejected_revoked", { keyId: row.id });
    return res.status(401).json({ error: "Readonly API key revoked" });
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await logAuthReject(req, "rejected_expired", { keyId: row.id });
    return res.status(401).json({ error: "Readonly API key expired" });
  }

  req.auth = {
    type:  "readonly_apikey",
    kind:  "readonly_apikey",
    keyId: row.id,
    label: row.label,
  };

  // Fire-and-forget usage counter — never block the request on this.
  req.db.query(
    `UPDATE readonly_api_keys
        SET last_used_at = NOW(), use_count = use_count + 1
      WHERE id = ?`,
    [row.id]
  ).catch(err => console.error("[auth.readonly] usage counter update failed:", err.message));

  next();
}

module.exports = { readonlyApiKeyAuth, hashKey };