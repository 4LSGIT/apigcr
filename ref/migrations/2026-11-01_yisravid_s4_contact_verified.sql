-- YisraVideo S4: which views may announce a video.* event.
-- Applied by scripts/yisravidS4ContactVerified.js on one connection, with
-- lock_wait_timeout = 5 and a backup first. Recorded here; run the script, not this.

ALTER TABLE video_views
  ADD COLUMN contact_verified tinyint(1) NOT NULL DEFAULT '0'
    COMMENT '1 = contact_id came from a ?ct= token; 0 = a ?c= integer anyone can type, no contact, or a view from before this column. Only 1 may fire video.* events',
  ALGORITHM=INSTANT;
