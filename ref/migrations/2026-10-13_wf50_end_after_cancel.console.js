/*
 * ref/migrations/2026-10-13_wf50_end_after_cancel.console.js
 *
 * wf50 "Calendly: appointment canceled" — stop the hardcoded SMS to Stuart
 * on the found-appointment path. Paste into the DevTools console of a
 * logged-in app.4lsg.com tab (the SHELL, where `apiSend` is defined).
 *
 * WHY: apptService.cancelAppt now texts the appointment's provider
 * (appt_with) whenever no user did the cancel (notifyProviderOfUnattendedCancel,
 * Fred's ruling 2026-10-13, option a). wf50 posts /api/appts/cancel on the
 * internal key — no user — so the provider is already told; wf50's own step 7
 * SMS to 2485592400 would double it. The "no matching YisraCase appointment"
 * branch keeps its SMS (there is no appt_with to route by).
 *
 * CHANGE (v2 → v3): insert `set_next end` at step 7. The add-step route's
 * branch-target remap moves step 5's else (no appt) from 7 to the SMS, now 8.
 *     5 Appointment found?  then 6 / else 8
 *     6 Cancel the appointment        (cancelAppt texts the provider)
 *     7 End (cancelAppt texted the provider)
 *     8 SMS Stuart                    (no-match branch only)
 * Base and draft are both asserted; a draft that fails its check is discarded
 * before anything publishes. Validated against lib/versionDiff
 * validateWorkflowDraft: no errors/warnings.
 *
 * DEPLOY ORDER: backend first (the cancelAppt provider notice), THEN this.
 * Between the two, a Calendly cancel texts Stuart twice — harmless. The other
 * order leaves a window where it texts nobody.
 *
 * ROLLBACK: republish v2 from the workflow editor's version history.
 *
 * SUCCESS: one console line starting "GO — wf50 v2 → v3 published".
 */
await (async () => {
  const WF = 50;
  const cfgOf = (s) => (typeof s.config === 'string' ? JSON.parse(s.config) : s.config);
  const fail = (msg) => { console.error('NO-GO — ' + msg); throw new Error(msg); };

  // ── 1. assert the base we expect (published v2, no draft) ──
  const base = await apiSend(`/workflows/${WF}`);
  if (base.has_draft) fail(`wf${WF} already has an unpublished draft (v${base.workflow.draft_version}) — inspect/discard it first`);
  const baseLabels = base.steps.map((s) => s.label);
  const wantBase = ['Normalize cancel payload', 'Is this a cancellation?', 'Find the appointment',
                    'Build cancel body + SMS', 'Appointment found?', 'Cancel the appointment', 'SMS Stuart'];
  if (JSON.stringify(baseLabels) !== JSON.stringify(wantBase)) fail('base step labels differ: ' + JSON.stringify(baseLabels));
  const b5 = cfgOf(base.steps[4]);
  if (b5.function_name !== 'evaluate_condition' || Number(b5.params.then) !== 6 || Number(b5.params.else) !== 7)
    fail('step 5 is not "hasAppt → then 6 else 7": ' + JSON.stringify(b5));
  if (cfgOf(base.steps[6]).function_name !== 'send_sms') fail('step 7 is not send_sms');
  const fromVersion = base.workflow.current_version;

  // ── 2. insert the end step at 7 (route remaps step 5's else 7 → 8) ──
  await apiSend(`/workflows/${WF}/steps`, 'POST', {
    stepNumber: 7,
    type: 'internal_function',
    label: 'End (cancelAppt texted the provider)',
    note: 'Appointment found and canceled: apptService.cancelAppt texts appt_with on a no-user cancel, so no SMS here. Step 8 only runs when no YisraCase appointment matched.',
    config: { function_name: 'set_next', params: { value: 'end' } },
  });

  // ── 3. assert the draft before publishing ──
  const d = await apiSend(`/workflows/${WF}`);
  const dLabels = d.steps.map((s) => s.label);
  const wantDraft = [...wantBase.slice(0, 6), 'End (cancelAppt texted the provider)', 'SMS Stuart'];
  const d5 = cfgOf(d.steps[4]), d7 = cfgOf(d.steps[6]), d8 = cfgOf(d.steps[7]);
  const problems = [];
  if (!d.has_draft) problems.push('no draft after insert');
  if (JSON.stringify(dLabels) !== JSON.stringify(wantDraft)) problems.push('draft labels: ' + JSON.stringify(dLabels));
  if (!(d5.function_name === 'evaluate_condition' && Number(d5.params.then) === 6 && Number(d5.params.else) === 8))
    problems.push('step 5 should be then 6 / else 8: ' + JSON.stringify(d5.params));
  if (!(d7.function_name === 'set_next' && d7.params.value === 'end')) problems.push('step 7 should be set_next end: ' + JSON.stringify(d7));
  if (d8.function_name !== 'send_sms') problems.push('step 8 should be send_sms');
  if (problems.length) {
    await apiSend(`/workflows/${WF}/discard-draft`, 'POST', {});
    fail('draft check failed, draft discarded: ' + problems.join(' | '));
  }

  // ── 4. publish and confirm ──
  await apiSend(`/workflows/${WF}/publish`, 'POST', {});
  const after = await apiSend(`/workflows/${WF}`);
  if (after.has_draft || after.steps.length !== 8 || !(after.workflow.current_version > fromVersion))
    fail('publish did not land as expected: ' + JSON.stringify({ has_draft: after.has_draft, steps: after.steps.length, v: after.workflow.current_version }));
  console.log(`GO — wf${WF} v${fromVersion} → v${after.workflow.current_version} published (8 steps; found-appt path ends after cancel).`);
})();
