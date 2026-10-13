// tests/ensureSqlProxy.test.js
//
// scripts/ensure-sql-proxy.js — the local-development helper that starts the
// Cloud SQL Auth Proxy when .env opts in. Nothing is mocked: a stand-in
// "cloud-sql-proxy" executable (a few lines of node, written to a temp dir) is
// really spawned, really listens (or exits, or stays deaf), and is really
// signalled. Ports are picked free at run time, never 3306.
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

const { ensureSqlProxy, stopSqlProxy, decide, portOpen, ENV_VAR, PORT } = require("../scripts/ensure-sql-proxy");

jest.setTimeout(30000);

const INSTANCE = "some-project:us-east1:some-instance";
const LOCAL_ENV = { [ENV_VAR]: INSTANCE, host: "127.0.0.1" };

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
  // control.json: { mode: listen (default) | exit | deaf, argsFile?, selfPid? }
  fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require("fs"); const net = require("net"); const path = require("path");
const args = process.argv.slice(2);
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(path.join(__dirname, "control.json"), "utf8")); } catch (_) {}
if (ctl.argsFile) fs.writeFileSync(ctl.argsFile, JSON.stringify(args));
if (ctl.selfPid) fs.writeFileSync(ctl.selfPid, String(process.pid));
const mode = ctl.mode || "listen";
if (mode === "exit") { console.error("error: could not find default credentials"); process.exit(1); }
if (mode === "deaf") { console.log("authorizing..."); setInterval(() => {}, 1000); }
else {
  const port = Number(args[args.indexOf("--port") + 1]);
  net.createServer((s) => s.end()).listen(port, "127.0.0.1", () => console.log("Listening on 127.0.0.1:" + port));
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
