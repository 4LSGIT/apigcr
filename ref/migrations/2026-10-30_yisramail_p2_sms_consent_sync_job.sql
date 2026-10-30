-- ref/migrations/2026-10-30_yisramail_p2_sms_consent_sync_job.sql
--
-- YisraMail P2 (ref/YISRAMAIL_DESIGN.md §4.6): the nightly "SMS Consent Sync"
-- recurring job, which runs fns.sms_consent_sync (lib/internal_functions/consent.js):
-- the read-only RingCentral consent reconcile (off unless app_settings
-- sms_rc_consent_sync_enabled = '1') and the inbound-text liveness alert
-- (sms_inbound_liveness_hours, default 72).
--
-- WHY A ROW HERE, NOT THE UI: sms_consent_sync is __meta.uiHidden — engine
-- plumbing, like phone_outbound_sync and comms_summarize_sweep — so the
-- Scheduled Jobs "New Job" picker never offers it (scheduledJobs.html filters
-- uiHidden on create; an existing job keeps its hidden function on edit).
--
-- Idempotent on idempotency_key (not a UNIQUE column — the NOT EXISTS is the
-- guard). First run at insert (UTC_TIMESTAMP()), then 08:20 UTC daily:
-- recurrence rules are evaluated in the process time zone, UTC on Cloud Run
-- (routes/process_jobs.js passes no tz to the cron parser) — 04:20 / 03:20
-- Detroit. max_attempts 1: a failed night alerts through the error sweep and
-- the next night runs anyway.
--
-- Applied 2026-10-30 through the SU db console (POST /admin/db/query).

INSERT INTO scheduled_jobs
  (type, scheduled_time, status, active, name, description, data,
   recurrence_rule, max_attempts, backoff_seconds, idempotency_key)
SELECT 'recurring', UTC_TIMESTAMP(), 'pending', 1,
       'SMS Consent Sync',
       'Nightly: the read-only RingCentral consent reconcile (every number RingCentral lists as opted out becomes a provider_optout event; off unless app_settings sms_rc_consent_sync_enabled = 1) and the inbound-text liveness alert (sms_inbound_liveness_hours, default 72). fns.sms_consent_sync. ref/YISRAMAIL_DESIGN.md §4.6.',
       '{"type": "internal_function", "params": {}, "function_name": "sms_consent_sync"}',
       '20 8 * * *', 1, 300, 'sms_consent_sync'
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM scheduled_jobs WHERE idempotency_key = 'sms_consent_sync');

-- ── Verify ──────────────────────────────────────────────────────────────────
-- SELECT id, name, type, status, active, recurrence_rule, max_attempts, scheduled_time, execution_count
--   FROM scheduled_jobs WHERE idempotency_key = 'sms_consent_sync';
-- SELECT id, status, error_message, output_data, executed_at FROM job_results
--  WHERE job_id = <id> ORDER BY id DESC LIMIT 3;
