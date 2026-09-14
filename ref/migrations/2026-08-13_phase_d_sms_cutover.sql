-- ============================================================================
-- Phase D: SMS intake-link cutover
--   go.4lsg.com/intake?id=<case_id>  →  https://app.4lsg.com/p/form?f=intake&case_id=<case_id>
--
-- STATUS: STAGED — DO NOT RUN until Phase D is approved (supermanager gate).
-- Committed to ref/ for the record ahead of approval.
--
-- Targets (verified against prod 2026-08-13): 9 rows in sequence_steps.
--   template 20 (steps 2,3,5,7,10 — ids 84,85,87,89,92): scheme-less
--     "go.4lsg.com/intake?id={{cases.case_id}}"
--   template 22 (steps 2,4,6,9  — ids 71,73,75,78): schemed
--     "https://go.4lsg.com/intake?id={{cases.case_id}}"
--
-- Safety properties:
--   * Each statement is single-statement-self-contained (DB console rule).
--   * Idempotent: after the first run the source pattern is gone; reruns no-op.
--   * REPLACE() on the JSON column round-trips string→JSON safely — the URL
--     substitution cannot touch JSON structure (no quotes/braces involved).
--   * Steps read action_config at fire time, so a mid-flight enrollment simply
--     sends the new (working) link from its next link-carrying step onward.
--
-- Retirement of the old chain (go.4lsg.com → Pabbly → Jotform 231710991971158
-- + its notification email) is deliberately NOT part of this cut: old links
-- already delivered by SMS must keep working through a drain window. Retire
-- the chain as one unit later.
-- ============================================================================

-- ── 0. Verify before (expect 9 rows, all carrying go.4lsg.com) ──────────────
SELECT id, template_id, step_number, action_config FROM sequence_steps WHERE id IN (71,73,75,78,84,85,87,89,92);

-- ── 1. Cut, template 22 (schemed pattern) ───────────────────────────────────
UPDATE sequence_steps SET action_config = REPLACE(action_config, 'https://go.4lsg.com/intake?id=', 'https://app.4lsg.com/p/form?f=intake&case_id=') WHERE id IN (71,73,75,78);

-- ── 2. Cut, template 20 (scheme-less pattern) ───────────────────────────────
UPDATE sequence_steps SET action_config = REPLACE(action_config, 'go.4lsg.com/intake?id=', 'https://app.4lsg.com/p/form?f=intake&case_id=') WHERE id IN (84,85,87,89,92);

-- ── 3. Verify after ─────────────────────────────────────────────────────────
-- Expect 0 rows:
SELECT id FROM sequence_steps WHERE template_id IN (20,22) AND action_config LIKE '%go.4lsg.com%';
-- Expect 9 rows:
SELECT id FROM sequence_steps WHERE template_id IN (20,22) AND action_config LIKE '%/p/form?f=intake%';

-- ── 4. Restore (inverse — only if rollback is ever needed) ──────────────────
-- UPDATE sequence_steps SET action_config = REPLACE(action_config, 'https://app.4lsg.com/p/form?f=intake&case_id=', 'https://go.4lsg.com/intake?id=') WHERE id IN (71,73,75,78);
-- UPDATE sequence_steps SET action_config = REPLACE(action_config, 'https://app.4lsg.com/p/form?f=intake&case_id=', 'go.4lsg.com/intake?id=') WHERE id IN (84,85,87,89,92);

-- ============================================================================
-- BACKUP: exact pre-cut message text, captured from prod 2026-08-13 (readonly
-- session). Full action_config differs from these only in the URL. Kept here
-- so a restore can be verified byte-for-byte if REPLACE inverse is ever in
-- doubt.
--
-- id=84 tpl=20 step=2  (send_sms, from 2484179800)
--   "...make sure you will not lose any property: go.4lsg.com/intake?id={{cases.case_id}}"
-- id=85 tpl=20 step=3
--   "...so I am fully prepared: go.4lsg.com/intake?id={{cases.case_id}}"
-- id=87 tpl=20 step=5
--   "...take a couple minutes to complete it: go.4lsg.com/intake?id={{cases.case_id}}"
-- id=89 tpl=20 step=7
--   "...so I can help you best: go.4lsg.com/intake?id={{cases.case_id}}"
-- id=92 tpl=20 step=10
--   "...complete it before we meet? go.4lsg.com/intake?id={{cases.case_id}}"
-- id=71 tpl=22 step=2  (send_sms, from {{users.default_phone}})
--   "...Thanks!\nhttps://go.4lsg.com/intake?id={{cases.case_id}}"
-- id=73 tpl=22 step=4
--   "...Thanks!\nhttps://go.4lsg.com/intake?id={{cases.case_id}}"
-- id=75 tpl=22 step=6
--   "...Thanks!\nhttps://go.4lsg.com/intake?id={{cases.case_id}}"
-- id=78 tpl=22 step=9
--   "...Thanks!\nhttps://go.4lsg.com/intake?id={{cases.case_id}}"
-- ============================================================================