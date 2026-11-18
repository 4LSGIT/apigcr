-- ref/migrations/2026-11-19_docs_reviewer.sql
--
-- ONE reviewer for client documents, whichever door they come through (Fred,
-- 2026-11-19): the docReq page, the client portal, an email to docs@, a person
-- filing from Comms all notify the user in `email_attachments_reviewer`
-- (services/docsReviewerService). Set to SB (user 5).
--
-- The upload pages' own recipient, `portal_docs_notify_to` (a bare address,
-- 2026-08), is retired: the registry entry and the portal-settings field are
-- gone in the same commit, so the row would be unreachable — delete it. Its
-- history stays in app_settings_versions.
--
-- Deploy order: this file (SU console, allowWrite) → the code. Between the two
-- the old code still reads portal_docs_notify_to (missing row = upload emails
-- off, by its own design) — a window of minutes, no lost email: the reviewer
-- row below is read the moment the new code is up.
--
-- Then, by hand in the workflow builder (not SQL — the builder owns the step
-- rows): workflow 55 "docs@ intake", step 1 — function `docs_reviewer`,
-- output_var `reviewer`, and set_vars
--   notify_email   {{reviewer.email}}
--   notify_user_id {{reviewer.user_id}}
-- replacing the hardcoded address. Steps 4, 8, 10, 14 keep reading
-- {{notify_email}} unchanged.

INSERT INTO app_settings (`key`, `value`, is_secret)
VALUES ('email_attachments_reviewer', '5', 0)
ON DUPLICATE KEY UPDATE `value` = '5';

DELETE FROM app_settings WHERE `key` = 'portal_docs_notify_to';
