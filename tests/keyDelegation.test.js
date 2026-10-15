// tests/keyDelegation.test.js
//
/**
 * Delegated session keys — access-control D1 (lib/capabilities.js
 * CHILD_SCOPES / childEffectiveScopes, lib/auth.readonly.js cascade,
 * routes/api.readonlyKeys.js /children, routes/api.alertIt.js root budget;
 * ACCESS_CONTROL_DESIGN §5.8).
 *
 * WHAT IS LOCKED (no DB — the real-engine half is tests/keyDelegation.mysql.test.js)
 *   - keys.mint is explicit: a legacy NULL-scopes key does not hold it.
 *   - CHILD_SCOPES is exactly the trio; childEffectiveScopes = own ∩ trio ∩
 *     parent (a NULL / malformed child column → [] — never legacy).
 *   - Auth cascade: a child of a revoked / missing / expired parent is a 401
 *     with its own audited status and NOTHING written to its row; a live child
 *     gets its effective scopes, parentKeyId and rootKeyId; a root key's
 *     rootKeyId is its own id.
 *   - Route ordering: /children and the SU /:id, /:id/log routes never
 *     swallow each other (HTTP, both auth types).
 *   - Every child-mint 400 (scope outside the trio, outside the parent, empty,
 *     unknown; TTL over 24h / past the parent / junk; no label) is decided
 *     before any transaction opens — nothing is inserted.
 *   - The child-caller belt on all three handlers.
 *   - The IT-alert budget is per ROOT key: a parent and its children share 10.
 *
 * HARNESS: the real modules over scripted dbs; express in-process for HTTP.
 * emailService / phoneService are mocked (provider boundaries, not under test).
 *
 * Run: npx jest tests/keyDelegation.test.js
 */
'use strict';

process.env.JWT_SECRET = 'key-delegation-d1-test-secret';
process.env.SU_RATE_LIMIT_READONLYKEYS = '10000';

jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/phoneService', () => ({ sendSms: jest.fn(async () => ({ ok: true })) }));

const express = require('express');
const jwt = require('jsonwebtoken');

const { KEY_SCOPES, CHILD_SCOPES, keyAllows, childEffectiveScopes } = require('../lib/capabilities');
const { readonlyApiKeyAuth, hashKey } = require('../lib/auth.readonly');
const { mintElevationToken } = require('../lib/auth.superuser');
const keysRouter = require('../routes/api.readonlyKeys');
const alertRouter = require('../routes/api.alertIt');

const HOUR = 3600e3;
const flush = () => new Promise(r => setImmediate(r));

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary + the intersection
// ─────────────────────────────────────────────────────────────────────────────

describe('keys.mint + CHILD_SCOPES', () => {
  test('keys.mint is an explicit surface scope — a legacy NULL key lacks it', () => {
    expect(KEY_SCOPES['keys.mint']).toMatchObject({ explicit: true });
    expect(keyAllows({ scopes: null }, 'keys.mint')).toBe(false);
    expect(keyAllows({}, 'keys.mint')).toBe(false);
    expect(keyAllows({ scopes: ['keys.mint'] }, 'keys.mint')).toBe(true);
  });

  test('CHILD_SCOPES is exactly the trio, frozen', () => {
    expect(CHILD_SCOPES).toEqual(['sql.ro', 'scratch', 'alert']);
    expect(Object.isFrozen(CHILD_SCOPES)).toBe(true);
  });

  test('childEffectiveScopes = own ∩ trio ∩ parent', () => {
    const mgr = ['sql.ro', 'scratch', 'alert', 'keys.mint'];
    expect(childEffectiveScopes(['sql.ro', 'alert'], mgr)).toEqual(['sql.ro', 'alert']);
    // parent narrowed → child narrowed
    expect(childEffectiveScopes(['sql.ro', 'scratch', 'alert'], ['sql.ro', 'keys.mint'])).toEqual(['sql.ro']);
    expect(childEffectiveScopes(['sql.ro'], [])).toEqual([]);
    // a tampered child row never carries anything past the trio, even if the parent holds it
    const everything = Object.keys(KEY_SCOPES);
    expect(childEffectiveScopes(everything, everything)).toEqual(['sql.ro', 'scratch', 'alert']);
    // JSON strings parse the same as arrays (mysql2 / scripted)
    expect(childEffectiveScopes('["scratch","temp.clio"]', '["scratch","temp.clio","keys.mint"]')).toEqual(['scratch']);
  });

  test('a NULL or malformed child column → [] (a child never gets the legacy surface)', () => {
    expect(childEffectiveScopes(null, ['sql.ro', 'scratch', 'alert'])).toEqual([]);
    expect(childEffectiveScopes(undefined, null)).toEqual([]);
    expect(childEffectiveScopes('not json', ['sql.ro'])).toEqual([]);
    // a legacy NULL parent counts as the legacy surface (the trio is non-explicit)
    expect(childEffectiveScopes(['sql.ro', 'scratch'], null)).toEqual(['sql.ro', 'scratch']);
    // a malformed parent column is closed
    expect(childEffectiveScopes(['sql.ro'], 'garbage')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth cascade (lib/auth.readonly) over a scripted row
// ─────────────────────────────────────────────────────────────────────────────

describe('readonlyApiKeyAuth — the cascade', () => {
  function authDb(row) {
    const calls = [];
    return {
      calls,
      query: async (sql, params) => {
        const s = String(sql);
        calls.push({ sql: s, params });
        if (/FROM readonly_api_keys k/.test(s)) return [row ? [row] : []];
        if (/UPDATE readonly_api_keys/.test(s)) return [{}];
        if (/admin_audit_log/.test(s)) return [{}];
        throw new Error('unscripted: ' + s);
      },
    };
  }
  function run(row) {
    const db = authDb(row);
    const req = { headers: { 'x-readonly-api-key': 'ycro_child' }, db, originalUrl: '/api/scratch/x/y', method: 'PUT', socket: {} };
    return new Promise((resolve) => {
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; resolve({ passed: false, req, res: this, db }); return this; } };
      readonlyApiKeyAuth(req, res, () => resolve({ passed: true, req, res, db }));
    });
  }
  const live = (o = {}) => ({
    id: 201, label: 'worker', expires_at: new Date(Date.now() + HOUR), revoked_at: null,
    scopes: ['sql.ro', 'scratch'], parent_key_id: 200,
    parent_id: 200, parent_expires_at: new Date(Date.now() + 2 * HOUR), parent_revoked_at: null,
    parent_scopes: ['sql.ro', 'scratch', 'alert', 'keys.mint'], ...o,
  });
  const audits = (db) => db.calls.filter(c => /admin_audit_log/.test(c.sql)).map(c => ({ status: c.params[5], details: JSON.parse(c.params[10]) }));
  const writes = (db) => db.calls.filter(c => /UPDATE readonly_api_keys/.test(c.sql));

  test('the SELECT reads the parent in the same statement', async () => {
    const r = await run(live());
    expect(r.db.calls[0].sql).toMatch(/LEFT JOIN readonly_api_keys p ON p\.id = k\.parent_key_id/);
    expect(r.db.calls[0].params).toEqual([hashKey('ycro_child')]);
  });

  test('a live child passes with its EFFECTIVE scopes, parentKeyId and rootKeyId', async () => {
    const r = await run(live({ parent_scopes: ['sql.ro', 'keys.mint'] }));
    expect(r.passed).toBe(true);
    expect(r.req.auth).toMatchObject({ keyId: 201, scopes: ['sql.ro'], parentKeyId: 200, rootKeyId: 200 });
    expect(r.req.auth.expiresAt).toBeInstanceOf(Date);
  });

  test('a root key: parentKeyId null, rootKeyId its own id, its own scopes', async () => {
    const r = await run({ id: 200, label: 'mgr', expires_at: new Date(Date.now() + HOUR), revoked_at: null,
      scopes: ['sql.ro', 'keys.mint'], parent_key_id: null, parent_id: null });
    expect(r.passed).toBe(true);
    expect(r.req.auth).toMatchObject({ keyId: 200, scopes: ['sql.ro', 'keys.mint'], parentKeyId: null, rootKeyId: 200 });
  });

  for (const [name, row, status, msg] of [
    ['parent revoked', live({ parent_revoked_at: new Date() }), 'rejected_parent_revoked', /parent key revoked/],
    ['parent row missing', live({ parent_id: null, parent_expires_at: null, parent_scopes: null }), 'rejected_parent_revoked', /parent key revoked/],
    ['parent expired', live({ parent_expires_at: new Date(Date.now() - 1000) }), 'rejected_parent_expired', /parent key expired/],
  ]) {
    test(`${name} → 401 ${status}, audited, nothing written to the child's row`, async () => {
      const r = await run(row);
      expect(r.passed).toBe(false);
      expect(r.res.statusCode).toBe(401);
      expect(r.res.body.error).toMatch(msg);
      await flush();
      expect(audits(r.db)).toEqual([{ status, details: { keyId: 201, parentKeyId: 200 } }]);
      expect(writes(r.db)).toEqual([]);
    });
  }

  test("the child's own revocation / expiry still win first", async () => {
    let r = await run(live({ revoked_at: new Date(), parent_revoked_at: new Date() }));
    expect(audits(r.db)[0].status).toBe('rejected_revoked');
    r = await run(live({ expires_at: new Date(Date.now() - 1000), parent_expires_at: new Date(Date.now() - 1000) }));
    expect(audits(r.db)[0].status).toBe('rejected_expired');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP: route ordering, the 400s, the belt
// ─────────────────────────────────────────────────────────────────────────────

const MGR_RAW = 'ycro_mgrfixture_20991231T0000Z';
const CHILD_RAW = 'ycro_kidfixture_20991231T0000Z';
const suToken = () => jwt.sign({ sub: 6, username: 'IT', user_type: 1, user_auth: 'authorized', roles: ['su'], aud: 'staff' },
  process.env.JWT_SECRET, { expiresIn: '5m' });

function keysDb({ mgr } = {}) {
  const calls = [];
  const manager = {
    id: 50, label: 'mgr', expires_at: new Date(Date.now() + 2 * HOUR), revoked_at: null,
    scopes: ['sql.ro', 'scratch', 'keys.mint'], parent_key_id: null, parent_id: null, ...mgr,
  };
  const rows = { [hashKey(MGR_RAW)]: manager };
  return {
    calls,
    getConnection: jest.fn(async () => { throw new Error('no transaction expected'); }),
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/FROM readonly_api_keys k LEFT JOIN readonly_api_keys p ON p\.id = k\.parent_key_id WHERE k\.key_hash/.test(s)) {
        return [rows[params[0]] ? [rows[params[0]]] : []];
      }
      if (/^UPDATE readonly_api_keys SET last_used_at/.test(s)) return [{}];
      if (/admin_audit_log|jwt_api_audit_log/.test(s)) return [{ insertId: 1 }];
      if (/WHERE parent_key_id = \? ORDER BY id DESC/.test(s)) return [[{ id: 51, label: 'child-list-marker' }]];
      if (/^UPDATE readonly_api_keys SET revoked_at = NOW\(\) WHERE id = \? AND parent_key_id = \?/.test(s)) return [{ affectedRows: 0 }];
      if (/^UPDATE readonly_api_keys SET revoked_at = NOW\(\) WHERE id = \? AND revoked_at IS NULL/.test(s)) return [{ affectedRows: 1 }];
      if (/FROM readonly_api_query_log|FROM readonly_query_log/.test(s)) return [[{ id: 1, sql_text: 'su-log-marker' }]];
      if (/FROM readonly_api_keys k LEFT JOIN users/.test(s)) return [[{ id: 50, label: 'su-list-marker' }]];
      throw new Error('unscripted: ' + s);
    },
  };
}

async function serve(db, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use(keysRouter);
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise(r => server.close(r)); }
}
async function hit(base, method, path, { key, su, body } = {}) {
  const headers = {};
  if (key) headers['x-readonly-api-key'] = key;
  if (su) { headers.authorization = 'Bearer ' + suToken(); headers['x-su-elevation'] = mintElevationToken(6); }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

describe('route ordering: /children vs the SU /:id routes', () => {
  test('registration order: the three /children routes come before /:id and /:id/log', () => {
    const paths = keysRouter.stack.filter(l => l.route).map(l => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
    const at = (p) => paths.indexOf(p);
    for (const c of ['POST /api/readonly-keys/children', 'GET /api/readonly-keys/children', 'DELETE /api/readonly-keys/children/:id']) {
      expect(at(c)).toBeGreaterThanOrEqual(0);
      expect(at(c)).toBeLessThan(at('DELETE /api/readonly-keys/:id'));
      expect(at(c)).toBeLessThan(at('GET /api/readonly-keys/:id/log'));
    }
  });

  test('a manager key reaches the child handlers; an SU JWT reaches the SU handlers', async () => {
    const db = keysDb();
    await serve(db, async (base) => {
      // child list — not swallowed by the SU list or /:id/log
      let r = await hit(base, 'GET', '/api/readonly-keys/children', { key: MGR_RAW });
      expect(r).toEqual({ status: 200, body: { ok: true, children: [{ id: 51, label: 'child-list-marker' }] } });
      // child revoke of id 5 — the CHILD statement (keyed on parent), not the SU revoke
      r = await hit(base, 'DELETE', '/api/readonly-keys/children/5', { key: MGR_RAW });
      expect(r.status).toBe(404);
      expect(db.calls.some(c => /WHERE id = \? AND parent_key_id = \?/.test(c.sql) && c.params[0] === 5 && c.params[1] === 50)).toBe(true);
      expect(db.calls.some(c => /WHERE id = \? AND revoked_at IS NULL/.test(c.sql))).toBe(false);
      // SU revoke + SU log still reach theirs
      r = await hit(base, 'DELETE', '/api/readonly-keys/5', { su: true });
      expect(r).toEqual({ status: 200, body: { ok: true } });
      r = await hit(base, 'GET', '/api/readonly-keys/5/log', { su: true });
      expect(r.status).toBe(200);
      expect(r.body.log).toEqual([{ id: 1, sql_text: 'su-log-marker' }]);
      r = await hit(base, 'GET', '/api/readonly-keys', { su: true });
      expect(r.body.keys).toEqual([{ id: 50, label: 'su-list-marker' }]);
    });
  });

  test('crossed credentials go nowhere: an SU JWT on /children is a key-auth 401; a key on /:id is the SU gate', async () => {
    const db = keysDb();
    await serve(db, async (base) => {
      let r = await hit(base, 'GET', '/api/readonly-keys/children', { su: true });
      expect(r.status).toBe(401);
      expect(r.body.error).toMatch(/Readonly API key required/);
      r = await hit(base, 'POST', '/api/readonly-keys/children', { su: true, body: { label: 'x' } });
      expect(r.status).toBe(401);
      // DELETE /children (no id) is the SU /:id route with id "children" — a key never authenticates there
      r = await hit(base, 'DELETE', '/api/readonly-keys/children', { key: MGR_RAW });
      expect(r.status).toBe(401);
      expect(r.body.error).not.toMatch(/Readonly API key/);
      r = await hit(base, 'GET', '/api/readonly-keys/children/log', { key: MGR_RAW });
      expect(r.status).toBe(401);
      expect(r.body.error).not.toMatch(/Readonly API key/);
      expect(db.calls.some(c => /SET revoked_at/.test(c.sql))).toBe(false);
    });
  });
});

describe('POST /children — every 400 is decided before a transaction opens', () => {
  const cases = [
    [{ scopes: ['keys.mint'] }, /not delegable: keys\.mint/, ['keys.mint']],
    [{ scopes: ['sql.ro', 'sql.ro.sensitive'] }, /not delegable: sql\.ro\.sensitive/, ['sql.ro.sensitive']],
    [{ scopes: ['temp.clio'] }, /not delegable: temp\.clio/, ['temp.clio']],
    [{ scopes: ['route:/process-jobs', 'firm.settings'] }, /not delegable: route:\/process-jobs, firm\.settings/, ['route:/process-jobs', 'firm.settings']],
    [{ scopes: ['sql.ro', 'alert'] }, /not delegable: alert/, ['alert']],            // in the trio, not in the parent
    [{ scopes: [] }, /non-empty array/],
    [{ scopes: 'sql.ro' }, /non-empty array/],
    [{ scopes: ['sql.rw'] }, /unknown scope/],
    [{ ttlMinutes: 1441 }, /at most 1440 minutes/],
    [{ ttlMinutes: 121 }, /cannot outlive its parent/],                              // parent has ~2h
    [{ ttlMinutes: 0 }, /positive whole number/],
    [{ ttlMinutes: 1.5 }, /positive whole number/],
    [{ ttlMinutes: 'soon' }, /positive whole number/],
    [{ label: '' }, /label is required/],
  ];
  for (const [patch, msg, offending] of cases) {
    test(`${JSON.stringify(patch)} → 400 ${msg}`, async () => {
      const db = keysDb();
      await serve(db, async (base) => {
        const r = await hit(base, 'POST', '/api/readonly-keys/children', { key: MGR_RAW, body: { label: 'w', ...patch } });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(msg);
        if (offending) expect(r.body.offendingScopes).toEqual(offending);
      });
      expect(db.getConnection).not.toHaveBeenCalled();
      expect(db.calls.some(c => /INSERT INTO readonly_api_keys/.test(c.sql))).toBe(false);
    });
  }

  test('scopes omitted and the parent holds none of the trio → 400, not an empty key', async () => {
    const db = keysDb({ mgr: { scopes: ['keys.mint', 'temp.clio'] } });
    await serve(db, async (base) => {
      const r = await hit(base, 'POST', '/api/readonly-keys/children', { key: MGR_RAW, body: { label: 'w' } });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/holds none of sql\.ro, scratch, alert/);
    });
    expect(db.getConnection).not.toHaveBeenCalled();
  });

  test('a key without keys.mint (legacy NULL, or the default trio) is a 403 naming it', async () => {
    for (const scopes of [null, ['sql.ro', 'scratch', 'alert']]) {
      const db = keysDb({ mgr: { scopes } });
      await serve(db, async (base) => {
        for (const [m, p] of [['POST', '/api/readonly-keys/children'], ['GET', '/api/readonly-keys/children'], ['DELETE', '/api/readonly-keys/children/9']]) {
          const r = await hit(base, m, p, { key: MGR_RAW, body: m === 'POST' ? { label: 'w' } : undefined });
          expect([m, r.status, r.body.missingScope]).toEqual([m, 403, 'keys.mint']);
        }
      });
    }
  });
});

describe('the child-caller belt (unreachable through the scope gate — driven on the handler)', () => {
  const handlerOf = (method, path) => {
    const l = keysRouter.stack.find(x => x.route && x.route.path === path && x.route.methods[method]);
    return l.route.stack[l.route.stack.length - 1].handle;
  };
  for (const [method, path] of [['post', '/api/readonly-keys/children'], ['get', '/api/readonly-keys/children'], ['delete', '/api/readonly-keys/children/:id']]) {
    test(`${method.toUpperCase()} ${path}: a caller with parentKeyId → 403, no DB touched`, async () => {
      const db = { query: jest.fn(), getConnection: jest.fn() };
      const req = { auth: { keyId: 201, parentKeyId: 200, scopes: ['sql.ro', 'keys.mint'], expiresAt: new Date(Date.now() + HOUR) },
        body: { label: 'x' }, params: { id: '3' }, db, headers: {}, socket: {}, method: method.toUpperCase(), originalUrl: path };
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await handlerOf(method, path)(req, res);
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toMatch(/child key cannot manage keys/);
      expect(db.query).not.toHaveBeenCalled();
      expect(db.getConnection).not.toHaveBeenCalled();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// IT alerts: one budget per ROOT key
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/alert/it — a parent and its children share one budget', () => {
  const KEYS = {
    ycro_root: { id: 300, parent_key_id: null, scopes: ['alert', 'keys.mint'] },
    ycro_kidA: { id: 301, parent_key_id: 300, parent_id: 300, parent_scopes: ['alert', 'keys.mint'] , scopes: ['alert'] },
    ycro_kidB: { id: 302, parent_key_id: 300, parent_id: 300, parent_scopes: ['alert', 'keys.mint'], scopes: ['alert'] },
    ycro_other: { id: 400, parent_key_id: null, scopes: ['alert'] },
  };
  const byHash = Object.fromEntries(Object.entries(KEYS).map(([raw, r]) => [hashKey(raw), {
    label: raw, expires_at: new Date(Date.now() + HOUR), revoked_at: null,
    parent_expires_at: new Date(Date.now() + 2 * HOUR), parent_revoked_at: null, ...r }]));
  const audits = [];
  const db = {
    query: async (sql, params) => {
      const s = String(sql);
      if (/FROM readonly_api_keys k/.test(s)) return [byHash[params[0]] ? [byHash[params[0]]] : []];
      if (/UPDATE readonly_api_keys/.test(s)) return [{}];
      if (/INSERT INTO admin_audit_log/.test(s)) { audits.push(params); return [{}]; }
      if (/FROM app_settings/.test(s)) return [params[0] === 'alert_from_email' ? [{ value: 'alerts@4lsg.com' }] : []];
      throw new Error('unscripted: ' + s);
    },
  };
  let server, base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.db = db; next(); });
    app.use(alertRouter);
    server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(r => server.close(r)));
  beforeEach(() => alertRouter._test.resetRateLimit());
  const send = (key) => fetch(`${base}/api/alert/it`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-readonly-api-key': key },
    body: JSON.stringify({ subject: 's', message: 'm' }) });

  test('root 4 + child A 3 + child B 3 = 10; the 11th from any of them → 429; another root is untouched', async () => {
    const plan = [...Array(4).fill('ycro_root'), ...Array(3).fill('ycro_kidA'), ...Array(3).fill('ycro_kidB')];
    for (const k of plan) expect([k, (await send(k)).status]).toEqual([k, 200]);
    for (const k of ['ycro_root', 'ycro_kidA', 'ycro_kidB']) {
      const r = await send(k);
      expect([k, r.status]).toEqual([k, 429]);
      const body = await r.json();
      expect(body.error).toMatch(/10 IT alerts per hour per key — a child key shares its parent's budget/);
    }
    expect((await send('ycro_other')).status).toBe(200);
    const limited = audits.filter(p => p[5] === 'rejected_rate_limit').map(p => JSON.parse(p[10]));
    expect(limited.map(d => [d.keyId, d.rootKeyId])).toEqual([[300, 300], [301, 300], [302, 300]]);
  });
});
