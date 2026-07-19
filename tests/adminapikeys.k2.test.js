/**
 * tests/adminapikeys.k2.test.js
 *
 * Tests for K2 — internal key rotation (routes/admin.apiKeys.js).
 *
 * Contracts pinned:
 *   - First rotation: current slot NULL in DB → the ENV key becomes the
 *     previous slot (in-flight callers holding the env key stay valid).
 *   - Subsequent rotation: DB current becomes previous; fresh yci_ current.
 *   - Both slots written in ONE atomic UPDATE.
 *   - Missing settings rows (K1 SQL not run) → throws, nothing half-written.
 *   - firmConfig cache is invalidated so this instance verifies the new key
 *     immediately.
 *
 * Run:
 *   npx jest tests/adminapikeys.k2.test.js
 */

const ENV_KEYS = ['INTERNAL_API_KEY'];
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

function fakeDb({ currentSlot = null, affectedRows = 2 } = {}) {
  const db = {
    updates: [],
    query: jest.fn(async (sql, params) => {
      if (sql.startsWith('SELECT `value` FROM app_settings')) {
        return [[currentSlot != null ? { value: currentSlot } : undefined].filter(Boolean)];
      }
      if (sql.startsWith('UPDATE app_settings SET `value` = CASE')) {
        db.updates.push(params);
        return [{ affectedRows }];
      }
      return [[]];
    }),
  };
  return db;
}

test('first rotation: env key is displaced into the previous slot', async () => {
  process.env.INTERNAL_API_KEY = 'env-legacy-key';
  const { _rotateInternal } = require('../routes/admin.apiKeys');
  const db = fakeDb({ currentSlot: null });
  const out = await _rotateInternal(db);
  expect(out.hadPrevious).toBe(true);
  const [next, displaced] = db.updates[0];
  expect(next).toMatch(/^yci_[0-9a-f]{64}$/);
  expect(displaced).toBe('env-legacy-key');
});

test('subsequent rotation: DB current becomes previous', async () => {
  process.env.INTERNAL_API_KEY = 'env-legacy-key'; // must be ignored
  const { _rotateInternal } = require('../routes/admin.apiKeys');
  const db = fakeDb({ currentSlot: 'yci_' + 'a'.repeat(64) });
  await _rotateInternal(db);
  const [next, displaced] = db.updates[0];
  expect(displaced).toBe('yci_' + 'a'.repeat(64));
  expect(next).toMatch(/^yci_[0-9a-f]{64}$/);
  expect(next).not.toBe(displaced);
});

test('rotation with nothing set anywhere: previous slot becomes NULL, still rotates', async () => {
  const { _rotateInternal } = require('../routes/admin.apiKeys');
  const db = fakeDb({ currentSlot: null });
  const out = await _rotateInternal(db);
  expect(out.hadPrevious).toBe(false);
  const [next, displaced] = db.updates[0];
  expect(next).toMatch(/^yci_/);
  expect(displaced).toBeNull();
});

test('missing settings rows (K1 SQL not run) → throws', async () => {
  const { _rotateInternal } = require('../routes/admin.apiKeys');
  const db = fakeDb({ affectedRows: 0 });
  await expect(_rotateInternal(db)).rejects.toThrow(/K1 api_keys migration/);
});

test('rotation invalidates firmConfig so the new key verifies immediately', async () => {
  const fc = require('../lib/firmConfig');
  // Prime the cache with the OLD current key via an injected db.
  fc._test({
    db: { query: async () => [[{ key: 'internal_api_key', value: 'old-current' }]] },
    resetCache: true,
  });
  await fc.prime();
  expect(fc.cfg('internal_api_key')).toBe('old-current');

  const { _rotateInternal } = require('../routes/admin.apiKeys');
  await _rotateInternal(fakeDb({ currentSlot: 'old-current' }));

  // invalidate() must have zeroed the TTL: swap the injected db to the
  // post-rotation state and confirm the next read refetches.
  fc._test({ db: { query: async () => [[{ key: 'internal_api_key', value: 'new-current' }]] } });
  await fc.prime();
  expect(fc.cfg('internal_api_key')).toBe('new-current');
  fc._test({ db: null, resetCache: true });
});

test('rotation end-to-end with the real verifier: old key valid via prev, new key valid', async () => {
  const fc = require('../lib/firmConfig');
  fc._test({
    db: { query: async () => [[
      { key: 'internal_api_key', value: 'yci_new' },
      { key: 'internal_api_key_prev', value: 'yci_old' },
    ]] },
    resetCache: true,
  });
  await fc.prime();
  const mw = require('../lib/auth.jwtOrApiKey');
  const auditDb = { query: jest.fn(async () => [{}]) };
  for (const key of ['yci_new', 'yci_old']) {
    const req = { headers: { 'x-api-key': key }, db: auditDb, originalUrl: '/x', method: 'GET', query: {}, body: {}, socket: {} };
    const res = { status() { return this; }, json() { return this; } };
    const next = jest.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.auth.key_label).toBe('internal');
  }
  fc._test({ db: null, resetCache: true });
});