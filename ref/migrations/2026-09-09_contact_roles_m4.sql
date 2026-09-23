-- ref/migrations/2026-09-09_contact_roles_m4.sql
--
-- Contact-roles arc m4 — the role axis: contact_role_types + contact_roles.
-- BACKFILLED 2026-09-23; APPLIED LIVE 2026-09-09. This file was reconstructed
-- after the fact from ref/database.sql (plus a live read of the role-type
-- rows), committed so the arc's schema history lives in the repo. Statement
-- text may differ in inessentials (column order, exact seed wording) from
-- what was actually typed into the console on 2026-09-09.
--
-- NOTE: attrs_schema on contact_role_types is NOT here — m7 added it
-- (2026-09-10_role_attrs_schema_m7.sql).
--
-- Every statement is STANDALONE (DB console runs each on its own pooled
-- connection: no session variables, no transactions).

CREATE TABLE `contact_role_types` (
  `role_code` varchar(40) COLLATE utf8mb4_general_ci NOT NULL,
  `label` varchar(60) COLLATE utf8mb4_general_ci NOT NULL,
  `sort_order` smallint NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`role_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `contact_roles` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `contact_id` int unsigned NOT NULL,
  `role` varchar(40) COLLATE utf8mb4_general_ci NOT NULL,
  `attrs` json DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` smallint NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_contact_role` (`contact_id`,`role`),
  KEY `idx_role_active` (`role`,`active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Seed role types (labels/sort as read live 2026-09-23; attrs_schema landed
-- in m7).
INSERT INTO contact_role_types (role_code, label, sort_order, active)
VALUES ('judge', 'Judge', 10, 1);

INSERT INTO contact_role_types (role_code, label, sort_order, active)
VALUES ('trustee', 'Trustee', 20, 1);

-- Role rows themselves (24 active trustee, 7 active judge as of decommission)
-- were seeded by scripts/seedRoleContacts.js from the fe-trustees setting and
-- the judges table — not by hand-written INSERTs here.
