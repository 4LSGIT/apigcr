// Measures where connection setup time goes: the network, or the server.
//
// FINDING (2026-08-06) — this DB stalls ~4s before its handshake greeting:
//   tcp        13 ms   <- network is fine
//   greeting 3964 ms   <- server stalls here
//
// Cause: skip_name_resolve = OFF, so MySQL does a reverse-DNS lookup of the
// client IP on every new connection. A laptop on a residential IP with no PTR
// record waits for that lookup to time out. Cloud Run is unaffected — GCP
// egress IPs have valid PTR records, so it resolves instantly (confirmed:
// admin_audit_log shows ~77ms avg over 1351 db_console calls).
//
// Host is giowm1139.siteground.biz (SiteGround shared, MySQL 8.4.6), so
// skip_name_resolve is not ours to change. scripts/dump-schema.js works around
// it by running in the background from .githooks/pre-commit.
//
// Re-run if connect times change: node scripts/probe-db-connect.js
//   tcp fast, greeting slow -> server-side stall (reverse DNS again?)
//   tcp itself slow         -> network path: firewall, proxy, route
const net = require("net"), fs = require("fs"), path = require("path");
const env = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split("\n")
    .map((l) => l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim().replace(/^["']|["']$/g, "")])
);
const host = env.host, port = +(env.port || 3306);
if (!host) { console.error("no `host` in .env"); process.exit(1); }
console.log(`probing ${host}:${port}`);
const t0 = Date.now();
const s = net.connect(port, host);
s.setTimeout(20000, () => { console.log(`TIMEOUT   ${Date.now() - t0} ms`); s.destroy(); });
s.on("lookup",  () => console.log(`dns       ${String(Date.now() - t0).padStart(5)} ms`));
s.on("connect", () => console.log(`tcp       ${String(Date.now() - t0).padStart(5)} ms   <- network path`));
s.once("data",  () => { console.log(`greeting  ${String(Date.now() - t0).padStart(5)} ms   <- server spoke`); s.destroy(); });
s.on("error",   (e) => { console.log("error", e.code, Date.now() - t0, "ms"); process.exit(1); });