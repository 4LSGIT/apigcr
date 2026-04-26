// lib/auth.superuser.js
//
// Authorization middleware for super-user-only admin tools (DB console,
// API tester, future tools).
// Layers on top of jwtOrApiKey:
//   1. Require valid JWT (API key path rejected — we want named, audited humans).
//   2. Require user_auth === "authorized - SU".
//   3. Sliding-window rate limit (per user).
// Every rejection — and every SU action the caller chooses to log — writes
// one row to `admin_audit_log` tagged with the calling tool name.
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

// ── awaited audit log (generic) ──────────────────────────────────────────────
// Writes one row to admin_audit_log. `row.tool` is required. `row.details`
// is the tool-specific JSON bucket.
async function auditAdminAction(db, row) {
  if (!row?.tool) throw new Error("auditAdminAction: row.tool is required");
  const sql = `
    INSERT INTO admin_audit_log
      (tool, user_id, username, route, method, status, error_message,
       duration_ms, ip_address, user_agent, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    row.tool,
    row.userId ?? null,
    row.username ?? null,
    row.route,
    row.method,
    row.status,
    row.errorMessage ?? null,
    row.durationMs ?? null,
    row.ip ?? null,
    row.userAgent ?? null,
    row.details ? JSON.stringify(row.details) : null,
  ];
  await db.query(sql, params);
}

// ── DB-console wrapper (back-compat shape for existing callsites) ────────────
// Keeps top-level queryText/readOnlyMode/rowCount in the caller's shape, packs
// them into `details` for storage. No admin.dbConsole.js callsites need to
// change.
async function auditDbConsole(db, row) {
  return auditAdminAction(db, {
    tool: "db_console",
    userId: row.userId,
    username: row.username,
    route: row.route,
    method: row.method,
    status: row.status,
    errorMessage: row.errorMessage,
    durationMs: row.durationMs,
    ip: row.ip,
    userAgent: row.userAgent,
    details: {
      query_text:     row.queryText ?? null,
      read_only_mode: !!row.readOnlyMode,
      row_count:      row.rowCount ?? null,
    },
  });
}

// ── middleware factories ─────────────────────────────────────────────────────
// superuserOnlyFor(tool) returns a middleware chain that tags rejection-audit
// rows with the given tool name. Before the factory, all rejections landed
// under "db_console" regardless of caller.

function makeSuperuserCheck(tool) {
  return function superuserCheck(req, res, next) {
    if (!isSuperuser(req.auth)) {
      auditAdminAction(req.db, {
        tool,
        userId:   req.auth?.userId   ?? null,
        username: req.auth?.username ?? null,
        route:    req.originalUrl,
        method:   req.method,
        status:   "rejected_not_su",
        ip:        req.headers["x-forwarded-for"]?.split(",").shift() || req.socket?.remoteAddress,
        userAgent: req.headers["user-agent"] || "unknown",
      }).catch(err => console.error("[superuser] audit log failed:", err.message));
      return res.status(403).json({ error: "Superuser access required" });
    }
    next();
  };
}

function makeRateLimitMiddleware(tool) {
  return function rateLimitMiddleware(req, res, next) {
    const { ok, retryInMs } = rateLimitCheck(req.auth.userId);
    if (!ok) {
      auditAdminAction(req.db, {
        tool,
        userId:   req.auth.userId,
        username: req.auth.username,
        route:    req.originalUrl,
        method:   req.method,
        status:   "rejected_rate_limit",
        ip:        req.headers["x-forwarded-for"]?.split(",").shift() || req.socket?.remoteAddress,
        userAgent: req.headers["user-agent"] || "unknown",
      }).catch(err => console.error("[superuser] audit log failed:", err.message));
      res.set("Retry-After", Math.ceil(retryInMs / 1000));
      return res.status(429).json({ error: "Rate limit exceeded (30/min)" });
    }
    next();
  };
}

function superuserOnlyFor(tool) {
  if (!tool || typeof tool !== "string") {
    throw new Error("superuserOnlyFor: tool name required");
  }
  return [jwtOrApiKey, makeSuperuserCheck(tool), makeRateLimitMiddleware(tool)];
}

// Back-compat: existing callers that destructure `superuserOnly` keep working,
// and their rejection-audit rows land with tool='db_console'.
const superuserOnly = superuserOnlyFor("db_console");

module.exports = {
  // Legacy exports (unchanged call shape)
  superuserOnly,
  auditDbConsole,
  isSuperuser,
  // New generalized exports
  superuserOnlyFor,
  auditAdminAction,
};