-- YisraMail T1 — transport contract (2026-11-01). ref/YISRAMAIL_DESIGN.md §5.2.
--
-- ALTER of a LIVE table (email_credentials, 12 rows at write time): three new
-- columns at the end, nothing else touched. Applied by
-- scripts/yisramailT1Migrate.js --apply on ONE connection with
-- lock_wait_timeout = 10 (never paste this into the SU console: the session
-- setting would not reach the ALTER). The script builds the ALTER from the
-- columns still missing, so a re-run resumes; with all three missing it is
-- exactly the statement below (tests/yisramailT1Migrate.mysql.test.js pins
-- that the two agree).
--
-- DEPLOY ORDER (absolute):
--   1. node scripts/yisramailT1Migrate.js            (CHECK — read-only)
--   2. node scripts/yisramailT1Migrate.js --apply    (this file, then verify)
--   3. backend deploy (every email_credentials reader filters bulk_ok)
--   4. frontend (the sender editor's three fields) — same deploy here
--   5. Fred marks row 17 (news@news.4lsg.com) bulk + ses in the editor
--
-- Every existing row gets bulk_ok = 0, events_driver NULL, driver_config NULL:
-- no behavior changes until a row is marked bulk.

ALTER TABLE email_credentials
  ADD COLUMN bulk_ok tinyint(1) NOT NULL DEFAULT 0 COMMENT '1 = a marketing (bulk) transport: never listed to a sender picker, refused by the public emailService.sendEmail, by createCampaign and as a mailbox send_credential_id; only sendEmailDirect({bulk:true}) — the campaign marketing path — may send from it. SMTP rows only; no other row may share its (smtp_host, smtp_user) and no mailbox may send through it (the sender editor refuses both). ref/YISRAMAIL_DESIGN.md §5.2',
  ADD COLUMN events_driver varchar(20) NULL COMMENT 'names the provider driver (services/adapters/email/drivers/<name>.js) that adds its headers at send and parses its events (T2); bulk_ok rows only (emailService throws events_driver_requires_bulk otherwise). NULL = plain SMTP, no driver. Today: ses',
  ADD COLUMN driver_config json NULL COMMENT 'driver-specific settings, e.g. {"configuration_set": "yisramail-marketing"} for ses; bulk_ok rows only, cleared with the driver. NULL = the provider defaults';
