// lib/auth.superuser.js
//
// Authorization middleware for super-user-only endpoints (e.g. the admin DB console).
// Layers on top of jwtOrApiKey:
//   1. Require valid JWT (API key path rejected — we want named, audited humans).
//   2. Require user_auth === "authorized - SU".
//   3. Sliding-window rate limit (per user).
//
// NOTE on the SU check: we string-match `user_auth` because that's the current
// convention across the codebase (see api.featureRequests.js:20). When a proper
// `role` column is introduced, update `isSuperuser()` below — it's the single
// source of truth for what counts as SU.

const jwtOrApiKey = require("./auth.jwtOrApiKey");

const SU_AUTH = "authorized - SU";

function isSuperuser(auth) {
  return auth && auth.type === "jwt" && auth.user_auth === SU_AUTH;
}

// ── rate limiter (per-user, sliding window, in-memory) ───────────────────────
// Good enough for a single-SU dev tool. If/when this runs multi-instance and
// multiple users hit it, move to a shared store.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_HITS  = 30;
const hits = new Map(); // userId -> number[] of timestamps

function rateLimitCheck(userId) {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const arr = (hits.get(userId) || []).filter(t => t >= cutoff);
  if (arr.length >= RATE_MAX_HITS) {
    hits.set(userId, arr);
    return { ok: false, retryInMs: arr[0] + RATE_WINDOW_MS - now };
  }
  arr.push(now);
  hits.set(userId, arr);
  return { ok: true };
}

// ── awaited audit log ────────────────────────────────────────────────────────
// Inserts one row into admin_db_console_log and awaits it. Callers should use
// this at the end of every handler, success or failure, before responding.
async function auditDbConsole(db, row) {
  const sql = `
    INSERT INTO admin_db_console_log
      (user_id, username, route, method, query_text, read_only_mode,
       status, error_message, row_count, duration_ms, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    row.userId ?? null,
    row.username ?? null,
    row.route,
    row.method,
    row.queryText ?? null,
    row.readOnlyMode ? 1 : 0,
    row.status,
    row.errorMessage ?? null,
    row.rowCount ?? null,
    row.durationMs ?? null,
    row.ip ?? null,
    row.userAgent ?? null,
  ];
  await db.query(sql, params);
}

// ── middleware ───────────────────────────────────────────────────────────────
function superuserCheck(req, res, next) {
  if (!isSuperuser(req.auth)) {
    // Log the rejection so we can see attempted misuse.
    auditDbConsole(req.db, {
      userId: req.auth?.userId ?? null,
      username: req.auth?.username ?? null,
      route: req.originalUrl,
      method: req.method,
      queryText: null,
      readOnlyMode: true,
      status: "rejected_not_su",
      ip: req.headers["x-forwarded-for"]?.split(",").shift() || req.socket?.remoteAddress,
      userAgent: req.headers["user-agent"] || "unknown",
    }).catch(err => console.error("[superuser] audit log failed:", err.message));
    return res.status(403).json({ error: "Superuser access required" });
  }
  next();
}

function rateLimitMiddleware(req, res, next) {
  const { ok, retryInMs } = rateLimitCheck(req.auth.userId);
  if (!ok) {
    auditDbConsole(req.db, {
      userId: req.auth.userId,
      username: req.auth.username,
      route: req.originalUrl,
      method: req.method,
      readOnlyMode: true,
      status: "rejected_rate_limit",
      ip: req.headers["x-forwarded-for"]?.split(",").shift() || req.socket?.remoteAddress,
      userAgent: req.headers["user-agent"] || "unknown",
    }).catch(err => console.error("[superuser] audit log failed:", err.message));
    res.set("Retry-After", Math.ceil(retryInMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded (30/min)" });
  }
  next();
}

// Composed chain: JWT verify → SU gate → rate limit.
const superuserOnly = [jwtOrApiKey, superuserCheck, rateLimitMiddleware];

module.exports = {
  superuserOnly,
  superuserCheck,
  isSuperuser,
  auditDbConsole,
};
