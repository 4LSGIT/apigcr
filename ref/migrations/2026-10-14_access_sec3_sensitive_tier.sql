-- Access-control SEC-3 — the sensitive-read tier (ref/ACCESS_CONTROL_DESIGN.md §5.7).
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ DEPLOY ORDER — THE HOUSE ORDER: THIS FIRST, THEN THE CODE.               │
-- │   1. node scripts/accessSec3SensitiveTier.js           (CHECK)           │
-- │   2. node scripts/accessSec3SensitiveTier.js --apply                     │
-- │   3. land + deploy SEC-3                                                 │
-- │ The SEC-3 backend names readonly_query_log.sensitive_key in its log     │
-- │ INSERT: deployed first, every /api/readonly/sql call's audit row fails   │
-- │ ("Unknown column" — fire-and-forget, so queries still answer and the    │
-- │ log goes dark). The old backend's INSERT lists its columns, so the new  │
-- │ column (DEFAULT 0) is invisible to it. The view alone is order-free.     │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- Run through the script, not the SU console: it sets lock_wait_timeout on
-- its own connection, refuses a pre-existing column/view of another shape,
-- preflights CREATE VIEW (SHOW GRANTS), verifies, and resumes.
--
-- A. The flag. NOT named `sensitive`: SENSITIVE is a MySQL reserved word
--    (an unquoted INSERT naming it is a syntax error — caught on the 8.4 twin).
ALTER TABLE `readonly_query_log`
  ADD COLUMN `sensitive_key` tinyint(1) NOT NULL DEFAULT 0
  COMMENT '1 = the session key held sql.ro.sensitive (access SEC-3)' AFTER `status`,
  ALGORITHM=INSTANT;

-- B. Spend monitoring for ordinary session keys once ai_calls is SENSITIVE:
--    every ai_calls column except error, request_excerpt, response.
--    SQL SECURITY INVOKER — the view grants nothing its reader could not
--    already SELECT. lib/schemaDump dumps BASE TABLEs only, so this view is
--    NOT in ref/database.sql: this file is its definition of record.
CREATE SQL SECURITY INVOKER VIEW `ai_spend` AS
  SELECT `id`, `created_at`, `prompt_key`, `prompt_version`, `model`, `mode`, `output_type`,
         `consumer_ref`, `status`, `input_tokens`, `output_tokens`, `cost_cents`, `latency_ms`
    FROM `ai_calls`;

-- Session check afterwards (readonly SQL, any session key):
--   SELECT model, COUNT(*) calls, ROUND(SUM(cost_cents)/100, 2) usd
--     FROM ai_spend WHERE created_at >= NOW() - INTERVAL 30 DAY GROUP BY model;
