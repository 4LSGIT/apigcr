-- 2026-10-27 — mailboxes.ingest_state COMMENT names the poison-message keys
--
-- The ingest worker writes poison / quarantined / quarantined_total per folder
-- since the quarantine slice (2026-10-26); the COMMENT listed the cursor keys
-- only. MySQL caps a column COMMENT at 1024 characters (the old one was 968),
-- so the new text names the keys and points at the service header (POISON
-- MESSAGES) for the full shapes. Doc-debt 20261026_mailboxes_ingest_state_comment.
-- COMMENT-only; definition unchanged; ALGORITHM=INSTANT (proven on 8.4.11 for
-- this JSON column, 2026-10-27).
--
-- APPLIED BY: node scripts/mailboxIngestStateComment.js --apply
-- (one session: lock_wait_timeout = 5, the live definition and the old comment
-- asserted first, verified after). Not for the SU console.

SET SESSION lock_wait_timeout = 5;
ALTER TABLE `mailboxes` MODIFY COLUMN `ingest_state` json DEFAULT NULL COMMENT 'per-folder CURSOR, written only by services/mailbox/mailboxIngestService.js (its header is the contract): {"<folder>": {uidvalidity, last_uid = new-mail cursor, backfill_uid = backlog still to store below it (absent = done), backfill_floor_uid = re-keyed backfill:false folder stores only above it, backfill_emit_after = ISO emit horizon from a re-key (null = store-only), backfill_skipped_below / _at = backfill:false baseline, checked_at, errors, backfill_errors, last_error, last_error_at, rekeyed_at, backfill_done_at, no_provider_id_total / last_no_provider_id_at / _uid = stored, not emitted, drafts_skipped_total = Drafts never stored, poison = {uid, attempts, ..., held?} UID the new pass keeps failing on, quarantined = [...] last 20 UIDs skipped for good, quarantined_total (POISON MESSAGES)}}. First poll baselines at UIDNEXT: existing mail stored (or skipped), never emitted. UIDVALIDITY change = re-key, never blanket purge. A folder dropped from ingest_folders keeps its key. NULL = never ingested', ALGORITHM=INSTANT;
