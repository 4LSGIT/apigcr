-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-09 — Mailbox system S2 polish: mail_image_senders
--   A. mail_image_senders — each user's "always show images from" senders
--
-- WHY
--   The comms hub blocks remote images by default: a tracking pixel tells the
--   sender the message was opened (opposing counsel included). "Show images"
--   lifts that for one message. A reader can now trust a SENDER for
--   themselves, so mail from it opens with images shown — the court's ECF
--   notices, a vendor's statements. Per USER (privacy is personal, like read
--   state) and per exact ADDRESS (never a whole domain). The From header is
--   the sender's own claim, so a forged From from a trusted address can at
--   most learn the message was opened: the sanitizer, the iframe sandbox and
--   the CSP are the same whatever the trust (only img-src widens).
--   Code: services/mailbox/mailReadService.js (markTrust on every thread /
--   message read, list/trust/untrust), routes/api.mail.js
--   (/api/mail/image-senders), public/comms.html.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- SQL FIRST, then backend. The new backend reads this table on EVERY thread /
-- single-message open (markTrust): deployed before this file, opening any
-- conversation in Comms fails (ER_NO_SUCH_TABLE) until it runs. The current
-- backend never names the table, so running this first is safe. Run it before
-- `git go` too — the pre-commit hook regenerates ref/database.sql from the
-- live schema.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS — one statement, safe from the SU DB console and
-- safe to re-run.
--
-- ── CONVENTIONS ─────────────────────────────────────────────────────────────
-- No DEFAULT CHARSET clause: the table inherits utf8mb4_general_ci, so
-- `address` compares case-insensitively and joins cleanly
-- (ref/SCHEMA_CONVENTIONS.md). No FK (house style); users.user is TINYINT.
-- No seed rows.
--
-- After running: regenerate the schema snapshot via
-- POST /admin/db/schema/save-to-ref (or `npm run db:ref`, or just commit —
-- the pre-commit hook does it). ref/database.sql is auto-generated.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Roll the backend back first (it reads the table on every open), then:
--   DROP TABLE mail_image_senders;
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mail_image_senders (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user       TINYINT      NOT NULL COMMENT 'users.user (FK by convention) - whose trust this is; every query carries user = caller',
  address    VARCHAR(255) NOT NULL COMMENT 'sender address as the hub parses From (the <angle> part), lowercased at write; app-validated',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mail_image_senders_user_address (user, address)
) ENGINE=InnoDB
  COMMENT='Comms hub: per-user "always show images from" senders (S2). Remote images are blocked by default (read receipts); a row here makes this user''s view of mail From this address load them. Never a grant, never firm-wide.';


-- VERIFY — the table, on the schema collation, with its unique key:
--   SELECT TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES
--    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_image_senders';
--     → mail_image_senders | utf8mb4_general_ci
--   SHOW INDEX FROM mail_image_senders;
--     → PRIMARY (id), uq_mail_image_senders_user_address (user, address)
-- ─────────────────────────────────────────────────────────────────────────────
