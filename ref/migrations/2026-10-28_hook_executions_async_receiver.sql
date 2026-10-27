-- ref/migrations/2026-10-28_hook_executions_async_receiver.sql
--
-- Async hook receiver S0 (Fred's go 2026-10-28): the three columns that let
-- `hook_executions` be the SCHEDULING AUTHORITY for inbound webhooks. Applied by
-- scripts/hookAsyncReceiverS0.js --apply, NOT by pasting this file anywhere: the
-- script runs these statements on ONE connection with the lock timeout they
-- depend on, asserts the live state before writing (and again after setting
-- it), verifies the end state, and smoke-tests the claim primitive in a
-- rolled-back transaction. This file is the durable record of what it runs.
--
--   hook_executions.claimed_at     ADD — when a drain claimed the row
--   hook_executions.completed_at   ADD — when the pipeline finished
--   hook_executions.attempts       ADD — claims so far (bumped at claim time)
--   hook_executions.status         COMMENT — what each value means once the row is the queue
--
-- WHY. RingCentral requires a 200 within 3000 ms and blacklists a subscription
-- that fails that for 10 minutes (silently; recovery = delete + recreate).
-- Today the receiver runs the hook's code filter + transform (QuickJS guest, up
-- to 15 s, one reserved sandbox slot) and the workflow start BEFORE answering,
-- so one slow body or a saturated lane makes every RC answer late. S1 answers
-- as soon as the execution row is written and a Cloud Tasks doorbell is rung;
-- filter, transform and targets run request-bound in POST
-- /process-hook-execution/:id, with the 60 s /process-jobs cron draining any
-- row whose doorbell never rang. Cloud Tasks delivers at least once: the
-- handler claims the row with ONE conditional UPDATE and only the winner runs
-- (lib/domainEventDrain.js is the precedent). Research and measurements:
-- local/RESEARCH_async_hook_receiver_FINDINGS.md.
--
-- ORDER: THIS FIRST, THEN THE BACKEND (SQL → backend). S1 SETs the three
-- columns on every inbound webhook; deployed first it would 500 on an unknown
-- column while still answering 200 — events LOST, not retried. Today's code
-- never names them, so this migration is invisible to the running app.
--
-- SESSION SETTING THE SCRIPT HOLDS ON ITS ONE CONNECTION:
--   lock_wait_timeout = 2           every ALTER (even INSTANT) takes an exclusive
--                                   metadata lock; the global default is a year.
--                                   The receiver INSERTs here ~170 times a day and
--                                   each one queued behind a waiting ALTER is a late
--                                   webhook answer (RingCentral allows 3 s) — hence
--                                   2 s, not the usual 5.
--
-- ALGORITHMS: every ALTER is INSTANT (ADD COLUMN with a constant default or
-- NULL; a comment change). ~30k rows (2026-10-27).
--
-- NO INDEX. The drain reads `status = 'received' AND claimed_at IS NULL` and
-- the stale sweep `status IN ('received','processing') AND claimed_at < …`;
-- both are served by the existing idx_status (received/processing rows are a
-- handful at any moment). Every historical row keeps claimed_at / completed_at
-- NULL and attempts 0 — no backfill: the drain keys off status, and a
-- historical row is never 'received'.

SET SESSION lock_wait_timeout = 2;

ALTER TABLE `hook_executions` ADD COLUMN `claimed_at` DATETIME(3) NULL DEFAULT NULL COMMENT 'Async receiver (2026-10-28): when a drain — the Cloud Tasks doorbell POST /process-hook-execution/:id or the /process-jobs cron — claimed this row to run filter, transform and targets. NULL = still queued (status received), or a row that predates the async receiver. The claim is ONE conditional UPDATE (WHERE status = received AND claimed_at IS NULL): Cloud Tasks delivers at least once and the loser of the claim does nothing. A synchronous run (dry run, live-test, /internal/hook-replay, the kill-switch path) sets claimed_at at INSERT so the drain never picks it up.' AFTER `created_at`, ALGORITHM=INSTANT;
ALTER TABLE `hook_executions` ADD COLUMN `completed_at` DATETIME(3) NULL DEFAULT NULL COMMENT 'Async receiver: when the drain finished and status became final. completed_at - created_at is the end-to-end pipeline time (created_at is receipt). NULL while queued or running, and on rows that predate the async receiver.' AFTER `claimed_at`, ALGORITHM=INSTANT;
ALTER TABLE `hook_executions` ADD COLUMN `attempts` TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Async receiver: claims so far, bumped AT claim time (a run that killed its instance has already spent its attempt). The stale sweep (lib/hookDrain.js) re-queues or fails a claimed row that never completed; its window and cap live there.' AFTER `completed_at`, ALGORITHM=INSTANT;
ALTER TABLE `hook_executions` MODIFY COLUMN `status` enum('received','filtered','processing','delivered','partial','failed','captured') NOT NULL DEFAULT 'received' COMMENT 'received = queued for the drain (claimed_at NULL) or running filter and transform (claimed_at set, completed_at NULL); processing = transform written, targets running; filtered | delivered | partial | failed | captured = final. A row stuck in processing after its claim must NOT be re-run automatically — targets may have fired. (Async receiver, 2026-10-28)', ALGORITHM=INSTANT;

-- SMOKE (the script, in a transaction it ROLLS BACK): INSERT a 'received' row;
-- it reads claimed_at NULL / completed_at NULL / attempts 0; then
--   UPDATE hook_executions SET claimed_at = NOW(3), attempts = attempts + 1
--    WHERE id = ? AND status = 'received' AND claimed_at IS NULL
-- affects 1 row the first time and 0 the second — the at-least-once primitive
-- S1's drain relies on, proven on the live table shape.

-- ── ROLLBACK (only before S1 is deployed; S1 needs the columns) ───────────
-- SET SESSION lock_wait_timeout = 2;
-- ALTER TABLE `hook_executions` DROP COLUMN `attempts`, ALGORITHM=INSTANT;
-- ALTER TABLE `hook_executions` DROP COLUMN `completed_at`, ALGORITHM=INSTANT;
-- ALTER TABLE `hook_executions` DROP COLUMN `claimed_at`, ALGORITHM=INSTANT;
-- ALTER TABLE `hook_executions` MODIFY COLUMN `status` enum('received','filtered','processing','delivered','partial','failed','captured') NOT NULL DEFAULT 'received', ALGORITHM=INSTANT;
