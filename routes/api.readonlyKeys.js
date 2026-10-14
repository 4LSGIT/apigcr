// routes/api.readonlyKeys.js
//
// Super-user-only management of SESSION KEYS — the ycro_-prefixed keys an
// AI session or script uses (ACCESS_CONTROL_DESIGN §5.3: "readonly key" was
// a misnomer — they reach read-only SQL, scratch, IT alerts and, by grant,
// the temp.* provider proxies). The prefix, the table (readonly_api_keys),
// the routes and the tool tag keep their old names; only the concept and the
// UI copy changed. All endpoints gated via superuserOnlyFor("readonlyKeys") —
// JWT-authed humans only, no API-key bypass.
//
// FORMAT (B3): "ycro_" + 22 base62 chars (lib/apiKeys randomBase62, ~131
// bits) + "_" + an expiry stamp. Keys minted before B3 carry 64 hex chars and
// keep working: identity is the hash of whatever was minted.
//
// Endpoints:
//   POST   /api/readonly-keys          body { label, ttlMinutes?, ipAllowlist?, scopes? }
//   GET    /api/readonly-keys          ?activeOnly=1 — also returns the scope
//                                      vocabulary + the mint default (the UI picker)
//   DELETE /api/readonly-keys/:id      revoke (sets revoked_at)
//   GET    /api/readonly-keys/:id/log  ?limit=N&offset=N
//
// SCOPES (access-control B1, ACCESS_CONTROL_DESIGN §5.1–5.2): a key may use
// only the surfaces in its scopes column (lib/auth.readonly requireKeyScope).
// A mint WITHOUT `scopes` gets DEFAULT_SCOPES = sql.ro + scratch + alert — the
// documented trio. NEW KEYS DO NOT GET temp.* (the credentialed provider
// proxies) by default: that is the point; name e.g. "temp.clio" explicitly.
// `scopes` is validated against lib/capabilities (surface list + route:/ and
// capability grammar); an unknown scope is a 400, never a silent drop. Keys
// minted before B1 have scopes NULL = the legacy full surface, untouched.
//
// SENSITIVE (SEC-3, ACCESS_CONTROL_DESIGN §5.7): a key whose scopes include
// sql.ro.sensitive (reads lib/sqlGuard SENSITIVE_TABLES) is mint-time capped —
// ttlMinutes over SENSITIVE_MAX_TTL_MIN (24h) is a 400, not a silent clamp;
// unspecified → SENSITIVE_DEFAULT_TTL_MIN (4h). It must carry sql.ro too (the
// endpoint's surface gate) — a 400 otherwise, never an implicit add.
//
// Audit: key create/revoke goes to admin_audit_log via auditAdminAction
// under tool='readonlyKeys'. Plaintext key is NEVER logged anywhere.
// Plaintext is returned ONCE on create and never again.

const express = require("express");
const router  = express.Router();
const { superuserOnlyFor, auditAdminAction } = require("../lib/auth.superuser");
const { hashKey } = require("../lib/auth.readonly");
const { normalizeKeyScopes, KEY_SCOPES } = require("../lib/capabilities");
const { randomBase62, KEY_BODY_LEN } = require("../lib/apiKeys");

const DEFAULT_SCOPES = Object.freeze(["sql.ro", "scratch", "alert"]);

const MAX_TTL_DAYS    = parseInt(process.env.READONLY_KEY_MAX_TTL_DAYS, 10) || 3;
const MAX_TTL_MINUTES = MAX_TTL_DAYS * 24 * 60;
const DEFAULT_TTL_MIN = 1440;  // 1 day

const SENSITIVE_SCOPE           = "sql.ro.sensitive";
const SENSITIVE_MAX_TTL_MIN     = 1440;  // 24h — not env-tunable
const SENSITIVE_DEFAULT_TTL_MIN = 240;   // 4h

const ipOf = (req) =>
  req.headers["x-forwarded-for"]?.split(",").shift() || req.socket?.remoteAddress;

// Compact UTC stamp (YYYYMMDDTHHMMZ) appended to the plaintext key, so a holder who
// has only the key string — a human, or an AI session handed the key with no other
// context — can tell whether it's dead without spending a request to find out.
//
// The stamp sits AFTER the second underscore, outside the key's hashed identity
// (only "ycro_<body>" is hashed — see canonicalKey in lib/auth.readonly). So the whole
// suffix is advisory and freely editable: a holder may rewrite the stamp, replace it
// with a human note, or drop it entirely and the key still authenticates. Forging the
// stamp later grants nothing — expiry is always enforced from the DB's expires_at, so
// the DB remains the sole source of truth. Seconds are truncated, so the stamp can read
// up to 59s earlier than the true expiry; erring early is the safe direction.
const stampExpiry = (d) => d.toISOString().replace(/[-:]/g, "").slice(0, 13) + "Z";

// ─── CREATE ──────────────────────────────────────────────────────────
router.post("/api/readonly-keys", ...superuserOnlyFor("readonlyKeys"), async (req, res) => {
  const started = Date.now();
  const { label, ttlMinutes, ipAllowlist, scopes: scopesIn } = req.body || {};

  if (!label || typeof label !== "string" || !label.trim()) {
    return res.status(400).json({ error: "label is required" });
  }

  let scopes;
  try {
    scopes = scopesIn === undefined ? [...DEFAULT_SCOPES] : normalizeKeyScopes(scopesIn);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const trimmedLabel = label.trim().slice(0, 255);

  const requested = parseInt(ttlMinutes, 10);
  const given = Number.isFinite(requested) && requested > 0;
  const sensitive = scopes.includes(SENSITIVE_SCOPE);
  if (sensitive && !scopes.includes("sql.ro")) {
    return res.status(400).json({ error: `${SENSITIVE_SCOPE} needs sql.ro too — it widens the SQL surface, it does not grant it` });
  }
  if (sensitive && given && requested > SENSITIVE_MAX_TTL_MIN) {
    return res.status(400).json({
      error: `a ${SENSITIVE_SCOPE} key lives at most ${SENSITIVE_MAX_TTL_MIN} minutes (24h); asked for ${requested}`,
      maxTtlMinutes: SENSITIVE_MAX_TTL_MIN,
    });
  }
  const ttl = sensitive
    ? (given ? requested : SENSITIVE_DEFAULT_TTL_MIN)
    : (given ? Math.min(requested, MAX_TTL_MINUTES) : DEFAULT_TTL_MIN);

  // Must precede the key — the key carries this value as its suffix and the two have
  // to agree. Note ttl here is the *clamped* value, so an over-long request can't mint
  // a key advertising an expiry the DB won't honor.
  const expiresAt = new Date(Date.now() + ttl * 60_000);

  // Body: 22 base62 chars (B3; lib/apiKeys). It has no underscore, so
  // canonicalKey still cuts "ycro_<body>" off at the second underscore and the
  // stamp stays an advisory suffix.
  const raw       = "ycro_" + randomBase62(KEY_BODY_LEN)
                            + "_" + stampExpiry(expiresAt);
  const keyHash   = hashKey(raw);
  const keyPrefix = raw.slice(0, 12);

  try {
    const [r] = await req.db.query(
      `INSERT INTO readonly_api_keys
         (key_hash, key_prefix, label, created_by, expires_at, ip_allowlist, scopes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [keyHash, keyPrefix, trimmedLabel, req.auth.userId, expiresAt,
       (ipAllowlist && String(ipAllowlist).trim()) || null, JSON.stringify(scopes)]
    );

    await auditAdminAction(req.db, {
      tool: "readonlyKeys",
      userId: req.auth.userId,
      username: req.auth.username,
      route: req.originalUrl,
      method: req.method,
      status: "created",
      durationMs: Date.now() - started,
      ip: ipOf(req),
      userAgent: req.headers["user-agent"] || "unknown",
      details: {
        key_id: r.insertId,
        key_prefix: keyPrefix,
        label: trimmedLabel,
        ttl_minutes: ttl,
        expires_at: expiresAt.toISOString(),
        ip_allowlist: ipAllowlist || null,
        scopes,
      },
    });

    // Plaintext returned ONCE here and never again.
    res.json({
      ok: true,
      id: r.insertId,
      key: raw,
      keyPrefix,
      label: trimmedLabel,
      expiresAt: expiresAt.toISOString(),
      ttlMinutes: ttl,
      scopes,
    });
  } catch (err) {
    console.error("POST /api/readonly-keys error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── LIST ────────────────────────────────────────────────────────────
router.get("/api/readonly-keys", ...superuserOnlyFor("readonlyKeys"), async (req, res) => {
  const activeOnly = ["1", "true", "yes"].includes(String(req.query.activeOnly || "").toLowerCase());
  try {
    const where = activeOnly
      ? "WHERE revoked_at IS NULL AND expires_at > NOW()"
      : "";
    const [rows] = await req.db.query(
      `SELECT k.id, k.key_prefix, k.label, k.created_by, u.username AS created_by_username,
              k.created_at, k.expires_at, k.revoked_at, k.last_used_at, k.use_count, k.ip_allowlist,
              k.scopes
         FROM readonly_api_keys k
         LEFT JOIN users u ON u.user = k.created_by
         ${where}
        ORDER BY k.id DESC
        LIMIT 200`
    );
    res.json({
      ok: true, keys: rows, max_ttl_days: MAX_TTL_DAYS,
      // The picker's source (B3): the surface vocabulary and the default trio,
      // so the page never carries its own copy of either.
      scope_vocabulary: Object.entries(KEY_SCOPES).map(([name, v]) => ({ name, desc: v.desc })),
      default_scopes: DEFAULT_SCOPES,
      // SEC-3: the sensitive scope and its mint cap, so the page renders the
      // box apart and caps the TTL field from the server's numbers.
      sensitive_scope: { name: SENSITIVE_SCOPE, max_ttl_minutes: SENSITIVE_MAX_TTL_MIN, default_ttl_minutes: SENSITIVE_DEFAULT_TTL_MIN },
    });
  } catch (err) {
    console.error("GET /api/readonly-keys error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── REVOKE ──────────────────────────────────────────────────────────
router.delete("/api/readonly-keys/:id", ...superuserOnlyFor("readonlyKeys"), async (req, res) => {
  const started = Date.now();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid id" });
  }
  try {
    const [r] = await req.db.query(
      `UPDATE readonly_api_keys
          SET revoked_at = NOW()
        WHERE id = ? AND revoked_at IS NULL`,
      [id]
    );

    if (!r.affectedRows) {
      return res.status(404).json({ error: "Not found or already revoked" });
    }

    await auditAdminAction(req.db, {
      tool: "readonlyKeys",
      userId: req.auth.userId,
      username: req.auth.username,
      route: req.originalUrl,
      method: req.method,
      status: "revoked",
      durationMs: Date.now() - started,
      ip: ipOf(req),
      userAgent: req.headers["user-agent"] || "unknown",
      details: { key_id: id },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/readonly-keys/:id error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PER-KEY QUERY LOG ───────────────────────────────────────────────
router.get("/api/readonly-keys/:id/log", ...superuserOnlyFor("readonlyKeys"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid id" });
  }
  const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit, 10)  || 100));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  try {
    const [rows] = await req.db.query(
      `SELECT id, created_at, ip, sql_text, params_json,
              row_count, duration_ms, status, error_text
         FROM readonly_query_log
        WHERE api_key_id = ?
        ORDER BY id DESC
        LIMIT ? OFFSET ?`,
      [id, limit, offset]
    );
    res.json({ ok: true, log: rows, limit, offset });
  } catch (err) {
    console.error("GET /api/readonly-keys/:id/log error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.DEFAULT_SCOPES = DEFAULT_SCOPES;
module.exports.SENSITIVE_MAX_TTL_MIN = SENSITIVE_MAX_TTL_MIN;
module.exports.SENSITIVE_DEFAULT_TTL_MIN = SENSITIVE_DEFAULT_TTL_MIN;