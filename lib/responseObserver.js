// lib/responseObserver.js
//
// 500-RESPONSE OBSERVER — Slice 3b. Normal 3-arg middleware, mounted in
// server.js AFTER the req.db middleware and BEFORE the route readdirSync
// loop, so every route's res passes through it.
//
// Design: instead of catching errors (slice 3 — near-zero coverage because
// almost every route try/catches internally and res.status(500)s itself),
// we observe the RESPONSE. Any outgoing 5xx is recorded regardless of which
// code path produced it.
//
// Body capture: res.json / res.send are wrapped minimally to stash a
// truncated copy (1000 chars) on res.locals._body before delegating to the
// originals. Behavior, headers, and return values are untouched.
//
// Stack enrichment: when the error flowed through next(err), the 4-arg
// handler (lib/errorMiddleware.js) stashes res.locals._errStack before
// responding; the finish handler here prefers it over the body.
//
// STORM CAP: shared with errorMiddleware (single per-routeKey budget across
// both emitters). The mechanism lives in errorMiddleware and is imported
// here — observer requires errorMiddleware requires alerting, no cycle.
// Semantics unchanged: 20 alerts/routeKey/clock-hour, then one
// 'route_500_suppressed' alert, then silence for the rest of the hour.
// Per-instance in-memory (worst case cap × instance count, max 3 today).

const { alert } = require('./alerting');
const { normalizeRouteKey, stormCheck, STORM_CAP } = require('./errorMiddleware');

const BODY_TRUNC = 1000;

function captureBody(body) {
  try {
    if (body == null) return null;
    const s = (typeof body === 'object' && !Buffer.isBuffer(body))
      ? JSON.stringify(body)
      : String(body);
    return s.length > BODY_TRUNC ? s.slice(0, BODY_TRUNC) : s;
  } catch (_) {
    return null;
  }
}

module.exports = function makeResponseObserver(db) {
  return function responseObserver(req, res, next) {
    try {
      // Marker for errorMiddleware: this response IS observed. Errors thrown
      // in middleware mounted before this point (pageHost, static,
      // body-parser) produce responses we never wrapped — errorMiddleware
      // alerts directly for those.
      res.locals._observed = true;

      const origJson = res.json;
      const origSend = res.send;

      res.json = function (body) {
        try { res.locals._body = captureBody(body); } catch (_) {}
        return origJson.call(this, body);
      };
      // res.json internally calls res.send with the stringified body — the
      // null-guard keeps the original (pre-stringify) capture.
      res.send = function (body) {
        try {
          if (res.locals._body == null) res.locals._body = captureBody(body);
        } catch (_) {}
        return origSend.call(this, body);
      };

      res.on('finish', () => {
        try {
          if (res.statusCode < 500) return;

          const routeKey = normalizeRouteKey(req);
          const verdict = stormCheck(routeKey);
          if (verdict === 'silent') return;

          if (verdict === 'final') {
            alert(db, {
              source: 'app',
              kind: 'route_500_suppressed',
              group_key: `route_500:${routeKey}`,
              severity: 'error',
              title: `500s on ${req.method} ${routeKey} suppressed`,
              message: 'further 500s on this route suppressed this hour (per-instance cap)',
              context: { method: req.method, routeKey, cap: STORM_CAP },
            });
            return;
          }

          alert(db, {
            source: 'app',
            kind: 'route_500',
            group_key: `route_500:${routeKey}`,
            severity: 'error',
            title: `${res.statusCode} on ${req.method} ${routeKey}`,
            message: res.locals._errStack || res.locals._body || '(no body captured)',
            context: {
              method: req.method,
              path: String(req.originalUrl || '').slice(0, 500),
              status: res.statusCode,
              user: req.auth?.username || req.auth?.userId || null,
            },
          });
          // alert() never throws and never rejects — fire-and-forget is safe.
        } catch (e) {
          try { console.error('[responseObserver] finish handler failed:', e.message); } catch (_) {}
        }
      });
    } catch (e) {
      try { console.error('[responseObserver] setup failed:', e.message); } catch (_) {}
    }
    next();
  };
};