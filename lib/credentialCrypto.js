// lib/credentialCrypto.js
//
// AES-256-GCM encrypt/decrypt for credential token storage. Used by Slice 2
// to encrypt access_token / refresh_token before INSERT and decrypt on read.
//
// Wire format:
//   "ENCv1:" + base64( iv (12 bytes) | authTag (16 bytes) | ciphertext (variable) )
//
// The "ENCv1:" prefix is a magic marker — isEncrypted() is a literal prefix
// check, not a heuristic. This avoids false positives where a plaintext
// secret happens to look like base64 ciphertext (which previously caused
// encrypt() to be skipped, leaving the plaintext sitting in the DB).
//
// One opaque string per encrypted value. The 12-byte IV is fresh per
// encrypt() call (never reused). The auth tag is verified in decrypt();
// any tamper produces a thrown error from decipher.final() — we let it
// propagate so callers know the value is corrupt or the key is wrong.
//
// The encryption key is loaded from CREDENTIALS_ENCRYPTION_KEY (base64,
// 32 bytes raw). The module fails fast at load time if the env var is
// missing or wrong length — we do not want to discover that on first use.
//
// Generate a key with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

const crypto = require('crypto');

const ALGORITHM  = 'aes-256-gcm';
const IV_LENGTH  = 12;   // GCM standard
const TAG_LENGTH = 16;   // GCM standard
const KEY_LENGTH = 32;   // 256 bits
const ENC_PREFIX = 'ENCv1:';

// ─────────────────────────────────────────────────────────────
// KEY LOAD — fail fast at module load
// ─────────────────────────────────────────────────────────────

const KEY = (() => {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'CREDENTIALS_ENCRYPTION_KEY env var is missing — set to a base64-encoded 32-byte key. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  // Note: Buffer.from(str, 'base64') is permissive — non-base64 characters
  // are silently dropped rather than thrown. The length check below is what
  // catches malformed input.
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== KEY_LENGTH) {
    throw new Error(
      `CREDENTIALS_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH} bytes (got ${buf.length}). ` +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  return buf;
})();

// ─────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────

/**
 * Encrypt a UTF-8 string with AES-256-GCM. Each call uses a fresh random
 * 12-byte IV, so encrypting the same plaintext twice yields different
 * ciphertexts.
 *
 * @param {string} plaintext
 * @returns {string} "ENCv1:" + base64(iv || authTag || ciphertext)
 */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt() requires a string plaintext');
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * Decrypt a value produced by encrypt(). Throws if:
 *   - the input is not a string with the ENCv1: prefix
 *   - the input is shorter than IV + tag bytes after base64 decode
 *   - the auth tag fails verification (tamper, wrong key, or corruption)
 *
 * The auth-tag failure is propagated from decipher.final() — we deliberately
 * do not catch it, so callers know the value is bad rather than seeing a
 * silent empty string.
 *
 * @param {string} encrypted
 * @returns {string}
 */
function decrypt(encrypted) {
  if (typeof encrypted !== 'string' || !encrypted.startsWith(ENC_PREFIX)) {
    throw new Error('decrypt() value is not encrypted (missing ENCv1: prefix)');
  }
  const buf = Buffer.from(encrypted.slice(ENC_PREFIX.length), 'base64');
  if (buf.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error(
      `decrypt() input too short — need at least ${IV_LENGTH + TAG_LENGTH} bytes after base64 decode, got ${buf.length}`
    );
  }
  const iv         = buf.subarray(0, IV_LENGTH);
  const tag        = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * Does `value` carry the ENCv1: marker that encrypt() emits?
 *
 * Pure prefix check — no heuristics, no false positives. A plaintext can
 * only collide if it literally starts with the string "ENCv1:", which a
 * real secret never will.
 *
 * Used by migration code (and api.hooks's encryptOauth2ClientSecret) to
 * decide whether a value still needs encrypting. Does NOT validate that
 * the payload is well-formed — that's decrypt()'s job.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
};