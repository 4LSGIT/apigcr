// startup/db.js
const mysql = require("mysql2");

const pool = mysql.createPool({
  host: process.env.host,
  user: process.env.user,
  password: process.env.password,
  database: process.env.database,
  timezone: "Z",
  connectionLimit: 10,
  waitForConnections: true,
  queueLimit: 0,

  // TCP keepalive — start probes well before NAT / wait_timeout kills the socket
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,   // 10s, not 0 (0 = OS default = 2h on macOS)

  // Proactively recycle idle pool members (mysql2 >= 3.11.0)
  maxIdle: 10,
  idleTimeout: 60_000,
});

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

module.exports = promisePool;

/*const mysql = require("mysql2");

const pool = mysql.createPool({
  connectionLimit: 10,
  waitForConnections: true,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  host: process.env.host,
  user: process.env.user,
  password: process.env.password,
  database: process.env.database,
  timezone: "Z"
});

pool.on("error", err => {
  console.error("MySQL pool error:", err);
});

module.exports = pool.promise();
*/