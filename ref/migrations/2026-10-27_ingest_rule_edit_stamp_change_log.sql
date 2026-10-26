-- ref/migrations/2026-10-27_ingest_rule_edit_stamp_change_log.sql
--
-- A20 slice 1 (Fred's go 2026-10-27, both schema changes): an EDIT STAMP and an
-- append-only CHANGE LOG for email + phone ingest rules. Applied by
-- scripts/ingestRuleEditStampAndChangeLog.js --apply, NOT by pasting this file
-- anywhere: the script runs these statements on ONE connection with the session
-- settings they depend on, asserts the live state before writing (and again
-- after setting them), backfills inside a transaction it rolls back unless
-- every updated_at is unchanged, verifies the end state, and smoke-tests in
-- rolled-back transactions. This file is the durable record of what it runs.
--
--   {email,phone}_ingest_rules.definition_updated_at   ADD — THE edit stamp
--   {email,phone}_ingest_rules.updated_at              COMMENT — not an edit stamp
--   {email,phone}_ingest_rule_changes                  CREATE — append-only log
--
-- WHY. Every match bumps match_count / last_matched_at with an UPDATE, so
-- `ON UPDATE CURRENT_TIMESTAMP` moves updated_at all day on a busy rule (live
-- 2026-10-27: 15 of 21 email rules and 2 of 3 phone rules show updated_at =
-- last_matched_at), and an action write never touches the rule row. A stale-
-- edit guard on updated_at would refuse spuriously and miss action edits. The
-- code that moves the stamp and writes the log: services/ingestRuleChangeLog.js.
--
-- ORDER: THIS FIRST, THEN THE BACKEND (SQL → backend). The new code selects
-- definition_updated_at on every rule read; deployed first, the rule editor's
-- routes 500 and write nothing. Ingest itself never names the new objects.
--
-- BACKFILL. A pre-existing row's stamp = its updated_at: an UPPER bound on its
-- last edit (the last row write, edit or match). No column holds the true time.
-- Three steps so a stopped run resumes: ADD with a SENTINEL default (no rule
-- predates 2026), switch the default to CURRENT_TIMESTAMP(3) (from then the old
-- code's inserts get a real stamp), backfill the sentinel rows assigning
-- updated_at to itself so ON UPDATE cannot fire.
--
-- SESSION SETTINGS THE SCRIPT HOLDS ON ITS ONE CONNECTION:
--   lock_wait_timeout = 5           every ALTER (even INSTANT) takes an
--                                   exclusive metadata lock; the global default
--                                   is a year. Measured on 8.4.11: a transaction
--                                   holding a rule row FOR UPDATE makes the ALTER
--                                   give up after 5 s with nothing changed.
--   innodb_lock_wait_timeout = 5    the backfill's row locks (default 50 s).
--
-- ALGORITHMS (measured on 8.4.11): every ALTER is INSTANT (ADD COLUMN with a
-- constant default, a default change, a comment change). The change tables are
-- new and empty. Sizes: 21 email / 3 phone rules, 21 / 3 actions (2026-10-27).
--
-- SECRETS. Rule and action rows hold none of the ingest keys (those are
-- email_ingest_sources, never read here). The log copy redacts an http action's
-- URL (host kept) and literal header values; there are 0 http actions live.
-- Reads: no route reads the log in this slice — SU console / readonly SQL only
-- (normal tier: it holds what the rule rows hold, minus those redactions).

SET SESSION lock_wait_timeout = 5;
SET SESSION innodb_lock_wait_timeout = 5;

-- ── email ──
ALTER TABLE `email_ingest_rules` ADD COLUMN `definition_updated_at` DATETIME(3) NOT NULL DEFAULT '2000-01-01 00:00:00.000' COMMENT 'THE EDIT STAMP: last real definition change (the rule fields or any of its action rows). Every match bumps updated_at; this column is the edit stamp. Set only by services/ingestRuleChangeLog.js, inside the edit transaction, strictly increasing; the stale-edit precondition (expected_base) compares it. Rows that predate 2026-10-27 were backfilled from updated_at (an upper bound on their last edit).' AFTER `updated_at`, ALGORITHM=INSTANT;
ALTER TABLE `email_ingest_rules` MODIFY COLUMN `definition_updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'THE EDIT STAMP: last real definition change (the rule fields or any of its action rows). Every match bumps updated_at; this column is the edit stamp. Set only by services/ingestRuleChangeLog.js, inside the edit transaction, strictly increasing; the stale-edit precondition (expected_base) compares it. Rows that predate 2026-10-27 were backfilled from updated_at (an upper bound on their last edit).', ALGORITHM=INSTANT;
START TRANSACTION;
UPDATE `email_ingest_rules` SET `definition_updated_at` = `updated_at`, `updated_at` = `updated_at` WHERE `definition_updated_at` = '2000-01-01 00:00:00.000';
-- (the script re-reads the rows here and ROLLS BACK unless every updated_at is unchanged)
COMMIT;
ALTER TABLE `email_ingest_rules` MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'NOT an edit stamp: ON UPDATE moves it on every match (the match_count bump), and an action edit never moves it. The edit stamp is definition_updated_at.', ALGORITHM=INSTANT;
CREATE TABLE IF NOT EXISTS `email_ingest_rule_changes` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `rule_id` int unsigned NOT NULL COMMENT 'email_ingest_rules.id. No FK: the row outlives a deleted rule',
  `change_kind` varchar(20) NOT NULL COMMENT 'create|update|activate|deactivate|delete|duplicate|action_add|action_update|action_delete (app-validated)',
  `action_id` int unsigned DEFAULT NULL COMMENT 'the email_ingest_rule_actions row, for the action_* kinds',
  `duplicated_from_rule_id` int unsigned DEFAULT NULL COMMENT 'duplicate: the source rule',
  `actor_user_id` int DEFAULT NULL COMMENT 'users.user of a staff JWT; NULL for an API key',
  `actor_key_id` int DEFAULT NULL COMMENT 'api_keys.id of a machine caller; NULL for staff and the internal key',
  `actor_label` varchar(255) DEFAULT NULL COMMENT 'the username, or api_key:<label>',
  `changed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `definition_updated_at` datetime(3) DEFAULT NULL COMMENT 'the rule edit stamp AFTER this change; NULL for delete',
  `before_json` json DEFAULT NULL COMMENT '{rule, actions} before; NULL for create and duplicate. http url and literal header values redacted; over 256 KB a size + sha256 marker',
  `after_json` json DEFAULT NULL COMMENT '{rule, actions} after; NULL for delete. Same redaction and cap',
  PRIMARY KEY (`id`),
  KEY `idx_rule_changed` (`rule_id`,`changed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='APPEND-ONLY change log of email ingest rule definitions: one row per real change (the rule fields or its action rows), before and after, with the actor, written inside the edit transaction (services/ingestRuleChangeLog.js). The app never UPDATEs or DELETEs a row.';

-- ── phone ──
ALTER TABLE `phone_ingest_rules` ADD COLUMN `definition_updated_at` DATETIME(3) NOT NULL DEFAULT '2000-01-01 00:00:00.000' COMMENT 'THE EDIT STAMP: last real definition change (the rule fields or any of its action rows). Every match bumps updated_at; this column is the edit stamp. Set only by services/ingestRuleChangeLog.js, inside the edit transaction, strictly increasing; the stale-edit precondition (expected_base) compares it. Rows that predate 2026-10-27 were backfilled from updated_at (an upper bound on their last edit).' AFTER `updated_at`, ALGORITHM=INSTANT;
ALTER TABLE `phone_ingest_rules` MODIFY COLUMN `definition_updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'THE EDIT STAMP: last real definition change (the rule fields or any of its action rows). Every match bumps updated_at; this column is the edit stamp. Set only by services/ingestRuleChangeLog.js, inside the edit transaction, strictly increasing; the stale-edit precondition (expected_base) compares it. Rows that predate 2026-10-27 were backfilled from updated_at (an upper bound on their last edit).', ALGORITHM=INSTANT;
START TRANSACTION;
UPDATE `phone_ingest_rules` SET `definition_updated_at` = `updated_at`, `updated_at` = `updated_at` WHERE `definition_updated_at` = '2000-01-01 00:00:00.000';
-- (the script re-reads the rows here and ROLLS BACK unless every updated_at is unchanged)
COMMIT;
ALTER TABLE `phone_ingest_rules` MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'NOT an edit stamp: ON UPDATE moves it on every match (the match_count bump), and an action edit never moves it. The edit stamp is definition_updated_at.', ALGORITHM=INSTANT;
CREATE TABLE IF NOT EXISTS `phone_ingest_rule_changes` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `rule_id` int unsigned NOT NULL COMMENT 'phone_ingest_rules.id. No FK: the row outlives a deleted rule',
  `change_kind` varchar(20) NOT NULL COMMENT 'create|update|activate|deactivate|delete|duplicate|action_add|action_update|action_delete (app-validated)',
  `action_id` int unsigned DEFAULT NULL COMMENT 'the phone_ingest_rule_actions row, for the action_* kinds',
  `duplicated_from_rule_id` int unsigned DEFAULT NULL COMMENT 'duplicate: the source rule',
  `actor_user_id` int DEFAULT NULL COMMENT 'users.user of a staff JWT; NULL for an API key',
  `actor_key_id` int DEFAULT NULL COMMENT 'api_keys.id of a machine caller; NULL for staff and the internal key',
  `actor_label` varchar(255) DEFAULT NULL COMMENT 'the username, or api_key:<label>',
  `changed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `definition_updated_at` datetime(3) DEFAULT NULL COMMENT 'the rule edit stamp AFTER this change; NULL for delete',
  `before_json` json DEFAULT NULL COMMENT '{rule, actions} before; NULL for create and duplicate. http url and literal header values redacted; over 256 KB a size + sha256 marker',
  `after_json` json DEFAULT NULL COMMENT '{rule, actions} after; NULL for delete. Same redaction and cap',
  PRIMARY KEY (`id`),
  KEY `idx_rule_changed` (`rule_id`,`changed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='APPEND-ONLY change log of phone ingest rule definitions: one row per real change (the rule fields or its action rows), before and after, with the actor, written inside the edit transaction (services/ingestRuleChangeLog.js). The app never UPDATEs or DELETEs a row.';

-- ── ROLLBACK (before the backend that needs it is rolled back too) ──────────
-- Drops the log (its rows are the only copy of rule history — export first if
-- any matter) and the stamp; the updated_at comment is harmless to keep, but
-- the statement restores the original definition. Each line is one statement;
-- tests/ingestRuleEditStampMigration.test.js runs exactly these.
--   DROP TABLE IF EXISTS `email_ingest_rule_changes`;
--   DROP TABLE IF EXISTS `phone_ingest_rule_changes`;
--   ALTER TABLE `email_ingest_rules` DROP COLUMN `definition_updated_at`, ALGORITHM=INSTANT;
--   ALTER TABLE `phone_ingest_rules` DROP COLUMN `definition_updated_at`, ALGORITHM=INSTANT;
--   ALTER TABLE `email_ingest_rules` MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, ALGORITHM=INSTANT;
--   ALTER TABLE `phone_ingest_rules` MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, ALGORITHM=INSTANT;
-- (a DROP COLUMN fails if the column is absent — run only the lines that apply)
