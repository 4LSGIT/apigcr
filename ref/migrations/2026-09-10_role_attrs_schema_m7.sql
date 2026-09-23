-- ref/migrations/2026-09-10_role_attrs_schema_m7.sql
--
-- Contact-roles arc m7 — structured role attributes:
--   1) contact_role_types.attrs_schema (json) — declares each role's attr
--      fields; the contact form renders the role card from it.
--   2) contact_roles.attrs.chapter normalized from scalar to ARRAY, so one
--      trustee role can carry several chapters (McDonald [12,13],
--      Shapiro [7,11]) and lib/trusteeRoster explodes one entry per chapter.
-- BACKFILLED 2026-09-23; APPLIED LIVE 2026-09-09/10. Reconstructed after the
-- fact from ref/database.sql and a live read of contact_role_types; statement
-- text may differ in inessentials from what was actually run.
--
-- Every statement is STANDALONE (DB console runs each on its own pooled
-- connection).

ALTER TABLE `contact_role_types`
  ADD COLUMN `attrs_schema` json DEFAULT NULL AFTER `label`;

-- attrs_schema values as read live 2026-09-23.
UPDATE contact_role_types
   SET attrs_schema = '[{"key":"judge_3","type":"text","label":"Docket suffix (3-letter)","required":true,"placeholder":"lsg"}]'
 WHERE role_code = 'judge';

UPDATE contact_role_types
   SET attrs_schema = '[{"key":"chapter","type":"multi_select","label":"Chapters","options":[7,11,12,13],"required":true},{"key":"zoom_link","type":"url","label":"341 Zoom link","required":false,"placeholder":"https://…zoom.us/j/…"}]'
 WHERE role_code = 'trustee';

-- Chapter scalar → array (idempotent: only touches non-array, non-null
-- chapters). After this, attrs.chapter is ALWAYS an array on trustee roles.
UPDATE contact_roles
   SET attrs = JSON_SET(attrs, '$.chapter', JSON_ARRAY(JSON_EXTRACT(attrs, '$.chapter')))
 WHERE role = 'trustee'
   AND JSON_EXTRACT(attrs, '$.chapter') IS NOT NULL
   AND JSON_TYPE(JSON_EXTRACT(attrs, '$.chapter')) <> 'ARRAY';
