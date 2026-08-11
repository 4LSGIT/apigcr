// routes/admin.dbConsole.js
//
// Super-user-only MySQL console. Replaces /db-jwt for interactive use; /db-jwt
// remains for backwards compatibility and will be deprecated.
//
// All endpoints require JWT with user_auth === "authorized - SU", are rate
// limited (30/min/user), and every attempt is awaited into admin_audit_log.
//
// Endpoints:
//   POST   /admin/db/query              body { query, allowWrite }
//   POST   /admin/db/batch              body { statements[], allowWrite, stopOnError }
//   GET    /admin/db/schema             -> { tables: [...] }
//   GET    /admin/db/schema.sql         downloads schema-YYYYMMDD-HHMMSS.sql (no data, no DB name)
//   POST   /admin/db/schema/save-to-ref dev-only: writes the dump to ref/ (Cloud
//                                       Run's filesystem is ephemeral, so this
//                                       endpoint refuses outside ENVIRONMENT=development)
//   GET    /admin/db/saved-queries
//   POST   /admin/db/saved-queries      body { name, query }
//   PUT    /admin/db/saved-queries/:id  body { name, query }
//   DELETE /admin/db/saved-queries/:id

const express = require("express");
const path    = require("path");
const fs      = require("fs/promises");
const { superuserOnly, auditDbConsole, auditAdminAction } = require("../lib/auth.superuser");
const { buildSchemaDump } = require("../lib/schemaDump");

const router = express.Router();

// ── batch limits ─────────────────────────────────────────────────────────────
// The RO/RW pools run with multipleStatements off, so a multi-statement script
// has to be executed one statement at a time. Doing that as N HTTP requests
// (the old client-side loop) burned N rate-limit tokens and made any script
// longer than the per-minute ceiling fail halfway through. /admin/db/batch
// does the loop server-side: one request, one token, every statement still
// individually audited.
const MAX_BATCH_STATEMENTS = 200;    // per request; client chunks above this
const BATCH_ROW_CAP        = 500;    // rows returned per statement (report caps at 200 anyway)
const BATCH_TIME_BUDGET_MS = 240_000; // stop starting new statements past this — Cloud Run kills the request at 300s

// Shown on every statement skipped after a stopOnError abort. Phrased to read
// correctly inside the client's per-statement "NOT RUN" block.
const STOP_ON_ERROR_ABORT = "Not run — an earlier statement failed and stop-on-error was on.";

// ── helpers ──────────────────────────────────────────────────────────────────
const ipOf = (req) =>
  req.headers["x-forwarded-for"]?.split(",").shift() || req.socket?.remoteAddress;

// A query is "read-only" if its first meaningful keyword is SELECT / SHOW /
// DESCRIBE / DESC / EXPLAIN. We strip leading /* */ and -- comments first so a
// commented header doesn't confuse the check. Deliberately does NOT include
// WITH — MySQL 8 allows `WITH ... UPDATE`, which is a write.
function isReadOnlyQuery(sql) {
  let s = String(sql || "").trim();
  // strip leading block comments
  while (s.startsWith("/*")) {
    const end = s.indexOf("*/");
    if (end < 0) return false;
    s = s.slice(end + 2).trim();
  }
  // strip leading line comments
  while (s.startsWith("--") || s.startsWith("#")) {
    const end = s.indexOf("\n");
    if (end < 0) return false;
    s = s.slice(end + 1).trim();
  }
  const first = (s.split(/\s+/)[0] || "").toUpperCase();
  return ["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"].includes(first);
}

// ── idempotent schema init ───────────────────────────────────────────────────
// Runs once when the module is first required. Safe to re-run (IF NOT EXISTS).
// Mirrored in ref/database.sql.
let schemaReady = null;
function ensureSchema(db) {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id            BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tool          VARCHAR(32)  NOT NULL,
        user_id       INT          NULL,
        username      VARCHAR(255) NULL,
        route         VARCHAR(255) NOT NULL,
        method        VARCHAR(10)  NOT NULL,
        status        VARCHAR(40)  NOT NULL,
        error_message TEXT         NULL,
        duration_ms   INT          NULL,
        ip_address    VARCHAR(45)  NULL,
        user_agent    VARCHAR(255) NULL,
        details       JSON         NULL,
        created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_admin_audit_tool   (tool, created_at),
        INDEX idx_admin_audit_user   (user_id, created_at),
        INDEX idx_admin_audit_status (status, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS admin_saved_queries (
        id         INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id    INT NOT NULL,
        name       VARCHAR(120)  NOT NULL,
        query_text MEDIUMTEXT    NOT NULL,
        created_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_admin_saved_queries_user (user_id, name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);
  })().catch(err => {
    // If init fails, reset so we try again next request rather than caching the failure.
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

router.use("/admin/db", async (req, res, next) => {
  try { await ensureSchema(req.db); next(); }
  catch (err) { next(err); }
});

// ── POST /admin/db/query ─────────────────────────────────────────────────────
router.post("/admin/db/query", ...superuserOnly, async (req, res) => {
  const started = Date.now();
  const { query, allowWrite = false } = req.body || {};
  const auditBase = {
    userId: req.auth.userId,
    username: req.auth.username,
    route: req.originalUrl,
    method: req.method,
    queryText: query,
    readOnlyMode: !allowWrite,
    ip: ipOf(req),
    userAgent: req.headers["user-agent"] || "unknown",
  };

  if (!query || typeof query !== "string" || !query.trim()) {
    await auditDbConsole(req.db, { ...auditBase, status: "rejected_empty", durationMs: Date.now() - started });
    return res.status(400).json({ error: "Missing query" });
  }

  if (!allowWrite && !isReadOnlyQuery(query)) {
    await auditDbConsole(req.db, { ...auditBase, status: "rejected_write_guard", durationMs: Date.now() - started });
    return res.status(400).json({ error: "Read-only mode is on. First keyword must be SELECT/SHOW/DESCRIBE/DESC/EXPLAIN, or enable writes." });
  }

  try {
    const [rows, fields] = await req.db.query(query);
    const rowCount = Array.isArray(rows) ? rows.length : (rows?.affectedRows ?? null);
    await auditDbConsole(req.db, {
      ...auditBase,
      status: "success",
      rowCount,
      durationMs: Date.now() - started,
    });
    res.json({
      ok: true,
      rows,
      fields: Array.isArray(fields) ? fields.map(f => ({ name: f.name, type: f.columnType })) : null,
      rowCount,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    await auditDbConsole(req.db, {
      ...auditBase,
      status: "error",
      errorMessage: err.message,
      durationMs: Date.now() - started,
    });
    res.status(400).json({ error: err.message, code: err.code || null });
  }
});

// ── POST /admin/db/batch ─────────────────────────────────────────────────────
// Run an ordered list of statements in one request.
//
// Body:    { statements: string[], allowWrite?: bool, stopOnError?: bool }
// Returns: { ok, results: [...], statementCount, okCount, errCount, durationMs, aborted }
//
// Each result: { index, ok, rows, fields, rowCount, truncated, durationMs,
//                error, code, notRun, auditError }
//   - rowCount is the FULL row count; rows may be capped at BATCH_ROW_CAP.
//   - notRun marks statements skipped after an abort (stopOnError or time budget).
//
// Statements are NOT wrapped in a transaction — same semantics as running them
// one at a time in the old client loop. Each one is audited to admin_audit_log
// individually, plus one summary row for the batch itself.
router.post("/admin/db/batch", ...superuserOnly, async (req, res) => {
  const started = Date.now();
  const { statements, allowWrite = false, stopOnError = false } = req.body || {};

  const auditBase = {
    userId: req.auth.userId,
    username: req.auth.username,
    route: req.originalUrl,
    method: req.method,
    readOnlyMode: !allowWrite,
    ip: ipOf(req),
    userAgent: req.headers["user-agent"] || "unknown",
  };

  if (!Array.isArray(statements) || statements.length === 0) {
    await auditDbConsole(req.db, {
      ...auditBase, queryText: "batch: (empty)",
      status: "rejected_empty", durationMs: Date.now() - started,
    });
    return res.status(400).json({ error: "statements[] is required and must be non-empty" });
  }

  if (statements.length > MAX_BATCH_STATEMENTS) {
    await auditDbConsole(req.db, {
      ...auditBase, queryText: `batch: ${statements.length} statements (over cap)`,
      status: "rejected_batch_too_large", durationMs: Date.now() - started,
    });
    return res.status(400).json({
      error: `Too many statements in one batch (${statements.length} > ${MAX_BATCH_STATEMENTS}). Split the script.`,
      maxStatements: MAX_BATCH_STATEMENTS,
    });
  }

  // Per-statement audit. Deliberately non-fatal: if the audit insert fails
  // mid-batch we do NOT abort, because bailing out of a half-run write script
  // leaves the DB in an unknown state — worse than a gap in the log. The
  // failure is surfaced on the result item and in the summary row instead.
  async function auditStatement(i, stmt, status, extra = {}) {
    try {
      await auditAdminAction(req.db, {
        tool: "db_console",
        userId: auditBase.userId,
        username: auditBase.username,
        route: auditBase.route,
        method: auditBase.method,
        status,
        errorMessage: extra.errorMessage ?? null,
        durationMs: extra.durationMs ?? null,
        ip: auditBase.ip,
        userAgent: auditBase.userAgent,
        details: {
          query_text: stmt,
          read_only_mode: !allowWrite,
          row_count: extra.rowCount ?? null,
          batch: true,
          batch_index: i,
          batch_size: statements.length,
        },
      });
      return null;
    } catch (err) {
      console.error(`[dbConsole] batch audit insert failed (stmt ${i}):`, err.message);
      return err.message;
    }
  }

  const results = [];
  let okCount = 0, errCount = 0, aborted = null;

  for (let i = 0; i < statements.length; i++) {
    const stmt = typeof statements[i] === "string" ? statements[i] : String(statements[i] ?? "");

    if (aborted) {
      results.push({ index: i, ok: false, notRun: true, error: aborted });
      continue;
    }

    if (!stmt.trim()) {
      results.push({ index: i, ok: false, error: "Empty statement" });
      errCount++;
      await auditStatement(i, stmt, "rejected_empty", { durationMs: 0 });
      if (stopOnError) aborted = STOP_ON_ERROR_ABORT;
      continue;
    }

    if (!allowWrite && !isReadOnlyQuery(stmt)) {
      const msg = "Read-only mode is on. First keyword must be SELECT/SHOW/DESCRIBE/DESC/EXPLAIN, or enable writes.";
      results.push({ index: i, ok: false, error: msg });
      errCount++;
      await auditStatement(i, stmt, "rejected_write_guard", { durationMs: 0 });
      if (stopOnError) aborted = STOP_ON_ERROR_ABORT;
      continue;
    }

    if (Date.now() - started > BATCH_TIME_BUDGET_MS) {
      aborted = `Batch time budget exceeded (${BATCH_TIME_BUDGET_MS / 1000}s) — remaining statements were not run.`;
      results.push({ index: i, ok: false, notRun: true, error: aborted });
      continue;
    }

    const qt0 = Date.now();
    try {
      const [rows, fields] = await req.db.query(stmt);
      const durationMs = Date.now() - qt0;
      const isArray   = Array.isArray(rows);
      const rowCount  = isArray ? rows.length : (rows?.affectedRows ?? null);
      const truncated = isArray && rows.length > BATCH_ROW_CAP;

      const auditError = await auditStatement(i, stmt, "success", { rowCount, durationMs });
      results.push({
        index: i,
        ok: true,
        rows: truncated ? rows.slice(0, BATCH_ROW_CAP) : rows,
        fields: Array.isArray(fields) ? fields.map(f => ({ name: f.name, type: f.columnType })) : null,
        rowCount,
        truncated,
        durationMs,
        ...(auditError ? { auditError } : {}),
      });
      okCount++;
    } catch (err) {
      const durationMs = Date.now() - qt0;
      const auditError = await auditStatement(i, stmt, "error", { errorMessage: err.message, durationMs });
      results.push({
        index: i,
        ok: false,
        error: err.message,
        code: err.code || null,
        durationMs,
        ...(auditError ? { auditError } : {}),
      });
      errCount++;
      if (stopOnError) aborted = STOP_ON_ERROR_ABORT;
    }
  }

  const durationMs = Date.now() - started;
  await auditDbConsole(req.db, {
    ...auditBase,
    queryText: `batch: ${statements.length} statement(s) — ${okCount} ok, ${errCount} err${aborted ? " — ABORTED" : ""}`,
    status: errCount ? "error" : "success",
    errorMessage: aborted,
    rowCount: okCount,
    durationMs,
  });

  res.json({
    ok: true,
    results,
    statementCount: statements.length,
    okCount,
    errCount,
    aborted,
    durationMs,
  });
});

// ── GET /admin/db/schema ─────────────────────────────────────────────────────
// Returns a structured view of the current database: tables, columns, indexes,
// foreign keys. Used by the sidebar and by the snapshot endpoint.
router.get("/admin/db/schema", ...superuserOnly, async (req, res) => {
  const started = Date.now();
  try {
    const [[{ db }]] = await req.db.query("SELECT DATABASE() AS db");

    const [tables] = await req.db.query(
      `SELECT TABLE_NAME AS name, TABLE_COMMENT AS comment, ENGINE AS engine
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME`, [db]
    );

    const [columns] = await req.db.query(
      `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name, COLUMN_TYPE AS type,
              IS_NULLABLE AS nullable, COLUMN_KEY AS keyType, COLUMN_DEFAULT AS defaultValue,
              EXTRA AS extra, ORDINAL_POSITION AS position
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, ORDINAL_POSITION`, [db]
    );

    const [indexes] = await req.db.query(
      `SELECT TABLE_NAME AS tableName, INDEX_NAME AS name, NON_UNIQUE AS nonUnique,
              COLUMN_NAME AS columnName, SEQ_IN_INDEX AS seq
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, [db]
    );

    const [fks] = await req.db.query(
      `SELECT TABLE_NAME AS tableName, CONSTRAINT_NAME AS name,
              COLUMN_NAME AS columnName, REFERENCED_TABLE_NAME AS refTable,
              REFERENCED_COLUMN_NAME AS refColumn
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY TABLE_NAME, CONSTRAINT_NAME`, [db]
    );

    const byTable = Object.fromEntries(tables.map(t => [t.name, { ...t, columns: [], indexes: [], foreignKeys: [] }]));
    for (const c of columns) byTable[c.tableName]?.columns.push(c);
    const idxByName = {};
    for (const i of indexes) {
      const key = `${i.tableName}::${i.name}`;
      (idxByName[key] ||= { tableName: i.tableName, name: i.name, nonUnique: !!i.nonUnique, columns: [] }).columns.push(i.columnName);
    }
    for (const i of Object.values(idxByName)) byTable[i.tableName]?.indexes.push(i);
    for (const f of fks) byTable[f.tableName]?.foreignKeys.push(f);

    await auditDbConsole(req.db, {
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method, readOnlyMode: true,
      status: "success", rowCount: tables.length, durationMs: Date.now() - started,
      ip: ipOf(req), userAgent: req.headers["user-agent"] || "unknown",
    });
    res.json({ database: db, tables: Object.values(byTable) });
  } catch (err) {
    await auditDbConsole(req.db, {
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method, readOnlyMode: true,
      status: "error", errorMessage: err.message, durationMs: Date.now() - started,
      ip: ipOf(req), userAgent: req.headers["user-agent"] || "unknown",
    });
    res.status(500).json({ error: err.message });
  }
});


// ── GET /admin/db/schema.sql ─────────────────────────────────────────────────
// Streams the dump as an attachment. Works everywhere (dev + Cloud Run).
router.get("/admin/db/schema.sql", ...superuserOnly, async (req, res) => {
  const started = Date.now();
  try {
    const { body, fileName, tableCount } = await buildSchemaDump(req.db, "GET /admin/db/schema.sql");
    await auditDbConsole(req.db, {
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method, readOnlyMode: true,
      status: "success", rowCount: tableCount, durationMs: Date.now() - started,
      ip: ipOf(req), userAgent: req.headers["user-agent"] || "unknown",
      queryText: `schema.sql download (${tableCount} tables, ${body.length} bytes)`,
    });
    res.set("Content-Type", "application/sql; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(body);
  } catch (err) {
    await auditDbConsole(req.db, {
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method, readOnlyMode: true,
      status: "error", errorMessage: err.message, durationMs: Date.now() - started,
      ip: ipOf(req), userAgent: req.headers["user-agent"] || "unknown",
    });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/db/schema/save-to-ref ────────────────────────────────────────
// Dev-only: writes the dump to ref/schema-*.sql so it can be committed to git.
// Refused outside ENVIRONMENT=development because Cloud Run's filesystem is
// ephemeral — writes would succeed momentarily and vanish on restart.
router.post("/admin/db/schema/save-to-ref", ...superuserOnly, async (req, res) => {
  const started = Date.now();
  if (process.env.ENVIRONMENT !== "development") {
    await auditDbConsole(req.db, {
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method, readOnlyMode: true,
      status: "rejected_not_dev", durationMs: Date.now() - started,
      ip: ipOf(req), userAgent: req.headers["user-agent"] || "unknown",
    });
    return res.status(400).json({ error: "save-to-ref is only available when ENVIRONMENT=development (Cloud Run's filesystem is ephemeral)." });
  }
  try {
    const { body, tableCount } = await buildSchemaDump(req.db, "POST /admin/db/schema/save-to-ref");
    const fileName = "database.sql";  // canonical ref file — overwrite in place, not a timestamped drop
    const refDir = path.join(__dirname, "..", "ref");
    await fs.mkdir(refDir, { recursive: true });
    const filePath = path.join(refDir, fileName);
    await fs.writeFile(filePath, body, "utf8");
    await auditDbConsole(req.db, {
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method, readOnlyMode: true,
      status: "success", rowCount: tableCount, durationMs: Date.now() - started,
      ip: ipOf(req), userAgent: req.headers["user-agent"] || "unknown",
      queryText: `save-to-ref -> ref/${fileName}`,
    });
    res.json({ ok: true, file: `ref/${fileName}`, tables: tableCount, bytes: body.length });
  } catch (err) {
    await auditDbConsole(req.db, {
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method, readOnlyMode: true,
      status: "error", errorMessage: err.message, durationMs: Date.now() - started,
      ip: ipOf(req), userAgent: req.headers["user-agent"] || "unknown",
    });
    res.status(500).json({ error: err.message });
  }
});

// ── saved queries ────────────────────────────────────────────────────────────
router.get("/admin/db/saved-queries", ...superuserOnly, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT id, name, query_text AS query, created_at, updated_at
         FROM admin_saved_queries
        WHERE user_id = ?
        ORDER BY name`, [req.auth.userId]
    );
    res.json({ ok: true, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/admin/db/saved-queries", ...superuserOnly, async (req, res) => {
  const { name, query } = req.body || {};
  if (!name || !query) return res.status(400).json({ error: "name and query are required" });
  try {
    const [r] = await req.db.query(
      `INSERT INTO admin_saved_queries (user_id, name, query_text) VALUES (?, ?, ?)`,
      [req.auth.userId, String(name).slice(0, 120), String(query)]
    );
    res.json({ ok: true, id: r.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/admin/db/saved-queries/:id", ...superuserOnly, async (req, res) => {
  const { name, query } = req.body || {};
  if (!name || !query) return res.status(400).json({ error: "name and query are required" });
  try {
    const [r] = await req.db.query(
      `UPDATE admin_saved_queries SET name = ?, query_text = ?
        WHERE id = ? AND user_id = ?`,
      [String(name).slice(0, 120), String(query), Number(req.params.id), req.auth.userId]
    );
    if (!r.affectedRows) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/admin/db/saved-queries/:id", ...superuserOnly, async (req, res) => {
  try {
    const [r] = await req.db.query(
      `DELETE FROM admin_saved_queries WHERE id = ? AND user_id = ?`,
      [Number(req.params.id), req.auth.userId]
    );
    if (!r.affectedRows) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;