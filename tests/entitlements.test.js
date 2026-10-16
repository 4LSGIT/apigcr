// tests/entitlements.test.js
//
/**
 * Launcher entitlement denies — access-control A5
 * (services/entitlementService.js, routes/api.entitlements.js,
 * routes/api.firmData.js `denied`; ref/ACCESS_CONTROL_DESIGN.md §2.6).
 *
 * WHAT IS LOCKED (the real-engine half — the union, deny-wins, the UNIQUE —
 * is tests/entitlements.mysql.test.js)
 *   - UNDENIABLE is exactly { moreSettings, helpSupport, all }, all real registry
 *     keys.
 *   - normalizeDeny: firm ref omitted/null/'' → '' (anything else 400); role
 *     ref must be a users.roles member; user ref digits/number, one spelling;
 *     item_key must be a featureRegistry.js key; undeniables refused at every
 *     scope; bad scope 400.
 *   - deniedFor: ONE query, the user id bound, distinct + sorted, undeniables
 *     stripped at resolve even when a row names them.
 *   - CRUD: firm.settings gate (staff / attorney / form_dev 403; admin, it,
 *     su through; x-api-key through as created_by 0; portal 401); 400 / 409 /
 *     404 mapping; a user-scope deny for a missing user is a 400.
 *   - /api/firm-data carries `denied` — the resolver's list, [] with no rows,
 *     [] (fail-soft) when the query throws — with exactly one entitlement
 *     query per call.
 *
 * HARNESS: the REAL routers / requireAuth / jwtOrApiKey / capabilities /
 * service over an in-process express app and a scripted req.db. Nothing is
 * mocked; the internal api key comes from env INTERNAL_API_KEY.
 *
 * Run: npx jest tests/entitlements.test.js
 */
'use strict';

process.env.JWT_SECRET = 'entitlements-a5-test-secret';
process.env.INTERNAL_API_KEY = 'yci_entitlements_a5_internal';

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

const svc = require('../services/entitlementService');
const { UNDENIABLE, normalizeDeny, deniedFor } = svc;

const SECRET = process.env.JWT_SECRET;

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

function makeDb({ deniedRows = [], deniedThrows = false, users = [5, 6] } = {}) {
  const calls = [];
  const denies = [];
  return {
    calls, denies,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/jwt_api_audit_log/.test(s)) return [{ affectedRows: 1 }];
      if (/FROM api_keys WHERE key_hash/.test(s)) return [[]];
      if (/^SELECT DISTINCT d\.item_key FROM entitlement_denies/.test(s)) {
        if (deniedThrows) throw new Error('no such table');
        return [deniedRows.map(item_key => ({ item_key }))];
      }
      if (/^SELECT `user` FROM users WHERE `user` = \?/.test(s)) {
        return [users.includes(params[0]) ? [{ user: params[0] }] : []];
      }
      if (/^INSERT INTO entitlement_denies/.test(s)) {
        if (denies.some(d => d.join('|') === params.slice(0, 3).join('|'))) {
          const e = new Error('Duplicate entry'); e.code = 'ER_DUP_ENTRY'; throw e;
        }
        denies.push(params.slice(0, 3));
        return [{ insertId: 40 + denies.length }];
      }
      if (/^SELECT id, scope, scope_ref, item_key/.test(s)) return [[{ id: 1, scope: 'firm', scope_ref: '', item_key: 'moreReports' }]];
      if (/^DELETE FROM entitlement_denies WHERE id = \?/.test(s)) return [{ affectedRows: params[0] === 1 ? 1 : 0 }];
      // /api/firm-data's other reads
      if (/^SELECT \* FROM users WHERE user = \?/.test(s)) return [[{ user: params[0], user_name: 'U', roles: 'staff', password: 'x' }]];
      if (/FROM phone_lines|FROM email_credentials|FROM users|FROM app_settings/.test(s)) return [[]];
      if (/contact_roles|FROM contacts/.test(s)) return [[]];
      throw new Error('unscripted query: ' + s);
    },
  };
}

function call(router, method, urlPath, { headers = {}, body, db = makeDb() } = {}) {
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
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(data || '{}'), db }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const bearer = (claims = {}) => ({ authorization: 'Bearer ' + jwt.sign(Object.assign(
  { sub: 6, username: 'IT', user_type: 1, user_auth: 'authorized', aud: 'staff', ver: 1, roles: [] }, claims),
  SECRET, { expiresIn: '1h' }) });

const ent = require('../routes/api.entitlements');
const firmData = require('../routes/api.firmData');
const inserts = db => db.calls.filter(c => /^INSERT INTO entitlement_denies/.test(c.sql));
const entQueries = db => db.calls.filter(c => /entitlement_denies/.test(c.sql));

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary
// ─────────────────────────────────────────────────────────────────────────────

describe('vocabulary', () => {
  test('UNDENIABLE is exactly moreSettings + helpSupport + all, frozen', () => {
    expect([...UNDENIABLE]).toEqual(['moreSettings', 'helpSupport', 'all']);   // all: ui-custom S6c
    expect(Object.isFrozen(UNDENIABLE)).toBe(true);
  });

  test('both undeniables are real registry keys (a rename would orphan the rule)', () => {
    const keys = svc.loadRegistryKeys();
    expect(keys.size).toBeGreaterThan(20);
    for (const k of UNDENIABLE) expect(keys.has(k)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeDeny — write-side validation
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeDeny', () => {
  const bad = (b, re) => {
    let err;
    try { normalizeDeny(b); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.status).toBe(400);
    if (re) expect(err.message).toMatch(re);
  };

  test("firm: omitted / null / '' all normalize to ''", () => {
    for (const ref of [undefined, null, '']) {
      expect(normalizeDeny({ scope: 'firm', scope_ref: ref, item_key: 'moreReports' }))
        .toEqual({ scope: 'firm', scope_ref: '', item_key: 'moreReports' });
    }
  });

  test('firm with a ref is refused', () => bad({ scope: 'firm', scope_ref: 'staff', item_key: 'moreReports' }, /empty/));

  test('role: a users.roles member, nothing else', () => {
    expect(normalizeDeny({ scope: 'role', scope_ref: 'attorney', item_key: 'moreCampaigns' }).scope_ref).toBe('attorney');
    bad({ scope: 'role', scope_ref: 'paralegal', item_key: 'moreCampaigns' }, /role/);
    bad({ scope: 'role', scope_ref: '', item_key: 'moreCampaigns' }, /role/);
    bad({ scope: 'role', item_key: 'moreCampaigns' }, /role/);
  });

  test('user: digits or a number, one canonical spelling', () => {
    expect(normalizeDeny({ scope: 'user', scope_ref: 5, item_key: 'bills' }).scope_ref).toBe('5');
    expect(normalizeDeny({ scope: 'user', scope_ref: '05', item_key: 'bills' }).scope_ref).toBe('5');
    for (const ref of ['x5', '-1', '1234', '', null, 5.5]) bad({ scope: 'user', scope_ref: ref, item_key: 'bills' }, /users\.user/);
  });

  test('item_key must be a registry key (a typo is refused, not stored)', () => {
    bad({ scope: 'firm', item_key: 'moreReport' }, /unknown item_key "moreReport"/);
    bad({ scope: 'firm', item_key: 'constructor' }, /unknown item_key/);
    bad({ scope: 'firm' }, /item_key is required/);
  });

  test('undeniables refused at EVERY scope', () => {
    for (const k of UNDENIABLE) {
      bad({ scope: 'firm', item_key: k }, /cannot be denied/);
      bad({ scope: 'role', scope_ref: 'staff', item_key: k }, /cannot be denied/);
      bad({ scope: 'user', scope_ref: '5', item_key: k }, /cannot be denied/);
    }
  });

  test('bad scope', () => {
    bad({ scope: 'tenant', item_key: 'bills' }, /scope must be/);
    bad(null, /scope must be/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deniedFor — resolve-side contract (the union itself: the mysql suite)
// ─────────────────────────────────────────────────────────────────────────────

describe('deniedFor', () => {
  test('one query, user id bound, distinct + sorted', async () => {
    const db = makeDb({ deniedRows: ['moreReports', 'bills', 'moreReports', 'adminEtch'] });
    expect(await deniedFor(db, 5)).toEqual(['adminEtch', 'bills', 'moreReports']);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].params).toEqual([5]);
  });

  test('the single statement covers all three scopes', () => {
    expect(svc.DENIED_SQL).toMatch(/d\.scope = 'firm'/);
    expect(svc.DENIED_SQL).toMatch(/d\.scope = 'role' AND .*FIND_IN_SET\(d\.scope_ref, u\.roles\)/);
    expect(svc.DENIED_SQL).toMatch(/d\.scope = 'user' AND .*CAST\(d\.scope_ref AS UNSIGNED\) = u\.`user`/);
    expect(svc.DENIED_SQL).toMatch(/LEFT JOIN users u/);
  });

  test('undeniables are stripped at RESOLVE (a row that got in some other way)', async () => {
    const db = makeDb({ deniedRows: ['helpSupport', 'moreSettings', 'bills'] });
    expect(await deniedFor(db, 5)).toEqual(['bills']);
  });

  test('a non-integer user id binds NULL (firm denies only, by the LEFT JOIN)', async () => {
    const db = makeDb({ deniedRows: [] });
    await deniedFor(db, undefined);
    expect(db.calls[0].params).toEqual([null]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD + gate
// ─────────────────────────────────────────────────────────────────────────────

describe('/api/entitlements gate (firm.settings)', () => {
  const FIRM = { scope: 'firm', item_key: 'moreReports' };

  for (const roles of [['staff'], ['staff', 'attorney'], ['form_dev'], []]) {
    test(`roles ${JSON.stringify(roles)} → 403 on GET, POST, DELETE; nothing written`, async () => {
      for (const [m, p, body] of [['GET', '/api/entitlements'], ['POST', '/api/entitlements', FIRM], ['DELETE', '/api/entitlements/1']]) {
        const r = await call(ent, m, p, { headers: bearer({ roles }), body });
        expect(r.status).toBe(403);
        expect(entQueries(r.db)).toHaveLength(0);
      }
    });
  }

  for (const roles of [['admin'], ['it'], ['su'], ['staff', 'admin']]) {
    test(`roles ${JSON.stringify(roles)} → POST 201 with created_by = the caller`, async () => {
      const r = await call(ent, 'POST', '/api/entitlements', { headers: bearer({ roles }), body: FIRM });
      expect(r.status).toBe(201);
      expect(r.body.deny).toMatchObject({ scope: 'firm', scope_ref: '', item_key: 'moreReports' });
      expect(inserts(r.db)[0].params).toEqual(['firm', '', 'moreReports', 6]);
    });
  }

  test('the legacy SU string alone is refused (A2b)', async () => {
    const r = await call(ent, 'POST', '/api/entitlements', { headers: bearer({ user_auth: 'authorized - SU' }), body: FIRM });
    expect(r.status).toBe(403);
  });

  test('x-api-key passes (Q3) and is recorded as created_by 0', async () => {
    const r = await call(ent, 'POST', '/api/entitlements', { headers: { 'x-api-key': process.env.INTERNAL_API_KEY }, body: FIRM });
    expect(r.status).toBe(201);
    expect(inserts(r.db)[0].params[3]).toBe(0);
  });

  test('portal token / no credentials → 401', async () => {
    const portal = { authorization: 'Bearer ' + jwt.sign({ sub: 7, aud: 'contact', ver: 1 }, SECRET, { expiresIn: '1h' }) };
    expect((await call(ent, 'POST', '/api/entitlements', { headers: portal, body: FIRM })).status).toBe(401);
    expect((await call(ent, 'GET', '/api/entitlements')).status).toBe(401);
  });
});

describe('/api/entitlements CRUD', () => {
  const admin = bearer({ roles: ['admin'] });

  test('GET lists rows and names the undeniables', async () => {
    const r = await call(ent, 'GET', '/api/entitlements', { headers: admin });
    expect(r.status).toBe(200);
    expect(r.body.denies).toHaveLength(1);
    expect(r.body.undeniable).toEqual(['moreSettings', 'helpSupport', 'all']);
  });

  test('POST: undeniable 400, unknown key 400, nothing written', async () => {
    for (const body of [{ scope: 'firm', item_key: 'moreSettings' }, { scope: 'role', scope_ref: 'staff', item_key: 'helpSupport' },
                        { scope: 'firm', item_key: 'nope' }]) {
      const r = await call(ent, 'POST', '/api/entitlements', { headers: admin, body });
      expect(r.status).toBe(400);
      expect(inserts(r.db)).toHaveLength(0);
    }
  });

  test('POST: a user-scope deny for a user that does not exist → 400', async () => {
    const r = await call(ent, 'POST', '/api/entitlements', { headers: admin, body: { scope: 'user', scope_ref: '99', item_key: 'bills' } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/no user 99/);
    expect(inserts(r.db)).toHaveLength(0);
  });

  test('POST: a user-scope deny stores the canonical digits', async () => {
    const r = await call(ent, 'POST', '/api/entitlements', { headers: admin, body: { scope: 'user', scope_ref: '05', item_key: 'bills' } });
    expect(r.status).toBe(201);
    expect(inserts(r.db)[0].params.slice(0, 3)).toEqual(['user', '5', 'bills']);
  });

  test('POST: duplicate → 409 (the table UNIQUE; null ref normalized to the same row)', async () => {
    const db = makeDb();
    expect((await call(ent, 'POST', '/api/entitlements', { headers: admin, db, body: { scope: 'firm', item_key: 'bills' } })).status).toBe(201);
    const dup = await call(ent, 'POST', '/api/entitlements', { headers: admin, db, body: { scope: 'firm', scope_ref: null, item_key: 'bills' } });
    expect(dup.status).toBe(409);
  });

  test('DELETE: 200 for a row, 404 for none, 400 for junk', async () => {
    expect((await call(ent, 'DELETE', '/api/entitlements/1', { headers: admin })).status).toBe(200);
    expect((await call(ent, 'DELETE', '/api/entitlements/2', { headers: admin })).status).toBe(404);
    expect((await call(ent, 'DELETE', '/api/entitlements/x', { headers: admin })).status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/firm-data delivery
// ─────────────────────────────────────────────────────────────────────────────

describe('/api/firm-data `denied`', () => {
  const staff = bearer({ sub: 5, roles: ['staff'] });

  test('carries the resolver list for the caller, with ONE entitlement query', async () => {
    const db = makeDb({ deniedRows: ['moreReports', 'bills'] });
    const r = await call(firmData, 'GET', '/api/firm-data', { headers: staff, db });
    expect(r.status).toBe(200);
    expect(r.body.denied).toEqual(['bills', 'moreReports']);
    expect(entQueries(db)).toHaveLength(1);
    expect(entQueries(db)[0].params).toEqual([5]);
  });

  test('[] when there are no rows', async () => {
    const r = await call(firmData, 'GET', '/api/firm-data', { headers: staff, db: makeDb() });
    expect(r.body.denied).toEqual([]);
  });

  test('fail-soft: a throwing entitlement query is [] — the shell still boots', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await call(firmData, 'GET', '/api/firm-data', { headers: staff, db: makeDb({ deniedThrows: true }) });
    expect(r.status).toBe(200);
    expect(r.body.denied).toEqual([]);
    expect(r.body.currentUser).toMatchObject({ user: 5 });
    console.error.mockRestore();
  });

  test('undeniables never reach the shell', async () => {
    const r = await call(firmData, 'GET', '/api/firm-data', { headers: staff, db: makeDb({ deniedRows: ['moreSettings', 'helpSupport'] }) });
    expect(r.body.denied).toEqual([]);
  });
});
