/*
 * ref/migrations/2026-10-14_wf50_text_on_cancel_failure.console.js
 *
 * wf50 "Calendly: appointment canceled" v3 → v4 — when the YisraCase cancel
 * FAILS, still text Stuart. Paste into the DevTools console of a logged-in
 * app.4lsg.com tab (the SHELL, where `apiSend` is defined).
 *
 * WHY: v3 (2026-10-13_wf50_end_after_cancel.console.js) ends the run right
 * after step 6 "Cancel the appointment", because cancelAppt now texts the
 * provider itself. But step 6 has no error_policy, and the engine default is
 * `ignore` — a failed webhook (non-2xx: already Canceled, 500, timeout) just
 * falls through to step 7. In v2 that was the SMS, so Stuart heard about the
 * Calendly cancel even when YisraCase failed; in v3 it is `set_next end`, and
 * nobody hears anything while the appointment stays Scheduled. Found tracing
 * the deploy, 2026-10-14.
 *
 * CHANGE (v3 → v4), no renumbering:
 *   6 Cancel the appointment   + set_vars { cancelStatus: "{{this.status}}" }
 *                                (static set_vars resolve on SUCCESS only, and
 *                                for a webhook step `this` is the response body:
 *                                /api/appts/cancel answers status:"success")
 *   7 set_next end  →  evaluate_condition cancelStatus != "success"
 *                                then 8 (text Stuart) / else null (end)
 *   8 SMS Stuart               unchanged; now reached on no-match OR failure
 * Base and draft are both asserted; a draft that fails its check is discarded
 * before anything publishes. Validated against lib/versionDiff
 * validateWorkflowDraft: no errors/warnings.
 *
 * On the failure path Stuart gets step 4's text ("Calendly cancellation: X
 * canceled …"), same as v2 did; the failed step 6 shows on the execution.
 *
 * ORDER: any time — independent of the backend deploy.
 * ROLLBACK: republish v3 from the workflow editor's version history.
 * SUCCESS: one console line starting "GO — wf50 v3 → v4 published".
 */
await (async () => {
  const WF = 50;
  const cfgOf = (s) => (typeof s.config === 'string' ? JSON.parse(s.config) : s.config);
  const fail = (msg) => { console.error('NO-GO — ' + msg); throw new Error(msg); };
  const LABELS_V3 = ['Normalize cancel payload', 'Is this a cancellation?', 'Find the appointment',
                     'Build cancel body + SMS', 'Appointment found?', 'Cancel the appointment',
                     'End (cancelAppt texted the provider)', 'SMS Stuart'];
  const STEP7_LABEL = 'Cancel failed? → text Stuart';
  const STEP7_PARAMS = { variable: 'cancelStatus', operator: '!=', value: 'success', then: 8, else: null };

  // ── 1. assert the base we expect (published v3, no draft) ──
  const base = await apiSend(`/workflows/${WF}`);
  if (base.has_draft) fail(`wf${WF} already has an unpublished draft (v${base.workflow.draft_version}) — inspect/discard it first`);
  if (base.workflow.current_version !== 3) fail(`expected published v3, found v${base.workflow.current_version}`);
  const labels = base.steps.map((s) => s.label);
  if (JSON.stringify(labels) !== JSON.stringify(LABELS_V3)) fail('base step labels differ: ' + JSON.stringify(labels));
  const s5 = cfgOf(base.steps[4]), s6 = cfgOf(base.steps[5]), s7 = cfgOf(base.steps[6]), s8 = cfgOf(base.steps[7]);
  if (!(s5.function_name === 'evaluate_condition' && Number(s5.params.then) === 6 && Number(s5.params.else) === 8))
    fail('step 5 is not "hasAppt → then 6 else 8": ' + JSON.stringify(s5.params));
  if (!(base.steps[5].type === 'webhook' && /\/api\/appts\/cancel$/.test(s6.url) && s6.body === '{{cancelBody}}' && !s6.set_vars))
    fail('step 6 is not the plain cancel webhook: ' + JSON.stringify(s6));
  if (!(s7.function_name === 'set_next' && s7.params.value === 'end')) fail('step 7 is not set_next end: ' + JSON.stringify(s7));
  if (s8.function_name !== 'send_sms') fail('step 8 is not send_sms');
  const fromVersion = base.workflow.current_version;

  // ── 2. edit the draft (PUT = full replace of type/config/error_policy) ──
  await apiSend(`/workflows/${WF}/steps/6`, 'PUT', {
    type: 'webhook',
    config: { ...s6, set_vars: { cancelStatus: '{{this.status}}' } },
    error_policy: base.steps[5].error_policy ?? null,
  });
  await apiSend(`/workflows/${WF}/steps/7`, 'PUT', {
    type: 'internal_function',
    label: STEP7_LABEL,
    note: 'cancelStatus is set by step 6 only when /api/appts/cancel succeeds. Success → end (cancelAppt texted the provider). Failure → step 8 so Stuart still hears about the Calendly cancel.',
    config: { function_name: 'evaluate_condition', params: STEP7_PARAMS },
    error_policy: null,
  });

  // ── 3. assert the draft before publishing ──
  const d = await apiSend(`/workflows/${WF}`);
  const d5 = cfgOf(d.steps[4]), d6 = cfgOf(d.steps[5]), d7 = cfgOf(d.steps[6]), d8 = cfgOf(d.steps[7]);
  const wantLabels = [...LABELS_V3.slice(0, 6), STEP7_LABEL, 'SMS Stuart'];
  const problems = [];
  if (!d.has_draft) problems.push('no draft after edits');
  if (JSON.stringify(d.steps.map((s) => s.label)) !== JSON.stringify(wantLabels)) problems.push('draft labels: ' + JSON.stringify(d.steps.map((s) => s.label)));
  if (!(Number(d5.params.then) === 6 && Number(d5.params.else) === 8)) problems.push('step 5 moved: ' + JSON.stringify(d5.params));
  if (!(d.steps[5].type === 'webhook' && d6.url === s6.url && d6.body === '{{cancelBody}}' && d6.method === s6.method
        && Number(d6.credential_id) === Number(s6.credential_id) && d6.set_vars?.cancelStatus === '{{this.status}}'))
    problems.push('step 6 config: ' + JSON.stringify(d6));
  if (!(d7.function_name === 'evaluate_condition' && JSON.stringify(d7.params) === JSON.stringify(STEP7_PARAMS)))
    problems.push('step 7 config: ' + JSON.stringify(d7));
  if (JSON.stringify(d8) !== JSON.stringify(s8)) problems.push('step 8 changed: ' + JSON.stringify(d8));
  if (problems.length) {
    await apiSend(`/workflows/${WF}/discard-draft`, 'POST', {});
    fail('draft check failed, draft discarded: ' + problems.join(' | '));
  }

  // ── 4. publish and confirm ──
  await apiSend(`/workflows/${WF}/publish`, 'POST', {});
  const after = await apiSend(`/workflows/${WF}`);
  if (after.has_draft || after.steps.length !== 8 || !(after.workflow.current_version > fromVersion))
    fail('publish did not land as expected: ' + JSON.stringify({ has_draft: after.has_draft, steps: after.steps.length, v: after.workflow.current_version }));
  console.log(`GO — wf${WF} v${fromVersion} → v${after.workflow.current_version} published (failed cancel now texts Stuart).`);
})();
