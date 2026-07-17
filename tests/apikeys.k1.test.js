/**
 * Tests for K1 — external api_keys service + jwtOrApiKey auth paths.
 *
 * Contracts pinned here:
 *   apiKeys:   hash determinism, create→lookup roundtrip, revoked → null,
 *              positive+negative caching, invalidateCache, fail-closed on
 *              DB errors, last_used_at touch throttling.
 *   middleware: internal key via env (back-compat), internal PREVIOUS slot
 *              via settings (rotation overlap), external key attribution
 *              (req.auth.key_label + audit username), unknown key → 401,
 *              JWT path unchanged.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ENV_KEYS = ['INTERNAL_API_KEY', 'JWT_SECRET', 'JWT_VERSION'];
let envBackup;
beforeEach(() => {
  envBackup = {};
  for (const k of ENV_KEYS) { envBackup[k] = process.env[k]; delete process.env[k]; }
  jest.resetModules();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

/** db stub dispatching on SQL substring. */
function fakeDb({ keyRows = [], failLookup = false } = {}) {
  const db = {
    selects: 0, touches: 0, inserts: [], audits: 0,
    query: jest.fn(async (sql, params) => {
      if (sql.includes('FROM api_keys WHERE key_hash')) {
        db.selects++;
        if (failLookup) throw new Error('ECONNRESET');
        const row = keyRows.find((r) => r.key_hash === params[0]);
        return [[row].filter(Boolean)];
      }
      if (sql.includes('SET last_used_at')) { db.touches++; return [{}]; }
      if (sql.includes('INSERT INTO api_keys')) {
        db.inserts.push(params);
        return [{ insertId: 77 }];
      }
      if (sql.includes('jwt_api_audit_log')) { db.audits++; return [{}]; }
      if (sql.includes('FROM api_keys ORDER')) return [keyRows];
      return [[]];
    }),
  };
  return db;
}

// ── apiKeys lib ─────────────────────────────────────────────────────────────

test('hashKey is deterministic sha256 hex', () => {
  const apiKeys = require('../lib/apiKeys');
  const h = apiKeys.hashKey('abc');
  expect(h).toBe(crypto.createHash('sha256').update('abc').digest('hex'));
  expect(h).toHaveLength(64);
});

test('generateKey: yck_ prefix + 64 hex, unique', () => {
  const apiKeys = require('../lib/apiKeys');
  const k1 = apiKeys.generateKey();
  const k2 = apiKeys.generateKey();
  expect(k1).toMatch(/^yck_[0-9a-f]{64}$/);
  expect(k1).not.toBe(k2);
});

test('create → lookup roundtrip; revoked → null', async () => {
  const apiKeys = require('../lib/apiKeys');
  apiKeys.invalidateCache();
  const raw = 'yck_' + 'a'.repeat(64);
  const h = apiKeys.hashKey(raw);
  let db = fakeDb({ keyRows: [{ id: 1, label: 'pabbly', key_hash: h, revoked_at: null }] });
  expect(await apiKeys.lookup(db, raw)).toEqual({ id: 1, label: 'pabbly' });

  apiKeys.invalidateCache();
  db = fakeDb({ keyRows: [{ id: 1, label: 'pabbly', key_hash: h, revoked_at: new Date() }] });
  expect(await apiKeys.lookup(db, raw)).toBeNull();
});

test('lookup caches positives and negatives within TTL', async () => {
  const apiKeys = require('../lib/apiKeys');
  apiKeys.invalidateCache();
  const raw = 'yck_' + 'b'.repeat(64);
  const h = apiKeys.hashKey(raw);
  const db = fakeDb({ keyRows: [{ id: 2, label: 'x', key_hash: h, revoked_at: null }] });
  await apiKeys.lookup(db, raw);
  await apiKeys.lookup(db, raw);
  expect(db.selects).toBe(1); // second read served from cache

  await apiKeys.lookup(db, 'yck_' + 'c'.repeat(64)); // miss
  await apiKeys.lookup(db, 'yck_' + 'c'.repeat(64)); // cached miss
  expect(db.selects).toBe(2);
});

test('invalidateCache forces refetch (revocation takes effect)', async () => {
  const apiKeys = require('../lib/apiKeys');
  apiKeys.invalidateCache();
  const raw = 'yck_' + 'd'.repeat(64);
  const h = apiKeys.hashKey(raw);
  const db = fakeDb({ keyRows: [{ id: 3, label: 'y', key_hash: h, revoked_at: null }] });
  expect(await apiKeys.lookup(db, raw)).toBeTruthy();
  db.keyRows = undefined; // not used; simulate revocation via new db
  const db2 = fakeDb({ keyRows: [{ id: 3, label: 'y', key_hash: h, revoked_at: new Date() }] });
  apiKeys.invalidateCache();
  expect(await apiKeys.lookup(db2, raw)).toBeNull();
});

test('lookup fails CLOSED (null) on DB error, and does not cache the error', async () => {
  const apiKeys = require('../lib/apiKeys');
  apiKeys.invalidateCache();
  const raw = 'yck_' + 'e'.repeat(64);
  const h = apiKeys.hashKey(raw);
  const bad = fakeDb({ failLookup: true });
  expect(await apiKeys.lookup(bad, raw)).toBeNull();
  const good = fakeDb({ keyRows: [{ id: 4, label: 'z', key_hash: h, revoked_at: null }] });
  expect(await apiKeys.lookup(good, raw)).toEqual({ id: 4, label: 'z' }); // recovered next call
});

test('last_used_at touch is throttled per key', async () => {
  const apiKeys = require('../lib/apiKeys');
  apiKeys.invalidateCache();
  apiKeys._touchedForTests.clear();
  const raw = 'yck_' + 'f'.repeat(64);
  const h = apiKeys.hashKey(raw);
  const db = fakeDb({ keyRows: [{ id: 5, label: 'w', key_hash: h, revoked_at: null }] });
  await apiKeys.lookup(db, raw);
  await apiKeys.lookup(db, raw);
  await apiKeys.lookup(db, raw);
  expect(db.touches).toBe(1);
});

test('createKey stores hash+prefix, returns raw once', async () => {
  const apiKeys = require('../lib/apiKeys');
  const db = fakeDb();
  const out = await apiKeys.createKey(db, 'pabbly', 42);
  expect(out.raw).toMatch(/^yck_[0-9a-f]{64}$/);
  expect(out.id).toBe(77);
  const [label, hash, prefix, by] = db.inserts[0];
  expect(label).toBe('pabbly');
  expect(hash).toBe(apiKeys.hashKey(out.raw));
  expect(prefix).toBe(out.raw.slice(0, 12));
  expect(by).toBe(42);
});

// ── jwtOrApiKey middleware ──────────────────────────────────────────────────

function run(mw, headers, db) {
  const req = { headers, db, originalUrl: '/x', method: 'GET', query: {}, body: {}, socket: {} };
  const res = {
    code: null, payload: null,
    status(c) { this.code = c; return this; },
    json(p) { this.payload = p; return this; },
  };
  const next = jest.fn();
  return mw(req, res, next).then(() => ({ req, res, next }));
}

test('internal key via env still authorizes (back-compat)', async () => {
  process.env.INTERNAL_API_KEY = 'sekret';
  const mw = require('../lib/auth.jwtOrApiKey');
  const { req, next } = await run(mw, { 'x-api-key': 'sekret' }, fakeDb());
  expect(next).toHaveBeenCalled();
  expect(req.auth).toEqual({ type: 'api_key', key_label: 'internal' });
});

test('internal PREVIOUS slot authorizes during rotation overlap', async () => {
  const fc = require('../lib/firmConfig');
  fc._test({
    db: { query: async () => [[
      { key: 'internal_api_key', value: 'newkey' },
      { key: 'internal_api_key_prev', value: 'oldkey' },
    ]] },
    resetCache: true,
  });
  await fc.prime();
  const mw = require('../lib/auth.jwtOrApiKey');
  for (const k of ['newkey', 'oldkey']) {
    const { next } = await run(mw, { 'x-api-key': k }, fakeDb());
    expect(next).toHaveBeenCalled();
  }
  fc._test({ db: null, resetCache: true });
});

test('external key authorizes with attribution', async () => {
  const apiKeys = require('../lib/apiKeys');
  apiKeys.invalidateCache();
  const raw = 'yck_' + '9'.repeat(64);
  const db = fakeDb({ keyRows: [{ id: 8, label: 'pabbly', key_hash: apiKeys.hashKey(raw), revoked_at: null }] });
  const mw = require('../lib/auth.jwtOrApiKey');
  const { req, next } = await run(mw, { 'x-api-key': raw }, db);
  expect(next).toHaveBeenCalled();
  expect(req.auth).toEqual({ type: 'api_key', key_id: 8, key_label: 'pabbly' });
});

test('unknown api key without Bearer → 401, next not called', async () => {
  const apiKeys = require('../lib/apiKeys');
  apiKeys.invalidateCache();
  const mw = require('../lib/auth.jwtOrApiKey');
  const { res, next } = await run(mw, { 'x-api-key': 'nope' }, fakeDb());
  expect(next).not.toHaveBeenCalled();
  expect(res.code).toBe(401);
});

test('JWT path unchanged: valid token authorizes with user identity', async () => {
  process.env.JWT_SECRET = 'testsecret';
  const token = jwt.sign(
    { sub: 5, username: 'fred', user_type: 'staff', user_auth: 'authorized - SU' },
    'testsecret'
  );
  const mw = require('../lib/auth.jwtOrApiKey');
  const { req, next } = await run(mw, { authorization: 'Bearer ' + token }, fakeDb());
  expect(next).toHaveBeenCalled();
  expect(req.auth.type).toBe('jwt');
  expect(req.auth.username).toBe('fred');
});

test('invalid JWT → 401', async () => {
  process.env.JWT_SECRET = 'testsecret';
  const mw = require('../lib/auth.jwtOrApiKey');
  const { res, next } = await run(mw, { authorization: 'Bearer garbage' }, fakeDb());
  expect(next).not.toHaveBeenCalled();
  expect(res.code).toBe(401);
});