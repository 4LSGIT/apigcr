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
-- The failure WAS detected — lib/alerting.js (_scanPhoneIngest) already
-- watches action_outcomes and streamed it into system_alerts: alert id 81,
-- kind='action_failed', ref phone_ingest_executions #4529, created
-- 2026-07-16T15:00:03Z — 33 minutes after the execution (14:27:09), on the
-- hourly sweep. (Verified live, T6 review remediation; an earlier draft of
-- this comment claimed "no failure view in the app could see it," which was
-- false.)
--
-- What was MISSING is an inline, per-row signal. The alert lands in a
-- separate ledger; the Activity page and the ingest admin lists rendered
-- #4529 as a green `suppressed` chip with nothing indicating its action had
-- failed. Adding the ingest sources to the Activity page with a status-only
-- filter would have shipped that same per-row blindness.
--
-- The `slim` half of T2 is justified independently of any of this:
-- raw_input averages 16.5 KB/row on email, so a 25-row fetch went
-- 399.6 KB → 2.0 KB on the Activity page's 60s auto-refresh loop.
--
-- WHAT: a generated column counting failed action outcomes, plus an index,
-- so `has_failure` becomes an index range read instead of the 528ms full
-- JSON scan measured against live data (and growing with the table). The
-- index also serves the alerting sweep itself: T6/F-2 pointed
-- _scanEmailIngest / _scanPhoneIngest at this column, replacing their
-- duplicated JSON_SEARCH predicate — one definition of "failed" instead of
-- two SQL dialects of it.
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
-- T6/F-3 + T7/F-8 ADDENDUM: two further synthetic outcomes now feed this
-- column, so it counts three shapes, not one:
--   real action  { rule_id:N,    rule_action_id:N,    <dispatchable type> }
--   transform    { rule_id:N,    rule_action_id:null, 'transform' }        T6/F-3
--   evaluator    { rule_id:null, rule_action_id:null, 'rule_evaluation' }  T7/F-8
-- Read the column as "this execution's Layer-3 processing failed" — an
-- action failed, OR its transform failed, OR the evaluator itself threw.
-- Same detector, wider net; no expression change was needed, because every
-- shape is an array entry with status:'failed'. Both synthetic types are
-- outside the dispatchable action set, so neither can collide with a real
-- action outcome.
--
-- SHAPE ASSUMPTION (T6/F-7): the expression assumes action_outcomes is a
-- JSON ARRAY of objects whose `status` is a plain string.
-- JSON_EXTRACT('$.action_outcomes[*].status') does NOT autowrap a bare
-- object — {action_outcomes:{status:"failed"}} yields 0 (silent
-- under-report). Conversely JSON_SEARCH recurses, so a non-string `status`
-- containing a nested "failed" string would over-count. All 739 values
-- live at verification time were JSON ARRAYs and every writer
-- (emailIngestService / phoneIngestService _buildMetadata ←
-- *IngestRuleService.evaluateRules) builds arrays of flat objects — a
-- future writer emitting a bare object breaks this column silently. Keep
-- it an array.
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