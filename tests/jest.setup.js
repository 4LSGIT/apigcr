// tests/jest.setup.js
//
// Central test-environment seeding — runs before every test file (see
// jest.config.js setupFiles). Purpose: several prod modules deliberately
// FAIL FAST at require() when critical env is missing (credentialCrypto,
// dropboxServiceLegacy). That's correct in prod — a misconfigured instance
// should crash at boot, loudly — but in tests it's noise: the suite verifies
// code, not Cloud Run's env. Dummies satisfy the load-time checks; nothing
// here performs network or crypto operations against real services.
//
// Individual test files may still seed these themselves (harmless
// redundancy that keeps them self-documenting); this file is the guarantee.
//
// If a NEW module adds a fail-fast env check, add its var here — the
// moduleLoad smoke suite will fail with a clear message until you do.

if (!process.env.CREDENTIALS_ENCRYPTION_KEY) {
  process.env.CREDENTIALS_ENCRYPTION_KEY =
    require('crypto').randomBytes(32).toString('base64');
}

for (const k of ['DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'DROPBOX_REFRESH_TOKEN']) {
  if (!process.env[k]) process.env[k] = 'jest-dummy';
}