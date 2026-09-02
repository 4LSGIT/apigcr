-- ref/2026-09-02_g4_2_notice_precheck.sql
--
-- G4.2 — check BEFORE rendering, and stop blocking the notice on a blank
-- street address.
--
-- Publishes VERSION 2 of workflow "Notice of Filing -> client" (id 47).
-- Version 1 is left intact and is NOT retired: three executions already
-- reference workflow_version = 1 and the editor's history reads from
-- workflow_versions. New runs pick up v2 the moment current_version flips in
-- statement 5.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- v1 discovered missing data by RENDERING and failing. Two costs:
--   1. html templates render through chromium, which SERIALIZES on this 1GiB
--      container. Burning a render to learn that case_judge is blank is the
--      most expensive possible way to read a column.
--   2. The only message staff got was document_generate_from_template's canned
--      on_missing task. Fine, but not ours to word, and it fires again on every
--      re-run.
-- v2 reads the columns it needs in the query_db step it was already running,
-- decides in a sandboxed custom_code step, and only then renders.
--
-- on_missing:'task' STAYS on the generate step as a backstop, because the
-- pre-check reads RAW COLUMNS and the resolvers do not. The gap that matters:
-- cases.case_trustee can be populated and still resolve to '' when the value
-- does not match a fe-trustees entry exactly (the two live stale short forms
-- do exactly this). The pre-check cannot see that; the generate step can.
--
-- ── COMPANION CHANGE (deploy first) ─────────────────────────────────────────
-- Template 8's prefill_schema drops `required` on debtor1_street. PUT the
-- regenerated ref/templates/notice_of_bankruptcy_filing.json to
-- /api/esign/templates/8 BEFORE running this. If you run this first, nothing
-- breaks — the pre-check simply never gates on an address, which is the intent
-- either way.
--
-- EACH STATEMENT IS SELF-CONTAINED — the console runs each on its own pooled
-- connection. Name-lookup subqueries, no session variables. No DDL.


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. The version-2 metadata row.
--    Numbered explicitly rather than MAX()+1 so re-reading this file tells you
--    which version it created.
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO workflow_versions (workflow_id, version, name, description, test_input, published_at, published_by)
SELECT w.id, 2, w.name,
       'G4.2. Pre-render readiness check: reads the required case columns in the existing query_db step, raises a staff task naming what is missing, and only renders when the data is there. debtor1_street is no longer a blocker.',
       w.test_input, NOW(), 'g4_2_seed'
  FROM workflows w
 WHERE w.name = 'Notice of Filing -> client';


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Steps 1-5 of version 2.
--
--    STEP 2 gains four columns (case_chapter, case_file_date, case_judge,
--    case_trustee). Free — the row was already being fetched.
--
--    STEP 3 now decides as well as formats. `ready` is the STRING 'true'/'false'
--    for the same reason the guards use string operands: resolvePlaceholders
--    stringifies primitives and evaluateSingle compares with loose ==, where
--    true == "true" is FALSE. Do not "fix" it to a boolean.
--
--    STEP 4 branches over 5 so the happy path never creates a task.
--    STEP 5 is the task, worded by us, naming every missing field at once
--    rather than one per re-run. assigned_to 6 = Fred (IT); change if this
--    should land on the filing clerk instead.
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO workflow_steps (workflow_id, version, step_number, type, label, note, config, error_policy)
SELECT w.id, 2, 1, 'internal_function',
       'Load the automations sender',
       'email_automations from app_settings, so changing the sender is a settings edit. Same idiom as wf37 step 1.',
       '{"function_name":"get_settings","params":{"keys":"email_automations","output_var":"settings"}}',
       NULL
  FROM workflows w WHERE w.name = 'Notice of Filing -> client';

INSERT INTO workflow_steps (workflow_id, version, step_number, type, label, note, config, error_policy)
SELECT w.id, 2, 2, 'internal_function',
       'Look up the case and client',
       'wf28 step 1 shape (Primary contact via case_relate), now also fetching the four case columns the pre-check needs. The row was already being read — the extra columns are free.',
       '{"function_name":"query_db","params":{"from":"cases","join":[{"type":"left","table":"case_relate","on":{"left":"cases.case_id","right":"case_relate.case_relate_case_id"}},{"type":"left","table":"contacts","on":{"left":"case_relate.case_relate_client_id","right":"contacts.contact_id"}}],"where":[{"column":"cases.case_id","op":"=","value":"{{case_id}}"},{"column":"case_relate.case_relate_type","op":"=","value":"Primary"}],"select":["cases.case_id","cases.case_number","cases.case_number_full","cases.case_chapter","cases.case_file_date","cases.case_judge","cases.case_trustee","contacts.contact_name","contacts.contact_email"],"format":"first","output_var":"caseRow"},"set_vars":{"client_email":"{{this.output.contact_email}}","contact_name":"{{this.output.contact_name}}","case_number":"{{this.output.case_number}}","case_number_full":"{{this.output.case_number_full}}","case_chapter":"{{this.output.case_chapter}}","case_file_date":"{{this.output.case_file_date}}","case_judge":"{{this.output.case_judge}}","case_trustee":"{{this.output.case_trustee}}"}}',
       NULL
  FROM workflows w WHERE w.name = 'Notice of Filing -> client';

INSERT INTO workflow_steps (workflow_id, version, step_number, type, label, note, config, error_policy)
SELECT w.id, 2, 3, 'custom_code',
       'Docket, and is this case ready?',
       'Builds the subject-line docket (full || short, the wf28 s2 rule) and decides readiness over RAW COLUMNS. `ready` is the string "true"/"false" on purpose — placeholder resolution stringifies primitives and evaluateSingle uses loose ==. To stop gating on the trustee, delete its line from the `need` object.',
       '{"code":"function s(v){var x=String(v==null?\\"\\":v).trim();return (x===\\"null\\"||x===\\"undefined\\")?\\"\\":x;}\\nvar docket = s(input.full) || s(input.short);\\nvar need = {\\n  \\"case number\\": docket,\\n  \\"chapter\\": s(input.chapter),\\n  \\"file date\\": s(input.file_date),\\n  \\"judge\\": s(input.judge),\\n  \\"trustee\\": s(input.trustee),\\n  \\"debtor name\\": s(input.debtor_name),\\n  \\"client email address\\": s(input.client_email)\\n};\\nvar missing = Object.keys(need).filter(function(k){ return !need[k]; });\\n({ docket: docket, missing_list: missing.join(\\", \\"), ready: missing.length ? \\"false\\" : \\"true\\" });","input":{"full":"{{case_number_full}}","short":"{{case_number}}","chapter":"{{case_chapter}}","file_date":"{{case_file_date}}","judge":"{{case_judge}}","trustee":"{{case_trustee}}","debtor_name":"{{contact_name}}","client_email":"{{client_email}}"},"set_vars":{"docket":"{{this.docket}}","missing_list":"{{this.missing_list}}","ready":"{{this.ready}}"}}',
       NULL
  FROM workflows w WHERE w.name = 'Notice of Filing -> client';

INSERT INTO workflow_steps (workflow_id, version, step_number, type, label, note, config, error_policy)
SELECT w.id, 2, 4, 'internal_function',
       'Ready to send?',
       'Branches OVER the task step so the happy path never raises one. String operand, as everywhere in this workflow.',
       '{"function_name":"evaluate_condition","params":{"variable":"ready","operator":"==","value":"true","then":6,"else":5}}',
       NULL
  FROM workflows w WHERE w.name = 'Notice of Filing -> client';

INSERT INTO workflow_steps (workflow_id, version, step_number, type, label, note, config, error_policy)
SELECT w.id, 2, 5, 'internal_function',
       'Tell someone what is missing',
       'Our wording, naming every gap at once — unlike the generate step''s canned on_missing task, which fires one per re-run. Falls through to step 6, which stops the run.',
       '{"function_name":"create_task","params":{"title":"Notice of filing not sent — case {{docket}}","description":"The automated Notice of Bankruptcy Filing could not be sent to {{contact_name}} because the case record is missing: {{missing_list}}.\\n\\nFill these in on the case, then re-run the \\"Notice of Filing -> client\\" workflow. Nothing was emailed and no document was generated.","assigned_to":6,"assigned_by":0,"link_type":"case","link_id":"{{case_id}}","source":"notice_gate"}}',
       NULL
  FROM workflows w WHERE w.name = 'Notice of Filing -> client';


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Steps 6-10 of version 2.
--
--    STEP 6 is the stop for the not-ready path. It re-tests `ready` rather than
--    relying on step 5 to halt, because create_task is NOT a control step and
--    would otherwise fall through into the render.
--
--    STEP 7 keeps on_missing:'task' as the backstop described in the header.
--    STEP 10 is the last step, so the success path ends by running off the end
--    rather than needing a ceremony stop.
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO workflow_steps (workflow_id, version, step_number, type, label, note, config, error_policy)
SELECT w.id, 2, 6, 'internal_function',
       'Stop here if not ready',
       'create_task is not a control step and falls through, so the not-ready path needs an explicit halt. else null ends the run (control.js NOTE on else/null).',
       '{"function_name":"evaluate_condition","params":{"variable":"ready","operator":"==","value":"true","then":7,"else":null}}',
       NULL
  FROM workflows w WHERE w.name = 'Notice of Filing -> client';

INSERT INTO workflow_steps (workflow_id, version, step_number, type, label, note, config, error_policy)
SELECT w.id, 2, 7, 'internal_function',
       'Generate the notice',
       'Renders and files the PDF. on_missing task stays as the BACKSTOP: the pre-check reads raw columns, but a populated case_trustee that matches no fe-trustees entry still resolves to empty, and only this step can see that.',
       '{"function_name":"document_generate_from_template","params":{"template_id":8,"linkable_type":"case","linkable_id":"{{case_id}}","on_missing":"task","output_var":"notice"},"set_vars":{"notice_generated":"{{this.output.generated}}"}}',
       NULL
  FROM workflows w WHERE w.name = 'Notice of Filing -> client';

INSERT INTO workflow_steps (workflow_id, version, step_number, type, label, note, config, error_policy)
SELECT w.id, 2, 8, 'internal_function',
       'Did it generate?',
       'The backstop''s verdict. String operand — see step 3.',
       '{"function_name":"evaluate_condition","params":{"variable":"notice_generated","operator":"==","value":"true","then":9,"else":null}}',
       NULL
  FROM workflows w WHERE w.name = 'Notice of Filing -> client';

INSERT INTO workflow_steps (workflow_id, version, step_number, type, label, note, config, error_policy)
SELECT w.id, 2, 9, 'internal_function',
       'Email the notice to the client',
       'attachment_urls uses the [{url,name}] shape (wf40 step 4). attachment_names is NOT used: emailService calls it Pabbly-only legacy and both the smtp and gmail adapters ignore it.',
       '{"function_name":"send_email","params":{"from":"{{settings.email_automations}}","to":"{{client_email}}","subject":"Notice of Bankruptcy Filing — Case {{docket}}","html":"<p>Dear {{contact_name}},</p><p>Your bankruptcy case has been filed. A copy of the Notice of Bankruptcy Filing is attached for your records. It lists your case number, the assigned judge, and the trustee where one has been appointed.</p><p>You may give a copy of this notice to any creditor who contacts you about a debt, and you may refer them to our office.</p><p>Please keep it with your case papers. If you have any questions, call us at the number on the notice.</p>","attachment_urls":[{"url":"{{notice.temp_link}}","name":"{{notice.file_name}}"}]}}',
       NULL
  FROM workflows w WHERE w.name = 'Notice of Filing -> client';

INSERT INTO workflow_steps (workflow_id, version, step_number, type, label, note, config, error_policy)
SELECT w.id, 2, 10, 'internal_function',
       'Log it on the case',
       'Last step — the success path ends by running off the end. Same mapping shape as trigger rule 4''s create_log action.',
       '{"function_name":"create_log","params":{"type":"status","link_type":"case","link_id":"{{case_id}}","by":0,"direction":"outgoing","subject":"Notice of filing sent","data":"Notice of filing generated and emailed to client: {{notice.file_name}}"}}',
       NULL
  FROM workflows w WHERE w.name = 'Notice of Filing -> client';


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Publish. Nothing runs v2 until this statement.
-- ═════════════════════════════════════════════════════════════════════════════
UPDATE workflows
   SET current_version = 2, draft_version = NULL
 WHERE name = 'Notice of Filing -> client';


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. VERIFY. Expect 10 steps at version 2, branch targets 4→6/5, 6→7/null,
--    8→9/null, and current_version = 2.
-- ═════════════════════════════════════════════════════════════════════════════
SELECT s.version, s.step_number, s.type, s.label,
       JSON_UNQUOTE(JSON_EXTRACT(s.config, '$.function_name')) AS fn,
       JSON_EXTRACT(s.config, '$.params.then') AS then_step,
       JSON_EXTRACT(s.config, '$.params.else') AS else_step
  FROM workflow_steps s
  JOIN workflows w ON w.id = s.workflow_id
 WHERE w.name = 'Notice of Filing -> client'
 ORDER BY s.version, s.step_number;

SELECT id, active, current_version, draft_version FROM workflows
 WHERE name = 'Notice of Filing -> client';