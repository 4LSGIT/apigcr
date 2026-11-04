-- custom_table_view S4 (Fred-ruled 2026-11-05): the per-def "offer as a list
-- column" flag. Applied by scripts/customTableS4ListColumnFlag.js (CHECK /
-- --apply, resumable, lock_wait_timeout 5); this file is the record.
--
-- The Config custom-fields builder's "Offer as a list column" checkbox
-- writes the flag; the listCases cf SELECT and the Cases Columns picker
-- honor only ACTIVE defs that carry it. cf_court is seeded ON (Court in the
-- Cases table is the point of the slice; the checkbox can turn it off).
--
-- ROLLBACK: ALTER TABLE field_defs DROP COLUMN list_column; the backend
-- that reads it must be rolled back FIRST (fieldDefService SELECT_COLS
-- names the column explicitly).

ALTER TABLE field_defs
  ADD COLUMN list_column tinyint(1) NOT NULL DEFAULT 0
    COMMENT 'custom_table_view S4 (2026-11-05): offer this def as a list-tab column — written by the Config fields builder checkbox "Offer as a list column"; only ACTIVE defs with this flag reach the listCases cf SELECT and the Cases Columns picker. Off by default.'
    AFTER indexed;

UPDATE field_defs SET list_column = 1
 WHERE entity = 'case' AND field_key = 'cf_court';
