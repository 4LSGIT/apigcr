-- ref/2026-08-31_wf40_subject_form_name.sql
--
-- wf40 ("Form Submission Notify", the SHARED onSubmit workflow) — put the
-- FORM'S NAME in the notification subject.
--
-- Before:  New form submission — John Smith
--          New UNLINKED form submission — John Smith
-- After:   Initial Bankruptcy Questionnaire — John Smith
--          [Unlinked] Initial Bankruptcy Questionnaire — John Smith
--
-- The label is resolved in step 1, cheapest-truthful-source first:
--   1. {{form_label}}      — per-form initData override; the CURATED short
--                        name for a form whose title is too long.
--   2. {{form_title}}      — form_templates.title, injected by BOTH dispatchers
--                        (needs the code deploy below); auto-clipped at
--                        {{form_label_max}} chars (default 45) on a word
--                        boundary with an ellipsis.
--   3. prettified form_key — 'contact_us' -> 'Contact Us'. Works with NO code
--                        deploy and NO per-form config.
--   4. 'Form'            — last resort.
--
-- Also fixed here, same shared-workflow defect (the workflow said "intake" for
-- every form, and had no log subject unless the form supplied one):
--   * step 1 now exports {{form_label}}, {{submitter}} and a {{log_subject}}
--     that falls back to "<form label> received". There is NO |default: filter
--     in the placeholder resolver (see the 2026-08-14 file), so the fallback
--     has to live in the custom_code.
--   * step 6's RG task title is generic instead of hardcoding "intake form".
--
-- ============================================================================
-- WHY THIS FILE IS SHAPED AS A DRAFT + PUBLISH, NOT AN IN-PLACE UPDATE
-- ============================================================================
-- The 2026-08-14 X5.1 file edited wf40's step rows by id. That predates
-- automation versioning (2026-08-18). workflow_steps is now keyed
-- (workflow_id, version, step_number); executions pin workflow_version; and
-- ensureDraft's contract is explicit: "Published versions are immutable BY
-- CONSTRUCTION — nothing ever writes to a version number once current_version
-- has pointed at it." So this file does what the editor does: builds draft
-- v2 as a copy of v1, edits v2, and leaves the publish to you.
--
-- Verified against the LIVE rows before writing this file:
--   * wf40 is current_version = 1, draft_version = NULL, 10 steps, one version.
--   * validateWorkflowDraft() passes on v1 as-is AND on the edited v2, so the
--     publish will not 400.
--   * diffWorkflowSteps() classifies the change as STRUCTURAL ("step 1:
--     custom_code changed (always structural)"). PUBLISH WITHOUT
--     "migrate in-flight" — it will 409 otherwise. That is the right
--     behaviour anyway: in-flight runs finish on v1, new submissions get v2.
--
-- RUN ORDER
--   1. This file, top to bottom.
--   2. Open wf40 in the workflow editor, confirm the draft diff, hit Publish
--      (do NOT tick migrate in-flight).
--   3. Deploy the code (form_title injection).
-- Safe in any order: the new step-1 code degrades to the prettified form_key
-- while form_title is absent, and every var it reads resolves to '' when
-- missing. Rollback is UPDATE workflows SET current_version = 1 (v1's rows are
-- untouched), or Discard Draft before step 2.
--
-- EACH STATEMENT IS SELF-CONTAINED (the DB console uses a pooled connection
-- per statement — no session variables, no cross-statement transactions).
--
-- The step-1 code literal below relies on backslash escaping: every \\ in it
-- decodes to one \ so the JS keeps its regexes and its \u2014 / \u2026.
-- Verified live 2026-08-31: MySQL 8.4.6, sql_mode does NOT include
-- NO_BACKSLASH_ESCAPES. If that ever changes, this literal must be re-escaped.
--
-- CODE DEPLOY THAT PAIRS WITH THIS (form_title injection):
--   routes/api.ext.forms.js   — form_title: tpl.title in the system block
--   public/js/yc-forms.js     — formTitle config + form_title/_values injection
--   public/forms/render.html  — formTitle: meta.title into the YCForm config

-- ---------------------------------------------------------------------------
-- 0. PRECONDITION — run this FIRST and read it.
--    Expect: current_version 1, draft_version NULL, max_version 1, steps 10.
--    If draft_version is NOT NULL, someone has an open draft in the editor.
--    STOP: publish or discard it first, then re-check. Every statement below
--    hardcodes version 2 and will collide with an existing draft.
-- ---------------------------------------------------------------------------
SELECT w.current_version,
       w.draft_version,
       (SELECT COALESCE(MAX(version), 0) FROM workflow_versions WHERE workflow_id = 40) AS max_version,
       (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = 40 AND version = w.current_version) AS steps_in_current
  FROM workflows w
 WHERE w.id = 40;

-- ---------------------------------------------------------------------------
-- 1. Copy the published version's steps into draft v2. Mirrors ensureDraft's
--    INSERT ... SELECT exactly (same column list, ids are fresh).
--    IGNORE, not a NOT EXISTS subquery: uk_workflow_version_step
--    (workflow_id, version, step_number) makes it idempotent, and a subquery
--    on the INSERT's own target table is the ER_UPDATE_TABLE_USED footgun.
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO workflow_steps (workflow_id, version, step_number, label, note, type, config, error_policy)
SELECT s.workflow_id, 2, s.step_number, s.label, s.note, s.type, s.config, s.error_policy
  FROM workflow_steps s
 WHERE s.workflow_id = 40
   AND s.version = 1;

-- ---------------------------------------------------------------------------
-- 2. Draft metadata stub. published_at stays NULL until you publish.
--    IGNORE against PK (workflow_id, version) makes it re-runnable.
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO workflow_versions (workflow_id, version, name, description, test_input)
SELECT id, 2, name, description, test_input FROM workflows WHERE id = 40;

-- ---------------------------------------------------------------------------
-- 3. Point the workflow at the draft. The editor will now show it.
-- ---------------------------------------------------------------------------
UPDATE workflows SET draft_version = 2, updated_at = NOW() WHERE id = 40 AND draft_version IS NULL;

-- ---------------------------------------------------------------------------
-- 4. DRAFT step 1 ("Format answers") — new code, wider input map, three new
--    output vars. One JSON_SET so a partial apply is impossible.
--    Addressed by (workflow_id, version, step_number), NOT by id: the v2 rows
--    were just created and their ids are whatever auto_increment handed out.
-- ---------------------------------------------------------------------------
UPDATE workflow_steps
   SET config = JSON_SET(
         config,
         '$.input.form_title',     '{{form_title}}',
         '$.input.form_label',     '{{form_label}}',
         '$.input.form_label_max', '{{form_label_max}}',
         '$.input.log_subject',    '{{log_subject}}',
         '$.set_vars.form_label',  '{{this.form_label}}',
         '$.set_vars.submitter',   '{{this.submitter}}',
         '$.set_vars.log_subject', '{{this.log_subject}}',
         '$.code',
'function s(v){var x=String(v==null?'''':v).trim();return (x===''null''||x===''undefined'')?'''':x;}
function esc(v){return String(v).replace(/&/g,''&amp;'').replace(/</g,''&lt;'').replace(/>/g,''&gt;'').replace(/"/g,''&quot;'');}
function pretty(k){return String(k).replace(/[_-]+/g,'' '').replace(/\\b[a-z]/g,function(c){return c.toUpperCase();});}
function clip(t,n){if(!t||t.length<=n)return t;var cut=t.slice(0,n),sp=cut.lastIndexOf('' '');if(sp>Math.floor(n*0.55))cut=cut.slice(0,sp);return cut.replace(/[\\s\\u2014,:;.-]+$/,'''')+''\\u2026'';}
var values = (input.values && typeof input.values === ''object'') ? input.values : {};
var pairs = [];
if (Array.isArray(input.labels) && input.labels.length) {
  for (var i = 0; i < input.labels.length; i++) {
    var L = input.labels[i];
    if (!Array.isArray(L) || L.length < 2) continue;
    pairs.push([String(L[0]), s(values[L[1]])]);
  }
} else {
  var ks = Object.keys(values);
  for (var j = 0; j < ks.length; j++) pairs.push([pretty(ks[j]), s(values[ks[j]])]);
}
var lines = [], rows = [];
for (var p = 0; p < pairs.length; p++) {
  if (!pairs[p][1]) continue;
  lines.push(pairs[p][0] + '': '' + pairs[p][1]);
  rows.push(''<tr><td style="padding:4px 12px 4px 0;vertical-align:top;"><b>'' + esc(pairs[p][0]) + ''</b></td><td style="padding:4px 0;">'' + esc(pairs[p][1]) + ''</td></tr>'');
}
var linked = s(input.link_type) === ''case'';
var who = s(values[s(input.title_field) || ''name'']);
var maxLen = Number(s(input.form_label_max));
if (!(maxLen > 0)) maxLen = 45;
var formLabel = s(input.form_label) || clip(s(input.form_title), maxLen) || pretty(s(input.form_key)) || ''Form'';
var formLine = formLabel + (s(input.form_key) ? '' ('' + s(input.form_key) + '')'' : '''');
var head = linked ? (''Linked to case '' + s(input.link_id)) : ''NOT LINKED to any case'';
({
  summary_text: head + ''\\nForm: '' + formLine + ''  Submission #'' + s(input.submission_id) + ''\\n\\n'' + lines.join(''\\n''),
  summary_html: ''<body><p>'' + esc(head) + ''<br>Form: '' + esc(formLine) + '' &mdash; Submission #'' + esc(s(input.submission_id)) + ''</p><table>'' + rows.join('''') + ''</table></body>'',
  form_label: formLabel,
  submitter: who,
  log_subject: s(input.log_subject) || (formLabel + '' received''),
  email_subject: (linked ? '''' : ''[Unlinked] '') + formLabel + (who ? '' \\u2014 '' + who : '''')
})'
       ),
       label = 'Format answers + subject (generic)'
 WHERE workflow_id = 40 AND version = 2 AND step_number = 1;

-- ---------------------------------------------------------------------------
-- 5. DRAFT step 6 ("RG alert (unlinked)") — stop hardcoding "intake form".
--    {{form_label}} and {{submitter}} come from statement 4's set_vars, so this
--    REQUIRES statement 4. Drop this one if you would rather leave the task
--    title alone.
-- ---------------------------------------------------------------------------
UPDATE workflow_steps
   SET config = JSON_SET(config, '$.params.title', 'Unlinked form: {{form_label}} — {{submitter}}')
 WHERE workflow_id = 40 AND version = 2 AND step_number = 6;

-- ---------------------------------------------------------------------------
-- 6. VERIFY the draft before publishing. Expect step 1 with the four new input
--    keys and three new set_vars, and step 6 with the generic title.
-- ---------------------------------------------------------------------------
SELECT step_number, id, label,
       JSON_EXTRACT(config, '$.input')        AS input_map,
       JSON_EXTRACT(config, '$.set_vars')     AS out_vars,
       JSON_UNQUOTE(JSON_EXTRACT(config, '$.params.title')) AS task_title
  FROM workflow_steps
 WHERE workflow_id = 40 AND version = 2 AND step_number IN (1, 6)
 ORDER BY step_number;

-- Sanity: v1 must still be intact and still the current version until you
-- press Publish. Expect current_version 1, draft_version 2, 10 rows each.
SELECT (SELECT current_version FROM workflows WHERE id = 40) AS current_version,
       (SELECT draft_version   FROM workflows WHERE id = 40) AS draft_version,
       (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = 40 AND version = 1) AS v1_steps,
       (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = 40 AND version = 2) AS v2_steps;

-- ---------------------------------------------------------------------------
-- 7. NOW PUBLISH from the workflow editor (Publish, migrate in-flight OFF).
--    Expected first intake submission after publish + code deploy:
--      linked   -> "Initial Bankruptcy Questionnaire — <name>"
--      unlinked -> "[Unlinked] Initial Bankruptcy Questionnaire — <name>"
--      RG task  -> "Unlinked form: Initial Bankruptcy Questionnaire — <name>"
--      case log -> subject "Intake questionnaire received" (unchanged; intake
--                  supplies log_subject, the new fallback only covers forms
--                  that do not)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 8. OPTIONAL — curated short label for the intake form. Its title is 32
--    chars, which clears the 45-char auto-clip, so this is only worth running
--    if you want the subject to read "Intake — John Smith". Edits the
--    PUBLISHED definition in place; the builder round-trips it. draft_definition
--    is left alone on purpose — republish from the builder to resync.
-- ---------------------------------------------------------------------------
-- UPDATE form_templates
--    SET definition = JSON_SET(definition,
--          '$.onSubmit.workflows[0].initData.form_label', 'Intake')
--  WHERE form_key = 'intake';
