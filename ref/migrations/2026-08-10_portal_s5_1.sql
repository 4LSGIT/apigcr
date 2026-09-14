-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-08-10 — Client Portal, S5.1 rider: home layout (seed only)
--
-- WHY
--   Fred's review of the shipped S5 home page: the inline case list crowded
--   the top and pushed the welcome announcement below the fold; the cases
--   entry point should be A CARD that takes clients to the cases list.
--
--   S5.1 therefore removes the inline case list from home.html (and drops
--   `cases` from the GET /api/portal/home aggregate — no more per-case
--   pipeline reads on every home view) and seeds the navigation as an
--   ENGINE card, the exact R2 pattern that carried the Documents/callback
--   nav into the card engine:
--
--   * myCases — ACTIVE template card, placement 'home', sort 20, no body,
--     no conditions; structured link '/portal/cases.html' (PORTAL-INTERNAL
--     → same-tab, no "opens in a new tab" note — the ratified R2 link
--     rule). sort 20 lands it AFTER the welcome card (sort 10): greeting →
--     Welcome → My Cases. Title / label / order / active all
--     staff-editable in Portal Manager thereafter, like any template card.
--
--   Single-case clients get one tap from home into their case: the card
--   opens cases.html, whose single-case auto-redirect (unchanged) forwards
--   straight to case.html.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- Run BEFORE deploying the S5.1 code (migrations before code — house rule).
-- Row + OLD (S5) code = a brief cosmetic window: S5's home ALREADY renders
-- home-placement cards, so the My Cases card appears BELOW the old inline
-- case list until the new home.html deploys. Nothing breaks; deploy
-- promptly to close the window. (Pre-S5 code: renders nowhere — inert.)
--
-- ── IDEMPOTENT / RE-RUN POSTURE ─────────────────────────────────────────────
-- Single-statement-self-contained (admin DB console runs each statement on
-- a separate pooled connection — 2026-08-05 incident). INSERT … SELECT …
-- WHERE NOT EXISTS keyed on card_key ('myCases', UNIQUE) — a re-run inserts
-- nothing and NEVER clobbers staff edits. Safe to re-run end to end.
--
-- ── AFTER RUNNING ───────────────────────────────────────────────────────────
-- No DDL — the ref/database.sql schema snapshot is unaffected.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- DELETE FROM portal_cards WHERE card_key = 'myCases';
-- (Code rollback: revert the S5.1 commit — the S5 home renders its own
--  inline case list and ignores this row's absence either way.)
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Seed: My Cases nav card (home placement) ─────────────────────────────
-- No body, structured link only — the callback-card shape. Validated
-- through the S5 validateCard (placement 'home') before landing here.

INSERT INTO portal_cards
  (card_key, title, body_type, body_template, coded_key,
   link_url, link_label, conditions, placement, sort, active)
SELECT
  'myCases', 'My Cases', 'template', NULL, NULL,
  '/portal/cases.html', 'View your cases', NULL, 'home', 20, 1
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM portal_cards WHERE card_key = 'myCases');
