-- ============================================================================
-- E-SIGN PHASE 3 — reminder sequences + terminal-event cancellation
-- 2026-07-21
--
-- DEPLOY ORDER: SQL first, code second. Every change here is inert until the
-- Phase 3 code reads it: the new column is written only by the new enrollment
-- path, the setting is read only by the new resolution ladder, and the seed
-- sequence fires nothing until an enrollment points at it.
--
-- Apply manually (Fred). Also fold the schema deltas into ref/database.sql.
-- ============================================================================

-- ── 1. sequence_enrollments.signing_request_id ──────────────────────────────
-- Mirror of the appt_id precedent (appt-scoped-cancellation migration), esign
-- flavor: the duplicate-enrollment guard keys on (contact, template,
-- appt_id <=> ?, signing_request_id <=> ?), so one client with TWO live
-- signing requests can hold two enrollments in the same reminder sequence —
-- exactly what appt_id already does for two appointments. INT UNSIGNED to
-- match signing_requests.id. No FK by house style; index for reverse lookups
-- and debugging (cancellation itself goes request → seq_instance_id →
-- cancelEnrollment, no join needed).

ALTER TABLE sequence_enrollments
  ADD COLUMN signing_request_id INT UNSIGNED NULL AFTER appt_id,
  ADD INDEX idx_seq_enroll_signing_request (signing_request_id);

-- ── 2. firm-default reminder sequence setting ───────────────────────────────
-- Resolution ladder at send time: template.reminders_off → OFF;
-- template.reminder_seq_id → that; else THIS setting; else OFF.
-- Empty value = no firm default (reminders off unless a template names one).
-- Same INSERT shape as ref/2026-07-19_esign_phase1c.sql's settings.

INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES
  ('esign_reminder_seq_id', '', 0, 1, 'E-Sign',
   'Default reminder sequence',
   'Sequence template ID enrolled for every e-sign send unless the contract template overrides it (its own sequence, or reminders off). Empty = no automatic reminders by default.',
   'text', 60)
ON DUPLICATE KEY UPDATE `key` = `key`;

-- ── 3. OPTIONAL seed: a default reminder cadence ────────────────────────────
-- Three nudges at ~3 business days apart (10:00), all inside the 14-day
-- expiration window. Each step calls the esign_remind internal function,
-- which re-checks live status before nudging (the race guard) — the sequence
-- itself is only a clock. Zoho sends the actual reminder email (its remind
-- endpoint re-sends the signing invitation); there is no email copy here to
-- write. Staff tune cadence in the sequence admin later.
--
-- The final SELECT prints the new template id. To make it the firm default,
-- the setting is wired automatically below via LAST_INSERT_ID().
-- DELETE FROM HERE DOWN if you'd rather build the sequence by hand.

INSERT INTO sequence_templates (name, type, active, description)
VALUES ('E-Sign Reminder — Default', 'esign_reminder', 1,
        'Nudges outstanding e-signature requests. Steps call esign_remind, which verifies live provider status before reminding — a signed/declined/expired request is never nudged. Enrolled automatically at send time per the template/firm-default resolution.');

SET @esign_seq_id = LAST_INSERT_ID();

INSERT INTO sequence_steps (template_id, step_number, action_type, action_config, timing, error_policy)
VALUES
  (@esign_seq_id, 1, 'internal_function',
   '{"function_name":"esign_remind","params":{"signing_request_id":"{{trigger_data.signing_request_id}}"}}',
   '{"type":"business_days","value":3,"timeOfDay":"10:00"}',
   '{"strategy":"retry_then_ignore","max_retries":2,"backoff_seconds":30}'),
  (@esign_seq_id, 2, 'internal_function',
   '{"function_name":"esign_remind","params":{"signing_request_id":"{{trigger_data.signing_request_id}}"}}',
   '{"type":"business_days","value":3,"timeOfDay":"10:00"}',
   '{"strategy":"retry_then_ignore","max_retries":2,"backoff_seconds":30}'),
  (@esign_seq_id, 3, 'internal_function',
   '{"function_name":"esign_remind","params":{"signing_request_id":"{{trigger_data.signing_request_id}}"}}',
   '{"type":"business_days","value":3,"timeOfDay":"10:00"}',
   '{"strategy":"retry_then_ignore","max_retries":2,"backoff_seconds":30}');

UPDATE app_settings SET `value` = CAST(@esign_seq_id AS CHAR)
 WHERE `key` = 'esign_reminder_seq_id' AND (`value` = '' OR `value` IS NULL);

-- ── verify ──────────────────────────────────────────────────────────────────
SELECT @esign_seq_id AS seeded_sequence_template_id;
SELECT `key`, `value` FROM app_settings WHERE `key` = 'esign_reminder_seq_id';
SELECT COUNT(*) AS steps FROM sequence_steps WHERE template_id = @esign_seq_id;
SHOW COLUMNS FROM sequence_enrollments LIKE 'signing_request_id';
