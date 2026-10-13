#!/usr/bin/env node
// scripts/ensure-sql-proxy.js
//
// LOCAL DEVELOPMENT ONLY. Makes sure a WORKING Cloud SQL Auth Proxy is on
// 127.0.0.1:3306 before something on this machine opens a database connection:
// starts one if there is none, and replaces one that has stopped connecting.
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
// "LISTENING" IS NOT "WORKING" — THE PART THAT BIT ON DAY ONE (2026-10-13)
//   The proxy opens its port before it has talked to Google. With credentials
//   that have expired, or an account without the Cloud SQL Client role, it
//   starts, says "ready for new connections", accepts each connection, fails to
//   reach the instance, and closes it without a byte. The MySQL client reports
//   that as PROTOCOL_CONNECTION_LOST, which says nothing about why.
//   And a RUNNING proxy keeps the credentials it started with: signing in again
//   (`gcloud auth application-default login`) does not fix it until it is
//   restarted. Verified against the real binary (v2.15.2) with a stale token.
//
//   So there is a second check, `greets`: the MySQL server speaks first, so one
//   byte arriving through the port proves the whole path — credentials, the
//   role, the instance name, the network. It costs a full connection, hence:
//     - a proxy started here is ALWAYS verified before it is reported started;
//       one that does not connect is stopped again and the reason is read out
//       of its log (`explain`);
//     - a proxy found already listening is trusted on the fast path (a commit
//       pays ~1 ms). Callers ask for `verify: true` when a connection through
//       it has just failed, or when nothing else would notice (`predev`). A
//       proxy started from here that no longer connects is then replaced, which
//       is what picks up fresh credentials.
//
// WHOSE CREDENTIALS: THE DEVELOPER'S, NEVER .env's SERVICE-ACCOUNT KEY
//   Google's auth library prefers GOOGLE_APPLICATION_CREDENTIALS over the
//   developer's application-default login, and a local .env may set it (a
//   service-account key for the app's own Google calls, e.g. storage). Callers
//   load .env before calling here, so the proxy would inherit it and connect
//   as that account, which typically lacks Cloud SQL Client: a 403 that names
//   no account, while signing in again changes nothing (bit 2026-10-13). The
//   proxy is started without that variable.
//
// WHY PORT 3306 AND NOTHING ELSE
//   startup/db.js and scripts/dump-schema.js pass `host` and no port, so they
//   always connect to 3306. A proxy on any other port would be one nothing
//   here talks to.
//
// THE PROXY OUTLIVES THE CALLER, ON PURPOSE
//   It is started detached and left running: the next commit or `npm run dev`
//   finds it already there. Stop it with `npm run db:proxy:stop`. Its output
//   goes to a log file in the temp dir.
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
// Written to the log before each start; `sinceStart` reads back from the last one.
const START_MARK = "--- ensure-sql-proxy:";

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

/**
 * Does a database answer through 127.0.0.1:port? The MySQL server sends its
 * greeting the moment a connection opens, so the first byte arriving proves the
 * tunnel works end to end. A proxy that cannot reach the instance closes the
 * connection without sending anything. Never rejects.
 */
function greets(port, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    let done = false;
    const finish = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(timeoutMs, () => finish(false));
    s.once("data", () => finish(true));
    s.once("end", () => finish(false));
    s.once("close", () => finish(false));
    s.once("error", () => finish(false));
  });
}

/** What the proxy printed since this script last started it (at most 64 KB back). */
function sinceStart(logFile) {
  let text = "";
  try {
    const { size } = fs.statSync(logFile);
    const len = Math.min(size, 65536);
    const fd = fs.openSync(logFile, "r");
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch (_) { return ""; }
  const at = text.lastIndexOf(START_MARK);
  if (at === -1) return text;
  const nl = text.indexOf("\n", at);
  return nl === -1 ? "" : text.slice(nl + 1);
}

const lastLines = (text, n) => text.trimEnd().split("\n").slice(-n).join("\n");

/**
 * Pure: turn what the proxy logged into what to do about it. Order matters —
 * a disabled-API answer is also a 403, so it is tested before the role.
 * @returns {string} one or two sentences, ending with the proxy's own line
 */
function explain(logText, instance) {
  const text = String(logText || "");
  const project = String(instance || "").split(":").slice(0, -2).join(":") || "<project>";
  const lines = text.split("\n").filter((l) => l.trim());
  const said = lines.filter((l) => /fail|error|denied|forbidden|invalid|not authorized/i.test(l)).pop() || lines.pop() || "";
  const quote = said ? `\n  proxy said: ${said.length > 420 ? `${said.slice(0, 420)}…` : said}` : "";

  if (/invalid_grant|invalid_rapt|reauth|could not find default credentials|token has been expired or revoked/i.test(text)) {
    return `Google credentials are missing or have expired. Run:  gcloud auth application-default login  — then run this again.${quote}`;
  }
  if (/has not been used in project|SERVICE_DISABLED|accessNotConfigured|quota project/i.test(text)) {
    return `Google refused the API call for lack of a quota project. Run:  gcloud auth application-default set-quota-project ${project}  — then run this again.${quote}`;
  }
  if (/NOT_AUTHORIZED|Error 403|forbidden|cloudsql\.instances\./i.test(text)) {
    return `The Google account you signed in with (gcloud auth application-default login) may not connect to Cloud SQL in ${project}. ` +
      `A project Owner grants it once:  gcloud projects add-iam-policy-binding ${project} --member=user:<that account> --role=roles/cloudsql.client${quote}`;
  }
  if (/Error 404|notFound|does not exist|instance not found/i.test(text)) {
    return `Google does not know the instance "${instance}". Check ${ENV_VAR} in .env.${quote}`;
  }
  if (/no such host|network is unreachable|i\/o timeout|connection refused|dial tcp|TLS handshake timeout|context deadline exceeded/i.test(text)) {
    return `The proxy could not reach Google or the instance from this network (offline, a VPN, or a firewall).${quote}`;
  }
  return said ? `Its log gives a reason this script does not recognise.${quote}` : "It logged nothing.";
}

/** The pid in the pid file, if that process is still a proxy; else null. */
function ownedPid(pidFile, bin) {
  let pid;
  try { pid = parseInt(fs.readFileSync(pidFile, "utf8"), 10); } catch (_) { return null; }
  if (!Number.isInteger(pid) || pid <= 1) return null;
  let args = "";
  try { args = cp.execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }).trim(); }
  catch (_) { return null; }   // ps exits 1: no such process
  return args.includes(path.basename(bin)) ? pid : null;
}

/**
 * Make sure the proxy is up. NEVER throws: callers decide what a failure means.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.verify=false]  also require that a database answers
 *   through a proxy that is ALREADY listening; one started from here that does
 *   not is replaced. (A proxy started by this call is verified regardless.)
 * @returns {Promise<{status: 'disabled'|'running'|'started'|'failed',
 *                    reason?: string|null, instance?: string, pid?: number,
 *                    logFile?: string, replaced?: boolean}>}
 *   disabled  not configured for this machine (reason null) or configured but
 *             not applicable (reason says why)
 *   running   already listening (and, with verify, answering); nothing started
 *   started   a proxy was started and a database answers through it;
 *             `replaced` is true when it took the place of a dead one
 *   failed    no working proxy; reason is printable as-is
 */
async function ensureSqlProxy(opts = {}) {
  const {
    env = process.env, port = PORT, bin = BIN,
    logFile = LOG_FILE, pidFile = PID_FILE,
    waitMs = 15000, greetMs = 10000, verify = false,
  } = opts;

  const d = decide(env);
  if (!d.enabled) return { status: "disabled", reason: d.reason };

  let replaced = false;
  if (await portOpen(port)) {
    if (!verify) return { status: "running", instance: d.instance, logFile };
    if (await greets(port, greetMs)) return { status: "running", instance: d.instance, logFile };

    const old = ownedPid(pidFile, bin);
    if (!old) {
      return {
        status: "failed", logFile,
        reason: `something is listening on 127.0.0.1:${port} but no database answers through it, and it was not started from here. ` +
          `If it is a proxy you started by hand: it keeps the credentials it started with, so stop it and run this again. ` +
          `If it is a local MySQL: stop it (the port is fixed).`,
      };
    }
    // Ours, and dead in the water. A restart is the only thing that makes it
    // read the current credentials.
    stopSqlProxy({ pidFile, bin });
    const gone = Date.now() + 5000;
    while (await portOpen(port, 300)) {
      if (Date.now() >= gone) {
        return { status: "failed", logFile, reason: `the proxy started from here (pid ${old}) is not connecting and did not stop when asked. Stop it by hand:  kill ${old}` };
      }
      await sleep(100);
    }
    replaced = true;
  }

  let fd;
  try { fd = fs.openSync(logFile, "a"); }
  catch (err) { return { status: "failed", reason: `cannot write the proxy log ${logFile}: ${err.message}` }; }

  let child; let spawnError = null; let exited = null;
  try {
    fs.writeSync(fd, `\n${START_MARK} ${new Date().toISOString()} starting ${bin} for ${d.instance} on port ${port}\n`);
    // The developer's login, not .env's service-account key: see the header.
    const { GOOGLE_APPLICATION_CREDENTIALS: _sa, ...childEnv } = process.env;
    child = cp.spawn(bin, [d.instance, "--port", String(port)], { detached: true, stdio: ["ignore", fd, fd], env: childEnv });
    child.on("error", (err) => { spawnError = err; });
    child.on("exit", (code, signal) => { exited = { code, signal }; });
  } catch (err) {
    spawnError = err;
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* the child holds its own copy */ }
  }

  const takeDown = () => {
    try { process.kill(-child.pid, "SIGTERM"); } catch (_) { try { child.kill("SIGTERM"); } catch (__) { /* gone */ } }
  };

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
      return {
        status: "failed", logFile,
        reason: `${bin} exited at once (${exited.signal || `code ${exited.code}`}). ${explain(sinceStart(logFile), d.instance)}`,
      };
    }
    if (await portOpen(port, 300)) break;
    if (Date.now() >= deadline) {
      takeDown();
      const out = lastLines(sinceStart(logFile), 6);
      return {
        status: "failed", logFile,
        reason: `${bin} did not start listening on port ${port} within ${Math.round(waitMs / 1000)} s.` +
          (out ? ` Its last lines:\n${out}` : ""),
      };
    }
    await sleep(150);
  }

  // Listening proves nothing (see the header). Prove the tunnel; if it does not
  // carry a connection, leave nothing behind: a dead proxy on the port would be
  // taken for a live one by the next fast-path caller.
  if (!(await greets(port, greetMs))) {
    await sleep(150);                       // let the proxy flush the reason to its log
    const why = `${bin} started and is listening, but no database answers through it. ${explain(sinceStart(logFile), d.instance)}`;
    takeDown();
    const closed = Date.now() + 3000;       // return only once the port is free again
    while (Date.now() < closed && (await portOpen(port, 300))) await sleep(100);
    return { status: "failed", logFile, reason: why };
  }

  try { fs.writeFileSync(pidFile, String(child.pid)); } catch (_) { /* stop will not find it; not fatal */ }
  child.removeAllListeners();
  child.unref();   // let the caller exit while the proxy keeps running
  return { status: "started", instance: d.instance, pid: child.pid, logFile, replaced };
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
  ensureSqlProxy, stopSqlProxy, decide, portOpen, greets, explain, sinceStart,
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

  // verify: this is `predev` — nothing after it would explain a dead proxy; the
  // app would just log "Connection lost" on every query.
  ensureSqlProxy({ verify: true }).then((r) => {
    if (r.status === "started") say(`${r.replaced ? "restarted (the old one had stopped connecting)" : "started"} for ${r.instance} on 127.0.0.1:${PORT} — database answering (pid ${r.pid}, log ${r.logFile}). Stop: npm run db:proxy:stop`);
    else if (r.status === "running") say(`already running on 127.0.0.1:${PORT}, database answering`);
    else if (r.status === "disabled" && r.reason) say(r.reason);
    else if (r.status === "failed") { console.error(`[sql-proxy] NOT WORKING: ${r.reason}`); process.exit(1); }
    // disabled with no reason: this machine does not use the proxy. Say nothing.
    process.exit(0);
  });
}
