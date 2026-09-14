-- ============================================================================
-- Booking + manage on the landing host (2026-08-16) — content edits only
-- Companion to: routes/pageLanding.js (allowlist + isMigratedPath + robots),
--               routes/booking.js (/b/:slug alias),
--               ref/ORIGIN_SEPARATION_ROLLOUT.md § "Follow-up slice".
--
-- NO settings rows are added by this file. landing_hosts / landing_redirect
-- already exist (ref/2026-08-16_origin_separation.sql) and are unchanged; the
-- code slice extends what those two knobs cover. Verified live 2026-08-16:
--   landing_hosts='4lsg.com', landing_redirect='1'  (i.e. rollout step 6 done)
--
-- Everything here is COSMETIC. The app-host 302s keep every unmigrated link
-- working, so a row missed by the sweep degrades to one extra hop, never a
-- break. Ship the code without this file if you want; run it at leisure.
--
-- DB-console rules: every statement is single-statement-self-contained.
-- All statements are idempotent (REPLACE()-with-gone-source).
--
-- LINK-SHAPE CONVENTION (decided this slice, applied below and in the repo):
--   /b/:slug      — anything that lands in an SMS body (3 chars saved per
--                   message against a 160-char GSM-7 segment boundary)
--   /book/:slug   — anything rendered as a link or button in a browser, where
--                   readability beats length
--   Both are permanent. /book/:slug is never deprecated.
-- ============================================================================


-- ── 0. Verify BEFORE ────────────────────────────────────────────────────────
-- Read the three settings rows first. All are is_editable = 1, so a human may
-- have edited them since 2026-08-16 — if any value differs from the source
-- string in the REPLACE() below, that statement is a no-op and you must hand-
-- edit instead. Do NOT blind-REPLACE a value you have not read.
SELECT `key`, `value`, is_editable FROM app_settings
 WHERE `key` IN ('manage_cancel_template', 'manage_reschedule_template', 'manage_fallback_url');

-- Expected (verified live 2026-08-16):
--   manage_cancel_template      …Need a new time? https://app.4lsg.com/m/{{appts.appt_manage_token|default:}}
--   manage_reschedule_template  …Manage or cancel anytime: https://app.4lsg.com/m/{{appts.appt_manage_token|default:}}
--   manage_fallback_url         {"url":"https://app.4lsg.com/book/consult","button_text":"Book a new time"}

-- Re-run the broad sweep too — new rows may have appeared since.
SELECT `key`, `value` FROM app_settings
 WHERE `value` LIKE '%app.4lsg.com/m/%' OR `value` LIKE '%app.4lsg.com/book%' OR `value` LIKE '%app.4lsg.com/b/%';
SELECT ss.template_id, ss.step_number, st.name FROM sequence_steps ss
  JOIN sequence_templates st ON st.id = ss.template_id
 WHERE ss.action_config LIKE '%app.4lsg.com/m/%' OR ss.action_config LIKE '%app.4lsg.com/book%';
SELECT ws.workflow_id, ws.step_number FROM workflow_steps ws
 WHERE ws.config LIKE '%app.4lsg.com/m/%' OR ws.config LIKE '%app.4lsg.com/book%';
SELECT id, slug FROM pages
 WHERE html LIKE '%app.4lsg.com/book%' OR html LIKE '%app.4lsg.com/m/%';
-- 2026-08-16 result: 3 settings rows, 0 sequence steps, 0 workflow steps,
-- 1 page (id 2, mich-tax-prep). Sections 1 and 2 below cover exactly those.


-- ── 1. app_settings — SMS/UI copy, plain host swap ──────────────────────────
-- These are copy, not plumbing. The token placeholder is untouched; only the
-- origin changes. Both are SMS bodies → /m/ (already minimal, no /b involved).
UPDATE app_settings SET `value` = REPLACE(`value`, 'https://app.4lsg.com/m/', 'https://4lsg.com/m/')
 WHERE `key` = 'manage_cancel_template';

UPDATE app_settings SET `value` = REPLACE(`value`, 'https://app.4lsg.com/m/', 'https://4lsg.com/m/')
 WHERE `key` = 'manage_reschedule_template';

-- Rendered as a BUTTON on the manage page's invalid-link fallback, not an SMS
-- → keep the readable /book/ form. Value is JSON; REPLACE on the substring
-- leaves the JSON structure intact (verified: the URL is not escaped).
UPDATE app_settings SET `value` = REPLACE(`value`, 'https://app.4lsg.com/book/', 'https://4lsg.com/book/')
 WHERE `key` = 'manage_fallback_url';


-- ── 2. pages — the deferred page-2 iframe ───────────────────────────────────
-- ref/2026-08-16_origin_separation.sql deliberately skipped this one because
-- booking was still app-host-only. Now it is not, so finish the job the same
-- way pages 3 and 4 were done: absolute → relative, so the embed is
-- same-origin with its parent on WHICHEVER host serves the page.
--
-- Without this the iframe still works (the app host 302s to the landing host
-- and browsers follow redirects inside frames) — it just pays a redirect on
-- every page view and pins a host in authored content.
--
-- Uniqueness verified 2026-08-16: exactly ONE occurrence of the full src
-- string, and exactly one occurrence of 'app.4lsg.com/book' in the row.
--   SELECT (LENGTH(html)-LENGTH(REPLACE(html,'app.4lsg.com/book','')))
--          / LENGTH('app.4lsg.com/book') FROM pages WHERE id = 2;   -- → 1
UPDATE pages
   SET html = REPLACE(html, 'src="https://app.4lsg.com/book/mich-tax-prep"', 'src="/book/mich-tax-prep"')
 WHERE slug = 'mich-tax-prep';


-- ── 3. Verify AFTER ─────────────────────────────────────────────────────────
-- Expect the three settings rows to read 4lsg.com, and both sweeps to be empty.
SELECT `key`, `value` FROM app_settings
 WHERE `key` IN ('manage_cancel_template', 'manage_reschedule_template', 'manage_fallback_url');

SELECT `key` FROM app_settings
 WHERE `value` LIKE '%app.4lsg.com/m/%' OR `value` LIKE '%app.4lsg.com/book%';   -- expect 0 rows

SELECT id, slug FROM pages
 WHERE html LIKE '%app.4lsg.com/book%' OR html LIKE '%app.4lsg.com/m/%';         -- expect 0 rows

SELECT id, slug FROM pages WHERE html LIKE '%src="/book/mich-tax-prep"%';        -- expect id 2


-- ── 4. Inverse revert ───────────────────────────────────────────────────────
-- ORDER MATTERS on a full rollback. These edits point at 4lsg.com; if the
-- Cloud Run domain mapping is ever removed, these links die. So on a teardown:
-- run THIS section FIRST, then unmap DNS, then blank landing_hosts — the exact
-- reverse of the forward order, and the mirror of the rule in the rollout
-- note's revert section.
--
-- UPDATE app_settings SET `value` = REPLACE(`value`, 'https://4lsg.com/m/', 'https://app.4lsg.com/m/')       WHERE `key` = 'manage_cancel_template';
-- UPDATE app_settings SET `value` = REPLACE(`value`, 'https://4lsg.com/m/', 'https://app.4lsg.com/m/')       WHERE `key` = 'manage_reschedule_template';
-- UPDATE app_settings SET `value` = REPLACE(`value`, 'https://4lsg.com/book/', 'https://app.4lsg.com/book/') WHERE `key` = 'manage_fallback_url';
-- UPDATE pages SET html = REPLACE(html, 'src="/book/mich-tax-prep"', 'src="https://app.4lsg.com/book/mich-tax-prep"') WHERE slug = 'mich-tax-prep';
--
-- The code side reverts independently and needs none of the above:
--   landing_redirect='0'  → app host stops 302ing /book and /m (landing host
--                           keeps serving them in parallel, so nothing breaks)
--   landing_hosts=''      → 4lsg.com becomes an unknown host again; ONLY after
--                           DNS no longer maps it (see the rollout note).
