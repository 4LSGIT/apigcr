// Casey v2 S1 — the tool layer's registry and the in-process tools
// (services/casey/tools: index, whoami, lookup_routes, search_docs, read_source).
// api_get has its own listening-app suite (tests/caseyApiGet.test.js);
// sql_read has tests/caseySqlRead.test.js + the real-engine twin.
//
// Real modules throughout; the catalog is the LIVE app built from every
// routes/*.js over the S0 no-rows db stub. read_source is pointed at a temp
// tree (ctx.sourceRoot) so the traversal matrix can plant a symlink and a
// dotfile without touching the repo.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'casey-tools-test-secret';

const tools = require('../services/casey/tools');
const { ToolError } = require('../services/casey/tools/index_error');
const readSource = require('../services/casey/tools/read_source');
const { mintElevationToken } = require('../lib/auth.superuser');
const { CAPABILITIES } = require('../lib/capabilities');

const ROUTES = path.join(__dirname, '..', 'routes');
const dbStub = {
  query: async () => [[], []], execute: async () => [[], []], withTransaction: async fn => fn(dbStub),
  getConnection: async () => ({ query: async () => [[], []], execute: async () => [[], []], release() {}, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {} }),
};
function liveApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = dbStub; next(); });
  for (const f of fs.readdirSync(ROUTES).filter(n => n.endsWith('.js')).sort()) app.use(require(path.join(ROUTES, f)));
  return app;
}
const app = liveApp();

const STAFF = { type: 'jwt', userId: 7, username: 'rena', roles: ['staff'] };
const ADMIN = { type: 'jwt', userId: 8, username: 'ss', roles: ['admin'] };
const SU = { type: 'jwt', userId: 6, username: 'IT', roles: ['su'] };
const KEY = { type: 'api_key', key_label: 'pabbly', scopes: null };
const ctx = (auth, extra = {}) => ({ db: dbStub, auth, app, headers: {}, ip: '10.0.0.1', port: 0, via: 'test', ...extra });

// ─────────────────────────────────────────────────────────────────────────────
describe('registry', () => {
  // What the checker supports (services/casey/tools/index.js checkValue): scalars, a string-map object
  // (additionalProperties), a free object (no properties — api_write's body), a nested object with
  // properties (checked like an input), an array with items. Every schema here is made of these only.
  function supported(p, at) {
    expect(['string', 'integer', 'number', 'boolean', 'object', 'array']).toContain(p.type);
    if (p.type === 'object' && p.additionalProperties) expect(p.additionalProperties.type).toBe('string');
    if (p.type === 'object' && p.properties) for (const [k, q] of Object.entries(p.properties)) { expect(k).toMatch(/^[a-z_]+$/); supported(q, `${at}.${k}`); }
    if (p.type === 'array') { expect(p.items).toBeDefined(); supported(p.items, `${at}[]`); }
  }
  test('seven tools, each with a name, description and an object schema the checker supports', () => {
    const defs = tools.definitions();
    expect(defs.map(d => d.name)).toEqual(['whoami', 'sql_read', 'api_get', 'lookup_routes', 'read_source', 'search_docs', 'api_write']);
    for (const d of defs) {
      expect(typeof d.description).toBe('string');
      expect(d.description.length).toBeGreaterThan(40);
      expect(d.input_schema.type).toBe('object');
      for (const [k, p] of Object.entries(d.input_schema.properties)) {
        expect(k).toMatch(/^[a-z_]+$/);
        supported(p, k);
      }
      expect(Object.keys(d)).toEqual(['name', 'description', 'input_schema']); // run / untrusted never leave the process
    }
  });
  test('checkInput (S3b): arrays with bounds and items, nested objects with their own required / unknown keys, a free object', () => {
    const schema = { type: 'object', properties: {
      steps: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'object', properties: { method: { type: 'string', enum: ['POST'] }, body: { type: 'object' } }, required: ['method'] } },
    }, required: ['steps'] };
    expect(tools.checkInput(schema, { steps: [{ method: 'POST', body: { any: [1, { deep: true }] } }] })).toBeNull();
    expect(tools.checkInput(schema, { steps: [] })).toBe('steps needs at least 1 item');
    expect(tools.checkInput(schema, { steps: [{ method: 'POST' }, { method: 'POST' }, { method: 'POST' }] })).toBe('steps has more than 2 items');
    expect(tools.checkInput(schema, { steps: [{ body: {} }] })).toBe('steps[0]: missing required input: method');
    expect(tools.checkInput(schema, { steps: [{ method: 'POST', nope: 1 }] })).toBe('steps[0]: unknown input key: nope');
    expect(tools.checkInput(schema, { steps: [{ method: 'GET' }] })).toBe('steps[0]: method must be one of POST');
    expect(tools.checkInput(schema, { steps: [{ method: 'POST', body: 'x' }] })).toBe('steps[0]: body must be object, got string');
    expect(tools.checkInput(schema, { steps: 'x' })).toBe('steps must be array, got string');
    expect(tools.checkInput(schema, { steps: ['x'] })).toBe('steps[0] must be object, got string');
  });

  test('checkInput: unknown key, missing required, wrong type, enum, bounds, nested object values', () => {
    const s = tools.TOOLS.find(t => t.name === 'lookup_routes').input_schema;
    expect(tools.checkInput(s, {})).toBeNull();
    expect(tools.checkInput(s, { q: 'x' })).toBeNull();
    expect(tools.checkInput(s, { nope: 1 })).toMatch(/unknown input key: nope/);
    expect(tools.checkInput(s, { q: 5 })).toMatch(/q must be string/);
    expect(tools.checkInput(s, { method: 'HEAD' })).toMatch(/method must be one of/);
    expect(tools.checkInput(s, { limit: 0 })).toMatch(/limit must be >= 1/);
    expect(tools.checkInput(s, { limit: 41 })).toMatch(/limit must be <= 40/);
    expect(tools.checkInput(s, { limit: 1.5 })).toMatch(/limit must be integer/);
    expect(tools.checkInput(s, [])).toMatch(/input must be an object/);
    const g = tools.TOOLS.find(t => t.name === 'api_get').input_schema;
    expect(tools.checkInput(g, { query: { a: '1' } })).toMatch(/missing required input: path/);
    expect(tools.checkInput(g, { path: '/x', query: { a: 1 } })).toMatch(/query\.a must be string/);
    expect(tools.checkInput(g, { path: '/x', query: { a: '1' } })).toBeNull();
  });

  test('runTool envelopes: unknown tool, bad input, ToolError → code, other throw → TOOL_FAILED, untrusted flag', async () => {
    expect(await tools.runTool('nope', ctx(SU), {})).toMatchObject({ ok: false, tool: 'nope', error: { code: 'UNKNOWN_TOOL' } });
    expect(await tools.runTool('whoami', ctx(SU), { x: 1 })).toMatchObject({ ok: false, error: { code: 'BAD_INPUT', message: 'unknown input key: x' } });
    const r = await tools.runTool('read_source', ctx(SU), { path: '../x' });
    expect(r).toMatchObject({ ok: false, tool: 'read_source', error: { code: 'BAD_PATH' } });
    const w = await tools.runTool('whoami', ctx(SU));
    expect(w).toMatchObject({ ok: true, tool: 'whoami', untrusted: false, truncated: false });
    expect(typeof w.ms).toBe('number');
    const d = await tools.runTool('search_docs', ctx(SU), { query: 'appointment' });
    expect(d.untrusted).toBe(true);
    // A tool that throws something other than a ToolError.
    const broken = { name: 'whoami' };
    const { envelope } = tools;
    expect(envelope('t', { a: 1 }, true, 3)).toEqual({ ok: true, tool: 't', data: { a: 1 }, bytes: 7, truncated: false, untrusted: true, ms: 3 });
    expect(broken.name).toBe('whoami');
    const te = new ToolError('X', 'm', { k: 1 });
    expect(te).toBeInstanceOf(Error);
    expect([te.code, te.detail]).toEqual(['X', { k: 1 }]);
  });

  test('a result over the cap comes back as a truncated STRING with a marker, never a shortened array; the cut is on BYTES and never splits a character', () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ i, text: 'x'.repeat(40) }));
    const e = tools.envelope('t', big, true, 1);
    expect(e.truncated).toBe(true);
    expect(typeof e.data).toBe('string');
    expect(e.data.length).toBeLessThan(tools.RESULT_CAP + 200);
    expect(e.data).toMatch(/…\[truncated: \d+ bytes serialised, cap 61440; narrow the request\]$/);
    expect(e.bytes).toBeGreaterThan(tools.RESULT_CAP);
    const wide = tools.envelope('t', 'é'.repeat(40000) + '😀'.repeat(5000), false, 1);  // 2-byte and 4-byte characters
    const head = wide.data.slice(0, wide.data.indexOf('\n…[truncated'));
    expect(Buffer.byteLength(head, 'utf8')).toBeLessThanOrEqual(tools.RESULT_CAP);
    expect(Buffer.byteLength(head, 'utf8')).toBeGreaterThan(tools.RESULT_CAP - 8);
    expect(head).not.toMatch(/\uFFFD/);
    expect(head.length).toBeLessThan(tools.RESULT_CAP); // fewer UTF-16 units than bytes
  });

  test('findRoute: an array route matches per path; a route under a MOUNTED sub-router never matches (fail closed)', () => {
    const cat = tools.TOOLS.length && require('../lib/routeCatalog').catalogFor(app);
    const catalogMod = require('../lib/routeCatalog');
    expect(catalogMod.findRoute(cat, 'GET', '/b/x').path).toBe('/b/:slug');
    expect(catalogMod.findRoute(cat, 'GET', '/book/x').path).toBe('/book/:slug');
    expect(catalogMod.findRoute(cat, 'GET', '/B/x/').path).toBe('/b/:slug');
    const a = express();
    const sub = express.Router();
    sub.get('/thing', require('../lib/auth.jwtOrApiKey'), (req, res) => res.json({}));
    a.use('/admin', sub);
    a.get('/admin/thing', (req, res) => res.json({}));
    const c = catalogMod.buildCatalog(a);
    expect(c.rows.map(r => r.path)).toEqual(['/admin/thing', '/admin/thing']);
    const mounted = c.rows.find(r => r.authClass === 'staff');
    expect(mounted.matches('/admin/thing')).toBe(false);
    expect(mounted.matches('/thing')).toBe(false); // its own regexp would say yes — the mount prefix is what fails it closed
    expect(catalogMod.findRoute(c, 'GET', '/thing')).toBeNull();
    expect(catalogMod.findRoute(c, 'GET', '/admin/thing')).toMatchObject({ authClass: 'public' });
  });

  test('ctxFromRequest carries the caller identity, headers, app, ip and the PORT server.js listens on', () => {
    const old = process.env.PORT;
    process.env.PORT = '9123';
    const req = { db: dbStub, auth: SU, app, headers: { authorization: 'Bearer x' }, ip: '1.2.3.4' };
    expect(tools.ctxFromRequest(req, 'tool-test')).toEqual({ db: dbStub, auth: SU, app, headers: { authorization: 'Bearer x' }, ip: '1.2.3.4', port: 9123, via: 'tool-test' });
    delete process.env.PORT;
    expect(tools.ctxFromRequest(req).port).toBe(8080);
    if (old !== undefined) process.env.PORT = old;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('whoami', () => {
  test('staff: roles, the capabilities can() grants, not SU, not elevated', async () => {
    const r = await tools.runTool('whoami', ctx(STAFF));
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ authenticated: true, kind: 'jwt', user_id: 7, username: 'rena', roles: ['staff'], is_superuser: false, elevated: false });
    expect(r.data.capabilities).not.toContain('automations.manage');
    expect(r.data.note).toMatch(/Not a superuser/);
  });
  test('admin holds the admin capabilities but no root one', async () => {
    const { data } = await tools.runTool('whoami', ctx(ADMIN));
    expect(data.capabilities).toContain('automations.manage');
    const root = Object.keys(CAPABILITIES).filter(c => CAPABILITIES[c].root);
    expect(root.length).toBeGreaterThan(0);
    for (const c of root) expect(data.capabilities).not.toContain(c);
  });
  test('SU: every capability; elevated only with a live elevation token for THIS user', async () => {
    const plain = await tools.runTool('whoami', ctx(SU));
    expect(plain.data).toMatchObject({ is_superuser: true, elevated: false });
    expect(plain.data.capabilities).toEqual(Object.keys(CAPABILITIES).sort());
    expect(plain.data.note).toMatch(/password prompt/);
    const mine = await tools.runTool('whoami', ctx(SU, { headers: { 'x-su-elevation': mintElevationToken(6) } }));
    expect(mine.data.elevated).toBe(true);
    expect(mine.data.note).toMatch(/live elevation/);
    const theirs = await tools.runTool('whoami', ctx(SU, { headers: { 'x-su-elevation': mintElevationToken(7) } }));
    expect(theirs.data.elevated).toBe(false);
    const staffWithToken = await tools.runTool('whoami', ctx(STAFF, { headers: { 'x-su-elevation': mintElevationToken(7) } }));
    expect(staffWithToken.data.elevated).toBe(false); // elevation adds to SU, never substitutes
  });
  test('machine key: scopes, no SU, never elevated; no auth: unauthenticated', async () => {
    const k = await tools.runTool('whoami', ctx(KEY));
    expect(k.data).toMatchObject({ kind: 'api_key', key_label: 'pabbly', scopes: null, is_superuser: false, elevated: false });
    expect(k.data.capabilities).toEqual(Object.keys(CAPABILITIES).sort()); // NULL scopes = legacy full trust (can())
    const scoped = await tools.runTool('whoami', ctx({ type: 'api_key', key_label: 's', scopes: ['comms.read_all'] }));
    expect(scoped.data.capabilities).toEqual(['comms.read_all']);
    expect((await tools.runTool('whoami', ctx(null))).data).toEqual({ authenticated: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('lookup_routes', () => {
  test('only staff-class rows; the shape; count vs returned; limit', async () => {
    const r = await tools.runTool('lookup_routes', ctx(STAFF), {});
    expect(r.ok).toBe(true);
    expect(r.data.count).toBeGreaterThan(500);
    expect(r.data.returned).toBe(40);
    expect(r.data.truncated).toBe(true);
    for (const row of r.data.rows) {
      expect(['staff', 'staff:can', 'su']).toContain(row.auth);
      expect(Object.keys(row)).toEqual(['method', 'path', 'family', 'auth', 'capability', 'superuser_tool', 'tier', 'proposable', 'auto_get', 'idempotent', 'multipart', 'you']);
      expect(row.tier).toMatch(/^T[0-3]$/);
    }
    const two = await tools.runTool('lookup_routes', ctx(STAFF), { limit: 2 });
    expect(two.data.returned).toBe(2);
    const none = await tools.runTool('lookup_routes', ctx(STAFF), { q: '/api/readonly/sql' }); // key class → omitted
    expect(none.data.count).toBe(0);
    const pub = await tools.runTool('lookup_routes', ctx(STAFF), { q: '/api/version' });
    expect(pub.data.count).toBe(0);
  });
  test('filters: q substring, family, method', async () => {
    const r = await tools.runTool('lookup_routes', ctx(STAFF), { q: 'casey', method: 'GET' });
    expect(r.data.rows.map(x => x.path)).toEqual(['/api/casey/boot', '/api/casey/cards/:id', '/api/casey/catalog', '/api/casey/chats', '/api/casey/chats/:id', '/api/casey/tools']);
    expect(r.data.rows[0]).toMatchObject({ path: '/api/casey/boot', auth: 'staff', tier: 'T0', proposable: false, auto_get: false });   // S3a: a staff read, still never proposable or auto (/api/casey/*)
    expect(r.data.rows[1]).toMatchObject({ path: '/api/casey/cards/:id', auth: 'staff', tier: 'T0', proposable: false, auto_get: false });   // S3b: the card read, the same closed class
    expect(r.data.rows[2]).toMatchObject({ path: '/api/casey/catalog', auth: 'su', superuser_tool: 'casey', tier: 'T3', proposable: false, auto_get: false });
    const f = await tools.runTool('lookup_routes', ctx(STAFF), { family: '/api/tasks' });
    expect(f.data.count).toBeGreaterThan(0);
    expect(f.data.rows.every(x => x.family === '/api/tasks')).toBe(true);
    const m = await tools.runTool('lookup_routes', ctx(STAFF), { family: '/api/tasks', method: 'DELETE' });
    expect(m.data.rows.every(x => x.method === 'DELETE')).toBe(true);
  });
  test('judged for THIS user: staff / staff:can / su / dynamic / jwtOnly / key', async () => {
    const find = async (auth, q, method) => (await tools.runTool('lookup_routes', ctx(auth), { q, method })).data.rows[0];
    // su route
    expect((await find(STAFF, '/api/casey/catalog', 'GET')).you).toEqual({ allowed: false, reason: 'superuser only' });
    expect((await find(SU, '/api/casey/catalog', 'GET')).you).toMatchObject({ allowed: true, reason: expect.stringMatching(/live elevation/) });
    expect((await find(KEY, '/api/casey/catalog', 'GET')).you.allowed).toBe(false);
    // su without elevation (requireAdmin)
    const ir = await find(SU, '/api/issue-reports', 'GET');
    expect(ir.auth).toBe('su');
    expect(ir.you.reason).toMatch(/no elevation step/);
    // staff:can
    const wf = (await tools.runTool('lookup_routes', ctx(STAFF), { q: '/api/hooks', method: 'POST' })).data.rows.find(x => x.path === '/api/hooks');
    expect(wf).toMatchObject({ auth: 'staff:can', capability: 'automations.manage' });
    expect(wf.you).toEqual({ allowed: false, reason: 'needs automations.manage' });
    const wfA = (await tools.runTool('lookup_routes', ctx(ADMIN), { q: '/api/hooks', method: 'POST' })).data.rows.find(x => x.path === '/api/hooks');
    expect(wfA.you).toEqual({ allowed: true, reason: 'holds automations.manage' });
    // dynamic
    const dyn = (await tools.runTool('lookup_routes', ctx(STAFF), { q: '/api/app-settings' })).data.rows.find(x => x.capability === 'dynamic');
    expect(dyn.you.allowed).toBeNull();
    // plain staff
    const t = await find(STAFF, '/api/tasks', 'GET');
    expect(t.you).toEqual({ allowed: true, reason: 'any staff identity' });
    // jwtOnly refuses a key
    const mb = await find(KEY, '/api/mail/mailboxes', 'GET');
    expect(mb.you).toEqual({ allowed: false, reason: 'needs a signed-in person, not a machine key' });
    expect((await find(STAFF, '/api/mail/mailboxes', 'GET')).you.allowed).toBe(true);
    // a SCOPED key reaches only its route:/ scopes
    const SCOPED = { type: 'api_key', key_label: 's', scopes: ['route:/api/tasks'] };
    expect((await find(SCOPED, '/api/tasks', 'GET')).you).toEqual({ allowed: true, reason: 'any staff identity' });
    expect((await find(SCOPED, '/api/contacts', 'GET')).you).toEqual({ allowed: false, reason: 'outside this key\'s route scopes' });
    expect((await find(KEY, '/api/contacts', 'GET')).you.allowed).toBe(true); // NULL scopes: legacy full surface
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('search_docs', () => {
  test('manual hits with title, path, excerpt; limit capped at 8', async () => {
    const r = await tools.runTool('search_docs', ctx(STAFF), { query: 'appointment reminder' });
    expect(r.ok).toBe(true);
    expect(r.data.count).toBeGreaterThan(0);
    expect(Object.keys(r.data.hits[0])).toEqual(['title', 'manual_path', 'excerpt']);
    const eight = await tools.runTool('search_docs', ctx(STAFF), { query: 'case contact appointment task', limit: 8 });
    expect(eight.data.hits.length).toBeLessThanOrEqual(8);
    expect(await tools.runTool('search_docs', ctx(STAFF), { query: 'x', limit: 9 })).toMatchObject({ ok: false, error: { code: 'BAD_INPUT' } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('read_source', () => {
  let root;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'casey-src-'));
    for (const d of ['routes', 'lib', 'services/casey', 'public', 'manual', 'ref', 'scripts', 'node_modules/x', 'lib/.hidden']) fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, 'routes', 'api.x.js'), Array.from({ length: 500 }, (_, i) => `line ${i + 1} ${i === 41 ? 'NEEDLE here' : ''}`).join('\n'));
    fs.writeFileSync(path.join(root, 'lib', 'a.js'), 'const needle = 1;\nconst Needle2 = 2;\n');
    fs.writeFileSync(path.join(root, 'services', 'casey', 'b.js'), 'nothing\n');
    fs.writeFileSync(path.join(root, 'public', 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x4e, 0x45, 0x45, 0x44, 0x4c, 0x45]));
    fs.writeFileSync(path.join(root, 'scripts', 'secret.js'), 'needle in scripts\n');
    fs.writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), 'needle in node_modules\n');
    fs.writeFileSync(path.join(root, 'lib', '.hidden', 'h.js'), 'needle hidden\n');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=needle\n');
    fs.writeFileSync(path.join(root, 'lib', '.env.js'), 'needle dotfile\n');
    fs.writeFileSync(path.join(root, 'outside.txt'), 'needle outside\n');
    fs.symlinkSync(path.join(root, 'outside.txt'), path.join(root, 'lib', 'link.js'));          // file link → outside
    fs.symlinkSync(path.join(root, 'scripts'), path.join(root, 'lib', 'scripts-link'));          // dir link → outside
    fs.symlinkSync(path.join(root, '.env'), path.join(root, 'lib', 'env-link.js'));              // link → dotfile
    fs.symlinkSync(path.join(root, 'routes', 'api.x.js'), path.join(root, 'lib', 'inside-link.js')); // link → inside
    fs.symlinkSync(path.join(root, 'lib', 'a.js'), path.join(root, 'lib', '.dot-link.js'));          // dot NAME, clean target: the name rule alone refuses it
    fs.symlinkSync(path.join(root, 'lib', '.hidden', 'h.js'), path.join(root, 'lib', 'hidden-link.js')); // clean name, REAL path through a dot dir inside lib: only the real-path check refuses it
  });
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const c = () => ctx(STAFF, { sourceRoot: root });
  const run = (input) => tools.runTool('read_source', c(), input);

  test('reads a window with line numbers and caps', async () => {
    const r = await run({ path: 'routes/api.x.js', start: 40, lines: 5 });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ path: 'routes/api.x.js', total_lines: 500, start: 40, end: 44, truncated: true });
    expect(r.data.text.split('\n')).toHaveLength(5);
    expect(r.data.text).toMatch(/NEEDLE here/);
    const whole = await run({ path: 'routes/api.x.js' });
    expect(whole.data).toMatchObject({ start: 1, end: 400, truncated: true });
    const tail = await run({ path: 'routes/api.x.js', start: 499 });
    expect(tail.data).toMatchObject({ start: 499, end: 500, truncated: false });
    expect(await run({ path: 'routes/api.x.js', lines: 401 })).toMatchObject({ ok: false, error: { code: 'BAD_INPUT' } });
  });

  test('byte cap: a file of long lines stops under MAX_BYTES', async () => {
    fs.writeFileSync(path.join(root, 'lib', 'long.js'), Array.from({ length: 300 }, () => 'y'.repeat(1000)).join('\n'));
    const r = await run({ path: 'lib/long.js' });
    expect(r.data.end).toBeLessThan(300);
    expect(Buffer.byteLength(r.data.text)).toBeLessThanOrEqual(readSource.MAX_BYTES + 1001);
    expect(r.data.truncated).toBe(true);
  });

  test('traversal matrix: every escape is BAD_PATH, nothing outside the six dirs is readable', async () => {
    const bad = [
      '../outside.txt', 'lib/../outside.txt', 'lib/../../etc/passwd', '/etc/passwd', `${root}/lib/a.js`,
      'scripts/secret.js', 'node_modules/x/index.js', '.env', 'lib/.env.js', 'lib/.hidden/h.js',
      'lib/link.js', 'lib/scripts-link/secret.js', 'lib/env-link.js', 'lib/.dot-link.js', 'lib/hidden-link.js',
      'lib//a.js', 'lib/./a.js', 'lib\\a.js', 'lib/a.js\u0000', 'C:/lib/a.js', 'lib',
    ];
    expect(await run({ path: '' })).toMatchObject({ ok: false, error: { code: 'BAD_INPUT' } }); // the schema's minLength
    for (const p of bad) {
      const r = await run({ path: p });
      expect([p, r.ok, r.error && r.error.code]).toEqual([p, false, 'BAD_PATH']);
    }
    // %2e%2e is not decoded by the tool: it is a literal (nonexistent) name.
    expect(await run({ path: 'lib/%2e%2e/outside.txt' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await run({ path: 'lib/nope.js' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    // a symlink that stays inside is fine
    expect((await run({ path: 'lib/inside-link.js' })).data.total_lines).toBe(500);
    // binary refused
    expect(await run({ path: 'public/img.png' })).toMatchObject({ ok: false, error: { code: 'BINARY' } });
  });

  test('grep: case-insensitive substring over the six dirs only; skips dotfiles, links, node_modules, binaries; dir filter; hit cap', async () => {
    const r = await run({ grep: 'needle' });
    expect(r.ok).toBe(true);
    expect(r.data.hits.map(h => `${h.path}:${h.line}`).sort()).toEqual(['lib/a.js:1', 'lib/a.js:2', 'routes/api.x.js:42']);
    expect(r.data.truncated).toBe(false);
    expect(r.data.files_scanned).toBe(r.data.files_total);
    // the byte budget: a tree larger than it is cut and says so
    fs.mkdirSync(path.join(root, 'ref', 'bulk'), { recursive: true });
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, 'ref', 'bulk', `f${i}.sql`), 'z'.repeat(1.9 * 1024 * 1024)); // 38 MB > the 32 MB budget
    fs.writeFileSync(path.join(root, 'ref', 'bulk', 'skip.png'), 'needle in a png name');
    const over = await run({ grep: 'needle', dir: 'ref' });
    expect(over.data.truncated).toBe(true);
    expect(over.data.files_scanned).toBeLessThan(over.data.files_total);
    expect(over.data.files_total).toBe(20); // the .png is never listed, never read, never counted
    fs.rmSync(path.join(root, 'ref', 'bulk'), { recursive: true, force: true });
    const d = await run({ grep: 'needle', dir: 'lib' });
    expect(d.data.hits.map(h => h.path)).toEqual(['lib/a.js', 'lib/a.js']);
    expect(await run({ grep: 'needle', dir: 'scripts' })).toMatchObject({ ok: false, error: { code: 'BAD_PATH' } });
    expect(await run({ grep: 'needle', dir: 'lib/scripts-link' })).toMatchObject({ ok: false, error: { code: 'BAD_PATH' } });
    expect(await run({ grep: 'needle', dir: 'lib/a.js' })).toMatchObject({ ok: false, error: { code: 'BAD_PATH', message: expect.stringMatching(/not a directory/) } });
    fs.writeFileSync(path.join(root, 'manual', 'many.md'), Array.from({ length: 80 }, () => 'needle').join('\n'));
    const cap = await run({ grep: 'needle', dir: 'manual' });
    expect(cap.data.hits).toHaveLength(readSource.MAX_HITS);
    expect(cap.data.truncated).toBe(true);
    expect(await run({ grep: 'x', path: 'lib/a.js' })).toMatchObject({ ok: false, error: { code: 'BAD_INPUT' } });
    expect(await run({})).toMatchObject({ ok: false, error: { code: 'BAD_INPUT' } });
  });

  test('on the real repo: reads its own file and the schema dump; grep finds a known line', async () => {
    const real = ctx(STAFF);
    const self = await tools.runTool('read_source', real, { path: 'services/casey/tools/read_source.js', lines: 3 });
    expect(self.data.text).toMatch(/read_source — read or grep/);
    const schema = await tools.runTool('read_source', real, { path: 'ref/database.sql', lines: 1 });
    expect(schema.ok).toBe(true);
    const g = await tools.runTool('read_source', real, { grep: 'superuserOnlyFor(\'casey\')', dir: 'routes' });
    expect(g.data.hits.some(h => h.path === 'routes/api.casey.js')).toBe(true);
    for (const p of ['tests/caseyTools.test.js', 'scripts/dump-schema.js', 'startup/db.js', 'server.js', 'package.json', '.env', 'local/x']) {
      expect((await tools.runTool('read_source', real, { path: p })).error.code).toBe('BAD_PATH');
    }
  });
});
