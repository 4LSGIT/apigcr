-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-12 — Comms slice S-PH: per-line phone reading + grant-gated SMS send
--   A. phone_event_log.line_number  VARCHAR(32) GENERATED … VIRTUAL — the firm
--      line an event belongs to: to_number for 'incoming', from_number
--      otherwise. VERIFIED LIVE 2026-10-12: equal to the provider's own
--      raw_extra.line on 10,476 of 10,476 rows, and no row has a line on the
--      OTHER side only (the rule never mis-attributes; 976 rows name a number
--      that is not a phone_lines row and stay invisible — "orphans").
--   B. INDEX idx_phone_event_line (line_number, processed_at) — the phone
--      tab's per-line walks (conversations, one conversation, the call log).
--   C. SEED channel_grants('phone_line'): can_read + can_send for every
--      non-SU staff user on the line their users.default_phone names
--      (ruling 2026-10-12, Fred: Stuart → 1, sb → 2, Rena → 3 — verified
--      against users; IT is SU and needs no row; VS/RR/CS/Charlie have no
--      default line and no SMS sends on record). WITHOUT THIS the S-PH
--      backend 403s the contact Communicate tab and the sending forms for
--      everyone but the SU — their /internal/sms|mms/send calls become
--      grant-checked in the same deploy.
--   D. COMMENTs: channel_grants (table + granted_by) said phone rows "arrive
--      with S-PH" — they arrive now.
--
-- WHY
--   ref/MAILBOX_SYSTEM_DESIGN.md D6 (amended 2026-10-11): the comms hub's
--   Phone tab reads phone_event_log — the complete phone store, both
--   providers — per line, scoped by channel_grants('phone_line'). Reads are
--   the generated column's equality + a processed_at range: one index walk
--   per line instead of a table scan. The services name `line_number`
--   DIRECTLY — MySQL's substitution of a generated column for its base
--   expression is collation-fragile (measured: under utf8mb4_general_ci the
--   base-expression form did NOT use the index) — and FORCE INDEX
--   (idx_phone_event_line) on the conversations + call-log walks (unforced,
--   the optimizer walked idx_phone_event_processed_at once one line held most
--   rows). tests/phoneSPH.mysql.test.js pins both plans.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- SQL FIRST, then backend + frontend (house order; one deploy). ALL of it:
--   - A/B MUST run before the backend: the phone-tab reads name line_number
--     and FORCE INDEX (idx_phone_event_line); without them every Phone-tab
--     read is a 500 (ER_BAD_FIELD_ERROR / ER_KEY_DOES_NOT_EXITS). Nothing
--     else in the app reads either.
--   - C MUST run before the backend: that backend grant-checks
--     /internal/sms|mms/send for staff JWT callers; without the seed rows
--     Stuart, sb and Rena are refused on the contact Communicate tab and the
--     sending forms.
-- The ingest INSERT (services/phoneIngestService.js) names its columns, so a
-- generated column is invisible to it — phone ingest is untouched.
--
-- ── ALGORITHMS ──────────────────────────────────────────────────────────────
--   A: ALGORITHM=INSTANT (a VIRTUAL column is metadata; 8.0.29+/8.4).
--   B: ALGORITHM=INPLACE, LOCK=NONE (secondary index build, concurrent DML
--      allowed; ≈10.5K rows → well under a second). Size ≈ 0.3 MB measured
--      on a 10.5K-row twin (≈ 0.03% of the 1 GB SiteGround cap; the DB sits
--      at ~899 MB).
--   C: ≤ 3 rows today.
--   D: metadata only (comments; granted_by restated with its exact type).
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- A/B guarded on information_schema (SET/PREPARE groups need ONE connection —
-- run from a mysql client session; from the SU DB console run the plain
-- fallbacks quoted under each group instead; a re-run of a fallback fails
-- harmlessly with ER_DUP_FIELDNAME / ER_DUP_KEYNAME). C inserts only rows
-- that do not exist (NOT EXISTS on the UNIQUE (user, channel_type,
-- channel_id) key). D re-applies the same text.
--
-- ── CONVENTIONS ─────────────────────────────────────────────────────────────
-- No FKs. ref/database.sql is auto-generated — it picks A/B/D up from the
-- live schema at the next commit after this file runs.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Roll the backend back first (the old backend ignores all of this), then:
--   ALTER TABLE phone_event_log DROP INDEX idx_phone_event_line;
--   ALTER TABLE phone_event_log DROP COLUMN line_number;
--   DELETE FROM channel_grants WHERE channel_type = 'phone_line';   -- every phone grant, seeded or not
-- ─────────────────────────────────────────────────────────────────────────────


-- ── A. phone_event_log.line_number ───────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'phone_event_log'
      AND COLUMN_NAME  = 'line_number') > 0,
  'SELECT ''phone_event_log.line_number already present — skipped'' AS note',
  'ALTER TABLE phone_event_log
     ADD COLUMN line_number VARCHAR(32)
       GENERATED ALWAYS AS (IF(direction = ''incoming'', to_number, from_number)) VIRTUAL
       COMMENT ''S-PH: the firm line this event belongs to (incoming → to_number, else from_number) - equal to raw_extra.line on every live row. Joins phone_lines.phone_number by plain equality; no match = an orphan (a number that is not a phone_lines row), invisible in the Comms phone tab. Indexed with processed_at (idx_phone_event_line). Code names this column directly (generated-column substitution for the base expression is collation-fragile) and forces the index on per-line walks''
       AFTER other_party,
     ALGORITHM=INSTANT');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Fallback (ER_DUP_FIELDNAME on a re-run):
--   ALTER TABLE phone_event_log
--     ADD COLUMN line_number VARCHAR(32)
--       GENERATED ALWAYS AS (IF(direction = 'incoming', to_number, from_number)) VIRTUAL
--       COMMENT 'S-PH: the firm line this event belongs to (incoming → to_number, else from_number) - equal to raw_extra.line on every live row. Joins phone_lines.phone_number by plain equality; no match = an orphan (a number that is not a phone_lines row), invisible in the Comms phone tab. Indexed with processed_at (idx_phone_event_line). Code names this column directly (generated-column substitution for the base expression is collation-fragile) and forces the index on per-line walks'
--       AFTER other_party,
--     ALGORITHM=INSTANT;


-- ── B. idx_phone_event_line ──────────────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'phone_event_log'
      AND INDEX_NAME   = 'idx_phone_event_line') > 0,
  'SELECT ''idx_phone_event_line already present — skipped'' AS note',
  'ALTER TABLE phone_event_log
     ADD INDEX idx_phone_event_line (line_number, processed_at),
     ALGORITHM=INPLACE, LOCK=NONE');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Fallback (ER_DUP_KEYNAME on a re-run):
--   ALTER TABLE phone_event_log
--     ADD INDEX idx_phone_event_line (line_number, processed_at),
--     ALGORITHM=INPLACE, LOCK=NONE;


-- ── C. Seed phone_line grants from users.default_phone ──────────────────────
-- Preview (audit trail — expect exactly: 1/Ssandweiss → line 1, 5/sb → line 2,
-- 22/RENA → line 3 on the live DB of 2026-10-12):
SELECT u.user, u.username, pl.id AS line_id, pl.phone_number
  FROM users u
  JOIN phone_lines pl ON pl.phone_number = u.default_phone
 WHERE u.user > 0 AND u.user_auth = 'authorized'
 ORDER BY u.user;

-- granted_by 6 = the SU who ruled the seed (Fred, 2026-10-12).
INSERT INTO channel_grants (user, channel_type, channel_id, can_read, can_send, can_manage, granted_by)
SELECT u.user, 'phone_line', pl.id, 1, 1, 0, 6
  FROM users u
  JOIN phone_lines pl ON pl.phone_number = u.default_phone
 WHERE u.user > 0
   AND u.user_auth = 'authorized'
   AND NOT EXISTS (SELECT 1 FROM channel_grants g
                    WHERE g.user = u.user AND g.channel_type = 'phone_line' AND g.channel_id = pl.id);


-- ── D. Comments ──────────────────────────────────────────────────────────────
ALTER TABLE channel_grants
  MODIFY COLUMN granted_by TINYINT NOT NULL
    COMMENT 'users.user who created the row; history of later flag edits lives in admin_audit_log (tool=mailboxes for mailbox rows, tool=phone_lines for phone_line rows)',
  COMMENT = 'Channel access grants (D6). Enforced on INTERACTIVE routes only - never inside emailService/phoneService, so automation sends bypass. SU short-circuits in mailboxService; users.roles attorney READS every mailbox and every phone line without a row (send/manage still need one). phone_line rows since S-PH (2026-10-12): the Comms phone tab, the phone-line send route, and staff-JWT /internal/sms|mms/send';


-- VERIFY:
--   SELECT COLUMN_NAME, GENERATION_EXPRESSION FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'phone_event_log' AND COLUMN_NAME = 'line_number';
--   SHOW INDEX FROM phone_event_log WHERE Key_name = 'idx_phone_event_line';
--   SELECT user, channel_id, can_read, can_send, can_manage, granted_by
--     FROM channel_grants WHERE channel_type = 'phone_line' ORDER BY user;   -- expect (1,1),(5,2),(22,3)
--   EXPLAIN SELECT id FROM phone_event_log FORCE INDEX (idx_phone_event_line)
--    WHERE line_number = '2485592400' AND event_type = 'call' AND suppressed = 0
--    ORDER BY processed_at DESC, id DESC LIMIT 51;                         -- key: idx_phone_event_line, no filesort
