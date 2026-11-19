// tests/docReqUploadComplete.test.js
//
// POST /api/public/upload-complete (routes/api.checklists.js) — the public
// docReq page's completion step. Until 2026-11-18 nothing tested it. Since
// 2026-11-19 the route's whole post-200 phase is
// services/clientUploadCompletionService (shared with the portal —
// tests/clientUploadCompletion.test.js owns the notice, the reviewer, the
// `docs` log row and the task); this suite pins what the ROUTE hands it and
// that it answers first.
//
// Docs intake S3 (2026-11-19): POST /api/public/upload-landed — one call per
// landed file, appended to the run's batch row (clientUploadBatchService,
// whose real-engine suite is tests/clientUploadBatchService.mysql.test.js) —
// and `batch` on upload-complete (→ finishByClient). Pinned here: validation,
// caps, the 404 for an unknown case, answer-after-write on landed, the 60/min
// limiter, and that a missing or malformed key leaves upload-complete exactly
// as it was.
//
// DRIVEN OVER REAL HTTP, the tests/portalDocsRoutes.test.js way: the real
// router in a real express app on an ephemeral port (express is a prod dep;
// fetch is global).
//
// Run:
//   npx jest tests/docReqUploadComplete.test.js

'use strict';

jest.mock('../services/clientUploadCompletionService', () => ({ completeClientUpload: jest.fn() }));
jest.mock('../services/uploadTargetService', () => ({ issueClientUploadLink: jest.fn() }));
// The batch service's I/O is mocked; its key rule (isBatchKey) stays real — it
// is what decides between the S3 path and today's.
jest.mock('../services/clientUploadBatchService', () => ({
  ...jest.requireActual('../services/clientUploadBatchService'),
  landed: jest.fn(),
  finishByClient: jest.fn(),
}));

const http = require('http');
const express = require('express');
const completion = require('../services/clientUploadCompletionService');
const batches = require('../services/clientUploadBatchService');
const router = require('../routes/api.checklists');

// Identity-checked. upload-complete never queries it; upload-landed reads the
// case (case-insensitive, like the column's general_ci) and gets the canonical id.
const CASES = ['PVXC1RMM'];
const DB = {
  marker: 'pool',
  query: jest.fn(async (sql, params) => {
    if (/^SELECT case_id FROM cases WHERE case_id = \?$/.test(sql)) {
      const hit = CASES.find(c => c.toLowerCase() === String(params[0]).toLowerCase());
      return [hit ? [{ case_id: hit }] : []];
    }
    throw new Error(`unexpected query: ${sql}`);
  }),
};
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = DB; next(); });
app.use(router);

let server;
let base;
beforeAll(done => {
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll(done => { server.closeAllConnections?.(); server.close(() => done()); });

// One client address for the whole suite: its few requests sit well inside the
// route's 10/min limiter (express-rate-limit keys on the socket here — no
// trust-proxy app setting, so no X-Forwarded-For either).
async function complete(body) {
  const res = await fetch(`${base}/api/public/upload-complete`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/**
 * POST from a chosen loopback source address. express-rate-limit keys on the
 * socket (no trust-proxy here), so each limiter test gets its own bucket by
 * connecting from its own 127.x address (Linux routes all of 127/8 to lo).
 */
function postFrom(localAddress, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const u = new URL(base + path);
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname, method: 'POST', localAddress,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
let addrSeq = 10;
const freshAddr = () => `127.0.0.${addrSeq++}`;
const landedCall = (body, from = freshAddr()) => postFrom(from, '/api/public/upload-landed', body);
const KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

/** The side effects run after the 200 — wait for the hand-off. */
async function settled(mockFn, times = 1) {
  for (let i = 0; i < 100 && mockFn.mock.calls.length < times; i++) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 20));
}

let release;
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  release = null;
  completion.completeClientUpload.mockImplementation(() => new Promise(r => { release = r; }));
  batches.landed.mockResolvedValue({ accepted: true, id: 1, opened: true });
  batches.finishByClient.mockResolvedValue({ status: 'owned', result: {} });
});
afterEach(() => console.error.mockRestore());

test('answers 200 FIRST, then hands the batch to the shared completion phase as source docreq', async () => {
  const files = Array.from({ length: 52 }, (_, i) => `stmt ${i}.pdf`);
  const r = await complete({ case_id: 'PVXC1RMM', files, comment: 'Taxes and statements' });
  expect(r).toEqual({ status: 200, json: { status: 'success', message: 'Notification received. Thank you!' } });
  await settled(completion.completeClientUpload);
  expect(release).not.toBeNull();   // the 200 went out while the phase is still pending
  expect(completion.completeClientUpload).toHaveBeenCalledTimes(1);
  const [db, o] = completion.completeClientUpload.mock.calls[0];
  expect(db).toBe(DB);
  expect(o).toEqual({
    source: 'docreq', caseId: 'PVXC1RMM',
    files: files.slice(0, 50),            // the route's cap
    fileCount: 52,                        // the true count
    comment: 'Taxes and statements',
  });
  release({ sent: true });
});

test('client input is normalised before the hand-off: non-strings coerced, names and comment capped', async () => {
  await complete({ case_id: 'PVXC1RMM', files: [null, 42, { a: 1 }, 'n'.repeat(300)], comment: 'c'.repeat(3000) });
  await settled(completion.completeClientUpload);
  const o = completion.completeClientUpload.mock.calls[0][1];
  expect(o.files).toEqual(['', '42', '[object Object]', 'n'.repeat(255)]);
  expect(o.fileCount).toBe(4);
  expect(o.comment).toHaveLength(2000);
  release({});
});

test('a phase that rejects never surfaces (the 200 already went; the error is logged)', async () => {
  completion.completeClientUpload.mockRejectedValue(new Error('boom'));
  const r = await complete({ case_id: 'PVXC1RMM', files: ['a.pdf'] });
  expect(r.status).toBe(200);
  await settled(completion.completeClientUpload);
  await new Promise(res => setTimeout(res, 30));
  expect(console.error).toHaveBeenCalledWith('POST /api/public/upload-complete error:', expect.any(Error));
});

test('no files → 400, nothing handed off', async () => {
  const r = await complete({ case_id: 'PVXC1RMM', files: [] });
  expect(r.status).toBe(400);
  await settled(completion.completeClientUpload, 0);
  expect(completion.completeClientUpload).not.toHaveBeenCalled();
});


// ─────────────────────────────────────────────────────────────────────────────
// Docs intake S3 — the batch key on upload-complete
// ─────────────────────────────────────────────────────────────────────────────

describe('upload-complete with a batch key (S3)', () => {
  test('a valid key → 200 first, then finishByClient with the route-normalised batch; the direct phase is not called', async () => {
    const files = Array.from({ length: 51 }, (_, i) => `f${i}.pdf`);
    const r = await postFrom(freshAddr(), '/api/public/upload-complete', { case_id: 'PVXC1RMM', files, comment: 'c'.repeat(2100), batch: KEY });
    expect(r).toEqual({ status: 200, json: { status: 'success', message: 'Notification received. Thank you!' } });
    await settled(batches.finishByClient);
    expect(batches.finishByClient).toHaveBeenCalledTimes(1);
    const [db, o] = batches.finishByClient.mock.calls[0];
    expect(db).toBe(DB);
    expect(o).toEqual({ source: 'docreq', batchKey: KEY, caseId: 'PVXC1RMM', files: files.slice(0, 50), fileCount: 51, comment: 'c'.repeat(2000) });
    expect(completion.completeClientUpload).not.toHaveBeenCalled();
  });

  test('a malformed key → today\'s path exactly (old page builds; a notice is never dropped over a bad key)', async () => {
    for (const batch of ['short', 'not a key at all!!', 42, { k: KEY }, 'x'.repeat(41)]) {
      jest.clearAllMocks();
      completion.completeClientUpload.mockResolvedValue({});
      await postFrom(freshAddr(), '/api/public/upload-complete', { case_id: 'PVXC1RMM', files: ['a.pdf'], batch });
      await settled(completion.completeClientUpload);
      expect(batches.finishByClient).not.toHaveBeenCalled();
      expect(completion.completeClientUpload.mock.calls[0][1]).toEqual({ source: 'docreq', caseId: 'PVXC1RMM', files: ['a.pdf'], fileCount: 1, comment: null });
    }
  });

  test('no key → today\'s path; finishByClient never runs', async () => {
    completion.completeClientUpload.mockResolvedValue({});
    await postFrom(freshAddr(), '/api/public/upload-complete', { case_id: 'PVXC1RMM', files: ['a.pdf'] });
    await settled(completion.completeClientUpload);
    expect(batches.finishByClient).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Docs intake S3 — POST /api/public/upload-landed
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/public/upload-landed', () => {
  test('appends under the CANONICAL case id; caps the name and comment; the declared size is not stored', async () => {
    const r = await landedCall({ case_id: 'pvxc1rmm', batch: KEY, file: { name: 'n'.repeat(300), size: 12345 }, comment: 'c'.repeat(2500) });
    expect(r).toEqual({ status: 200, json: { status: 'success' } });
    expect(batches.landed).toHaveBeenCalledTimes(1);
    const [db, o] = batches.landed.mock.calls[0];
    expect(db).toBe(DB);
    expect(o).toEqual({ source: 'docreq', batchKey: KEY, caseId: 'PVXC1RMM', file: { name: 'n'.repeat(255) }, comment: 'c'.repeat(2000) });
  });

  test('a refused append is still a success to the page', async () => {
    batches.landed.mockResolvedValue({ accepted: false, reason: 'closed' });
    expect(await landedCall({ case_id: 'PVXC1RMM', batch: KEY, file: { name: 'a.pdf' } })).toEqual({ status: 200, json: { status: 'success' } });
  });

  test('ANSWERS AFTER THE WRITE: the 200 waits on the upsert', async () => {
    let releaseLanded;
    batches.landed.mockReturnValue(new Promise(r => { releaseLanded = r; }));
    const pending = landedCall({ case_id: 'PVXC1RMM', batch: KEY, file: { name: 'a.pdf' } });
    let timer;
    const outcome = await Promise.race([pending, new Promise(r => { timer = setTimeout(() => r('BLOCKED'), 200); })]);
    clearTimeout(timer);
    expect(outcome).toBe('BLOCKED');
    releaseLanded({ accepted: true });
    expect((await pending).status).toBe(200);
  });

  test('bad bodies → 400 before any DB work', async () => {
    for (const body of [
      { batch: KEY, file: { name: 'a.pdf' } },
      { case_id: 'PVXC1RMM', file: { name: 'a.pdf' } },
      { case_id: 'PVXC1RMM', batch: 'short', file: { name: 'a.pdf' } },
      { case_id: 'PVXC1RMM', batch: 'bad key with spaces!', file: { name: 'a.pdf' } },
      { case_id: 'PVXC1RMM', batch: 'x'.repeat(41), file: { name: 'a.pdf' } },
      { case_id: 'PVXC1RMM', batch: KEY },
      { case_id: 'PVXC1RMM', batch: KEY, file: 'a.pdf' },
      { case_id: 'PVXC1RMM', batch: KEY, file: { name: '   ' } },
      undefined,
    ]) {
      const r = await landedCall(body);
      expect(r).toEqual({ status: 400, json: { status: 'error', message: 'case_id, batch and file.name are required' } });
    }
    expect(DB.query).not.toHaveBeenCalled();
    expect(batches.landed).not.toHaveBeenCalled();
  });

  test('an unknown case → 404 with get-upload-link\'s wording; nothing appended', async () => {
    const r = await landedCall({ case_id: 'NOPE0000', batch: KEY, file: { name: 'a.pdf' } });
    expect(r).toEqual({ status: 404, json: { status: 'error', message: 'Case not found' } });
    expect(batches.landed).not.toHaveBeenCalled();
  });

  test('a DB failure → 500 (the page ignores it; upload-complete still reports the file)', async () => {
    batches.landed.mockRejectedValue(new Error('ER_NO_SUCH_TABLE: client_upload_batches'));
    const r = await landedCall({ case_id: 'PVXC1RMM', batch: KEY, file: { name: 'a.pdf' } });
    expect(r).toEqual({ status: 500, json: { status: 'error', message: 'Failed to record the upload' } });
    expect(console.error).toHaveBeenCalledWith('POST /api/public/upload-landed error:', expect.any(Error));
  });

  test('60/min per client (a 50-file run fits), then 429 without touching the service', async () => {
    const from = freshAddr();
    for (let i = 0; i < 60; i++) {
      expect((await landedCall({ case_id: 'PVXC1RMM', batch: KEY, file: { name: `f${i}.pdf` } }, from)).status).toBe(200);
    }
    const over = await landedCall({ case_id: 'PVXC1RMM', batch: KEY, file: { name: 'over.pdf' } }, from);
    expect(over).toEqual({ status: 429, json: { status: 'error', message: 'Too many requests, please try again shortly.' } });
    expect(batches.landed).toHaveBeenCalledTimes(60);
    // its own bucket: the run's upload-complete still goes through
    const done = await postFrom(from, '/api/public/upload-complete', { case_id: 'PVXC1RMM', files: ['a.pdf'], batch: KEY });
    expect(done.status).toBe(200);
  });
});
