-- Documents S3.3 — guided re-link
-- APPLY BEFORE DEPLOYING THE BACKEND.
--
-- relink_dismissed_by is TINYINT, not INT: it references users.user, which is
-- `tinyint`. (log.log_by is `tinyint unsigned` — the existing schema is already
-- inconsistent between the two; matching the referenced PK is the narrower and
-- more defensible choice.) Nullable because an API-key caller legitimately has
-- no user, exactly as document_links.created_by does.
--
-- No COLLATE clause is needed: neither column is a string.

ALTER TABLE case_folder_cache
  ADD COLUMN relink_dismissed_at DATETIME NULL,
  ADD COLUMN relink_dismissed_by TINYINT  NULL;
