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

-- -----------------------------------------------------------------
-- Escalation half — no code needed

-- The other instance was right that alerting already works. I traced it: 
-- _scanWorkflows caught the wf27 abort as severity='error', alert 127 
-- created 21:00:03, digested 21:00:05. The failure was 20:38 — so detection
-- lag was 22 min, and the digest went out 2 seconds later. The delay is entirely
-- the sweep cadence, not the digest.

-- The sweep is scheduled job 867, recurrence_rule = '0 * * * *'. One row changes
-- worst-case detection from 60 min to 15:

UPDATE scheduled_jobs SET recurrence_rule = '*/15 * * * *' WHERE id = 867;
