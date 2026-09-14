-- ref/2026-09-06_FIL1_trustee_validation.sql
--
-- FIL-1 Phase 2 — trustee validation wiring. Every statement is STANDALONE
-- (DB console runs each on its own pooled connection: no session variables,
-- no LAST_INSERT_ID; the action row finds its rule by unique name instead).
--
-- SHIPS SAFE: the rule is ACTIVE but the function is gated by
-- app_settings 'trustee_validation_live' = '0' (statement 1), so the next
-- real 341 notice produces a visible DRY RUN (summary email to it@4lsg.com,
-- [DRY RUN] task to user 6) and writes nothing. Arm by flipping the setting
-- to '1'. Requires the lib/internal_functions/trustee.js deploy FIRST —
-- a rule firing an unknown function name errors on every 341 notice.

-- 1) Dry-run gate (INSERT IGNORE — `key` is the PK; re-running is a no-op
--    and never overwrites a flipped value).
INSERT IGNORE INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`)
VALUES ('trustee_validation_live', '0', 0, 1, 'court',
        'Trustee validation live',
        'validate_case_trustee: ''1'' = live (writes cases.case_trustee / case_341_link, alerts Rena). Anything else = dry-run (no case writes; alert to user 6; summary email to it@4lsg.com).',
        'text');

-- 2) The trigger rule. starts_with 'meeting_' covers exactly meeting_ch7,
--    meeting_ch13, and meeting_continued (no other courtExtract
--    classification carries that prefix); re-validation on a continued
--    notice is deliberate — the executor may have overwritten case_trustee
--    from the new email.
INSERT INTO trigger_rules
  (event_type, name, description, active, position, min_interval_s,
   match_mode, match_config, transform_mode, transform_config)
VALUES
  ('case.court_processed',
   'Court 341 notice -> validate trustee',
   'FIL-1: after the court executor lands a 341 notice (meeting_ch7 / meeting_ch13 / meeting_continued), canonicalize cases.case_trustee against the fe-trustees roster and set cases.case_341_link from the roster Zoom link; no-match/ambiguous raises a deduped task instead of guessing. Dry-run gated by app_settings trustee_validation_live.',
   1, 100, 0,
   'conditions',
   '{"operator":"and","conditions":[{"op":"exists","path":"case_id"},{"op":"starts_with","path":"data.classification","value":"meeting_"}]}',
   'passthrough', NULL);

-- 3) The action row — rule found by its unique name (cross-connection safe).
INSERT INTO trigger_rule_actions (rule_id, name, position, active, action_type, config)
SELECT id, 'validate trustee', 1, 1, 'internal_function',
       '{"function_name":"validate_case_trustee","params_mapping":{"case_id":"case_id"}}'
  FROM trigger_rules
 WHERE name = 'Court 341 notice -> validate trustee'
 LIMIT 1;

-- Verify:
--   SELECT r.id, r.active, a.id action_id FROM trigger_rules r
--     JOIN trigger_rule_actions a ON a.rule_id = r.id
--    WHERE r.name = 'Court 341 notice -> validate trustee';
--   SELECT `value` FROM app_settings WHERE `key` = 'trustee_validation_live';
--
-- ARM (after a good dry run on a real notice):
--   UPDATE app_settings SET `value` = '1' WHERE `key` = 'trustee_validation_live';
--
-- ROLLBACK:
--   UPDATE trigger_rules SET active = 0 WHERE name = 'Court 341 notice -> validate trustee';
