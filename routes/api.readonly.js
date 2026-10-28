// routes/api.readonly.js
//
// POST /api/readonly/sql  — execute a single read-only SQL statement.
//
// Auth:    X-Readonly-Api-Key header → readonlyApiKeyAuth + requireKeyScope('sql.ro')
// Body:    { sql: string, params?: array, maxRows?: number, timeoutMs?: number }
// Returns: { ok, rows, fields, rowCount, truncated, durationMs }
//
// GET /api/readonly/settings — app_settings without its secrets (below).
// Same auth and scope; one readonly_query_log row per call.
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
//   7. Table tiers (lib/sqlGuard, access SEC-3): SECRET_TABLES refuse every
//      key; SENSITIVE_TABLES refuse a key without `sql.ro.sensitive` (403
//      naming the scope). Every readonly_query_log row records whether the
//      key held that scope (`sensitive_key`).

const express = require("express");
const router  = express.Router();
const roPool  = require("../startup/dbReadonly");
const { readonlyApiKeyAuth, requireKeyScope } = require("../lib/auth.readonly");
const { isReadOnlyQuery, hasFileExfilClause, deniedTable } = require("../lib/sqlGuard");
const { keyAllows } = require("../lib/capabilities");
const reg = require("../lib/settingsRegistry");

const SENSITIVE_SCOPE = "sql.ro.sensitive";
// Explicit scope: a legacy NULL-scopes key does not hold it (lib/capabilities).
const holdsSensitive = (req) => keyAllows(req.auth, SENSITIVE_SCOPE);

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
       row_count, duration_ms, status, sensitive_key, error_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    holdsSensitive(req) ? 1 : 0,
    fields.error_text ?? null,
  ];
  req.db.query(sql, params)
    .catch(err => console.error("[api.readonly] query-log insert failed:", err.message));
}

router.post("/api/readonly/sql", readonlyApiKeyAuth, requireKeyScope("sql.ro"), async (req, res) => {
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
  // Withheld tables (lib/sqlGuard): SECRET (credentials — no key, ever; RO
  // keys must not escalate to internal-API or ingest authority) and
  // SENSITIVE (content — only under sql.ro.sensitive).
  const denied = deniedTable(sql, { sensitive: holdsSensitive(req) });
  if (denied && denied.tier === "secret") {
    logQuery(req, {
      sql_text: sql, params_json: params,
      status: "rejected_secret_table", duration_ms: Date.now() - started,
    });
    return res.status(400).json({ error: `${denied.table} is not readable through this endpoint (use the SU db console)` });
  }
  if (denied) {
    logQuery(req, {
      sql_text: sql, params_json: params,
      status: "rejected_sensitive_table", duration_ms: Date.now() - started,
    });
    return res.status(403).json({
      error: `${denied.table} needs the '${SENSITIVE_SCOPE}' scope — a short-lived sensitive session key (Admin → Session Keys)`,
      missingScope: SENSITIVE_SCOPE,
      table: denied.table,
    });
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

// ─── GET /api/readonly/settings ──────────────────────────────────────
// app_settings is a SECRET table to POST /api/readonly/sql (lib/sqlGuard):
// it holds live credentials, and a statement regex cannot split it by row.
// This endpoint serves the rest, judged by the settings registry in code, so
// a key registered kind 'secret' is withheld the moment it is registered —
// no list to keep in step (a view would need one: a row's is_secret flag is
// not reliable — RingCentral's renewal REPLACEs rc_subscriptions without it).
//
// Served (fail closed — anything not matched is withheld):
//   - a REGISTERED key whose kind is not secret / access / retired
//     (reg.NEVER_SERVED), except AI_WITHHELD below;
//   - an UNREGISTERED row with is_editable = 1 that does not fold onto a
//     registered key (the collation: app_settings.key ignores case and
//     trailing spaces, so 'Quo_Api_Key ' would read as quo_api_key);
//   and in both cases never a row that is secret by either source
//   (reg.isSecret: registry kind or the row's is_secret = 1).
// A secret row's value is also NULLed inside MySQL, so it never reaches
// this process from the read-only pool; the registry filter is the boundary.
// → { ok, settings: [{ key, value, updated_at, registered, kind, home }],
//     count, durationMs }  ordered by key.

// Not credentials by kind, but not for AI sessions: the live Clio 2FA code
// (staff read it through GET /clio-code).
const AI_WITHHELD = Object.freeze(["clio_login_code"]);

function aiReadableSetting(row) {
  const key = row && row.key;
  if (typeof key !== "string") return null;
  if (reg.isSecret(key, row.is_secret)) return null;
  const entry = reg.get(key);
  if (entry) {
    if (reg.NEVER_SERVED.includes(entry.kind) || AI_WITHHELD.includes(key)) return null;
    return { key, value: row.value, updated_at: row.updated_at, registered: true, kind: entry.kind, home: entry.home };
  }
  if (reg.registeredSpelling(key)) return null;
  if (Number(row.is_editable) !== 1) return null;
  return { key, value: row.value, updated_at: row.updated_at, registered: false, kind: "variable", home: "firm" };
}

const SETTINGS_SQL =
  "SELECT `key`, IF(is_secret = 0, `value`, NULL) AS `value`, is_secret, is_editable, updated_at " +
  "FROM app_settings ORDER BY `key`";

router.get("/api/readonly/settings", readonlyApiKeyAuth, requireKeyScope("sql.ro"), async (req, res) => {
  const started = Date.now();
  let conn;
  try {
    conn = await roPool.getConnection();
    await conn.query("SET SESSION MAX_EXECUTION_TIME = ?", [DEFAULT_TIMEOUT]);
    const [rows] = await conn.query(SETTINGS_SQL);
    const settings = rows.map(aiReadableSetting).filter(Boolean);
    logQuery(req, {
      sql_text: "GET /api/readonly/settings",
      row_count: settings.length, duration_ms: Date.now() - started,
      status: "success",
    });
    res.json({ ok: true, settings, count: settings.length, durationMs: Date.now() - started });
  } catch (err) {
    logQuery(req, {
      sql_text: "GET /api/readonly/settings",
      duration_ms: Date.now() - started,
      status: "error", error_text: err.message,
    });
    res.status(500).json({ error: "settings read failed" });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;
module.exports.aiReadableSetting = aiReadableSetting;