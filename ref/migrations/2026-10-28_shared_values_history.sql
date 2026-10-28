-- Shared values — write history (the Shared values admin page, 2026-10-28).
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ DEPLOY ORDER — THE HOUSE ORDER: THIS FIRST, THEN THE CODE.               │
-- │   1. node scripts/sharedValuesHistoryMigrate.js            (CHECK)       │
-- │   2. node scripts/sharedValuesHistoryMigrate.js --apply                   │
-- │   3. land + deploy the history code (services/sharedValuesService.js)     │
-- │ One NEW table; nothing existing is altered. The old backend never names  │
-- │ it, so running this first is safe. The new backend writes a history row  │
-- │ in every shared-values write's transaction, so its writes fail (rolled   │
-- │ back, nothing half-done) until the table exists.                         │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- Run through the script, not the SU console: it sets lock_wait_timeout on its
-- own connection, refuses a pre-existing table of another shape, verifies the
-- end state from information_schema, and resumes after a partial run.
--
-- ns / k are utf8mb4_bin like the source columns (SCHEMA_CONVENTIONS "the one
-- exception"). No foreign key: the history outlives a deleted namespace. Once
-- applied and the dump has regenerated, the two bin columns join
-- tests/schemaCollationBin.test.js BIN_COLUMNS.

CREATE TABLE `shared_values_history` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `ns` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'shared_namespaces.ns at the time of the write (no FK: history outlives a deleted namespace); utf8mb4_bin like the source column',
  `k` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'shared_values.k; NULL = a namespace event (ns_create / ns_update / ns_delete)',
  `op` enum('ns_create','ns_update','ns_delete','create','update','delete') NOT NULL COMMENT 'what the write did. App-written only (relaxed sql_mode would store an unknown value as an empty string)',
  `old_v` mediumtext DEFAULT NULL COMMENT 'before: the value (update / delete), or the namespace rules as JSON (ns_update; ns_delete adds key_count). NULL for a create. UNTRUSTED staff-written text',
  `new_v` mediumtext DEFAULT NULL COMMENT 'after: the value (create / update), or the namespace rules as JSON (ns_create / ns_update). NULL for a delete. UNTRUSTED staff-written text',
  `old_rev` int unsigned DEFAULT NULL COMMENT 'shared_values.rev before the write (update / delete); NULL otherwise',
  `new_rev` int unsigned DEFAULT NULL COMMENT 'shared_values.rev after the write (create = 1 / update); NULL otherwise',
  `changed_by` tinyint NOT NULL COMMENT 'users.user who wrote it, stamped by the server from the JWT (a live View-as: the target user)',
  `changed_act` tinyint DEFAULT NULL COMMENT 'users.user of the human behind a live View-as session; NULL otherwise',
  `changed_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_shared_values_history_ns_k_id` (`ns`, `k`, `id`),
  KEY `idx_shared_values_history_ns_id` (`ns`, `id`)
) ENGINE=InnoDB COMMENT='Shared values write history (routes/api.shared.js _history; the Shared values admin page): one row per successful write, in its transaction. UNTRUSTED staff-written text — render with textContent. No retention yet (ref/plans.md).';
