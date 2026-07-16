/**
 * Tests for lib/firmConfig.js — the cached sync config reader.
 *
 * Pins down the resolution order (DB → env → legacyEnv → null), the
 * empty-string-falls-through rule, TTL throttling, invalidate(), and
 * fail-open behavior on DB errors. These are the contracts every migrated
 * call site (Slice C) depends on.
 *
 * Run:
 *   npm install --save-dev jest
 *   npx jest tests/firmConfig.test.js
 *   npm uninstall --save-dev jest
 */

const path = require('path');
const MOD = path.join(__dirname, '..', 'lib', 'firmConfig');

/** Fresh module instance per test — module-scope cache state must not leak. */
function load() {
  jest.resetModules();
  return require(MOD);
}

/** Fake promise-pool: rows = [{key, value}, ...]. Counts queries. */
function fakeDb(rows) {
  const db = {
    calls: 0,
    rows,
    query: jest.fn(async () => {
      db.calls++;
      if (db.rows instanceof Error) throw db.rows;
      return [db.rows];
    }),
  };
  return db;
}

const ENV_KEYS = [
  'IT_EMAIL', 'AUTO_EMAIL', 'FIRM_EMAIL', 'EMAIL_DOMAINS', 'EMAIL_DOMAIN',
  'FIRM_LOGO', 'FIRM_PHONE', 'FIRM_URL', 'APP_URL', 'GCS_BUCKET',
];
let envBackup;
beforeEach(() => {
  envBackup = {};
  for (const k of ENV_KEYS) {
    envBackup[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

// ── resolution order ────────────────────────────────────────────────────────

test('env fallback serves before any DB load completes', () => {
  const fc = load();
  // db that never resolves — cfg() must not wait on it
  fc._test({ db: { query: () => new Promise(() => {}) }, resetCache: true });
  process.env.IT_EMAIL = 'it@example.com';
  expect(fc.cfg('email_it')).toBe('it@example.com');
});

test('DB value wins over env after prime()', async () => {
  const fc = load();
  fc._test({ db: fakeDb([{ key: 'email_it', value: 'db@example.com' }]), resetCache: true });
  process.env.IT_EMAIL = 'env@example.com';
  await fc.prime();
  expect(fc.cfg('email_it')).toBe('db@example.com');
});

test('empty-string DB value falls through to env', async () => {
  const fc = load();
  fc._test({ db: fakeDb([{ key: 'email_it', value: '' }]), resetCache: true });
  process.env.IT_EMAIL = 'env@example.com';
  await fc.prime();
  expect(fc.cfg('email_it')).toBe('env@example.com');
});

test('legacyEnv is used when primary env is unset', async () => {
  const fc = load();
  fc._test({ db: fakeDb([]), resetCache: true });
  process.env.EMAIL_DOMAIN = '@legacy.com'; // singular
  await fc.prime();
  expect(fc.cfg('email_domains')).toBe('@legacy.com');
});

test('primary env beats legacyEnv', async () => {
  const fc = load();
  fc._test({ db: fakeDb([]), resetCache: true });
  process.env.EMAIL_DOMAINS = '@a.com,@b.com';
  process.env.EMAIL_DOMAIN = '@legacy.com';
  await fc.prime();
  expect(fc.cfg('email_domains')).toBe('@a.com,@b.com');
});

test('returns null when nothing is set anywhere', async () => {
  const fc = load();
  fc._test({ db: fakeDb([]), resetCache: true });
  await fc.prime();
  expect(fc.cfg('firm_email')).toBeNull();
});

test('unknown key throws (typo protection)', () => {
  const fc = load();
  fc._test({ db: fakeDb([]), resetCache: true });
  expect(() => fc.cfg('email_ti')).toThrow(/unknown key/);
});

// ── cfgList ─────────────────────────────────────────────────────────────────

test('cfgList splits, trims, drops empties', async () => {
  const fc = load();
  fc._test({
    db: fakeDb([{ key: 'email_domains', value: ' @4lsg.com , @mdbl.com ,, ' }]),
    resetCache: true,
  });
  await fc.prime();
  expect(fc.cfgList('email_domains')).toEqual(['@4lsg.com', '@mdbl.com']);
});

test('cfgList returns [] when unset', async () => {
  const fc = load();
  fc._test({ db: fakeDb([]), resetCache: true });
  await fc.prime();
  expect(fc.cfgList('email_domains')).toEqual([]);
});

// ── cache mechanics ─────────────────────────────────────────────────────────

test('TTL throttle: repeated cfg() reads cause a single query', async () => {
  const fc = load();
  const db = fakeDb([{ key: 'email_it', value: 'db@example.com' }]);
  fc._test({ db, resetCache: true });
  await fc.prime();
  fc.cfg('email_it');
  fc.cfg('firm_email');
  fc.cfg('app_url');
  expect(db.calls).toBe(1);
});

test('invalidate() forces a refetch on next read', async () => {
  const fc = load();
  const db = fakeDb([{ key: 'email_it', value: 'v1' }]);
  fc._test({ db, resetCache: true });
  await fc.prime();
  expect(fc.cfg('email_it')).toBe('v1');

  db.rows = [{ key: 'email_it', value: 'v2' }];
  fc.invalidate();
  await fc.prime(); // deterministic wait for the refetch
  expect(fc.cfg('email_it')).toBe('v2');
  expect(db.calls).toBe(2);
});

// ── fail-open ───────────────────────────────────────────────────────────────

test('DB error: serves env, never throws, keeps last known values', async () => {
  const fc = load();
  const db = fakeDb([{ key: 'email_it', value: 'db@example.com' }]);
  fc._test({ db, resetCache: true });
  await fc.prime();
  expect(fc.cfg('email_it')).toBe('db@example.com');

  // subsequent refresh fails — last known value must survive
  db.rows = new Error('ECONNRESET');
  fc.invalidate();
  await fc.prime();
  expect(fc.cfg('email_it')).toBe('db@example.com'); // fail open
});

test('DB error before any successful load: env fallback still works', async () => {
  const fc = load();
  fc._test({ db: fakeDb(new Error('ETIMEDOUT')), resetCache: true });
  process.env.APP_URL = 'https://app.example.com';
  await fc.prime(); // fails internally, must not throw
  expect(fc.cfg('app_url')).toBe('https://app.example.com');
});