// lib/errorMiddleware.js
//
// Express 4-arg error middleware. Mounted in server.js AFTER the route
// readdirSync loop. Factory pattern (takes db) matching pageHostMiddleware.
//
// KNOWN LIMITATION (by design, do not "fix" by refactoring routes):
// Express 4 only routes errors here via next(err) or synchronous throws in
// handlers/middleware. Nearly every existing route try/catches internally
// and res.status(500)s itself — those never reach this middleware. Async
// handler rejections without try/catch ALSO bypass it (Express 4 turns
// them into unhandledRejection, not next(err)). Coverage today is a safety
// net (sync throws, body-parser errors, admin.dbConsole/apiTester which
// already next(err)) plus the convention for future routes.
//
// STORM CAP — per-instance, in-memory, DELIBERATE: after 20 alert() calls
// for one routeKey in one clock hour, one 'route_500_suppressed' alert is
// emitted and the rest of the hour is silent. In-memory means worst case
// is cap × Cloud Run instance count (max 3 today) — acceptable; a DB-backed
// cap would put a query on the error path for no real gain.

const { alert } = require('./alerting');

const STORM_CAP = 20;
const stormState = new Map(); // routeKey -> { hourBucket, count }

/**
 * Stable grouping key. Matched route → baseUrl + route.path (already
 * parameterized, e.g. /api/cases/:id). No matched route (error thrown in
 * middleware before routing) → req.path with purely-numeric segments
 * replaced by ':id' so /case/123 and /case/456 group together.
 */
function normalizeRouteKey(req) {
  if (req.route?.path) return (req.baseUrl || '') + req.route.path;
  const p = (req.path || (req.originalUrl || '').split('?')[0] || '/');
  return p.split('/').map(s => (/^\d+$/.test(s) ? ':id' : s)).join('/') || '/';
}

/** Returns 'pass' (alert normally), 'final' (emit the one suppression alert), or 'silent'. */
function stormCheck(routeKey) {
  const hourBucket = Math.floor(Date.now() / 3600000);
  let s = stormState.get(routeKey);
  if (!s || s.hourBucket !== hourBucket) {
    s = { hourBucket, count: 0 };
    stormState.set(routeKey, s);
  }
  s.count++;
  if (s.count <= STORM_CAP) return 'pass';
  if (s.count === STORM_CAP + 1) return 'final';
  return 'silent';
}

module.exports = function makeErrorMiddleware(db) {
  // eslint-disable-next-line no-unused-vars -- 4-arg signature is how Express identifies an error handler
  return function errorMiddleware(err, req, res, next) {
    try {
      const status = err.status || err.statusCode || 500;

      // 4xx (body-parser parse failures, auth middleware errors, etc.) —
      // client noise, not alert-worthy. Delegate to Express's default
      // handler, which is exactly what happened before this middleware
      // existed (no prior custom handler in the codebase).
      if (status < 500) return next(err);

      // 5xx: respond if we still can. If headers already went out we
      // neither respond nor delegate (the default handler would destroy
      // the socket); we still record the alert below.
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal error' });
      }

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

      const stack = (err.stack || '').split('\n').slice(0, 11).join('\n');
      alert(db, {
        source: 'app',
        kind: 'route_500',
        group_key: `route_500:${routeKey}`,
        severity: 'error',
        title: `500 on ${req.method} ${routeKey}`,
        message: `${err.message || String(err)}\n${stack}`,
        context: {
          method: req.method,
          path: String(req.originalUrl || '').slice(0, 500),
          user: req.auth?.username || req.auth?.userId
            || (req.auth?.type === 'api_key' ? 'api_key' : null),
        },
      });
      // alert() never throws and never rejects — fire-and-forget is safe.
    } catch (e) {
      // The error handler must never itself throw.
      try { console.error('[errorMiddleware] failed:', e.message); } catch (_) {}
      try { if (!res.headersSent) res.status(500).json({ error: 'internal error' }); } catch (_) {}
    }
  };
};