// services/esign/index.js
//
/**
 * E-Sign PROVIDER LAYER — factory + the neutral provider contract.
 * services/esign/index.js
 *
 * Phase 1B. This directory is the only place in the codebase that knows a
 * signature vendor exists. Everything above it (routes, sequences, the
 * reconciliation job, the webhook) talks to the interface documented below;
 * everything below it is vendor dialect.
 *
 * Layer map:
 *
 *   routes / sequences / jobs          ← callers
 *          │
 *          ├──→ services/esignService.js      DATA  (slice 1A) — rows, audit
 *          │                                          trail, status transitions
 *          └──→ services/esign/index.js       WIRE  (slice 1B) — this file
 *                     │
 *                     └──→ zohoSignProvider.js         vendor dialect
 *
 * The two halves are peers, not a stack: esignService NEVER calls a provider
 * and a provider NEVER touches signing_requests. Slice 1C is what joins them
 * (send → markSent, webhook → applyStatus). That separation is why 1A shipped
 * testable with no network and why this ships testable with no database.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *
 *   const { getProvider } = require('../services/esign');
 *   const provider = await getProvider(db);            // default: zoho_sign
 *   const { providerId, status } = await provider.sendForSignature({ ... });
 *
 * getProvider is ASYNC because it resolves the credential from app_settings
 * and FAILS LOUDLY when that is missing. It does not fail open. A half-working
 * send is worse than no send: a retainer that silently never reaches the
 * client is a file that quietly stalls, and nobody finds out until the 341
 * hearing. lib/firmConfig's fail-open posture is right for a logo URL and
 * wrong for this.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE PROVIDER CONTRACT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Every method is async. Every method throws a TYPED error (below) rather than
 * returning a falsy sentinel. No vendor-shaped value crosses this boundary
 * except `providerId`, which is deliberately opaque — callers store it and
 * hand it back, they never parse it.
 *
 * ── Neutral types ───────────────────────────────────────────────────────────
 *
 *   Recipient        { name: string|null, email: string, order: number }
 *                    `order` is 1-BASED and is the identity a placement's
 *                    `signer` refers to. It is NOT an array index.
 *
 *   Placements       { coord_space: 'pdf_user_space',
 *                      fields: [ Placement, ... ] }
 *
 *   Placement        { page:   number,   // 1-BASED
 *                      x:      number,   // points, from the page's LEFT edge
 *                      y:      number,   // points, from the page's BOTTOM edge
 *                      w:      number,   // points
 *                      h:      number,   // points
 *                      type:   'signature' | 'initial' | 'date',
 *                      signer: number }  // matches Recipient.order
 *
 *                    coord_space is PDF user space: origin bottom-left, 72dpi,
 *                    (x,y) is the field box's BOTTOM-LEFT corner. Providers
 *                    convert; callers never think in vendor coordinates.
 *
 *   Status           one of esignService.STATUSES —
 *                    draft | sent | viewed | signed | declined | expired |
 *                    recalled | bounced | satisfied_external
 *                    ...or null when the vendor reported a status we do not
 *                    recognize. null is intentional: coercing an unknown
 *                    vendor string into a known one could drive a wrong state
 *                    transition in esignService.applyStatus. Every method that
 *                    can return null also returns `providerStatus` with the
 *                    raw string, so nothing is lost.
 *
 * ── Methods ─────────────────────────────────────────────────────────────────
 *
 *   sendForSignature({ pdfBuffer, documentName, recipients, placements,
 *                      expirationDays?, testing?, pageInfo? })
 *       → { providerId, status, providerStatus, testing, raw }
 *     Uploads and sends in one call from the caller's point of view.
 *     `testing` defaults to the esign_test_mode setting; pass it explicitly
 *     only to override. `pageInfo` ({width,height} in points, default US
 *     Letter 612x792) feeds the coordinate transform.
 *
 *   recall(providerId, reason?)
 *       → { status: 'recalled', reasonSentToProvider, reason, raw }
 *     Cancels an in-flight envelope. `reasonSentToProvider` tells the caller
 *     whether the vendor actually recorded the reason — Zoho does not, so the
 *     caller must log it locally rather than assume the recipient sees it.
 *
 *   remind(providerId, recipientEmail?)
 *       → { ok: true, remindedAll, recipientEmail, raw }
 *     Re-sends the signing invitation. `remindedAll: true` means the vendor
 *     nudged EVERY pending recipient, not just the one named — the caller must
 *     not tell a user otherwise.
 *
 *   getStatus(providerId)
 *       → { status, providerStatus, recipients: [ {name, email, order, status,
 *           signed_at, ip} ], raw }
 *     recipients[].status uses the same vocabulary, plus 'pending' for a
 *     recipient whose turn has not come in a sequential envelope.
 *
 *   downloadSignedPdf(providerId, { withCoc?, merge? })   → Buffer
 *   downloadCompletionCertificate(providerId)             → Buffer
 *
 *   getCreditBalance()
 *       → { credits: number|null, supported: boolean, raw }
 *     `supported: false` means the vendor exposes no balance on this plan.
 *     Slice 1C's low-credit alert must branch on this, not on credits == null.
 *
 *   listInProgress({ rowCap?, pageSize? })
 *       → { items: [ {providerId, status, providerStatus, documentName} ],
 *           capped, pagesFetched }
 *     Pages internally. `capped: true` means the result is TRUNCATED and the
 *     reconciliation job must not treat absence from `items` as evidence a
 *     document is finished.
 *
 * ── Error contract ──────────────────────────────────────────────────────────
 *
 *   err.code = 'ESIGN_NOT_CONFIGURED'   no esign_credential_id setting.
 *                                       Thrown by getProvider, before any
 *                                       network call.
 *   err.code = 'ESIGN_UNKNOWN_PROVIDER' provider name not in PROVIDERS.
 *   err.code = 'ESIGN_AUTH_ERROR'       token fetch/refresh failed.
 *                                       .cause carries oauthService's error.
 *   err.code = 'ESIGN_INVALID_INPUT'    caller-side mistake (bad placement,
 *                                       missing recipient email, ...).
 *                                       Thrown BEFORE any network call, so it
 *                                       never costs a credit.
 *   err.code = 'ESIGN_PROVIDER_ERROR'   the vendor rejected the call.
 *                                       .provider, .httpStatus, .providerCode,
 *                                       .providerMessage. Raw fetch/undici
 *                                       errors never escape; a network failure
 *                                       or timeout arrives here with
 *                                       .httpStatus === 0.
 *
 * ── ADDING A SECOND PROVIDER ────────────────────────────────────────────────
 * Write services/esign/<name>Provider.js exporting a class with the methods
 * above, add one line to PROVIDERS, done. No caller changes: esignService
 * already stores `provider` per row and getByProviderId is scoped by it.
 */

const esignService = require('../esignService');
const { getSetting } = require('../settingsService');
const { ZohoSignProvider } = require('./zohoSignProvider');

/** name → constructor. The whole registry. */
const PROVIDERS = Object.freeze({
  zoho_sign: ZohoSignProvider,
});

/** app_settings key holding the Connections credential id. */
const CREDENTIAL_SETTING_KEY = 'esign_credential_id';

function _err(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Build a provider instance.
 *
 * @param {object} db                  mysql2 promise pool (req.db)
 * @param {string} [providerName]      defaults to esignService.DEFAULT_PROVIDER
 * @returns {Promise<object>}          provider instance (see contract above)
 * @throws  ESIGN_UNKNOWN_PROVIDER | ESIGN_NOT_CONFIGURED
 */
async function getProvider(db, providerName) {
  if (!db) throw _err('ESIGN_INVALID_INPUT', 'getProvider: db is required');

  const name = providerName || esignService.DEFAULT_PROVIDER;
  const Ctor = PROVIDERS[name];
  if (!Ctor) {
    throw _err(
      'ESIGN_UNKNOWN_PROVIDER',
      `esign: unknown provider "${name}" (known: ${Object.keys(PROVIDERS).join(', ')})`
    );
  }

  // Resolve the credential HERE, not lazily inside the first API call, so a
  // misconfiguration surfaces at the top of the call stack with a message that
  // names the fix — rather than as an auth failure three layers down.
  let raw;
  try {
    raw = await getSetting(db, CREDENTIAL_SETTING_KEY);
  } catch (err) {
    throw _err(
      'ESIGN_NOT_CONFIGURED',
      `esign: could not read app_settings.${CREDENTIAL_SETTING_KEY}: ${err.message}`
    );
  }

  if (raw == null || String(raw).trim() === '') {
    throw _err(
      'ESIGN_NOT_CONFIGURED',
      `esign: app_settings.${CREDENTIAL_SETTING_KEY} is missing or blank — ` +
      `set it to the Connections credential id for ${name} (Settings → E-Sign). ` +
      `Refusing to send: a half-configured signature request must fail loudly.`
    );
  }

  return new Ctor(db, { credentialId: String(raw).trim() });
}

/** Names this build can serve. */
function listProviders() {
  return Object.keys(PROVIDERS);
}

module.exports = {
  getProvider,
  listProviders,
  PROVIDERS,
  CREDENTIAL_SETTING_KEY,
};