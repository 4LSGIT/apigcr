-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-11-16 — comms-polish-2 bundle B: per-user read state for the Comms
-- Phone tab (texts and calls), the Phone tab badge and the shell's Comms badge.
--
--   A. TABLE phone_read_state — one row per (user, line, outside number) once a
--      conversation is opened or marked; two kinds of BASELINE row use '*':
--        line_number = '*', other_party = '*'  the user's global baseline
--        line_number = <line>, other_party = '*'  "Mark all read" on that line
--      The rule (services/phoneCommsService.js "Read state"): a conversation is
--      UNREAD for a user when its newest unread-making event — an incoming text,
--      or a missed / unanswered incoming call — has an id above the user's
--      read-through for it: the conversation's own row when one exists (0 =
--      marked unread by hand, so it wins over any baseline), else the larger of
--      the line's and the global baseline, else 0.
--   B. SEED one global baseline per authorized user at today's MAX(id), so
--      launch day shows no backlog (12K events, 2.1K conversations live): only
--      activity after the migration counts as unread. A user authorized later
--      has no baseline and sees history as unread until Mark all read, the
--      Email tab's own rule.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- SQL FIRST, then backend + frontend (house order). The B backend reads and
-- writes this table on every Phone-tab list, on GET /api/phone-lines/readable
-- (the badges) and on the new read routes; without it those are 500s.
-- Nothing in the app reads the table before B deploys, so running it early is
-- harmless. Run through scripts/commsPolish2PhoneReadState.js (CHECK, then
-- --apply: asserts, applies, verifies, one GO / NO-GO line), not by hand.
--
-- ── ALGORITHMS ──────────────────────────────────────────────────────────────
--   A: a new table — no lock on anything live. B: ≤ 10 rows.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS; the seed's NOT EXISTS skips users that have a
-- global baseline already (a re-run never moves a baseline forward).
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- DROP TABLE phone_read_state; — only before B deploys (after it, the Phone
-- tab's reads name the table).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `phone_read_state` (
  `user` tinyint NOT NULL COMMENT 'users.user (FK by convention); the state is PER USER, like mail_read_state',
  `line_number` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'phone_lines.phone_number = phone_event_log.line_number (10 digits): read state is per LINE — the same outside number on two lines is two conversations (the Phone tab lists them so). ''*'' with other_party ''*'' = the user''s global baseline (seeded at the migration)',
  `other_party` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'phone_event_log.other_party. ''*'' = the line''s "Mark all read" baseline (every conversation on the line read through read_through_id, unless its own row says otherwise)',
  `read_through_id` int unsigned NOT NULL COMMENT 'phone_event_log.id: events of the conversation with id <= this are read for this user. UNREAD when the newest incoming text or missed/unanswered incoming call has a larger id. A conversation''s own row WINS over the baselines; 0 in it = marked unread by hand. Writers: phoneCommsService setConversationRead / setLinesRead only',
  `read_at` datetime NOT NULL COMMENT 'UTC (the pool runs UTC) — when the row was last written',
  PRIMARY KEY (`user`, `line_number`, `other_party`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='PER-USER read state of the Comms Phone tab (comms-polish-2 B, 2026-11-16; migration 2026-11-16_phone_read_state.sql): conversations = (line, outside number). Rows outlive their events (no FK) — harmless. The rule lives in services/phoneCommsService.js "Read state"; manual/08-Admin-Tools/08-mailboxes.md "Phone lines — Comms"';

INSERT INTO `phone_read_state` (`user`, `line_number`, `other_party`, `read_through_id`, `read_at`)
SELECT u.`user`, '*', '*', (SELECT COALESCE(MAX(id), 0) FROM `phone_event_log`), UTC_TIMESTAMP()
  FROM `users` u
 WHERE u.`user_auth` = 'authorized' AND u.`user` > 0
   AND NOT EXISTS (SELECT 1 FROM `phone_read_state` r WHERE r.`user` = u.`user` AND r.`line_number` = '*' AND r.`other_party` = '*');
