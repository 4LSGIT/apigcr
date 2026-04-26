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
//   GET    /admin/db/schema             -> { tables: [...] }
//   GET    /admin/db/schema.sql         downloads schema-YYYYMMDD-HHMMSS.sql (no data)
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
const { superuserOnly, auditDbConsole } = require("../lib/auth.superuser");

const router = express.Router();

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
      `SELECT TABLE_NAME AS tableName, CONSTRAINT_NAME AS name, COLUMN_NAME AS columnName,
              REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refColumn
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

// Build a CREATE-TABLE-only schema dump (no data). Returns { body, fileName,
// tableCount }. Used by both the download and the dev-only save endpoints.
async function buildSchemaDump(db, source) {
  const [[{ db: dbName }]] = await db.query("SELECT DATABASE() AS db");
  const [tables] = await db.query(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME`, [dbName]
  );
  const parts = [
    `-- Schema snapshot for \`${dbName}\``,
    `-- Generated: ${new Date().toISOString()}`,
    `-- Source: ${source}`,
    `-- Contains CREATE TABLE statements only (no data).`,
    ``,
  ];
  for (const { name } of tables) {
    const [[row]] = await db.query(`SHOW CREATE TABLE \`${name}\``);
    const createSql = row["Create Table"] || row["Create View"] || "";
    parts.push(`-- -----------------------------------------------------`);
    parts.push(`-- Table: ${name}`);
    parts.push(`-- -----------------------------------------------------`);
    parts.push(`DROP TABLE IF EXISTS \`${name}\`;`);
    parts.push(`${createSql};`);
    parts.push(``);
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, "");
  const fileName = `schema-${stamp.slice(0, 8)}-${stamp.slice(8, 14)}.sql`;
  return { body: parts.join("\n"), fileName, tableCount: tables.length };
}

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
    const { body, fileName, tableCount } = await buildSchemaDump(req.db, "POST /admin/db/schema/save-to-ref");
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
