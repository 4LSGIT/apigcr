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
//   getClientIp(req)           → string

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
 * Client IP resolution. NOT booking/manage's `cf-connecting-ip || req.ip`:
 * on this Cloud Run chain req.ip empirically resolves to 0.0.0.0 for
 * external traffic (verified 2026-08-05 against portal_access_log), which
 * collapses every per-IP rate bucket into one global bucket. Uses the
 * jwt_api_audit_log resolution instead — x-forwarded-for first element —
 * which records real client IPs for the same live traffic. booking/manage
 * carry the latent req.ip issue; migrating them here is a follow-up slice.
 */
function getClientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',').shift()?.trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

module.exports = { makeLimiter, getClientIp };