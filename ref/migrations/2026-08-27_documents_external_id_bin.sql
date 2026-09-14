-- ─────────────────────────────────────────────────────────────────────────────
-- DOCUMENT PROVIDER HANDLES — utf8mb4_bin (2026-08-27)
--
-- Dropbox file ids ("id:a4ayc_80_OEAAAAAAAAAXw") are case-SENSITIVE base64url.
-- Both columns that store one were utf8mb4_general_ci, which case-folds on
-- comparison. `documents` carries UNIQUE uq_source_ext (source, external_id),
-- so two ids differing only in letter case were the SAME KEY: the upsert in
-- documentService.upsertFromEntry took its ON DUPLICATE KEY UPDATE branch and
-- overwrote the existing row with the newcomer's name/path/rev.
--
-- WHY THIS WAS DENSE AND NOT A BIRTHDAY-PARADOX CURIOSITY: the id body is
-- base64 over a near-sequential per-namespace counter, so ids 26 apart in a
-- 6-bit group differ by exactly one letter's case ('B' vs 'b') and nothing
-- else. Case-twins are therefore COMMON in any large folder, not astronomical.
-- 3,000+ distinct files had collapsed onto shared rows before anyone noticed.
--
-- WHY NOBODY SAW AN ERROR: by construction. The write succeeds, affected-rows
-- comes back 2, the row looks freshly synced. There is no runtime signal to
-- check — hence tests/schemaCollationBin.test.js, a lint against ref/
-- database.sql, as the regression guard.
--
-- SAFETY: ci → bin only ever SPLITS equivalence classes, never merges them, so
-- uq_source_ext cannot conflict on existing rows and the implicit index
-- rebuild cannot fail. The reverse direction (bin → ci) would fail on any
-- surviving case-twin pair — do not roll this back without dedup first.
--
-- DEPLOY ORDER: SQL-only, no code change, inert in either order.
--
-- THIS DOES NOT REPAIR THE MERGED ROWS. The losers were overwritten, not
-- stored — there is no trace of them in the DB to recover from. Getting them
-- back means re-listing from Dropbox and re-registering; only then is the
-- documents table complete. Applied live 2026-08-27; ref/database.sql
-- regenerated via `npm run db:ref`.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `documents`
  MODIFY `external_id` varchar(191)
  CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;

ALTER TABLE `case_folder_cache`
  MODIFY `folder_external_id` varchar(191)
  CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL;
