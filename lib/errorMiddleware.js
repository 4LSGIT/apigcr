// lib/errorMiddleware.js
//
// Express 4-arg error middleware. Mounted in server.js AFTER the route
// readdirSync loop. Factory pattern (takes db) matching pageHostMiddleware.
//
// ROLE (post Slice 3b): stash-and-respond. Alerting on 5xx responses is
// owned by lib/responseObserver.js, which sees EVERY outgoing 5xx — the
// slice-3 limitation (routes that try/catch internally and res.status(500)
// themselves never reach a 4-arg handler) is history. This handler's job:
//   - 4xx → delegate to Express default (client noise, not alert-worthy).
//   - 5xx → stash err stack on res.locals._errStack so the observer's
//     finish handler emits ONE alert enriched with the stack instead of
//     just the generic body; respond 500 if headers haven't gone out.
//   - Direct alert() ONLY when the observer can't cover it:
//       (a) headersSent — finish may already have fired (or fire) without
//           our stack; worst case is a near-duplicate dedup'd by group_key,
//           never a missed event.
//       (b) response never wrapped (res.locals._observed unset) — error
//           thrown in middleware mounted BEFORE the observer (pageHost,
//           static, body-parser 5xx). No finish listener exists, so without
//           this branch the event would vanish.
//
// STORM CAP — per-instance, in-memory, DELIBERATE: after 20 alert() calls
// for one routeKey in one clock hour, one 'route_500_suppressed' alert is
// emitted and the rest of the hour is silent. The mechanism lives here and
// is exported; responseObserver imports it so both emitters share one
// per-routeKey budget (observer → this file → alerting, no require cycle).
// In-memory means worst case is cap × Cloud Run instance count (max 3
// today) — acceptable; a DB-backed cap would put a query on the error path
// for no real gain.

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

function makeErrorMiddleware(db) {
  // eslint-disable-next-line no-unused-vars -- 4-arg signature is how Express identifies an error handler
  return function errorMiddleware(err, req, res, next) {
    try {
      const status = err.status || err.statusCode || 500;

      // 4xx (body-parser parse failures, auth middleware errors, etc.) —
      // client noise, not alert-worthy. Delegate to Express's default
      // handler, which is exactly what happened before this middleware
      // existed (no prior custom handler in the codebase).
      if (status < 500) return next(err);

      // Capture BEFORE we respond — responding flips headersSent.
      const alreadySent = res.headersSent;

      const stack = (err.stack || '').split('\n').slice(0, 11).join('\n');
      res.locals._errStack = `${err.message || String(err)}\n${stack}`;

      // 5xx: respond if we still can. If headers already went out we don't
      // respond and don't delegate (the default handler would destroy the
      // socket). The observer's finish handler picks up _errStack and emits
      // the single, stack-enriched alert.
      if (!alreadySent) {
        res.status(500).json({ error: 'internal error' });
      }

      // Direct-alert fallback for the two cases the observer can't cover.
      if (alreadySent || !res.locals._observed) {
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
          title: `500 on ${req.method} ${routeKey}`,
          message: res.locals._errStack,
          context: {
            method: req.method,
            path: String(req.originalUrl || '').slice(0, 500),
            status,
            user: req.auth?.username || req.auth?.userId
              || (req.auth?.type === 'api_key' ? 'api_key' : null),
          },
        });
        // alert() never throws and never rejects — fire-and-forget is safe.
      }
    } catch (e) {
      // The error handler must never itself throw.
      try { console.error('[errorMiddleware] failed:', e.message); } catch (_) {}
      try { if (!res.headersSent) res.status(500).json({ error: 'internal error' }); } catch (_) {}
    }
  };
}

module.exports = makeErrorMiddleware;
module.exports.normalizeRouteKey = normalizeRouteKey;
module.exports.stormCheck = stormCheck;
module.exports.STORM_CAP = STORM_CAP;