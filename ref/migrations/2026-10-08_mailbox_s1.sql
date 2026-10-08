-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-08 — Mailbox system S1: IMAP ingest worker
--   A. mail_messages.ingested_at + (mailbox_id, ingested_at) index
--   B. mailboxes.ingest_state COMMENT → the cursor shape S1 actually writes
--   B2. mail_messages COMMENTs → the address/date/attachments formats S1 writes
--   C. email_ingest_sources row 'mailbox-imap' (the worker's in-process source)
--
-- WHY
--   S1 starts filling the tier-1 store (mail_messages) from IMAP and emits
--   new mail into the existing rules pipeline (emailIngestService) as its own
--   ingest source. Spec: ref/MAILBOX_SYSTEM_DESIGN.md §4.1, D1/D4/D6.
--   Code: services/mailbox/imapTransport.js (all IMAP),
--   services/mailbox/mailboxIngestService.js (the worker),
--   routes/mailboxIngest.js (ALL /mailbox-ingest, the Cloud Scheduler tick),
--   routes/api.mailboxes.js (GET …/messages/:mid/parts/:part, on-demand
--   attachments).
--
--   A. `ingested_at` is the pruning axis for the 2-year mirror window (OQ2):
--      `date` is the sender's Date header — absent, wrong, or spoofed often
--      enough that "older than two years" cannot hang off it.
--   B. S0's COMMENT described the cursor as {uidvalidity, last_uid}. S1 adds
--      the backlog cursor, the emit horizon and failure bookkeeping; the
--      COMMENT is the documentation of record (it flows into ref/database.sql).
--   B2. Same reason: S2 reads these columns, and the formats are decisions
--      (display-form addresses, INTERNALDATE fallback, `cid`, encoded size).
--   C. emailIngestService.ingestEmail(db, {id, name}, envelope, …) takes a
--      resolved source row: the HTTP route resolves it from the
--      X-Email-Ingest-Key header, the worker resolves it BY NAME. The row is
--      wiring, not data — hence this one deliberate exception to "no seeds":
--      without it every executions row the worker writes has no source to
--      point at, and nothing reaches the log.
--
-- ── THE SOURCE KEY IS UNPRESENTABLE, ON PURPOSE ────────────────────────────
-- email_ingest_sources.api_key is NOT NULL UNIQUE, and authenticate() accepts
-- ANY active row's key over HTTP. A guessable key here would let anyone holding
-- it POST forged envelopes as 'mailbox-imap' and fire court / e-sign rules.
-- The worker never uses the key, so the key is 32 random bytes of hex wrapped
-- as 'inproc:<hex>\n' — the trailing LF is a byte an HTTP header value cannot
-- carry (HTTP/1.1 and HTTP/2 both forbid it), so no request can ever present
-- it, even to someone who reads the row (readonly SQL keys can: this table is
-- not in lib/sqlGuard SECRET_TABLES).
--
-- KILL SWITCH: `UPDATE email_ingest_sources SET active = 0 WHERE name =
-- 'mailbox-imap'` stops ALL emission from the worker on its next tick (mail is
-- still stored; messages stored while off are NOT emitted later). Per-folder
-- control is ingest_folders.<folder>.emit_to_rules in the Mailboxes pane.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- SQL first, then backend (house deploy order). The S1 backend INSERTs into
-- mail_messages without naming ingested_at (DEFAULT fills it), so it would not
-- break without A — but C must exist before the first tick or every folder set
-- to Emit to rules is stored-not-emitted (the worker alerts once a day).
-- Run this while mail_messages is still EMPTY (it is until the first tick):
-- the ALTER is then instant whatever algorithm MySQL picks.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- A: guarded on information_schema (MySQL has no ADD COLUMN IF NOT EXISTS) —
--    each SET/PREPARE/EXECUTE/DEALLOCATE group must run on ONE connection:
--    paste the group as a single block. If the console splits statements, run
--    the plain fallbacks quoted under each group instead (harmless
--    ER_DUP_FIELDNAME / ER_DUP_KEYNAME on a re-run).
-- B/B2: a re-run re-applies the same COMMENTs (comment-only MODIFYs restating
--    the S0 types exactly — no data change, no rebuild).
-- C: INSERT … WHERE NOT EXISTS — a re-run inserts nothing and never rotates
--    the key.
--
-- ── CONVENTIONS ─────────────────────────────────────────────────────────────
-- No FKs, no new charset-bearing columns (ingested_at is a DATETIME). Times
-- are UTC (server time_zone is UTC; the app pool runs timezone 'Z').
--
-- After running: regenerate the schema snapshot via
-- POST /admin/db/schema/save-to-ref (or `npm run db:ref`). ref/database.sql is
-- auto-generated — do not hand-edit it.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Stop the scheduler job first (gcloud scheduler jobs pause mailbox-ingest).
--   ALTER TABLE mail_messages DROP INDEX idx_mail_messages_mailbox_ingested,
--                             DROP COLUMN ingested_at;
--   -- B/B2 are comment-only; leave them (or restore S0's text from
--   -- ref/migrations/2026-10-08_mailbox_s0.sql).
--   -- C only if no execution references it (else keep it, set active = 0):
--   DELETE FROM email_ingest_sources WHERE name = 'mailbox-imap'
--     AND NOT EXISTS (SELECT 1 FROM email_ingest_executions e
--                      WHERE e.source_id = email_ingest_sources.id);
-- mail_messages rows written by S1 are left in place (S0's rollback drops the
-- table).
-- ─────────────────────────────────────────────────────────────────────────────


-- ── A1. mail_messages.ingested_at ────────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'mail_messages'
      AND COLUMN_NAME  = 'ingested_at') > 0,
  'SELECT ''mail_messages.ingested_at already present — skipped'' AS note',
  'ALTER TABLE mail_messages
     ADD COLUMN ingested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     COMMENT ''when the S1 worker stored the row (UTC). The OQ2 2-year pruning axis: `date` is the sender-supplied header and can be absent or lie''
     AFTER log_id');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Fallback if the console splits the group above (errors harmlessly with
-- ER_DUP_FIELDNAME on a re-run):
--   ALTER TABLE mail_messages
--     ADD COLUMN ingested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
--     COMMENT 'when the S1 worker stored the row (UTC). The OQ2 2-year pruning axis: `date` is the sender-supplied header and can be absent or lie'
--     AFTER log_id;


-- ── A2. (mailbox_id, ingested_at) index ──────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'mail_messages'
      AND INDEX_NAME   = 'idx_mail_messages_mailbox_ingested') > 0,
  'SELECT ''idx_mail_messages_mailbox_ingested already present — skipped'' AS note',
  'ALTER TABLE mail_messages
     ADD INDEX idx_mail_messages_mailbox_ingested (mailbox_id, ingested_at)');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Fallback (ER_DUP_KEYNAME on a re-run):
--   ALTER TABLE mail_messages
--     ADD INDEX idx_mail_messages_mailbox_ingested (mailbox_id, ingested_at);


-- ── B. ingest_state COMMENT (metadata only) ──────────────────────────────────
ALTER TABLE mailboxes MODIFY COLUMN ingest_state JSON NULL
  COMMENT 'per-folder CURSOR, written only by the ingest worker (services/mailbox/mailboxIngestService.js): {"<folder>": {uidvalidity, last_uid = new-mail cursor, backfill_uid = backlog still to store below it (absent = done), backfill_emit_after = ISO emit horizon set by a re-key (null = store-only), checked_at, errors, backfill_errors, last_error, last_error_at, rekeyed_at, backfill_done_at}}. First poll baselines at UIDNEXT: existing mail is stored, never emitted. UIDVALIDITY change = re-key, never blanket purge (§4.1). NULL = never ingested';


-- ── B2. mail_messages column COMMENTs — the formats S1 writes (metadata only;
--        each MODIFY restates the S0 type exactly) ─────────────────────────────
ALTER TABLE mail_messages
  MODIFY COLUMN from_addr VARCHAR(255) NULL
    COMMENT 'first From: address in display form - Name <a@b> (name quoted when it has specials) or bare a@b; emails lowercased',
  MODIFY COLUMN to_addrs TEXT NULL
    COMMENT 'To: list, comma-separated display forms (see from_addr); NULL when empty',
  MODIFY COLUMN cc_addrs TEXT NULL
    COMMENT 'Cc: list, comma-separated display forms (see from_addr); NULL when empty',
  MODIFY COLUMN `date` DATETIME NULL
    COMMENT 'Date header, stored UTC (DB pool runs UTC); IMAP INTERNALDATE when the header is missing or outside 1970-2100',
  MODIFY COLUMN attachments JSON NULL
    COMMENT '[{part, filename, size, mime, cid?}] - STRUCTURE ONLY, no bytes (D1); every non-body leaf incl. inline images (cid) and attached messages; size = the server''s ENCODED size. Parts stream on demand via GET /api/mailboxes/:id/messages/:mid/parts/:part, grant-checked';


-- ── C. the worker's ingest source ────────────────────────────────────────────
INSERT INTO email_ingest_sources (name, api_key, active, description)
SELECT 'mailbox-imap',
       CONCAT('inproc:', HEX(RANDOM_BYTES(32)), CHAR(10)),
       1,
       'YC IMAP ingest worker (services/mailbox/mailboxIngestService.js). IN-PROCESS: no HTTP adapter can present this key'
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM email_ingest_sources WHERE name = 'mailbox-imap');


-- VERIFY 1 — ingested_at + index exist. Expect 1 column row (datetime, NO,
-- CURRENT_TIMESTAMP) and 2 index rows (mailbox_id seq 1, ingested_at seq 2):
--   SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
--     FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_messages'
--      AND COLUMN_NAME = 'ingested_at';
--   SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS
--    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_messages'
--      AND INDEX_NAME = 'idx_mail_messages_mailbox_ingested';
--
-- VERIFY 2 — exactly one source row, active, key unpresentable (ends in LF,
-- 7 + 64 + 1 = 72 chars). Expect: mailbox-imap | 1 | 1 | 72:
--   SELECT name, active, RIGHT(api_key, 1) = CHAR(10) AS lf_terminated,
--          CHAR_LENGTH(api_key) AS len
--     FROM email_ingest_sources WHERE name = 'mailbox-imap';
