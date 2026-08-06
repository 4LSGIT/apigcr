#!/usr/bin/env node
// scripts/dump-schema.js
//
// Regenerates ref/database.sql from the live DB — but only when the schema
// actually changed.
//
// The dump itself costs one SHOW CREATE TABLE per table (117 round trips), so
// running it on every commit would add seconds to `git commit`. Instead we
// first compute a structural fingerprint (6 information_schema queries, flat
// cost) and compare it to the `-- Fingerprint:` line in the existing
// ref/database.sql. Match -> exit immediately, file untouched, no diff noise
// from the moving `-- Generated:` timestamp. Mismatch -> full dump + write.
//
// Usage:
//   node scripts/dump-schema.js            regenerate if the schema changed
//   node scripts/dump-schema.js --force    regenerate unconditionally
//   node scripts/dump-schema.js --check    report drift, write nothing (exit 1 if drifted)
//   node scripts/dump-schema.js --quiet    only speak when something changed or broke
//   node scripts/dump-schema.js --strict   exit non-zero if the DB is unreachable
//
// Exit codes: 0 = fine (unchanged / written), 1 = drift detected under --check,
// 2 = error. Without --strict a DB failure warns and exits 0, so a commit made
// offline or on a plane still goes through.

require("dotenv").config();

const fs    = require("fs/promises");
const path  = require("path");
const mysql = require("mysql2");

const { buildSchemaDump, schemaFingerprint, FINGERPRINT_RE } = require("../lib/schemaDump");

const argv   = process.argv.slice(2);
const has    = (f) => argv.includes(f);
const FORCE  = has("--force");
const CHECK  = has("--check");
const QUIET  = has("--quiet");
const STRICT = has("--strict");

const REF_FILE = path.join(__dirname, "..", "ref", "database.sql");

const say  = (msg) => { if (!QUIET) console.log(`[schema] ${msg}`); };
const warn = (msg) => console.warn(`[schema] ${msg}`);

function makePool() {
  for (const k of ["host", "user", "password", "database"]) {
    if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present?)`);
  }
  return mysql.createPool({
    host:            process.env.host,
    user:            process.env.user,
    password:        process.env.password,
    database:        process.env.database,
    timezone:        "Z",
    connectionLimit: 4,
    waitForConnections: true,
    connectTimeout:  10_000,
  }).promise();
}

async function existingFingerprint() {
  try {
    const body  = await fs.readFile(REF_FILE, "utf8");
    const match = body.match(FINGERPRINT_RE);
    return match ? match[1] : null;   // null = pre-fingerprint file, force a rebuild
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

(async () => {
  let db;
  try {
    db = makePool();

    const [current, previous] = await Promise.all([
      schemaFingerprint(db),
      existingFingerprint(),
    ]);

    if (!FORCE && previous && current === previous) {
      say("unchanged");
      return 0;
    }

    if (CHECK) {
      warn(previous
        ? `drift: ref/database.sql is stale (${previous} -> ${current})`
        : "drift: ref/database.sql missing or has no fingerprint");
      return 1;
    }

    const { body, tableCount } = await buildSchemaDump(
      db,
      "scripts/dump-schema.js",
      { fingerprint: current }
    );

    await fs.mkdir(path.dirname(REF_FILE), { recursive: true });
    await fs.writeFile(REF_FILE, body, "utf8");

    console.log(`[schema] ref/database.sql updated — ${tableCount} tables, ${body.length} bytes`);
    return 0;
  } catch (err) {
    warn(`skipped: ${err.code || err.name} — ${err.message}`);
    return STRICT || CHECK ? 2 : 0;
  } finally {
    if (db) await db.end().catch(() => {});
  }
})().then((code) => process.exit(code));
