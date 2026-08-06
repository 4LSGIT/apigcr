#!/usr/bin/env node
// scripts/dump-schema.js
//
// Regenerates ref/database.sql from the live DB — but only when the schema
// actually changed.
//
// Cost model, measured against this DB from a laptop:
//   opening a connection  ~4000 ms   ← dominates everything
//   one query               ~40 ms
//   SHOW CREATE TABLE ×118  ~5000 ms (8 concurrent)
//
// So: the common "did anything change?" path uses ONE connection and runs its
// queries in series. A pool is created only when a full dump is actually
// needed, because there the per-table round trips are worth 8 handshakes.
//
// The check compares a structural fingerprint against the `-- Fingerprint:`
// line in the existing ref/database.sql. Match -> exit, file untouched, no diff
// noise from the moving `-- Generated:` timestamp. Mismatch -> full dump.
//
// Usage:
//   node scripts/dump-schema.js            regenerate if the schema changed
//   node scripts/dump-schema.js --force    regenerate unconditionally
//   node scripts/dump-schema.js --check    report drift, write nothing (exit 1 if drifted)
//   node scripts/dump-schema.js --quiet    only speak when something changed or broke
//   node scripts/dump-schema.js --strict   exit non-zero if the DB is unreachable
//   node scripts/dump-schema.js --timing   per-phase + per-query ms breakdown
//
// Live progress (table counter) goes to stderr whenever stderr is a TTY, even
// under --quiet — that's status, not chatter, and it's erased when done.
//
// Exit codes: 0 = fine (unchanged / written), 1 = drift detected under --check,
// 2 = error. Without --strict a DB failure warns and exits 0, so a commit made
// offline still goes through.

const fs    = require("fs/promises");
const path  = require("path");
const mysql = require("mysql2");

// Explicit path, not cwd-relative: git runs hooks from the repo root, but a
// human running this from scripts/ shouldn't get a silent "missing env var".
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { buildSchemaDump, schemaFingerprint, FINGERPRINT_RE } = require("../lib/schemaDump");

const argv   = process.argv.slice(2);
const has    = (f) => argv.includes(f);
const FORCE  = has("--force");
const CHECK  = has("--check");
const QUIET  = has("--quiet");
const STRICT = has("--strict");
const TIMING = has("--timing");

const REF_FILE = path.join(__dirname, "..", "ref", "database.sql");

const say  = (msg) => { if (!QUIET) console.log(`[schema] ${msg}`); };
const warn = (msg) => { status.clear(); console.warn(`[schema] ${msg}`); };

// ── timing ───────────────────────────────────────────────────────────────────
// Baseline is process start, not module end, so "boot" captures node spawn +
// require('mysql2') — a real slice of a git hook's wall clock.
const marks = [["boot", process.uptime() * 1000, 0]];
let last = process.uptime() * 1000;
const mark = (label, depth = 0) => {
  const now = process.uptime() * 1000;
  marks.push([label, now - last, depth]);
  last = now;
};
const submark = (label, ms) => marks.push([label, ms, 1]);

function printTiming() {
  if (!TIMING) return;
  const total = process.uptime() * 1000;
  const width = Math.max(...marks.map(([l, , d]) => l.length + d * 2));
  console.log("[schema] timing:");
  for (const [label, ms, depth] of marks) {
    const name = "  ".repeat(depth) + label;
    console.log(`  ${name.padEnd(width)}  ${ms.toFixed(0).padStart(6)} ms`);
  }
  console.log(`  ${"TOTAL".padEnd(width)}  ${total.toFixed(0).padStart(6)} ms`);
}

// ── live status line ─────────────────────────────────────────────────────────
// stderr, TTY-only, \r-rewritten and erased on completion. Non-TTY (CI, piped
// output) gets nothing, so logs stay clean.
const status = {
  active: false,
  write(text) {
    if (!process.stderr.isTTY) return;
    process.stderr.write(`\r\x1b[K[schema] ${text}`);
    this.active = true;
  },
  clear() {
    if (this.active) { process.stderr.write("\r\x1b[K"); this.active = false; }
  },
};

function dbConfig() {
  for (const k of ["host", "user", "password", "database"]) {
    if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present?)`);
  }
  return {
    host:           process.env.host,
    user:           process.env.user,
    password:       process.env.password,
    database:       process.env.database,
    timezone:       "Z",
    connectTimeout: 15_000,
  };
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
  let conn, pool;
  try {
    mark("require");

    // Single connection for the check — one handshake, queries in series.
    status.write("connecting…");
    conn = mysql.createConnection(dbConfig()).promise();
    await conn.query("SELECT 1");
    mark("connect");

    status.write("checking schema…");
    const previous = await existingFingerprint();
    const current  = await schemaFingerprint(conn, {
      onQuery: ({ name, ms, rows }) => {
        if (TIMING) submark(`${name} (${rows} rows)`, ms);
        status.write(`checking schema… ${name}`);
      },
    });
    mark("fingerprint");
    status.clear();

    if (!FORCE && previous && current === previous) {
      say("unchanged");
      printTiming();
      return 0;
    }

    if (CHECK) {
      warn(previous
        ? `drift: ref/database.sql is stale (${previous} -> ${current})`
        : "drift: ref/database.sql missing or has no fingerprint");
      printTiming();
      return 1;
    }

    // Only now is a pool worth its handshakes: 118 SHOW CREATE TABLE round
    // trips, 8 at a time, beats 118 in series on the one connection we have.
    status.write("opening pool…");
    pool = mysql.createPool({ ...dbConfig(), connectionLimit: 8, waitForConnections: true })
                .promise();
    await pool.query("SELECT 1");
    mark("pool");

    const { body, tableCount } = await buildSchemaDump(pool, "scripts/dump-schema.js", {
      fingerprint: current,
      concurrency: 8,
      onProgress: ({ done, total }) => status.write(`dumping ${done}/${total} tables…`),
    });
    mark("dump");
    status.clear();

    await fs.mkdir(path.dirname(REF_FILE), { recursive: true });
    await fs.writeFile(REF_FILE, body, "utf8");
    mark("write");

    console.log(`[schema] ref/database.sql updated — ${tableCount} tables, ${body.length} bytes`);
    printTiming();
    return 0;
  } catch (err) {
    warn(`skipped: ${err.code || err.name} — ${err.message}`);
    printTiming();
    return STRICT || CHECK ? 2 : 0;
  } finally {
    status.clear();
    if (conn) await conn.end().catch(() => {});
    if (pool) await pool.end().catch(() => {});
  }
})().then((code) => process.exit(code));