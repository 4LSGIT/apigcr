-- ============================================================
-- Trigger System — case.stage_aged: record of applied + corrections
-- ref/2026-08-17_trigger_stage_aged.sql
--
-- HISTORY: Sections A and B below were ALREADY APPLIED to production on
-- 2026-08-17 (verified live by independent review: table exists with 0
-- rows; scheduled_jobs id 3555 seeded). The original migration file never
-- made it into ref/ — this dated file is the repo record of what ran,
-- plus two CORRECTIVE statements (C, D) found by that review.
--
-- RUN INSTRUCTIONS:
--   A — safe to re-run (IF NOT EXISTS); no-op in prod.
--   B — DO NOT RUN. Recorded commented-out; the live row is job id 3555.
--   C, D — NOT yet applied. Run each ONCE.
-- NO session variables anywhere (runner uses separate connections).
-- ============================================================

-- ── A. Claim table (APPLIED 2026-08-17 — re-run is a no-op) ──
--
-- Keyed on case_stage_log.id, NOT (case_id, stage_key): each stage ENTRY is
-- its own log row, so re-entering a stage re-arms its rungs for free.
-- INSERT IGNORE against uq_stage_threshold IS the atomic dedup/claim.
-- Deliberately NO FK to case_stage_log (log is append-only by contract —
-- advanceStage is the only writer; backfills must APPEND, never rewrite).
CREATE TABLE IF NOT EXISTS case_stage_aged_emitted (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  stage_log_id   BIGINT UNSIGNED NOT NULL,
  threshold_days INT NOT NULL,
  case_id        VARCHAR(20) NOT NULL,
  emitted_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stage_threshold (stage_log_id, threshold_days),
  KEY idx_case (case_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── B. Job seed (APPLIED 2026-08-17 as job id 3555 — DO NOT RE-RUN) ──
--
-- INSERT INTO scheduled_jobs
--   (type, scheduled_time, status, active, name, description, data, recurrence_rule, max_attempts)
-- VALUES
--   ('recurring',
--    TIMESTAMP(DATE_ADD(CURDATE(), INTERVAL 1 DAY), '08:00:00'),
--    'pending', 1,
--    'Stage Aged Emitter',
--    'Nightly case.stage_aged synthetic-event emitter: fires trigger rules when a case''s current pipeline stage crosses a day threshold (default ladder 3/7/14/30/60; recent crossings only; exactly-once per stage entry + threshold). Params editable in data.params: thresholds, grace_days, max_emissions.',
--    '{"type": "internal_function", "params": {}, "function_name": "emit_stage_aged"}',
--    '0 8 * * *', 3);

-- ── C. Collation fix (Review F3 — RUN ONCE) ──────────────────
--
-- The table default collated case_id as utf8mb4_0900_ai_ci while cases and
-- case_stage_log are utf8mb4_general_ci — so the audit join this column's
-- idx_case exists to serve ("what have we emitted for case X") threw
-- "Illegal mix of collations". Free at 0 rows; expensive never.
--
-- NOTE (same latent class, out of scope here): trigger_executions.case_id /
-- trigger_execution_rules also carry 0900_ai_ci. Nothing joins them to
-- cases today (all lookups are literal-param equality), but the identical
-- MODIFY applies if such a join is ever written.
ALTER TABLE case_stage_aged_emitted
  MODIFY case_id VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL;

-- ── D. Reschedule to the outbound band (Review F4 — RUN ONCE) ─
--
-- 0 8 * * * = 04:00 Detroit — the overnight system band. This is the one
-- job whose designed output is client-facing send_sms/send_email; the first
-- rule anyone writes would text a bankruptcy client at 4 AM. 13:00 UTC =
-- 9am ET, alongside the task digest.
--
-- Harmless either way if the 08:00 run fired before this lands: it emits
-- into no_rules (replayable after rules exist) and claims at most a rung
-- the case will out-age anyway.
UPDATE scheduled_jobs
   SET recurrence_rule = '0 13 * * *',
       scheduled_time  = TIMESTAMP(DATE_ADD(CURDATE(), INTERVAL 1 DAY), '13:00:00')
 WHERE id = 3555
   AND name = 'Stage Aged Emitter'
   AND type = 'recurring';
