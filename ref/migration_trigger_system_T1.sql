-- ============================================================
-- Trigger System — Slice T1 migration
-- Run ONCE, BEFORE deploying T1 code (migration → code order).
-- Tables use IF NOT EXISTS; the seed INSERTs are NOT idempotent —
-- do not re-run the seed section.
-- ============================================================

CREATE TABLE IF NOT EXISTS trigger_rules (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_type       VARCHAR(64)  NOT NULL,
  name             VARCHAR(255) NOT NULL,
  description      TEXT         NULL,
  active           TINYINT(1)   NOT NULL DEFAULT 1,
  position         INT          NOT NULL DEFAULT 0,
  match_mode       ENUM('conditions','code') NOT NULL DEFAULT 'conditions',
  match_config     JSON         NULL,
  transform_mode   ENUM('passthrough','mapper','code') NOT NULL DEFAULT 'passthrough',
  transform_config JSON         NULL,
  match_count      INT          NOT NULL DEFAULT 0,
  last_matched_at  DATETIME     NULL,
  last_modified_by INT          NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_event_active (event_type, active, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS trigger_rule_actions (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  rule_id     INT UNSIGNED NOT NULL,
  name        VARCHAR(100) NULL,
  position    INT          NOT NULL DEFAULT 0,
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  action_type ENUM('workflow','sequence','internal_function','http','hook') NOT NULL,
  config      JSON         NOT NULL,
  KEY idx_rule (rule_id, active, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS trigger_executions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_type    VARCHAR(64) NOT NULL,
  contact_id    INT         NULL,
  case_id       VARCHAR(50) NULL,
  depth         TINYINT     NOT NULL DEFAULT 0,
  status        ENUM('matched','no_match','no_rules','depth_capped','error') NOT NULL,
  rules_matched INT         NOT NULL DEFAULT 0,
  outcomes      JSON        NULL,
  envelope      JSON        NULL,
  error         TEXT        NULL,
  created_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_type_time (event_type, created_at),
  KEY idx_case    (case_id),
  KEY idx_contact (contact_id),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- SEED RULES (run once)
--
-- Rule 1: consult booked  → advance to consult_booked   (appt.created)
-- Rule 2: consult attended → advance to consult_held    (appt.attended)
-- Rule 3: 341 attended     → advance to meeting_341     (appt.attended)
--
-- All three use advance_stage guards (only_from) so they soft-skip
-- anywhere the transition doesn't apply. 'none' guard token = case
-- with no stage-log rows yet.
-- ============================================================

INSERT INTO trigger_rules
  (event_type, name, description, active, position, match_mode, match_config)
VALUES
  ('appt.created', 'Consult booked -> consult_booked',
   'Consult-type appointment created on a case: advance the case to consult_booked. Guard excludes consult_held / intake_complete / contract_sent so a follow-up booking never drags a case backwards. Appt type list is editable in the match conditions.',
   1, 10, 'conditions',
   '{"operator":"and","conditions":[{"path":"case_id","op":"exists"},{"path":"data.appt_type","op":"in","value":["Initial Strategy Session","Strategy Session","Consultation","Intial Strategy Session"]}]}'),

  ('appt.attended', 'Consult attended -> consult_held',
   'Consult-type appointment marked Attended: advance the case to consult_held. Guard allows lead / consult_booked / intake_complete / no_show / no-history only.',
   1, 10, 'conditions',
   '{"operator":"and","conditions":[{"path":"case_id","op":"exists"},{"path":"data.appt_type","op":"in","value":["Initial Strategy Session","Strategy Session","Consultation","Intial Strategy Session"]}]}'),

  ('appt.attended', '341 attended -> meeting_341',
   '341 Meeting marked Attended on a filed case: advance to meeting_341. Guard only_from=filed makes this a no-op everywhere else.',
   1, 20, 'conditions',
   '{"operator":"and","conditions":[{"path":"case_id","op":"exists"},{"path":"data.appt_type","op":"equals","value":"341 Meeting"}]}');

-- Actions (rule ids assumed 1..3 on a fresh install of these tables;
-- if trigger_rules was not empty, replace the rule_id values below with
-- the ids just created).

INSERT INTO trigger_rule_actions (rule_id, name, position, active, action_type, config) VALUES
  (1, 'advance_stage consult_booked', 0, 1, 'internal_function',
   '{"function_name":"advance_stage","params_mapping":{"case_id":"case_id","stage":"''consult_booked''","only_from":"''lead,no_show,not_eligible_yet,not_interested,dead_lead,none''","note":"''Auto: consult appointment booked''"}}'),

  (2, 'advance_stage consult_held', 0, 1, 'internal_function',
   '{"function_name":"advance_stage","params_mapping":{"case_id":"case_id","stage":"''consult_held''","only_from":"''lead,consult_booked,intake_complete,no_show,none''","note":"''Auto: consult attended''"}}'),

  (3, 'advance_stage meeting_341', 0, 1, 'internal_function',
   '{"function_name":"advance_stage","params_mapping":{"case_id":"case_id","stage":"''meeting_341''","only_from":"''filed''","note":"''Auto: 341 meeting attended''"}}');
