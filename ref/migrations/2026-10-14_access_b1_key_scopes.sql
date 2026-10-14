-- Access-control B1 — the scopes column on both key tables (ref/ACCESS_CONTROL_DESIGN.md §5.2, §5.6).
-- Applied via scripts/accessB1KeyScopes.js (one connection, session
-- lock_wait_timeout=5; CHECK + --apply, resumable per table; a scopes column
-- of any other shape is a NO-GO, never altered). Verified on MySQL 8.4.11
-- (same as production) before shipping.
--
-- Deploy order: THIS, then land + deploy B1 — the new backend SELECTs scopes
-- on every key-authenticated request.
--
-- NULL = the legacy full surface: every existing key behaves exactly as
-- before until its scopes are set. New session-key mints default to
-- ["sql.ro","scratch","alert"] (routes/api.readonlyKeys.js).

ALTER TABLE `readonly_api_keys` ADD COLUMN `scopes` JSON NULL COMMENT 'Key scopes (access-control B1): NULL = legacy full surface; else a JSON array of scope strings — surface (sql.ro, scratch, alert, temp.*), route:/<path>, or a capability name. Vocabulary: lib/capabilities.js KEY_SCOPES.', ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE `api_keys` ADD COLUMN `scopes` JSON NULL COMMENT 'Key scopes (access-control B1): NULL = legacy full surface; else a JSON array of scope strings — surface (sql.ro, scratch, alert, temp.*), route:/<path>, or a capability name. Vocabulary: lib/capabilities.js KEY_SCOPES.', ALGORITHM=INPLACE, LOCK=NONE;
