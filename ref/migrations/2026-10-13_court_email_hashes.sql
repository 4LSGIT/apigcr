-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-13 — Court NEF content dedupe: court_email_hashes
--   CREATE TABLE court_email_hashes: one row per distinct court-email content
--   hash, owned by the first message_id that reached court_extract with it.
--
-- WHY
--   The firm inbox receives the same court email under two or more distinct
--   Gmail message_ids (live 2026-09-01..10-13: 8 groups / 19 messages among
--   326 uscourts.gov emails, all source gmail-firm, 0 s to 3 days apart).
--   email_log dedupes on (source, message_id) and the executor's STEP 1
--   processed-marker keys on message_id, so each copy the court rule routes
--   to court_extract spends an AI call and can mint its own review card.
--   lib/internal_functions/court.js (CONTENT DEDUPE) claims each email's
--   hash here BEFORE the AI call: INSERT IGNORE; an ignored insert whose
--   stored message_id differs = duplicate delivery (skipped, logged to
--   court_ai_log as outcome 'none', review_reason 'duplicate_of:<owner>');
--   the same message_id = a re-extract of the original (proceeds).
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- SQL FIRST (house order). The code fails OPEN — with the table missing every
-- court email logs a "content dedupe failed" console error and is processed
-- normally — but that is a safety net, not a deploy plan.
--
-- ── SHAPE NOTES ─────────────────────────────────────────────────────────────
--   content_hash  sha256 hex (lowercase) of normWs(subject) + '\n' +
--                 normWs(body); normWs = lib/courtCitation's whitespace
--                 collapse. PK = the dedupe key.
--   message_id    the owner, exactly as court_extract canonicalizes it
--                 (angle brackets stripped). VARCHAR(255) matches
--                 email_log.message_id; court_extract skips dedupe for longer
--                 ids rather than let the non-strict sql_mode truncate them.
--   COLLATE is explicit — ref/SCHEMA_CONVENTIONS.md: a bare DEFAULT
--   CHARSET=utf8mb4 would land on utf8mb4_0900_ai_ci and fail
--   tests/schemaConventions.test.js once the dump regenerates.
--   No retention / purge: rows are ~150 bytes; a few hundred court emails a
--   month is negligible.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS — a re-run is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS court_email_hashes (
  content_hash CHAR(64) NOT NULL COMMENT 'sha256 hex (lowercase) of normWs(subject) + LF + normWs(body) - see lib/internal_functions/court.js CONTENT DEDUPE',
  message_id VARCHAR(255) NOT NULL COMMENT 'the OWNER: first message_id that reached court_extract with this content. Same id later = re-extract (proceeds); different id = duplicate delivery (skipped, court_ai_log duplicate_of:<owner>)',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'UTC (the pool runs UTC) - first sighting',
  PRIMARY KEY (content_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='court_extract content dedupe: one row per distinct court-email content hash, owned by the first message_id. No time window - ECF bodies embed the entered-on timestamp, so an identical hash means identical input.';
