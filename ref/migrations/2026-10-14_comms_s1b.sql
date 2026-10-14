-- 2026-10-14 — Comms archive S1b — Quo recordings, MMS, delete detection, restrict / purge
--
-- Spec: ref/COMMS_ARCHIVE_DESIGN.md §6.1 (media sweep), §8 (restrict / purge),
-- §10 (delete detection), §0 R9 (who). Code: services/commsArchiveMediaSweep.js,
-- services/commsArchiveVerify.js, services/commsArchiveAdmin.js,
-- routes/api.commsArchive.js, lib/internal_functions/commsArchive.js.
-- comms_media itself is unchanged (S1a created the full table).
--
-- TWO PARTS:
--   Part A — BEFORE the S1b backend deploy: the R9 admin list.
--   Part B — AFTER the backend is live: the two recurring jobs, which name
--            functions that exist only once the backend deploys.
--
-- Re-runnable: the setting never clobbers an edited value; the job seeds are
-- guarded by NOT EXISTS on their idempotency_key. No session variables.

-- ════════════════════════════════════════════════════════════════════════════
-- PART A — before the backend
-- ════════════════════════════════════════════════════════════════════════════

-- ── A1. R9: who besides SU may restrict / purge (Fred, 2026-10-14) ──────────
-- CSV of users.user ids; read uncached on every request; digits only (other
-- tokens ignored and logged); missing / empty / garbage = SU only. SU always
-- passes. is_editable 0: changed from the SU db console only. Seeded with
-- user 1 (SS). Interim — a users.roles capability replaces it when the roles
-- arc lands (ref/plans.md).
INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES (
  'comms_archive_admins', '1', 0, 0, 'Automations', 'Comms Archive Admins',
  'Comma-separated users.user ids who may restrict, unrestrict and purge comms archive items, besides SU (who always may). Digits only; anything else is ignored. Empty = SU only. Changed from the SU db console only.',
  'string', 41
)
-- (never clobber an existing value)
ON DUPLICATE KEY UPDATE `key` = `key`;

-- ── Verify (Part A) ─────────────────────────────────────────────────────────
-- SELECT `key`, `value`, is_editable FROM app_settings WHERE `key` = 'comms_archive_admins';

-- ════════════════════════════════════════════════════════════════════════════
-- PART B — AFTER the backend is live
-- ════════════════════════════════════════════════════════════════════════════

-- ── B1. Media sweep (Quo recordings + MMS), every 2 minutes ─────────────────
INSERT INTO scheduled_jobs
  (type, scheduled_time, status, active, name, description, data,
   recurrence_rule, max_attempts, backoff_seconds, idempotency_key)
SELECT 'recurring', UTC_TIMESTAMP(), 'pending', 1,
       'Comms Archive Media Sweep',
       'Copies Quo call recordings and RingCentral / Quo MMS files into the private comms archive bucket. Bounded per tick (45 s; RC Medium and Quo API budgets). A provider response that does not match its documented shape is parked and alerted, never treated as "no file". Gated on app_settings comms_archive_enabled. ref/COMMS_ARCHIVE_DESIGN.md §6.1.',
       '{"type": "internal_function", "params": {}, "function_name": "comms_archive_media_sweep"}',
       '*/2 * * * *', 1, 300, 'comms_archive_media_sweep'
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM scheduled_jobs WHERE idempotency_key = 'comms_archive_media_sweep');

-- ── B2. Nightly delete detection, 07:15 UTC ─────────────────────────────────
INSERT INTO scheduled_jobs
  (type, scheduled_time, status, active, name, description, data,
   recurrence_rule, max_attempts, backoff_seconds, idempotency_key)
SELECT 'recurring', UTC_TIMESTAMP(), 'pending', 1,
       'Comms Archive Verify',
       'Nightly delete detection: stats a rolling 1/7 of the archived objects, the whole slice (every object every 7 days, within 14 if a night is missed — inside the bucket''s 30-day soft-delete window) and raises an error alert for any missing outside a purge. Read-only; runs even while comms_archive_enabled is off. ref/COMMS_ARCHIVE_DESIGN.md §10.',
       '{"type": "internal_function", "params": {}, "function_name": "comms_archive_verify"}',
       '15 7 * * *', 1, 300, 'comms_archive_verify'
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM scheduled_jobs WHERE idempotency_key = 'comms_archive_verify');

-- ── Verify (Part B) ─────────────────────────────────────────────────────────
-- SELECT id, name, recurrence_rule, status FROM scheduled_jobs
--  WHERE idempotency_key IN ('comms_archive_media_sweep', 'comms_archive_verify');
