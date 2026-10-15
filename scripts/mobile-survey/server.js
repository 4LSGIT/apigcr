// scripts/mobile-survey/server.js
//
// A stand-in origin for layout testing: serves public/ the way server.js does
// (express.static, so text/html gets the same charset header — case.html and
// contact.html have no <meta charset> and depend on it), and answers the API
// from synthetic fixtures. NO database, NO auth: every /api/* and /admin/*
// request succeeds.
//
//   POST /login                   -> a fake, UNSIGNED token (any username and
//                                    password) so the page can be browsed by
//                                    hand; nothing here verifies it.
//   GET /api/firm-data            -> fixtures/firm-data.json
//   ANY /api/<path>, /admin/<path> -> fixtures/api/<path>.json when it exists
//                                    (exact path only — /api/cases/X/pipeline
//                                    does NOT fall back to /api/cases/X),
//                                    otherwise an empty-success envelope.
//   GET /manual[/:section[/:file]] -> the REAL routes/manuals.js, reading the
//                                    repo's manual/ from disk (no DB); only its
//                                    auth middleware is swapped for a
//                                    pass-through (manualsRouter below).
//
// Fixtures are synthetic on purpose (the repo is treated as public): no real
// staff, clients, phone numbers or emails. See README.md.
//
// Standalone:  node scripts/mobile-survey/server.js [port]   (default 8765)
// survey.js starts it in-process via start().

'use strict';

const path    = require('path');
const fs      = require('fs');
const express = require('express');

const ROOT     = path.join(__dirname, '..', '..');
const PUBLIC   = path.join(ROOT, 'public');
const FIXTURES = path.join(__dirname, 'fixtures');

// Covers the list shapes the panes read (data / rows / items / entries /
// documents …) so an un-fixtured endpoint renders an empty state, not a crash.
const EMPTY = Object.freeze({
  status: 'success', ok: true, success: true, total: 0, count: 0,
  data: [], rows: [], items: [], results: [], entries: [], list: [], documents: [],
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** '{{TODAY}}' / '{{TODAY+N}}' / '{{TODAY-N}}' in a fixture → the local civil
 *  date N days out (YYYY-MM-DD), resolved at read time. Date-driven fixtures
 *  (calendar-feed.json) stay inside the surveyed week forever instead of
 *  rotting past it. Same en-CA idiom the panes themselves use. */
function resolveDates(text) {
  return text.replace(/\{\{TODAY([+-]\d+)?\}\}/g, (_, off) =>
    new Date(Date.now() + (Number(off) || 0) * 86400000).toLocaleDateString('en-CA'));
}

function fixtureFor(urlPath) {
  // '/api/cases/TESTCASE1' -> fixtures/api/cases/TESTCASE1.json
  const rel = urlPath.replace(/^\/(api|admin)\//, '');
  if (!rel || rel.includes('..')) return null;
  const file = path.join(FIXTURES, 'api', rel + '.json');
  return fs.existsSync(file) ? JSON.parse(resolveDates(fs.readFileSync(file, 'utf8'))) : null;
}

/** Unsigned JWT-shaped token with a far-future exp. The shell only decodes
 *  the payload (exp, username) — it never verifies a signature. */
function fakeJwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ userId: 1, username: 'layout-test', exp: 4102444800 })}.x`;
}

/** The real routes/manuals.js with its one dependency outside express/fs —
 *  lib/auth.jwtOrApiKey — replaced by a pass-through: the module is pre-seeded
 *  in require.cache for the duration of the router's require, then the cache
 *  entry is put back the way it was, so nothing else loaded in this process
 *  ever gets the stub. The router captures the stub at require time. */
let manualsRouterCache = null;
function manualsRouter() {
  if (manualsRouterCache) return manualsRouterCache;
  const Module   = require('module');
  const authPath = require.resolve(path.join(ROOT, 'lib', 'auth.jwtOrApiKey'));
  const routerPath = require.resolve(path.join(ROOT, 'routes', 'manuals'));
  const prevAuth = require.cache[authPath];
  const prevRouter = require.cache[routerPath];
  const stub = new Module(authPath);
  stub.filename = authPath;
  stub.loaded = true;
  stub.exports = (req, res, next) => next();
  require.cache[authPath] = stub;
  delete require.cache[routerPath];
  try {
    manualsRouterCache = require(routerPath);
  } finally {
    if (prevAuth) require.cache[authPath] = prevAuth; else delete require.cache[authPath];
    if (prevRouter) require.cache[routerPath] = prevRouter; else delete require.cache[routerPath];
  }
  return manualsRouterCache;
}

function createApp({ log = null } = {}) {
  const app = express();

  app.post('/login', (req, res) => res.json({ token: fakeJwt() }));

  app.use(manualsRouter());

  app.all(/^\/(api|admin)\//, (req, res) => {
    const body = req.path === '/api/firm-data'
      ? readJson(path.join(FIXTURES, 'firm-data.json'))
      : (fixtureFor(req.path) || EMPTY);
    if (log) log(`${req.method} ${req.path} ${body === EMPTY ? 'empty' : 'fixture'}`);
    res.json(body);
  });

  app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
  app.use(express.static(PUBLIC));
  return app;
}

/** Start on `port` (0 = any free port). Resolves { server, url }. */
function start(port = 0, opts = {}) {
  return new Promise((resolve, reject) => {
    const server = createApp(opts).listen(port, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
    server.on('error', reject);
  });
}

module.exports = { start, createApp, fakeJwt };

if (require.main === module) {
  const port = Number(process.argv[2]) || 8765;
  start(port, { log: (l) => console.log(l) }).then(({ url }) => {
    console.log(`mobile-survey mock origin on ${url} — open it in a browser at phone width`);
  });
}
