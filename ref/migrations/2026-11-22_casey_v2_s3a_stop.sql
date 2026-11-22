-- Casey v2 S3a (2026-11-22): a Stop button for a running turn.
-- Applied by scripts/caseyV2S3aMigrate.js (CHECK / --apply), which reads this
-- file, so the file and the applied schema cannot differ. Runs BEFORE the S3a
-- backend deploys (SQL → backend). One statement; ends with ';' at end of line.
-- After this, casey_chats has one column more than ref/migrations/2026-11-22_casey_v2_chats.sql
-- declares: scripts/caseyV2ChatsMigrate.js (S2) is superseded for CHECK by the S3a script.
ALTER TABLE casey_chats
  ADD COLUMN stop_requested_at datetime DEFAULT NULL COMMENT 'UTC. Set by POST /api/casey/turn/stop while a turn is running (running_since not NULL); the loop checks it before every model call and ends the turn with a text-only [Stopped by the user.] row. Cleared by the next claim.' AFTER running_since;
