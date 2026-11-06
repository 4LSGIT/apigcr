// ref/migrations/2026-11-06_docs_intake_cutover.console.js
// Design: ref/EMAIL_ATTACHMENTS_DESIGN.md §7 (S2). Runs after 2026-11-06_docs_intake_shadow.console.js
// has shadowed for a few days.
//
// docs@ intake — CUTOVER. Paste into the main YisraCase tab's DevTools console
// (apiSend).
//   1. workflow "docs@ intake": step 1's notice recipient it@4lsg.com / user 6
//      → SB (shoshana@metrodetroitbankruptcylaw.com / user 5); draft, verify
//      only step 1 moved, publish
//   2. rule 24: the digest action 27 deleted; the transform cut to the message
//      reference alone; renamed "docs@ intake"
// The recipient moves FIRST, so the worst a mid-run stop leaves is one email
// both ways (SB gets the digest and the notice), never one nobody gets.
// Asserts the shadow state it expects, refuses when a shadow run failed
// (look at it first, or set ALLOW_FAILED), re-reads every write. Re-runnable.
(async () => {
const RULE_ID = 24;
const DIGEST_ACTION_ID = 27;
const WF_NAME = 'docs@ intake';
const ALLOW_FAILED = false;   // true = cut over even though a shadow run failed
const POS_EXEC = 28130;       // a real docs@ message (worker) for the transform proof
const SHADOW_STEP1 = /* JSON:SHADOW_STEP1 */{ "function_name": "noop", "params": {}, "set_vars": { "notify_email": "it@4lsg.com", "notify_user_id": 6 } }/* /JSON:SHADOW_STEP1 */;
const LIVE_STEP1 = /* JSON:LIVE_STEP1 */{ "function_name": "noop", "params": {}, "set_vars": { "notify_email": "shoshana@metrodetroitbankruptcylaw.com", "notify_user_id": 5 } }/* /JSON:LIVE_STEP1 */;
const LABELS = ['Who gets the notices', 'File the attachments', 'Does someone need to pick the case?', 'Send the notice', 'Done',
  'Ask which case (notice with one button per case)', 'A case was picked?', 'Move the files to that case', 'Anything left behind?',
  'Say what did not move'];
const DIGEST_CONFIG = { function_name: 'send_email', params_mapping: {
  to: "'shoshana@metrodetroitbankruptcylaw.com'", from: "'automations@4lsg.com'", html: 'html', text: 'text', subject: 'subject' } };
// What the shadow script appended to the digest transform — its presence marks the shadow state.
const SHADOW_RETURN_MARK = '  // docs@ intake workflow (ref/EMAIL_ATTACHMENTS_DESIGN.md §7): the stored message it files from\n';
const RULE_NAME = 'docs@ intake';
const RULE_DESCRIPTION = 'docs@4lsg.com → the "docs@ intake" workflow, which files each email\'s attachments in Dropbox ' +
  'and emails SB the notice (ref/EMAIL_ATTACHMENTS_DESIGN.md §7). Replaced the digest email 2026-11 — the old ' +
  'transform is in email_ingest_rule_changes.';
const CODE = /* JSON:CUTOVER_CODE */"// docs@ intake — email ingest rule, transform_mode 'code' (QuickJS guest).\n// Output = the \"docs@ intake\" workflow's init_data: the stored message to file\n// from (ref/EMAIL_ATTACHMENTS_DESIGN.md §7). The worker's envelope names its\n// row; source + headers.message_id resolve any envelope the store also holds.\nreturn {\n  mail_message_id: (input.mailbox && input.mailbox.message_row_id) || null,\n  source: input.source || null,\n  message_id: (input.headers && input.headers.message_id) || null,\n};\n"/* /JSON:CUTOVER_CODE */;

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x))
  ? Object.keys(x).sort().reduce((o, key) => (o[key] = x[key], o), {}) : x);
const same = (a, b) => canon(a) === canon(b);
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const fail = (m, extra) => { console.error('NO-GO —', m, extra ?? ''); throw new Error(m); };
const stepView = (s) => ({ step_number: Number(s.step_number), label: s.label ?? null, type: s.type, config: J(s.config), error_policy: J(s.error_policy) ?? null });

// ── 1. the workflow ──
const named = ((await apiSend('/workflows', 'GET', { search: WF_NAME, limit: 100 })).workflows || []).filter((w) => w.name === WF_NAME);
if (named.length !== 1) fail('expected exactly one workflow named ' + JSON.stringify(WF_NAME) + ', found ' + named.length);
const wfId = Number(named[0].id);
const readWf = async () => apiSend('/workflows/' + wfId, 'GET');
let wf = await readWf();
if (wf.has_draft) fail('workflow ' + wfId + ' has an unpublished draft — publish or discard it first', wf.workflow);
const labelsOk = (rows) => rows.length === LABELS.length && rows.every((s, i) => Number(s.step_number) === i + 1 && s.label === LABELS[i]);
if (!labelsOk(wf.steps || [])) fail('workflow ' + wfId + ' is not the 10-step docs@ intake', (wf.steps || []).map((s) => s.label));
const step1 = J(wf.steps[0].config);
if (same(step1, SHADOW_STEP1)) {
  const runs = (await apiSend('/workflows/' + wfId + '/executions', 'GET', { limit: 200 })).executions || [];
  const bad = runs.filter((r) => r.status === 'failed' || Number(r.failed_steps) > 0);
  const done = runs.filter((r) => String(r.status).startsWith('completed'));
  console.log('shadow runs: ' + runs.length + ' (' + done.length + ' completed, ' + bad.length + ' failed or with a failed step)');
  if (!runs.length) fail('the shadow has not run yet — wait for a docs@ email');
  if (bad.length && !ALLOW_FAILED) fail('shadow runs failed: ' + bad.map((r) => r.id).join(', ') + ' — look at them first, or set ALLOW_FAILED = true');
  const before = wf.steps.map(stepView);
  const base = Number(wf.workflow.current_version);
  await apiSend('/workflows/' + wfId + '/steps/1', 'PUT', { type: 'internal_function', config: LIVE_STEP1,
    expected_base: { draft_version: null, step_count: LABELS.length } });
  wf = await readWf();
  const draft = Number(wf.workflow.draft_version);
  if (!wf.has_draft || !(draft > base)) fail('no draft after the step edit', wf.workflow);
  const after = wf.steps.map(stepView);
  if (!same(after[0].config, LIVE_STEP1) || after[0].label !== LABELS[0] || after[0].error_policy !== null) fail('step 1 did not land', after[0]);
  if (after.length !== before.length || !after.slice(1).every((s, i) => same(s, before[i + 1]))) fail('the draft changed more than step 1', after);
  await apiSend('/workflows/' + wfId + '/publish', 'POST', { expected_base: { draft_version: draft, step_count: LABELS.length } });
  wf = await readWf();
  if (wf.has_draft || Number(wf.workflow.current_version) !== draft) fail('publish did not land', wf.workflow);
} else if (!same(step1, LIVE_STEP1)) {
  fail('step 1 is neither the shadow nor the live recipient', step1);
}
if (!same(J(wf.steps[0].config), LIVE_STEP1)) fail('published step 1 is not the SB recipient', wf.steps[0]);
console.log('workflow ' + wfId + ' v' + wf.workflow.current_version + ': notices to SB');

// ── 2. rule 24 ──
let rule = (await apiSend('/api/email-ingest/rules/' + RULE_ID, 'GET')).rule;
const isWfAction = (a) => a.action_type === 'workflow' && Number((J(a.config) || {}).workflow_id) === wfId;
const code0 = (J(rule.transform_config) || {}).code;
const wfActs = (rule.actions || []).filter(isWfAction);
if (wfActs.length !== 1 || Number(wfActs[0].active) !== 1) fail('rule ' + RULE_ID + ' does not start workflow ' + wfId + ' exactly once', rule.actions);
const strays = (rule.actions || []).filter((a) => !isWfAction(a) && Number(a.id) !== DIGEST_ACTION_ID);
if (strays.length) fail('rule ' + RULE_ID + ' carries an action this script does not know', strays);
const digest = (rule.actions || []).find((a) => Number(a.id) === DIGEST_ACTION_ID);
if (digest && !same(J(digest.config), DIGEST_CONFIG)) fail('action ' + DIGEST_ACTION_ID + ' is not the SB digest', digest);
const codeIsShadow = typeof code0 === 'string' && code0.split(SHADOW_RETURN_MARK).length === 2;
if (!codeIsShadow && code0 !== CODE) fail('rule ' + RULE_ID + ' transform is neither the shadow digest nor the cutover code');
if (code0 !== CODE) {   // prove the cut-down transform before writing
  const tt = await apiSend('/api/email-ingest/rules/test-transform', 'POST',
    { transform_mode: 'code', transform_config: { code: CODE }, exec_id: POS_EXEC });
  const o = tt.transform && tt.transform.ok ? tt.transform.output : null;
  if (!o || Object.keys(o).sort().join() !== 'mail_message_id,message_id,source' || o.source !== 'gmail-firm' || !o.message_id) fail('cutover transform output wrong', tt.transform);
}
if (digest) {
  await apiSend('/api/email-ingest/rule-actions/' + DIGEST_ACTION_ID, 'DELETE',
    { expected_base: { definition_updated_at: rule.definition_updated_at } });
  rule = (await apiSend('/api/email-ingest/rules/' + RULE_ID, 'GET')).rule;
  if ((rule.actions || []).some((a) => Number(a.id) === DIGEST_ACTION_ID)) fail('digest action still there');
}
if ((J(rule.transform_config) || {}).code !== CODE || rule.name !== RULE_NAME) {
  await apiSend('/api/email-ingest/rules/' + RULE_ID, 'PUT', { name: RULE_NAME, description: RULE_DESCRIPTION,
    transform_mode: 'code', transform_config: { code: CODE },
    expected_base: { definition_updated_at: rule.definition_updated_at } });
  rule = (await apiSend('/api/email-ingest/rules/' + RULE_ID, 'GET')).rule;
}
const acts = rule.actions || [];
if ((J(rule.transform_config) || {}).code !== CODE || rule.name !== RULE_NAME || Number(rule.active) !== 1) fail('rule ' + RULE_ID + ' did not land', rule);
if (acts.length !== 1 || !isWfAction(acts[0]) || Number(acts[0].active) !== 1) fail('rule ' + RULE_ID + ' actions are not the workflow alone', acts);
console.log('GO — cut over: docs@ mail → workflow ' + wfId + ' (notices and pick-the-case emails to SB); the digest action is gone. ' +
  'Next: tell SB; the next docs@ email should reach her as one notice.');
})();
