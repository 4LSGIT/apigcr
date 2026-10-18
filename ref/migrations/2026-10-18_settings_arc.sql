-- 2026-10-18 — settings / config-split arc: app_settings_versions, the
-- app_settings metadata COMMENTs, pabbly_internal_url flagged secret, two test
-- rows deleted (stage 1, BEFORE the deploy); the two retired rollout flags
-- deleted (stage 2, AFTER the deploy).
--
-- APPLIED BY: node scripts/settingsArcMigrate.js [--apply] and
--             node scripts/settingsArcMigrate.js --stage2 [--apply]
-- (ONE session: lock_wait_timeout = 5 before any ALTER; every column
-- definition, comment, row flag and row value asserted first; resumable;
-- the row changes in one transaction, each asserting it hit exactly one row;
-- verified after, with the route's version INSERT in a rolled-back
-- transaction). Not for the SU console: /admin/db/batch spreads statements over
-- pooled connections, so the session setting would not reach the ALTERs.
-- This file RECORDS the statements; tests/settingsArcMigrate.test.js holds it
-- identical to the script's.
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ ORDER: stage 1 → land + deploy the settings arc backend → stage 2.       │
-- │ The arc's routes/api.appSettings.js writes app_settings_versions in the  │
-- │ same transaction as every settings change: deployed before stage 1,      │
-- │ every settings save fails (500, rolled back — nothing half-written).    │
-- │ The old backend never names the table. Stage 2 deletes rows the OLD      │
-- │ code still reads (unified_singleton_enabled → off when missing,          │
-- │ esign_webhook_hmac_mode → its default): the script refuses it until      │
-- │ this checkout stops naming them and the live build is newer than the     │
-- │ arc's commits (GET /api/version mtime).                                  │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- app_settings: lib/settingsRegistry.js now owns every key the code reads; the
-- metadata columns (is_editable, category, label, description, type,
-- sort_order) describe UNREGISTERED rows only — their comments say so, and
-- is_editable's 'exposed in settings.html' is false after this arc.
-- is_secret's comment ('never returned by any settings API') stays: still true.
-- `key` gains the collation landmine: utf8mb4_general_ci PAD SPACE ignores case
-- and trailing spaces while lib/settingsRegistry.js matches exactly (review F1,
-- 2026-10-18 — an alias spelling walked past the per-key gates).
-- Column ALTER: definitions restated exactly (asserted first), INSTANT —
-- metadata only, refused rather than a rebuild. Table comment: INPLACE,
-- LOCK=NONE (8.4 refuses INSTANT for a table comment, error 1845).
-- pabbly_internal_url: a webhook URL with a key in its query string — the
-- registry already calls it a secret; now the row flag agrees. Its value is
-- never read by the script (key / is_secret only).
-- gate_probe / fe-gate_probe: leftover test rows; deleted only when they hold
-- exactly 'hello' / 'hello2' (the script prints each row before deleting it).
-- Stage 1 also refuses (NO-GO, nothing written) while a retired flag holds
-- anything but its final value: the arc's code behaves as that value, so
-- deploying it would change behaviour.

-- ═══ STAGE 1 — BEFORE the deploy ══════════════════════════════════════════

SET SESSION lock_wait_timeout = 5;

CREATE TABLE `app_settings_versions` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `setting_key` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'app_settings.key the change was to (no foreign key: the history outlives a deleted row)',
  `old_value` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL COMMENT 'The value before this change; NULL = there was no row (a create, or the first write of a registered key) or it held NULL. Restore puts this back (NULL as an empty string).',
  `new_value` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL COMMENT 'The value this change stored.',
  `changed_by` tinyint NULL COMMENT 'users.user of the staff JWT that made the change; NULL = a machine key (x-api-key)',
  `changed_via` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'ui (staff PUT) | api_key (machine PUT) | create (POST) | restore. App-validated.',
  `changed_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'When the change was made.',
  PRIMARY KEY (`id`),
  KEY `idx_app_settings_versions_key` (`setting_key`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Change history of app_settings values: one row per value change made through routes/api.appSettings.js (PUT, POST create, restore), written in the same transaction as the change; none when a save left the value unchanged. Never holds a secret: those routes never write one. Writes made elsewhere (automation set_setting / update_db, runtime state, key rotation, the SU db console) are not recorded.';

ALTER TABLE `app_settings`
  MODIFY COLUMN `key` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'The setting''s name; the primary key. utf8mb4_general_ci PAD SPACE: a lookup ignores case and trailing spaces (WHERE `key` = ''Firm_Name '' reads the firm_name row), and two keys that differ only so cannot coexist. lib/settingsRegistry.js matches keys exactly, so code that judges a key by name compares the row''s own key with it byte for byte (routes/api.appSettings.js, set_setting / get_setting).',
  MODIFY COLUMN `is_editable` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'UNREGISTERED rows only (keys not in lib/settingsRegistry.js, the automation variables): 1 = listed and editable in YisraCase Config, Firm tab, Automation variables; 0 = served by no settings API. Ignored for a registered key: its edit posture comes from the registry.',
  MODIFY COLUMN `category` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL COMMENT 'UNREGISTERED rows only: the grouping shown with an automation variable. A registered key takes its section from lib/settingsRegistry.js; this column is ignored for it.',
  MODIFY COLUMN `label` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL COMMENT 'UNREGISTERED rows only: display label (blank = the key). Registered keys take theirs from lib/settingsRegistry.js.',
  MODIFY COLUMN `description` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL COMMENT 'UNREGISTERED rows only: the operator hint. Registered keys take theirs from lib/settingsRegistry.js.',
  MODIFY COLUMN `type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL COMMENT 'UNREGISTERED rows only: the validator type (string, template, number, bool, email, csv, phone, url, json, json_array, date; anything else is stored verbatim). A registered key validates by its lib/settingsRegistry.js type.',
  MODIFY COLUMN `sort_order` int NULL DEFAULT NULL COMMENT 'UNREGISTERED rows only: the order among the automation variables. Registered keys take theirs from lib/settingsRegistry.js.',
  ALGORITHM=INSTANT;

ALTER TABLE `app_settings` COMMENT = 'Key / value settings. lib/settingsRegistry.js owns every key the code reads (kind, editor home, type, label, edit posture); for those rows only key, value, is_secret and updated_at carry meaning. The metadata columns describe UNREGISTERED rows: the automation variables created in YisraCase Config, Firm tab. Value history: app_settings_versions.', ALGORITHM=INPLACE, LOCK=NONE;

START TRANSACTION;

UPDATE `app_settings` SET `is_secret` = 1 WHERE `key` = 'pabbly_internal_url' AND `is_secret` = 0;

DELETE FROM `app_settings` WHERE `key` = 'gate_probe' AND `value` COLLATE utf8mb4_bin = 'hello' AND `is_secret` = 0;

DELETE FROM `app_settings` WHERE `key` = 'fe-gate_probe' AND `value` COLLATE utf8mb4_bin = 'hello2' AND `is_secret` = 0;

COMMIT;

-- ═══ STAGE 2 — AFTER the deploy ═══════════════════════════════════════════
-- The rollout flags retire at their final value (Fred, 2026-10-17): the arc's
-- code always behaves as unified_singleton_enabled = '1' and
-- esign_webhook_hmac_mode = 'enforce'. Deleted only when they hold exactly
-- those values (the script prints each row before deleting it).

START TRANSACTION;
DELETE FROM `app_settings` WHERE `key` = 'unified_singleton_enabled' AND `value` COLLATE utf8mb4_bin = '1' AND `is_secret` = 0;
DELETE FROM `app_settings` WHERE `key` = 'esign_webhook_hmac_mode' AND `value` COLLATE utf8mb4_bin = 'enforce' AND `is_secret` = 0;
COMMIT;

-- ═══ ROLLBACK (not expected) ══════════════════════════════════════════════
-- Stage 2 — BEFORE rolling the backend back to a pre-arc build (the old code
-- reads these; missing, it behaves as off / its default). The old code reads
-- only the value; the other columns as the --stage2 --apply output recorded:
--
-- INSERT INTO `app_settings` (`key`, `value`, `is_secret`) VALUES ('unified_singleton_enabled', '1', 0);
-- INSERT INTO `app_settings` (`key`, `value`, `is_secret`) VALUES ('esign_webhook_hmac_mode', 'enforce', 0);
--
-- Stage 1 — the row changes (pabbly_internal_url was is_secret = 0 before; the
-- test rows' full contents are in the --apply output if anyone wants them):
--
-- UPDATE `app_settings` SET `is_secret` = 0 WHERE `key` = 'pabbly_internal_url';
--
-- Stage 1 — the comments (metadata only; any time):
--
-- SET SESSION lock_wait_timeout = 5;
-- ALTER TABLE `app_settings`
--   MODIFY COLUMN `key` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '',
--   MODIFY COLUMN `is_editable` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'exposed in settings.html',
--   MODIFY COLUMN `category` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL COMMENT '',
--   MODIFY COLUMN `label` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL COMMENT '',
--   MODIFY COLUMN `description` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL COMMENT '',
--   MODIFY COLUMN `type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL COMMENT '',
--   MODIFY COLUMN `sort_order` int NULL DEFAULT NULL COMMENT '',
--   ALGORITHM=INSTANT;
-- ALTER TABLE `app_settings` COMMENT = '', ALGORITHM=INPLACE, LOCK=NONE;
--
-- Stage 1 — the history table: ONLY once the backend is a pre-arc build again
-- (the arc's routes write it on every settings change), and it drops the
-- history with it:
--
-- DROP TABLE `app_settings_versions`;
