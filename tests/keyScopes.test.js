// tests/keyScopes.test.js
//
/**
 * Key scopes — access-control B1 (lib/capabilities.js KEY_SCOPES / keyAllows,
 * lib/auth.readonly.js requireKeyScope, lib/apiKeys.js + lib/auth.jwtOrApiKey
 * attach, routes/api.readonlyKeys.js mints; ACCESS_CONTROL_DESIGN §5.2).
 *
 * WHAT IS LOCKED
 *   - The SURFACE vocabulary: an exact snapshot (the deliberate-choice gate,
 *     like CAPABILITIES). The route:/ and capability families are grammar-
 *     validated (mints accept them) but not enforced in B1.
 *   - keyAllows: scopes NULL/absent → legacy true; array → membership;
 *     malformed → false; a malformed scope NAME throws.
 *   - EVERY route mounting readonlyApiKeyAuth mounts requireKeyScope right
 *     after it, with the surface pinned per file — a new mount without one
 *     fails here, so a temp route cannot ride in silently (§5.1).
 *   - Per-route surface matrix, driven through each REAL router's own first
 *     two layers (auth, scope — never the handler, so no temp route makes a
 *     provider call): a ["sql.ro"] key passes sql and gets a 403 NAMING the
 *     missing scope everywhere else; a NULL-scopes key passes all 13 mounts.
 *   - Mints: default ["sql.ro","scratch","alert"] (no temp.*), custom lists
 *     validated and stored, invalid / empty refused with nothing inserted;
 *     the list endpoint surfaces scopes.
 *   - yck_: scopes ATTACHED (lookup + its cache, jwtOrApiKey → req.auth) but
 *     NOT enforced — a scoped yck_ key still passes jwtOrApiKey and a
 *     can-gated requireAuth({allowApiKey}) route in B1. B2 flips these.
 *
 * HARNESS: the real modules over scripted dbs; express in-process for the
 * HTTP cases. Nothing is mocked.
 *
 * Run: npx jest tests/keyScopes.test.js
 */
'use strict';

process.env.JWT_SECRET = 'key-scopes-b1-test-secret';
process.env.SU_RATE_LIMIT_READONLYKEYS = '10000';

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

const caps = require('../lib/capabilities');
const { KEY_SCOPES, isKeyScope, normalizeKeyScopes, scopesFromColumn, keyAllows } = caps;
const { readonlyApiKeyAuth, requireKeyScope, hashKey } = require('../lib/auth.readonly');
const { mintElevationToken } = require('../lib/auth.superuser');

const ROOT = path.join(__dirname, '..');
const flush = () => new Promise(r => setImmediate(r));

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary + predicate
// ─────────────────────────────────────────────────────────────────────────────

describe('KEY_SCOPES vocabulary', () => {
  test('the surface family is exactly the reviewed snapshot', () => {
    expect(Object.keys(KEY_SCOPES)).toEqual([
      'sql.ro', 'sql.ro.sensitive', 'scratch', 'alert', 'temp.clio', 'temp.dropbox', 'temp.ringcentral', 'temp.zohosign',
    ]);
    expect(Object.isFrozen(KEY_SCOPES)).toBe(true);
    for (const v of Object.values(KEY_SCOPES)) expect(v.desc).toMatch(/\S/);
  });

  test('grammar: surface, route:/<path>, capability names', () => {
    for (const s of ['sql.ro', 'temp.zohosign', 'route:/process-jobs', 'route:/mailbox-ingest',
                     'route:/api/a_b-c.d~e', 'firm.settings', 'tools.author']) {
      expect(isKeyScope(s)).toBe(true);
    }
    for (const s of ['', 'sql', 'SQL.RO', 'temp.*', 'route:', 'route:/', 'route://x', 'route:/a/../b',
                     'route:process-jobs', 'route:/a b', 'firm.setting', 'toString', '__proto__', null, 7, ['sql.ro']]) {
      expect(isKeyScope(s)).toBe(false);
    }
  });

  test('normalizeKeyScopes: non-empty array of well-formed scopes, de-duplicated; else throws', () => {
    expect(normalizeKeyScopes(['sql.ro', 'temp.clio', 'sql.ro'])).toEqual(['sql.ro', 'temp.clio']);
    expect(normalizeKeyScopes(['route:/process-jobs', 'firm.settings'])).toEqual(['route:/process-jobs', 'firm.settings']);
    expect(() => normalizeKeyScopes([])).toThrow(/non-empty array/);
    expect(() => normalizeKeyScopes('sql.ro')).toThrow(/non-empty array/);
    expect(() => normalizeKeyScopes(null)).toThrow(/non-empty array/);
    expect(() => normalizeKeyScopes(['sql.ro', 'sql.rw'])).toThrow(/unknown scope\(s\): "sql\.rw"/);
  });

  test('scopesFromColumn: NULL → null (legacy); arrays/strings parsed; malformed → [] (closed)', () => {
    expect(scopesFromColumn(null)).toBeNull();
    expect(scopesFromColumn(undefined)).toBeNull();
    expect(scopesFromColumn(['sql.ro'])).toEqual(['sql.ro']);
    expect(scopesFromColumn('["scratch","alert"]')).toEqual(['scratch', 'alert']);
    expect(scopesFromColumn('not json')).toEqual([]);
    expect(scopesFromColumn({ 'sql.ro': true })).toEqual([]);
    expect(scopesFromColumn('"sql.ro"')).toEqual([]);
    expect(scopesFromColumn(['sql.ro', 5])).toEqual(['sql.ro']);
  });
});

describe('keyAllows', () => {
  test('scopes NULL / absent → legacy full surface — minus the explicit scopes', () => {
    for (const s of Object.keys(KEY_SCOPES)) {
      const want = !KEY_SCOPES[s].explicit;
      expect([s, keyAllows({ type: 'readonly_apikey', scopes: null }, s)]).toEqual([s, want]);
      expect([s, keyAllows({ type: 'readonly_apikey' }, s)]).toEqual([s, want]);
    }
    // SEC-3: the one explicit scope today — a legacy key never gained the sensitive tables
    expect(Object.keys(KEY_SCOPES).filter(s => KEY_SCOPES[s].explicit)).toEqual(['sql.ro.sensitive']);
    expect(keyAllows({ scopes: ['sql.ro', 'sql.ro.sensitive'] }, 'sql.ro.sensitive')).toBe(true);
  });

  test('scoped: membership only', () => {
    const a = { type: 'readonly_apikey', scopes: ['sql.ro', 'alert'] };
    expect(keyAllows(a, 'sql.ro')).toBe(true);
    expect(keyAllows(a, 'alert')).toBe(true);
    expect(keyAllows(a, 'scratch')).toBe(false);
    expect(keyAllows(a, 'temp.clio')).toBe(false);
    expect(keyAllows({ scopes: [] }, 'sql.ro')).toBe(false);
  });

  test('malformed scopes on the auth fail closed; no auth is false', () => {
    expect(keyAllows({ scopes: 'sql.ro' }, 'sql.ro')).toBe(false);
    expect(keyAllows({ scopes: { 'sql.ro': 1 } }, 'sql.ro')).toBe(false);
    expect(keyAllows(null, 'sql.ro')).toBe(false);
    expect(keyAllows(undefined, 'sql.ro')).toBe(false);
  });

  test('an unknown scope name THROWS — even for a legacy key', () => {
    expect(() => keyAllows({ scopes: null }, 'sql.rw')).toThrow(/unknown scope "sql\.rw"/);
    expect(() => keyAllows({ scopes: ['x'] }, 'x')).toThrow(/unknown scope/);
    expect(() => keyAllows(null, undefined)).toThrow(/unknown scope/);
  });

  test('requireKeyScope accepts SURFACE scopes only, at mount', () => {
    expect(typeof requireKeyScope('scratch')).toBe('function');
    expect(() => requireKeyScope('route:/process-jobs')).toThrow(/unknown surface scope/);
    expect(() => requireKeyScope('firm.settings')).toThrow(/unknown surface scope/);
    expect(() => requireKeyScope('sql')).toThrow(/unknown surface scope/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Every readonlyApiKeyAuth mount declares its surface
// ─────────────────────────────────────────────────────────────────────────────

const SURFACE_BY_FILE = {
  'api.readonly.js': 'sql.ro',
  'api.scratch.js': 'scratch',
  'api.alertIt.js': 'alert',
  'api.temp.clio.js': 'temp.clio',
  'api.temp.dropbox.js': 'temp.dropbox',
  'api.temp.ringcentral.js': 'temp.ringcentral',
  'api.temp.zohosign.js': 'temp.zohosign',
};

/** Every route layer in routes/ whose first handler is readonlyApiKeyAuth. */
function readonlyMounts() {
  const out = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes')).filter(n => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ROOT, 'routes', f), 'utf8');
    if (!/readonlyApiKeyAuth/.test(src)) continue;
    const router = require(path.join(ROOT, 'routes', f));
    for (const l of router.stack || []) {
      if (!l.route) continue;
      const hs = l.route.stack.map(s => s.handle);
      if (hs[0] === readonlyApiKeyAuth) {
        out.push({ file: f, method: Object.keys(l.route.methods)[0], path: l.route.path, auth: hs[0], gate: hs[1] });
      }
    }
  }
  return out;
}

describe('every readonly-key mount declares its surface', () => {
  const mounts = readonlyMounts();

  test('the inventory: 13 mounts across the 7 files', () => {
    expect(mounts).toHaveLength(13);
    expect([...new Set(mounts.map(m => m.file))].sort()).toEqual(Object.keys(SURFACE_BY_FILE).sort());
  });

  test('no file mounts readonlyApiKeyAuth without requireKeyScope right after it (source scan)', () => {
    for (const f of fs.readdirSync(path.join(ROOT, 'routes')).filter(n => n.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(ROOT, 'routes', f), 'utf8');
      const bare = src.split('\n').filter(l => /readonlyApiKeyAuth\s*[,)]/.test(l) && !/require\(/.test(l)
        && !/readonlyApiKeyAuth,\s*requireKeyScope\(/.test(l) && !/^\s*(\/\/|\*)/.test(l));
      expect({ f, bare }).toEqual({ f, bare: [] });
    }
  });

  test('every mount gates on keyScopeCheck', () => {
    for (const m of mounts) expect(m.gate && m.gate.name).toBe('keyScopeCheck');
  });

  // Drive auth → gate on the REAL layers; stop at the handler.
  function keyDb(scopes) {
    const audits = [];
    return {
      audits,
      query: async (sql, params) => {
        const s = String(sql);
        if (/FROM readonly_api_keys/.test(s)) {
          return [[{ id: 70, label: 'k', expires_at: new Date(Date.now() + 3600e3), revoked_at: null, scopes }]];
        }
        if (/UPDATE readonly_api_keys/.test(s)) return [{}];
        if (/admin_audit_log/.test(s)) { audits.push(params); return [{ insertId: 1 }]; }
        throw new Error('unscripted: ' + s);
      },
    };
  }
  async function throughGate(m, scopes) {
    const db = keyDb(scopes);
    const req = { headers: { 'x-readonly-api-key': 'ycro_abc' }, db, originalUrl: m.path, method: m.method.toUpperCase(), socket: {} };
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let passed = false;
    await m.auth(req, res, async () => { await m.gate(req, res, () => { passed = true; }); });
    await flush();
    return { passed, res, req, db };
  }

  test('a NULL-scopes (legacy) key passes all 13 gates', async () => {
    for (const m of mounts) {
      const r = await throughGate(m, null);
      expect({ at: `${m.method} ${m.path}`, passed: r.passed }).toEqual({ at: `${m.method} ${m.path}`, passed: true });
      expect(r.req.auth.scopes).toBeNull();
    }
  });

  test('a ["sql.ro"] key passes sql only; 403 NAMING the missing scope everywhere else, audited', async () => {
    for (const m of mounts) {
      const want = SURFACE_BY_FILE[m.file];
      const r = await throughGate(m, ['sql.ro']);
      if (want === 'sql.ro') { expect(r.passed).toBe(true); continue; }
      expect(r.passed).toBe(false);
      expect(r.res.statusCode).toBe(403);
      expect(r.res.body).toEqual({ error: `Readonly API key lacks the '${want}' scope`, missingScope: want, keyScopes: ['sql.ro'] });
      const statuses = r.db.audits.map(p => JSON.stringify(p));
      expect(statuses.some(s => s.includes('rejected_scope') && s.includes(want))).toBe(true);
    }
  });

  test('each mount checks exactly its file\'s surface (the key holding only that one passes)', async () => {
    for (const m of mounts) {
      const want = SURFACE_BY_FILE[m.file];
      expect((await throughGate(m, [want])).passed).toBe(true);
      const others = Object.keys(KEY_SCOPES).filter(s => s !== want);
      expect((await throughGate(m, others)).passed).toBe(false);
    }
  });

  test('the default mint trio reaches sql, scratch and alert — and no temp route', async () => {
    for (const m of mounts) {
      const r = await throughGate(m, ['sql.ro', 'scratch', 'alert']);
      expect(r.passed).toBe(!SURFACE_BY_FILE[m.file].startsWith('temp.'));
    }
  });

  test('the scopes column arrives as a JSON string too (parsed the same)', async () => {
    const scratch = mounts.find(m => m.file === 'api.scratch.js');
    expect((await throughGate(scratch, '["scratch"]')).passed).toBe(true);
    expect((await throughGate(scratch, '["sql.ro"]')).passed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mints (routes/api.readonlyKeys.js)
// ─────────────────────────────────────────────────────────────────────────────

describe('readonly key mints', () => {
  const router = require('../routes/api.readonlyKeys');

  function call(method, urlPath, body) {
    const calls = [];
    const db = {
      calls,
      query: async (sql, params = []) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        calls.push({ sql: s, params });
        if (/admin_audit_log|jwt_api_audit_log/.test(s)) return [{ insertId: 1 }];
        if (/^INSERT INTO readonly_api_keys/.test(s)) return [{ insertId: 88 }];
        if (/FROM readonly_api_keys k/.test(s)) return [[{ id: 75, label: 'claude long key', scopes: null }, { id: 88, label: 'new', scopes: ['sql.ro'] }]];
        throw new Error('unscripted: ' + s);
      },
    };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.db = db; next(); });
    app.use(router);
    const token = jwt.sign({ sub: 6, username: 'IT', user_type: 1, user_auth: 'authorized', roles: ['su'], aud: 'staff' },
      process.env.JWT_SECRET, { expiresIn: '5m' });
    return new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
          port: server.address().port, path: urlPath, method,
          headers: Object.assign({ authorization: 'Bearer ' + token, 'x-su-elevation': mintElevationToken(6) },
            payload ? { 'content-type': 'application/json' } : {}),
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
  const insert = db => db.calls.find(c => /^INSERT INTO readonly_api_keys/.test(c.sql));

  test('default mint: ["sql.ro","scratch","alert"] — no temp.* — stored and returned', async () => {
    const r = await call('POST', '/api/readonly-keys', { label: 'session' });
    expect(r.status).toBe(200);
    expect(r.body.scopes).toEqual(['sql.ro', 'scratch', 'alert']);
    expect(insert(r.db).sql).toMatch(/ip_allowlist, scopes\)/);
    expect(JSON.parse(insert(r.db).params[6])).toEqual(['sql.ro', 'scratch', 'alert']);
    expect(router.DEFAULT_SCOPES).toEqual(['sql.ro', 'scratch', 'alert']);
  });

  test('custom scopes are validated, de-duplicated, stored and returned', async () => {
    const r = await call('POST', '/api/readonly-keys', { label: 'clio work', scopes: ['sql.ro', 'temp.clio', 'sql.ro'] });
    expect(r.status).toBe(200);
    expect(r.body.scopes).toEqual(['sql.ro', 'temp.clio']);
    expect(JSON.parse(insert(r.db).params[6])).toEqual(['sql.ro', 'temp.clio']);
  });

  test('route:/ and capability scopes are mintable now (B2 enforces them)', async () => {
    const r = await call('POST', '/api/readonly-keys', { label: 'b2-ready', scopes: ['sql.ro', 'route:/process-jobs', 'firm.settings'] });
    expect(r.status).toBe(200);
    expect(r.body.scopes).toEqual(['sql.ro', 'route:/process-jobs', 'firm.settings']);
  });

  test('an unknown scope, an empty list or a non-array → 400, nothing inserted', async () => {
    for (const scopes of [['sql.ro', 'temp.gmail'], [], 'sql.ro', null]) {
      const r = await call('POST', '/api/readonly-keys', { label: 'x', scopes });
      expect(r.status).toBe(400);
      expect(insert(r.db)).toBeUndefined();
    }
  });

  test('the audit row records the scopes', async () => {
    const r = await call('POST', '/api/readonly-keys', { label: 'audited', scopes: ['scratch'] });
    await flush();
    const audit = r.db.calls.find(c => /admin_audit_log/.test(c.sql) && c.params.some(p => String(p).includes('"scopes"')));
    expect(audit).toBeDefined();
    expect(audit.params.find(p => String(p).includes('"scopes"'))).toContain('["scratch"]');
  });

  test('the SU list surfaces scopes (NULL = legacy)', async () => {
    const r = await call('GET', '/api/readonly-keys');
    expect(r.status).toBe(200);
    expect(r.db.calls.find(c => /FROM readonly_api_keys k/.test(c.sql)).sql).toMatch(/k\.scopes/);
    expect(r.body.keys.map(k => k.scopes)).toEqual([null, ['sql.ro']]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// yck_ — attached, NOT enforced (B2 flips these deliberately)
// ─────────────────────────────────────────────────────────────────────────────

describe('yck_ keys: scopes attached (B1), ENFORCED since B2', () => {
  const apiKeys = require('../lib/apiKeys');
  const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
  const requireAuth = require('../lib/auth.requireAuth');

  const RAW = 'yck_' + 'b1'.repeat(32);
  function keyDb(scopes) {
    const calls = [];
    return {
      calls,
      query: async (sql, params) => {
        const s = String(sql);
        calls.push(s);
        if (/FROM api_keys WHERE key_hash/.test(s)) {
          expect(params[0]).toBe(apiKeys.hashKey(RAW));
          return [[{ id: 3, label: 'scheduler', revoked_at: null, scopes }]];
        }
        if (/UPDATE api_keys SET last_used_at/.test(s) || /jwt_api_audit_log/.test(s)) return [{}];
        throw new Error('unscripted: ' + s);
      },
    };
  }
  const run = (mw, req) => new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; resolve({ via: 'res', status: this.statusCode, body: b }); return this; } };
    mw(req, res, () => resolve({ via: 'next' }));
  });
  const baseReq = (db) => ({ headers: { 'x-api-key': RAW }, db, originalUrl: '/api/x', method: 'POST', socket: {} });

  beforeEach(() => apiKeys.invalidateCache && apiKeys.invalidateCache());

  test('lookup carries scopes, and the cached record does too (one SELECT)', async () => {
    const db = keyDb(['route:/process-jobs']);
    expect(await apiKeys.lookup(db, RAW)).toEqual({ id: 3, label: 'scheduler', scopes: ['route:/process-jobs'] });
    expect(await apiKeys.lookup(db, RAW)).toEqual({ id: 3, label: 'scheduler', scopes: ['route:/process-jobs'] });
    expect(db.calls.filter(s => /FROM api_keys WHERE key_hash/.test(s))).toHaveLength(1);
  });

  test('a NULL-scopes yck_ key attaches scopes: null (legacy)', async () => {
    const req = baseReq(keyDb(null));
    expect(await run(jwtOrApiKey, req)).toEqual({ via: 'next' });
    expect(req.auth).toMatchObject({ type: 'api_key', key_id: 3, scopes: null });
  });

  // B1 pinned "a scoped yck_ key still passes"; B2 flips it on purpose
  // (route scopes in jwtOrApiKey; capability scopes on can gates). The full
  // matrices are tests/machineKeyScopes.test.js.
  test('B2 FLIP: a scoped yck_ key is refused off its routes (403), passes on them', async () => {
    const off = baseReq(keyDb(['route:/process-jobs']));            // originalUrl /api/x
    expect(await run(jwtOrApiKey, off)).toMatchObject({ via: 'res', status: 403 });
    apiKeys.invalidateCache();
    const on = { ...baseReq(keyDb(['route:/process-jobs'])), originalUrl: '/process-jobs' };
    expect(await run(jwtOrApiKey, on)).toEqual({ via: 'next' });
    expect(on.auth.scopes).toEqual(['route:/process-jobs']);
  });

  test('B2 FLIP: a can-gated allowApiKey route takes a scoped key only with that capability', async () => {
    const mw = requireAuth({ audience: 'staff', can: 'firm.settings', allowApiKey: true });
    expect(await run(mw, baseReq(keyDb(['route:/process-jobs'])))).toMatchObject({ via: 'res', status: 403 });
    apiKeys.invalidateCache();
    expect(await run(mw, baseReq(keyDb(['firm.settings'])))).toEqual({ via: 'next' });
  });
});
