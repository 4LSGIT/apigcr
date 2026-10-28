-- ref/migrations/2026-10-28_appt_length_smallint.sql
--
-- Widen appts.appt_length from a SIGNED TINYINT to SMALLINT. Applied by
-- scripts/apptLengthSmallint.js --apply, NOT by pasting this file anywhere:
-- the script runs the ALTER on ONE connection with the session setting it
-- depends on, asserts the live column before writing and the end state after.
-- This file is the durable record of what it runs.
--
-- WHY. A signed tinyint holds -128..127, and production's sql_mode is relaxed
-- (no STRICT_TRANS_TABLES): a longer length is stored as 127 with only a
-- warning, and the STORED generated appt_end (appt_date + interval
-- appt_length minute) with it. Reproduced on MySQL 8.4.11 under the
-- production sql_mode: INSERT of 180 stored 127, appt_end 2h07m after start.
-- Found by the Ask Casey appointment-confirmation slice (1b7e9ce), which
-- refused a {{appts.appt_length}} / {{appts.appt_end}} placeholder on a
-- length over 127 as a stopgap; that refusal is removed with this change.
--
-- LIVE STATE BEFORE (CHECK, 2026-10-28): appt_length tinyint, NULL, default
-- NULL, no comment, ordinal position 8; 2,253 rows, 0 NULL, min 1, max 90,
-- 0 rows at exactly 127 — nothing was clamped, nothing to repair. No trigger,
-- view, routine or event names the column; appt_end is its only dependant.
-- NULL-ness and default are restated unchanged — only the type and the
-- comment change.
--
-- ORDER IS ABSOLUTE:
--   1. THIS
--   2. backend deploy — services/assistantService.js no longer refuses a
--      length over 127 in a confirmation; before the ALTER it would show the
--      client a length the row then stores as 127.

SET SESSION lock_wait_timeout = 10;

ALTER TABLE `appts` MODIFY `appt_length` smallint NULL DEFAULT NULL
  COMMENT 'minutes; smallint since 2026-10-28 — was signed tinyint, relaxed sql_mode clamped >127 to 127 silently',
  ALGORITHM=COPY, LOCK=SHARED;

-- A type change cannot run in place: COPY with LOCK=SHARED keeps appts
-- readable while writes wait for the copy (seconds at ~2k rows). appt_end is
-- recomputed during the copy and comes out identical; the script verifies
-- row count and appt_length / appt_end checksums before vs after.
--
-- DRY-RUN (the gate on this exact text): MySQL 8.4.11, fresh DB loaded from
-- ref/database.sql, under both a STRICT session and the production sql_mode,
-- with NULL-length and zero-appt_date rows present; re-run is a no-op GO;
-- a held metadata lock makes it give up after 10 s with nothing changed.
--
-- ROLLBACK (not expected): only while no row holds a length over 127 —
--   SELECT COUNT(*) FROM appts WHERE appt_length > 127;   -- must be 0
--   SET SESSION lock_wait_timeout = 10;
--   ALTER TABLE `appts` MODIFY `appt_length` tinyint NULL DEFAULT NULL, ALGORITHM=COPY, LOCK=SHARED;
-- and redeploy the backend from before this change (it restores the 127
-- refusal). Run the rollback in the production session sql_mode: a STRICT
-- session refuses the COPY on a legacy zero appt_date row.
