// tests/vocabWriteGates.test.js
//
/**
 * YisraCase Config vocabulary WRITES need firm.settings (settings arc, Fred
 * 2026-10-17): custom-field definitions, calendar item types, pipeline
 * templates / stages / requirements, and contact-role TYPES.
 *
 *   routes/api.fieldDefs.js           every POST / PATCH (reconcile included)
 *   routes/api.calendarTypesAdmin.js  every POST / PUT / DELETE
 *   routes/api.pipelineAdmin.js       every POST / PUT / DELETE (reorders included)
 *   routes/api.contactRoles.js        POST /api/contact-role-types and
 *                                     PUT /api/contact-role-types/:code ONLY —
 *                                     /api/contacts/:id/roles* is record data
 *                                     any staff edits and stays jwtOrApiKey
 *
 * WHAT IS LOCKED — for EVERY write route, enumerated from the router itself
 * (a write route added later without the gate fails here, and the expected
 * counts catch a router that stops enumerating):
 *   - staff-only JWTs (staff; staff + attorney; form_dev) → 403 { error:
 *     'Forbidden' } and the handler never runs (no query but the audit row);
 *   - admin / it / su JWTs → through the gate (the handler answers with its
 *     own { status } envelope);
 *   - machine keys: a NULL-scope key and the internal key → through; a scoped
 *     key → through only when its scopes name firm.settings (a route:/ scope
 *     covering the path, or another capability, → 403 missingCapability);
 *   - no credentials → 401.
 * And the read side is unchanged: every GET (and every per-contact role
 * route) still admits a staff-only JWT.
 *
 * HARNESS: the REAL routers, lib/auth.requireAuth, lib/auth.jwtOrApiKey and
 * lib/capabilities on one in-process express app per file, with a scripted
 * req.db that answers the auth layer (api_keys lookups, audit rows) and makes
 * every other query THROW — so a request that reaches a handler ends in the
 * route's own error envelope, never the gate's. Only the side-effect services
 * behind the handlers are stubbed (the alert pager, the DDL reconciler);
 * nothing on the auth path is. The internal key comes from env
 * INTERNAL_API_KEY via firmConfig's env fallback (firmConfig opens no DB
 * under jest).
 *
 * Run: npx jest tests/vocabWriteGates.test.js
 */
'use strict';

process.env.JWT_SECRET = 'vocab-write-gates-test-secret';
process.env.INTERNAL_API_KEY = 'yci_vocab_gates_internal';

jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));
jest.mock('../services/fieldDefReconciler', () => ({
  scheduleReconcile: jest.fn(),
  reconcile: jest.fn(async () => ({ status: 'noop' })),
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const apiKeys = require('../lib/apiKeys');

const ROUTERS = {
  fieldDefs:     require('../routes/api.fieldDefs'),
  calendarTypes: require('../routes/api.calendarTypesAdmin'),
  pipeline:      require('../routes/api.pipelineAdmin'),
  contactRoles:  require('../routes/api.contactRoles'),
};

// ── callers ─────────────────────────────────────────────────────────────────

const tok = (roles) => jwt.sign(
  { sub: 5, username: 'gate-test', user_type: 'staff', user_auth: 'authorized', aud: 'staff', ver: 1, roles },
  process.env.JWT_SECRET, { expiresIn: '1h' });
const bearer = (roles) => ({ authorization: 'Bearer ' + tok(roles) });

const KEYS = {
  legacy:   { raw: 'yck_' + 'l'.repeat(22), row: { id: 2, label: 'legacy-null-scope', revoked_at: null, scopes: null } },
  firm:     { raw: 'yck_' + 'f'.repeat(22), row: { id: 3, label: 'firm-settings-bot', revoked_at: null, scopes: ['firm.settings'] } },
  otherCap: { raw: 'yck_' + 'a'.repeat(22), row: { id: 4, label: 'automations-bot', revoked_at: null, scopes: ['automations.manage'] } },
  // A route scope covering every vocabulary prefix — it reaches these paths on
  // a plain jwtOrApiKey mount, and must NOT stand in for the capability.
  routes:   { raw: 'yck_' + 'r'.repeat(22), row: { id: 5, label: 'route-scoped', revoked_at: null,
              scopes: ['route:/api/field-defs', 'route:/api/calendar-types-admin', 'route:/api/pipeline-admin', 'route:/api/contact-role-types'] } },
};
const apiKey = (k) => ({ 'x-api-key': KEYS[k].raw });

const DENIED_JWTS  = { staff: ['staff'], 'staff+attorney': ['staff', 'attorney'], form_dev: ['form_dev'] };
const ALLOWED_JWTS = { admin: ['admin'], it: ['it'], su: ['su'] };

// ── scripted db ─────────────────────────────────────────────────────────────

const AUTH_SQL = /jwt_api_audit_log|FROM api_keys WHERE key_hash|UPDATE api_keys SET last_used_at/;

function makeDb() {
  const byHash = Object.fromEntries(Object.values(KEYS).map((k) => [apiKeys.hashKey(k.raw), k.row]));
  const handlerCalls = [];
  return {
    handlerCalls,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/FROM api_keys WHERE key_hash/.test(s)) {
        const r = byHash[params[0]];
        return [r ? [{ ...r }] : []];
      }
      if (AUTH_SQL.test(s)) return [{ affectedRows: 1 }];
      handlerCalls.push(s);
      throw new Error('vocab-gate-test: handler reached');
    },
  };
}

// ── one app per router ──────────────────────────────────────────────────────

const servers = {};
let currentDb = null;

beforeAll(async () => {
  for (const [name, router] of Object.entries(ROUTERS)) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = currentDb; next(); });
    app.use(router);
    await new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => {
        servers[name] = { server, base: `http://127.0.0.1:${server.address().port}` };
        resolve();
      });
    });
  }
});
afterAll(async () => {
  for (const { server } of Object.values(servers)) await new Promise((r) => server.close(r));
});
beforeEach(() => {
  apiKeys.invalidateCache();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => console.error.mockRestore());

const PARAMS = { id: '7', type_key: 'ss', code: 'judge', roleRowId: '9' };
const fill = (p) => p.replace(/:(\w+)/g, (_, k) => PARAMS[k] || '1');

async function call(name, method, routePath, headers) {
  currentDb = makeDb();
  const db = currentDb;
  const res = await fetch(servers[name].base + fill(routePath), {
    method: method.toUpperCase(),
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'get' ? undefined : JSON.stringify({}),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }
  return { status: res.status, body, handlerCalls: db.handlerCalls };
}

// Through the gate = the handler answered: its own { status } envelope, never
// the auth layer's 401/403 { error }.
const passedGate = (r) => r.status !== 401 && r.status !== 403
  && Object.prototype.hasOwnProperty.call(r.body, 'status') && !Object.prototype.hasOwnProperty.call(r.body, 'error');

// ── route inventory (from the routers themselves) ───────────────────────────

const routesOf = (router) => router.stack.filter((l) => l.route)
  .map((l) => ({ path: l.route.path, method: Object.keys(l.route.methods)[0] }));

const isPerContactRole = (r) => r.path.startsWith('/api/contacts/');
const GATED = Object.fromEntries(Object.entries(ROUTERS).map(([name, router]) => [name,
  routesOf(router).filter((r) => r.method !== 'get' && !isPerContactRole(r))]));
const OPEN = Object.fromEntries(Object.entries(ROUTERS).map(([name, router]) => [name,
  routesOf(router).filter((r) => r.method === 'get' || isPerContactRole(r))]));

const CASES = Object.entries(GATED).flatMap(([name, list]) =>
  list.map((r) => [`${name} ${r.method.toUpperCase()} ${r.path}`, name, r.method, r.path]));
const OPEN_CASES = Object.entries(OPEN).flatMap(([name, list]) =>
  list.map((r) => [`${name} ${r.method.toUpperCase()} ${r.path}`, name, r.method, r.path]));

describe('the inventory the gate tests run over', () => {
  test('every write route of the three Config routers, and exactly the two role-TYPE writes', () => {
    expect(GATED.fieldDefs.map((r) => `${r.method} ${r.path}`)).toEqual([
      'post /api/field-defs', 'patch /api/field-defs/:id', 'post /api/field-defs/:id/deactivate',
      'post /api/field-defs/:id/reactivate', 'post /api/field-defs/reconcile',
    ]);
    expect(GATED.calendarTypes).toHaveLength(7);
    expect(GATED.pipeline).toHaveLength(11);
    expect(GATED.contactRoles.map((r) => `${r.method} ${r.path}`)).toEqual([
      'post /api/contact-role-types', 'put /api/contact-role-types/:code',
    ]);
    expect(OPEN.contactRoles.map((r) => `${r.method} ${r.path}`)).toEqual([
      'get /api/contact-role-types', 'get /api/contacts/:id/roles', 'post /api/contacts/:id/roles',
      'patch /api/contacts/:id/roles/:roleRowId', 'delete /api/contacts/:id/roles/:roleRowId',
    ]);
  });
});

// ── the gate, on every write route ──────────────────────────────────────────

describe.each(CASES)('%s', (_label, name, method, routePath) => {
  test('staff-only JWTs → 403 Forbidden, handler never runs', async () => {
    for (const roles of Object.values(DENIED_JWTS)) {
      const r = await call(name, method, routePath, bearer(roles));
      expect({ roles, status: r.status, body: r.body }).toEqual({ roles, status: 403, body: { error: 'Forbidden' } });
      expect(r.handlerCalls).toEqual([]);
    }
  });

  test('admin / it / su JWTs pass the gate', async () => {
    for (const roles of Object.values(ALLOWED_JWTS)) {
      const r = await call(name, method, routePath, bearer(roles));
      expect({ roles, passed: passedGate(r), status: r.status }).toEqual({ roles, passed: true, status: r.status });
    }
  });

  test('machine keys: NULL-scope and internal pass; a scoped key only with firm.settings', async () => {
    for (const headers of [apiKey('legacy'), { 'x-api-key': process.env.INTERNAL_API_KEY }, apiKey('firm')]) {
      const r = await call(name, method, routePath, headers);
      expect(passedGate(r)).toBe(true);
    }
    for (const k of ['otherCap', 'routes']) {
      const r = await call(name, method, routePath, apiKey(k));
      expect({ k, status: r.status, body: r.body })
        .toEqual({ k, status: 403, body: { error: 'Forbidden', missingCapability: 'firm.settings' } });
      expect(r.handlerCalls).toEqual([]);
    }
  });

  test('no credentials → 401', async () => {
    const r = await call(name, method, routePath, {});
    expect(r.status).toBe(401);
    expect(r.handlerCalls).toEqual([]);
  });
});

// ── the read side (and per-contact roles) is unchanged ──────────────────────

describe.each(OPEN_CASES)('%s (not gated)', (_label, name, method, routePath) => {
  test('a staff-only JWT still reaches the handler', async () => {
    const r = await call(name, method, routePath, bearer(['staff']));
    expect(passedGate(r)).toBe(true);
  });
});
