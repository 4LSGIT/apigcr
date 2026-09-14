-- ref/2026-08-19_pin_column_defaults_0.sql
--
-- Versioning fixpack (review III.F3) — carry the fail-safe-default reasoning
-- of ref/2026-08-19_current_version_default_0.sql down to the two RUNTIME PIN
-- columns it left behind.
--
-- WHY: workflow_executions.workflow_version and
-- sequence_enrollments.template_version still DEFAULT 1. Application code
-- never relies on it (all five INSERT sites bind the version explicitly;
-- tests/executionVersionStamp.test.js fails any new site that doesn't) — the
-- default only fires for OUT-OF-BAND inserts. Post-versioning, v1 is not
-- reliably "the real definition": it can be a retired draft (wf42 v2 already
-- is; a retired v1 is only a matter of time on new entities). An out-of-band
-- run/enrollment landing on DEFAULT 1 resolves against wrong-or-retired rows
-- SILENTLY. With DEFAULT 0, loadWorkflowStep and scheduleFromStep both throw
-- immediately — the loud-failure direction the parent-column fixpack chose.
--
-- Zero behavioural change to shipped code. Metadata-only in MySQL 8 —
-- instant, no rebuild. Each statement single & console-safe. Reversible with
-- SET DEFAULT 1.
--
-- AFTER RUNNING: ref/database.sql was hand-updated in the same commit to
-- match (all four version-column defaults); regenerate via `npm run db:ref`
-- at the next convenient point for a full refresh.
--
-- Run each statement separately (house console convention):

ALTER TABLE workflow_executions ALTER COLUMN workflow_version SET DEFAULT 0;

ALTER TABLE sequence_enrollments ALTER COLUMN template_version SET DEFAULT 0;
