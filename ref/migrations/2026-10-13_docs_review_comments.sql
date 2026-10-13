-- 2026-10-13 — docs review #2: stale / missing column COMMENTs (7 columns, 6 tables)
--
-- COMMENT-ONLY. No data change, no type change — every MODIFY restates the
-- live column definition exactly (per ref/database.sql @ 9821110) and swaps
-- the COMMENT. Metadata-only on MySQL 8.4 (ALGORITHM=INSTANT spelled out so
-- the engine errors rather than silently rebuilding). Idempotent: a re-run
-- re-applies the same text. Each ALTER is a standalone statement — safe from
-- the SU console (no guarded groups; see ref/SCHEMA_CONVENTIONS.md).
--
-- Sources (doc-debt queue, scratch ns=docs):
--   court_ai_log.message_id   2026-10-05_collation-invariant-stale — both
--                             message_id columns are utf8mb4_general_ci live;
--                             the old COMMENT still asserted the divergence.
--   field_defs.show_when      20260925_field_defs_show_when_comment — S4
--                             shipped 2026-09-25; "NOT EVALUATED" is false.
--   email_log.processed_at    20261009_email_log_processed_at_tz — mixed TZ
--                             by writer, previously undocumented.
--   log.log_date              20260925_log_timezone_spellings — three
--                             spellings of one wall clock.
--   inbox_views.filters,      20261009_inbox_views_filters_comment — S2
--   inbox_views.mailbox_ids   defined the vocabulary the old COMMENT deferred.
--   mailboxes.ingest_folders  20261011_ingest_folders_draft_comment — the
--                             DRAFT GUARD is flag OR Gmail Draft label.
--
-- After applying: npm run db:ref (or let the pre-commit hook do it).

ALTER TABLE court_ai_log
  MODIFY message_id varchar(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
    COMMENT 'utf8mb4_general_ci — SAME as email_log.message_id since the 2026-10-05 verification (this column was utf8mb4_unicode_ci once). The explicit COLLATE utf8mb4_general_ci clauses on the court-side joins (routes/courtReview.js, services/courtRerun.js, lib/internal_functions/court.js) are no-ops kept as insurance against re-divergence',
  ALGORITHM=INSTANT;

ALTER TABLE field_defs
  MODIFY show_when json DEFAULT NULL
    COMMENT 'Conditional display, evaluated CLIENT-SIDE since S4 (2026-09-25): public/js/yc-custom-fields.js parseShowWhen/evalShowWhen; authored in the caseconfig fields builder. v1 vocabulary: ONE condition object {field, op, value?} — op eq|ne (scalar value) | in (non-empty scalar array) | not_empty|empty (no value). Any other shape VOIDS the condition (field always shown, stored value left untouched, console warning). NULL = always shown',
  ALGORITHM=INSTANT;

ALTER TABLE email_log
  MODIFY processed_at datetime NOT NULL
    COMMENT 'MIXED wall clock BY WRITER (found 2026-10-09): ingest rows (services/emailIngestService.js — gmail-firm, mailbox-imap, siteground...) write Eastern via CONVERT_TZ(NOW(), @@session.time_zone, EST5EDT); outbound-* rows (services/adapters/email/gmail|smtp|pabbly.js) write NOW() = pool UTC. Cross-source time arithmetic is off by 4-5 h — compare within one source, or normalize per source first',
  ALGORITHM=INSTANT;

ALTER TABLE log
  MODIFY log_date datetime NOT NULL
    COMMENT 'Firm-local wall clock written under THREE spellings that are today the same offset (found 2026-09-25): logService.createLogEntry CONVERT_TZ(..., EST5EDT), the after_contact_update DB trigger CONVERT_TZ(..., America/New_York), and the firm zone America/Detroit (FIRM_TIMEZONE env). A future zone change touches all three literals, in two languages. CONVERT_TZ with named zones returns NULL on a MySQL without tz tables loaded and this column is NOT NULL — a real-engine clone needs mysql_tzinfo_to_sql first',
  ALGORITHM=INSTANT;

ALTER TABLE inbox_views
  MODIFY filters json DEFAULT NULL
    COMMENT 'Saved-view filter vocabulary = services/mailbox/mailReadService.js FILTER_KEYS (S2, grown since: unread_only/has_case/no_case/client_only/has_files/all_folders/sent_only booleans + from_domain + q). Unknown keys are REFUSED on write and ignored on read; the stored shape keeps only narrowing entries',
  MODIFY mailbox_ids json DEFAULT NULL
    COMMENT '[mailboxes.id, ...]; NULL or [] = all boxes the viewer can read. A view never grants access: every id must be readable at write time and is re-checked / intersected against channel_grants at every read (S2)',
  ALGORITHM=INSTANT;

ALTER TABLE mailboxes
  MODIFY ingest_folders json DEFAULT NULL
    COMMENT 'per-folder CONFIG: {"<folder>": {"emit_to_rules": bool, "backfill"?: false}} - which folders the worker polls, which emit into the rules pipeline (§4.1), and (S1-G) backfill:false = store only mail arriving after first sight (no history; decided at first sight; a later re-key stores only above the highest re-mapped UID). Everything polled is stored to mail_messages regardless - except drafts, never stored nor emitted (DRAFT GUARD, §4.1: the IMAP Draft flag OR the Gmail Draft label - Gmail does not flag drafts in All Mail; label patch 2026-10-11). mailboxService always writes it (backfill only when false); v1 default {"INBOX":{"emit_to_rules":true}} (Sent is opt-in, emit_to_rules false - host Sent names vary). Gmail: [Gmail]/All Mail as the ONLY folder (one copy of inbound, sent and labelled mail; sent mail emits too) - never All Mail alongside other folders (every labelled message stored twice)',
  ALGORITHM=INSTANT;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY — expect 7 rows, each COLUMN_COMMENT starting as shown:
--   SELECT TABLE_NAME, COLUMN_NAME, LEFT(COLUMN_COMMENT, 40) AS head
--     FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE()
--      AND ((TABLE_NAME='court_ai_log'  AND COLUMN_NAME='message_id')      -- 'utf8mb4_general_ci — SAME as email_log…'
--        OR (TABLE_NAME='field_defs'    AND COLUMN_NAME='show_when')       -- 'Conditional display, evaluated CLIENT-…'
--        OR (TABLE_NAME='email_log'     AND COLUMN_NAME='processed_at')    -- 'MIXED wall clock BY WRITER…'
--        OR (TABLE_NAME='log'           AND COLUMN_NAME='log_date')        -- 'Firm-local wall clock written under TH…'
--        OR (TABLE_NAME='inbox_views'   AND COLUMN_NAME IN ('filters','mailbox_ids'))
--        OR (TABLE_NAME='mailboxes'     AND COLUMN_NAME='ingest_folders'));
--
-- VERIFY 2 — nothing but comments moved: types/nullability unchanged vs
-- ref/database.sql @ 9821110 (varchar(190) general_ci NOT NULL; json NULL ×4;
-- datetime NOT NULL ×2).
