-- ref/migrations/2026-11-05_yisramail_c4_mail_digest_job.sql
--
-- YisraMail C4 (ref/YISRAMAIL_DESIGN.md §6.5): the daily "Marketing Mail
-- Digest" recurring job, which runs fns.mail_bounce_digest
-- (lib/internal_functions/mailDigest.js): the last 24 h of marketing email —
-- per campaign sent / delivered / hard bounces / complaints / unsubscribes,
-- per bulk transport the current rates + held state — emailed to
-- campaign_bounce_digest_email (blank = alert_recipients) ONLY when the
-- window saw activity. Off when app_settings campaign_bounce_digest_enabled
-- = '0'.
--
-- WHY A ROW HERE, NOT THE UI: mail_bounce_digest is __meta.uiHidden — engine
-- plumbing, like sms_consent_sync — so the Scheduled Jobs "New Job" picker
-- never offers it.
--
-- Idempotent on idempotency_key (not a UNIQUE column — the NOT EXISTS is the
-- guard). First run at insert (UTC_TIMESTAMP()), then 12:00 UTC daily:
-- recurrence rules are evaluated in the process time zone, UTC on Cloud Run
-- (routes/process_jobs.js passes no tz to the cron parser) — 07:00 EST /
-- 08:00 EDT Detroit. max_attempts 1: a failed morning alerts through the
-- error sweep and the next morning runs anyway.
--
-- Apply through the SU db console (POST /admin/db/query) AFTER the C4 backend
-- deploy (the function must exist when the first run fires).

INSERT INTO scheduled_jobs
  (type, scheduled_time, status, active, name, description, data,
   recurrence_rule, max_attempts, backoff_seconds, idempotency_key)
SELECT 'recurring', UTC_TIMESTAMP(), 'pending', 1,
       'Marketing Mail Digest',
       'Daily: the last 24 h of marketing email — per campaign sent / delivered / hard bounces / complaints / unsubscribes, per bulk sender the current rates and held state — emailed to campaign_bounce_digest_email (blank = the IT alert list) only when the window saw activity. Off when app_settings campaign_bounce_digest_enabled = 0. fns.mail_bounce_digest. ref/YISRAMAIL_DESIGN.md §6.5 (C4).',
       '{"type": "internal_function", "params": {}, "function_name": "mail_bounce_digest"}',
       '0 12 * * *', 1, 300, 'mail_bounce_digest'
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM scheduled_jobs WHERE idempotency_key = 'mail_bounce_digest');

-- ── Verify ──────────────────────────────────────────────────────────────────
-- SELECT id, name, type, status, active, recurrence_rule, max_attempts, scheduled_time, execution_count
--   FROM scheduled_jobs WHERE idempotency_key = 'mail_bounce_digest';
-- SELECT id, status, error_message, output_data, executed_at FROM job_results
--  WHERE job_id = <id> ORDER BY id DESC LIMIT 3;
