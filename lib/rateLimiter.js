// lib/rateLimiter.js
//
// Shared fixed-window in-memory rate limiter — the exact pattern from
// routes/booking.js / routes/manage.js (which itself came from
// routes/pageLanding.js), extracted so portal routes don't hand-roll a
// fourth copy.
//
// STALE-COMMENT CORRECTION (2026-08-16): this block used to say booking.js
// and manage.js "keep their local copies for now". They do not — both now
// import makeLimiter + getClientIp from here and key on the last XFF element.
// Consumers today: portal routes, routes/booking.js, routes/manage.js.
// routes/pageLanding.js still has its own inline copy keyed on
// `cf-connecting-ip || req.ip` — the exact anti-pattern getClientIp() below
// argues against. That is a PRE-EXISTING gap on the landing-page POST
// limiter, unrelated to any routing slice; chartered, not fixed here.
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
 * Client IP resolution for RATE-LIMIT KEYING. NOT booking/manage's
 * `cf-connecting-ip || req.ip`, and NOT jwt_api_audit_log's XFF-first:
 *
 *   - req.ip on this chain yields constants for external traffic
 *     (::1 / 0.0.0.0 — verified 2026-08-05 in portal_access_log), which
 *     collapses every per-IP bucket into one global bucket.
 *   - app.4lsg.com is DIRECT Cloud Run (CNAME ghs.googlehosted.com,
 *     verified 2026-08-05) — there is NO Cloudflare in front, so
 *     `cf-connecting-ip` here is just a client-suppliable header. Keying
 *     on it hands an attacker a fresh bucket per request.
 *   - X-Forwarded-For: the Google Front End APPENDS the true peer IP as
 *     the LAST element; anything earlier is client-supplied. First-element
 *     resolution (the audit-log style) is fine for LOGGING honest traffic
 *     but is a bypass as a limiter key — an attacker sets their own XFF
 *     prefix and every request lands in a different bucket. A limiter
 *     keyed on attacker-controlled input rate-limits everyone except
 *     attackers. We take the LAST element.
 *
 * If app.4lsg.com is ever fronted by a proxy/CDN later, the last element
 * becomes that proxy's egress IP (global bucket again) — revisit this
 * function as part of that change.
 */
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',');
    const last = parts[parts.length - 1].trim();
    if (last) return last;
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

module.exports = { makeLimiter, getClientIp };