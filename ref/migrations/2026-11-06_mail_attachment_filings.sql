-- ref/migrations/2026-11-06_mail_attachment_filings.sql
--
-- Email attachments → Dropbox, slice S1 (ref/EMAIL_ATTACHMENTS_DESIGN.md §4).
-- One row per (stored message, IMAP body part) that the filing service has
-- put — or is putting — into Dropbox. Three jobs:
--   1. IDEMPOTENCY: UNIQUE(mail_message_id, part) is the claim. A retried
--      workflow step, a duplicate job, or a second rule never files the same
--      attachment twice (no "statement (1).pdf").
--   2. AUDIT: where each attachment went, how the case was chosen, by whom.
--   3. REFILE: email_attachments_refile moves the filed parts of a message by
--      their Dropbox id (survives staff renames/moves) and rewrites the row.
--
-- No FK to mail_messages on purpose: a UIDVALIDITY orphan purge or a future
-- prune deletes mail_messages rows, and the record of where a client's file
-- went must outlive the mail copy of it. ids are never reused (AUTO_INCREMENT).
--
-- Run ONCE, before the backend deploy (SQL → backend → frontend). SU DB
-- console is fine (one statement, no session setting). Idempotent: IF NOT
-- EXISTS. After it runs, the next commit's hook regenerates ref/database.sql;
-- then add ['mail_attachment_filings', 'dropbox_id'] to
-- tests/schemaCollationBin.test.js BIN_COLUMNS (it lints the dump, which has
-- no such column until then).

CREATE TABLE IF NOT EXISTS mail_attachment_filings (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  mail_message_id BIGINT UNSIGNED NOT NULL COMMENT 'mail_messages.id (no FK on purpose: the filing record outlives a purged or pruned mail copy)',
  part            VARCHAR(64)     NOT NULL COMMENT 'IMAP body part id, as mail_messages.attachments[].part (e.g. 2, 1.2)',
  status          VARCHAR(12)     NOT NULL DEFAULT 'filing' COMMENT 'filing = claimed, upload in flight (a claim older than 15 min is stale and may be re-claimed); filed = in Dropbox. App-validated (sql_mode is not strict)',
  claimed_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'UTC. When the current claim was taken; the stale-claim clock',
  filename        VARCHAR(255)    NOT NULL DEFAULT '' COMMENT 'name as the mail carried it (before sanitizing); the filed name is the last segment of dropbox_path',
  size            BIGINT UNSIGNED DEFAULT NULL COMMENT 'bytes actually filed (decoded); NULL while filing',
  link_type       VARCHAR(12)     DEFAULT NULL COMMENT 'case | contact | NULL (unknown sender, unsorted) — what the file was registered to',
  link_id         VARCHAR(20)     DEFAULT NULL COMMENT 'cases.case_id or contacts.contact_id per link_type',
  placement       VARCHAR(12)     DEFAULT NULL COMMENT 'case = under the case folder; unsorted = in the unsorted client-uploads bin',
  match_method    VARCHAR(40)     DEFAULT NULL COMMENT 'how the case was chosen: case_id_in_subject | case_id_in_body | sender_open_case | sender_retained_case | explicit | refiled | none (emailCaseMatchService)',
  dropbox_path    TEXT            COMMENT 'path_display Dropbox returned (post-autorename truth); may go stale when staff move the file — dropbox_id does not',
  dropbox_id      VARCHAR(64)     CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'utf8mb4_bin ON PURPOSE — Dropbox ids are case-sensitive (id:...). The refile handle; never normalize this collation',
  document_id     BIGINT UNSIGNED DEFAULT NULL COMMENT 'documents.id from write-time registration; NULL when registration failed (the sync picks the file up later)',
  filed_by        INT             DEFAULT NULL COMMENT 'users.user who caused it; NULL = automation',
  filed_at        DATETIME        DEFAULT NULL COMMENT 'UTC. When the upload landed',
  refiled_at      DATETIME        DEFAULT NULL COMMENT 'UTC. Last email_attachments_refile move',
  PRIMARY KEY (id),
  UNIQUE KEY uq_mail_attachment_part (mail_message_id, part),
  KEY idx_mail_attachment_link (link_type, link_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Email attachments filed to Dropbox (ref/EMAIL_ATTACHMENTS_DESIGN.md): the per-part idempotency claim, the audit of where each went, and the refile handle';
