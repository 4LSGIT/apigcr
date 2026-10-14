-- ref/migrations/2026-10-15_comms_s2c_redo.sql
--
-- Comms archive S2c-2 — the redo marker (ref/COMMS_ARCHIVE_DESIGN.md §8).
--
--   Part A — BEFORE the backend: one NEW table. Plain SQL (the SU console is
--            fine): no ALTER on a live table, no session variables.
--
-- Why a side table and not a comms_transcripts column: any ALTER on
-- comms_transcripts that adds a column must REBUILD it, and its FULLTEXT index
-- (ft_comms_transcripts) refuses ALGORITHM=INSTANT and INPLACE (ER 1846,
-- measured on MySQL 8.4.11) — only ALGORITHM=COPY, which blocks every write
-- of both comms sweeps for the copy. Design §5, the schema landmine.
--
-- The new backend LEFT JOINs this table on every transcribe tick, so it runs
-- FIRST: deployed without it, the transcribe sweep fails every tick (alerted
-- by the scheduler) until it exists.
--
-- Re-runnable: CREATE TABLE IF NOT EXISTS.

-- ════════════════════════════════════════════════════════════════════════════
-- PART A — before the backend
-- ════════════════════════════════════════════════════════════════════════════

-- ── A1. The redo marker ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comms_redo (
  transcript_id  BIGINT UNSIGNED NOT NULL PRIMARY KEY
                 COMMENT 'comms_transcripts.id sent back to be transcribed again (POST /api/comms-archive/redo). Written in the same transaction as the row''s flip to pending; deleted when the new transcript is stored (a stale one is harmless) and by purge',
  requested_at   DATETIME NOT NULL
                 COMMENT 'UTC. The transcribe sweep submits marked rows first, retires the old vendor JSON just before the new POST, and counts only main-job failures since this',
  requested_by   TINYINT NULL
                 COMMENT 'users.user of the SU who asked',
  prev_model     VARCHAR(48) NULL
                 COMMENT 'comms_transcripts.stt_model of the transcript being redone. The old text stays (hidden) in the row until the new one is stored; a redo that ends failed or skipped is RESTORED to transcribed with this model (the submit overwrote stt_model)'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Comms archive S2c-2: transcripts being redone. A side table because comms_transcripts cannot take an ADD COLUMN without ALGORITHM=COPY (its FULLTEXT index refuses INSTANT and INPLACE — ref/COMMS_ARCHIVE_DESIGN.md §5, the schema landmine). Ids and times only';

-- ── Verify (Part A) ─────────────────────────────────────────────────────────
-- SHOW CREATE TABLE comms_redo;
