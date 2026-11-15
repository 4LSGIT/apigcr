-- 2026-11-15 — comm_unsub_tokens.campaign_id COMMENT names the triggered promotional send
--
-- The P3 migration (2026-10-30_yisramail_p3_unsub_tokens.sql) wrote
-- "NULL: test/smoke mints". Since YisraMail C7 (2026-11-05)
-- campaignService.sendPromotional mints a real token for every TRIGGERED
-- promotional send with campaign_id NULL — one recipient, no campaign row,
-- contact_id attributed — so NULL is a production value. Doc-debt
-- 20261105_unsub_token_campaign_null_comment. COMMENT-only; definition
-- unchanged; ALGORITHM=INSTANT (proven on 8.4.11 for this int column,
-- 2026-11-15).
--
-- APPLIED BY: node scripts/commUnsubTokensCampaignIdComment.js --apply
-- (one session: lock_wait_timeout = 5, the live definition and the old comment
-- asserted first, verified after). Not for the SU console.

SET SESSION lock_wait_timeout = 5;
ALTER TABLE `comm_unsub_tokens` MODIFY COLUMN `campaign_id` int DEFAULT NULL COMMENT 'campaigns.id of the campaign send that minted it. NULL = a triggered promotional send (campaignService.sendPromotional, C7: one recipient, no campaign row, contact_id attributed) or a test/smoke mint', ALGORITHM=INSTANT;
