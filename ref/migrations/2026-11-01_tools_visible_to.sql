-- launcher-nits L5 — tools.visible_to, the role allow-list for the tool picker (2026-11-01).
-- Fred's rulings 2026-10-28 and 2026-11-01; ref/AI_CONTEXT.md §31.
--
-- One nullable column on a five-row table, added INSTANT: the statement refuses
-- rather than rebuild the table. Every existing tool stays NULL (everyone), so
-- nothing changes for anyone until a superuser restricts a tool. Applied by
-- scripts/launcherL5ToolsVisibleTo.js --apply, which sets lock_wait_timeout
-- first (an ALTER queued behind a long transaction stalls every query on the
-- table) and verifies the end state.
--
-- DEPLOY ORDER (absolute):
--   1. node scripts/launcherL5ToolsVisibleTo.js            (CHECK, read-only)
--   2. node scripts/launcherL5ToolsVisibleTo.js --apply    (this file)
--   3. backend deploy (routes/api.tools.js and uiConfigService.pickers read it)
--   4. frontend deploy (the Tool Manager control)
--
-- ROLLBACK (no data lost while no tool is restricted):
--   ALTER TABLE tools DROP COLUMN visible_to, ALGORITHM=INSTANT;

ALTER TABLE tools
  ADD COLUMN visible_to json NULL DEFAULT NULL COMMENT 'who the tool lists for in the tool picker (GET /api/ui-config/pickers, My buttons). NULL = everyone; a JSON array of users.roles members = those roles; [] = no role. Holders of firm.settings (admin, IT, su) always see every tool. An ALLOW-list: a role nobody ticked never sees it. Picker visibility only, never security: GET /tool/<key> is public and a button already made keeps working. Written by routes/api.tools.js validatePayload' AFTER status,
  ALGORITHM=INSTANT;
