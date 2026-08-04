// lib/signatureValidation.js
//
/**
 * Shared validation/coercion for email signature fields.
 *
 * Used by:
 *   routes/api.emailCredentials.js  — SU admin editor (Connections)
 *   routes/api.mySignatures.js     — self-service editor (Settings)
 *
 * Signatures live on email_credentials (the SENDING IDENTITY), so both
 * editors write the same columns and must enforce the same rules.
 */

// Size caps. The columns are MEDIUMTEXT/TEXT (16MB/64KB), but a legitimate
// signature is a couple of KB. Guards against paste accidents, not attackers.
const SIGNATURE_MAX = { signature_html: 65535, signature_text: 8192 };

/**
 * Validate signature fields present in a request body.
 * Absent/null fields pass (they mean "no change" or "no signature").
 * @returns {string|null} error message, or null when valid
 */
function validateSignatures(body) {
  for (const f of Object.keys(SIGNATURE_MAX)) {
    const v = body[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return `${f} must be a string`;
    if (v.length > SIGNATURE_MAX[f]) {
      return `${f} exceeds the ${SIGNATURE_MAX[f]} character limit (got ${v.length})`;
    }
  }
  return null;
}

/**
 * Coerce a signature value for storage: blank/whitespace-only → NULL, so
 * `signature_html IS NOT NULL` stays a reliable "has a signature" test at
 * send time. Non-blank content is stored VERBATIM (no trim — leading
 * whitespace inside stored HTML is the author's business).
 */
function coerceSignature(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : String(value);
}

/** Summarize a signature value for audit rows: '(N chars)' or null. */
function summarizeForAudit(value) {
  return value == null ? null : `(${String(value).length} chars)`;
}

module.exports = { SIGNATURE_MAX, validateSignatures, coerceSignature, summarizeForAudit };
