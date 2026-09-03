/**
 * tests/multipartBody.test.js
 *
 * multipart/form-data parsing for /hooks (2026-09-03).
 *
 * The hole it closes: Express does not error on a content-type no parser
 * claims — it leaves req.body = {} and the receiver stores an empty payload,
 * so a 19 KB Jotform submission and a genuinely empty POST are indistinguish-
 * able by the time anyone looks. Live evidence: hook_executions 24678
 * (slug jotform-dbkq) recorded `content-length: 19632` next to `"body": {}`.
 *
 * WHAT IS LOCKED SHUT
 *   1. Fields parse, as STRINGS — no JSON sniffing, so a provider that packs
 *      its payload into one field (Jotform's `rawRequest`) yields a stable
 *      shape rather than one that depends on whether a value looks like JSON.
 *   2. Repeated names collapse to arrays, matching extended urlencoded.
 *   3. File parts are discarded but SUMMARIZED under `__files` — dropping
 *      them silently is the bug being fixed, one layer down.
 *   4. rawBody/rawBodyBuf are populated so per-hook HMAC auth
 *      (hookService.authenticateRequest reads req.rawBody) still works.
 *   5. Non-multipart requests and already-parsed bodies pass straight through
 *      untouched.
 *   6. Prototype-polluting field names are dropped.
 *
 * Run: npx jest tests/multipartBody.test.js
 */

'use strict';

const { Readable } = require('stream');
const { multipartBody } = require('../lib/multipartBody');

const BOUNDARY = '----jesttestboundary';

// Build a real multipart body — the parser is exercised over wire bytes, not
// a hand-made object, so a boundary/CRLF mistake fails here rather than live.
function buildMultipart(parts) {
  const chunks = [];
  for (const p of parts) {
    let head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) head += `; filename="${p.filename}"`;
    head += '\r\n';
    if (p.contentType) head += `Content-Type: ${p.contentType}\r\n`;
    head += '\r\n';
    chunks.push(Buffer.from(head), Buffer.from(p.value), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

// Minimal req/res doubles. req is a real Readable so the middleware's data/end
// handling is exercised for real.
function run(middleware, { body, contentType = `multipart/form-data; boundary=${BOUNDARY}`, method = 'POST', preParsed = false } = {}) {
  return new Promise((resolve) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
    const req = new Readable({ read() { this.push(buf.length ? buf : null); this.push(null); } });
    req.method = method;
    req.headers = { 'content-type': contentType, 'content-length': String(buf.length) };
    req.body = {};
    if (preParsed) req._body = true;

    const res = {
      statusCode: null,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(obj) { this.payload = obj; resolve({ req, res, outcome: 'responded' }); return this; },
    };

    middleware(req, res, () => resolve({ req, res, outcome: 'next' }));
  });
}

describe('multipartBody', () => {
  test('parses form fields that Express would otherwise drop', async () => {
    const mw = multipartBody();
    const { req, outcome } = await run(mw, {
      body: buildMultipart([
        { name: 'formID', value: '250123456789' },
        { name: 'submissionID', value: '6100000000000000' },
        { name: 'rawRequest', value: '{"q1_name":{"first":"Ada"},"q2_email":"ada@example.com"}' },
      ]),
    });

    expect(outcome).toBe('next');
    expect(req.body.formID).toBe('250123456789');
    expect(req.body.submissionID).toBe('6100000000000000');
    // Left as a STRING on purpose — no JSON sniffing.
    expect(typeof req.body.rawRequest).toBe('string');
    expect(JSON.parse(req.body.rawRequest).q2_email).toBe('ada@example.com');
    expect(req._body).toBe(true);
  });

  test('repeated field names collapse to an array', async () => {
    const { req } = await run(multipartBody(), {
      body: buildMultipart([
        { name: 'tag', value: 'one' },
        { name: 'tag', value: 'two' },
        { name: 'tag', value: 'three' },
      ]),
    });
    expect(req.body.tag).toEqual(['one', 'two', 'three']);
  });

  test('file parts are discarded but summarized, never silently lost', async () => {
    const { req } = await run(multipartBody(), {
      body: buildMultipart([
        { name: 'formID', value: '42' },
        { name: 'upload', filename: 'scan.pdf', contentType: 'application/pdf', value: 'PDFBYTES-1234567890' },
      ]),
    });

    expect(req.body.formID).toBe('42');
    expect(req.body.upload).toBeUndefined();     // bytes never enter the body
    expect(req.body.__files).toEqual([
      { field: 'upload', filename: 'scan.pdf', mimetype: 'application/pdf', bytes: 19 },
    ]);
  });

  test('__files is absent when no files were sent', async () => {
    const { req } = await run(multipartBody(), {
      body: buildMultipart([{ name: 'a', value: 'b' }]),
    });
    expect(Object.prototype.hasOwnProperty.call(req.body, '__files')).toBe(false);
  });

  test('rawBody survives for HMAC verification', async () => {
    const raw = buildMultipart([{ name: 'a', value: 'b' }]);
    const { req } = await run(multipartBody(), { body: raw });

    expect(req.rawBodyBuf.equals(raw)).toBe(true);
    expect(req.rawBody).toBe(raw.toString());
  });

  test('prototype-polluting field names are dropped', async () => {
    const { req } = await run(multipartBody(), {
      body: buildMultipart([
        { name: '__proto__', value: '{"polluted":true}' },
        { name: 'safe', value: 'yes' },
      ]),
    });

    expect(req.body.safe).toBe('yes');
    expect({}.polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(req.body, '__proto__')).toBe(false);
  });

  test('non-multipart requests pass through untouched', async () => {
    const { req, outcome } = await run(multipartBody(), {
      body: '{"already":"json"}',
      contentType: 'application/json',
    });
    expect(outcome).toBe('next');
    expect(req.body).toEqual({});   // left for express.json
    expect(req._body).toBeUndefined();
  });

  test('an already-parsed body is never re-read', async () => {
    const { req, outcome } = await run(multipartBody(), {
      body: buildMultipart([{ name: 'a', value: 'b' }]),
      preParsed: true,
    });
    expect(outcome).toBe('next');
    expect(req.body).toEqual({});
  });

  test('oversized payloads are refused with 413, not truncated', async () => {
    const mw = multipartBody({ limit: 64 });
    const { res, outcome } = await run(mw, {
      body: buildMultipart([{ name: 'big', value: 'x'.repeat(500) }]),
    });
    expect(outcome).toBe('responded');
    expect(res.statusCode).toBe(413);
  });

  test('a missing boundary is refused rather than read as an empty body', async () => {
    const { res, outcome } = await run(multipartBody(), {
      body: 'whatever',
      contentType: 'multipart/form-data',
    });
    expect(outcome).toBe('responded');
    expect(res.statusCode).toBe(400);
    expect(res.payload.message).toMatch(/multipart/i);
  });
});
