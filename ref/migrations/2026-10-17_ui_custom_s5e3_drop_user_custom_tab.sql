-- 2026-10-17 — ui-custom S5e-3: drop users.user_custom_tab (the retired custom tab)
--
-- S5e-1 (applied 2026-10-16) turned every custom tab into a launcher button and
-- set the column to the JSON null for every user (prior values:
-- 2026-10-16_ui_custom_s5e_custom_tabs_to_buttons.json). S5e-2 removed every
-- reader; S5e-3's commit took the column out of its one writer,
-- routes/admin.users.js's INSERT. Nothing else in the schema names it (no
-- trigger on users at all — swept live 2026-10-17).
--
-- APPLIED BY: node scripts/uiCustomS5e3DropCustomTab.js --apply
-- (one session: lock_wait_timeout = 5; asserts the column definition, that
-- every row holds the JSON null, that nothing else names it, and that the
-- backend which stops naming it is live; verifies after). Run after the soak
-- of S5e-2. Not for the SU console.
--
-- ALGORITHM=INSTANT: a metadata-only drop on 8.4 (measured on 8.4.11 with
-- users built from ref/database.sql); if the server refused it, it errors
-- instead of rebuilding the table.

SET SESSION lock_wait_timeout = 5;
ALTER TABLE `users` DROP COLUMN `user_custom_tab`, ALGORITHM=INSTANT;

-- ROLLBACK (not expected: every value was the JSON null). Puts the column back
-- where it stood (after reset_expires); every existing row comes back as the
-- JSON null it held (measured on 8.4.11 under the live sql_mode). Nothing in
-- the code reads or writes it, so no deploy is needed either way.
--
-- SET SESSION lock_wait_timeout = 5;
-- ALTER TABLE `users` ADD COLUMN `user_custom_tab` json NOT NULL AFTER `reset_expires`, ALGORITHM=INSTANT;
