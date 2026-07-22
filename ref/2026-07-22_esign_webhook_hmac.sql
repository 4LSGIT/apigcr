-- ─────────────────────────────────────────────────────────────────────────────
-- E-SIGN WEBHOOK HMAC — settings (2026-07-22)
--
-- Adds signature verification of Zoho Sign webhook deliveries as a SECOND
-- lock alongside the URL token: base64(HMAC-SHA256(secret, raw request
-- body)) presented in the X-ZS-WEBHOOK-SIGNATURE header.
--
-- DEPLOY ORDER: either direction is inert —
--   * code before SQL: getHmacConfig finds no rows → mode 'off' → behavior
--     byte-identical to before the feature existed.
--   * SQL before code: two settings rows nobody reads.
-- Convention says SQL → code; follow it.
--
-- ROLLOUT (deliberately three steps — do NOT jump to enforce):
--   1. Run this migration. Nothing changes yet (secret is empty = off).
--   2. Copy the webhook "secret key" from Zoho Sign's webhook configuration
--      (Zoho Sign admin → Settings → Webhooks → the configured hook) into
--      esign_webhook_secret. Mode defaults to log-only: every delivery's
--      signature is now verified and the verdict logged
--      ('[ESIGN WEBHOOK] hmac …' in Cloud Run logs) but NOTHING is rejected.
--   3. Trigger a real delivery (view/sign a test envelope), grep the logs.
--        reason=match                              → flip mode to 'enforce'.
--        reason=mismatch_but_hex_encoding_matched  → Zoho sends hex, not
--          base64 — one-line code fix in evaluateHmac, do not enforce yet.
--        reason=signature_missing                  → Zoho isn't sending the
--          header for this webhook config — investigate before enforcing.
--      Only after an observed 'match': set esign_webhook_hmac_mode='enforce'.
--
-- WHY LOG-FIRST: the header name/encoding come from documentation, not from
-- a captured delivery. Enforcing an untested assumption silently stops ALL
-- inbound signing status (endpoint fails closed) until nightly reconcile.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES
  ('esign_webhook_secret', '', 1, 0, 'E-Sign',
   'E-Sign Webhook HMAC Secret',
   'Zoho Sign webhook secret key, copied verbatim from the webhook configuration in the Zoho Sign admin console. EMPTY disables signature verification entirely (URL token only, the pre-2026-07-22 posture). When set, each delivery''s X-ZS-WEBHOOK-SIGNATURE header is verified as base64 HMAC-SHA256 of the raw body; esign_webhook_hmac_mode decides whether a failure is logged or rejected.',
   'text', 31)
ON DUPLICATE KEY UPDATE
  is_secret   = VALUES(is_secret),
  is_editable = VALUES(is_editable),
  category    = VALUES(category),
  label       = VALUES(label),
  description = VALUES(description),
  type        = VALUES(type),
  sort_order  = VALUES(sort_order);
  -- `value` deliberately absent: re-running must not clear a live secret.

INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES
  ('esign_webhook_hmac_mode', 'log', 0, 1, 'E-Sign',
   'E-Sign Webhook HMAC Mode',
   'Only meaningful once esign_webhook_secret is set. ''enforce'' = a delivery whose signature is missing or wrong is rejected with 401. Any other value (including empty) = log-only: verification runs and its verdict appears in the logs as ''[ESIGN WEBHOOK] hmac …'', but no delivery is ever rejected. Flip to enforce ONLY after logs show reason=match on a real delivery.',
   'text', 32)
ON DUPLICATE KEY UPDATE
  is_secret   = VALUES(is_secret),
  is_editable = VALUES(is_editable),
  category    = VALUES(category),
  label       = VALUES(label),
  description = VALUES(description),
  type        = VALUES(type),
  sort_order  = VALUES(sort_order);
  -- `value` deliberately absent: re-running must not un-enforce a live mode.

-- ─────────────────────────────────────────────────────────────────────────────
-- TOKEN ROTATION (run separately, during the rotation window — NOT part of
-- the migration). The current token has appeared in Cloud Run request logs;
-- verifyToken now accepts comma-separated candidates, making rotation a pure
-- data operation with zero downtime:
--
--   -- 1. Append a fresh token IN FRONT of the current one (both now valid):
--   UPDATE app_settings
--      SET `value` = CONCAT(LOWER(HEX(RANDOM_BYTES(32))), ',', `value`)
--    WHERE `key` = 'esign_webhook_token';
--
--   -- 2. Read it back (readonly endpoint can't — is_secret; use mysql client
--   --    or the temp proxy), take the part BEFORE the comma, and update the
--   --    webhook URL in the Zoho Sign admin console to ?token=<new>.
--
--   -- 3. After a delivery confirms the new token works (webhook log line or
--   --    a signing_request_events row), drop the old one:
--   UPDATE app_settings
--      SET `value` = SUBSTRING_INDEX(`value`, ',', 1)
--    WHERE `key` = 'esign_webhook_token';
-- ─────────────────────────────────────────────────────────────────────────────

-- Verify:
SELECT `key`, `value` = '' AS is_empty, is_secret, is_editable, sort_order
  FROM app_settings
 WHERE `key` IN ('esign_webhook_secret', 'esign_webhook_hmac_mode', 'esign_webhook_token');
