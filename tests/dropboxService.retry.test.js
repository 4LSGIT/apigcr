// tests/dropboxService.retry.test.js
//
/**
 * services/dropboxService.js — transient-failure retry.
 *
 * WHY THIS EXISTS. system_alerts 153 (2026-09-28 16:00:54 UTC): documents
 * sync root 4 died with
 *
 *   dropbox: request to /2/files/list_folder/continue failed:
 *   This operation was aborted
 *
 * — our OWN AbortController firing at the then-30s RPC timeout. One slow
 * Dropbox response killed the root for the tick and emailed IT at severity
 * 'error'; the next tick, 10 minutes later, synced clean. 4,751 job runs,
 * one failure, self-healed.
 *
 * Two things had to be true and were not:
 *   1. a replay-safe read retries instead of failing the whole root, and
 *   2. a replay-UNSAFE mutation never retries, because a lost response on
 *      files/move_v2 or files/create_folder_v2 means the write may have
 *      landed and a second attempt double-applies it.
 *
 * Both directions are pinned here. The negative case is the load-bearing
 * one: a blanket retry is the obvious fix and it is the wrong one.
 *
 * No DB, no network — global.fetch and the credential injector are stubbed.
 *
 * Run:
 *   npx jest tests/dropboxService.retry.test.js
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY ||
  require('crypto').randomBytes(32).toString('base64');

// The async header builder is the ONLY thing dropboxService needs from the
// credential system (AI_CONTEXT §21). Stub it; nothing here decrypts.
jest.mock('../lib/credentialInjection', () => ({
  buildHeadersForCredential: jest.fn(async () => ({ Authorization: 'Bearer test' })),
}));

const dropbox = require('../services/dropboxService');

// db stub: _resolveCredential's app_settings lookup is the only query made.
const db = { query: jest.fn(async () => [[{ value: 8 }]]) };

/** A fetch Response good enough for _rpcOnce. */
function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

/** An undici-shaped abort, i.e. exactly what our AbortController produces. */
function abortError() {
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  return e;
}

let realFetch;
beforeAll(() => { realFetch = global.fetch; });
afterAll(() => { global.fetch = realFetch; });
beforeEach(() => { db.query.mockClear(); });

describe('isTransientError', () => {
  it('grades our own abort, socket failures, 429 and 5xx as transient', () => {
    expect(dropbox.isTransientError(abortError())).toBe(true);
    expect(dropbox.isTransientError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(dropbox.isTransientError(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } })
    )).toBe(true);
    expect(dropbox.isTransientError(Object.assign(new Error('x'), { status: 429 }))).toBe(true);
    expect(dropbox.isTransientError(Object.assign(new Error('x'), { status: 503 }))).toBe(true);
  });

  it('does NOT grade the 4xx Dropbox uses to mean something as transient', () => {
    // 409 reset / path_not_found and 401 never heal on retry. Grading any of
    // them transient would spin the retry loop on a permanent condition AND
    // downgrade its alert to a warning nobody emails.
    for (const status of [400, 401, 403, 409]) {
      expect(dropbox.isTransientError(Object.assign(new Error('x'), { status }))).toBe(false);
    }
    expect(dropbox.isTransientError(new Error('plain'))).toBe(false);
    expect(dropbox.isTransientError(null)).toBe(false);
  });
});

describe('_rpc retry policy (via public callers)', () => {
  it('retries list_folder/continue past a transient abort and returns the page', async () => {
    global.fetch = jest.fn()
      .mockRejectedValueOnce(abortError())
      .mockResolvedValueOnce(jsonRes(200, { entries: [{ '.tag': 'file', name: 'a.pdf' }], cursor: 'c2', has_more: false }));

    const page = await dropbox.listFolderContinue(db, { cursor: 'c1', credentialId: 8 });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(page.cursor).toBe('c2');
    expect(page.entries).toHaveLength(1);
  });

  it('retries a 429 and honours Retry-After without waiting the full backoff', async () => {
    const res429 = {
      ok: false, status: 429,
      headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '0' : null) },
      text: async () => JSON.stringify({ error_summary: 'too_many_requests/..' }),
    };
    global.fetch = jest.fn()
      .mockResolvedValueOnce(res429)
      .mockResolvedValueOnce(jsonRes(200, { entries: [], cursor: 'c9', has_more: false }));

    const page = await dropbox.listFolderContinue(db, { cursor: 'c1', credentialId: 8 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(page.cursor).toBe('c9');
  });

  it('gives up after RETRY_ATTEMPTS, not RETRY_ATTEMPTS retries', async () => {
    global.fetch = jest.fn().mockRejectedValue(abortError());

    await expect(dropbox.listFolderContinue(db, { cursor: 'c1', credentialId: 8 }))
      .rejects.toThrow(/list_folder\/continue/);

    // 3 attempts total, not 3 retries on top of the first.
    expect(global.fetch).toHaveBeenCalledTimes(3);
  }, 30000);

  it('names the TIMEOUT when our own AbortController is what fired', async () => {
    // The pre-fix message was "failed: This operation was aborted", which
    // reads like Dropbox hung up on us. It was our 30s timer. A real hanging
    // request (one that only settles when the signal aborts) is the only way
    // to exercise the timedOut branch, so drive _rpc directly with a tiny
    // timeout rather than waiting out RPC_TIMEOUT_MS.
    global.fetch = jest.fn((url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(abortError()));
    }));

    let caught;
    try {
      await dropbox._rpc(db, 8, 'files/get_metadata', { path: '/x' },
        { timeoutMs: 40, attempts: 1 });
    } catch (err) { caught = err; }

    expect(caught.message).toMatch(/timed out after 40ms/);
    expect(caught.code).toBe('ETIMEDOUT');
    expect(dropbox.isTransientError(caught)).toBe(true);
  });

  it('a hard endpoint cap of 1 attempt still applies to a hanging mutation', async () => {
    global.fetch = jest.fn((url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(abortError()));
    }));

    await expect(
      dropbox._rpc(db, 8, 'files/move_v2', { from_path: '/a', to_path: '/b' }, { timeoutMs: 40 })
    ).rejects.toThrow(/timed out after 40ms/);

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a 409 cursor reset — and still classifies it as one', async () => {
    const res409 = {
      ok: false, status: 409,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error_summary: 'reset/...', error: { '.tag': 'reset' } }),
    };
    global.fetch = jest.fn().mockResolvedValue(res409);

    let caught;
    try { await dropbox.listFolderContinue(db, { cursor: 'c1', credentialId: 8 }); }
    catch (err) { caught = err; }

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(dropbox.isCursorResetError(caught)).toBe(true);
    expect(dropbox.isTransientError(caught)).toBe(false);
  });

  it('NEVER retries a mutation, even on a transient abort', async () => {
    // files/move_v2 is not in RETRYABLE_ENDPOINTS: a lost response may mean
    // the move already landed. One attempt, then surface the failure.
    global.fetch = jest.fn().mockRejectedValue(abortError());

    await expect(dropbox.movePath(db, {
      fromPath: '/  Law Office/a', toPath: '/  Law Office/b', credentialId: 8,
    })).rejects.toThrow(/files\/move_v2/);

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('NEVER retries files/upload', async () => {
    global.fetch = jest.fn().mockRejectedValue(abortError());

    await expect(dropbox.uploadFile(db, {
      path: '/  Law Office/x.pdf', content: Buffer.from('hi'), credentialId: 8,
    })).rejects.toThrow(/files\/upload/);

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
