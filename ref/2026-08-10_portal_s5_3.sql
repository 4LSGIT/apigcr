-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-08-10 — Client Portal, S5.3 rider: logo link setting (seed only)
--
-- WHY
--   * portal_logo_href — where the client-portal header logo links, now a
--     setting (Portal Manager → Settings → Branding). Seeded BLANK = the
--     default behavior (portal home on signed-in pages, not clickable on
--     the login page). When set, it applies on EVERY page, login included —
--     e.g. the firm website. Values must be http(s) or a single-'/' site
--     path; the branding endpoint normalizes anything else to null
--     (safeHref — never a javascript: URI in a client href), and the
--     Branding box validates the same rule on save.
--
--   Served through GET /api/portal/branding — its hardcoded fixed set
--   grows to six keys. (The cases-list back-to-home arrow, the other half
--   of S5.3, is code-only.)
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- Run BEFORE deploying the S5.3 code (migrations before code — house rule).
-- Row + OLD (S5.2) code = fully inert: the old endpoint's fixed set doesn't
-- include this key, so nothing reads it until the new code deploys.
--
-- ── IDEMPOTENT / RE-RUN POSTURE ─────────────────────────────────────────────
-- Single-statement-self-contained (admin DB console — 2026-08-05 incident).
-- INSERT … ON DUPLICATE KEY UPDATE with `value` deliberately ABSENT from
-- the UPDATE list (house pattern): re-running refreshes metadata but never
-- resets a live value. Safe to re-run end to end.
--
-- ── AFTER RUNNING ───────────────────────────────────────────────────────────
-- No DDL — the ref/database.sql schema snapshot is unaffected.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- DELETE FROM app_settings WHERE `key` = 'portal_logo_href';
-- (Code rollback: revert the S5.3 commit — the S5.2 endpoint ignores this
--  row.)
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. portal_logo_href ─────────────────────────────────────────────────────

INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES
  ('portal_logo_href', '', 0, 1, 'Portal',
   'Portal logo link',
   'Where the client-portal header logo links (served by the public GET /api/portal/branding). http(s) URL or a single-''/'' site path. Blank = default: portal home on signed-in pages, not clickable on login. Applies on every page when set, login included.',
   'text', 80)
ON DUPLICATE KEY UPDATE
  is_secret   = VALUES(is_secret),
  is_editable = VALUES(is_editable),
  category    = VALUES(category),
  label       = VALUES(label),
  description = VALUES(description),
  type        = VALUES(type),
  sort_order  = VALUES(sort_order);
