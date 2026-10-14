// tests/secretAtRest.test.js
//
/**
 * Secret values encrypted at rest — access-control B4 (lib/secretAtRest.js;
 * credentials: lib/credentialInjection.buildAuthHeaders, routes/api.oauth.js
 * /reveal, routes/api.credentials.js POST/PUT; hooks: services/hookService
 * authenticateRequest / createHook / updateHook / duplicateHook /
 * withReadableAuth, routes/api.hooks.js display routes).
 *
 * WHAT IS LOCKED (the real-engine migration is secretsAtRest.mysql.test.js)
 *   - The secret-field map: exactly which config keys are secret per type.
 *   - encryptFields is idempotent and touches only the named fields;
 *     decryptFields/readSecret are DUAL-READ (ENCv1 decrypts, plaintext passes)
 *     — both directions of the partial-migration window.
 *   - Credentials: buildAuthHeaders gives identical headers for a plaintext and
 *     an encrypted row (api_key, bearer, basic); a corrupt ciphertext → {} (fails
 *     closed). POST/PUT store every type's secret encrypted, a re-save of an
 *     already-encrypted value is not double-encrypted, and the non-secret keys
 *     stay plaintext. /reveal decrypts what it reveals.
 *   - Hooks: authenticateRequest accepts the right key / HMAC (plain and
 *     Calendly-timestamped) whether stored plaintext or encrypted, refuses the
 *     wrong one, and refuses a corrupt ciphertext (never "no secret").
 *     create/update store ciphertext whatever the auth_type; duplicateHook
 *     copies ciphertext verbatim and the copy still verifies; the two display
 *     routes return plaintext while the service reads stay encrypted.
 *
 * HARNESS: the real modules; scripted dbs; express in-process for routes.
 * CREDENTIALS_ENCRYPTION_KEY is seeded by tests/jest.setup.js.
 *
 * Run: npx jest tests/secretAtRest.test.js
 */
'use strict';

process.env.JWT_SECRET = 'secret-at-rest-b4-test-secret';
process.env.SU_RATE_LIMIT_CONNECTIONS = '10000';

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

const cc = require('../lib/credentialCrypto');
const sar = require('../lib/secretAtRest');
const { buildAuthHeaders } = require('../lib/credentialInjection');
const hookService = require('../services/hookService');
const { mintElevationToken } = require('../lib/auth.superuser');

const SECRET = 'live-secret-' + crypto.randomBytes(8).toString('hex');

// ─────────────────────────────────────────────────────────────────────────────
// The map + the helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('lib/secretAtRest', () => {
  test('the secret-field map is exactly the reviewed one', () => {
    expect(JSON.parse(JSON.stringify(sar.CREDENTIAL_SECRET_FIELDS))).toEqual({
      oauth2: ['client_secret'], api_key: ['key'], bearer: ['token'], basic: ['password'], internal: [],
    });
    expect(JSON.parse(JSON.stringify(sar.HOOK_SECRET_FIELDS))).toEqual({ api_key: ['key'], hmac: ['secret'], none: [] });
    expect(sar.fieldsFor(sar.CREDENTIAL_SECRET_FIELDS, 'nope')).toEqual([]);
    expect(sar.fieldsFor(sar.CREDENTIAL_SECRET_FIELDS, 'constructor')).toEqual([]);
  });

  test('encryptFields: named non-empty plaintext only, a COPY, idempotent', () => {
    const cfg = { key: SECRET, header: 'x-api-key', other: 'keep' };
    const e1 = sar.encryptFields(cfg, ['key']);
    expect(cc.isEncrypted(e1.key)).toBe(true);
    expect(e1.header).toBe('x-api-key');
    expect(e1.other).toBe('keep');
    expect(cfg.key).toBe(SECRET);                         // input untouched
    expect(sar.encryptFields(e1, ['key']).key).toBe(e1.key);   // no double-encrypt
    expect(sar.encryptFields({ key: '' }, ['key']).key).toBe('');
    expect(sar.encryptFields({ key: null }, ['key']).key).toBeNull();
    expect(sar.encryptFields(null, ['key'])).toBeNull();
  });

  test('decryptFields / readSecret are dual-read', () => {
    const enc = cc.encrypt(SECRET);
    expect(sar.readSecret(enc)).toBe(SECRET);
    expect(sar.readSecret(SECRET)).toBe(SECRET);          // pre-migration plaintext
    expect(sar.decryptFields({ key: enc, header: 'h' }, ['key'])).toEqual({ key: SECRET, header: 'h' });
    expect(sar.decryptFields({ key: SECRET, header: 'h' }, ['key'])).toEqual({ key: SECRET, header: 'h' });
    expect(() => sar.readSecret('ENCv1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Credentials — the chokepoint
// ─────────────────────────────────────────────────────────────────────────────

describe('credentialInjection.buildAuthHeaders', () => {
  const URL_ = 'https://api.example.test/v1/x';
  const row = (type, config) => ({ id: 10, type, config, allowed_urls: ['https://api.example.test/*'] });

  const cases = {
    api_key: [{ key: SECRET, header: 'Authorization' }, { Authorization: SECRET }],
    bearer:  [{ token: SECRET }, { Authorization: `Bearer ${SECRET}` }],
    basic:   [{ username: 'u', password: SECRET }, { Authorization: 'Basic ' + Buffer.from(`u:${SECRET}`).toString('base64') }],
  };
  for (const [type, [cfg, want]] of Object.entries(cases)) {
    test(`${type}: plaintext and encrypted rows build the same headers`, () => {
      const enc = sar.encryptFields(cfg, sar.CREDENTIAL_SECRET_FIELDS[type]);
      expect(JSON.stringify(enc)).not.toContain(SECRET);
      expect(buildAuthHeaders(row(type, cfg), URL_)).toEqual(want);
      expect(buildAuthHeaders(row(type, enc), URL_)).toEqual(want);
      expect(buildAuthHeaders(row(type, JSON.stringify(enc)), URL_)).toEqual(want);   // string column
    });
  }

  test('a corrupt ciphertext fails CLOSED ({}), never sends the ENCv1 text', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const bad = { key: 'ENCv1:' + Buffer.alloc(40).toString('base64'), header: 'x-api-key' };
    expect(buildAuthHeaders(row('api_key', bad), URL_)).toEqual({});
    console.error.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Credentials — write path + reveal (real routers, SU harness)
// ─────────────────────────────────────────────────────────────────────────────

function suCall(router, method, urlPath, body, rowsFor) {
  const calls = [];
  const db = {
    calls,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/admin_audit_log|jwt_api_audit_log/.test(s)) return [{ insertId: 1 }];
      const r = rowsFor(s, params);
      if (r !== undefined) return r;
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

describe('credentials write path (routes/api.credentials.js)', () => {
  const router = require('../routes/api.credentials');
  const written = (db, re) => {
    const c = db.calls.find(x => re.test(x.sql));
    if (!c) return null;
    const obj = c.params.find(p => p && typeof p === 'object' && 'config' in p) || c.params[0];
    return JSON.parse(obj.config);
  };

  for (const [type, cfg, field] of [['api_key', { key: SECRET, header: 'x-api-key' }, 'key'],
                                     ['bearer', { token: SECRET }, 'token'],
                                     ['basic', { username: 'u', password: SECRET }, 'password'],
                                     ['oauth2', { client_id: 'cid', client_secret: SECRET }, 'client_secret']]) {
    test(`POST ${type}: ${field} stored encrypted, the rest plaintext`, async () => {
      const r = await suCall(router, 'POST', '/api/credentials', { name: 'n', type, config: cfg },
        (s) => (/^INSERT INTO credentials/.test(s) ? [{ insertId: 50 }] : undefined));
      expect(r.status).toBe(200);
      const stored = written(r.db, /^INSERT INTO credentials/);
      expect(cc.isEncrypted(stored[field])).toBe(true);
      expect(cc.decrypt(stored[field])).toBe(SECRET);
      for (const k of Object.keys(cfg).filter(k => k !== field)) expect(stored[k]).toBe(cfg[k]);
    });
  }

  test('PUT api_key: a new plaintext key is encrypted; an untouched stored ciphertext is kept, not re-encrypted', async () => {
    const existing = { key: cc.encrypt('old-key'), header: 'x-api-key' };
    const rows = (s) => {
      if (/^SELECT id, name, type, config FROM credentials WHERE id = \?/.test(s)) return [[{ id: 10, name: 'Quo', type: 'api_key', config: existing }]];
      if (/^UPDATE credentials SET \?/.test(s)) return [{ affectedRows: 1 }];
      return undefined;
    };
    const r1 = await suCall(router, 'PUT', '/api/credentials/10', { config: { key: SECRET } }, rows);
    expect(r1.status).toBe(200);
    const s1 = written(r1.db, /^UPDATE credentials SET \?/);
    expect(cc.decrypt(s1.key)).toBe(SECRET);
    expect(s1.header).toBe('x-api-key');

    const r2 = await suCall(router, 'PUT', '/api/credentials/10', { config: { header: 'Authorization' } }, rows);
    const s2 = written(r2.db, /^UPDATE credentials SET \?/);
    expect(s2.key).toBe(existing.key);                 // byte-identical ciphertext
    expect(s2.header).toBe('Authorization');
  });

  test('/reveal decrypts api_key / bearer / basic, and passes a pre-migration plaintext through', async () => {
    const oauth = require('../routes/api.oauth');
    const cfgs = {
      api_key: { key: cc.encrypt(SECRET), header: 'h' },
      bearer: { token: cc.encrypt(SECRET) },
      basic: { username: 'u', password: cc.encrypt(SECRET) },
      plain: { key: SECRET, header: 'h' },
    };
    const want = { api_key: { key: SECRET, header: 'h' }, bearer: { token: SECRET }, basic: { username: 'u', password: SECRET }, plain: { key: SECRET, header: 'h' } };
    for (const [label, cfg] of Object.entries(cfgs)) {
      const type = label === 'plain' ? 'api_key' : label;
      const r = await suCall(oauth, 'GET', '/api/credentials/10/reveal', undefined,
        (s) => (/FROM credentials WHERE id = \?/.test(s) ? [[{ id: 10, name: 'x', type, config: cfg, access_token: null, refresh_token: null }]] : undefined));
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).toContain(SECRET);
      for (const [k, v] of Object.entries(want[label])) expect(JSON.stringify(r.body)).toContain(`"${k}":"${v}"`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hooks — the verify chokepoint
// ─────────────────────────────────────────────────────────────────────────────

describe('hookService.authenticateRequest', () => {
  const body = Buffer.from('{"event":"invitee.created"}');
  const hook = (auth_type, cfg) => ({ id: 1, slug: 's', auth_type, auth_config: cfg });

  for (const stored of ['plaintext', 'encrypted']) {
    const wrap = (cfg, f) => (stored === 'encrypted' ? sar.encryptFields(cfg, [f]) : cfg);

    test(`api_key (${stored}): the right key passes, a wrong one fails`, () => {
      const h = hook('api_key', wrap({ key: SECRET, header: 'x-hook-key' }, 'key'));
      expect(hookService.authenticateRequest(h, { headers: { 'x-hook-key': SECRET } })).toEqual({ valid: true });
      expect(hookService.authenticateRequest(h, { headers: { 'x-hook-key': 'nope' } }).valid).toBe(false);
      // never accept the stored ciphertext itself as the key
      if (stored === 'encrypted') {
        expect(hookService.authenticateRequest(h, { headers: { 'x-hook-key': h.auth_config.key } }).valid).toBe(false);
      }
    });

    test(`hmac plain (${stored}): a real signature passes, a wrong one fails`, () => {
      const h = hook('hmac', wrap({ secret: SECRET, header: 'x-signature', algorithm: 'sha256' }, 'secret'));
      const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
      expect(hookService.authenticateRequest(h, { headers: { 'x-signature': sig }, rawBodyBuf: body }).valid).toBe(true);
      expect(hookService.authenticateRequest(h, { headers: { 'x-signature': 'ab' + sig.slice(2) }, rawBodyBuf: body }).valid).toBe(false);
    });

    test(`hmac Calendly-timestamped (${stored}): a real signature passes`, () => {
      const h = hook('hmac', wrap({ secret: SECRET, header: 'Calendly-Webhook-Signature', scheme: 'timestamped', algorithm: 'sha256', tolerance_seconds: 300 }, 'secret'));
      const t = String(Math.floor(Date.now() / 1000));
      const v1 = crypto.createHmac('sha256', SECRET).update(t + '.').update(body).digest('hex');
      expect(hookService.authenticateRequest(h, { headers: { 'calendly-webhook-signature': `t=${t},v1=${v1}` }, rawBodyBuf: body }).valid).toBe(true);
    });
  }

  test('a corrupt ciphertext is REFUSED (never "no secret")', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const bad = 'ENCv1:' + Buffer.alloc(40).toString('base64');
    expect(hookService.authenticateRequest(hook('api_key', { key: bad, header: 'x-hook-key' }), { headers: { 'x-hook-key': bad } }))
      .toEqual({ valid: false, error: 'Hook authentication is misconfigured' });
    console.error.mockRestore();
  });

  test('auth_type none is untouched', () => {
    expect(hookService.authenticateRequest(hook('none', null), { headers: {} })).toEqual({ valid: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hooks — writes, duplicate, display
// ─────────────────────────────────────────────────────────────────────────────

describe('hook writes, duplicate and display', () => {
  function hookDb(rows = {}) {
    const calls = [];
    return {
      calls,
      query: async (sql, params = []) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        calls.push({ sql: s, params });
        if (/^INSERT INTO hooks SET \?/.test(s)) return [{ insertId: 77 }];
        if (/^UPDATE hooks SET \?/.test(s)) return [{ affectedRows: 1 }];
        if (/FROM hooks h LEFT JOIN users u ON h.last_modified_by = u.user WHERE h.id = \?/.test(s)) return [[rows[params[0]]].filter(Boolean)];
        if (/FROM hooks h LEFT JOIN hook_targets ht/.test(s)) return [Object.values(rows)];
        if (/FROM hook_targets ht/.test(s)) return [[]];
        if (/jwt_api_audit_log/.test(s)) return [{}];
        return [[]];
      },
    };
  }
  const authOf = (db, re) => {
    const c = db.calls.find(x => re.test(x.sql));
    return JSON.parse(c.params[0].auth_config);
  };

  test('createHook stores ciphertext (object or JSON-string body), other keys plain', async () => {
    for (const ac of [{ key: SECRET, header: 'x-hook-key' }, JSON.stringify({ key: SECRET, header: 'x-hook-key' })]) {
      const db = hookDb();
      await hookService.createHook(db, { name: 'n', auth_type: 'api_key', auth_config: ac });
      const stored = authOf(db, /^INSERT INTO hooks SET \?/);
      expect(cc.decrypt(stored.key)).toBe(SECRET);
      expect(stored.header).toBe('x-hook-key');
    }
  });

  test('updateHook encrypts even when the body omits auth_type; null clears; ciphertext not re-encrypted', async () => {
    const db = hookDb();
    await hookService.updateHook(db, 5, { auth_config: JSON.stringify({ secret: SECRET, scheme: 'timestamped' }) });
    const s = authOf(db, /^UPDATE hooks SET \?/);
    expect(cc.decrypt(s.secret)).toBe(SECRET);
    expect(s.scheme).toBe('timestamped');

    const db2 = hookDb();
    await hookService.updateHook(db2, 5, { auth_config: JSON.stringify(s) });
    expect(authOf(db2, /^UPDATE hooks SET \?/).secret).toBe(s.secret);

    const db3 = hookDb();
    await hookService.updateHook(db3, 5, { auth_config: null });
    expect(db3.calls.find(x => /^UPDATE hooks SET \?/.test(x.sql)).params[0].auth_config).toBeNull();
  });

  test('display: GET /api/hooks and /api/hooks/:id return plaintext; the service reads stay encrypted', async () => {
    const enc = { key: cc.encrypt(SECRET), header: 'x-hook-key' };
    const rows = { 5: { id: 5, slug: 's', auth_type: 'api_key', auth_config: enc } };
    expect((await hookService.getHookById(hookDb(rows), 5)).auth_config.key).toBe(enc.key);
    expect((await hookService.listHooks(hookDb(rows)))[0].auth_config.key).toBe(enc.key);

    const router = require('../routes/api.hooks');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.db = hookDb(rows); next(); });
    app.use(router);
    const token = jwt.sign({ sub: 6, username: 'IT', user_auth: 'authorized', roles: [], aud: 'staff' }, process.env.JWT_SECRET);
    const get = (p) => new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        http.get({ port: server.address().port, path: p, headers: { authorization: 'Bearer ' + token } }, (res) => {
          let d = ''; res.on('data', c => (d += c)); res.on('end', () => { server.close(); resolve(JSON.parse(d)); });
        }).on('error', (e) => { server.close(); reject(e); });
      });
    });
    expect((await get('/api/hooks/5')).hook.auth_config).toEqual({ key: SECRET, header: 'x-hook-key' });
    expect((await get('/api/hooks')).hooks[0].auth_config).toEqual({ key: SECRET, header: 'x-hook-key' });
  });

  test('duplicateHook copies the ciphertext verbatim, and the copy still verifies', async () => {
    const enc = { key: cc.encrypt(SECRET), header: 'x-hook-key' };
    const src = { id: 5, slug: 's', name: 'n', description: null, auth_type: 'api_key', auth_config: enc,
                  filter_mode: 'none', filter_config: null, transform_mode: 'passthrough', transform_config: null,
                  capture_mode: 'off', targets: [] };
    let inserted = null;
    const conn = {
      query: async (sql, params) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        if (/^INSERT INTO hooks/.test(s)) { inserted = params; return [{ insertId: 78 }]; }
        return [[]];
      },
    };
    const db = {
      query: async (sql, params) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        if (/FROM hooks h LEFT JOIN users u/.test(s)) return [[params[0] === 5 ? src : { ...src, id: 78, auth_config: JSON.parse(inserted[4]) }]];
        if (/FROM hook_targets ht/.test(s)) return [[]];
        return [[]];
      },
      withTransaction: async (fn) => fn(conn),
    };
    const copy = await hookService.duplicateHook(db, 5, 6);
    expect(inserted).not.toBeNull();
    const copied = JSON.parse(inserted[4]);
    expect(copied.key).toBe(enc.key);
    expect(hookService.authenticateRequest({ ...copy, auth_type: 'api_key', auth_config: copied }, { headers: { 'x-hook-key': SECRET } }).valid).toBe(true);
  });
});
