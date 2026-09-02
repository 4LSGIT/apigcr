-- ref/2026-09-02_unified_events_u8.sql
--
-- UNIFIED EVENTS U8 — `calendar.approaching`: per-type offsets + the claim table
-- Governing design: ref/UNIFIED_EVENTS_DESIGN_V0_5.md §3.2 (amendment A6),
-- §8.0 (code owns vocabulary; data owns policy).
--
-- A6 withdrew v0.4's dedicated reminder spawner. A reminder is now two things
-- that already exist: a synthetic EVENT (`calendar.approaching`, emitted by the
-- nightly `emit_calendar_approaching` internal function, same house pattern as
-- `emit_stage_aged` / `sweep_calendar_missed`) and a TRIGGER RULE that decides
-- what the reminder DOES. Nothing about "a task 7 days before a deadline" is
-- code: the 7 is a registry row, the task is a rule.
--
-- ── ZERO EMISSIONS AT DEPLOY (the acceptance bar) ────────────────────────────
-- `approaching_offsets` is added NULL and seeded NOTHING. NULL means "this type
-- has no approaching events", so on the morning after deploy the emitter loads
-- the registry, finds no configured type, and returns { scanned: 0 } without
-- touching `events` or `appts` at all. Turning the feature on is an act in Case
-- Config, not a deploy.
--
-- ── WHY `item_date` IS IN THE PRIMARY KEY ────────────────────────────────────
-- The obvious key is (source, source_id, offset_days) — "this item's 7-day rung
-- has fired". It is wrong for the one case that matters. An event can be moved
-- IN PLACE (`updateEvent` with a new `event_date` is a reschedule, not a
-- supersession — §3.5), so the same `event_id` can legitimately need its rungs
-- again against a different date. With `item_date` in the key:
--
--   * a stale claim is keyed to a date the item no longer has, so it can never
--     suppress the new one — it self-invalidates, no cleanup job, no UPDATE;
--   * every offset re-arms for the new date automatically;
--   * a date moved BACK to a previously-claimed value correctly stays claimed
--     (that rung really did fire for that date).
--
-- The cost is one dead row per moved item per fired rung. At firm scale that is
-- rounding error, and a retention sweep can take them later if it ever is not.
--
-- ── court_item_reminders IS DROPPED ──────────────────────────────────────────
-- It was v0.4's per-type reminder config (lead_days / assignee /
-- title_template) hanging off `ai_match_types`. A6 replaces its design role
-- entirely: lead_days becomes `approaching_offsets` here, assignee and
-- title_template become fields of a trigger rule's task action. Verified before
-- dropping: 0 rows (live, 2026-09-02) and zero code readers anywhere in the
-- tree — the only remaining mentions are in ref/*.sql and the design doc.
-- `court_item_policy` STAYS; U7 decides its fate.
--
-- PROPERTIES: standalone statements (the DB console runs each on its own
-- connection — no session variables). Idempotent on re-run: the ADD COLUMN is
-- guarded by a conditional (a bare ADD COLUMN would ER_DUP_FIELDNAME on the
-- second run), CREATE TABLE IF NOT EXISTS, DROP TABLE IF EXISTS. Collation is
-- explicit (utf8mb4_general_ci, the house collation) — MySQL 8 silently
-- produces 0900_ai_ci from a bare `DEFAULT CHARSET=utf8mb4`, and this table's
-- `source` column is compared against string literals in code.
--
-- DEPLOY ORDER: SQL → backend. There is no frontend ordering hazard: the Case
-- Config field only appears once the backend serves the column, and the emitter
-- is inert until a scheduled job exists (which Fred creates as data, AFTER
-- setting real offsets — see manual/03-YisraFlow/15-triggers.md).
--
-- Rollback at the bottom, commented, including the court_item_reminders
-- re-creation SQL from the U0-era schema (ref/2026-08-10_ai_match_registry.sql).


-- ─────────────────────────────────────────────────────────────────────────────
-- 1  REGISTRY COLUMN — the policy, as data
--
-- Shape: a JSON array of DISTINCT integers 0..365, days BEFORE the item's date.
-- `[7, 1]` = "emit at the 7-day mark and again at the 1-day mark"; `[0]` = "on
-- the day"; NULL (and, by the write layer's normalization, `[]`) = no
-- approaching events for this type. Order carries no meaning — the admin layer
-- stores them sorted descending so display and max() are deterministic.
--
-- Validation lives in services/calendarTypeAdminService.js, not in a CHECK
-- constraint: the error a human sees when they type "seven" belongs in the
-- editor, and this row is edited through exactly one write path.
-- ─────────────────────────────────────────────────────────────────────────────

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'calendar_item_types'
      AND COLUMN_NAME  = 'approaching_offsets') > 0,
  'SELECT ''approaching_offsets already present — skipped'' AS note',
  'ALTER TABLE calendar_item_types
     ADD COLUMN approaching_offsets JSON NULL
     COMMENT ''U8/A6: days-before offsets that emit calendar.approaching, e.g. [7,1]. NULL/[] = none. Distinct ints 0..365.''
     AFTER default_length');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- NOTE: the three statements above are the ONE place this file needs a session
-- variable, and they must therefore run on ONE connection — paste them as a
-- single block. If the console insists on splitting them, run the plain
-- statement instead (it is safe on a fresh column, and errors harmlessly with
-- ER_DUP_FIELDNAME on a re-run):
--
--   ALTER TABLE calendar_item_types
--     ADD COLUMN approaching_offsets JSON NULL
--     COMMENT 'U8/A6: days-before offsets that emit calendar.approaching, e.g. [7,1]. NULL/[] = none. Distinct ints 0..365.'
--     AFTER default_length;

-- SEED: none, deliberately. See the header — zero emissions at deploy.


-- ─────────────────────────────────────────────────────────────────────────────
-- 2  CLAIM TABLE — exactly-once per (item, rung, date)
--
-- Claimed with a plain INSERT IGNORE, never ON DUPLICATE KEY UPDATE: under
-- mysql2's CLIENT_FOUND_ROWS default an ODKU reports affectedRows=1 for a
-- no-change duplicate as well as a fresh insert, which would make every rung
-- look freshly claimed forever. With INSERT IGNORE, affectedRows === 1 means
-- and only means "this row did not exist".
--
-- Claim-THEN-emit is deliberate at-most-once, same ruling as emit_stage_aged: a
-- crash in the milliseconds between the claim and the emit loses one reminder
-- (a human notices a missing nudge); emit-then-claim would risk duplicate SMS
-- to a client, which is worse.
--
-- No FK to events / appts, by convention (neither table carries one) and by
-- necessity: rows are keyed across two source tables.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calendar_approaching_emitted (
  source      ENUM('appt','event') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
              COMMENT 'which table source_id points at — appts.appt_id | events.event_id',
  source_id   INT NOT NULL,
  offset_days SMALLINT NOT NULL COMMENT 'days before item_date; 0 = on the day',
  item_date   DATE NOT NULL
              COMMENT 'the item date this claim was made against. IN THE KEY on purpose: an in-place date move invalidates the old claim and re-arms every rung for the new date.',
  emitted_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source, source_id, offset_days, item_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='U8/A6: calendar.approaching claim ledger. INSERT IGNORE; affectedRows=1 = claimed.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3  RETIRE court_item_reminders (A6 supersedes it)
--
-- Empty and unread — see the header. Dropped rather than migrated: there is
-- nothing in it to migrate.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS court_item_reminders;


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY (expected results on the right)
-- ─────────────────────────────────────────────────────────────────────────────
-- SHOW COLUMNS FROM calendar_item_types LIKE 'approaching_offsets';        → 1 row, Type json, Null YES
-- SELECT COUNT(*) FROM calendar_item_types WHERE approaching_offsets IS NOT NULL;  → 0  (nothing configured)
-- SELECT COUNT(*) FROM calendar_approaching_emitted;                       → 0
-- SHOW TABLES LIKE 'court_item_reminders';                                 → 0 rows
-- SHOW TABLES LIKE 'court_item_policy';                                    → 1 row  (U7's; untouched)
--
-- Then, backend deployed, via apiTester:
--   emit_calendar_approaching { "dry_run": true }   → { scanned: 0, types_configured: 0 }
-- Set approaching_offsets on one type in Case Config and re-run the dry run;
-- `would_emit` should match:
--   SELECT e.event_id, e.event_date FROM events e
--    WHERE e.type_key = '<key>' AND e.event_status = 'Scheduled'
--      AND e.superseded_by_event_id IS NULL
--      AND e.event_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL <max offset> DAY);


-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (roll the backend revision back first — the emitter and the Case
-- Config field both disappear with it, and the claim table is write-only)
-- ─────────────────────────────────────────────────────────────────────────────
-- DROP TABLE calendar_approaching_emitted;
-- ALTER TABLE calendar_item_types DROP COLUMN approaching_offsets;
--
-- court_item_reminders, as it stood before this migration (from the U0-era
-- ref/2026-08-10_ai_match_registry.sql; 0 rows, so there is no data to restore):
--
-- CREATE TABLE court_item_reminders (
--   id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
--   type_id        INT UNSIGNED NOT NULL,
--   assignee       INT DEFAULT NULL,
--   lead_days      INT NOT NULL DEFAULT 7,
--   title_template VARCHAR(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
--   active         TINYINT(1) NOT NULL DEFAULT 1,
--   PRIMARY KEY (id),
--   KEY idx_cir_type (type_id),
--   CONSTRAINT fk_cir_type FOREIGN KEY (type_id) REFERENCES ai_match_types (id) ON DELETE CASCADE
-- ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
