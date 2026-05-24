// routes/api.readonly.js
//
// POST /api/readonly/sql  — execute a single read-only SQL statement.
//
// Auth:    X-Readonly-Api-Key header → readonlyApiKeyAuth
// Body:    { sql: string, params?: array, maxRows?: number, timeoutMs?: number }
// Returns: { ok, rows, fields, rowCount, truncated, durationMs }
//
// Safety layers (in order):
//   1. DB user `yc_readonly` has only SELECT — hard guarantee, can't
//      DDL/DML regardless of any bug above.
//   2. multipleStatements: false on the RO pool — no batching.
//   3. App-level isReadOnlyQuery() — friendlier error than waiting for
//      a permission failure.
//   4. INTO OUTFILE / DUMPFILE explicitly rejected (also blocked by
//      no-FILE-priv, but again, friendlier error).
//   5. Per-session MAX_EXECUTION_TIME — kills runaway SELECTs.
//   6. Row cap in the response payload — prevents accidental dump of
//      huge result sets to the caller.

const express = require("express");
const router  = express.Router();
const roPool  = require("../startup/dbReadonly");
const { readonlyApiKeyAuth } = require("../lib/auth.readonly");
const { isReadOnlyQuery, hasFileExfilClause } = require("../lib/sqlGuard");

const DEFAULT_MAX_ROWS  = 5000;
const HARD_MAX_ROWS     = 20000;
const DEFAULT_TIMEOUT   = 30_000;
const HARD_MAX_TIMEOUT  = 120_000;

const ipOf = (req) =>
  req.headers["x-forwarded-for"]?.split(",").shift() || req.socket?.remoteAddress;

function clamp(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

// Fire-and-forget log to readonly_query_log. Uses the main pool
// (req.db) — the RO pool physically can't INSERT.
function logQuery(req, fields) {
  const sql = `
    INSERT INTO readonly_query_log
      (api_key_id, ip, user_agent, sql_text, params_json,
       row_count, duration_ms, status, error_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    req.auth?.keyId ?? null,
    ipOf(req),
    (req.headers["user-agent"] || "unknown").slice(0, 512),
    fields.sql_text ?? "",
    fields.params_json ? JSON.stringify(fields.params_json) : null,
    fields.row_count ?? null,
    fields.duration_ms ?? null,
    fields.status,
    fields.error_text ?? null,
  ];
  req.db.query(sql, params)
    .catch(err => console.error("[api.readonly] query-log insert failed:", err.message));
}

router.post("/api/readonly/sql", readonlyApiKeyAuth, async (req, res) => {
  const started = Date.now();
  const { sql, params, maxRows, timeoutMs } = req.body || {};

  if (!sql || typeof sql !== "string" || !sql.trim()) {
    logQuery(req, {
      sql_text: String(sql || ""), params_json: params,
      status: "rejected_empty", duration_ms: Date.now() - started,
    });
    return res.status(400).json({ error: "Missing sql" });
  }

  if (!isReadOnlyQuery(sql)) {
    logQuery(req, {
      sql_text: sql, params_json: params,
      status: "rejected_not_readonly", duration_ms: Date.now() - started,
    });
    return res.status(400).json({
      error: "Read-only required. First keyword must be SELECT / SHOW / DESCRIBE / DESC / EXPLAIN.",
    });
  }
  if (hasFileExfilClause(sql)) {
    logQuery(req, {
      sql_text: sql, params_json: params,
      status: "rejected_file_exfil", duration_ms: Date.now() - started,
    });
    return res.status(400).json({ error: "INTO OUTFILE / INTO DUMPFILE not allowed" });
  }

  const rowCap  = clamp(maxRows,  1, HARD_MAX_ROWS,    DEFAULT_MAX_ROWS);
  const timeout = clamp(timeoutMs, 1, HARD_MAX_TIMEOUT, DEFAULT_TIMEOUT);

  let conn;
  try {
    conn = await roPool.getConnection();
    await conn.query("SET SESSION MAX_EXECUTION_TIME = ?", [timeout]);
    const [rows, fields] = await conn.query(
      sql,
      Array.isArray(params) ? params : []
    );

    const isArrayResult = Array.isArray(rows);
    const fullRowCount  = isArrayResult ? rows.length : null;
    const truncated     = isArrayResult && fullRowCount > rowCap;
    const payloadRows   = isArrayResult && truncated ? rows.slice(0, rowCap) : rows;

    const fieldMeta = Array.isArray(fields)
      ? fields.map(f => ({ name: f.name, type: f.columnType }))
      : null;

    logQuery(req, {
      sql_text: sql, params_json: params,
      row_count: fullRowCount, duration_ms: Date.now() - started,
      status: "success",
    });

    res.json({
      ok: true,
      rows: payloadRows,
      fields: fieldMeta,
      rowCount: fullRowCount,
      truncated,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    logQuery(req, {
      sql_text: sql, params_json: params,
      duration_ms: Date.now() - started,
      status: "error", error_text: err.message,
    });
    res.status(400).json({ error: err.message, code: err.code || null });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;