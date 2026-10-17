-- 2026-10-17 — comms_summaries.skip_reason COMMENT names every reason the summarize sweep writes
--
-- It listed restricted | short | empty | refused | purged; services/
-- commsSummarizeSweep.js also writes not_transcribed and (comms-summary v4.2)
-- no_speech — 98 live rows hold no_speech (2026-10-17). Doc-debt
-- 20261016_comms_summaries_skip_reason_comment.
-- COMMENT-only; definition unchanged. Column-only, so ALGORITHM=INSTANT applies
-- (proven on 8.4.11 for a column comment by the 2026-10-16 reviews).
--
-- APPLIED BY: node scripts/commsSummariesSkipReasonComment.js --apply
-- (one session: lock_wait_timeout = 5, the live definition and the old comment
-- asserted first, verified after). Not for the SU console.

SET SESSION lock_wait_timeout = 5;
ALTER TABLE `comms_summaries` MODIFY COLUMN `skip_reason` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'restricted (back to pending once unrestricted) | short | empty | no_speech | not_transcribed | refused | purged', ALGORITHM=INSTANT;
