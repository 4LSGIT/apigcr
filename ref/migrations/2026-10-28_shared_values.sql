-- Shared values — staff-writable namespaces (settings-access arc, 2026-10-28).
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ DEPLOY ORDER — THE HOUSE ORDER: THIS FIRST, THEN THE CODE.               │
-- │   1. node scripts/sharedValuesMigrate.js            (CHECK)              │
-- │   2. node scripts/sharedValuesMigrate.js --apply                          │
-- │   3. land + deploy routes/api.shared.js                                   │
-- │ Two NEW tables; nothing existing is altered. The old backend never names │
-- │ them, so running this first is safe; the new backend's routes 500 until  │
-- │ they exist.                                                              │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- Run through the script, not the SU console: it sets lock_wait_timeout on its
-- own connection, refuses a pre-existing table of another shape, verifies the
-- end state from information_schema, and resumes after a partial run.
--
-- ns / k are utf8mb4_bin (SCHEMA_CONVENTIONS "the one exception"): under
-- general_ci 'Score' and 'score' are the same key. utf8mb4_bin is still PAD
-- SPACE ('x' = 'x ' — verified on 8.4.11), so it is the route's pattern
-- ^[a-z0-9][a-z0-9_-]{0,63}$ (no spaces, lowercase only) that keeps every
-- stored name distinct. The tables themselves stay general_ci. Once applied and `npm run db:ref` has regenerated the dump, the
-- three bin columns join tests/schemaCollationBin.test.js BIN_COLUMNS.

CREATE TABLE `shared_namespaces` (
  `ns` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'namespace name, ^[a-z0-9][a-z0-9_-]{0,63}$ (route-enforced); utf8mb4_bin so case never folds two names together (it is still PAD SPACE, so trailing spaces would: the pattern refusing spaces keeps every name distinct)',
  `description` varchar(500) DEFAULT NULL COMMENT 'what the namespace is for (free text, shown in listings)',
  `write_mode` enum('staff','creator','own_key') NOT NULL DEFAULT 'staff' COMMENT 'who may write values: staff = any staff; creator = created_by or a firm.settings holder; own_key = each user only the key equal to their users.user (firm.settings any). App-validated (relaxed sql_mode stores an unknown value as an empty string, which writes refuse)',
  `max_value_bytes` int unsigned NOT NULL DEFAULT 65536 COMMENT 'largest value (UTF-8 bytes) a write may store; refused at the route BEFORE SQL (relaxed sql_mode would truncate silently). 1..1048576',
  `max_keys` int unsigned NOT NULL DEFAULT 1000 COMMENT 'most keys the namespace may hold; a create beyond it is refused. 1..10000',
  `created_by` tinyint NOT NULL COMMENT 'users.user who created it (manages it, with firm.settings holders)',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`ns`)
) ENGINE=InnoDB COMMENT='Shared values: staff-created namespaces of staff-written key/value pairs (routes/api.shared.js). Values are UNTRUSTED text: render with textContent, never as HTML. Not config: app_settings is.';

CREATE TABLE `shared_values` (
  `ns` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'shared_namespaces.ns (FK, cascade delete)',
  `k` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'key within the namespace, ^[a-z0-9][a-z0-9_-]{0,63}$ (route-enforced); utf8mb4_bin',
  `v` mediumtext NOT NULL COMMENT 'the value, verbatim (UNTRUSTED staff-written text; size capped per namespace by the route)',
  `rev` int unsigned NOT NULL DEFAULT 1 COMMENT 'compare-and-set revision: 1 on create, +1 per write; a write names the rev it read and is refused (409) when it moved',
  `updated_by` tinyint NOT NULL COMMENT 'users.user of the last writer, stamped by the server from the JWT (a live View-as: the target user)',
  `updated_act` tinyint DEFAULT NULL COMMENT 'users.user of the human behind a live View-as session that made the last write; NULL otherwise',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`ns`, `k`),
  CONSTRAINT `fk_shared_values_ns` FOREIGN KEY (`ns`) REFERENCES `shared_namespaces` (`ns`) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Shared values (routes/api.shared.js): one row per key. UNTRUSTED staff-written text — render with textContent. Kept out of update_db / insert_db / query_db.';
