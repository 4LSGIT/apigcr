-- ─────────────────────────────────────────────────────────────────────────────
-- TASK DEDUPE KEY (2026-08-16)
--
-- Gives a machine-pushed task a stable identifier for the CONDITION it
-- describes, as opposed to the occurrence. services/esignAlertService.js uses
-- it to keep at most one OPEN task per (task_source, task_dedupe_key), and to
-- close that task automatically when the condition clears.
--
-- WHY A NEW COLUMN. `tasks` had no spare field:
--   * task_source  is filtered by exact equality elsewhere
--                  (scripts/esign_e2e_check.js: WHERE task_source = 'esign')
--                  and is documented IMMUTABLE in taskService.updateTask's
--                  allowlist, so it cannot carry a suffix.
--   * task_link    (varchar 50) has live JOIN semantics in taskService.getTask:
--                  `task_link_type IS NULL AND task_link != ''` is matched
--                  against cases.case_number / case_number_full / case_id.
--                  A sentinel there would be attempted as a join key.
--   * task_desc    a sentinel would consume the varchar(1000) budget on
--                  precisely the alerts with the longest bodies, be visible to
--                  staff, and be destroyed by anyone editing the description.
--
-- NOT esign-specific. task_source already marks court_review, client_upload and
-- other machine-pushed notices; any of them can adopt this column without a
-- further migration.
--
-- DEPLOY ORDER: SQL first, per convention. Both directions are inert, though:
--   * SQL before code — an unused NULL column.
--   * code before SQL — esignAlertService's lookup and stamp are each wrapped;
--     "Unknown column 'task_dedupe_key'" is caught, logged, and the alert is
--     RAISED anyway (unkeyed). Behavior degrades to exactly what it was before
--     this feature. Nothing is lost, nothing is suppressed.
--
-- ROLLBACK: ALTER TABLE tasks DROP COLUMN task_dedupe_key;
--           (the index goes with the column)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE tasks
  ADD COLUMN task_dedupe_key VARCHAR(64) NULL DEFAULT NULL AFTER task_source,
  ADD INDEX idx_task_source_dedupe (task_source, task_dedupe_key, task_status);
