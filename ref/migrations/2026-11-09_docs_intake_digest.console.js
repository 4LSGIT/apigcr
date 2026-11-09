// ref/migrations/2026-11-09_docs_intake_digest.console.js
// Design: ref/EMAIL_ATTACHMENTS_DESIGN.md §8 (S2d, the burst digest). Runs AFTER
// ref/migrations/2026-11-09_mail_attachment_notices.sql and the backend deploy.
//
// docs@ intake — ONE NOTICE PER BURST. Paste into the main YisraCase tab's
// DevTools console (apiSend). Workflow "docs@ intake" v2 (10 steps, a notice
// per email) → v3 (14 steps):
//   2     files the attachments at once, as before, and queues the notice
//         (digest_key 'docs@')
//   3–6   email_attachments_digest: while the sender is still sending, wait and
//         ask again; when the burst ends (5 min quiet, or 30 min after its first
//         email) ONE execution sends the burst's notice, the others end
//   7–14  as v2, on the burst: one pick-the-case email whose answer moves every
//         unsorted file of the burst
// Preflight: a test-step of email_attachments_digest on a message never queued
// must answer NOT_QUEUED — the backend has the function AND the table exists.
// Asserts the published v2 exactly (or a draft that is already v3), writes the
// draft (PUT steps 1–10, append 11–14), verifies it equals v3, publishes,
// re-reads. Re-runnable: a published v3 is reported and left alone.
// Executions already running on v2 (a pick-the-case still open) finish on v2.
(async () => {
const WF_NAME = 'docs@ intake';
const V2 = /* JSON:V2_STEPS */[
  {"label": "Who gets the notices", "type": "internal_function", "config": {"function_name": "noop", "params": {}, "set_vars": {"notify_email": "shoshana@metrodetroitbankruptcylaw.com", "notify_user_id": 5}}},
  {"label": "File the attachments", "type": "internal_function", "config": {"function_name": "email_attachments_file", "params": {"mail_message_id": "{{mail_message_id}}", "source": "{{source}}", "message_id": "{{message_id}}", "target": "auto", "notice_subject_prefix": "New email to Docs@4LSG.com — ", "notice_title": "docs@4lsg.com", "output_var": "filing"}, "set_vars": {"needs_decision": "{{this.output.needs_decision}}"}}, "error_policy": {"strategy": "retry_then_abort", "max_retries": 2, "backoff_seconds": 20}},
  {"label": "Does someone need to pick the case?", "type": "internal_function", "config": {"function_name": "evaluate_condition", "params": {"variable": "needs_decision", "operator": "==", "value": "true", "then": 6, "else": 4}}},
  {"label": "Send the notice", "type": "internal_function", "config": {"function_name": "send_email", "params": {"from": "automations@4lsg.com", "to": "{{notify_email}}", "subject": "{{filing.notice_subject}}", "html": "{{filing.notice_html}}", "text": "{{filing.notice_text}}"}}, "error_policy": {"strategy": "retry_then_abort", "max_retries": 2, "backoff_seconds": 30}},
  {"label": "Done", "type": "internal_function", "config": {"function_name": "set_next", "params": {"value": "end"}}},
  {"label": "Ask which case (notice with one button per case)", "type": "internal_function", "config": {"function_name": "request_decision", "params": {"question": "Which case do the files emailed by {{filing.from.email}} belong to?", "options": "{{filing.decision_options}}", "result_var": "chosen_case", "timeout": "7d", "timeout_value": "unsorted", "nextStep": 7, "recipient_kind": "user", "recipient_id": "{{notify_user_id}}", "send_email": true, "email_from": "automations@4lsg.com", "email_subject": "{{filing.notice_subject}}", "email_html": "{{filing.notice_html_decision}}", "create_task": false}}, "error_policy": {"strategy": "retry_then_abort", "max_retries": 1, "backoff_seconds": 30}},
  {"label": "A case was picked?", "type": "internal_function", "config": {"function_name": "evaluate_condition", "params": {"variable": "chosen_case", "operator": "!=", "value": "unsorted", "then": 8}}},
  {"label": "Move the files to that case", "type": "internal_function", "config": {"function_name": "email_attachments_refile", "params": {"mail_message_id": "{{filing.mail_message_id}}", "case_id": "{{chosen_case}}", "output_var": "refiled"}, "set_vars": {"refile_failed": "{{this.output.failed.length}}"}}, "error_policy": {"strategy": "retry_then_abort", "max_retries": 1, "backoff_seconds": 30}},
  {"label": "Anything left behind?", "type": "internal_function", "config": {"function_name": "evaluate_condition", "params": {"variable": "refile_failed", "operator": ">", "value": 0, "then": 10}}},
  {"label": "Say what did not move", "type": "internal_function", "config": {"function_name": "send_email", "params": {"from": "automations@4lsg.com", "to": "{{notify_email}}", "subject": "NOT MOVED — {{filing.notice_subject}}", "text": "{{refile_failed}} of the files emailed by {{filing.from.email}} could not be moved to case {{chosen_case}}. They are still in the unsorted folder:\n{{filing.folder_path}}\n{{filing.folder_link}}\n\nWhatever did move is in:\n{{refiled.folder_path}}\n{{refiled.folder_link}}\n\nIf this keeps happening, tell IT (workflow execution {{env.executionId}}, mail message {{filing.mail_message_id}})."}}, "error_policy": {"strategy": "retry_then_abort", "max_retries": 2, "backoff_seconds": 30}}
]/* /JSON:V2_STEPS */;
const V3 = /* JSON:V3_STEPS */[
  {"label": "Who gets the notices", "type": "internal_function", "config": {"function_name": "noop", "params": {}, "set_vars": {"notify_email": "shoshana@metrodetroitbankruptcylaw.com", "notify_user_id": 5}}},
  {"label": "File the attachments", "type": "internal_function", "config": {"function_name": "email_attachments_file", "params": {"mail_message_id": "{{mail_message_id}}", "source": "{{source}}", "message_id": "{{message_id}}", "target": "auto", "notice_subject_prefix": "New email to Docs@4LSG.com — ", "notice_title": "docs@4lsg.com", "output_var": "filing", "digest_key": "docs@"}}, "error_policy": {"strategy": "retry_then_abort", "max_retries": 2, "backoff_seconds": 20}},
  {"label": "Has the sender finished? (one notice per burst)", "type": "internal_function", "config": {"function_name": "email_attachments_digest", "params": {"mail_message_id": "{{filing.mail_message_id}}", "digest_key": "docs@", "quiet": "5m", "cap": "30m", "output_var": "digest"}, "set_vars": {"digest_action": "{{this.output.action}}", "needs_decision": "{{this.output.needs_decision}}"}}, "error_policy": {"strategy": "retry_then_abort", "max_retries": 2, "backoff_seconds": 20}},
  {"label": "Still sending?", "type": "internal_function", "config": {"function_name": "evaluate_condition", "params": {"variable": "digest_action", "operator": "==", "value": "wait", "then": 5, "else": 6}}},
  {"label": "Wait for the burst to end", "type": "internal_function", "config": {"function_name": "wait_for", "params": {"duration": "{{digest.wait}}", "nextStep": 3}}},
  {"label": "Is this email's notice ours to send?", "type": "internal_function", "config": {"function_name": "evaluate_condition", "params": {"variable": "digest_action", "operator": "==", "value": "send", "then": 7}}},
  {"label": "Does someone need to pick the case?", "type": "internal_function", "config": {"function_name": "evaluate_condition", "params": {"variable": "needs_decision", "operator": "==", "value": "true", "then": 10, "else": 8}}},
  {"label": "Send the notice", "type": "internal_function", "config": {"function_name": "send_email", "params": {"from": "automations@4lsg.com", "to": "{{notify_email}}", "subject": "{{digest.notice_subject}}", "html": "{{digest.notice_html}}", "text": "{{digest.notice_text}}"}}, "error_policy": {"strategy": "retry_then_abort", "max_retries": 2, "backoff_seconds": 30}},
  {"label": "Done", "type": "internal_function", "config": {"function_name": "set_next", "params": {"value": "end"}}},
  {"label": "Ask which case (notice with one button per case)", "type": "internal_function", "config": {"function_name": "request_decision", "params": {"question": "Which case do the files emailed by {{digest.from.email}} belong to?", "options": "{{digest.decision_options}}", "result_var": "chosen_case", "timeout": "7d", "timeout_value": "unsorted", "nextStep": 11, "recipient_kind": "user", "recipient_id": "{{notify_user_id}}", "send_email": true, "email_from": "automations@4lsg.com", "email_subject": "{{digest.notice_subject}}", "email_html": "{{digest.notice_html_decision}}", "create_task": false}}, "error_policy": {"strategy": "retry_then_abort", "max_retries": 1, "backoff_seconds": 30}},
  {"label": "A case was picked?", "type": "internal_function", "config": {"function_name": "evaluate_condition", "params": {"variable": "chosen_case", "operator": "!=", "value": "unsorted", "then": 12}}},
  {"label": "Move the files to that case", "type": "internal_function", "config": {"function_name": "email_attachments_refile", "params": {"digest_key": "docs@", "digest_of": "{{digest.digest_of}}", "case_id": "{{chosen_case}}", "output_var": "refiled"}, "set_vars": {"refile_failed": "{{this.output.failed.length}}"}}, "error_policy": {"strategy": "retry_then_abort", "max_retries": 1, "backoff_seconds": 30}},
  {"label": "Anything left behind?", "type": "internal_function", "config": {"function_name": "evaluate_condition", "params": {"variable": "refile_failed", "operator": ">", "value": 0, "then": 14}}},
  {"label": "Say what did not move", "type": "internal_function", "config": {"function_name": "send_email", "params": {"from": "automations@4lsg.com", "to": "{{notify_email}}", "subject": "NOT MOVED — {{digest.notice_subject}}", "text": "{{refile_failed}} of the files emailed by {{digest.from.email}} could not be moved to case {{chosen_case}}. They are still in the unsorted folder:\n{{digest.unsorted_folder_path}}\n{{digest.unsorted_folder_link}}\n\nWhatever did move is in:\n{{refiled.folder_path}}\n{{refiled.folder_link}}\n\nIf this keeps happening, tell IT (workflow execution {{env.executionId}}, notice {{digest.digest_of}})."}}, "error_policy": {"strategy": "retry_then_abort", "max_retries": 2, "backoff_seconds": 30}}
]/* /JSON:V3_STEPS */;

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x))
  ? Object.keys(x).sort().reduce((o, key) => (o[key] = x[key], o), {}) : x);
const same = (a, b) => canon(a) === canon(b);
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const fail = (m, extra) => { console.error('NO-GO —', m, extra ?? ''); throw new Error(m); };
const view = (rows) => (rows || []).map((s) => ({ label: s.label ?? null, type: s.type, config: J(s.config), error_policy: J(s.error_policy) ?? null }));
const want = (defs) => defs.map((s) => ({ label: s.label, type: s.type, config: s.config, error_policy: s.error_policy ?? null }));

// ── the workflow ──
const named = ((await apiSend('/workflows', 'GET', { search: WF_NAME, limit: 100 })).workflows || []).filter((w) => w.name === WF_NAME);
if (named.length !== 1) fail('expected exactly one workflow named ' + JSON.stringify(WF_NAME) + ', found ' + named.length);
const wfId = Number(named[0].id);
const readWf = async () => apiSend('/workflows/' + wfId, 'GET');
let wf = await readWf();
if (!wf.has_draft && same(view(wf.steps), want(V3))) {
  console.log('GO — workflow ' + wfId + ' v' + wf.workflow.current_version + ' is already the burst digest; nothing to do.');
  return;
}
if (wf.has_draft && !same(view(wf.steps), want(V3))) {
  fail('workflow ' + wfId + ' has an unpublished draft that is not v3 — discard it (POST /workflows/' + wfId + '/discard-draft) and run again', view(wf.steps));
}

// ── preflight: the backend and the table ──
let pf;
try {
  pf = await apiSend('/workflows/test-step', 'POST', { step: { type: 'internal_function',
    config: { function_name: 'email_attachments_digest', params: { mail_message_id: 1, digest_key: 'preflight' } } }, variables: {} });
} catch (e) { pf = { success: false, error: e && e.message }; }
if (!/is not queued under digest "preflight"/.test(String((pf && (pf.error || pf.message)) || ''))) {
  fail('preflight: deploy the backend and run ref/migrations/2026-11-09_mail_attachment_notices.sql first', pf);
}

// ── the draft ──
if (!wf.has_draft) {
  if (!same(view(wf.steps), want(V2))) fail('workflow ' + wfId + ' is not the published v2 this script expects', view(wf.steps));
  let eb = { draft_version: null, step_count: V2.length };
  const next = async () => { wf = await readWf(); eb = { draft_version: Number(wf.workflow.draft_version), step_count: (wf.steps || []).length }; };
  for (let i = 0; i < V2.length; i++) {
    const s = V3[i];
    await apiSend('/workflows/' + wfId + '/steps/' + (i + 1), 'PUT',
      { type: s.type, label: s.label, config: s.config, error_policy: s.error_policy ?? null, expected_base: eb });
    await next();
  }
  for (let i = V2.length; i < V3.length; i++) {
    const s = V3[i];
    await apiSend('/workflows/' + wfId + '/steps', 'POST',
      { type: s.type, label: s.label, config: s.config, error_policy: s.error_policy ?? null, expected_base: eb });
    await next();
  }
}
if (!wf.has_draft || !same(view(wf.steps), want(V3))) fail('the draft is not v3 — discard it and look', view(wf.steps));

// ── publish ──
const draft = Number(wf.workflow.draft_version);
await apiSend('/workflows/' + wfId + '/publish', 'POST', { expected_base: { draft_version: draft, step_count: V3.length } });
wf = await readWf();
if (wf.has_draft || Number(wf.workflow.current_version) !== draft || !same(view(wf.steps), want(V3))) fail('publish did not land', wf.workflow);
console.log('GO — workflow ' + wfId + ' v' + draft + ': docs@ notices now go out once per burst (5 min quiet / 30 min cap). ' +
  'Executions already running stay on their version. Next: the next docs@ email\'s notice arrives ~5 minutes after it.');
})();
