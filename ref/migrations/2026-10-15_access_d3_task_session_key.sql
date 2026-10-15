-- Access-control D3 — session-key tasks: tasks.task_session_key_id.
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ DEPLOY ORDER — THE HOUSE ORDER: THIS FIRST, THEN THE CODE.               │
-- │   1. node scripts/accessD3TaskSessionKey.js           (CHECK)            │
-- │   2. node scripts/accessD3TaskSessionKey.js --apply                      │
-- │   3. land + deploy D3                                                    │
-- │ The D3 /api/key-tasks routes name task_session_key_id. Deployed first,  │
-- │ every key-task call is a 500 — CLOSED, nothing written — until the       │
-- │ column exists (proven on the 8.4 twin, tests/keyTasks.mysql.test.js).   │
-- │ Every OTHER task path is untouched on either schema: createTask names    │
-- │ the column only for a key's task; the rest select t.* or name columns.   │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- `tasks` is HOT. Both statements are online and say so — MySQL refuses
-- rather than fall back to a copy: the column is INSTANT (metadata only), the
-- index INPLACE with LOCK=NONE (reads and writes continue). Run through the
-- script, not the SU console: it sets lock_wait_timeout low on its own
-- connection (a metadata lock queued behind a long transaction would stall
-- every query on tasks), refuses a pre-existing column / index of another
-- shape, verifies, and resumes.
--
-- No foreign key to readonly_api_keys, deliberately: an FK adds a parent-row
-- lookup and shared lock to every keyed INSERT on this hot table, and
-- ownership needs only equality; InnoDB never reuses a key id.
ALTER TABLE `tasks`
  ADD COLUMN `task_session_key_id` int NULL DEFAULT NULL
  COMMENT 'Session-key tasks (access-control D3): NULL = not created by a session key; else readonly_api_keys.id of the tasks.own key that created it and alone may manage it via /api/key-tasks. Ownership lives HERE, never in task_source (free text). No FK: hot table; key ids are never reused.'
  AFTER `task_source`,
  ALGORITHM=INSTANT;

ALTER TABLE `tasks`
  ADD INDEX `idx_tasks_session_key` (`task_session_key_id`, `task_date`),
  ALGORITHM=INPLACE, LOCK=NONE;

-- Session check afterwards (readonly SQL; expect 0 — no key task exists until D3 deploys):
--   SELECT COUNT(*) FROM tasks WHERE task_session_key_id IS NOT NULL;
