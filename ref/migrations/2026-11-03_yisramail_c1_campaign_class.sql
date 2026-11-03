-- YisraMail C1 — campaign class, over-cap marker, paused, the send reservation's statuses and the
-- marketing kill switch (2026-11-03). ref/YISRAMAIL_DESIGN.md §6.1, §6.4 "As built (C1)".
--
-- ALTERs of LIVE tables (campaigns: 118 rows, campaign_results: ~291 at write time): three new
-- campaigns columns at the end, one enum member appended to campaigns.status, two appended to
-- campaign_results.status, the COMMENTs of campaign_results.provider_message_id (C1's 'sent'
-- update now writes it too) and email_credentials.bulk_ok (an over-cap operational campaign may
-- now send through a bulk row, D16) — nothing else touched; existing rows read class 'operational'.
-- Plus ONE app_settings row: marketing_send_enabled = '0' (an explicit row, so the switch starts
-- dark and turning it on is an UPDATE, not an INSERT; an existing row is left as it is).
-- Applied by scripts/yisramailC1Migrate.js --apply on ONE connection with lock_wait_timeout = 10
-- (never paste this into the SU console: the session setting would not reach the ALTERs). The
-- script builds each ALTER from what is still missing, so a re-run resumes; with everything
-- missing it runs exactly the statements below (tests/yisramailC1Migrate.mysql.test.js pins that).
--
-- DEPLOY ORDER (absolute):
--   1. node scripts/yisramailC1Migrate.js            (CHECK — read-only)
--   2. node scripts/yisramailC1Migrate.js --apply    (this file, then verify)
--   3. backend deploy (campaignService selects class / topic_key / bulk_confirmed_count and
--      writes 'sending' / 'unknown' / 'paused')

ALTER TABLE campaigns
  MODIFY COLUMN status enum('draft','scheduled','sending','sent','failed','partial_fail','canceled','paused') DEFAULT 'draft' COMMENT 'scheduled (future send) -> sending (the first send flips it) -> sent / failed / partial_fail (campaignService.checkCompletion when every recipient has a terminal result: unknown counts like failed); canceled (cancelCampaign, from draft / scheduled / sending / paused — pending jobs deleted); paused (C1: PATCH from scheduled / sending — pending send jobs stay pending but PARKED (scheduled_time + 1000 years, never due), the pump stops; resume = sending again, the parked jobs re-staggered from now). draft is never written. ref/YISRAMAIL_DESIGN.md §6.4',
  ADD COLUMN class enum('operational','marketing') NOT NULL DEFAULT 'operational' COMMENT 'the send class chosen at compose (C1, ref/YISRAMAIL_DESIGN.md §6.1), enforced by campaignService.createCampaign (every caller, API keys included): operational = about the recipient''s case, appointment or account; email asks NO consent (D18), SMS asks scope all (D19); capped at campaign_operational_cap unless confirmed over the cap (bulk_confirmed_count). marketing = email only (D1), topic required, a bulk_ok sender, the campaigns.bulk capability, and refused while app_settings marketing_send_enabled is not exactly 1 (create 422; executeSend records skipped marketing_disabled — and marketing_path_unbuilt until C2 builds the marketing send path)',
  ADD COLUMN topic_key varchar(40) NULL COMMENT 'marketing campaigns only (NULL for operational): the comm_topics.topic_key recipients are sent under and can unsubscribe from — shape [a-z0-9_]{1,40} (interpolated into SQL by optoutService), validated at create as an existing, active email topic; executeSend asks consent for scope marketing + this topic',
  ADD COLUMN bulk_confirmed_count int unsigned NULL COMMENT 'operational campaigns over the cap only (D16): the recipient count a campaigns.bulk holder typed to confirm the send (equals contact_count; audited as admin_audit_log tool campaign_over_cap). NOT NULL marks the campaign over-cap: paced (staggered jobs + a campaign_pump job) and allowed to send through a bulk_ok email row (bulk:true, no footer, no headers). NULL = within the cap, or marketing';

ALTER TABLE campaign_results
  MODIFY COLUMN status enum('sent','failed','skipped','sending','unknown') NOT NULL COMMENT 'one row per recipient (uq_campaign_contact). The send reservation (C1, at most once): campaignService.executeSend INSERTs the row as sending (result_meta.attempt_id) BEFORE the provider call, then UPDATEs that attempt''s row to sent; a definite provider refusal deletes the reservation before retry / failed. A later attempt finding a sending row never resends: the row becomes unknown (the provider may have accepted it). sending is NOT done for checkCompletion; unknown is (and counts like failed for the final status). skipped / failed with no provider call are recorded first-wins (never overwrite an existing row)',
  MODIFY COLUMN provider_message_id varchar(128) NULL COMMENT 'the provider message id of the send (SES: the id in the 250 reply, emailService info.providerMessageId; SES events carry it as detail.mail.messageId). Written by campaignService.executeSend''s sent update when the transport returned one (C1; never overwrites a value already stored), and by mail_event_ingest when it correlated by the result_id tag first. Second correlation key after the result_id message tag. ref/YISRAMAIL_DESIGN.md §5.2';

ALTER TABLE email_credentials
  MODIFY COLUMN bulk_ok tinyint(1) NOT NULL DEFAULT 0 COMMENT '1 = a marketing (bulk) transport: never in a sender picker (campaign compose lists it apart, for marketing and over-cap campaigns only), refused by the public emailService.sendEmail, by createCampaign for an operational campaign within the cap, and as a mailbox send_credential_id; only sendEmailDirect({bulk:true}) may send from it — the campaign marketing path (C2) and an operational campaign confirmed over the cap (C1, D16: no footer, no headers). SMTP rows only; no other row may share its (smtp_host, smtp_user) and no mailbox may send through it (the sender editor refuses both). ref/YISRAMAIL_DESIGN.md §5.2, §6.1';

INSERT INTO app_settings (`key`, `value`, is_secret, is_editable)
  VALUES ('marketing_send_enabled', '0', 0, 0)
  ON DUPLICATE KEY UPDATE `key` = `key`;
