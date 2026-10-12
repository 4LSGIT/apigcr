-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-12 — Mailbox system S3-R: per-address reading (alias boxes)
--   A1. mailboxes.alias_of     INT UNSIGNED NULL — parent mailbox (FK by
--       convention). NOT NULL = this row is a send-as ALIAS of that box, and
--       SEND-ONLY is now DEFINED as alias_of IS NOT NULL
--       (mailReadService.SEND_ONLY_SQL — the old "ingest off AND no secret"
--       inference dies with this file's backend).
--   A2. mailboxes.alias_label  VARCHAR(255) NULL — the Gmail label whose
--       filter files this alias's mail in the parent (e.g. 'IT'); the
--       label → alias mapping lives on the alias row.
--   B.  Convert rows the old inference called send-only (ingest off AND no
--       secret) into alias rows. VERIFIED LIVE 2026-10-12: no such row exists
--       (boxes 1–3 all poll with secrets), so B updates ZERO rows — it is the
--       belt for a copy of this file run elsewhere. It can only set a
--       placeholder parent of NULL… there is nothing to infer a parent FROM,
--       so B is a NO-OP by design: a pre-existing inferred send-only row (none
--       live) must be re-created through the pane's alias mode instead.
--
-- WHY
--   S3.1 send-only boxes (a Google send-as alias as its own mailbox row) let
--   people SEND as it@ / rena@ / shoshana@, but replies land in the parent
--   account's box (mailbox 2), readable only by box-2 readers. S3-R makes a
--   can_read grant on an alias box read the alias's SLICE of the parent:
--   rows the Gmail filter labelled for it (alias_label — catches Bcc and
--   list mail; live: every it@ row has in_inbox = 0, the filters archive) or
--   that carry the alias address in From/To/Cc. Resolution:
--   services/mailbox/mailReadService.js (ALIAS SLICE); admin:
--   public/mailboxAdmin.html "send-as address" mode.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- SQL FIRST, then backend, then frontend (house order). The S3-R backend
-- SELECTs alias_of in mailboxService.listReadable and tests it in
-- SEND_ONLY_SQL — deployed before this file it fails every mailbox read
-- (ER_BAD_FIELD_ERROR). The live S3.2 backend names its columns and never
-- reads these two, so running this file under it changes nothing. NO ingest
-- or emission statement touches mailboxes' new columns (parity window safe).
--
-- ── ALGORITHMS ──────────────────────────────────────────────────────────────
-- A1/A2 are plain ADD COLUMNs on a 3-row table — INSTANT (metadata only).
-- No index: the table holds a handful of rows and every alias resolution
-- walks rows already fetched by listReadable.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- A1/A2 guarded on information_schema (SET/PREPARE groups need ONE
-- connection — run from a mysql client session; from the SU DB console run
-- the plain fallbacks quoted under each group instead; a re-run fails
-- harmlessly with ER_DUP_FIELDNAME). B is idempotent as written (matches
-- nothing after the first run — or ever, live).
--
-- ── CONVENTIONS ─────────────────────────────────────────────────────────────
-- No FKs (FK-by-convention in the COMMENT), no seeds. Type matches
-- mailboxes.id (INT UNSIGNED). ref/database.sql is auto-generated — never
-- hand-edited; it picks these columns up from the live schema at the next
-- commit after this file runs.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Roll the backend back first (it SELECTs the columns), then:
--   ALTER TABLE mailboxes DROP COLUMN alias_label;
--   ALTER TABLE mailboxes DROP COLUMN alias_of;
-- ─────────────────────────────────────────────────────────────────────────────


-- ── A1. mailboxes.alias_of ───────────────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'mailboxes'
      AND COLUMN_NAME  = 'alias_of') > 0,
  'SELECT ''mailboxes.alias_of already present — skipped'' AS note',
  'ALTER TABLE mailboxes
     ADD COLUMN alias_of INT UNSIGNED NULL
     COMMENT ''S3-R: parent mailboxes.id (FK by convention). NOT NULL = this row is a send-as ALIAS of that box - the ONE definition of SEND-ONLY (mailReadService.SEND_ONLY_SQL). An alias never polls (ingest stays off, no secret; host/login copied from the parent) and a can_read grant on it reads the alias SLICE of the parent: rows labelled alias_label or carrying the address in From/To/Cc; within it From = the alias is Sent, the rest Inbox. SU may re-point it to another real box (PATCH; host/login re-copied) - never cleared, never set on a full box, never an alias of an alias''
     AFTER send_credential_id');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Fallback (ER_DUP_FIELDNAME on a re-run):
--   ALTER TABLE mailboxes
--     ADD COLUMN alias_of INT UNSIGNED NULL
--     COMMENT 'S3-R: parent mailboxes.id (FK by convention). NOT NULL = this row is a send-as ALIAS of that box - the ONE definition of SEND-ONLY (mailReadService.SEND_ONLY_SQL). An alias never polls (ingest stays off, no secret; host/login copied from the parent) and a can_read grant on it reads the alias SLICE of the parent: rows labelled alias_label or carrying the address in From/To/Cc; within it From = the alias is Sent, the rest Inbox. SU may re-point it to another real box (PATCH; host/login re-copied) - never cleared, never set on a full box, never an alias of an alias'
--     AFTER send_credential_id;


-- ── A2. mailboxes.alias_label ────────────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'mailboxes'
      AND COLUMN_NAME  = 'alias_label') > 0,
  'SELECT ''mailboxes.alias_label already present — skipped'' AS note',
  'ALTER TABLE mailboxes
     ADD COLUMN alias_label VARCHAR(255) NULL
     COMMENT ''S3-R: the Gmail label whose filter files this ALIAS box''''s mail in the parent (exact spelling, case-sensitive in JSON MEMBER OF - live: IT / Rena / Shoshana). Catches Bcc and list mail the From/To/Cc half of the slice misses. NULL = address matching only. A USER label: a system label (backslash-led, e.g. Inbox) is refused. Meaningful on alias rows (alias_of) only; SU-editable''
     AFTER alias_of');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Fallback (ER_DUP_FIELDNAME on a re-run):
--   ALTER TABLE mailboxes
--     ADD COLUMN alias_label VARCHAR(255) NULL
--     COMMENT 'S3-R: the Gmail label whose filter files this ALIAS box''s mail in the parent (exact spelling, case-sensitive in JSON MEMBER OF - live: IT / Rena / Shoshana). Catches Bcc and list mail the From/To/Cc half of the slice misses. NULL = address matching only. A USER label: a system label (backslash-led, e.g. Inbox) is refused. Meaningful on alias rows (alias_of) only; SU-editable'
--     AFTER alias_of;


-- ── B. Convert inferred send-only rows ───────────────────────────────────────
-- Verified live 2026-10-12: zero rows match (SELECT id FROM mailboxes WHERE
-- ingest_enabled = 0 AND imap_secret IS NULL → empty). A row that DID match
-- has no inferable parent, so nothing can be written here — delete and
-- re-create it through the pane's "send-as address" mode. This statement is
-- the audit trail of that decision, not a write:
SELECT id, address FROM mailboxes WHERE ingest_enabled = 0 AND imap_secret IS NULL AND alias_of IS NULL;
-- (expect: empty. Any row listed must be re-created as an alias before the
--  S3-R backend deploys, or it becomes a readable empty box — harmless but
--  pointless — and stops appearing in the From picker as send-only.)


-- VERIFY — expect both columns, NULL on every existing row:
--   SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
--     FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mailboxes'
--      AND COLUMN_NAME IN ('alias_of', 'alias_label');
--   SELECT id, address, alias_of, alias_label FROM mailboxes ORDER BY id;
