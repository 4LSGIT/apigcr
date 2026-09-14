-- ref/2026-08-18_s4_condition_resync.sql
--
-- Automation versioning S4 — template_condition re-sync (closes the S2/S3
-- drift window flagged in review).
--
-- WHY: sequence_template_versions.template_condition was backfilled from the
-- live `sequence_templates`.`condition` column on 2026-08-18 (S1 migration).
-- Through the S2/S3 window the editor kept writing the LIVE column while the
-- version rows stayed frozen at the backfill snapshot. S4 flips the engine's
-- read to the version row — so any condition edited during the window must be
-- copied forward first, or every enrollment pinned to the current version
-- silently reverts to the backfill-era condition.
--
-- DEPLOY ORDER (matters): run this statement IMMEDIATELY BEFORE deploying the
-- S4 backend — same pattern as the contact_token rename. Pre-S4 code never
-- reads template_condition, so running it early is harmless to the running
-- system; the only exposure is a condition edit landing between this UPDATE
-- and the deploy (a seconds-wide window if run back-to-back). Post-S4 code
-- writes conditions to the draft version row, so the live column stops
-- receiving edits and this statement never needs to run again.
--
-- Idempotent; single statement; console-safe.

UPDATE sequence_template_versions v
  JOIN sequence_templates t
    ON t.id = v.template_id
   AND v.version = t.current_version
   SET v.template_condition = t.`condition`;
