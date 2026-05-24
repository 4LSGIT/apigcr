// startup/dbReadonly.js
//
// Dedicated mysql2 pool using the obfuscated read-only MySQL user
// (SELECT-only grants, IP-bound to Cloud Run egress). Separate from
// the main pool in startup/db.js so the grant boundary cannot be
// bypassed by accident.
//
// Env vars (each falls back to the main-pool counterpart):
//   host_ro      → host
//   user_ro      → (required, no fallback — we DO NOT want to silently
//                   share creds with the privileged user)
//   password_ro  → (required)
//   database_ro  → database
//   port_ro      → port (mysql2 default 3306)
//
// connectionLimit deliberately small — this pool is for human/Claude
// interactive use, not app traffic.

const mysql = require("mysql2");

const roUser = process.env.user_ro;
const roPass = process.env.password_ro;

if (!roUser || !roPass) {
  console.warn("[dbReadonly] user_ro / password_ro not set — /api/readonly/sql will fail until configured.");
}

const pool = mysql.createPool({
  host:     process.env.host_ro     || process.env.host,
  user:     roUser     || "MISSING_USER_RO",
  password: roPass     || "MISSING_PASSWORD_RO",
  database: process.env.database_ro || process.env.database,
  port:     process.env.port_ro     || process.env.port || 3306,
  timezone: "Z",
  connectionLimit: 3,
  waitForConnections: true,
  queueLimit: 0,

  // Explicit safety: no batching, no implicit file ops.
  multipleStatements: false,

  // Return BIGINT and DECIMAL columns as strings so JSON.stringify
  // doesn't choke. JSON columns come through as parsed objects (mysql2
  // default).
  supportBigNumbers: true,
  bigNumberStrings: true,

  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  maxIdle: 3,
  idleTimeout: 60_000,
});

pool.on("error", err => {
  console.error("MySQL RO pool error:", err);
});

const promisePool = pool.promise();

if (process.env.ENVIRONMENT === "development" && roUser && roPass) {
  promisePool.query("SELECT 1")
    .then(() => console.log(`[dbReadonly] connected as ${roUser}@${process.env.host_ro || process.env.host}`))
    .catch((err) => console.error(`[dbReadonly] connection failed: ${err.code || err.name} — ${err.message}`));
}

module.exports = promisePool;


// ═══════════════════════════════════════════════════════════════════════
// REMOVAL INSTRUCTIONS — if/when this entire subsystem is ripped out
// ═══════════════════════════════════════════════════════════════════════
//
// This file is part of the "readonly DB access for AI sessions" subsystem
// added 2026-05. If Anthropic stops being involved, or the audit value no
// longer justifies the surface area, undo the whole thing in this order:
//
// 1. REVOKE OUTSTANDING KEYS first (UI: Admin tab → "Readonly Keys (SU)" →
//    revoke each active row). This is belt-and-suspenders — the table drop
//    in step 5 invalidates them anyway, but explicit revoke is cleaner.
//
// 2. DELETE THESE FILES:
//      startup/dbReadonly.js            (this file)
//      startup/dbScratch.js             (if scratch subsystem was added)
//      lib/auth.readonly.js
//      lib/sqlGuard.js                  (UNLESS admin.dbConsole.js was
//                                         refactored to import from it —
//                                         check first with `grep -r sqlGuard`)
//      routes/api.readonly.js
//      routes/api.readonlyKeys.js
//      routes/api.scratch.js            (if scratch subsystem was added)
//      public/readonlyKeys.html
//
// 3. REVERT public/b.html (or whichever is the live shell at the time):
//      - the "Readonly Keys (SU)" button in the Admin tab
//      - the readonlyKeysSwal() function
//    Either restore the original testSwalPage() or remove both entirely.
//
// 4. REMOVE ENV VARS from Cloud Run service config:
//      user_ro
//      password_ro
//      host_ro                          (if set)
//      database_ro                      (if set)
//      port_ro                          (if set)
//      READONLY_KEY_MAX_TTL_DAYS        (if set)
//      user_scratch                     (if scratch subsystem was added)
//      password_scratch                 (if scratch subsystem was added)
//
// 5. DROP DB OBJECTS (run as DBA, after files deploy is live):
//      DROP TABLE IF EXISTS readonly_query_log;   -- FK → readonly_api_keys
//      DROP TABLE IF EXISTS readonly_api_keys;
//      DROP TABLE IF EXISTS rw_scratch;           -- if scratch added
//      -- Then drop the dedicated MySQL users. Names are obfuscated; look
//      -- them up via:
//      --   SELECT User, Host FROM mysql.user
//      --     WHERE User NOT IN ('root','<main app user>','mysql.sys',
//      --                        'mysql.session','mysql.infoschema');
//      -- Then for each:
//      --   DROP USER '<obfuscated>'@'<egress-ip>';
//      FLUSH PRIVILEGES;
//
// 6. REMOVE the AI-CONTEXT section. Search YISRACASE_AI_CONTEXT.md for
//    "READONLY DATABASE ACCESS" and delete that section. Same for
//    YISRAFLOW_COOKBOOK.md if it ever picks up an entry.
//
// 7. The rows in admin_audit_log under tool='readonlyKeys' and tool='db_readonly'
//    are historical audit data — DO NOT delete. They survive subsystem removal.
//
// Order matters: code deploy without DB objects → /api/readonly/sql returns
// 500. DB drop without code removal → same. Always remove code first, then
// drop tables.
//
// ═══════════════════════════════════════════════════════════════════════