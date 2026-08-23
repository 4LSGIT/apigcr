/**
 * tests/scheduleResume.accel.test.js
 *
 * lib/workflow_engine.scheduleResume — the Cloud Tasks enqueue window
 * (P1, 2026-08).
 *
 * WHAT IS LOCKED SHUT
 *   1. WINDOW: only resumes due within ACCEL_WINDOW_MS (90s) get a push
 *      dispatch. Long workflow delays stay entirely cron-owned — the
 *      scheduled_jobs row is the single cancellable scheduling authority;
 *      a task pinned days ahead is a second authority that can outlive a
 *      cancelled execution.
 *   2. DEDUPE PATH ENQUEUES NOTHING: when an identical resume is already
 *      pending, scheduleResume early-returns without inserting — and must
 *      not enqueue either (the pending job already has its task).
 *   3. THE ENQUEUE CARRIES THE FRESH insertId — the accelerator dispatches
 *      the row that was just created, not a guess.
 *   4. GARBAGE resumeAt (NaN ms) skips the enqueue instead of enqueueing a
 *      task for a row the claim predicate may never match. (The INSERT
 *      itself still happens — pre-existing behavior, not this slice's to
 *      change.)
 *
 * taskQueue is mocked at the module boundary: this suite is about the
 * caller's gating, not about Cloud Tasks RPCs (tests/taskQueue.accel.test.js
 * owns those).
 *
 * Run: npx jest tests/scheduleResume.accel.test.js
 */

'use strict';

jest.mock('../lib/taskQueue', () => ({
  enqueueJobDispatch: jest.fn(async () => true),
  ACCEL_WINDOW_MS: 90 * 1000,
  DISPATCH_BUFFER_MS: 2000,
}));

const { enqueueJobDispatch } = require('../lib/taskQueue');
const { scheduleResume } = require('../lib/workflow_engine');

const INSERT_ID = 777;

function makeDb({ duplicatePending = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('WHERE idempotency_key = ?')) {
        return [duplicatePending ? [{ id: 1 }] : []];
      }
      if (s.includes('INSERT INTO scheduled_jobs')) {
        return [{ insertId: INSERT_ID, affectedRows: 1 }];
      }
      return [{ affectedRows: 1 }];
    },
  };
}

beforeEach(() => enqueueJobDispatch.mockClear());

describe('scheduleResume × Cloud Tasks accelerator', () => {

  test('immediate resume (new Date()) → row inserted AND dispatch enqueued with the fresh insertId', async () => {
    const db = makeDb();
    const at = new Date();
    await scheduleResume(5, at, 1, db);

    expect(db.calls.some((c) => c.sql.includes('INSERT INTO scheduled_jobs'))).toBe(true);
    expect(enqueueJobDispatch).toHaveBeenCalledTimes(1);
    expect(enqueueJobDispatch).toHaveBeenCalledWith(INSERT_ID, at.getTime());
  });

  test('scheduleSelfContinue shape (now + 1s ISO string) is inside the window → enqueued', async () => {
    const db = makeDb();
    await scheduleResume(5, new Date(Date.now() + 1000).toISOString(), 3, db);
    expect(enqueueJobDispatch).toHaveBeenCalledTimes(1);
  });

  test('far-future resume (a real workflow delay) → row inserted, NO enqueue', async () => {
    const db = makeDb();
    await scheduleResume(5, new Date(Date.now() + 3600 * 1000), 2, db);
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO scheduled_jobs'))).toBe(true);
    expect(enqueueJobDispatch).not.toHaveBeenCalled();
  });

  test('boundary: just inside 90s → enqueued; just outside → not', async () => {
    let db = makeDb();
    await scheduleResume(5, new Date(Date.now() + 85 * 1000), 2, db);
    expect(enqueueJobDispatch).toHaveBeenCalledTimes(1);

    enqueueJobDispatch.mockClear();
    db = makeDb();
    await scheduleResume(5, new Date(Date.now() + 95 * 1000), 2, db);
    expect(enqueueJobDispatch).not.toHaveBeenCalled();
  });

  test('dedupe early-return (identical resume already pending) → no INSERT and NO enqueue', async () => {
    const db = makeDb({ duplicatePending: true });
    await scheduleResume(5, new Date(), 1, db);
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO scheduled_jobs'))).toBe(false);
    expect(enqueueJobDispatch).not.toHaveBeenCalled();
  });

  test('unparseable resumeAt → NaN window check fails closed: no enqueue (insert behavior unchanged)', async () => {
    const db = makeDb();
    await scheduleResume(5, 'not-a-date', 1, db);
    expect(enqueueJobDispatch).not.toHaveBeenCalled();
  });
});
