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
const { getSetting, getSettings } = require('../settingsService');
const { ZohoSignProvider } = require('./zohoSignProvider');

/** name → constructor. The whole registry. */
const PROVIDERS = Object.freeze({
  zoho_sign: ZohoSignProvider,
});

/** app_settings key holding the Connections credential id. */
const CREDENTIAL_SETTING_KEY = 'esign_credential_id';

// ─────────────────────────────────────────────────────────────────────────────
// CREDIT ACCOUNTING (slice 1C)
//
// Zoho exposes NO credit-balance endpoint — getCreditBalance() returns
// {supported:false} and 1B's smoke run confirmed GET /accounts carries nothing
// credit-shaped. So the balance is a LOCAL counter that Fred tops up by hand
// after buying credits, decremented by this module on every real send.
//
// That makes it an ESTIMATE, not a ledger. It drifts whenever an envelope is
// sent from the Zoho dashboard rather than through YisraCase, and it cannot
// self-heal because there is nothing to reconcile against. It exists to raise
// "buy more credits soon", not to be authoritative — which is exactly why the
// alert text says "approx" and points at the dashboard for the real number.
// ─────────────────────────────────────────────────────────────────────────────

const CREDIT_BALANCE_KEY    = 'esign_credit_balance';
const CREDIT_THRESHOLD_KEY  = 'esign_credit_alert_threshold';
const CREDIT_ALERT_SENT_KEY = 'esign_credit_alert_sent';

/** Zoho's API-only plan bills 5 credits per envelope. */
const CREDITS_PER_ENVELOPE = 5;

/** Used when esign_credit_alert_threshold is missing or unparseable. */
const DEFAULT_ALERT_THRESHOLD = 50;

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

/** Parse an app_settings string to an integer, or fall back. */
function _int(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * Record that a REAL (testing=false) envelope was sent: decrement the local
 * credit estimate and raise a staff task the first time it crosses below the
 * alert threshold.
 *
 * Called by Phase 2's send flow, at the point markSent succeeds — NOT from the
 * webhook, which is inbound and long past the moment credits were spent. It is
 * exported here rather than from esignService because spending credits is a
 * PROVIDER fact (Zoho's pricing), not a row fact, and esignService is
 * deliberately provider-free.
 *
 * ── ONCE PER CROSSING ───────────────────────────────────────────────────────
 * A third setting, esign_credit_alert_sent ('1' | '0'), latches the alert:
 *
 *   balance >= threshold  →  latch CLEARED (so the next fall re-arms it)
 *   balance <  threshold  →  task raised ONLY if the latch was clear, then SET
 *
 * A boolean latch beats the alternative of checking whether a matching task
 * already exists: task-existence is the wrong question (a staff member may
 * legitimately complete the task and still be below threshold — re-alerting
 * every send after that is the exact spam this prevents), and it re-arms for
 * free the moment Fred tops the balance back up. The cost is one extra
 * app_settings row, which is also the thing an admin can eyeball and reset by
 * hand if it ever gets stuck.
 *
 * NEVER THROWS. A credit-accounting failure must not fail a send that Zoho has
 * already accepted — the envelope is out, the credits are gone, and turning
 * that into a 500 would leave the caller believing the send failed. Errors are
 * logged and swallowed; the return value says what happened.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {number} [opts.credits=CREDITS_PER_ENVELOPE]
 * @returns {Promise<{ok, balance, previous, threshold, alerted, reason?}>}
 */
async function recordCreditSpend(db, { credits = CREDITS_PER_ENVELOPE } = {}) {
  try {
    const rows = await getSettings(db, [
      CREDIT_BALANCE_KEY, CREDIT_THRESHOLD_KEY, CREDIT_ALERT_SENT_KEY,
    ]);

    // A missing/blank balance means "nobody has told us the balance yet".
    // Counting down from an invented number would be worse than not counting:
    // skip, say so, and leave the row alone.
    if (rows[CREDIT_BALANCE_KEY] == null || String(rows[CREDIT_BALANCE_KEY]).trim() === '') {
      console.warn(`[ESIGN CREDITS] ${CREDIT_BALANCE_KEY} is unset — not counting down from an unknown balance`);
      return { ok: false, reason: 'balance_unset', balance: null, previous: null, threshold: null, alerted: false };
    }

    const previous  = _int(rows[CREDIT_BALANCE_KEY], 0);
    const threshold = _int(rows[CREDIT_THRESHOLD_KEY], DEFAULT_ALERT_THRESHOLD);
    const latched   = String(rows[CREDIT_ALERT_SENT_KEY] ?? '0').trim() === '1';

    // Floor at 0. A negative balance is not information — it just means the
    // manual figure was stale — and it would read as nonsense in the alert.
    const balance = Math.max(0, previous - credits);

    await db.query('UPDATE app_settings SET `value` = ? WHERE `key` = ?', [String(balance), CREDIT_BALANCE_KEY]);

    let alerted = false;
    if (balance < threshold && !latched) {
      await _raiseLowCreditTask(db, balance, threshold);
      await db.query('UPDATE app_settings SET `value` = ? WHERE `key` = ?', ['1', CREDIT_ALERT_SENT_KEY]);
      alerted = true;
    } else if (balance >= threshold && latched) {
      // Re-arm. Reached after Fred tops up and sends again.
      await db.query('UPDATE app_settings SET `value` = ? WHERE `key` = ?', ['0', CREDIT_ALERT_SENT_KEY]);
    }

    console.log(`[ESIGN CREDITS] ${previous} → ${balance} (spent ${credits}, threshold ${threshold}${alerted ? ', ALERTED' : ''})`);
    return { ok: true, balance, previous, threshold, alerted };
  } catch (err) {
    console.error('[ESIGN CREDITS] recordCreditSpend failed:', err && err.message);
    return { ok: false, reason: 'error', error: err && err.message, balance: null, previous: null, threshold: null, alerted: false };
  }
}

/**
 * Staff task for a low balance. Assignee resolution and the length rules live
 * in esignAlertService so every e-sign alert reads the same setting the same
 * way. Required lazily: this module is required at boot by the webhook route,
 * and esignAlertService pulls in taskService → emailService → the mail stack.
 * Deferring keeps that off the boot path of anything that only wants
 * getProvider().
 */
async function _raiseLowCreditTask(db, balance, threshold) {
  const esignAlertService = require('../esignAlertService');
  await esignAlertService.raiseTask(db, {
    // Well under the 100-char clip for any plausible balance.
    title: `Zoho Sign credits low: ${balance} remaining`,
    desc:
      `The local Zoho Sign credit estimate has fallen to approximately ${balance}, ` +
      `below the alert threshold of ${threshold}.\n\n` +
      `Each envelope costs ${CREDITS_PER_ENVELOPE} credits, so this is roughly ` +
      `${Math.floor(balance / CREDITS_PER_ENVELOPE)} more send(s).\n\n` +
      `THIS IS AN ESTIMATE, not a ledger. Zoho exposes no balance API, so the ` +
      `number is counted down locally from whatever was last entered by hand, and ` +
      `it drifts whenever anyone sends from the Zoho dashboard directly.\n\n` +
      `Action: check the real balance in the Zoho Sign dashboard, buy credits if ` +
      `needed, then set 'esign_credit_balance' to the true figure in ` +
      `Settings → E-Sign. Saving a value at or above ${threshold} re-arms this alert.`,
  });
}

module.exports = {
  getProvider,
  listProviders,
  recordCreditSpend,
  PROVIDERS,
  CREDENTIAL_SETTING_KEY,
  CREDIT_BALANCE_KEY,
  CREDIT_THRESHOLD_KEY,
  CREDIT_ALERT_SENT_KEY,
  CREDITS_PER_ENVELOPE,
  DEFAULT_ALERT_THRESHOLD,
};