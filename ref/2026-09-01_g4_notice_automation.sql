-- ref/2026-09-01_g4_notice_automation.sql
--
-- G4 — "Notice of Filing -> client": generate the Notice of Bankruptcy Filing
-- from its contract_templates row and email it to the primary debtor whenever a
-- case advances into the `filed` stage.
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ @@TEMPLATE_ID@@ IS A PARAMETER. THIS FILE DOES NOT RUN AS WRITTEN.       ║
-- ║                                                                          ║
-- ║ Create the template FIRST (the curl is in the G4 report; the JSON is     ║
-- ║ ref/templates/notice_of_bankruptcy_filing.json), take the `id` the API   ║
-- ║ returns, and replace @@TEMPLATE_ID@@ below with that integer, UNQUOTED.  ║
-- ║                                                                          ║
-- ║ Exactly ONE occurrence is executable — statement 6, the                  ║
-- ║ document_generate_from_template config. The others are in comments, so   ║
-- ║ a global replace is safe:                                                ║
-- ║     sed -i 's/@@TEMPLATE_ID@@/8/g' 2026-09-01_g4_notice_automation.sql   ║
-- ║                                                                          ║
-- ║ A leftover @@TEMPLATE_ID@@ is a SYNTAX error, not a silently bad row —   ║
-- ║ that is the point of the token. Do not default it to a number.           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- RUN ORDER
--   1. Deploy the code (lib/firmConfig.js + services/esignPrefillService.js).
--      The template's resolvers do not exist without it and step 2 would 400
--      with ESIGN_BAD_RESOLVER.
--   2. Create the template (POST /api/esign/templates).
--   3. Substitute @@TEMPLATE_ID@@ and run this file, top to bottom.
--   4. Run the workflow by hand against a real filed case
--      (Automations -> Workflows -> Run) and OPEN THE PDF IT PRODUCES.
--   5. Only then arm the rule — statement 13, deliberately commented out.
--
-- Nothing else here needs a deploy: every function named (get_settings,
-- query_db, document_generate_from_template, evaluate_condition, send_email,
-- create_log) already exists, and the `workflow` trigger action type is already
-- dispatchable.
--
-- EACH STATEMENT IS SELF-CONTAINED. The DB console runs every statement on a
-- SEPARATE POOLED CONNECTION, so nothing here may rely on session state — no
-- SET @var, no LAST_INSERT_ID(). Every cross-statement reference is a
-- name-lookup subquery instead. (House ground rule; it has bitten before.)
--
-- No DDL. Every table this touches exists already and is
-- utf8mb4 / utf8mb4_general_ci, so there is no CHARSET/COLLATE clause to get
-- wrong.


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. The workflow row.
--
--    active = 1 and current_version = 1 from the start. lib/actionDispatchers
--    deliverWorkflow REFUSES a workflow that is inactive OR whose
--    current_version is 0 ("has never been published"), logging both as failed
--    deliveries — so a workflow seeded unpublished would look wired up and fail
--    at the first real filing. The safety is the trigger rule being inactive
--    (statement 11), not the workflow being unpublished: that way the manual
--    test run exercises exactly the rows the trigger will.
--
--    default_contact_id_from stays NULL. init_data here is {case_id} and
--    carries no contact id, so resolveExecutionContactId has nothing to find;
--    naming a key that is never present would log a warning on every run.
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO workflows (name, description, active, current_version, draft_version, test_input)
VALUES (
  'Notice of Filing -> client',
  'G4. Generates the Notice of Bankruptcy Filing PDF for a case, files it to the case Dropbox folder, and emails it to the primary debtor. Started by the trigger rule "Case filed -> notice of filing to client" on case.stage_advanced when data.stage_key = filed. init_data is {case_id} and nothing else — see that rule''s code transform.',
  1, 1, NULL,
  '{"case_id": "AbC12dEf"}'
);


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The version-1 metadata row.
--
--    NOT optional bookkeeping. routes/workflows.js ensureDraft numbers a new
--    draft MAX(workflow_versions.version) + 1, and GET /workflows/:id/versions
--    reads FROM workflow_versions. A workflow with steps at version 1 and no row
--    here shows an empty version history in the editor and mints its first draft
--    as version 1 again — colliding with the live steps on
--    uk_workflow_version_step (workflow_id, version, step_number).
--
--    published_by 'g4_seed' follows the convention the 2026-08-18 versioning
--    backfill set with 'backfill': a non-username string that says a machine
--    wrote the row.
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO workflow_versions (workflow_id, version, name, description, test_input, published_at, published_by)
SELECT w.id, 1, w.name, w.description, w.test_input, NOW(), 'g4_seed'
  FROM workflows w
 WHERE w.name = 'Notice of Filing -> client';


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Step 1 — the automations sender.
--
--    Read from app_settings rather than hardcoded, so changing the firm's
--    outbound sender is a settings edit and not a workflow edit. Same idiom as
--    wf37 step 1. Consumed by step 6 as {{settings.email_automations}}.
--
--    get_settings is ALL-OR-NOTHING: it throws if the key is missing or
--    is_secret. email_automations exists and is not secret (verified live
--    2026-09-01, value automations@4lsg.com).
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO workflow_steps (workflow_id, version, step_number, type, label, note, config, error_policy)
SELECT w.id, 1, 1, 'internal_function',
       'Load the automations sender',
       'email_automations from app_settings, so changing the sender is a settings edit. Same idiom as wf37 step 1.',
       '{"function_name":"get_settings","params":{"keys":"email_automations","output_var":"settings"}}',
       NULL
  FROM workflows w WHERE w.name = 'Notice of Filing -> client';


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Step 2 — who the client is.
--
--    Copied from wf28 step 1 ("EXAMPLE: Filed Case Dropbox Move"), the repo's
--    only worked example of reaching a case's PRIMARY contact from a workflow,
--    extended with contacts.contact_email. There was NO existing precedent for
--    emailing a case's debtor: every other send_email step in the live corpus
--    goes to an office address, an attorney, or a contact-anchored
--    {{contact_email}}.
--
--    format 'first' + the Primary predicate mirrors esignPrefillService
--    buildContext, so the addressee is the same person the notice names.
--
--    {{this.output.X}} and NOT {{this.X}}: for an INTERNAL_FUNCTION step
--    rawResult is {success, output, set_vars}, so `this` is that envelope.
--    Webhook and custom_code steps are the other way round (step 3 below) —
--    see the comment in lib/job_executor.js, which notes that getting this
--    backwards fails SILENTLY and cost real debugging time.
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO workflow_steps (workflow_id, version, step_number, type, label, note, config, error_policy)
SELECT w.id, 1, 2, 'internal_function',
       'Look up the client',
       'Primary contact via case_relate — the same rule esignPrefillService.buildContext uses for debtor1. Copied from wf28 step 1, extended with contact_email.',
       '{"function_name":"query_db","params":{"from":"cases","join":[{"type":"left","table":"case_relate","on":{"left":"cases.case_id","right":"case_relate.case_relate_case_id"}},{"type":"left","table":"contacts","on":{"left":"case_relate.case_relate_client_id","right":"contacts.contact_id"}}],"where":[{"column":"cases.case_id","op":"=","value":"{{case_id}}"},{"column":"case_relate.case_relate_type","op":"=","value":"Primary"}],"select":["cases.case_id","cases.case_number","cases.case_number_full","contacts.contact_name","contacts.contact_email"],"format":"first","output_var":"caseRow"},"set_vars":{"client_email":"{{this.output.contact_email}}","contact_name":"{{this.output.contact_name}}","case_number":"{{this.output.case_number}}","case_number_full":"{{this.output.case_number_full}}"}}',
       NULL
  FROM workflows w WHERE w.name = 'Notice of Filing -> client';


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. Step 3 — the docket, for the subject line.
--
--    A whole step for one string, and it earns its place. The TEMPLATE resolves
--    its own docket through case.docket, which coalesces case_number_full over
--    case_number. The EMAIL SUBJECT has no resolver behind it — it is built from
--    workflow variables — and query_db cannot COALESCE (its select list is a
--    column whitelist, not an expression language). Without this step, a case
--    carrying only the short form would generate a correct notice and mail it
--    under the subject "... — Case ", with the number missing.
--
--    Same `full || short` rule and same shape as wf28 step 2.
--
--    custom_code returns its last expression, and for a custom_code step `this`
--    IS that value — {{this.docket}}, NOT {{this.output.docket}}. The opposite
--    of step 2. The s() helper also flattens the literal strings "null" and
--    "undefined", which is what an unresolved placeholder can leave behind.
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO workflow_steps (workflow_id, version, step_number, type, label, note, config, error_policy)
SELECT w.id, 1, 3, 'custom_code',
       'Docket for the subject line',
       'full || short, the wf28 step 2 rule. The template resolves its own docket via case.docket; the email SUBJECT has no resolver behind it and query_db cannot COALESCE, so a short-form-only case would otherwise mail as "Case " with nothing after it.',
       '{"code":"function s(v){var x=String(v==null?\\"\\":v).trim();return (x===\\"null\\"||x===\\"undefined\\")?\\"\\":x;}\\n({ docket: s(input.full) || s(input.short) });","input":{"full":"{{case_number_full}}","short":"{{case_number}}"},"set_vars":{"docket":"{{this.docket}}"}}',
       NULL
  FROM workflows w WHERE w.name = 'Notice of Filing -> client';


-- ═════════════════════════════════════════════════════════════════════════════
-- 6. Step 4 — the document.  ← @@TEMPLATE_ID@@ LIVES HERE
--
--    on_missing 'task' rather than 'fail': a required prefill still empty
--    (debtor1_street is the one that will bite — it is required ON PURPOSE, as
--    data-entry pressure) raises a staff task naming the missing key and returns
--    success with generated:false, instead of killing the run. Step 5 then
--    declines to email a document that does not exist.
--
--    set_vars FLATTENS the verdict deliberately.
--    lib/internal_functions/control.js evaluateSingle does `variables[variable]`
--    — a FLAT lookup with NO dot-path support — so a guard written against
--    "notice.generated" would read undefined forever and never fire. The
--    output_var object stays for {{notice.temp_link}} in step 6, which goes
--    through resolvePlaceholders and DOES support dots.
--
--    document_generate_from_template is workflowOnly: chromium renders serialize
--    on this 1GiB container. Do not move this into a sequence.
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO workflow_steps (workflow_id, version, step_number, type, label, note, config, error_policy)
SELECT w.id, 1, 4, 'internal_function',
       'Generate the notice',
       'Renders the Notice template to PDF and files it under the case folder. on_missing task raises a staff task naming the empty required key instead of failing silently. set_vars flattens `generated` because evaluate_condition cannot read a dot path.',
       '{"function_name":"document_generate_from_template","params":{"template_id":@@TEMPLATE_ID@@,"linkable_type":"case","linkable_id":"{{case_id}}","on_missing":"task","output_var":"notice"},"set_vars":{"notice_generated":"{{this.output.generated}}"}}',
       NULL
  FROM workflows w WHERE w.name = 'Notice of Filing -> client';


-- ═════════════════════════════════════════════════════════════════════════════
-- 7. Step 5 — one guard, two conditions.
--
--    ┌──────────────────────────────────────────────────────────────────────┐
--    │ value is the STRING "true", NOT the boolean true. DO NOT "FIX" THIS. │
--    └──────────────────────────────────────────────────────────────────────┘
--    lib/workflow_engine.resolvePlaceholders stringifies PRIMITIVES on the way
--    out (only non-primitives survive the single-placeholder fast path), so
--    notice_generated always arrives as the string 'true' or 'false'.
--    evaluateSingle compares with loose ==, and `true == "true"` is FALSE in
--    JavaScript. A boolean operand here silently skips every notice, forever —
--    the same coercion trap control.js documents for wf15 s1 / wf16 s1.
--    Verified by direct call 2026-09-01.
--
--    (wf40 s2 gates on a boolean legitimately, because its `make_pdf` is
--    injected as a real boolean by the form dispatcher and never resolved from
--    a placeholder. Different provenance, different operand.)
--
--    conditions[] + match 'all' collapses the has-a-notice and has-an-address
--    checks into ONE step; evaluateClause supports it.
--
--    else null ENDS the workflow. For a control step there is no sequential
--    fall-through (the NOTE on else/null in control.js). No notice or no
--    address means no email, and the task raised by step 4 is the record.
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO workflow_steps (workflow_id, version, step_number, type, label, note, config, error_policy)
SELECT w.id, 1, 5, 'internal_function',
       'Have a notice and an address?',
       'value is the STRING "true" on purpose — placeholder resolution stringifies primitives and evaluateSingle uses loose ==, where true == "true" is FALSE. A boolean operand here would skip every notice forever. See control.js on wf15 s1 / wf16 s1.',
       '{"function_name":"evaluate_condition","params":{"conditions":[{"variable":"notice_generated","operator":"==","value":"true"},{"variable":"client_email","operator":"is_not_empty"}],"match":"all","then":6,"else":null}}',
       NULL
  FROM workflows w WHERE w.name = 'Notice of Filing -> client';


-- ═════════════════════════════════════════════════════════════════════════════
-- 8. Step 6 — the email.
--
--    attachment_urls uses the [{url, name}] shape — wf40 step 4's, and the one
--    document_generate_from_template.__meta documents for output_var. There is
--    deliberately NO attachment_names: services/emailService calls it "legacy
--    csv string, Pabbly only", and BOTH adapters this firm sends through ignore
--    it outright (adapters/email/smtp.js:68, gmail.js:234). Passing it would
--    attach the file named after the Dropbox temp URL. The display name rides
--    inside the object.
--
--    The gmail adapter fetches the URL into the MIME body server-side, so the
--    client receives real bytes rather than a link that expires in ~4 hours.
--
--    error_policy NULL = the engine default 'ignore', so a bounced send still
--    lets step 7 record what happened.
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO workflow_steps (workflow_id, version, step_number, type, label, note, config, error_policy)
SELECT w.id, 1, 6, 'internal_function',
       'Email the notice to the client',
       'attachment_urls uses the [{url,name}] shape (wf40 step 4). attachment_names is NOT used: emailService calls it Pabbly-only legacy and both the smtp and gmail adapters ignore it.',
       '{"function_name":"send_email","params":{"from":"{{settings.email_automations}}","to":"{{client_email}}","subject":"Notice of Bankruptcy Filing — Case {{docket}}","html":"<p>Dear {{contact_name}},</p><p>Your bankruptcy case has been filed. A copy of the Notice of Bankruptcy Filing is attached for your records. It lists your case number, the assigned judge, and the trustee where one has been appointed.</p><p>You may give a copy of this notice to any creditor who contacts you about a debt, and you may refer them to our office.</p><p>Please keep it with your case papers. If you have any questions, call us at the number on the notice.</p>","attachment_urls":[{"url":"{{notice.temp_link}}","name":"{{notice.file_name}}"}]}}',
       NULL
  FROM workflows w WHERE w.name = 'Notice of Filing -> client';


-- ═════════════════════════════════════════════════════════════════════════════
-- 9. Step 7 — the case log.
--
--    type 'status', link_type 'case', by 0 — the same mapping shape trigger
--    rule 4's create_log action uses.
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO workflow_steps (workflow_id, version, step_number, type, label, note, config, error_policy)
SELECT w.id, 1, 7, 'internal_function',
       'Log it on the case',
       'Same mapping shape as trigger rule 4''s create_log action: type status, link_type case, by 0.',
       '{"function_name":"create_log","params":{"type":"status","link_type":"case","link_id":"{{case_id}}","by":0,"direction":"outgoing","subject":"Notice of filing sent","data":"Notice of filing generated and emailed to client: {{notice.file_name}}"}}',
       NULL
  FROM workflows w WHERE w.name = 'Notice of Filing -> client';


-- ═════════════════════════════════════════════════════════════════════════════
-- 10. The trigger rule.
--
--    match_config grammar copied from rule 12 (form.submitted -> stage): an
--    `equals` on a dotted path under the standard {operator, conditions[]}
--    envelope, with an `exists` on case_id first. NULL match_config in
--    conditions mode is NON-match, never match-all.
--
--    transform_mode 'code' returning {case_id: input.case_id} is rule 4's
--    shape, and it matters MORE here because of how a workflow action is
--    dispatched: lib/actionDispatchers.deliverWorkflow sets
--    `initData = targetOutput` and writes it to workflow_executions.init_data
--    AND .variables verbatim. There is NO trigger_data wrapper on this path —
--    that namespace belongs to hooks and to internal_function params_mapping —
--    so the workflow's variables ARE the transform's output keys, and the
--    placeholder is {{case_id}}, flat.
--
--    A passthrough transform would also work (the envelope carries case_id at
--    the top level), but it would dump data/extra/actor into every execution's
--    variables. A workflow that receives exactly what it needs has an init_data
--    that reads as documentation.
--
--    min_interval_s = 0. This is a per-RULE cooldown, not per-case
--    (triggerService R4), so ANY positive value would drop the notice for the
--    second case filed inside the window — and this firm files in batches.
--    Double-advance needs no cooldown anyway: pipelineService advanceStage
--    treats a same-stage re-advance as a `noop` and emits nothing.
--
--    position 20 puts it after rule 4 (the stage-change case log, position 10)
--    on the same event, so the log entry lands before the notice work starts.
--
--    active = 0 ON INSERT.
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO trigger_rules
  (event_type, name, description, active, position, min_interval_s,
   match_mode, match_config, transform_mode, transform_config)
VALUES (
  'case.stage_advanced',
  'Case filed -> notice of filing to client',
  'G4. When a case advances into the `filed` stage, start the "Notice of Filing -> client" workflow, which generates the Notice of Bankruptcy Filing PDF and emails it to the primary debtor. Seeded INACTIVE — run the workflow by hand once and read the PDF before arming this.',
  0, 20, 0,
  'conditions',
  '{"operator":"and","conditions":[{"op":"exists","path":"case_id"},{"op":"equals","path":"data.stage_key","value":"filed"}]}',
  'code',
  '{"code":"return {case_id: input.case_id};"}'
);


-- ═════════════════════════════════════════════════════════════════════════════
-- 11. The action.
--
--    FIRST LIVE `workflow`-TYPE TRIGGER ACTION. Every existing trigger action
--    (rules 1-14) is action_type 'internal_function', so there was no row to
--    copy. This shape comes from the dispatcher itself:
--
--      services/triggerService.js ACTION_TYPES =
--        {workflow, sequence, internal_function, http, hook}
--      _validateActions case 'workflow' requires Number(config.workflow_id) > 0
--      lib/actionDispatchers.js deliverWorkflow reads config.workflow_id and
--        sets initData = targetOutput (the transform output) — no wrapper, no
--        params_mapping, no envelope key.
--
--    NOTE THE NAME. 'start_workflow' is NOT a trigger action type — it is the
--    name of a SEQUENCE step type and of a workflow-to-workflow internal
--    function. Using it here would fail _validateActions at write time.
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO trigger_rule_actions (rule_id, name, position, active, action_type, config)
SELECT r.id, 'start Notice of Filing workflow', 0, 1, 'workflow',
       JSON_OBJECT('workflow_id',
                   (SELECT w.id FROM workflows w WHERE w.name = 'Notice of Filing -> client'))
  FROM trigger_rules r
 WHERE r.name = 'Case filed -> notice of filing to client';


-- ═════════════════════════════════════════════════════════════════════════════
-- 12. VERIFY.
--
--    Expect 7 steps, numbered 1-7, all at version 1:
--      1 Load the automations sender    get_settings
--      2 Look up the client             query_db
--      3 Docket for the subject line    (custom_code — the fn column reads NULL)
--      4 Generate the notice            document_generate_from_template
--                                       template_id must be a NUMBER — not a
--                                       string, not @@TEMPLATE_ID@@
--      5 Have a notice and an address?  evaluate_condition  then=6  else=null
--      6 Email the notice to the client send_email
--      7 Log it on the case             create_log
--
--    the workflow active=1 current_version=1 draft_version=NULL version_rows=1
--    step_rows=7, and one rule active=0 with one 'workflow' action whose
--    workflow_id matches.
-- ═════════════════════════════════════════════════════════════════════════════
SELECT s.step_number, s.id, s.type, s.label,
       JSON_UNQUOTE(JSON_EXTRACT(s.config, '$.function_name')) AS fn,
       JSON_EXTRACT(s.config, '$.params.then')        AS then_step,
       JSON_EXTRACT(s.config, '$.params.else')        AS else_step,
       JSON_EXTRACT(s.config, '$.params.template_id') AS template_id,
       s.version
  FROM workflow_steps s
  JOIN workflows w ON w.id = s.workflow_id
 WHERE w.name = 'Notice of Filing -> client'
 ORDER BY s.version, s.step_number;

SELECT w.id AS workflow_id, w.active, w.current_version, w.draft_version,
       (SELECT COUNT(*) FROM workflow_versions v WHERE v.workflow_id = w.id) AS version_rows,
       (SELECT COUNT(*) FROM workflow_steps s
         WHERE s.workflow_id = w.id AND s.version = 1)                       AS step_rows
  FROM workflows w
 WHERE w.name = 'Notice of Filing -> client';

SELECT r.id AS rule_id, r.event_type, r.active, r.min_interval_s, r.position,
       r.match_mode, r.match_config, r.transform_mode, r.transform_config,
       a.action_type, a.config AS action_config
  FROM trigger_rules r
  LEFT JOIN trigger_rule_actions a ON a.rule_id = r.id
 WHERE r.name = 'Case filed -> notice of filing to client';


-- ═════════════════════════════════════════════════════════════════════════════
-- 13. ARM IT — run this ONLY after a manual workflow run produced a PDF you
--     have opened and read. Deliberately left commented out.
-- ═════════════════════════════════════════════════════════════════════════════
-- UPDATE trigger_rules
--    SET active = 1
--  WHERE name = 'Case filed -> notice of filing to client';
