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

// A readonly key's hashable identity is only "ycro_<hex>" — the first two
// underscore-delimited segments. Everything after the second underscore is a
// free-form, advisory suffix (an expiry stamp, a human note, or nothing) that a
// holder may edit or drop without invalidating the key. These are all the same key:
//   ycro_<hex>
//   ycro_<hex>_20260720T1654Z
//   ycro_<hex>_NOTE-goes here_BLA_BLA_BLA
function canonicalKey(plain) {
  const s = String(plain);
  const firstUnderscore  = s.indexOf("_");
  if (firstUnderscore === -1) return s;
  const secondUnderscore = s.indexOf("_", firstUnderscore + 1);
  return secondUnderscore === -1 ? s : s.slice(0, secondUnderscore);
}

// Hashes the canonical identity only, so the stored key_hash and the auth-time
// lookup both ignore the advisory suffix. This is the single source of truth for
// key identity — canonicalizing here keeps create and check in lockstep.
function hashKey(plain) {
  return crypto.createHash("sha256").update(canonicalKey(plain)).digest("hex");
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
    // Safe to disclose: the caller already proved possession of the key.
    return res.status(401).json({
      error: "Readonly API key expired",
      expiredAt: new Date(row.expires_at).toISOString(),
    });
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

module.exports = { readonlyApiKeyAuth, hashKey, canonicalKey };