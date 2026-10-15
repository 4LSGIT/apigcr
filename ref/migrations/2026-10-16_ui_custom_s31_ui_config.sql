-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-16 — ui-customization arc, slice S3.1: ui_config + ui_config_versions
--   A. CREATE TABLE ui_config: the launcher's FIRM and USER config documents,
--      one row per (scope, user_id, role, config_key).
--   B. CREATE TABLE ui_config_versions: the save history of FIRM-scope rows.
--
-- WHY
--   local/ui-custom/PLAN.md §6 (storage), §7 (resolution), §8 (delivery). The
--   API is routes/api.uiConfig.js (GET/PUT /api/ui-config) over
--   services/uiConfigService.js; documents are validated by lib/uiConfigShape.js
--   (strict) before they are stored. /api/firm-data delivers `ui: { firm, user }`
--   to the shell, whose ycLauncher applies the firm overlay.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- SQL FIRST (house order). Without these tables the S3.1 backend still boots:
-- /api/firm-data reads ui_config fail-soft (ui = { firm: {}, user: {} } plus a
-- console error), GET/PUT /api/ui-config are 500s. Nothing else reads them.
--
-- ── SHAPE NOTES ─────────────────────────────────────────────────────────────
--   user_id / updated_by / saved_by  signed TINYINT — users.user's exact type
--               (FK by convention). user_id 0 = "not a user row" (firm scope).
--   user_id, role  NOT NULL sentinels (0, '') are LOAD-BEARING: MySQL unique
--               indexes never collide on NULL, so a nullable user_id/role would
--               let two firm rows for one config_key coexist. Do not "clean
--               this up" to NULLs.
--   scope       ENUM('system','firm','user'). sql_mode is RELAXED in this
--               database (no STRICT_TRANS_TABLES — ref/INFRA_GCP.md §7): an
--               invalid ENUM value is stored as '' with a WARNING, not
--               rejected. The app layer is the only real validator. 'system'
--               is reserved: the platform tier is code (public/js/featureRegistry.js),
--               writes refuse it.
--   role        RESERVED ('' only) until a role model lands (PLAN §4.8);
--               writes refuse anything else.
--   config      JSON. MySQL re-orders object keys on write: compare stored vs
--               new documents key-order-insensitively (the service does).
--   ui_config_versions  one row per FIRM-scope save holding the NEW document
--               (routes/api.tools.js convention: newest version row == the
--               current row; no row when the document is unchanged). User
--               scope is not versioned. ON DELETE CASCADE from ui_config.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS; plain CREATE on new tables needs no session
-- settings, so this is a plain .sql file (SU DB console is fine).
-- After applying: npm run db:ref (or let the pre-commit hook do it).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ui_config (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope ENUM('system','firm','user') NOT NULL COMMENT 'firm = everyone (user_id 0); user = one user (user_id = users.user); system RESERVED (refused at write - the platform tier is code). sql_mode is relaxed here: an invalid value is stored as empty string with a warning, NOT rejected - the app layer (lib/uiConfigShape.js) is the only real validator',
  user_id TINYINT NOT NULL DEFAULT 0 COMMENT 'users.user (signed tinyint, FK by convention) for scope user; sentinel 0 for scope firm. NOT NULL is load-bearing: MySQL unique indexes never collide on NULL, so a nullable user_id would allow duplicate firm rows',
  role VARCHAR(20) NOT NULL DEFAULT '' COMMENT 'RESERVED: empty string only until a role model lands (writes refuse anything else). NOT NULL sentinel is load-bearing for uq_ui_config_scope, same reason as user_id',
  config_key VARCHAR(50) NOT NULL COMMENT 'app-validated per scope: firm registry_overrides | user shortcuts (lib/uiConfigShape.js CONFIG_KEYS)',
  config JSON NOT NULL COMMENT 'the normalized document lib/uiConfigShape.js returned. MySQL re-orders object keys on write - compare key-order-insensitively',
  updated_by TINYINT NULL COMMENT 'users.user of the last writer (staff JWT only)',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ui_config_scope (scope, user_id, role, config_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='ui-custom launcher config documents (PLAN §6): firm overlay + per-user layers, delivered by /api/firm-data ui and GET /api/ui-config, written by PUT /api/ui-config. Firm writes are versioned in ui_config_versions; user writes are not.';

CREATE TABLE IF NOT EXISTS ui_config_versions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ui_config_id INT UNSIGNED NOT NULL COMMENT 'ui_config.id (FK, ON DELETE CASCADE)',
  config_key VARCHAR(50) NOT NULL COMMENT 'copy of ui_config.config_key at save time',
  config JSON NOT NULL COMMENT 'the NEW document saved - the newest row equals ui_config.config (routes/api.tools.js versioning convention); no row when a save left the document unchanged',
  saved_by TINYINT NULL COMMENT 'users.user of the writer',
  saved_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ui_config_versions_config (ui_config_id, id),
  CONSTRAINT fk_ui_config_versions_config FOREIGN KEY (ui_config_id) REFERENCES ui_config (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Save history of FIRM-scope ui_config rows: one row per firm save that changed the document, holding the new document. User scope is not versioned (PLAN §6).';
