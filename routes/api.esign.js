// routes/api.esign.js
//
/**
 * E-Sign routes.
 * routes/api.esign.js
 *
 * Phase 1C ships exactly one endpoint:
 *
 *   POST /webhooks/esign/zoho?token=…   — PUBLIC receiver. Auth is the token.
 *
 * Phase 2's authed endpoints deliberately do NOT live in this file. They are
 * in routes/api.esign.actions.js (send/recall/remind/resend/list) and
 * routes/api.esign.templates.js (templates/preview/prefills/send-from-
 * template) precisely so no future edit can accidentally hang jwtOrApiKey on
 * the public webhook below (breaking inbound delivery) or leave it off an
 * action route (opening a send endpoint to the internet). Keep this file
 * webhook-only.
 *
 * ── WHY THIS ENDPOINT IS UNAUTHENTICATED ────────────────────────────────────
 * There is no global auth middleware in this app. server.js mounts every
 * routes/*.js file with app.use() and each route opts IN to protection by
 * naming jwtOrApiKey as its own middleware. So "public" is not a bypass, an
 * exemption or an ordering trick — it is simply the absence of that argument,
 * exactly as POST /hooks/:slug does it in routes/api.hooks.js.
 *
 * Zoho cannot present a JWT and cannot be given an API key header (its webhook
 * config is a URL), so the shared secret rides in the query string. That is
 * the same posture as the hook receiver, whose per-hook auth also lives in the
 * request rather than in our session layer.
 *
 * ── THE 200-THEN-WORK PATTERN ───────────────────────────────────────────────
 * The handler responds BEFORE doing the work, then runs the pipeline
 * fire-and-forget with a .catch. This copies POST /hooks/:slug verbatim
 * (api.hooks.js: `res.json(...)` then `hookService.executeHook(...).catch(...)`)
 * and it is the right shape for a webhook: filing a signed document means two
 * Zoho downloads and two Dropbox uploads, which can run to tens of seconds.
 * Holding the connection open for that invites Zoho's own timeout, and a
 * timeout is indistinguishable from a failure — so it would retry, and the
 * retry would race the work still in flight.
 *
 * The cost is that a crash between the response and the end of the pipeline
 * loses that delivery. That is ACCEPTED, not ignored, because the nightly
 * reconciliation job closes it: pass A re-checks every outstanding row against
 * Zoho, and pass B re-files any row that is signed but has no stored PDF path.
 * A dropped webhook costs at most a day's delay, never a lost document.
 *
 * ── BODY PARSING ────────────────────────────────────────────────────────────
 * Zoho's webhook content-type is not documented. server.js's global
 * express.json + express.urlencoded already cover the two likely cases; the
 * scoped express.text below catches everything else. body-parser sets
 * req._body once something has parsed, and every parser short-circuits on it,
 * so the text parser can never double-read or clobber an earlier parse.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');

const esignWebhookService = require('../services/esignWebhookService');

/** Where Zoho is told to POST. Kept here so the checkpoint script can print it. */
const WEBHOOK_PATH = '/webhooks/esign/zoho';

/**
 * Rate limit by IP. Looser than the hook receiver's 120/min because a single
 * multi-recipient envelope can emit a burst, and Zoho retries on top of that;
 * tight enough that a leaked token cannot be used to hammer the DB.
 */
const esignWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  keyGenerator: (req) => `esign:${req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error' },
  validate: false,
});

/**
 * Catch-all body parser for content-types the global parsers ignore.
 * No-ops when req._body is already set.
 */
const rawTextFallback = express.text({
  type: '*/*',
  limit: '2mb',
  // Exact wire bytes for HMAC (see server.js's /webhooks hooks): the string
  // body express.text produces has been through a UTF-8 decode, which is not
  // reversible for invalid sequences. Signature verification prefers this
  // Buffer; the string keeps serving payload capture.
  verify: (req, res, buf) => { req.rawBodyBuf = buf; },
});

/**
 * POST /webhooks/esign/zoho?token=…
 *
 * Responses are deliberately terse. A caller that fails the token check learns
 * only that it failed — no hint about whether the token was absent, wrong, or
 * unconfigured, since all three are the same answer to anyone who should not
 * be here.
 */
router.post(WEBHOOK_PATH, esignWebhookLimiter, rawTextFallback, async (req, res) => {
  const db = req.db;

  // ── auth ──────────────────────────────────────────────────────────────────
  // Runs first and is fully independent of the body. An unparseable payload
  // with a GOOD token is a 200 (we want to capture it); any payload with a bad
  // token is a 401 (we do not want to look at it at all).
  let verdict;
  try {
    verdict = await esignWebhookService.verifyToken(db, req.query && req.query.token);
  } catch (err) {
    console.error('[ESIGN WEBHOOK] token verification threw:', err.message);
    return res.status(401).json({ status: 'error' });
  }

  if (!verdict.ok) {
    console.warn(
      `[ESIGN WEBHOOK] rejected delivery from ip=${req.ip}: ${verdict.reason}` +
      (verdict.reason === 'token_unset'
        ? ` — app_settings '${esignWebhookService.WEBHOOK_TOKEN_KEY}' is empty, so the endpoint is closed`
        : '')
    );
    return res.status(401).json({ status: 'error' });
  }

  // ── hmac gate ─────────────────────────────────────────────────────────────
  // Second lock on the same door: the URL token proves the caller knows the
  // URL; the signature proves the caller holds Zoho's webhook secret AND that
  // the body wasn't altered in flight. Verification runs over the verbatim
  // bytes (req.rawBody — captured by server.js's verify hooks; the text
  // fallback's string body IS the raw bytes), never over a re-serialization.
  //
  // Mode semantics live in esignWebhookService (see WEBHOOK_HMAC_MODE_KEY):
  // secret unset = off; 'enforce' rejects failures; anything else is log-only
  // so the header's real-world shape can be observed before it is trusted to
  // gate deliveries.
  const body = req.body;
  const rawBody = typeof req.rawBody === 'string'
    ? req.rawBody
    : (typeof body === 'string' ? body : null);
  // Exact bytes beat decoded text: a Buffer captured by a verify hook is the
  // wire payload verbatim; the string is a UTF-8 decode of it and can differ
  // on invalid sequences. handleZohoWebhook still receives the STRING —
  // payload capture wants readable text, only the MAC wants bytes.
  const rawBytes = Buffer.isBuffer(req.rawBodyBuf) ? req.rawBodyBuf : rawBody;

  const hmac = await esignWebhookService.evaluateHmac(db, {
    rawBody: rawBytes,
    signature: req.get(esignWebhookService.SIGNATURE_HEADER),
  });
  if (hmac.mode !== 'off') {
    const detail =
      `mode=${hmac.mode} ok=${hmac.ok} reason=${hmac.reason}` +
      (hmac.presented ? ` presented=${hmac.presented}…` : '') +
      (hmac.expected ? ` expected=${hmac.expected}…` : '');
    if (hmac.mode === 'enforce' && !hmac.ok) {
      console.warn(`[ESIGN WEBHOOK] hmac REJECTED delivery from ip=${req.ip}: ${detail}`);
      return res.status(401).json({ status: 'error' });
    }
    // Log-only mode narrates every verdict; enforce mode narrates passes too,
    // so a healthy hmac leaves the same evidence trail either way.
    (hmac.ok ? console.log : console.warn)(`[ESIGN WEBHOOK] hmac ${detail}`);
  }

  // ── respond, then work ────────────────────────────────────────────────────
  res.status(200).json({ status: 'received' });

  const ip = req.ip;

  Promise.resolve()
    .then(() => esignWebhookService.handleZohoWebhook(db, { body, rawBody, ip }))
    .then((out) => {
      if (out && out.ok === false) {
        console.error('[ESIGN WEBHOOK] pipeline reported failure:', JSON.stringify(out).slice(0, 500));
      }
    })
    .catch((err) => {
      // Nothing to tell Zoho — it already has its 200. Loud in the logs, and
      // reconciliation will pick up whatever this delivery would have done.
      console.error('[ESIGN WEBHOOK] pipeline threw:', err && err.stack ? err.stack : err);
    });
});

module.exports = router;
module.exports.WEBHOOK_PATH = WEBHOOK_PATH;