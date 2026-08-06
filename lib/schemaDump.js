// lib/schemaDump.js
//
// Builds the phpMyAdmin-compatible schema dump that lives at ref/database.sql,
// plus a cheap structural fingerprint used to decide whether the dump needs
// regenerating at all.
//
// Two callers:
//   routes/admin.dbConsole.js  — GET /admin/db/schema.sql, POST /admin/db/schema/save-to-ref
//   scripts/dump-schema.js     — CLI / pre-commit hook
//
// Exports: { buildSchemaDump, schemaFingerprint, parseCreateTable, FINGERPRINT_RE }

const crypto = require("crypto");

// ─────────────────────────────────────────────────────────────────────────────
// Structural fingerprint.
//
// buildSchemaDump costs one SHOW CREATE TABLE per table (117 round trips today),
// which is too slow to run on every commit. The fingerprint costs 6 queries
// regardless of table count: it hashes the information_schema rows that describe
// structure — columns, indexes, FKs, checks, triggers, views, table options —
// and deliberately excludes volatile fields (AUTO_INCREMENT high-water mark,
// TABLE_ROWS, UPDATE_TIME, DATA_LENGTH) so it only moves on real DDL.
//
// Every query is explicitly ORDER BY'd so the hash is stable run-to-run.
// ─────────────────────────────────────────────────────────────────────────────
async function schemaFingerprint(db) {
  const [[{ db: dbName }]] = await db.query("SELECT DATABASE() AS db");

  const q = (sql) => db.query(sql, [dbName]).then(([rows]) => rows);

  const [tables, columns, indexes, fks, checks, triggers, views] = await Promise.all([
    q(`SELECT TABLE_NAME, ENGINE, TABLE_COLLATION, TABLE_COMMENT, ROW_FORMAT
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME`),
    q(`SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, IS_NULLABLE,
              COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, COLLATION_NAME, GENERATION_EXPRESSION
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, ORDINAL_POSITION`),
    q(`SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, EXPRESSION,
              NON_UNIQUE, INDEX_TYPE, SUB_PART, NULLABLE
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`),
    q(`SELECT k.CONSTRAINT_NAME, k.TABLE_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION,
              k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
              r.UPDATE_RULE, r.DELETE_RULE
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
          AND r.CONSTRAINT_NAME   = k.CONSTRAINT_NAME
        WHERE k.CONSTRAINT_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`),
    q(`SELECT CONSTRAINT_NAME, CHECK_CLAUSE
         FROM information_schema.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = ?
        ORDER BY CONSTRAINT_NAME`).catch(() => []),   // MySQL < 8.0.16
    q(`SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION,
              ACTION_ORDER, ACTION_STATEMENT
         FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = ?
        ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER, TRIGGER_NAME`),
    q(`SELECT TABLE_NAME, VIEW_DEFINITION
         FROM information_schema.VIEWS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME`),
  ]);

  const payload = JSON.stringify(
    { tables, columns, indexes, fks, checks, triggers, views },
    (_k, v) => (Buffer.isBuffer(v) ? v.toString("utf8") : v)
  );
  return "sha256:" + crypto.createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

// Matches the `-- Fingerprint: …` header line written into the dump.
const FINGERPRINT_RE = /^--\s*Fingerprint:\s*(\S+)\s*$/m;

// ─────────────────────────────────────────────────────────────────────────────
// Schema dump construction.
//
// The output is a phpMyAdmin-compatible .sql file with one notable goal: it's
// committed to git, so we (a) omit the database identifier and (b) strip the
// AUTO_INCREMENT high-water mark from table options to keep diffs quiet.
//
// Layout:
//   preamble (SET … / FOREIGN_KEY_CHECKS = 0)
//   for each base table:
//     CREATE TABLE (columns + CHECK constraints only — keys/FKs deferred)
//     CREATE TRIGGER blocks for triggers attached to that table
//   for each view:
//     CREATE VIEW (DEFINER/SQL SECURITY stripped for portability)
//   ALTER TABLE … ADD PRIMARY KEY/KEY/UNIQUE/FULLTEXT/SPATIAL  (one block per table)
//   ALTER TABLE … MODIFY … AUTO_INCREMENT                       (one block per table)
//   ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY                   (one block per table)
//   postamble (FOREIGN_KEY_CHECKS = 1, COMMIT)
//
// The deferred-keys structure means the file re-imports cleanly into a fresh
// DB regardless of FK ordering. CHECK constraints are kept inline (phpMyAdmin
// silently drops them, which is a bug — they're part of the schema).
// ─────────────────────────────────────────────────────────────────────────────

// Parse a SHOW CREATE TABLE result into { createTable (without keys/FKs),
// indexes (raw key clauses), fks (raw constraint clauses), autoIncCol,
// autoIncTypeSpec }. The type-spec captures everything between the column name
// and the AUTO_INCREMENT keyword — typically "int NOT NULL" or
// "bigint UNSIGNED NOT NULL" — so we can reproduce it verbatim in the deferred
// MODIFY clause.
function parseCreateTable(name, ddl) {
  const lines = ddl.split("\n");
  const headerLine = lines[0];                         // CREATE TABLE `name` (
  const footerLine = lines[lines.length - 1];          // ) ENGINE=InnoDB ...
  const bodyLines  = lines.slice(1, -1);

  const cols    = [];   // column definitions + inline CHECK constraints (kept in CREATE TABLE)
  const indexes = [];   // raw "PRIMARY KEY (...)" / "KEY ... (...)" clauses
  const fks     = [];   // raw "CONSTRAINT ... FOREIGN KEY ..." clauses
  let autoIncCol      = null;
  let autoIncTypeSpec = null;

  for (const rawLine of bodyLines) {
    const noComma = rawLine.replace(/,\s*$/, "");
    const trimmed = noComma.trim();
    if (!trimmed) continue;

    if (/^`[^`]+`/.test(trimmed)) {
      // Column definition. Detect AUTO_INCREMENT and extract the type spec.
      const aiMatch = trimmed.match(/^`([^`]+)`\s+(.+)\s+AUTO_INCREMENT\b/i);
      if (aiMatch) {
        autoIncCol = aiMatch[1];
        autoIncTypeSpec = aiMatch[2];
        cols.push(noComma.replace(/\s+AUTO_INCREMENT\b/i, ""));
      } else {
        cols.push(noComma);
      }
    } else if (/^(PRIMARY KEY|UNIQUE KEY|KEY|FULLTEXT KEY|SPATIAL KEY)\b/i.test(trimmed)) {
      indexes.push(trimmed);
    } else if (/^CONSTRAINT\s+`[^`]+`\s+FOREIGN KEY\b/i.test(trimmed)) {
      fks.push(trimmed);
    } else {
      // CHECK constraint or unknown clause — keep inline. CHECK references
      // columns that exist in the table being defined, so it's safe here.
      cols.push(noComma);
    }
  }

  // Strip the AUTO_INCREMENT high-water mark — noisy in git diffs, irrelevant
  // for re-import.
  const cleanFooter = footerLine.replace(/\s+AUTO_INCREMENT=\d+/i, "");

  const createTable = `${headerLine}\n${cols.join(",\n")}\n${cleanFooter};`;
  return { name, createTable, indexes, fks, autoIncCol, autoIncTypeSpec };
}

// Build the full dump. Returns { body, fileName, tableCount }.
async function buildSchemaDump(db, source, opts = {}) {
  const [[{ db: dbName }]] = await db.query("SELECT DATABASE() AS db");

  // Fingerprint of the structural metadata, embedded in the header so a caller
  // (scripts/dump-schema.js) can tell "schema actually changed" from "dump re-run"
  // without diffing 165 KB of SQL against a moving Generated: timestamp.
  const fingerprint = opts.fingerprint || await schemaFingerprint(db);

  const [tableRows] = await db.query(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME`, [dbName]
  );

  const [viewRows] = await db.query(
    `SELECT TABLE_NAME AS name FROM information_schema.VIEWS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME`, [dbName]
  );

  const [triggerRows] = await db.query(
    `SELECT TRIGGER_NAME       AS name,
            EVENT_MANIPULATION AS event,
            EVENT_OBJECT_TABLE AS tableName,
            ACTION_TIMING      AS timing,
            ACTION_STATEMENT   AS body
       FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = ?
      ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER, TRIGGER_NAME`, [dbName]
  );
  const triggersByTable = {};
  for (const t of triggerRows) (triggersByTable[t.tableName] ||= []).push(t);

  // Pull each table's CREATE TABLE and split into deferred parts.
  const parsedTables = [];
  for (const { name } of tableRows) {
    const [[row]] = await db.query(`SHOW CREATE TABLE \`${name}\``);
    const ddl = row["Create Table"];
    if (ddl) parsedTables.push(parseCreateTable(name, ddl));
  }

  const parts = [];

  // Preamble
  parts.push(
    `-- DB Console schema snapshot`,
    `-- Generated: ${new Date().toISOString()}`,
    `-- Source: ${source}`,
    `-- Fingerprint: ${fingerprint}`,
    `-- Contains schema only (no data, no database identifier).`,
    ``,
    `SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";`,
    `START TRANSACTION;`,
    `SET time_zone = "+00:00";`,
    `SET FOREIGN_KEY_CHECKS = 0;`,
    ``,
    `/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;`,
    `/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;`,
    `/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;`,
    `/*!40101 SET NAMES utf8mb4 */;`,
    ``
  );

  // Tables (CREATE TABLE without keys/FKs) + per-table triggers.
  for (const t of parsedTables) {
    parts.push(`-- --------------------------------------------------------`);
    parts.push(``);
    parts.push(`--`);
    parts.push(`-- Table structure for table \`${t.name}\``);
    parts.push(`--`);
    parts.push(``);
    parts.push(`DROP TABLE IF EXISTS \`${t.name}\`;`);
    parts.push(t.createTable);
    parts.push(``);

    const tt = triggersByTable[t.name] || [];
    if (tt.length) {
      parts.push(`--`);
      parts.push(`-- Triggers for table \`${t.name}\``);
      parts.push(`--`);
      for (const trig of tt) {
        parts.push(`DELIMITER $$`);
        parts.push(
          `CREATE TRIGGER \`${trig.name}\` ${trig.timing} ${trig.event} ` +
          `ON \`${trig.tableName}\` FOR EACH ROW ${trig.body}`
        );
        parts.push(`$$`);
        parts.push(`DELIMITER ;`);
      }
      parts.push(``);
    }
  }

  // Views — placed after tables so they can reference any table. DEFINER and
  // SQL SECURITY clauses are stripped so the dump re-imports without needing
  // the same DB user to exist.
  for (const { name } of viewRows) {
    let viewSql = "";
    try {
      const [[row]] = await db.query(`SHOW CREATE VIEW \`${name}\``);
      viewSql = (row["Create View"] || "").replace(
        /CREATE\s+(?:ALGORITHM=\w+\s+)?(?:DEFINER=`[^`]+`@`[^`]+`\s+)?(?:SQL SECURITY \w+\s+)?VIEW/i,
        "CREATE VIEW"
      );
    } catch (e) {
      // Skip views we can't introspect (rare; usually a privilege issue).
      continue;
    }

    parts.push(`-- --------------------------------------------------------`);
    parts.push(``);
    parts.push(`--`);
    parts.push(`-- Structure for view \`${name}\``);
    parts.push(`--`);
    parts.push(``);
    parts.push(`DROP VIEW IF EXISTS \`${name}\`;`);
    parts.push(`${viewSql};`);
    parts.push(``);
  }

  // Indexes — one ALTER TABLE per table, all keys grouped.
  const tablesWithIndexes = parsedTables.filter(t => t.indexes.length);
  if (tablesWithIndexes.length) {
    parts.push(`--`);
    parts.push(`-- Indexes for dumped tables`);
    parts.push(`--`);
    parts.push(``);
    for (const t of tablesWithIndexes) {
      parts.push(`--`);
      parts.push(`-- Indexes for table \`${t.name}\``);
      parts.push(`--`);
      parts.push(`ALTER TABLE \`${t.name}\``);
      parts.push(`  ${t.indexes.map(i => `ADD ${i}`).join(",\n  ")};`);
      parts.push(``);
    }
  }

  // AUTO_INCREMENT — one MODIFY per table.
  const tablesWithAi = parsedTables.filter(t => t.autoIncCol);
  if (tablesWithAi.length) {
    parts.push(`--`);
    parts.push(`-- AUTO_INCREMENT for dumped tables`);
    parts.push(`--`);
    parts.push(``);
    for (const t of tablesWithAi) {
      parts.push(`--`);
      parts.push(`-- AUTO_INCREMENT for table \`${t.name}\``);
      parts.push(`--`);
      parts.push(`ALTER TABLE \`${t.name}\``);
      parts.push(`  MODIFY \`${t.autoIncCol}\` ${t.autoIncTypeSpec} AUTO_INCREMENT;`);
      parts.push(``);
    }
  }

  // Foreign keys — last, since both sides of the reference must exist.
  const tablesWithFks = parsedTables.filter(t => t.fks.length);
  if (tablesWithFks.length) {
    parts.push(`--`);
    parts.push(`-- Constraints for dumped tables`);
    parts.push(`--`);
    parts.push(``);
    for (const t of tablesWithFks) {
      parts.push(`--`);
      parts.push(`-- Constraints for table \`${t.name}\``);
      parts.push(`--`);
      parts.push(`ALTER TABLE \`${t.name}\``);
      parts.push(`  ${t.fks.map(fk => `ADD ${fk}`).join(",\n  ")};`);
      parts.push(``);
    }
  }

  // Postamble
  parts.push(`SET FOREIGN_KEY_CHECKS = 1;`);
  parts.push(`COMMIT;`);
  parts.push(``);
  parts.push(`/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;`);
  parts.push(`/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;`);
  parts.push(`/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;`);
  parts.push(``);

  const stamp = new Date().toISOString().replace(/[-:T]/g, "");
  const fileName = `schema-${stamp.slice(0, 8)}-${stamp.slice(8, 14)}.sql`;
  return { body: parts.join("\n"), fileName, tableCount: tableRows.length, fingerprint };
}

module.exports = { buildSchemaDump, schemaFingerprint, parseCreateTable, FINGERPRINT_RE };
