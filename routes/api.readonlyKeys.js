// routes/api.readonlyKeys.js
//
// Super-user-only management of readonly API keys. All endpoints gated
// via superuserOnlyFor("readonlyKeys") — JWT-authed humans only, no
// API-key bypass.
//
// Endpoints:
//   POST   /api/readonly-keys          body { label, ttlMinutes?, ipAllowlist? }
//   GET    /api/readonly-keys          ?activeOnly=1
//   DELETE /api/readonly-keys/:id      revoke (sets revoked_at)
//   GET    /api/readonly-keys/:id/log  ?limit=N&offset=N
//
// Audit: key create/revoke goes to admin_audit_log via auditAdminAction
// under tool='readonlyKeys'. Plaintext key is NEVER logged anywhere.
// Plaintext is returned ONCE on create and never again.

const express = require("express");
const crypto  = require("crypto");
const router  = express.Router();
const { superuserOnlyFor, auditAdminAction } = require("../lib/auth.superuser");
const { hashKey } = require("../lib/auth.readonly");

const MAX_TTL_DAYS    = parseInt(process.env.READONLY_KEY_MAX_TTL_DAYS, 10) || 3;
const MAX_TTL_MINUTES = MAX_TTL_DAYS * 24 * 60;
const DEFAULT_TTL_MIN = 1440;  // 1 day

const ipOf = (req) =>
  req.headers["x-forwarded-for"]?.split(",").shift() || req.socket?.remoteAddress;

// Compact UTC stamp (YYYYMMDDTHHMMZ) appended to the plaintext key, so a holder who
// has only the key string — a human, or an AI session handed the key with no other
// context — can tell whether it's dead without spending a request to find out.
//
// Advisory only: expiry is always enforced from the DB's expires_at. The stamp cannot
// be forged upward, since it sits inside the sha256'd material — editing it changes
// key_hash and the lookup simply misses. Seconds are truncated, so the stamp can read
// up to 59s earlier than the true expiry; erring early is the safe direction.
const stampExpiry = (d) => d.toISOString().replace(/[-:]/g, "").slice(0, 13) + "Z";

// ─── CREATE ──────────────────────────────────────────────────────────
router.post("/api/readonly-keys", ...superuserOnlyFor("readonlyKeys"), async (req, res) => {
  const started = Date.now();
  const { label, ttlMinutes, ipAllowlist } = req.body || {};

  if (!label || typeof label !== "string" || !label.trim()) {
    return res.status(400).json({ error: "label is required" });
  }
  const trimmedLabel = label.trim().slice(0, 255);

  const requested = parseInt(ttlMinutes, 10);
  const ttl = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, MAX_TTL_MINUTES)
    : DEFAULT_TTL_MIN;

  // Must precede the key — the key carries this value as its suffix and the two have
  // to agree. Note ttl here is the *clamped* value, so an over-long request can't mint
  // a key advertising an expiry the DB won't honor.
  const expiresAt = new Date(Date.now() + ttl * 60_000);

  const raw       = "ycro_" + crypto.randomBytes(32).toString("hex")
                            + "_" + stampExpiry(expiresAt);
  const keyHash   = hashKey(raw);
  const keyPrefix = raw.slice(0, 12);

  try {
    const [r] = await req.db.query(
      `INSERT INTO readonly_api_keys
         (key_hash, key_prefix, label, created_by, expires_at, ip_allowlist)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [keyHash, keyPrefix, trimmedLabel, req.auth.userId, expiresAt,
       (ipAllowlist && String(ipAllowlist).trim()) || null]
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
              k.created_at, k.expires_at, k.revoked_at, k.last_used_at, k.use_count, k.ip_allowlist
         FROM readonly_api_keys k
         LEFT JOIN users u ON u.user = k.created_by
         ${where}
        ORDER BY k.id DESC
        LIMIT 200`
    );
    res.json({ ok: true, keys: rows, max_ttl_days: MAX_TTL_DAYS });
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