-- ============================================================
-- Split-phase domain event dispatch — domain_event_queue
-- Run ONCE, BEFORE deploying the code (migration -> backend -> frontend).
-- Idempotent: IF NOT EXISTS. No session variables, no cross-statement state.
-- ============================================================
--
-- WHY
--   lib/domainEvents.emit() used to run the ENTIRE trigger tree in a detached
--   async IIFE — rule loading, envelope matching, the node:vm transform, and
--   every action dispatch — from a post-response context. Cloud Run allocates
--   CPU per REQUEST, so all of that ran throttled, and throttled wall time is
--   "real work plus however long until something grants this instance CPU
--   again": unbounded. trigger_executions#458 (2026-08-28) lost rule 4's
--   transform to a 200ms ceiling on ~8ms of real work. The ceiling was raised
--   to 15000ms (TRIGGER_CODE_TIMEOUT_MS), which is a probability play.
--
--   emit() now does two cheap things — INSERT here, ring a Cloud Tasks
--   doorbell — and the tree is evaluated by a REQUEST-BOUND drain
--   (POST /process-domain-event/:id, with the 60s /process-jobs cron as the
--   fallback). Same trade the Cloud Tasks accelerator already makes: a
--   CORRECTNESS risk (tree aborted mid-flight, audit rows silently skipped)
--   becomes a LATENCY risk (worst case ~60s, bounded, no loss).
--
--   This row is the scheduling AUTHORITY. The Cloud Task is a doorbell and
--   nothing more — if it never rings, the cron drains the row anyway. Same
--   invariant as scheduled_jobs vs. lib/taskQueue.js; do not weaken it.
--
-- COLLATION
--   No DEFAULT CHARSET clause at all, deliberately: the schema default is
--   utf8mb4 / utf8mb4_general_ci and omitting the clause inherits it.
--   Writing `DEFAULT CHARSET=utf8mb4` WITHOUT `COLLATE` would silently reset
--   to utf8mb4_0900_ai_ci and make this table un-joinable to the core tables
--   forever. See ref/SCHEMA_CONVENTIONS.md and tests/schemaConventions.test.js.
--   Verified against the live sibling tables (trigger_executions,
--   scheduled_jobs, hook_executions): all utf8mb4_general_ci.
--
-- event_type IS VARCHAR(64), NOT 100
--   Deliberately equal to trigger_executions.event_type. Every event type
--   flows into BOTH tables, and sql_mode here lacks STRICT_TRANS_TABLES, so
--   an over-length value truncates SILENTLY. Two different widths would mean
--   two different truncation points and a queue row that no longer matches
--   its own audit row. One width, one truncation point.

CREATE TABLE IF NOT EXISTS domain_event_queue (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_type    VARCHAR(64)     NOT NULL,

  -- Root of this event's trigger tree, for the CROSS-PROCESS dispatch budget.
  -- NULL = "I am my own root" (a root emission). A nested emit fired from
  -- inside an action carries its root's id here.
  --
  -- Deliberately NOT a foreign key: the retention sweep deletes by age, and a
  -- FK would either block the parent's deletion or cascade children away
  -- mid-flight. A dangling root_id after retention is harmless — the budget
  -- read below falls back to 0, which is the correct answer for a tree whose
  -- root aged out days ago.
  root_id       BIGINT UNSIGNED NULL,

  envelope      JSON            NOT NULL,
  status        ENUM('pending','running','done','error') NOT NULL DEFAULT 'pending',

  -- Total actions dispatched across this ROOT event's whole tree. Written
  -- ONLY on the root row (id = root_id, or root_id IS NULL), as an atomic
  -- `SET dispatches = dispatches + <delta>` after each drained node. This is
  -- what survives serialisation of the in-memory ALS counters object and
  -- keeps MAX_DISPATCHES_PER_ROOT (services/triggerService.js) a per-ROOT
  -- budget rather than a per-node one. See lib/domainEventDrain.js.
  dispatches    INT UNSIGNED    NOT NULL DEFAULT 0,

  -- Bumped at CLAIM time, not at completion: a row whose instance died
  -- mid-drain has already spent its attempt, so the stale-claim sweep cannot
  -- loop a poison envelope forever.
  attempts      INT UNSIGNED    NOT NULL DEFAULT 0,
  claimed_at    DATETIME        NULL,
  completed_at  DATETIME        NULL,
  error_message TEXT            NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),

  -- Batch drain (cron fallback): WHERE status='pending' ORDER BY id.
  -- Stale-claim sweep: WHERE status='running' AND claimed_at < ...
  KEY idx_status_created (status, created_at),
  -- Retention sweep deletes by created_at across all statuses.
  KEY idx_created (created_at)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Retention
--
-- NOT a new mechanism and NOT a new job. lib/internal_functions/system.js
-- `sweep_trigger_executions` already runs daily (scheduled_jobs id 3530,
-- "Trigger Executions Sweep", cron `0 7 * * *`) doing exactly this for the
-- sibling audit table. That function gains a third batched DELETE for this
-- queue in the same slice; nothing needs scheduling here.
--
-- Why this table needs it MORE than trigger_executions does: no_rules
-- executions are capped at 20 rows per event type (_insertNoRulesCapped), so
-- a high-volume no-rules event type writes 20 audit rows total but a queue
-- row EVERY time. The queue therefore grows strictly faster than the audit
-- log it feeds. Live sizing: documents alone saw 1,858 updates on 2026-08-27
-- and the envelope is a full row snapshot.
-- ------------------------------------------------------------
