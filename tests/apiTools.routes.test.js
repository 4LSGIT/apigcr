// Tools S1 (backend) — routes/api.tools.js
//
// Locks:
//   - LANDING DEAD-END: landingAllowed() is false for GET /tool/* and for
//     GET/POST /api/tools — the tools surface must never serve on 4lsg.com.
//   - Serve route: live tool → 200 text/html with Cache-Control: no-cache
//     and X-Robots-Tag: noindex, nofollow; draft → 404; unknown/invalid
//     key → 404; mixed-case key is lowercased before lookup.
//   - Auth: /api/tools without a JWT → 401; with a non-SU JWT → 403;
//     API-key auth (internal key) → 403 (superuserOnlyFor's SU check
//     requires auth.type === 'jwt'); SU JWT without X-SU-Elevation → 401
//     code 'elevation_required'.
//   - Versioning convention (NEW html appended): create appends v1; an
//     html-changing PATCH appends; a title-only PATCH does not; a
//     same-html PATCH does not; restore copies the html back and appends.
//   - Duplicate tool_key → 409; invalid tool_key → 400; mixed-case
//     tool_key input is lowercased on create.
//
// Harness: real superuserOnlyFor chain (JWTs + elevation, same as
// tests/su.stepup.test.js) over a pattern-matching stateful fake db.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-tools';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'test-internal-key';

const express = require('express');
const jwt = require('jsonwebtoken');

const { mintElevationToken, _resetRateLimits } = require('../lib/auth.superuser');
const landingAllowed = require('../routes/pageLanding')._landingAllowed;
const router = require('../routes/api.tools');

const SECRET = process.env.JWT_SECRET;

// ── stateful fake db ────────────────────────────────────────────────────────
let tools, versions, nextToolId, nextVerId, auditRows;

function resetDb() {
  tools = new Map();       // id -> row
  versions = [];           // { id, tool_id, html, saved_by, saved_at }
  nextToolId = 1;
  nextVerId = 1;
  auditRows = [];
}

function toolByKey(key) {
  for (const t of tools.values()) if (t.tool_key === key) return t;
  return null;
}

const db = {
  query: jest.fn(async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    // auth plumbing
    if (/^INSERT INTO jwt_api_audit_log/i.test(s)) return [{}];
    if (/^INSERT INTO admin_audit_log/i.test(s)) { auditRows.push(params); return [{}]; }

    // tools
    if (/^SELECT t\.id, t\.tool_key.*FROM tools t ORDER BY/i.test(s)) {
      const rows = [...tools.values()].map((t) => ({
        id: t.id, tool_key: t.tool_key, title: t.title, status: t.status,
        updated_by: t.updated_by, updated_at: t.updated_at,
        version_count: versions.filter((v) => v.tool_id === t.id).length,
      }));
      return [rows];
    }
    if (/^SELECT id, tool_key, title, status, html, updated_by, created_at, updated_at FROM tools WHERE id = \?/i.test(s)) {
      const t = tools.get(Number(params[0]));
      return [t ? [{ ...t }] : []];
    }
    if (/^SELECT html, status FROM tools WHERE tool_key = \?/i.test(s)) {
      const t = toolByKey(params[0]);
      return [t ? [{ html: t.html, status: t.status }] : []];
    }
    if (/^INSERT INTO tools SET \?/i.test(s)) {
      const data = params[0];
      if (toolByKey(data.tool_key)) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }
      const id = nextToolId++;
      tools.set(id, {
        id, tool_key: data.tool_key, title: data.title ?? '', status: data.status ?? 'draft',
        html: data.html, updated_by: data.updated_by ?? null,
        created_at: 'T0', updated_at: 'T0',
      });
      return [{ insertId: id }];
    }
    if (/^UPDATE tools SET \? WHERE id = \?/i.test(s)) {
      const [data, id] = params;
      const t = tools.get(Number(id));
      if (t) {
        if (data.tool_key !== undefined) {
          const clash = toolByKey(data.tool_key);
          if (clash && clash.id !== t.id) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }
        }
        Object.assign(t, data);
      }
      return [{ affectedRows: t ? 1 : 0 }];
    }
    if (/^DELETE FROM tools WHERE id = \?/i.test(s)) {
      const id = Number(params[0]);
      const had = tools.delete(id);
      if (had) versions = versions.filter((v) => v.tool_id !== id); // FK cascade
      return [{ affectedRows: had ? 1 : 0 }];
    }

    // tool_versions
    if (/^INSERT INTO tool_versions \(tool_id, html, saved_by\) VALUES/i.test(s)) {
      const [tool_id, html, saved_by] = params;
      versions.push({ id: nextVerId++, tool_id: Number(tool_id), html, saved_by, saved_at: 'T0' });
      return [{ insertId: nextVerId - 1 }];
    }
    if (/^SELECT id, saved_by, saved_at, CHAR_LENGTH\(html\) AS html_length FROM tool_versions WHERE tool_id = \?/i.test(s)) {
      const rows = versions
        .filter((v) => v.tool_id === Number(params[0]))
        .sort((a, b) => b.id - a.id)
        .map((v) => ({ id: v.id, saved_by: v.saved_by, saved_at: v.saved_at, html_length: v.html.length }));
      return [rows];
    }
    if (/^SELECT id, tool_id, html(?:, saved_by, saved_at)? FROM tool_versions WHERE id = \? AND tool_id = \?/i.test(s)) {
      const v = versions.find(
        (x) => x.id === Number(params[0]) && x.tool_id === Number(params[1])
      );
      return [v ? [{ ...v }] : []];
    }

    throw new Error('apiTools test db: unscripted query: ' + s);
  }),
};

// ── tokens ──────────────────────────────────────────────────────────────────
const staffToken = (over = {}) =>
  jwt.sign(
    { sub: 42, username: 'fred', user_type: 'staff', user_auth: 'authorized - SU', aud: 'staff', roles: [], ...over },
    SECRET,
    { expiresIn: '1h' }
  );
const ELEV = () => mintElevationToken(42);

// ── app ─────────────────────────────────────────────────────────────────────
let server, base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use(router);
  await new Promise((r) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      r();
    });
  });
});

afterAll((done) => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(done);
});

beforeEach(() => {
  resetDb();
  _resetRateLimits();
  delete process.env.SU_STEPUP; // step-up ON (default)
});

const call = (p, { method = 'GET', bearer, elev, apiKey, body } = {}) =>
  fetch(base + p, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(elev ? { 'x-su-elevation': elev } : {}),
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(body || {}) }),
  });

const su = (p, opts = {}) => call(p, { bearer: staffToken(), elev: ELEV(), ...opts });

async function createTool(over = {}) {
  const res = await su('/api/tools', {
    method: 'POST',
    body: { tool_key: 'calc', title: 'Calc', html: '<h1>v1</h1>', status: 'draft', ...over },
  });
  expect(res.status).toBe(200);
  return (await res.json()).tool;
}

// ── landing dead-end ────────────────────────────────────────────────────────
describe('landing allowlist dead-end', () => {
  const allowed = (path, method) => landingAllowed({ path, method });

  test('GET /tool/* is NOT landing-allowed', () => {
    expect(allowed('/tool/anything', 'GET')).toBe(false);
    expect(allowed('/tool/my-calc', 'GET')).toBe(false);
    expect(allowed('/tool', 'GET')).toBe(false);
  });

  test('/api/tools is NOT landing-allowed (GET or POST)', () => {
    expect(allowed('/api/tools', 'GET')).toBe(false);
    expect(allowed('/api/tools', 'POST')).toBe(false);
    expect(allowed('/api/tools/1', 'GET')).toBe(false);
    expect(allowed('/api/tools/1/versions', 'GET')).toBe(false);
    expect(allowed('/api/tools/1/restore/2', 'POST')).toBe(false);
  });
});

// ── public serve ────────────────────────────────────────────────────────────
describe('GET /tool/:key', () => {
  test('live tool → 200 html with the three headers', async () => {
    const t = await createTool({ tool_key: 'live-tool', status: 'live', html: '<h1>LIVE</h1>' });
    expect(t.status).toBe('live');
    const res = await call('/tool/live-tool');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html; charset=utf-8/i);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(await res.text()).toBe('<h1>LIVE</h1>');
  });

  test('mixed-case key is lowercased before lookup', async () => {
    await createTool({ tool_key: 'live-tool', status: 'live', html: '<h1>LIVE</h1>' });
    const res = await call('/tool/LIVE-Tool');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<h1>LIVE</h1>');
  });

  test('draft tool → 404', async () => {
    await createTool({ tool_key: 'draft-tool', status: 'draft' });
    const res = await call('/tool/draft-tool');
    expect(res.status).toBe(404);
  });

  test('unknown key → 404; invalid key shape → 404 without a query', async () => {
    expect((await call('/tool/nope')).status).toBe(404);
    const before = db.query.mock.calls.length;
    expect((await call('/tool/bad_key!')).status).toBe(404); // underscore + ! fail the regex
    // invalid shape short-circuits — no tools query ran
    const toolQueries = db.query.mock.calls.slice(before)
      .filter(([sql]) => /FROM tools/i.test(sql));
    expect(toolQueries).toHaveLength(0);
  });
});

// ── auth ────────────────────────────────────────────────────────────────────
describe('auth on /api/tools', () => {
  test('no JWT → 401', async () => {
    expect((await call('/api/tools')).status).toBe(401);
  });

  test('non-SU JWT → 403', async () => {
    const res = await call('/api/tools', { bearer: staffToken({ user_auth: 'authorized', sub: 7 }), elev: ELEV() });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Superuser/);
  });

  test('API-key auth → 403 (SU check requires a JWT identity)', async () => {
    const res = await call('/api/tools', { apiKey: process.env.INTERNAL_API_KEY });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Superuser/);
  });

  test('SU JWT without elevation → 401 elevation_required', async () => {
    const res = await call('/api/tools', { bearer: staffToken() });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('elevation_required');
  });
});

// ── CRUD + versioning convention ────────────────────────────────────────────
describe('CRUD + version append convention (NEW html appended)', () => {
  test('create appends v1 and stamps updated_by/saved_by from the JWT', async () => {
    const t = await createTool();
    expect(t.tool_key).toBe('calc');
    expect(t.updated_by).toBe('fred');

    const list = await (await su('/api/tools')).json();
    expect(list.tools).toHaveLength(1);
    expect(list.tools[0]).toMatchObject({ tool_key: 'calc', version_count: 1 });
    expect(list.tools[0].html).toBeUndefined(); // lean list

    const vers = await (await su(`/api/tools/${t.id}/versions`)).json();
    expect(vers.versions).toHaveLength(1);
    expect(vers.versions[0]).toMatchObject({ saved_by: 'fred', html_length: '<h1>v1</h1>'.length });
    expect(vers.versions[0].html).toBeUndefined(); // length only

    const one = await (await su(`/api/tools/${t.id}/versions/${vers.versions[0].id}`)).json();
    expect(one.version.html).toBe('<h1>v1</h1>'); // v1 = created html
  });

  test('mixed-case tool_key is lowercased on create; invalid → 400; dup → 409', async () => {
    const res = await su('/api/tools', { method: 'POST', body: { tool_key: 'My-Calc', html: '<p>x</p>' } });
    expect((await res.json()).tool.tool_key).toBe('my-calc');

    const bad = await su('/api/tools', { method: 'POST', body: { tool_key: 'bad_key!', html: '<p>x</p>' } });
    expect(bad.status).toBe(400);

    const dup = await su('/api/tools', { method: 'POST', body: { tool_key: 'my-calc', html: '<p>y</p>' } });
    expect(dup.status).toBe(409);
  });

  test('html-changing PATCH appends; title-only and same-html PATCHes do not', async () => {
    const t = await createTool();

    // title-only → no append
    let res = await su(`/api/tools/${t.id}`, { method: 'PATCH', body: { title: 'Renamed' } });
    expect(res.status).toBe(200);
    expect((await res.json()).tool.title).toBe('Renamed');
    let vers = (await (await su(`/api/tools/${t.id}/versions`)).json()).versions;
    expect(vers).toHaveLength(1);

    // same html → no append
    res = await su(`/api/tools/${t.id}`, { method: 'PATCH', body: { html: '<h1>v1</h1>' } });
    expect(res.status).toBe(200);
    vers = (await (await su(`/api/tools/${t.id}/versions`)).json()).versions;
    expect(vers).toHaveLength(1);

    // changed html → append (newest row = NEW html)
    res = await su(`/api/tools/${t.id}`, { method: 'PATCH', body: { html: '<h1>v2</h1>' } });
    expect(res.status).toBe(200);
    expect((await res.json()).tool.html).toBe('<h1>v2</h1>');
    vers = (await (await su(`/api/tools/${t.id}/versions`)).json()).versions;
    expect(vers).toHaveLength(2);
    const newest = (await (await su(`/api/tools/${t.id}/versions/${vers[0].id}`)).json()).version;
    expect(newest.html).toBe('<h1>v2</h1>');
  });

  test('empty PATCH → 400; missing tool → 404', async () => {
    const t = await createTool();
    expect((await su(`/api/tools/${t.id}`, { method: 'PATCH', body: {} })).status).toBe(400);
    expect((await su('/api/tools/999', { method: 'PATCH', body: { title: 'x' } })).status).toBe(404);
    expect((await su('/api/tools/999')).status).toBe(404);
  });

  test('restore copies the version html into the tool and appends', async () => {
    const t = await createTool(); // v1 = <h1>v1</h1>
    await su(`/api/tools/${t.id}`, { method: 'PATCH', body: { html: '<h1>v2</h1>' } });

    const vers = (await (await su(`/api/tools/${t.id}/versions`)).json()).versions;
    expect(vers).toHaveLength(2);
    const v1 = vers[vers.length - 1]; // oldest

    const res = await su(`/api/tools/${t.id}/restore/${v1.id}`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).tool.html).toBe('<h1>v1</h1>');

    const after = (await (await su(`/api/tools/${t.id}/versions`)).json()).versions;
    expect(after).toHaveLength(3); // restore appended the restored html
    const newest = (await (await su(`/api/tools/${t.id}/versions/${after[0].id}`)).json()).version;
    expect(newest.html).toBe('<h1>v1</h1>');
  });

  test("restore 404s on a vid belonging to a different tool", async () => {
    const a = await createTool({ tool_key: 'tool-a' });
    const b = await createTool({ tool_key: 'tool-b', html: '<p>b</p>' });
    const bVers = (await (await su(`/api/tools/${b.id}/versions`)).json()).versions;
    const res = await su(`/api/tools/${a.id}/restore/${bVers[0].id}`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('delete removes the tool and its versions (cascade); actions are audited', async () => {
    const t = await createTool();
    const res = await su(`/api/tools/${t.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await su(`/api/tools/${t.id}`)).status).toBe(404);

    // per-action audit rows (tool column is params[0] in auditAdminAction's insert)
    const toolsAudits = auditRows.filter((p) => p[0] === 'tools');
    expect(toolsAudits.length).toBeGreaterThanOrEqual(2); // create + delete at minimum
  });
});
