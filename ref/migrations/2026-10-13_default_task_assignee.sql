-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-13 — default_task_assignee (appointment follow-up tasks)
--
-- WHY
--   apptService.cancelAppt / rescheduleLater create an optional follow-up
--   task assigned to the ACTING user. A caller with no user — the Calendly
--   cancel workflow (wf50) posts /api/appts/cancel on the internal API key,
--   so req.auth has no userId — passed to:0; createTask threw "requires to"
--   and the catch swallowed it. Every Calendly cancel since 2026-09-06 asked
--   for a task and got none (found in a live schedule→reschedule→cancel test,
--   2026-10-13).
--
--   Those callers now fall back to this setting. Staff clicks still assign
--   to the acting user. Unset/invalid → no task + an error-severity alert
--   (kind appt_followup_no_assignee) instead of a silent console line.
--
--   NO SCHEMA CHANGES — one app_settings row.
--
--   * default_task_assignee — users.user id. Initial value 22 (Rena
--     Grunberger), Fred's call 2026-10-13. createTask's assignment
--     email/SMS to this user is the notification.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- Run BEFORE deploying the code (migrations before code — house rule). If the
-- code lands first, automation cancels raise appt_followup_no_assignee alerts
-- until this row exists; nothing else changes.
--
-- ── IDEMPOTENT / RE-RUN POSTURE ─────────────────────────────────────────────
-- Single-statement-self-contained (console convention). INSERT ... ON
-- DUPLICATE KEY UPDATE with `value` deliberately absent from the UPDATE list
-- (house pattern — 2026-08-06_portal_s3_5.sql): re-running refreshes metadata
-- but never resets a live value. Safe to re-run.
--
-- ── VERIFY ──────────────────────────────────────────────────────────────────
-- SELECT `key`, `value`, category, label FROM app_settings
--  WHERE `key` = 'default_task_assignee';            -- expect one row, value 22
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- DELETE FROM app_settings WHERE `key` = 'default_task_assignee';
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES
  ('default_task_assignee', '22', 0, 1, 'Automations',
   'Default Task Assignee',
   'users.user id that gets appointment follow-up tasks (cancel / reschedule-later) when no staff user did the action, e.g. a Calendly cancellation. Staff actions still assign to the staff member. Unset or not a user id: no task is created and an alert is raised.',
   'number', 10)
ON DUPLICATE KEY UPDATE
  is_secret   = VALUES(is_secret),
  is_editable = VALUES(is_editable),
  category    = VALUES(category),
  label       = VALUES(label),
  description = VALUES(description),
  type        = VALUES(type),
  sort_order  = VALUES(sort_order);
