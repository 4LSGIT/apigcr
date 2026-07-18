/**
 * Tests for K3 — refresh-on-miss in auth.jwtOrApiKey.
 *
 * Scenario: rotation just happened on instance A; instance B's firmConfig
 * cache is still within TTL and holds the pre-rotation slots. A self-call
 * carrying the NEW yci_ key hits B. Without refresh-on-miss, B 401s until
 * TTL expiry. With it, B forces one awaited refresh, learns the new key,
 * and accepts on first contact.
 *
 * Also pinned: the forced refresh is throttled, and non-yci_ garbage never
 * triggers it.
 */

const ENV_KEYS = ['INTERNAL_API_KEY'];
let envBackup;
beforeEach(() => {
  envBackup = {};
  for (const k of ENV_KEYS) { envBackup[k] = process.env[k]; delete process.env[k]; }
  jest.resetModules(); // fresh middleware throttle + fresh firmConfig cache
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

/** firmConfig-injectable db serving given slot values; counts queries. */
function settingsDb(slots) {
  const db = {
    calls: 0,
    query: jest.fn(async () => {
      db.calls++;
      return [Object.entries(db.slots).map(([key, value]) => ({ key, value }))];
    }),
    slots,
  };
  return db;
}

/** db handed to the middleware (audit inserts + api_keys lookups). */
function reqDb() {
  return { query: jest.fn(async (sql) => (sql.includes('FROM api_keys') ? [[]] : [{}])) };
}

function run(mw, key) {
  const req = { headers: { 'x-api-key': key }, db: reqDb(), originalUrl: '/x', method: 'GET', query: {}, body: {}, socket: {} };
  const res = { code: null, status(c) { this.code = c; return this; }, json() { return this; } };
  const next = jest.fn();
  return mw(req, res, next).then(() => ({ req, res, next }));
}

const OLD = 'yci_' + 'a'.repeat(64);
const NEW = 'yci_' + 'b'.repeat(64);

test('stale verifier accepts a freshly rotated key on first contact', async () => {
  const fc = require('../lib/firmConfig');
  const db = settingsDb({ internal_api_key: OLD, internal_api_key_prev: null });
  fc._test({ db, resetCache: true });
  await fc.prime();
  expect(fc.cfg('internal_api_key')).toBe(OLD); // cache holds pre-rotation state

  // Rotation happens "elsewhere": DB now serves NEW/OLD, cache still stale.
  db.slots = { internal_api_key: NEW, internal_api_key_prev: OLD };

  const mw = require('../lib/auth.jwtOrApiKey');
  const { req, next } = await run(mw, NEW);
  expect(next).toHaveBeenCalled();                 // refresh-on-miss saved it
  expect(req.auth).toEqual({ type: 'api_key', key_label: 'internal' });
  expect(fc.cfg('internal_api_key')).toBe(NEW);    // cache is now current
  fc._test({ db: null, resetCache: true });
});

test('old key still accepted by the same stale-then-refreshed instance (prev slot)', async () => {
  const fc = require('../lib/firmConfig');
  const db = settingsDb({ internal_api_key: NEW, internal_api_key_prev: OLD });
  fc._test({ db, resetCache: true });
  await fc.prime();
  const mw = require('../lib/auth.jwtOrApiKey');
  const { next } = await run(mw, OLD);
  expect(next).toHaveBeenCalled();
  fc._test({ db: null, resetCache: true });
});

test('bogus yci_ keys: refresh is throttled to one within the window', async () => {
  const fc = require('../lib/firmConfig');
  const db = settingsDb({ internal_api_key: OLD, internal_api_key_prev: null });
  fc._test({ db, resetCache: true });
  await fc.prime();
  const baseline = db.calls;

  const mw = require('../lib/auth.jwtOrApiKey');
  for (let i = 0; i < 5; i++) {
    const { res, next } = await run(mw, 'yci_' + String(i).repeat(64));
    expect(next).not.toHaveBeenCalled();
    expect(res.code).toBe(401);
  }
  expect(db.calls - baseline).toBe(1); // one forced refresh, four throttled
  fc._test({ db: null, resetCache: true });
});

test('non-yci_ garbage never triggers a config refresh', async () => {
  const fc = require('../lib/firmConfig');
  const db = settingsDb({ internal_api_key: OLD, internal_api_key_prev: null });
  fc._test({ db, resetCache: true });
  await fc.prime();
  const baseline = db.calls;

  const mw = require('../lib/auth.jwtOrApiKey');
  for (const k of ['yck_' + 'c'.repeat(64), 'random-junk', 'Bearer-ish']) {
    const { res } = await run(mw, k);
    expect(res.code).toBe(401);
  }
  expect(db.calls - baseline).toBe(0);
  fc._test({ db: null, resetCache: true });
});