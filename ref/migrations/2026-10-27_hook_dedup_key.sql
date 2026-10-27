-- ref/migrations/2026-10-27_hook_dedup_key.sql
--
-- Async hook receiver S3 (Fred's go 2026-10-27): dedup inbound webhooks on the
-- PROVIDER's event id. Applied by scripts/hookDedupS3.js --apply, NOT by pasting
-- this file anywhere: the script runs these statements on ONE connection with
-- the lock timeout they depend on, asserts the live state before writing (and
-- again after setting it), verifies the end state, and smoke-tests the unique
-- key in a rolled-back transaction. This file is the durable record of what it
-- runs.
--
--   hooks.dedup_path            ADD — dot-path of the provider event id (body.uuid / body.id)
--   hook_executions.dedup_key   ADD — the resolved id at receipt
--   hook_executions             ADD UNIQUE KEY uq_hook_dedup (hook_id, dedup_key)
--   hooks 16, 17 (Quo)          dedup_path = 'body.id'
--   hooks 21, 22, 23 (RC)       dedup_path = 'body.uuid'
--
-- WHY. RingCentral stamps every event with a unique body.uuid (0 duplicates in
-- 30 days, 5,054 events) but Quo REDELIVERS: 5 groups of duplicate body.id in
-- 14 days, mostly 0–5 s apart, every copy delivered, the workflow started
-- twice (Casey manager, 2026-10-27). Quo sends no webhook-id header; body.id
-- is its event id. The receiver (hookService.recordExecution) resolves the
-- hook's dedup_path against the event and stores it as dedup_key; a second
-- INSERT with the same (hook_id, dedup_key) fails on the unique key and the
-- duplicate is answered 200 {status:'received'} with no row and nothing rung.
-- NULL keys never collide (MySQL UNIQUE ignores NULLs): a hook without a
-- path, an event without the field, and every row a synchronous run writes
-- (live-test, replay, kill-switch path — dedup_key NULL) behave as before.
--
-- ORDER: THIS FIRST, THEN THE BACKEND (SQL → backend). S3's INSERT names
-- dedup_key on every inbound webhook; deployed first it would 500 while still
-- answering 200 — events LOST. Today's code never names either column. The
-- seeding is part of the migration on purpose: without it the slice is inert.
--
-- SESSION SETTING THE SCRIPT HOLDS ON ITS ONE CONNECTION:
--   lock_wait_timeout = 2           the receiver INSERTs into hook_executions
--                                   ~170 times a day; each one queued behind a
--                                   waiting ALTER is a late webhook answer
--                                   (RingCentral allows 3 s).
--
-- ALGORITHMS: the two ADD COLUMNs are INSTANT. The UNIQUE KEY is an online
-- INPLACE, LOCK=NONE build over ~35k rows (seconds; concurrent INSERTs
-- proceed). It cannot fail on duplicates: dedup_key is NULL on every row at
-- that moment (asserted twice, the second time right before the build).
-- The seed UPDATE assigns updated_at to itself so ON UPDATE does not move it,
-- and names id AND slug so a renumbered hook is never seeded by mistake.
-- dedup_key is utf8mb4_bin: provider ids are opaque, case-sensitive strings
-- (Quo's are mixed-case base62); the table default utf8mb4_general_ci would
-- fold 'EVabc' / 'EVABC' / 'EVabc ' together and refuse a legitimate event as
-- a duplicate — the documents.external_id precedent.

SET SESSION lock_wait_timeout = 2;

ALTER TABLE `hooks` ADD COLUMN `dedup_path` VARCHAR(100) NULL DEFAULT NULL COMMENT 'Async hook receiver S3 (2026-10-27): dot-path into the received event ({body,headers,query,method,meta}) of the PROVIDER event id — RingCentral body.uuid, Quo body.id. The receiver stores the resolved value as hook_executions.dedup_key; a second event with the same id for this hook is answered 200 and NOT recorded (no row, nothing runs). NULL = no dedup. Edited in the hook editor (Filter tab).' AFTER `transform_config`, ALGORITHM=INSTANT;
ALTER TABLE `hook_executions` ADD COLUMN `dedup_key` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL DEFAULT NULL COMMENT 'Async hook receiver S3 (2026-10-27): the provider event id resolved from hooks.dedup_path at receipt (longer than 191 chars: sha256 hex). UNIQUE with hook_id — a redelivered event fails its INSERT and is answered 200 with no row. NULL when the hook has no path, the event no value, or the row was written by a synchronous run (live-test, replay, kill-switch path) — NULLs never collide.' AFTER `attempts`, ALGORITHM=INSTANT;
ALTER TABLE `hook_executions` ADD UNIQUE KEY `uq_hook_dedup` (`hook_id`, `dedup_key`), ALGORITHM=INPLACE, LOCK=NONE;

UPDATE `hooks` SET dedup_path = 'body.id',   updated_at = updated_at WHERE id = 16 AND slug = 'quo-message'    AND dedup_path IS NULL;
UPDATE `hooks` SET dedup_path = 'body.id',   updated_at = updated_at WHERE id = 17 AND slug = 'quo-call'       AND dedup_path IS NULL;
UPDATE `hooks` SET dedup_path = 'body.uuid', updated_at = updated_at WHERE id = 21 AND slug = 'rc-message-in'  AND dedup_path IS NULL;
UPDATE `hooks` SET dedup_path = 'body.uuid', updated_at = updated_at WHERE id = 22 AND slug = 'rc-message-out' AND dedup_path IS NULL;
UPDATE `hooks` SET dedup_path = 'body.uuid', updated_at = updated_at WHERE id = 23 AND slug = 'rc-call'        AND dedup_path IS NULL;

-- SMOKE (the script, in a transaction it ROLLS BACK): two INSERTs into
-- hook_executions with the same (hook_id, dedup_key) — the second fails with
-- ER_DUP_ENTRY; two with dedup_key NULL both succeed.

-- ── ROLLBACK (only before S3 is deployed; S3 names both columns) ──────────
-- SET SESSION lock_wait_timeout = 2;
-- UPDATE `hooks` SET dedup_path = NULL, updated_at = updated_at WHERE id IN (16, 17, 21, 22, 23);
-- ALTER TABLE `hook_executions` DROP INDEX `uq_hook_dedup`, ALGORITHM=INPLACE, LOCK=NONE;
-- ALTER TABLE `hook_executions` DROP COLUMN `dedup_key`, ALGORITHM=INSTANT;
-- ALTER TABLE `hooks` DROP COLUMN `dedup_path`, ALGORITHM=INSTANT;
