-- 2026-08-16_form_dev_role.sql
--
-- Form-dev authoring gate (ref/EXTERNAL_CODE_CSS_DECISION.md §Q5).
--
-- Adds 'form_dev' to the users.roles SET and grants it to user 6 (IT).
-- The grant is technically redundant — lib/auth.formDev.js also passes the
-- 'it' role and 'authorized - SU' — but explicit beats implicit: if either
-- bypass convention ever changes, IT keeps form-dev access.
--
-- SAFETY: the new member is appended at the END of the SET, so every
-- existing row's stored bitmap keeps its meaning (never reorder or remove
-- SET members in-place). Idempotent: re-running the ALTER is a no-op
-- redefinition; the UPDATE's FIND_IN_SET guard prevents double-append.
--
-- Deploy order: this migration FIRST, then backend, then frontend
-- (standard order). The backend gate works before the migration too — it
-- reads the JWT roles claim, not the column — but nobody could be GRANTED
-- form_dev until the SET member exists.
--
-- Roles ride the 24h staff JWT (routes/auth.login.js): a grant/revoke takes
-- effect at the user's next login.

ALTER TABLE users
  MODIFY COLUMN roles SET('it','admin','staff','attorney','automation','form_dev')
  NOT NULL DEFAULT '';

UPDATE users
   SET roles = CONCAT_WS(',', NULLIF(roles, ''), 'form_dev')
 WHERE user = 6
   AND NOT FIND_IN_SET('form_dev', roles);

-- Grant to another user later (no deploy needed; takes effect at next login):
--   UPDATE users SET roles = CONCAT_WS(',', NULLIF(roles,''), 'form_dev')
--    WHERE user = <id> AND NOT FIND_IN_SET('form_dev', roles);
-- Revoke:
--   UPDATE users SET roles = TRIM(BOTH ',' FROM REPLACE(CONCAT(',', roles, ','), ',form_dev,', ','))
--    WHERE user = <id>;
