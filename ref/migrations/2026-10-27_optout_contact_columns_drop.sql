-- ref/migrations/2026-10-27_optout_contact_columns_drop.sql
--
-- Opt-out follow-up (ruling 2026-10-27; Fred's go the same day): drop the two
-- retired contact-level opt-out columns, and name the row flags THE consent
-- flag in the schema. Applied by scripts/optoutContactColumnsDrop.js --apply,
-- NOT by pasting this file anywhere: the script runs these statements on ONE
-- connection with the session setting they depend on, asserts the live state
-- before writing (and again after setting it), re-counts under the table lock
-- immediately before the DROP, verifies the end state after, and smoke-tests a
-- contact UPDATE in a rolled-back transaction. This file is the durable record
-- of what it runs.
--
--   contacts.contact_sms_optout     DROP  — retired: consent is the row's flag
--   contacts.contact_email_optout   DROP
--   contact_phones.sms_optout       COMMENT: THE SMS/MMS consent flag
--   contact_emails.email_optout     COMMENT: THE email consent flag
--
-- Sweep (CLAUDE.md "Dropping a COLUMN"), 2026-10-26 / 10-27: all 1,106
-- contacts hold 0 in both columns; no code reader or writer (the report
-- manifest and test fixtures stopped naming them in the slice that ships this
-- file); no trigger, view, index or generated column names them; zero hits in
-- 30+ app definition tables (RO endpoint) and in app_settings (SU console).
--
-- ORDER: CODE FIRST, THEN THIS. The deploy rule is SQL → backend; a DROP
-- inverts it — the column must outlive every reader, so the code that stopped
-- naming these columns (lib/reportSchema/manifest.js, the report author's
-- schema) is deployed before this runs.
--
-- THE REPORT GRANT (proved on MySQL 8.4.11). yc_report holds per-column SELECT
-- on contacts, both columns included (scripts/reportGrantUserProvision.js,
-- provisioned 2026-10-22 from the live schema). The DROP does not fail on it:
-- the grant is left ORPHANED in mysql.columns_priv / SHOW GRANTS — inert, but
-- it re-attaches to any later column of the same name. Optional cleanup, as
-- root (the app user can neither see nor revoke it):
--   REVOKE SELECT (`contact_sms_optout`, `contact_email_optout`)
--     ON `<database>`.`contacts` FROM 'yc_report'@'%';
-- or the next `reportGrantUserProvision.js --apply --rotate` (its targeted
-- REVOKE of the SHOW GRANTS line succeeds though the line names a dropped
-- column, and the plan read from information_schema no longer grants it).
--
-- SESSION SETTING THE SCRIPT HOLDS ON ITS ONE CONNECTION:
--   lock_wait_timeout = 5   LOCK TABLES and the ALTERs take an exclusive
--                           metadata lock; queued behind a long transaction
--                           one would stall every query on the table for up
--                           to the global default (a year). Measured: with a
--                           transaction holding contacts, LOCK TABLES gives up
--                           after 5 s and nothing has changed.
-- LOCK TABLES contacts WRITE closes the gap between the value census and the
-- DROP: no write can set a value the drop would lose.
--
-- ALGORITHMS (measured on 8.4.11): contacts has a FULLTEXT index, which rules
-- out INSTANT and INPLACE for the drop (error 1846) — a COPY rebuild of ~1.1k
-- rows, under a second. A column COMMENT change is metadata only: INSTANT.
--
-- The smoke UPDATE burns one log.log_id (rolled-back inserts keep their
-- auto-increment value) — expected, harmless.

SET SESSION lock_wait_timeout = 5;

LOCK TABLES `contacts` WRITE;
-- (the script re-counts nonzero values here and stops if there are any)
ALTER TABLE `contacts` DROP COLUMN `contact_sms_optout`, DROP COLUMN `contact_email_optout`, ALGORITHM=COPY;
UNLOCK TABLES;

ALTER TABLE `contact_phones` MODIFY COLUMN `sms_optout` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'messaging consent: 1 = opted out of SMS/MMS. THE consent flag (services/optoutService.js); only the active row (end_date IS NULL) counts; automation refuses, staff sends warn', ALGORITHM=INSTANT;
ALTER TABLE `contact_emails` MODIFY COLUMN `email_optout` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'messaging consent: 1 = opted out of email. THE consent flag (services/optoutService.js); only the active row (end_date IS NULL) counts; automation refuses, staff sends warn', ALGORITHM=INSTANT;

-- ── ROLLBACK (not expected: every value was 0) ─────────────────────────────
-- Re-adding restores the shape, not meaning — nothing reads the columns:
--   ALTER TABLE `contacts`
--     ADD COLUMN `contact_sms_optout` tinyint(1) NOT NULL DEFAULT '0' AFTER `contact_updated`,
--     ADD COLUMN `contact_email_optout` tinyint(1) NOT NULL DEFAULT '0' AFTER `contact_sms_optout`,
--     ALGORITHM=COPY;
-- (an orphaned yc_report grant, if not revoked, re-attaches to them at once)
-- The comments are harmless to keep.
