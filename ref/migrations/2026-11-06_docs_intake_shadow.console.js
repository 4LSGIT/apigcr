// ref/migrations/2026-11-06_docs_intake_shadow.console.js
// Design: ref/EMAIL_ATTACHMENTS_DESIGN.md §7 (S2). Next: 2026-11-06_docs_intake_cutover.console.js.
//
// docs@ intake — SHADOW. Paste into the main YisraCase tab's DevTools console
// (apiSend). Deploy the S2 patch FIRST — step 0 refuses when the server's
// request_decision.options does not take a {{placeholder}}.
//
//   1. creates + publishes the "docs@ intake" workflow, its notices going to
//      it@4lsg.com / user 6 (step 1) while it shadows
//   2. rule 24 ("docs@ digest (replaces Pabbly)"): match widened to docs@ in
//      any To/Cc slot; transform output gains the message reference
//      (mail_message_id, source, message_id) with the digest fields
//      unchanged; a `workflow` action added BESIDE the live digest action 27
// Proves the new match and transform on real executions before writing,
// asserts every base it writes over, re-reads every write. Re-runnable: each
// part recognizes its own finished state and skips it.
//
// THE SHADOW IS NOT DRY: from the first docs@ email after this runs,
// attachments are filed in Dropbox for real, while SB still gets the old
// digest (which says nothing about it).
(async () => {
const RULE_ID = 24;
const RULE_BASE_STAMP = '2026-10-26T15:58:11.000Z';  // rule 24 definition_updated_at, read 2026-11-06
const DIGEST_ACTION_ID = 27;
const FROM = 'automations@4lsg.com';
const DIGEST_CONFIG = { function_name: 'send_email', params_mapping: {
  to: "'shoshana@metrodetroitbankruptcylaw.com'", from: "'" + FROM + "'", html: 'html', text: 'text', subject: 'subject' } };
const POS_EXECS = [28130, 26046];  // real docs@ mail: worker (to[0]); docs@ third in To
const NEG_EXEC = 28354;            // YC's own task-summary email to stuart@ — must NOT match
const WF_NAME = 'docs@ intake';
const WF_DESCRIPTION = 'Started by email rule 24 for each new email to docs@4lsg.com ' +
  '(ref/EMAIL_ATTACHMENTS_DESIGN.md §7). Files the attachments — the case\'s Client Uploads/Emailed YYMMDD, ' +
  'else the unsorted client-uploads folder — and emails the notice. When the case is unclear the notice ' +
  'carries one button per candidate case (7 days; unanswered, the files stay unsorted). Notice recipient: step 1.';
const RULE_DESCRIPTION = 'docs@4lsg.com: one formatted digest email per message (action 27, to SB) AND the "docs@ intake" ' +
  'workflow, which files the attachments in Dropbox (ref/EMAIL_ATTACHMENTS_DESIGN.md §7; shadow from 2026-11-06).';

const STEPS = /* JSON:STEPS */[
  {
    "label": "Who gets the notices",
    "type": "internal_function",
    "config": { "function_name": "noop", "params": {},
      "set_vars": { "notify_email": "it@4lsg.com", "notify_user_id": 6 } }
  },
  {
    "label": "File the attachments",
    "type": "internal_function",
    "config": { "function_name": "email_attachments_file",
      "params": { "mail_message_id": "{{mail_message_id}}", "source": "{{source}}", "message_id": "{{message_id}}",
        "target": "auto", "notice_subject_prefix": "New email to Docs@4LSG.com — ", "notice_title": "docs@4lsg.com",
        "output_var": "filing" },
      "set_vars": { "needs_decision": "{{this.output.needs_decision}}" } },
    "error_policy": { "strategy": "retry_then_abort", "max_retries": 2, "backoff_seconds": 20 }
  },
  {
    "label": "Does someone need to pick the case?",
    "type": "internal_function",
    "config": { "function_name": "evaluate_condition",
      "params": { "variable": "needs_decision", "operator": "==", "value": "true", "then": 6, "else": 4 } }
  },
  {
    "label": "Send the notice",
    "type": "internal_function",
    "config": { "function_name": "send_email",
      "params": { "from": "automations@4lsg.com", "to": "{{notify_email}}", "subject": "{{filing.notice_subject}}",
        "html": "{{filing.notice_html}}", "text": "{{filing.notice_text}}" } },
    "error_policy": { "strategy": "retry_then_abort", "max_retries": 2, "backoff_seconds": 30 }
  },
  {
    "label": "Done",
    "type": "internal_function",
    "config": { "function_name": "set_next", "params": { "value": "end" } }
  },
  {
    "label": "Ask which case (notice with one button per case)",
    "type": "internal_function",
    "config": { "function_name": "request_decision",
      "params": { "question": "Which case do the files emailed by {{filing.from.email}} belong to?",
        "options": "{{filing.decision_options}}", "result_var": "chosen_case",
        "timeout": "7d", "timeout_value": "unsorted", "nextStep": 7,
        "recipient_kind": "user", "recipient_id": "{{notify_user_id}}",
        "send_email": true, "email_from": "automations@4lsg.com",
        "email_subject": "{{filing.notice_subject}}", "email_html": "{{filing.notice_html_decision}}",
        "create_task": false } },
    "error_policy": { "strategy": "retry_then_abort", "max_retries": 1, "backoff_seconds": 30 }
  },
  {
    "label": "A case was picked?",
    "type": "internal_function",
    "config": { "function_name": "evaluate_condition",
      "params": { "variable": "chosen_case", "operator": "!=", "value": "unsorted", "then": 8 } }
  },
  {
    "label": "Move the files to that case",
    "type": "internal_function",
    "config": { "function_name": "email_attachments_refile",
      "params": { "mail_message_id": "{{filing.mail_message_id}}", "case_id": "{{chosen_case}}", "output_var": "refiled" },
      "set_vars": { "refile_failed": "{{this.output.failed.length}}" } },
    "error_policy": { "strategy": "retry_then_abort", "max_retries": 1, "backoff_seconds": 30 }
  },
  {
    "label": "Anything left behind?",
    "type": "internal_function",
    "config": { "function_name": "evaluate_condition",
      "params": { "variable": "refile_failed", "operator": ">", "value": 0, "then": 10 } }
  },
  {
    "label": "Say what did not move",
    "type": "internal_function",
    "config": { "function_name": "send_email",
      "params": { "from": "automations@4lsg.com", "to": "{{notify_email}}",
        "subject": "NOT MOVED — {{filing.notice_subject}}",
        "text": "{{refile_failed}} of the files emailed by {{filing.from.email}} could not be moved to case {{chosen_case}}. They are still in the unsorted folder:\n{{filing.folder_path}}\n{{filing.folder_link}}\n\nWhatever did move is in:\n{{refiled.folder_path}}\n{{refiled.folder_link}}\n\nIf this keeps happening, tell IT (workflow execution {{env.executionId}}, mail message {{filing.mail_message_id}})." } },
    "error_policy": { "strategy": "retry_then_abort", "max_retries": 2, "backoff_seconds": 30 }
  }
]/* /JSON:STEPS */;

// Rule 24's match as read 2026-11-06 (no firm-domain exclusion: staff can
// forward client mail to docs@, and a typed "case XXXXXXXX" files it).
const OLD_MATCH = { operator: 'and', conditions: [{ operator: 'or', conditions: [
  { op: 'equals', path: 'envelope.recipient', value: 'docs@4lsg.com' },
  { op: 'equals', path: 'to.0.email', value: 'docs@4lsg.com' }] }] };
// Widened: docs@ in ANY of the first ten To and Cc slots (hookFilter's equals
// is a String() compare, so an array can't be searched — the slots are
// enumerated). Envelope addresses are lowercased by both feeders.
const MATCH = /* JSON:MATCH */{ "operator": "and", "conditions": [{ "operator": "or", "conditions": [
  { "op": "equals", "path": "envelope.recipient", "value": "docs@4lsg.com" },
  { "op": "equals", "path": "to.0.email", "value": "docs@4lsg.com" }, { "op": "equals", "path": "to.1.email", "value": "docs@4lsg.com" },
  { "op": "equals", "path": "to.2.email", "value": "docs@4lsg.com" }, { "op": "equals", "path": "to.3.email", "value": "docs@4lsg.com" },
  { "op": "equals", "path": "to.4.email", "value": "docs@4lsg.com" }, { "op": "equals", "path": "to.5.email", "value": "docs@4lsg.com" },
  { "op": "equals", "path": "to.6.email", "value": "docs@4lsg.com" }, { "op": "equals", "path": "to.7.email", "value": "docs@4lsg.com" },
  { "op": "equals", "path": "to.8.email", "value": "docs@4lsg.com" }, { "op": "equals", "path": "to.9.email", "value": "docs@4lsg.com" },
  { "op": "equals", "path": "cc.0.email", "value": "docs@4lsg.com" }, { "op": "equals", "path": "cc.1.email", "value": "docs@4lsg.com" },
  { "op": "equals", "path": "cc.2.email", "value": "docs@4lsg.com" }, { "op": "equals", "path": "cc.3.email", "value": "docs@4lsg.com" },
  { "op": "equals", "path": "cc.4.email", "value": "docs@4lsg.com" }, { "op": "equals", "path": "cc.5.email", "value": "docs@4lsg.com" },
  { "op": "equals", "path": "cc.6.email", "value": "docs@4lsg.com" }, { "op": "equals", "path": "cc.7.email", "value": "docs@4lsg.com" },
  { "op": "equals", "path": "cc.8.email", "value": "docs@4lsg.com" }, { "op": "equals", "path": "cc.9.email", "value": "docs@4lsg.com" }
] }] }/* /JSON:MATCH */;

// The digest transform's last line, and its replacement: the same digest
// fields plus the message reference the workflow's first step reads. The
// worker's envelope names its stored row (mailbox.message_row_id); source +
// headers.message_id resolve any envelope the mailbox store also holds.
const OLD_RETURN = 'return { subject: outSubject, html, text, sender_email: email, files: nFiles, case_id: caseId };';
const NEW_RETURN = /* JSON:NEW_RETURN */"return { subject: outSubject, html, text, sender_email: email, files: nFiles, case_id: caseId,\n  // docs@ intake workflow (ref/EMAIL_ATTACHMENTS_DESIGN.md §7): the stored message it files from\n  mail_message_id: (input.mailbox && input.mailbox.message_row_id) || null,\n  source: input.source || null,\n  message_id: (input.headers && input.headers.message_id) || null };"/* /JSON:NEW_RETURN */;

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x))
  ? Object.keys(x).sort().reduce((o, key) => (o[key] = x[key], o), {}) : x);
const same = (a, b) => canon(a) === canon(b);
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const count = (s, sub) => String(s).split(sub).length - 1;
const fail = (m, extra) => { console.error('NO-GO —', m, extra ?? ''); throw new Error(m); };
const stepView = (s) => ({ label: s.label ?? null, type: s.type, config: J(s.config), error_policy: J(s.error_policy) ?? null });
const want = STEPS.map((s) => ({ label: s.label, type: s.type, config: s.config, error_policy: s.error_policy ?? null }));
const stepsMatch = (rows) => rows.length === want.length && rows.every((r, i) => same(stepView(r), want[i]));

// ── 0. the deployed server knows the S1 functions and the S2 options contract ──
const meta = (await apiSend('/workflows/functions', 'GET')).meta || {};
const optSpec = ((meta.request_decision || {}).params || []).find((p) => p.name === 'options');
if (!optSpec || optSpec.placeholderAllowed !== true) fail('request_decision.options takes no {{placeholder}} on this server — deploy the S2 patch first');
if (!meta.email_attachments_file || !meta.email_attachments_refile) fail('email_attachments_file / _refile missing on this server — S1 is not deployed');

// ── 1. read both bases ──
const named = ((await apiSend('/workflows', 'GET', { search: WF_NAME, limit: 100 })).workflows || []).filter((w) => w.name === WF_NAME);
if (named.length > 1) fail('more than one workflow is named ' + JSON.stringify(WF_NAME) + ': ' + named.map((w) => w.id).join(', '));
let rule = (await apiSend('/api/email-ingest/rules/' + RULE_ID, 'GET')).rule;
const code0 = (J(rule.transform_config) || {}).code;
const acts0 = rule.actions || [];
const digest0 = acts0.find((a) => Number(a.id) === DIGEST_ACTION_ID);
if (rule.match_mode !== 'conditions' || rule.transform_mode !== 'code' || typeof code0 !== 'string') fail('rule ' + RULE_ID + ' is not a conditions/code rule', rule);
if (!digest0 || digest0.action_type !== 'internal_function' || Number(digest0.active) !== 1 || !same(J(digest0.config), DIGEST_CONFIG)) fail('digest action ' + DIGEST_ACTION_ID + ' is not the live SB digest', digest0);
const ruleIsBase = Date.parse(rule.definition_updated_at) === Date.parse(RULE_BASE_STAMP)
  && same(J(rule.match_config), OLD_MATCH) && count(code0, OLD_RETURN) === 1 && acts0.length === 1;
const ruleIsNew = same(J(rule.match_config), MATCH) && count(code0, NEW_RETURN) === 1 && count(code0, OLD_RETURN) === 0;
if (!ruleIsBase && !ruleIsNew) fail('rule ' + RULE_ID + ' is neither the 2026-11-06 base nor this script\'s result — someone edited it; re-read before running', { stamp: rule.definition_updated_at, actions: acts0.length });
const NEW_CODE = ruleIsBase ? code0.replace(OLD_RETURN, () => NEW_RETURN) : code0;
if (count(NEW_CODE, NEW_RETURN) !== 1 || count(NEW_CODE, OLD_RETURN) !== 0) fail('transform edit did not apply');

// ── 2. prove the match and the transform on real executions BEFORE any write ──
const tm = async (match_config, exec_id) => (await apiSend('/api/email-ingest/rules/test-match', 'POST',
  { match_mode: 'conditions', match_config, exec_id, include_misses: true })).rows[0];
for (const id of POS_EXECS) { const r = await tm(MATCH, id); if (!r || r.matched !== true) fail('positive execution ' + id + ' does not match', r); }
{ const r = await tm(MATCH, NEG_EXEC); if (!r || r.matched !== false) fail('negative execution ' + NEG_EXEC + ' matches', r); }
const win = async (match_config) => (await apiSend('/api/email-ingest/rules/test-match', 'POST',
  { match_mode: 'conditions', match_config, limit: 300 })).rows.filter((r) => r.matched).map((r) => String(r.exec_id));
const oldHits = await win(OLD_MATCH), newHits = await win(MATCH);
const lost = oldHits.filter((id) => !newHits.includes(id));
if (lost.length) fail('the widened match misses executions the old one matched: ' + lost.join(', '));
console.log('match: ' + POS_EXECS.length + ' positives, 1 negative; last 300 events — old ' + oldHits.length + ', new ' + newHits.length +
  (newHits.length > oldHits.length ? ' (new only: ' + newHits.filter((id) => !oldHits.includes(id)).join(', ') + ')' : ''));
const tt = async (code) => apiSend('/api/email-ingest/rules/test-transform', 'POST', {
  transform_mode: 'code', transform_config: { code }, exec_id: POS_EXECS[0],
  params_mappings: [{ label: 'digest', mapping: DIGEST_CONFIG.params_mapping }] });
const tNew = await tt(NEW_CODE);
if (!tNew.transform || !tNew.transform.ok) fail('new transform fails on ' + POS_EXECS[0], tNew.transform);
const o = tNew.transform.output;
if (o.source !== 'gmail-firm' || typeof o.message_id !== 'string' || !o.message_id || !('mail_message_id' in o)) fail('new transform: message reference missing', o);
if (o.mail_message_id !== null && !(Number.isInteger(o.mail_message_id) && o.mail_message_id > 0)) fail('new transform: mail_message_id is neither null nor a row id', o.mail_message_id);
if (ruleIsBase) {
  const tOld = await tt(code0);
  if (!tOld.transform || !tOld.transform.ok) fail('current transform fails on ' + POS_EXECS[0], tOld.transform);
  const { mail_message_id, source, message_id, ...digestPart } = o;
  if (!same(digestPart, tOld.transform.output)) fail('the digest fields changed', { before: tOld.transform.output, after: digestPart });
  if (!same(tNew.resolved_params, tOld.resolved_params)) fail('the digest email changed', { before: tOld.resolved_params, after: tNew.resolved_params });
}
console.log('transform: ' + (ruleIsBase ? 'digest output unchanged' : 'already extended') + '; reference ' + JSON.stringify({ mail_message_id: o.mail_message_id, source: o.source, message_id: o.message_id }));

// ── 3. the workflow: create (unpublished draft v1) → verify → publish → verify ──
let wfId = named.length ? Number(named[0].id) : null;
const readWf = async () => apiSend('/workflows/' + wfId, 'GET');
if (wfId == null) {
  const r = await apiSend('/workflows/bulk', 'POST', { name: WF_NAME, description: WF_DESCRIPTION, steps: STEPS });
  wfId = Number(r.workflowId);
  if (!Number.isInteger(wfId) || wfId <= 0 || r.stepCount !== STEPS.length) fail('bulk create answered oddly', r);
  console.log('created workflow ' + wfId);
}
let wf = await readWf();
if (Number(wf.workflow.active) !== 1) fail('workflow ' + wfId + ' is inactive', wf.workflow);
if (!stepsMatch(wf.steps || [])) fail('workflow ' + wfId + ' steps differ from STEPS (version ' + wf.editing_version + ')', (wf.steps || []).map(stepView));
if (wf.has_draft) {
  if (Number(wf.workflow.current_version) !== 0 || Number(wf.workflow.draft_version) !== 1) fail('workflow ' + wfId + ' has an unexpected draft', wf.workflow);
  await apiSend('/workflows/' + wfId + '/publish', 'POST', { expected_base: { draft_version: 1, step_count: STEPS.length } });
  wf = await readWf();
}
if (wf.has_draft || Number(wf.workflow.current_version) !== 1 || !stepsMatch(wf.steps || [])) fail('workflow ' + wfId + ' is not published v1 with STEPS', wf.workflow);
console.log('workflow ' + wfId + ' published v1, notices to ' + STEPS[0].config.set_vars.notify_email);

// ── 4. rule 24: match + transform, then the workflow action beside the digest ──
if (ruleIsBase) {
  const r = await apiSend('/api/email-ingest/rules/' + RULE_ID, 'PUT', {
    description: RULE_DESCRIPTION, match_mode: 'conditions', match_config: MATCH,
    transform_mode: 'code', transform_config: { code: NEW_CODE },
    expected_base: { definition_updated_at: rule.definition_updated_at } });
  if (!r || !r.rule) fail('rule PUT answered oddly', r);
}
rule = (await apiSend('/api/email-ingest/rules/' + RULE_ID, 'GET')).rule;
if (!same(J(rule.match_config), MATCH) || (J(rule.transform_config) || {}).code !== NEW_CODE || Number(rule.active) !== 1) fail('rule ' + RULE_ID + ' did not land as written', rule);
const isWfAction = (a) => a.action_type === 'workflow' && Number((J(a.config) || {}).workflow_id) === wfId;
let wfActs = (rule.actions || []).filter(isWfAction);
const others = (rule.actions || []).filter((a) => !isWfAction(a) && Number(a.id) !== DIGEST_ACTION_ID);
if (others.length) fail('rule ' + RULE_ID + ' carries an action this script does not know', others);
if (wfActs.length > 1) fail('rule ' + RULE_ID + ' starts workflow ' + wfId + ' twice', wfActs);
if (!wfActs.length) {
  await apiSend('/api/email-ingest/rules/' + RULE_ID + '/actions', 'POST', {
    action_type: 'workflow', name: 'docs@ intake workflow', position: 1, active: 1, config: { workflow_id: wfId },
    expected_base: { definition_updated_at: rule.definition_updated_at } });
  rule = (await apiSend('/api/email-ingest/rules/' + RULE_ID, 'GET')).rule;
  wfActs = (rule.actions || []).filter(isWfAction);
}
const digest1 = (rule.actions || []).find((a) => Number(a.id) === DIGEST_ACTION_ID);
if ((rule.actions || []).length !== 2 || wfActs.length !== 1 || Number(wfActs[0].active) !== 1 || !same(J(wfActs[0].config), { workflow_id: wfId })) fail('workflow action did not land', rule.actions);
if (!digest1 || Number(digest1.active) !== 1 || !same(J(digest1.config), DIGEST_CONFIG)) fail('digest action changed', digest1);
console.log('GO — shadow on: workflow ' + wfId + ' (docs@ intake, notices to it@4lsg.com) starts from rule ' + RULE_ID +
  ' action ' + wfActs[0].id + ', beside the SB digest (action ' + DIGEST_ACTION_ID + '). Next: on the next docs@ email expect the digest at SB ' +
  'AND a notice (or a pick-the-case email) at it@4lsg.com, files in Dropbox; after 3–5 days run 2026-11-06_docs_intake_cutover.console.js.');
})();
