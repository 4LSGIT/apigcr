-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-11 — Mailbox system S1-G, All-Mail slice: COMMENT-only
--   mailboxes.ingest_folders — Gmail: [Gmail]/All Mail as the ONLY folder is
--     the sanctioned configuration (was: "never Gmail All Mail"); Draft-flagged
--     messages are never stored.
--   mailboxes.ingest_state   — the new drafts_skipped_total key.
--
-- WHY
--   Manager ruling 2026-10-11 (ref/MAILBOX_GMAIL_PARITY.md §5): the Workspace
--   mailbox polls All Mail ONLY — one copy of inbound, sent and label-filed
--   mail (~43% of what the Apps Script source posts lives outside INBOX/Sent),
--   so a new Gmail filter can never open a coverage gap. The old rule was
--   about double-storing: All Mail ALONGSIDE other folders stores every
--   labelled message twice — that part stands (GET /api/mailboxes/:id/folders
--   warns ALL_MAIL_ALONGSIDE_OTHER_FOLDERS). Drafts (Gmail re-creates one per
--   autosave) are skipped by the worker's DRAFT GUARD
--   (services/mailbox/mailboxIngestService.js, design §4.1).
--
-- ── ORDER / SAFETY ───────────────────────────────────────────────────────────
-- Metadata only: each MODIFY restates the current type exactly (JSON NULL, no
-- default) — no data change, no rebuild. Independent of the backend deploy
-- (nothing reads a COMMENT); run it first by convention. Idempotent: a re-run
-- re-applies the same COMMENTs. From the SU DB console run both statements
-- through /admin/db/batch (allowWrite: true, stopOnError: true).
--
-- After running: the pre-commit hook regenerates ref/database.sql.
-- ROLLBACK: re-run section C of ref/migrations/2026-10-09_mailbox_s1g.sql.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE mailboxes
  MODIFY COLUMN ingest_folders JSON NULL
    COMMENT 'per-folder CONFIG: {"<folder>": {"emit_to_rules": bool, "backfill"?: false}} - which folders the worker polls, which emit into the rules pipeline (§4.1), and (S1-G) backfill:false = store only mail arriving after first sight (no history; decided at first sight; a later re-key stores only above the highest re-mapped UID). Everything polled is stored to mail_messages regardless - except Draft-flagged messages, never stored nor emitted (DRAFT GUARD, §4.1). mailboxService always writes it (backfill only when false); v1 default {"INBOX":{"emit_to_rules":true}} (Sent is opt-in, emit_to_rules false - host Sent names vary). Gmail: [Gmail]/All Mail as the ONLY folder (one copy of inbound, sent and labelled mail; sent mail emits too) - never All Mail alongside other folders (every labelled message stored twice)';

ALTER TABLE mailboxes
  MODIFY COLUMN ingest_state JSON NULL
    COMMENT 'per-folder CURSOR, written only by the ingest worker (services/mailbox/mailboxIngestService.js): {"<folder>": {uidvalidity, last_uid = new-mail cursor, backfill_uid = backlog still to store below it (absent = done), backfill_floor_uid = re-key of a backfill:false folder stores only above this, backfill_emit_after = ISO emit horizon set by a re-key (null = store-only), backfill_skipped_below / backfill_skipped_at = backfill:false baseline, checked_at, errors, backfill_errors, last_error, last_error_at, rekeyed_at, backfill_done_at, no_provider_id_total / last_no_provider_id_at / last_no_provider_id_uid = provider-keyed mail stored but not emitted, drafts_skipped_total = Draft-flagged messages passed over (never stored)}}. First poll baselines at UIDNEXT: existing mail is stored (or skipped), never emitted. UIDVALIDITY change = re-key, never blanket purge (§4.1). A folder dropped from ingest_folders keeps its key here as a breadcrumb. NULL = never ingested';

-- VERIFY — expect the two new texts:
--   SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, LEFT(COLUMN_COMMENT, 60) AS c,
--          LOCATE('ONLY folder', COLUMN_COMMENT) > 0 AS all_mail_rule,
--          LOCATE('drafts_skipped_total', COLUMN_COMMENT) > 0 AS drafts_key
--     FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mailboxes'
--      AND COLUMN_NAME IN ('ingest_folders', 'ingest_state');
