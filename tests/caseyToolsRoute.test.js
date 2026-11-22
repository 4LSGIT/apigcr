// Casey v2 S1 — the SU-only test route for the tool layer (routes/api.casey.js):
//   GET  /api/casey/tools             the definitions + the flag state
//   POST /api/casey/tools/:name       runs the tool AS THE CALLER
// Over a real socket with the real SU chain (superuserOnlyFor('casey'): JWT +
// su role + X-SU-Elevation + rate limit). firmConfig is mocked for the flag.
'use strict';

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'casey-tools-route-secret';

const flag = { value: null };
jest.mock('../lib/firmConfig', () => {
  const actual = jest.requireActual('../lib/firmConfig');
  return { ...actual, cfg: jest.fn((k) => (k === 'casey_v2_enabled' ? flag.value : actual.cfg(k))) };
});

const { mintElevationToken } = require('../lib/auth.superuser');
const router = require('../routes/api.casey');

const dbStub = { query: async () => [[], []], execute: async () => [[], []] };
let server, port;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = dbStub; next(); });
  app.use(router);
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  port = server.address().port;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => { flag.value = null; });

const su = jwt.sign({ sub: 6, username: 'IT', user_auth: 'authorized', roles: ['su'], aud: 'staff' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const staff = jwt.sign({ sub: 7, username: 'rena', user_auth: 'authorized', roles: ['admin'], aud: 'staff' }, process.env.JWT_SECRET, { expiresIn: '5m' });

function call(method, p, { token = su, elevate = true, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (elevate && token) headers['x-su-elevation'] = mintElevationToken(jwt.decode(token).sub);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('GET /api/casey/tools: SU + elevation only; lists the six definitions and the flag state', async () => {
  expect((await call('GET', '/api/casey/tools', { token: null })).status).toBe(401);
  expect((await call('GET', '/api/casey/tools', { token: staff })).status).toBe(403);
  expect((await call('GET', '/api/casey/tools', { elevate: false })).status).toBe(401); // the SU step-up 401 apiSend answers with the password prompt
  const r = await call('GET', '/api/casey/tools');
  expect(r.status).toBe(200);
  expect(r.body.status).toBe('success');
  expect(r.body.enabled).toBe(true);
  expect(r.body.tools.map((t) => t.name)).toEqual(['whoami', 'sql_read', 'api_get', 'lookup_routes', 'read_source', 'search_docs']);
  expect(Object.keys(r.body.tools[0])).toEqual(['name', 'description', 'input_schema']);
  flag.value = '0';
  expect((await call('GET', '/api/casey/tools')).body.enabled).toBe(false);
});

test('POST runs the tool as the caller (whoami sees the SU, its elevation, the IT username)', async () => {
  const r = await call('POST', '/api/casey/tools/whoami', { body: { input: {} } });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ status: 'success', ok: true, tool: 'whoami', untrusted: false });
  expect(r.body.data).toMatchObject({ user_id: 6, username: 'IT', roles: ['su'], is_superuser: true, elevated: true });
  expect(typeof r.body.ms).toBe('number');
  const noBody = await call('POST', '/api/casey/tools/whoami');
  expect(noBody.body.ok).toBe(true);
});

test('dark when casey_v2_enabled is "0": 403 before any tool runs; "1" and unset are on', async () => {
  flag.value = '0';
  const r = await call('POST', '/api/casey/tools/whoami', { body: { input: {} } });
  expect(r).toEqual({ status: 403, body: { status: 'error', message: 'Casey v2 is off (casey_v2_enabled = 0)' } });
  flag.value = '1';
  expect((await call('POST', '/api/casey/tools/whoami', { body: {} })).body.ok).toBe(true);
  flag.value = '';
  expect((await call('POST', '/api/casey/tools/whoami', { body: {} })).body.ok).toBe(true);
});

test('the SU chain guards POST too: no token 401, staff 403, SU without elevation 401 (step-up)', async () => {
  expect((await call('POST', '/api/casey/tools/whoami', { token: null, body: {} })).status).toBe(401);
  expect((await call('POST', '/api/casey/tools/whoami', { token: staff, body: {} })).status).toBe(403);
  expect((await call('POST', '/api/casey/tools/whoami', { elevate: false, body: {} })).status).toBe(401);
});

test('unknown tool → 404; non-object input → 400; bad input → 200 with an ok:false envelope', async () => {
  expect(await call('POST', '/api/casey/tools/nope', { body: { input: {} } })).toMatchObject({ status: 404, body: { status: 'error', message: 'no tool named "nope"' } });
  expect(await call('POST', '/api/casey/tools/whoami', { body: { input: [] } })).toMatchObject({ status: 400, body: { message: 'input must be an object' } });
  expect(await call('POST', '/api/casey/tools/whoami', { body: { input: 'x' } })).toMatchObject({ status: 400 });
  expect(await call('POST', '/api/casey/tools/whoami', { body: { input: null } })).toMatchObject({ status: 400 });
  const bad = await call('POST', '/api/casey/tools/search_docs', { body: { input: { nope: 1 } } });
  expect(bad).toMatchObject({ status: 200, body: { ok: false, error: { code: 'BAD_INPUT', message: 'unknown input key: nope' } } });
});

test('a tool that reads the catalog gets THIS app (req.app): lookup_routes finds the casey routes themselves', async () => {
  const r = await call('POST', '/api/casey/tools/lookup_routes', { body: { input: { q: '/api/casey' } } });
  expect(r.body.ok).toBe(true);
  expect(r.body.data.rows.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /api/casey/catalog', 'GET /api/casey/tools', 'POST /api/casey/tools/:name']);
  expect(r.body.data.rows.every((x) => x.auth === 'su' && x.tier === 'T3' && x.you.allowed === true)).toBe(true);
});
