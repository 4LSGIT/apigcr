-- ============================================================
-- T9/WEAK-2 — clear stale `error` text on hook executions that a retry recovered
--
-- WHY: services/hookService.executeRetry, on a successful retry, flipped
-- hook_executions.status back to 'delivered' but left the FIRST attempt's error
-- text in the `error` column:
--
--     UPDATE hook_executions SET status = ? WHERE id = ? AND status IN ('failed','partial')
--
-- so a fully recovered execution read green in `status` and broken in `error`.
-- Live proof, hook_executions #15312 (2026-07-19):
--
--   status: "delivered"
--   error:  "Email Fred on unmatched slug: internal_function delivery failed:
--            Gmail API 400: Invalid To header"
--   its ONLY hook_delivery_logs row: status='success', attempts=2, error=NULL
--
-- The retry worked. The execution row just never said so.
--
-- The code half of this fix (same slice) adds `, error = NULL` to that UPDATE
-- when the recomputed status is 'delivered'. This file cleans the rows written
-- before it.
--
-- WHY IT IS WORTH A MIGRATION FOR ONE ROW: `hook_executions.error IS NOT NULL`
-- is exactly the predicate the T2/F-3/F-8 pattern trains an author to reach for
-- when hunting "failure recorded in a side field while the status column stays
-- green" — the shape those three slices each closed. #15312 makes that
-- predicate return a false positive on its first use, which is how a detector
-- gets written, disbelieved, and abandoned. Leaving one poisoned row costs more
-- than the UPDATE does.
--
-- ── PREDICATE — deliberately narrower than "delivered AND error IS NOT NULL" ──
-- Two guards, both load-bearing:
--
--   EXISTS (attempts > 1)          proves a RETRY happened. hook_delivery_logs
--                                  .attempts defaults to 1 (verified against
--                                  information_schema) and only executeRetry
--                                  ever increments it, so attempts > 1 is an
--                                  exact witness for "this row was recovered".
--
--   NOT EXISTS (status <> 'success')  proves nothing is still failing. The
--                                  column is enum('success','failed') NOT NULL,
--                                  so this is total.
--
-- The first guard is what keeps this migration from eating a REAL hidden
-- failure. hookService.executeHook step 6 writes
-- `allErrors = transformResult.errors + target delivery errors` into the same
-- column, and a hook whose TRANSFORM fails still delivers (it hands `{}` to the
-- targets rather than refusing — the audit's WEAK-1, deliberately out of scope
-- here). Such a row is genuinely `status='delivered'` with a genuinely
-- meaningful `error`, and every delivery log on it has attempts = 1. Clearing
-- it would destroy the only record of a live problem. Verified: zero such rows
-- exist today, but the guard is what makes the statement safe to re-run later.
--
-- ── VERIFIED AGAINST LIVE DATA BEFORE WRITING ────────────────────────────
--   hook_executions total ....................................... 21,454
--   status='delivered' AND error IS NOT NULL ......................... 1  (#15312)
--   ... of those, with a retried log and zero failed logs ............ 1  <- updated
--   ... of those, WITHOUT a retry (i.e. a real transform failure) .... 0  <- protected
--   hook_delivery_logs cross-tab: success/delivered 9,316; failed/failed 21
--
-- So the UPDATE touches exactly one row, and that row is provably recovered.
--
-- SCOPE: `partial` rows are deliberately NOT touched. A partial execution still
-- has a failed delivery log, so it is a live failure that lib/alerting.js's
-- _scanHooks catches on status alone; its error text may name a target that has
-- since recovered, but it is not a false positive for "something here is
-- broken". Narrowing further would be cosmetics on a row that is already loud.
--
-- NOT ADDRESSED HERE: executeRetry UPDATEs the delivery log IN PLACE, so the
-- failed attempt's response_status / response_body / error are overwritten and
-- the first-attempt detail is unrecoverable — which is why #15312's log reads
-- error=NULL. That is schema-shaped (an attempts table, or append-only logs)
-- and is queued with the stuck-hook-execution scanner work, not fixed here.
--
-- COLLATION: N/A — no new objects, no character columns created.
--
-- RUN ORDER: ONE standalone statement (no session variables, no cross-statement
-- state) per house convention. Order versus deploy is FREE — this is a pure
-- data cleanup of historical rows and the code change is independent:
--   • run it BEFORE the deploy  → the one stale row is cleaned; new recoveries
--     between the migration and the deploy could write one more, so re-run the
--     VERIFY afterwards.
--   • run it AFTER the deploy   → no window at all. PREFERRED.
-- Neither ordering can break the running app: no code reads this column as a
-- control flow input (only lib/alerting.js's _scanHooks reads `error`, and only
-- for rows it already selected on `status`).
--
-- IDEMPOTENT: re-running is a no-op once the rows are clean (error IS NOT NULL
-- stops matching). Safe to run repeatedly.
-- ============================================================


-- 1 of 1 — clear stale error text on recovered executions ---------------
UPDATE hook_executions e
   SET e.error = NULL
 WHERE e.status = 'delivered'
   AND e.error IS NOT NULL
   AND EXISTS (
         SELECT 1 FROM hook_delivery_logs d
          WHERE d.execution_id = e.id AND d.attempts > 1)
   AND NOT EXISTS (
         SELECT 1 FROM hook_delivery_logs d
          WHERE d.execution_id = e.id AND d.status <> 'success');


-- VERIFY 1 — the detector predicate is now honest (expect ZERO rows):
--   SELECT id, status, error FROM hook_executions
--    WHERE status = 'delivered' AND error IS NOT NULL;
--
-- VERIFY 2 — #15312 is otherwise untouched (expect status='delivered',
-- error NULL, and its delivery log still success/attempts=2):
--   SELECT e.id, e.status, e.error, d.status AS log_status, d.attempts
--     FROM hook_executions e
--     JOIN hook_delivery_logs d ON d.execution_id = e.id
--    WHERE e.id = 15312;
--
-- VERIFY 3 — nothing else moved (expect filtered 12086, delivered 9329,
-- failed 21, captured 18 — the same distribution as before the UPDATE):
--   SELECT status, COUNT(*) c FROM hook_executions GROUP BY status;
