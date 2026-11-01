-- YisraVideo S2: tracking proof, real completion, soft exclusion.
-- Applied by scripts/yisravidS2Columns.js on one connection, with
-- lock_wait_timeout = 5 and a backup first. Recorded here; run the script, not this.

ALTER TABLE video_views
  ADD COLUMN track_token char(22) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL
    COMMENT 'bearer for the public track + cta-click POSTs, rendered into the page that opened the view; ids are sequential; NULL on views before 2026-11-01; _bin: case-sensitive',
  ADD COLUMN completed_at timestamp NULL DEFAULT NULL
    COMMENT 'first time at least 90% really played (videoService.COMPLETE_PCT), claimed once by conditional UPDATE; before 2026-11-01 backfilled from completion_pct=100, which only meant the player reached the end',
  ADD COLUMN excluded_at timestamp NULL DEFAULT NULL
    COMMENT 'staff excluded this view from stats (test view, scanner); NULL = counted; reversible, never a delete',
  ADD COLUMN excluded_by int DEFAULT NULL
    COMMENT 'users.user who excluded it',
  ALGORITHM=INSTANT;

ALTER TABLE video_views
  MODIFY COLUMN watch_seconds int NOT NULL DEFAULT '0'
    COMMENT 'seconds really played since 2026-11-01; before that the furthest position reached, so dragging the bar counted',
  ALGORITHM=INSTANT;

UPDATE video_views
   SET completed_at = COALESCE(played_at, opened_at)
 WHERE completion_pct = 100 AND completed_at IS NULL;
