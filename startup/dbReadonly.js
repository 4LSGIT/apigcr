// startup/dbReadonly.js
//
// Dedicated mysql2 pool using the `yc_readonly` MySQL user (SELECT-only
// grants). Separate from the main pool in startup/db.js so the grant
// boundary cannot be bypassed by accident.
//
// Env vars (each falls back to the main-pool counterpart):
//   host_ro      → host
//   user_ro      → (required, no fallback — we DO NOT want to silently
//                   share creds with the privileged user)
//   password_ro  → (required)
//   database_ro  → database
//   port_ro      → port (mysql2 default 3306)
//
//   READONLY_KEY_MAX_TTL_DAYS (default 3).
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