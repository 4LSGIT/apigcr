/**
 * tests/hookHmacRawBody.test.js
 *
 * Per-hook HMAC authentication over the bytes on the wire (2026-09-03).
 *
 * The gap: server.js gave /hooks a json parser with a `verify` hook, but
 * form-encoded deliveries fell through to the GLOBAL express.urlencoded, which
 * has none. req.rawBody stayed unset, authenticateRequest fell back to
 * JSON.stringify(req.body), and the HMAC could not match — so every
 * form-encoded sender got "HMAC signature mismatch" and the operator went
 * looking for a wrong secret. Content-types no parser claimed at all
 * (text/plain, XML, vendor types) had the same problem.
 *
 * Not a vulnerability — the fallback fails CLOSED, since forging a signature
 * over "{}" still needs the secret. It is a functionality gap, and it was
 * latent: no live hook uses auth_type='hmac' yet.
 *
 * WHAT IS LOCKED SHUT
 *   1. A signature over form-encoded wire bytes verifies.
 *   2. A signature over an unparsed content-type's bytes verifies
 *      (rawBodyFallback), and req.body is NOT reshaped by that capture.
 *   3. An EMPTY body is signable — '' is falsy, so a truthiness check on
 *      rawBody would silently take the wrong branch.
 *   4. The Buffer is preferred over the string, so bytes that do not survive
 *      a UTF-8 round trip still verify.
 *   5. Missing raw body reports THAT, not a signature mismatch.
 *   6. A wrong signature is still rejected.
 *
 * Run: npx jest tests/hookHmacRawBody.test.js
 */

'use strict';

const crypto = require('crypto');
const { Readable } = require('stream');
const { authenticateRequest } = require('../services/hookService');
const { rawBodyFallback } = require('../lib/rawBodyFallback');

const SECRET = 's3cr3t-hook-key';

function hmacHook(overrides = {}) {
  return {
    auth_type: 'hmac',
    auth_config: { secret: SECRET, header: 'x-signature', algorithm: 'sha256', ...overrides },
  };
}

const sign = (bytes) => crypto.createHmac('sha256', SECRET).update(bytes).digest('hex');

// A request as the receiver sees it AFTER the parser chain.
function req({ rawBody, rawBodyBuf, body = {}, signature, contentType = 'application/json' }) {
  const headers = { 'content-type': contentType };
  if (signature !== undefined) headers['x-signature'] = signature;
  return { headers, body, ...(rawBody !== undefined ? { rawBody } : {}), ...(rawBodyBuf !== undefined ? { rawBodyBuf } : {}) };
}

// Drive the fallback middleware over a real stream.
function runFallback(bytes, { contentType = 'text/plain', preParsed = false } = {}) {
  return new Promise((resolve) => {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const r = new Readable({ read() { if (buf.length) this.push(buf); this.push(null); } });
    r.method = 'POST';
    r.headers = { 'content-type': contentType };
    r.body = {};
    if (preParsed) r._body = true;
    const res = { statusCode: null, status(c) { this.statusCode = c; return this; }, json() { resolve({ req: r, res, outcome: 'responded' }); return this; } };
    rawBodyFallback()(r, res, () => resolve({ req: r, res, outcome: 'next' }));
  });
}

describe('HMAC over form-encoded deliveries', () => {
  test('a signature over the urlencoded wire bytes verifies', () => {
    // What the scoped /hooks urlencoded parser now captures via `verify`.
    const wire = 'event=lead.created&email=ada%40example.com';
    const out = authenticateRequest(hmacHook(), req({
      contentType: 'application/x-www-form-urlencoded',
      rawBody: wire,
      rawBodyBuf: Buffer.from(wire),
      body: { event: 'lead.created', email: 'ada@example.com' },
      signature: sign(wire),
    }));
    expect(out).toEqual({ valid: true });
  });

  test('the old JSON.stringify(body) fallback would NOT have matched', () => {
    // Pins the reason the fix was needed rather than trusting the story.
    const wire = 'event=lead.created&email=ada%40example.com';
    const body = { event: 'lead.created', email: 'ada@example.com' };
    expect(sign(JSON.stringify(body))).not.toBe(sign(wire));
  });
});

describe('HMAC over content-types no parser claims', () => {
  test('rawBodyFallback captures the bytes and the signature verifies', async () => {
    const wire = '<notification><id>7</id></notification>';
    const { req: parsed, outcome } = await runFallback(wire, { contentType: 'application/xml' });

    expect(outcome).toBe('next');
    expect(authenticateRequest(hmacHook(), {
      headers: { 'content-type': 'application/xml', 'x-signature': sign(wire) },
      body: parsed.body,
      rawBody: parsed.rawBody,
      rawBodyBuf: parsed.rawBodyBuf,
    })).toEqual({ valid: true });
  });

  test('the fallback does not reshape req.body', async () => {
    const { req: parsed } = await runFallback('plain text payload');
    expect(parsed.body).toEqual({});          // unchanged — parsing is not its job
    expect(parsed.rawBody).toBe('plain text payload');
    expect(parsed._body).toBeUndefined();     // never claims to have parsed
  });

  test('an already-parsed request is left alone', async () => {
    const { req: parsed, outcome } = await runFallback('ignored', { preParsed: true });
    expect(outcome).toBe('next');
    expect(parsed.rawBody).toBeUndefined();
  });

  test('oversized bodies are refused with 413', async () => {
    const buf = Buffer.alloc(2048, 'x');
    const r = new Readable({ read() { this.push(buf); this.push(null); } });
    r.method = 'POST'; r.headers = {}; r.body = {};
    const done = new Promise((resolve) => {
      const res = { statusCode: null, status(c) { this.statusCode = c; return this; }, json() { resolve(this.statusCode); return this; } };
      rawBodyFallback({ limit: 64 })(r, res, () => resolve('next'));
    });
    await expect(done).resolves.toBe(413);
  });
});

describe('raw-body edge cases', () => {
  test('an EMPTY body is signable (the falsy-string trap)', async () => {
    const { req: parsed } = await runFallback('', { contentType: 'text/plain' });
    expect(parsed.rawBody).toBe('');

    expect(authenticateRequest(hmacHook(), {
      headers: { 'content-type': 'text/plain', 'x-signature': sign('') },
      body: {},
      rawBody: parsed.rawBody,
      rawBodyBuf: parsed.rawBodyBuf,
    })).toEqual({ valid: true });
  });

  test('the Buffer wins over the string for bytes that break a UTF-8 round trip', () => {
    const wire = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x22, 0x7d]); // invalid 0xff
    expect(Buffer.from(wire.toString(), 'utf8').equals(wire)).toBe(false);      // decode is lossy

    expect(authenticateRequest(hmacHook(), req({
      rawBody: wire.toString(),   // lossy — would fail on its own
      rawBodyBuf: wire,           // byte-exact — must be preferred
      signature: sign(wire),
    }))).toEqual({ valid: true });
  });

  test('missing raw body reports THAT, not a signature mismatch', () => {
    const out = authenticateRequest(hmacHook(), req({
      contentType: 'application/vnd.custom+xml',
      body: {},
      signature: sign('anything'),
    }));
    expect(out.valid).toBe(false);
    expect(out.error).toMatch(/raw body was not captured/);
    expect(out.error).toMatch(/application\/vnd\.custom\+xml/);
    expect(out.error).not.toMatch(/mismatch/);
  });
});

describe('rejections still reject', () => {
  test('a wrong signature fails', () => {
    const out = authenticateRequest(hmacHook(), req({ rawBody: '{"a":1}', signature: sign('{"a":2}') }));
    expect(out).toEqual({ valid: false, error: 'HMAC signature mismatch' });
  });

  test('a missing signature header fails before any raw-body work', () => {
    const out = authenticateRequest(hmacHook(), req({ rawBody: '{"a":1}' }));
    expect(out).toEqual({ valid: false, error: 'Missing HMAC signature' });
  });

  test("a provider's sha256= prefix is still stripped", () => {
    const out = authenticateRequest(hmacHook(), req({ rawBody: '{"a":1}', signature: `sha256=${sign('{"a":1}')}` }));
    expect(out).toEqual({ valid: true });
  });
});
