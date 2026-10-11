-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-11 — Mailbox system S2-L: Gmail labels for the comms hub (design OQ5)
--   A1. mail_messages.gmail_labels  JSON NULL — X-GM-LABELS snapshot at ingest
--   A2. mail_messages.in_inbox      generated VIRTUAL — the hub's ONE "Inbox"
--   A3. idx_mail_messages_mailbox_inbox_date (mailbox_id, in_inbox, date)
--   C.  mail_messages.thread_key COMMENT → the OQ1 rule as built (doc-debt
--       docs/20261009_thread_key_comment; comment only)
--
-- WHY
--   Mailbox 2 (stuart@4lsg.com) polls [Gmail]/All Mail as its only folder
--   (runbook step 3b, 2026-10-11). The S2 hub scoped its default list, unread
--   counts, view counts and mark-all to folder = 'INBOX', so that mailbox's
--   new mail showed under "All folders" only and its sent mail was not told
--   apart. Gmail says where a message sits through its LABELS: the worker now
--   fetches X-GM-LABELS in the same FETCH (services/mailbox/imapTransport.js)
--   and stores them as fetched (mailboxIngestService.buildRow); the hub reads
--   "Inbox" from in_inbox (services/mailbox/mailReadService.js).
--
--   A1. The snapshot as fetched: Gmail system labels keep their leading
--       backslash (the Inbox, Sent, Important ... labels), user labels as
--       named; [] = Gmail says none (archived). NULL = not Gmail, or stored
--       before S2-L (the hub then goes by folder, as before). Ingest never
--       refreshes it; the SU route POST /api/mailboxes/:id/labels/snapshot
--       re-fetches it for stored rows (the backfill; refresh/sync is S4).
--   A2. in_inbox = folder INBOX, OR the snapshot holds the Inbox system label.
--       The folder half is OR'ed in for labelled rows too: Gmail is reported
--       to leave the SELECTED folder's own label out of X-GM-LABELS. VIRTUAL:
--       no storage, computed from the row; the index (A3) materializes it.
--       The backslash of the label is built with CONVERT(CHAR(92) USING
--       utf8mb4), so the stored expression holds no backslash escape (it is
--       re-parsed safely under any sql_mode). MEASURED (MySQL 8.0.46 + 8.4.6):
--       the shorter CHAR(92 USING utf8mb4) is printed back WITHOUT its USING
--       clause, so the stored column CONCATs a BINARY string and matches
--       nothing; CONVERT(...) survives SHOW CREATE TABLE → reload. The
--       _utf8mb4 introducers are belt-and-braces (CONCAT with a utf8mb4 arg
--       coerces a bare literal anyway — measured under a latin1 client).
--       tests/mailboxS2.mysql.test.js pins the edge matrix below.
--       Edge matrix (the engine, both versions):
--         folder INBOX / inbox, labels NULL .......................... 1
--         folder Sent, labels NULL ................................... 0
--         All Mail ["\Inbox","\Important"] / ["\Inbox","\Sent"] ...... 1
--         All Mail ["\Sent"] / [] / ["Clio/Payments"] / NULL ......... 0
--         All Mail ["\INBOX"] / ["Inbox"] (case / no backslash) ...... 0
--         folder INBOX, ["\Important"] (selected-label omission) ..... 1
--   A3. The Inbox-scoped list walks (mailbox_id, in_inbox = 1, date)
--       backwards (FORCE INDEX in mailReadService.listMessages); the summary
--       (the sidebar badge) is a covering range on its prefix. Without it, an
--       All Mail box's Inbox list would walk every archived and sent row too
--       and evaluate the JSON per row. View counts stay cost-based
--       (they join the log row; a scan wins when most rows are Inbox).
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- SQL FIRST, then backend. The S2-L worker INSERTs gmail_labels and the hub
-- SELECTs in_inbox: a backend deployed before this file fails EVERY ingest
-- tick (ER_BAD_FIELD_ERROR) — mailbox 2 stops storing mid parity window —
-- and every hub read. The S1-G/S2 backend is unaffected by these columns (it
-- names its columns), so running this while that backend is live is safe.
-- Nothing in this file changes behaviour by itself.
--
-- ── ALGORITHMS (measured on 8.0.46 + 8.4.6 with the production table) ────────
-- A1 and A2 run INSTANT (metadata only; no rebuild, no row touched); A3 is an
-- INPLACE index build with concurrent DML allowed (LOCK=NONE) — it reads the
-- table once (~hundreds of rows today). C is metadata only. None names an
-- ALGORITHM, so MySQL picks the cheapest it supports; each still takes a
-- brief metadata lock — run between ingest ticks if you can (not required).
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- A1–A3 guarded on information_schema (MySQL has no ADD COLUMN IF NOT EXISTS)
-- — each SET/PREPARE/EXECUTE/DEALLOCATE group must run on ONE connection,
-- i.e. from a mysql client session. The SU DB console CANNOT guarantee that
-- (multipleStatements off; /admin/db/batch sends each statement through the
-- pool separately, so @sql may not survive to PREPARE): from the console run
-- the plain fallback quoted under each group, in order (none of the three
-- objects exists live as of 2026-10-11; a re-run fails harmlessly with
-- ER_DUP_FIELDNAME / ER_DUP_KEYNAME). C restates thread_key's current type
-- exactly — a re-run re-applies the same COMMENT.
--
-- ── CONVENTIONS ─────────────────────────────────────────────────────────────
-- No FKs, no seeds, no data. ref/database.sql is auto-generated (pre-commit
-- hook / POST /admin/db/schema/save-to-ref) — do not hand-edit it.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Roll the backend back first (it would otherwise fail every tick), then:
--   ALTER TABLE mail_messages DROP INDEX idx_mail_messages_mailbox_inbox_date;
--   ALTER TABLE mail_messages DROP COLUMN in_inbox;
--   ALTER TABLE mail_messages DROP COLUMN gmail_labels;
-- (drop order matters: in_inbox depends on gmail_labels.) C is comment-only;
-- leave it.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── A1. mail_messages.gmail_labels ───────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'mail_messages'
      AND COLUMN_NAME  = 'gmail_labels') > 0,
  'SELECT ''mail_messages.gmail_labels already present — skipped'' AS note',
  'ALTER TABLE mail_messages
     ADD COLUMN gmail_labels JSON NULL
     COMMENT ''Gmail labels at ingest (S2-L): the X-GM-LABELS list fetched with the message - system labels keep their leading backslash (Inbox, Sent, Important...), user labels as named; [] = none (archived). NULL = not Gmail (no X-GM-EXT-1) or stored before S2-L. A SNAPSHOT: archiving/relabelling in Gmail later is not seen until POST /api/mailboxes/:id/labels/snapshot re-fetches it (sync is S4). Never read by ingest or emission; the hub reads it through in_inbox''
     AFTER provider_id');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Fallback (ER_DUP_FIELDNAME on a re-run):
--   ALTER TABLE mail_messages
--     ADD COLUMN gmail_labels JSON NULL
--     COMMENT 'Gmail labels at ingest (S2-L): the X-GM-LABELS list fetched with the message - system labels keep their leading backslash (Inbox, Sent, Important...), user labels as named; [] = none (archived). NULL = not Gmail (no X-GM-EXT-1) or stored before S2-L. A SNAPSHOT: archiving/relabelling in Gmail later is not seen until POST /api/mailboxes/:id/labels/snapshot re-fetches it (sync is S4). Never read by ingest or emission; the hub reads it through in_inbox'
--     AFTER provider_id;


-- ── A2. mail_messages.in_inbox (generated, VIRTUAL) ──────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'mail_messages'
      AND COLUMN_NAME  = 'in_inbox') > 0,
  'SELECT ''mail_messages.in_inbox already present — skipped'' AS note',
  'ALTER TABLE mail_messages
     ADD COLUMN in_inbox TINYINT(1) UNSIGNED GENERATED ALWAYS AS (
       (folder = _utf8mb4''INBOX'')
       OR COALESCE(CONCAT(CONVERT(CHAR(92) USING utf8mb4), _utf8mb4''Inbox'') MEMBER OF (gmail_labels), 0)
     ) VIRTUAL NOT NULL
     COMMENT ''GENERATED (S2-L): 1 = in the Inbox for the comms hub - folder INBOX, OR the gmail_labels snapshot holds the Inbox system label (backslash + Inbox; CHAR(92) keeps the DDL free of escapes). The ONE definition of Inbox for the hub list, unread and view counts and mark-all (services/mailbox/mailReadService.js); indexed with mailbox_id + date''
     AFTER gmail_labels');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Fallback (ER_DUP_FIELDNAME on a re-run):
--   ALTER TABLE mail_messages
--     ADD COLUMN in_inbox TINYINT(1) UNSIGNED GENERATED ALWAYS AS (
--       (folder = _utf8mb4'INBOX')
--       OR COALESCE(CONCAT(CONVERT(CHAR(92) USING utf8mb4), _utf8mb4'Inbox') MEMBER OF (gmail_labels), 0)
--     ) VIRTUAL NOT NULL
--     COMMENT 'GENERATED (S2-L): 1 = in the Inbox for the comms hub - folder INBOX, OR the gmail_labels snapshot holds the Inbox system label (backslash + Inbox; CHAR(92) keeps the DDL free of escapes). The ONE definition of Inbox for the hub list, unread and view counts and mark-all (services/mailbox/mailReadService.js); indexed with mailbox_id + date'
--     AFTER gmail_labels;


-- ── A3. (mailbox_id, in_inbox, date) index ───────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'mail_messages'
      AND INDEX_NAME   = 'idx_mail_messages_mailbox_inbox_date') > 0,
  'SELECT ''idx_mail_messages_mailbox_inbox_date already present — skipped'' AS note',
  'ALTER TABLE mail_messages
     ADD INDEX idx_mail_messages_mailbox_inbox_date (mailbox_id, in_inbox, `date`)');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Fallback (ER_DUP_KEYNAME on a re-run):
--   ALTER TABLE mail_messages
--     ADD INDEX idx_mail_messages_mailbox_inbox_date (mailbox_id, in_inbox, `date`);


-- ── C. thread_key COMMENT (comment only — restates the current type) ─────────
ALTER TABLE mail_messages
  MODIFY COLUMN thread_key VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL
    COMMENT 'thread root, written by the worker: the first References id, else In-Reply-To, else the message''s own Message-ID (brackets stripped) - the whole rule (OQ1, answered in S2: no subject/participants fallback). The hub groups a thread by it across every readable mailbox';


-- VERIFY — expect gmail_labels json/YES, in_inbox tinyint unsigned/NO/VIRTUAL
-- GENERATED, the index on (mailbox_id, in_inbox, date), and every existing
-- row's in_inbox = (folder = 'INBOX') (no row has labels yet):
--   SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, EXTRA
--     FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_messages'
--      AND COLUMN_NAME IN ('gmail_labels', 'in_inbox', 'thread_key');
--   SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS
--    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_messages'
--      AND INDEX_NAME = 'idx_mail_messages_mailbox_inbox_date' ORDER BY SEQ_IN_INDEX;
--   SELECT mailbox_id, folder, in_inbox, COUNT(*) AS n FROM mail_messages
--    GROUP BY mailbox_id, folder, in_inbox ORDER BY mailbox_id, folder;
