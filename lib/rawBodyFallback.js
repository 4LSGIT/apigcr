/**
 * lib/rawBodyFallback.js — last-resort raw-body capture for webhook receivers.
 *
 * Per-hook HMAC authentication (hookService.authenticateRequest) verifies a
 * signature over the BYTES ON THE WIRE, so it needs `req.rawBody`. Those bytes
 * are captured by the `verify` hooks on the scoped json/urlencoded parsers and
 * by lib/multipartBody — but only for the content-types those parsers claim.
 * Anything else (text/plain, application/xml, a provider posting JSON under a
 * vendor content-type, a body with no content-type at all) reached the handler
 * with no rawBody at all.
 *
 * This middleware runs LAST in the /hooks parser chain and buffers whatever is
 * left, so HMAC works for every sender rather than for the two encodings we
 * happened to parse.
 *
 * It deliberately does NOT touch `req.body`. Setting it to a Buffer or a string
 * for unparsed content-types would change the shape every hook filter,
 * transform and mapper reads — a real behavior change smuggled in under a
 * signature fix. Unparsed bodies stay `{}` exactly as before; only the raw
 * bytes are now recorded alongside them.
 *
 * Both `req.rawBody` (string) and `req.rawBodyBuf` (Buffer) are set, matching
 * the /webhooks parsers: a UTF-8 decode turns invalid byte sequences into
 * U+FFFD, so re-encoding the string can differ from what the sender signed.
 * Verification should prefer the Buffer.
 */

'use strict';

const DEFAULT_LIMIT_BYTES = 10 * 1024 * 1024; // matches express.json({limit:'10mb'})

/**
 * Express middleware factory.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit] max raw body bytes (413 beyond it)
 */
function rawBodyFallback({ limit = DEFAULT_LIMIT_BYTES } = {}) {
  return function rawBodyFallbackMiddleware(req, res, next) {
    // A parser already claimed and consumed this request (express sets _body,
    // as does lib/multipartBody).
    if (req._body) return next();
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    // Already captured by a verify hook — nothing left on the stream.
    if (req.rawBody != null) return next();

    const chunks = [];
    let received = 0;
    let done = false;

    const finish = (fn) => {
      if (done) return;
      done = true;
      fn();
    };

    req.on('data', (chunk) => {
      if (done) return;
      received += chunk.length;
      if (received > limit) {
        return finish(() => {
          req.resume();
          res.status(413).json({ status: 'error', message: 'Payload too large' });
        });
      }
      chunks.push(chunk);
    });

    req.on('error', () => finish(() => {
      res.status(400).json({ status: 'error', message: 'Request stream error' });
    }));

    req.on('end', () => finish(() => {
      const raw = Buffer.concat(chunks);
      req.rawBodyBuf = raw;
      req.rawBody = raw.toString();
      // req.body is left alone on purpose — see the header comment.
      next();
    }));
  };
}

module.exports = { rawBodyFallback };
