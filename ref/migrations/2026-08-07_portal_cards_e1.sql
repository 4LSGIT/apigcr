-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-08-07 — Client Portal, SLICE E1: card engine schema + live-card seeds
--
-- WHY
--   Configurable card engine for the portal case view (lib/portalCardEngine.js)
--   replacing per-card hardcoding in public/portal/case.html. Staff will edit
--   rows via E2's admin UI; E1 seeds the two LIVE cards so post-migration
--   portal output is behaviorally identical to pre-E1 (parity requirement).
--
--   portal_cards — one row per configurable card.
--     card_key       stable staff-facing identifier (unique; seeds keyed on it)
--     body_type      'template' → body_template resolves via resolverService
--                    against the PORTAL_FIELD_WHITELIST (code constant in
--                    lib/portalCardEngine.js — NOT staff-editable, NOT a DB
--                    table; deny-by-default; refs outside it REFUSE the card,
--                    never sanitize).
--                    'coded'    → body supplied by a client-side coded
--                    renderer dispatched on coded_key; body_template unused.
--     link_url/label structured action link. Links ALWAYS render
--                    target="_blank" rel="noopener" — the Clio page behind
--                    /r/payment REFUSES to load in an iframe, so links must
--                    be top-level/new-tab navigations, never embedded. Action
--                    links come from these structured columns only; templates
--                    are text with placeholders, never HTML.
--     conditions     JSON, NULL = always renders. Two modes (ratified model):
--                      rules — fixed server vocabulary evaluated in JS against
--                              whitelisted fields (ops v1: in, empty,
--                              not_empty, date_future, date_past,
--                              date_within_days, contains, starts_with;
--                              all/any match, nestable groups).
--                      sql   — escape hatch (amended ruling 2026-08-07):
--                              sequenceEngine.checkCondition shape
--                              {query, params, assert, assert_mode}; params
--                              PINNED server-side to the session's
--                              {case_id, contact_id} only. SELECT-only,
--                              fail-closed.
--                    Failed/refused cards are ABSENT from the payload.
--     placement      region on the page. E1 vocabulary: 'case_top' (above the
--                    progress timeline) and 'case' (below it — default).
--                    varchar leaves room for future surfaces ('home', …).
--     sort           ascending within placement; id tiebreak.
--     active         staff kill switch (0 = card gone from the portal).
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- Run BEFORE deploying the E1 code (migrations before code — house rule).
-- Inert until the E1 build of services/portalCaseService.js ships: nothing
-- reads portal_cards today. Pre-migration code + this table = no effect;
-- post-migration table + old code = no effect. E1 code WITHOUT this table
-- would fail-closed every card (portal stays up, cards region empty) — the
-- deploy order avoids that window.
--
-- ── IDEMPOTENT / RE-RUN POSTURE ─────────────────────────────────────────────
-- Every statement is single-statement-self-contained (no session vars, no
-- PREPARE/EXECUTE — the admin DB console runs each statement on a separate
-- pooled connection; 2026-08-05 incident). CREATE TABLE IF NOT EXISTS is
-- truly idempotent. Seeds use INSERT … SELECT … WHERE NOT EXISTS keyed on
-- card_key: a re-run inserts nothing and NEVER clobbers staff edits made
-- after the first run (title/body/conditions/active all staff-ownable).
-- Safe to re-run end to end.
--
-- ── CONVENTIONS ─────────────────────────────────────────────────────────────
-- utf8mb4_general_ci (dominant repo convention). NO foreign keys (repo
-- convention: FK-by-convention only). No reliance on STRICT_TRANS_TABLES —
-- every NOT NULL column has an explicit DEFAULT or is written by the seeds.
--
-- After running: regenerate the schema snapshot via
-- POST /admin/db/schema/save-to-ref (ref/database.sql is auto-generated —
-- do not hand-edit it).
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS portal_cards;
-- (Code rollback: revert the E1 commit — pre-E1 case.html/portalCaseService
--  hardcode both cards and never read this table.)
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. portal_cards ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS portal_cards (
  id             int unsigned  NOT NULL AUTO_INCREMENT,
  card_key       varchar(50)   NOT NULL,
  title          varchar(100)  NOT NULL,
  body_type      enum('template','coded') NOT NULL DEFAULT 'template',
  body_template  text          NULL,
  coded_key      varchar(50)   NULL,
  link_url       varchar(255)  NULL,
  link_label     varchar(50)   NULL,
  conditions     json          NULL,
  placement      varchar(20)   NOT NULL DEFAULT 'case',
  sort           int           NOT NULL DEFAULT 0,
  active         tinyint(1)    NOT NULL DEFAULT 1,
  created_at     datetime      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     datetime      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_portal_cards_key (card_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ── 2. Seed: payment card ───────────────────────────────────────────────────
-- Replaces the hardcoded payment card (case.html S2). No conditions — always
-- renders (pre-E1 parity: the payment card shows on every case view).
-- placement 'case' = below the progress timeline, same position as today.
-- Body copy drafted by E1 worker — PENDING FRED'S APPROVAL; edit the row (or
-- this seed pre-run) if the wording changes. The old hardcoded pay-note
-- ("Opens our secure payment page in a new tab.") is superseded by the
-- generic under-button note the client renders beneath EVERY card link
-- ("Opens in a new tab.") plus this body line.

INSERT INTO portal_cards
  (card_key, title, body_type, body_template, coded_key,
   link_url, link_label, conditions, placement, sort, active)
SELECT
  'payment', 'Payments', 'template',
  'You can make a secure online payment toward your account at any time.',
  NULL,
  '/r/payment', 'Make a payment', NULL, 'case', 10, 1
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM portal_cards WHERE card_key = 'payment');


-- ── 3. Seed: Meeting of Creditors (341) card ────────────────────────────────
-- The 341 BODY stays coded (client renderer keyed 'meeting341' — date/time/
-- link formatting stays in portalCaseService + case.html). The GATES move
-- here as engine conditions, translated EXACTLY from the shipped
-- buildMeeting341 (S2.1 + Fred's BK-exclusivity addition, verified against
-- services/portalCaseService.js 2026-08-07):
--   • BK gate:   trimmed case_chapter non-empty OR trimmed case_type =
--                'Bankruptcy'  → the nested "any" group.
--   • 341 set:   case_341_current non-null → not_empty.
--   • past-date: firm-local DATE >= today (today still shows; date-only,
--                time ignored) → date_future (engine op is >= today by
--                definition; reads the datetime's NAIVE components —
--                case_341_current is firm-local wall time stored as-if-UTC,
--                exactly buildMeeting341's read).
-- placement 'case_top' = above the progress timeline, same position as today.

INSERT INTO portal_cards
  (card_key, title, body_type, body_template, coded_key,
   link_url, link_label, conditions, placement, sort, active)
SELECT
  'meeting341', 'Meeting of Creditors (341)', 'coded', NULL, 'meeting341',
  NULL, NULL,
  '{
    "mode": "rules",
    "match": "all",
    "rules": [
      { "match": "any", "rules": [
        { "field": "cases.case_chapter", "op": "not_empty" },
        { "field": "cases.case_type", "op": "in", "value": ["Bankruptcy"] }
      ]},
      { "field": "cases.case_341_current", "op": "not_empty" },
      { "field": "cases.case_341_current", "op": "date_future" }
    ]
  }',
  'case_top', 10, 1
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM portal_cards WHERE card_key = 'meeting341');
