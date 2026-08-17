-- ============================================================
-- Schema hygiene — collation normalization to utf8mb4_general_ci
--
-- WHY: the schema default is utf8mb4 / utf8mb4_general_ci, but 26 of 119
-- tables carry a different collation. MySQL refuses column = column
-- comparisons across collations, so these joins THROW today:
--
--   trigger_executions.case_id      = cases.case_id          -- ER_CANT_AGGREGATE_2COLLATIONS
--   case_stage_aged_emitted.case_id = cases.case_id
--   court_ai_log.resolved_case_id   = cases.case_id
--   court_ai_log.case_number        = cases.case_number
--   ai_change_log.entity_id         = cases.case_id
--
-- It has stayed latent because `WHERE case_id = ?` never errors — a bound
-- literal is coercible and adopts the column's collation. Only column-to-
-- column joins fail, and nothing joined these tables until now.
--
-- ROOT CAUSE: writing `DEFAULT CHARSET=utf8mb4` with no `COLLATE` does NOT
-- inherit the schema default. It resets to the CHARSET's default, which on
-- MySQL 8 is utf8mb4_0900_ai_ci. Omitting the clause entirely would have
-- been correct. (The utf8mb4_unicode_ci tables predate that and were
-- explicit.) See the "Schema conventions" note in
-- manual/06-Admin-Tools/01-db-console.md.
--
-- WHY general_ci AND NOT 0900_ai_ci: 0900_ai_ci is the technically better
-- collation. It loses on arithmetic — the target has to be whatever `cases`,
-- `contacts`, and `case_stage_log` already use, and moving 102 tables to
-- reach 26 is not a trade. One collation beats the best collation.
--
-- SAFETY (all verified against live before writing this):
--   - utf8mb4 -> utf8mb4 is a COLLATION-only change. No charset widening, so
--     no VARCHAR -> MEDIUMTEXT type promotion. Column types are preserved.
--   - Every FK touching these tables is on a numeric column (3 FKs:
--     phone_lines.credential_id, trigger_execution_rules.execution_id,
--     trigger_rule_actions.rule_id). No FK can be broken by this.
--   - Every UNIQUE key on an affected string column was pre-flighted for new
--     collisions under general_ci: all returned 0. (Data is ASCII; general_ci
--     and 0900_ai_ci agree on A-Z a-z 0-9.) Re-run VERIFICATION 1 below if
--     time has passed.
--   - JSON columns are unaffected (they carry no user collation).
--
-- COST: CONVERT TO CHARACTER SET cannot run INPLACE — it rebuilds the table
-- (ALGORITHM=COPY). Reads continue; WRITES BLOCK for the rebuild. Largest
-- table here is workflow_execution_steps at ~20k rows: expect well under a
-- second each. Section B touches live workflow-engine tables, so run it when
-- the poller is quiet if you want to be fussy about it.
--
-- ORDER: Sections A and B are independent and individually re-runnable
-- (CONVERT TO on an already-correct table is a no-op rebuild). No session
-- variables anywhere.
-- ============================================================


-- ── VERIFICATION 1 — run FIRST. Every row must show new_dupes = 0. ────────
-- Aborts the whole exercise if a unique key would newly collide.

SELECT 'api_keys.key_hash' AS uq,
       COUNT(*) - COUNT(DISTINCT key_hash COLLATE utf8mb4_general_ci) AS new_dupes FROM api_keys
UNION ALL SELECT 'phone_lines.phone_number',
       COUNT(*) - COUNT(DISTINCT phone_number COLLATE utf8mb4_general_ci) FROM phone_lines
UNION ALL SELECT 'report_definitions.report_key',
       COUNT(*) - COUNT(DISTINCT report_key COLLATE utf8mb4_general_ci) FROM report_definitions
UNION ALL SELECT 'image_library.url',
       COUNT(*) - COUNT(DISTINCT url COLLATE utf8mb4_general_ci) FROM image_library
UNION ALL SELECT 'sequence_template_types.type',
       COUNT(*) - COUNT(DISTINCT type COLLATE utf8mb4_general_ci) FROM sequence_template_types
UNION ALL SELECT 'settings.setting_name',
       COUNT(*) - COUNT(DISTINCT setting_name COLLATE utf8mb4_general_ci) FROM settings;


-- ── SECTION A — the utf8mb4_0900_ai_ci cluster (11 tables) ────────────────
--
-- All small (0-43 rows). Contains the two tables that block real joins:
-- trigger_executions and case_stage_aged_emitted. Run this one first and on
-- its own if you want the smallest possible change that fixes the trigger
-- system.

ALTER TABLE case_stage_aged_emitted   CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE trigger_executions        CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE trigger_execution_rules   CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE trigger_rules             CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE trigger_rule_actions      CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE report_definitions        CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE report_definition_versions CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE report_runs               CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE api_keys                  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE phone_lines               CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE rc_sms_log                CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;


-- ── SECTION B — the utf8mb4_unicode_ci cluster (15 tables) ────────────────
--
-- Older and pre-dating the trigger system. court_ai_log.resolved_case_id and
-- ai_change_log.entity_id are demonstrated live join blockers against
-- cases.case_id, so this is not merely cosmetic.
--
-- Larger tables are last. workflow_execution_steps (~20k) and
-- workflow_executions (~7.5k) are written by the live workflow engine.

ALTER TABLE court_ai_log              CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE ai_change_log             CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE ai_calls                  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE image_library             CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE settings                  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE sequence_template_types   CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE sequence_templates        CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE sequence_steps            CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE sequence_enrollments      CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE sequence_step_log         CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE workflows                 CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE workflow_steps            CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE workflow_executions       CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE workflow_execution_steps  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE campaign_contacts         CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;


-- ── VERIFICATION 2 — run LAST. Must return ZERO rows. ─────────────────────

SELECT TABLE_NAME, TABLE_COLLATION
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_COLLATION IS NOT NULL
   AND TABLE_COLLATION <> 'utf8mb4_general_ci'
 ORDER BY TABLE_NAME;

-- And the joins that used to throw must now count:
SELECT (SELECT COUNT(*) FROM trigger_executions t JOIN cases c ON c.case_id = t.case_id)  AS trig_join,
       (SELECT COUNT(*) FROM court_ai_log l JOIN cases c ON c.case_id = l.resolved_case_id) AS court_join;

-- Then regenerate the committed dump so the CI guard sees the new state:
--   npm run db:ref
