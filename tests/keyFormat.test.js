// tests/keyFormat.test.js
//
/**
 * Key mint format — access-control B3 (lib/apiKeys randomBase62 / generateKey,
 * routes/api.readonlyKeys.js mint, routes/admin.apiKeys.js internal rotate;
 * ref/ACCESS_CONTROL_DESIGN.md §5.3).
 *
 * WHAT IS LOCKED
 *   - The body: exactly 22 chars of [0-9A-Za-z] for every prefix; no
 *     collisions over a large sample; UNIFORM over the 62 symbols (rejection
 *     sampling — a modulo-biased generator over-produces 8 symbols by ~25%,
 *     which this sample catches).
 *   - ycro_ mints: "ycro_" + body + "_" + stamp; canonicalKey cuts exactly
 *     "ycro_<body>" (the body has no underscore); the stored hash is the
 *     canonical one; the key authenticates with its stamp, without it, and
 *     with the stamp edited.
 *   - OLD keys still authenticate (pin): a pre-B3 ycro_<64 hex>_<stamp> through
 *     readonlyApiKeyAuth, and a pre-B3 yck_<64 hex> through apiKeys.lookup.
 *   - The internal-key rotate mints the new format (yci_ + 22 base62).
 *   - The list hands the UI the scope vocabulary (= KEY_SCOPES) and the default.
 *
 * Run: npx jest tests/keyFormat.test.js
 */
'use strict';

process.env.JWT_SECRET = 'key-format-b3-test-secret';
process.env.SU_RATE_LIMIT_READONLYKEYS = '10000';
process.env.SU_RATE_LIMIT_API_KEYS = '10000';

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

const apiKeys = require('../lib/apiKeys');
const { randomBase62, generateKey, KEY_BODY_LEN } = apiKeys;
const { readonlyApiKeyAuth, hashKey, canonicalKey } = require('../lib/auth.readonly');
const { KEY_SCOPES } = require('../lib/capabilities');
const { mintElevationToken } = require('../lib/auth.superuser');

const B62 = /^[0-9A-Za-z]+$/;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

describe('randomBase62 / generateKey', () => {
  test('22 chars, base62 only, for every prefix', () => {
    expect(KEY_BODY_LEN).toBe(22);
    for (const p of ['yci_', 'yck_']) {
      for (let i = 0; i < 500; i++) expect(generateKey(p)).toMatch(new RegExp(`^${p}[0-9A-Za-z]{22}$`));
    }
    expect(generateKey()).toMatch(/^yck_[0-9A-Za-z]{22}$/);   // default prefix
    for (const n of [1, 22, 100]) {
      const s = randomBase62(n);
      expect(s).toHaveLength(n);
      expect(s).toMatch(B62);
    }
  });

  test('no collisions over 50,000 keys', () => {
    const seen = new Set();
    for (let i = 0; i < 50000; i++) seen.add(randomBase62(22));
    expect(seen.size).toBe(50000);
  });

  test('uniform over all 62 symbols (rejection sampling — no modulo bias)', () => {
    const counts = Object.fromEntries([...ALPHABET].map(c => [c, 0]));
    const N = 62 * 4000;
    const s = randomBase62(N);
    for (const c of s) counts[c]++;
    const expected = N / 62;                                   // 4000
    // every symbol appears, and none drifts beyond ±12% — a byte%62 generator
    // gives symbols 0–7 five chances in 256 vs four (≈ +25%), far outside this
    for (const [c, n] of Object.entries(counts)) {
      expect({ c, ok: n > expected * 0.88 && n < expected * 1.12 }).toEqual({ c, ok: true });
    }
  });
});

// ── harness for the real SU routes ──────────────────────────────────────────

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

// readonlyApiKeyAuth over a db holding exactly one key hash.
function authWith(storedHash, presented) {
  return new Promise((resolve) => {
    const db = {
      query: async (sql, params) => {
        const s = String(sql);
        if (/FROM readonly_api_keys/.test(s)) {
          return [params[0] === storedHash
            ? [{ id: 70, label: 'k', expires_at: new Date(Date.now() + 3600e3), revoked_at: null, scopes: null }] : []];
        }
        return [{}];
      },
    };
    const req = { headers: { 'x-readonly-api-key': presented }, db, originalUrl: '/x', method: 'POST', socket: {} };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { resolve(false); return this; } };
    readonlyApiKeyAuth(req, res, () => resolve(true));
  });
}

describe('session key (ycro_) mints', () => {
  const router = require('../routes/api.readonlyKeys');
  const mint = (body) => suCall(router, 'POST', '/api/readonly-keys', body,
    (s) => (/^INSERT INTO readonly_api_keys/.test(s) ? [{ insertId: 88 }] : undefined));

  test('ycro_ + 22 base62 + _ + stamp; canonicalKey cuts ycro_<body>; the stored hash is the canonical one', async () => {
    const r = await mint({ label: 'b3' });
    expect(r.status).toBe(200);
    expect(r.body.key).toMatch(/^ycro_[0-9A-Za-z]{22}_\d{8}T\d{4}Z$/);
    const canon = canonicalKey(r.body.key);
    expect(canon).toMatch(/^ycro_[0-9A-Za-z]{22}$/);
    const ins = r.db.calls.find(c => /^INSERT INTO readonly_api_keys/.test(c.sql));
    expect(ins.params[0]).toBe(hashKey(canon));
    expect(ins.params[0]).toBe(crypto.createHash('sha256').update(canon).digest('hex'));
    expect(ins.params[1]).toBe(r.body.key.slice(0, 12));
  });

  test('the minted key authenticates with its stamp, without it, and with the stamp edited', async () => {
    const r = await mint({ label: 'b3-auth' });
    const stored = r.db.calls.find(c => /^INSERT INTO readonly_api_keys/.test(c.sql)).params[0];
    const canon = canonicalKey(r.body.key);
    expect(await authWith(stored, r.body.key)).toBe(true);
    expect(await authWith(stored, canon)).toBe(true);
    expect(await authWith(stored, canon + '_20991231T2359Z')).toBe(true);
    expect(await authWith(stored, canon + '_any note here')).toBe(true);
    expect(await authWith(stored, canon.slice(0, -1) + (canon.endsWith('A') ? 'B' : 'A'))).toBe(false);
  });

  test('the picker payload round-trips: chosen scopes stored and returned', async () => {
    const r = await mint({ label: 'picker', scopes: ['sql.ro', 'temp.ringcentral'] });
    expect(r.body.scopes).toEqual(['sql.ro', 'temp.ringcentral']);
    const ins = r.db.calls.find(c => /^INSERT INTO readonly_api_keys/.test(c.sql));
    expect(JSON.parse(ins.params[5])).toEqual(['sql.ro', 'temp.ringcentral']);
  });

  test('the list hands the UI the vocabulary (exactly KEY_SCOPES) and the default trio', async () => {
    const r = await suCall(router, 'GET', '/api/readonly-keys', undefined,
      (s) => (/FROM readonly_api_keys k/.test(s) ? [[]] : undefined));
    expect(r.status).toBe(200);
    expect(r.body.scope_vocabulary.map(v => v.name)).toEqual(Object.keys(KEY_SCOPES));
    for (const v of r.body.scope_vocabulary) expect(v.desc).toBe(KEY_SCOPES[v.name].desc);
    expect(r.body.default_scopes).toEqual(['sql.ro', 'scratch', 'alert']);
  });
});

describe('pre-B3 keys keep working (pin)', () => {
  test('an old ycro_<64 hex>_<stamp> session key authenticates, stamp or not', async () => {
    const old = 'ycro_' + crypto.randomBytes(32).toString('hex');
    const stored = hashKey(old);
    expect(await authWith(stored, old + '_20261020T0000Z')).toBe(true);
    expect(await authWith(stored, old)).toBe(true);
  });

  test('an old yck_<64 hex> machine key still resolves through apiKeys.lookup', async () => {
    apiKeys.invalidateCache();
    const old = 'yck_' + crypto.randomBytes(32).toString('hex');
    const db = {
      query: async (sql, params) => {
        if (/FROM api_keys WHERE key_hash/.test(String(sql))) {
          return [params[0] === apiKeys.hashKey(old) ? [{ id: 2, label: 'Pabbly', revoked_at: null, scopes: null }] : []];
        }
        return [{}];
      },
    };
    expect(await apiKeys.lookup(db, old)).toEqual({ id: 2, label: 'Pabbly', scopes: null });
  });
});

describe('the internal key rotate mints the new format', () => {
  test('yci_ + 22 base62 into internal_api_key; the displaced key into _prev', async () => {
    const router = require('../routes/admin.apiKeys');
    const routes = router.stack.filter(l => l.route).map(l => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
    const rotate = routes.find(r => /rotate/.test(r));
    expect(rotate).toBeDefined();
    const [method, path] = rotate.split(' ');
    const OLD = 'yci_' + crypto.randomBytes(32).toString('hex');
    const r = await suCall(router, method, path, {}, (s, p) => {
      if (/SELECT `value` FROM app_settings WHERE `key` = 'internal_api_key'/.test(s)) return [[{ value: OLD }]];
      if (/^UPDATE app_settings SET `value` = CASE/.test(s)) return [{ affectedRows: 2 }];
      return [[]];
    });
    expect(r.status).toBeLessThan(300);
    const upd = r.db.calls.find(c => /^UPDATE app_settings SET `value` = CASE/.test(c.sql));
    expect(upd.params[0]).toMatch(/^yci_[0-9A-Za-z]{22}$/);
    expect(upd.params[1]).toBe(OLD);
  });
});
