/**
 * tests/hookHmacTimestamped.test.js
 *
 * Timestamped HMAC scheme for per-hook auth (2026-09-06) — the Calendly /
 * Stripe format:
 *
 *   <header>: t=<unix seconds>,v1=<hmac-sha256 hex>[,v1=<hex>…]
 *   signed payload = t + '.' + raw request body
 *
 * Motivating case: the native Calendly hooks (32 schedule / 40 cancel) ran
 * auth_type='none', and the cancel hook will cancel a real appointment for
 * any payload naming a real event URI — a leaked slug was a live forgery
 * risk. The legacy hmac path could not verify Calendly: its prefix-strip
 * regex (/^(sha\d+=|v1=)/) never matches a header that STARTS with "t=",
 * so the whole "t=…,v1=…" string fell into Buffer.from(…, 'hex') and
 * mismatched.
 *
 * WHAT IS LOCKED SHUT
 *   1. A correctly signed t.body verifies; the same signature with the
 *      legacy (schemeless) config does NOT — the scheme flag is load-bearing.
 *   2. A timestamp outside tolerance is rejected AS a tolerance failure
 *      (stale AND future — forward clock skew buys no replay window).
 *   3. Replaying a signature with a fresh t fails (t is inside the MAC).
 *   4. A tampered body fails; a wrong secret fails.
 *   5. Multiple v1 candidates: one valid among invalid/malformed ones passes
 *      (key-roll shape), and malformed candidates cannot make
 *      timingSafeEqual throw.
 *   6. Malformed headers (no t, no v1, garbage) are named as malformed, not
 *      as a mismatch.
 *   7. tolerance_seconds is honored; default is 300 when absent.
 *   8. The legacy schemeless path still passes its own format (regression).
 *
 * Run: npx jest tests/hookHmacTimestamped.test.js
 */

'use strict';

const crypto = require('crypto');
const { authenticateRequest } = require('../services/hookService');

const SECRET = 'calendly-signing-key-for-tests';

function tsHook(overrides = {}) {
  return {
    auth_type: 'hmac',
    auth_config: {
      scheme: 'timestamped',
      secret: SECRET,
      header: 'calendly-webhook-signature',
      algorithm: 'sha256',
      tolerance_seconds: 180,
      ...overrides,
    },
  };
}

const nowSec = () => Math.floor(Date.now() / 1000);

function signTs(t, body, secret = SECRET) {
  return crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
}

function req({ rawBody, signature, header = 'calendly-webhook-signature' }) {
  const headers = { 'content-type': 'application/json' };
  if (signature !== undefined) headers[header] = signature;
  return { headers, body: {}, rawBody, rawBodyBuf: Buffer.from(rawBody ?? '') };
}

const BODY = '{"event":"invitee.canceled","payload":{"name":"Test"}}';

describe('timestamped scheme — the happy path and the scheme flag', () => {
  test('a correctly signed t.body verifies', () => {
    const t = nowSec();
    const out = authenticateRequest(tsHook(), req({
      rawBody: BODY,
      signature: `t=${t},v1=${signTs(t, BODY)}`,
    }));
    expect(out).toEqual({ valid: true });
  });

  test('the SAME header fails under the legacy schemeless config', () => {
    // Pins why the scheme exists: legacy hmac cannot parse t=…,v1=… at all.
    const t = nowSec();
    const out = authenticateRequest(
      { auth_type: 'hmac', auth_config: { secret: SECRET, header: 'calendly-webhook-signature' } },
      req({ rawBody: BODY, signature: `t=${t},v1=${signTs(t, BODY)}` })
    );
    expect(out.valid).toBe(false);
  });
});

describe('timestamped scheme — replay window', () => {
  test('a stale timestamp is rejected as a tolerance failure', () => {
    const t = nowSec() - 3600;
    const out = authenticateRequest(tsHook(), req({
      rawBody: BODY,
      signature: `t=${t},v1=${signTs(t, BODY)}`,
    }));
    expect(out.valid).toBe(false);
    expect(out.error).toMatch(/timestamp outside tolerance/);
    expect(out.error).not.toMatch(/mismatch/);
  });

  test('a FUTURE timestamp beyond tolerance is equally rejected', () => {
    const t = nowSec() + 3600;
    const out = authenticateRequest(tsHook(), req({
      rawBody: BODY,
      signature: `t=${t},v1=${signTs(t, BODY)}`,
    }));
    expect(out.valid).toBe(false);
    expect(out.error).toMatch(/timestamp outside tolerance/);
  });

  test('replaying an old signature with a fresh t fails — t is inside the MAC', () => {
    const oldT = nowSec() - 30;
    const freshT = nowSec();
    const out = authenticateRequest(tsHook(), req({
      rawBody: BODY,
      signature: `t=${freshT},v1=${signTs(oldT, BODY)}`,
    }));
    expect(out).toEqual({ valid: false, error: 'HMAC signature mismatch' });
  });

  test('tolerance_seconds is honored; absent → default 300', () => {
    const t = nowSec() - 250; // inside 300, outside 180
    const strict = authenticateRequest(tsHook(), req({
      rawBody: BODY, signature: `t=${t},v1=${signTs(t, BODY)}`,
    }));
    expect(strict.valid).toBe(false);

    const dflt = authenticateRequest(tsHook({ tolerance_seconds: undefined }), req({
      rawBody: BODY, signature: `t=${t},v1=${signTs(t, BODY)}`,
    }));
    expect(dflt).toEqual({ valid: true });
  });
});

describe('timestamped scheme — rejections still reject', () => {
  test('a tampered body fails', () => {
    const t = nowSec();
    const out = authenticateRequest(tsHook(), req({
      rawBody: BODY.replace('Test', 'Evil'),
      signature: `t=${t},v1=${signTs(t, BODY)}`,
    }));
    expect(out).toEqual({ valid: false, error: 'HMAC signature mismatch' });
  });

  test('a wrong secret fails', () => {
    const t = nowSec();
    const out = authenticateRequest(tsHook(), req({
      rawBody: BODY,
      signature: `t=${t},v1=${signTs(t, BODY, 'not-the-key')}`,
    }));
    expect(out).toEqual({ valid: false, error: 'HMAC signature mismatch' });
  });

  test.each([
    ['no v1',          () => `t=${nowSec()}`],
    ['no t',           () => `v1=${signTs(nowSec(), BODY)}`],
    ['non-numeric t',  () => `t=soon,v1=${signTs(nowSec(), BODY)}`],
    ['garbage',        () => 'not-a-signature-header'],
  ])('malformed header (%s) is named malformed, not mismatch', (_label, mk) => {
    const out = authenticateRequest(tsHook(), req({ rawBody: BODY, signature: mk() }));
    expect(out.valid).toBe(false);
    expect(out.error).toBe('Malformed timestamped signature header');
  });

  test('missing raw body reports THAT, not a mismatch', () => {
    const t = nowSec();
    const out = authenticateRequest(tsHook(), {
      headers: {
        'content-type': 'application/vnd.custom+json',
        'calendly-webhook-signature': `t=${t},v1=${signTs(t, BODY)}`,
      },
      body: {},
    });
    expect(out.valid).toBe(false);
    expect(out.error).toMatch(/raw body was not captured/);
  });
});

describe('timestamped scheme — multiple v1 candidates (key roll shape)', () => {
  test('one valid candidate among invalid and malformed ones passes', () => {
    const t = nowSec();
    const out = authenticateRequest(tsHook(), req({
      rawBody: BODY,
      signature: `t=${t},v1=deadbeef,v1=not-hex-at-all,v1=${signTs(t, BODY)}`,
    }));
    expect(out).toEqual({ valid: true });
  });

  test('all-invalid candidates fail without throwing', () => {
    const t = nowSec();
    const out = authenticateRequest(tsHook(), req({
      rawBody: BODY,
      signature: `t=${t},v1=deadbeef,v1=zzzz`,
    }));
    expect(out).toEqual({ valid: false, error: 'HMAC signature mismatch' });
  });
});

describe('legacy schemeless path — regression', () => {
  test('a plain body signature with no scheme still verifies', () => {
    const sig = crypto.createHmac('sha256', SECRET).update(BODY).digest('hex');
    const out = authenticateRequest(
      { auth_type: 'hmac', auth_config: { secret: SECRET, header: 'x-signature' } },
      { headers: { 'content-type': 'application/json', 'x-signature': sig },
        body: {}, rawBody: BODY, rawBodyBuf: Buffer.from(BODY) }
    );
    expect(out).toEqual({ valid: true });
  });
});
