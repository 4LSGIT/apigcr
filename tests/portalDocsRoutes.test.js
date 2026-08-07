// tests/portalDocsRoutes.test.js
//
// Client Portal Slice 3 ROUTE layer — routes/portal.docs.js. The service has
// its own suite (tests/portalDocsService.test.js); this one covers only what
// the route itself owns and nothing below it:
//
//   • the { status:'success' | 'error' } envelope and its EXACT field set
//     (case_dropbox / placement / ctx internals must not leak through)
//   • respondError's mapping: .status 404 → uniform 'Not found',
//     .status 400 → the service's client-safe message passed through,
//     anything else → 500 'Server error' with the real message swallowed
//   • the ORACLE posture: out-of-scope case, nonexistent case and foreign
//     itemId all produce byte-identical 404 bodies
//   • req.portalCaseId attribution — set from the service's canonical id on
//     success AND on rejected requests (portal_access_log names the case
//     either way). Captured here via a res.on('finish') hook, which is
//     exactly how lib/auth.requireAuth reads it in production.
//   • body → service argument mapping (item_id→itemId, content_type→
//     contentType) and the `req.body || {}` guard
//   • RESPOND-FIRST sequencing on upload-complete: the 200 must not wait on
//     sendUploadNotifications, and a rejected side-effect promise must not
//     surface as an unhandled rejection
//   • the per-IP limiters, driven through the REAL lib/rateLimiter (30/min
//     upload-link, 10/min upload-complete) including XFF-LAST keying
//
// DRIVEN OVER REAL HTTP. routes/portal.docs.js exports only the router — no
// internals — so unlike tests/portalAccessAdmin.test.js there is no exported
// handler to call directly. Mounting the real router in a real express app on
// an ephemeral port is the honest alternative and needs no new dependency
// (express is a prod dep; fetch is global on Node 18+). It also exercises the
// json body parser and status/serialisation for real.
//
// MOCKED: services/portalDocsService (this suite is about the route) and
// lib/auth.requireAuth (a passthrough that injects req.auth — the real
// middleware's JWT / kill-switch / session-version semantics are already
// covered by tests/portalAuth.test.js; the only thing THIS route owns is
// that it mounts it with audience 'contact', asserted below).
// NOT mocked: lib/rateLimiter — the limiters are the route's own decision.
//
// Run:
//   npx jest tests/portalDocsRoutes.test.js

'use strict';

const CONTACT_ID = 4242;

jest.mock('../services/portalDocsService', () => ({
  listDocs: jest.fn(),
  createUploadLink: jest.fn(),
  completeUpload: jest.fn(),
  sendUploadNotifications: jest.fn(),
}));

jest.mock('../lib/auth.requireAuth', () => {
  const factory = jest.fn(() => (req, res, next) => {
    req.auth = { type: 'portal', contactId: 4242 };
    next();
  });
  return factory;
});

const express     = require('express');
const requireAuth = require('../lib/auth.requireAuth');
const portalDocs  = require('../services/portalDocsService');
const router      = require('../routes/portal.docs');

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const DB = { marker: 'pool' };          // identity-checked, never queried

/** res.on('finish') captures — one entry per completed request, in order. */
let finished = [];

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.db = DB;                          // server.js:119 equivalent
  // Mirrors lib/auth.requireAuth's contact-path hook: the access-log row is
  // written on finish, so portalCaseId is read AFTER the handler ran.
  res.on('finish', () => finished.push({
    status: res.statusCode,
    portalCaseId: req.portalCaseId,
  }));
  next();
});
app.use(router);

let server;
let base;

beforeAll(done => {
  server = app.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll(done => {
  // closeAllConnections: undici (global fetch) keeps sockets alive, so a bare
  // close() would wait on them. And close's callback must be swallowed — jest's
  // `done` treats any argument as a failure.
  server.closeAllConnections?.();
  server.close(() => done());
});

beforeEach(() => { finished = []; });
afterEach(() => jest.clearAllMocks());

/** Fresh limiter bucket per test unless a test deliberately reuses one. */
let ipSeq = 0;
function freshIp() { return `192.0.2.${(ipSeq++ % 250) + 1}`; }

/**
 * One request. The XFF carries a spoofed FIRST element on purpose — the
 * limiter must key on the LAST (the GFE-appended peer), so a rotating prefix
 * must not hand out fresh buckets.
 */
async function call(method, path, { body, ip = freshIp(), xffPrefix = '198.51.100.9' } = {}) {
  const headers = { 'x-forwarded-for': `${xffPrefix}, ${ip}` };
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, headers, body: payload });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

const DOCS_URL     = '/api/portal/cases/AbCdEf12/docs';
const LINK_URL     = '/api/portal/cases/AbCdEf12/docs/upload-link';
const COMPLETE_URL = '/api/portal/cases/AbCdEf12/docs/upload-complete';

const NOT_FOUND = { status: 'error', message: 'Not found' };

/** Silence the route's expected console.error noise. */
let errSpy;
beforeAll(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterAll(() => errSpy.mockRestore());

// ─────────────────────────────────────────────────────────────────────────────
// Mounting
// ─────────────────────────────────────────────────────────────────────────────

describe('mounting', () => {
  test('every route sits behind requireAuth({audience:"contact"})', () => {
    // The staff audience must never appear here — a portal route authenticated
    // as staff would hand any logged-in employee a client session shape.
    expect(requireAuth).toHaveBeenCalledTimes(3);
    for (const c of requireAuth.mock.calls) {
      expect(c[0]).toEqual({ audience: 'contact' });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /docs
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/portal/cases/:caseId/docs', () => {
  test('success → envelope is EXACTLY status/case_id/has_upload/items', async () => {
    portalDocs.listDocs.mockResolvedValue({
      case_id: 'AbCdEf12',
      has_upload: true,
      items: [{ id: 7, name: 'Pay stubs', status: 'needed' }],
      // A service that ever widened its return must not widen the response.
      case_dropbox: 'https://www.dropbox.com/sh/secret',
    });

    const res = await call('GET', DOCS_URL);

    expect(res.status).toBe(200);
    expect(Object.keys(res.json).sort())
      .toEqual(['case_id', 'has_upload', 'items', 'status']);
    expect(res.json.status).toBe('success');
    expect(res.json.items).toEqual([{ id: 7, name: 'Pay stubs', status: 'needed' }]);
    expect(JSON.stringify(res.json)).not.toContain('dropbox.com');
  });

  test('service receives (db, authed contactId, raw :caseId) — never a body-supplied id', async () => {
    portalDocs.listDocs.mockResolvedValue({ case_id: 'AbCdEf12', has_upload: true, items: [] });
    await call('GET', '/api/portal/cases/ABCDEF12/docs');
    expect(portalDocs.listDocs).toHaveBeenCalledWith(DB, CONTACT_ID, 'ABCDEF12');
  });

  test('null (out of scope / nonexistent) → uniform 404', async () => {
    portalDocs.listDocs.mockResolvedValue(null);
    const res = await call('GET', DOCS_URL);
    expect(res.status).toBe(404);
    expect(res.json).toEqual(NOT_FOUND);
  });

  test('portalCaseId is attributed from the CANONICAL id, not the request casing', async () => {
    portalDocs.listDocs.mockResolvedValue({ case_id: 'AbCdEf12', has_upload: true, items: [] });
    await call('GET', '/api/portal/cases/ABCDEF12/docs');
    expect(finished).toHaveLength(1);
    expect(finished[0].portalCaseId).toBe('AbCdEf12');
  });

  test('a 404 leaves portalCaseId unset — nothing to attribute when scope failed', async () => {
    portalDocs.listDocs.mockResolvedValue(null);
    await call('GET', DOCS_URL);
    expect(finished[0]).toEqual({ status: 404, portalCaseId: undefined });
  });

  test('a thrown service error → 500 with the internal message swallowed', async () => {
    portalDocs.listDocs.mockRejectedValue(new Error('ER_PARSE_ERROR near checkitems'));
    const res = await call('GET', DOCS_URL);
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ status: 'error', message: 'Server error' });
    expect(JSON.stringify(res.json)).not.toMatch(/checkitems|ER_PARSE/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /docs/upload-link
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/portal/cases/:caseId/docs/upload-link', () => {
  test('success → { status, link } only; case_id and ladder internals stay server-side', async () => {
    portalDocs.createUploadLink.mockResolvedValue({ case_id: 'AbCdEf12', link: 'https://up' });
    const res = await call('POST', LINK_URL, { body: { filename: 'a.pdf', size: 100 } });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'success', link: 'https://up' });
    expect(finished[0].portalCaseId).toBe('AbCdEf12');
  });

  test('body maps snake_case → the service opts (item_id→itemId, content_type→contentType)', async () => {
    portalDocs.createUploadLink.mockResolvedValue({ case_id: 'AbCdEf12', link: 'https://up' });
    await call('POST', LINK_URL, {
      body: { item_id: 7, filename: 'a.pdf', size: 100, content_type: 'application/pdf', bogus: 'x' },
    });

    expect(portalDocs.createUploadLink).toHaveBeenCalledWith(
      DB, CONTACT_ID, 'AbCdEf12',
      { itemId: 7, filename: 'a.pdf', size: 100, contentType: 'application/pdf' }
    );
    // Unknown body keys are dropped by the destructure, not forwarded.
    expect(Object.keys(portalDocs.createUploadLink.mock.calls[0][3]).sort())
      .toEqual(['contentType', 'filename', 'itemId', 'size']);
  });

  test('a bodyless POST does not crash — the service gets undefineds and rules on them', async () => {
    const err = new Error('filename is required');
    err.status = 400; err.portalCaseId = 'AbCdEf12';
    portalDocs.createUploadLink.mockRejectedValue(err);

    const res = await call('POST', LINK_URL);       // no content-type, no body

    expect(res.status).toBe(400);
    expect(portalDocs.createUploadLink.mock.calls[0][3])
      .toEqual({ itemId: undefined, filename: undefined, size: undefined, contentType: undefined });
  });

  test('validation error (.status 400) → the client-safe message reaches the client verbatim', async () => {
    const err = new Error('Files must be 50 MB or smaller.');
    err.status = 400; err.portalCaseId = 'AbCdEf12';
    portalDocs.createUploadLink.mockRejectedValue(err);

    const res = await call('POST', LINK_URL, { body: { filename: 'a.pdf', size: 9e9 } });

    expect(res.status).toBe(400);
    expect(res.json).toEqual({ status: 'error', message: 'Files must be 50 MB or smaller.' });
    // Rejected requests are still attributed to the case in portal_access_log.
    expect(finished[0].portalCaseId).toBe('AbCdEf12');
  });

  test('foreign itemId (.status 404) → byte-identical to the out-of-scope 404 (no probing oracle)', async () => {
    portalDocs.createUploadLink.mockResolvedValue(null);
    const scopeMiss = await call('POST', LINK_URL, { body: { filename: 'a.pdf', size: 100 } });

    const err = new Error('Not found');
    err.status = 404; err.portalCaseId = 'AbCdEf12';
    portalDocs.createUploadLink.mockRejectedValue(err);
    const itemMiss = await call('POST', LINK_URL, { body: { itemId: 999, filename: 'a.pdf', size: 100 } });

    expect(scopeMiss.status).toBe(404);
    expect(itemMiss.status).toBe(404);
    expect(JSON.stringify(itemMiss.json)).toBe(JSON.stringify(scopeMiss.json));
    expect(itemMiss.json).toEqual(NOT_FOUND);
    // The only distinguishable trace is server-side, in the access log.
    expect(finished[0].portalCaseId).toBeUndefined();
    expect(finished[1].portalCaseId).toBe('AbCdEf12');
  });

  test('an unclassified error → 500 Server error, message swallowed, case still attributed', async () => {
    const err = new Error('unsorted upload fallback failed (dropbox 503)');
    err.portalCaseId = 'AbCdEf12';                 // no .status
    portalDocs.createUploadLink.mockRejectedValue(err);

    const res = await call('POST', LINK_URL, { body: { filename: 'a.pdf', size: 100 } });

    expect(res.status).toBe(500);
    expect(res.json).toEqual({ status: 'error', message: 'Server error' });
    expect(JSON.stringify(res.json)).not.toMatch(/dropbox|fallback/i);
    expect(finished[0].portalCaseId).toBe('AbCdEf12');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /docs/upload-complete
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/portal/cases/:caseId/docs/upload-complete', () => {
  const body = { files: [{ name: 'a.pdf', item_id: 7 }], comment: 'here you go' };

  test('success → fixed acknowledgement; the ctx never reaches the client', async () => {
    const ctx = {
      case_id: 'AbCdEf12', contact_id: CONTACT_ID, clientName: 'Jane Doe',
      dropboxLink: 'https://www.dropbox.com/sh/secret', files: [], fileCount: 1,
    };
    portalDocs.completeUpload.mockResolvedValue(ctx);
    portalDocs.sendUploadNotifications.mockResolvedValue([]);

    const res = await call('POST', COMPLETE_URL, { body });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'success', message: 'Notification received. Thank you!' });
    expect(JSON.stringify(res.json)).not.toContain('dropbox.com');
    expect(portalDocs.completeUpload).toHaveBeenCalledWith(
      DB, CONTACT_ID, 'AbCdEf12', { files: body.files, comment: 'here you go' }
    );
    expect(finished[0].portalCaseId).toBe('AbCdEf12');
  });

  test('RESPOND-FIRST: the 200 lands while sendUploadNotifications is still pending', async () => {
    // The side effects hit Dropbox, SMTP and the log table. If res.json() ever
    // moved BELOW the side-effect call, a slow SMTP would become client-visible
    // latency on the upload page. A promise that never settles pins the
    // ordering — and the response is RACED against a timer rather than simply
    // awaited, so the regression fails in 300ms with a legible message instead
    // of as an opaque 5s jest timeout.
    let released;
    portalDocs.completeUpload.mockResolvedValue({ case_id: 'AbCdEf12' });
    portalDocs.sendUploadNotifications.mockReturnValue(
      new Promise(resolve => { released = resolve; })
    );

    let timer;
    const outcome = await Promise.race([
      call('POST', COMPLETE_URL, { body }),
      new Promise(r => { timer = setTimeout(() => r('BLOCKED'), 300); }),
    ]);
    clearTimeout(timer);

    expect(outcome).not.toBe('BLOCKED');            // res.json() must precede the side effects
    expect(outcome.status).toBe(200);
    expect(portalDocs.sendUploadNotifications).toHaveBeenCalledWith(DB, { case_id: 'AbCdEf12' });
    released([]);                                   // don't leak a pending promise
  });

  test('a rejected side-effect promise is caught — no unhandled rejection after the 200', async () => {
    const unhandled = [];
    const onUnhandled = e => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      portalDocs.completeUpload.mockResolvedValue({ case_id: 'AbCdEf12' });
      portalDocs.sendUploadNotifications.mockRejectedValue(new Error('smtp + dropbox both down'));

      const res = await call('POST', COMPLETE_URL, { body });
      expect(res.status).toBe(200);

      // Give the microtask queue + one macrotask turn to surface a rejection.
      await new Promise(r => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('side effects are NOT fired when the request was rejected', async () => {
    portalDocs.completeUpload.mockResolvedValue(null);
    const res = await call('POST', COMPLETE_URL, { body });
    expect(res.status).toBe(404);
    expect(res.json).toEqual(NOT_FOUND);
    expect(portalDocs.sendUploadNotifications).not.toHaveBeenCalled();

    const err = new Error('files array is required');
    err.status = 400; err.portalCaseId = 'AbCdEf12';
    portalDocs.completeUpload.mockRejectedValue(err);
    const res2 = await call('POST', COMPLETE_URL, { body: {} });
    expect(res2.status).toBe(400);
    expect(res2.json).toEqual({ status: 'error', message: 'files array is required' });
    expect(portalDocs.sendUploadNotifications).not.toHaveBeenCalled();
  });

  test('an unclassified error → 500 Server error', async () => {
    portalDocs.completeUpload.mockRejectedValue(new Error('ECONNRESET reading contacts'));
    const res = await call('POST', COMPLETE_URL, { body });
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ status: 'error', message: 'Server error' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting (real lib/rateLimiter)
// ─────────────────────────────────────────────────────────────────────────────

describe('rate limiting', () => {
  test('upload-link: 30/min/IP, then 429 without touching the service', async () => {
    portalDocs.createUploadLink.mockResolvedValue({ case_id: 'AbCdEf12', link: 'https://up' });
    const ip = freshIp();
    const b = { filename: 'a.pdf', size: 100 };

    for (let i = 0; i < 30; i++) {
      const r = await call('POST', LINK_URL, { body: b, ip });
      expect(r.status).toBe(200);
    }
    expect(portalDocs.createUploadLink).toHaveBeenCalledTimes(30);

    const over = await call('POST', LINK_URL, { body: b, ip });
    expect(over.status).toBe(429);
    expect(over.json).toEqual({
      status: 'error',
      message: 'Too many requests. Please try again later.',
    });
    expect(portalDocs.createUploadLink).toHaveBeenCalledTimes(30);   // never reached
  });

  test('upload-complete: 10/min/IP — the tighter cap, side effects cost more', async () => {
    portalDocs.completeUpload.mockResolvedValue({ case_id: 'AbCdEf12' });
    portalDocs.sendUploadNotifications.mockResolvedValue([]);
    const ip = freshIp();
    const b = { files: [{ name: 'a.pdf' }] };

    for (let i = 0; i < 10; i++) {
      expect((await call('POST', COMPLETE_URL, { body: b, ip })).status).toBe(200);
    }
    const over = await call('POST', COMPLETE_URL, { body: b, ip });
    expect(over.status).toBe(429);
    expect(portalDocs.completeUpload).toHaveBeenCalledTimes(10);
  });

  test('the buckets are per-route: exhausting upload-complete leaves upload-link usable', async () => {
    portalDocs.completeUpload.mockResolvedValue({ case_id: 'AbCdEf12' });
    portalDocs.sendUploadNotifications.mockResolvedValue([]);
    portalDocs.createUploadLink.mockResolvedValue({ case_id: 'AbCdEf12', link: 'https://up' });
    const ip = freshIp();

    for (let i = 0; i < 11; i++) await call('POST', COMPLETE_URL, { body: { files: [1] }, ip });
    const link = await call('POST', LINK_URL, { body: { filename: 'a.pdf', size: 100 }, ip });
    expect(link.status).toBe(200);
  });

  test('a rotating X-Forwarded-For PREFIX does not mint fresh buckets (XFF-LAST keying)', async () => {
    // The bypass this keying exists to close: if the limiter took the FIRST
    // element, a client-supplied prefix would give an attacker one bucket per
    // request while rate-limiting everyone honest.
    portalDocs.completeUpload.mockResolvedValue({ case_id: 'AbCdEf12' });
    portalDocs.sendUploadNotifications.mockResolvedValue([]);
    const ip = freshIp();
    const b = { files: [{ name: 'a.pdf' }] };

    for (let i = 0; i < 10; i++) {
      await call('POST', COMPLETE_URL, { body: b, ip, xffPrefix: `203.0.113.${i}` });
    }
    const over = await call('POST', COMPLETE_URL, { body: b, ip, xffPrefix: '203.0.113.99' });
    expect(over.status).toBe(429);
  });

  test('GET docs carries no limiter — authed reads are unlimited (S2 precedent)', async () => {
    portalDocs.listDocs.mockResolvedValue({ case_id: 'AbCdEf12', has_upload: true, items: [] });
    const ip = freshIp();
    for (let i = 0; i < 40; i++) {
      expect((await call('GET', DOCS_URL, { ip })).status).toBe(200);
    }
  });
});