-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-08-09 — Client Portal, SLICE 5: Branding + Home (seed only)
--
-- WHY
--   S5 turns home.html into a real landing page (greeting + case summary +
--   engine cards) and extends the card engine with placement 'home' — a
--   staff-authored announcements channel manageable from Portal Manager.
--   The HOME surface is CASE-LESS: renderCards runs with caseId NULL, and
--   home cards may reference contacts.* whitelist fields only (enforced at
--   save by the placement-aware validateCard; fail-closed at render).
--
--   This migration seeds ONE example announcement so the channel ships
--   demonstrably working:
--
--   * welcome — ACTIVE template card, placement 'home', sort 10, no
--     conditions (always shows), no link. Copy is a starting draft — Fred
--     approves the seed wording here; staff own every subsequent edit
--     through Portal Manager → Cards (title/body/sort/active/conditions all
--     admin-editable; it's a plain template card, deletable like any other).
--
--   The branding endpoint (GET /api/portal/branding) needs NO rows from
--   this file — it reads the three fe- app_settings rows that already
--   exist in production (fe-firm_logo_url / fe-firm_site_url /
--   fe-firm_phone, verified live 2026-08-09).
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- Run BEFORE deploying the S5 code (migrations before code — house rule).
-- The seeded row is INERT until S5 deploys: the case view calls renderCards
-- with placement ['case_top','case'] explicitly (services/
-- portalCaseService.js), so a 'home'-placement row renders NOWHERE on
-- pre-S5 code — no cosmetic window at all (contrast the R2 note in
-- 2026-08-09_portal_r1_r2.sql). Pre-S5 Portal Manager will LIST the row
-- (the admin list shows every row) but its editor rejects placement 'home'
-- on save until the new engine deploys — don't edit it in the gap.
--
-- ── IDEMPOTENT / RE-RUN POSTURE ─────────────────────────────────────────────
-- Single-statement-self-contained (admin DB console runs each statement on
-- a separate pooled connection — no session vars, no PREPARE/EXECUTE;
-- 2026-08-05 incident). The INSERT … SELECT … WHERE NOT EXISTS is keyed on
-- card_key ('welcome', UNIQUE) — a re-run inserts nothing and NEVER
-- clobbers staff edits (wording/sort/active/conditions all staff-ownable
-- post-seed). Safe to re-run end to end.
--
-- ── AFTER RUNNING ───────────────────────────────────────────────────────────
-- No DDL in this file — the ref/database.sql schema snapshot is unaffected;
-- regenerating it (POST /admin/db/schema/save-to-ref) is optional.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- DELETE FROM portal_cards WHERE card_key = 'welcome';
-- (Code rollback: revert the S5 commit — pre-S5 code never renders
--  placement 'home', so the row alone is harmless either way.)
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Seed: welcome announcement (home placement) ──────────────────────────
-- Template card, always shows (conditions NULL), no link. Body references
-- ONLY contacts.contact_fname — the home surface's whole field vocabulary
-- today — with a |default: so a blank first name reads naturally. Validated
-- through the S5 validateCard (placement 'home') before landing here.

INSERT INTO portal_cards
  (card_key, title, body_type, body_template, coded_key,
   link_url, link_label, conditions, placement, sort, active)
SELECT
  'welcome', 'Welcome', 'template',
  'Welcome to your client portal, {{contacts.contact_fname|default:there}}. Here you can check your case status, upload documents, and request a callback from our office — all in one place. Questions? Give us a call any time.',
  NULL,
  NULL, NULL, NULL, 'home', 10, 1
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM portal_cards WHERE card_key = 'welcome');
