// lib/routeFamilies.js
//
// Route-family PREFIXES for the machine-key scope picker (access-control B6,
// public/apikeys.html): the paths a `route:/<prefix>` scope would usually name.
//
// SOURCE: the LIVE express app, walked at request time — the same traversal
// scripts/updateRoutes.js uses to generate ref/routes.md (app._router.stack,
// recursing into routers). Chosen over parsing ref/routes.md from disk: the
// walk lists exactly what THIS instance serves (env-conditional routes
// included or not, as deployed), while routes.md is a commit-time artifact
// whose rows depend on the committing checkout's .env (its /_aitest note) and
// whose markdown is a document, not a contract. No file I/O, no format coupling.
// Express 4 keeps the stack on app._router (Express 5: app.router); both are
// read, and anything unreadable yields [] — the page then offers only its
// free-text row. The SERVER stays the judge of any scope sent (lib/apiKeys
// machineKeyScopes); this list is only a menu.
//
// FAMILY RULE: '/api/<segment>' for paths under /api, else '/<segment>' — the
// first static segment(s), before any :param or wildcard. Every family must
// itself be a valid route scope body (lib/capabilities isKeyScope), so array
// paths, regexes and odd strings drop out. Bare '/api' is never offered: it
// would grant the whole API — type it if you mean it.

'use strict';

const { isKeyScope } = require('./capabilities');

function familyOf(path) {
  if (typeof path !== 'string') return null;
  const segs = path.split('/').filter(Boolean);
  if (!segs.length || /[:*(]/.test(segs[0])) return null;
  if (segs[0] === 'api') {
    if (segs.length < 2 || /[:*(]/.test(segs[1])) return null;
    return `/api/${segs[1]}`;
  }
  return `/${segs[0]}`;
}

function routePaths(app) {
  const root = app && (app._router || app.router);
  const out = [];
  const walk = (stack) => {
    if (!Array.isArray(stack)) return;
    for (const layer of stack) {
      if (layer && layer.route) {
        const p = layer.route.path;
        for (const one of Array.isArray(p) ? p : [p]) out.push(one);
      } else if (layer && layer.handle && Array.isArray(layer.handle.stack)) {
        walk(layer.handle.stack);
      }
    }
  };
  try { walk(root && root.stack); } catch (_) { return []; }
  return out;
}

/** Sorted, de-duplicated route-family prefixes of the app's routes. */
function routeFamilies(app) {
  const set = new Set();
  for (const p of routePaths(app)) {
    const f = familyOf(p);
    if (f && isKeyScope(`route:${f}`)) set.add(f);
  }
  return [...set].sort();
}

module.exports = { routeFamilies, familyOf };
