// lib/auth.superuser.js
//
// Authorization middleware for super-user-only admin tools (DB console,
// API tester, future tools).
// Layers on top of jwtOrApiKey:
//   1. Require valid JWT (API key path rejected — we want named, audited humans).
//   2. Require user_auth === "authorized - SU".
//   3. Sliding-window rate limit (per tool, per user).
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

// ── rate limiter (per-tool + per-user, sliding window, in-memory) ────────────
// This is a runaway-loop guardrail, not a security control. It is in-memory,
// so on Cloud Run with N instances the effective ceiling is (limit × N).
//
// Buckets are keyed `${tool}:${userId}`. Before 2026-08 they were keyed by
// userId alone and shared across every SU tool, which meant a DB Console
// batch would lock the same human out of the users admin, API keys, and
// credentials for the rest of the minute. Tools now get independent budgets.
//
// Limit resolution order (first match wins):
//   1. env  SU_RATE_LIMIT_<TOOL>   e.g. SU_RATE_LIMIT_DB_CONSOLE=200
//   2. RATE_BY_TOOL below
//   3. env  SU_RATE_LIMIT_DEFAULT
//   4. RATE_DEFAULT
const RATE_WINDOW_MS = 60_000;
const RATE_DEFAULT   = 30;

// Per-tool ceilings. db_console is high because a human doing schema work
// legitimately fires bursts (schema load + saved queries + several runs);
// large multi-statement runs go through POST /admin/db/batch, which costs a
// single token no matter how many statements it carries.
const RATE_BY_TOOL = {
  db_console: 120,
  api_tester: 60,
};

const hits = new Map(); // `${tool}:${userId}` -> number[] of timestamps

function envLimitFor(tool) {
  const key = "SU_RATE_LIMIT_" + String(tool).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

const limitCache = new Map();
function rateLimitFor(tool) {
  if (limitCache.has(tool)) return limitCache.get(tool);
  const envDefault = Number(process.env.SU_RATE_LIMIT_DEFAULT);
  const limit =
    envLimitFor(tool) ??
    RATE_BY_TOOL[tool] ??
    (Number.isFinite(envDefault) && envDefault > 0 ? Math.floor(envDefault) : RATE_DEFAULT);
  limitCache.set(tool, limit);
  return limit;
}

// Drop buckets whose newest hit is older than the window. Cheap, and only
// runs once the map has grown past a threshold, so the hot path stays O(1).
function sweep(now) {
  if (hits.size < 200) return;
  const cutoff = now - RATE_WINDOW_MS;
  for (const [k, arr] of hits) {
    if (!arr.length || arr[arr.length - 1] < cutoff) hits.delete(k);
  }
}

function rateLimitCheck(tool, userId) {
  const limit  = rateLimitFor(tool);
  const now    = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const key    = `${tool}:${userId}`;
  const arr    = (hits.get(key) || []).filter(t => t >= cutoff);
  if (arr.length >= limit) {
    hits.set(key, arr);
    return { ok: false, limit, retryInMs: arr[0] + RATE_WINDOW_MS - now };
  }
  arr.push(now);
  hits.set(key, arr);
  sweep(now);
  return { ok: true, limit };
}

// Test hook — lets suites reset state between cases without reloading the module.
function _resetRateLimits() {
  hits.clear();
  limitCache.clear();
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
    const { ok, limit, retryInMs } = rateLimitCheck(tool, req.auth.userId);
    if (!ok) {
      const retrySec = Math.max(1, Math.ceil(retryInMs / 1000));
      auditAdminAction(req.db, {
        tool,
        userId:   req.auth.userId,
        username: req.auth.username,
        route:    req.originalUrl,
        method:   req.method,
        status:   "rejected_rate_limit",
        ip:        req.headers["x-forwarded-for"]?.split(",").shift() || req.socket?.remoteAddress,
        userAgent: req.headers["user-agent"] || "unknown",
        details:  { limit, window_sec: RATE_WINDOW_MS / 1000, retry_in_ms: retryInMs },
      }).catch(err => console.error("[superuser] audit log failed:", err.message));
      res.set("Retry-After", retrySec);
      return res.status(429).json({
        error: `Rate limit exceeded — ${limit}/min for ${tool}. Retry in ${retrySec}s.`,
        tool,
        limit,
        windowSec: RATE_WINDOW_MS / 1000,
        retryInMs,
      });
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
  // Rate-limit introspection / test hooks
  rateLimitFor,
  _resetRateLimits,
};