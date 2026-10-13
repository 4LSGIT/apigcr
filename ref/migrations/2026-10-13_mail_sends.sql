-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-13 — Comms slice S2P: mail_sends — who sent what through the hub
--   A. CREATE TABLE mail_sends: one row per successful comms-hub send
--      (mailboxSendService.sendFromMailbox writes it post-dispatch,
--      best-effort). It answers design OQ4 (shared-box send attribution:
--      "Sent by Rena via YisraCase") and carries the composer Case field's
--      link state (case_link_state / case_log_id — the 'mail_sent_case_link'
--      job updates them).
--   B. BACKFILL the 10 pre-S2P hub sends from admin_audit_log (tool
--      'mail_send', status 'sent') + email_log. Verified live 2026-10-13:
--      exactly 10 rows, every one unambiguous — user_id 6 on all, details
--      carry mailbox_id / email_log_id / provider_message_id, and
--      email_log.message_id holds the Gmail hex id for outbound-gmail rows
--      and the bracketed RFC id for outbound-smtp rows.
--
-- WHY
--   ref/MAILBOX_SYSTEM_DESIGN.md §7 OQ4 (ANSWERED with S2P) + §4.2. A shared
--   box's thread shows WHO replied; the hub's Case field needs a place to
--   remember "link the sent copy to case X" across the ingest delay.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- SQL FIRST (house order): the S2P backend INSERTs into mail_sends on every
-- hub send and reads it on every thread open — without this table those are
-- write warnings and read 500s respectively.
--
-- ── SHAPE NOTES ─────────────────────────────────────────────────────────────
--   user         signed TINYINT — users.user's exact type (FK by convention).
--   message_id   the RFC Message-ID, brackets stripped, exactly as
--                mail_messages.message_id stores it (varchar(512), prefix key).
--   provider_id  Gmail's hex id (lowercase), as mail_messages.provider_id.
--   case_link_state  NULL = no case asked at send; 'pending' = the
--                'mail_sent_case_link' job will link the stored copy;
--                'linked' = done (case_log_id set); 'failed' = the job gave
--                up (an error alert was raised).
--   KEY (message_id(191)), KEY (provider_id): the thread read's sent_by
--   probe. KEY (user, sent_at): "what did X send lately".
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- A: CREATE TABLE IF NOT EXISTS. B: INSERT … SELECT guarded by NOT EXISTS on
-- email_log_id, so a re-run inserts nothing.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mail_sends (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  mailbox_id INT UNSIGNED NOT NULL COMMENT 'mailboxes.id (FK by convention) - the box sent AS (an alias box keeps its own id; the copy lands in the parent)',
  `user` TINYINT NOT NULL COMMENT 'users.user (FK by convention) - who clicked Send; the hub is interactive-only, never 0/automation',
  message_id VARCHAR(512) NULL COMMENT 'RFC Message-ID, brackets stripped as in mail_messages.message_id; NULL for a Gmail send (Gmail rewrites it - provider_id is the key there)',
  provider_id VARCHAR(64) NULL COMMENT 'Gmail hex id (lowercase X-GM-MSGID), as mail_messages.provider_id; NULL for SMTP sends',
  email_log_id INT NULL COMMENT 'email_log.id of the adapter''s outbound-* row (best-effort lookup; NULL if the fire-and-forget row was not found)',
  case_id VARCHAR(20) NULL COMMENT 'cases.case_id the sender asked to link the sent copy to (composer Case field); NULL = none asked',
  case_link_state VARCHAR(12) NULL COMMENT 'app-validated: NULL (no case asked) | pending (mail_sent_case_link job will link the stored copy) | linked (case_log_id set) | failed (job gave up; error alert raised)',
  case_log_id INT NULL COMMENT 'log.log_id the sent copy was linked to (via mailReadService.caseLink, or created at send when no copy will ever be stored)',
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'UTC (the pool runs UTC) - when the dispatch succeeded',
  PRIMARY KEY (id),
  KEY idx_mail_sends_message_id (message_id(191)),
  KEY idx_mail_sends_provider_id (provider_id),
  KEY idx_mail_sends_user_sent (`user`, sent_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='S2P: one row per comms-hub send - attribution (Sent by X via YisraCase, design OQ4) + the Case field''s link state. Written post-dispatch, best-effort (a failed insert never fails the send); read by thread/message responses (sent_by).';

-- B. Backfill the 10 pre-S2P sends (all user 6). provider_id only when
-- email_log.message_id is a Gmail hex id; message_id only when it is a
-- bracketed RFC id (outbound-smtp). sent_at = the audit row's created_at.
INSERT INTO mail_sends (mailbox_id, `user`, message_id, provider_id, email_log_id, sent_at)
SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(a.details, '$.mailbox_id')) AS UNSIGNED),
       a.user_id,
       CASE WHEN e.message_id LIKE '<%>' THEN TRIM(BOTH '<' FROM TRIM(BOTH '>' FROM e.message_id)) ELSE NULL END,
       CASE WHEN e.message_id REGEXP '^[0-9a-f]{1,16}$' THEN e.message_id ELSE NULL END,
       e.id,
       a.created_at
  FROM admin_audit_log a
  JOIN email_log e ON e.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(a.details, '$.email_log_id')) AS UNSIGNED)
 WHERE a.tool = 'mail_send' AND a.status = 'sent'
   AND a.user_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM mail_sends s WHERE s.email_log_id = e.id);
