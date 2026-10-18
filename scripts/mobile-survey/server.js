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
//   PUT /api/ui-config            -> echoes the body's document back as saved
//   POST /api/ui-config/versions/:id/restore
//                                 -> fixtures/api/ui-config/versions/<id>.json's
//                                    document as the restored one (else 404).
//                                    No state: the Firm tab (Config shell) can be
//                                    clicked through, nothing persists. The GETs
//                                    …/pickers, …/versions[/<id>] are plain fixtures.
//   GET/PUT /api/app-settings[…]  -> fixtures/api/app-settings.json, filtered
//                                    by ?home=; history per key; PUT / restore
//                                    echo (see the route block below).
//   POST /__mock/persona          -> { persona: 'su' | 'staff' } — who the mock
//                                    answers as (see PERSONA below).
//   GET /api/ui-config            -> fixtures/api/ui-config.json (can_edit_firm)
//                                    with firm / user taken from firm-data.json's
//                                    `ui`: one source for the layers, as in
//                                    production (the layout editor re-reads them).
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

// The persona the mock answers as (settings arc): 'su' — the fixture user,
// a superuser holding every capability (the default); 'staff' — a staff-only
// user: GET /api/ui-config says neither gate, the settings API serves no
// system / comms rows and nothing editable, and a fixture with a `.staff`
// twin (fixtures/api/<path>.staff.json — mailboxes, phone-lines/readable)
// answers from the twin. Switched by POST /__mock/persona { persona }; the
// survey flips it around the steps that need it and reloads the pane.
let PERSONA = 'su';

function fixtureFor(urlPath) {
  // '/api/cases/TESTCASE1' -> fixtures/api/cases/TESTCASE1.json
  const rel = urlPath.replace(/^\/(api|admin)\//, '');
  if (!rel || rel.includes('..')) return null;
  const twin = PERSONA !== 'su' && path.join(FIXTURES, 'api', `${rel}.${PERSONA}.json`);
  const file = twin && fs.existsSync(twin) ? twin : path.join(FIXTURES, 'api', rel + '.json');
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
  app.post('/__mock/persona', express.json(), (req, res) => {
    const p = (req.body || {}).persona;
    if (p !== 'su' && p !== 'staff') return res.status(400).json({ error: 'persona: su | staff' });
    PERSONA = p;
    res.json({ persona: PERSONA });
  });

  app.use(manualsRouter());

  // GET /api/ui-config: its layers ARE firm-data.json's `ui` — in production
  // both reads come from one uiConfigService.readFor, and the layout editor
  // (ui-custom S4b) refreshes the shell from this read when the two differ, so
  // a mock that disagreed with itself would re-run the launcher mid-survey.
  // The rest (can_edit_firm, …) comes from fixtures/api/ui-config.json.
  app.get('/api/ui-config', (req, res) => {
    const ui = readJson(path.join(FIXTURES, 'firm-data.json')).ui || {};
    const staff = PERSONA === 'staff' ? { can_edit_firm: false, can_edit_system: false } : {};
    res.json({ ...fixtureFor('/api/ui-config'), ...staff, firm: ui.firm || {}, user: ui.user || {} });
  });

  // ui-custom S3.2 — the Firm tab's two writes (stateless; see the header).
  app.put('/api/ui-config', express.json(), (req, res) => {
    const b = req.body || {};
    res.json({ status: 'success', scope: b.scope, config_key: b.config_key, config: b.config, changed: true, versioned: b.scope === 'firm' });
  });
  app.post(/^\/api\/ui-config\/versions\/(\d+)\/restore$/, (req, res) => {
    const v = fixtureFor(`/api/ui-config/versions/${req.params[0]}`);
    if (!v || !v.version) return res.status(404).json({ status: 'error', message: 'Version not found' });
    res.json({ status: 'success', scope: 'firm', config_key: v.version.config_key, config: v.version.config,
      changed: true, versioned: true, restored_from: v.version.id });
  });

  // Settings arc — the settings API (routes/api.appSettings.js): GET serves
  // fixtures/api/app-settings.json filtered by ?home= the way the route does
  // (sections only for the homes served); PUT echoes the value; history is a
  // plain per-key fixture (fixtures/api/app-settings/<key>/history.json, else
  // none); restore answers that history's OLD value. Stateless, like the
  // Firm tab's ui-config writes above.
  app.get('/api/app-settings', (req, res) => {
    const all = fixtureFor('/api/app-settings');
    if (PERSONA === 'staff') {   // what the route serves a staff-only user: no system / comms rows, nothing editable
      all.caps = { firm: false, system: false };
      all.settings = all.settings.filter((r) => r.home !== 'system' && r.home !== 'comms').map((r) => ({ ...r, can_edit: false }));
    }
    const homes = String(req.query.home || '').split(',').map((h) => h.trim()).filter(Boolean);
    const settings = homes.length ? all.settings.filter((r) => homes.includes(r.home)) : all.settings;
    const sections = {};
    for (const r of settings) sections[r.home] = all.sections[r.home];
    res.json({ ...all, sections, settings });
  });
  app.get(/^\/api\/app-settings\/([^/]+)\/history$/, (req, res) => {
    const h = fixtureFor(`/api/app-settings/${req.params[0]}/history`);
    res.json(h || { status: 'success', key: req.params[0], versions: [] });
  });
  app.put(/^\/api\/app-settings\/([^/]+)$/, express.json(), (req, res) => {
    res.json({ status: 'success', setting: { key: req.params[0], value: String((req.body || {}).value ?? ''), updated_at: new Date().toISOString() } });
  });
  app.post(/^\/api\/app-settings\/([^/]+)\/restore$/, express.json(), (req, res) => {
    const h = fixtureFor(`/api/app-settings/${req.params[0]}/history`);
    const v = h && h.versions.find((x) => x.id === Number((req.body || {}).version_id));
    if (!v) return res.status(404).json({ status: 'error', message: 'Version not found' });
    res.json({ status: 'success', setting: { key: req.params[0], value: v.old_value ?? '', updated_at: new Date().toISOString() } });
  });

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
