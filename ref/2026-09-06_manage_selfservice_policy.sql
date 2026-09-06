-- 2026-09-06 — Manage-page self-service policy gate
--
-- Context: /m/<token> manage links have been going out to real clients via
-- (a) all six booking_views confirm SMS and (b) the staff appt-dialog
-- confirmation defaults, but SS has not approved client self-rescheduling.
-- This migration seeds three bool toggles read by routes/manage.js
-- (loadManageSettings). Code defaults MATCH the seeded values, so deploy
-- order vs. this migration does not matter — rescheduling is closed either
-- way until manage_allow_reschedule is flipped to '1' in the settings UI.
--
-- allow_rebook must track allow_reschedule: rebook-on with reschedule-off
-- is cancel-then-rebook = a reschedule in two clicks.
--
-- Rules: each statement is single + self-contained (DB console runs each on
-- its own connection). INSERT IGNORE keys off the app_settings PRIMARY KEY
-- (`key`), so re-running is a no-op.

-- 1) Seed the three policy toggles (Booking category, after the existing
--    manage_* rows which end at sort_order 60; fallback URL sits at 60).
INSERT IGNORE INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES
  ('manage_allow_cancel', '1', 0, 1, 'Booking', 'Client Self-Cancel',
   'Allow clients to cancel a Scheduled appointment from their /m/ manage link (1=yes, 0=call the office). Cutoff window still applies.',
   'bool', 62),
  ('manage_allow_reschedule', '0', 0, 1, 'Booking', 'Client Self-Reschedule',
   'Allow clients to reschedule a Scheduled appointment from their /m/ manage link (1=yes, 0=call the office). Keep OFF until approved. Cutoff/horizon still apply.',
   'bool', 64),
  ('manage_allow_rebook', '0', 0, 1, 'Booking', 'Client Rebook After Cancel',
   'Allow a Canceled appointment''s manage page to offer "pick a new time" (1=yes). Must match Client Self-Reschedule — rebook-on with reschedule-off lets clients reschedule by canceling first.',
   'bool', 66);

-- 2) Client-cancel SMS template: stop pointing back at the /m/ page (with
--    rebook off it has no action there) — send them to public booking.
UPDATE app_settings
   SET `value` = 'Your appointment has been canceled. Need a new time? https://4lsg.com/book/consult'
 WHERE `key` = 'manage_cancel_template';

-- 3) Host normalization: booking_views confirm SMS used app.4lsg.com/m/,
--    which 302s to 4lsg.com/m/ (landing_redirect=1). Send the final host
--    directly. Old app.-host links already in the wild keep working via the
--    302; this only changes future sends. (Verified 2026-09-06: only
--    confirm_template contains /m/ links; thankyou/footer HTML do not.)
UPDATE booking_views
   SET confirm_template = REPLACE(confirm_template,
       'https://app.4lsg.com/m/', 'https://4lsg.com/m/')
 WHERE confirm_template LIKE '%https://app.4lsg.com/m/%';

-- ── Verify ──
-- SELECT `key`,`value`,`type`,sort_order FROM app_settings WHERE `key` LIKE 'manage_allow%';
-- SELECT `key`,`value` FROM app_settings WHERE `key`='manage_cancel_template';
-- SELECT id, slug FROM booking_views WHERE confirm_template LIKE '%app.4lsg.com/m/%';  -- expect 0 rows

-- ── Later, when SS approves rescheduling (settings UI, or): ──
-- UPDATE app_settings SET `value`='1' WHERE `key` IN ('manage_allow_reschedule','manage_allow_rebook');
