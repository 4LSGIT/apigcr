-- ============================================================
-- Trigger System — case.stage_aged migration
--
-- SECTION A (DDL): run ONCE, BEFORE deploying the emitter code
--   (migration → code order). IF NOT EXISTS — safe to re-run.
-- SECTION B (job seed): run AFTER (or same day as) the backend
--   deploy. First run is tomorrow 08:00 UTC, so a same-day deploy
--   is safe — same contract as the T3/T4 sweep-job seed. The
--   INSERT is NOT idempotent; do not re-run it.
--
-- NO session variables / no LAST_INSERT_ID across statements —
-- the runner executes each statement on its own connection.
-- Nothing here needs a cross-statement id.
-- ============================================================

-- ── A. Claim table: exactly-once per (stage entry, threshold) ─
--
-- Keyed on case_stage_log.id, NOT (case_id, stage_key): each stage ENTRY is
-- its own log row, so a case that goes docs → filed → back to docs gets a
-- NEW row and its nudges re-arm — correct behaviour, obtained for free.
--
-- INSERT IGNORE against uq_stage_threshold IS the dedup: the emitter claims
-- (stage_log_id, threshold_days) and emits only when affectedRows = 1.
-- Atomic; safe if the job overlaps itself or is run twice by hand.
--
-- Deliberately NO FK to case_stage_log: the log is append-only by contract
-- (pipelineService.advanceStage is the only writer). A backfill that
-- DELETES+REINSERTS log rows would change ids and re-arm nudges either way
-- (a cascade would delete the claims); the grace window in the emitter
-- bounds the damage of that to crossings within the last grace_days.
-- Backfills must APPEND, never rewrite — that is a constraint on the
-- backfill design, recorded here.
--
-- Growth is negligible (≤ thresholds × stage entries; tens of KB at this
-- firm's scale) — no retention sweep needed.
CREATE TABLE IF NOT EXISTS case_stage_aged_emitted (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  stage_log_id   BIGINT UNSIGNED NOT NULL,
  threshold_days INT NOT NULL,
  case_id        VARCHAR(20) NOT NULL,
  emitted_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stage_threshold (stage_log_id, threshold_days),
  KEY idx_case (case_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── B. Nightly recurring job (08:00 UTC — after the 07:00 sweep) ─
--
-- Params are deliberately empty: the emitter's defaults (thresholds
-- 3,7,14,30,60 / grace_days 7 / max_emissions 200) apply. Override any of
-- them by editing this row's data.params — no deploy needed.
INSERT INTO scheduled_jobs
  (type, scheduled_time, status, active, name, description, data, recurrence_rule, max_attempts)
VALUES
  ('recurring',
   TIMESTAMP(DATE_ADD(CURDATE(), INTERVAL 1 DAY), '08:00:00'),
   'pending', 1,
   'Stage Aged Emitter',
   'Nightly case.stage_aged synthetic-event emitter: fires trigger rules when a case''s current pipeline stage crosses a day threshold (default ladder 3/7/14/30/60; recent crossings only; exactly-once per stage entry + threshold). Params editable in data.params: thresholds, grace_days, max_emissions.',
   '{"type": "internal_function", "params": {}, "function_name": "emit_stage_aged"}',
   '0 8 * * *', 3);
