-- 2026-10-14 — Comms archive registry — comms archive arc, slice S1a
--
-- Spec: ref/COMMS_ARCHIVE_DESIGN.md §5 (comms_media — the FULL table, so S1b
-- needs no second migration), §4 (kill switch), §6.1 (the sweep job).
-- Code: services/commsArchiveService.js (bucket), services/commsArchiveSweep.js
--       (the tick), lib/internal_functions/commsArchive.js
--       (comms_archive_sweep), services/adapters/phone/ringcentral.js (fetchers).
--
-- TWO PARTS, RUN AT DIFFERENT TIMES:
--   Part A — BEFORE the S1a backend deploy (SQL → backend → frontend).
--   Part B — AFTER the backend is live. It seeds the recurring job row, which
--            names a function that exists only once the backend deploys.
--            (Run early it would be harmless — an unknown function throws,
--            and process_jobs reschedules a recurring max_attempts-1 job
--            rather than ending it — but the split keeps the failed-tick
--            noise out of job_results.)
--
-- Re-runnable: CREATE TABLE IF NOT EXISTS; the kill switch never clobbers an
-- edited value; the job seed is guarded by NOT EXISTS on its
-- idempotency_key. No session variables (the console runner uses separate
-- connections).
--
-- After Part A: npm run db:ref (or let the pre-commit hook do it).
--
-- comms_media NEVER enters QUERY_DB_ALLOWED_TABLES or WRITE_POLICY: it is
-- grant-scoped content (design P1, §7).

-- ════════════════════════════════════════════════════════════════════════════
-- PART A — before the backend
-- ════════════════════════════════════════════════════════════════════════════

-- ── A1. comms_media ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comms_media (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  channel         VARCHAR(8)   NOT NULL
                  COMMENT 'phone | mail — app-validated',
  kind            VARCHAR(20)  NOT NULL
                  COMMENT 'call_recording | mms_file | stt_raw | mail_raw | mail_attachment — app-validated',
  source_table    VARCHAR(32)  NOT NULL
                  COMMENT 'phone_event_log | mail_messages | comms_media (stt_raw)',
  source_id       BIGINT UNSIGNED NOT NULL
                  COMMENT 'id in source_table',
  part            VARCHAR(64)  NOT NULL DEFAULT ''
                  COMMENT 'provider recording / attachment id; '''' = placeholder before the provider lists any. Discovery tests existence on (source_table, source_id, kind) REGARDLESS of part — a recovered placeholder changes its part, so the unique key alone would re-insert it',
  provider        VARCHAR(16)  NULL
                  COMMENT 'ringcentral | quo — phone_event_log.provider',
  channel_id      INT UNSIGNED NULL
                  COMMENT 'phone_lines.id / mailboxes.id — the grant anchor (mailboxService.getAccess). NULL = the source line is not a phone_lines row (orphan)',
  party           VARCHAR(20)  NULL
                  COMMENT 'other party (10-digit) for phone — the log-style read-time anchor',
  object_name     VARCHAR(255) NULL
                  COMMENT 'name inside comms_archive_bucket (ids only, design §4); NULL until archived',
  mime            VARCHAR(128) NULL
                  COMMENT 'content-type as stored (allowlisted at fetch)',
  bytes           BIGINT UNSIGNED NULL,
  sha256          CHAR(64)     NULL
                  COMMENT 'hex sha256 of the stored bytes, computed in flight (or by re-hash on adopt)',
  duration_s      INT UNSIGNED NULL
                  COMMENT 'media duration; NULL until known (S1a does not fetch it)',
  audio_channels  TINYINT UNSIGNED NULL,
  captured_at     DATETIME     NULL
                  COMMENT 'provider time of the call/message, UTC wall clock (pool convention). Phone calls: raw_extra.started_at, else phone_event_log.processed_at when started_at is blank (tsi: rows). The cliff clock',
  state           VARCHAR(16)  NOT NULL DEFAULT 'pending'
                  COMMENT 'pending | archived | none | gone | failed | purged — app-validated (design §5)',
  restricted      TINYINT(1)   NOT NULL DEFAULT 0
                  COMMENT '1 = SU/SS-only visibility (Restrict, design §8)',
  attempts        INT UNSIGNED NOT NULL DEFAULT 0
                  COMMENT 'provider-side attempts only — our-side failures (bucket, auth, no line) never charge it',
  next_attempt_at DATETIME     NULL
                  COMMENT 'UTC; NULL = due now. Also the sweep''s per-row lease: a claim sets it ahead, so a crashed tick''s rows come back when it passes',
  last_error      VARCHAR(1000) NULL,
  archived_at     DATETIME     NULL,
  purged_at       DATETIME     NULL,
  purged_by       TINYINT      NULL
                  COMMENT 'users.user',
  purge_reason    VARCHAR(500) NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_comms_media_source (source_table, source_id, kind, part),
  KEY idx_comms_media_work (state, next_attempt_at),
  KEY idx_comms_media_party (party, captured_at),
  KEY idx_comms_media_channel (channel, channel_id, captured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Comms archive registry (ref/COMMS_ARCHIVE_DESIGN.md). One row per archived file. Never deleted — purge clears content and stamps purged_*';

-- ── A2. Kill switch ─────────────────────────────────────────────────────────
-- Read uncached through settingsService.getSetting every tick, FAIL-CLOSED:
-- only the exact string '1' enables. Seeded OFF; the deploy flips it.
INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES (
  'comms_archive_enabled', '0', 0, 1, 'Automations', 'Comms Archive Sweep',
  '1 = the comms archive sweep copies call recordings into the private archive bucket (RingCentral recordings in S1a). Anything else, including blank or a missing row, = OFF. Read uncached — takes effect on the next tick. Turning it off is always safe: pending rows wait, nothing is lost until the provider''s own retention (RingCentral: 90 days) runs out. The cliff guard alarm keeps running while this is off — a paused archive with recordings near that edge still pages.',
  'bool', 40
)
-- (never clobber an existing value)
ON DUPLICATE KEY UPDATE `key` = `key`;

-- ── Verify (Part A) ─────────────────────────────────────────────────────────
-- SHOW CREATE TABLE comms_media;
-- SELECT `key`, `value` FROM app_settings WHERE `key` = 'comms_archive_enabled';

-- ════════════════════════════════════════════════════════════════════════════
-- PART B — AFTER the backend is live
-- ════════════════════════════════════════════════════════════════════════════

-- ── B1. Recurring sweep job ─────────────────────────────────────────────────
-- Shape copied from the CTA Expiry Sweep seed (2026-10-07_cta.sql): internal
-- function data, max_attempts 1 (an idempotent sweep re-runs next tick — no
-- retry ladder; a throwing tick is rescheduled by process_jobs, not ended),
-- backoff 300. Every 2 minutes. data.params.heavy_per_tick (default 3) is
-- the RingCentral Heavy-call budget per tick — editable without a deploy.
INSERT INTO scheduled_jobs
  (type, scheduled_time, status, active, name, description, data,
   recurrence_rule, max_attempts, backoff_seconds, idempotency_key)
SELECT 'recurring', UTC_TIMESTAMP(), 'pending', 1,
       'Comms Archive Sweep',
       'Copies RingCentral call recordings into the private comms archive bucket before RingCentral deletes them at 90 days (oldest first), and raises the cliff guard alert for any recording 75+ days old not yet archived. Bounded per tick (45 s, at most heavy_per_tick RingCentral Heavy calls, spaced 20 s). Gated on app_settings comms_archive_enabled. ref/COMMS_ARCHIVE_DESIGN.md §6.',
       '{"type": "internal_function", "params": {}, "function_name": "comms_archive_sweep"}',
       '*/2 * * * *', 1, 300, 'comms_archive_sweep'
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM scheduled_jobs WHERE idempotency_key = 'comms_archive_sweep');

-- ── Verify (Part B) ─────────────────────────────────────────────────────────
-- SELECT id, name, recurrence_rule, scheduled_time, active, status
--   FROM scheduled_jobs WHERE idempotency_key = 'comms_archive_sweep';
