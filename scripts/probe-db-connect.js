// Where do the ~4 seconds go: the network, or the server?
// No dependencies. Run: node scripts/probe-db-connect.js
//
//   tcp ~160ms, greeting ~4s  -> the SERVER is stalling. Almost always
//                                reverse-DNS on connect: SHOW VARIABLES LIKE
//                                'skip_name_resolve' (want ON).
//   tcp ~4s                   -> the NETWORK path is slow: firewall, proxy,
//                                or route. Nothing MySQL can fix.
//   both fast                 -> the cost is in auth; check the auth plugin.
//
// Throwaway diagnostic — delete once the 4s connect is understood.
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