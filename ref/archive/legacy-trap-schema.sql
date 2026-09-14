-- Temporary tracing table for legacy routes we want to retire.
-- Paired with lib/legacyTrap.js.
--
-- Workflow:
--   1. CREATE the table (run this file once on the live DB).
--   2. Leave the trap middleware in place for ~14 days of traffic.
--   3. Query by route to see callers:
--        SELECT route, COUNT(*), MIN(ts), MAX(ts)
--        FROM legacy_route_log GROUP BY route;
--        SELECT ts, ip, user_agent, body_json
--        FROM legacy_route_log WHERE route = 'create-case' ORDER BY ts DESC;
--   4. Once every route has been sunset, DROP TABLE legacy_route_log
--      and delete lib/legacyTrap.js + the require()s / trap() calls.

CREATE TABLE IF NOT EXISTS legacy_route_log (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  ts           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  route        VARCHAR(64) NOT NULL,
  method       VARCHAR(8)  NOT NULL,
  ip           VARCHAR(64),
  user_agent   TEXT,
  query_json   JSON,
  body_json    JSON,
  headers_json JSON,
  INDEX idx_route_ts (route, ts)
);
