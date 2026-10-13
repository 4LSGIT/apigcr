// tests/ensureSqlProxy.test.js
//
// scripts/ensure-sql-proxy.js — the local-development helper that starts the
// Cloud SQL Auth Proxy when .env opts in. Nothing is mocked: a stand-in
// "cloud-sql-proxy" executable (a few lines of node, written to a temp dir) is
// really spawned, really listens (or exits, or stays deaf, or listens and
// drops every connection the way the real proxy does with expired credentials),
// and is really signalled. Ports are picked free at run time, never 3306.
//
// The stand-in's failure output is copied from the real binary (v2.15.2, run
// with a stale token and with no credentials, 2026-10-13) — see REAL below.
//
// The stand-in takes its orders from a control file next to it, not from
// environment variables: jest gives each test file its own copy of
// process.env, and a child spawned by the module under test inherits the REAL
// one — a variable set here would never reach it.

"use strict";

const cp   = require("child_process");
const fs   = require("fs");
const net  = require("net");
const os   = require("os");
const path = require("path");

const {
  ensureSqlProxy, stopSqlProxy, decide, portOpen, greets, explain, sinceStart, ENV_VAR, PORT,
} = require("../scripts/ensure-sql-proxy");

jest.setTimeout(30000);

const INSTANCE = "some-project:us-east1:some-instance";
const LOCAL_ENV = { [ENV_VAR]: INSTANCE, host: "127.0.0.1" };

// What the real proxy logs. STALE and NO_ADC are verbatim captures; the others
// are the documented shapes of the same line.
const REAL = {
  STALE: '2026/10/13 11:11:32 [some-project:us-east1:some-instance] failed to connect to instance: failed to get instance: Refresh error: failed to get instance metadata (connection name = "some-project:us-east1:some-instance"): Get "https://sqladmin.googleapis.com/sql/v1beta4/projects/some-project/instances/some-instance/connectSettings?alt=json&prettyPrint=false": auth: "invalid_grant" "Bad Request"',
  NO_ADC: "2026/10/13 11:11:27 The proxy has encountered a terminal error: unable to start: error initializing dialer: failed to create default credentials: credentials: could not find default credentials. See https://cloud.google.com/docs/authentication/external/set-up-adc for more information",
  NO_ROLE: '2026/10/13 11:20:01 [some-project:us-east1:some-instance] failed to connect to instance: failed to get instance: Refresh error: failed to get instance metadata (connection name = "some-project:us-east1:some-instance"): googleapi: Error 403: boss::NOT_AUTHORIZED: Not authorized to access resource. Possibly missing permission cloudsql.instances.get on resource instances/some-instance., forbidden',
  NO_QUOTA: "2026/10/13 11:20:01 [some-project:us-east1:some-instance] failed to connect to instance: failed to get instance: Refresh error: failed to get instance metadata: googleapi: Error 403: Cloud SQL Admin API has not been used in project 764086051850 before or it is disabled. Details: reason: SERVICE_DISABLED, forbidden",
  NO_INSTANCE: "2026/10/13 11:20:01 [some-project:us-east1:nope] failed to connect to instance: failed to get instance: Refresh error: failed to get instance metadata: googleapi: Error 404: The Cloud SQL instance does not exist., instanceDoesNotExist",
  OFFLINE: '2026/10/13 11:20:01 [some-project:us-east1:some-instance] failed to connect to instance: Dial error: failed to dial (connection name = "some-project:us-east1:some-instance"): dial tcp 203.0.113.7:3307: i/o timeout',
  READY: "2026/10/13 11:11:28 The proxy has started successfully and is ready for new connections!",
};

let dir; let fakeBin; let seq = 0;
const started = [];   // pids to reap

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitGone(pid, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!alive(pid)) return true; await sleep(50); }
  return !alive(pid);
}
function files() {
  seq += 1;
  return {
    logFile: path.join(dir, `proxy-${seq}.log`),
    pidFile: path.join(dir, `proxy-${seq}.pid`),
    selfPid: path.join(dir, `self-${seq}.pid`),
    argsFile: path.join(dir, `args-${seq}.json`),
  };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "yc-proxy-test-"));
  fakeBin = path.join(dir, "cloud-sql-proxy");
  // control.json, read once when the stand-in starts:
  //   mode      listen (default): a database answers through it
  //             mute:   listens, accepts, logs logLine, closes without a byte —
  //                     the real proxy with credentials it cannot use
  //             exit:   prints the no-credentials error and exits 1
  //             deaf:   never listens
  //   muteFlag  a path; from the moment that file exists a listening stand-in
  //             behaves as mute (credentials expiring under a running proxy)
  //   logLine   what mute logs (default: the real stale-token line)
  //   slowExit  ms to keep the port open after SIGTERM (a proxy that takes a
  //             moment to shut down)
  //   argsFile, selfPid   where to record argv / the pid
  fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require("fs"); const net = require("net"); const path = require("path");
const args = process.argv.slice(2);
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(path.join(__dirname, "control.json"), "utf8")); } catch (_) {}
if (ctl.argsFile) fs.writeFileSync(ctl.argsFile, JSON.stringify(args));
if (ctl.selfPid) fs.writeFileSync(ctl.selfPid, String(process.pid));
const mode = ctl.mode || "listen";
if (ctl.slowExit) process.on("SIGTERM", () => setTimeout(() => process.exit(0), ctl.slowExit));
if (mode === "exit") { console.error(${JSON.stringify(REAL.NO_ADC)}); process.exit(1); }
if (mode === "deaf") { console.log("authorizing..."); setInterval(() => {}, 1000); }
else {
  const port = Number(args[args.indexOf("--port") + 1]);
  net.createServer((s) => {
    s.on("error", () => {});
    if (mode === "mute" || (ctl.muteFlag && fs.existsSync(ctl.muteFlag))) {
      console.log(ctl.logLine || ${JSON.stringify(REAL.STALE)});
      s.end();
    } else {
      s.write(Buffer.from([0x4a, 0, 0, 0, 0x0a, 0x38, 0x2e, 0x34]));   // the server speaks first
    }
  }).listen(port, "127.0.0.1", () => console.log("Listening on 127.0.0.1:" + port + "\\n" + ${JSON.stringify(REAL.READY)}));
}
`);
  fs.chmodSync(fakeBin, 0o755);
});

const control = (o) => fs.writeFileSync(path.join(dir, "control.json"), JSON.stringify(o));

afterEach(() => {
  fs.rmSync(path.join(dir, "control.json"), { force: true });
  while (started.length) { const pid = started.pop(); try { process.kill(pid, "SIGKILL"); } catch (_) { /* already gone */ } }
});

afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("decide — when a proxy is managed at all", () => {
  test("not configured: disabled, and silent (reason null)", () => {
    expect(decide({ host: "127.0.0.1" })).toEqual({ enabled: false, reason: null });
    expect(decide({ [ENV_VAR]: "   ", host: "127.0.0.1" })).toEqual({ enabled: false, reason: null });
  });

  test("configured and local: enabled with the instance", () => {
    expect(decide(LOCAL_ENV)).toEqual({ enabled: true, instance: INSTANCE, reason: null });
    expect(decide({ [ENV_VAR]: ` ${INSTANCE} `, host: "LocalHost" }).enabled).toBe(true);
  });

  test("never on Cloud Run, even if the variable leaked into a revision", () => {
    const d = decide({ ...LOCAL_ENV, K_SERVICE: "svc" });
    expect(d.enabled).toBe(false);
    expect(d.reason).toMatch(/Cloud Run/);
  });

  test("not when the app is in socket mode (INSTANCE_CONNECTION_NAME set)", () => {
    const d = decide({ ...LOCAL_ENV, INSTANCE_CONNECTION_NAME: INSTANCE });
    expect(d.enabled).toBe(false);
    expect(d.reason).toMatch(/INSTANCE_CONNECTION_NAME/);
  });

  test("not when host points somewhere else: a proxy nothing would use", () => {
    const d = decide({ [ENV_VAR]: INSTANCE, host: "db.example.com" });
    expect(d.enabled).toBe(false);
    expect(d.reason).toMatch(/db\.example\.com/);
    expect(decide({ [ENV_VAR]: INSTANCE }).enabled).toBe(false);   // host unset
  });

  test("a value that is not PROJECT:REGION:INSTANCE is refused, not passed to the binary", () => {
    for (const bad of ["just-a-name", "two:parts", "a:b:c:d:e", "has space:us:x"]) {
      const d = decide({ [ENV_VAR]: bad, host: "127.0.0.1" });
      expect(d.enabled).toBe(false);
      expect(d.reason).toMatch(/PROJECT:REGION:INSTANCE/);
    }
  });

  test("the port is 3306: the one startup/db.js and dump-schema.js connect to", () => {
    expect(PORT).toBe(3306);
  });
});

describe("ensureSqlProxy — against a real child process", () => {
  test("disabled: nothing is spawned, no file is written", async () => {
    const f = files(); const port = await freePort();
    control({ selfPid: f.selfPid });
    const r = await ensureSqlProxy({ env: { host: "127.0.0.1" }, port, bin: fakeBin, logFile: f.logFile, pidFile: f.pidFile });
    expect(r).toEqual({ status: "disabled", reason: null });
    await sleep(300);
    expect(fs.existsSync(f.selfPid)).toBe(false);
    expect(fs.existsSync(f.logFile)).toBe(false);
    expect(await portOpen(port, 300)).toBe(false);
  });

  test("already listening: reported as running, nothing is spawned", async () => {
    const f = files(); const port = await freePort();
    const srv = net.createServer((s) => s.end());
    await new Promise((res) => srv.listen(port, "127.0.0.1", res));
    control({ selfPid: f.selfPid });
    try {
      const r = await ensureSqlProxy({ env: LOCAL_ENV, port, bin: fakeBin, logFile: f.logFile, pidFile: f.pidFile });
      expect(r.status).toBe("running");
      expect(r.instance).toBe(INSTANCE);
      await sleep(300);
      expect(fs.existsSync(f.selfPid)).toBe(false);
      expect(fs.existsSync(f.pidFile)).toBe(false);
    } finally { await new Promise((res) => srv.close(res)); }
  });

  test("not listening: starts the proxy with the instance and the port, waits until it accepts connections", async () => {
    const f = files(); const port = await freePort();
    control({ argsFile: f.argsFile });
    const r = await ensureSqlProxy({ env: LOCAL_ENV, port, bin: fakeBin, logFile: f.logFile, pidFile: f.pidFile });
    if (r.pid) started.push(r.pid);
    expect(r.status).toBe("started");
    expect(r.instance).toBe(INSTANCE);
    expect(await portOpen(port, 500)).toBe(true);                     // usable the moment it returns
    expect(JSON.parse(fs.readFileSync(f.argsFile, "utf8"))).toEqual([INSTANCE, "--port", String(port)]);
    expect(fs.readFileSync(f.pidFile, "utf8")).toBe(String(r.pid));
    expect(alive(r.pid)).toBe(true);
    expect(fs.readFileSync(f.logFile, "utf8")).toMatch(/Listening on/); // its output lands in the log
    // a second call finds it and starts nothing new
    const again = await ensureSqlProxy({ env: LOCAL_ENV, port, bin: fakeBin, logFile: f.logFile, pidFile: f.pidFile });
    expect(again.status).toBe("running");
  });

  test("the started proxy outlives the process that started it", async () => {
    const f = files(); const port = await freePort();
    const script = `
      const { ensureSqlProxy } = require(${JSON.stringify(path.join(__dirname, "..", "scripts", "ensure-sql-proxy.js"))});
      ensureSqlProxy({ env: ${JSON.stringify(LOCAL_ENV)}, port: ${port}, bin: ${JSON.stringify(fakeBin)},
        logFile: ${JSON.stringify(f.logFile)}, pidFile: ${JSON.stringify(f.pidFile)} })
        .then((r) => { console.log(JSON.stringify(r)); });`;
    // No process.exit in the script: the caller must be able to end on its own
    // while the proxy keeps running (child.unref + detached + no shared pipes).
    const out = cp.execFileSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20000 });
    const r = JSON.parse(out.trim().split("\n").pop());
    started.push(r.pid);
    expect(r.status).toBe("started");
    expect(alive(r.pid)).toBe(true);
    expect(await portOpen(port, 500)).toBe(true);
  });

  test("Ctrl-C in the terminal that ran the commit does not take the proxy down with it", async () => {
    // Ctrl-C (and a closed terminal) signal the launcher's whole process GROUP.
    // The proxy is started detached, in a group of its own, so it is not in it.
    const f = files(); const port = await freePort();
    const script = `
      const { ensureSqlProxy } = require(${JSON.stringify(path.join(__dirname, "..", "scripts", "ensure-sql-proxy.js"))});
      ensureSqlProxy({ env: ${JSON.stringify(LOCAL_ENV)}, port: ${port}, bin: ${JSON.stringify(fakeBin)},
        logFile: ${JSON.stringify(f.logFile)}, pidFile: ${JSON.stringify(f.pidFile)} })
        .then((r) => { console.log(JSON.stringify(r)); setInterval(() => {}, 1000); });`;
    const launcher = cp.spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    started.push(launcher.pid);
    let timer;
    const r = await new Promise((resolve, reject) => {
      let buf = "";
      launcher.stdout.on("data", (d) => { buf += d; if (buf.includes("\n")) resolve(JSON.parse(buf.trim())); });
      launcher.once("exit", () => reject(new Error("launcher exited early")));
      timer = setTimeout(() => reject(new Error("launcher gave no result")), 15000);
    }).finally(() => { clearTimeout(timer); launcher.stdout.destroy(); });
    started.push(r.pid);
    expect(r.status).toBe("started");
    process.kill(-launcher.pid, "SIGINT");                 // the whole group, as a terminal does
    expect(await waitGone(launcher.pid)).toBe(true);
    await sleep(300);
    expect(alive(r.pid)).toBe(true);
    expect(await portOpen(port, 500)).toBe(true);
  });

  test("binary not installed: failed, with the install hint, and no throw", async () => {
    const f = files(); const port = await freePort();
    const r = await ensureSqlProxy({ env: LOCAL_ENV, port, bin: path.join(dir, "no-such-binary"), logFile: f.logFile, pidFile: f.pidFile });
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/not installed/);
    expect(r.reason).toMatch(/brew install cloud-sql-proxy/);
    expect(fs.existsSync(f.pidFile)).toBe(false);
  });

  test("proxy exits at once (no credentials): failed, quoting what it printed and how to sign in", async () => {
    const f = files(); const port = await freePort();
    control({ mode: "exit" });
    const r = await ensureSqlProxy({ env: LOCAL_ENV, port, bin: fakeBin, logFile: f.logFile, pidFile: f.pidFile });
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/exited at once \(code 1\)/);
    expect(r.reason).toMatch(/could not find default credentials/);
    expect(r.reason).toMatch(/gcloud auth application-default login/);
    expect(fs.existsSync(f.pidFile)).toBe(false);
  });

  // ── listening is not working (2026-10-13, the first real run) ────────────
  // The real proxy opens its port before it has talked to Google. With a stale
  // token it starts, accepts, and drops every connection without a byte.

  test("starts but cannot reach the database (stale credentials): failed with the fix, and nothing is left on the port", async () => {
    const f = files(); const port = await freePort();
    control({ mode: "mute", selfPid: f.selfPid, slowExit: 500 });
    const r = await ensureSqlProxy({ env: LOCAL_ENV, port, bin: fakeBin, logFile: f.logFile, pidFile: f.pidFile });
    // Checked the instant it returns: the next caller's fast path only looks at the port.
    expect(await portOpen(port, 300)).toBe(false);
    const pid = Number(fs.readFileSync(f.selfPid, "utf8"));
    started.push(pid);
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/is listening, but no database answers through it/);
    expect(r.reason).toMatch(/credentials are missing or have expired/);
    expect(r.reason).toMatch(/gcloud auth application-default login/);
    expect(r.reason).toMatch(/proxy said: .*invalid_grant/);            // the proxy's own line, not ours
    expect(r.logFile).toBe(f.logFile);
    // A dead proxy left listening would be taken for a live one next time.
    expect(await waitGone(pid)).toBe(true);
    expect(await portOpen(port, 300)).toBe(false);
    expect(fs.existsSync(f.pidFile)).toBe(false);
  });

  test("the reason comes from THIS start, not from an older failure in the same log", async () => {
    const f = files(); const port = await freePort();
    fs.writeFileSync(f.logFile, `${REAL.STALE}\n`);                     // yesterday's problem
    control({ mode: "mute", logLine: REAL.NO_ROLE, selfPid: f.selfPid });
    const r = await ensureSqlProxy({ env: LOCAL_ENV, port, bin: fakeBin, logFile: f.logFile, pidFile: f.pidFile });
    started.push(Number(fs.readFileSync(f.selfPid, "utf8")));
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/roles\/cloudsql\.client/);
    expect(r.reason).not.toMatch(/application-default login {2}—/);
    expect(fs.readFileSync(f.logFile, "utf8")).toMatch(/invalid_grant/); // the old line is still in the file
  });

  test("credentials expire under a running proxy: the fast path still says running; verify replaces it", async () => {
    const f = files(); const port = await freePort();
    const flag = path.join(dir, `expired-${seq}`);
    control({ muteFlag: flag, slowExit: 500 });   // slow to let go of the port: the replacement must wait for it
    const first = await ensureSqlProxy({ env: LOCAL_ENV, port, bin: fakeBin, logFile: f.logFile, pidFile: f.pidFile });
    started.push(first.pid);
    expect(first.status).toBe("started");
    expect(first.replaced).toBe(false);

    fs.writeFileSync(flag, "");                                         // the token expires
    expect(await greets(port, 2000)).toBe(false);
    // Fast path (what a commit pays for): the port is open, so it is trusted.
    const fast = await ensureSqlProxy({ env: LOCAL_ENV, port, bin: fakeBin, logFile: f.logFile, pidFile: f.pidFile });
    expect(fast.status).toBe("running");
    expect(alive(first.pid)).toBe(true);

    // The developer signs in again; only a NEW process reads the new credentials.
    control({});
    const r = await ensureSqlProxy({ env: LOCAL_ENV, port, bin: fakeBin, logFile: f.logFile, pidFile: f.pidFile, verify: true });
    if (r.pid) started.push(r.pid);
    expect(r.status).toBe("started");
    expect(r.replaced).toBe(true);
    expect(r.pid).not.toBe(first.pid);
    expect(await waitGone(first.pid)).toBe(true);
    expect(await greets(port, 2000)).toBe(true);
    expect(fs.readFileSync(f.pidFile, "utf8")).toBe(String(r.pid));
  });

  test("verify, and signing in again did not help: failed with the reason, the dead proxy is gone", async () => {
    const f = files(); const port = await freePort();
    const flag = path.join(dir, `expired-${seq}`);
    control({ muteFlag: flag });
    const first = await ensureSqlProxy({ env: LOCAL_ENV, port, bin: fakeBin, logFile: f.logFile, pidFile: f.pidFile });
    started.push(first.pid);
    fs.writeFileSync(flag, "");
    control({ mode: "mute", logLine: REAL.NO_ROLE, selfPid: f.selfPid });  // the replacement fails too, differently
    const r = await ensureSqlProxy({ env: LOCAL_ENV, port, bin: fakeBin, logFile: f.logFile, pidFile: f.pidFile, verify: true });
    const second = Number(fs.readFileSync(f.selfPid, "utf8"));
    started.push(second);
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/add-iam-policy-binding some-project .*--role=roles\/cloudsql\.client/);
    expect(await waitGone(first.pid)).toBe(true);
    expect(await waitGone(second)).toBe(true);
    expect(await portOpen(port, 300)).toBe(false);
    expect(fs.existsSync(f.pidFile)).toBe(false);
  });

  test("verify, already listening and answering: running, nothing is spawned or stopped", async () => {
    const f = files(); const port = await freePort();
    const srv = net.createServer((s) => { s.on("error", () => {}); s.write("hello"); });
    await new Promise((res) => srv.listen(port, "127.0.0.1", res));
    control({ selfPid: f.selfPid });
    try {
      const r = await ensureSqlProxy({ env: LOCAL_ENV, port, bin: fakeBin, logFile: f.logFile, pidFile: f.pidFile, verify: true });
      expect(r.status).toBe("running");
      await sleep(300);
      expect(fs.existsSync(f.selfPid)).toBe(false);
    } finally { srv.closeAllConnections?.(); await new Promise((res) => srv.close(res)); }
  });

  test("verify, a listener that is NOT ours and does not answer: failed, and it is left alone", async () => {
    const f = files(); const port = await freePort();
    const srv = net.createServer((s) => s.end());                       // a hand-started proxy with stale credentials
    await new Promise((res) => srv.listen(port, "127.0.0.1", res));
    control({ selfPid: f.selfPid });
    try {
      const r = await ensureSqlProxy({ env: LOCAL_ENV, port, bin: fakeBin, logFile: f.logFile, pidFile: f.pidFile, verify: true });
      expect(r.status).toBe("failed");
      expect(r.reason).toMatch(/not started from here/);
      expect(r.reason).toMatch(/keeps the credentials it started with/);
      await sleep(300);
      expect(fs.existsSync(f.selfPid)).toBe(false);                     // nothing was started on top of it
      expect(await portOpen(port, 300)).toBe(true);                     // and it was not touched
    } finally { await new Promise((res) => srv.close(res)); }
  });

  test("verify, a pid file naming some OTHER process: that process is never signalled", async () => {
    const f = files(); const port = await freePort();
    const srv = net.createServer((s) => s.end());
    await new Promise((res) => srv.listen(port, "127.0.0.1", res));
    const other = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    started.push(other.pid);
    fs.writeFileSync(f.pidFile, String(other.pid));                     // a reused pid
    try {
      const r = await ensureSqlProxy({ env: LOCAL_ENV, port, bin: fakeBin, logFile: f.logFile, pidFile: f.pidFile, verify: true });
      expect(r.status).toBe("failed");
      expect(r.reason).toMatch(/not started from here/);
      await sleep(200);
      expect(alive(other.pid)).toBe(true);
    } finally { await new Promise((res) => srv.close(res)); }
  });

  test("proxy never listens: failed after the wait, and the stray process is taken down", async () => {
    const f = files(); const port = await freePort();
    control({ mode: "deaf", selfPid: f.selfPid });
    const t0 = Date.now();
    const r = await ensureSqlProxy({ env: LOCAL_ENV, port, bin: fakeBin, logFile: f.logFile, pidFile: f.pidFile, waitMs: 1200 });
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/did not start listening on port/);
    expect(r.reason).toMatch(/authorizing/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1200);
    const pid = Number(fs.readFileSync(f.selfPid, "utf8"));
    started.push(pid);
    expect(await waitGone(pid)).toBe(true);
    expect(fs.existsSync(f.pidFile)).toBe(false);
  });
});

describe("greets — does a database answer through the port?", () => {
  const serve = async (handler) => {
    const port = await freePort();
    const srv = net.createServer(handler);
    await new Promise((res) => srv.listen(port, "127.0.0.1", res));
    return { port, close: () => { srv.closeAllConnections?.(); return new Promise((res) => srv.close(res)); } };
  };

  test("true on the first byte from the server", async () => {
    const s = await serve((c) => { c.on("error", () => {}); c.write("x"); });
    try { expect(await greets(s.port, 2000)).toBe(true); } finally { await s.close(); }
  });

  test("false when the connection is accepted and closed without a byte (the dead-proxy signature)", async () => {
    const s = await serve((c) => c.end());
    try { expect(await greets(s.port, 2000)).toBe(false); } finally { await s.close(); }
  });

  test("false when nothing listens, and false (not a hang) when the listener stays silent", async () => {
    expect(await greets(await freePort(), 500)).toBe(false);
    const s = await serve((c) => { c.on("error", () => {}); });
    try {
      const t0 = Date.now();
      expect(await greets(s.port, 400)).toBe(false);
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally { await s.close(); }
  });
});

describe("explain — the proxy's log line, turned into what to do", () => {
  test("stale or missing credentials: sign in again", () => {
    for (const line of [REAL.STALE, REAL.NO_ADC]) {
      const out = explain(`${REAL.READY}\n${line}\n`, INSTANCE);
      expect(out).toMatch(/gcloud auth application-default login/);
      expect(out).not.toMatch(/add-iam-policy-binding|set-quota-project/);
    }
  });

  test("no Cloud SQL Client role: the grant command, with the project taken from the instance name", () => {
    const out = explain(`${REAL.READY}\n${REAL.NO_ROLE}\n`, "my-proj:us-east1:db1");
    expect(out).toMatch(/gcloud projects add-iam-policy-binding my-proj --member=user:<that account> --role=roles\/cloudsql\.client/);
    expect(out).toMatch(/proxy said: .*NOT_AUTHORIZED/);
    expect(out).not.toMatch(/application-default login {2}—/);
    // legacy domain-scoped project ids have a colon of their own
    expect(explain(REAL.NO_ROLE, "example.com:proj:us-east1:db1")).toMatch(/add-iam-policy-binding example\.com:proj --member/);
  });

  test("API refused for lack of a quota project is also a 403, and is NOT reported as a missing role", () => {
    const out = explain(REAL.NO_QUOTA, "my-proj:us-east1:db1");
    expect(out).toMatch(/gcloud auth application-default set-quota-project my-proj/);
    expect(out).not.toMatch(/add-iam-policy-binding/);
  });

  test("unknown instance, and no route to Google", () => {
    expect(explain(REAL.NO_INSTANCE, "my-proj:us-east1:nope")).toMatch(new RegExp(`"my-proj:us-east1:nope".*${ENV_VAR}`));
    expect(explain(REAL.OFFLINE, INSTANCE)).toMatch(/could not reach Google or the instance/);
  });

  test("nothing recognisable: says so and still shows the last line; an empty log says it logged nothing", () => {
    expect(explain(`${REAL.READY}\n`, INSTANCE)).toMatch(/does not recognise[^\n]*\n {2}proxy said: .*ready for new connections/);
    expect(explain("", INSTANCE)).toMatch(/It logged nothing\./);
  });

  test("quotes the error line rather than the chatter after it, and cuts a very long one", () => {
    const out = explain(`${REAL.STALE}\n2026/10/13 11:11:33 [x] Accepted connection from 127.0.0.1:5\n`, INSTANCE);
    expect(out).toMatch(/proxy said: .*invalid_grant/);
    const long = explain(`failed: ${"x".repeat(2000)}`, INSTANCE);
    expect(long.length).toBeLessThan(700);
    expect(long).toMatch(/…$/);
  });
});

describe("sinceStart — only what the proxy printed since this script last started it", () => {
  test("text after the last start marker; the whole file when there is none; empty when unreadable", async () => {
    const f = files(); const port = await freePort();
    fs.writeFileSync(f.logFile, "old line one\nold line two\n");
    expect(sinceStart(f.logFile)).toBe("old line one\nold line two\n");
    expect(sinceStart(path.join(dir, "no-such.log"))).toBe("");
    const r = await ensureSqlProxy({ env: LOCAL_ENV, port, bin: fakeBin, logFile: f.logFile, pidFile: f.pidFile });
    started.push(r.pid);
    const now = sinceStart(f.logFile);
    expect(now).toMatch(/Listening on/);
    expect(now).not.toMatch(/old line/);
    expect(fs.readFileSync(f.logFile, "utf8")).toMatch(/old line one/);   // appended to, never truncated
  });
});

describe("stopSqlProxy", () => {
  test("stops the proxy this script started and forgets the pid file", async () => {
    const f = files(); const port = await freePort();
    const r = await ensureSqlProxy({ env: LOCAL_ENV, port, bin: fakeBin, logFile: f.logFile, pidFile: f.pidFile });
    started.push(r.pid);
    expect(r.status).toBe("started");
    expect(stopSqlProxy({ pidFile: f.pidFile, bin: fakeBin })).toEqual({ status: "stopped", pid: r.pid });
    expect(await waitGone(r.pid)).toBe(true);
    expect(fs.existsSync(f.pidFile)).toBe(false);
    expect(stopSqlProxy({ pidFile: f.pidFile, bin: fakeBin })).toEqual({ status: "not_running" });
  });

  test("a pid file pointing at some other live process is never signalled", async () => {
    const f = files();
    const other = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    started.push(other.pid);
    fs.writeFileSync(f.pidFile, String(other.pid));
    expect(stopSqlProxy({ pidFile: f.pidFile, bin: fakeBin })).toEqual({ status: "not_ours", pid: other.pid });
    await sleep(200);
    expect(alive(other.pid)).toBe(true);
    expect(fs.existsSync(f.pidFile)).toBe(false);
  });

  test("stale or junk pid file: not_running, file removed, nothing signalled", () => {
    const f = files();
    fs.writeFileSync(f.pidFile, "2147483646");            // no such process
    expect(stopSqlProxy({ pidFile: f.pidFile, bin: fakeBin })).toEqual({ status: "not_running" });
    expect(fs.existsSync(f.pidFile)).toBe(false);
    for (const junk of ["", "abc", "0", "1", "-5"]) {      // 0 / 1 / negative would signal a group or init
      fs.writeFileSync(f.pidFile, junk);
      expect(stopSqlProxy({ pidFile: f.pidFile, bin: fakeBin })).toEqual({ status: "not_running" });
    }
  });
});
