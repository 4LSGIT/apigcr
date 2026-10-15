-- ref/migrations/2026-10-16_comms_s3c_summary_guides.sql
--
-- Comms archive S3c — per-call re-summarise (ref/COMMS_ARCHIVE_DESIGN.md §6.4).
--
--   Part A — BEFORE the backend: one NEW table. Plain SQL (the SU console is
--            fine): no ALTER on a live table, no session variables.
--
-- Why a side table, not comms_summaries columns (an INSTANT ADD COLUMN would
-- work there — no FULLTEXT, measured on 8.4.11): both redo modes DELETE the
-- comms_summaries row, and a staff note must survive every later bulk redo.
--
-- The new backend LEFT JOINs this table on every summarize tick, so it runs
-- FIRST: deployed without it, the summarize sweep fails every tick (alerted by
-- the scheduler) until it exists.
--
-- Re-runnable: CREATE TABLE IF NOT EXISTS.

-- ════════════════════════════════════════════════════════════════════════════
-- PART A — before the backend
-- ════════════════════════════════════════════════════════════════════════════

-- ── A1. The per-transcript summary guide ────────────────────────────────────
CREATE TABLE IF NOT EXISTS comms_summary_guides (
  transcript_id  BIGINT UNSIGNED NOT NULL PRIMARY KEY
                 COMMENT 'comms_transcripts.id. One row = the CURRENT guide: a staff request (POST /api/comms-archive/media/:id/resummarize) replaces it. It drives EVERY later summary of this transcript (bulk and transcript redos included); purge deletes it',
  model          VARCHAR(48) NOT NULL
                 COMMENT 'the summary model asked for (claude-sonnet-5-5 | claude-haiku-5-5 — app-validated); overrides comms_summary_model for this transcript',
  note           VARCHAR(500) NULL
                 COMMENT 'a staff hint about the call''s context, sent to the model as UNTRUSTED input (escaped, inside the user turn) — never a source for quotes or names. NULL = no note; a new request without a note clears it. Content: purge deletes the row; Restrict hides it with the summary',
  note_by        TINYINT NULL
                 COMMENT 'users.user who wrote the note (NULL with no note)',
  requested_at   DATETIME NOT NULL
                 COMMENT 'UTC; the latest request. The summarize sweep runs a pending guide first',
  requested_by   TINYINT NOT NULL
                 COMMENT 'users.user who asked',
  version        INT UNSIGNED NOT NULL DEFAULT 1
                 COMMENT 'bumped on every request: the identity of a request (requested_at is seconds-precise, two requests can share it). The sweep''s write-ahead and its outcome stamp are conditional on the version it read',
  outcome        VARCHAR(16) NULL
                 COMMENT 'NULL = pending (summary_pending) | done | failed | skipped — app-validated; set by the summarize sweep',
  outcome_at     DATETIME NULL
                 COMMENT 'UTC'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Comms archive S3c: the model + staff note a transcript''s summary is made with. A side table because both redo modes delete comms_summaries rows';

-- ── Verify (Part A) ─────────────────────────────────────────────────────────
-- SHOW CREATE TABLE comms_summary_guides;
