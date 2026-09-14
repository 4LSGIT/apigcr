-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-08-06 — Client Portal, SLICE 3.5: callback requests
--
-- WHY
--   Portal clients request a callback (day + 2-hour window + phone +
--   message); the request becomes a task via taskService.createTask plus a
--   one_time scheduled job that reminds the assignee at window start.
--   Natively replaces the legacy Jotform embed at public/appt.html.
--
--   NO SCHEMA CHANGES. This file only adds the one app_settings row the
--   service reads (recipients resolve from settings — never hardcoded).
--
--   * portal_callback_task_to — users.user id the callback task is
--     assigned to. Phase A decision: default 1 (Stuart Sandweiss).
--     createTask's built-in assignment email/SMS to this user IS the
--     immediate notification; the window-start reminder re-resolves the
--     assignee at fire time, so reassigning the task redirects the
--     reminder too.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- Run BEFORE deploying the Slice 3.5 code (migrations before code — house
-- rule). Inert until routes/portal.callback.js ships. If the code deploys
-- first, POST /api/portal/callback 500s with a clear misconfig error until
-- this row exists (the service refuses to assign to user 0/NaN).
--
-- ── IDEMPOTENT / RE-RUN POSTURE ─────────────────────────────────────────────
-- Single-statement-self-contained (console convention, 2026-08-05 incident).
-- INSERT ... ON DUPLICATE KEY UPDATE with `value` deliberately absent from
-- the UPDATE list (house pattern — 2026-07-19_esign_phase1c.sql /
-- 2026-08-05_portal_s1.sql): re-running refreshes metadata but never resets
-- a live value. Safe to re-run end to end.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- DELETE FROM app_settings WHERE `key` = 'portal_callback_task_to';
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES
  ('portal_callback_task_to', '1', 0, 1, 'Portal',
   'Portal Callback Task Assignee',
   'users.user id assigned the task created by a client-portal callback request. This user gets the immediate assignment email/SMS and the window-start reminder (the reminder follows the task if it is reassigned). Must be a valid user id or callback requests fail.',
   'number', 30)
ON DUPLICATE KEY UPDATE
  is_secret   = VALUES(is_secret),
  is_editable = VALUES(is_editable),
  category    = VALUES(category),
  label       = VALUES(label),
  description = VALUES(description),
  type        = VALUES(type),
  sort_order  = VALUES(sort_order);
