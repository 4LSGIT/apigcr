-- YisraMail C6c — the daily tracking-domain watchdog job (ref/YISRAMAIL_DESIGN.md
-- §6.5 "As built (C6c)"). Applied via the SU console snippet
-- (local/2026-11-05_c6c_watchdog_job_snippet.js) AFTER the C6c deploy — the
-- definition payload recorded here outlives ref/database.sql. Idempotent on
-- idempotency_key.

INSERT INTO scheduled_jobs
  (type, scheduled_time, status, active, name, description, data, recurrence_rule, max_attempts, backoff_seconds, idempotency_key)
SELECT 'recurring', UTC_TIMESTAMP(), 'pending', 1,
  'Tracking Domain Watchdog',
  'Daily: probe https://r.news.4lsg.com/favicon.ico (AWS''s own verification path for the C6 tracking domain), assert HTTP 200 + x-amz-ses-region us-east-2 + https request protocol, and read the TLS certificate''s days-to-expiry — the cert only auto-renews while the ACM validation CNAME exists in Namecheap, and losing it would break every sent tracking link ~a year later, silently. Error alert (once per UTC day) for broken/expiring; warning for a transient fetch failure; a healthy day is silent. fns.tracking_domain_check. ref/YISRAMAIL_DESIGN.md §6.5 (C6c).',
  '{"type": "internal_function", "params": {}, "function_name": "tracking_domain_check"}',
  '30 12 * * *', 1, 300, 'tracking_domain_check'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM scheduled_jobs WHERE idempotency_key = 'tracking_domain_check');
