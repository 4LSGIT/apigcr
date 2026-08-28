-- YisraStreak — board chat.
-- Replaces the per-checkin `note` field, which went unused (1 note in 68 checkins).
--
-- DEPLOY ORDER: this migration runs BEFORE the backend deploy. The new routes
-- SELECT from this table on every board load; without it every board 500s.
--
-- `created_at` is TIMESTAMP, not DATETIME, deliberately. TIMESTAMP is stored as
-- UTC internally, so `UNIX_TIMESTAMP(created_at)` is session-timezone-proof.
-- The API hands the client an epoch integer and the client renders it in the
-- viewer's own zone — which is the only correct answer for a board whose two
-- members sit in different countries.
--
-- No FK to streak_boards, matching streak_checkins: dropping a member from the
-- board's JSON member list must not destroy their history. The board DELETE
-- route does the cascade itself.

CREATE TABLE IF NOT EXISTS `streak_messages` (
  `id`         int unsigned NOT NULL AUTO_INCREMENT,
  `board_id`   int unsigned NOT NULL,
  `username`   varchar(32) COLLATE utf8mb4_general_ci NOT NULL
               COMMENT 'matches streak_boards.members[].u — deliberately not an FK',
  `body`       varchar(1000) COLLATE utf8mb4_general_ci NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
               COMMENT 'UTC-backed; always read via UNIX_TIMESTAMP()',
  PRIMARY KEY (`id`),
  KEY `idx_streak_msg_board` (`board_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
