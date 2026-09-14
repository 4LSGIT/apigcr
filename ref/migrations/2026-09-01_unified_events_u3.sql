-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-09-01 — Unified Events U3: events.event_resolution
-- ref/2026-09-01_unified_events_u3.sql
--
-- Governing design: ref/UNIFIED_EVENTS_DESIGN_V0_5.md §3.7 (A7 — status /
-- resolution model), §7 (U3), §7.1 (live-safety rules). Worker: Opus.
-- Slice owner: CAL. Depends on U2 (applied + verified 2026-09-01).
--
-- WHY
--   `event_status` (Scheduled / Completed / Canceled) says whether a row is
--   still on the calendar. It does not say HOW it ended, and for a deadline
--   that is the only interesting fact: a Completed deadline was MET, a
--   Canceled one may have been mooted rather than cancelled. §3.7 fixes the
--   vocabulary per kind:
--
--     meeting            attended / no_show / cancelled  (appt_status already
--                                                         encodes these — that
--                                                         is why appts get no
--                                                         column here)
--     hearing/conference held / cancelled
--     deadline           met / missed / moot
--
--   The column is the union of those, minus the two the appt enum owns:
--   ENUM('held','met','missed','moot','cancelled'). Allowed-value-per-kind is
--   enforced in CODE at U6, not by a CHECK constraint — the kind lives in a
--   second column and a CHECK across two columns would have to be dropped and
--   rebuilt every time the registry mints a type.
--
-- ── NO WRITER IN THIS SLICE ─────────────────────────────────────────────────
--   U3 is the READ half. caseEventService reads the column to compute
--   `resolution` and falls back per §3.7 when it is NULL:
--
--     Completed + kind 'deadline'  → 'met'
--     Completed + anything else    → 'held'
--     Canceled                     → 'cancelled'   (only 'moot' overrides)
--
--   So every one of the 156 live rows keeps reporting exactly what it reports
--   today. U6 adds the writers (`resolve` on the write API) and the daily sweep
--   that stamps 'missed' on deadlines still Scheduled at date+1. Until then the
--   column is NULL on every row and the fallback is the whole behaviour.
--
--   THERE IS NOTHING TO BACKFILL. A backfill would be inventing history: no row
--   in `events` records how it ended beyond its status, and guessing 'met' vs
--   'missed' for 47 past deadlines from a Completed flag nobody set deliberately
--   is exactly the laundering §3.1 forbids. NULL is the honest value.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
--   1. THIS FILE (one ALTER). Then run the VERIFY block.
--   2. Regenerate ref/database.sql via POST /admin/db/schema/save-to-ref.
--   3. Deploy the BACKEND (caseEventService reads event_resolution).
--   There is no frontend in this slice.
--
--   SQL-first is safe AND SQL-only is safe: the currently-deployed backend does
--   not name this column, and the new backend tolerates it being absent only in
--   the sense that it never will be — deploy the SQL first and the question
--   does not arise. Reversing the order would make every case-timeline read 500
--   on "Unknown column 'e.event_resolution'".
--
--   No session variables, no LAST_INSERT_ID, no stored procedures, no
--   cross-statement transaction. The single statement is standalone and may run
--   on its own pooled connection (house convention; E0a / U2 headers).
--
-- ── RE-RUN SAFETY ───────────────────────────────────────────────────────────
--   NOT idempotent and cannot be: MySQL 8.4 has no "ADD COLUMN IF NOT EXISTS"
--   and the house forbids stored procedures / session variables in migrations.
--   House convention (E0a, U2, R4, pipeline_lane): plain ALTER + this note. A
--   re-run fails with ER_DUP_FIELDNAME ("Duplicate column name
--   'event_resolution'"), which MEANS it is already applied — skip it.
--   To check first:
--     SELECT COLUMN_NAME FROM information_schema.COLUMNS
--      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events'
--        AND COLUMN_NAME = 'event_resolution';
--   (expects 0 rows before, 1 row after).
--
-- ── event_updated_at ────────────────────────────────────────────────────────
--   §7.1 rule 9 requires any UPDATE backfill on `events` to carry
--   `event_updated_at = event_updated_at`, because the column is
--   ON UPDATE CURRENT_TIMESTAMP and U1/U2 bumped every pre-existing row by
--   omitting it. THIS FILE CONTAINS NO UPDATE — an ALTER TABLE ... ADD COLUMN
--   does not fire ON UPDATE — so no row's timestamp moves. That is deliberate,
--   not an oversight: the rule is satisfied by having nothing to apply it to.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
--   Redeploy the previous backend FIRST (the new one SELECTs this column by
--   name), then:
--     ALTER TABLE events DROP COLUMN event_resolution;
--   Nothing else is touched by this file. No data is lost: the column is NULL
--   on every row until U6.
--
-- After running: regenerate the schema snapshot via
--   POST /admin/db/schema/save-to-ref
-- (ref/database.sql is auto-generated — do not hand-edit it.)
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- A.1 — the column (plain ALTER; on re-run skip "Duplicate column")
--
-- No CHARACTER SET / COLLATE clause: an ENUM's storage is an integer index and
-- its collation only affects comparison against a string literal. Every read
-- and write of this column is against a bare literal from a fixed five-value
-- set, so the table default applies and there is nothing to pin. (Contrast U2's
-- type_key VARCHAR(40), which DOES spell both out — a bare CHARSET there would
-- have yielded 0900_ai_ci and broken joins.)
--
-- AFTER event_status places it beside the status it qualifies rather than at the
-- end of the table, where E0a's supersession columns live.
-- ═════════════════════════════════════════════════════════════════════════════
ALTER TABLE events
  ADD COLUMN event_resolution
    ENUM('held','met','missed','moot','cancelled') NULL DEFAULT NULL
    COMMENT 'U3: HOW the event ended, per v0.5 §3.7. NULL = not recorded; the read layer falls back to met (deadline) / held (else) on Completed and cancelled on Canceled. No writer until U6.'
    AFTER event_status;


-- ═════════════════════════════════════════════════════════════════════════════
-- VERIFY (run after A.1)
-- ═════════════════════════════════════════════════════════════════════════════

-- 1. BLOCKING — the column exists, with the right type, nullable, defaulting
--    NULL, positioned after event_status. Expect ONE row:
--    event_resolution | enum('held','met','missed','moot','cancelled') | YES | NULL
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'events'
   AND COLUMN_NAME = 'event_resolution';

-- 2. BLOCKING — nothing was backfilled. Expect 0.
SELECT COUNT(*) AS resolution_not_null FROM events WHERE event_resolution IS NOT NULL;

-- 3. informational — no '' slipped in under the non-strict sql_mode (there is no
--    writer, so this is a tripwire for the next slice rather than for this one).
--    Expect 0.
SELECT COUNT(*) AS resolution_blank FROM events WHERE event_resolution = '';

-- 4. informational — what the read layer will report while the column is NULL,
--    i.e. the §3.7 fallback applied to the live rows. Census 2026-09-01
--    (156 rows): Scheduled → live/null; Canceled → cancelled/cancelled;
--    Completed → resolved/met on kind='deadline', resolved/held otherwise.
SELECT e.event_status, e.kind, COUNT(*) AS n
  FROM events e
 GROUP BY e.event_status, e.kind
 ORDER BY n DESC, e.event_status, e.kind;


-- ── POST-DEPLOY GATES (Fred, readonly, after the backend) ────────────────────
-- G1. still nothing written. Expect 0.
--   SELECT COUNT(*) FROM events WHERE event_resolution IS NOT NULL;
-- G2. GET /api/cases/<case with a 341 appt and a deadline>/events before vs
--     after — identical except the added `state` / `resolution` keys on every row.
-- G3. same call with ?include_attendees=1 → every row carries attendees[];
--     without it → no row carries the key.
-- G4. GET /api/case-events/audit → counts.broken/pending/unlinked unchanged
--     (0 / 0 / 2 as of 2026-09-01 — event 4 'Reminder smoke' and event 156
--     'Mediation', both legitimately unlinked), plus a new counts.appts block
--     (8 / 0 / 12 / 20 as of 2026-09-01).
-- ─────────────────────────────────────────────────────────────────────────────
