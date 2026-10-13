-- ref/migrations/2026-10-13_custom_fields_s5b_drop_clio_columns.sql
--
-- Custom-fields arc S5-B — drop the three Clio columns S5-A retired
-- (ref/CUSTOM_FIELDS_DESIGN.md §7 S5-B). Applied by
-- scripts/customFieldsS5bDrop.js --apply, NOT by pasting this file anywhere:
-- the script runs these statements on ONE connection with the session
-- settings they depend on, asserts the live state before writing and the end
-- state after, and smoke-tests a contact and a case UPDATE in a rolled-back
-- transaction. This file is the durable record of what it runs.
--
--   contacts.contact_clio_id  → values in the custom field cf_clio_id since S5-A
--   cases.clio_matter         → values in cf_clio_matter since S5-A
--   cases.case_clio_id        → never filled (0 rows); nothing moved
--
-- Soak: 2026-09-25 → 2026-10-13, across the 2026-10-13 move to Cloud SQL.
-- Verified live 2026-10-13: 240/240 cases and 245/245 contacts carried the
-- same value in the cf_ field, 0 cf-only, case_clio_id empty on all 1,105
-- cases. No trigger but after_contact_update, and no view, generated column,
-- routine or event, names any of the three. Outside the repo only wf37
-- mentions them: prose in its description and step notes, and step #32's
-- create_log payload key `clio_matter` — a LOG FIELD, not a column; leave it.
--
-- ORDER IS ABSOLUTE:
--   1. THIS — the trigger first, then the columns
--   2. backend deploy — it removes the S5-A write freeze, which is only
--      harmless once the columns are gone (with a column still present,
--      updateCase would accept a write to it again)
--
-- THE LANDMINE. after_contact_update names contact_clio_id (OLD. and NEW.).
-- Drop the column with the trigger untouched and the DROP succeeds — then
-- EVERY contact UPDATE fails "ERROR 1054 Unknown column 'contact_clio_id' in
-- 'OLD'", a no-op UPDATE included (a zero-row UPDATE does not fail, so it
-- proves nothing). Proved both ways on MySQL 8.4.11. So the trigger is rebuilt
-- FIRST, minus that one IF block — every other line as it was — and the
-- column drop runs only after the new body is verified byte for byte.
--
-- SESSION SETTINGS THE SCRIPT HOLDS ON ITS ONE CONNECTION:
--   lock_wait_timeout = 5   LOCK TABLES and both ALTERs take an exclusive
--                           metadata lock; queued behind a long transaction
--                           one would stall every query on the table for up
--                           to the global default (a year). Measured: with a
--                           transaction holding contacts, LOCK TABLES gives up
--                           after 5 s and nothing has changed.
--   sql_mode = the old trigger's own SQL_MODE, for the CREATE TRIGGER only,
--                           so the rebuild keeps the stamp it had.
-- LOCK TABLES contacts WRITE closes the gap between DROP and CREATE TRIGGER:
-- measured, a concurrent contact UPDATE waits, then runs and logs through the
-- NEW trigger. The trigger keeps its DEFINER because the script refuses to run
-- as anyone but its current owner (the app user, yc_app@%).
--
-- ALGORITHMS (measured on 8.4.11): contacts has a FULLTEXT index, which rules
-- out INSTANT and INPLACE (error 1846) — a COPY rebuild of ~1.1k rows, under
-- a second. cases is left to MySQL: INSTANT while it has row versions to
-- spend (it spends one), an in-place rebuild once they run out (an
-- unspecified ALGORITHM falls back on its own — verified at 64/64).
--
-- The smoke UPDATE burns one log.log_id (rolled-back inserts keep their
-- auto-increment value) — expected, harmless.

SET SESSION lock_wait_timeout = 5;

-- 1. the trigger (session sql_mode = the old trigger's SQL_MODE while creating)
LOCK TABLES `contacts` WRITE;
DROP TRIGGER `after_contact_update`;
DELIMITER $$
CREATE TRIGGER `after_contact_update` AFTER UPDATE ON `contacts` FOR EACH ROW BEGIN
    DECLARE log_data TEXT;
    SET log_data = JSON_OBJECT();
    SET log_data = JSON_OBJECT(
        'contact_id', NEW.contact_id
    );
    -- Compare each column and add changed fields to log_data
    IF OLD.contact_type != NEW.contact_type THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_type', OLD.contact_type,
            '$.new_contact_type', NEW.contact_type);
    END IF;

    IF OLD.contact_name != NEW.contact_name THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_name', OLD.contact_name,
            '$.new_contact_name', NEW.contact_name);
    END IF;


    IF OLD.contact_pname != NEW.contact_pname THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_pref_name', OLD.contact_pname,
            '$.new_contact_pref_name', NEW.contact_pname);
    END IF;

    IF OLD.contact_phone != NEW.contact_phone THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_phone', OLD.contact_phone,
            '$.new_contact_phone', NEW.contact_phone);
    END IF;

    IF OLD.contact_email != NEW.contact_email THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_email', OLD.contact_email,
            '$.new_contact_email', NEW.contact_email);
    END IF;

    IF OLD.contact_address != NEW.contact_address THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_address', OLD.contact_address,
            '$.new_contact_address', NEW.contact_address);
    END IF;

    IF OLD.contact_city != NEW.contact_city THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_city', OLD.contact_city,
            '$.new_contact_city', NEW.contact_city);
    END IF;

    IF OLD.contact_state != NEW.contact_state THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_state', OLD.contact_state,
            '$.new_contact_state', NEW.contact_state);
    END IF;

    IF OLD.contact_zip != NEW.contact_zip THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_zip', OLD.contact_zip,
            '$.new_contact_zip', NEW.contact_zip);
    END IF;

    IF OLD.contact_dob != NEW.contact_dob THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_dob', OLD.contact_dob,
            '$.new_contact_dob', NEW.contact_dob);
    END IF;

    IF OLD.contact_ssn != NEW.contact_ssn THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_ssn', OLD.contact_ssn,
            '$.new_contact_ssn', NEW.contact_ssn);
    END IF;

    IF OLD.contact_marital_status != NEW.contact_marital_status THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_marital_status', OLD.contact_marital_status,
            '$.new_contact_marital_status', NEW.contact_marital_status);
    END IF;

    IF OLD.contact_tags != NEW.contact_tags THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_tags', OLD.contact_tags,
            '$.new_contact_tags', NEW.contact_tags);
    END IF;

    IF OLD.contact_notes != NEW.contact_notes THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_notes', OLD.contact_notes,
            '$.new_contact_notes', NEW.contact_notes);
    END IF;

    IF OLD.contact_phone2 != NEW.contact_phone2 THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_phone2', OLD.contact_phone2,
            '$.new_contact_phone2', NEW.contact_phone2);
    END IF;

    IF OLD.contact_email2 != NEW.contact_email2 THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_email2', OLD.contact_email2,
            '$.new_contact_email2', NEW.contact_email2);
    END IF;

    -- Insert log entry if any changes were made
    IF JSON_LENGTH(log_data) > 1 THEN
        INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
        VALUES ('update', CONVERT_TZ(NOW(), 'UTC', 'America/New_York'), NEW.contact_id, 1, log_data);
    END IF;
END
$$
DELIMITER ;
UNLOCK TABLES;

-- 2. the columns
ALTER TABLE `contacts` DROP COLUMN `contact_clio_id`, ALGORITHM=COPY;
ALTER TABLE `cases` DROP COLUMN `clio_matter`, DROP COLUMN `case_clio_id`;

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK — not expected: every value lives on in its cf_ field. If the
-- columns must come back, in THIS order (backfill BEFORE the old trigger
-- returns, so the backfill writes no log rows):
--
--   ALTER TABLE `contacts` ADD COLUMN `contact_clio_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL AFTER `contact_notes`;
--   ALTER TABLE `cases` ADD COLUMN `clio_matter` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL AFTER `case_preference`,
--                       ADD COLUMN `case_clio_id` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL AFTER `341_notes`;
--   UPDATE `contacts` SET `contact_clio_id` = `cf_clio_id` WHERE `cf_clio_id` IS NOT NULL;
--   UPDATE `cases` SET `clio_matter` = `cf_clio_matter` WHERE `cf_clio_matter` IS NOT NULL;
--
-- then the old trigger: OLD_BODY in scripts/customFieldsS5bDrop.js (or
-- `git show 0b9d788:ref/database.sql`), with the same LOCK TABLES / DROP /
-- CREATE dance as yc_app; and revert the S5-B code commit, which brings the
-- write freeze back with it.
