-- ============================================================================
-- 2026-08-18  Automation Versioning — schema + backfill (Slice S1)
-- ============================================================================
-- Adds per-row versioning to workflow/sequence definitions, version pinning to
-- executions/enrollments, and thin per-version metadata tables.
--
-- RUN ORDER: this file must complete IMMEDIATELY BEFORE the S2 backend deploy.
-- It is purely additive with DEFAULT 1 on every version column, so the
-- currently-deployed code keeps working during the run window (old INSERTs
-- omit the new columns and get version 1, which is also every row's backfilled
-- current_version).
--
-- CONSOLE RULES (house convention): every statement below is single-statement
-- self-contained — no session variables, no cross-statement transactions.
-- Run them top to bottom.
--
-- Design notes (from the reviewed plan, v2):
--   * New unique keys get NEW names (uk_workflow_version_step /
--     uk_template_version_step) — same-name drop+add in one ALTER is not
--     reliably online under InnoDB online DDL. Drop and add are separate
--     statements; the unguarded gap between them is acceptable at 232/111 rows
--     with single-user editors.
--   * sequence_template_versions.template_condition — deliberately NOT named
--     `condition` (reserved word in MySQL 8; every existing reference in this
--     repo has to backtick it, and `template_condition` is already the alias
--     the engine uses downstream: lib/sequenceEngine.js SELECT ... AS
--     template_condition).
--   * No `filters` column on sequence_template_versions: per plan-v2 ruling
--     O3, only `condition` is versioned (it is read mid-flight on every step
--     fire); `filters` is enroll-time-only and stays live on
--     sequence_templates.
--   * retired_at supports discard-as-retire (plan-v2 ruling O2): discarding a
--     draft keeps its rows (draft test-run history stays resolvable) and marks
--     the version retired instead of deleting it.
--   * Explicit COLLATE utf8mb4_general_ci on both new tables — MySQL 8 would
--     otherwise silently pick 0900_ai_ci (the 26-table incident, 2026-08-17).
--     tests/schemaConventions.test.js enforces this in CI.
-- ============================================================================

-- ── Workflows ───────────────────────────────────────────────────────────────

ALTER TABLE workflow_steps ADD COLUMN version INT NOT NULL DEFAULT 1;

ALTER TABLE workflow_steps DROP INDEX uk_workflow_step;

ALTER TABLE workflow_steps ADD UNIQUE KEY uk_workflow_version_step (workflow_id, version, step_number);

ALTER TABLE workflows ADD COLUMN current_version INT NOT NULL DEFAULT 1, ADD COLUMN draft_version INT NULL;

ALTER TABLE workflow_executions ADD COLUMN workflow_version INT NOT NULL DEFAULT 1;

CREATE TABLE workflow_versions (
  workflow_id  INT NOT NULL,
  version      INT NOT NULL,
  name         VARCHAR(100) NULL,
  description  TEXT NULL,
  test_input   JSON NULL,
  published_at DATETIME NULL,
  published_by VARCHAR(100) NULL,
  retired_at   DATETIME NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workflow_id, version),
  CONSTRAINT fk_wfv_workflow FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO workflow_versions (workflow_id, version, name, description, test_input, published_at, published_by)
SELECT id, 1, name, description, test_input, NOW(), 'backfill'
FROM workflows;

-- ── Sequences ───────────────────────────────────────────────────────────────

ALTER TABLE sequence_steps ADD COLUMN version INT NOT NULL DEFAULT 1;

ALTER TABLE sequence_steps DROP INDEX uk_template_step;

ALTER TABLE sequence_steps ADD UNIQUE KEY uk_template_version_step (template_id, version, step_number);

ALTER TABLE sequence_templates ADD COLUMN current_version INT NOT NULL DEFAULT 1, ADD COLUMN draft_version INT NULL;

ALTER TABLE sequence_enrollments ADD COLUMN template_version INT NOT NULL DEFAULT 1;

CREATE TABLE sequence_template_versions (
  template_id        INT UNSIGNED NOT NULL,
  version            INT NOT NULL,
  name               VARCHAR(100) NULL,
  type               VARCHAR(50) NULL,
  template_condition JSON NULL,
  description        TEXT NULL,
  test_input         JSON NULL,
  published_at       DATETIME NULL,
  published_by       VARCHAR(100) NULL,
  retired_at         DATETIME NULL,
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (template_id, version),
  CONSTRAINT fk_stv_template FOREIGN KEY (template_id) REFERENCES sequence_templates(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO sequence_template_versions (template_id, version, name, type, template_condition, description, test_input, published_at, published_by)
SELECT id, 1, name, type, `condition`, description, test_input, NOW(), 'backfill'
FROM sequence_templates;

-- ── Verification (read-only; expected results as of 2026-08-18) ─────────────
-- All step rows at version 1:
--   SELECT COUNT(*) AS total, SUM(version = 1) AS v1 FROM workflow_steps;      -- 232 / 232
--   SELECT COUNT(*) AS total, SUM(version = 1) AS v1 FROM sequence_steps;      -- 111 / 111
-- One backfilled version row per entity:
--   SELECT (SELECT COUNT(*) FROM workflows)          = (SELECT COUNT(*) FROM workflow_versions)          AS wf_ok;   -- 1
--   SELECT (SELECT COUNT(*) FROM sequence_templates) = (SELECT COUNT(*) FROM sequence_template_versions) AS seq_ok;  -- 1
-- Backfilled condition matches live:
--   SELECT COUNT(*) FROM sequence_templates t
--     JOIN sequence_template_versions v ON v.template_id = t.id AND v.version = 1
--    WHERE NOT (t.`condition` <=> v.template_condition);                        -- 0
-- New keys present:
--   SHOW INDEX FROM workflow_steps  WHERE Key_name = 'uk_workflow_version_step';
--   SHOW INDEX FROM sequence_steps  WHERE Key_name = 'uk_template_version_step';
