-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-08-09 — Client Portal, riders R1 + R2 (mini-slice; the S4 messaging
--              core is PARKED — see scratch ns=fred k=portal_s4_messaging_parked)
--
-- WHY
--   R1 — portal docs upload notification recipients move from hardcoded
--   constants (services/portalDocsService.js) to app_settings, resolved per
--   send. Seeds carry the EXACT values that were hardcoded, so behavior is
--   unchanged until staff edit them.
--
--   * portal_docs_notify_from — sender address for the "New Documents
--     Uploaded" email. Seed: automations@4lsg.com (the pre-R1 hardcode).
--   * portal_docs_notify_to   — recipient. Seed: rena@4lsg.com (ditto).
--     BLANK either value = notifications deliberately OFF (email skipped
--     with a server warning; the case-log entry still writes) — the
--     office_alerts_to "empty ⇒ feature off" precedent.
--     PARITY NOTE: the PUBLIC upload-complete route (api.checklists.js)
--     still hardcodes automations@4lsg.com → rena@4lsg.com. Editing these
--     settings retargets the PORTAL notification only — keep the pair in
--     sync until that route is settings-driven too.
--
--   R2 — the two remaining HARDCODED nav cards in public/portal/case.html
--   (Documents, "Need a call?") move into the card engine:
--
--   * docsNav  — CODED card (coded_key 'docsNav', added to
--     KNOWN_CODED_KEYS + a case.html renderer, deploy-level pair). Coded
--     because its link is per-case (docs.html?id=<case_id>) — a static
--     link_url cannot carry the id and URL templating is deliberately NOT
--     being added.
--   * callback — plain TEMPLATE row: no body, static
--     link_url '/portal/callback.html'. Fully admin-editable in Portal
--     Manager like the payment card.
--
--   sort values 2 (docsNav) and 4 (callback) place both AHEAD of the
--   payment row (sort 10) in placement 'case', reproducing the pre-R2
--   visual order below the timeline: Documents → Need a call? → Payments.
--   Byte-level render parity (modulo the callback href value, now
--   /portal/callback.html instead of the relative callback.html — same
--   destination) verified by harness against the pre-R2 client.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- Run BEFORE deploying the R1+R2 code (migrations before code — house rule),
-- ideally immediately before:
--   * R1 rows are inert until the new portalDocsService ships. If the code
--     deploys FIRST (order violated), notifications skip-with-warning until
--     these rows exist — never an error, never a blocked upload.
--   * R2 rows + OLD code = a brief cosmetic window: the OLD client still
--     hardcodes both nav cards, so the seeded callback TEMPLATE row renders
--     a SECOND "Need a call?" card (with the old new-tab treatment), and
--     the docsNav CODED card is silently skipped (unknown coded_key —
--     client-side skip by design). Nothing breaks; deploy promptly to
--     close the window.
--
-- ── IDEMPOTENT / RE-RUN POSTURE ─────────────────────────────────────────────
-- Every statement is single-statement-self-contained (no session vars, no
-- PREPARE/EXECUTE — the admin DB console runs each statement on a separate
-- pooled connection; 2026-08-05 incident).
--   * app_settings: INSERT … ON DUPLICATE KEY UPDATE with `value`
--     deliberately ABSENT from the UPDATE list (house pattern —
--     2026-08-06_portal_s3_5.sql): re-running refreshes metadata but never
--     resets a live value.
--   * portal_cards: INSERT … SELECT … WHERE NOT EXISTS keyed on card_key —
--     a re-run inserts nothing and NEVER clobbers staff edits (title/sort/
--     active/link all staff-ownable post-seed).
-- Safe to re-run end to end.
--
-- ── AFTER RUNNING ───────────────────────────────────────────────────────────
-- Regenerate the schema snapshot via POST /admin/db/schema/save-to-ref
-- (ref/database.sql is auto-generated — do not hand-edit it). No DDL in
-- this file, so this is optional; app_settings/portal_cards row content
-- isn't part of the snapshot.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- DELETE FROM app_settings WHERE `key` IN ('portal_docs_notify_from', 'portal_docs_notify_to');
-- DELETE FROM portal_cards WHERE card_key IN ('docsNav', 'callback');
-- (Code rollback: revert the R1+R2 commit — the pre-R2 case.html hardcodes
--  both nav cards and the pre-R1 portalDocsService hardcodes the
--  notification addresses; neither reads these rows.)
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. R1: notification settings ────────────────────────────────────────────

INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES
  ('portal_docs_notify_from', 'automations@4lsg.com', 0, 1, 'Portal',
   'Portal Docs Upload Notification — From',
   'Sender address for the email staff receive when a client uploads documents through the portal. Blank = upload notification emails off (the case log entry still writes). NOTE: the public docReq upload flow has its own hardcoded copy of this address — keep them in sync.',
   'text', 40)
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
  ('portal_docs_notify_to', 'rena@4lsg.com', 0, 1, 'Portal',
   'Portal Docs Upload Notification — To',
   'Recipient of the email staff receive when a client uploads documents through the portal. Blank = upload notification emails off (the case log entry still writes). NOTE: the public docReq upload flow has its own hardcoded copy of this address — keep them in sync.',
   'text', 50)
ON DUPLICATE KEY UPDATE
  is_secret   = VALUES(is_secret),
  is_editable = VALUES(is_editable),
  category    = VALUES(category),
  label       = VALUES(label),
  description = VALUES(description),
  type        = VALUES(type),
  sort_order  = VALUES(sort_order);


-- ── 2. R2: Documents nav card (coded) ───────────────────────────────────────
-- No conditions — renders on every case view, exactly like the hardcoded
-- card it replaces. sort 2 → first card below the timeline.

INSERT INTO portal_cards
  (card_key, title, body_type, body_template, coded_key,
   link_url, link_label, conditions, placement, sort, active)
SELECT
  'docsNav', 'Documents', 'coded', NULL, 'docsNav',
  NULL, NULL, NULL, 'case', 2, 1
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM portal_cards WHERE card_key = 'docsNav');


-- ── 3. R2: callback nav card (template) ─────────────────────────────────────
-- No body, structured link only. /portal/callback.html is a PORTAL-INTERNAL
-- link — the R2 client renders /portal/-prefixed links same-tab with no
-- "Opens in a new tab." note (external links, including /r/… redirects,
-- keep the new-tab treatment). sort 4 → between docsNav and payment.

INSERT INTO portal_cards
  (card_key, title, body_type, body_template, coded_key,
   link_url, link_label, conditions, placement, sort, active)
SELECT
  'callback', 'Need a call?', 'template', NULL, NULL,
  '/portal/callback.html', 'Request a callback', NULL, 'case', 4, 1
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM portal_cards WHERE card_key = 'callback');
