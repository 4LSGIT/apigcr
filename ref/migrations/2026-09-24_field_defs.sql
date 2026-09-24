-- ref/migrations/2026-09-24_field_defs.sql
--
-- Custom-fields arc S1 — the `field_defs` registry (ref/CUSTOM_FIELDS_DESIGN.md
-- §2–§3). One row per admin-defined field on an entity. S1 creates the table
-- and its editor ONLY: no `custom` storage columns (S2), no virtual columns
-- (S3), no consumers (S4). After this runs the table is empty and nothing
-- writes it except POST/PATCH /api/field-defs (routes/api.fieldDefs.js).
--
-- DEPLOY ORDER: run this BEFORE the backend that ships routes/api.fieldDefs.js
-- (SQL → backend → frontend). The settings page's Custom Fields section calls
-- GET /api/field-defs on load; without the table that GET 500s.
--
-- CONVENTIONS (ref/SCHEMA_CONVENTIONS.md): explicit COLLATE on the table AND
-- the varchar columns — `DEFAULT CHARSET=utf8mb4` alone silently resets to
-- utf8mb4_0900_ai_ci and the table could never be joined to the core tables.
-- sql_mode is non-strict: every value here is validated at the door by
-- services/fieldDefService.js (over-length writes would otherwise truncate).
--
-- No `sensitive` column in v1 — deliberately (design doc §2 "Policy wiring",
-- revised after the 2026-09-24 SSN ruling). Do not add one without a
-- demonstrated need that defines its semantics.
--
-- STANDALONE statement (the DB console runs each on its own pooled connection).
--
-- After applying:  npm run db:ref   (regenerates ref/database.sql)
--                  npm run db:ref:check   (must report no drift)

CREATE TABLE `field_defs` (
  `id`          int unsigned NOT NULL AUTO_INCREMENT,
  `entity`      varchar(20) COLLATE utf8mb4_general_ci NOT NULL
                COMMENT 'case | contact (v1 set; app-validated — sql_mode is non-strict). IMMUTABLE after create.',
  `field_key`   varchar(64) COLLATE utf8mb4_general_ci NOT NULL
                COMMENT '^cf_[a-z][a-z0-9_]{1,60}$ — becomes the JSON path in <entity>.custom (S2) AND the VIRTUAL column name on the entity table (S3). IMMUTABLE after create; must not collide with a real column (checked at create).',
  `label`       varchar(100) COLLATE utf8mb4_general_ci NOT NULL,
  `field_type`  varchar(20) COLLATE utf8mb4_general_ci NOT NULL
                COMMENT 'text | number | date | select | multiselect | boolean (v1 set; app-validated). Drives the S3 virtual column type (design doc §2 type map).',
  `options`     json DEFAULT NULL
                COMMENT 'select/multiselect ONLY (NULL otherwise): [{"value","label"}]. value is the STORED form — byte-sensitive under MEMBER OF, so values are not labels. Unique case-insensitively.',
  `validation`  json DEFAULT NULL
                COMMENT 'v1 keys: required, max_len, pattern (text), min, max (number). Enforced at write time from S2; S1 only stores it.',
  `show_when`   json DEFAULT NULL
                COMMENT 'Conditional display. STORED, NOT EVALUATED until S4 — an object, otherwise uninterpreted.',
  `indexed`     tinyint(1) NOT NULL DEFAULT '0'
                COMMENT 'Promotion flag for the S3 reconciler (secondary index on the virtual column). Not writable through the v1 API.',
  `sort_order`  smallint NOT NULL DEFAULT '0',
  `active`      tinyint(1) NOT NULL DEFAULT '1'
                COMMENT 'active=0 is RETIREMENT — there is no hard delete. Values already stored under the key persist in the JSON by design.',
  `created_at`  datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_field_defs_entity_key` (`entity`, `field_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Custom-fields registry (ref/CUSTOM_FIELDS_DESIGN.md). Single source of truth for admin-defined fields; read through services/fieldDefService.js (cached).';
