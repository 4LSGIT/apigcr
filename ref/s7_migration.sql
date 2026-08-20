-- §7 slice — hook_delivery_logs.status honesty (2026-08-20)
--
-- Adds 'queued' to the status enum so a workflow-target delivery can record
-- that the execution was ENQUEUED rather than claiming it was delivered.
--
-- RUN THIS BEFORE DEPLOYING THE CODE PATCH.
-- This deployment's sql_mode lacks STRICT_TRANS_TABLES, so writing 'queued'
-- to the un-widened enum does NOT error — MySQL silently coerces it to ''.
-- Deploying code first would quietly write empty-string statuses.
--
-- Single statement, no session variables, no transaction (DB console runs
-- each statement on its own connection).
--
-- Backward compatible: existing 'success'/'failed' rows are untouched, the
-- DEFAULT is unchanged, and the old code can still write both old values, so
-- this is safe to run ahead of the deploy and safe to leave in place on a
-- code rollback.

ALTER TABLE hook_delivery_logs
  MODIFY COLUMN status ENUM('success','failed','queued')
  COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'failed';
