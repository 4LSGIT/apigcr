// lib/routeCatalog.js
//
// Casey v2 S0 — an exact, generated answer to "what is this route, who may
// call it, how risky is it", read from the LIVE Express stack (the same walk
// scripts/updateRoutes.js and lib/routeFamilies.js use; Express 4 keeps it on
// app._router). Design: ref/CASEY_V2_DESIGN.md §4.3, verified in §8.1–8.2.
//
// Row: { method, path, family, authClass, can, roles, suTool, elevation,
//        multipart, tier, proposable, autoGet, idempotent, chain }
//      + non-enumerable handler (source scans), seq (registration order) and
//        matches(concretePath) (the layer's regexp) — see findRoute().
//
// AUTH CLASS — from the middleware chain, by three means and NOTHING else:
//   identity   module singletons: lib/auth.jwtOrApiKey, requireAuth's
//              contactMiddleware, lib/auth.readonly's key auth,
//              lib/auth.impersonation markViewAsControl
//   authMeta   a frozen descriptor the auth FACTORIES stamp on the closures
//              they return (makeStaffMiddleware → staffAuth, makeSuperuserCheck,
//              makeElevationCheck, makeRateLimitMiddleware, requireKeyScope).
//              The stamp describes the gate; it never changes it.
//   LOCAL_GATES  the route-local gates (a `requireJwt` inside routes/api.mail.js
//              cannot be imported from here), classified by NAME from the pinned
//              table below. tests/routeCatalog.test.js drives a staff JWT and an
//              SU JWT through one route per name, AND pins the route files that
//              may define each name, so a new `function gate` in some other file
//              fails the test instead of inheriting the table's claim.
// Anything else — an unknown name, or an ANONYMOUS middleware on a route that
// also carries an auth gate — makes the row `authClass: 'unknown'`, closed
// to Casey (not proposable, no auto GET), and is listed in `unknown` so the
// catalog test fails BY NAME. That is the guard that keeps this honest as
// routes are added: a new gate joins LOCAL_GATES (or stamps authMeta) in the
// slice that adds it. An anonymous middleware is tolerated only on a route
// with NO auth gate at all (the public rate limiters and legacy traps).
//
// Classes (design §8.1): 'staff' (jwtOrApiKey or a roles-only requireAuth),
// 'staff:can' (a capability-gated requireAuth; `can` names it, or 'dynamic'
// when the gate picks the capability per request — perKeyGate, gateByScope),
// 'su' (superuserCheck, or a route-local requireAdmin — isSuperuser with no
// elevation step: `elevation: false`), 'key' (readonly session keys),
// 'portal' (contact JWT), 'public' (no auth gate: token, webhook, landing,
// legacy-trap and own-password routes). Casey reaches only the first three.
//
// Built lazily, cached per app object. No file I/O; the catalog of THIS
// process is the catalog of what THIS process serves.

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const pathToRegexp = require('path-to-regexp'); // express 4's own dependency (0.1.x), the Layer's regexp builder

const jwtOrApiKey = require('./auth.jwtOrApiKey');
const requireAuth = require('./auth.requireAuth');
const { readonlyApiKeyAuth } = require('./auth.readonly');
const { markViewAsControl } = require('./auth.impersonation');
const { familyOf } = require('./routeFamilies');
const sensitivity = require('./caseySensitivity');
const { WIRED_ROUTES } = require('./requestIdempotency');

const CLASSES = Object.freeze(['staff', 'staff:can', 'su', 'key', 'portal', 'public', 'unknown']);

// The contact gate is the ONE function requireAuth({audience:'contact'}) returns.
const contactMiddleware = requireAuth({ audience: 'contact' });

// Route-local gates by function NAME → effect. Effects:
//   jwtOnly      refines a staff route to a signed-in person (API keys 403)
//   su           isSuperuser in a route file, no elevation step
//   viewAsOnly   needs a live View-as session (api.impersonation)
//   dynamicCan   a requireAuth({can}) chosen per request (settings key / body scope)
//   limiter      a per-user or per-IP rate limiter — no auth meaning
//   multipart    a multer wrapper: the body is a file upload, not JSON
//   parser       a body parser (text/plain for a webhook)
//   publicAuth   a public route's own header password / env key
// A name here is a claim about what that function does; the enforcement test
// in tests/routeCatalog.test.js checks the claim against the live route.
const LOCAL_GATES = Object.freeze({
  requireJwt: 'jwtOnly',          // routes/api.mail.js, api.mailboxes.js, api.phoneComms.js, api.forms.js, api.entityComms.js
  staffOnly: 'jwtOnly',           // routes/api.casey.js (v1's check, kept by v2 at S3a; v1 retired at S6)
  requireUser: 'jwtOnly',         // routes/api.reports.js
  requireAdmin: 'su',             // routes/api.issueReports.js, api.featureRequests.js — isAdmin IS isSuperuser
  requireViewAsSession: 'viewAsOnly', // routes/api.impersonation.js
  perKeyGate: 'dynamicCan',       // routes/api.appSettings.js — capability per settings key
  gateByScope: 'dynamicCan',      // routes/api.uiConfig.js — firm.settings when body.scope === 'firm'
  limitDraft: 'limiter',          // routes/api.reports.js
  limitPreview: 'limiter',        // routes/api.reports.js
  uploadSingle: 'multipart',      // routes/api.ai.js, api.esign.actions.js
  tplUploadSingle: 'multipart',   // routes/api.esign.templates.js
  multerMiddleware: 'multipart',  // routes/api.pdf.js (multer's own name)
  textParser: 'parser',           // routes/api.esign.js — Zoho webhook body
  memberAuth: 'publicAuth',       // routes/api.streak.js — board member password
  adminAuth: 'publicAuth',        // routes/api.streak.js — STREAK_ADMIN_PASSWORD
  checkApiKey: 'publicAuth',      // routes/ringcentral.js — RINGCENTRAL_API_KEY
  gate: 'publicAuth',             // routes/_aitest.js, _errtest.js, _courtexec.js — env-keyed test routes
});

const ANON = '<anonymous>';

/** One middleware function → its meaning, or null when nothing here knows it. */
function describe(fn) {
  if (typeof fn !== 'function') return null;
  if (fn === jwtOrApiKey) return { kind: 'staff', can: null, roles: [], allowApiKey: true };
  if (fn === contactMiddleware) return { kind: 'portal' };
  if (fn === readonlyApiKeyAuth) return { kind: 'key', allowExpired: false };
  // The expired-key variant (renewal requests) is known by its authMeta stamp
  // below, never by name: tests/keyScopes.test.js pins its name to one file.
  if (fn === markViewAsControl) return { kind: 'flag', flag: 'viewAsControl' };
  if (fn.authMeta && typeof fn.authMeta === 'object') return fn.authMeta;
  const name = fn.name || '';
  if (Object.prototype.hasOwnProperty.call(LOCAL_GATES, name)) return { kind: 'local', effect: LOCAL_GATES[name], name };
  return null;
}

/**
 * classifyChain(middlewares) — the middleware functions BEFORE the handler →
 *   { authClass, can, roles, suTool, elevation, multipart, flags, unknown: [names] }
 * Pure; exported for the negative-control test.
 */
function classifyChain(middlewares) {
  const out = { authClass: 'public', can: null, roles: [], suTool: null, elevation: false, multipart: false, flags: [], unknown: [] };
  let staff = false, staffCan = null, su = false, key = false, portal = false, anonymous = 0;
  for (const fn of middlewares) {
    const d = describe(fn);
    if (!d) {
      if (typeof fn === 'function' && !fn.name) { anonymous++; continue; }
      out.unknown.push((fn && fn.name) || ANON);
      continue;
    }
    switch (d.kind) {
      case 'staff':
        staff = true;
        if (d.can) staffCan = d.can;
        if (Array.isArray(d.roles) && d.roles.length) out.roles = [...d.roles];
        break;
      case 'su': su = true; out.suTool = d.tool || null; break;
      case 'elevation': out.elevation = true; break;
      case 'rateLimit': break;
      case 'key': case 'keyScope': key = true; break;
      case 'portal': portal = true; break;
      case 'flag': out.flags.push(d.flag); break;
      case 'local':
        switch (d.effect) {
          case 'jwtOnly': out.flags.push('jwtOnly'); break;
          case 'su': su = true; break;               // elevation stays false
          case 'viewAsOnly': out.flags.push('viewAsOnly'); break;
          case 'dynamicCan': staff = true; staffCan = 'dynamic'; break;
          case 'multipart': out.multipart = true; break;
          case 'limiter': case 'parser': break;
          case 'publicAuth': out.flags.push(`publicAuth:${d.name}`); break;
          default: out.unknown.push(d.name);
        }
        break;
      default: out.unknown.push((fn && fn.name) || ANON);
    }
  }
  const authed = staff || su || key || portal;
  // A route-local SU gate without the staff auth in front of it authenticates
  // nobody — refuse to call that 'su'.
  if (su && !staff && !key && !portal) out.unknown.push('su-gate-without-jwtOrApiKey');
  // An anonymous middleware beside an auth gate could be anything.
  if (anonymous && authed) out.unknown.push(ANON);

  if (out.unknown.length) out.authClass = 'unknown';
  else if (su) out.authClass = 'su';
  else if (key) out.authClass = 'key';
  else if (portal) out.authClass = 'portal';
  else if (staff && staffCan) { out.authClass = 'staff:can'; out.can = staffCan; }
  else if (staff) out.authClass = 'staff';
  else out.authClass = 'public';
  return out;
}

/** A mounted router's path prefix from its layer regexp — the same best-effort
 *  read scripts/updateRoutes.js makes ('' for a root-mounted router). Shares its
 *  limit: a MULTI-segment mount ('/api/pref') comes back as its first segment
 *  (ref/plans.md, Casey v2 S0 review). No routes/ file mounts under a prefix today. */
function mountPrefix(layer) {
  if (!layer.regexp) return '';
  const src = layer.regexp.source;
  if (src === '^\\/?$' || src === '^\\/?(?=\\/|$)') return '';
  const m = src.match(/^\^\\\/([^\\$?]+)/);
  return m ? '/' + m[1] : '';
}

/** Walk the live stack → [{ method, path, middlewares: [fn], handler }], one per method × path.
 *  An array path (`['/book/:slug', '/b/:slug']`) is one row per path (ref/routes.md
 *  joins them with a comma); `router.all` stays one `_ALL` row, as in routes.md. */
function listRouteLayers(app) {
  const root = app && (app._router || app.router);
  const out = [];
  const walk = (stack, prefix) => {
    if (!Array.isArray(stack)) return;
    for (const layer of stack) {
      if (layer && layer.route) {
        const handles = layer.route.stack.map(l => l.handle);
        const methods = Object.keys(layer.route.methods || {}).map(m => m.toUpperCase());
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const p of paths) for (const m of methods) {
          out.push({ method: m, path: prefix + String(p), prefix, middlewares: handles.slice(0, -1), handler: handles[handles.length - 1], layer });
        }
      } else if (layer && layer.handle && Array.isArray(layer.handle.stack)) {
        walk(layer.handle.stack, prefix + mountPrefix(layer));
      }
    }
  };
  walk(root && root.stack, '');
  return out;
}

/**
 * buildCatalog(app) → { rows, unknown, builtAt }
 * `unknown` lists every row whose chain could not be classified, by
 * middleware name — the test asserts it is empty.
 */
function buildCatalog(app) {
  const rows = [];
  const unknown = [];
  let seq = 0;
  for (const r of listRouteLayers(app)) {
    const c = classifyChain(r.middlewares);
    const s = sensitivity.classify({ method: r.method, path: r.path, authClass: c.authClass, multipart: c.multipart });
    const row = {
      method: r.method,
      path: r.path,
      family: familyOf(r.path),
      authClass: c.authClass,
      can: c.can,
      roles: c.roles,
      suTool: c.suTool,
      elevation: c.elevation,
      multipart: c.multipart,
      flags: c.flags,
      tier: s.tier,
      proposable: c.authClass === 'unknown' ? false : s.proposable,
      autoGet: c.authClass === 'unknown' ? (s.autoGet === null ? null : false) : s.autoGet,
      tierReason: s.reason,
      idempotent: WIRED_ROUTES[`${r.method} ${r.path}`] || null,
      chain: Object.freeze(r.middlewares.map(fn => (fn && fn.name) || ANON)),
    };
    // Not serialised by the route (a function); lets the tests scan each
    // handler's SOURCE for what a path cannot show (a decrypt, a forwarded SQL).
    Object.defineProperty(row, 'handler', { value: r.handler, enumerable: false });
    // Registration order and a matcher (S1): findRoute() picks the row
    // Express itself would dispatch a concrete path to — the FIRST registered
    // route whose regexp matches and whose method applies. A single-path route
    // uses the layer's own regexp; an ARRAY route's layer regexp covers every
    // alias, so each row gets a regexp built for ITS path with the Layer's
    // options (path-to-regexp 0.1.x, case-insensitive, trailing slash
    // optional, anchored). No `g` flag, so .test() is stateless; Layer.match()
    // is not used because it writes layer.params on the live app's layer.
    // A row under a MOUNTED sub-router never matches (fail closed): the mount
    // prefix is read best-effort (mountPrefix) and Express matches it case-
    // insensitively — model it when a routes/ file first mounts under one.
    const regexp = Array.isArray(r.layer.route.path)
      ? pathToRegexp(r.path, [], { sensitive: false, strict: false, end: true })
      : r.layer.regexp;
    const prefix = r.prefix;
    Object.defineProperty(row, 'seq', { value: seq++, enumerable: false });
    Object.defineProperty(row, 'matches', {
      enumerable: false,
      value: (concretePath) => !prefix && regexp.test(String(concretePath)),
    });
    Object.freeze(row.roles); Object.freeze(row.flags);
    rows.push(Object.freeze(row));
    if (c.unknown.length) unknown.push(Object.freeze({ method: r.method, path: r.path, names: Object.freeze(c.unknown) }));
  }
  rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  // The cached catalog is shared by every request of the process: frozen, so a
  // consumer cannot edit a row in place.
  return Object.freeze({ rows: Object.freeze(rows), unknown: Object.freeze(unknown), builtAt: new Date().toISOString() });
}

const cache = new WeakMap();
/** The catalog of `app`, built once per app object. */
function catalogFor(app) {
  // An express app is a callable (typeof 'function'); req.app in production.
  if (!app || (typeof app !== 'function' && typeof app !== 'object')) throw new Error('routeCatalog: an express app is required');
  let c = cache.get(app);
  if (!c) { c = buildCatalog(app); cache.set(app, c); }
  return c;
}

/**
 * findRoute(catalog, method, concretePath) → the row Express would dispatch
 * `METHOD concretePath` to, or null. Path only (no query string): the first
 * registered row (seq order, not the sorted order) whose matcher accepts the
 * path and whose method is `method` or `_ALL`. One exception, PASS_THROUGH:
 * server.js's public `GET /:page` catch-all calls next() for every path without
 * a public/<page>.html, so it would shadow each single-segment API route
 * without serving it; a PASS_THROUGH row is taken only when nothing later
 * matches. Every OTHER public row keeps first-registered-wins — a public token
 * route (`/u/:token`, `/c/:token`) has side effects, and a later gated route on
 * the same path must never make api_get send the request. A gated handler
 * that calls next() into a later route is not modelled.
 */
const PASS_THROUGH = Object.freeze(new Set(['GET /:page']));

function findRoute(catalog, method, concretePath) {
  const m = String(method || '').toUpperCase();
  let best = null, passThrough = null;
  for (const row of catalog.rows) {
    if (row.method !== m && row.method !== '_ALL') continue;
    if (best && row.seq > best.seq) continue;
    if (!row.matches(concretePath)) continue;
    if (row.authClass === 'public' && PASS_THROUGH.has(`${row.method} ${row.path}`)) { if (!passThrough) passThrough = row; continue; }
    best = row;
  }
  return best || passThrough;
}

/** Throws, naming every unclassifiable route, when the catalog is not determinate. */
function assertDeterminate(catalog) {
  if (!catalog.unknown.length) return;
  const lines = catalog.unknown.map(u => `  ${u.method} ${u.path} — ${u.names.join(', ')}`);
  throw new Error(`routeCatalog: ${catalog.unknown.length} route(s) with an unclassifiable middleware chain (add the gate to LOCAL_GATES or stamp authMeta):\n${lines.join('\n')}`);
}

/**
 * appFromRoutes(dir?) — a bare express app with every routes/*.js mounted at
 * root, exactly as server.js mounts them. For tests and scripts; production
 * passes its live `req.app`. Requiring an already-loaded route module is a
 * cache hit, so building this beside a live app registers nothing twice.
 */
function appFromRoutes(dir = path.join(__dirname, '..', 'routes')) {
  const app = express();
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js')).sort()) {
    app.use(require(path.join(dir, f)));
  }
  return app;
}

/** summary(rows) → counts by class, by tier, proposable / autoGet totals. */
function summary(rows) {
  const byClass = {}, byTier = {};
  let proposable = 0, autoGet = 0, writes = 0;
  for (const r of rows) {
    byClass[r.authClass] = (byClass[r.authClass] || 0) + 1;
    byTier[`T${r.tier}`] = (byTier[`T${r.tier}`] || 0) + 1;
    if (r.proposable) proposable++;
    if (r.autoGet) autoGet++;
    if (r.method !== 'GET' && r.method !== 'HEAD') writes++;
  }
  return { total: rows.length, writes, byClass, byTier, proposable, autoGet };
}

module.exports = {
  CLASSES, LOCAL_GATES,
  classifyChain, listRouteLayers, buildCatalog, catalogFor, findRoute, PASS_THROUGH, assertDeterminate, appFromRoutes, summary,
};
