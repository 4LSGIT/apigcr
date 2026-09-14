-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-08-26 — Pipeline R2: stage requirements + per-case overrides
--
-- WHY
--   Stages are POSITIONS; requirements are the unordered, parallel WORK ITEMS
--   within a stage. They DERIVE their done-ness from source objects the app
--   already writes (signing_requests, checklists, form_submissions, appts) so
--   nobody has to mark anything — a signed contract IS the requirement being
--   done. Two states derivation cannot express get a sparse override table:
--   `na` ("doesn't apply to this case") and manual `done` ("satisfied outside
--   the system"). Everything else is computed at read time by
--   services/requirementService.resolveRequirements against the detector
--   registry in services/requirementDetectors.js.
--
--   * pipeline_stage_requirements — authored config: one row per work item on
--       a stage. requirement_key is the stable machine id (unique per stage;
--       SHARED across templates when the same work item exists on several —
--       same convention as stage_key). detector names a registry entry;
--       detector_config is validated at WRITE time by that detector's
--       validateConfig (a config that can only fail at read time is a booby
--       trap). hint / effort / group_label are render-only.
--   * case_requirement_overrides — sparse per-case exceptions. Binds by
--       requirement KEY, not id: overrides survive requirement edits AND
--       template switches when keys are shared (same convention as
--       case_stage_log.stage_key). Clearing an override = DELETE the row.
--       status 'na' | 'done' only — every other state is derived.
--
-- ── NO SEEDS, BY DESIGN ─────────────────────────────────────────────────────
-- Requirements are authored in the Case Config admin UI (pipelines.html,
-- per-stage sub-editor) by Fred. Running this migration changes ZERO behavior:
-- empty tables resolve to `requirements: []` everywhere, and getPipeline's
-- default payload does not carry requirements at all (opt-in only).
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- SQL first, then backend, then frontend (house deploy order). This file is
-- inert on its own.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS only. Safe to re-run.
--
-- ── CONVENTIONS ─────────────────────────────────────────────────────────────
-- Explicit DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci (the MySQL-8
-- 0900_ai_ci landmine: omitting COLLATE would default the new tables to
-- utf8mb4_0900_ai_ci and every join against cases / pipeline_stages /
-- case_stage_log would need explicit COLLATE clauses). No FK constraints
-- (repo convention: FK-by-convention only). No reliance on
-- STRICT_TRANS_TABLES — all lengths/enums are validated in JS with 400s.
--
-- case_requirement_overrides.case_id is varchar(20) — matched to
-- cases.case_id EXACTLY (verified live 2026-08-26: varchar(20)
-- utf8mb4_general_ci; case_stage_log.case_id is also varchar(20)).
-- The worker prompt sketched varchar(8); its own instruction was "match
-- cases.case_id type exactly (verify)", and 8 is wrong.
--
-- set_by follows the signing_requests.created_by convention:
-- users.user id, 0 = system/api-key caller (no JWT user id available).
--
-- After running: regenerate the schema snapshot via
-- POST /admin/db/schema/save-to-ref (ref/database.sql is auto-generated —
-- do not hand-edit it).
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- DROP TABLE case_requirement_overrides, pipeline_stage_requirements;
-- ─────────────────────────────────────────────────────────────────────────────


-- ── DDL ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pipeline_stage_requirements (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  stage_id INT UNSIGNED NOT NULL,
  requirement_key VARCHAR(60) NOT NULL,        -- ^[a-z0-9_]{1,60}$ ; overrides bind to THIS
  internal_label VARCHAR(120) NOT NULL,
  client_label VARCHAR(120) NULL,
  client_visible TINYINT(1) NOT NULL DEFAULT 1,
  required TINYINT(1) NOT NULL DEFAULT 1,
  owner ENUM('client','staff','system') NOT NULL DEFAULT 'client',
  kind ENUM('task','event') NOT NULL DEFAULT 'task',
  hint VARCHAR(255) NULL,                      -- static subtitle ("Last 60 days · 4 files")
  effort VARCHAR(30) NULL,                     -- "~25 min"
  group_label VARCHAR(60) NULL,                -- staff-side grouping; render concern only
  detector VARCHAR(30) NOT NULL,               -- registry key (services/requirementDetectors.js)
  detector_config JSON NULL,
  sort_order INT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stage_reqkey (stage_id, requirement_key),
  KEY idx_req_stage (stage_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS case_requirement_overrides (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  case_id VARCHAR(20) NOT NULL,                -- = cases.case_id (varchar(20), verified live)
  requirement_key VARCHAR(60) NOT NULL,        -- KEY, not id: survives requirement edits AND
                                               -- template switches when keys are shared (same
                                               -- convention as case_stage_log.stage_key)
  status ENUM('na','done') NOT NULL,
  note VARCHAR(255) NULL,
  set_by INT NOT NULL,                         -- users.user; 0 = system/api-key caller
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_case_reqkey (case_id, requirement_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- VERIFY 1 — both tables exist with the intended collation. Expect two rows,
-- both utf8mb4_general_ci:
--   SELECT TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES
--    WHERE TABLE_SCHEMA = DATABASE()
--      AND TABLE_NAME IN ('pipeline_stage_requirements','case_requirement_overrides');
--
-- VERIFY 2 — BLOCKING. case_id widths agree (a narrower override column would
-- silently clip under the session's lax sql_mode). Expect all three rows to
-- read varchar(20):
--   SELECT TABLE_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'case_id'
--      AND TABLE_NAME IN ('cases','case_stage_log','case_requirement_overrides');
--
-- VERIFY 3 — both tables empty (no seeds). Expect 0 / 0:
--   SELECT (SELECT COUNT(*) FROM pipeline_stage_requirements) reqs,
--          (SELECT COUNT(*) FROM case_requirement_overrides) overrides;
