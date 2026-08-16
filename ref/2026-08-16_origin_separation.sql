-- ============================================================================
-- Origin separation (2026-08-16) — settings rows + DB page content edits
-- Companion to: routes/pageLanding.js host router, lib/firmConfig.js keys,
--               ref/ORIGIN_SEPARATION_ROLLOUT.md (ordering + DNS steps).
--
-- DB-console rules: every statement is single-statement-self-contained.
-- All statements are idempotent (INSERT IGNORE / REPLACE()-with-gone-source).
-- ============================================================================

-- ── 1. Settings rows ─────────────────────────────────────────────────────────
-- is_editable = 0 ON PURPOSE: these define a security boundary, so changing
-- them is an SU act via DB console (which, after rider B, also requires
-- step-up) — never a settings-tab edit. lib/firmConfig reads them regardless
-- of is_editable; env fallbacks LANDING_HOSTS / LANDING_REDIRECT remain for
-- emergencies. landing_redirect starts '0': map + verify the landing host
-- FIRST, flip to '1' only at cutover (rollout step 6).

INSERT IGNORE INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES ('landing_hosts', '4lsg.com', 0, 0, 'system', 'Landing hosts', 'CSV of hostnames served as the public landing origin (pages, /f, /r, /api/ext ONLY — everything else dead-ends). First entry = canonical redirect target. Empty = feature off. SU/DB-console only.', 'csv', 990);

INSERT IGNORE INTO app_settings (`key`, `value`, is_secret, is_editable, category, label, description, `type`, sort_order)
VALUES ('landing_redirect', '0', 0, 0, 'system', 'Landing redirects', '1 = non-landing hosts 302 GET /p/*, /f/*, and ext-mode render to the canonical landing host. Flip to 1 only after the landing mapping + cert are verified. 0 = instant revert. SU/DB-console only.', 'bool', 991);

-- Verify:
SELECT `key`, `value`, is_editable FROM app_settings WHERE `key` IN ('landing_hosts', 'landing_redirect');

-- ── 2. Page content edits (run any time after the settings rows) ────────────
-- Page 4 ("form", the SMS wrapper): FORM_BASE absolute → relative. Relative
-- '/f/' targets whatever host serves the page — app host today, landing host
-- after cutover — and keeps the iframe same-origin with its parent on BOTH,
-- so grow-mode keeps working with no redirect hop. Verified unique substring
-- (one occurrence in the page HTML, ref/pages/form.html line 232).
UPDATE pages SET html = REPLACE(html, '''https://app.4lsg.com/f/''', '''/f/''') WHERE slug = 'form';

-- Page 3 ("intake" landing page): noscript fallback link → relative, same
-- reasoning. Verified single occurrence.
UPDATE pages SET html = REPLACE(html, 'href="https://app.4lsg.com/f/intake"', 'href="/f/intake"') WHERE slug = 'intake';

-- Page 2 ("mich-tax-prep") deliberately NOT edited: its iframe targets
-- app.4lsg.com/book/… — booking stays on the app host this slice (see the
-- rollout note's "not done" list), and a cross-origin iframe of a booking
-- page works fine.

-- Verify (expect 0 rows):
SELECT id, slug FROM pages WHERE html LIKE '%app.4lsg.com/f/%';

-- ── 3. Revert ────────────────────────────────────────────────────────────────
-- Settings: UPDATE app_settings SET `value`='0'  WHERE `key`='landing_redirect';
--           UPDATE app_settings SET `value`=''   WHERE `key`='landing_hosts';
--           (ONLY empty landing_hosts AFTER DNS no longer maps 4lsg.com to
--           Cloud Run — an emptied list while the mapping stands serves the
--           FULL APP on 4lsg.com. See rollout note, revert section.)
-- Page 4:   UPDATE pages SET html = REPLACE(html, '''/f/''', '''https://app.4lsg.com/f/''') WHERE slug = 'form';
-- Page 3:   UPDATE pages SET html = REPLACE(html, 'href="/f/intake"', 'href="https://app.4lsg.com/f/intake"') WHERE slug = 'intake';