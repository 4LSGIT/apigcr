-- ============================================================
-- Trigger System — R4 migration (P1 per-rule history + S6 cooldown)
-- Run ONCE, BEFORE deploying the R4 code (migration → code order).
-- Prereq: the T1 and T3/T4 migrations are already applied.
--
-- NO session variables / no LAST_INSERT_ID across statements — the runner
-- executes each statement on its own connection. (The T3/T4 migration used
-- SET @stage_log_rule_id = LAST_INSERT_ID(); do NOT copy that pattern.)
-- Nothing here needs cross-statement ids: this migration is pure DDL.
--
-- IDEMPOTENCY: the CREATE TABLE is IF NOT EXISTS and re-runnable. The
-- ALTER TABLE is NOT (MySQL 8.4 has no ADD COLUMN IF NOT EXISTS) — re-running
-- it errors 1060 "Duplicate column name", which is harmless but noisy.
-- ============================================================

-- ── P1: per-rule execution history ──────────────────────────
--
-- One row per MATCHED rule per execution, so a rule's own recent-runs card
-- can be answered with an indexed lookup instead of scanning
-- trigger_executions.outcomes JSON.
--
-- NO FK to trigger_rules: these rows must SURVIVE rule deletion (the whole
-- point of an audit trail), which is also why rule_name is denormalized —
-- same reasoning as trigger_rule_actions' rule_name in the outcomes JSON.
-- rule_name is VARCHAR(255) to match trigger_rules.name exactly: sql_mode
-- has no STRICT_TRANS_TABLES, so a narrower column would TRUNCATE a long
-- rule name silently, in the one table whose job is to remember it.
--
-- FK to trigger_executions WITH ON DELETE CASCADE: the retention sweep stays
-- a single batched DELETE and can never leave orphans behind.
CREATE TABLE IF NOT EXISTS trigger_execution_rules (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  execution_id  BIGINT UNSIGNED NOT NULL,
  rule_id       INT UNSIGNED    NOT NULL,
  rule_name     VARCHAR(255)    NOT NULL,
  action_count  INT             NOT NULL DEFAULT 0,
  failed_count  INT             NOT NULL DEFAULT 0,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rule_time (rule_id, id),
  KEY idx_execution (execution_id),
  CONSTRAINT fk_trigger_execution_rules_exec
    FOREIGN KEY (execution_id) REFERENCES trigger_executions (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── S6: per-rule cooldown ───────────────────────────────────
--
-- 0 = no throttle (the default, and every existing rule's behaviour).
-- > 0 = suppress this rule when it last matched within N seconds.
-- Cooldown-suppressed is NOT a match: no match_count bump, no actions, a
-- warning on the execution row naming the rule.
ALTER TABLE trigger_rules
  ADD COLUMN min_interval_s INT NOT NULL DEFAULT 0 AFTER position;
