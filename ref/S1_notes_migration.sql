-- S1 — notes/checklists merge. Run these FOUR statements one at a time,
-- in this order, in the DB console.
--
-- ORDER IS LOAD-BEARING. uq_link_kind_tag is strictly WEAKER than uq_link_tag
-- (same columns plus one), so adding it first means there is never a window
-- in which duplicate protection is absent. Dropping first would open one.
--
-- Single statements, no session variables, no cross-statement transactions —
-- the console runs each on a separate connection.
--
-- The 270 existing rows take kind='checklist' from the DEFAULT. No backfill.
-- KEY idx_link (link_type, link) is a SEPARATE index and is untouched.
--
-- After all four: run `npm run db:ref` to regenerate ref/database.sql,
-- which tests/schemaConventions.test.js lints.

-- 1 of 4
ALTER TABLE checklists
  ADD COLUMN kind ENUM('checklist','note')
    COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'checklist' AFTER title;

-- 2 of 4
ALTER TABLE checklists
  ADD COLUMN body TEXT COLLATE utf8mb4_general_ci NULL AFTER kind;

-- 3 of 4
ALTER TABLE checklists
  ADD UNIQUE KEY uq_link_kind_tag (link_type, link, kind, tag);

-- 4 of 4
ALTER TABLE checklists DROP INDEX uq_link_tag;

-- Verification (expect uq_link_kind_tag present, uq_link_tag absent,
-- idx_link still there):
--   SHOW CREATE TABLE checklists;
