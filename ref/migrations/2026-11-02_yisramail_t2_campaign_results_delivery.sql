-- YisraMail T2 — delivery columns on campaign_results (2026-11-02). ref/YISRAMAIL_DESIGN.md §5.4, §6.4.
--
-- ALTER of a LIVE table (campaign_results, 291 rows at write time): seven new
-- columns at the end + one index, nothing else touched. Applied by
-- scripts/yisramailT2Migrate.js --apply on ONE connection with
-- lock_wait_timeout = 10 (never paste this into the SU console: the session
-- setting would not reach the ALTER). The script builds the ALTER from what
-- is still missing, so a re-run resumes; with everything missing it is exactly
-- the statement below (tests/yisramailT2Migrate.mysql.test.js pins that).
--
-- DEPLOY ORDER (absolute):
--   1. node scripts/yisramailT2Migrate.js            (CHECK — read-only)
--   2. node scripts/yisramailT2Migrate.js --apply    (this file, then verify)
--   3. backend deploy (mail_event_ingest writes these columns)
--
-- Every existing row gets delivery_status 'unknown' and NULLs: campaigns sent
-- before T2 have no provider events. recordResult never writes these columns
-- (its ODKU leaves them as they are), so a retried send never overwrites an
-- event that arrived first (§6.4 delivery-state precedence).

ALTER TABLE campaign_results
  ADD COLUMN provider_message_id varchar(128) NULL COMMENT 'the provider message id of the send (SES: the id in the 250 reply, emailService info.providerMessageId; SES events carry it as detail.mail.messageId). Written at send by C2, and by mail_event_ingest when it correlated by the result_id tag first. Second correlation key after the result_id message tag. ref/YISRAMAIL_DESIGN.md §5.2',
  ADD COLUMN delivery_status enum('unknown','delivered','bounced_hard','bounced_soft','complained','rejected') NOT NULL DEFAULT 'unknown' COMMENT 'the strongest provider outcome seen (mail_event_ingest, from SES events): complained > bounced_hard > rejected > delivered > bounced_soft > unknown — a weaker later event never downgrades it. bounced_soft = SES Bounce Transient/Undetermined or DeliveryDelay; rejected = Reject or Rendering Failure. unknown = no event yet (and every send before T2)',
  ADD COLUMN delivered_at datetime(3) NULL COMMENT 'UTC time of the first SES Delivery event for this send (mail_event_ingest)',
  ADD COLUMN bounced_at datetime(3) NULL COMMENT 'UTC time of the first SES Bounce / DeliveryDelay event for this send, hard or soft (mail_event_ingest)',
  ADD COLUMN complained_at datetime(3) NULL COMMENT 'UTC time of the first SES Complaint event for this send (mail_event_ingest)',
  ADD COLUMN delivery_diag varchar(255) NULL COMMENT 'the provider diagnostic behind delivery_status (bounce diagnosticCode, complaint feedback type, reject reason, delay status), at most 255 characters; overwritten only when delivery_status changes',
  ADD COLUMN bounce_subtype varchar(40) NULL COMMENT 'the SES bounceSubType of the bounce behind delivery_status (mail_event_ingest; set when a bounce raises the status). OnAccountSuppressionList / EmailValidationSuppressed / OnTenantSuppressionList are SES refusing a known-bad address: still bounced_hard and an opt-out, but NOT counted in mailEventService.transportHealth bounce rate (AWS: they do not count toward the bounce rate)',
  ADD KEY ix_provider_message_id (provider_message_id);
