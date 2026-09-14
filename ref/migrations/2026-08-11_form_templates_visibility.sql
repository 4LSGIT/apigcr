-- 2026-08-11 External forms X1 — form_templates.visibility
-- Contract: ref/EXTERNAL_FORMS_DESIGN.md §3.
--
-- Run manually via the DB console BEFORE deploying the X1 code (deploy-order
-- rule: SQL migration → backend → frontend; fetchRow/listTemplates SELECT the
-- new column by name).
--
-- Console convention: single-statement-self-contained (each statement runs on
-- its own pooled connection). One ALTER, no session state.
--
-- Re-run safety: MySQL has no ADD COLUMN IF NOT EXISTS — a re-run fails with
-- ER_DUP_FIELDNAME ("Duplicate column name 'visibility'"), which means the
-- migration is already applied. Harmless, nothing partial.
--
-- Semantics (§3): policy lives in this COLUMN, not the definition JSON.
--   internal → external routes serve nothing (the default; every existing row)
--   portal   → Tier B only (portal JWT)
--   public   → Tier A (+ B)
-- External routes serve the PUBLISHED definition only, and only when
-- visibility permits. Until X2 ships there are no external routes; this column
-- gates a surface that does not exist yet — deliberately additive.
--
-- ROLLBACK:
--   ALTER TABLE form_templates DROP COLUMN visibility;

ALTER TABLE form_templates
  ADD COLUMN visibility ENUM('internal','portal','public') NOT NULL DEFAULT 'internal';
