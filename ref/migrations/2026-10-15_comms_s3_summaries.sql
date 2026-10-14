-- ref/migrations/2026-10-15_comms_s3_summaries.sql
--
-- Comms archive S3 — AI summaries (ref/COMMS_ARCHIVE_DESIGN.md §6.4, §6.5).
--
--   Part A — BEFORE the backend: the summary work queue + its settings.
--            Plain SQL (the SU console is fine): a NEW table and settings
--            rows only — no ALTER on a live table, no session variables.
--            The summary CONTENT lives on comms_transcripts (summary,
--            summary_text, summary_model, ai_call_ids, grounding_dropped,
--            llm_cost_cents — S2's columns); this queue holds no content.
--   Part B — AFTER the backend is live: the recurring job row.
--
-- Re-runnable: CREATE TABLE IF NOT EXISTS; settings never clobber an edited
-- value; the job seed is guarded by NOT EXISTS on its idempotency_key.

-- ════════════════════════════════════════════════════════════════════════════
-- PART A — before the backend
-- ════════════════════════════════════════════════════════════════════════════

-- ── A1. The summary queue ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comms_summaries (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  transcript_id   BIGINT UNSIGNED NOT NULL
                  COMMENT 'comms_transcripts.id — the summary itself is written there (summary, summary_text, …); this row is only the work queue',
  state           VARCHAR(16)  NOT NULL DEFAULT 'pending'
                  COMMENT 'pending | calling | done | skipped | failed — app-validated. calling = a model call in flight (written AHEAD of it, so the monthly cap counts est_cents even if the process dies mid-call)',
  skip_reason     VARCHAR(32)  NULL
                  COMMENT 'restricted (back to pending once unrestricted) | short | empty | refused | purged',
  model           VARCHAR(48)  NULL
                  COMMENT 'the model of the latest call',
  effort          VARCHAR(8)   NULL,
  est_cents       DECIMAL(10,4) NULL
                  COMMENT 'estimated cost of the call in flight; the cap counts it while state = calling (ai_calls holds the billed cost)',
  attempts        INT UNSIGNED NOT NULL DEFAULT 0
                  COMMENT 'failed calls (timeout, 5xx, unusable output) — our-side stops (cap, credential, configuration) never charge it',
  next_attempt_at DATETIME     NULL
                  COMMENT 'UTC; NULL = due now. Also the per-row lease',
  last_error      VARCHAR(500) NULL
                  COMMENT 'codes and reasons only — NEVER model output or transcript text',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_comms_summaries_transcript (transcript_id),
  KEY idx_comms_summaries_work (state, next_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='AI summary work queue, one row per transcript (comms archive S3). No content — that is on comms_transcripts';

-- ── A2. Settings (read uncached every tick; fail-closed) ────────────────────
INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES ('comms_summarize_mode', 'off', 0, 1, 'Automations', 'Comms Summaries',
  'off | sample | on. off: no summaries are made. sample: only transcripts of the items in comms_eval_items (the S0 evaluation). on: every transcribed call and voicemail. Restricted calls are never sent. Anything else = off. Read uncached every tick.',
  'string', 58)
ON DUPLICATE KEY UPDATE `key` = `key`;

INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES ('comms_summary_model', 'claude-sonnet-5-5', 0, 0, 'Automations', 'Comms Summary Model',
  'claude-sonnet-5-5 | claude-haiku-5-5. Anything else = the summaries stop (alerted).',
  'string', 59)
ON DUPLICATE KEY UPDATE `key` = `key`;

INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES ('comms_summary_effort', 'low', 0, 0, 'Automations', 'Comms Summary Effort',
  'low | medium | high — the model''s thinking effort (billed as output). Anything else = the summaries stop (alerted).',
  'string', 60)
ON DUPLICATE KEY UPDATE `key` = `key`;

INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES ('comms_min_summary_s', '30', 0, 0, 'Automations', 'Comms Summary Minimum (s)',
  'A call with less audio than this (seconds, as AssemblyAI measured it) is not summarised (P6). Not applied to voicemails or in sample mode.',
  'number', 61)
ON DUPLICATE KEY UPDATE `key` = `key`;

-- ── Verify (Part A) ─────────────────────────────────────────────────────────
-- SHOW CREATE TABLE comms_summaries;
-- SELECT `key`, `value` FROM app_settings WHERE `key` IN ('comms_summarize_mode', 'comms_summary_model', 'comms_summary_effort', 'comms_min_summary_s');

-- ════════════════════════════════════════════════════════════════════════════
-- PART B — AFTER the backend is live
-- ════════════════════════════════════════════════════════════════════════════

-- ── B1. Summarize sweep, every 2 minutes ────────────────────────────────────
INSERT INTO scheduled_jobs
  (type, scheduled_time, status, active, name, description, data,
   recurrence_rule, max_attempts, backoff_seconds, idempotency_key)
SELECT 'recurring', UTC_TIMESTAMP(), 'pending', 1,
       'Comms Summarize Sweep',
       'Summarises transcribed calls and voicemails with Claude (aiService, credential 12): at most 3 calls per tick, none started after 30 s. Every quote is checked against the transcript; restricted calls are never sent. Gated on app_settings comms_summarize_mode (off | sample | on) and the shared monthly AI cap. ref/COMMS_ARCHIVE_DESIGN.md §6.4.',
       '{"type": "internal_function", "params": {}, "function_name": "comms_summarize_sweep"}',
       '*/2 * * * *', 1, 300, 'comms_summarize_sweep'
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM scheduled_jobs WHERE idempotency_key = 'comms_summarize_sweep');

-- ── Verify (Part B) ─────────────────────────────────────────────────────────
-- SELECT id, name, recurrence_rule, status FROM scheduled_jobs WHERE idempotency_key = 'comms_summarize_sweep';
