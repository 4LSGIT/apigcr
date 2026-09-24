-- ref/migrations/2026-09-24_field_key_comment.sql
--
-- Custom-fields arc S3, step 0.5 — the field_defs.field_key COMMENT follows
-- the tightened key regex (ref/CUSTOM_FIELDS_DESIGN.md §3 namespace line).
--
-- WHY: services/fieldDefService.js KEY_RE went from ^cf_[a-z][a-z0-9_]{1,60}$
-- to ^cf_[a-z][a-z0-9_]{1,56}$ (60 chars max). The S3 reconciler names its
-- index `idx_<key>`; with a 64-char key that is 68 chars — over MySQL's
-- 64-char identifier cap, ERROR 1059 at reconcile time. The column stays
-- varchar(64): only the documented rule changes, so the COMMENT (which flows
-- into ref/database.sql) must say the new one. field_defs held 0 rows when
-- this shipped — no existing key can violate the new rule.
--
-- ONLINE DDL: a comment-only MODIFY is metadata-only — ALGORITHM=INSTANT
-- verified on MySQL 8.4.11 against a full ref/database.sql clone. Spelled out
-- so the engine errors instead of rebuilding if that ever stops being true.
--
-- DEPLOY ORDER: independent of the S3 backend (a comment); run it any time,
-- then regenerate ref/database.sql (the pre-commit hook does).

ALTER TABLE `field_defs`
  MODIFY `field_key` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
    COMMENT '^cf_[a-z][a-z0-9_]{1,56}$ (60 chars max, so the S3 index name idx_<key> fits MySQL''s 64-char identifier cap) — the JSON path in <entity>.custom AND the VIRTUAL column name on the entity table (the S3 reconciler creates it). IMMUTABLE after create; must not collide with a real column (checked at create).',
  ALGORITHM=INSTANT;
