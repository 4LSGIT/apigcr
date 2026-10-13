#!/usr/bin/env node
// scripts/ensure-sql-proxy.js
//
// LOCAL DEVELOPMENT ONLY. Makes sure a Cloud SQL Auth Proxy is listening on
// 127.0.0.1:3306 before something on this machine opens a database connection,
// and starts one if it is not.
//
// WHY
//   Production reaches the database over Cloud Run's /cloudsql socket. A laptop
//   has no such socket: it goes through the Cloud SQL Auth Proxy, a local
//   process that listens on a TCP port and tunnels to the instance with the
//   developer's Google credentials (no IP allowlist, no database port open to
//   the internet). Forgetting to start it used to mean a commit whose schema
//   check silently skipped, or `npm run dev` failing with ECONNREFUSED.
//
// WHO CALLS IT
//   - `npm run dev`            via the `predev` script in package.json
//   - `npm run db:ref[:check]` and the pre-commit hook, via scripts/dump-schema.js
//   - `npm run db:proxy` / `npm run db:proxy:stop` by hand
//
// OPT-IN, AND INERT EVERYWHERE ELSE
//   It does something only when ALL of these hold; otherwise it returns
//   `disabled` and touches nothing:
//     DEV_SQL_PROXY_INSTANCE = PROJECT:REGION:INSTANCE   in .env (never in git)
//     host                   = 127.0.0.1 (or localhost)  in .env
//     INSTANCE_CONNECTION_NAME unset   (that one means "use the socket")
//     not running on Cloud Run (K_SERVICE unset)
//   So a machine without the variable, CI, and production are unaffected.
//
// WHY PORT 3306 AND NOTHING ELSE
//   startup/db.js and scripts/dump-schema.js pass `host` and no port, so they
//   always connect to 3306. A proxy on any other port would be one nothing
//   here talks to.
//
// THE PROXY OUTLIVES THE CALLER, ON PURPOSE
//   It is started detached and left running: the next commit or `npm run dev`
//   finds it already there (a ~1 ms port check). Stop it with
//   `npm run db:proxy:stop`. Its output goes to a log file in the temp dir.
//
// One-time setup for a new machine: ref/INFRA_GCP.md §10.

"use strict";

const cp   = require("child_process");
const fs   = require("fs");
const net  = require("net");
const os   = require("os");
const path = require("path");

const ENV_VAR  = "DEV_SQL_PROXY_INSTANCE";
const PORT     = 3306;
const BIN      = "cloud-sql-proxy";
const LOG_FILE = path.join(os.tmpdir(), "yc-sql-proxy.log");
const PID_FILE = path.join(os.tmpdir(), "yc-sql-proxy.pid");

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
// Same shape lib/dbTarget.js accepts: PROJECT:REGION:INSTANCE (or the legacy
// four-part domain-scoped form).
const INSTANCE_RE = /^[^:\s]+(:[^:\s]+){2,3}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pure: should a proxy be managed here, given this environment?
 * @returns {{enabled: boolean, instance?: string, reason: string|null}}
 *   reason is null when the feature is simply not configured (stay silent),
 *   and a sentence when it IS configured but cannot apply (say so).
 */
function decide(env = process.env) {
  const instance = String(env[ENV_VAR] == null ? "" : env[ENV_VAR]).trim();
  if (!instance) return { enabled: false, reason: null };
  if (env.K_SERVICE) {
    return { enabled: false, reason: `${ENV_VAR} is set on Cloud Run and is ignored there` };
  }
  if (String(env.INSTANCE_CONNECTION_NAME == null ? "" : env.INSTANCE_CONNECTION_NAME).trim()) {
    return { enabled: false, reason: `INSTANCE_CONNECTION_NAME is set, so connections use the /cloudsql socket, not a local proxy. Remove it from .env for local development` };
  }
  const host = String(env.host == null ? "" : env.host).trim().toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    return { enabled: false, reason: `${ENV_VAR} is set but host is "${env.host}", not 127.0.0.1: not starting a proxy nothing would connect to` };
  }
  if (!INSTANCE_RE.test(instance)) {
    return { enabled: false, reason: `${ENV_VAR}="${instance}" does not look like PROJECT:REGION:INSTANCE` };
  }
  return { enabled: true, instance, reason: null };
}

/** Does something accept TCP connections on 127.0.0.1:port? Never rejects. */
function portOpen(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    let done = false;
    const finish = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(timeoutMs, () => finish(false));
    s.once("connect", () => finish(true));
    s.once("error", () => finish(false));
  });
}

function tail(file, lines = 6) {
  try {
    return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch (_) { return ""; }
}

/**
 * Make sure the proxy is up. NEVER throws: callers decide what a failure means.
 *
 * @returns {Promise<{status: 'disabled'|'running'|'started'|'failed',
 *                    reason?: string|null, instance?: string, pid?: number, logFile?: string}>}
 *   disabled  not configured for this machine (reason null) or configured but
 *             not applicable (reason says why)
 *   running   something already listens on the port; nothing was started
 *   started   a proxy was started and is accepting connections
 *   failed    it could not be started; reason is printable as-is
 */
async function ensureSqlProxy(opts = {}) {
  const {
    env = process.env, port = PORT, bin = BIN,
    logFile = LOG_FILE, pidFile = PID_FILE, waitMs = 15000,
  } = opts;

  const d = decide(env);
  if (!d.enabled) return { status: "disabled", reason: d.reason };
  if (await portOpen(port)) return { status: "running", instance: d.instance, logFile };

  let fd;
  try { fd = fs.openSync(logFile, "a"); }
  catch (err) { return { status: "failed", reason: `cannot write the proxy log ${logFile}: ${err.message}` }; }

  let child; let spawnError = null; let exited = null;
  try {
    fs.writeSync(fd, `\n--- ${new Date().toISOString()} starting ${bin} for ${d.instance} on port ${port}\n`);
    child = cp.spawn(bin, [d.instance, "--port", String(port)], { detached: true, stdio: ["ignore", fd, fd] });
    child.on("error", (err) => { spawnError = err; });
    child.on("exit", (code, signal) => { exited = { code, signal }; });
  } catch (err) {
    spawnError = err;
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* the child holds its own copy */ }
  }

  const deadline = Date.now() + waitMs;
  for (;;) {
    if (spawnError) {
      const missing = spawnError.code === "ENOENT";
      return {
        status: "failed",
        reason: missing
          ? `"${bin}" is not installed (macOS: brew install cloud-sql-proxy). Setup: ref/INFRA_GCP.md §10`
          : `could not start ${bin}: ${spawnError.message}`,
      };
    }
    if (exited) {
      const out = tail(logFile);
      return {
        status: "failed", logFile,
        reason: `${bin} exited at once (${exited.signal || `code ${exited.code}`}).` +
          (out ? ` Its last lines:\n${out}\n` : " ") +
          `If that is about credentials: gcloud auth application-default login`,
      };
    }
    if (await portOpen(port, 300)) break;
    if (Date.now() >= deadline) {
      try { process.kill(-child.pid, "SIGTERM"); } catch (_) { try { child.kill("SIGTERM"); } catch (__) { /* gone */ } }
      const out = tail(logFile);
      return {
        status: "failed", logFile,
        reason: `${bin} did not start listening on port ${port} within ${Math.round(waitMs / 1000)} s.` +
          (out ? ` Its last lines:\n${out}` : ""),
      };
    }
    await sleep(150);
  }

  try { fs.writeFileSync(pidFile, String(child.pid)); } catch (_) { /* stop will not find it; not fatal */ }
  child.removeAllListeners();
  child.unref();   // let the caller exit while the proxy keeps running
  return { status: "started", instance: d.instance, pid: child.pid, logFile };
}

/**
 * Stop the proxy this script started. Only signals a pid that still looks like
 * a proxy: a pid file can outlive its process and the number can be reused.
 * @returns {{status: 'stopped'|'not_running'|'not_ours', pid?: number}}
 */
function stopSqlProxy(opts = {}) {
  const { pidFile = PID_FILE, bin = BIN } = opts;
  let pid;
  try { pid = parseInt(fs.readFileSync(pidFile, "utf8"), 10); } catch (_) { return { status: "not_running" }; }
  const forget = () => { try { fs.unlinkSync(pidFile); } catch (_) { /* already gone */ } };
  if (!Number.isInteger(pid) || pid <= 1) { forget(); return { status: "not_running" }; }
  let args = "";
  try { args = cp.execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }).trim(); }
  catch (_) { forget(); return { status: "not_running" }; }   // ps exits 1: no such process
  if (!args.includes(path.basename(bin))) { forget(); return { status: "not_ours", pid }; }
  try { process.kill(pid, "SIGTERM"); } catch (_) { forget(); return { status: "not_running" }; }
  forget();
  return { status: "stopped", pid };
}

module.exports = {
  ensureSqlProxy, stopSqlProxy, decide, portOpen,
  ENV_VAR, PORT, BIN, LOG_FILE, PID_FILE,
};

// ── command line: `node scripts/ensure-sql-proxy.js [--stop]` ───────────────
if (require.main === module) {
  // Explicit path, like scripts/dump-schema.js: works from any directory.
  require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
  const say = (msg) => console.log(`[sql-proxy] ${msg}`);

  if (process.argv.includes("--stop")) {
    const r = stopSqlProxy();
    say(r.status === "stopped" ? `stopped (pid ${r.pid})`
      : r.status === "not_ours" ? `pid ${r.pid} is not a proxy any more; left alone`
      : "none was started from here");
    process.exit(0);
  }

  ensureSqlProxy().then((r) => {
    if (r.status === "started") say(`started for ${r.instance} on 127.0.0.1:${PORT} (pid ${r.pid}, log ${r.logFile}). Stop: npm run db:proxy:stop`);
    else if (r.status === "running") say(`already listening on 127.0.0.1:${PORT}`);
    else if (r.status === "disabled" && r.reason) say(r.reason);
    else if (r.status === "failed") { console.error(`[sql-proxy] NOT RUNNING: ${r.reason}`); process.exit(1); }
    // disabled with no reason: this machine does not use the proxy. Say nothing.
    process.exit(0);
  });
}
