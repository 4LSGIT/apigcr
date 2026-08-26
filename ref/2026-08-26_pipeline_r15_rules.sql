-- ============================================================
-- Pipeline R1.5 — stage keys move from code to data
-- ref/2026-08-26_pipeline_r15_rules.sql
--
-- Run ONCE, BEFORE deploying the R1.5 code (migration → code order).
-- Prereq: the T1, T3/T4 and R4 trigger migrations are already applied.
--
-- NO session variables / no LAST_INSERT_ID across statements — the runner
-- executes each statement on its own connection (ref/migration_trigger_R4.sql
-- header; the T3/T4 migration used SET @rule_id = LAST_INSERT_ID(), do NOT
-- copy that pattern). The action INSERTs below resolve their rule_id with an
-- INSERT … SELECT against trigger_rules.name instead, which is
-- connection-independent.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- Two pipeline advances were hardcoded in service/route code with the stage
-- key as a string literal:
--
--   services/esignSendService.js  sendFromTemplate → advanceStage(…, 'contract_sent',
--                                 { onlyFromRole: ['intake', null] })
--   routes/api.checklists.js      POST /checklists/upsert-items → advanceStage(…,
--                                 'docs', { onlyFrom: ['retained'] })
--
-- Stage keys do not belong in code: the app is supposed to adapt to another
-- business model by editing DATA, and a firm that renames or drops a stage
-- should not need a deploy. Rule 12 already proves the target pattern — a
-- trigger_rules row whose internal_function action calls advance_stage with
-- the guards in params_mapping. R1.5 emits two new domain events at the same
-- choke points, registers them, seeds the two rules below carrying TODAY'S
-- EXACT GUARDS, and deletes the hardcoded advances.
--
-- No new tables, no schema change, no new event model. This file is pure data.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
--   1. THIS FILE.       The rules are INERT until the code deploy: the events
--                       they listen for (esign.sent, checklist.items_upserted)
--                       are emitted by nothing on the currently-deployed
--                       backend, and that backend still does the hardcoded
--                       advances. Seeding first is therefore safe in both
--                       directions — there is no overlap window:
--                         pre-deploy  = hardcoded advances only
--                         post-deploy = rules only
--   2. Deploy backend.  Emits start; hardcoded advances are gone.
--   3. No frontend changes.
--
-- ── IDEMPOTENT? NO ──────────────────────────────────────────────────────────
-- The two rule INSERTs are NOT idempotent — re-running this file creates
-- DUPLICATE rules, and duplicates would each dispatch advance_stage on the
-- same event. (The second advance is a harmless no-op, since the first one
-- already moved the case, but the executions log becomes a lie about how many
-- rules are wired.) The action INSERT … SELECTs inherit that: re-running with
-- duplicate rules present would attach an action to EVERY row matching the
-- name.
--
-- CHECK BEFORE (expect ZERO rows):
--   SELECT id, name FROM trigger_rules
--    WHERE name IN ('Contract sent → contract_sent stage',
--                   'Doc request sent → docs stage');
--
-- CHECK AFTER (expect exactly TWO rows, one each, and one action per rule):
--   SELECT r.id, r.name, r.event_type, r.active, COUNT(a.id) AS actions
--     FROM trigger_rules r
--     LEFT JOIN trigger_rule_actions a ON a.rule_id = r.id
--    WHERE r.name IN ('Contract sent → contract_sent stage',
--                     'Doc request sent → docs stage')
--    GROUP BY r.id, r.name, r.event_type, r.active;
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- trigger_rule_actions has ON DELETE CASCADE to trigger_rules, so deleting the
-- rules removes their actions. Run BOTH statements (the explicit action DELETE
-- is belt-and-braces and harmless):
--
--   DELETE a FROM trigger_rule_actions a
--     JOIN trigger_rules r ON r.id = a.rule_id
--    WHERE r.name IN ('Contract sent → contract_sent stage',
--                     'Doc request sent → docs stage');
--
--   DELETE FROM trigger_rules
--    WHERE name IN ('Contract sent → contract_sent stage',
--                   'Doc request sent → docs stage');
--
-- SOFTER ROLLBACK (keeps the audit trail, stops the behaviour):
--   UPDATE trigger_rules SET active = 0
--    WHERE name IN ('Contract sent → contract_sent stage',
--                   'Doc request sent → docs stage');
--
-- Note trigger_executions rows are NOT deleted by either — deliberately. They
-- carry rule_name denormalized precisely so history survives rule deletion.
--
-- ── FAILURE-VISIBILITY DELTA (accepted) ─────────────────────────────────────
-- The two bespoke alerts these advances used to raise on failure —
-- contract_sent_advance_failed and doc_request_advance_failed — go away with
-- the code. Rule dispatch failures now surface through trigger_executions
-- (outcomes JSON), trigger_rules.error_count / last_error_at, and the trigger
-- engine's own alerting (kind 'trigger_engine_error'). That is a real change
-- in where you look, not a loss of signal.
--
-- ── GUARDS ARE VERBATIM, DELIBERATELY ───────────────────────────────────────
-- Both rules carry TODAY'S guards exactly. In particular they are NOT
-- "upgraded" to forward_only in this slice — swapping a from-state whitelist
-- for a direction check is a behaviour change and belongs in its own slice
-- with its own gates.
--
-- 'intake,none' below is the CSV form of the code's ['intake', null]: ONE
-- quoted literal holding the whole comma-separated list, where the token
-- `none` means "case has no pipeline history yet". It is NOT a list of quoted
-- literals ('intake','none') — params_mapping strips only the OUTER quote
-- pair, so that form resolves to the string  intake','none  and yields a guard
-- that can never match while reporting as healthy (Aug 2026 trigger rule 12
-- postmortem). Both lib/internal_functions/pipeline.js `_csvGuard` and the
-- save-time check in `__validateParamsMapping` now reject the broken form.
-- ============================================================


-- ── RULE A: Contract sent → contract_sent stage ─────────────────────────────
--
-- Replaces the Slice E1 advance in esignSendService.sendFromTemplate.
--
-- BROADER THAN WHAT IT REPLACES, deliberately. The old advance lived in
-- sendFromTemplate and so only fired for TEMPLATE sends. esign.sent is emitted
-- at the send choke points, so this rule also sees ad-hoc sends (POST
-- /api/esign/send) and resends. That is safe, and in one case a fix:
--
--   · ad-hoc contract send on an intake case → advances. Arguably the bug the
--     old placement had: the same document sent without a template did not
--     move the pipeline.
--   · resend of a contract → the case is already at contract_sent, so
--     advanceStage no-ops (nothing written, no case_stage_log row).
--   · mid-pipeline case → the only_from_role guard skips it (its latest log
--     row belongs to a role='case' template). This is what structurally
--     excludes the Ch7 Post-Filing agreement.
--   · history-less case whose subtype is already set → resolves to a case
--     template where contract_sent does not exist → advanceStage's soft
--     resolution skips (reason 'unresolved', no 400).
--
-- NOT gated on data.testing, matching the old code: the completion-trigger
-- side (esignService.applyStatus) fires regardless of test mode, and the two
-- ends of the retainer arc should agree.

INSERT INTO trigger_rules
  (event_type, name, description, active, position, min_interval_s,
   match_mode, match_config, transform_mode, transform_config)
VALUES
  ('esign.sent',
   'Contract sent → contract_sent stage',
   'Advances an intake-phase case to contract_sent when a contract goes out for signature. Replaces the advance formerly hardcoded in esignSendService.sendFromTemplate (Pipeline Slice E1) — R1.5, 2026-08-26. Guards are verbatim from that code: only_from_role intake,none (judged by the case''s latest log row''s template role; "none" = no pipeline history yet), which excludes mid-pipeline cases such as the Ch7 Post-Filing agreement. Do not add a second rule doing this.',
   1, 10, 0,
   'conditions',
   '{"operator":"and","conditions":[{"op":"equals","path":"data.kind","value":"contract"},{"op":"exists","path":"case_id"}]}',
   'passthrough',
   NULL);

INSERT INTO trigger_rule_actions
  (rule_id, name, position, active, action_type, config)
SELECT r.id, 'advance_stage contract_sent', 0, 1, 'internal_function',
       '{"function_name":"advance_stage","params_mapping":{"case_id":"case_id","stage":"''contract_sent''","only_from_role":"''intake,none''","note":"''Contract sent for signature''"}}'
  FROM trigger_rules r
 WHERE r.name = 'Contract sent → contract_sent stage';


-- ── RULE B: Doc request sent → docs stage ───────────────────────────────────
--
-- Replaces the Slice E1 advance in POST /checklists/upsert-items.
--
-- The only_from 'retained' guard is STRICT and must stay that way. This route
-- fires repeatedly across a case's whole life (263 live docs checklists at the
-- time the original code was written, ~7 items each, re-upserted whenever the
-- requested list changes). An unguarded advance would drag cases BACKWARDS
-- from meeting_341 to docs on every re-request. Every non-retained state —
-- intake stages during the ISS, mid-pipeline, no pipeline history at all —
-- skips silently inside advance_stage, and a skipped outcome is the common
-- case here, not an anomaly.
--
-- data.tag = 'docs_needed' is what narrows the generic
-- checklist.items_upserted event to the docs list. Every emission carries that
-- tag today (the route has one caller path), but the condition is what keeps
-- that true when a second upsert path appears.

INSERT INTO trigger_rules
  (event_type, name, description, active, position, min_interval_s,
   match_mode, match_config, transform_mode, transform_config)
VALUES
  ('checklist.items_upserted',
   'Doc request sent → docs stage',
   'Advances a retained case to docs when a doc request is sent (items upserted on the case''s docs_needed checklist). Replaces the advance formerly hardcoded in POST /checklists/upsert-items (Pipeline Slice E1) — R1.5, 2026-08-26. Guard is verbatim from that code: only_from retained, STRICT — this event fires repeatedly across a case''s life and an unguarded advance would drag cases backwards from meeting_341 on every re-request. Skipping is the normal outcome. Do not add a second rule doing this.',
   1, 10, 0,
   'conditions',
   '{"operator":"and","conditions":[{"op":"equals","path":"data.tag","value":"docs_needed"},{"op":"exists","path":"case_id"}]}',
   'passthrough',
   NULL);

INSERT INTO trigger_rule_actions
  (rule_id, name, position, active, action_type, config)
SELECT r.id, 'advance_stage docs', 0, 1, 'internal_function',
       '{"function_name":"advance_stage","params_mapping":{"case_id":"case_id","stage":"''docs''","only_from":"''retained''","note":"''Doc request sent''"}}'
  FROM trigger_rules r
 WHERE r.name = 'Doc request sent → docs stage';


-- ============================================================
-- VERIFY (after the code deploy)
-- ============================================================
--
-- VERIFY 1 — BLOCKING. Both rules present exactly once, active, one action
-- each, and the params_mapping literals intact. Expect 2 rows, actions=1 each:
--   SELECT r.id, r.name, r.event_type, r.active, r.position, r.min_interval_s,
--          r.match_mode, r.transform_mode, COUNT(a.id) AS actions,
--          MAX(a.config->>'$.function_name') AS fn
--     FROM trigger_rules r
--     LEFT JOIN trigger_rule_actions a ON a.rule_id = r.id
--    WHERE r.name IN ('Contract sent → contract_sent stage',
--                     'Doc request sent → docs stage')
--    GROUP BY r.id, r.name, r.event_type, r.active, r.position,
--             r.min_interval_s, r.match_mode, r.transform_mode;
--
-- VERIFY 2 — BLOCKING. The guards resolved as intended, i.e. ONE literal
-- holding the whole list, no inner quotes. Expect 'intake,none' and 'retained'
-- with no embedded quote characters:
--   SELECT r.name,
--          a.config->>'$.params_mapping.stage'          AS stage,
--          a.config->>'$.params_mapping.only_from'      AS only_from,
--          a.config->>'$.params_mapping.only_from_role' AS only_from_role
--     FROM trigger_rules r
--     JOIN trigger_rule_actions a ON a.rule_id = r.id
--    WHERE r.name IN ('Contract sent → contract_sent stage',
--                     'Doc request sent → docs stage');
--
-- VERIFY 3 — no OTHER rule now listens on these events (nothing should, on
-- day one). Expect exactly the two rules above:
--   SELECT id, name, event_type, active FROM trigger_rules
--    WHERE event_type IN ('esign.sent', 'checklist.items_upserted');
--
--
-- ── LIVE GATES (Fred runs these after the deploy) ───────────────────────────
--
-- GATE 1 — send a test contract from a TEMPLATE on an intake-phase test case.
--   Expect: the case advances to contract_sent VIA THE RULE, not via code.
--   Prove it two ways —
--     (a) an execution row for rule A:
--         SELECT e.id, e.event_type, e.case_id, e.status, e.rules_matched, e.created_at
--           FROM trigger_executions e
--          WHERE e.event_type = 'esign.sent'
--          ORDER BY e.id DESC LIMIT 5;
--     (b) the case_stage_log row's source — advance_stage always writes
--         source='system' and entered_by=NULL:
--         SELECT id, case_id, stage_key, source, entered_by, note, entered_at
--           FROM case_stage_log
--          WHERE case_id = '<TEST CASE>'
--          ORDER BY id DESC LIMIT 5;
--
-- GATE 2 — upsert doc-request items on a case sitting at `retained`.
--   Expect: advances to docs via rule B. Same two checks, event_type
--   'checklist.items_upserted'.
--
-- GATE 3 — resend a DECLINED / RECALLED / EXPIRED contract (a terminal
--   resend, which mints a fresh draft and routes through sendPipeline).
--   Expect: rule A fires and the advance NO-OPS — the executions view shows
--   the action succeeded with output.noop=true, and NO new case_stage_log row
--   appears. (A BOUNCED resend is a different code path — see gate 4.)
--
-- GATE 4 — resend a BOUNCED contract (the same-row resend path, which inlines
--   its own provider call and never reaches sendPipeline).
--   Expect: esign.sent STILL fires — trigger_executions shows rule A evaluated
--   (skip or noop per the guards, both fine). This is the gate that confirms
--   the branch-(a) emit exists; without it this path would be silent, and the
--   registry entry's claim to cover "every send path" would be false.
--
-- For gates 3 and 4, the send shape is readable straight off the envelope:
--   SELECT e.id, e.case_id,
--          e.envelope->>'$.data.kind'          AS kind,
--          e.envelope->>'$.extra.resend'       AS resend,
--          e.envelope->>'$.extra.draft_reused' AS draft_reused,
--          e.outcomes
--     FROM trigger_executions e
--    WHERE e.event_type = 'esign.sent'
--    ORDER BY e.id DESC LIMIT 10;
