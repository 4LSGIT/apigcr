/**
 * lib/multipartBody.js — multipart/form-data body parser for webhook receivers.
 *
 * Why this exists (2026-09-03): server.js gives /hooks an express.json parser
 * and the app a global express.urlencoded. Neither handles multipart/form-data,
 * and Express does not error on a content-type it cannot parse — it leaves
 * `req.body` as `{}` and the handler stores an empty payload. So a sender that
 * posts multipart looked, from every screen we have, like a sender that posted
 * nothing.
 *
 * That is not hypothetical. Jotform posts submissions as multipart/form-data:
 * hook_executions 24678/24679 (slug jotform-dbkq) recorded
 * `content-length: 19632` next to `"body": {}` — 19 KB of form answers
 * silently discarded, with the headers right there in the same row proving
 * they had been sent. Anything that captures, replays or maps a hook payload
 * inherits the hole.
 *
 * Shape decisions, all chosen to match what express.urlencoded already
 * produces so hook authors see one body shape regardless of encoding:
 *
 *   • Fields land as strings. No JSON sniffing — a provider that packs its
 *     real payload into one field (Jotform's `rawRequest`) hands you a JSON
 *     STRING, and quietly parsing it would make the body shape depend on
 *     whether a value happened to look like JSON.
 *   • A repeated field name collapses to an array, like extended urlencoded.
 *   • File parts are DISCARDED, with metadata (never bytes) summarized under
 *     `__files`. raw_input is a JSON column; file contents could not be stored
 *     there anyway, and dropping them without a trace is how you get a second
 *     bug report identical to the first.
 *   • `req.rawBody` / `req.rawBodyBuf` are populated exactly as the scoped
 *     json/urlencoded parsers do, so per-hook HMAC authentication
 *     (hookService.authenticateRequest reads req.rawBody) keeps working for
 *     multipart senders.
 *
 * Bounded by design: the raw body is capped (413 past the limit) and file
 * bytes are counted, not kept.
 */

'use strict';

const Busboy = require('busboy');

const DEFAULT_LIMIT_BYTES = 10 * 1024 * 1024; // matches express.json({limit:'10mb'})

/**
 * Express middleware factory.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.limit]     max raw body bytes (413 beyond it)
 * @param {number}  [opts.fieldSize] max bytes per field value (busboy limit)
 * @param {number}  [opts.fields]    max field count (busboy limit)
 */
function multipartBody({ limit = DEFAULT_LIMIT_BYTES, fieldSize = 2 * 1024 * 1024, fields = 500 } = {}) {
  return function multipartBodyMiddleware(req, res, next) {
    // Another parser already claimed this request (express sets _body).
    if (req._body) return next();
    if (req.method === 'GET' || req.method === 'HEAD') return next();

    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (!ctype.startsWith('multipart/form-data')) return next();

    // Buffer the raw bytes first, then parse from the buffer. Streaming
    // straight into busboy would be leaner, but rawBody must survive for HMAC
    // verification and the stream is consumed exactly once — the parsers this
    // sits beside buffer too, under the same cap.
    const chunks = [];
    let received = 0;
    let aborted = false;

    const fail = (status, message) => {
      if (aborted) return;
      aborted = true;
      req.unpipe?.();
      req.resume();
      res.status(status).json({ status: 'error', message });
    };

    req.on('data', (chunk) => {
      if (aborted) return;
      received += chunk.length;
      if (received > limit) {
        return fail(413, 'Payload too large');
      }
      chunks.push(chunk);
    });

    req.on('error', () => fail(400, 'Request stream error'));

    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks);

      let bb;
      try {
        bb = Busboy({ headers: req.headers, limits: { fieldSize, fields } });
      } catch (err) {
        // Malformed content-type (e.g. a missing boundary). Treat it the way
        // an unparseable JSON body is treated: reject rather than pretend the
        // sender posted nothing.
        return fail(400, `Malformed multipart request: ${err.message}`);
      }

      const body = {};
      const files = [];

      const put = (name, value) => {
        if (!Object.prototype.hasOwnProperty.call(body, name)) {
          body[name] = value;
        } else if (Array.isArray(body[name])) {
          body[name].push(value);
        } else {
          body[name] = [body[name], value];
        }
      };

      bb.on('field', (name, value) => {
        // __proto__ / constructor as a field name would otherwise walk the
        // prototype chain on assignment.
        if (name === '__proto__' || name === 'constructor' || name === 'prototype') return;
        put(name, value);
      });

      bb.on('file', (name, stream, info) => {
        let bytes = 0;
        stream.on('data', (d) => { bytes += d.length; });
        stream.on('limit', () => { /* counted, still discarded */ });
        stream.on('end', () => {
          files.push({
            field: name,
            filename: info?.filename ?? null,
            mimetype: info?.mimeType ?? null,
            bytes,
          });
        });
        stream.resume(); // discard — see the header comment
      });

      bb.on('error', (err) => fail(400, `Malformed multipart request: ${err.message}`));

      bb.on('close', () => {
        if (aborted) return;
        if (files.length) body.__files = files;
        req.body = body;
        req.rawBody = raw.toString();
        req.rawBodyBuf = raw;
        req._body = true;
        next();
      });

      bb.end(raw);
    });
  };
}

module.exports = { multipartBody };
