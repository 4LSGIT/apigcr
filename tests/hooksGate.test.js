// tests/hooksGate.test.js
//
/**
 * The automations.manage gate on /api/hooks — access-control B5
 * (routes/api.hooks.js, public/automation/hooks.html;
 * ref/ACCESS_CONTROL_DESIGN.md §5.6 B5).
 *
 * WHAT IS LOCKED
 *   - The inventory: 17 routes mount the gate, exactly two stay on
 *     jwtOrApiKey (the list, the global executions feed), and the receiver
 *     POST /hooks/:slug mounts neither.
 *   - Gate matrix on the gated routes: staff / attorney / form_dev / legacy
 *     no-roles / legacy SU string → 403 with nothing written; admin, it, su →
 *     through; x-api-key (internal, and a SCOPED yck_ key — scopes are not
 *     enforced until B2) → through; portal token → 401. A denial writes one
 *     jwt/unauthorized audit row (requireAuth parity).
 *   - The list (ruling Q1a): staff rows carry id/slug/name/active for the
 *     booking-views picker and NO auth_config / filter_config /
 *     transform_config / captured_sample key at all; holders get full rows
 *     with the secret decrypted (B4 H1).
 *   - The global executions feed (ruling Q2) stays open and carries no auth
 *     or config material; the per-hook execution routes are gated.
 *   - The receiver is untouched: the RC validation handshake, an unknown
 *     slug (404) and a wrong per-hook key (the hook's own 401) all answer
 *     without any session credential.
 *   - The pane mirror: hooks.html replaces itself with one sentence for a
 *     viewer outside su | it | admin before loading anything.
 *
 * HARNESS: the REAL router, requireAuth, jwtOrApiKey, capabilities,
 * hookService and credentialCrypto on an in-process express app with a
 * scripted req.db. Nothing is mocked.
 *
 * Run: npx jest tests/hooksGate.test.js
 */
'use strict';

process.env.JWT_SECRET = 'hooks-gate-b5-test-secret';
process.env.INTERNAL_API_KEY = 'yci_hooks_gate_b5_internal';

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

const cc = require('../lib/credentialCrypto');
const apiKeys = require('../lib/apiKeys');
const router = require('../routes/api.hooks');

const SECRET_KEY = 'hook-key-' + 'z'.repeat(20);
const HOOK = {
  id: 5, slug: 'rc-call', name: 'RC call', description: 'd', auth_type: 'api_key',
  auth_config: { key: cc.encrypt(SECRET_KEY), header: 'x-hook-key' },
  filter_mode: 'conditions', filter_config: { all: [] }, transform_mode: 'mapper', transform_config: [{ a: 1 }],
  active: 1, version: 3, capture_mode: 'off', captured_sample: { raw: 'payload' }, captured_at: null,
  target_count: 1, modified_by_name: 'IT',
};
const SCOPED_YCK = 'yck_' + 'b5'.repeat(32);            // scopes ['route:/process-jobs']
const CAP_YCK = 'yck_' + 'c5'.repeat(32);               // scopes ['automations.manage'] (B2)
// The machine keys the stubs know: raw → api_keys row.
const KEY_ROWS = () => ({
  [apiKeys.hashKey(SCOPED_YCK)]: { id: 3, label: 'scheduler', revoked_at: null, scopes: ['route:/process-jobs'] },
  [apiKeys.hashKey(CAP_YCK)]: { id: 4, label: 'hook-admin-bot', revoked_at: null, scopes: ['automations.manage'] },
});

function makeDb({ catchall = false } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/jwt_api_audit_log/.test(s)) return [{ affectedRows: 1 }];
      if (/FROM api_keys WHERE key_hash/.test(s)) {
        { const row = KEY_ROWS()[params[0]]; return [row ? [row] : []]; }
      }
      if (/UPDATE api_keys SET last_used_at/.test(s)) return [{}];
      if (/FROM hooks h LEFT JOIN hook_targets ht/.test(s)) return [[{ ...HOOK }]];
      if (/FROM hooks h LEFT JOIN users u ON h.last_modified_by = u.user WHERE h.id = \?/.test(s)) return [[{ ...HOOK }]];
      if (/FROM hook_targets ht/.test(s)) return [[]];
      if (/FROM hook_executions he LEFT JOIN hooks h/.test(s)) {
        return [[{ id: 9, hook_id: 5, slug: 'rc-call', status: 'delivered', error: null, created_at: '2026-10-14', hook_name: 'RC call', delivery_count: 1 }]];
      }
      if (/SELECT \* FROM hooks WHERE slug = \? AND active = 1/.test(s)) {
        if (params[0] === 'rc-call') return [[{ ...HOOK }]];
        if (params[0] === '_catchall' && catchall) return [[{ ...HOOK, slug: '_catchall' }]];
        return [[]];
      }
      if (/^(INSERT|UPDATE|DELETE)/.test(s)) return [{ affectedRows: 1, insertId: 77 }];
      return [[]];
    },
  };
}

function call(method, urlPath, { headers = {}, body, db = makeDb() } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use(router);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        port: server.address().port, path: urlPath, method,
        headers: Object.assign(payload ? { 'content-type': 'application/json' } : {}, headers),
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { server.close(); let j = null; try { j = JSON.parse(data); } catch (_) {} resolve({ status: res.statusCode, body: j, raw: data, db }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const tok = (claims = {}) => ({ authorization: 'Bearer ' + jwt.sign(Object.assign(
  { sub: 5, username: 'sb', user_type: 1, user_auth: 'authorized', aud: 'staff', ver: 1, roles: ['staff'] }, claims),
  process.env.JWT_SECRET, { expiresIn: '1h' }) });
const legacy = (user_auth) => ({ authorization: 'Bearer ' + jwt.sign({ sub: 6, username: 'IT', user_auth, ver: 1 }, process.env.JWT_SECRET) });
const writes = (db) => db.calls.filter(c => /^(INSERT|UPDATE|DELETE)/.test(c.sql) && !/jwt_api_audit_log|api_keys/.test(c.sql));

// One representative request per gated route.
const GATED = [
  ['GET', '/api/hooks/meta'], ['GET', '/api/hooks/5'], ['POST', '/api/hooks', { name: 'n' }],
  ['PUT', '/api/hooks/5', { name: 'n2' }], ['POST', '/api/hooks/5/duplicate'], ['DELETE', '/api/hooks/5'],
  ['GET', '/api/hooks/5/targets'], ['POST', '/api/hooks/5/targets', { name: 't', url: 'https://x.test' }],
  ['PUT', '/api/hooks/targets/1', { name: 't2' }], ['DELETE', '/api/hooks/targets/1'],
  ['POST', '/api/hooks/5/test', { input: {} }], ['POST', '/api/hooks/5/live-test', {}],
  ['POST', '/api/hooks/test-transform', { input: {}, transform_mode: 'passthrough' }],
  ['POST', '/api/hooks/5/capture/start'], ['POST', '/api/hooks/5/capture/stop'],
  ['GET', '/api/hooks/5/executions'], ['GET', '/api/hooks/executions/9'],
];

// ─────────────────────────────────────────────────────────────────────────────

describe('inventory', () => {
  const layers = router.stack.filter(l => l.route).map(l => ({
    sig: `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`,
    first: l.route.stack[0].handle.name,
  }));

  test('17 gated, the list + the global feed on jwtOrApiKey, the receiver on neither', () => {
    expect(layers.filter(l => l.first === 'staffAuth')).toHaveLength(17);
    expect(layers.filter(l => l.first === 'jwtOrApiKey').map(l => l.sig).sort())
      .toEqual(['GET /api/hooks', 'GET /api/hooks/executions']);
    const rx = router.stack.find(l => l.route && l.route.path === '/hooks/:slug');
    const names = rx.route.stack.map(s => s.handle.name);
    expect(names).not.toContain('staffAuth');
    expect(names).not.toContain('jwtOrApiKey');
  });

  // firm.settings and automations.manage have the SAME holders today (admin,
  // it, su), so no request can tell them apart — pin the capability by name,
  // so a swap fails now rather than on the day ROLE_CAPS diverges.
  test('the gate cites automations.manage, once', () => {
    const code = fs.readFileSync(path.join(__dirname, '..', 'routes', 'api.hooks.js'), 'utf8')
      .split('\n').filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');   // the header names it too
    const gates = [...code.matchAll(/requireAuth\(\{[^}]*\}\)/g)].map(m => m[0]);
    expect(gates).toEqual(["requireAuth({ audience: 'staff', can: 'automations.manage', allowApiKey: true })"]);
  });

  test('every GATED request below hits a gated layer (the table covers all 17)', () => {
    const gatedSigs = layers.filter(l => l.first === 'staffAuth').map(l => l.sig).sort();
    const toSig = ([m, p]) => `${m} ${p.replace(/\/5\b/, '/:id').replace('/targets/1', '/targets/:id').replace('/executions/9', '/executions/:id')}`;
    const mine = GATED.map(toSig).map(s => s.replace('/api/hooks/:id/targets', '/api/hooks/:hookId/targets')
      .replace('/api/hooks/:id/executions', '/api/hooks/:hookId/executions')).sort();
    expect(mine).toEqual(gatedSigs);
  });
});

describe('gate matrix (17 routes)', () => {
  const denied = {
    staff: tok(), 'staff+attorney': tok({ roles: ['staff', 'attorney'] }), form_dev: tok({ roles: ['form_dev'] }),
    'legacy no-roles token': legacy('authorized'), 'legacy SU string alone': legacy('authorized - SU'),
  };
  for (const [who, headers] of Object.entries(denied)) {
    test(`${who} → 403 everywhere, nothing written`, async () => {
      for (const [m, p, body] of GATED) {
        const r = await call(m, p, { headers, body });
        expect({ at: `${m} ${p}`, status: r.status }).toEqual({ at: `${m} ${p}`, status: 403 });
        expect(writes(r.db)).toEqual([]);
      }
    });
  }

  for (const [who, headers] of Object.entries({ admin: tok({ roles: ['admin', 'staff'] }), it: tok({ roles: ['it'] }), su: tok({ roles: ['su'] }) })) {
    test(`${who} → through the gate on every route (no 401/403)`, async () => {
      for (const [m, p, body] of GATED) {
        const r = await call(m, p, { headers, body });
        expect({ at: `${m} ${p}`, denied: [401, 403].includes(r.status) }).toEqual({ at: `${m} ${p}`, denied: false });
      }
    });
  }

  test('admin GET /api/hooks/:id is the full row with the secret decrypted', async () => {
    const r = await call('GET', '/api/hooks/5', { headers: tok({ roles: ['admin'] }) });
    expect(r.status).toBe(200);
    expect(r.body.hook.auth_config).toEqual({ key: SECRET_KEY, header: 'x-hook-key' });
  });

  // B5 pinned "a SCOPED yck_ key passes (scopes enforced only from B2)"; B2
  // flips it on purpose: a scoped key needs the capability in its scopes.
  test('x-api-key: the internal key passes; a scoped key passes only with automations.manage (B2 flip)', async () => {
    for (const [key, ok] of [[process.env.INTERNAL_API_KEY, true], [CAP_YCK, true], [SCOPED_YCK, false]]) {
      apiKeys.invalidateCache();
      const r = await call('POST', '/api/hooks', { headers: { 'x-api-key': key }, body: { name: 'machine' } });
      expect({ key: key.slice(0, 8), status: r.status }).toEqual({ key: key.slice(0, 8), status: ok ? 200 : 403 });
      expect(writes(r.db).some(c => /^INSERT INTO hooks/.test(c.sql))).toBe(ok);
    }
  });

  test('portal token → 401', async () => {
    const portal = { authorization: 'Bearer ' + jwt.sign({ sub: 7, aud: 'contact', ver: 1 }, process.env.JWT_SECRET) };
    expect((await call('GET', '/api/hooks/5', { headers: portal })).status).toBe(401);
  });

  test('a denial leaves one jwt/unauthorized audit row', async () => {
    const r = await call('DELETE', '/api/hooks/5', { headers: tok() });
    await new Promise(res => setImmediate(res));
    const audit = r.db.calls.filter(c => /jwt_api_audit_log/.test(c.sql));
    expect(audit).toHaveLength(1);
    expect(audit[0].params[7]).toBe('jwt');
    expect(audit[0].params[9]).toBe('unauthorized');
  });
});

describe('the list (ruling Q1a)', () => {
  const HOLDER_ONLY = ['auth_config', 'filter_config', 'transform_config', 'captured_sample'];

  test('staff: picker fields present, holder-only keys ABSENT (not even named in the JSON)', async () => {
    const r = await call('GET', '/api/hooks', { headers: tok() });
    expect(r.status).toBe(200);
    const row = r.body.hooks[0];
    expect(row).toMatchObject({ id: 5, slug: 'rc-call', name: 'RC call', active: 1 });
    for (const k of HOLDER_ONLY) {
      expect(Object.prototype.hasOwnProperty.call(row, k)).toBe(false);
      expect(r.raw).not.toContain(`"${k}"`);
    }
    expect(r.raw).not.toContain('ENCv1:');
    expect(r.raw).not.toContain(SECRET_KEY);
  });

  test('holders (admin, it, su, x-api-key) get full rows, the secret decrypted', async () => {
    for (const headers of [tok({ roles: ['admin'] }), tok({ roles: ['it'] }), tok({ roles: ['su'] }), { 'x-api-key': process.env.INTERNAL_API_KEY }]) {
      const r = await call('GET', '/api/hooks', { headers });
      const row = r.body.hooks[0];
      expect(row.auth_config).toEqual({ key: SECRET_KEY, header: 'x-hook-key' });
      expect(row.filter_config).toEqual({ all: [] });
      expect(row.captured_sample).toEqual({ raw: 'payload' });
    }
  });
});

describe('executions (ruling Q2)', () => {
  test('the global feed stays open to staff and carries no auth / config / payload material', async () => {
    const r = await call('GET', '/api/hooks/executions', { headers: tok() });
    expect(r.status).toBe(200);
    expect(r.body.executions).toHaveLength(1);
    for (const k of ['auth_config', 'filter_config', 'transform_config', 'raw_input', 'transform_output', 'captured_sample']) {
      expect(r.raw).not.toContain(`"${k}"`);
    }
    const sql = r.db.calls.find(c => /FROM hook_executions he/.test(c.sql)).sql;
    expect(sql).not.toMatch(/he\.\*|h\.\*/);
  });

  test('the per-hook routes are gated', async () => {
    expect((await call('GET', '/api/hooks/5/executions', { headers: tok() })).status).toBe(403);
    expect((await call('GET', '/api/hooks/executions/9', { headers: tok() })).status).toBe(403);
  });
});

describe('the receiver is untouched', () => {
  test('RC validation handshake → 200 with no credentials', async () => {
    const r = await call('POST', '/hooks/rc-call', { headers: { 'Validation-Token': 'abc' } });
    expect(r.status).toBe(200);
  });

  test('unknown slug, no catch-all → 404 (not a session 401)', async () => {
    const r = await call('POST', '/hooks/nope', { body: {} });
    expect(r.status).toBe(404);
    expect(r.body.message).toBe('Hook not found');
  });

  test('a wrong per-hook key → the HOOK\'s own 401, with no session credential involved', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await call('POST', '/hooks/rc-call', { headers: { 'x-hook-key': 'wrong' }, body: {} });
    expect(r.status).toBe(401);
    expect(r.body.message).toBe('Invalid or missing API key');
    console.warn.mockRestore();
  });
});

describe('the pane mirror (hooks.html)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'automation', 'hooks.html'), 'utf8');

  test('mayManageHooks mirrors the capability holders: su | it | admin, from currentUser.roles', () => {
    const fn = src.match(/function mayManageHooks\(\) \{([\s\S]*?)\n  \}/);
    expect(fn).not.toBeNull();
    const body = fn[1];
    expect(body).toMatch(/currentUser\?\.roles/);
    const roles = [...body.matchAll(/roles\.includes\('(\w+)'\)/g)].map(m => m[1]).sort();
    expect(roles).toEqual(['admin', 'it', 'su']);
  });

  test('init() replaces the page BEFORE loading anything when the viewer may not manage hooks', () => {
    const init = src.match(/function init\(\) \{([\s\S]*?)\n  \}/)[1];
    const deny = init.indexOf('if (!mayManageHooks())');
    expect(deny).toBeGreaterThan(-1);
    expect(init.indexOf('return;', deny)).toBeLessThan(init.indexOf('hooksInit()'));
    expect(init).toMatch(/hooks-denied/);
  });

  test('the topbar shows no actions to a non-holder', () => {
    const fn = src.match(/function updateTopbarButtons\(\) \{([\s\S]*?)\n  \}/)[1];
    expect(fn).toMatch(/if \(!mayManageHooks\(\)\) \{\s*P\.setTopbarButtons\(\{ refresh: false, new: false, save: false, delete: false \}\);\s*return;/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// routes/api.pages.js — create-hook is hook management too (ruling F1)
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/pages/:id/create-hook (ruling F1)', () => {
  const pages = require('../routes/api.pages');

  function pagesDb() {
    const calls = [];
    return {
      calls,
      query: async (sql, params = []) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        calls.push({ sql: s, params });
        if (/jwt_api_audit_log/.test(s)) return [{ affectedRows: 1 }];
        if (/FROM api_keys WHERE key_hash/.test(s)) {
          { const row = KEY_ROWS()[params[0]]; return [row ? [row] : []]; }
        }
        if (/UPDATE api_keys SET last_used_at/.test(s)) return [{}];
        if (/FROM pages WHERE id = \?/.test(s)) return [[{ id: 4, slug: 'promo', hook_slug: null, status: 'draft', host: null, path: null }]];
        if (/FROM pages ORDER BY/.test(s)) return [[{ id: 4, slug: 'promo' }]];
        if (/SELECT id, slug FROM hooks WHERE slug = \?/.test(s)) return [[]];
        if (/^INSERT INTO hooks/.test(s)) return [{ insertId: 90 }];
        if (/^UPDATE pages SET/.test(s)) return [{ affectedRows: 1 }];
        if (/FROM hooks h LEFT JOIN users u/.test(s)) return [[{ id: 90, slug: 'lp-promo', auth_type: 'none', auth_config: null }]];
        if (/FROM hook_targets ht/.test(s)) return [[]];
        return [[]];
      },
    };
  }
  // call() mounts routes/api.hooks — this block mounts routes/api.pages.
  function callPages(method, urlPath, { headers = {}, body } = {}) {
    const db = pagesDb();
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.db = db; next(); });
    app.use(pages);
    return new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const rq = http.request({ port: server.address().port, path: urlPath, method,
          headers: Object.assign(payload ? { 'content-type': 'application/json' } : {}, headers) }, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => { server.close(); let j = null; try { j = JSON.parse(data); } catch (_) {} resolve({ status: res.statusCode, body: j, db }); });
        });
        rq.on('error', (e) => { server.close(); reject(e); });
        if (payload) rq.write(payload);
        rq.end();
      });
    });
  }
  const created = (db) => db.calls.some(c => /^INSERT INTO hooks/.test(c.sql));
  const CREATE = '/api/pages/4/create-hook';

  test('inventory: create-hook mounts the gate; the five page-CRUD routes stay on jwtOrApiKey', () => {
    const layers = pages.stack.filter(l => l.route).map(l => ({
      sig: `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`, first: l.route.stack[0].handle.name,
    }));
    expect(layers.filter(l => l.first === 'staffAuth').map(l => l.sig)).toEqual(['POST /api/pages/:id/create-hook']);
    expect(layers.filter(l => l.first === 'jwtOrApiKey').map(l => l.sig).sort()).toEqual([
      'DELETE /api/pages/:id', 'GET /api/pages', 'GET /api/pages/:id', 'PATCH /api/pages/:id', 'POST /api/pages',
    ]);
    const code = fs.readFileSync(path.join(__dirname, '..', 'routes', 'api.pages.js'), 'utf8')
      .split('\n').filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    expect([...code.matchAll(/requireAuth\(\{[^}]*\}\)/g)].map(m => m[0]))
      .toEqual(["requireAuth({ audience: 'staff', can: 'automations.manage', allowApiKey: true })"]);
  });

  test('staff / attorney / legacy tokens → 403, no hook created', async () => {
    for (const headers of [tok(), tok({ roles: ['staff', 'attorney'] }), legacy('authorized'), legacy('authorized - SU')]) {
      const r = await callPages('POST', CREATE, { headers, body: {} });
      expect(r.status).toBe(403);
      expect(created(r.db)).toBe(false);
    }
  });

  test('admin, it and su create the hook', async () => {
    for (const roles of [['admin'], ['it'], ['su']]) {
      const r = await callPages('POST', CREATE, { headers: tok({ roles }), body: {} });
      expect(r.status).toBe(200);
      expect(r.body.hook.slug).toBe('lp-promo');
      expect(created(r.db)).toBe(true);
    }
  });

  test('x-api-key: internal passes; a scoped key only with automations.manage (B2 flip)', async () => {
    for (const [key, ok] of [[process.env.INTERNAL_API_KEY, true], [CAP_YCK, true], [SCOPED_YCK, false]]) {
      apiKeys.invalidateCache();
      const r = await callPages('POST', CREATE, { headers: { 'x-api-key': key }, body: {} });
      expect(r.status).toBe(ok ? 200 : 403);
      expect(created(r.db)).toBe(ok);
    }
  });

  test('portal token → 401', async () => {
    const portal = { authorization: 'Bearer ' + jwt.sign({ sub: 7, aud: 'contact', ver: 1 }, process.env.JWT_SECRET) };
    expect((await callPages('POST', CREATE, { headers: portal, body: {} })).status).toBe(401);
  });

  test('the page CRUD stays open to staff', async () => {
    expect((await callPages('GET', '/api/pages', { headers: tok() })).status).toBe(200);
    expect((await callPages('GET', '/api/pages/4', { headers: tok() })).status).toBe(200);
  });
});
