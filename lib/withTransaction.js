// lib/withTransaction.js
//
// Run a function inside a DB transaction with guarded cleanup.
//
// Why this exists: rollback()/release() on a connection whose socket has died
// throw ("Can't add new command when connection is in closed state"). Left
// unguarded that becomes an unhandled promise rejection. This wraps acquire ->
// begin -> fn -> commit -> release so a dropped connection can never escape as
// an unhandled rejection, and retries exactly once for the narrow "dead pooled
// connection handed out" race (mirrors the pool-level wrapper in startup/db.js).
//
// Usage:
//   const result = await withTransaction(db, async (conn) => {
//     await conn.query("UPDATE ...", [...]);
//     const [rows] = await conn.query("SELECT ...");
//     return rows;
//   });
//
// `db` is the promise pool exported from startup/db.js. The callback receives a
// promise-wrapped pooled connection and must run all its work on that `conn`.
//
// NOTE: the helper retries the ENTIRE callback once on a transient, PRE-commit
// failure. That is only safe when the callback has no non-DB side effects
// (email/SMS send, external HTTP, file write) before the failure point, since a
// retry would re-fire them. For callbacks that must perform such side effects
// inside the transaction body, pass { retries: 0 } to disable the auto-retry
// (guarded cleanup still applies). Prefer keeping side effects out of the
// transaction (post-commit) where possible.

// Same set as startup/db.js. Kept local so this module stays self-contained.
// (startup/db.js declares TRANSIENT locally and exports only the promise pool;
// it does NOT export TRANSIENT. Decision: keep the local duplicate; do NOT edit
// db.js for this.)
const TRANSIENT = new Set([
  "EPIPE", "ECONNRESET", "ETIMEDOUT",
  "PROTOCOL_CONNECTION_LOST", "PROTOCOL_SEQUENCE_TIMEOUT",
]);

// One of mysql2's dead-socket errors carries NO err.code, so the set above
// cannot see it. Connection._addCommandClosedState throws a bare
//   new Error("Can't add new command when connection is in closed state")
// with err.fatal = true and no code. startup/db.js already special-cases it for
// pool.query / pool.execute; this is the same clause for the transaction path,
// which was otherwise blind to the single most likely way a borrowed connection
// arrives dead (SiteGround wait_timeout = 60s).
//
// Safe to retry for the same reason it is safe there: the command is rejected
// because the connection is ALREADY closed, so it never reached a socket and
// the server never saw it. Matched on fatal === true AND the message, never the
// message alone, so an application error quoting the phrase cannot smuggle
// itself into the retry path. The !commitAttempted guard below still applies.
function isTransient(err) {
  if (!err) return false;
  if (TRANSIENT.has(err.code)) return true;
  return err.fatal === true && /closed state/.test(String(err.message || ""));
}

async function withTransaction(db, fn, { retries = 1 } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let conn;
    let commitAttempted = false;
    try {
      conn = await db.getConnection();
      await conn.beginTransaction();
      const result = await fn(conn);
      commitAttempted = true;
      await conn.commit();
      // Release errors AFTER a successful commit must not fail the operation --
      // the data is already committed. Swallow and drop the connection.
      try { conn.release(); } catch (_) { try { conn.destroy(); } catch (_) {} }
      return result;
    } catch (err) {
      // Guarded cleanup. If rollback throws (dead socket), destroy the poisoned
      // connection so the pool evicts it instead of handing it out again.
      if (conn) {
        try {
          await conn.rollback();
          conn.release();
        } catch (cleanupErr) {
          console.warn(`[withTransaction] cleanup failed (${cleanupErr.code || cleanupErr.message}); destroying connection`);
          try { conn.destroy(); } catch (_) {}
        }
      }
      // Retry ONLY the dead-conn-on-borrow race, and ONLY when the failure
      // happened before we attempted commit. Never retry once commit was
      // attempted -- a dropped ack after a server-side commit would double-apply.
      if (isTransient(err) && !commitAttempted && attempt < retries) {
        attempt++;
        console.warn(`[withTransaction] transient ${err.code || "closed-state"} — retry ${attempt}/${retries}`);
        continue;
      }
      throw err;
    }
  }
}

module.exports = { withTransaction };