-- ============================================================================
-- 2026-07-26_form_templates.sql
-- YisraForm template system — data layer (Slice 1 of the template-driven forms).
--
-- WHY
--   A template-driven form system sits on top of the existing YisraForms runtime
--   (public/js/yc-forms.js). A single generic renderer (public/forms/render.html)
--   turns a stored JSON `definition` into a working YCForm — no per-form code.
--   This migration creates the two tables that hold those definitions.
--
--   Governing contract: ref/FORM_TEMPLATE_SCHEMA_V1.md §1 (this DDL is that §1,
--   verbatim on columns/keys, with IF NOT EXISTS added for safe re-runs).
--
--   * form_templates          — one row per form_key. The published definition
--                               and the builder's working draft coexist as two
--                               JSON columns (no duplicate-key/version dance):
--                                 definition       = published (NULL = never published)
--                                 draft_definition = working copy the builder edits
--                               schema_version tracks the PUBLISHED definition and
--                               is bumped on publish only when the field set changes
--                               (see contract §6). form_key locks (becomes immutable)
--                               once any form_submissions row exists for it.
--   * form_template_versions  — append-only history: one row per publish.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- RUN THIS FIRST, THEN DEPLOY THE CODE.
--
-- SQL-first is the inert direction. Nothing reads these tables until the
-- matching build ships (routes/api.formTemplates.js + services/formTemplateService.js
-- are auto-mounted from routes/ but query these tables only when called). The
-- reverse order is the dangerous one — deployed routes would query tables that
-- do not exist yet and 500 on every call.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS: safe to re-run. Re-running never touches data.
-- (There are no seed rows; the builder/API creates templates at runtime.)
--
-- ── mysql2 HAZARD (carried into the service layer) ──────────────────────────
-- Both JSON columns come back from mysql2 as PARSED objects. When binding a
-- definition object back to a `?` placeholder the service must JSON.stringify()
-- it first (key-expansion hazard). The publish path avoids this entirely by
-- copying column-to-column in SQL (definition = draft_definition).
-- ============================================================================

CREATE TABLE IF NOT EXISTS form_templates (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  form_key         VARCHAR(50)  NOT NULL,           -- immutable once any form_submissions row exists for it
  title            VARCHAR(150) NOT NULL,
  link_type        VARCHAR(20)  NOT NULL,           -- 'case' | 'contact' | 'appt'
  schema_version   INT UNSIGNED NOT NULL DEFAULT 1, -- of the PUBLISHED definition
  definition       JSON NULL,                       -- published definition; NULL = never published
  draft_definition JSON NOT NULL,                   -- working copy the builder edits
  published_at     DATETIME NULL,
  updated_by       INT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY idx_form_key (form_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS form_template_versions (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  template_id    INT UNSIGNED NOT NULL,
  schema_version INT UNSIGNED NOT NULL,
  definition     JSON NOT NULL,
  published_by   INT UNSIGNED NULL,
  published_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tpl (template_id, published_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;