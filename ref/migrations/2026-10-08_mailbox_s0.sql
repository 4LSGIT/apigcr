-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-08 — Mailbox system S0: schema (mailboxes, channel_grants,
-- mail_messages, mail_read_state, inbox_views)
--
-- WHY
--   Foundation of the comms hub: YisraCase-native mailboxes with many-to-many
--   access. A mailbox row is provider-blind connection data (IMAP host/user/
--   secret + an optional send credential); `channel_grants` is the access
--   model, channel-general from day one per D6 ('mailbox' now, 'phone_line'
--   later against phone_lines rows, same table, no ALTER); `mail_messages` is
--   the tier-1 mailbox store (S1 ingest fills it); `mail_read_state` is
--   per-user read state (IMAP \Seen is per-mailbox, so it cannot say "has
--   Fred read this"); `inbox_views` are per-user saved mixed-inbox views (S2
--   reads them). Spec: ref/MAILBOX_SYSTEM_DESIGN.md §3 (schema), D1–D6
--   (decisions), §4.1 (ingest + UIDVALIDITY re-key), §5 (slices).
--   Code: services/mailboxService.js, routes/api.mailboxes.js,
--   public/mailboxAdmin.html.
--
-- ── NO SEEDS, BY DESIGN ─────────────────────────────────────────────────────
-- Mailboxes and grants are created in the Admin → Mailboxes pane by an SU.
-- Running this migration changes ZERO behavior: nothing reads mail_messages,
-- mail_read_state or inbox_views yet (S1/S2), and empty mailboxes /
-- channel_grants tables mean the S0 API lists nothing and grants nothing.
-- S0 is inert until rows exist.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- SQL first, then backend, then frontend (house deploy order). The S0 backend
-- (routes/api.mailboxes.js) queries mailboxes / channel_grants — deploying it
-- before this file would 500 every mailbox route (ER_NO_SUCH_TABLE). The pane
-- only calls those routes.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS only. Safe to re-run. No session variables.
--
-- ── CONVENTIONS ─────────────────────────────────────────────────────────────
-- Explicit DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci on every table
-- (the MySQL-8 0900_ai_ci landmine — ref/SCHEMA_CONVENTIONS.md). No FK
-- constraints: the design's "FK" notes are FK-by-convention, stated in column
-- COMMENTs. sql_mode is non-strict, so every length / shape / vocabulary rule
-- is enforced in JS with 400s — in particular channel_grants.channel_type is
-- VARCHAR(16), app-validated, never ENUM (a new channel needs no ALTER).
--
-- Type matches (verified live 2026-10-08):
--   users.user            signed tinyint   → every user / granted_by column is TINYINT
--   email_credentials.id  int unsigned     → mailboxes.send_credential_id INT UNSIGNED
--                                            (design §3 sketched "INT"; matched to the target)
--   phone_lines.id        tinyint unsigned → fits channel_grants.channel_id INT UNSIGNED
--   log.log_id            signed int       → mail_messages.log_id INT
--   mail_messages.id      BIGINT UNSIGNED  → mail_read_state.message_fk BIGINT UNSIGNED
-- None of the five table names existed before this file (SHOW TABLES LIKE
-- 'mail%' / 'mailboxes' / 'channel_grants' / 'inbox_views' all empty).
--
-- Two indexes beyond the design sketch, both for paths the design names:
--   channel_grants  KEY (channel_type, channel_id) — "who holds grants on this
--                   mailbox" (grant editor, grant counts); the UNIQUE leads with
--                   `user`, so it cannot serve that lookup.
--   mail_read_state KEY (message_fk) — §4.1 orphan purge and the OQ2 pruning
--                   delete read-state BY MESSAGE; the PK leads with `user`.
--   inbox_views     KEY (user, sort_order) — every read is "this user's views".
--
-- After running: regenerate the schema snapshot via
-- POST /admin/db/schema/save-to-ref (or `npm run db:ref`). ref/database.sql is
-- auto-generated — do not hand-edit it. The COMMENTs below flow into it.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Safe only while S0 is the newest slice (S1+ writes mail_messages).
--   DROP TABLE IF EXISTS inbox_views, mail_read_state, mail_messages,
--                        channel_grants, mailboxes;
-- ─────────────────────────────────────────────────────────────────────────────


-- ── A. mailboxes ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mailboxes (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  address            VARCHAR(255) NOT NULL
                     COMMENT 'mailbox email address, lowercased at write; unique (general_ci = case-insensitive)',
  domain             VARCHAR(128) NOT NULL
                     COMMENT 'derived from address at write (part after @) by mailboxService; never client-supplied',
  display_name       VARCHAR(128) NULL,
  imap_host          VARCHAR(255) NOT NULL
                     COMMENT 'row data, never a code constant (D2); changing host/port requires re-entering imap_secret in the same write (credential-redirect guard)',
  imap_port          INT NOT NULL DEFAULT 993,
  imap_user          VARCHAR(255) NOT NULL,
  imap_secret        TEXT NULL
                     COMMENT 'ENCv1 ciphertext via lib/credentialCrypto (same pattern as email_credentials.smtp_pass); identity creds or mailbox password per D3 - transport-agnostic. WRITE-ONLY: no API response carries it in any shape (has_secret boolean instead). NULL = not set',
  send_credential_id INT UNSIGNED NULL
                     COMMENT 'email_credentials.id (FK by convention); NULL = read-only mailbox. Grant checks for sending live on interactive routes only, never in emailService (D6)',
  ingest_enabled     TINYINT(1) NOT NULL DEFAULT 1,
  ingest_folders     JSON NULL
                     COMMENT 'per-folder CONFIG: {"<folder>": {"emit_to_rules": bool}} - which folders the S1 worker polls, and which emit into the rules pipeline (§4.1). Everything polled is stored to mail_messages regardless. mailboxService always writes it; v1 default {"INBOX":{"emit_to_rules":true}} (Sent is opt-in, emit_to_rules false - host Sent names vary)',
  ingest_state       JSON NULL
                     COMMENT 'per-folder CURSOR {"<folder>": {"uidvalidity": n, "last_uid": n}}; written only by the S1 ingest worker; NULL = never ingested. UIDVALIDITY change = re-key, never blanket purge (§4.1)',
  active             TINYINT(1) NOT NULL DEFAULT 1
                     COMMENT 'no hard delete - mail_messages rows reference mailboxes forever; 0 = deactivated',
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mailboxes_address (address)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='YC-native mailboxes (ref/MAILBOX_SYSTEM_DESIGN.md). Provider-blind connection rows; access via channel_grants(channel_type=mailbox)';

-- ── B. channel_grants ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_grants (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user               TINYINT NOT NULL
                     COMMENT 'users.user (FK by convention); never 0 - automation bypasses grants (D6)',
  channel_type       VARCHAR(16) NOT NULL
                     COMMENT 'mailbox | phone_line - app-validated vocabulary, VARCHAR not ENUM so a new channel needs no ALTER',
  channel_id         INT UNSIGNED NOT NULL
                     COMMENT 'mailboxes.id when mailbox; phone_lines.id when phone_line (FK by convention)',
  can_read           TINYINT(1) NOT NULL DEFAULT 0,
  can_send           TINYINT(1) NOT NULL DEFAULT 0,
  can_manage         TINYINT(1) NOT NULL DEFAULT 0
                     COMMENT 'grant others on this channel + edit its non-connection settings; never implies read/send',
  granted_by         TINYINT NOT NULL
                     COMMENT 'users.user who created the row; history of later flag edits lives in admin_audit_log (tool=mailboxes)',
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_channel_grants_user_channel (user, channel_type, channel_id),
  KEY idx_channel_grants_channel (channel_type, channel_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Channel access grants (D6). Enforced on INTERACTIVE routes only - never inside emailService/phoneService, so automation sends bypass. SU short-circuits in mailboxService. phone_line rows arrive with slice S-PH (no unenforced phone rows before then)';

-- ── C. mail_messages ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mail_messages (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  mailbox_id         INT UNSIGNED NOT NULL
                     COMMENT 'mailboxes.id (FK by convention)',
  folder             VARCHAR(128) NOT NULL,
  uid                INT UNSIGNED NULL
                     COMMENT 'IMAP UID within (mailbox, folder, UIDVALIDITY). NULLABLE on purpose: UIDVALIDITY re-key parks rows at NULL, then sets finals (§4.1) - UNIQUE allows many NULLs. Never make NOT NULL',
  message_id         VARCHAR(512) NULL
                     COMMENT 'Message-ID header; secondary dedupe key and the re-key match key',
  in_reply_to        VARCHAR(512) NULL,
  thread_key         VARCHAR(512) NULL
                     COMMENT 'from References/In-Reply-To; subject+participants fallback (OQ1)',
  from_addr          VARCHAR(255) NULL,
  to_addrs           TEXT NULL,
  cc_addrs           TEXT NULL,
  subject            TEXT NULL,
  `date`             DATETIME NULL
                     COMMENT 'Date header, stored UTC (DB pool runs UTC)',
  snippet            VARCHAR(512) NULL,
  body_text          MEDIUMTEXT NULL
                     COMMENT 'inline per D1',
  body_html          MEDIUMTEXT NULL
                     COMMENT 'inline per D1; untrusted mail HTML - sanitize/sandbox at render (S2)',
  attachments        JSON NULL
                     COMMENT '[{part, filename, size, mime}] - STRUCTURE ONLY, no bytes (D1); parts stream on demand from IMAP, grant-checked',
  raw_ref            VARCHAR(512) NULL
                     COMMENT 'reserved for the GCS archival slice (S6): raw .eml pointer. NULL in v1',
  gcs_ref            VARCHAR(512) NULL
                     COMMENT 'reserved for the GCS archival slice (S6): attachments pointer. NULL in v1',
  size               INT UNSIGNED NULL,
  flags              SET('seen','answered','flagged','draft') NOT NULL DEFAULT ''
                     COMMENT 'SERVER flags (mailbox-level), mirrored read-mostly. Per-user read state lives in mail_read_state, NOT here; v1 never writes \\Seen back (§4.3)',
  log_id             INT NULL
                     COMMENT 'log.log_id bridge to the curated log tier / case linking (FK by convention); NULL = not emitted or not logged',
  UNIQUE KEY uq_mail_messages_folder_uid (mailbox_id, folder, uid),
  KEY idx_mail_messages_mailbox_date (mailbox_id, `date`),
  KEY idx_mail_messages_message_id (message_id(191)),
  KEY idx_mail_messages_thread_key (thread_key(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Tier-1 mailbox store (D1): every message in every ingested folder, grant-controlled. 2-year full-body mirror window (OQ2); the provider + future GCS archive are the long-term record; pruning lands by S4';

-- ── D. mail_read_state ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mail_read_state (
  user               TINYINT NOT NULL
                     COMMENT 'users.user (FK by convention)',
  message_fk         BIGINT UNSIGNED NOT NULL
                     COMMENT 'mail_messages.id (FK by convention); delete with the message on prune / orphan purge',
  read_at            DATETIME NOT NULL,
  PRIMARY KEY (user, message_fk),
  KEY idx_mail_read_state_message (message_fk)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='PER-USER read state (§4.3): IMAP \\Seen is per-mailbox and cannot represent many users. Row present = read';

-- ── E. inbox_views ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inbox_views (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user               TINYINT NOT NULL
                     COMMENT 'users.user (FK by convention)',
  name               VARCHAR(64) NOT NULL,
  mailbox_ids        JSON NULL
                     COMMENT '[mailboxes.id, ...]. A view never grants access: every id is re-checked against channel_grants at read time (S2)',
  filters            JSON NULL
                     COMMENT 'unread-only, has-case, from-domain, etc. - vocabulary defined by S2',
  is_default         TINYINT(1) NOT NULL DEFAULT 0,
  sort_order         INT NOT NULL DEFAULT 0,
  KEY idx_inbox_views_user (user, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Per-user saved mixed-inbox views (S2). Created in S0, read by nothing until S2';


-- VERIFY 1 — all five tables exist on the house collation. Expect 5 rows,
-- all utf8mb4_general_ci:
--   SELECT TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES
--    WHERE TABLE_SCHEMA = DATABASE()
--      AND TABLE_NAME IN ('mailboxes','channel_grants','mail_messages',
--                         'mail_read_state','inbox_views');
--
-- VERIFY 2 — BLOCKING. User columns match users.user (signed tinyint), and
-- mail_messages.uid is nullable. Expect every user/granted_by row = tinyint,
-- and uid IS_NULLABLE = YES:
--   SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
--     FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE()
--      AND ((TABLE_NAME = 'users' AND COLUMN_NAME = 'user')
--        OR (COLUMN_NAME IN ('user','granted_by')
--            AND TABLE_NAME IN ('channel_grants','mail_read_state','inbox_views'))
--        OR (TABLE_NAME = 'mail_messages' AND COLUMN_NAME = 'uid'));
--
-- VERIFY 3 — no seeds. Expect all zeros:
--   SELECT (SELECT COUNT(*) FROM mailboxes) mb, (SELECT COUNT(*) FROM channel_grants) g,
--          (SELECT COUNT(*) FROM mail_messages) m, (SELECT COUNT(*) FROM mail_read_state) r,
--          (SELECT COUNT(*) FROM inbox_views) v;
