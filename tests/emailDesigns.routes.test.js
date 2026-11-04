// tests/emailDesigns.routes.test.js
//
/**
 * YisraMail C3a — routes/api.emailDesigns.js, the FIXED contract C3b builds against:
 *   POST  /api/email-designs      {name, design_json, html, text} → {success, id, warning?} | 400 {error, code:'design_rejected', rule, detail}
 *   GET   /api/email-designs      ?q= &include_archived= → {designs:[{id, name, builder, updated_at, archived}]} (no bodies)
 *   GET   /api/email-designs/:id  → {design} (full row)
 *   PUT   /api/email-designs/:id  same as POST
 *   PATCH /api/email-designs/:id  {archived: true|false} → {success}
 * The REAL auth middleware (lib/auth.jwtOrApiKey): no token / a portal token → 401, a key scoped
 * to another route → 403, a staff JWT → through. The routes and the service run for real over a
 * scripted db — a rejected save never reaches an INSERT / UPDATE.
 * Run: npx jest tests/emailDesigns.routes.test.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-email-designs';

const express = require('express');
const jwt = require('jsonwebtoken');
const F = require('./helpers/emailDesignFixture');

const SECRET = process.env.JWT_SECRET;
const SCOPED_KEY = 'yck_' + 'S'.repeat(22);   // secret-scan: allow (fake test key)

function makeDb() {
  const T = { rows: new Map(), writes: [], nextId: 41, audits: 0 };
  const query = async (raw, p = []) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    if (/jwt_api_audit_log/.test(sql)) { T.audits++; return [{}]; }
    if (/FROM api_keys WHERE key_hash/.test(sql)) {
      const { hashKey } = require('../lib/apiKeys');
      return [p[0] === hashKey(SCOPED_KEY) ? [{ id: 9, label: 'scoped', revoked_at: null, expires_at: null, scopes: JSON.stringify(['route:/api/campaigns']) }] : []];
    }
    if (/SET last_used_at/.test(sql)) return [{}];
    if (/^INSERT INTO email_designs/.test(sql)) {
      const id = T.nextId++;
      T.writes.push({ sql, p });
      T.rows.set(id, { id, name: p[0], builder: p[1], design_json: p[2], html: p[3], text: p[4], thumbnail_asset_id: null, created_by: p[5], created_at: new Date(), updated_at: new Date(), archived: 0 });
      return [{ insertId: id }];
    }
    if (/^UPDATE email_designs SET name = \?/.test(sql)) {
      T.writes.push({ sql, p });
      const row = T.rows.get(p[4]);
      if (!row) return [{ affectedRows: 0 }];
      Object.assign(row, { name: p[0], design_json: p[1], html: p[2], text: p[3] });
      return [{ affectedRows: 1 }];
    }
    if (/^UPDATE email_designs SET archived = \?/.test(sql)) {
      T.writes.push({ sql, p });
      const row = T.rows.get(p[1]);
      if (!row) return [{ affectedRows: 0 }];
      row.archived = p[0];
      return [{ affectedRows: 1 }];
    }
    if (/^SELECT id, name, builder, design_json/.test(sql)) return [[T.rows.get(p[0])].filter(Boolean)];
    if (/^SELECT id, name, builder, updated_at, archived FROM email_designs/.test(sql)) {
      T.lastList = { sql, p };
      let rows = [...T.rows.values()];
      if (/archived = 0/.test(sql)) rows = rows.filter((r) => !r.archived);
      return [rows.map(({ id, name, builder, updated_at, archived }) => ({ id, name, builder, updated_at, archived }))];
    }
    throw new Error(`unscripted: ${sql}`);
  };
  return { T, query };
}

let currentDb, server, base;
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => { req.db = currentDb; next(); });
app.use(require('../routes/api.emailDesigns'));

beforeAll(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => {
  currentDb = makeDb();
  require('../lib/apiKeys').invalidateCache();
  for (const m of ['log', 'warn', 'error']) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const staff = () => jwt.sign({ sub: 9, username: 'sam', user_type: 'staff', user_auth: 'authorized', aud: 'staff', roles: ['staff'] }, SECRET, { expiresIn: '1h' });
const portal = () => jwt.sign({ sub: 77, aud: 'contact' }, SECRET, { expiresIn: '1h' });
async function call(method, url, body, headers = { Authorization: `Bearer ${staff()}` }) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}
const good = (over = {}) => ({ name: 'November newsletter', design_json: F.design(), html: F.html(), text: 'Hi there', ...over });

describe('auth — the real jwtOrApiKey on every route', () => {
  // Every row has 3 entries: a 2-entry row would hand jest's `done` callback to the 3rd parameter.
  const routes = [['GET', '/api/email-designs', undefined], ['GET', '/api/email-designs/41', undefined], ['POST', '/api/email-designs', good()],
    ['PUT', '/api/email-designs/41', good()], ['PATCH', '/api/email-designs/41', { archived: true }]];
  test.each(routes)('%s %s: no token → 401, a portal token → 401, a key scoped elsewhere → 403; nothing written', async (method, url, body) => {
    expect((await call(method, url, body, {})).status).toBe(401);
    expect((await call(method, url, body, { Authorization: `Bearer ${portal()}` })).status).toBe(401);
    expect((await call(method, url, body, { 'x-api-key': SCOPED_KEY })).status).toBe(403);
    expect(currentDb.T.writes).toEqual([]);
  });
  test('a plain staff JWT (no capability) creates, lists, reads, updates and archives', async () => {
    const c = await call('POST', '/api/email-designs', good());
    expect(c).toEqual({ status: 200, json: { success: true, id: 41 } });
    expect((await call('GET', '/api/email-designs')).status).toBe(200);
    expect((await call('GET', '/api/email-designs/41')).status).toBe(200);
    expect((await call('PUT', '/api/email-designs/41', good({ name: 'Renamed' }))).json).toEqual({ success: true, id: 41 });
    expect(await call('PATCH', '/api/email-designs/41', { archived: true })).toEqual({ status: 200, json: { success: true } });
  });
});

describe('POST / PUT — validation before any write', () => {
  test('POST stores the validated design: name trimmed, builder grapesjs-mjml, created_by from the JWT, html + text verbatim', async () => {
    const r = await call('POST', '/api/email-designs', good({ name: '  Nov  ' }));
    expect(r.json).toEqual({ success: true, id: 41 });
    const [w] = currentDb.T.writes;
    expect(w.p[0]).toBe('Nov');
    expect(w.p[1]).toBe('grapesjs-mjml');
    expect(JSON.parse(w.p[2])).toEqual(F.design());
    expect(w.p[3]).toBe(F.html());
    expect(w.p[4]).toBe('Hi there');
    expect(w.p[5]).toBe(9);
  });
  test('created_by takes a numeric-string JWT sub too', async () => {
    const tok = jwt.sign({ sub: '9', username: 'sam', user_auth: 'authorized', aud: 'staff' }, SECRET, { expiresIn: '1h' });
    await call('POST', '/api/email-designs', good(), { Authorization: `Bearer ${tok}` });
    expect(currentDb.T.writes[0].p[5]).toBe(9);
  });
  test('a rule failure → 400 {error, code:design_rejected, rule, detail}; no INSERT / UPDATE ran', async () => {
    const d = F.design();
    d.pages[0].frames[0].component.components[0].components[1].components[0].components[0].components[0].attributes.onerror = 'parent.apiSend(1)';
    const r = await call('POST', '/api/email-designs', good({ design_json: d }));
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: expect.stringMatching(/^Design rejected \(rule 4\)/), code: 'design_rejected', rule: 4, detail: expect.stringMatching(/event-handler attribute "onerror"/) });
    const h = await call('PUT', '/api/email-designs/41', good({ html: F.html().replace('<!-- yc:footer-slot -->', '') }));
    expect(h).toMatchObject({ status: 400, json: { code: 'design_rejected', rule: 9 } });
    expect(currentDb.T.writes).toEqual([]);
  });
  test('the html leg is checked even when design_json is clean (never assumed = compile(design_json))', async () => {
    const r = await call('POST', '/api/email-designs', good({ html: F.html().replace('</body>', '<img src="https://x.test/a.png" onerror="x()"></body>') }));
    expect(r).toMatchObject({ status: 400, json: { code: 'design_rejected', rule: 7 } });
    expect(currentDb.T.writes).toEqual([]);
  });
  test('rule 10: over ~95 KB → saved, with a warning string on the success', async () => {
    const big = F.html().replace('</body>', `<div>${'x'.repeat(100 * 1024)}</div></body>`);
    const r = await call('POST', '/api/email-designs', good({ html: big }));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ success: true, id: 41, warning: expect.stringMatching(/Gmail clips/) });
    expect(currentDb.T.writes).toHaveLength(1);
    const u = await call('PUT', '/api/email-designs/41', good({ html: big }));
    expect(u.json.warning).toMatch(/Gmail clips/);
  });
  test('bad name / text → 400 invalid_input (not a design rule); missing design_json / html → design_rejected', async () => {
    for (const body of [good({ name: '' }), good({ name: '   ' }), good({ name: 'x'.repeat(256) }), good({ name: 7 }), good({ text: undefined }), good({ text: 5 })]) {
      expect(await call('POST', '/api/email-designs', body)).toMatchObject({ status: 400, json: { code: 'invalid_input' } });
    }
    expect(await call('POST', '/api/email-designs', good({ design_json: undefined }))).toMatchObject({ status: 400, json: { code: 'design_rejected', rule: 1 } });
    expect(await call('POST', '/api/email-designs', good({ html: undefined }))).toMatchObject({ status: 400, json: { code: 'design_rejected', rule: 7 } });
    expect(currentDb.T.writes).toEqual([]);
  });
  test('PUT a missing id → 404 not_found; a non-numeric id → 400', async () => {
    expect(await call('PUT', '/api/email-designs/999', good())).toMatchObject({ status: 404, json: { code: 'not_found' } });
    expect(await call('PUT', '/api/email-designs/abc', good())).toMatchObject({ status: 400, json: { code: 'invalid_input' } });
  });
});

describe('GET / PATCH', () => {
  test('list: no bodies; archived excluded unless include_archived; q is LIKE-escaped', async () => {
    await call('POST', '/api/email-designs', good({ name: 'A' }));
    await call('POST', '/api/email-designs', good({ name: 'B' }));
    await call('PATCH', '/api/email-designs/42', { archived: true });
    const l = await call('GET', '/api/email-designs');
    expect(l.status).toBe(200);
    expect(l.json.designs.map((d) => d.id)).toEqual([41]);
    expect(Object.keys(l.json.designs[0]).sort()).toEqual(['archived', 'builder', 'id', 'name', 'updated_at']);
    expect(l.json.designs[0].archived).toBe(false);
    const all = await call('GET', '/api/email-designs?include_archived=1');
    expect(all.json.designs.map((d) => [d.id, d.archived])).toEqual([[41, false], [42, true]]);
    await call('GET', '/api/email-designs?q=50%25_off');
    expect(currentDb.T.lastList.p).toEqual(['%50\\%\\_off%']);
  });
  test('GET :id → {design} full row with design_json as an object and archived boolean; 404 / 400', async () => {
    await call('POST', '/api/email-designs', good());
    const g = await call('GET', '/api/email-designs/41');
    expect(g.json.design).toMatchObject({ id: 41, name: 'November newsletter', builder: 'grapesjs-mjml', html: F.html(), text: 'Hi there', thumbnail_asset_id: null, created_by: 9, archived: false });
    expect(g.json.design.design_json).toEqual(F.design());
    expect(await call('GET', '/api/email-designs/77')).toMatchObject({ status: 404, json: { code: 'not_found' } });
    expect(await call('GET', '/api/email-designs/0')).toMatchObject({ status: 400 });
  });
  test('PATCH: archived must be exactly true / false; 404 missing', async () => {
    await call('POST', '/api/email-designs', good());
    for (const v of ['true', 1, null, undefined]) {
      expect(await call('PATCH', '/api/email-designs/41', { archived: v })).toMatchObject({ status: 400, json: { code: 'invalid_input' } });
    }
    expect(await call('PATCH', '/api/email-designs/41', { archived: false })).toEqual({ status: 200, json: { success: true } });
    expect(await call('PATCH', '/api/email-designs/99', { archived: true })).toMatchObject({ status: 404, json: { code: 'not_found' } });
  });
});
