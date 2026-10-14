-- Access-control B6 — optional expiry on machine (yck_) keys.
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ DEPLOY ORDER — THE HOUSE ORDER: THIS FIRST, THEN THE CODE.               │
-- │   1. node scripts/accessB6KeyExpiry.js           (CHECK)                 │
-- │   2. node scripts/accessB6KeyExpiry.js --apply                           │
-- │   3. land + deploy B6                                                    │
-- │ The B6 lookup SELECTs api_keys.expires_at. Deployed first, that SELECT   │
-- │ fails and lib/apiKeys.lookup fails CLOSED: EVERY machine key — both     │
-- │ Cloud Scheduler jobs, Pabbly — stops authenticating until the column    │
-- │ exists (proven on the 8.4 twin). The old backend names its columns, so  │
-- │ the new NULL column is invisible to it.                                  │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- Run through the script, not the SU console: it sets lock_wait_timeout on
-- its own connection, refuses a pre-existing expires_at of another shape,
-- verifies (and that every existing key is NULL = non-expiring), and resumes.
-- datetime, like readonly_api_keys.expires_at; the app pool is UTC
-- (timezone 'Z'), so the stored value is a UTC instant.
ALTER TABLE `api_keys`
  ADD COLUMN `expires_at` datetime NULL DEFAULT NULL
  COMMENT 'NULL = non-expiring (legacy and infrastructure keys); checked at lookup' AFTER `revoked_at`,
  ALGORITHM=INSTANT;

-- Session check afterwards (readonly SQL; expect 9 rows, all NULL at apply):
--   SELECT id, label, expires_at FROM api_keys ORDER BY id;
