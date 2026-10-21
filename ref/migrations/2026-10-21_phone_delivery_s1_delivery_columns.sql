-- Phone-delivery S1 (ref/PHONE_DELIVERY_DESIGN.md §4): delivery columns +
-- index on phone_event_log. APPLIED VIA scripts/phoneDeliveryS1DeliveryColumns.js
-- (one session, lock_wait_timeout 5, CHECK then --apply) — this file is the
-- dated record; do not paste it into the SU console (/admin/db/batch gives no
-- session settings). Varchar not enum per house convention (app-validated;
-- vocabulary lives in the design doc §3 and the column COMMENTs).

ALTER TABLE `phone_event_log`
  ADD COLUMN `delivery_state` varchar(12) DEFAULT NULL COMMENT 'outbound delivery, normalized by phoneDeliveryService: pending|sent|delivered|failed. NULL = incoming row, call, or never synced. Vocabulary: ref/PHONE_DELIVERY_DESIGN.md §3',
  ADD COLUMN `delivery_reason` varchar(16) DEFAULT NULL COMMENT 'failure reason (delivery_state=failed): unreachable|opted_out|spam_content|sender_flagged|unknown',
  ADD COLUMN `delivery_code` varchar(32) DEFAULT NULL COMMENT 'raw provider error code (e.g. SMS-CAR-411). Tooltip/forensics only — only the provider adapter may interpret it',
  ADD COLUMN `delivery_checked_at` datetime DEFAULT NULL COMMENT 'last phone_outbound_sync stamp (UTC)',
  ALGORITHM=INSTANT;

ALTER TABLE `phone_event_log`
  ADD INDEX `idx_phone_event_delivery` (`delivery_state`, `processed_at`),
  ALGORITHM=INPLACE, LOCK=NONE;

-- Rollback (metadata-only the other way; the index first):
--   ALTER TABLE `phone_event_log` DROP INDEX `idx_phone_event_delivery`, ALGORITHM=INPLACE, LOCK=NONE;
--   ALTER TABLE `phone_event_log`
--     DROP COLUMN `delivery_state`, DROP COLUMN `delivery_reason`,
--     DROP COLUMN `delivery_code`, DROP COLUMN `delivery_checked_at`;
