-- 2026-10-16 — ui-custom arc close: ui_config.config_key + table COMMENTs
--
-- The config_key COMMENT listed only "user shortcuts"; layout (S4a), items
-- (S5a) and prefs (S5d) followed. The table COMMENT said "launcher" documents;
-- prefs holds the theme. COMMENT-only, one ALTER; definition unchanged.
--
-- APPLIED BY: node scripts/uiCustomConfigKeyComment.js --apply
-- (one session: lock_wait_timeout = 5, the live definition and both old
-- comments asserted first, ALGORITHM=INPLACE LOCK=NONE — INSTANT is refused for a
-- table comment on 8.4 (error 1845) — verified after). Not for the SU
-- console: /admin/db/batch spreads statements over pooled connections.

SET SESSION lock_wait_timeout = 5;
ALTER TABLE `ui_config` MODIFY COLUMN `config_key` varchar(50)
  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
  COMMENT 'app-validated per scope (lib/uiConfigShape.js CONFIG_KEYS): firm registry_overrides | user layout, shortcuts, items, prefs',
  COMMENT = 'ui-custom config documents (PLAN §6): the firm launcher overlay + per-user layers (layout, shortcuts, own buttons, theme prefs), delivered by /api/firm-data ui and GET /api/ui-config, written by PUT /api/ui-config. Firm writes are versioned in ui_config_versions; user writes are not.',
  ALGORITHM=INPLACE, LOCK=NONE;
