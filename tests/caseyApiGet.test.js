// Casey v2 S1 — api_get against a LISTENING app: every routes/*.js over the
// S0 no-rows db stub, plus a probe router mounted on the same app (so the
// catalog classifies it like any route: staff, T0, autoGet). Proves, over a
// real socket:
//   • the forwarded headers reach the route — the probe echoes req.auth (the
//     user the route sees), X-Forwarded-For, User-Agent, X-Casey-Via, and the
//     absence of X-SU-Elevation;
//   • a non-autoGet row is refused BEFORE any request (the probe counts hits);
//   • a non-JSON response is refused by content type; a 4xx/5xx JSON answer is
//     returned as data; a hanging route times out;
//   • the path rules (query string, .. / encoded, //, control chars) and
//     findRoute's first-registered-wins order.
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'casey-apiget-test-secret';

const tools = require('../services/casey/tools');
const catalog = require('../lib/routeCatalog');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

const ROUTES = path.join(__dirname, '..', 'routes');
const dbStub = {
  query: async () => [[], []], execute: async () => [[], []], withTransaction: async fn => fn(dbStub),
  getConnection: async () => ({ query: async () => [[], []], execute: async () => [[], []], release() {}, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {} }),
};

const hits = [];
const probe = express.Router();
probe.get('/api/_casey_probe/echo', jwtOrApiKey, (req, res) => {
  hits.push('echo');
  res.json({ user: req.auth.username, userId: req.auth.userId, xff: req.headers['x-forwarded-for'] || null, ua: req.headers['user-agent'],
    via: req.headers['x-casey-via'] || null, elev: req.headers['x-su-elevation'] || null, ae: req.headers['accept-encoding'], q: req.query });
});
probe.get('/api/_casey_probe/text', jwtOrApiKey, (req, res) => { hits.push('text'); res.type('text/plain').send('hello'); });
probe.get('/api/_casey_probe/pdf', jwtOrApiKey, (req, res) => { hits.push('pdf'); res.type('application/pdf').send(Buffer.from('%PDF')); });
probe.get('/api/_casey_probe/bad', jwtOrApiKey, (req, res) => { hits.push('bad'); res.type('application/json').send('{nope'); });
probe.get('/api/_casey_probe/forbidden', jwtOrApiKey, (req, res) => { hits.push('forbidden'); res.status(403).json({ status: 'error', message: 'needs automations.manage' }); });
probe.get('/api/_casey_probe/hang', jwtOrApiKey, (req, res) => { hits.push('hang'); req.on('close', () => res.end()); });
probe.get('/api/_casey_probe/redirect', jwtOrApiKey, (req, res) => { hits.push('redirect'); res.redirect(302, '/api/casey/catalog'); });
probe.get('/api/_casey_probe/jsonseq', jwtOrApiKey, (req, res) => { hits.push('jsonseq'); res.type('application/json-seq').send('{}\n'); });
probe.get('/api/_casey_probe/big', jwtOrApiKey, (req, res) => { hits.push('big'); res.json({ pad: 'x'.repeat(3 * 1024 * 1024) }); });
let slowClosedEarly = null;
probe.get('/api/_casey_probe/text-slow', jwtOrApiKey, (req, res) => {
  hits.push('text-slow');
  res.type('text/plain'); res.write('x'.repeat(1000));
  setTimeout(() => { slowClosedEarly = req.socket.destroyed; res.end(); }, 250);
});
probe.get('/api/_casey_probe/:id', jwtOrApiKey, (req, res) => { hits.push('param'); res.json({ id: req.params.id }); });
probe.get('/api/_casey_probe/literal', jwtOrApiKey, (req, res) => { hits.push('literal-after-param'); res.json({ literal: true }); });

// server.js registers `GET /:page` (public, no gate) BEFORE every router; it
// calls next() when public/<page>.html is missing. Modelled here, first.
const pageCatchAll = express.Router();
pageCatchAll.get('/:page', (req, res, next) => { hits.push('page:' + req.params.page); if (req.params.page === 'served') return res.type('text/html').send('<html>'); next(); });
// Any OTHER public route registered before a gated one on the same path keeps first-registered-wins.
pageCatchAll.get('/api/_casey_probe/pubfirst', (req, res) => { hits.push('pubfirst-public'); res.json({ pub: true }); });
probe.get('/_casey_single', jwtOrApiKey, (req, res) => { hits.push('single'); res.json({ single: true }); });
probe.get('/api/_casey_probe/pubfirst', jwtOrApiKey, (req, res) => { hits.push('pubfirst-staff'); res.json({ staff: true }); });

let app, server, port;
const token = jwt.sign({ sub: 6, username: 'IT', user_type: 1, user_auth: 'authorized', roles: ['su'], aud: 'staff' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const staffToken = jwt.sign({ sub: 7, username: 'rena', user_auth: 'authorized', roles: ['staff'], aud: 'staff' }, process.env.JWT_SECRET, { expiresIn: '10m' });

beforeAll(async () => {
  app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use((req, _res, next) => { req.db = dbStub; next(); });
  app.use(pageCatchAll);
  app.use(probe);
  for (const f of fs.readdirSync(ROUTES).filter(n => n.endsWith('.js')).sort()) app.use(require(path.join(ROUTES, f)));
  server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  port = server.address().port;
});
afterAll(async () => { await new Promise(r => server.close(r)); });
beforeEach(() => { hits.length = 0; });

const ctx = (extra = {}) => ({
  db: dbStub, auth: { type: 'jwt', userId: 6, username: 'IT', roles: ['su'] }, app, port, via: 'tool-test', ip: '203.0.113.9',
  headers: { authorization: `Bearer ${token}`, 'user-agent': 'jest-ua', 'x-forwarded-for': '198.51.100.7', 'x-su-elevation': 'ELEV-SHOULD-NOT-FORWARD' },
  ...extra,
});
const get = (input, extra) => tools.runTool('api_get', ctx(extra), input);

test('the probe rows are catalogued as staff / T0 / autoGet, so this suite tests the real rule', () => {
  const cat = catalog.catalogFor(app);
  const echo = cat.rows.find(r => r.path === '/api/_casey_probe/echo');
  expect(echo).toMatchObject({ method: 'GET', authClass: 'staff', tier: 0, autoGet: true, proposable: true });
  expect(cat.unknown).toEqual([]);
});

test('forwards the caller identity and the audit headers; never X-SU-Elevation; query as an object', async () => {
  const r = await get({ path: '/api/_casey_probe/echo', query: { a: '1', b: 'x y&z' } });
  expect(r.ok).toBe(true);
  expect(r.untrusted).toBe(true);
  expect(r.data).toEqual({ route: '/api/_casey_probe/echo', status: 200, body: {
    user: 'IT', userId: 6, xff: '198.51.100.7', ua: 'jest-ua', via: 'tool-test', elev: null, ae: 'identity', q: { a: '1', b: 'x y&z' } } });
  expect(hits).toEqual(['echo']);
  // Without an X-Forwarded-For header the caller's own ip is forwarded.
  const own = await get({ path: '/api/_casey_probe/echo' }, { headers: { authorization: `Bearer ${token}` } });
  expect(own.data.body).toMatchObject({ xff: '203.0.113.9', ua: 'casey', via: 'tool-test' });
  // A different caller is a different user at the route.
  const rena = await get({ path: '/api/_casey_probe/echo' }, { auth: { type: 'jwt', userId: 7, username: 'rena', roles: ['staff'] }, headers: { authorization: `Bearer ${staffToken}` } });
  expect(rena.data.body).toMatchObject({ user: 'rena', userId: 7 });
  // The route's own auth judges the forwarded token: a bad one is a 401 as data.
  const bad = await get({ path: '/api/_casey_probe/echo' }, { headers: { authorization: 'Bearer nope' } });
  expect(bad.ok).toBe(true);
  expect(bad.data.status).toBe(401);
  expect(await get({ path: '/api/_casey_probe/echo' }, { headers: {} })).toMatchObject({ ok: false, error: { code: 'NO_AUTH' } });
});

test('a real staff route over the stubbed app: GET /api/availability-blocks answers JSON', async () => {
  const r = await get({ path: '/api/availability-blocks' });
  expect(r.ok).toBe(true);
  expect(r.data).toEqual({ route: '/api/availability-blocks', status: 200, body: { status: 'success', rows: [] } });
});

test('refused before any request: su rows (T3), never-auto reads, public, key, portal, unknown path, wrong method', async () => {
  const cases = [
    ['/api/casey/catalog', 'NOT_AUTO_GET', /superuser route \(T3\)/],
    ['/api/casey/tools', 'NOT_AUTO_GET', /superuser route/],
    ['/api/credentials', 'NOT_AUTO_GET', /T\d read closed to automatic calls/],
    ['/api/api-keys', 'NOT_AUTO_GET', /superuser route/],
    ['/api/email-credentials', 'NOT_AUTO_GET', /closed to automatic calls/],
    ['/api/hooks/5', 'NOT_AUTO_GET', /closed to automatic calls/],
    ['/api/version', 'NOT_AUTO_GET', /public route — not a staff route/],
    ['/api/readonly/whoami', 'NOT_AUTO_GET', /key route/],
    ['/api/portal/me', 'NOT_AUTO_GET', /portal route/],
    ['/api/no/such/route', 'NO_ROUTE', /no GET route serves/],
    ['/api/casey/tools/whoami', 'NO_ROUTE', /no GET route/],      // POST-only path
  ];
  for (const [p, code, msg] of cases) {
    const r = await get({ path: p });
    expect([p, r.ok, r.error && r.error.code]).toEqual([p, false, code]);
    expect(r.error.message).toMatch(msg);
  }
  expect(hits).toEqual([]);
});

test('path rules: query string, fragments, dot segments (raw and encoded), //, whitespace, control, backslash, malformed escape', async () => {
  const bad = ['/api/_casey_probe/echo?a=1', '/api/_casey_probe/echo#x', '/api/../etc', '/api/%2e%2e/x', '/api/./x', '/api//x', '/api/x y',
    '/api/x\u0007', '/api\\x', '/api/%zz', 'api/x', '', '/' + 'a'.repeat(2001)];
  for (const p of bad) {
    const r = await get({ path: p });
    expect([p.slice(0, 30), r.ok, r.error && r.error.code]).toEqual([p.slice(0, 30), false, p === '' ? 'BAD_INPUT' : p.length > 2000 ? 'BAD_INPUT' : 'BAD_PATH']);
  }
  expect(hits).toEqual([]);
});

test('the /:page catch-all does not shadow a single-segment staff route; a page it SERVES is refused as public', async () => {
  const cat = catalog.catalogFor(app);
  expect(cat.rows.find(r => r.path === '/:page')).toMatchObject({ authClass: 'public', autoGet: false });
  expect(catalog.findRoute(cat, 'GET', '/_casey_single').path).toBe('/_casey_single');
  const r = await get({ path: '/_casey_single' });
  expect(r.data).toEqual({ route: '/_casey_single', status: 200, body: { single: true } });
  expect(hits).toEqual(['page:_casey_single', 'single']); // Express ran the catch-all first and it passed through
  // a path only the catch-all serves: findRoute returns the public row → refused, never requested
  hits.length = 0;
  const s = await get({ path: '/served' });
  expect(s).toMatchObject({ ok: false, error: { code: 'NOT_AUTO_GET', message: expect.stringMatching(/GET \/:page — public route/) } });
  expect(hits).toEqual([]);
  // the real catalog of this app lists single-segment autoGet staff routes the catch-all would shadow
  expect(catalog.findRoute(cat, 'GET', '/workflows')).toMatchObject({ path: '/workflows', autoGet: true });
  // only /:page is pass-through: another public row registered first still wins (and is refused — it may have side effects)
  expect(catalog.PASS_THROUGH).toEqual(new Set(['GET /:page']));
  hits.length = 0;
  const pf = await get({ path: '/api/_casey_probe/pubfirst' });
  expect(pf).toMatchObject({ ok: false, error: { code: 'NOT_AUTO_GET', message: expect.stringMatching(/public route/) } });
  expect(hits).toEqual([]);
});

test('a redirect is refused and never followed — the target route is not hit', async () => {
  const r = await get({ path: '/api/_casey_probe/redirect' });
  expect(r).toMatchObject({ ok: false, error: { code: 'REDIRECT', status: 302, location: '/api/casey/catalog' } });
  expect(hits).toEqual(['redirect']);
});

test('the content type is judged from the headers BEFORE the body is read: a slow text body is cancelled, a 3 MB JSON body is cut at the cap', async () => {
  const t = await get({ path: '/api/_casey_probe/text-slow' });
  expect(t).toMatchObject({ ok: false, error: { code: 'NON_JSON' } });
  await new Promise(r => setTimeout(r, 400));
  expect(slowClosedEarly).toBe(true);
  const big = await get({ path: '/api/_casey_probe/big' });
  expect(big).toMatchObject({ ok: false, error: { code: 'TOO_LARGE', cap: 1024 * 1024 } });
  const small = await get({ path: '/api/_casey_probe/big' }, { maxBody: 4 * 1024 * 1024 });
  expect(small.ok).toBe(true);
  expect(small.truncated).toBe(true); // the envelope's own 60 KB cap
  expect(await get({ path: '/api/_casey_probe/jsonseq' })).toMatchObject({ ok: false, error: { code: 'NON_JSON', content_type: expect.stringMatching(/json-seq/) } });
});

test('non-JSON answers are refused by content type; unparseable JSON too; a 403 JSON is data', async () => {
  const t = await get({ path: '/api/_casey_probe/text' });
  expect(t).toMatchObject({ ok: false, error: { code: 'NON_JSON', status: 200, content_type: expect.stringMatching(/^text\/plain/) } });
  const p = await get({ path: '/api/_casey_probe/pdf' });
  expect(p).toMatchObject({ ok: false, error: { code: 'NON_JSON', content_type: 'application/pdf' } });
  const b = await get({ path: '/api/_casey_probe/bad' });
  expect(b).toMatchObject({ ok: false, error: { code: 'BAD_JSON', status: 200 } });
  const f = await get({ path: '/api/_casey_probe/forbidden' });
  expect(f).toMatchObject({ ok: true, data: { status: 403, body: { status: 'error', message: 'needs automations.manage' } } });
  expect(hits).toEqual(['text', 'pdf', 'bad', 'forbidden']);
});

test('a hanging route times out at the ctx limit', async () => {
  const r = await get({ path: '/api/_casey_probe/hang' }, { timeoutMs: 300 });
  expect(r).toMatchObject({ ok: false, error: { code: 'TIMEOUT', message: 'no response within 300 ms' } });
  expect(hits).toEqual(['hang']);
});

test('findRoute dispatches like Express: first registered row wins, by method, _ALL rows match any method', async () => {
  const cat = catalog.catalogFor(app);
  // /api/_casey_probe/literal is registered AFTER /:id — Express would run /:id.
  expect(catalog.findRoute(cat, 'GET', '/api/_casey_probe/literal').path).toBe('/api/_casey_probe/:id');
  expect(catalog.findRoute(cat, 'GET', '/api/_casey_probe/echo').path).toBe('/api/_casey_probe/echo');
  const r = await get({ path: '/api/_casey_probe/literal' });
  expect(r.data.body).toEqual({ id: 'literal' });
  expect(hits).toEqual(['param']);
  expect(catalog.findRoute(cat, 'POST', '/api/_casey_probe/echo')).toBeNull();
  expect(catalog.findRoute(cat, 'GET', '/ringcentral/send-sms').method).toBe('_ALL');
  expect(catalog.findRoute(cat, 'PATCH', '/ringcentral/send-sms').method).toBe('_ALL');
  expect(catalog.findRoute(cat, 'GET', '/api/tasks/12')).toMatchObject({ method: 'GET' });
  expect(catalog.findRoute(cat, 'GET', '/api/casey/catalog').path).toBe('/api/casey/catalog');
  // matches() is stateless and never touches the layer's params.
  const row = cat.rows.find(x => x.path === '/api/_casey_probe/:id');
  expect([row.matches('/api/_casey_probe/9'), row.matches('/api/_casey_probe/9'), row.matches('/api/_casey_probe/9/x')]).toEqual([true, true, false]);
  expect(Object.keys(row)).not.toContain('matches');
  expect(Object.keys(row)).not.toContain('seq');
});
