-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-09 — Mailbox system S1-G: Gmail second pilot + cross-source dedupe
--   A. mail_messages.provider_id + (mailbox_id, provider_id) index
--   B. mailboxes.emit_source_name + mailboxes.emit_id_kind (emission override)
--   C. COMMENTs → the shapes S1-G writes (ingest_folders.backfill, the new
--      ingest_state keys, message_id's narrowed role)
--
-- WHY
--   email_log dedupes on UNIQUE(source, message_id) — PER SOURCE ONLY
--   (AI_CONTEXT §27). The Apps Script `gmail-firm` source has always posted
--   Gmail's INTERNAL id (hex), while the S1 worker emits RFC Message-IDs under
--   `mailbox-imap`; one email reaching both would log twice and fire Layer 3
--   (court rules 8–10/12/15/16/22, e-sign) twice. Ruling Q1a: the Gmail
--   mailbox emits under `gmail-firm` keyed by hex(X-GM-MSGID) — Google
--   documents X-GM-MSGID as the decimal of the id the web UI / Gmail API (and
--   so GmailMessage.getId()) use — so the two feeders collide into ONE log
--   row and can run in parallel through the parity window. The equality is
--   VERIFIED LIVE before anything emits (ref/MAILBOX_GMAIL_PARITY.md, gate).
--   Code: services/mailbox/imapTransport.js (capture),
--   services/mailbox/mailboxIngestService.js (emission identity + guards),
--   services/mailboxService.js (PATCH validation), routes/api.mailboxes.js
--   (GET …/folders, GET …/messages/:mid/emit-preview).
--
--   A. provider_id is the provider-native message id: Gmail = lowercase hex
--      X-GM-MSGID (16 chars today; 64 leaves room); NULL on hosts without one
--      (SiteGround/Dovecot — zero behaviour change there). The index serves
--      the provider-keyed secondary dedupe and the parity joins
--      (mail_messages.provider_id = email_log.message_id — both general_ci, so
--      no COLLATE clause is needed).
--   B. Two nullable columns, app-validated (sql_mode is non-strict): NULL/NULL
--      = the S1 default (mailbox-imap + RFC Message-ID). Set ONLY by the SU
--      PATCH route, only as a pair, only to an ACTIVE email_ingest_sources row;
--      'provider' never under mailbox-imap; one provider-keyed mailbox per
--      source. A row edited outside the route into a bad pair emits nothing.
--   C. COMMENTs are the documentation of record (they flow into
--      ref/database.sql).
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- SQL FIRST, then backend. The S1-G worker SELECTs emit_source_name /
-- emit_id_kind and INSERTs provider_id: a backend deployed before this file
-- fails every ingest tick (ER_BAD_FIELD_ERROR) until it runs. The S1 backend
-- is unaffected by these columns (it names its columns), so running this
-- while S1 is live is safe. Nothing in this file changes behaviour by itself.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- A/B guarded on information_schema (MySQL has no ADD COLUMN IF NOT EXISTS) —
-- each SET/PREPARE/EXECUTE/DEALLOCATE group must run on ONE connection, i.e.
-- from a mysql client session. The SU DB console CANNOT guarantee that: its
-- pool runs with multipleStatements off and /admin/db/batch sends each
-- statement through the pool separately, so @sql may not survive to PREPARE.
-- From the console, run the plain fallback quoted under each group instead
-- (verified 2026-10-09: none of the three columns exists live, so they
-- succeed; a re-run fails harmlessly with ER_DUP_FIELDNAME / ER_DUP_KEYNAME).
-- C: comment-only MODIFYs restating the current types exactly — a re-run
-- re-applies the same COMMENTs; no data change, no rebuild.
--
-- ── CONVENTIONS ─────────────────────────────────────────────────────────────
-- No FKs, no seeds, no data. New VARCHARs inherit the tables' utf8mb4_general_ci
-- (both tables declare it explicitly — ref/SCHEMA_CONVENTIONS.md).
--
-- After running: regenerate the schema snapshot via
-- POST /admin/db/schema/save-to-ref (or `npm run db:ref`). ref/database.sql is
-- auto-generated — do not hand-edit it.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Roll the backend back to S1 first (it would otherwise fail every tick).
-- Only while no mailbox carries an override (SELECT id FROM mailboxes WHERE
-- emit_source_name IS NOT NULL → expect none):
--   ALTER TABLE mailboxes DROP COLUMN emit_id_kind, DROP COLUMN emit_source_name;
--   ALTER TABLE mail_messages DROP INDEX idx_mail_messages_mailbox_provider,
--                             DROP COLUMN provider_id;
-- C is comment-only; leave it (or restore S1's text from
-- ref/migrations/2026-10-08_mailbox_s1.sql / ref/database.sql history).
-- ─────────────────────────────────────────────────────────────────────────────


-- ── A1. mail_messages.provider_id ────────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'mail_messages'
      AND COLUMN_NAME  = 'provider_id') > 0,
  'SELECT ''mail_messages.provider_id already present — skipped'' AS note',
  'ALTER TABLE mail_messages
     ADD COLUMN provider_id VARCHAR(64) NULL
     COMMENT ''provider-native message id: Gmail = lowercase hex X-GM-MSGID (the id Gmail web/API/Apps Script use, = gmail-firm email_log.message_id); NULL for hosts without one. Identity for secondary dedupe + re-key where present; the emit key when mailboxes.emit_id_kind = provider (S1-G)''
     AFTER message_id');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Fallback (ER_DUP_FIELDNAME on a re-run):
--   ALTER TABLE mail_messages
--     ADD COLUMN provider_id VARCHAR(64) NULL
--     COMMENT 'provider-native message id: Gmail = lowercase hex X-GM-MSGID (the id Gmail web/API/Apps Script use, = gmail-firm email_log.message_id); NULL for hosts without one. Identity for secondary dedupe + re-key where present; the emit key when mailboxes.emit_id_kind = provider (S1-G)'
--     AFTER message_id;


-- ── A2. (mailbox_id, provider_id) index ──────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'mail_messages'
      AND INDEX_NAME   = 'idx_mail_messages_mailbox_provider') > 0,
  'SELECT ''idx_mail_messages_mailbox_provider already present — skipped'' AS note',
  'ALTER TABLE mail_messages
     ADD INDEX idx_mail_messages_mailbox_provider (mailbox_id, provider_id)');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Fallback (ER_DUP_KEYNAME on a re-run):
--   ALTER TABLE mail_messages
--     ADD INDEX idx_mail_messages_mailbox_provider (mailbox_id, provider_id);


-- ── B1. mailboxes.emit_source_name ───────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'mailboxes'
      AND COLUMN_NAME  = 'emit_source_name') > 0,
  'SELECT ''mailboxes.emit_source_name already present — skipped'' AS note',
  'ALTER TABLE mailboxes
     ADD COLUMN emit_source_name VARCHAR(64) NULL
     COMMENT ''emission override (S1-G): email_ingest_sources.name the worker emits this mailbox under. NULL (with emit_id_kind NULL) = mailbox-imap. SU PATCH only, set as a pair, must be an ACTIVE source row; decides the email_log dedupe space — see services/mailbox/mailboxIngestService.js EMISSION IDENTITY''
     AFTER ingest_state');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Fallback (ER_DUP_FIELDNAME on a re-run):
--   ALTER TABLE mailboxes
--     ADD COLUMN emit_source_name VARCHAR(64) NULL
--     COMMENT 'emission override (S1-G): email_ingest_sources.name the worker emits this mailbox under. NULL (with emit_id_kind NULL) = mailbox-imap. SU PATCH only, set as a pair, must be an ACTIVE source row; decides the email_log dedupe space — see services/mailbox/mailboxIngestService.js EMISSION IDENTITY'
--     AFTER ingest_state;


-- ── B2. mailboxes.emit_id_kind ───────────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'mailboxes'
      AND COLUMN_NAME  = 'emit_id_kind') > 0,
  'SELECT ''mailboxes.emit_id_kind already present — skipped'' AS note',
  'ALTER TABLE mailboxes
     ADD COLUMN emit_id_kind VARCHAR(12) NULL
     COMMENT ''emission override (S1-G): rfc | provider (app-validated). The (source, message_id) key: rfc = RFC Message-ID, provider = mail_messages.provider_id. A provider mailbox NEVER falls back to the RFC id - a message without provider_id is stored, counted, alerted, never emitted. provider never under mailbox-imap; one provider mailbox per source''
     AFTER emit_source_name');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Fallback (ER_DUP_FIELDNAME on a re-run):
--   ALTER TABLE mailboxes
--     ADD COLUMN emit_id_kind VARCHAR(12) NULL
--     COMMENT 'emission override (S1-G): rfc | provider (app-validated). The (source, message_id) key: rfc = RFC Message-ID, provider = mail_messages.provider_id. A provider mailbox NEVER falls back to the RFC id - a message without provider_id is stored, counted, alerted, never emitted. provider never under mailbox-imap; one provider mailbox per source'
--     AFTER emit_source_name;


-- ── C. COMMENTs (metadata only; each MODIFY restates the current type) ──────
ALTER TABLE mailboxes
  MODIFY COLUMN ingest_folders JSON NULL
    COMMENT 'per-folder CONFIG: {"<folder>": {"emit_to_rules": bool, "backfill"?: false}} - which folders the worker polls, which emit into the rules pipeline (§4.1), and (S1-G) backfill:false = store only mail arriving after first sight (no history; decided at first sight; a later re-key stores only above the highest re-mapped UID). Everything polled is stored to mail_messages regardless. mailboxService always writes it (backfill only when false); v1 default {"INBOX":{"emit_to_rules":true}} (Sent is opt-in, emit_to_rules false - host Sent names vary; never Gmail All Mail)',
  MODIFY COLUMN ingest_state JSON NULL
    COMMENT 'per-folder CURSOR, written only by the ingest worker (services/mailbox/mailboxIngestService.js): {"<folder>": {uidvalidity, last_uid = new-mail cursor, backfill_uid = backlog still to store below it (absent = done), backfill_floor_uid = re-key of a backfill:false folder stores only above this, backfill_emit_after = ISO emit horizon set by a re-key (null = store-only), backfill_skipped_below / backfill_skipped_at = backfill:false baseline, checked_at, errors, backfill_errors, last_error, last_error_at, rekeyed_at, backfill_done_at, no_provider_id_total / last_no_provider_id_at / last_no_provider_id_uid = provider-keyed mail stored but not emitted}}. First poll baselines at UIDNEXT: existing mail is stored (or skipped), never emitted. UIDVALIDITY change = re-key, never blanket purge (§4.1). NULL = never ingested';

ALTER TABLE mail_messages
  MODIFY COLUMN message_id VARCHAR(512) NULL
    COMMENT 'Message-ID header (brackets stripped). Secondary dedupe + re-key match key for rows WITHOUT provider_id; the emit key under the default emission (mailbox-imap)';


-- VERIFY 1 — the three columns. Expect provider_id varchar(64) YES, emit_source_name
-- varchar(64) YES, emit_id_kind varchar(12) YES, all utf8mb4_general_ci:
--   SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLLATION_NAME
--     FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE()
--      AND ((TABLE_NAME = 'mail_messages' AND COLUMN_NAME = 'provider_id')
--        OR (TABLE_NAME = 'mailboxes' AND COLUMN_NAME IN ('emit_source_name', 'emit_id_kind')))
--    ORDER BY TABLE_NAME, COLUMN_NAME;
--
-- VERIFY 2 — the index: 2 rows (mailbox_id seq 1, provider_id seq 2):
--   SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS
--    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_messages'
--      AND INDEX_NAME = 'idx_mail_messages_mailbox_provider';
--
-- VERIFY 3 — nothing changed behaviour: every mailbox on the default, every
-- existing row without a provider id. Expect 0 and 0:
--   SELECT (SELECT COUNT(*) FROM mailboxes WHERE emit_source_name IS NOT NULL OR emit_id_kind IS NOT NULL) AS overrides,
--          (SELECT COUNT(*) FROM mail_messages WHERE provider_id IS NOT NULL) AS provider_rows;
-- ─────────────────────────────────────────────────────────────────────────────
