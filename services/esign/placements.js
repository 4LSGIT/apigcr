// services/esign/placements.js
//
/**
 * NEUTRAL PLACEMENT SCHEMA — the validator, and only the validator.
 * services/esign/placements.js
 *
 * Phase 2A. Extracted from zohoSignProvider.neutralToZohoFields, which until
 * now was both the validator and the Zoho coordinate transform. The transform
 * stays where it belongs (vendor dialect); the schema rules move here because
 * TWO layers need them and neither should own the other:
 *
 *   services/esignSendService.js   validates BEFORE createRequest, so a bad
 *                                  placement never mints an orphan draft row
 *   services/esign/zohoSignProvider.js
 *                                  validates before the network call, so a bad
 *                                  placement never costs an API call or credit
 *
 * The alternative — the neutral send service requiring a file called
 * `zohoSignProvider` to find out whether ITS input is well formed — would put
 * the vendor's name in the one layer whose whole job is not knowing it.
 *
 * ── THE SCHEMA ──────────────────────────────────────────────────────────────
 *
 *   { coord_space: 'pdf_user_space',          // optional; only value accepted
 *     fields: [ { page:   number,   // 1-BASED
 *                 x:      number,   // points, from the page's LEFT edge
 *                 y:      number,   // points, from the page's BOTTOM edge
 *                 w:      number,   // points
 *                 h:      number,   // points
 *                 type:   'signature' | 'initial' | 'date',
 *                 signer: number }, // matches Recipient.order (1-based)
 *               ... ] }
 *
 * An EMPTY fields array is schema-valid. It is not necessarily SENDABLE —
 * Zoho rejects a submit whose actions carry no fields — but that is a provider
 * fact, and this file does not know about providers.
 *
 * Errors carry code 'ESIGN_INVALID_INPUT', matching the provider contract, so
 * callers already switching on that code need no change. Messages are NOT
 * vendor-prefixed here: this layer has no vendor.
 */

/** Neutral field types. The provider maps these to its own descriptors. */
const NEUTRAL_FIELD_TYPES = Object.freeze(['signature', 'initial', 'date']);

/**
 * Neutral `page` numbers are 1-BASED (the schema's example is "page":3).
 * Lives here rather than in the provider because it is a property of the
 * NEUTRAL schema; the provider's 0-based page_no is the thing that converts.
 */
const NEUTRAL_PAGE_BASE = 1;

function inputError(message) {
  const err = new Error(message);
  err.code = 'ESIGN_INVALID_INPUT';
  return err;
}

/**
 * Validate a neutral placements object. Throws on the first problem; returns
 * a normalized summary on success.
 *
 * PURE. No ids, no network, no db — callable from anywhere, at any point,
 * including before a row exists.
 *
 * @param {object} placements
 * @returns {{count:number, signers:number[]}} field count and the distinct
 *          1-based signer orders referenced, ascending.
 * @throws  ESIGN_INVALID_INPUT
 */
function validatePlacements(placements) {
  if (!placements || typeof placements !== 'object') {
    throw inputError('placements must be an object');
  }
  const { coord_space: coordSpace, fields } = placements;

  // Guard rather than silently mis-transform. The neutral schema declares one
  // coord space; if a caller ever introduces another, the provider's y-flip is
  // wrong and we want a throw, not a document with signatures in the margin.
  if (coordSpace != null && coordSpace !== 'pdf_user_space') {
    throw inputError(`unsupported coord_space "${coordSpace}" (expected pdf_user_space)`);
  }
  if (!Array.isArray(fields)) {
    throw inputError('placements.fields must be an array');
  }

  const signers = new Set();

  fields.forEach((f, i) => {
    if (!f || typeof f !== 'object') {
      throw inputError(`placements.fields[${i}] must be an object`);
    }
    if (!NEUTRAL_FIELD_TYPES.includes(f.type)) {
      throw inputError(
        `placements.fields[${i}].type "${f.type}" unsupported ` +
        `(expected one of: ${NEUTRAL_FIELD_TYPES.join(', ')})`
      );
    }

    const signer = Number.isInteger(f.signer) ? f.signer : 1;
    const page   = Number.isInteger(f.page)   ? f.page   : NEUTRAL_PAGE_BASE;
    if (page - NEUTRAL_PAGE_BASE < 0) {
      throw inputError(`placements.fields[${i}].page ${page} is below the 1-based minimum`);
    }

    for (const k of ['x', 'y', 'w', 'h']) {
      if (!Number.isFinite(Number(f[k]))) {
        throw inputError(`placements.fields[${i}].${k} must be a finite number`);
      }
    }

    signers.add(signer);
  });

  return { count: fields.length, signers: [...signers].sort((a, b) => a - b) };
}

module.exports = {
  validatePlacements,
  NEUTRAL_FIELD_TYPES,
  NEUTRAL_PAGE_BASE,
};