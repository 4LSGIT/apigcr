-- ============================================================
-- T8 — cases.pipeline_phase: give the pipeline its second axis
--
-- WHY: services/pipelineService.resolveTemplate branch 1 read
--
--     if (subtype === '') return intake;
--
-- which uses WHAT KIND OF MATTER a case is to answer WHERE IT IS IN ITS
-- LIFECYCLE. Empty subtype stood in for "we don't know enough yet, so they
-- must still be in intake." The proxy is false: a referral can be an obvious
-- Chapter 7 on day one and still be an unsigned lead — it may have arrived
-- off a Chapter 7 drip, or been pre-qualified.
--
-- The consequence was not a crash. A case whose chapter was known but who had
-- not retained resolved to a chapter template whose FIRST stage is `retained`
-- — a state not yet true. It had no valid stage to occupy, so getBoard put it
-- in `unstaged` on the CHAPTER board and getPipeline set upcoming to the whole
-- chapter template. It looked fine and was filed in the wrong place with its
-- intake position erased. Worse than invisible.
--
-- Matter type and lifecycle phase are independent facts. This migration adds
-- the missing axis instead of collapsing the two.
--
--   pipeline_phase  = LIFECYCLE (intake funnel vs post-retainer case)
--   case_type/_subtype = MATTER (Chapter 7 vs Chapter 13 vs Litigation)
--
-- resolveTemplate now asks phase FIRST, matter SECOND. case_subtype therefore
-- means subtype and nothing else, and is legitimate — expected — on a lead.
-- Chapter boards become post-retainer only, by design.
--
-- REJECTED ALTERNATIVE, recorded because it looks right and is not:
-- duplicating the nine active Intake stages onto both chapter templates.
-- advanceStage's `onlyFromRole` guard is judged against the LATEST LOG ROW's
-- template_id → pipeline_templates.role. Two live callers depend on it:
-- workflow 42 step 5 (only_from_role 'intake,none' → `retained`) and
-- services/esignSendService.js (~L1762, onlyFromRole ['intake', null] →
-- `contract_sent`). Duplicating intake stages onto role='case' templates makes
-- a known-Ch7 lead log `lead` with template_id=2, role 'case' — both guards
-- then stop matching, as a guard SKIP: no insert, no throw, no alert. The
-- retainer and contract-sent advances would quietly stop working for exactly
-- the population the change was meant to serve. Keeping intake stages on the
-- intake template alone is what preserves those two guards untouched.
--
-- ── WHAT ────────────────────────────────────────────────────────────────
-- One column and one backfill. NO pipeline_stages rows are added, none are
-- renumbered, and no case_stage_log row is written, re-pointed or deleted.
-- That is deliberate: it is what makes "no existing history is orphaned or
-- reinterpreted" provable rather than argued.
--
-- ── BACKFILL PREDICATE ──────────────────────────────────────────────────
-- Verified against all 1,077 live cases before being written here. Evaluated
-- in this priority order; first hit wins; everything else stays 'intake'.
--
--   A  has a case_stage_log row on a role='case' template ......  70
--   B  case_file_date IS NOT NULL ............................... 124
--   C  non-blank case_number OR case_number_full ................  36
--   D  case_stage IN ('Filed','Concluded') ......................   0  (all caught above)
--   E  case_status IN ('Signed Post-Petition',
--                      'Pre-petition signed','Case Filed') ......  12
--                                                          case = 242
--   everything else ........................................... intake = 835
--
-- Counts measured 2026-08-19. They will DRIFT — 10 of them moved during the
-- session that wrote this file, when the chapterless-retained repair landed.
-- The predicate is what matters; re-measure before you run it and expect the
-- totals to differ. Nothing in the predicate depends on the counts.
--
-- A is the strongest signal and is why it leads: a case-template stage was
-- actually LOGGED, so advanceStage itself already asserted the phase. B and C
-- mean the matter reached a court, which cannot happen pre-retainer. E catches
-- retained-but-never-filed cases that carry no docket at all.
--
-- The 835 'intake' rows include 157 case_status='Stale Lead' and 677
-- Open/blank — dead and live leads respectively. Both are correctly intake:
-- a lead that went cold is still a lead.
--
-- KNOWN, ACCEPTED: 23 of the 242 will be phase 'case' with NO matching
-- role='case' template (2 Bankruptcies still retained with no chapter
-- recorded, 10 blank-subtype Open Bankruptcies, plus Litigation / Adversary
-- Proceeding / Chapter 11). They fall to
-- resolveTemplate branch 4 → Intake and sit `unstaged`. That is the SAME place
-- they sit today; the change is that the wrongness is now visible rather than
-- plausible. Do NOT "fix" this by setting is_default=1 on Chapter 7 — that
-- files a Chapter 11 on a Chapter 7 pipeline. The real fix is new templates
-- (Litigation/Adversary) and chapter recovery for the 12; both are out of
-- scope here and tracked separately.
--
-- ── ENUM SAFETY ─────────────────────────────────────────────────────────
-- The session sql_mode lacks STRICT_TRANS_TABLES, so an invalid ENUM write
-- lands as '' SILENTLY rather than erroring. pipelineService.isCasePhase
-- therefore tests for exactly 'case' (trimmed, lowercased) and treats NULL,
-- '', 'intake' and any coerced garbage as intake — the safe default, since
-- intake is where every case starts. A bad write parks a case in the funnel;
-- it never promotes one.
--
-- NOT NULL DEFAULT 'intake' is what makes every case-creation path correct
-- without edits: routes/api.intake.js and api.intake.petition.js both omit the
-- column and both get the right answer. The petition route's immediate
-- advance to `filed` then flips the row to 'case' through advanceStage's
-- cross-phase target search. No creator has to know this column exists.
--
-- ── RUN ORDER ───────────────────────────────────────────────────────────
-- Both statements are standalone: no session variables, no LAST_INSERT_ID,
-- no cross-statement transaction. Each may run on its own connection.
--
--   1. Run statement 1, then statement 2, in that order (2 reads the column
--      1 creates).
--   2. Deploy the backend AFTER BOTH have completed.
--
-- The ordering is not optional in either direction. Deploying first means the
-- new resolveTemplate selects a column that does not exist — every getPipeline
-- and advanceStage call 500s. Running statement 1 without statement 2 leaves
-- all 1,077 cases at the 'intake' default, which silently moves 242 live
-- cases off their chapter boards until the backfill lands.
--
-- ROLLBACK: redeploy the previous backend, then
--   ALTER TABLE cases DROP COLUMN pipeline_phase;
-- Nothing else was written, so there is nothing else to undo.
-- ============================================================


-- 1 of 2 — the column ---------------------------------------------------
-- Defaults every existing row to 'intake'; statement 2 promotes the 242.
ALTER TABLE cases
  ADD COLUMN pipeline_phase ENUM('intake','case') NOT NULL DEFAULT 'intake'
    COMMENT 'T8 lifecycle axis: intake funnel vs post-retainer case. Written by pipelineService.advanceStage from the entered stage template role.'
    AFTER case_subtype;


-- 2 of 2 — the backfill (needs statement 1) -----------------------------
-- Self-contained: the A predicate is a correlated EXISTS, not a temp table or
-- a session variable, so this runs as one statement on one connection.
UPDATE cases c
   SET c.pipeline_phase = 'case'
 WHERE EXISTS (                                                     -- A
         SELECT 1
           FROM case_stage_log l
           JOIN pipeline_templates t ON t.id = l.template_id
          WHERE l.case_id = c.case_id
            AND t.role = 'case'
       )
    OR c.case_file_date IS NOT NULL                                 -- B
    OR TRIM(COALESCE(c.case_number, '')) <> ''                      -- C
    OR TRIM(COALESCE(c.case_number_full, '')) <> ''                 -- C
    OR c.case_stage IN ('Filed', 'Concluded')                       -- D
    OR c.case_status IN ('Signed Post-Petition',                    -- E
                         'Pre-petition signed',
                         'Case Filed');


-- VERIFY 1 — phase split. Expect case=242, intake=835 (total 1077):
--   SELECT pipeline_phase, COUNT(*) n FROM cases GROUP BY pipeline_phase;
--
-- VERIFY 2 — BLOCKING. Every case that has pipeline history must resolve to
-- the SAME template after the change as before, or a log row has been
-- reinterpreted. Expect ZERO rows:
--   SELECT c.case_id, c.pipeline_phase, l.template_id AS logged_on
--     FROM cases c
--     JOIN case_stage_log l
--       ON l.id = (SELECT l2.id FROM case_stage_log l2
--                   WHERE l2.case_id = c.case_id
--                   ORDER BY l2.entered_at DESC, l2.id DESC LIMIT 1)
--     JOIN pipeline_templates t ON t.id = l.template_id
--    WHERE (t.role = 'case'   AND c.pipeline_phase <> 'case')
--       OR (t.role = 'intake' AND c.pipeline_phase =  'case');
--
-- VERIFY 3 — BLOCKING. No case's CURRENT stage_key may fall outside the
-- template it now resolves to (that is the "valid state with nowhere to live"
-- condition this whole migration exists to remove). Expect ZERO rows:
--   SELECT c.case_id, l.stage_key, c.pipeline_phase
--     FROM cases c
--     JOIN case_stage_log l
--       ON l.id = (SELECT l2.id FROM case_stage_log l2
--                   WHERE l2.case_id = c.case_id
--                   ORDER BY l2.entered_at DESC, l2.id DESC LIMIT 1)
--    WHERE l.stage_key NOT IN (
--            SELECT ps.stage_key FROM pipeline_stages ps
--             WHERE ps.active = 1
--               AND ps.template_id = (
--                     CASE WHEN c.pipeline_phase <> 'case' THEN 1
--                          ELSE COALESCE((SELECT t.id FROM pipeline_templates t
--                                          WHERE t.active = 1 AND t.role = 'case'
--                                            AND TRIM(t.case_type)    = TRIM(COALESCE(c.case_type, ''))
--                                            AND TRIM(t.case_subtype) = TRIM(COALESCE(c.case_subtype, ''))
--                                          ORDER BY t.id LIMIT 1), 1)
--                     END));
--
-- VERIFY 4 — the 33 known strays, for the record. Expect 33 rows, all either
-- blank-subtype Bankruptcy or a non-Bankruptcy type:
--   SELECT case_type, case_subtype, case_stage, case_status, COUNT(*) n
--     FROM cases c
--    WHERE c.pipeline_phase = 'case'
--      AND NOT EXISTS (SELECT 1 FROM pipeline_templates t
--                       WHERE t.active = 1 AND t.role = 'case'
--                         AND TRIM(t.case_type)    = TRIM(COALESCE(c.case_type, ''))
--                         AND TRIM(t.case_subtype) = TRIM(COALESCE(c.case_subtype, '')))
--    GROUP BY case_type, case_subtype, case_stage, case_status;
