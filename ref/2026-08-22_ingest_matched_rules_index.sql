-- ============================================================
-- T8 — index metadata.matched_rules so "which emails did rule N fire on?"
--      is a range read instead of a full JSON scan
--
-- ⚠ THIS MIGRATION IS OPTIONAL. Unlike
-- ref/2026-08-19_ingest_action_failure_count.sql — whose generated column
-- the executions services SELECT by name, so a code-first deploy 500s every
-- executions list — nothing here is referenced by name anywhere in the
-- application. The `rule_id` filter is written as
--
--     ? MEMBER OF (e.metadata->'$.matched_rules')
--
-- which is correct with or without this index; the index only changes how
-- the optimizer satisfies it. Deploy order is therefore UNCONSTRAINED: run
-- this before the backend, after it, next month, or never.
--
-- WHY: emailIngestExecutionsService / phoneIngestExecutionsService gained a
-- rule_id filter so an operator can ask "show me every email that triggered
-- rule 21." matched_rules is a JSON array inside the `metadata` column, and
-- no plain index can reach into it, so the filter full-scans:
--
--   EXPLAIN SELECT COUNT(*) FROM email_ingest_executions
--    WHERE 21 MEMBER OF (metadata->'$.matched_rules');
--   -> type=ALL, key=NULL, rows=12767   (~420ms measured, 2026-08-22)
--
-- 420ms is fine for an admin page today. It is linear in table size, and
-- email_ingest_executions is at 16,107 rows and growing with every inbound
-- message, so this exists to be applied whenever that number stops being
-- fine. There is no urgency and no correctness stake.
--
-- WHAT: a MULTI-VALUED index (MySQL 8.0.17+; this server is 8.4.6). A
-- multi-valued index stores one index record per ARRAY ELEMENT rather than
-- one per row, which is exactly the shape needed here — a single execution
-- can match several rules (maxlen 3 on live email data). The optimizer uses
-- it for MEMBER OF, JSON_CONTAINS and JSON_OVERLAPS.
--
-- ⚠ THE PROBE MUST STAY BARE. MySQL matches a multi-valued index against
-- the literal expression indexed. `21 MEMBER OF (metadata->'$.matched_rules')`
-- matches; wrapping the left side — `CAST(21 AS UNSIGNED) MEMBER OF (…)` —
-- or changing the path silently costs the index and returns the scan with
-- no error. The service pushes rule_id as a JS NUMBER for exactly this
-- reason (a string param would render '21' and match zero rows anyway).
-- If you ever "tidy" that predicate, re-run VERIFY 3.
--
-- SHAPE — verified against live data BEFORE writing this file. A
-- multi-valued index build FAILS (not warns) if any value is not castable
-- to the declared type, so this was not assumed:
--
--   email_ingest_executions, rows with a matched_rules key ...... 739
--     JSON_TYPE(matched_rules) <> 'ARRAY' ........................   0
--     element JSON_TYPE ......................................... INTEGER (all)
--     empty arrays ..............................................   0
--     max array length ..........................................   3
--   phone_ingest_executions, rows with a matched_rules key ......  65
--     JSON_TYPE(matched_rules) <> 'ARRAY' ........................   0
--     element JSON_TYPE ......................................... INTEGER (all)
--     empty arrays ..............................................   0
--     max array length ..........................................   1
--   MIN(id) email_ingest_rules = 1, phone_ingest_rules = 2
--     -> no zero/negative ids, so UNSIGNED ARRAY is safe
--
-- Rows with NO matched_rules key extract to SQL NULL and are simply indexed
-- as NULL; they are the majority (15,368 of 16,107 on email) and cost one
-- NULL record each. Rows with an EMPTY array would contribute no index
-- record at all — none exist today, and none can: _buildMetadata only
-- writes matched_rules when matchedRuleIds.length is non-zero.
--
-- WRITER CONTRACT this index depends on (same contract
-- action_failure_count already depends on): matched_rules is a JSON ARRAY
-- of non-negative integers, written by emailIngestService /
-- phoneIngestService _buildMetadata from
-- *IngestRuleService.evaluateRules().matchedRuleIds. A future writer
-- emitting a bare scalar, a string id, or a negative id breaks the index
-- BUILD loudly on rebuild — but until then would just fail to be found.
-- Keep it an array of ints.
--
-- NOT COVERED BY THIS INDEX: the `action_status` filter, which reads
-- metadata.action_outcomes[].status via JSON_CONTAINS and still scans.
-- Deliberately left alone — the indexed action_failure_count column from
-- 2026-08-19 already answers the only high-traffic case ("something
-- failed"), and action_status is a drill-down applied to an already-narrow
-- result. Do not add a second multi-valued index speculatively.
--
-- VIRTUAL/STORED: N/A — a multi-valued index is a functional index over an
-- expression; no column is added and nothing is materialized per row.
-- email_ingest_executions is ~62.5 MB, almost entirely raw_input JSON, so
-- avoiding a table rebuild matters; ALGORITHM=INPLACE, LOCK=NONE builds the
-- index online.
--
-- COLLATION: N/A — UNSIGNED integers.
--
-- RUN ORDER: the two statements are independent (different tables, no
-- session state) per house convention and may run on separate connections,
-- in either order. Unlike the 2026-08-19 migration there is NO dependency
-- on a preceding ADD COLUMN, so each is a single online ALTER.
--
-- FALLBACK: if either statement rejects LOCK=NONE on this server, re-run
-- that statement with LOCK=SHARED. These are live inbound webhook pipelines
-- (email and phone events arrive continuously), so a write-blocking window
-- risks a provider-side timeout on an inbound delivery — but the index is
-- a few hundred records and the block would be effectively instant. Do NOT
-- drop ALGORITHM=INPLACE: that permits a COPY rebuild of the 62.5 MB email
-- table.
--
-- ROLLBACK (safe at any time — nothing reads this index by name):
--   ALTER TABLE email_ingest_executions DROP INDEX idx_matched_rules,
--     ALGORITHM=INPLACE, LOCK=NONE;
--   ALTER TABLE phone_ingest_executions DROP INDEX idx_matched_rules,
--     ALGORITHM=INPLACE, LOCK=NONE;
-- ============================================================


-- 1 of 2 — email ------------------------------------------------------
ALTER TABLE email_ingest_executions
  ADD INDEX idx_matched_rules (
    (CAST(metadata->'$.matched_rules' AS UNSIGNED ARRAY))
  ),
  ALGORITHM=INPLACE, LOCK=NONE;


-- 2 of 2 — phone ------------------------------------------------------
ALTER TABLE phone_ingest_executions
  ADD INDEX idx_matched_rules (
    (CAST(metadata->'$.matched_rules' AS UNSIGNED ARRAY))
  ),
  ALGORITHM=INPLACE, LOCK=NONE;


-- VERIFY 1 — index exists on BOTH tables (expect two rows; COLUMN_NAME is
-- NULL and EXPRESSION carries the CAST, because this is a functional index):
--   SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, EXPRESSION
--     FROM information_schema.STATISTICS
--    WHERE TABLE_SCHEMA = DATABASE()
--      AND INDEX_NAME = 'idx_matched_rules'
--    ORDER BY TABLE_NAME;
--
-- VERIFY 2 — results are UNCHANGED by the index (this is the one that
-- matters; a multi-valued index that silently drops rows is worse than no
-- index). Expect 52 for rule 21 on email as of 2026-08-22 — the number will
-- drift as mail arrives, so compare the two counts to each other, not to 52:
--   SELECT
--     (SELECT COUNT(*) FROM email_ingest_executions
--       WHERE 21 MEMBER OF (metadata->'$.matched_rules'))            AS via_member_of,
--     (SELECT COUNT(*) FROM email_ingest_executions
--       WHERE JSON_CONTAINS(metadata->'$.matched_rules', '21'))      AS via_contains;
--
-- VERIFY 3 — index is actually USED (expect type=range, key=idx_matched_rules;
-- type=ALL means the optimizer declined it and the scan is still there —
-- check the probe has not been wrapped, see THE PROBE MUST STAY BARE above):
--   EXPLAIN SELECT id FROM email_ingest_executions
--    WHERE 21 MEMBER OF (metadata->'$.matched_rules')
--    ORDER BY id DESC LIMIT 25;
