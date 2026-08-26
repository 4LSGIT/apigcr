/**
 * Regression guard for the mysql2 idle-connection sweeper on both pools.
 *
 * BACKGROUND. 2026-08-25 22:11:09 UTC, GET /executions returned 500 with
 * "Connection lost: The server closed the connection." (PROTOCOL_CONNECTION_LOST).
 * Root cause was config, not the route:
 *
 *   - SiteGround MySQL runs wait_timeout = interactive_timeout = 60s. Any
 *     pooled socket idle for 60s is closed by the server.
 *   - mysql2 arms its idle recycler ONLY when maxIdle < connectionLimit
 *     (mysql2/lib/base/pool.js, BasePool constructor). maxIdle defaults to
 *     connectionLimit. Both pools set maxIdle === connectionLimit, so the
 *     sweeper never started and `idleTimeout` was dead config. Sockets sat in
 *     _freeConnections until the server reaped them, and a request landing in
 *     the same instant as the teardown got a fatal error.
 *   - enableKeepAlive does not help: wait_timeout measures protocol-level
 *     idleness, and TCP keepalive probes are invisible to mysqld.
 *
 * WHAT IS LOAD-BEARING HERE
 *
 *   1. The sweeper timer must exist. `_removeIdleTimeoutConnectionsTimer` is a
 *      private mysql2 field, but it is the only observable proof the recycler
 *      armed — asserting on `config.maxIdle` alone would still pass if mysql2
 *      changed the arming condition. If a future mysql2 renames the field this
 *      test fails loudly, which is the correct outcome: re-verify by hand.
 *
 *   2. maxIdle < connectionLimit is asserted separately so a failure says WHY,
 *      not just "timer missing".
 *
 *   3. idleTimeout must leave real headroom under the 60s server wait_timeout.
 *      60_000 is not "equal, therefore fine" — it is a coin flip on whose timer
 *      fires first. 45s is the loosest value that still leaves a margin; the
 *      shipped value is 30s.
 *
 *   4. The sweeper timer must be unref'd, and must STAY unref'd across its 1s
 *      self-rearm (lib/unrefPoolIdleSweeper.js). mysql2 never unrefs it, and a
 *      ref'd repeating timer holds every Jest worker (and one-shot script)
 *      that transitively requires a pool module — several suites reach
 *      startup/dbReadonly via reportService ← internal_functions. This file
 *      deliberately uses REAL timers: it is itself the canary — if the unref
 *      shim regresses, this suite hangs its worker and Jest says so.
 *
 * afterAll ends both pools; mysql2's end() clears the sweeper timer. The pools
 * never connect (mysql2 is lazy), so no network I/O happens here.
 */

const appPool = require('../startup/db');
const roPool = require('../startup/dbReadonly');

// Server-side ceiling these pools must stay under. Re-verify with:
//   SELECT @@GLOBAL.wait_timeout;
const SERVER_WAIT_TIMEOUT_MS = 60_000;
const MAX_ALLOWED_IDLE_TIMEOUT_MS = 45_000;

const CASES = [
  ['startup/db.js (app pool)', appPool],
  ['startup/dbReadonly.js (readonly pool)', roPool],
];

afterAll(async () => {
  await Promise.allSettled(CASES.map(([, p]) => p.end()));
});

describe.each(CASES)('%s idle-connection recycling', (_label, promisePool) => {
  // Both modules export the promise wrapper; .pool is the underlying BasePool.
  const pool = promisePool.pool;

  test('exposes the underlying mysql2 pool', () => {
    expect(pool).toBeDefined();
    expect(typeof pool.config.connectionLimit).toBe('number');
  });

  test('maxIdle is strictly below connectionLimit', () => {
    const { maxIdle, connectionLimit } = pool.config;
    expect(maxIdle).toBeLessThan(connectionLimit);
  });

  test('idleTimeout leaves headroom under the server wait_timeout', () => {
    expect(pool.config.idleTimeout).toBeGreaterThan(0);
    expect(pool.config.idleTimeout).toBeLessThanOrEqual(MAX_ALLOWED_IDLE_TIMEOUT_MS);
    expect(pool.config.idleTimeout).toBeLessThan(SERVER_WAIT_TIMEOUT_MS);
  });

  test('the mysql2 idle sweeper actually armed', () => {
    // See note 1 above: this is the assertion that catches a silent regression.
    expect(pool._removeIdleTimeoutConnectionsTimer).toBeTruthy();
  });

  test('sweeper timer is unref’d and stays unref’d across a self-rearm', async () => {
    const t0 = pool._removeIdleTimeoutConnectionsTimer;
    expect(typeof t0.hasRef).toBe('function');
    expect(t0.hasRef()).toBe(false);

    // The sweeper rearms every 1s via this._removeIdleTimeoutConnections();
    // the shim in lib/unrefPoolIdleSweeper.js must unref each NEW timer too.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const t1 = pool._removeIdleTimeoutConnectionsTimer;
    expect(t1).toBeTruthy();
    expect(t1).not.toBe(t0); // proves a rearm actually happened
    expect(t1.hasRef()).toBe(false);
  });
});
