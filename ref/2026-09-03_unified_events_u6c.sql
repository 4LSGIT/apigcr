-- ============================================================================
-- UNIFIED EVENTS U6c — events.event_status gains 'Rescheduled'
-- ref/2026-09-03_unified_events_u6c.sql
--
-- WHY (Fred, 2026-09-03, overruling v0.5 §3.4's "supersession is the pointer,
-- never a status"):
--
--   appts already solves this exact problem and has for years:
--
--     appt_status  enum('Attended','No Show','Rescheduled','Canceled','Scheduled')
--     rescheduled_from_appt_id  int
--
--   BOTH. The status answers "is this row dead"; the pointer answers "which
--   row replaced it". Two different questions, two columns, no conflict.
--   85 live appts sit in 'Rescheduled' today.
--
--   `events` got the pointer WITHOUT the status. The consequence is that every
--   liveness query in the tree — availability, the digest, the ICS feed, the
--   dedupe candidate scans, courtExecutor's reschedule/cancel candidate
--   queries — already knew how to ask "is this Scheduled?" and had to be
--   taught a second, unfamiliar predicate instead. courtExecutor's two
--   candidate queries (lines 826 and 964) never were. That is not a
--   courtExecutor bug; it is a design that manufactured a bug surface.
--
--   With this value in the enum, a rescheduled predecessor stops looking live
--   to every one of those queries WITHOUT any of them changing. The pointer
--   stays exactly as it is and keeps doing its own job (which successor, and
--   supersede_reason keeps 'rescheduled' apart from 'duplicate').
--
--   The original objection — "Canceled must keep meaning the court cancelled
--   it" — is fully preserved. 'Rescheduled' is a THIRD value, not a reuse of
--   'Canceled'. Exactly the appts model.
--
-- ADDITIVE (v0.5 §7.1 rule 1). The value is APPENDED, so every existing row
-- keeps its ordinal and no data moves. No backfill: all 31 currently
-- superseded rows carry supersede_reason='duplicate' (July cleanup artifacts,
-- already 'Canceled'), not 'rescheduled'. There is not one 'rescheduled'
-- pointer live today — the writer has never fired, because
-- unified_singleton_enabled has never been on.
--
-- DEPLOY ORDER: **SQL FIRST, THEN BACKEND** (v0.5 §7.1 rule 5, normal
-- direction). sql_mode lacks STRICT_TRANS_TABLES, so a backend that writes
-- 'Rescheduled' before this runs stores '' silently — a blank status on a
-- superseded row, which _deriveState reads as LIVE. Do not invert this.
--
-- Each statement standalone; no session variables, no transactions
-- (the DB console runs each on its own connection).
-- ============================================================================


-- ── PRE-FLIGHT ──────────────────────────────────────────────────────────────
-- 1. Confirm the enum is still the 3-value shape this migration expects.
--    EXPECT: exactly one row, COLUMN_TYPE = enum('Scheduled','Completed','Canceled')
SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME   = 'events'
   AND COLUMN_NAME  = 'event_status';

-- 2. Confirm no 'rescheduled' supersession exists yet (would need a status
--    backfill if it did).  EXPECT: 0
SELECT COUNT(*) AS rescheduled_pointers_pre
  FROM events
 WHERE superseded_by_event_id IS NOT NULL
   AND supersede_reason = 'rescheduled';

-- 3. The 31 known 'duplicate' tombstones, for the after-comparison.
--    EXPECT: event_status='Canceled', supersede_reason='duplicate', n=31
SELECT event_status, supersede_reason, COUNT(*) AS n
  FROM events
 WHERE superseded_by_event_id IS NOT NULL
 GROUP BY event_status, supersede_reason;


-- ── MIGRATION ───────────────────────────────────────────────────────────────
-- 'Rescheduled' is APPENDED (ordinal 4). Appending never rewrites existing
-- values; inserting mid-list would. COLLATE / NOT NULL / DEFAULT are restated
-- verbatim from the live DDL so MODIFY does not silently drop them.
ALTER TABLE `events`
  MODIFY `event_status`
    enum('Scheduled','Completed','Canceled','Rescheduled')
    CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
    NOT NULL DEFAULT 'Scheduled'
    COMMENT 'U6c: Rescheduled = superseded by a successor row (paired with superseded_by_event_id + supersede_reason=''rescheduled''). Mirrors appt_status.Rescheduled. Canceled still means court-cancelled ONLY.';


-- ── VERIFY ──────────────────────────────────────────────────────────────────
-- V1. The enum now carries four values, still NOT NULL DEFAULT 'Scheduled'.
--     EXPECT: enum('Scheduled','Completed','Canceled','Rescheduled') / NO / Scheduled
SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME   = 'events'
   AND COLUMN_NAME  = 'event_status';

-- V2. NOTHING MOVED. Same distribution as before the ALTER.
--     EXPECT (2026-09-03): Scheduled 102, Canceled 54, Completed 1, Rescheduled 0
--     (re-verify against your own pre-flight figures, not these).
SELECT event_status, COUNT(*) AS n
  FROM events
 GROUP BY event_status
 ORDER BY n DESC;

-- V3. The 31 tombstones are untouched.  EXPECT: Canceled / duplicate / 31
SELECT event_status, supersede_reason, COUNT(*) AS n
  FROM events
 WHERE superseded_by_event_id IS NOT NULL
 GROUP BY event_status, supersede_reason;

-- V4. No blank statuses (the non-strict-mode failure signature).  EXPECT: 0
SELECT COUNT(*) AS blank_status
  FROM events
 WHERE event_status = '';


-- ── POST-BACKEND GATES (run AFTER the code deploy) ──────────────────────────
-- G1. Every 'rescheduled' supersession carries the status, and vice versa.
--     Any row in this result is a half-write.  EXPECT: 0 rows
SELECT event_id, event_status, supersede_reason, superseded_by_event_id
  FROM events
 WHERE (supersede_reason = 'rescheduled' AND event_status <> 'Rescheduled')
    OR (event_status = 'Rescheduled' AND superseded_by_event_id IS NULL);

-- G2. No 'Rescheduled' row is still visible to a naive liveness query — the
--     whole point of the slice.  EXPECT: 0
SELECT COUNT(*) AS phantom_live
  FROM events
 WHERE superseded_by_event_id IS NOT NULL
   AND event_status = 'Scheduled';


-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Only valid while zero rows carry the value (check first — narrowing an enum
-- under non-strict mode silently blanks any row that holds the dropped value):
--
--   SELECT COUNT(*) FROM events WHERE event_status = 'Rescheduled';   -- must be 0
--
--   ALTER TABLE `events`
--     MODIFY `event_status` enum('Scheduled','Completed','Canceled')
--       CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
--       NOT NULL DEFAULT 'Scheduled';
--
-- If rows DO carry it, revert the backend first and run:
--   UPDATE events SET event_status = 'Canceled', event_updated_at = event_updated_at
--    WHERE event_status = 'Rescheduled';        -- §7.1 rule 9: self-assign the timestamp
-- then narrow the enum.
