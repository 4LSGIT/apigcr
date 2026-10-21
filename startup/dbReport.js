// startup/dbReport.js
//
// Dedicated mysql2 pool for the validator-gated report/assistant surface
// (services/reportService.js: /api/reports/* and the assistant's sql.read).
// It uses the least-privilege MySQL account provisioned by
// scripts/reportGrantUserProvision.js — per-column SELECT on exactly the
// report manifest's tables, secrets withheld — so even a validator bypass
// reads nothing outside the curated set (arc review 2026-10-21 P0#1; the
// regex validator is defence, this account is the boundary).
//
// The ycro readonly endpoint (routes/api.readonly.js) deliberately STAYS on
// startup/dbReadonly's broader account: its keys are SU-minted and
// sqlGuard-tiered, and they legitimately read tables outside the report
// manifest (rw_scratch, information_schema, …). Do not point it here.
//
// Env vars:
//   user_report / password_report — the least-privilege account. UNSET =
//   fall back to startup/dbReadonly's pool, with a loud boot line: reports
//   must not break on the deploy that ships this module, before the Cloud
//   Run env vars exist. Once the vars are live, the fallback line must be
//   absent from boot logs (verification step in ref/plans.md).
//   host_report / database_report / port_report → the _ro / main-pool values.
//   INSTANCE_CONNECTION_NAME_REPORT → _RO → the main instance (Unix socket).

const mysql = require("mysql2");

const rpUser = process.env.user_report;
const rpPass = process.env.password_report;

if (!rpUser || !rpPass) {
  console.warn(
    "[dbReport] user_report / password_report not set — reports+assistant are RUNNING ON THE BROAD dbReadonly POOL (fallback). Set the env vars to finish the least-privilege switch."
  );
  module.exports = require("./dbReadonly");
} else {
  const target = require("../lib/dbTarget").dbTarget({
    instance:
      process.env.INSTANCE_CONNECTION_NAME_REPORT ||
      process.env.INSTANCE_CONNECTION_NAME_RO ||
      process.env.INSTANCE_CONNECTION_NAME,
    host: process.env.host_report || process.env.host_ro || process.env.host,
    port: process.env.port_report || process.env.port_ro || process.env.port || 3306,
  });
  if (target.warning) console.error(`[dbReport] ${target.warning}`);

  const pool = mysql.createPool({
    ...target.config,
    user: rpUser,
    password: rpPass,
    database: process.env.database_report || process.env.database_ro || process.env.database,
    timezone: "Z",
    connectionLimit: 3,
    waitForConnections: true,
    queueLimit: 0,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    // maxIdle MUST be < connectionLimit or mysql2 never arms its idle
    // recycler — see the long note in startup/db.js.
    maxIdle: 2,
    idleTimeout: 30_000,
  });

  try {
    if (!pool._removeIdleTimeoutConnectionsTimer) {
      console.error("[dbReport] idle-connection sweeper NOT armed (maxIdle must be < connectionLimit).");
    }
  } catch (_) { /* mysql2 internals moved — the recycling test pins this */ }

  // Same lifecycle guards as dbReadonly: unref'd sweeper, logged pool errors.
  require("../lib/unrefPoolIdleSweeper").unrefPoolIdleSweeper(pool);
  pool.on("error", (err) => {
    console.error("MySQL report pool error:", err);
  });

  console.log(`[dbReport] reports+assistant pool on least-privilege account ${rpUser}`);
  module.exports = pool.promise();
}
