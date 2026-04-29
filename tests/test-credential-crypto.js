// tests/test-credential-crypto.js
//
// Ad-hoc test script for lib/credentialCrypto. Same style as the other
// scripts in tests/ (test-cron.js, test-timing-extensions.js) — not a
// formal jest suite. Run with `node tests/test-credential-crypto.js`.
//
// Covers:
//   - round-trip (encrypt → decrypt yields original plaintext, ASCII + UTF-8 + empty)
//   - tamper detection (flipping a byte in ciphertext or auth tag throws)
//   - decrypt with a different key throws
//   - decrypt rejects values without ENCv1: prefix
//   - IV uniqueness (encrypting same plaintext twice yields different output)
//   - missing CREDENTIALS_ENCRYPTION_KEY → throws on require
//   - wrong-length key (16 and 64 bytes) → throws on require
//   - isEncrypted prefix check — true for encrypt() output, false for plain strings
//     including base64-shaped plaintext that lacks the ENCv1: prefix

const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

// Wire-format prefix (mirrors lib/credentialCrypto.js). Tamper tests strip
// this off before manipulating bytes and re-add it before calling decrypt().
const ENC_PREFIX = 'ENCv1:';

// Auto-detect whether we're running from /tests or from project root, so the
// require path resolves either way (same shim trick test-timing-extensions uses).
const root = path.resolve(__dirname, path.basename(__dirname) === 'tests' ? '..' : '.');
const cryptoModulePath = path.join(root, 'lib', 'credentialCrypto');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

// Helper: load credentialCrypto fresh under a specific env var value.
// Bypasses Node's require cache so we can re-test the load-time validation.
function loadFresh(keyValue) {
  delete require.cache[require.resolve(cryptoModulePath)];
  if (keyValue === undefined) {
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
  } else {
    process.env.CREDENTIALS_ENCRYPTION_KEY = keyValue;
  }
  return require(cryptoModulePath);
}

console.log('\n=== credentialCrypto tests ===\n');

// One valid key for the round-trip / tamper / IV tests.
const validKey = crypto.randomBytes(32).toString('base64');

// ─────────────────────────────────────────────────────────────
// round-trip
// ─────────────────────────────────────────────────────────────
console.log('round-trip');

test('encrypt then decrypt returns original plaintext (ASCII)', () => {
  const { encrypt, decrypt } = loadFresh(validKey);
  const original = 'sk-abcdef1234567890';
  const enc = encrypt(original);
  assert.notStrictEqual(enc, original);
  assert.strictEqual(decrypt(enc), original);
});

test('encrypt then decrypt returns original plaintext (UTF-8)', () => {
  const { encrypt, decrypt } = loadFresh(validKey);
  const original = 'tøken with émoji 🔑 — and unicode';
  assert.strictEqual(decrypt(encrypt(original)), original);
});

test('empty string round-trips', () => {
  const { encrypt, decrypt } = loadFresh(validKey);
  assert.strictEqual(decrypt(encrypt('')), '');
});

test('encrypt rejects non-string input', () => {
  const { encrypt } = loadFresh(validKey);
  assert.throws(() => encrypt(null),      /requires a string/);
  assert.throws(() => encrypt(undefined), /requires a string/);
  assert.throws(() => encrypt(12345),     /requires a string/);
  assert.throws(() => encrypt({}),        /requires a string/);
});

// ─────────────────────────────────────────────────────────────
// tamper detection
// ─────────────────────────────────────────────────────────────
console.log('\ntamper detection');

test('flipping a byte in ciphertext causes decrypt to throw', () => {
  const { encrypt, decrypt } = loadFresh(validKey);
  const enc = encrypt('payload');
  const buf = Buffer.from(enc.slice(ENC_PREFIX.length), 'base64');
  // Flip a byte in the ciphertext region (after IV + tag = byte 28+).
  buf[buf.length - 1] ^= 0x01;
  assert.throws(() => decrypt(ENC_PREFIX + buf.toString('base64')));
});

test('flipping a byte in the auth tag causes decrypt to throw', () => {
  const { encrypt, decrypt } = loadFresh(validKey);
  const enc = encrypt('payload');
  const buf = Buffer.from(enc.slice(ENC_PREFIX.length), 'base64');
  buf[12] ^= 0x01; // first byte of auth tag (right after the 12-byte IV)
  assert.throws(() => decrypt(ENC_PREFIX + buf.toString('base64')));
});

test('flipping a byte in the IV causes decrypt to throw', () => {
  const { encrypt, decrypt } = loadFresh(validKey);
  const enc = encrypt('payload');
  const buf = Buffer.from(enc.slice(ENC_PREFIX.length), 'base64');
  buf[0] ^= 0x01;
  assert.throws(() => decrypt(ENC_PREFIX + buf.toString('base64')));
});

test('decrypt with a different key throws', () => {
  const { encrypt } = loadFresh(validKey);
  const enc = encrypt('payload');
  // Reload the module under a different key and try to decrypt.
  const { decrypt } = loadFresh(crypto.randomBytes(32).toString('base64'));
  assert.throws(() => decrypt(enc));
});

test('decrypt rejects too-short payload after prefix', () => {
  const { decrypt } = loadFresh(validKey);
  // 20 bytes < IV(12) + tag(16) = 28; prefix is present so we reach the length check.
  const tooShort = ENC_PREFIX + crypto.randomBytes(20).toString('base64');
  assert.throws(() => decrypt(tooShort), /too short/);
});

test('decrypt rejects empty / non-string input', () => {
  const { decrypt } = loadFresh(validKey);
  assert.throws(() => decrypt(''),        /missing ENCv1: prefix/);
  assert.throws(() => decrypt(null),      /missing ENCv1: prefix/);
  assert.throws(() => decrypt(undefined), /missing ENCv1: prefix/);
});

test('decrypt rejects values without ENCv1: prefix', () => {
  const { decrypt } = loadFresh(validKey);
  // A bare base64 blob (what Slice 2/3 used to emit) is no longer accepted.
  const bareB64 = crypto.randomBytes(40).toString('base64');
  assert.throws(() => decrypt(bareB64), /missing ENCv1: prefix/);
  // Wrong version prefix.
  assert.throws(() => decrypt('ENCv2:' + bareB64), /missing ENCv1: prefix/);
});

// ─────────────────────────────────────────────────────────────
// IV uniqueness
// ─────────────────────────────────────────────────────────────
console.log('\nIV uniqueness');

test('encrypting same plaintext twice yields different ciphertexts', () => {
  const { encrypt } = loadFresh(validKey);
  const a = encrypt('same-plaintext');
  const b = encrypt('same-plaintext');
  assert.notStrictEqual(a, b);
});

test('IV regions of repeat encrypts differ (sanity check on randomness)', () => {
  const { encrypt } = loadFresh(validKey);
  const ivs = new Set();
  for (let i = 0; i < 25; i++) {
    const buf = Buffer.from(encrypt('x'), 'base64');
    ivs.add(buf.subarray(0, 12).toString('hex'));
  }
  assert.strictEqual(ivs.size, 25);
});

// ─────────────────────────────────────────────────────────────
// module-load env validation
// ─────────────────────────────────────────────────────────────
console.log('\nmodule-load env validation');

test('missing CREDENTIALS_ENCRYPTION_KEY throws on require', () => {
  assert.throws(() => loadFresh(undefined), /CREDENTIALS_ENCRYPTION_KEY env var is missing/);
});

test('wrong-length key (16 bytes) throws on require', () => {
  const shortKey = crypto.randomBytes(16).toString('base64');
  assert.throws(() => loadFresh(shortKey), /must decode to exactly 32 bytes/);
});

test('wrong-length key (64 bytes) throws on require', () => {
  const longKey = crypto.randomBytes(64).toString('base64');
  assert.throws(() => loadFresh(longKey), /must decode to exactly 32 bytes/);
});

test('garbage non-base64 key throws on require (decodes to <32 bytes)', () => {
  // 'hello' base64-decodes permissively to a few junk bytes — far short of 32.
  assert.throws(() => loadFresh('hello'), /must decode to exactly 32 bytes/);
});

// ─────────────────────────────────────────────────────────────
// isEncrypted prefix check
// ─────────────────────────────────────────────────────────────
console.log('\nisEncrypted prefix check');

test('returns true for encrypt() output', () => {
  const { encrypt, isEncrypted } = loadFresh(validKey);
  assert.strictEqual(isEncrypted(encrypt('anything')), true);
});

test('returns false for a short plain string', () => {
  const { isEncrypted } = loadFresh(validKey);
  assert.strictEqual(isEncrypted('hello'), false);
});

test('returns false for empty string', () => {
  const { isEncrypted } = loadFresh(validKey);
  assert.strictEqual(isEncrypted(''), false);
});

test('returns false for plaintext that happens to look like base64 ciphertext', () => {
  // The bug this fix addresses: a plain client_secret composed of base64 chars
  // and >= 28 bytes used to trip the old heuristic, so encrypt() was skipped
  // and the plaintext was stored as-is. With the prefix marker, no plaintext
  // collides unless it literally starts with "ENCv1:".
  const { isEncrypted } = loadFresh(validKey);
  const baseLikePlaintext = crypto.randomBytes(40).toString('base64');
  assert.strictEqual(isEncrypted(baseLikePlaintext), false);
});

test('returns false for a string with non-base64 characters', () => {
  const { isEncrypted } = loadFresh(validKey);
  assert.strictEqual(isEncrypted('not!valid@base64'), false);
  assert.strictEqual(isEncrypted('has spaces in it'), false);
});

test('returns false for non-string input', () => {
  const { isEncrypted } = loadFresh(validKey);
  assert.strictEqual(isEncrypted(null),      false);
  assert.strictEqual(isEncrypted(undefined), false);
  assert.strictEqual(isEncrypted(12345),     false);
  assert.strictEqual(isEncrypted({}),        false);
});

// ─────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────
console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
  for (const f of failures) {
    console.log(`FAIL: ${f.name}`);
    console.log(`      ${f.err.stack || f.err.message}`);
  }
  process.exitCode = 1;
}