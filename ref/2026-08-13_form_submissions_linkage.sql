-- 2026-08-13 External forms X4 — form_submissions linked_by / linked_at
-- Contract: ref/EXTERNAL_FORMS_DESIGN.md §8 ("stamps who linked it").
--
-- Run manually via the DB console BEFORE deploying the X4 code (deploy-order
-- rule: SQL migration → backend → frontend; linkSubmission UPDATEs the new
-- columns by name).
--
-- Console convention: single-statement-self-contained (each statement runs on
-- its own pooled connection). Two independent ALTERs, no session state.
--
-- Re-run safety: MySQL has no ADD COLUMN IF NOT EXISTS — a re-run fails with
-- ER_DUP_FIELDNAME ("Duplicate column name 'linked_by'"), which means the
-- migration is already applied. Harmless, nothing partial (each ALTER is
-- atomic on its own).
--
-- Semantics: both NULL on every existing row and on every new submission.
-- Written ONLY by the X4 adopt path (PATCH /api/forms/submissions/:id/link)
-- when a staff member links an unlinked (link_type='') submission to a
-- case/contact/appt. submitted_by stays "who filled the form" (NULL for
-- external); linked_by is "who adopted it". A directly-linked external
-- submission (valid case_id at submit time) never gets these stamped —
-- NULL linked_by + non-empty link_type reads as "linked at submit time".
--
-- ROLLBACK:
--   ALTER TABLE form_submissions DROP COLUMN linked_at;
--   ALTER TABLE form_submissions DROP COLUMN linked_by;

ALTER TABLE form_submissions
  ADD COLUMN linked_by int unsigned NULL DEFAULT NULL AFTER submitted_by;

ALTER TABLE form_submissions
  ADD COLUMN linked_at datetime NULL DEFAULT NULL AFTER linked_by;
