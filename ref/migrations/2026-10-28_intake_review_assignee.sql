-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-28 — intake_review_assignee (contact-match review tasks)
--
-- WHY
--   services/intakeService.js NAME REVIEW: an intake (website / Calendly /
--   API lead) whose phone or email matches one contact under a DIFFERENT name
--   now changes nothing on that contact and opens a "Check contact match"
--   task. Before, the single-match UPDATE wrote the lead's name (and DOB /
--   SSN / address) over the matched contact — a spouse's lead on a shared
--   phone renamed the other spouse.
--
--   The task goes to this setting, else default_task_assignee (the first that
--   is an active user). Neither → no task + an error alert
--   (kind intake_review_no_assignee).
--
--   NO SCHEMA CHANGES — one app_settings row, and OPTIONAL: unset, the
--   fallback routes the task. A registered key (lib/settingsRegistry.js), so
--   only `key` and `value` carry meaning; editable in YisraCase Config →
--   Firm → Routing once the code is deployed.
--
--   Applied by Fred in the SU DB console 2026-10-28, value 22 (Rena
--   Grunberger) — before the code, per house order.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- `value` deliberately absent from the UPDATE list: re-running never resets a
-- live value.
--
-- ── VERIFY ──────────────────────────────────────────────────────────────────
-- SELECT `key`, `value` FROM app_settings WHERE `key` = 'intake_review_assignee';
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- DELETE FROM app_settings WHERE `key` = 'intake_review_assignee';
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO app_settings (`key`, `value`, is_secret)
VALUES ('intake_review_assignee', '22', 0)
ON DUPLICATE KEY UPDATE is_secret = VALUES(is_secret);
