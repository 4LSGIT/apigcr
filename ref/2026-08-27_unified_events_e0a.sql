-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-08-27 — Unified Events E0a: schema atoms + dedup backfill
-- ref/2026-08-27_unified_events_e0a.sql
--
-- Governing design: UNIFIED_EVENTS_DESIGN_V0_4.md (frozen) §3.4, §7.
--
-- WHY
--   Three facts the schema cannot currently express, all of which the unified
--   read layer needs before it can be written:
--
--   1. WHAT AN EVENT IS. `event_type` is free varchar(60) carrying whatever the
--      court pipeline or a human typed ('341', 'Docs Deadline',
--      'poc_gov_due', 'confirmation_hearing'). Nothing says whether a row is a
--      thing you ATTEND or a date you MUST NOT MISS, so no reader can render
--      hearings and deadlines differently without pattern-matching strings.
--      `kind` is that axis. THIS MIGRATION ONLY ADDS THE COLUMN — every row
--      stays NULL. Population is E0b, which is judgment-gated (the mapping
--      from today's ~15 live event_type strings onto five kinds is a decision,
--      not a transform) and ships with the eventform picker.
--
--   2. WHY AN EVENT IS DEAD. `event_status='Canceled'` is doing two unrelated
--      jobs today: "the court cancelled this hearing" and "this row was a
--      duplicate and we tombstoned it". A reader cannot tell them apart, so
--      every consumer either shows tombstones as real cancellations or hides
--      real cancellations along with them. `superseded_by_event_id` +
--      `supersede_reason` split the second meaning out of the first.
--
--   3. WHICH APPOINTMENT REPLACED WHICH. A reschedule already knows its
--      predecessor — apptService passes it as `hook_rescheduled_from` into the
--      fire-and-forget view-hook payload and the appt.created trigger envelope.
--      Both are transient: nothing on the successor ROW records where it came
--      from, so lineage is unreconstructable from the DB.
--      `appts.rescheduled_from_appt_id` persists it.
--
--   No behaviour changes here. Columns 1 and 2 are written by nothing on the
--   currently-deployed backend and read by nothing; column 3 starts being
--   written by the E0a backend deploy.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
--   1. THIS FILE, statements 1–6 (the ALTERs) then statement 7 (the backfill,
--      which reads the columns 2 and 3 create).
--   2. Deploy the BACKEND. Its only new write is
--      appts.rescheduled_from_appt_id inside createAppt's INSERT.
--   3. No frontend changes.
--
--   SQL-first is safe in both directions and there is no overlap window: the
--   new columns are unread and unwritten by the currently-deployed backend, so
--   running this file and NOT deploying leaves production behaving exactly as
--   it does today. Deploying the backend FIRST would 500 every createAppt
--   (INSERT names a column that does not exist) — do not reverse the order.
--
--   No session variables, no LAST_INSERT_ID, no cross-statement transaction.
--   Each statement is standalone and may run on its own pooled connection
--   (DB-console convention — ref/migration_trigger_R4.sql header; the T3/T4
--   migration used SET @x = LAST_INSERT_ID(), do NOT copy that pattern).
--
-- ── RE-RUN SAFETY ───────────────────────────────────────────────────────────
--   Statements 1–6 are NOT idempotent and cannot be: MySQL 8.4 has no
--   "ALTER TABLE … ADD COLUMN IF NOT EXISTS". This is the house convention for
--   every column-adding migration in ref/ (2026-08-11_form_templates_visibility,
--   2026-08-13_form_submissions_linkage, 2026-08-19_pipeline_phase,
--   2026-08-25_pipeline_lane, migration_trigger_R4) — a plain ALTER plus this
--   note. A re-run fails with ER_DUP_FIELDNAME / ER_DUP_KEYNAME, which MEANS
--   the migration is already applied. Harmless, nothing partial, no cleanup.
--
--   Statement 7 (the backfill) IS idempotent — the
--   `AND c.superseded_by_event_id IS NULL` guard makes a re-run match zero
--   rows. It is also safe to run again later if new tombstones appear, though
--   the count assertion below will no longer read 31.
--
-- ── NO CHARSET / COLLATE CLAUSES ────────────────────────────────────────────
--   No new tables, and every column added is numeric or ENUM — nothing here
--   can inherit a collation. Do NOT add DEFAULT CHARSET / COLLATE to any
--   statement below: on MySQL 8 a bare `DEFAULT CHARSET=utf8mb4` yields
--   0900_ai_ci and breaks joins against the general_ci core tables.
--
-- ── sql_mode NOTE (ENUM writes) ─────────────────────────────────────────────
--   The session lacks STRICT_TRANS_TABLES, so an invalid ENUM write lands as
--   '' SILENTLY. Both ENUMs here are nullable with no default and nothing
--   writes them as a free string: `kind` is written by nobody in this slice,
--   and statement 7 writes `supersede_reason` as a bare literal. E0b and the
--   court executor must validate against a JS whitelist before binding
--   (the pipelineAdminService convention).
--
-- ── NO FOREIGN KEYS, DELIBERATELY ───────────────────────────────────────────
--   `events` and `appts` carry ZERO foreign keys today (verified 2026-08-26:
--   information_schema.KEY_COLUMN_USAGE returns no referenced constraints for
--   either table). Both new pointer columns follow that convention — a plain
--   indexed INT, integrity asserted by the VERIFY queries rather than by the
--   engine. Adding the first FK to either table is a separate decision with
--   its own delete-cascade consequences; it does not belong in an atoms slice.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
--   Redeploy the previous backend FIRST (the E0a backend INSERTs
--   rescheduled_from_appt_id by name), then run in this order:
--
--     -- 1. undo the backfill's data (only needed if you intend to re-run it)
--     UPDATE events
--        SET superseded_by_event_id = NULL,
--            supersede_reason       = NULL
--      WHERE superseded_by_event_id IS NOT NULL
--         OR supersede_reason IS NOT NULL;
--
--     -- 2. drop the additions (indexes go with their columns automatically,
--     --    but DROP KEY first is explicit and works either way)
--     ALTER TABLE events DROP KEY idx_events_superseded_by;
--     ALTER TABLE events DROP COLUMN superseded_by_event_id;
--     ALTER TABLE events DROP COLUMN supersede_reason;
--     ALTER TABLE events DROP COLUMN kind;
--     ALTER TABLE appts  DROP KEY idx_appts_rescheduled_from;
--     ALTER TABLE appts  DROP COLUMN rescheduled_from_appt_id;
--
--   No event_status was changed and no row was inserted or deleted, so there
--   is nothing else to undo. Step 1 is optional if you are dropping the
--   columns anyway.
--
-- After running: regenerate the schema snapshot via
--   POST /admin/db/schema/save-to-ref
-- (ref/database.sql is auto-generated — do not hand-edit it.)
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- VERIFY 0 — run BEFORE statement 7. Expect exactly 31.
-- ═════════════════════════════════════════════════════════════════════════════
--   SELECT COUNT(*) AS candidates
--     FROM events c
--     JOIN events s ON s.event_link_type = c.event_link_type
--                  AND s.event_link_id   = c.event_link_id
--                  AND s.event_type      = c.event_type
--                  AND s.event_date      = c.event_date
--                  AND s.event_status    = 'Scheduled'
--    WHERE c.event_status = 'Canceled';
--
-- If this is not 31, STOP and re-derive before running statement 7. The count
-- is the assertion that the predicate still means what it meant on 2026-08-26.


-- ── 1 of 7 — events.kind (COLUMN ONLY; population is E0b) ────────────────────
-- Stays NULL for all 152 existing rows and for everything E0a writes. NULL
-- means "not yet classified", which is a true statement about every row until
-- E0b runs — it is NOT a default that a reader may treat as 'other'.
ALTER TABLE events
  ADD COLUMN kind ENUM('hearing','meeting','deadline','conference','other') NULL
    COMMENT 'E0a atom: what the event IS, independent of event_type free text. NULL = unclassified. Populated by E0b (judgment-gated), not here.'
    AFTER event_type;


-- ── 2 of 7 — events.superseded_by_event_id ───────────────────────────────────
-- Points at the event that REPLACED this one. INT UNSIGNED to match
-- events.event_id (verified 2026-08-26: `int unsigned`, PRI, auto_increment).
ALTER TABLE events
  ADD COLUMN superseded_by_event_id INT UNSIGNED NULL
    COMMENT 'E0a atom: the event that replaced this one. NULL = this row is not superseded. No FK by convention (events carries none).';


-- ── 3 of 7 — events.supersede_reason ─────────────────────────────────────────
-- WHY it was superseded. Set together with the pointer, always.
ALTER TABLE events
  ADD COLUMN supersede_reason ENUM('rescheduled','duplicate') NULL
    COMMENT 'E0a atom: why this row was superseded. rescheduled = the court moved it; duplicate = tombstoned dedup artifact. NULL iff superseded_by_event_id IS NULL.';


-- ── 4 of 7 — index on the pointer ────────────────────────────────────────────
-- Supports the read layer's "is this row live?" filter and the reverse lookup
-- ("what did event N supersede?").
ALTER TABLE events
  ADD KEY idx_events_superseded_by (superseded_by_event_id);


-- ── 5 of 7 — appts.rescheduled_from_appt_id ──────────────────────────────────
-- Points at the appt this one REPLACED. INT (signed) to match appts.appt_id
-- (verified 2026-08-26: `int`, PRI, auto_increment — NOT unsigned, unlike
-- events.event_id. The asymmetry is pre-existing; do not "fix" it here).
--
-- Written by services/apptService.createAppt from its existing
-- `hook_rescheduled_from` argument, which covers BOTH successor-creation
-- sites: rescheduleAppt (staff + client reschedule) and the manage-page rebook
-- in routes/manage.js. rescheduleLater tears a slot down with no successor and
-- therefore writes nothing.
--
-- NOT BACKFILLED. Historical successors are not reliably recoverable: the
-- predecessor link lives only in appt log extras ('New Appt': <id>) written by
-- a code path whose shape changed over the table's life, and a wrong lineage
-- claim is worse than an honest NULL. Every pre-deploy row stays NULL, which
-- correctly reads as "we do not know".
ALTER TABLE appts
  ADD COLUMN rescheduled_from_appt_id INT NULL
    COMMENT 'E0a atom: the appt this row replaced (reschedule or manage-page rebook). NULL = original booking, or pre-2026-08-27 row (not backfilled). No FK by convention (appts carries none).';


-- ── 6 of 7 — index on the appt pointer ───────────────────────────────────────
ALTER TABLE appts
  ADD KEY idx_appts_rescheduled_from (rescheduled_from_appt_id);


-- ── 7 of 7 — BACKFILL: tombstone the dedup artifacts ─────────────────────────
--
-- EXPECT EXACTLY 31 ROWS MATCHED (verified against live data 2026-08-26).
-- Anything else means the population changed since — STOP and re-derive.
--
-- WHAT THESE 31 ROWS ARE. Canceled events that still have a live twin: same
-- event_link_type + event_link_id + event_type + event_date, with the twin
-- still 'Scheduled'. Every one of them is a duplicate that was cancelled as
-- cleanup, not a real cancellation. Provenance breakdown by cancellation date
-- (events.event_updated_at), verified 2026-08-26:
--
--     2026-07-15 .. 20 rows  the Slice 4 Phase B court-dupe cleanup
--                            (scripts/cleanup_court_event_dupes_2026_07.js)
--     2026-06-18 ..  4 rows  \
--     2026-06-11 ..  4 rows   > earlier dev-era dupes on test cases
--     2026-06-04 ..  3 rows  /  (aYwkZLA3, SUTCdsPn, xOx37DC1)
--                    ──────
--                       31
--
--   (The prompt for this slice described all 31 as July-2026 cleanup
--   artifacts. 11 of them predate it. The predicate is unchanged and the
--   count is unchanged; only the provenance sentence is corrected.)
--
-- NO FAN-OUT. Each of the 31 canceled rows has EXACTLY ONE live twin —
-- measured 2026-08-26, min(twins) = max(twins) = 1 across all 31 — so the
-- JOIN cannot multiply rows and the UPDATE is deterministic.
--
--   Fan-IN is present and is fine: canceled events 41 AND 58 both resolve to
--   live event 51 (a 3-way confirmation-hearing cluster where two copies were
--   tombstoned and one kept). A successor may supersede several predecessors;
--   a predecessor may have only one successor. Do not write a VERIFY that
--   expects DISTINCT(superseded_by_event_id) = 31 — it is 30.
--
-- THESE ROWS CORRECTLY KEEP event_status = 'Canceled'. Their Google Calendar
-- entries and reminder tasks were already torn down when they were cancelled
-- (verified 2026-08-26: all 31 have event_gcal NULL, and zero non-Completed /
-- non-Deleted tasks link to any of them). Flipping them back to 'Scheduled'
-- would resurrect 31 obligations with no calendar entries and no reminders
-- behind them. The tombstone is the pointer, not the status.
--
-- "CANCELED MEANS COURT-CANCELED" IS A STATEMENT ABOUT THE FUTURE READ LAYER,
-- NOT ABOUT THIS TABLE. After this migration the invariant a reader can rely
-- on is:
--
--     event_status = 'Canceled' AND superseded_by_event_id IS NULL
--       ⇒ genuinely cancelled
--     event_status = 'Canceled' AND superseded_by_event_id IS NOT NULL
--       ⇒ tombstone; the live row is the one pointed at
--
-- Raw queries written against `events` MUST apply the
-- `superseded_by_event_id IS NULL` filter themselves. Nothing in the schema
-- enforces it and no view hides these rows.
--
-- NULL JOIN KEYS. event_link_type / event_link_id / event_type are nullable,
-- and `NULL = NULL` is NULL, so a row with a NULL join key can never match.
-- Exactly one event row in the table has NULL link_type/link_id today; it is
-- correctly excluded. This is conservative in the safe direction — an
-- unmatched row stays a plain Canceled event.

UPDATE events c
  JOIN events s ON s.event_link_type = c.event_link_type
               AND s.event_link_id   = c.event_link_id
               AND s.event_type      = c.event_type
               AND s.event_date      = c.event_date
               AND s.event_status    = 'Scheduled'
   SET c.superseded_by_event_id = s.event_id,
       c.supersede_reason       = 'duplicate'
 WHERE c.event_status = 'Canceled'
   AND c.superseded_by_event_id IS NULL;


-- ═════════════════════════════════════════════════════════════════════════════
-- VERIFY (run after statement 7)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- VERIFY 1 — BLOCKING. The backfill landed. Expect superseded = 31.
--   SELECT COUNT(*) AS superseded
--     FROM events
--    WHERE superseded_by_event_id IS NOT NULL;
--
-- VERIFY 2 — BLOCKING. The remaining genuine cancellations. Expect 21
--   (52 Canceled total on 2026-08-26, minus the 31 tombstoned above):
--   SELECT COUNT(*) AS genuinely_canceled
--     FROM events
--    WHERE event_status = 'Canceled'
--      AND superseded_by_event_id IS NULL;
--
-- VERIFY 3 — BLOCKING. No LIVE row may claim to be superseded. Expect ZERO:
--   SELECT event_id, event_status, superseded_by_event_id
--     FROM events
--    WHERE event_status <> 'Canceled'
--      AND superseded_by_event_id IS NOT NULL;
--
-- VERIFY 4 — BLOCKING. Every pointer resolves to a real event. Expect ZERO:
--   SELECT c.event_id, c.superseded_by_event_id
--     FROM events c
--     LEFT JOIN events s ON s.event_id = c.superseded_by_event_id
--    WHERE c.superseded_by_event_id IS NOT NULL
--      AND s.event_id IS NULL;
--
-- VERIFY 5 — BLOCKING. Pointer and reason move together, both directions.
--   Expect ZERO rows from each half:
--   SELECT event_id FROM events
--    WHERE supersede_reason IS NOT NULL AND superseded_by_event_id IS NULL;
--   SELECT event_id FROM events
--    WHERE superseded_by_event_id IS NOT NULL AND supersede_reason IS NULL;
--
-- VERIFY 6 — BLOCKING. No row supersedes itself, and no pointer targets
--   another tombstone (a chain would make "follow the pointer once" wrong).
--   Expect ZERO:
--   SELECT c.event_id, c.superseded_by_event_id
--     FROM events c
--     JOIN events s ON s.event_id = c.superseded_by_event_id
--    WHERE c.event_id = c.superseded_by_event_id
--       OR s.superseded_by_event_id IS NOT NULL;
--
-- VERIFY 7 — informational. `kind` must still be entirely NULL after E0a;
--   E0b is what populates it. Expect one row: (NULL, 152-or-current-total):
--   SELECT kind, COUNT(*) n FROM events GROUP BY kind;
--
-- VERIFY 8 — the appt column exists and is empty (nothing is backfilled).
--   Expect 0 before the backend deploy:
--   SELECT COUNT(*) AS with_lineage
--     FROM appts
--    WHERE rescheduled_from_appt_id IS NOT NULL;
--
--
-- ── LIVE GATE (Fred runs this AFTER the backend deploy) ─────────────────────
--
-- GATE 1 — reschedule a test appt (staff UI or the /m/ manage link).
--   Expect the successor row to carry the predecessor's id:
--     SELECT appt_id, appt_status, appt_date, rescheduled_from_appt_id
--       FROM appts
--      ORDER BY appt_id DESC LIMIT 3;
--   The newest row's rescheduled_from_appt_id must equal the appt_id of the
--   row now sitting at appt_status='Rescheduled'.
--
-- GATE 2 — cancel a test appt, then rebook it from the manage link.
--   Same assertion; the predecessor stays 'Canceled' (rebook does not flip it)
--   and the successor points at it.
--
-- GATE 3 — book a plain new appt. Expect rescheduled_from_appt_id NULL.
-- ─────────────────────────────────────────────────────────────────────────────
