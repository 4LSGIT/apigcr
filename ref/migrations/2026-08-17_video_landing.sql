-- ============================================================================
-- Video landing on the landing host (2026-08-17) — content edits only
-- Companion to: routes/pageLanding.js (allowlist + isMigratedPath),
--               routes/videoLanding.js (og:url pin),
--               public/{videoManager.html,js/videoInsert.js,sendingform-bk.html}
--               (link-minting defaults),
--               ref/ORIGIN_SEPARATION_ROLLOUT.md § "Video landing slice".
--
-- NO settings rows are added by this file. landing_hosts / landing_redirect
-- already exist and are unchanged; the code slice extends what those two
-- knobs cover. Verified live 2026-08-16:
--   landing_hosts='4lsg.com', landing_redirect='1'
--
-- Everything here is COSMETIC. The app-host 302s keep every unmigrated link
-- working, so a row missed by the sweep degrades to one extra hop, never a
-- break. Ship the code without this file if you want; run it at leisure.
--
-- SENT HISTORY IS DELIBERATELY UNTOUCHED. The sweep (2026-08-17) also found
-- app-host /v/ links in ~20 `log` rows (sent SMS/email bodies, 12 contacts,
-- 2026-05-04 → 2026-08-13) and 2 sent `campaigns` bodies (104 = app-host
-- link, 105 = a localhost URL — already broken, a test artifact). Those are
-- records of what was sent, not templates: nothing re-sends from them, and
-- the app-host 302 keeps every already-delivered link working. Rewriting
-- history buys nothing and falsifies the audit trail.
--
-- DB-console rules: every statement is single-statement-self-contained.
-- All statements are idempotent (REPLACE()-with-gone-source).
-- ============================================================================


-- ── 0. Verify BEFORE ────────────────────────────────────────────────────────
-- The three live rows are sequence-step JSON (send_sms message bodies).
-- Sequence steps are staff-editable, so a human may have changed them since
-- 2026-08-17 — if the app-host substring is gone from a row, that REPLACE is
-- a no-op and you must hand-check instead. Do NOT blind-REPLACE unread rows.
SELECT ss.id, ss.template_id, ss.step_number, st.name
  FROM sequence_steps ss
  JOIN sequence_templates st ON st.id = ss.template_id
 WHERE ss.action_config LIKE '%app.4lsg.com/v/%';
-- Expected (verified live 2026-08-17): exactly these three rows —
--   id 60  template 19 step 4  …https://app.4lsg.com/v/pre-341-info?c={{contacts.contact_id}}
--   id 81  template 19 step 2  …https://app.4lsg.com/v/341-reminder?c={{contacts.contact_id}}
--   id 83  template 20 step 1  …https://app.4lsg.com/v/welcome?c={{contacts.contact_id}}

-- Re-run the broad sweep too — new rows may have appeared since.
SELECT `key` FROM app_settings   WHERE `value`        LIKE '%app.4lsg.com/v/%';  -- expect 0
SELECT id    FROM workflow_steps WHERE config          LIKE '%app.4lsg.com/v/%';  -- expect 0
SELECT id    FROM pages          WHERE html            LIKE '%app.4lsg.com/v/%';  -- expect 0
SELECT id    FROM videos         WHERE description     LIKE '%app.4lsg.com/v/%'
                                    OR actions         LIKE '%app.4lsg.com/v/%';  -- expect 0
-- 2026-08-17 result: 3 sequence steps, 0 everywhere else. Section 1 below
-- covers exactly those three.


-- ── 1. sequence_steps — SMS bodies, plain host swap ─────────────────────────
-- These are LIVE templates (future sends), unlike the log/campaign history
-- above. The {{contacts.contact_id}} placeholder is untouched; only the
-- origin changes. All three are SMS bodies; /v/ has no short alias (a /vid
-- alias was considered and skipped — /v/ is already minimal), so the path
-- shape is unchanged.
-- Idempotence/uniqueness: each row carries exactly ONE occurrence of the
-- app-host /v/ substring (verified 2026-08-17 via LENGTH-diff), so REPLACE
-- touches exactly one link per row.
UPDATE sequence_steps
   SET action_config = REPLACE(action_config, 'https://app.4lsg.com/v/', 'https://4lsg.com/v/')
 WHERE id = 60 AND action_config LIKE '%app.4lsg.com/v/%';

UPDATE sequence_steps
   SET action_config = REPLACE(action_config, 'https://app.4lsg.com/v/', 'https://4lsg.com/v/')
 WHERE id = 81 AND action_config LIKE '%app.4lsg.com/v/%';

UPDATE sequence_steps
   SET action_config = REPLACE(action_config, 'https://app.4lsg.com/v/', 'https://4lsg.com/v/')
 WHERE id = 83 AND action_config LIKE '%app.4lsg.com/v/%';


-- ── 2. Verify AFTER ─────────────────────────────────────────────────────────
SELECT id FROM sequence_steps WHERE action_config LIKE '%app.4lsg.com/v/%';      -- expect 0 rows
SELECT id FROM sequence_steps WHERE action_config LIKE '%https://4lsg.com/v/%';  -- expect 60, 81, 83


-- ── 3. Inverse revert ───────────────────────────────────────────────────────
-- ORDER MATTERS on a full rollback: these edits point at 4lsg.com; if the
-- Cloud Run domain mapping is ever removed, run THIS section FIRST, then
-- unmap DNS, then blank landing_hosts — same rule as the booking slice.
--
-- UPDATE sequence_steps SET action_config = REPLACE(action_config, 'https://4lsg.com/v/', 'https://app.4lsg.com/v/') WHERE id = 60;
-- UPDATE sequence_steps SET action_config = REPLACE(action_config, 'https://4lsg.com/v/', 'https://app.4lsg.com/v/') WHERE id = 81;
-- UPDATE sequence_steps SET action_config = REPLACE(action_config, 'https://4lsg.com/v/', 'https://app.4lsg.com/v/') WHERE id = 83;
--
-- The code side reverts independently and needs none of the above:
--   landing_redirect='0'  → app host stops 302ing /v/* (landing host keeps
--                           serving it in parallel, so nothing breaks)
