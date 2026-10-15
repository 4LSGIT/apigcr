-- ref/migrations/2026-10-15_comms_s3b_firm_context.sql
--
-- Comms archive S3b — summary prompt v3's firm context (ref/COMMS_ARCHIVE_DESIGN.md §6.4).
--
--   Part A — BEFORE the backend: one settings row. Plain SQL (the SU console
--            is fine): no ALTER, no session variables.
--
-- comms_summary_firm_context is free text an SU writes about how the firm's
-- phones sound; the summarize sweep puts it (escaped, as data) in the prompt's
-- <firm_context> block beside the staff names from users. Missing or empty =
-- nothing extra; longer than 2,000 characters = summaries stop (alerted).
--
-- Re-runnable: an edited value is never clobbered.

-- ════════════════════════════════════════════════════════════════════════════
-- PART A — before the backend
-- ════════════════════════════════════════════════════════════════════════════

-- ── A1. The firm context ────────────────────────────────────────────────────
INSERT INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES ('comms_summary_firm_context',
  'The firm is Legal Solutions Group (also "4LSG"; sometimes "Metro Detroit Bankruptcy Law"), a consumer bankruptcy law office. The principal attorney is Stuart Sandweiss. Sandweiss is often mis-transcribed as Samwise, Sanway, Sandwise, Sandliss, Sandways or Standwise — read those as Sandweiss.
Many incoming calls are first answered by Sonoma, the firm''s AI receptionist: an automated voice that greets callers, takes messages and books appointments. Sonoma speaks for the firm — an appointment it books or a callback it promises is a firm commitment.
The firm''s recorded greetings, such as "At the present time, there is no one available…", are announcements, not anyone''s statement.
Some calls pass through Google Voice call screening ("please state your name"); that prompt is an automated system, not a party to the call.',
  0, 1, 'Automations', 'Comms Summary Firm Context',
  'Facts about how the firm''s phones sound, for the AI call summaries (prompt v3): the AI receptionist, recorded greetings, call screening, names the transcriber mishears. Staff names come from the users table automatically. At most 2,000 characters — longer stops the summaries (alerted). Read on every tick.',
  'string', 63)
ON DUPLICATE KEY UPDATE `key` = `key`;

-- ── Verify (Part A) ─────────────────────────────────────────────────────────
-- SELECT `key`, CHAR_LENGTH(`value`) AS chars FROM app_settings WHERE `key` = 'comms_summary_firm_context';
