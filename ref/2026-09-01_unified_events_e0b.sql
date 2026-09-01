-- 2026-09-01_unified_events_e0b.sql
-- Slice U1 (= v0.4 E0b). Governing: ref/UNIFIED_EVENTS_DESIGN_V0_5.md Appendix A.1, §7 (U1).
-- Author: CAL (manager), 2026-09-01. Applied by Fred via the SQL runner.
--
-- WHAT: populate events.kind from event_type per the ratified vocabulary, and apply the four
--       row-level hand-fixes Fred approved (ids 4, 6, 107, 134).
-- NOT:  no DDL (events.kind exists since E0a), no type_key (arrives in U2), no rewrite of
--       event_type strings, no session variables, no write to any other table.
--
-- IDEMPOTENT: every bulk UPDATE is guarded by `kind IS NULL`; hand-fixes are guarded by the
--       row's exact current (id, type[, status]). Re-running is a no-op. U2 re-runs the five
--       bulk statements for rows created between this apply and U2's apply (write paths do not
--       set kind until U2).
--
-- COLLATION: events.event_type is utf8mb4_general_ci; IN (...) matches case-insensitively.
--       Binary census 2026-09-01: 25 BINARY-distinct values == 25 ci-distinct — no hidden variants.
--
-- LIVE 2026-09-01 (155 rows, kind 100% NULL): hearing 50 / conference 5 / meeting 16 /
--       deadline 82 / other 2 after the hand-fixes. Rows created between now and apply shift
--       these by the new rows' types. The gate is `kind IS NULL` = 0, not the absolute counts.
--
-- ROLLBACK: UPDATE events SET kind = NULL;  (E0a state)  and, for id 134 only,
--       UPDATE events SET event_status='Scheduled' WHERE event_id=134 AND event_type='Trial / Pre-Trial Hearing';
--       Nothing else changes. caseEventService derives keys from strings and is unaffected either way.

-- ── bulk: kind by type ───────────────────────────────────────────────────────────────────────
UPDATE events SET kind = 'hearing'
 WHERE kind IS NULL
   AND event_type IN ('Confirmation Hearing','confirmation_hearing','Hearing',
                      'Show Cause','Show Cause Hearing','Trial','Trial / Pre-Trial Hearing');

UPDATE events SET kind = 'conference'
 WHERE kind IS NULL
   AND event_type IN ('Telephonic Status Conference','Status Conference',
                      'Initial Scheduling Conference','Pre-trial Conference','Deposition');

UPDATE events SET kind = 'meeting'
 WHERE kind IS NULL
   AND event_type = '341';

UPDATE events SET kind = 'deadline'
 WHERE kind IS NULL
   AND event_type IN ('dischargeability_due','object_confirmation_due','poc_due','poc_gov_due',
                      'Docs Deadline','Schedules Deadline','Confirmation Certificate Deadline',
                      'Filing Fee Deadline','Filing Fee Installment Deadline','Deadline');

UPDATE events SET kind = 'other'
 WHERE kind IS NULL
   AND event_type IN ('Order','Milestone');

-- ── row-level hand-fixes (Fred, 2026-08-30 / 09-01) ─────────────────────────────────────────
-- These mirror caseEventService._EVENT_ROW_OVERRIDES (E1). U3 deletes that map once type_key
-- lands in U2; until then the read layer and the column agree by construction.

-- id 6: 'Deadline' on contact 1001, Canceled — a test row, not a deadline.
UPDATE events SET kind = 'other'
 WHERE event_id = 6 AND event_type = 'Deadline';

-- id 4: 'Milestone' "Reminder smoke", unlinked, Canceled — test row. Already 'other' from the
-- bulk statement; stated explicitly so the override list is complete and greppable.
UPDATE events SET kind = 'other'
 WHERE event_id = 4 AND event_type = 'Milestone';

-- id 107: 'Order' "Order Extending Time to Pay Case Filing Fee", all-day, Scheduled — the
-- date the row carries IS the extended filing-fee deadline. Key at U2: filing_fee_deadline.
UPDATE events SET kind = 'deadline'
 WHERE event_id = 107 AND event_type = 'Order';

-- id 134: 'Trial / Pre-Trial Hearing' "Order Canceling Trial and Pre-Trial Hearing Dates",
-- all-day, stored as Scheduled — the row is a cancellation notice, not a hearing. kind stays
-- 'hearing' (bulk); status becomes Canceled. Verified 2026-09-01: event_gcal NULL,
-- event_calendar_id 'none', no tasks linked → no side effects to orchestrate.
UPDATE events SET event_status = 'Canceled'
 WHERE event_id = 134
   AND event_type = 'Trial / Pre-Trial Hearing'
   AND event_status = 'Scheduled';

-- ── VERIFY (run after apply; expected as of 2026-09-01) ─────────────────────────────────────
-- 1. must be 0
SELECT COUNT(*) AS kind_null_must_be_0 FROM events WHERE kind IS NULL;

-- 2. conference 5 / deadline 82 / hearing 50 / meeting 16 / other 2 (+ rows created since)
SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY kind;

-- 3. 4 other Canceled · 6 other Canceled · 107 deadline Scheduled · 134 hearing Canceled
SELECT event_id, event_type, kind, event_status FROM events WHERE event_id IN (4,6,107,134) ORDER BY event_id;

-- 4. exactly one row: ('Deadline', 2) — the only type with two kinds, by design (id 6 override)
SELECT event_type, COUNT(DISTINCT kind) AS kinds FROM events GROUP BY event_type HAVING kinds > 1;

-- 5. superseded/canceled rows got kind too (kind is the type's kind, not a status): must be 0
SELECT COUNT(*) AS superseded_without_kind FROM events WHERE superseded_by_event_id IS NOT NULL AND kind IS NULL;