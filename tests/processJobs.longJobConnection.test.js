// tests/processJobs.longJobConnection.test.js
//
/**
 * routes/process_jobs.js — executeJob must NOT run inside a held transaction.
 *
 * ── THE BUG THIS LOCKS OUT ────────────────────────────────────────────────
 * withTransaction checks a connection OUT of the pool and holds it for the
 * whole callback. When executeJob ran inside that callback, a job whose
 * execution outlasted the server's 60s wait_timeout left that connection idle
 * for its entire runtime — all of the job's own queries go to the POOL, not to
 * `conn` — and SiteGround closed it. The callback then resumed onto a dead
 * socket and died on the COMMIT-side writes with
 *     Can't add new command when connection is in closed state
 *
 * Two independent safety nets both miss it, which is why it survived review:
 *   - a CHECKED-OUT connection is not in _freeConnections, so mysql2's idle
 *     sweeper never inspects it;
 *   - `conn.query` is a raw PoolConnection method, not the wrapped
 *     promisePool.query, so startup/db.js's transient-retry cannot apply.
 *
 * Killed documents_refresh_case_cache six consecutive times at ~220s
 * (2026-08-27) and documents_sync once at 132s. Any job over ~60s was exposed.
 *
 * This is a STRUCTURAL test: it asserts ordering, not timing, because the real
 * failure needs a 60-second wall clock to reproduce and a unit test that slept
 * that long would be deleted by the next person who saw it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'routes', 'process_jobs.js'), 'utf8');

/**
 * The normal-job-types block: from its banner to the CLOSE of the recording
 * transaction. Anchored on the literal closing `}, { retries: 0 });` rather
 * than on `{ retries: 0 }` alone — the explanatory comments in that block
 * mention the option by name, and matching the bare string truncated the
 * slice before executeJob and made these tests fail against correct code.
 */
function normalJobBlock() {
  const start = src.indexOf('// NORMAL JOB TYPES');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('}, { retries: 0 });', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

test('executeJob is awaited BEFORE the recording transaction opens', () => {
  const block = normalJobBlock();
  const exec = block.indexOf('await executeJob(');
  const txn  = block.indexOf('db.withTransaction(');

  expect(exec).toBeGreaterThan(-1);
  expect(txn).toBeGreaterThan(-1);
  // Ordering IS the fix. Inside-the-callback is the bug.
  expect(exec).toBeLessThan(txn);
});

test('executeJob appears exactly once, and not inside the callback body', () => {
  const block = normalJobBlock();
  const occurrences = block.match(/await executeJob\(/g) || [];
  expect(occurrences.length).toBe(1);

  const callbackBody = block.slice(block.indexOf('db.withTransaction('));
  expect(callbackBody).not.toContain('executeJob(');
});

test('the recording transaction still keeps { retries: 0 }', () => {
  // executeJob remains non-idempotent. Retrying the recording callback must
  // never be able to re-fire a side effect, even though the callback no longer
  // contains one — the guarantee should not quietly depend on that.
  const start = src.indexOf('// NORMAL JOB TYPES');
  const tail = src.slice(start, start + 4000);
  expect(tail).toContain('{ retries: 0 }');
});

test('rawOutput is still coerced so success rows round-trip as valid JSON', () => {
  // Moving the call must not drop the undefined-coercion (custom_code with no
  // trailing expression; webhook 204 → axios undefined). NULL output_data is
  // indistinguishable from a failure row.
  expect(normalJobBlock()).toContain('rawOutput === undefined');
});

test('the failure path records in its own transaction, unchanged', () => {
  // recordResult on the error path is pure DB and keeps retries: 3.
  expect(src).toContain('{ retries: 3 }');
});
