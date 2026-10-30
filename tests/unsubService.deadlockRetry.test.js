/**
 * tests/unsubService.deadlockRetry.test.js — the public unsubscribe writers
 * (oneClick / applyPage) retry ONCE on ER_LOCK_DEADLOCK (post-P3 review
 * M-1, 2026-10-30). Both are direct callers in P1's terms: the token row is
 * locked, then recordConsent locks contact_emails through uk_email_active —
 * the interleave that a concurrent contact-form end-and-replace of the same
 * address can deadlock against. Without the retry a mail client's RFC 8058
 * POST answers 500 and the unsubscribe is lost. Same pattern as
 * phoneConsentService.consentTx.
 *
 * lib/withTransaction is mocked (it is not the module under test): the first
 * call rejects with a deadlock, the second runs the span. The span itself is
 * exercised against a minimal connection stub only as far as the token lock
 * (an unknown token returns early) — the retry is what is under test.
 */
'use strict';

const calls = [];
jest.mock('../lib/withTransaction', () => ({
  withTransaction: jest.fn(async (db, fn, opts) => {
    calls.push(opts);
    const err = db.__fail && db.__fail.shift();
    if (err) throw err;
    return fn(db.__conn);
  }),
}));

const unsub = require('../services/unsubService');

const TOK = 'AbCdEfGhIjKlMnOpQrStUv';   // 22 base62 — passes the format gate
const deadlock = () => Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'ER_LOCK_DEADLOCK' });
const other = () => Object.assign(new Error('boom'), { code: 'ER_NO_SUCH_TABLE' });
// A connection whose token lock finds nothing: the span returns before any consent write.
const conn = { query: async () => [[]] };

beforeEach(() => { calls.length = 0; });

describe('oneClick', () => {
  test('one deadlock → the span is re-run and the request succeeds', async () => {
    const db = { __conn: conn, __fail: [deadlock()] };
    const out = await unsub.oneClick(db, TOK, { ip: '1.2.3.4', userAgent: 'x' });
    expect(out).toEqual({ ok: true, applied: false });
    expect(calls).toHaveLength(2);
    expect(calls.every((o) => o && o.retries === 1)).toBe(true);   // the pure-DB span still asks for the blip retry
  });

  test('two deadlocks in a row → the second propagates (one retry only)', async () => {
    const db = { __conn: conn, __fail: [deadlock(), deadlock()] };
    await expect(unsub.oneClick(db, TOK, {})).rejects.toMatchObject({ code: 'ER_LOCK_DEADLOCK' });
    expect(calls).toHaveLength(2);
  });

  test('a non-deadlock error propagates at once, no retry', async () => {
    const db = { __conn: conn, __fail: [other()] };
    await expect(unsub.oneClick(db, TOK, {})).rejects.toMatchObject({ code: 'ER_NO_SUCH_TABLE' });
    expect(calls).toHaveLength(1);
  });
});

describe('applyPage', () => {
  test('one deadlock → the span is re-run', async () => {
    const db = { __conn: conn, __fail: [deadlock()], query: async () => [[]] };
    const out = await unsub.applyPage(db, TOK, { action: 'unsubscribe', ip: '1.2.3.4', userAgent: 'x' });
    expect(out).toMatchObject({ ok: false, code: 'not_found' });
    expect(calls).toHaveLength(2);
  });

  test('a non-deadlock error propagates at once', async () => {
    const db = { __conn: conn, __fail: [other()], query: async () => [[]] };
    await expect(unsub.applyPage(db, TOK, { action: 'unsubscribe' })).rejects.toMatchObject({ code: 'ER_NO_SUCH_TABLE' });
    expect(calls).toHaveLength(1);
  });
});
