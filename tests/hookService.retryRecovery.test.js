/**
 * tests/hookService.retryRecovery.test.js
 *
 * T9/WEAK-2 — when a retry recovers a hook execution, the execution row must
 * stop claiming to be broken.
 *
 * THE BUG THIS LOCKS SHUT: services/hookService.executeRetry flipped
 * hook_executions.status back to 'delivered' on a successful retry but left the
 * FIRST attempt's error text in the `error` column:
 *
 *     UPDATE hook_executions SET status = ? WHERE id = ? AND status IN ('failed','partial')
 *
 * Live proof before the fix, hook_executions #15312 (2026-07-19):
 *   status: 'delivered'
 *   error:  'Email Fred on unmatched slug: internal_function delivery failed:
 *            Gmail API 400: Invalid To header'
 *   its ONLY delivery log: status='success', attempts=2, error=NULL
 *
 * WHY THAT MATTERED ENOUGH TO FIX: `hook_executions.error IS NOT NULL` is
 * precisely the predicate the T2/F-3/F-8 pattern trains an author to reach for
 * when hunting "a failure recorded in a side field while the status column stays
 * green". A recovered retry made that predicate a guaranteed false positive on
 * its first use — which is how a detector gets written, disbelieved, and
 * abandoned. Poisoning the next detector is worse than the stale string itself.
 *
 * WHAT IS ASSERTED
 *   - full recovery (no delivery log still failed) → status 'delivered' AND
 *     error cleared, in the SAME statement as the status flip
 *   - partial recovery (another target still failed) → status 'partial' and the
 *     error text LEFT ALONE. That row is a live failure lib/alerting.js's
 *     _scanHooks catches on status alone; clearing it would delete the only
 *     human-readable description of what is still broken.
 *   - a retry that FAILS again touches hook_executions not at all
 *   - the guarded WHERE (status IN ('failed','partial')) is preserved, so a
 *     concurrently-cancelled or already-green row is not resurrected
 *   - 'this needed a retry' survives in hook_delivery_logs.attempts, which is
 *     the durable signal the cleared string was never a good substitute for
 *
 * NOT COVERED HERE, deliberately: executeRetry UPDATEs the delivery log IN
 * PLACE, so the failed attempt's response_status/response_body/error are
 * overwritten and unrecoverable (which is why #15312's log reads error=NULL).
 * That is schema-shaped and queued with the stuck-hook-execution scanner work.
 *
 * Run: npx jest tests/hookService.retryRecovery.test.js
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY || 'x'.repeat(64);

// Delivery is mocked at the dispatcher boundary: this suite is about what the
// EXECUTION ROW says afterwards, not about how a target is reached.
jest.mock('../lib/actionDispatchers', () => ({
  dispatch: jest.fn(),
}));

const actionDispatchers = require('../lib/actionDispatchers');
const hookService       = require('../services/hookService');

// ─────────────────────────────────────────────────────────────
// Stub pool — matcher-based, records every statement
// ─────────────────────────────────────────────────────────────

const EXEC_ID   = 15312;
const TARGET_ID = 32;
const STALE_ERR =
  'Email Fred on unmatched slug: internal_function delivery failed: Gmail API 400: Invalid To header';

/**
 * @param {object} o
 *   execStatus   current hook_executions.status
 *   execError    current hook_executions.error
 *   otherLogs    statuses of the OTHER delivery logs on this execution
 */
function makeDb({ execStatus = 'failed', execError = STALE_ERR, otherLogs = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });

      if (/SELECT \* FROM hook_executions/.test(sql)) {
        return [[{ id: EXEC_ID, status: execStatus, error: execError,
                   transform_output: JSON.stringify({ hello: 'world' }) }]];
      }
      if (/FROM hook_targets/.test(sql)) {
        return [[{ id: TARGET_ID, name: 'Email Fred on unmatched slug',
                   target_type: 'internal_function', config: '{}',
                   transform_mode: 'passthrough', transform_config: null,
                   credential_id: null }]];
      }
      // The "does an earlier log exist" probe, then the post-success re-check.
      if (/SELECT id, attempts FROM hook_delivery_logs/.test(sql)) {
        return [[{ id: 6622, attempts: 1 }]];
      }
      if (/SELECT status FROM hook_delivery_logs/.test(sql)) {
        // This retry's own log has just been written as success.
        return [[{ status: 'success' }, ...otherLogs.map(s => ({ status: s }))]];
      }
      if (/UPDATE hook_delivery_logs/.test(sql)) return [{ affectedRows: 1 }];
      if (/UPDATE hook_executions/.test(sql))    return [{ affectedRows: 1 }];
      if (/INSERT INTO hook_delivery_logs/.test(sql)) return [{ insertId: 1 }];

      throw new Error('stub: unscripted SQL: ' + sql.slice(0, 70));
    },
  };
}

const deliveryOk = () => ({
  status: 'success',
  result: { target_id: TARGET_ID, request_url: 'internal://fn', request_method: 'CALL',
            request_body: '{}', response_status: 200, response_body: 'ok',
            status: 'success', error: null },
  error: null,
});
const deliveryBad = () => ({
  status: 'failed',
  result: { target_id: TARGET_ID, request_url: 'internal://fn', request_method: 'CALL',
            request_body: '{}', response_status: 500, response_body: null,
            status: 'failed', error: 'still broken' },
  error: 'still broken',
});

const execUpdate = (db) => db.calls.find(c => /^UPDATE hook_executions/.test(c.sql));

beforeEach(() => actionDispatchers.dispatch.mockReset());

// ─────────────────────────────────────────────────────────────

test('full recovery clears the stale error alongside the status flip', async () => {
  actionDispatchers.dispatch.mockResolvedValue(deliveryOk());
  const db = makeDb({ execStatus: 'failed', otherLogs: [] });

  await hookService.executeRetry(db, { execution_id: EXEC_ID, target_id: TARGET_ID });

  const upd = execUpdate(db);
  expect(upd).toBeDefined();
  expect(upd.sql).toContain('error = NULL');
  expect(upd.params).toEqual(['delivered', EXEC_ID]);

  // ONE statement, not a status flip followed by a separate cleanup — the row
  // is never briefly green-with-an-error for another reader to observe.
  expect(db.calls.filter(c => /^UPDATE hook_executions/.test(c.sql))).toHaveLength(1);
});

test("the detector predicate that #15312 poisoned is now honest", async () => {
  // JS mirror of `WHERE status = 'delivered' AND error IS NOT NULL` applied to
  // the row state this UPDATE produces. Before the fix this selected #15312.
  actionDispatchers.dispatch.mockResolvedValue(deliveryOk());
  const db = makeDb({ execStatus: 'failed', otherLogs: [] });
  await hookService.executeRetry(db, { execution_id: EXEC_ID, target_id: TARGET_ID });

  const upd = execUpdate(db);
  const rowAfter = {
    status: upd.params[0],
    error:  /error = NULL/.test(upd.sql) ? null : STALE_ERR,
  };
  expect(rowAfter.status).toBe('delivered');
  expect(rowAfter.error).toBeNull();
  expect(rowAfter.status === 'delivered' && rowAfter.error !== null).toBe(false);
});

test('partial recovery keeps the error — that row is still a live failure', async () => {
  actionDispatchers.dispatch.mockResolvedValue(deliveryOk());
  const db = makeDb({ execStatus: 'failed', otherLogs: ['failed'] });

  await hookService.executeRetry(db, { execution_id: EXEC_ID, target_id: TARGET_ID });

  const upd = execUpdate(db);
  expect(upd.sql).not.toContain('error = NULL');
  expect(upd.params).toEqual(['partial', EXEC_ID]);
});

test('a retry that fails again does not touch hook_executions at all', async () => {
  actionDispatchers.dispatch.mockResolvedValue(deliveryBad());
  const db = makeDb({ execStatus: 'failed' });

  await hookService.executeRetry(db, { execution_id: EXEC_ID, target_id: TARGET_ID });

  expect(execUpdate(db)).toBeUndefined();
  // The delivery log still records the attempt.
  expect(db.calls.some(c => /^UPDATE hook_delivery_logs/.test(c.sql))).toBe(true);
});

test('the guarded WHERE survives — a row already out of failed/partial is not resurrected', async () => {
  actionDispatchers.dispatch.mockResolvedValue(deliveryOk());
  const db = makeDb({ execStatus: 'failed', otherLogs: [] });

  await hookService.executeRetry(db, { execution_id: EXEC_ID, target_id: TARGET_ID });

  const upd = execUpdate(db);
  expect(upd.sql).toContain("status IN ('failed','partial')");
});

test("'this needed a retry' survives in hook_delivery_logs.attempts", async () => {
  actionDispatchers.dispatch.mockResolvedValue(deliveryOk());
  const db = makeDb({ execStatus: 'failed', otherLogs: [] });

  await hookService.executeRetry(db, { execution_id: EXEC_ID, target_id: TARGET_ID });

  const logUpd = db.calls.find(c => /^UPDATE hook_delivery_logs/.test(c.sql));
  expect(logUpd.sql).toContain('attempts = attempts + 1');
  // Which is why clearing the execution's error text loses nothing: the
  // durable "a retry happened here" signal lives on the delivery log, and it
  // is also the witness the backfill migration keys off
  // (ref/2026-08-19_hook_recovered_retry_error_backfill.sql).
});