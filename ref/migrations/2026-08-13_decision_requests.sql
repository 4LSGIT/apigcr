-- HITL decision step — Slice 1 schema
-- Run in DB console. Single self-contained statement (console runs each
-- statement on its own pooled connection).
--
-- decision_requests: one row per request_decision workflow step execution.
-- Soft references only (no FKs — matches existing convention):
--   workflow_execution_id -> workflow_executions.id (bigint)
--   paired_task_id        -> tasks.task_id
--   recipient_user_id     -> users.user
--   recipient_contact_id  -> contacts.contact_id
--
-- status lifecycle:
--   pending   -> responded  (link POST claimed it before expiry)
--   pending   -> timed_out  (decision_timeout_cleanup job at expires_at)
--   pending   -> cancelled  (execution cancelled -> cascade)
-- Terminal states never transition further; the response endpoint's atomic
-- claim (WHERE status='pending' AND expires_at > NOW()) is the arbiter.

CREATE TABLE decision_requests (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  token                 VARCHAR(32) NOT NULL,
  workflow_execution_id BIGINT NOT NULL,
  step_number           INT NOT NULL,
  resume_step           INT NOT NULL,
  recipient_kind        ENUM('user','contact','raw') NOT NULL,
  recipient_user_id     INT NULL,
  recipient_contact_id  INT NULL,
  recipient_email       VARCHAR(255) NULL,
  recipient_phone       VARCHAR(20) NULL,
  question              TEXT NOT NULL,
  options               JSON NOT NULL,
  result_var            VARCHAR(64) NOT NULL,
  timeout_value         VARCHAR(255) NOT NULL,
  expires_at            DATETIME NOT NULL,
  status                ENUM('pending','responded','timed_out','cancelled') NOT NULL DEFAULT 'pending',
  response_value        VARCHAR(255) NULL,
  responded_at          DATETIME NULL,
  responded_via         VARCHAR(20) NULL,
  paired_task_id        BIGINT NULL,
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_decision_token (token),
  KEY idx_decision_exec (workflow_execution_id, status)
) ENGINE=InnoDB;
