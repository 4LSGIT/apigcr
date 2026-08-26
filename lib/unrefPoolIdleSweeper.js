// lib/unrefPoolIdleSweeper.js
//
// mysql2's idle-connection sweeper (armed when maxIdle < connectionLimit —
// see the note in startup/db.js) is a self-rearming 1s setTimeout that
// upstream never unref()s, so on its own it keeps the Node process alive.
// Irrelevant for the long-running server (the HTTP listener holds the process
// anyway), but it hangs Jest workers and one-shot scripts that transitively
// require a pool module — observed 2026-08-26 as "Jest did not exit one second
// after the test run has completed" once the sweeper was first armed.
//
// This unrefs the current timer and shadows the instance's rearm method so
// every FUTURE timer is unref'd too. Verified against mysql2 3.24.2
// lib/base/pool.js: the timer callback rearms via
// `this._removeIdleTimeoutConnections()`, i.e. through the instance property,
// so an instance-level shadow intercepts every rearm. unref() only affects
// event-loop liveness, never firing behavior — prod semantics are unchanged.
//
// Touches the same mysql2 private internals the arming guard in startup/db.js
// reads. Every access is defensive: a future mysql2 that renames them degrades
// to the old keep-process-alive behavior, never a crash. Returns whether the
// shim attached, so callers/tests can assert on it.

function unrefPoolIdleSweeper(pool) {
  try {
    if (!pool || typeof pool._removeIdleTimeoutConnections !== "function") {
      return false;
    }
    const orig = pool._removeIdleTimeoutConnections.bind(pool);
    pool._removeIdleTimeoutConnections = function () {
      orig();
      const t = pool._removeIdleTimeoutConnectionsTimer;
      if (t && typeof t.unref === "function") t.unref();
    };
    const t = pool._removeIdleTimeoutConnectionsTimer;
    if (t && typeof t.unref === "function") t.unref();
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { unrefPoolIdleSweeper };
