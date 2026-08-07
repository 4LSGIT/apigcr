-- 2026-08-07 Client upload fallback ladder (docReq + portal docs)
-- Run manually via DB console BEFORE deploying the code (deploy-order rule).
--
-- 1) New setting: where client uploads land when the case has no working
--    Dropbox folder and one cannot be created (uploadTargetService rung 3).
--    Files go into a per-case subfolder "{case_id} - {lfm name}".
--    LEADING SPACES IN THE VALUE ARE LOAD-BEARING (manual sort convention).
INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES
  ('dropbox_unsorted_uploads_path',
   '/  Law Office/   Cases/  Unsorted Client Uploads',
   0, 1, 'Dropbox',
   'Unsorted Client Uploads Folder',
   'Dropbox folder where client-uploaded documents land when the case has no working Dropbox folder and one cannot be created automatically. Files go into a per-case subfolder. Leading spaces are load-bearing (manual sort ordering) — preserved verbatim.',
   'string', 40);

-- 2) Surface the EXISTING e-sign unsorted path in settings.html (it was
--    seeded is_editable=0 with no display metadata, so the Settings tab
--    never showed it). Value untouched.
UPDATE app_settings
   SET is_editable = 1,
       category    = 'Dropbox',
       label       = 'Unsorted E-Signed Documents Folder',
       description = 'Dropbox folder where signed documents land when no case folder can be found or created (e-sign filing fallback). Leading spaces are load-bearing (manual sort ordering) — preserved verbatim.',
       `type`      = 'string',
       sort_order  = 30
 WHERE `key` = 'dropbox_unsorted_esign_path';

-- 3) The public docReq upload flow now reads the same notify setting as the
--    portal, and the SENDER now comes from the firm-wide 'email_automations'
--    setting (Email category) instead of a per-feature key — drop the
--    duplicate and update the recipient's description.
DELETE FROM app_settings WHERE `key` = 'portal_docs_notify_from';

UPDATE app_settings
   SET description = 'Recipient of the email staff receive when a client uploads documents (portal and public docReq page). Sender is the Automations Email setting. Blank = upload notification emails off (the case log entry still writes).'
 WHERE `key` = 'portal_docs_notify_to';
