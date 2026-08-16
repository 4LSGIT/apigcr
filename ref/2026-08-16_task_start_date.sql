-- ─────────────────────────────────────────────────────────────────────────────
-- Task start dates ("defer until") — 2026-08-16
--
-- tasks.task_start (DATE) already exists and is already writable: the
-- create_task automation step exposes it as `start_date`, POST /api/tasks
-- accepts it as `start`, and updateTask whitelists it. Eight rows already
-- carry one. Nothing read it, so a task deferred a year still appeared in its
-- assignee's daily digest every day of that year.
--
-- This migration adds ONLY the reminder-job handle. The behaviour change
-- (digest suppression, start reminders, UI) is code.
--
--   task_start_job_id  — mirrors the existing task_due_job_id: the
--                        scheduled_jobs row for the start-date notification,
--                        so it can be cancelled/rescheduled when the start
--                        date moves or the task is completed/deleted.
--
-- Nullable, no default, no backfill: NULL means "no start reminder pending",
-- which is the correct state for every existing row.
--
-- Reversal:
--   ALTER TABLE tasks DROP COLUMN task_start_job_id;
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE tasks
  ADD COLUMN task_start_job_id BIGINT NULL DEFAULT NULL AFTER task_due_job_id;
