-- YisraMail C2 — the marketing send path: the send-start snapshot and the transport hold
-- (2026-11-04). ref/YISRAMAIL_DESIGN.md §6.4 / §6.5 "As built (C2)".
--
-- ALTERs of LIVE tables (campaigns: 118 rows, email_credentials: a handful at write time): three
-- NULLable columns added at the end, nothing else touched; every existing row reads NULL (no
-- snapshot taken, no transport held). No app_settings row: the new setting marketing_reply_to is
-- registry-only (blank = the firm email).
-- Applied by scripts/yisramailC2Migrate.js --apply on ONE connection with lock_wait_timeout = 10
-- (never paste this into the SU console: the session setting would not reach the ALTERs). The
-- script builds each ALTER from what is still missing, so a re-run resumes; with everything
-- missing it runs exactly the statements below (tests/yisramailC2Migrate.mysql.test.js pins that).
--
-- DEPLOY ORDER (absolute):
--   1. node scripts/yisramailC2Migrate.js            (CHECK — read-only)
--   2. node scripts/yisramailC2Migrate.js --apply    (this file, then verify)
--   3. backend deploy (campaignService selects send_snapshot and email_credentials.held_at /
--      held_reason — createCampaign reads held_at for EVERY email campaign, so the backend
--      before this file would fail every email campaign create)

ALTER TABLE campaigns
  ADD COLUMN send_snapshot json NULL COMMENT 'marketing campaigns only (C2, MRPC 7.2(b) — keep >= 2 years): written ONCE by the first marketing send (conditional UPDATE ... WHERE send_snapshot IS NULL; a concurrent first send reads the winner back) — {v, taken_at, firm (complianceFooter.firmValues at send start), topic {topic_key,label,consent_model}, reply_to, list_id, sender, subject, html, text (the template copy with the footer injected; token_placeholder names the per-recipient token)}. Every recipient renders its footer and refs.firm FROM it, so a settings edit mid-send cannot split the campaign. NULL = no marketing send has started (and every operational campaign)';

ALTER TABLE email_credentials
  ADD COLUMN held_at datetime NULL COMMENT 'UTC time the marketing transport was HELD (C2, ref/YISRAMAIL_DESIGN.md §6.5): set by campaignService when the 24 h complaint rate passes 0.3 % or the hard-bounce rate 5 % (with >= 200 delivered), or when the provider refuses at the account level (SES sending paused). While set: every marketing send on it pauses its campaign, new marketing campaigns on it are refused (422 transport_held), the marketing test send is refused. Never cleared automatically — only the audited SU release (POST /api/campaigns/transports/:id/release, admin_audit_log tool mail_transport_release). NULL = not held',
  ADD COLUMN held_reason varchar(255) NULL COMMENT 'why the transport is held (the first trip wins — a later trip while held does not overwrite it); cleared with held_at by the SU release. NULL when not held';
