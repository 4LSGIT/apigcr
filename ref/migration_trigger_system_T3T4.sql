-- ============================================================
-- Trigger System — T3/T4 migration
-- Run ONCE, BEFORE deploying the T3/T4 code (migration → code order).
-- Prereq: the T1 migration (trigger_* tables) is already applied.
-- Seeds are NOT idempotent — do not re-run.
-- ============================================================

-- ── Seed rule: stage change → case log ──────────────────────
-- Fred's request from T1 smoke: "add a log when a stage changes".
-- Implemented as a trigger rule (not a hardcode): case.stage_advanced →
-- code transform composes the text → create_log internal function writes a
-- type='status' log row on the case. Editable/disable-able like any rule.

INSERT INTO trigger_rules
  (event_type, name, description, active, position, match_mode, match_config,
   transform_mode, transform_config)
VALUES
  ('case.stage_advanced', 'Stage change -> case log',
   'Writes a type=status log entry on the case for every real pipeline stage advance (all surfaces: board, workflows, triggers, esign, checklists). Edit the transform to change the wording.',
   1, 10, 'conditions',
   '{"operator":"and","conditions":[]}',
   'code',
   '{"code":"var f=(input.extra&&input.extra.from_stage)||''(start)'';var t=input.data.stage_key;var l=input.data.status_label?'' (''+input.data.status_label+'')'':'''';var n=(input.extra&&input.extra.note)?'' - ''+input.extra.note:'''';return {case_id:input.case_id,by:(input.actor&&input.actor.user_id)||0,note:''Stage: ''+f+'' -> ''+t+l+n};"}');

SET @stage_log_rule_id = LAST_INSERT_ID();

INSERT INTO trigger_rule_actions (rule_id, name, position, active, action_type, config)
VALUES
  (@stage_log_rule_id, 'create_log on case', 0, 1, 'internal_function',
   '{"function_name":"create_log","params_mapping":{"type":"''status''","link_type":"''case''","link_id":"case_id","by":"by","data":"note"}}');

-- ── Recurring retention sweep job ───────────────────────────
-- Daily 07:00 UTC. Same recurring-job pattern as "Error Alert Sweep"
-- (scheduled_jobs id 867): cron recurrence_rule + internal_function data.
-- Requires the sweep_trigger_executions internal function
-- (lib/internal_functions/system.js — T4 Edit 10) to be deployed before the
-- job's first run; the job insert itself is safe to run before the deploy
-- as long as the deploy lands the same day.

INSERT INTO scheduled_jobs
  (type, scheduled_time, status, active, name, description, data, recurrence_rule, max_attempts)
VALUES
  ('recurring',
   TIMESTAMP(DATE_ADD(CURDATE(), INTERVAL 1 DAY), '07:00:00'),
   'pending', 1,
   'Trigger Executions Sweep',
   'Nightly retention for trigger_executions: no_match/no_rules rows kept 30 days, matched/error rows kept 90 days.',
   '{"type": "internal_function", "params": {}, "function_name": "sweep_trigger_executions"}',
   '0 7 * * *', 3);
