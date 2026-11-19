-- Booking redirect: where the widget sends the visitor after a booking.
-- Applied by scripts/bookingRedirectColumn.js on one connection, with
-- lock_wait_timeout = 5. Recorded here; run the script, not this.

ALTER TABLE booking_views
  ADD COLUMN redirect_url varchar(500) NULL DEFAULT NULL COMMENT 'https URL the booking widget sends the visitor to after a booking, once the thank-you has shown; in an iframe the host page redirects via the embed snippet. NULL = stay on the thank-you. https-only, app-validated (routes/api.bookingViews.js)' AFTER thankyou_html,
  ALGORITHM=INSTANT;
