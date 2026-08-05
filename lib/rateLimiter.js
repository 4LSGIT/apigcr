// lib/rateLimiter.js
//
// Shared fixed-window in-memory rate limiter — the exact pattern from
// routes/booking.js / routes/manage.js (which itself came from
// routes/pageLanding.js), extracted so portal routes don't hand-roll a
// fourth copy. booking.js and manage.js keep their local copies for now
// (deliberately untouched this slice); portal routes are the only consumer.
//
// Per-instance on Cloud Run — buckets are process memory, so the effective
// limit is (max × instance count). Accepted best-effort, same posture as
// every existing copy.
//
// Exports:
//   makeLimiter(windowMs, max) → limited(ip) → boolean (true = OVER limit)
//   getClientIp(req)           → string       (cf-connecting-ip || req.ip;
//                                              trust proxy is 1 in server.js)

'use strict';

/**
 * Fixed-window in-memory rate limiter factory.
 * @param {number} windowMs  window length in ms
 * @param {number} max       allowed hits per window per IP
 * @returns {(ip: string) => boolean}  true when the call EXCEEDS the limit
 */
function makeLimiter(windowMs, max) {
  const buckets = new Map(); // ip -> { windowStart, count }
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, b] of buckets) {
      if (b.windowStart < cutoff) buckets.delete(ip);
    }
  }, 5 * 60 * 1000).unref();

  return function limited(ip) {
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b || now - b.windowStart >= windowMs) {
      b = { windowStart: now, count: 0 };
      buckets.set(ip, b);
    }
    b.count += 1;
    return b.count > max;
  };
}

/**
 * Client IP resolution — same convention as routes/booking.js /
 * routes/manage.js / routes/pageLanding.js (trust proxy = 1 in server.js,
 * so req.ip already honors one X-Forwarded-For hop; Cloudflare's
 * cf-connecting-ip wins when present).
 */
function getClientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip;
}

module.exports = { makeLimiter, getClientIp };
