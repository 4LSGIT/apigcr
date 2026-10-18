// tests/appSettingsGate.test.js
//
/**
 * The firm.settings gate on app-settings writes — access-control arc A4
 * (routes/api.appSettings.js; ref/ACCESS_CONTROL_DESIGN.md §3.2–3, §3.6,
 * §8 Q3). The first staff-route mount of requireAuth.
 *
 * Since the settings arc (2026-10) the capability is decided PER KEY in the
 * handler (lib/settingsRegistry.js: fe-firm_phone is a firm key, so
 * firm.settings), after a requireAuth({ audience:'staff', allowApiKey:true })
 * mount; the per-key rules are tests/appSettingsRegistry.test.js. This file
 * keeps the A4 matrix on one firm key.
 *
 * WHAT IS LOCKED
 *   - PUT /api/app-settings/:key and POST /api/app-settings: staff / attorney
 *     / form_dev JWTs → 403 naming the permission, and no app_settings query
 *     runs; admin / it / su → through. The legacy 'authorized - SU' string
 *     alone → 403 since A2b (a claim, not a credential).
 *   - x-api-key callers pass (machine trust, Q3): PUT writes; POST still
 *     refuses them in its own handler (automation never mints keys).
 *   - Portal (aud:'contact') token / no credentials → 401 on writes.
 *   - GET stays on jwtOrApiKey: a plain staff JWT reads.
 *   - Audit parity: a denied write leaves a jwt_api_audit_log row
 *     (auth_type 'jwt', status 'unauthorized'), as the role gate does — beside
 *     the mount's 'authorized' row, since the refusal is the handler's.
 *
 * HARNESS: the REAL router, requireAuth, jwtOrApiKey, capabilities and
 * lib/withTransaction on an in-process express app (as
 * tests/formrender.extappearance.test.js), with a regex-scripted req.db. Nothing
 * is mocked; the internal api key comes from env INTERNAL_API_KEY via
 * firmConfig's env fallback (firmConfig never opens a DB under jest).
 *
 * Run: npx jest tests/appSettingsGate.test.js
 */
'use strict';

process.env.JWT_SECRET = 'app-settings-a4-test-secret';
process.env.INTERNAL_API_KEY = 'yci_app_settings_a4_internal';

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

const { withTransaction } = require('../lib/withTransaction');

const SECRET = process.env.JWT_SECRET;
const flush = () => new Promise(r => setImmediate(r));

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

function makeDb() {
  const calls = [];
  const row = { key: 'fe-firm_phone', value: '555-0100', is_secret: 0, is_editable: 1, type: 'phone', updated_at: '2026-10-14' };
  const query = async (sql, params) => {
    const norm = String(sql).replace(/\s+/g, ' ').trim();
    calls.push({ sql: norm, params: params || [] });
    if (/jwt_api_audit_log/.test(norm)) return [{ affectedRows: 1 }];
    if (/FROM api_keys WHERE key_hash/.test(norm)) return [[]];
    if (/^UPDATE app_settings/.test(norm)) return [{ affectedRows: 1 }];
    if (/^INSERT INTO app_settings/.test(norm)) return [{ affectedRows: 1 }];
    if (/FROM app_settings WHERE `key` IN \(\?\)/.test(norm)) return [[row]];   // GET
    if (/FROM app_settings WHERE `key` = \?/.test(norm)) {
      return [norm.includes('`key` = ? FOR UPDATE') || params[0] === row.key ? [row] : []];
    }
    throw new Error('unscripted query: ' + norm);
  };
  const db = {
    calls,
    query,
    getConnection: async () => ({ query, beginTransaction: async () => {}, commit: async () => {},
      rollback: async () => {}, release: () => {}, destroy: () => {} }),
  };
  db.withTransaction = (fn, opts) => withTransaction(db, fn, opts);
  return db;
}

function appWith(db) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use(require('../routes/api.appSettings'));
  return app;
}

function call(method, urlPath, { headers = {}, body } = {}) {
  const db = makeDb();
  const app = appWith(db);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        port: server.address().port, path: urlPath, method,
        headers: Object.assign(payload ? { 'content-type': 'application/json' } : {}, headers),
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(data || '{}'), db });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const tok = (claims = {}) => jwt.sign(Object.assign(
  { sub: 5, username: 'sb', user_type: 'staff', user_auth: 'authorized', aud: 'staff', ver: 1 },
  claims), SECRET, { expiresIn: '1h' });
const bearer = (claims) => ({ authorization: 'Bearer ' + tok(claims) });

const settingsQueries = db => db.calls.filter(c => /app_settings/.test(c.sql));
const writes = db => db.calls.filter(c => /^(UPDATE app_settings SET|INSERT INTO app_settings \()/.test(c.sql));
const versioned = db => db.calls.filter(c => /^INSERT INTO app_settings_versions/.test(c.sql));

const PUT = (headers) => call('PUT', '/api/app-settings/fe-firm_phone',
  { headers, body: { value: '555-0199' } });
const POST = (headers) => call('POST', '/api/app-settings',
  { headers, body: { key: 'new_knob', value: 'x' } });

// ─────────────────────────────────────────────────────────────────────────────
// Denied: non-holders
// ─────────────────────────────────────────────────────────────────────────────

describe('non-holders are refused before any app_settings query', () => {
  for (const roles of [['staff'], ['staff', 'attorney'], ['form_dev'], []]) {
    test(`roles ${JSON.stringify(roles)}: PUT → 403, no app_settings query`, async () => {
      const r = await PUT(bearer({ roles }));
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ status: 'error', message: 'Changing Firm phone needs the firm.settings permission' });
      expect(settingsQueries(r.db)).toHaveLength(0);
    });

    test(`roles ${JSON.stringify(roles)}: POST → 403, no app_settings query`, async () => {
      const r = await POST(bearer({ roles }));
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ status: 'error', message: 'Creating a setting needs the firm.settings permission' });
      expect(settingsQueries(r.db)).toHaveLength(0);
    });
  }

  test('legacy non-SU token (no roles claim) → 403', async () => {
    const legacy = jwt.sign({ sub: 5, username: 'sb', user_auth: 'authorized', ver: 1 },
      SECRET, { expiresIn: '1h' });
    const r = await PUT({ authorization: 'Bearer ' + legacy });
    expect(r.status).toBe(403);
  });

  test('a denied write leaves a jwt/unauthorized audit row (role-gate parity), after the mount\'s authorized one', async () => {
    const r = await PUT(bearer({ roles: ['staff'] }));
    await flush();
    const audit = r.db.calls.filter(c => /jwt_api_audit_log/.test(c.sql));
    // (route, method, headers, query, body, ip, ua, auth_type, username, status)
    expect(audit.map(a => a.params[9])).toEqual(['authorized', 'unauthorized']);
    expect(audit[1].params[0]).toBe('/api/app-settings/fe-firm_phone');
    expect(audit[1].params[7]).toBe('jwt');
    expect(audit[1].params[8]).toBe('sb');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Allowed: firm.settings holders
// ─────────────────────────────────────────────────────────────────────────────

describe('firm.settings holders write', () => {
  const holders = {
    admin: { roles: ['admin'] },
    it: { roles: ['it'] },
    su: { roles: ['su'] },
    'admin+staff': { roles: ['staff', 'admin'] },
  };
  for (const [name, claims] of Object.entries(holders)) {
    test(`${name}: PUT → 200, row updated (and versioned)`, async () => {
      const r = await PUT(bearer(claims));
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('success');
      expect(writes(r.db)).toHaveLength(1);
      expect(writes(r.db)[0].params).toEqual(['555-0199', 'fe-firm_phone']);
      expect(versioned(r.db)).toHaveLength(1);
    });

    test(`${name}: POST → 201, row inserted (and versioned)`, async () => {
      const r = await POST(bearer(claims));
      expect(r.status).toBe(201);
      expect(writes(r.db)).toHaveLength(1);
      expect(writes(r.db)[0].sql).toMatch(/^INSERT INTO app_settings \(/);
      expect(versioned(r.db)).toHaveLength(1);
    });
  }

  test("legacy 'authorized - SU' string (no roles claim) is refused PUT and POST (A2b)", async () => {
    const legacy = { authorization: 'Bearer ' + jwt.sign(
      { sub: 6, username: 'IT', user_type: 'admin', user_auth: 'authorized - SU', ver: 1 },
      SECRET, { expiresIn: '1h' }) };
    const put = await PUT(legacy);
    expect(put.status).toBe(403);
    expect(writes(put.db)).toHaveLength(0);
    const post = await POST(legacy);
    expect(post.status).toBe(403);
    expect(writes(post.db)).toHaveLength(0);
  });

  test('legacy SU string on a staff-only roles claim is refused', async () => {
    const r = await PUT(bearer({ sub: 6, username: 'IT', user_auth: 'authorized - SU', roles: ['staff'] }));
    expect(r.status).toBe(403);
  });

  test('the post-collapse SU shape (authorized + su role) writes', async () => {
    const r = await PUT(bearer({ sub: 6, username: 'IT', user_auth: 'authorized', roles: ['it', 'admin', 'form_dev', 'su'] }));
    expect(r.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Machine keys (Q3) and authn failures
// ─────────────────────────────────────────────────────────────────────────────

describe('x-api-key callers (machine trust until Phase B)', () => {
  const internal = { 'x-api-key': process.env.INTERNAL_API_KEY };

  test('internal key: PUT passes the gate and writes', async () => {
    const r = await PUT(internal);
    expect(r.status).toBe(200);
    expect(writes(r.db)).toHaveLength(1);
  });

  test('internal key: POST passes the gate, then its handler refuses (never mints)', async () => {
    const r = await POST(internal);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ status: 'error', message: 'Settings can only be created by a signed-in user' });
    expect(writes(r.db)).toHaveLength(0);
  });

  test('unrecognized key + staff Bearer: JWT fallthrough is gated → 403', async () => {
    const r = await PUT(Object.assign({ 'x-api-key': 'yck_not_a_real_key' }, bearer({ roles: ['staff'] })));
    expect(r.status).toBe(403);
    expect(writes(r.db)).toHaveLength(0);
  });

  test('unrecognized key + admin Bearer: JWT fallthrough passes', async () => {
    const r = await PUT(Object.assign({ 'x-api-key': 'yck_not_a_real_key' }, bearer({ roles: ['admin'] })));
    expect(r.status).toBe(200);
  });
});

describe('authn failures → 401', () => {
  const portal = { authorization: 'Bearer ' + jwt.sign({ sub: 7, aud: 'contact', ver: 1 }, SECRET, { expiresIn: '1h' }) };

  test('portal (aud:contact) token: PUT and POST 401', async () => {
    for (const r of [await PUT(portal), await POST(portal)]) {
      expect(r.status).toBe(401);
      expect(writes(r.db)).toHaveLength(0);
    }
  });

  test('no credentials: PUT and POST 401', async () => {
    expect((await PUT({})).status).toBe(401);
    expect((await POST({})).status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET stays ungated
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/app-settings stays on jwtOrApiKey', () => {
  test('plain staff JWT reads', async () => {
    const r = await call('GET', '/api/app-settings', { headers: bearer({ roles: ['staff'] }) });
    expect(r.status).toBe(200);
    expect(r.body.settings.find(s => s.key === 'fe-firm_phone')).toMatchObject({ value: '555-0100', can_edit: false });
  });

  test('legacy no-roles staff JWT reads', async () => {
    const legacy = jwt.sign({ sub: 5, username: 'sb', user_auth: 'authorized', ver: 1 },
      SECRET, { expiresIn: '1h' });
    const r = await call('GET', '/api/app-settings', { headers: { authorization: 'Bearer ' + legacy } });
    expect(r.status).toBe(200);
  });

  test('portal token cannot read', async () => {
    const portal = jwt.sign({ sub: 7, aud: 'contact', ver: 1 }, SECRET, { expiresIn: '1h' });
    const r = await call('GET', '/api/app-settings', { headers: { authorization: 'Bearer ' + portal } });
    expect(r.status).toBe(401);
  });
});
