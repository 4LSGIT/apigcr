-- Access-control A5 — the entitlement_denies table (ref/ACCESS_CONTROL_DESIGN.md §2.6).
-- Applied via scripts/accessA5Entitlements.js (one connection, session
-- lock_wait_timeout=5; CHECK + --apply, resumable; a table already present in
-- any other shape is a NO-GO, never altered). Verified on MySQL 8.4.11 (same
-- as production) before shipping.
--
-- Deploy order: THIS, then land + deploy A5 (SQL → backend → frontend).
--
-- Deny-only rows: absent = allowed, any matching row denies — deny-wins and
-- default-allow fall out of the shape. scope_ref '' = firm: NOT NULL so the
-- UNIQUE holds (InnoDB treats NULLs as distinct), the same sentinel spelling
-- as ui_config's role column. Collation spelled out (ref/SCHEMA_CONVENTIONS.md).

CREATE TABLE IF NOT EXISTS `entitlement_denies` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `scope` enum('firm','role','user') NOT NULL COMMENT 'firm = everyone; role = holders of scope_ref; user = users.user scope_ref',
  `scope_ref` varchar(64) NOT NULL DEFAULT '' COMMENT 'empty string = firm (sentinel; NOT NULL so the UNIQUE holds); role = a users.roles SET member; user = users.user as digits',
  `item_key` varchar(64) NOT NULL COMMENT 'public/js/featureRegistry.js key — validated at write; moreSettings/helpSupport refused (undeniable)',
  `created_by` tinyint NOT NULL COMMENT 'users.user of the writer; 0 = an x-api-key caller',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_entitlement_denies_scope_item` (`scope`,`scope_ref`,`item_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Launcher entitlement DENIES (access-control A5). Deny-only: absent = allowed; any matching row denies. Visibility-only in v2 — no route enforcement.';
