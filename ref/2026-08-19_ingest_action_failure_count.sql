-- ============================================================
-- T2 — surface ingest action failures that the `status` column hides
--
-- WHY: both ingest pipelines record per-action results in
-- metadata.action_outcomes (emailIngestService / phoneIngestService
-- _buildMetadata) and NEVER reflect them in `status`. An execution whose
-- Layer-3 rule action failed still stores status='logged' or 'suppressed'.
-- Live proof, phone_ingest_executions #4529:
--
--   status:             "suppressed"
--   action_outcomes[0]: { status:"failed", rule_id:3,
--                         action_type:"internal_function",
--                         error:"internal_function delivery failed:
--                                certificate has expired" }
--
-- An expired certificate silently killed a rule action and no failure view
-- in the app could see it. Adding the ingest sources to the Activity page
-- with a status-only filter would have shipped that same blindness.
--
-- WHAT: a generated column counting failed action outcomes, plus an index,
-- so `has_failure` becomes an index range read instead of the 528ms full
-- JSON scan measured against live data (and growing with the table).
--
-- EXPRESSION — verified against live rows and a seven-case edge matrix
-- BEFORE being written here:
--   NULL metadata ............................... 0
--   metadata with no action_outcomes key ........ 0
--   action_outcomes: [] ......................... 0
--   [{status:success}] .......................... 0
--   [{status:failed},{status:failed},{success}] . 2
--   [{status:skipped_test_envelope}] ............ 0   <- deliberate skip, NOT a failure
--   suppression-only metadata ................... 0
--   phone_ingest_executions #4529 ............... 1   <- the known real failure
--
-- The outcome vocabulary is success | failed | skipped_test_envelope
-- (emailIngestRuleService). Only 'failed' counts. JSON_SEARCH uses LIKE
-- semantics, but 'failed' contains no % or _ wildcard, so the match is
-- exact and skipped_test_envelope cannot be caught by it.
--
-- VIRTUAL, NOT STORED: a STORED column forces a full table rebuild, and
-- email_ingest_executions is 62.5 MB (almost entirely raw_input JSON).
-- Adding a VIRTUAL column is metadata-only, and a secondary index on it is
-- built in place and fully usable by the optimizer. Nothing reads this
-- column per row except the index.
--
-- COLLATION: N/A — INT UNSIGNED. Both tables are already
-- utf8mb4_general_ci and conform to the house convention.
--
-- ⚠ WHY FOUR STATEMENTS AND NOT TWO. The obvious form —
--
--     ALTER TABLE x ADD COLUMN ... VIRTUAL,
--                   ADD INDEX idx (that_column, created_at),
--                   ALGORITHM=INPLACE, LOCK=NONE;
--
-- is REJECTED by MySQL 8.4:
--
--     LOCK=NONE is not supported. Reason: ADD COLUMN col...VIRTUAL,
--     ADD INDEX(col). Try LOCK=SHARED.
--
-- Each half is independently online; the COMBINATION is not, because the
-- index build needs the new virtual column's values materialized in the
-- same statement that introduces it. Splitting restores LOCK=NONE — the
-- column lands first as pure metadata, then the index builds against a
-- column that already exists. These are live inbound webhook pipelines
-- (email and phone events arrive continuously), so blocking writes, even
-- briefly, risks a provider-side timeout on an inbound delivery. The
-- tables are small enough that LOCK=SHARED would only be a sub-second
-- block, but there is no reason to take it when splitting is free.
--
-- RUN ORDER: all four statements are standalone (no session variables, no
-- cross-statement state) per house convention — each may run on its own
-- connection. Per table, the COLUMN must precede its INDEX. Run ALL FOUR
-- *BEFORE* deploying the backend: the executions services select and
-- filter on action_failure_count, so a code-first deploy would 500 every
-- executions list — including the ingest pages' own drawers, not just the
-- Activity page — until these land.
--
-- FALLBACK: if statement 2 or 4 still rejects LOCK=NONE on this server,
-- re-run that statement with `LOCK=SHARED` instead. By then the column
-- already exists, so the write-blocking window is just the index build:
-- a few thousand rows, effectively instant. Do NOT fall back to dropping
-- ALGORITHM=INPLACE — that would permit a COPY rebuild of the 62.5 MB
-- email table.
-- ============================================================


-- 1 of 4 — email column (metadata-only) -------------------------------
ALTER TABLE email_ingest_executions
  ADD COLUMN action_failure_count INT UNSIGNED
    GENERATED ALWAYS AS (
      COALESCE(
        JSON_LENGTH(
          JSON_SEARCH(
            JSON_EXTRACT(metadata, '$.action_outcomes[*].status'),
            'all', 'failed'
          )
        ), 0)
    ) VIRTUAL,
  ALGORITHM=INPLACE, LOCK=NONE;


-- 2 of 4 — email index (needs statement 1) ----------------------------
ALTER TABLE email_ingest_executions
  ADD INDEX idx_action_failures (action_failure_count, created_at),
  ALGORITHM=INPLACE, LOCK=NONE;


-- 3 of 4 — phone column (metadata-only) -------------------------------
ALTER TABLE phone_ingest_executions
  ADD COLUMN action_failure_count INT UNSIGNED
    GENERATED ALWAYS AS (
      COALESCE(
        JSON_LENGTH(
          JSON_SEARCH(
            JSON_EXTRACT(metadata, '$.action_outcomes[*].status'),
            'all', 'failed'
          )
        ), 0)
    ) VIRTUAL,
  ALGORITHM=INPLACE, LOCK=NONE;


-- 4 of 4 — phone index (needs statement 3) ----------------------------
ALTER TABLE phone_ingest_executions
  ADD INDEX idx_action_failures (action_failure_count, created_at),
  ALGORITHM=INPLACE, LOCK=NONE;


-- VERIFY 1 — expect exactly one row (phone #4529) until something else fails:
--   SELECT 'email' src, id, status, action_failure_count
--     FROM email_ingest_executions WHERE action_failure_count > 0
--   UNION ALL
--   SELECT 'phone', id, status, action_failure_count
--     FROM phone_ingest_executions WHERE action_failure_count > 0;
--
-- VERIFY 2 — index exists on BOTH tables (expect two rows, seq_in_index=1):
--   SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME
--     FROM information_schema.STATISTICS
--    WHERE TABLE_SCHEMA = DATABASE()
--      AND INDEX_NAME = 'idx_action_failures'
--    ORDER BY TABLE_NAME, SEQ_IN_INDEX;
--
-- VERIFY 3 — index is actually USED (expect type=range, key=idx_action_failures;
-- if it reports type=ALL the 528ms scan is still there and step 2/4 did not take):
--   EXPLAIN SELECT id FROM email_ingest_executions
--    WHERE action_failure_count > 0 ORDER BY id DESC LIMIT 25;
