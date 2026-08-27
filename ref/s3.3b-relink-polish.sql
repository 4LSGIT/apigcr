-- Documents S3.3b — re-link polish
-- APPLY BEFORE DEPLOYING THE BACKEND, and before committing the patch
-- (the pre-commit hook regenerates ref/database.sql from the live fingerprint;
--  run the ALTER first or it will re-stamp the dump at varchar(255)).

-- ── The current definition, read from the live DB 2026-08-27 ──────────────
--   `case_dropbox` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL
--   nullable · no default · no EXTRA · no comment · not generated
--   ordinal position 44 · NO INDEX touches it · longest live value 125 chars
--
-- ── Why the ALTER names every attribute ───────────────────────────────────
-- MODIFY restates a column's ENTIRE definition; anything not repeated is
-- dropped and re-derived from the table default. The short form —
--     ALTER TABLE cases MODIFY case_dropbox VARCHAR(512) NULL;
-- is harmless TODAY only because `cases` defaults to utf8mb4/utf8mb4_general_ci,
-- which is what this column already carries. It would stop being harmless the
-- moment the table default moved, or the moment someone copied the statement to
-- a table that never matched — and a silently re-collated column is a
-- column-to-column JOIN that fails months later (see tests/schemaConventions).
-- So: every attribute spelled out. MODIFY without FIRST/AFTER keeps position 44.

ALTER TABLE cases
  MODIFY COLUMN `case_dropbox` VARCHAR(512)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
    NULL DEFAULT NULL;

-- Verify (expect: varchar(512) / YES / NULL / utf8mb4 / utf8mb4_general_ci / '' / 44)
-- SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, CHARACTER_SET_NAME,
--        COLLATION_NAME, COLUMN_COMMENT, ORDINAL_POSITION
--   FROM information_schema.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cases'
--    AND COLUMN_NAME = 'case_dropbox';
