-- ref/migrations/2026-09-23_trustee_judge_decommission_m6.sql
--
-- Contact-roles arc m6 — trustee/judge storage decommission.
-- Run AFTER the 7B code deploy. This DELIBERATELY inverts the usual
-- SQL-before-code rule: that rule is for ADDITIVE migrations. For drops,
-- the code must stop referencing the storage BEFORE the storage goes away.
--
-- Removes:
--   - `trustees` table (22 rows) and `judges` table (7 rows) — dead since
--     slice 7A; nothing at runtime reads either.
--   - app_settings 'fe-trustees' (9,684 B) and 'fe-trustees-II' (6,543 B) —
--     the retired roster blobs. The roster is served from contacts +
--     contact_roles by lib/trusteeRoster.
--
-- DB console: write mode, stop-on-error ON. Every statement is STANDALONE.
-- Afterwards regenerate the schema dump: POST /admin/db/schema/save-to-ref.

DROP TABLE trustees;

DROP TABLE judges;

DELETE FROM app_settings WHERE `key` IN ('fe-trustees','fe-trustees-II');

-- verify:
SELECT COUNT(*) FROM contact_roles WHERE role='trustee' AND active=1; -- 24

SELECT COUNT(*) FROM contact_roles WHERE role='judge'   AND active=1; -- 7
