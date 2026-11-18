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
// DRIVEN OVER REAL HTTP, the tests/portalDocsRoutes.test.js way: the real
// router in a real express app on an ephemeral port (express is a prod dep;
// fetch is global).
//
// Run:
//   npx jest tests/docReqUploadComplete.test.js

'use strict';

jest.mock('../services/clientUploadCompletionService', () => ({ completeClientUpload: jest.fn() }));
jest.mock('../services/uploadTargetService', () => ({ issueClientUploadLink: jest.fn() }));

const express = require('express');
const completion = require('../services/clientUploadCompletionService');
const router = require('../routes/api.checklists');

const DB = { marker: 'pool' };   // identity-checked, never queried by this route
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
