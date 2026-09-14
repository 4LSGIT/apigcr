-- ============================================================================
-- 2026-07-19_esign_phase1c.sql
-- Zoho Sign e-signature — Phase 1C: webhook receiver, filing, reconciliation,
-- credit accounting.
--
-- DEPENDS ON: 2026-07-19_esign_phase1a.sql (signing_requests,
--             signing_request_events) and _phase1b.sql. Both are already
--             APPLIED on the live server — verified 2026-07-19: both tables
--             exist, signing_requests is empty, app_settings already holds
--             esign_credential_id=13 and esign_test_mode=1.
--
-- NO SCHEMA CHANGES. 1C adds no tables and alters no columns; everything it
-- needs already exists. This file only seeds configuration rows.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- DEPLOY THE CODE FIRST, THEN RUN THIS.
--
-- The reverse order creates a window where the scheduled job exists and names
-- a function the running build does not have. lib/internal_functions/index.js
-- resolves by name at call time, so the job would fail, retry, and raise noise
-- until the deploy lands. Code-first is inert: the new route 401s every
-- delivery until esign_webhook_token exists (it fails CLOSED by design), and
-- nothing calls esign_reconcile until its job row is here.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- Safe to re-run. Every settings INSERT refreshes the metadata columns but
-- deliberately PRESERVES `value` — re-running must never rotate the webhook
-- token out from under a configured Zoho account, nor reset a credit balance
-- Fred has just topped up. The scheduled job insert is guarded on the function
-- name rather than on a fixed id.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. WEBHOOK SHARED SECRET
--
-- Zoho cannot present a JWT or an API-key header — its webhook configuration
-- is a bare URL — so the secret rides in the query string and IS the auth for
-- POST /webhooks/esign/zoho.
--
-- Generated server-side by RANDOM_BYTES(32) so no secret is ever committed to
-- the repo, and so nobody is tempted to reuse one from a password manager.
-- 64 hex characters.
--
-- is_secret  = 1  → never returned by any settings API, and the internal
--                   get_setting function refuses it outright. The webhook
--                   service therefore reads app_settings directly; that is
--                   intentional and documented at the call site.
-- is_editable= 0  → not exposed in settings.html. Rotating it means updating
--                   Zoho's webhook URL in the same breath, so it is a
--                   deliberate two-step operation, not a text box someone can
--                   clear by accident and silently kill all inbound status.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES
  ('esign_webhook_token', LOWER(HEX(RANDOM_BYTES(32))), 1, 0, 'E-Sign',
   'E-Sign Webhook Token',
   'Shared secret in the Zoho Sign webhook URL. Zoho cannot send auth headers, so this query parameter is the only thing standing between the internet and our signing-status endpoint. Generated automatically. To rotate: set a new 64-char hex value here AND update the webhook URL in the Zoho Sign admin console in the same maintenance window - the endpoint fails closed, so a mismatch silently stops all inbound signing updates until the nightly reconciliation job catches up.',
   'text', 30)
ON DUPLICATE KEY UPDATE
  is_secret   = VALUES(is_secret),
  is_editable = VALUES(is_editable),
  category    = VALUES(category),
  label       = VALUES(label),
  description = VALUES(description),
  type        = VALUES(type),
  sort_order  = VALUES(sort_order);
  -- `value` deliberately absent: re-running must not rotate a live token.


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. CREDIT ACCOUNTING
--
-- Zoho publishes NO credit-balance endpoint. 1B's live smoke run confirmed
-- GET /accounts returns nothing credit-shaped, and the provider's
-- getCreditBalance() honestly returns {supported:false} rather than guessing.
--
-- So the balance is a LOCAL ESTIMATE: Fred enters the real figure after buying
-- credits, and services/esign/index.js recordCreditSpend() counts it down by 5
-- per live envelope. It drifts whenever anyone sends from the Zoho dashboard
-- instead of YisraCase, and it cannot self-heal because there is nothing to
-- reconcile against. It exists to say "buy more soon", not to be authoritative
-- — which is why the alert text calls it an estimate and points at the
-- dashboard for the true number.
--
-- Left EMPTY on purpose. An unset balance makes recordCreditSpend skip and
-- warn; a seeded guess would count down confidently from a number nobody
-- chose. Fred fills this in at production cutover, when he knows the figure.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES
  ('esign_credit_balance', NULL, 0, 1, 'E-Sign',
   'E-Sign Credit Balance (estimate)',
   'Approximate Zoho Sign credits remaining. Zoho has no balance API, so this is counted down locally by 5 per live envelope and must be re-entered by hand after buying credits. Leave blank to disable credit tracking entirely. Check the Zoho Sign dashboard for the true balance.',
   'number', 40)
ON DUPLICATE KEY UPDATE
  is_secret = VALUES(is_secret), is_editable = VALUES(is_editable),
  category  = VALUES(category),  label       = VALUES(label),
  description = VALUES(description), type = VALUES(type), sort_order = VALUES(sort_order);

INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES
  ('esign_credit_alert_threshold', '50', 0, 1, 'E-Sign',
   'E-Sign Low-Credit Alert Threshold',
   'Raise a staff task when the estimated credit balance falls below this number. 50 credits is 10 envelopes. Only meaningful when a credit balance has been entered above.',
   'number', 50)
ON DUPLICATE KEY UPDATE
  is_secret = VALUES(is_secret), is_editable = VALUES(is_editable),
  category  = VALUES(category),  label       = VALUES(label),
  description = VALUES(description), type = VALUES(type), sort_order = VALUES(sort_order);

-- The once-per-crossing latch. NOT editable: this is machine state, not
-- configuration. Its documented reset is setting the balance back at or above
-- the threshold, which clears it automatically on the next send. Exposing it
-- in settings.html would invite someone to "fix" a stuck alert in the one way
-- that also suppresses a real one.
INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES
  ('esign_credit_alert_sent', '0', 0, 0, 'E-Sign',
   'E-Sign Low-Credit Alert Latch',
   'Internal. 1 = the low-credit task has already been raised for the current dip below the threshold, so further sends stay quiet. Cleared automatically the first time a send leaves the balance at or above the threshold. Not user-configurable.',
   'text', 60)
ON DUPLICATE KEY UPDATE
  is_secret = VALUES(is_secret), is_editable = VALUES(is_editable),
  category  = VALUES(category),  label       = VALUES(label),
  description = VALUES(description), type = VALUES(type), sort_order = VALUES(sort_order);


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. NIGHTLY RECONCILIATION JOB
--
-- Shape copied from the live recurring rows (ids 1187, 1451, 1843), which all
-- use data.type='internal_function' + data.function_name. Bespoke job types
-- were RETIRED for recurring work — lib/job_executor.js:158 records
-- 'task_daily_digest' being replaced by internal_function/run_task_digest.
--
-- 0 11 * * * — verified free: the live schedule occupies 0 4, 0 7, 30 7, 0 9,
-- 0 13 (three jobs), 0 21, 45 7 on the 1st, hourly, and */5. Same frame as
-- those rows, which is roughly 07:00 in Michigan — overnight failures are
-- waiting as a task when staff arrive, and it is well clear of the 0 13 pile-up.
--
-- max_attempts 3 / backoff 300 match every other recurring job. The job is
-- idempotent, so a retry is free.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO scheduled_jobs
  (type, scheduled_time, status, active, name, data, recurrence_rule, max_attempts, backoff_seconds)
SELECT
  'recurring',
  TIMESTAMP(DATE(UTC_TIMESTAMP()) + INTERVAL 1 DAY, '11:00:00'),
  'pending',
  1,
  'E-Sign reconciliation (Zoho Sign)',
  JSON_OBJECT(
    'type',          'internal_function',
    'function_name', 'esign_reconcile',
    'params',        JSON_OBJECT()
  ),
  '0 11 * * *',
  3,
  300
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM scheduled_jobs
   WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.function_name')) = 'esign_reconcile'
);


-- ============================================================================
-- VERIFY (run after applying; all four should be as described)
-- ============================================================================
-- SELECT `key`,
--        CASE WHEN is_secret = 1 THEN CONCAT('(secret, ', COALESCE(CHAR_LENGTH(`value`), 0), ' chars)')
--             ELSE COALESCE(`value`, '(null)') END AS val,
--        is_secret, is_editable, sort_order
--   FROM app_settings
--  WHERE category = 'E-Sign'
--  ORDER BY sort_order;
--
--   esign_credential_id           13            secret=0 editable=1   10
--   esign_test_mode               1             secret=0 editable=1   20
--   esign_webhook_token           (secret, 64)  secret=1 editable=0   30
--   esign_credit_balance          (null)        secret=0 editable=1   40
--   esign_credit_alert_threshold  50            secret=0 editable=1   50
--   esign_credit_alert_sent       0             secret=0 editable=0   60
--
-- SELECT id, name, active, recurrence_rule, scheduled_time,
--        JSON_UNQUOTE(JSON_EXTRACT(data, '$.function_name')) AS fn
--   FROM scheduled_jobs
--  WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.function_name')) = 'esign_reconcile';
--   → exactly ONE row, active=1, '0 11 * * *'
--
-- To read the token for the Zoho webhook URL (it is is_secret, so no API
-- returns it — this is the only way):
-- SELECT `value` FROM app_settings WHERE `key` = 'esign_webhook_token';
--
-- Then configure in Zoho Sign → Settings → Webhooks:
--   https://app.4lsg.com/webhooks/esign/zoho?token=<that value>
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- Disable inbound + the job without losing configuration:
--   UPDATE scheduled_jobs SET active = 0
--    WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.function_name')) = 'esign_reconcile';
--
-- The webhook endpoint cannot be "disabled" by clearing the token — an empty
-- token makes it fail CLOSED, which is the same thing from Zoho's side (401).
-- Prefer removing the webhook in the Zoho console so Zoho stops retrying.
--
-- Full removal (only if 1C is being abandoned):
--   DELETE FROM scheduled_jobs
--    WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.function_name')) = 'esign_reconcile';
--   DELETE FROM app_settings WHERE `key` IN
--     ('esign_webhook_token', 'esign_credit_balance',
--      'esign_credit_alert_threshold', 'esign_credit_alert_sent');
-- ============================================================================
