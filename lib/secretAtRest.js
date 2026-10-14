// lib/secretAtRest.js
//
// Secret VALUES inside JSON config columns, encrypted at rest (access-control
// B4, ref/ACCESS_CONTROL_DESIGN.md §5.5). Only the named fields are encrypted
// — the rest of the JSON (header names, schemes, allowed_urls, client ids)
// stays readable, because sessions legitimately query it.
//
//   credentials.config  per credentials.type  (decrypted only in
//                        lib/credentialInjection.buildAuthHeaders and the SU
//                        /api/credentials/:id/reveal route)
//   hooks.auth_config   per hooks.auth_type   (decrypted only in
//                        services/hookService.authenticateRequest and, for the
//                        editor's display, getHookById / listHooks)
//
// Format: lib/credentialCrypto ENCv1 (AES-256-GCM, CREDENTIALS_ENCRYPTION_KEY).
// DUAL-READ: readSecret() decrypts an ENCv1 value and passes anything else
// through, so a row written before the B4 data migration (plaintext) and one
// written after (ciphertext) both work — in either deploy order of code vs
// data. Writes go through encryptFields(), idempotent on already-encrypted
// values, so a UI re-save of a value it was shown never double-encrypts.

'use strict';

const credentialCrypto = require('./credentialCrypto');

const CREDENTIAL_SECRET_FIELDS = Object.freeze({
  oauth2:   Object.freeze(['client_secret']),
  api_key:  Object.freeze(['key']),
  bearer:   Object.freeze(['token']),
  basic:    Object.freeze(['password']),     // username is an identifier, not a secret
  internal: Object.freeze([]),
});

const HOOK_SECRET_FIELDS = Object.freeze({
  api_key: Object.freeze(['key']),
  hmac:    Object.freeze(['secret']),
  none:    Object.freeze([]),
});

/** ENCv1 → plaintext; anything else unchanged (pre-migration plaintext). */
function readSecret(v) {
  return credentialCrypto.isEncrypted(v) ? credentialCrypto.decrypt(v) : v;
}

/** Fields that are secret for this type in this table's map ([] if unknown). */
function fieldsFor(map, type) {
  return Object.prototype.hasOwnProperty.call(map, type) ? map[type] : [];
}

/**
 * A COPY of config with each named field encrypted when it is a non-empty
 * plaintext string. Already-encrypted, empty and non-string values are left
 * as they are. Non-object configs are returned unchanged.
 */
function encryptFields(config, fields) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
  const out = { ...config };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === 'string' && v.length > 0 && !credentialCrypto.isEncrypted(v)) {
      out[f] = credentialCrypto.encrypt(v);
    }
  }
  return out;
}

/** A COPY of config with each named field run through readSecret(). Throws on a bad ciphertext. */
function decryptFields(config, fields) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
  const out = { ...config };
  for (const f of fields) if (out[f] != null) out[f] = readSecret(out[f]);
  return out;
}

/** Parse a JSON column value (mysql2 parses JSON columns; strings tolerated). */
function parseJsonColumn(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

module.exports = {
  CREDENTIAL_SECRET_FIELDS, HOOK_SECRET_FIELDS,
  readSecret, fieldsFor, encryptFields, decryptFields, parseJsonColumn,
};
