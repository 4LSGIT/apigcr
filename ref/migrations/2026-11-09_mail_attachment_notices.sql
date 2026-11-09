-- ref/migrations/2026-11-09_mail_attachment_notices.sql
--
-- Email attachments S2d — the BURST DIGEST (ref/EMAIL_ATTACHMENTS_DESIGN.md §8).
-- A client who emails docs@ twenty times in forty minutes got twenty notices.
-- Now each email's attachments are still filed at once, but its NOTICE waits
-- here; one notice goes out per burst — when the sender has been quiet for 5
-- minutes (measured at ingest), or 30 minutes after the burst's first
-- un-notified email, whichever comes first (Fred, 2026-11-09). One row per
-- (digest, email):
--   - written by email_attachments_file when its step passes digest_key
--     (a placeholder before the files are filed — result NULL — so a burst
--     still being filed holds the digest back; the result once they are);
--   - claimed by email_attachments_digest: notified_at + digest_of (the
--     email whose workflow sent the notice — rows sharing digest_of ARE the
--     burst, and email_attachments_refile moves a burst by it).
--
-- result is MEDIUMTEXT holding JSON, NOT a JSON column, on purpose: it carries
-- email-derived text cut at fixed lengths, and MySQL refuses a lone UTF-16
-- surrogate in a JSON value (the 2026-10-25 executions-row incident); a text
-- column takes what mysql2 encodes (U+FFFD).
--
-- No FK to mail_messages, same reason as mail_attachment_filings: the record
-- outlives a purged or pruned mail copy. Times are UTC, written with
-- UTC_TIMESTAMP() by the service (never a session-zone default).
--
-- Run ONCE, before the backend deploy (SQL → backend → console script). SU DB
-- console is fine (one statement). Idempotent: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS mail_attachment_notices (
  digest_key      VARCHAR(40)     NOT NULL COMMENT 'which digest: the workflow step''s digest_key (docs@ intake: docs@). A burst never spans two keys',
  mail_message_id BIGINT UNSIGNED NOT NULL COMMENT 'mail_messages.id (no FK on purpose: outlives a purged or pruned mail copy)',
  sender          VARCHAR(255)    NOT NULL COMMENT 'the From address, lowercased — the burst key; #<mail_message_id> when the email had none (never grouped)',
  ingested_at     DATETIME        NOT NULL COMMENT 'UTC. mail_messages.ingested_at — the burst clock (quiet time and cap are measured on it)',
  result          MEDIUMTEXT      COMMENT 'JSON: the email_attachments_file result the notice is built from. NULL while the email''s files are being filed (a placeholder: holds the digest back for 15 minutes at most)',
  digest_of       BIGINT UNSIGNED DEFAULT NULL COMMENT 'the mail_message_id whose workflow sent the notice covering this email; rows sharing it are one burst. NULL = not notified yet',
  notified_at     DATETIME        DEFAULT NULL COMMENT 'UTC. When the row was claimed into a notice',
  created_at      DATETIME        NOT NULL COMMENT 'UTC. When the filing step queued it (the placeholder''s staleness clock)',
  PRIMARY KEY (digest_key, mail_message_id),
  KEY idx_mail_attachment_notice_pending (digest_key, sender, notified_at),
  KEY idx_mail_attachment_notice_digest (digest_key, digest_of)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Email attachments burst digest (ref/EMAIL_ATTACHMENTS_DESIGN.md §8): one row per email whose notice waits for its sender''s burst to end';
