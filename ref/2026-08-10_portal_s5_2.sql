-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-08-10 — Client Portal, S5.2 rider: portal branding settings (seed only)
--
-- WHY
--   The portal logo/favicon become their own SETTINGS, editable in Portal
--   Manager → Settings → Branding, instead of piggybacking on the firm-wide
--   fe-firm_logo_url:
--
--   * portal_logo_url    — the portal header/login logo. Seeded with the
--     full LSG logo Fred chose (2026-08-10):
--     https://legalsolutions.group/assets/lsg-logo.webp — rendered 120px
--     tall by the S5.2 header. BLANK = fall back to fe-firm_logo_url.
--   * portal_favicon_url — browser-tab icon. Seeded BLANK = use the
--     effective logo (the public branding endpoint resolves the fallback
--     server-side).
--
--   Both are served to clients ONLY through GET /api/portal/branding —
--   the fixed-set public endpoint (routes/portal.branding.js), whose
--   hardcoded key list grows to include these two. Client browsers cache
--   branding 5 minutes.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- Run BEFORE deploying the S5.2 code (migrations before code — house rule).
-- Rows + OLD (S5/S5.1) code = fully inert: the old branding endpoint's
-- fixed set doesn't include these keys, so nothing reads them until the new
-- code deploys (the old header keeps showing fe-firm_logo_url at the old
-- size in the gap). Nothing breaks either way.
--
-- ── IDEMPOTENT / RE-RUN POSTURE ─────────────────────────────────────────────
-- Single-statement-self-contained (admin DB console runs each statement on
-- a separate pooled connection — 2026-08-05 incident). INSERT … ON
-- DUPLICATE KEY UPDATE with `value` deliberately ABSENT from the UPDATE
-- list (house pattern — 2026-08-09_portal_r1_r2.sql): re-running refreshes
-- metadata but never resets a live value, so staff edits in the Branding
-- box survive re-runs. Safe to re-run end to end.
--
-- ── AFTER RUNNING ───────────────────────────────────────────────────────────
-- No DDL — the ref/database.sql schema snapshot is unaffected.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- DELETE FROM app_settings WHERE `key` IN ('portal_logo_url', 'portal_favicon_url');
-- (Code rollback: revert the S5.2 commit — the S5.1 branding endpoint reads
--  only the fe- keys and ignores these rows.)
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. portal_logo_url ──────────────────────────────────────────────────────

INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES
  ('portal_logo_url', 'https://legalsolutions.group/assets/lsg-logo.webp', 0, 1, 'Portal',
   'Portal logo URL',
   'Logo shown in the client-portal header on every page including login (served by the public GET /api/portal/branding). Blank = fall back to the firm-wide fe-firm_logo_url. Renders 120px tall — a wide, transparent-background image works best.',
   'text', 60)
ON DUPLICATE KEY UPDATE
  is_secret   = VALUES(is_secret),
  is_editable = VALUES(is_editable),
  category    = VALUES(category),
  label       = VALUES(label),
  description = VALUES(description),
  type        = VALUES(type),
  sort_order  = VALUES(sort_order);


-- ── 2. portal_favicon_url ───────────────────────────────────────────────────

INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES
  ('portal_favicon_url', '', 0, 1, 'Portal',
   'Portal favicon URL',
   'Browser-tab icon for the client portal (served by the public GET /api/portal/branding). Blank = use the effective portal logo.',
   'text', 70)
ON DUPLICATE KEY UPDATE
  is_secret   = VALUES(is_secret),
  is_editable = VALUES(is_editable),
  category    = VALUES(category),
  label       = VALUES(label),
  description = VALUES(description),
  type        = VALUES(type),
  sort_order  = VALUES(sort_order);
