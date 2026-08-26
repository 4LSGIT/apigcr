// startup/db.js
const mysql = require("mysql2");

// ── Idle-connection policy ────────────────────────────────────────────────
// SiteGround MySQL runs wait_timeout = interactive_timeout = 60s (verified
// 2026-08-26: SELECT @@GLOBAL.wait_timeout → 60). The server closes ANY
// pooled socket that sits idle for 60s. Two facts drive the numbers below:
//
//  1. enableKeepAlive does NOT protect against this. wait_timeout counts time
//     since the last *MySQL protocol command* on the connection; TCP keepalive
//     probes live below the protocol and mysqld never sees them. Keepalive only
//     guards against NAT / firewall idle drops.
//
//  2. mysql2 only arms its idle recycler when maxIdle < connectionLimit. From
//     mysql2/lib/base/pool.js (BasePool constructor):
//         if (this.config.maxIdle < this.config.connectionLimit) {
//           this._removeIdleTimeoutConnections();
//         }
//     maxIdle DEFAULTS to connectionLimit, so the sweeper is off by default and
//     `idleTimeout` is inert. MAX_IDLE must stay STRICTLY BELOW CONNECTION_LIMIT
//     or every setting in this block silently stops working.
//
// Symptom when this is wrong: intermittent 500 with
//   "Connection lost: The server closed the connection." (PROTOCOL_CONNECTION_LOST)
// on any request that reaches the socket in the same instant the server is
// tearing it down. Observed 2026-08-25 22:11:09 UTC on GET /executions.
//
// Cost of the fix: after ~30s of quiet the pool drains to zero, so the first
// request of a burst pays one TCP + handshake to SiteGround. That is strictly
// cheaper than a 500.
//
// Cloud Run caveat: with request-only CPU allocation, JS timers stall while an
// instance is idle-throttled, so the sweeper only runs while traffic flows. At
// wake-up after a long quiet stretch every free socket is already dead no
// matter what the client config says; the transient-retry wrapper below is the
// guard for that path (dead sockets self-evict on their 'close' events as soon
// as the event loop resumes). The sweeper eliminates the race during active
// traffic — which is where the observed failure occurred.
const CONNECTION_LIMIT = 10;
const MAX_IDLE         = 8;       // MUST be < CONNECTION_LIMIT — arms the sweeper
const IDLE_TIMEOUT_MS  = 30_000;  // MUST be well under server wait_timeout (60s)

const pool = mysql.createPool({
  host: process.env.host,
  user: process.env.user,
  password: process.env.password,
  database: process.env.database,
  timezone: "Z",
  connectionLimit: CONNECTION_LIMIT,
  waitForConnections: true,
  queueLimit: 0,

  // TCP keepalive — guards NAT / firewall idle drops only (see note 1 above)
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,   // 10s, not 0 (0 = OS default = 2h on macOS)

  // Proactively recycle idle pool members before wait_timeout can reap them
  maxIdle: MAX_IDLE,
  idleTimeout: IDLE_TIMEOUT_MS,
});

// Guard: mysql2 arms the sweeper once, in the Pool constructor, and never
// re-checks. If a future edit pushes maxIdle up to connectionLimit the
// recycling stops silently and the intermittent PROTOCOL_CONNECTION_LOST 500s
// come back. Private field, so probe defensively — never fail boot over it.
try {
  if (!pool._removeIdleTimeoutConnectionsTimer) {
    console.error(
      "[db] idle-connection sweeper NOT armed (maxIdle must be < connectionLimit). " +
      "Pooled sockets will be reaped by MySQL wait_timeout instead — expect " +
      "intermittent PROTOCOL_CONNECTION_LOST 500s."
    );
  }
} catch (_) { /* upstream shape changed; not worth failing boot */ }

// The armed sweeper is a self-rearming 1s timer mysql2 never unref()s — on its
// own it would hold Jest workers / one-shot scripts open. See the helper.
require("../lib/unrefPoolIdleSweeper").unrefPoolIdleSweeper(pool);

pool.on("error", err => {
  console.error("MySQL pool error:", err);
});

// --- transient-retry wrapper ---
// Exactly one retry for the narrow "dead socket handed out by pool" race.
// Not a general retry loop — we don't want to mask real bugs.
const TRANSIENT = new Set([
  "EPIPE", "ECONNRESET", "ETIMEDOUT",
  "PROTOCOL_CONNECTION_LOST", "PROTOCOL_SEQUENCE_TIMEOUT",
]);

const promisePool = pool.promise();
const rawQuery   = promisePool.query.bind(promisePool);
const rawExecute = promisePool.execute.bind(promisePool);

promisePool.query = async function (...args) {
  try {
    return await rawQuery(...args);
  } catch (err) {
    if (TRANSIENT.has(err && err.code)) {
      console.warn(`[db] transient ${err.code} — retrying once`);
      return await rawQuery(...args);
    }
    throw err;
  }
};

promisePool.execute = async function (...args) {
  try {
    return await rawExecute(...args);
  } catch (err) {
    if (TRANSIENT.has(err && err.code)) {
      console.warn(`[db] transient ${err.code} — retrying once`);
      return await rawExecute(...args);
    }
    throw err;
  }
};

if (process.env.ENVIRONMENT === "development") {
  promisePool.query("SELECT 1")
    .then(() => console.log(`[db] connected to ${process.env.database}@${process.env.host} as ${process.env.user}`))
    .catch((err) => console.error(`[db] connection failed: ${err.code || err.name} — ${err.message}`));
}

// Transaction helper, surfaced on the pool so every caller (req.db is this same
// pool singleton) can do `db.withTransaction(async (conn) => { ... })` with no
// import. Implementation lives in lib/withTransaction.js (dependency-free,
// unit-testable); this is just a thin bound convenience method. The standalone
// withTransaction(db, fn, opts) is still exported from there for scripts/tests.
const { withTransaction } = require("../lib/withTransaction");
promisePool.withTransaction = (fn, opts) => withTransaction(promisePool, fn, opts);

module.exports = promisePool;