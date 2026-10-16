-- 2026-10-16 — ui-custom S6c: ui_config.config_key COMMENT names the firm `layout` key
--
-- S6c-1+2 adds firm default layouts (config_key 'layout' at scope firm).
-- COMMENT-only; definition unchanged. Column-only, so ALGORITHM=INSTANT applies
-- (proven on 8.4.11 for a column comment by the 2026-10-16 reviews).
--
-- APPLIED BY: node scripts/uiCustomS6cConfigKeyComment.js --apply
-- (one session: lock_wait_timeout = 5, the live definition and the old comment
-- asserted first, verified after). Not for the SU console.

SET SESSION lock_wait_timeout = 5;
ALTER TABLE `ui_config` MODIFY COLUMN `config_key` varchar(50)
  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
  COMMENT 'app-validated per scope (lib/uiConfigShape.js CONFIG_KEYS): firm registry_overrides, layout | user layout, shortcuts, items, prefs',
  ALGORITHM=INSTANT;
