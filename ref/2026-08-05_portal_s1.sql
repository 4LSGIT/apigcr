-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-08-05 — Client Portal, SLICE 1: auth foundation schema
--
-- WHY
--   Foundation for the client portal: clients authenticate by 6-digit PIN
--   sent to a phone/email they typed; sessions are JWTs with aud:"contact".
--   Staff auth is behaviorally untouched but gains aud:"staff" + roles claims.
--
--   * contacts.portal_enabled         — per-contact portal kill switch
--                                       (default ON; staff flips off).
--   * contacts.portal_session_version — bump to revoke ALL of a contact's
--                                       portal tokens (token ver must match).
--   * users.roles                     — SET column feeding the new roles JWT
--                                       claim; backfilled below. Nothing
--                                       ENFORCES roles yet except portal-era
--                                       requireAuth (mounted on portal routes
--                                       only this slice).
--   * portal_login_pins               — one row per PIN issued. pin_hash is
--                                       HMAC-SHA256(JWT_SECRET, pin) hex —
--                                       raw PINs are never stored or logged.
--   * portal_access_log               — one row per portal API request plus
--                                       service-level auth events
--                                       (pin_sent / pin_no_match /
--                                       pin_multi_match / pin_disabled /
--                                       pin_capped / pin_send_failed /
--                                       login / logout). method/event/meta
--                                       extend the originally planned column
--                                       set (manager addition, flagged for
--                                       ratification) so the staff-visible
--                                       multi-match row and the SMS-cap event
--                                       have a home.
--   * app_settings rows               — portal_email_from (PIN email sender),
--                                       portal_sms_monthly_cap (cost cap),
--                                       portal_sms_counter (machine-managed
--                                       month counter JSON).
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- Run BEFORE deploying the Slice 1 code (migrations before code — house
-- rule). Everything here is inert until routes/portal.auth.js ships; the
-- only pre-deploy effect is that a fresh staff login can SELECT users.roles
-- once D4 deploys (column must exist first).
--
-- ── IDEMPOTENT / RE-RUN POSTURE ─────────────────────────────────────────────
-- The ALTERs are PLAIN — MySQL 8.4 has no "ADD COLUMN IF NOT EXISTS", and
-- the guarded PREPARE/EXECUTE pattern this file originally used SILENTLY
-- NO-OPS in the admin DB console: the console executes each statement on a
-- separate pooled connection, so session variables (@ddl) and prepared
-- handlers do not survive between statements (incident, 2026-08-05 — the
-- first run half-applied). CONVENTION for console-run migrations: every
-- statement must be single-statement-self-contained — no session vars, no
-- PREPARE/EXECUTE, no cross-statement transaction assumptions.
-- Re-run posture: on an already-migrated DB the three ALTERs fail with
-- "Duplicate column name" — HARMLESS, and itself the already-applied
-- signal; everything else is truly idempotent (CREATE TABLE IF NOT EXISTS;
-- backfill guarded by `AND roles = ''` so re-runs never clobber later
-- manual role edits).
-- app_settings inserts use INSERT ... ON DUPLICATE KEY UPDATE with `value`
-- deliberately absent from the UPDATE list (house pattern — see
-- 2026-07-19_esign_phase1c.sql): re-running refreshes metadata but never
-- resets a live value (critical for portal_sms_counter).
-- Safe to re-run end to end.
--
-- ── CONVENTIONS ─────────────────────────────────────────────────────────────
-- utf8mb4_general_ci (dominant repo convention; matches contacts/users so
-- joins avoid collation coercion). NO foreign keys on new tables (repo
-- convention: FK-by-convention only). No reliance on STRICT_TRANS_TABLES —
-- every NOT NULL column has an explicit DEFAULT or is always written.
--
-- After running: regenerate the schema snapshot via
-- POST /admin/db/schema/save-to-ref (ref/database.sql is auto-generated —
-- do not hand-edit it).
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- ALTER TABLE contacts DROP COLUMN portal_enabled;
-- ALTER TABLE contacts DROP COLUMN portal_session_version;
-- ALTER TABLE users DROP COLUMN roles;      -- also reverts the backfill
-- DROP TABLE IF EXISTS portal_login_pins;
-- DROP TABLE IF EXISTS portal_access_log;
-- DELETE FROM app_settings WHERE `key` IN
--   ('portal_email_from', 'portal_sms_monthly_cap', 'portal_sms_counter');
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. contacts.portal_enabled ──────────────────────────────────────────────
-- Default 1: every contact can use the portal unless staff disables them.

ALTER TABLE contacts ADD COLUMN portal_enabled tinyint(1) NOT NULL DEFAULT 1;


-- ── 2. contacts.portal_session_version ──────────────────────────────────────
-- Portal JWTs carry ver = this value at sign time; requireAuth rejects any
-- mismatch. Bumping it is the all-device revoke for one contact.

ALTER TABLE contacts ADD COLUMN portal_session_version int NOT NULL DEFAULT 1;


-- ── 3. users.roles ──────────────────────────────────────────────────────────
-- SET column: a user may hold several roles. mysql2 returns SET values as a
-- comma-joined string; auth.login splits it into the roles JWT claim.

ALTER TABLE users ADD COLUMN roles SET('it','admin','staff','attorney','automation') NOT NULL DEFAULT '';


-- ── 4. Roles backfill ───────────────────────────────────────────────────────
-- All 9 current rows (verified live 2026-08-05: users 0,1,2,3,4,5,6,22,23).
-- `AND roles = ''` guard: a re-run never clobbers roles edited after the
-- first run. users PK column is `user`.

UPDATE users SET roles = 'automation'      WHERE user = 0  AND roles = '';
UPDATE users SET roles = 'attorney,staff'  WHERE user = 1  AND roles = '';
UPDATE users SET roles = 'staff'           WHERE user IN (2, 3, 4, 5, 22) AND roles = '';
UPDATE users SET roles = 'it,admin'        WHERE user = 6  AND roles = '';
UPDATE users SET roles = 'staff'           WHERE user = 23 AND roles = '';


-- ── 5. portal_login_pins ────────────────────────────────────────────────────
-- One row per PIN issued. Newest unconsumed row per (contact, channel) is
-- the live one — a newer request supersedes older PINs by recency; older
-- rows are simply never loaded again. destination = the exact phone/email
-- the PIN went to. attempts increments on every verify try (max 5).

CREATE TABLE IF NOT EXISTS portal_login_pins (
  id           int unsigned      NOT NULL AUTO_INCREMENT,
  contact_id   int unsigned      NOT NULL,
  channel      enum('sms','email') NOT NULL,
  destination  varchar(100)      NOT NULL,
  pin_hash     char(64)          NOT NULL,
  expires_at   datetime          NOT NULL,
  attempts     tinyint unsigned  NOT NULL DEFAULT 0,
  consumed_at  datetime          NULL,
  ip           varchar(45)       NULL,
  created_at   datetime          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pins_contact (contact_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ── 6. portal_access_log ────────────────────────────────────────────────────
-- Written two ways:
--   a) requireAuth's res.on('finish') hook — one row per authed portal API
--      request (route/method/status filled; event only when the route sets
--      one, e.g. logout).
--   b) portalAuthService — one row per auth event on the unauthenticated
--      endpoints (pin_* events, login). contact_id NULL when unresolved.
-- case_id is the S2 hook (req.portalCaseId) — nothing sets it this slice.

CREATE TABLE IF NOT EXISTS portal_access_log (
  id           int unsigned  NOT NULL AUTO_INCREMENT,
  contact_id   int unsigned  NULL,
  case_id      varchar(8)    NULL,
  route        varchar(255)  NOT NULL,
  method       varchar(8)    NOT NULL DEFAULT '',
  status       smallint      NULL,
  event        varchar(32)   NULL,
  meta         json          NULL,
  ip           varchar(45)   NULL,
  created_at   datetime      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pal_contact (contact_id, created_at),
  KEY idx_pal_event (event)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ── 7. app_settings ─────────────────────────────────────────────────────────
-- House pattern: ON DUPLICATE KEY UPDATE refreshes metadata only; `value`
-- deliberately absent from every UPDATE list so a re-run never resets a
-- live value (portal_sms_counter especially — machine-managed state).

INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES
  ('portal_email_from', 'office@4lsg.com', 0, 1, 'Portal',
   'Portal Email From',
   'Sender address for client-portal login-code emails. Must exist in email_credentials or portal login emails fail (failures alert; the client still sees the generic confirmation). Falls back to email_default_from ONLY if this row is deleted, never on a send failure.',
   'email', 10)
ON DUPLICATE KEY UPDATE
  is_secret   = VALUES(is_secret),
  is_editable = VALUES(is_editable),
  category    = VALUES(category),
  label       = VALUES(label),
  description = VALUES(description),
  type        = VALUES(type),
  sort_order  = VALUES(sort_order);

INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES
  ('portal_sms_monthly_cap', '300', 0, 1, 'Portal',
   'Portal SMS Monthly Cap',
   'Maximum client-portal login-code SMS sends per calendar month (UTC). At the cap, requests still return the generic confirmation but no SMS is sent (pin_capped rows in portal_access_log; one alert per month). Cost control, not a security control.',
   'number', 20)
ON DUPLICATE KEY UPDATE
  is_secret   = VALUES(is_secret),
  is_editable = VALUES(is_editable),
  category    = VALUES(category),
  label       = VALUES(label),
  description = VALUES(description),
  type        = VALUES(type),
  sort_order  = VALUES(sort_order);

INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES
  ('portal_sms_counter', '{"ym":"","count":0,"alerted_ym":""}', 0, 0, 'Portal',
   'Portal SMS Counter (machine-managed)',
   'Rolling month counter for portal login-code SMS sends. Managed by portalAuthService; do not edit. ym = UTC YYYY-MM; count = sends this month; alerted_ym = last month a cap alert fired.',
   'text', 30)
ON DUPLICATE KEY UPDATE
  is_secret   = VALUES(is_secret),
  is_editable = VALUES(is_editable),
  category    = VALUES(category),
  label       = VALUES(label),
  description = VALUES(description),
  type        = VALUES(type),
  sort_order  = VALUES(sort_order);
