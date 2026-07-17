// routes/admin.systemAlerts.js
//
// Super-user-only management API for system_alerts. Companion UI:
// public/systemAlerts.html (iframed in index.html's Admin tab).
//
// Background: the sweep (lib/alerting.js) only ever auto-resolves oauth
// alerts; everything else (uncaught_exception, action_failed, route_500, …)
// stays open forever and keeps the shell banner up until a human clears it.
// Until this route existed, that meant manual SQL. Now:
//
//   GET  /admin/system-alerts            list + filter + summary counts
//        ?status=open|acked|resolved|all   (default open)
//        &severity=critical|error|warning  (optional)
//        &source=<source>                  (optional)
//        &q=<substring>                    (optional; matches title/message/kind)
//        &limit=<1..500>&offset=<n>        (default 100 / 0)
//   POST /admin/system-alerts/ack        body { ids: [..] }   sets acked_at/acked_by
//   POST /admin/system-alerts/resolve    body { ids: [..] }   sets resolved_at (+ack if not acked)
//   POST /admin/system-alerts/reopen     body { ids: [..] }   clears acked_at/acked_by/resolved_at
//
// Status semantics mirror routes/api.systemStatus.js exactly:
//   open     = resolved_at IS NULL AND acked_at IS NULL   (what the banner counts)
//   acked    = acked_at IS NOT NULL AND resolved_at IS NULL
//   resolved = resolved_at IS NOT NULL
//
// Auth: superuserOnlyFor("system_alerts") — JWT-authed SU humans only,
// rate-limited, rejections audited. Every write is audited to
// admin_audit_log with tool='system_alerts'.

const express = require("express");
const { superuserOnlyFor, auditAdminAction } = require("../lib/auth.superuser");

const router = express.Router();
const guard = superuserOnlyFor("system_alerts");

const SEVERITIES = ["critical", "error", "warning"];
const STATUSES = ["open", "acked", "resolved", "all"];

const ipOf = (req) =>
  req.headers["x-forwarded-for"]?.split(",").shift() || req.socket?.remoteAddress;

// ── helpers ──────────────────────────────────────────────────────────────────

function statusWhere(status) {
  switch (status) {
    case "open":     return "resolved_at IS NULL AND acked_at IS NULL";
    case "acked":    return "acked_at IS NOT NULL AND resolved_at IS NULL";
    case "resolved": return "resolved_at IS NOT NULL";
    default:         return "1=1"; // all
  }
}

// Validates body.ids into a bounded array of positive ints, or null.
function parseIds(body) {
  const ids = Array.isArray(body?.ids) ? body.ids : null;
  if (!ids || !ids.length || ids.length > 500) return null;
  const clean = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return clean.length === ids.length ? clean : null;
}

async function audit(req, action, details, status = "ok", errorMessage = null, durationMs = null) {
  try {
    await auditAdminAction(req.db, {
      tool: "system_alerts",
      userId: req.auth?.userId,
      username: req.auth?.username,
      route: req.originalUrl,
      method: req.method,
      status,
      errorMessage,
      durationMs,
      ip: ipOf(req),
      userAgent: req.headers["user-agent"],
      details: { action, ...details },
    });
  } catch (e) {
    console.error("system_alerts audit failed:", e.message);
  }
}

// ── GET /admin/system-alerts ─────────────────────────────────────────────────
router.get("/admin/system-alerts", guard, async (req, res) => {
  try {
    const status = STATUSES.includes(req.query.status) ? req.query.status : "open";
    const severity = SEVERITIES.includes(req.query.severity) ? req.query.severity : null;
    const source = typeof req.query.source === "string" && req.query.source.trim()
      ? req.query.source.trim() : null;
    const q = typeof req.query.q === "string" && req.query.q.trim()
      ? req.query.q.trim() : null;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const where = [statusWhere(status)];
    const params = [];
    if (severity) { where.push("severity = ?"); params.push(severity); }
    if (source)   { where.push("source = ?");   params.push(source); }
    if (q) {
      where.push("(title LIKE ? OR message LIKE ? OR kind LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    const whereSql = where.join(" AND ");

    const [rows] = await req.db.query(
      `SELECT id, source, kind, group_key, severity, title, message, context,
              ref_table, ref_id, digested_at, resolved_at, acked_at, acked_by,
              created_at
         FROM system_alerts
        WHERE ${whereSql}
        ORDER BY id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await req.db.query(
      `SELECT COUNT(*) AS total FROM system_alerts WHERE ${whereSql}`, params
    );

    // Summary counts are filter-independent — they describe the whole table,
    // matching what the banner / system-status endpoint reports.
    const [[counts]] = await req.db.query(
      `SELECT
         SUM(severity='critical' AND resolved_at IS NULL AND acked_at IS NULL) AS open_critical,
         SUM(severity='error'    AND resolved_at IS NULL AND acked_at IS NULL) AS open_error,
         SUM(severity='warning'  AND resolved_at IS NULL AND acked_at IS NULL) AS open_warning,
         SUM(acked_at IS NOT NULL AND resolved_at IS NULL)                     AS acked,
         SUM(resolved_at >= NOW() - INTERVAL 7 DAY)                            AS resolved_7d,
         SUM(digested_at IS NULL AND acked_at IS NULL AND resolved_at IS NULL) AS undigested
       FROM system_alerts`
    );

    // Distinct sources for the filter dropdown.
    const [srcRows] = await req.db.query(
      `SELECT DISTINCT source FROM system_alerts ORDER BY source`
    );

    res.json({
      rows,
      total,
      limit,
      offset,
      counts: Object.fromEntries(
        Object.entries(counts).map(([k, v]) => [k, Number(v) || 0])
      ),
      sources: srcRows.map((r) => r.source),
    });
  } catch (err) {
    console.error("GET /admin/system-alerts failed:", err);
    res.status(500).json({ error: "Failed to list alerts" });
  }
});

// ── write actions ────────────────────────────────────────────────────────────
// All three share shape: body {ids}, respond { updated: n }.

async function runAction(req, res, action) {
  const started = Date.now();
  const ids = parseIds(req.body);
  if (!ids) {
    await audit(req, action, { ids: req.body?.ids }, "rejected_bad_ids", "invalid ids");
    return res.status(400).json({ error: "body.ids must be a non-empty array of ints (max 500)" });
  }

  let sql;
  if (action === "ack") {
    // Only rows not already acked/resolved — keeps first-acker attribution.
    sql = `UPDATE system_alerts
              SET acked_at = NOW(), acked_by = ?
            WHERE id IN (?) AND acked_at IS NULL AND resolved_at IS NULL`;
  } else if (action === "resolve") {
    // Resolving implies acknowledging; preserve an existing ack's attribution.
    sql = `UPDATE system_alerts
              SET resolved_at = NOW(),
                  acked_at = COALESCE(acked_at, NOW()),
                  acked_by = COALESCE(acked_by, ?)
            WHERE id IN (?) AND resolved_at IS NULL`;
  } else { // reopen
    sql = `UPDATE system_alerts
              SET acked_at = NULL, acked_by = NULL, resolved_at = NULL
            WHERE id IN (?) AND (acked_at IS NOT NULL OR resolved_at IS NOT NULL)`;
  }

  try {
    const params = action === "reopen"
      ? [ids]
      : [req.auth?.username || `user:${req.auth?.userId}`, ids];
    const [result] = await req.db.query(sql, params);
    await audit(req, action, { ids, updated: result.affectedRows }, "ok", null, Date.now() - started);
    res.json({ updated: result.affectedRows });
  } catch (err) {
    console.error(`POST /admin/system-alerts/${action} failed:`, err);
    await audit(req, action, { ids }, "error", err.message, Date.now() - started);
    res.status(500).json({ error: `Failed to ${action} alerts` });
  }
}

router.post("/admin/system-alerts/ack",     guard, (req, res) => runAction(req, res, "ack"));
router.post("/admin/system-alerts/resolve", guard, (req, res) => runAction(req, res, "resolve"));
router.post("/admin/system-alerts/reopen",  guard, (req, res) => runAction(req, res, "reopen"));

module.exports = router;