-- ============================================================================
-- Phase D v2: SMS intake-link cutover — RETARGETED to the landing origin
--   go.4lsg.com/intake?id=<case_id>  →  https://4lsg.com/p/form?f=intake&case_id=<case_id>
--
-- SUPERSEDES ref/2026-08-13_phase_d_sms_cutover.sql (which targeted
-- app.4lsg.com/p/form). Rationale, decided with Fred 2026-08-16: system
-- links use the /p prefix on the landing host (his stated preference —
-- "cleanest"), the host is 4 chars shorter than app.4lsg.com AND the link no
-- longer points staff-authorable public content at the app origin. Root-slug
-- form (https://4lsg.com/form?f=…) also works if 2 more chars ever matter.
--
-- STATUS: STAGED — DO NOT RUN until BOTH gates pass:
--   1. supermanager approval (unchanged from v1), AND
--   2. origin-separation rollout steps 1–6 complete and verified
--      (https://4lsg.com/p/form?f=intake&case_id=<real> loads and submits).
--
-- Targets: same 9 sequence_steps rows as v1 (re-verified against prod
-- 2026-08-16 — still carrying go.4lsg.com):
--   template 22 (steps 2,4,6,9  — ids 71,73,75,78): schemed
--   template 20 (steps 2,3,5,7,10 — ids 84,85,87,89,92): scheme-less
--
-- Safety properties: identical to v1 (single-statement, idempotent, REPLACE
-- can't touch JSON structure, mid-flight enrollments pick up the new link at
-- their next link-carrying step). The go.4lsg.com → short.io → Pabbly →
-- Jotform legacy chain again stays alive through a drain window and is
-- retired later as one unit — reclaiming the `go` subdomain rides THAT
-- retirement, not this cut.
-- ============================================================================

-- ── 0. Verify before (expect 9 rows, all carrying go.4lsg.com) ──────────────
SELECT id, template_id, step_number, action_config FROM sequence_steps WHERE id IN (71,73,75,78,84,85,87,89,92);

-- ── 1. Cut, template 22 (schemed pattern) ───────────────────────────────────
UPDATE sequence_steps SET action_config = REPLACE(action_config, 'https://go.4lsg.com/intake?id=', 'https://4lsg.com/p/form?f=intake&case_id=') WHERE id IN (71,73,75,78);

-- ── 2. Cut, template 20 (scheme-less pattern) ───────────────────────────────
UPDATE sequence_steps SET action_config = REPLACE(action_config, 'go.4lsg.com/intake?id=', 'https://4lsg.com/p/form?f=intake&case_id=') WHERE id IN (84,85,87,89,92);

-- ── 2b. Only if v1 was ever run first (harmless no-op otherwise) ─────────────
UPDATE sequence_steps SET action_config = REPLACE(action_config, 'https://app.4lsg.com/p/form?f=intake&case_id=', 'https://4lsg.com/p/form?f=intake&case_id=') WHERE id IN (71,73,75,78,84,85,87,89,92);

-- ── 3. Verify after ─────────────────────────────────────────────────────────
-- Expect 0 rows:
SELECT id FROM sequence_steps WHERE template_id IN (20,22) AND (action_config LIKE '%go.4lsg.com%' OR action_config LIKE '%app.4lsg.com/p/form%');
-- Expect 9 rows:
SELECT id FROM sequence_steps WHERE template_id IN (20,22) AND action_config LIKE '%https://4lsg.com/p/form?f=intake%';

-- ── 4. Restore (inverse — only if rollback is ever needed) ──────────────────
-- UPDATE sequence_steps SET action_config = REPLACE(action_config, 'https://4lsg.com/p/form?f=intake&case_id=', 'https://go.4lsg.com/intake?id=') WHERE id IN (71,73,75,78);
-- UPDATE sequence_steps SET action_config = REPLACE(action_config, 'https://4lsg.com/p/form?f=intake&case_id=', 'go.4lsg.com/intake?id=') WHERE id IN (84,85,87,89,92);
-- (Byte-exact pre-cut message text: see the BACKUP block in
--  ref/2026-08-13_phase_d_sms_cutover.sql — unchanged, still authoritative.)
