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
 * Phase 2's send/recall/remind endpoints belong in this file too, behind
 * jwtOrApiKey. They are not here yet.
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
const rawTextFallback = express.text({ type: '*/*', limit: '2mb' });

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

  // ── respond, then work ────────────────────────────────────────────────────
  res.status(200).json({ status: 'received' });

  const body = req.body;
  const rawBody = typeof req.rawBody === 'string'
    ? req.rawBody
    : (typeof body === 'string' ? body : null);
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