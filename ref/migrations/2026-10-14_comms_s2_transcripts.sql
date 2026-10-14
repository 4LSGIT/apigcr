-- ref/migrations/2026-10-14_comms_s2_transcripts.sql
--
-- Comms archive S2 — transcription (ref/COMMS_ARCHIVE_DESIGN.md §5, §6.3, §6.5).
--
--   Part A — BEFORE the backend: the two tables, the settings, and the
--            comms_media COMMENT fold-in. APPLIED BY
--              node scripts/commsTranscribeS2Migrate.js            (CHECK)
--              node scripts/commsTranscribeS2Migrate.js --apply
--            NOT by pasting it into the SU console: the ALTER runs on a LIVE
--            table and needs lock_wait_timeout set on its own session, which
--            /admin/db/batch cannot do (CLAUDE.md). This file RECORDS what the
--            script runs; tests/commsTranscribe.migration.mysql.test.js holds
--            the two identical.
--   Part B — AFTER the backend is live: the recurring job row (plain SQL; the
--            SU console is fine — it names a function that exists only once
--            the backend deploys).
--
-- Re-runnable: CREATE TABLE IF NOT EXISTS; settings never clobber an edited
-- value; the job seed is guarded by NOT EXISTS on its idempotency_key.

-- ════════════════════════════════════════════════════════════════════════════
-- PART A — before the backend (run by the script)
-- ════════════════════════════════════════════════════════════════════════════

SET SESSION lock_wait_timeout = 5;

-- ── A1. Transcripts ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comms_transcripts (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  media_id          BIGINT UNSIGNED NOT NULL
                    COMMENT 'comms_media.id — a call_recording or voicemail. Visibility is the PARENT''s: every reader JOINs comms_media (restricted, channel_id) — Restrict hides derived text (R9); nothing is copied here',
  phone_event_id    BIGINT UNSIGNED NULL
                    COMMENT 'phone_event_log.id — denormalised for joins; NULL for an RC voicemail (source_table rc_message: no call row)',
  state             VARCHAR(16)  NOT NULL DEFAULT 'pending'
                    COMMENT 'pending | transcribing | transcribed | summarized | skipped | failed | purged — app-validated (design §5)',
  skip_reason       VARCHAR(32)  NULL
                    COMMENT 'short | no_transcribe | over_cap | policy',
  stt_vendor        VARCHAR(16)  NULL
                    COMMENT 'assemblyai',
  stt_model         VARCHAR(48)  NULL
                    COMMENT 'model + variant of the canonical transcript, e.g. universal-3-5-pro+diarize',
  stt_job_ref       VARCHAR(191) NULL
                    COMMENT 'vendor transcript id (canonical variant)',
  alt_job_ref       VARCHAR(191) NULL
                    COMMENT 'sample mode only: vendor id of the other Quo-stereo variant — stored as an stt_raw child (part assemblyai-mc or assemblyai), never in this row',
  language          VARCHAR(16)  NULL,
  speakers          TINYINT UNSIGNED NULL,
  segments          JSON NULL
                    COMMENT '[{s:speaker,a:start_s,b:end_s,t:text}] — s is A, B… (diarized) or ch1, ch2… (multichannel)',
  full_text         MEDIUMTEXT NULL,
  summary           JSON NULL
                    COMMENT 'schema in COMMS_ARCHIVE_DESIGN §6.4',
  summary_text      TEXT NULL,
  summary_model     VARCHAR(48)  NULL,
  ai_call_ids       JSON NULL
                    COMMENT 'ai_calls.id of every summary attempt — purge clears their request_excerpt/response',
  grounding_dropped SMALLINT UNSIGNED NULL,
  est_audio_s       INT UNSIGNED NULL
                    COMMENT 'audio length estimated from the archived file''s header before submit (the P6 gate and the caps); comms_media.duration_s holds the vendor''s measured length',
  stt_cost_cents    DECIMAL(10,4) NULL
                    COMMENT 'total STT spend for this row: every vendor job ever submitted for it (comms_stt_jobs — resubmits and the sample variant included), the billed cost once a job completed, its estimate otherwise. Kept in step with the ledger; never cleared — cost is not content, purge leaves it',
  llm_cost_cents    DECIMAL(10,4) NULL,
  cap_released_by   TINYINT NULL
                    COMMENT 'users.user who released an over_cap skip (SU console — design §6.5)',
  attempts          INT UNSIGNED NOT NULL DEFAULT 0
                    COMMENT 'vendor-side failures only — our-side failures (storage, signing, auth, cap) never charge it',
  next_attempt_at   DATETIME NULL
                    COMMENT 'UTC; NULL = due now. Also the per-row lease and the poll schedule',
  last_error        VARCHAR(1000) NULL,
  submitted_at      DATETIME NULL
                    COMMENT 'UTC; the current vendor job was submitted',
  transcribed_at    DATETIME NULL
                    COMMENT 'UTC; month-to-date STT cost (the monthly cap) sums on it',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_comms_transcripts_media (media_id),
  KEY idx_comms_transcripts_event (phone_event_id),
  KEY idx_comms_transcripts_work (state, next_attempt_at),
  KEY idx_comms_transcripts_month (transcribed_at),
  FULLTEXT KEY ft_comms_transcripts (full_text, summary_text)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Transcript + AI summary per archived call recording / voicemail (ref/COMMS_ARCHIVE_DESIGN.md §5). Never broader than its comms_media row: readers JOIN it';

-- ── A1b. The STT job ledger (spend + owed vendor deletes; ids and money only) ─
CREATE TABLE IF NOT EXISTS comms_stt_jobs (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  transcript_id  BIGINT UNSIGNED NOT NULL
                 COMMENT 'comms_transcripts.id the job was submitted for',
  media_id       BIGINT UNSIGNED NOT NULL
                 COMMENT 'comms_media.id (denormalised)',
  vendor         VARCHAR(16)  NOT NULL DEFAULT 'assemblyai',
  role           VARCHAR(8)   NOT NULL
                 COMMENT 'main (the transcript row''s variant) | alt (the sample-mode variant)',
  variant        VARCHAR(16)  NOT NULL
                 COMMENT 'diarize | multichannel',
  job_ref        VARCHAR(191) NULL
                 COMMENT 'the vendor''s job id. NULL = no id came back: the vendor MAY hold a job we never got an id for (state unknown — searched for by url_sha256)',
  state          VARCHAR(16)  NOT NULL
                 COMMENT 'unknown | submitted | completed | error | lost | drift | orphan | refused — app-validated. WRITE-AHEAD: every row is inserted as unknown BEFORE its POST and resolved from the answer, so a process death mid-POST still leaves the spend and the search. drift = a 2xx we could not read; lost = the vendor 404ed it; orphan = an unknown found again in the vendor list; refused = the vendor definitely took nothing (a 4xx, 500) — est 0',
  post_status    SMALLINT     NULL
                 COMMENT 'HTTP status the POST answered; 0 = no answer (timeout / network); NULL = written ahead, no answer recorded (the process ended mid-POST)',
  url_sha256     CHAR(64)     NULL
                 COMMENT 'sha256 of the signed audio_url sent (one URL per POST, so unique per job) — never the URL (a bearer link); kept while the vendor may hold a job we cannot name',
  est_cents      DECIMAL(10,4) NOT NULL
                 COMMENT 'estimated cost at submit — counted until the billed cost is known',
  cost_cents     DECIMAL(10,4) NULL
                 COMMENT 'billed cost (vendor audio_duration × the price card) once completed',
  submitted_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                 COMMENT 'UTC; the monthly cap sums every job by this',
  finished_at    DATETIME     NULL,
  deleted_at     DATETIME     NULL
                 COMMENT 'UTC; the vendor CONFIRMED the delete (2xx or 404). NULL with a job_ref and no live use = a delete still owed — retried with backoff; the vendor''s 30-day TTL is the backstop',
  delete_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  delete_after   DATETIME     NULL
                 COMMENT 'UTC; next delete (or orphan search) not before this',
  last_error     VARCHAR(500) NULL,
  UNIQUE KEY uq_comms_stt_jobs_ref (vendor, job_ref),
  KEY idx_comms_stt_jobs_transcript (transcript_id),
  KEY idx_comms_stt_jobs_month (submitted_at),
  KEY idx_comms_stt_jobs_owed (deleted_at, delete_after)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Every STT vendor job ever submitted (comms archive S2): the spend ledger behind the monthly cap and the per-job owed-delete list. Ids and money only — never content; purge leaves it';

-- ── A2. Numbers never transcribed (P6) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS comms_no_transcribe (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  phone      CHAR(10)     NOT NULL
             COMMENT '10 digits — matched against the last 10 digits of comms_media.party',
  note       VARCHAR(255) NULL,
  created_by TINYINT NULL
             COMMENT 'users.user',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_comms_no_transcribe_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Numbers whose calls are archived but never transcribed or summarised (P6). SU / SS maintain it (R9); adding a number later does not touch existing transcripts — Restrict or Purge does';

-- ── A3. Settings (read uncached every tick; fail-closed) ────────────────────
INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES ('comms_transcribe_mode', 'off', 0, 1, 'Automations', 'Comms Transcription', 'off | sample | on. off: no NEW submissions — jobs already sent are still polled, stored and deleted at the vendor. sample: only the archive items listed in comms_eval_items (the S0 evaluation), both Quo-stereo variants. on: every archived call recording and voicemail. Restricted calls are never sent. Anything else = off. Read uncached every tick.', 'string', 50)
ON DUPLICATE KEY UPDATE `key` = `key`;

INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES ('comms_stt_credential_id', '14', 0, 0, 'Automations', 'Comms STT Credential', 'credentials.id of the AssemblyAI api_key credential the transcription sweep calls through. Missing / not a number = transcription stops (alerted).', 'number', 51)
ON DUPLICATE KEY UPDATE `key` = `key`;

INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES ('comms_min_transcribe_s', '15', 0, 0, 'Automations', 'Comms Transcribe Minimum (s)', 'Audio shorter than this (estimated from the archived file) is skipped as short (P6). Not applied to voicemails or in sample mode.', 'number', 52)
ON DUPLICATE KEY UPDATE `key` = `key`;

INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES ('comms_stt_max_min_per_call', '300', 0, 0, 'Automations', 'Comms STT Per-Call Cap (min)', 'Audio longer than this is skipped as over_cap; an SU releases one from the db console (design §6.5).', 'number', 53)
ON DUPLICATE KEY UPDATE `key` = `key`;

INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES ('comms_ai_monthly_cap_cents', '7500', 0, 0, 'Automations', 'Comms AI Monthly Cap (cents)', 'Month-to-date transcription (+ summary, S3) spend that stops new submissions; archiving never stops. 7500 for the backfill month, then 2500 (an SU-console UPDATE — design §6.5). Missing / not a number = 0 = nothing submitted.', 'number', 54)
ON DUPLICATE KEY UPDATE `key` = `key`;

INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES ('comms_stt_quo_stereo', 'diarize', 0, 0, 'Automations', 'Comms STT Stereo Mode', 'diarize | multichannel — how a 2-channel recording is transcribed in mode on (sample mode runs both). diarize = one mixed channel + speaker labels (one-channel price); multichannel = one transcript per channel (billed per channel). Anything else = diarize.', 'string', 55)
ON DUPLICATE KEY UPDATE `key` = `key`;

INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES ('comms_stt_keyterms', '[]', 0, 0, 'Automations', 'Comms STT Keyterms', 'JSON array of words / phrases (≤ 6 words each) sent as keyterms_prompt. Empty = off; non-empty adds $0.05 per audio hour.', 'json', 56)
ON DUPLICATE KEY UPDATE `key` = `key`;

INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES ('comms_stt_language_detection', '1', 0, 0, 'Automations', 'Comms STT Language Detection', '1 = the vendor detects the language (some clients do not speak English). Anything else = English (en_us).', 'bool', 57)
ON DUPLICATE KEY UPDATE `key` = `key`;

-- ── A4. comms_media COMMENTs (doc debt docs/20261014_comms_media_comment_kinds)
-- Each MODIFY restates the column's CURRENT definition exactly (the script
-- asserts it from information_schema first); INSTANT is refused by MySQL for
-- anything that is not metadata-only.
ALTER TABLE comms_media
  MODIFY kind VARCHAR(20) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'call_recording | voicemail | mms_file | stt_raw | mail_raw | mail_attachment — app-validated',
  MODIFY source_table VARCHAR(32) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'phone_event_log (calls, MMS, Quo voicemails) | rc_message (RC voicemails: source_id = the RC message id — no call row) | comms_media (stt_raw: source_id = the parent row) | mail_messages',
  MODIFY part VARCHAR(64) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '' COMMENT 'provider recording / attachment id; '''' = placeholder before the provider lists any. Discovery tests existence on (source_table, source_id, kind) REGARDLESS of part — a recovered placeholder changes its part, so the unique key alone would re-insert it. stt_raw: the transcript''s source — ''quo'', the RC AudioTranscription attachment id, ''assemblyai'' (diarized; S2) or ''assemblyai-mc'' (multichannel; S2)',
  MODIFY channel_id INT UNSIGNED NULL COMMENT 'phone_lines.id / mailboxes.id — the grant anchor (mailboxService.getAccess). NULL = the source line is not a phone_lines row (orphan), or an RC voicemail left with no to-number (who may see it: S4)',
  MODIFY duration_s INT UNSIGNED NULL COMMENT 'measured media length in seconds: the STT vendor''s audio_duration, written by the transcribe sweep (S2); NULL until transcribed',
  MODIFY audio_channels TINYINT UNSIGNED NULL COMMENT 'channel count read from the archived file''s header by the transcribe sweep (S2); NULL until read',
  MODIFY captured_at DATETIME NULL COMMENT 'provider time of the call/message, UTC wall clock (pool convention). Phone calls: raw_extra.started_at, else phone_event_log.processed_at when started_at is blank (tsi: rows). RC voicemails: the message creationTime. stt_raw: the parent''s. The cliff clock',
  ALGORITHM=INSTANT;

-- ── Verify (Part A) ─────────────────────────────────────────────────────────
-- The script verifies and prints GO. By hand:
-- SHOW CREATE TABLE comms_transcripts; SHOW CREATE TABLE comms_no_transcribe;
-- SELECT `key`, `value` FROM app_settings WHERE `key` IN ('comms_transcribe_mode', 'comms_ai_monthly_cap_cents');

-- ════════════════════════════════════════════════════════════════════════════
-- PART B — AFTER the backend is live
-- ════════════════════════════════════════════════════════════════════════════

-- ── B1. Transcribe sweep, every 2 minutes ───────────────────────────────────
INSERT INTO scheduled_jobs
  (type, scheduled_time, status, active, name, description, data,
   recurrence_rule, max_attempts, backoff_seconds, idempotency_key)
SELECT 'recurring', UTC_TIMESTAMP(), 'pending', 1,
       'Comms Transcribe Sweep',
       'Transcribes archived call recordings and voicemails through AssemblyAI: submit (1-hour signed URL), poll, store the vendor JSON in the archive and the segments in comms_transcripts, then delete the vendor copy. Bounded per tick (45 s). Gated on app_settings comms_transcribe_mode (off | sample | on) and the monthly cap. ref/COMMS_ARCHIVE_DESIGN.md §6.3.',
       '{"type": "internal_function", "params": {}, "function_name": "comms_transcribe_sweep"}',
       '*/2 * * * *', 1, 300, 'comms_transcribe_sweep'
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM scheduled_jobs WHERE idempotency_key = 'comms_transcribe_sweep');

-- ── Verify (Part B) ─────────────────────────────────────────────────────────
-- SELECT id, name, recurrence_rule, status FROM scheduled_jobs WHERE idempotency_key = 'comms_transcribe_sweep';
