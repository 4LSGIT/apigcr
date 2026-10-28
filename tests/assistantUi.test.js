'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/assistant.html'), 'utf8');
const route = fs.readFileSync(path.join(ROOT, 'routes/api.assistant.js'), 'utf8');
const shell = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

function fnSrc(src, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!match) throw new Error(`function ${name} not found`);
  const start = match.index;
  // Skip the parameter list by paren depth: a destructured default
  // ({ required = false } = {}) holds braces of its own.
  let parens = 0;
  let body = match.index + match[0].length - 1;
  for (; body < src.length; body++) {
    if (src[body] === '(') parens++;
    else if (src[body] === ')' && --parens === 0) break;
  }
  let depth = 0;
  for (let i = src.indexOf('{', body); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`function ${name} unbalanced`);
}

function fnSrcAuto(src, name) {
  const body = fnSrc(src, name);
  return new RegExp(`async\\s+function\\s+${name}\\s*\\(`).test(src) ? `async ${body}` : body;
}

// `const NAME = …;` — the terminating semicolon at bracket depth 0. Used for
// the kind Sets and for ACTION_FAMILIES, the browser's action registry.
function constSrc(src, name) {
  const match = new RegExp(`const\\s+${name}\\s*=`).exec(src);
  if (!match) throw new Error(`const ${name} not found`);
  let depth = 0;
  for (let i = match.index; i < src.length; i++) {
    const c = src[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0) return src.slice(match.index, i + 1);
  }
  throw new Error(`const ${name} unterminated`);
}

// The whole action region, rebuilt from the page's own source: the four
// families' builders, the registry, and the one shared engine. Every
// behavioural test below runs the real functions out of assistant.html —
// nothing here re-implements them.
const ACTION_FNS = ['appendDraftField', 'appendDraftFieldsFromText', 'actionDraftStale', 'askCaseyAgain',
  'hydrateStaleDraft', 'appendMarkerError', 'recordActionResult',
  'taskCreateBody', 'taskUpdateBody', 'taskActionLabel', 'taskActionRequest', 'taskDraftText',
  'taskDraftConfirmation', 'taskActionResult', 'taskDraftFields',
  'eventActionLabel', 'eventTypeText', 'eventProviderText', 'eventReminderText', 'eventDraftText',
  'eventCreateBody', 'eventUpdateBody', 'eventActionRequest', 'eventActionResult',
  'apptManageLinkPattern', 'apptConfirmation', 'apptConfirmFields', 'apptConfirmLinkLabel', 'apptConfirmDisplay', 'apptConfirmLines',
  'apptConfirmMessageBlock', 'apptDraftFields', 'apptConfirmText', 'apptPrecheck',
  'apptActionLabel', 'apptChannelsText', 'apptDraftText', 'apptCreateBody', 'apptActionRequest', 'apptActionResult',
  'contactSubrecordActionLabel', 'contactAddressText', 'contactSubrecordValue', 'contactSubrecordDraftText',
  'contactSubrecordCreateBody', 'contactSubrecordActionRequest', 'contactSubrecordActionResult',
  'contactRelationLabel', 'contactRelationValue', 'contactRelationLines', 'contactRelationText', 'contactRoleAttrLines', 'contactRoleText',
  'contactRelationRequest', 'contactRoleRequest', 'contactRelationStableJson', 'contactRelationDay', 'contactRelationPrecheck',
  'contactRolePrecheck', 'contactRelationResult', 'contactRoleResult', 'contactRelationOpenTarget',
  'recordTextSpec', 'recordTextLabel', 'recordTextCount', 'recordTextShow', 'recordTextDiff', 'recordTextBefore',
  'recordTextTargetLines', 'recordTextText', 'recordTextDanger', 'recordTextRequest', 'recordTextPrecheck',
  'caseTextResult', 'contactTextResult', 'recordTextOpenTarget',
  'caseContactLabel', 'caseContactCaseLabel', 'caseContactText', 'caseContactIds', 'caseContactRequest',
  'caseContactSignature', 'caseContactPrecheck', 'caseContactResult', 'caseContactKnownOutcome',
  'jobActionLabel', 'jobScheduleText', 'jobDraftText', 'jobActionRequest', 'jobActionResult',
  'workflowDraftLabel', 'workflowSendLines', 'workflowDraftStepLine', 'workflowDraftText', 'workflowDraftRequest', 'workflowDraftResult',
  'workflowStepActionLabel', 'workflowStepWorkflowLine', 'workflowStepInsertText', 'workflowStepEditValue',
  'workflowStepEditText', 'workflowStepActionText', 'workflowStepActionRequest', 'workflowStepActionResult',
  'workflowPublishLabel', 'workflowPublishChangeLine', 'workflowPublishText', 'workflowPublishRequest', 'workflowPublishResult',
  'workflowStartLabel', 'workflowStartText', 'workflowStartRequest', 'workflowStartPrecheck', 'workflowStartResult',
  'hookCreateLabel', 'hookTargetText', 'hookCreateText', 'hookCreateRequest', 'hookCreateResult',
  'sequenceStepActionLabel', 'sequenceStepParamValue', 'sequenceStepText', 'sequenceStepActionRequest', 'sequenceStepActionResult',
  'sequencePublishLabel', 'sequencePublishChangeLine', 'sequencePublishText', 'sequencePublishRequest', 'sequencePublishResult',
  'sequenceEnrollLabel', 'sequenceEnrollStepLine', 'sequenceEnrollText', 'sequenceEnrollRequest', 'sequenceEnrollPrecheck',
  'sequenceEnrollResult', 'sequenceEnrollFirstText', 'sequenceEnrollKnownOutcome',
  'ingestRulePath', 'ingestRuleId', 'ingestRuleLabel', 'ingestRuleValue', 'ingestRuleHead', 'ingestRuleSideText', 'ingestRuleActionLine',
  'ingestRuleText', 'ingestRuleRequest', 'ingestRuleDispatch', 'ingestRuleResult', 'ingestRulePrecheck', 'openIngestRuleRecord',
  'openAutomationRecord',
  'sendIsSms', 'sendActionLabel', 'sendRecipientLine', 'sendOptoutText', 'sendFactLines', 'sendDraftText', 'sendDraftFields', 'sendConfirmText', 'sendActionRequest',
  'sendPrecheck', 'sendActionDispatch', 'sendActionResult', 'sendResultText', 'openSendRecord',
  'reportDraftLabel', 'reportSsnText', 'reportVizText', 'reportCardText', 'reportDraftFields', 'reportConfirmText', 'reportDraftRequest', 'reportDraftResult',
  'actionFamily', 'isActionDraft', 'actionStringReceipt', 'actionAppliedId', 'markActionApplied', 'confirmActionDraft',
  'executeActionDraft', 'applyActionResults', 'hydrateActionDraft'];

const APPT_CONFIRM_FNS = ['apptManageLinkPattern', 'apptConfirmation', 'apptConfirmFields', 'apptConfirmLinkLabel', 'apptConfirmDisplay', 'apptConfirmLines', 'apptConfirmMessageBlock'];
const apptFns = (...names) => [...APPT_CONFIRM_FNS, ...names].map((name) => fnSrc(html, name)).join(';');

function actionSandbox(deps = {}) {
  const registry = constSrc(html, 'ACTION_FAMILIES');
  expect(registry.endsWith('];')).toBe(true);
  expect(registry).toContain("id: 'task'");
  const src = [
    'const ACTION_DRAFT_TTL_MS=15*60*1000;',
    constSrc(html, 'TASK_ACTION_KINDS'), constSrc(html, 'EVENT_ACTION_KINDS'),
    constSrc(html, 'APPT_ACTION_KINDS'), constSrc(html, 'CONTACT_SUBRECORD_ACTION_KINDS'),
    constSrc(html, 'CONTACT_RELATION_ACTION_KINDS'), constSrc(html, 'CONTACT_ROLE_ACTION_KINDS'),
    constSrc(html, 'CASE_TEXT_ACTION_KINDS'), constSrc(html, 'CONTACT_TEXT_ACTION_KINDS'), constSrc(html, 'RECORD_TEXT_SPECS'),
    constSrc(html, 'RECORD_TEXT_CONTEXT'), constSrc(html, 'RECORD_TEXT_PART_MAX'), constSrc(html, 'RECORD_TEXT_WORD_MAX'),
    constSrc(html, 'CASE_CONTACT_ACTION_KINDS'), constSrc(html, 'CASE_CONTACT_TYPES'),
    constSrc(html, 'JOB_ACTION_KINDS'), constSrc(html, 'WORKFLOW_ACTION_KINDS'),
    constSrc(html, 'WORKFLOW_STEP_ACTION_KINDS'), constSrc(html, 'WORKFLOW_PUBLISH_ACTION_KINDS'), constSrc(html, 'WORKFLOW_START_ACTION_KINDS'),
    constSrc(html, 'HOOK_ACTION_KINDS'), constSrc(html, 'SEQUENCE_STEP_ACTION_KINDS'), constSrc(html, 'SEQUENCE_PUBLISH_ACTION_KINDS'), constSrc(html, 'SEQUENCE_ENROLL_ACTION_KINDS'), constSrc(html, 'SEND_ACTION_KINDS'),
    constSrc(html, 'REPORT_ACTION_KINDS'), constSrc(html, 'INGEST_RULE_ACTION_KINDS'), constSrc(html, 'INGEST_RULE_PATHS'),
    constSrc(html, 'INGEST_RULE_UPDATE_FIELDS'), constSrc(html, 'INGEST_ACTION_UPDATE_FIELDS'),
    constSrc(html, 'SEQUENCE_STEP_FUNCTIONS'), constSrc(html, 'SEQUENCE_STEP_ERROR_POLICY'),
    ...ACTION_FNS.map((name) => fnSrcAuto(html, name)),
    registry,
    'return { executeActionDraft, applyActionResults, actionFamily, isActionDraft, hydrateActionDraft };',
  ].join('\n');
  const supplied = { P: {}, api: jest.fn(), render: jest.fn(), history: [], saveAssistantMessage: jest.fn(), openEntity: jest.fn(), input: { value: '', focus: jest.fn() }, document: undefined, navigator: undefined, ...deps };
  const canonicalApi = supplied.api;
  const ledgerApi = deps.ledgerApi || (async (path) => path.endsWith('/claim')
    ? { outcome: 'in_flight', claimed: true, claim_token: 'receipt-test-token' } : { outcome: 'applied' });
  supplied.api = (path, ...args) => path.startsWith('/api/assistant/actions/')
    ? ledgerApi(path, ...args) : canonicalApi(path, ...args);
  delete supplied.ledgerApi;
  const names = Object.keys(supplied);
  return new Function(...names, src)(...names.map((name) => supplied[name])); // eslint-disable-line no-new-func
}

describe('Ask Casey UI wiring', () => {
  test('its inline script parses as JavaScript', () => {
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
      .map((m) => m[1]).filter((s) => s.trim());
    expect(scripts.length).toBe(1);
    expect(() => new Function(scripts[0])).not.toThrow(); // eslint-disable-line no-new-func
  });

  test('renders model/data strings only through the HTML escaper', () => {
    expect(html).toContain('${esc(m.text)}');
    expect(html).toContain('${esc(s.label)}');
    expect(html).toContain('${esc(action.label)}');
    expect(html).toContain('${esc(JSON.stringify(s.row, null, 2))}');
  });

  test('renders reviewed task lifecycle actions through the existing tasks API', () => {
    expect(html).toContain(": draft.executing ? 'Applying…' : draft.reviewing ? 'Reviewing…' : 'Proposal — not applied'");
    expect(html).toContain("'task.update.v1'");
    expect(html).toContain("'task.complete.v1'");
    expect(html).toContain("'task.cancel.v1'");
    expect(html).toContain("'task.reopen.v1'");
    expect(html).toContain("'task.transfer.v1'");
    expect(html).toContain("copy.textContent = 'Copy details'");
    expect(html).toContain("discard.textContent = 'Discard'");
    expect(html).toContain('detail.textContent = String(value)');
    expect(html).toContain("'Before applying this action:'");
    expect(html).toContain("'Confirm only if every value is correct. Cancel returns to this unchanged draft.'");
    expect(html).toContain('Normal task notifications and reminders may run');
    expect(html).toContain('navigator.clipboard.writeText(family.text(draft))');
    expect(html).toContain('delete message.action_draft; render()');
    expect(html).toContain('...(r.action_draft ? { action_draft: { ...r.action_draft, received_at: Date.now() } } : {})');
    expect(html).toContain('...(message.action_draft ? { action_draft: message.action_draft } : {})');
    expect(html).toContain("return { path: '/api/tasks', method: 'POST', body: taskCreateBody(draft), idempotent: true }");
    expect(html).toContain("P.Swal.fire({");
    expect(html).toContain('if (!await confirmActionDraft(family, draft)) return');
    expect(html).not.toContain('window.confirm(');
    // Recording endpoints are allowed; business writes remain canonical.
    expect(route).not.toMatch(/(?:require\s*\([^)]*|\b)(?:taskService|eventService|apptService|contactPhoneService|contactEmailService|contactAddressService)\b/);
    const writers = [
      'createTask', 'updateTask', 'completeTask', 'deleteTask', 'reopenTask', 'transferTask',
      'scheduleDueReminder', 'cancelDueReminder', 'scheduleStartReminder', 'cancelStartReminder', 'logTaskEvent',
      'createEvent', 'updateEvent', 'completeEvent', 'cancelEvent', 'supersedeEvent', '_applySingleton',
      'spawnReminderTask', 'cancelReminderTasks', 'sendEventDigest',
      'createAppt', 'markAttended', 'markNoShow', 'cancelAppt', 'rescheduleAppt', 'rescheduleLater',
      'cancelApptAutomation', 'insertApptLog', 'applyApptLinkPatch', 'applyApptTypePatch',
      'notifyStaffOfClientAction', 'notifyProviderOfUnattendedCancel',
      ...['Phone', 'Email', 'Address'].flatMap(f => ['createContact', 'updateContact', 'deleteContact', 'setPrimaryContact'].map(v => `${v}${f}`)),
    ];
    expect(route).not.toMatch(new RegExp(`\\b(?:${writers.join('|')})\\s*\\(`));
  });

  test('maps each task action to one fixed canonical route and closed request body', () => {
    const request = new Function(`${fnSrc(html, 'taskCreateBody')};${fnSrc(html, 'taskUpdateBody')};${fnSrc(html, 'taskActionRequest')};return taskActionRequest;`)(); // eslint-disable-line no-new-func
    const task = { task_id: 44, title: 'Old', status: 'Pending' };
    expect(request({ kind: 'task.update.v1', task, changes: { title: 'New', due_date: null, link: null, ignored: 'x' } })).toEqual({
      path: '/api/tasks/44', method: 'PATCH', body: { task_title: 'New', task_due: null, task_link: '', task_link_type: null, task_link_id: null },
    });
    expect(request({ kind: 'task.complete.v1', task, note: 'Finished' })).toEqual({ path: '/api/tasks/44/complete', method: 'PATCH', body: { note: 'Finished' } });
    expect(request({ kind: 'task.cancel.v1', task, note: '' })).toEqual({ path: '/api/tasks/44/delete', method: 'PATCH', body: { note: '' } });
    expect(request({ kind: 'task.reopen.v1', task })).toEqual({ path: '/api/tasks/44/reopen', method: 'PATCH', body: {} });
    expect(request({ kind: 'task.transfer.v1', task, assignee: { user_id: 7, label: 'Fred' } })).toEqual({ path: '/api/tasks/44/transfer', method: 'PATCH', body: { to: 7 } });
  });

  test('maps only the validated draft fields into the normal task insert, including links', () => {
    const bodyFn = new Function(`${fnSrc(html, 'taskCreateBody')}; return taskCreateBody;`)(); // eslint-disable-line no-new-func
    expect(bodyFn({
      kind: 'task.create.v1', title: 'Review Ask Casey', description: 'Try it.',
      assignee: { user_id: 1, label: 'Stuart' }, start_date: '2026-10-20', due_date: '2026-10-27',
      notify_assigner_on_completion: true, link: { type: 'contact', id: '1001', label: 'Fred' },
      evidence: [{ query_id: 'q1', row_number: 1 }], ignored: 'never send me',
    })).toEqual({
      to: 1, title: 'Review Ask Casey', desc: 'Try it.', start: '2026-10-20', due: '2026-10-27',
      notify: true, link_type: 'contact', link_id: '1001', source: 'Casey',
    });
  });

  test('cancellation writes nothing; confirmation creates once and turns the control into Open task', async () => {
    const api = jest.fn().mockResolvedValue({ status: 'success', task_id: 77 });
    const render = jest.fn();
    const reloadTasks = jest.fn();
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: false }) }, showTask: jest.fn(), tasksBadgeRefresh: jest.fn(), document: { getElementById: jest.fn(() => ({ contentWindow: { reloadTasks } })) } };
    const history = [];
    const saveAssistantMessage = jest.fn().mockResolvedValue();
    const make = actionSandbox({ P, api, render, history, saveAssistantMessage }).executeActionDraft;
    const message = { action_draft: {
      draft_id: 'draft-123', kind: 'task.create.v1', status: 'draft', title: 'Review Ask Casey', description: 'Try it.',
      assignee: { user_id: 1, label: 'Stuart' }, link: { type: 'contact', id: '1001', label: 'Fred' },
      start_date: '2026-10-20', due_date: '2026-10-27', notify_assigner_on_completion: false,
    } };

    await make(message);
    expect(api).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(2);
    expect(P.Swal.fire).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Create task', text: expect.stringContaining('Assigned to: Stuart'),
      showCancelButton: true, confirmButtonText: 'Create task', cancelButtonText: 'Keep proposal',
    }));

    P.Swal.fire.mockResolvedValue({ isConfirmed: true });
    await make(message);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/api/tasks', {
      to: 1, title: 'Review Ask Casey', desc: 'Try it.', start: '2026-10-20', due: '2026-10-27',
      notify: false, link_type: 'contact', link_id: '1001', source: 'Casey',
    }, 'POST', { 'Idempotency-Key': 'draft-123' });
    expect(message.action_draft).toMatchObject({ status: 'applied', result_task_id: 77, executing: false });
    expect(render).toHaveBeenCalled();
    expect(history).toEqual([expect.objectContaining({
      text: 'Create task applied to task #77.',
      action_result: { kind: 'task.create.v1', draft_id: 'draft-123', task_id: 77 },
    })]);
    expect(saveAssistantMessage).toHaveBeenCalledWith(history[0], { required: true });
    expect(P.tasksBadgeRefresh).toHaveBeenCalledTimes(1);
    expect(reloadTasks).toHaveBeenCalledTimes(1);

    await make(message);
    expect(api).toHaveBeenCalledTimes(1);
    expect(P.showTask).toHaveBeenCalledWith(77);
  });

  test('a safe code job card pins code_mode safe in the fixed request — the model cannot choose the engine', async () => {
    const api = jest.fn().mockResolvedValue({ id: 91, scheduled_time: '2026-10-23T00:00:00.000Z' });
    const render = jest.fn();
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) } };
    const history = [];
    const saveAssistantMessage = jest.fn().mockResolvedValue();
    const make = actionSandbox({ P, api, render, history, saveAssistantMessage }).executeActionDraft;
    const message = { action_draft: {
      draft_id: 'job-draft-1', kind: 'job.code_safe.create.v1', status: 'draft',
      name: 'Deadline math', description: 'Computes the 30-day deadline',
      code: 'input.a + 1;', input: { a: 1 }, schedule: { delay: '10m' }, evidence: [],
    } };

    await make(message);
    expect(P.Swal.fire).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Schedule safe code job',
      text: expect.stringContaining('isolated sandbox'),
    }));
    expect(api).toHaveBeenCalledWith('/scheduled-jobs', {
      type: 'one_time', job_type: 'custom_code', code_mode: 'safe',
      name: 'Deadline math', description: 'Computes the 30-day deadline',
      code: 'input.a + 1;', input: { a: 1 }, delay: '10m',
    }, 'POST', { 'Idempotency-Key': 'job-draft-1' });
    expect(message.action_draft).toMatchObject({ status: 'applied', result_job_id: 91, executing: false });
    expect(history).toEqual([expect.objectContaining({
      text: 'Schedule safe code job applied to scheduled job #91.',
      action_result: { kind: 'job.code_safe.create.v1', draft_id: 'job-draft-1', job_id: 91, scheduled_time: '2026-10-23T00:00:00.000Z' },
    })]);
  });

  test('a workflow draft card pins safe mode on code steps and strips side_effect annotations', async () => {
    const api = jest.fn().mockResolvedValue({ success: true, workflowId: 61, name: 'Deadline chase', stepCount: 2 });
    const render = jest.fn();
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) },
      ycAssistantNavigate: jest.fn().mockResolvedValue({ ready: true }) };
    const history = [];
    const saveAssistantMessage = jest.fn().mockResolvedValue();
    const make = actionSandbox({ P, api, render, history, saveAssistantMessage }).executeActionDraft;
    const message = { action_draft: {
      draft_id: 'wf-draft-1', kind: 'workflow.draft.v1', status: 'draft',
      name: 'Deadline chase', description: 'd',
      steps: [
        { type: 'internal_function', label: 'Find contact', side_effect: 'read',
          config: { function_name: 'lookup_contact', params: { contact_id: '{{contact_id}}' } } },
        { type: 'custom_code', side_effect: 'safe-code', config: { code: 'input.a + 1;', input: { a: 1 } },
          error_policy: { strategy: 'ignore' } },
      ],
      evidence: [],
    } };
    await make(message);
    expect(P.Swal.fire).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Create draft workflow',
      text: expect.stringContaining('UNPUBLISHED workflow (version 0)'),
    }));
    expect(api).toHaveBeenCalledWith('/workflows/bulk', {
      name: 'Deadline chase', description: 'd',
      steps: [
        { type: 'internal_function', label: 'Find contact',
          config: { function_name: 'lookup_contact', params: { contact_id: '{{contact_id}}' } } },
        { type: 'custom_code', config: { code: 'input.a + 1;', input: { a: 1 }, code_mode: 'safe' },
          error_policy: { strategy: 'ignore' } },
      ],
    }, 'POST', { 'Idempotency-Key': 'wf-draft-1' });
    expect(message.action_draft).toMatchObject({ status: 'applied', result_workflow_id: 61 });
    expect(history).toEqual([expect.objectContaining({
      text: 'Create draft workflow applied to draft workflow #61.',
    })]);
    // Applying the card takes the user RIGHT TO the draft (Fred, 2026-10-22):
    // the open handler deep-links through the shell with the applied id.
    expect(P.ycAssistantNavigate).toHaveBeenCalledWith('automations.workflow', { id: 61 });
  });

  // Ruling 15: a send step in a workflow card is disclosed — its sender (a
  // placeholder verbatim plus the server's plain line) and who it messages —
  // the card is danger-styled, and the request builders strip the
  // annotations so only the reviewed config reaches the route.
  test('workflow send steps: disclosure, danger styling, annotations stripped from the request', async () => {
    const fire = jest.fn().mockResolvedValue({ isConfirmed: true });
    const api = jest.fn().mockResolvedValue({ success: true, workflowId: 62, stepNumber: 3 });
    const sandbox = actionSandbox({ P: { Swal: { fire } }, api, saveAssistantMessage: jest.fn() });
    const sendStep = { type: 'internal_function', label: 'Mail', side_effect: 'external-send',
      sender: '{{settings.email_automations}}', sender_note: 'sender resolved when the workflow runs — the firm sender setting "email_automations", read by step 1 (get_settings).',
      recipient: '{{client_email}}',
      config: { function_name: 'send_email', params: { from: '{{settings.email_automations}}', to: '{{client_email}}', subject: 'S', text: 'T' } } };
    await sandbox.executeActionDraft({ action_draft: { draft_id: 'wf-send-1', kind: 'workflow.draft.v1', status: 'draft', name: 'Mailer', description: '', steps: [sendStep], evidence: [] } });
    const dlg = fire.mock.calls[0][0];
    expect(dlg).toMatchObject({ icon: 'warning', focusCancel: true });
    expect(dlg.text).toContain('   Sender: {{settings.email_automations}}');
    expect(dlg.text).toContain('   Sender note: sender resolved when the workflow runs');
    expect(dlg.text).toContain('   EXTERNAL SEND: this step messages {{client_email}} when the workflow runs, after a human publishes it.');
    expect(api.mock.calls[0][1].steps).toEqual([{ type: 'internal_function', label: 'Mail', config: sendStep.config }]);

    // Insert: same disclosure, same stripping.
    fire.mockClear(); api.mockClear();
    await sandbox.executeActionDraft({ action_draft: { draft_id: 'wf-send-2', kind: 'workflow.step_insert.v1', status: 'draft', received_at: Date.now(),
      workflow: { workflow_id: 62, name: 'Mailer', published: 1, active: 1, has_draft: 0 }, position: null, displaces: null,
      step: { ...sendStep, sender: '4LSG <office@4lsg.com>', sender_note: undefined }, expected_base: { draft_version: null, step_count: 2 }, evidence: [] } });
    expect(fire.mock.calls[0][0]).toMatchObject({ icon: 'warning' });
    expect(fire.mock.calls[0][0].text).toContain('   Sender: 4LSG <office@4lsg.com>');
    expect(fire.mock.calls[0][0].text).not.toContain('Sender note');
    expect(Object.keys(api.mock.calls[0][1]).sort()).toEqual(['config', 'expected_base', 'label', 'type']);

    // Edit: the top-level send disclosure renders on the edit card too.
    fire.mockClear(); api.mockClear();
    await sandbox.executeActionDraft({ action_draft: { draft_id: 'wf-send-3', kind: 'workflow.step_edit.v1', status: 'draft', received_at: Date.now(),
      workflow: { workflow_id: 62, name: 'Mailer', published: 1, active: 1, has_draft: 1 }, step_number: 3,
      target: { step_number: 3, type: 'internal_function', label: 'Mail', function_name: 'send_email' },
      changes: { label: 'Mail them' }, before: { label: 'Mail' },
      send: { side_effect: 'external-send', sender: 'it@4lsg.com (unchanged — as stored on this step)', recipient: '{{client_email}}' },
      expected_base: { draft_version: 4, step_count: 3, step_fingerprint: 'b'.repeat(64) }, evidence: [] } });
    expect(fire.mock.calls[0][0]).toMatchObject({ icon: 'warning' });
    expect(fire.mock.calls[0][0].text).toContain('EXTERNAL SEND: this step messages {{client_email}} when the workflow runs, after a human publishes it.');
    expect(api.mock.calls[0][1]).toEqual({ expected_base: { draft_version: 4, step_count: 3, step_fingerprint: 'b'.repeat(64) }, label: 'Mail them' });

    // A draft with no send step keeps the plain question styling.
    fire.mockClear();
    await sandbox.executeActionDraft({ action_draft: { draft_id: 'wf-send-4', kind: 'workflow.draft.v1', status: 'draft', name: 'Quiet', description: '',
      steps: [{ type: 'internal_function', side_effect: 'read', config: { function_name: 'lookup_contact', params: { contact_id: '1' } } }], evidence: [] } });
    expect(fire.mock.calls[0][0]).toMatchObject({ icon: 'question' });
    expect(fire.mock.calls[0][0].text).not.toContain('EXTERNAL SEND');
  });

  test('a sequence card shows a placeholder sender verbatim with its plain line', () => {
    const { actionFamily } = actionSandbox({});
    const draft_ = { kind: 'sequence.step_insert.v1', template: { sequence_template_id: 21, name: 'pre_appt', active: 1, published_version: 1, active_enrollments: 0 },
      position: null, step: { action_type: 'sms', side_effect: 'external-send', params: { from: '{{users.default_phone}}', to: 'x', message: 'm' }, timing: { type: 'immediate' } },
      timing_text: 'Immediately', timing_notes: [], sender: '{{users.default_phone}}',
      sender_note: "sender resolved per enrollment — e.g. the enrolling user's default phone", expected_base: { step_count: 3 } };
    const text = actionFamily(draft_).text(draft_);
    expect(text).toContain('Sender: {{users.default_phone}}\nSender note: sender resolved per enrollment — e.g. the enrolling user\'s default phone');
  });

  test('a hook card pins active:0, never carries a slug or URL, and deep-links to the created hook', async () => {
    const api = jest.fn().mockResolvedValue({ status: 'success', id: 12, target_ids: [30] });
    const render = jest.fn();
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) },
      ycAssistantNavigate: jest.fn().mockResolvedValue({ ready: true }) };
    const history = [];
    const saveAssistantMessage = jest.fn().mockResolvedValue();
    const make = actionSandbox({ P, api, render, history, saveAssistantMessage }).executeActionDraft;
    const message = { action_draft: {
      draft_id: 'hook-draft-1', kind: 'hook.create.v1', status: 'draft',
      name: 'Site form → intake', description: 'd', slug: 'test-cyan-tuna-44',
      param_map: { contact_id: 'query.contact_id' },
      target: { kind: 'workflow', workflow_id: 27, label: 'static site hit', published: 1 },
      evidence: [],
    } };
    await make(message);
    expect(P.Swal.fire).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Create inactive hook',
      text: expect.stringContaining('created INACTIVE'),
    }));
    // The review text shows the mapping lines and the chosen slug.
    expect(P.Swal.fire.mock.calls[0][0].text).toContain('contact_id ← query.contact_id');
    expect(P.Swal.fire.mock.calls[0][0].text).toContain('test-cyan-tuna-44');
    expect(api).toHaveBeenCalledWith('/api/hooks', {
      name: 'Site form → intake', description: 'd', active: 0, slug: 'test-cyan-tuna-44',
      targets: [{ name: '→ static site hit', target_type: 'workflow', config: { workflow_id: 27 }, active: 1,
        transform_mode: 'mapper',
        transform_config: [{ to: 'contact_id', from: 'query.contact_id' }] }],
    }, 'POST', { 'Idempotency-Key': 'hook-draft-1' });
    const sent = JSON.stringify(api.mock.calls[0][1]);
    expect(sent).not.toMatch(/"url"|api_key|auth_config/i);
    expect(message.action_draft).toMatchObject({ status: 'applied', result_hook_id: 12 });
    expect(P.ycAssistantNavigate).toHaveBeenCalledWith('automations.hook', { id: 12 });
  });

  // A16: the browser posts EXACTLY the server-normalized definition, plus the
  // builder's fixed fields — nothing from the model beyond the reviewed values.
  // (The real-engine round trip normalizer → builder → route → stored row is
  // tests/caseyReportDraft.mysql.test.js.)
  const REPORT_DRAFT = () => ({
    draft_id: 'report-draft-1', kind: 'report.draft.v1', status: 'draft', received_at: Date.now(),
    definition: { report_key: 'casey_detroit_contacts_a1b2c3', title: 'Detroit contacts', category: 'Contacts',
      description: 'Active contacts whose city is Detroit.', sql_text: "SELECT ct.contact_id, ct.contact_name AS client_name\nFROM contacts ct WHERE ct.contact_city = 'Detroit' ORDER BY ct.contact_name",
      params: [], columns_meta: [{ key: 'client_name', label: 'Client' }], caveats: ['contact_city is the legacy field.'], row_limit: 1000 },
    tables: ['contacts'], ssn: 'none', dob: false,
    preview: { columns: [{ key: 'contact_id', label: 'contact_id' }, { key: 'client_name', label: 'Client' }],
      rows: [[1, 'Pat One'], [2, 'Sam Two']], row_count: 2, truncated: false, more_columns: 0, bound_values: [] },
    evidence: [],
  });

  test('a report card posts exactly the normalized definition with the fixed fields, keyed by its draft_id', async () => {
    const api = jest.fn().mockResolvedValue({ status: 'success', report: { id: 21, report_key: 'casey_detroit_contacts_a1b2c3' } });
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) },
      ycAssistantNavigate: jest.fn().mockResolvedValue({ ready: true }) };
    const message = { action_draft: REPORT_DRAFT() };
    const { executeActionDraft, actionFamily } = actionSandbox({ P, api, history: [], saveAssistantMessage: jest.fn().mockResolvedValue() });
    const family = actionFamily(message.action_draft);
    expect([family.id, family.idField, family.appliedKey, family.danger(message.action_draft)]).toEqual(['report', 'report_id', 'result_report_id', false]);
    await executeActionDraft(message);
    const d = REPORT_DRAFT().definition;
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/api/reports', {
      report_key: d.report_key, title: d.title, category: d.category, description: d.description,
      sql_text: d.sql_text, params: d.params, columns_meta: d.columns_meta, caveats: d.caveats, row_limit: d.row_limit,
      kind: 'report', visibility: 'shared', viz: { type: 'table' }, source: 'ai',
    }, 'POST', { 'Idempotency-Key': 'report-draft-1' });
    expect(message.action_draft).toMatchObject({ status: 'applied', result_report_id: 21 });
    expect(P.ycAssistantNavigate).toHaveBeenCalledWith('reports.report', { id: 21 });
    const dialog = P.Swal.fire.mock.calls[0][0];
    expect(dialog.title).toBe('Save report');
    expect(dialog.text).toContain('Rows now: 2 (row limit 1000)');
    expect(dialog.text).toContain('contains client personal information');
    expect(dialog.text).not.toMatch(/FULL Social Security/);
  });

  test('a full-SSN report card is danger-styled and warns before anything else', () => {
    const { actionFamily } = actionSandbox({});
    const draft = { ...REPORT_DRAFT(), ssn: 'full' };
    const family = actionFamily(draft);
    expect(family.danger(draft)).toBe(true);
    expect(family.confirmText(draft)).toMatch(/^This report shows FULL Social Security \/ EIN numbers\./);
    expect(family.text({ ...REPORT_DRAFT(), ssn: 'last4' })).toContain('SSN: last four digits only');
  });

  test('the report card renders its preview and SQL as text, and model text never becomes markup', () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><div id="host"></div>');
    const { document } = dom.window;
    const { hydrateActionDraft, actionFamily } = actionSandbox({ document, navigator: dom.window.navigator });
    const d = REPORT_DRAFT();
    d.definition.title = '<img src=x onerror=alert(1)>';
    d.preview.rows = [[1, '<b>Pat</b>'], [2, null]];
    d.preview.columns.push({ key: 'ssn_last4', label: 'SSN', masked: true });
    d.preview.rows = d.preview.rows.map((r) => [...r, '(hidden in this preview)']);
    const message = { action_draft: d };
    const host = document.createElement('div');
    hydrateActionDraft(actionFamily(d), host, message, d);
    expect(host.querySelector('img')).toBe(null);
    expect(host.querySelector('b.action-draft-head, .action-draft-head b').textContent).toBe('Report');
    const cells = [...host.querySelectorAll('.action-draft-preview td')].map((td) => td.textContent);
    expect(cells).toEqual(['1', '<b>Pat</b>', '(hidden in this preview)', '2', '', '(hidden in this preview)']);
    expect([...host.querySelectorAll('.action-draft-preview th')].map((th) => th.textContent)).toEqual(['contact_id', 'Client', 'SSN']);
    expect(host.textContent).toContain('SSN and date-of-birth values are hidden here');
    expect(host.querySelector('details.action-draft-preview pre').textContent).toBe(d.definition.sql_text);
    // The SQL is behind the disclosure, not repeated as field rows.
    expect([...host.querySelectorAll('dt')].map((t) => t.textContent)).not.toContain('SQL');
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toContain('Review & save report');
  });

  test('a report card with no usable definition never reaches the route', async () => {
    const api = jest.fn();
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) } };
    const broken = REPORT_DRAFT(); broken.definition.sql_text = '';
    const message = { action_draft: broken };
    await actionSandbox({ P, api, history: [], saveAssistantMessage: jest.fn() }).executeActionDraft(message);
    expect(api).not.toHaveBeenCalled();
    expect(message.action_draft.status).not.toBe('applied');
  });

  test('a saved action result restores its exact proposal as applied without another write', () => {
    const apply = actionSandbox().applyActionResults;
    const messages = [
      { action_draft: { draft_id: 'one', kind: 'task.create.v1', status: 'draft' } },
      { action_draft: { draft_id: 'two', kind: 'task.create.v1', status: 'draft' } },
      { action_result: { kind: 'task.create.v1', draft_id: 'one', task_id: 91 } },
    ];
    expect(apply(messages)).toBe(messages);
    expect(messages[0].action_draft).toMatchObject({ status: 'applied', result_task_id: 91 });
    expect(messages[1].action_draft).toMatchObject({ status: 'draft' });

    // A stored result with no usable id must be IGNORED, not half-applied: a
    // draft marked applied with a NaN id reads as unapplied to the card, which
    // would then offer the write a second time.
    for (const broken of [{ task_id: 0 }, { task_id: null }, { task_id: 'nine' }, {}]) {
      const one = { action_draft: { draft_id: 'three', kind: 'task.create.v1', status: 'draft' } };
      apply([one, { action_result: { kind: 'task.create.v1', draft_id: 'three', ...broken } }]);
      expect(one.action_draft).toEqual({ draft_id: 'three', kind: 'task.create.v1', status: 'draft' });
    }
    const unknown = { action_draft: { draft_id: 'four', kind: 'task.create.v1', status: 'draft' } };
    apply([unknown, { action_result: { kind: 'task.delete.v1', draft_id: 'four', task_id: 5 } }]);
    expect(unknown.action_draft.status).toBe('draft');
  });

  test('a task create is single-flight and a failed insert leaves an unknown outcome', async () => {
    let rejectWrite;
    const api = jest.fn(() => new Promise((_resolve, reject) => { rejectWrite = reject; }));
    const render = jest.fn();
    const history = [];
    const saveAssistantMessage = jest.fn();
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) }, showTask: jest.fn() };
    const make = actionSandbox({ P, api, render, history, saveAssistantMessage }).executeActionDraft;
    const message = { action_draft: {
      draft_id: 'draft-fail', kind: 'task.create.v1', status: 'draft', title: 'Try Casey', description: 'Review it.',
      assignee: { user_id: 1, label: 'Stuart' }, link: null, start_date: null, due_date: null,
      notify_assigner_on_completion: false,
    } };

    const first = make(message);
    expect(message.action_draft.reviewing).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(message.action_draft.executing).toBe(true);
    await make(message);
    expect(api).toHaveBeenCalledTimes(1);
    rejectWrite(new Error('Task insert failed'));
    await first;
    expect(message.action_draft).toMatchObject({ status: 'draft', executing: false, ambiguous_error: expect.stringContaining('Do not apply this card again') });
    expect(history).toEqual([]);
    expect(saveAssistantMessage).not.toHaveBeenCalled();
  });

  test('maps every event action to the canonical route with an exact allowlisted body', () => {
    const request = new Function(`${fnSrc(html, 'eventCreateBody')};${fnSrc(html, 'eventUpdateBody')};${fnSrc(html, 'eventActionRequest')};return eventActionRequest;`)(); // eslint-disable-line no-new-func
    const create = { kind: 'event.create.v1', type: { event_type: 'Hearing', kind: 'hearing' }, event_title: 'Confirmation hearing',
      event_date: '2026-10-27', event_time: '09:30:00', event_all_day: false, event_length: 45,
      event_location: 'Court', event_link: null, event_note: 'Bring order', link: { type: 'case', id: 'C1', label: '26-1' },
      event_with: { user_id: 8, label: 'Provider' }, reminder: { to: 7, date: '2026-10-26', label: 'Fred' }, ignored: 'never send' };
    expect(request(create)).toEqual({ idempotent: true, path: '/api/events', method: 'POST', body: {
      event_type: 'Hearing', event_title: 'Confirmation hearing', event_date: '2026-10-27', event_time: '09:30:00',
      event_all_day: 0, event_length: 45, event_location: 'Court', event_link: null, event_note: 'Bring order', event_with: 8,
      event_link_type: 'case', event_link_id: 'C1', reminder: { to: 7, date: '2026-10-26' },
    } });
    const event = { event_id: 42, title: 'H', status: 'Scheduled' };
    expect(request({ kind: 'event.update.v1', event, changes: { event_title: 'New', event_all_day: true, event_time: null,
      event_with: { user_id: 0, label: 'Nobody' }, reminder: null, ignored: 'x' } })).toEqual({
      path: '/api/events/42', method: 'PATCH', body: { event_title: 'New', event_all_day: 1, event_time: null, event_with: 0, reminder: null },
    });
    expect(request({ kind: 'event.complete.v1', event, resolution: 'held' })).toEqual({ path: '/api/events/42/complete', method: 'PATCH', body: { resolution: 'held' } });
    expect(request({ kind: 'event.cancel.v1', event, resolution: 'cancelled', delete_gcal: true })).toEqual({ path: '/api/events/42/cancel', method: 'PATCH', body: { delete_gcal: true, resolution: 'cancelled' } });
  });

  test('event SweetAlert cancellation writes nothing; confirmation is single-flight, persists, and opens the event', async () => {
    let resolveWrite;
    const api = jest.fn(() => new Promise((resolve) => { resolveWrite = resolve; }));
    const render = jest.fn(); const history = []; const saveAssistantMessage = jest.fn().mockResolvedValue();
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: false }) }, showEvent: jest.fn() };
    const make = actionSandbox({ P, api, render, history, saveAssistantMessage }).executeActionDraft;
    const message = { action_draft: { draft_id: 'event-1', kind: 'event.cancel.v1', status: 'draft',
      event: { event_id: 42, title: 'Hearing', status: 'Scheduled', type: 'Hearing', kind: 'hearing', date: '2026-10-27', time: '09:30:00', all_day: false },
      resolution: 'cancelled', delete_gcal: true } };
    await make(message);
    expect(api).not.toHaveBeenCalled();
    expect(P.Swal.fire).toHaveBeenCalledWith(expect.objectContaining({ title: 'Cancel event', text: expect.stringContaining('the existing entry will be deleted'), showCancelButton: true }));

    P.Swal.fire.mockResolvedValue({ isConfirmed: true });
    const first = make(message); await Promise.resolve(); await Promise.resolve();
    await make(message);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/api/events/42/cancel', { delete_gcal: true, resolution: 'cancelled' }, 'PATCH');
    resolveWrite({ status: 'success', data: { event_id: 42 } }); await first;
    expect(message.action_draft).toMatchObject({ status: 'applied', result_event_id: 42, executing: false });
    expect(history[0].action_result).toEqual({ kind: 'event.cancel.v1', draft_id: 'event-1', event_id: 42 });
    expect(saveAssistantMessage).toHaveBeenCalledWith(history[0], { required: true });
    expect(P.showEvent).toHaveBeenCalledWith(42);
    await make(message);
    expect(api).toHaveBeenCalledTimes(1);
  });

  test('failed event writes remain unknown and saved results prevent history replay', async () => {
    const apply = actionSandbox().applyActionResults;
    const messages = [{ action_draft: { draft_id: 'event-2', kind: 'event.update.v1', status: 'draft' } },
      { action_result: { draft_id: 'event-2', kind: 'event.update.v1', event_id: 42 } }];
    expect(apply(messages)[0].action_draft).toMatchObject({ status: 'applied', result_event_id: 42 });

    const api = jest.fn().mockRejectedValue(new Error('Event update failed')); const render = jest.fn();
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) }, showEvent: jest.fn() };
    const make = actionSandbox({ P, api, render }).executeActionDraft;
    const message = { action_draft: { draft_id: 'event-fail', kind: 'event.update.v1', status: 'draft',
      event: { event_id: 42, title: 'H', status: 'Scheduled', type: 'Hearing', kind: 'hearing', date: '2026-10-27', time: null, all_day: true },
      changes: { event_note: 'Updated' } } };
    await make(message);
    expect(message.action_draft).toMatchObject({ status: 'draft', executing: false, ambiguous_error: expect.stringContaining('Do not apply this card again') });
    await make(message);
    expect(api).toHaveBeenCalledTimes(1);
  });

  test('maps every appointment action to one canonical route and exact allowlisted body', () => {
    const request = new Function(`${apptFns('apptCreateBody', 'apptActionRequest')};return apptActionRequest;`)(); // eslint-disable-line no-new-func
    // A draft WITHOUT the server's confirmation object sends none, whatever flags it carries.
    const create = { kind: 'appt.create.v1', contact: { contact_id: 1309 }, case: { case_id: 'C1' },
      type: { appt_type: 'Consultation', type_key: 'consult' }, appt_length: 60, appt_platform: 'Telephone',
      appt_date: '2026-10-27 09:30:00', provider: { user_id: 7 }, note: 'Bring documents', confirm_sms: true,
      confirm_email: false, confirm_message: 'Confirmed', ignored: 'never send' };
    expect(request(create)).toEqual({ idempotent: true, path: '/api/appts', method: 'POST', body: { contact_id: 1309, case_id: 'C1',
      appt_type: 'Consultation', type_key: 'consult', appt_length: 60, appt_platform: 'Telephone',
      appt_date: '2026-10-27 09:30:00', appt_with: 7, note: 'Bring documents', confirm_sms: false,
      confirm_email: false, confirm_message: '' } });
    const appt = { appt_id: 55 };
    expect(request({ kind: 'appt.update.v1', appt, changes: { note: 'New note', case: null, ignored: 'x' } }))
      .toEqual({ path: '/api/appts/55', method: 'PATCH', body: { appt_note: 'New note', appt_case_id: '' } });
    expect(request({ kind: 'appt.attended.v1', appt, note: 'Held' })).toEqual({ path: '/api/appts/55/attended', method: 'POST', body: { note: 'Held' } });
    expect(request({ kind: 'appt.no_show.v1', appt, note: '', enroll: true })).toEqual({ path: '/api/appts/55/no-show', method: 'POST', body: { note: '', enroll: true } });
    expect(request({ kind: 'appt.cancel.v1', appt, note: '', sms: true, email: true, confirm_message: 'Hi {{contacts.contact_ssn}}', cancel_gcal: true, create_task: false }))
      .toEqual({ path: '/api/appts/cancel', method: 'POST', body: { appt: 55, note: '', sms: false, email: false, confirm_message: '', cancel_gcal: true, create_task: false } });
    expect(request({ kind: 'appt.reschedule.v1', appt, new_date: '2026-10-28 10:00:00', note: '', sms: true, email: false, confirm_message: 'Moved' }))
      .toEqual({ path: '/api/appts/reschedule', method: 'POST', body: { appt: 55, newDate: '2026-10-28 10:00:00', note: '', sms: false, email: false, msg: '' } });
    expect(request({ kind: 'appt.reschedule_later.v1', appt, note: 'Call', create_task: true }))
      .toEqual({ path: '/api/appts/reschedule', method: 'POST', body: { appt: 55, note: 'Call', rescheduleLater: true, createTask: true } });
  });

  test('appointment update review text shows current and proposed material values', () => {
    const reviewText = new Function(`${apptFns('apptActionLabel', 'apptChannelsText', 'apptDraftText')};return apptDraftText;`)(); // eslint-disable-line no-new-func
    const text = reviewText({ kind: 'appt.update.v1', firm_timezone: 'Asia/Jerusalem',
      appt: { appt_id: 55, type: 'Consultation', status: 'Scheduled', date: '2026-10-27 09:30:00', note: 'Existing note',
        contact: { label: 'Client' }, case: { label: '26-1' }, provider: { label: 'Fred' }, google_calendar: { firm: true, provider: false } },
      changes: { note: 'Replacement note' } });
    expect(text).toMatch(/Current complete note: Existing note/);
    expect(text).toMatch(/New complete note: Replacement note/);
    expect(text).toMatch(/Calendar \/ automation: unchanged/);
  });

  test('appointment review cancellation writes nothing; confirmation is single-flight, persists, and opens the canonical result', async () => {
    let resolveWrite;
    const api = jest.fn(() => new Promise((resolve) => { resolveWrite = resolve; }));
    const render = jest.fn(); const history = []; const saveAssistantMessage = jest.fn().mockResolvedValue();
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: false }) }, showAppt: jest.fn() };
    const execute = actionSandbox({ P, api, render, history, saveAssistantMessage }).executeActionDraft;
    const message = { action_draft: { draft_id: 'appt-1', kind: 'appt.reschedule.v1', status: 'draft',
      appt: { appt_id: 55, type: 'Consultation', status: 'Scheduled', date: '2026-10-27 09:30:00', note: 'Existing note', contact: { label: 'Client' }, case: null,
        provider: { label: 'Fred' }, google_calendar: { firm: true, provider: true } },
      new_date: '2026-10-28 10:00:00', note: '', sms: false, email: false, confirm_message: '' } };
    await execute(message);
    expect(api).not.toHaveBeenCalled();
    expect(P.Swal.fire).toHaveBeenCalledWith(expect.objectContaining({ title: 'Reschedule appointment',
      text: expect.stringContaining('a successor with the same client'), showCancelButton: true }));

    P.Swal.fire.mockResolvedValue({ isConfirmed: true });
    const first = execute(message); await Promise.resolve(); await Promise.resolve();
    await execute(message);
    expect(api).toHaveBeenCalledTimes(1);
    resolveWrite({ status: 'success', appt_id: 55, new_appt_id: 56 }); await first;
    expect(message.action_draft).toMatchObject({ status: 'applied', result_appt_id: 56, executing: false });
    expect(history[0].action_result).toEqual({ kind: 'appt.reschedule.v1', draft_id: 'appt-1', appt_id: 56 });
    expect(saveAssistantMessage).toHaveBeenCalledWith(history[0], { required: true });
    expect(P.showAppt).toHaveBeenCalledWith(56);
    await execute(message);
    expect(api).toHaveBeenCalledTimes(1);
  });

  test('failed appointment writes remain unknown and saved results prevent replay', async () => {
    const apply = actionSandbox().applyActionResults;
    const messages = [{ action_draft: { draft_id: 'appt-2', kind: 'appt.cancel.v1', status: 'draft' } },
      { action_result: { draft_id: 'appt-2', kind: 'appt.cancel.v1', appt_id: 55 } }];
    expect(apply(messages)[0].action_draft).toMatchObject({ status: 'applied', result_appt_id: 55 });

    const api = jest.fn().mockRejectedValue(new Error('Appointment cancel failed')); const render = jest.fn();
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) }, showAppt: jest.fn() };
    const execute = actionSandbox({ P, api, render }).executeActionDraft;
    const message = { action_draft: { draft_id: 'appt-fail', kind: 'appt.cancel.v1', status: 'draft',
      appt: { appt_id: 55, type: 'Consultation', status: 'Scheduled', date: '2026-10-27 09:30:00', contact: { label: 'Client' }, case: null,
        provider: { label: 'Fred' }, google_calendar: { firm: true, provider: false } }, note: '', sms: false, email: false,
      confirm_message: '', cancel_gcal: true, create_task: false } };
    await execute(message);
    expect(message.action_draft).toMatchObject({ status: 'draft', executing: false, ambiguous_error: expect.stringContaining('Do not apply this card again') });
    await execute(message);
    expect(api).toHaveBeenCalledTimes(1);
  });

  // Ruling 15's A14 bar on the appointment cards: off, every card is byte-for-byte
  // the shipped one; on, the request sends exactly the server-resolved text.
  const apptFixture = () => {
    const appt = { appt_id: 55, type: 'Consultation', status: 'Scheduled', date: '2026-10-27 09:30:00', note: 'Existing note',
      contact: { contact_id: 1309, label: 'Client' }, case: { label: '26-1' }, provider: { label: 'Fred' }, google_calendar: { firm: true, provider: false } };
    return {
      create: { kind: 'appt.create.v1', firm_timezone: 'America/Detroit', contact: { contact_id: 1309, label: 'Client' }, case: { case_id: 'C1', label: '26-1' },
        type: { appt_type: 'Consultation', type_key: 'consult', singleton: false }, appt_length: 60, appt_platform: 'Telephone',
        appt_date: '2026-10-27 09:30:00', provider: { user_id: 7, label: 'Fred' }, note: 'Bring documents', confirm_sms: false, confirm_email: false, confirm_message: '' },
      cancel: { kind: 'appt.cancel.v1', appt, note: 'Client called', sms: false, email: false, confirm_message: '', cancel_gcal: true, create_task: false },
      reschedule: { kind: 'appt.reschedule.v1', appt, new_date: '2026-10-28 10:00:00', note: '', sms: false, email: false, confirm_message: '' },
    };
  };
  const LINK = '{{appts.appt_manage_token|default:}}';
  const resolvedMsg = `Hi Jane, you are booked for Tuesday at 9:30 AM.\nConsent: yes\nManage: https://4lsg.com/m/${LINK}`;
  const confirmation = { manage_link: true, templated: true, ssn_warning: false,
    sms: { to: '3135550100', from: '2485550000', segments: { encoding: 'GSM-7', units: 120, segments: 1 } },
    email: { to: 'jane@example.com', from: 'office@firm.example', subject: 'Appointment Confirmation' } };

  test('appointment cards without a confirmation are byte-stable: review text and request body', () => {
    const fns = new Function(`${apptFns('apptActionLabel', 'apptChannelsText', 'apptDraftText', 'apptCreateBody', 'apptActionRequest')};return { apptDraftText, apptActionRequest };`)(); // eslint-disable-line no-new-func
    const { create, cancel, reschedule } = apptFixture();
    const none = 'Client confirmation: None — this appointment card sends no client SMS or email; send a confirmation from the appointment itself, or ask Casey for a separate send card';
    expect(fns.apptDraftText(create)).toBe(['Appointment action proposal — not applied', 'Action: Create appointment', 'Client: Client (contact 1309)',
      'Case: 26-1 (C1)', 'Type: Consultation (consult)', 'Firm-local date/time (America/Detroit): 2026-10-27 09:30:00', 'Length: 60 minutes',
      'Platform / location: Telephone', 'Provider: Fred (user 7)', 'Note: Bring documents', none,
      'Google Calendar: creation will be attempted on the firm calendar and the provider calendar when configured; the firm entry includes the client attendee without Google update emails.',
      'Automation: active no-show sequences are canceled and normal pre-appointment sequences are enrolled.', 'Singleton effect: none.'].join('\n'));
    const head = ['Appointment: #55 — Consultation', 'Current status: Scheduled', 'Current firm-local date/time: 2026-10-27 09:30:00', 'Client: Client',
      'Case: 26-1', 'Provider: Fred', 'Google Calendar entries: firm present; provider absent'];
    expect(fns.apptDraftText(cancel)).toBe(['Appointment action proposal — not applied', 'Action: Cancel appointment', ...head, 'Note to append: Client called', none,
      'Follow-up task: do not create.', 'Google Calendar: delete both existing entries when present.', 'Automation: appointment and contact no-show sequences are canceled.'].join('\n'));
    expect(fns.apptDraftText(reschedule)).toBe(['Appointment action proposal — not applied', 'Action: Reschedule appointment', ...head, 'New firm-local date/time: 2026-10-28 10:00:00', none,
      'Result: the current appointment becomes Rescheduled and a successor with the same client, case, type, length, platform, and provider is created.',
      'Calendar / automation: old calendar entries and appointment automation are removed; new calendar entries and pre-appointment automation are created.'].join('\n'));
    expect(fns.apptActionRequest(create).body).toMatchObject({ confirm_sms: false, confirm_email: false, confirm_message: '' });
    expect(fns.apptActionRequest(cancel).body).toEqual({ appt: 55, note: 'Client called', sms: false, email: false, confirm_message: '', cancel_gcal: true, create_task: false });
    expect(fns.apptActionRequest(reschedule).body).toEqual({ appt: 55, newDate: '2026-10-28 10:00:00', note: '', sms: false, email: false, msg: '' });
  });

  test('a server-prepared confirmation sends exactly the resolved text and shows the manage link as a labeled element', () => {
    const fns = new Function(`${apptFns('apptActionLabel', 'apptChannelsText', 'apptDraftText', 'apptCreateBody', 'apptActionRequest', 'apptConfirmText')};return { apptDraftText, apptActionRequest, apptConfirmText };`)(); // eslint-disable-line no-new-func
    const { create, cancel, reschedule } = apptFixture();
    const c = { ...create, confirm_sms: true, confirm_email: true, confirm_message: resolvedMsg, confirmation };
    expect(fns.apptActionRequest(c).body).toMatchObject({ confirm_sms: true, confirm_email: true, confirm_message: resolvedMsg });
    const x = { ...cancel, sms: true, email: false, confirm_message: resolvedMsg, confirmation: { ...confirmation, email: null } };
    expect(fns.apptActionRequest(x).body).toEqual({ appt: 55, note: 'Client called', sms: true, email: false, confirm_message: resolvedMsg, cancel_gcal: true, create_task: false });
    const r = { ...reschedule, sms: false, email: true, confirm_message: resolvedMsg, confirmation: { ...confirmation, sms: null } };
    expect(fns.apptActionRequest(r).body).toEqual({ appt: 55, newDate: '2026-10-28 10:00:00', note: '', sms: false, email: true, msg: resolvedMsg });
    // A flag the server did not prepare a channel for sends nothing on that channel.
    expect(fns.apptActionRequest({ ...x, email: true }).body).toMatchObject({ sms: true, email: false });

    const text = fns.apptDraftText(c);
    expect(text).toContain('Client confirmation: SMS to (313) 555-0100 from (248) 555-0000; email to jane@example.com from office@firm.example, subject "Appointment Confirmation"');
    expect(text).toContain('except the manage link, which is filled in when it is sent');
    expect(text).toContain('Confirmation effect: goes to the client as soon as the appointment saves. It cannot be recalled.');
    expect(text.endsWith(['Confirmation message, exactly as sent, between the rules:', '────────',
      'Hi Jane, you are booked for Tuesday at 9:30 AM.\nConsent: yes\nManage: https://4lsg.com/m/[secure manage link — generated when the appointment is created]', '────────'].join('\n'))).toBe(true);
    expect(text).not.toContain('{{');
    expect(fns.apptDraftText(x)).toContain('[secure manage link for this appointment — filled in when the message is sent]');
    expect(fns.apptDraftText(r)).toContain('[secure manage link for the new appointment — generated when it is created]');
    expect(fns.apptConfirmText(c)).toMatch(/It also sends the client confirmation above, which cannot be recalled\.$/);
    expect(fns.apptConfirmText(create)).toBe(`${fns.apptDraftText(create)}\n\nThis changes YisraCase immediately using your signed-in account.`);

    // Belt and braces: braces beyond the manage link never send.
    expect(() => fns.apptActionRequest({ ...c, confirm_message: 'Hi {{contacts.contact_fname}}' })).toThrow(/no resolved text/);
    expect(() => fns.apptActionRequest({ ...c, confirm_message: '  ' })).toThrow(/no resolved text/);
  });

  test('a confirmation card re-reads the recipient at click time; a card without one reads nothing', async () => {
    const { create } = apptFixture();
    const card = () => ({ action_draft: { draft_id: 'appt-conf', status: 'draft', ...create, confirm_sms: true, confirm_email: true,
      confirm_message: resolvedMsg, confirmation } });
    const contactApi = ({ phone = '3135550100', smsOpt = 0, emailOpt = 0 } = {}) => jest.fn(async (path) => {
      if (path === '/api/contacts/1309') return { contact: { contact_id: 1309, contact_phone: phone, contact_email: 'jane@example.com' } };
      if (path === '/api/contacts/1309/phones') return { phones: [{ id: 1, phone, end_date: null, sms_optout: smsOpt }] };
      if (path === '/api/contacts/1309/emails') return { emails: [{ id: 1, email: 'jane@example.com', end_date: null, email_optout: emailOpt }] };
      if (path === '/api/appts') return { status: 'success', data: { appt_id: 90 } };
      throw new Error(`unexpected ${path}`);
    });
    const P = () => ({ Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) }, showAppt: jest.fn() });

    const changed = contactApi({ phone: '3135550111' }); const m1 = card();
    await actionSandbox({ P: P(), api: changed, render: jest.fn() }).executeActionDraft(m1);
    expect(m1.action_draft.refusal_error).toMatch(/phone number changed/);
    expect(changed.mock.calls.map((c) => c[0])).toEqual(['/api/contacts/1309']);

    const opted = contactApi({ smsOpt: 1 }); const m2 = card();
    await actionSandbox({ P: P(), api: opted, render: jest.fn() }).executeActionDraft(m2);
    expect(m2.action_draft.refusal_error).toMatch(/opted out of texts since this card was prepared/);
    expect(opted.mock.calls.map((c) => c[0])).not.toContain('/api/appts');

    const ok = contactApi(); const p3 = P(); const m3 = card();
    await actionSandbox({ P: p3, api: ok, render: jest.fn() }).executeActionDraft(m3);
    expect(p3.Swal.fire).toHaveBeenCalledWith(expect.objectContaining({ icon: 'warning', focusCancel: true }));
    expect(m3.action_draft).toMatchObject({ status: 'applied', result_appt_id: 90 });
    const write = ok.mock.calls.find((c) => c[0] === '/api/appts');
    expect(write[1]).toMatchObject({ confirm_sms: true, confirm_email: true, confirm_message: resolvedMsg });

    const plain = contactApi(); const p4 = P(); const m4 = { action_draft: { draft_id: 'appt-plain', status: 'draft', ...create } };
    await actionSandbox({ P: p4, api: plain, render: jest.fn() }).executeActionDraft(m4);
    expect(plain.mock.calls.map((c) => c[0])).toEqual(['/api/appts']);
    expect(p4.Swal.fire).toHaveBeenCalledWith(expect.objectContaining({ icon: 'question' }));
  });

  test('maps every contact subrecord action to one canonical route and exact allowlisted body', () => {
    const request = new Function(`${fnSrc(html, 'contactSubrecordCreateBody')};${fnSrc(html, 'contactSubrecordActionRequest')};return contactSubrecordActionRequest;`)(); // eslint-disable-line no-new-func
    const contact = { contact_id: 1309, label: 'Client' };
    expect(request({ kind: 'contact.phone.create.v1', family: 'phone', contact, fields: { phone: '2485550100', label: 'Mobile', is_primary: true,
      sms_optout: false, mms_capable: true, start_date: null, notes: '', verified: 1 } })).toEqual({ idempotent: true, path: '/api/contact-phones', method: 'POST', body: {
      contact_id: 1309, phone: '2485550100', label: 'Mobile', is_primary: true, sms_optout: false, mms_capable: true, start_date: null, notes: '', expected_primary_id: null } });
    expect(request({ kind: 'contact.email.create.v1', family: 'email', contact, fields: { email: 'client@example.com', label: 'Personal', is_primary: false,
      email_optout: true, start_date: '2026-01-01', notes: 'n' } })).toEqual({ idempotent: true, path: '/api/contact-emails', method: 'POST', body: {
      contact_id: 1309, email: 'client@example.com', label: 'Personal', is_primary: false, email_optout: true, start_date: '2026-01-01', notes: 'n' } });
    expect(request({ kind: 'contact.address.create.v1', family: 'address', contact, fields: { address1: '1 Main', address2: '', city: 'Detroit', state: 'MI', zip: '48201',
      country: 'US', label: 'Home', is_primary: true, start_date: null, notes: '' } })).toEqual({ idempotent: true, path: '/api/contact-addresses', method: 'POST', body: {
      contact_id: 1309, address1: '1 Main', address2: '', city: 'Detroit', state: 'MI', zip: '48201', country: 'US', label: 'Home', is_primary: true, start_date: null, notes: '', expected_primary_id: null } });
    const target = { id: 21, expected_updated_at: '2026-10-20T10:00:00.000Z' };
    expect(request({ kind: 'contact.phone.update.v1', family: 'phone', target, changes: { label: 'Work', sms_optout: true, ignored: 'x' } })).toEqual({
      path: '/api/contact-phones/21', method: 'PATCH', body: { expected_updated_at: target.expected_updated_at, label: 'Work', sms_optout: true } });
    expect(request({ kind: 'contact.email.update.v1', family: 'email', target, changes: { email_optout: true, notes: 'Stop' } })).toEqual({
      path: '/api/contact-emails/21', method: 'PATCH', body: { expected_updated_at: target.expected_updated_at, email_optout: true, notes: 'Stop' } });
    expect(request({ kind: 'contact.address.update.v1', family: 'address', target, demoted_primary: { id: 19 },
      changes: { address1: '2 Main', city: 'Detroit', is_primary: true } })).toEqual({ path: '/api/contact-addresses/21', method: 'PATCH',
      body: { expected_updated_at: target.expected_updated_at, address1: '2 Main', city: 'Detroit', is_primary: true, expected_primary_id: 19 } });
    for (const family of ['phone', 'email', 'address']) expect(request({ kind: `contact.${family}.end.v1`, family, target,
      changes: { end_date: '2026-10-20', end_reason: 'No longer used' } })).toEqual({ path: `/api/contact-${family}${family === 'address' ? 'es' : 's'}/21`, method: 'PATCH',
      body: { expected_updated_at: target.expected_updated_at, end_date: '2026-10-20', end_reason: 'No longer used' } });
  });

  test('contact subrecord review is cancelable, single-flight, persisted, and opens the parent contact', async () => {
    let resolveWrite;
    const api = jest.fn(() => new Promise((resolve) => { resolveWrite = resolve; }));
    const render = jest.fn(); const history = []; const saveAssistantMessage = jest.fn().mockResolvedValue(); const openEntity = jest.fn();
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: false }) } };
    const execute = actionSandbox({ P, api, render, history, saveAssistantMessage, openEntity }).executeActionDraft;
    const message = { action_draft: { draft_id: 'contact-1', kind: 'contact.phone.end.v1', family: 'phone', status: 'draft',
      target: { id: 21, contact: { contact_id: 1309, label: 'Client' }, phone: '2485550100', label: 'Mobile', is_primary: true,
        start_date: '2026-01-01', notes: '', sms_optout: false, mms_capable: true, expected_updated_at: '2026-10-20T10:00:00.000Z' },
      changes: { end_date: '2026-10-20', end_reason: 'No longer used' } } };
    await execute(message);
    expect(api).not.toHaveBeenCalled();
    expect(P.Swal.fire).toHaveBeenCalledWith(expect.objectContaining({ title: 'End contact phone', text: expect.stringContaining('not a hard delete'), showCancelButton: true }));
    P.Swal.fire.mockResolvedValue({ isConfirmed: true });
    const first = execute(message); await Promise.resolve(); await Promise.resolve();
    await execute(message);
    expect(api).toHaveBeenCalledTimes(1);
    resolveWrite({ status: 'success', phone: { id: 21, contact_id: 1309 } }); await first;
    expect(message.action_draft).toMatchObject({ status: 'applied', result_contact_id: 1309, executing: false });
    expect(history[0].action_result).toEqual({ kind: 'contact.phone.end.v1', draft_id: 'contact-1', contact_id: 1309, contact_label: 'Client' });
    expect(saveAssistantMessage).toHaveBeenCalledWith(history[0], { required: true });
    expect(openEntity).toHaveBeenCalledWith('contact', 1309, 'Client');
    await execute(message); expect(api).toHaveBeenCalledTimes(1);
  });

  test('failed contact writes remain unknown and saved results prevent replay', async () => {
    const apply = actionSandbox().applyActionResults;
    const messages = [{ action_draft: { draft_id: 'contact-2', kind: 'contact.email.update.v1', status: 'draft' } },
      { action_result: { draft_id: 'contact-2', kind: 'contact.email.update.v1', contact_id: 1309, contact_label: 'Client' } }];
    expect(apply(messages)[0].action_draft).toMatchObject({ status: 'applied', result_contact_id: 1309, result_contact_label: 'Client' });

    const api = jest.fn().mockRejectedValue(new Error('Contact update failed')); const render = jest.fn();
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) } };
    const execute = actionSandbox({ P, api, render }).executeActionDraft;
    const message = { action_draft: { draft_id: 'contact-fail', kind: 'contact.email.update.v1', family: 'email', status: 'draft',
      target: { id: 22, contact: { contact_id: 1309, label: 'Client' }, email: 'client@example.com', label: 'Personal', is_primary: false,
        start_date: '2026-01-01', notes: '', email_optout: false, expected_updated_at: '2026-10-20T10:00:00.000Z' }, changes: { label: 'Work' } } };
    await execute(message);
    expect(message.action_draft).toMatchObject({ status: 'draft', executing: false, ambiguous_error: expect.stringContaining('Do not apply this card again') });
    await execute(message); expect(api).toHaveBeenCalledTimes(1);
  });

  test('uses exact structured follow-up queries and shell-native record links', () => {
    expect(html).toContain('data-follow="${esc(s.query)}"');
    expect(html).toContain("P.addFile(label || id, 'case', String(id))");
    expect(html).toContain("P.addFile(label || id, 'client', String(id))");
    expect(html).toContain('P.showAppt(id)');
    expect(html).toContain('P.showEvent(id)');
    expect(html).toContain('P.showTask(id)');
  });

  test('shows the wand-writing animation during planning and execution', () => {
    expect(html).toContain('<h1><i class="fa-solid fa-wand-magic-sparkles"></i> Ask Casey</h1>');
    expect(html).toContain('class="thinking-wand"');
    expect(html).toContain('@keyframes wandWrite');
    expect(html).toContain("type: 'thinking'");
    expect(html).toContain('bounded read passes');
    expect(html).toContain('read passes`');
    expect(html).toContain('r.investigation.notices');
  });

  test('runs read plans automatically and retries one safe planner repair', () => {
    expect(html).toContain('r = await executeAutomatically(r.ticket, attachmentRequest.temporary)');
    expect(html).toContain("if (r.outcome !== 'plan') return r");
    expect(html).not.toContain('Approve & run');
    expect(html).toContain('Read-only searches run automatically');
  });

  test('record actions are visible without expanding the evidence row', () => {
    expect(html).toContain('<b>Open records</b>');
    expect(html).toContain('entities: r.entities || []');
    const actionPos = html.indexOf('class="source-actions"');
    const detailPos = html.indexOf('<details><summary>View evidence row');
    expect(actionPos).toBeGreaterThan(-1);
    expect(detailPos).toBeGreaterThan(actionPos);
  });

  test('the API exposes plan and execute as separate staff-only posts', () => {
    expect(route).toMatch(/router\.post\('\/api\/assistant\/plan', jwtOrApiKey, staffOnly/);
    expect(route).toMatch(/router\.post\('\/api\/assistant\/execute', jwtOrApiKey, staffOnly/);
    expect(route).toContain('workspaceContext: req.body && req.body.workspace_context');
  });

  test('a one-shot ask URL only prefills the textarea and is scrubbed by the shell', () => {
    expect(shell).toContain("raw.length <= 2000");
    expect(shell).toContain("u.searchParams.delete('ask')");
    expect(shell).toContain('window.ycTakeAssistantDraft = function ()');
    expect(html).toContain("P.ycTakeAssistantDraft()");
    expect(html).toContain('input.value = String(draft).slice(0, 2000)');
    expect(html).not.toMatch(/if \(draft\).*ask\(\)/);
  });

  test('shows removable frozen workspace context and submits only its snapshot', () => {
    expect(html).toContain('id="contextList"');
    expect(html).toContain('let workspaceContextAttached = true');
    expect(html).toContain('workspaceContextAttached = false');
    expect(html).toContain('const turnContext = freezeWorkspaceContextForTurn()');
    expect(html).toMatch(/function freezeWorkspaceContextForTurn\(\)[\s\S]*refreshWorkspaceContext\(\)[\s\S]*JSON\.parse\(JSON\.stringify\(current\)\)/);
    expect(html).toContain('workspace_context: turnContext && turnContext.snapshot');
  });

  test('refreshes an attached context when the canonical workspace changes', () => {
    expect(html).toContain('window.ycAssistantRefreshContext = refreshWorkspaceContext');
    expect(shell).toContain('frame.contentWindow.ycAssistantRefreshContext');
    expect(shell.indexOf('history.replaceState(null, "", currentOpenFilesUrl())'))
      .toBeLessThan(shell.indexOf('frame.contentWindow.ycAssistantRefreshContext'));
  });

  test('renders allowlisted semantic destination actions through the shell bridge', () => {
    expect(html).toContain('data-destination="${esc(item.id)}"');
    expect(html).toContain('P.ycAssistantNavigate(b.dataset.destination)');
  });

  test('recent chats are user-backed and long chats get a gentle new-chat prompt', () => {
    expect(route).toMatch(/router\.get\('\/api\/assistant\/chats', jwtOrApiKey, staffOnly/);
    expect(route).toMatch(/router\.delete\('\/api\/assistant\/chats\/:id/);
    expect(html).toContain('Recent chats');
    expect(html).toContain("history.filter((m) => m.role === 'user').length < 4");
    expect(html).toContain('keep each chat about one person, matter, or task');
  });

  test('offers product-level model modes and transient or existing attachments', () => {
    expect(html).toContain('<option value="better_quality">Better quality</option>');
    expect(html).toContain('<option value="faster_speed">Faster speed</option>');
    expect(html).not.toContain('>Best quality<');
    expect(html).toContain('id="fileInput"');
    expect(html).toContain('YisraCase document');
    expect(html).toContain('temporary_attachments: attachmentRequest.temporary');
    expect(html).toContain('document_ids: attachmentRequest.documentIds');
    expect(html).toContain('Save to case');
    expect(html).toContain("'/api/documents/upload-link'");
    expect(html).toContain("'/api/documents/upload-commit'");
  });
});

describe('Ask Casey action freshness and applied-marker durability (review fix package 2026-10-21)', () => {
  const draft = (extra = {}) => ({ action_draft: { draft_id: 'd-1', kind: 'task.create.v1', status: 'draft', title: 'Call', description: 'Call the client.',
    assignee: { user_id: 1, label: 'Stuart' }, link: null, start_date: null, due_date: null, notify_assigner_on_completion: false, ...extra } });
  const harness = (P, api, saveAssistantMessage) => actionSandbox({ P, api, saveAssistantMessage }).executeActionDraft;

  test('a card reopened from history or past its TTL never writes; it asks for a fresh proposal', async () => {
    const api = jest.fn().mockResolvedValue({ status: 'success', task_id: 5 });
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) }, showTask: jest.fn() };
    const execute = harness(P, api, jest.fn().mockResolvedValue());
    const restored = draft({ restored: true });
    await execute(restored);
    expect(restored.action_draft.action_error).toMatch(/reopened from saved history/);
    const old = draft({ received_at: Date.now() - 16 * 60 * 1000 });
    await execute(old);
    expect(old.action_draft.action_error).toMatch(/more than 15 minutes old/);
    expect(P.Swal.fire).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  });

  test('a card that expires while its review dialog is open writes nothing', async () => {
    const api = jest.fn().mockResolvedValue({ status: 'success', task_id: 5 });
    const message = draft({ received_at: Date.now() });
    const P = { Swal: { fire: jest.fn(async () => { message.action_draft.received_at = Date.now() - 16 * 60 * 1000; return { isConfirmed: true }; }) }, showTask: jest.fn() };
    await harness(P, api, jest.fn().mockResolvedValue())(message);
    expect(P.Swal.fire).toHaveBeenCalledTimes(1);
    expect(api).not.toHaveBeenCalled();
    expect(message.action_draft).toMatchObject({ status: 'draft', action_error: expect.stringMatching(/15 minutes old/) });
  });

  test('a fresh card writes once; its button stays blocked until the applied marker is saved', async () => {
    let resolveSave;
    const save = jest.fn(() => new Promise((resolve) => { resolveSave = resolve; }));
    const api = jest.fn().mockResolvedValue({ status: 'success', task_id: 5 });
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) }, showTask: jest.fn() };
    const message = draft({ received_at: Date.now() });
    const running = harness(P, api, save)(message);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(api).toHaveBeenCalledTimes(1);
    expect(message.action_draft).toMatchObject({ status: 'applied', executing: true });
    resolveSave();
    await running;
    expect(message.action_draft).toMatchObject({ status: 'applied', executing: false });
    expect(message.action_draft).not.toHaveProperty('marker_error');
  });

  test('when the applied marker cannot be saved the user is told loudly; the write is not repeated', async () => {
    const api = jest.fn().mockResolvedValue({ status: 'success', task_id: 5 });
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) }, showTask: jest.fn() };
    const message = draft({ received_at: Date.now() });
    await harness(P, api, jest.fn().mockRejectedValue(new Error('chat history is unavailable')))(message);
    expect(api).toHaveBeenCalledTimes(1);
    expect(message.action_draft.status).toBe('applied');
    expect(message.action_draft.marker_error).toMatch(/WAS applied[\s\S]*Do not apply it again/);
    expect(P.Swal.fire).toHaveBeenLastCalledWith(expect.objectContaining({ icon: 'warning', title: 'Applied, but not recorded' }));
    expect(message.action_draft).not.toHaveProperty('action_error');
  });

  test('the action registry is closed and complete: every family carries the mechanics the shared engine calls', () => {
    const { actionFamily, isActionDraft, executeActionDraft } = actionSandbox();
    const kinds = [
      ['task.create.v1', 'task', 'task', 'task_id', 'result_task_id'],
      ['task.transfer.v1', 'task', 'task', 'task_id', 'result_task_id'],
      ['event.cancel.v1', 'event', 'event', 'event_id', 'result_event_id'],
      ['appt.reschedule_later.v1', 'appt', 'appointment', 'appt_id', 'result_appt_id'],
      ['contact.address.end.v1', 'contact', 'contact', 'contact_id', 'result_contact_id'],
    ];
    for (const [kind, id, noun, idField, appliedKey] of kinds) {
      const family = actionFamily({ kind });
      expect(family).toBeTruthy();
      expect([family.id, family.noun, family.idField, family.appliedKey]).toEqual([id, noun, idField, appliedKey]);
      // Everything the engine and the card reach for, per family.
      for (const member of ['kinds', 'title', 'errorNoun', 'label', 'text', 'request', 'result', 'danger',
        'resultText', 'entity', 'failure', 'reviewWarning', 'open']) expect(family[member]).toBeTruthy();
    }
    // One kind resolves to exactly one family, and ids/result keys are not shared.
    const families = kinds.map(([kind]) => actionFamily({ kind }));
    const all = [...new Set(families)];
    const everyKind = all.flatMap((family) => [...family.kinds]);
    expect(everyKind).toHaveLength(26);
    expect(new Set(everyKind).size).toBe(26);
    expect(new Set(all.map((f) => f.appliedKey)).size).toBe(all.length);

    // An unknown or model-invented kind has no family and is inert everywhere.
    for (const kind of ['task.delete.v1', 'contact.merge.v1', 'task.create.v2', '', undefined]) {
      expect(actionFamily({ kind })).toBe(null);
      expect(isActionDraft({ kind })).toBe(false);
    }
    expect(actionFamily(null)).toBe(null);
    const api = jest.fn();
    const sandbox = actionSandbox({ api, P: { Swal: { fire: jest.fn() } } });
    return sandbox.executeActionDraft({ action_draft: { draft_id: 'x', kind: 'task.delete.v1', status: 'draft' } })
      .then(() => { expect(api).not.toHaveBeenCalled(); expect(executeActionDraft).toBeInstanceOf(Function); });
  });

  test('a required save throws (after one retry) instead of swallowing; an ordinary save still only warns', async () => {
    const make = (api, chatId, available = true) => new Function('api', 'currentChatId', 'historyAvailable', `async ${fnSrc(html, 'saveAssistantMessage')}; return saveAssistantMessage;`)(api, chatId, available); // eslint-disable-line no-new-func
    const failing = jest.fn().mockRejectedValue(new Error('500'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(make(failing, 9)({ text: 'Applied.' }, { required: true })).rejects.toThrow('500');
      expect(failing).toHaveBeenCalledTimes(2);
      await expect(make(jest.fn(), null)({ text: 'Applied.' }, { required: true })).rejects.toThrow(/unavailable/);
      await expect(make(jest.fn(), 9, false)({ text: 'Applied.' }, { required: true })).rejects.toThrow(/unavailable/);
      await expect(make(failing, 9)({ text: 'Answer.' })).resolves.toBeUndefined();
      const flaky = jest.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce({ status: 'success' });
      await expect(make(flaky, 9)({ text: 'Applied.' }, { required: true })).resolves.toBeUndefined();
      expect(flaky).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore(); }
  });

  test('a reopened chat marks every unapplied proposal as restored; answers are stamped when they arrive', () => {
    expect(fnSrc(html, 'openSavedChat')).toContain("history.forEach((m) => { if (m.action_draft && m.action_draft.status !== 'applied') m.action_draft.restored = true; });");
    const stale = new Function(`const ACTION_DRAFT_TTL_MS=15*60*1000;${fnSrc(html, 'actionDraftStale')};return actionDraftStale;`)(); // eslint-disable-line no-new-func
    expect(stale({ status: 'draft', received_at: Date.now() })).toBe('');
    expect(stale({ status: 'applied', restored: true })).toBe('');
    expect(stale({ status: 'draft', restored: true })).toMatch(/history/);
  });

  test('an end reason longer than the stored 40 characters is never sent', () => {
    const request = new Function(`${fnSrc(html, 'contactSubrecordCreateBody')};${fnSrc(html, 'contactSubrecordActionRequest')};return contactSubrecordActionRequest;`)(); // eslint-disable-line no-new-func
    const target = { id: 21, expected_updated_at: '2026-10-20T10:00:00.000Z' };
    expect(() => request({ kind: 'contact.phone.end.v1', family: 'phone', target, changes: { end_date: '2026-10-20', end_reason: 'x'.repeat(41) } }))
      .toThrow(/40 characters/);
    expect(request({ kind: 'contact.phone.end.v1', family: 'phone', target, changes: { end_date: '2026-10-20', end_reason: 'x'.repeat(40) } }).body.end_reason).toHaveLength(40);
  });

  test('a create carries its draft_id as the idempotency key; nothing else carries one', async () => {
    const api = jest.fn().mockResolvedValue({ status: 'success', task_id: 5 });
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) }, showTask: jest.fn(),
      tasksBadgeRefresh: jest.fn(), document: { getElementById: jest.fn(() => null) } };
    const execute = actionSandbox({ P, api, saveAssistantMessage: jest.fn().mockResolvedValue() }).executeActionDraft;

    await execute(draft({ received_at: Date.now() }));
    expect(api).toHaveBeenLastCalledWith('/api/tasks', expect.any(Object), 'POST', { 'Idempotency-Key': 'd-1' });

    // A non-create cannot duplicate a record, so it sends no key — and no
    // fourth argument at all, so its call is unchanged.
    const complete = { action_draft: { draft_id: 'd-2', kind: 'task.complete.v1', status: 'draft', received_at: Date.now(),
      task: { task_id: 44, title: 'T', status: 'Pending' }, note: '' } };
    await execute(complete);
    expect(api).toHaveBeenLastCalledWith('/api/tasks/44/complete', { note: '' }, 'PATCH');
    expect(api.mock.calls[1]).toHaveLength(3);
  });

  test('a P4 replay reports no second record and an applied card never writes again', async () => {
    const api = jest.fn()
      .mockResolvedValueOnce({ status: 'success', task_id: 5, replayed: true });
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) }, showTask: jest.fn(),
      tasksBadgeRefresh: jest.fn(), document: { getElementById: jest.fn(() => null) } };
    const history = [];
    const execute = actionSandbox({ P, api, history, saveAssistantMessage: jest.fn().mockResolvedValue() }).executeActionDraft;
    const message = draft({ received_at: Date.now() });

    await execute(message);
    await execute(message);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0][3]).toEqual({ 'Idempotency-Key': 'd-1' });
    expect(message.action_draft).toMatchObject({ status: 'applied', result_task_id: 5, replayed: true });
    expect(history[0].text).toBe('Create task had already been applied to task #5; nothing was created a second time.');
  });

  test('canonical unknown and in-flight outcomes both keep the ledger claim fenced', async () => {
    const ambiguous = Object.assign(new Error('no result recorded'), {
      status: 409, body: { idempotency: { outcome: 'unknown' } } });
    const api = jest.fn().mockRejectedValue(ambiguous);
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) }, showTask: jest.fn() };
    const execute = actionSandbox({ P, api, saveAssistantMessage: jest.fn() }).executeActionDraft;
    const message = draft({ received_at: Date.now() });

    await execute(message);
    expect(message.action_draft.ambiguous_error).toMatch(/may already have been applied[\s\S]*Do not apply this card again/);
    expect(message.action_draft).not.toHaveProperty('action_error');
    expect(message.action_draft.status).toBe('draft');
    // The write is refused from then on, even if something calls it again.
    await execute(message);
    expect(api).toHaveBeenCalledTimes(1);

    const busy = Object.assign(new Error('still applying'), {
      status: 409, body: { idempotency: { outcome: 'in_flight' } } });
    const api2 = jest.fn().mockRejectedValue(busy);
    const execute2 = actionSandbox({ P, api: api2, saveAssistantMessage: jest.fn() }).executeActionDraft;
    const retryable = draft({ received_at: Date.now() });
    await execute2(retryable);
    expect(retryable.action_draft.ambiguous_error).toMatch(/Do not apply this card again/);
    expect(retryable.action_draft).not.toHaveProperty('action_error');
    await execute2(retryable);
    expect(api2).toHaveBeenCalledTimes(1);
  });

  test('the card itself removes the write control once the outcome is unknown', () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><div id="host"></div>');
    const { document } = dom.window;
    const { hydrateActionDraft, actionFamily } = actionSandbox({ document, navigator: dom.window.navigator });
    const family = actionFamily({ kind: 'task.create.v1' });
    const buttons = (host) => [...host.querySelectorAll('button')].map((b) => b.textContent);

    // Control: a fresh card offers the write.
    const fresh = draft({ received_at: Date.now() });
    const host1 = document.createElement('div');
    hydrateActionDraft(family, host1, fresh, fresh.action_draft);
    expect(buttons(host1)).toContain('Review & create task');
    expect(host1.querySelector('.action-draft-status').textContent).toBe('Proposal — not applied');

    // Ambiguous: no write control at all, and the chip says so rather than
    // claiming the proposal was not applied.
    const unknown = draft({ received_at: Date.now(), ambiguous_error: 'This may already have been applied: check the record.' });
    const host2 = document.createElement('div');
    hydrateActionDraft(family, host2, unknown, unknown.action_draft);
    expect(buttons(host2)).not.toContain('Review & create task');
    expect(buttons(host2).some((t) => /^Review &/.test(t))).toBe(false);
    expect(host2.querySelector('.action-draft-status').textContent).toBe('Outcome unknown — check the record');
    expect(host2.textContent).toContain('This may already have been applied: check the record.');
    // Copy and Discard remain: reading and dismissing are always safe.
    expect(buttons(host2)).toEqual(['Copy details', 'Discard']);
  });

  test('a refusal the server could read is reported as a refusal, not as an unknown outcome', async () => {
    // The claim succeeded, then the canonical route REFUSED with a 4xx it had
    // read. Nothing was written, so claiming it might have been would send
    // staff hunting for a record that does not exist. The claim is spent
    // either way, so the card still offers no write.
    const refusals = [
      [400, 'Task title is required'],
      [403, 'Not permitted'],
      [404, 'Task 44 not found'],
      [422, 'Event is already Completed'],
    ];
    for (const [status, message] of refusals) {
      const api = jest.fn(async (path) => {
        if (path.includes('/claim')) return { outcome: 'in_flight', claimed: true, claim_token: 'tok-1' };
        throw Object.assign(new Error(message), { status, body: { message } });
      });
      const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) }, showTask: jest.fn() };
      const execute = actionSandbox({ P, api, saveAssistantMessage: jest.fn() }).executeActionDraft;
      const message_ = draft({ received_at: Date.now() });

      await execute(message_);
      expect(message_.action_draft.refusal_error).toBe(
        `The server refused this (${message}). Nothing was written. Ask Casey to prepare the action again.`);
      expect(message_.action_draft).not.toHaveProperty('ambiguous_error');
      expect(message_.action_draft.status).toBe('draft');
      // Spent claim: no second attempt, ever.
      await execute(message_);
      expect(api.mock.calls.filter(([p]) => !p.includes('/claim'))).toHaveLength(1);
    }

    // A 409 and anything 5xx or socket-dead stay AMBIGUOUS: appointment status
    // conflicts reach the browser as 500 and the A5 stale preconditions as
    // 409, and a conflict from a route we have not audited could still have
    // written. Only a refusal we can read is certain.
    for (const status of [409, 500, 503, undefined]) {
      const api = jest.fn(async (path) => {
        if (path.includes('/claim')) return { outcome: 'in_flight', claimed: true, claim_token: 'tok-2' };
        throw Object.assign(new Error('conflict'), status ? { status } : {});
      });
      const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) }, showTask: jest.fn() };
      const execute = actionSandbox({ P, api, saveAssistantMessage: jest.fn() }).executeActionDraft;
      const message_ = draft({ received_at: Date.now() });
      await execute(message_);
      expect(message_.action_draft.ambiguous_error).toMatch(/may already have been applied/);
      expect(message_.action_draft).not.toHaveProperty('refusal_error');
    }
  });

  test('a refused card shows the refusal and no write control', () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><div></div>');
    const { document } = dom.window;
    const { hydrateActionDraft, actionFamily } = actionSandbox({ document, navigator: dom.window.navigator });
    const family = actionFamily({ kind: 'task.create.v1' });
    const refused = draft({ received_at: Date.now(), refusal_error: 'The server refused this (nope). Nothing was written. Ask Casey to prepare the action again.' });
    const host = document.createElement('div');
    hydrateActionDraft(family, host, refused, refused.action_draft);

    expect(host.querySelector('.action-draft-status').textContent).toBe('Refused — nothing written');
    expect(host.textContent).toContain('The server refused this (nope).');
    expect(host.textContent).not.toContain('may already have been applied');
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Copy details', 'Discard']);
  });

  // A18.2: the sequence step family through the SHARED engine — the function
  // pinned by the browser (a draft lying about function_name is ignored), the
  // draft_id as Idempotency-Key, a one-field receipt, and the route's
  // precondition 409 rendered as the sequence's own refusal.
  test('sequence step card: pinned function, idempotent POST, receipt, and the base-conflict refusal', async () => {
    const seqMessage = () => ({ action_draft: {
      draft_id: '247eb0a1-9f77-4de0-8f18-119665bcda0b', kind: 'sequence.step_insert.v1', status: 'draft', received_at: Date.now(),
      template: { sequence_template_id: 12, name: 'No-Show Follow-Up', type: 'no_show', active: 1, published_version: 3, has_draft: 0, active_enrollments: 2 },
      position: 2, displaces: { step_number: 2, summary: 'sms (send_sms)' },
      step: { action_type: 'sms', function_name: 'update_db', side_effect: 'external-send',
        params: { from: '2484179800', to: '{{contacts.contact_phone}}', message: 'Hi' }, timing: { type: 'immediate' } },
      timing_text: 'Immediately', timing_notes: [], sender: 'office (2484179800)',
      expected_base: { draft_version: null, step_count: 3, step_fingerprint: 'a'.repeat(64) },
    } });
    const writes = [];
    const receipts = [];
    const api = jest.fn(async (path, body, method, headers) => { writes.push({ path, body, method, headers }); return { success: true, stepId: 900, stepNumber: 2 }; });
    const ledgerApi = jest.fn(async (path, body) => {
      if (path.endsWith('/claim')) return { outcome: 'in_flight', claimed: true, claim_token: 'tok-seq' };
      receipts.push(body); return { outcome: 'applied' };
    });
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) }, ycAssistantNavigate: jest.fn().mockResolvedValue(true) };
    const sandbox = actionSandbox({ P, api, ledgerApi, saveAssistantMessage: jest.fn() });
    const m = seqMessage();
    expect(sandbox.actionFamily(m.action_draft).id).toBe('sequence_step');
    await sandbox.executeActionDraft(m);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: '/sequences/templates/12/steps', method: 'POST',
      headers: { 'Idempotency-Key': m.action_draft.draft_id } });
    expect(writes[0].body.action_config.function_name).toBe('send_sms');
    expect(writes[0].body).toMatchObject({ step_number: 2, action_type: 'sms',
      error_policy: { strategy: 'ignore', max_retries: 0, backoff_seconds: 5 }, expected_base: m.action_draft.expected_base });
    expect('condition' in writes[0].body || 'fire_guard' in writes[0].body).toBe(false);
    expect(receipts).toEqual([{ claim_token: 'tok-seq', result: { sequence_template_id: 12 } }]);
    expect(m.action_draft.status).toBe('applied');
    expect(P.ycAssistantNavigate).toHaveBeenCalledWith('automations.sequence', { id: 12 });
    // An sms card is danger-styled: it messages clients once published.
    expect(P.Swal.fire.mock.calls[0][0]).toMatchObject({ icon: 'warning', focusCancel: true });
    expect(P.Swal.fire.mock.calls[0][0].text).toMatch(/TEXTS the client on every NEW enrollment/);

    const refusedApi = jest.fn(async () => { throw Object.assign(new Error('changed'), { status: 409,
      body: { conflict: { changed: 'step_fingerprint', expected: 'a', actual: 'b' } } }); });
    const stale = seqMessage();
    await actionSandbox({ P, api: refusedApi, ledgerApi, saveAssistantMessage: jest.fn() }).executeActionDraft(stale);
    expect(stale.action_draft.refusal_error).toMatch(/^The sequence template changed since this card was prepared/);
    expect(stale.action_draft).not.toHaveProperty('ambiguous_error');
  });

  // A18.3: the sequence publish family through the SHARED engine — always
  // danger-styled, the fixed disclosures on the card, migrate_in_flight
  // pinned false, no Idempotency-Key (the publish route honours none; the
  // ledger claim is the single-flight), a one-field receipt, the deep link,
  // and the route's precondition 409 rendered as the publish's own refusal.
  test('sequence publish card: disclosures, pinned request, receipt, and the base-conflict refusal', async () => {
    const pubMessage = () => ({ action_draft: {
      draft_id: '6f1d2e3f-4a5b-4c6d-8e7f-0123456789ab', kind: 'sequence.publish.v1', status: 'draft', received_at: Date.now(),
      template: { sequence_template_id: 12, name: 'No-Show Follow-Up', type: 'no_show', active: 1 },
      publish: { from_version: 3, to_version: 4, step_count: 3 },
      classification: 'structural', structural_reasons: ['template condition changed'],
      changes: [{ step_number: null, kind: 'modified', fields: ['template_condition'] }, { step_number: 3, kind: 'added' }],
      validation_warnings: [], in_flight_count: 2, stranded_count: 1,
      starters: [{ source: 'hook', name: 'No-show hook', active: 1 }],
      effects: ['step 3: send_email — external-send: messages {{contacts.contact_email}} on every enrollment that reaches it'],
      expected_base: { draft_version: 4, step_count: 3, draft_fingerprint: 'c'.repeat(64) },
      migrate_in_flight: true,
    } });
    const writes = [];
    const receipts = [];
    const api = jest.fn(async (path, body, method, headers) => { writes.push({ path, body, method, headers }); return { success: true, published_version: 4, previous_version: 3, migrated_count: null }; });
    const ledgerApi = jest.fn(async (path, body) => {
      if (path.endsWith('/claim')) return { outcome: 'in_flight', claimed: true, claim_token: 'tok-pub' };
      receipts.push(body); return { outcome: 'applied' };
    });
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) }, ycAssistantNavigate: jest.fn().mockResolvedValue(true) };
    const sandbox = actionSandbox({ P, api, ledgerApi, saveAssistantMessage: jest.fn() });
    const m = pubMessage();
    expect(sandbox.actionFamily(m.action_draft).id).toBe('sequence_publish');
    await sandbox.executeActionDraft(m);
    expect(writes).toEqual([{ path: '/sequences/templates/12/publish', method: 'POST', headers: undefined,
      body: { migrate_in_flight: false, expected_base: { draft_version: 4, step_count: 3, draft_fingerprint: 'c'.repeat(64) } } }]);
    expect(receipts).toEqual([{ claim_token: 'tok-pub', result: { sequence_template_id: 12 } }]);
    expect(m.action_draft.status).toBe('applied');
    expect(P.ycAssistantNavigate).toHaveBeenCalledWith('automations.sequence', { id: 12 });
    const dialog = P.Swal.fire.mock.calls[0][0];
    expect(dialog).toMatchObject({ icon: 'warning', focusCancel: true, confirmButtonText: 'Publish sequence version' });
    expect(dialog.text).toContain('Class rule (sequences are stricter than workflows): content-only means ONLY an action_config change on an unchanged sms, email or task step.');
    expect(dialog.text).toContain('  template: modified (template_condition)\n  step 3: added');
    expect(dialog.text).toContain('Enrollments running on v3: 2 — publishing does NOT move them (Casey never migrates enrollments): each stays on v3 and finishes there, and no queued step is rewritten.');
    expect(dialog.text).toContain('  step 3: send_email — external-send: messages {{contacts.contact_email}} on every enrollment that reaches it');
    expect(dialog.text).toContain('THERE IS NO ROLLBACK ROUTE');

    const refusedApi = jest.fn(async () => { throw Object.assign(new Error('changed'), { status: 409,
      body: { conflict: { changed: 'draft_fingerprint', expected: 'c', actual: 'd' } } }); });
    const stale = pubMessage();
    await actionSandbox({ P, api: refusedApi, ledgerApi, saveAssistantMessage: jest.fn() }).executeActionDraft(stale);
    expect(stale.action_draft.refusal_error).toBe('The sequence template changed since this card was reviewed, so the server refused the publish — nothing was written. Ask Casey to read the template again and rebuild the proposal.');
    expect(stale.action_draft).not.toHaveProperty('ambiguous_error');
  });

  // A17.7: the workflow start card through the SHARED engine — the one
  // automation card that EXECUTES. Pinned: the click-time re-read refuses
  // before the ledger claim, the request is exactly {init_data:{}} keyed by
  // the draft_id, the receipt is the run, the applied card deep-links to the
  // EXECUTION (not the workflow — the A19.1 record-kind lesson), and every
  // outcome reads in A14's vocabulary.
  const startMessage = (over = {}) => ({ action_draft: {
    draft_id: '7a1d2e3f-4a5b-4c6d-8e7f-0123456789ab', kind: 'workflow.start.v1', status: 'draft', received_at: Date.now(),
    workflow: { workflow_id: 5, name: 'Daily Appointment Report', active: 1, version: 3, step_count: 4, has_draft: 1 },
    unset_inputs: ['day', 'source'],
    starters: [{ source: 'trigger_rule', name: 'Daily 7am', active: 1 }],
    effects: ['step 3: send_email — external-send: messages staff@4lsg.com on this run', 'step 4: webhook POST → hooks.example.com'],
    in_flight_count: 1, recent: { runs_90d: 77, avg_steps: 10.7 },
    expected: { current_version: 3 }, evidence: [],
    // Model-shaped junk that must never reach the request.
    use_draft: true, init_data: { x: 1 }, contact_id: 9,
    ...over } });
  const startReads = (over = {}) => (path) => {
    if (path !== '/workflows/5') throw new Error(`unexpected read ${path}`);
    return { success: true, workflow: { id: 5, active: 1, current_version: 3, draft_version: 4, ...(over.workflow || {}) },
      steps: over.steps || [], has_draft: over.has_draft !== undefined ? over.has_draft : true };
  };
  function runStart(message, { read = startReads(), write = async () => ({ success: true, executionId: 901, workflowId: 5, contactId: null, status: 'processing' }), confirm = true } = {}) {
    const writes = []; const gets = []; const ledger = [];
    const api = jest.fn(async (path, body, method, headers) => {
      if (method === 'GET') { gets.push(path); return read(path); }
      writes.push({ path, body, method, headers }); return write(path, body);
    });
    const ledgerApi = jest.fn(async (path, body) => { ledger.push(path.endsWith('/claim') ? 'claim' : { receipt: body }); return path.endsWith('/claim') ? { outcome: 'in_flight', claimed: true, claim_token: 'tok-start' } : { outcome: 'applied' }; });
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: confirm }) }, ycAssistantNavigate: jest.fn().mockResolvedValue(true) };
    const history = [];
    const sandbox = actionSandbox({ P, api, ledgerApi, history, saveAssistantMessage: jest.fn() });
    return sandbox.executeActionDraft(message).then(() => ({ writes, gets, ledger, P, history, sandbox }));
  }

  test('workflow start card: danger dialog, click-time re-read, ONE keyed POST of {init_data:{}}, execution receipt and deep link', async () => {
    const m = startMessage();
    const { writes, gets, ledger, P, history, sandbox } = await runStart(m);
    expect(sandbox.actionFamily(m.action_draft).id).toBe('workflow_start');
    expect(gets).toEqual(['/workflows/5']);
    expect(writes).toEqual([{ path: '/workflows/5/start', method: 'POST', body: { init_data: {} },
      headers: { 'Idempotency-Key': m.action_draft.draft_id } }]);
    expect(ledger).toEqual(['claim', { receipt: { claim_token: 'tok-start', result: { execution_id: 901 } } }]);
    expect(m.action_draft).toMatchObject({ status: 'applied', result_started_execution_id: 901 });
    expect(history[0].text).toBe('Started "Daily Appointment Report" (workflow #5, v3): execution #901.');
    expect(P.ycAssistantNavigate).toHaveBeenCalledWith('automations.workflow', { id: 901, record: 'execution' });
    const dialog = P.Swal.fire.mock.calls[0][0];
    expect(dialog).toMatchObject({ icon: 'warning', focusCancel: true, confirmButtonText: 'Start workflow run' });
    expect(dialog.text).toMatch(/^This starts ONE run of "Daily Appointment Report" NOW\. It cannot be undone/);
    expect(dialog.text).toContain('runs published v3 (4 steps); it also has an unpublished draft — this start runs v3, NOT the draft');
    expect(dialog.text).toContain('Input: NONE — no contact and no variables are sent with this start.');
    expect(dialog.text).toContain('Blank inputs: this version reads {{day}}, {{source}}, which no step sets — on this run each resolves BLANK.');
    expect(dialog.text).toContain('  trigger_rule: "Daily 7am"');
    expect(dialog.text).toContain('  step 3: send_email — external-send: messages staff@4lsg.com on this run');
    expect(dialog.text).toContain('Runs in flight: 1 already running (any version). Recent volume: 77 run(s) in 90 days, about 10.7 steps each.');
    expect(dialog.text).toContain('A start is immediate and irreversible fan-out');
  });

  test('workflow start card: a deactivated workflow, a new published version, or standard code refuses BEFORE the claim', async () => {
    const cases = [
      [startReads({ workflow: { active: 0 } }), 'The workflow was deactivated since this card was prepared. Nothing was started.'],
      [startReads({ workflow: { current_version: 4, draft_version: null } }), 'The workflow\'s published version changed (v3 → v4) since this card was prepared. Nothing was started.'],
      [startReads({ has_draft: false, workflow: { draft_version: null },
        steps: [{ step_number: 1, type: 'custom_code', config: { code: '1;' } }] }), 'The published version now has a standard-mode code step. Nothing was started.'],
      [() => ({ success: true }), 'The workflow no longer exists. Nothing was started.'],
    ];
    for (const [read, why] of cases) {
      const m = startMessage();
      const { writes, ledger } = await runStart(m, { read });
      expect({ why, writes, ledger }).toEqual({ why, writes: [], ledger: [] });
      expect(m.action_draft.refusal_error).toContain(why);
    }
    // Safe-mode code on the published steps passes the re-read.
    const safe = startMessage();
    const ok = await runStart(safe, { read: startReads({ has_draft: false, workflow: { draft_version: null },
      steps: [{ step_number: 1, type: 'custom_code', config: JSON.stringify({ code: '1;', code_mode: 'safe' }) }] }) });
    expect(ok.writes).toHaveLength(1);
  });

  test('workflow start card: refusal, unknown and replay outcomes read in A14\'s vocabulary', async () => {
    // A plain 409 (audited pre-INSERT) is a refusal — nothing started.
    const refused = startMessage();
    await runStart(refused, { write: async () => { throw Object.assign(new Error('Workflow is inactive'), { status: 409, body: { error: 'Workflow is inactive' } }); } });
    expect(refused.action_draft.refusal_error).toBe('Refused — nothing started (Workflow is inactive). Ask Casey to prepare the start again.');
    expect(refused.action_draft).not.toHaveProperty('ambiguous_error');
    // An idempotency 409, a 5xx and a dead socket are UNKNOWN — the write control goes.
    for (const err of [
      Object.assign(new Error('The same request is still being applied.'), { status: 409, body: { idempotency: { outcome: 'in_flight' } } }),
      Object.assign(new Error('Failed to start workflow'), { status: 500, body: {} }),
      new Error('Failed to fetch'),
    ]) {
      const m = startMessage();
      await runStart(m, { write: async () => { throw err; } });
      expect(m.action_draft.ambiguous_error).toMatch(/^Outcome unknown — the run may or may not have started .*Check the workflow's executions before starting again\. Do not apply this card again\.$/);
      expect(m.action_draft).not.toHaveProperty('refusal_error');
    }
    // A replay names the first run and says nothing started twice.
    const replay = startMessage();
    const { history } = await runStart(replay, { write: async () => ({ success: true, executionId: 900, workflowId: 5, replayed: true }) });
    expect(history[0].text).toBe('This start of "Daily Appointment Report" had already run as execution #900; nothing was started a second time.');
    expect(replay.action_draft.result_started_execution_id).toBe(900);
    // Cancel starts nothing and reads nothing.
    const cancelled = await runStart(startMessage(), { confirm: false });
    expect([cancelled.writes, cancelled.gets, cancelled.ledger]).toEqual([[], [], []]);
  });

  // A18.4b: the sequence enroll card through the SHARED engine. Pinned: the
  // click-time re-read (template + the contact's active enrollments) refuses
  // before the ledger claim, the request is exactly {contact_id, template_id,
  // trigger_data:{}} keyed by the draft_id, the receipt is the enrollment, the
  // applied card deep-links to the ENROLLMENT, and the route's coded outcomes
  // read in A14's vocabulary through the family's knownOutcome.
  const enrollMessage = (over = {}) => ({ action_draft: {
    draft_id: '8b1d2e3f-4a5b-4c6d-8e7f-0123456789ab', kind: 'sequence.enroll.v1', status: 'draft', received_at: Date.now(),
    template: { sequence_template_id: 12, name: 'Lead Drip', type: 'lead', version: 3, step_count: 2, has_draft: 1 },
    contact: { contact_id: 77, contact_name: 'Dana Client' },
    verdict: 'would_proceed', first_step: 1, skipped_leading: [], stall_step: null, placeholder_at_steps: [],
    send_steps: 1, steps_truncated: 0,
    steps: [
      { step_number: 1, action_type: 'sms', function_name: 'send_sms', sends: true, timing_text: 'Immediately (about 5 seconds after the previous step, or after enrollment for step 1)',
        placement: 'places', when_text: 'Wed, Oct 28, 2026, 3:05 PM firm time', to: '3135551234', from: '{{users.default_phone}}', message: 'Hi Dana',
        unresolved: ['{{users.default_phone}}'] },
      { step_number: 2, action_type: 'task', function_name: 'create_task', sends: false, timing_text: '2 days after the previous step (or after enrollment for step 1)',
        placement: 'places', when_text: 'Fri, Oct 30, 2026, 3:05 PM firm time' },
    ],
    effects: ['step 1: send_sms — external-send: messages {{contacts.contact_phone}} when this enrollment reaches it'],
    starters: [{ source: 'hook', name: 'Lead hook', active: 1 }],
    active_enrollments: 4, expected: { current_version: 3 }, evidence: [],
    // Model-shaped junk that must never reach the request.
    trigger_data: { appt_id: 5 }, template_type: 'lead', appt_id: 5,
    ...over } });
  const enrollReads = (over = {}) => (path) => {
    if (path === '/sequences/templates/12') {
      return { success: true, template: { id: 12, active: 1, current_version: 3, draft_version: 4, ...(over.template || {}) }, steps: [], has_draft: true };
    }
    if (path === '/sequences/enrollments?contact_id=77&status=active&limit=100') {
      const rows = over.rows || [];
      return { success: true, enrollments: rows, pagination: { page: 1, limit: 100, total: rows.length, totalPages: 1 } };
    }
    throw new Error(`unexpected read ${path}`);
  };
  function runEnroll(message, { read = enrollReads(), write = async () => ({ success: true, enrollmentId: 812, templateName: 'Lead Drip', totalSteps: 2, firstJobScheduledAt: '2026-10-28T19:05:05.000Z' }), confirm = true } = {}) {
    const writes = []; const gets = []; const ledger = [];
    const api = jest.fn(async (path, body, method, headers) => {
      if (method === 'GET') { gets.push(path); return read(path); }
      writes.push({ path, body, method, headers }); return write(path, body);
    });
    const ledgerApi = jest.fn(async (path, body) => { ledger.push(path.endsWith('/claim') ? 'claim' : { receipt: body }); return path.endsWith('/claim') ? { outcome: 'in_flight', claimed: true, claim_token: 'tok-enroll' } : { outcome: 'applied' }; });
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: confirm }) }, ycAssistantNavigate: jest.fn().mockResolvedValue(true) };
    const history = [];
    const sandbox = actionSandbox({ P, api, ledgerApi, history, saveAssistantMessage: jest.fn() });
    return sandbox.executeActionDraft(message).then(() => ({ writes, gets, ledger, P, history, sandbox }));
  }
  const coded = (status, body, message = 'Contact 77 is already enrolled') => Object.assign(new Error(message), { status, body });

  test('sequence enroll card: danger dialog, click-time re-read, ONE keyed POST, enrollment receipt and deep link', async () => {
    const m = enrollMessage();
    const { writes, gets, ledger, P, history, sandbox } = await runEnroll(m);
    expect(sandbox.actionFamily(m.action_draft).id).toBe('sequence_enroll');
    expect(gets).toEqual(['/sequences/templates/12', '/sequences/enrollments?contact_id=77&status=active&limit=100']);
    expect(writes).toEqual([{ path: '/sequences/enroll', method: 'POST', body: { contact_id: 77, template_id: 12, trigger_data: {} },
      headers: { 'Idempotency-Key': m.action_draft.draft_id } }]);
    expect(ledger).toEqual(['claim', { receipt: { claim_token: 'tok-enroll', result: { enrollment_id: 812 } } }]);
    expect(m.action_draft).toMatchObject({ status: 'applied', result_enrollment_id: 812 });
    expect(history[0].text).toMatch(/^Enrolled Dana Client in "Lead Drip" \(template #12, v3\): enrollment #812 — its first step is scheduled for /);
    expect(P.ycAssistantNavigate).toHaveBeenCalledWith('automations.sequence', { id: 812, record: 'enrollment' });
    const dialog = P.Swal.fire.mock.calls[0][0];
    expect(dialog).toMatchObject({ icon: 'warning', focusCancel: true, confirmButtonText: 'Enroll contact in sequence' });
    expect(dialog.text).toMatch(/^This enrolls Dana Client in "Lead Drip" NOW\. It cannot be undone/);
    expect(dialog.text).toContain('runs published v3 (2 steps); it also has an unpublished draft — this enrollment runs v3, NOT the draft');
    expect(dialog.text).toContain('Contact: Dana Client (#77)');
    expect(dialog.text).toContain('Trigger data: NONE — a contact-scoped enrollment');
    expect(dialog.text).toContain('Placement: the first step to run is step 1.');
    expect(dialog.text).toContain('  step 1: sms (send_sms) — MESSAGES THE CLIENT — Immediately (about 5 seconds after the previous step, or after enrollment for step 1); runs Wed, Oct 28, 2026, 3:05 PM firm time; to 3135551234 from {{users.default_phone}}; "Hi Dana"; UNRESOLVED for this enrollment — left in the text as written: {{users.default_phone}}');
    expect(dialog.text).toContain('Sends: 1 step text or email the client');
    expect(dialog.text).toContain('  hook: "Lead hook"');
    expect(dialog.text).toContain('An enrollment is immediate fan-out');
  });

  test('sequence enroll card: stall, skipped steps, nothing placeable and a failing template condition are all on the card', async () => {
    const m = enrollMessage({ first_step: null, stall_step: 3, placeholder_at_steps: [3], skipped_leading: [1, 2],
      verdict: 'would_cancel_at_first_step (template condition failed)' });
    const { P } = await runEnroll(m, { confirm: false });
    const text = P.Swal.fire.mock.calls[0][0].text;
    expect(text).toContain('Template condition: would_cancel_at_first_step (template condition failed) — the enrollment is created, then stopped at its first step.');
    expect(text).toContain('Placement: NO step can be scheduled — the enrollment completes at once and sends nothing.');
    expect(text).toContain("STALL: step 3's timing cannot be computed for this enrollment — the enrollment stops there");
    expect(text).toContain('Placeholder dates: step 3 use a {{placeholder}} as a fixed delay.at');
    const skipped = enrollMessage({ skipped_leading: [1, 2], first_step: 3 });
    const r = await runEnroll(skipped, { confirm: false });
    expect(r.P.Swal.fire.mock.calls[0][0].text).toContain('Placement: the first step to run is step 3 — steps 1, 2 SKIPPED (window already passed).');
  });

  test('sequence enroll card: a deactivated template, a new published version, or an existing enrollment refuses BEFORE the claim', async () => {
    const cases = [
      [enrollReads({ template: { active: 0 } }), 'The sequence template was deactivated since this card was prepared. Nothing was enrolled.'],
      [enrollReads({ template: { current_version: 4, draft_version: null } }), 'The template\'s published version changed (v3 → v4) since this card was prepared. Nothing was enrolled.'],
      [enrollReads({ rows: [{ id: 5501, contact_id: 77, template_id: 12, appt_id: null, signing_request_id: null, status: 'active' }] }),
        'Dana Client is already enrolled in this sequence (active enrollment #5501). Nothing was enrolled.'],
      [(path) => (path === '/sequences/templates/12' ? { success: true } : enrollReads()(path)), 'The sequence template no longer exists. Nothing was enrolled.'],
    ];
    for (const [read, why] of cases) {
      const m = enrollMessage();
      const { writes, ledger } = await runEnroll(m, { read });
      expect({ why, writes, ledger }).toEqual({ why, writes: [], ledger: [] });
      expect(m.action_draft.refusal_error).toContain(why);
    }
    // An appointment-scoped enrollment in the same template is a different identity.
    const ok = await runEnroll(enrollMessage(), { read: enrollReads({ rows: [{ id: 5502, contact_id: 77, template_id: 12, appt_id: 900, signing_request_id: null, status: 'active' }] }) });
    expect(ok.writes).toHaveLength(1);
  });

  test('sequence enroll card: coded refusals, the known SCHEDULING_FAILED failure, unknown and replay outcomes', async () => {
    const refusals = [
      [coded(409, { error: 'Failed to enroll contact', code: 'ALREADY_ENROLLED', enrollment_id: 5501 }),
        'Refused — nothing enrolled: the contact is already enrolled in this sequence (active enrollment #5501).', 'Refused — nothing enrolled'],
      [coded(409, { error: 'Failed to enroll contact', code: 'NEVER_PUBLISHED' }, 'never been published'),
        'Refused — nothing enrolled (never been published): the template changed since this card was reviewed. Ask Casey to prepare the enrollment again.', 'Refused — nothing enrolled'],
      [coded(409, { error: 'Failed to enroll contact', code: 'EMPTY_SEQUENCE' }, 'has no steps'),
        'Refused — nothing enrolled (has no steps): the template changed since this card was reviewed. Ask Casey to prepare the enrollment again.', 'Refused — nothing enrolled'],
      [coded(503, { error: 'Failed to enroll contact', code: 'ENROLL_BUSY' }, 'lock not granted'),
        'Refused — nothing enrolled: another enrollment of this contact in this sequence was in progress at that moment. Wait a moment, then ask Casey to prepare it again.', 'Refused — nothing enrolled'],
      [coded(500, { error: 'Failed to enroll contact', code: 'SCHEDULING_FAILED', enrollment_id: 813 }, 'Enrollment #813 was created but its first step could not be scheduled'),
        'Failed — enrollment #813 was created, but its first step could not be scheduled, so no step is scheduled and nothing will send (Enrollment #813 was created but its first step could not be scheduled). Fix the sequence\'s timing in the sequence editor before enrolling again.',
        'Failed — nothing will send'],
      // A plain 4xx the route raised before the engine (400 / 404) is the generic refusal.
      [coded(404, { error: 'Template not found' }, 'Template not found'),
        'Refused — nothing enrolled (Template not found). Ask Casey to prepare the enrollment again.', 'Refused — nothing enrolled'],
    ];
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><div></div>');
    for (const [err, text, chip] of refusals) {
      const m = enrollMessage();
      const { sandbox } = await runEnroll(m, { write: async () => { throw err; } });
      expect(m.action_draft.refusal_error).toBe(text);
      expect(m.action_draft).not.toHaveProperty('ambiguous_error');
      const box = actionSandbox({ document: dom.window.document, navigator: dom.window.navigator });
      const host = dom.window.document.createElement('div');
      box.hydrateActionDraft(sandbox.actionFamily(m.action_draft), host, m, m.action_draft);
      expect(host.querySelector('.action-draft-status').textContent).toBe(chip);
      expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Copy details', 'Discard']);
    }
    // An idempotency 409, an uncoded 409 / 5xx and a dead socket are UNKNOWN — the write control goes.
    for (const err of [
      coded(409, { idempotency: { outcome: 'in_flight' } }, 'The same request is still being applied.'),
      coded(409, { code: 'ALREADY_ENROLLED', idempotency: { outcome: 'in_flight' } }, 'still applying'),
      coded(409, { error: 'conflict' }, 'conflict'),
      coded(500, { error: 'Failed to enroll contact', message: 'Sequence template #12 is inactive' }, 'Sequence template #12 is inactive'),
      coded(503, {}, 'Service Unavailable'),
      new Error('Failed to fetch'),
    ]) {
      const m = enrollMessage();
      await runEnroll(m, { write: async () => { throw err; } });
      expect(m.action_draft.ambiguous_error).toMatch(/^Outcome unknown — the contact may or may not have been enrolled .*Check the sequence's enrollments before enrolling again\. Do not apply this card again\.$/);
      expect(m.action_draft).not.toHaveProperty('refusal_error');
    }
    // A replay names the first enrollment and says nothing enrolled twice.
    const replay = enrollMessage();
    const { history } = await runEnroll(replay, { write: async () => ({ success: true, enrollmentId: 810, firstJobScheduledAt: null, replayed: true }) });
    expect(history[0].text).toBe('This enrollment of Dana Client in "Lead Drip" had already been made as enrollment #810; nothing was enrolled a second time.');
    expect(replay.action_draft.result_enrollment_id).toBe(810);
    // A success that placed no step says so.
    const none = enrollMessage();
    const r = await runEnroll(none, { write: async () => ({ success: true, enrollmentId: 811, firstJobScheduledAt: null }) });
    expect(r.history[0].text).toBe('Enrolled Dana Client in "Lead Drip" (template #12, v3): enrollment #811 — no step could be scheduled, so it completed at once and sends nothing.');
    // Cancel enrolls nothing and reads nothing.
    const cancelled = await runEnroll(enrollMessage(), { confirm: false });
    expect([cancelled.writes, cancelled.gets, cancelled.ledger]).toEqual([[], [], []]);
    dom.window.close();
  });

  test('sequence enroll card: a reopened card restores from the ledger, and an applied card offers only the enrollment', () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><div></div>');
    const box = actionSandbox({ document: dom.window.document, navigator: dom.window.navigator });
    const m = enrollMessage({ refusal_error: 'stale', refusal_status: 'Failed — nothing will send' });
    box.applyActionResults([m], [{ draft_id: m.action_draft.draft_id, kind: 'sequence.enroll.v1', outcome: 'applied', result: { enrollment_id: 812 } }]);
    expect(m.action_draft).toMatchObject({ status: 'applied', result_enrollment_id: 812 });
    expect(m.action_draft).not.toHaveProperty('refusal_status');
    const host = dom.window.document.createElement('div');
    box.hydrateActionDraft(box.actionFamily(m.action_draft), host, m, m.action_draft);
    expect(host.querySelector('.action-draft-status').textContent).toBe('Enrolled — enrollment #812');
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Open enrollment #812', 'Copy details']);
    dom.window.close();
  });

  // A6: the relation and role cards through the SHARED engine. Pinned: the
  // click-time re-read through the native GETs refuses BEFORE the ledger
  // claim; each request is exactly the fixed route/body (no Idempotency-Key —
  // these routes take none; one claim per draft + the routes' UNIQUE keys);
  // the receipt is the relation / role row; a 4xx is a refusal; the applied
  // card opens the contact.
  const relDraft = (over = {}) => ({ action_draft: {
    draft_id: '6a6a6a6a-1b2c-4d3e-8f40-123456789abc', kind: 'contact.relation.create.v1', status: 'draft', received_at: Date.now(),
    relation: { type_code: 'parent_child', forward_label: 'Parent of', reverse_label: 'Child of', is_symmetric: false,
      contact_a: { contact_id: 77, contact_name: 'Dana Client', contact_kind: 'person' }, contact_b: { contact_id: 78, contact_name: 'Sam Client', contact_kind: 'person' } },
    fields: { status: 'adopted', start_date: '2015-01-02', notes: 'n' }, evidence: [],
    // Model-shaped junk that must never reach a request.
    active: 0, end_date: '2020-01-01', created_by: 1, contact_id: 99,
    ...over } });
  const relUpdateDraft = (over = {}) => relDraft({ kind: 'contact.relation.update.v1',
    relation: { relation_id: 44, type_code: 'spouse', forward_label: 'Spouse of', reverse_label: 'Spouse of', is_symmetric: true, type_retired: false,
      contact_a: { contact_id: 77, contact_name: 'Dana Client' }, contact_b: { contact_id: 78, contact_name: 'Sam Client' } },
    current: { status: '', start_date: '2010-06-12', notes: 'old' }, changes: { status: 'separated', notes: '', type_code: 'x', end_date: '2020-01-01' },
    expected: { updated_at: '2026-10-01T12:00:00.000Z' }, fields: undefined, ...over });
  const roleDraft = (over = {}) => ({ action_draft: {
    draft_id: '7b7b7b7b-1b2c-4d3e-8f40-123456789abc', kind: 'contact.role.create.v1', status: 'draft', received_at: Date.now(),
    contact: { contact_id: 77, contact_name: 'Dana Client' },
    role: { role_code: 'trustee', label: 'Trustee', fields: [{ key: 'chapter', label: 'Chapters', type: 'multi_select', required: true },
      { key: 'zoom_link', label: '341 Zoom link', type: 'url', required: false }] },
    attrs: { chapter: [7, 13] }, effects: ['Trustee roster: the contact is on the panel-trustee roster for chapter(s) 7, 13 — case trustee matching reads it.'],
    evidence: [], active: 0, sort_order: 4, ...over } });
  const roleUpdateDraft = (over = {}) => roleDraft({ kind: 'contact.role.update.v1',
    role: { role_id: 31, role_code: 'trustee', label: 'Trustee', fields: [{ key: 'chapter', label: 'Chapters', type: 'multi_select', required: true }] },
    current_attrs: { chapter: [7, 13], legacy: 'x' }, attrs: { chapter: [13] }, dropped_keys: ['legacy'],
    expected: { attrs: { legacy: 'x', chapter: [7, 13] } }, ...over });
  const RELATION_ROW = { id: 44, type_code: 'spouse', contact_a_id: 77, contact_b_id: 78, active: 1, status: '', start_date: '2010-06-12T00:00:00.000Z',
    end_date: null, notes: 'old', updated_at: '2026-10-01T12:00:00.000Z' };
  const relReads = (over = {}) => (path) => {
    if (over.gone) { throw Object.assign(new Error('Contact not found'), { status: 404 }); }
    if (/^\/api\/contacts\/77\/relations\?type_code=(parent_child|spouse)&limit=100$/.test(path)) {
      const rows = over.rows || [];
      return { status: 'success', relations: rows, total: over.total != null ? over.total : rows.length };
    }
    if (path === '/api/contacts/77/roles') return { status: 'success', roles: over.roles || [] };
    throw new Error(`unexpected read ${path}`);
  };
  function runRel(message, { read = relReads(), write = async () => ({ status: 'success', relation: { id: 501 } }), confirm = true } = {}) {
    const writes = []; const gets = []; const ledger = [];
    const api = jest.fn(async (path, body, method, headers) => {
      if (method === 'GET') { gets.push(path); return read(path); }
      writes.push({ path, body, method, headers }); return write(path, body);
    });
    const ledgerApi = jest.fn(async (path, body) => { ledger.push(path.endsWith('/claim') ? 'claim' : { receipt: body }); return path.endsWith('/claim') ? { outcome: 'in_flight', claimed: true, claim_token: 'tok-a6' } : { outcome: 'applied' }; });
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: confirm }) } };
    const history = []; const openEntity = jest.fn();
    const sandbox = actionSandbox({ P, api, ledgerApi, history, openEntity, saveAssistantMessage: jest.fn() });
    return sandbox.executeActionDraft(message).then(() => ({ writes, gets, ledger, P, history, openEntity, sandbox }));
  }

  test('relationship create: plain-language card, click-time re-read, ONE fixed POST without a key, relation receipt, opens contact A', async () => {
    const m = relDraft();
    const { writes, gets, ledger, P, history, openEntity, sandbox } = await runRel(m);
    expect(sandbox.actionFamily(m.action_draft).id).toBe('contact_relation');
    expect(gets).toEqual(['/api/contacts/77/relations?type_code=parent_child&limit=100']);
    expect(writes).toEqual([{ path: '/api/contact-relations', method: 'POST', headers: undefined,
      body: { contact_a_id: 77, contact_b_id: 78, type_code: 'parent_child', status: 'adopted', start_date: '2015-01-02', notes: 'n' } }]);
    expect(ledger).toEqual(['claim', { receipt: { claim_token: 'tok-a6', result: { relation_id: 501 } } }]);
    expect(m.action_draft).toMatchObject({ status: 'applied', result_relation_id: 501 });
    expect(history[0].text).toBe('Add relationship applied to relationship #501.');
    expect(history[0].entities).toEqual([{ kind: 'contact', id: '77', label: 'Dana Client' }]);
    expect(openEntity).toHaveBeenCalledWith('contact', 77, 'Dana Client');
    const dialog = P.Swal.fire.mock.calls[0][0];
    expect(dialog).toMatchObject({ icon: 'question', confirmButtonText: 'Add relationship' });
    expect(dialog.text).toContain("On Dana Client's record: \"Parent of Sam Client\"");
    expect(dialog.text).toContain("On Sam Client's record: \"Child of Dana Client\"");
    expect(dialog.text).toContain('Type: parent_child — one-way (the two records read differently)');
    expect(dialog.text).toContain('Contact B: Sam Client (#78, person)');
    expect(dialog.text).toContain('Created as: active, with no end date.');
  });

  test('relationship update: only the reviewed status/start_date/notes reach the PATCH; a stale, ended or vanished relation refuses BEFORE the claim', async () => {
    const m = relUpdateDraft();
    const ok = await runRel(m, { read: relReads({ rows: [RELATION_ROW] }), write: async () => ({ status: 'success', relation: { id: 44 } }) });
    expect(ok.writes).toEqual([{ path: '/api/contact-relations/44', method: 'PATCH', headers: undefined, body: { status: 'separated', notes: '' } }]);
    expect(m.action_draft.result_relation_id).toBe(44);
    const text = ok.P.Swal.fire.mock.calls[0][0].text;
    expect(text).toContain('Relation: #44');
    expect(text).toContain('New status: separated');
    expect(text).toContain('Stays: active — the type, both contacts and the end fields are unchanged.');
    const cases = [
      [relReads({ rows: [{ ...RELATION_ROW, updated_at: '2026-10-02T09:00:00.000Z' }] }), 'Relation #44 was edited since this card was prepared. Nothing was written.'],
      [relReads({ rows: [{ ...RELATION_ROW, notes: 'edited in the same second' }] }), 'Relation #44 was edited since this card was prepared.'],
      [relReads({ rows: [{ ...RELATION_ROW, active: 0 }] }), 'Relation #44 was ended or deactivated since this card was prepared. Nothing was written.'],
      [relReads({ rows: [{ ...RELATION_ROW, end_date: '2026-10-05T00:00:00.000Z' }] }), 'Relation #44 was ended or deactivated'],
      [relReads({ rows: [] }), 'Relation #44 no longer exists, or its type changed, since this card was prepared. Nothing was written.'],
      [relReads({ gone: true }), 'Dana Client (contact #77) no longer exists. Nothing was written.'],
    ];
    for (const [read, why] of cases) {
      const d = relUpdateDraft();
      const r = await runRel(d, { read });
      expect({ why, writes: r.writes, ledger: r.ledger }).toEqual({ why, writes: [], ledger: [] });
      expect(d.action_draft.refusal_error).toContain(why);
    }
    // A truncated list cannot prove freshness: nothing claimed, the card stays retryable.
    const t = relUpdateDraft();
    const tr = await runRel(t, { read: relReads({ rows: [RELATION_ROW], total: 101 }) });
    expect([tr.writes, tr.ledger]).toEqual([[], []]);
    expect(t.action_draft.action_error).toMatch(/^Could not re-check the record before applying \(the contact's relationships could not be read in full\)/);
  });

  test('relationship create: a pair that became related (either direction) refuses before the claim; a 400 from the route is a refusal', async () => {
    for (const row of [{ id: 9, type_code: 'parent_child', contact_a_id: 77, contact_b_id: 78 }, { id: 9, type_code: 'parent_child', contact_a_id: 78, contact_b_id: 77 }]) {
      const d = relDraft();
      const r = await runRel(d, { read: relReads({ rows: [row] }) });
      expect([r.writes, r.ledger]).toEqual([[], []]);
      expect(d.action_draft.refusal_error).toBe('Dana Client and Sam Client now have a parent_child relation (#9), added since this card was prepared. Nothing was written.');
    }
    const other = await runRel(relDraft(), { read: relReads({ rows: [{ id: 9, type_code: 'parent_child', contact_a_id: 77, contact_b_id: 90 }] }) });
    expect(other.writes).toHaveLength(1);
    const d = relDraft();
    await runRel(d, { write: async () => { throw Object.assign(new Error('This relation already exists (same A, B, and type)'), { status: 400, body: { status: 'error' } }); } });
    expect(d.action_draft.refusal_error).toBe('Refused — nothing written (This relation already exists (same A, B, and type)). Ask Casey to prepare it again.');
    expect(d.action_draft).not.toHaveProperty('ambiguous_error');
    const u = relDraft();
    await runRel(u, { write: async () => { throw Object.assign(new Error('Internal'), { status: 500 }); } });
    expect(u.action_draft.ambiguous_error).toMatch(/may already have been applied/);
    const cancelled = await runRel(relDraft(), { confirm: false });
    expect([cancelled.writes, cancelled.gets, cancelled.ledger]).toEqual([[], [], []]);
  });

  test('role create / update: fixed bodies, held-role and stale-attrs refusals, key-order-insensitive freshness, role receipt', async () => {
    const m = roleDraft();
    const r = await runRel(m, { write: async () => ({ status: 'success', id: 61 }) });
    expect(r.sandbox.actionFamily(m.action_draft).id).toBe('contact_role');
    expect(r.gets).toEqual(['/api/contacts/77/roles']);
    expect(r.writes).toEqual([{ path: '/api/contacts/77/roles', method: 'POST', headers: undefined, body: { role: 'trustee', attrs: { chapter: [7, 13] } } }]);
    expect(r.ledger).toEqual(['claim', { receipt: { claim_token: 'tok-a6', result: { role_id: 61 } } }]);
    const text = r.P.Swal.fire.mock.calls[0][0].text;
    expect(text).toContain('Role: Trustee (trustee)');
    expect(text).toContain('Chapters (required): 7, 13');
    expect(text).toContain('341 Zoom link: —');
    expect(text).toContain('Effect: Trustee roster: the contact is on the panel-trustee roster for chapter(s) 7, 13');
    for (const [roles, why] of [[[{ id: 5, role: 'Trustee', active: 1 }], 'Dana Client now has a trustee role row (#5), added since this card was prepared. Nothing was written.'],
      [[{ id: 6, role: 'trustee', active: 0 }], 'Dana Client now has a trustee role row (#6, inactive), added since this card was prepared.']]) {
      const d = roleDraft();
      const x = await runRel(d, { read: relReads({ roles }) });
      expect([x.writes, x.ledger]).toEqual([[], []]);
      expect(d.action_draft.refusal_error).toContain(why);
    }
    // Update: the stored attrs come back in another key order — still fresh.
    const u = roleUpdateDraft();
    const ok = await runRel(u, { read: relReads({ roles: [{ id: 31, role: 'trustee', active: 1, attrs: { chapter: [7, 13], legacy: 'x' } }] }), write: async () => ({ status: 'success', id: 31 }) });
    expect(ok.writes).toEqual([{ path: '/api/contacts/77/roles/31', method: 'PATCH', headers: undefined, body: { attrs: { chapter: [13] } } }]);
    expect(ok.P.Swal.fire.mock.calls[0][0].text).toContain('Removed attributes: legacy (not in the new set, so they are deleted).');
    for (const [roles, why] of [[[{ id: 31, role: 'trustee', active: 1, attrs: { chapter: [7] } }], "Role row #31's attributes were edited since this card was prepared."],
      [[{ id: 31, role: 'trustee', active: 0, attrs: { chapter: [7, 13], legacy: 'x' } }], 'Role row #31 was deactivated since this card was prepared.'],
      [[], 'Role row #31 is no longer on Dana Client. Nothing was written.']]) {
      const d = roleUpdateDraft();
      const x = await runRel(d, { read: relReads({ roles }) });
      expect([x.writes, x.ledger]).toEqual([[], []]);
      expect(d.action_draft.refusal_error).toContain(why);
    }
    // An AMBIGUOUS judge-suffix effect danger-styles the dialog.
    const j = roleDraft({ role: { role_code: 'judge', label: 'Judge', fields: [] }, attrs: { judge_3: 'abc' },
      effects: ['Judge resolution: x', 'AMBIGUOUS SUFFIX: Hon. Other (#5) already carries judge suffix "abc"'] });
    const jr = await runRel(j, { confirm: false });
    expect(jr.P.Swal.fire.mock.calls[0][0]).toMatchObject({ icon: 'warning', focusCancel: true });
  });

  test('reopened relation / role cards restore from the ledger and offer only the contact', () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><div></div>');
    const box = actionSandbox({ document: dom.window.document, navigator: dom.window.navigator });
    for (const [m, field, id, chip] of [[relDraft(), 'relation_id', 501, 'Applied — relationship #501'], [roleDraft(), 'role_id', 61, 'Applied — role row #61']]) {
      box.applyActionResults([m], [{ draft_id: m.action_draft.draft_id, kind: m.action_draft.kind, outcome: 'applied', result: { [field]: id } }]);
      expect(m.action_draft.status).toBe('applied');
      const host = dom.window.document.createElement('div');
      box.hydrateActionDraft(box.actionFamily(m.action_draft), host, m, m.action_draft);
      expect(host.querySelector('.action-draft-status').textContent).toBe(chip);
      expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Open Dana Client', 'Copy details']);
    }
    // Two families, distinct applied keys, the four A6 kinds and nothing else.
    const rel = box.actionFamily({ kind: 'contact.relation.update.v1' }); const role = box.actionFamily({ kind: 'contact.role.update.v1' });
    expect([[...rel.kinds], [...role.kinds]]).toEqual([['contact.relation.create.v1', 'contact.relation.update.v1'], ['contact.role.create.v1', 'contact.role.update.v1']]);
    expect([rel.appliedKey, role.appliedKey, rel.idField, role.idField]).toEqual(['result_relation_id', 'result_role_id', 'relation_id', 'role_id']);
    for (const kind of ['contact.relation.end.v1', 'contact.relation.delete.v1', 'contact.role.remove.v1']) expect(box.actionFamily({ kind })).toBe(null);
    dom.window.close();
  });

  // A20.2 / A20.3: the ingest rule family through the SHARED engine. The
  // click-time precheck re-reads the rule through the editor's GET and
  // refuses BEFORE the claim when the edit stamp moved; the route's 409
  // (body.conflict) renders as the rule's own refusal; a removal's 204 is a
  // confirmed write whose receipt is the parent rule; an ACTIVE rule's edit is
  // danger-styled; create pins active:0 and sends the draft_id as
  // Idempotency-Key.
  test('ingest rule cards: precheck refusal, idempotent inactive create, 204 removal receipt, base-conflict refusal', async () => {
    const STAMP = '2026-10-27T10:00:00.123Z';
    const removal = () => ({ action_draft: {
      draft_id: '5c1d2e3f-4a5b-4c6d-8e7f-0123456789ab', kind: 'ingest_rule.action_remove.v1', status: 'draft', received_at: Date.now(),
      channel: 'email', rule: { channel: 'email', rule_id: 12, name: 'Court notices', active: 1 }, live: 1,
      live_text: 'LIVE: this rule is ACTIVE — the change applies to the very next matching email', revert_text: 'change log',
      target: { rule_action_id: 41, action_type: 'http', name: 'Relay', active: 1, config: '{}' },
      expected_base: { definition_updated_at: STAMP } } });
    const ledgerCalls = [];
    const ledgerApi = jest.fn(async (path, body) => {
      ledgerCalls.push(path);
      if (path.endsWith('/claim')) return { outcome: 'in_flight', claimed: true, claim_token: 'tok-ing' };
      return { outcome: 'applied' };
    });
    const Swal = { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) };

    // 1. The stamp moved between the card and the click: refused, NOTHING claimed or written.
    const moved = { Swal, apiSend: jest.fn(async (path, method) => {
      if (method === 'GET') return { rule: { id: 12, definition_updated_at: '2026-10-27T10:00:01.000Z' } };
      throw new Error('a write was attempted');
    }) };
    const m1 = removal();
    await actionSandbox({ P: moved, ledgerApi, saveAssistantMessage: jest.fn() }).executeActionDraft(m1);
    expect(m1.action_draft.refusal_error).toMatch(/changed since this card was prepared, so nothing was changed/);
    expect(ledgerCalls).toEqual([]);
    expect(moved.apiSend.mock.calls.map((c) => c[1])).toEqual(['GET']);
    expect(Swal.fire.mock.calls[0][0]).toMatchObject({ icon: 'warning', focusCancel: true }); // live rule: danger

    // 2. Same stamp: the DELETE goes out with the base, the 204 is a confirmed removal, the receipt is the rule.
    const receipts = [];
    const ledgerApi2 = jest.fn(async (path, body) => {
      if (path.endsWith('/claim')) return { outcome: 'in_flight', claimed: true, claim_token: 'tok-ing' };
      receipts.push(body); return { outcome: 'applied' };
    });
    const writes = [];
    const ok = { Swal, apiSend: jest.fn(async (path, method, body, headers) => {
      if (method === 'GET') return { rule: { id: 12, definition_updated_at: STAMP } };
      writes.push({ path, method, body, headers }); return null;
    }) };
    const m2 = removal();
    await actionSandbox({ P: ok, ledgerApi: ledgerApi2, saveAssistantMessage: jest.fn() }).executeActionDraft(m2);
    expect(writes).toEqual([{ path: '/api/email-ingest/rule-actions/41', method: 'DELETE',
      body: { expected_base: { definition_updated_at: STAMP } }, headers: {} }]);
    expect(receipts).toEqual([{ claim_token: 'tok-ing', result: { ingest_rule_id: 12 } }]);
    expect(m2.action_draft.status).toBe('applied');

    // 3. The route's precondition 409 (the gap after the precheck): the rule's own refusal, never "may have applied".
    const conflict = { Swal, apiSend: jest.fn(async (path, method) => {
      if (method === 'GET') return { rule: { id: 12, definition_updated_at: STAMP } };
      throw Object.assign(new Error('changed'), { status: 409, body: { error: 'x', conflict: { changed: 'definition_updated_at', expected: STAMP, actual: 'y' } } });
    }) };
    const m3 = removal();
    await actionSandbox({ P: conflict, ledgerApi: ledgerApi2, saveAssistantMessage: jest.fn() }).executeActionDraft(m3);
    expect(m3.action_draft.refusal_error).toMatch(/^The ingest rule changed since this card was prepared/);
    expect(m3.action_draft).not.toHaveProperty('ambiguous_error');

    // 4. Create: no precheck read, POST with active 0 and the Idempotency-Key, receipt = the new rule.
    const created = [];
    const createP = { Swal, apiSend: jest.fn(async (path, method, body, headers) => { created.push({ path, method, body, headers }); return { status: 'success', rule: { id: 77 } }; }) };
    const m4 = { action_draft: { draft_id: '6d2e3f4a-5b6c-4d7e-8f90-123456789abc', kind: 'ingest_rule.create.v1', status: 'draft', received_at: Date.now(),
      channel: 'phone', rule: { name: 'Clio code', position: 0, match_mode: 'conditions', match_config: { operator: 'and', conditions: [{ path: 'message', op: 'contains', value: 'code' }] },
        transform_mode: 'passthrough', transform_config: null }, actions: [], order: 'position 0', code: { match: false, transform: false }, requires_capability: null, notes: [] } };
    await actionSandbox({ P: createP, ledgerApi: ledgerApi2, saveAssistantMessage: jest.fn() }).executeActionDraft(m4);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ path: '/api/phone-ingest/rules', method: 'POST', headers: { 'Idempotency-Key': m4.action_draft.draft_id },
      body: { name: 'Clio code', active: 0, actions: [] } });
    expect(m4.action_draft.status).toBe('applied');
    expect(m4.action_draft.result_ingest_rule_id).toBe(77);
  });

  test('the retry-receipt button is sized like the other card buttons', () => {
    // It lives in the warning block beside the error it belongs to, so it is
    // outside `.action-draft-actions button` and needs its own metrics.
    expect(html).toContain("retry.className = 'action-draft-retry'");
    expect(html).toMatch(/\.action-draft-actions button, \.action-draft-retry \{[^}]*font-size: 12px/);
  });

  test('appointment review text offers no client send unless the server prepared one', () => {
    const channels = new Function(`${apptFns('apptChannelsText')};return apptChannelsText;`)(); // eslint-disable-line no-new-func
    expect(channels({ kind: 'appt.create.v1', confirm_sms: true, confirm_message: 'Hi {{contacts.contact_ssn}}' })).toMatch(/^None — this appointment card sends no client SMS or email/);
    expect(channels({ kind: 'appt.cancel.v1', sms: true, confirm_message: 'Hi', confirmation: { sms: null, email: null } })).toMatch(/^None — /);
  });
});

describe('P5 durable applied-result ledger', () => {
  const message = () => ({ action_draft: { draft_id: '147eb0a1-9f77-4de0-8f18-119665bcda0b',
    kind: 'task.create.v1', status: 'draft', title: 'T', description: 'D', assignee: { user_id: 6, label: 'F' }, received_at: Date.now() } });
  const parent = () => ({ Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) },
    showTask: jest.fn(), tasksBadgeRefresh: jest.fn() });

  test('claim precedes the canonical write; receipt survives a chat save failure and excludes payload secrets', async () => {
    const calls = [];
    const ledgerApi = jest.fn(async (path, body) => {
      calls.push(path.endsWith('/claim') ? 'claim' : 'receipt');
      return path.endsWith('/claim') ? { outcome: 'in_flight', claimed: true, claim_token: 'private-receipt' } : { outcome: 'applied' };
    });
    const api = jest.fn(async () => { calls.push('write'); return { task_id: 71 }; });
    const save = jest.fn(async () => { calls.push('chat'); throw new Error('offline'); });
    const m = message();
    await actionSandbox({ P: parent(), api, ledgerApi, saveAssistantMessage: save }).executeActionDraft(m);
    expect({ calls, receipt: ledgerApi.mock.calls[1][1], draft: JSON.parse(JSON.stringify(m.action_draft)) }).toEqual({
      calls: ['claim', 'write', 'receipt', 'chat'],
      receipt: { claim_token: 'private-receipt', result: { task_id: 71 } },
      draft: expect.objectContaining({ status: 'applied', result_task_id: 71, marker_error: expect.any(String) }),
    });
    expect(JSON.stringify(m)).not.toContain('private-receipt');
  });

  test('unknown claim and lost claim acknowledgement never reach a canonical writer', async () => {
    for (const reply of [{ outcome: 'unknown' }, new Error('lost acknowledgement')]) {
      const api = jest.fn(); const m = message();
      const ledgerApi = jest.fn(async () => { if (reply instanceof Error) throw reply; return reply; });
      const execute = actionSandbox({ P: parent(), api, ledgerApi }).executeActionDraft;
      await execute(m); await execute(m);
      expect({ writes: api.mock.calls.length, claims: ledgerApi.mock.calls.length, warning: m.action_draft.ambiguous_error })
        .toEqual({ writes: 0, claims: 1, warning: expect.stringContaining('Do not apply this card again') });
    }
  });

  test('an applied claim restores the record id without a canonical write', async () => {
    const api = jest.fn(); const m = message();
    const ledgerApi = jest.fn(async () => ({ outcome: 'applied', result: { task_id: 81 } }));
    await actionSandbox({ P: parent(), api, ledgerApi }).executeActionDraft(m);
    expect({ writes: api.mock.calls.length, status: m.action_draft.status, id: m.action_draft.result_task_id })
      .toEqual({ writes: 0, status: 'applied', id: 81 });
  });

  test('receipt retries never repeat the canonical write; a retry button only saves the result', async () => {
    const { JSDOM } = require('jsdom'); const dom = new JSDOM('<main></main>');
    const api = jest.fn().mockResolvedValue({ task_id: 73 });
    let fail = true;
    const ledgerApi = jest.fn(async path => {
      if (path.endsWith('/claim')) return { outcome: 'in_flight', claimed: true, claim_token: 'receipt' };
      if (fail) throw new Error('receipt unavailable');
      return { outcome: 'applied' };
    });
    const save = jest.fn(); const m = message();
    const box = actionSandbox({ P: parent(), api, ledgerApi, saveAssistantMessage: save, document: dom.window.document });
    await box.executeActionDraft(m);
    const host = dom.window.document.querySelector('main');
    box.hydrateActionDraft(box.actionFamily(m.action_draft), host, m, m.action_draft);
    const retry = [...host.querySelectorAll('button')].find(b => b.textContent === 'Retry saving result');
    expect({ writes: api.mock.calls.length, receiptAttempts: ledgerApi.mock.calls.length - 1, retry: !!retry, chat: save.mock.calls.length })
      .toEqual({ writes: 1, receiptAttempts: 2, retry: true, chat: 0 });
    fail = false; retry.click();
    await new Promise(resolve => setImmediate(resolve));
    expect({ writes: api.mock.calls.length, receiptAttempts: ledgerApi.mock.calls.length - 1, chat: save.mock.calls.length,
      error: m.action_draft.marker_error, capability: m.action_draft.__ledgerReceipt })
      .toEqual({ writes: 1, receiptAttempts: 3, chat: 1, error: undefined, capability: undefined });
    dom.window.close();
  });

  test('ledger overrides payload markers; missing rows preserve legacy results and old kinds stay inert', () => {
    const box = actionSandbox();
    const drafts = ['applied', 'unknown', 'not-applied', 'legacy'].map(key => ({ action_draft: {
      draft_id: key, kind: 'task.create.v1', status: 'applied', result_task_id: 999 } }));
    const messages = [...drafts, ...drafts.map(m => ({ action_result: { draft_id: m.action_draft.draft_id, kind: 'task.create.v1', task_id: 999 } }))];
    const restored = box.applyActionResults(messages, [
      { draft_id: 'applied', kind: 'task.create.v1', outcome: 'applied', result: { task_id: 82 } },
      { draft_id: 'unknown', kind: 'task.create.v1', outcome: 'unknown' },
      { draft_id: 'not-applied', kind: 'task.create.v1', outcome: 'not-applied' },
    ]);
    expect(restored.slice(0, 4).map(m => [m.action_draft.status, m.action_draft.result_task_id, !!m.action_draft.ambiguous_error]))
      .toEqual([['applied', 82, false], ['draft', undefined, true], ['draft', undefined, false], ['applied', 999, false]]);
    expect(box.actionFamily({ kind: 'task.create.v0' })).toBeNull();
  });
});

test('opening saved history reconciles receipts before rendering and fails closed when reconciliation is unavailable', async () => {
  const id = '147eb0a1-9f77-4de0-8f18-119665bcda0b';
  for (const unavailable of [false, true]) {
    const api = jest.fn(async path => {
      if (path === '/api/assistant/chats/42') return { chat: { id: 42, messages: [{ role: 'assistant', text: 'Prepared', payload: {
        action_draft: { draft_id: id, kind: 'task.create.v1', status: 'draft' },
      } }] } };
      if (unavailable) throw new Error('reconciliation unavailable');
      return { actions: [{ draft_id: id, kind: 'task.create.v1', outcome: 'applied', result: { task_id: 83 } }] };
    });
    const render = jest.fn(); const historyList = { innerHTML: '' };
    const open = new Function('api', 'applyActionResults', 'render', 'historyList', `
      let history = []; let currentChatId = null; const busy = false;
      const modelMode = {}; const historyPanel = {}; const input = { focus() {} };
      const esc = value => value;
      ${fnSrcAuto(html, 'openSavedChat')}
      return { openSavedChat, messages: () => history };
    `)(api, actionSandbox().applyActionResults, render, historyList);
    await open.openSavedChat(42);
    expect({ requests: api.mock.calls, renders: render.mock.calls.length,
      messages: open.messages(), error: historyList.innerHTML }).toEqual({
      requests: [['/api/assistant/chats/42', null, 'GET'], ['/api/assistant/actions/reconcile', { draft_ids: [id] }, 'POST']],
      renders: unavailable ? 0 : 1,
      messages: unavailable ? [] : [{ role: 'assistant', text: 'Prepared', action_draft: {
        draft_id: id, kind: 'task.create.v1', status: 'applied', result_task_id: 83,
      } }],
      error: unavailable ? '<div class="history-empty">reconciliation unavailable</div>' : '',
    });
  }
});

test('the browser requests ledger-backed drafts on each automatic read attempt', async () => {
  const api = jest.fn().mockResolvedValue({ outcome: 'answer' });
  // Streaming not offered (answerStreaming false): executeAnswer is api().
  const execute = new Function('api', `const history = []; function render() {}; const currentChatId = 41; const answerStreaming = false;
    ${fnSrcAuto(html, 'executeAnswer')}; ${fnSrcAuto(html, 'executeAutomatically')}; return executeAutomatically;`)(api);
  await execute('read-ticket', []);
  // R1: the chat id rides along so a budget stop's continuation is bound to it.
  expect(api.mock.calls).toEqual([['/api/assistant/execute', {
    ticket: 'read-ticket', temporary_attachments: [], action_ledger_version: 1, chat_id: 41,
  }]]);
});

// A14 direct sends through the SHARED engine. The canonical routes are
// stubbed at api() — the browser half; tests/caseySend.routes.test.js drives
// the same request builder into the real routes with the transports stubbed.
describe('A14 send cards (sms.send.v1 / email.send.v1)', () => {
  const STAMP = '2026-10-26T10:00:00.000Z';
  const smsDraft = (over = {}) => ({ action_draft: {
    draft_id: '347eb0a1-9f77-4de0-8f18-119665bcda0b', kind: 'sms.send.v1', status: 'draft', received_at: Date.now(),
    recipient: { contact_id: 1309, contact_name: 'Pat One', phone_id: 12, phone: '3135550001', label: 'Mobile', is_primary: true, expected_updated_at: STAMP },
    sender: { line_id: 3, label: '#3 Rena (248) 965-5355', number: '2489655355', defaulted: false },
    message: 'Hi Pat, your hearing moved.', segments: { encoding: 'GSM-7', units: 27, segments: 1 },
    templated: true, ssn_warning: false, case: null, evidence: [], ...over } });
  const emailDraft = (over = {}) => ({ action_draft: {
    draft_id: '447eb0a1-9f77-4de0-8f18-119665bcda0b', kind: 'email.send.v1', status: 'draft', received_at: Date.now(),
    recipient: { contact_id: 1309, contact_name: 'Pat One', email_id: 13, email: 'pat@example.com', label: 'Personal', is_primary: true, expected_updated_at: STAMP },
    sender: { mailbox_id: 5, label: '#5 Rena <rena@4lsg.com>', address: 'rena@4lsg.com', defaulted: false },
    subject: 'Your case', body: 'Dear Pat,\n\nSee you Tuesday.', templated: true, ssn_warning: false, case: null, evidence: [], ...over } });
  // The canonical reads the precheck makes, answering "unchanged" unless told otherwise.
  const reads = (over = {}) => {
    const contact = { contact_id: 1309, ...(over.contact || {}) };
    const phone = { id: 12, phone: '3135550001', sms_optout: 0, end_date: null, updated_at: STAMP, ...(over.phone || {}) };
    const email = { id: 13, email: 'pat@example.com', email_optout: 0, end_date: null, updated_at: STAMP, ...(over.email || {}) };
    return (path) => {
      if (path === '/api/contacts/1309') return { contact };
      if (path === '/api/contacts/1309/phones') return { status: 'success', phones: over.noRow ? [] : [phone] };
      if (path === '/api/contacts/1309/emails') return { status: 'success', emails: over.noRow ? [] : [email] };
      return undefined;
    };
  };
  // The page's opt-out helper, for real (public/js/optoutAck.js in a JSDOM
  // window, as the page loads it); window.confirm answers `answer`.
  function optoutHelper(answer) {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously' });
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'public/js/optoutAck.js'), 'utf8'));
    const asked = [];
    dom.window.confirm = (t) => { asked.push(t); return answer; };
    return { ycOptoutAck: dom.window.ycOptoutAck, asked };
  }
  const optedOut409 = () => Object.assign(new Error('Pat One (313) 555-0001 (contact #1309) has opted out of texts. Send anyway only if they asked for this message.'), {
    status: 409, body: { status: 'error', code: 'opted_out', message: 'Pat One (313) 555-0001 (contact #1309) has opted out of texts. Send anyway only if they asked for this message.' } });
  function run(message, { read = reads(), write = async () => ({ status: 'success', line_id: 3, to: '3135550001', result: { id: 'MSG1', status: 'queued' } }), confirm = true, optout } = {}) {
    const writes = []; const gets = []; const ledger = [];
    const api = jest.fn(async (path, body, method, headers) => {
      if (method === 'GET') { gets.push(path); const r = read(path); if (r === undefined) throw new Error(`unexpected read ${path}`); return r; }
      writes.push({ path, body, method, headers }); return write(path, body);
    });
    const ledgerApi = jest.fn(async (path, body) => { ledger.push(path.endsWith('/claim') ? 'claim' : { receipt: body }); return path.endsWith('/claim') ? { outcome: 'in_flight', claimed: true, claim_token: 'tok-send' } : { outcome: 'applied' }; });
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: confirm }) }, addFile: jest.fn() };
    const history = [];
    const sandbox = actionSandbox({ P, api, ledgerApi, history, saveAssistantMessage: jest.fn(), ...(optout ? { ycOptoutAck: optout.ycOptoutAck } : {}) });
    return sandbox.executeActionDraft(message).then(() => ({ writes, gets, ledger, P, history, sandbox }));
  }

  test('one registry family, danger-styled, its dialog says it sends NOW and cannot be recalled', async () => {
    const { actionFamily } = actionSandbox();
    const family = actionFamily({ kind: 'sms.send.v1' });
    expect(family).toBe(actionFamily({ kind: 'email.send.v1' }));
    expect([family.id, family.idField, family.appliedKey, family.danger({})]).toEqual(['send', 'contact_id', 'result_send_contact_id', true]);
    const cancelled = await run(smsDraft(), { confirm: false });
    expect(cancelled.writes).toEqual([]); expect(cancelled.ledger).toEqual([]); expect(cancelled.gets).toEqual([]);
    const dialog = cancelled.P.Swal.fire.mock.calls[0][0];
    expect(dialog).toMatchObject({ icon: 'warning', focusCancel: true, title: 'Send text message' });
    expect(dialog.text).toMatch(/^This sends NOW to Pat One 3135550001\. It cannot be recalled\./);
    expect(dialog.text).toMatch(/Message, exactly as sent, between the rules:\n────────\nHi Pat, your hearing moved\.\n────────$/);
    expect(dialog.text).toContain('To: Pat One — (313) 555-0001 (Mobile, primary)');
  });

  test('SMS: the precheck re-reads, then ONE POST carries exactly the resolved text and the draft_id key; the receipt is the contact', async () => {
    const m = smsDraft();
    const { writes, gets, ledger, P, history } = await run(m);
    expect(gets).toEqual(['/api/contacts/1309', '/api/contacts/1309/phones']);
    expect(writes).toEqual([{ path: '/api/phone-lines/3/sms', method: 'POST',
      body: { to: '3135550001', message: 'Hi Pat, your hearing moved.' },
      headers: { 'Idempotency-Key': m.action_draft.draft_id } }]);
    expect(ledger).toEqual(['claim', { receipt: { claim_token: 'tok-send', result: { contact_id: 1309 } } }]);
    expect(m.action_draft).toMatchObject({ status: 'applied', result_send_contact_id: 1309 });
    expect(history[0].text).toBe('Text to Pat One: contact #1309: accepted by the provider (status queued) (provider id MSG1).');
    expect(history[0].entities).toEqual([{ kind: 'contact', id: '1309', label: 'Pat One' }]);
    expect(P.addFile).toHaveBeenCalledWith('Pat One', 'client', '1309&tab=send');
  });

  test('email: ONE POST /api/mail/send with exactly mailbox, one To, subject and body_text — no cc/bcc/html/attachments', async () => {
    const m = emailDraft();
    const { writes, gets } = await run(m, { write: async () => ({ status: 'success', email_log_id: 991, provider_message_id: '1a2b', warnings: [] }) });
    expect(gets).toEqual(['/api/contacts/1309', '/api/contacts/1309/emails']);
    expect(writes).toEqual([{ path: '/api/mail/send', method: 'POST',
      body: { mailbox_id: 5, to: ['pat@example.com'], subject: 'Your case', body_text: 'Dear Pat,\n\nSee you Tuesday.' },
      headers: { 'Idempotency-Key': m.action_draft.draft_id } }]);
    expect(m.action_draft.status).toBe('applied');
  });

  // Ruling 17 ("casey is like the user"): the route's 409 opted_out meets the
  // SAME confirm Comms uses; acknowledge_optout is sent only after it.
  const ackWrite = async (path, body) => {
    if (!body.acknowledge_optout) throw optedOut409();
    return { status: 'success', line_id: 3, to: '3135550001', result: { id: 'MSG2', status: 'queued' } };
  };
  test('ruling 17: an opted-out recipient — the confirm says the server\'s words; OK → ONE acknowledged resend, same path and key; applied', async () => {
    const m = smsDraft({ recipient: { ...smsDraft().action_draft.recipient, opted_out: true } });
    const optout = optoutHelper(true);
    const { writes, history } = await run(m, { read: reads({ phone: { sms_optout: 1 } }), write: ackWrite, optout });
    expect(optout.asked).toEqual(['Pat One (313) 555-0001 (contact #1309) has opted out of texts. Send anyway only if they asked for this message.\n\nSend anyway?']);
    expect(writes).toEqual([
      { path: '/api/phone-lines/3/sms', method: 'POST', body: { to: '3135550001', message: 'Hi Pat, your hearing moved.' }, headers: { 'Idempotency-Key': m.action_draft.draft_id } },
      { path: '/api/phone-lines/3/sms', method: 'POST', body: { to: '3135550001', message: 'Hi Pat, your hearing moved.', acknowledge_optout: true }, headers: { 'Idempotency-Key': m.action_draft.draft_id } },
    ]);
    expect(m.action_draft).toMatchObject({ status: 'applied', result_send_contact_id: 1309 });
    expect(history[0].text).toMatch(/^Text to Pat One: contact #1309: accepted by the provider/);
  });

  test('ruling 17: no acknowledge without the confirm — Cancel sends nothing more and says so; nothing is "outcome unknown"', async () => {
    const m = smsDraft({ recipient: { ...smsDraft().action_draft.recipient, opted_out: true } });
    const optout = optoutHelper(false);
    const { writes } = await run(m, { read: reads({ phone: { sms_optout: 1 } }), write: ackWrite, optout });
    expect(optout.asked).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(writes[0].body).not.toHaveProperty('acknowledge_optout');
    expect(m.action_draft.refusal_error).toBe('Cancelled — nothing was sent (the recipient has opted out). Ask Casey to prepare it again if you change your mind.');
    expect(m.action_draft).not.toHaveProperty('ambiguous_error');
    expect(m.action_draft.status).toBe('draft');
  });

  test('ruling 17: the same confirm when the opt-out races past the precheck; a 409 AFTER acknowledging is a refusal, never a loop', async () => {
    const m = smsDraft();
    const optout = optoutHelper(true);
    const raced = await run(m, { write: ackWrite, optout });
    expect(optout.asked).toHaveLength(1);
    expect(raced.writes.map((w) => w.body.acknowledge_optout === true)).toEqual([false, true]);
    expect(m.action_draft.status).toBe('applied');
    const again = smsDraft({ draft_id: '547eb0a1-9f77-4de0-8f18-119665bcda0b' });
    const twice = await run(again, { write: async () => { throw optedOut409(); }, optout: optoutHelper(true) });
    expect(twice.writes).toHaveLength(2);
    expect(again.action_draft.refusal_error).toMatch(/^The server refused this \(Pat One .*opted out of texts/);
    expect(again.action_draft).not.toHaveProperty('ambiguous_error');
  });

  test('without the helper (it failed to load) the 409 stays a refusal: ONE POST, never acknowledged — fails safe', async () => {
    const m = smsDraft();
    const { writes } = await run(m, { write: async () => { throw optedOut409(); } });
    expect(writes).toHaveLength(1);
    expect(writes[0].body).not.toHaveProperty('acknowledge_optout');
    expect(m.action_draft.refusal_error).toMatch(/^The server refused this \(Pat One .*opted out of texts/);
    expect(m.action_draft.ambiguous_error).toBeUndefined();
  });

  test('click-time freshness: an opt-out, an ended/changed/missing row refuses BEFORE any claim or write', async () => {
    const cases = [
      [{ phone: { sms_optout: 1 } }, /has opted out since/],
      [{ phone: { end_date: '2026-10-26' } }, /no longer active/],
      [{ noRow: true }, /no longer active/],
      [{ phone: { phone: '3135559999' } }, /changed since this card was prepared/],
      [{ phone: { updated_at: '2026-10-26T10:00:05.000Z' } }, /changed since this card was prepared/],
    ];
    for (const [over, why] of cases) {
      const m = smsDraft();
      const { writes, ledger } = await run(m, { read: reads(over) });
      expect({ over, writes: writes.length, ledger: ledger.length }).toEqual({ over, writes: 0, ledger: 0 });
      expect(m.action_draft.refusal_error).toMatch(why);
      expect(m.action_draft.status).toBe('draft');
    }
    const e = emailDraft();
    const r = await run(e, { read: reads({ email: { email_optout: 1 } }) });
    expect(r.writes).toEqual([]); expect(e.action_draft.refusal_error).toMatch(/opted out/);
    // Ruling 17: the reviewed opt-out state is part of what was reviewed.
    const reviewedOpted = smsDraft({ recipient: { ...smsDraft().action_draft.recipient, opted_out: true } });
    const cleared = await run(reviewedOpted, { read: reads({ phone: { sms_optout: 0 } }) });
    expect([cleared.writes.length, cleared.ledger.length]).toEqual([0, 0]);
    expect(reviewedOpted.action_draft.refusal_error).toMatch(/is no longer opted out — its consent changed since this card was prepared/);
    const stillOpted = smsDraft({ recipient: { ...smsDraft().action_draft.recipient, opted_out: true } });
    const ok = await run(stillOpted, { read: reads({ phone: { sms_optout: 1 } }), write: ackWrite, optout: optoutHelper(true) });
    expect(ok.ledger[0]).toBe('claim');
    expect(stillOpted.action_draft.status).toBe('applied');
    // A read that FAILS sends nothing and leaves the card retryable (nothing was claimed).
    const f = smsDraft();
    const failed = await run(f, { read: () => { throw new Error('offline'); } });
    expect(failed.writes).toEqual([]); expect(failed.ledger).toEqual([]);
    expect(f.action_draft.action_error).toMatch(/Could not re-check the record before applying \(offline\)\. Nothing was sent/);
    expect(f.action_draft).not.toHaveProperty('refusal_error');
  });

  test('outcomes: a pre-dispatch 4xx/409 is a refusal; an idempotency 409, a 502 or a dead socket is "outcome unknown"; none is offered again', async () => {
    for (const [err, kind] of [
      [{ status: 403, message: 'Send permission required on this phone line' }, 'refusal'],
      [{ status: 409, message: 'This phone line is inactive — it cannot send' }, 'refusal'],
      [{ status: 429, message: 'Too many texts' }, 'refusal'],
      [{ status: 401, message: 'Elevation required' }, 'refusal'],
      [{ status: 409, message: 'still being applied', body: { idempotency: { outcome: 'in_flight' } } }, 'unknown'],
      [{ status: 502, message: 'The message was not sent: Quo API 504' }, 'unknown'],
      [{ message: 'Failed to fetch' }, 'unknown'],
    ]) {
      const m = smsDraft();
      const out = await run(m, { write: async () => { throw Object.assign(new Error(err.message), err); } });
      expect(out.writes).toHaveLength(1);
      if (kind === 'refusal') {
        expect(m.action_draft.refusal_error).toBe(`The server refused this (${err.message}). Nothing was written. Ask Casey to prepare the action again.`);
        expect(m.action_draft).not.toHaveProperty('ambiguous_error');
      } else {
        expect(m.action_draft.ambiguous_error).toBe(`Outcome unknown — the message may or may not have gone out (${err.message}). Check the contact's Communications tab or the comms log before resending. Do not apply this card again.`);
        expect(m.action_draft).not.toHaveProperty('refusal_error');
      }
      await out.sandbox.executeActionDraft(m);       // never a second attempt
      expect(out.writes).toHaveLength(1);
    }
  });

  test('a replay sent nothing twice and says so', async () => {
    const m = smsDraft();
    const { history } = await run(m, { write: async () => ({ status: 'success', line_id: 3, to: '3135550001', result: null, replayed: true }) });
    expect(history[0].text).toBe('This text to Pat One had already been sent; nothing was sent a second time.');
  });

  test('the builder never sends template braces or a missing recipient — and never acknowledge_optout, even for an opted-out card', () => {
    const { actionFamily } = actionSandbox();
    const family = actionFamily({ kind: 'sms.send.v1' });
    const opted = (d) => ({ ...d, recipient: { ...d.recipient, opted_out: true } });
    expect(family.request(opted(smsDraft().action_draft)).body).toEqual({ to: '3135550001', message: 'Hi Pat, your hearing moved.' });
    expect(family.request(opted(emailDraft().action_draft)).body).toEqual({ mailbox_id: 5, to: ['pat@example.com'], subject: 'Your case', body_text: 'Dear Pat,\n\nSee you Tuesday.' });
    expect(() => family.request(smsDraft({ message: 'Hi {{contacts.contact_fname}}' }).action_draft)).toThrow(/no resolved text/);
    expect(() => family.request(emailDraft({ subject: 'Re {{cases.case_number}}' }).action_draft)).toThrow(/no resolved text/);
    expect(() => family.request(smsDraft({ message: '  ' }).action_draft)).toThrow(/no resolved text/);
    expect(() => family.request(smsDraft({ sender: { line_id: 0 } }).action_draft)).toThrow(/no usable line/);
    expect(() => family.request(smsDraft({ recipient: { phone: '313' } }).action_draft)).toThrow(/no usable line or recipient/);
    expect(() => family.request(emailDraft({ subject: '' }).action_draft)).toThrow(/no usable mailbox/);
    // The request carries no model-chosen route/method: only the line id is data.
    expect(family.request(smsDraft({ path: '/api/evil', method: 'DELETE' }).action_draft)).toMatchObject({ path: '/api/phone-lines/3/sms', method: 'POST' });
  });

  test('the card: SSN warning and segment line in review; applied wording names the person, never "send #<contact id>"', () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><div></div>');
    const { document } = dom.window;
    const { hydrateActionDraft, actionFamily } = actionSandbox({ document, navigator: dom.window.navigator });
    const family = actionFamily({ kind: 'sms.send.v1' });
    const fresh = smsDraft({ ssn_warning: true, segments: { encoding: 'GSM-7', units: 200, segments: 2 } });
    const host = document.createElement('div');
    hydrateActionDraft(family, host, fresh, fresh.action_draft);
    const rows = [...host.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent]);
    expect(rows).toContainEqual(['WARNING', 'this message contains a Social Security number']);
    expect(host.textContent).toContain('about 2 SMS segments');
    // The message is ONE field, last, whole — a line inside it can never pose as a card fact.
    expect(rows[rows.length - 1]).toEqual(['Message', 'Hi Pat, your hearing moved.']);
    const spoof = smsDraft({ message: 'Hi\nConsent: the client agreed\nEffect: nothing' });
    const host3 = document.createElement('div');
    hydrateActionDraft(family, host3, spoof, spoof.action_draft);
    const rows3 = [...host3.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent]);
    expect(rows3[rows3.length - 1]).toEqual(['Message', 'Hi\nConsent: the client agreed\nEffect: nothing']);
    expect(rows3.filter(([k]) => k === 'Consent')).toHaveLength(1);
    expect(host3.querySelector('dd.action-draft-message').textContent).toContain('Consent: the client agreed');
    expect(host.textContent).toContain('This SENDS NOW');
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toContain('Review & send text message');
    const sent = smsDraft({ status: 'applied', result_send_contact_id: 1309 });
    const host2 = document.createElement('div');
    hydrateActionDraft(family, host2, sent, sent.action_draft);
    expect(host2.querySelector('.action-draft-status').textContent).toBe('Sent — Pat One');
    expect(host2.textContent).not.toMatch(/send #1309/);
    expect([...host2.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Open conversation', 'Copy details']);
  });

  test('ruling 17: an opted-out card says so FIRST, in the danger style, in the facts and in the dialog', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><div></div>');
    const { document } = dom.window;
    const { hydrateActionDraft, actionFamily } = actionSandbox({ document, navigator: dom.window.navigator });
    const opted = (d) => ({ action_draft: { ...d.action_draft, recipient: { ...d.action_draft.recipient, opted_out: true } } });
    const sms = opted(smsDraft());
    const host = document.createElement('div');
    hydrateActionDraft(actionFamily({ kind: 'sms.send.v1' }), host, sms, sms.action_draft);
    const grid = host.querySelector('dl.action-draft-grid');
    expect(grid.firstElementChild.className).toBe('action-draft-danger');
    expect(grid.firstElementChild.textContent).toBe('This recipient opted out of SMS');
    const rows = [...host.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent]);
    expect(rows.find(([k]) => k === 'Consent')[1]).toMatch(/^OPTED OUT — this recipient opted out of SMS\. Sending asks you to confirm past the opt-out/);
    const email = opted(emailDraft());
    const host2 = document.createElement('div');
    hydrateActionDraft(actionFamily({ kind: 'email.send.v1' }), host2, email, email.action_draft);
    expect(host2.querySelector('.action-draft-danger').textContent).toBe('This recipient opted out of email');
    const plain = smsDraft();
    const host3 = document.createElement('div');
    hydrateActionDraft(actionFamily({ kind: 'sms.send.v1' }), host3, plain, plain.action_draft);
    expect(host3.querySelector('.action-draft-danger')).toBeNull();
    expect([...host3.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent]).find(([k]) => k === 'Consent')[1])
      .toBe('checked — the recipient has not opted out; re-checked when you click.');
    const cancelled = await run(opted(smsDraft()), { confirm: false });
    const dialog = cancelled.P.Swal.fire.mock.calls[0][0];
    expect(dialog.text).toMatch(/^This sends NOW to Pat One 3135550001\. It cannot be recalled\. This recipient opted out of SMS — you will be asked to confirm past the opt-out\.\n\nText message proposal — not sent\nWARNING: This recipient opted out of SMS\n/);
  });

  test('reopening a chat whose send claim never recorded shows the send\'s own unknown wording', () => {
    const { applyActionResults } = actionSandbox();
    const m = smsDraft();
    applyActionResults([m], [{ draft_id: m.action_draft.draft_id, kind: 'sms.send.v1', outcome: 'unknown' }]);
    expect(m.action_draft.ambiguous_error).toBe("Outcome unknown — the message may or may not have gone out. Check the contact's Communications tab or the comms log before resending. Do not apply this card again.");
    const done = smsDraft();
    applyActionResults([done], [{ draft_id: done.action_draft.draft_id, kind: 'sms.send.v1', outcome: 'applied', result: { contact_id: 1309 } }]);
    expect(done.action_draft).toMatchObject({ status: 'applied', result_send_contact_id: 1309 });
  });
});

// R1 read-loop continuation: the Keep going control. The real functions run
// out of assistant.html; api() and the history saves are the stubs.
describe('R1 Keep going control', () => {
  const KEEP_FNS = ['compactInvestigation', 'keepGoingHtml', 'answerMessage', 'executeAnswer', 'keepGoing', 'askCaseyAgain', 'saveAssistantMessage'];
  function keepSandbox(deps = {}) {
    const supplied = {
      history: [], busy: false, currentChatId: 41, historyAvailable: true, modelMode: { value: 'better_quality' },
      api: jest.fn(), render: jest.fn(), setBusy: jest.fn(), saveUserMessage: jest.fn().mockResolvedValue(),
      requestAttachments: jest.fn().mockResolvedValue({ temporary: [], documentIds: [] }),
      input: { value: '', focus: jest.fn() }, answerStreaming: false, ...deps,
    };
    const names = Object.keys(supplied);
    const src = `${constSrc(html, 'esc')}\n${constSrc(html, 'CONTINUATION_TTL_MS')}\n${constSrc(html, 'STOP_LABELS')}\n` +
      `${KEEP_FNS.map((name) => fnSrcAuto(html, name)).join('\n')}\nreturn { ${KEEP_FNS.join(', ')} };`;
    return new Function(...names, src)(...names.map((name) => supplied[name])); // eslint-disable-line no-new-func
  }
  const INV = { stop_reason: 'round_budget', continuable: true, rounds: 3, total_steps: 3, returned_rows: 3, grants: 0, approx_cost_cents: 42 };
  const answerAt = (extra = {}) => ({ role: 'assistant', text: 'Stopped early.', investigation: INV, ...extra });

  test('a fresh continuation renders the Keep going button with the budget and the cost', () => {
    const msg = answerAt({ continuation: 'c1.token', continuation_received_at: Date.now() });
    const out = keepSandbox({ history: [msg] }).keepGoingHtml(msg, 0);
    expect(out).toMatch(/read-pass limit after 3 read passes \(3 reads, 3 rows, about 42¢ of AI so far\)/);
    expect(out).toMatch(/data-keep-going="0"/);
  });

  test('stale, reopened, already-continued and non-budget messages never offer it', () => {
    const stale = answerAt({ continuation: 'c1.token', continuation_received_at: Date.now() - 16 * 60 * 1000 });
    const reopened = answerAt();
    const continued = answerAt({ continuation: 'c1.token', continuation_received_at: Date.now() });
    const { keepGoingHtml } = keepSandbox({ history: [continued, { role: 'user', text: 'Keep going', continuation: true }] });
    expect(keepGoingHtml(stale, 9)).toMatch(/more than 15 minutes old[\s\S]*data-reask/);
    expect(keepGoingHtml(stale, 9)).not.toMatch(/data-keep-going/);
    expect(keepGoingHtml(reopened, 9)).toMatch(/reopened from saved history[\s\S]*data-reask/);
    expect(keepGoingHtml(continued, 0)).toBe('<div class="keep-going">Continued below.</div>');
    expect(keepGoingHtml(answerAt({ investigation: { ...INV, continuable: false } }), 9)).toBe('');
  });

  test('the saved chat payload keeps the stop summary but never the sealed token', async () => {
    const api = jest.fn().mockResolvedValue({ status: 'success' });
    const { saveAssistantMessage } = keepSandbox({ api });
    await saveAssistantMessage(answerAt({ continuation: 'c1.SECRET-SEALED', continuation_received_at: 1, turn_attachments: [{ file: {} }] }));
    const payload = api.mock.calls[0][1].payload;
    expect(payload.investigation).toEqual(INV);
    expect(JSON.stringify(api.mock.calls)).not.toMatch(/SECRET-SEALED|turn_attachments/);
  });

  test('a click spends the continuation once, in its chat, and appends the resumed answer', async () => {
    const history = [{ role: 'user', text: 'Who?' }, answerAt({ continuation: 'c1.old', continuation_received_at: Date.now(), continuation_chat: 41, turn_attachments: [] })];
    const api = jest.fn().mockResolvedValue({ answer: 'Now complete.', continuation: 'c1.new', investigation: { ...INV, rounds: 6, grants: 1 }, steps: [] });
    const saveUserMessage = jest.fn().mockResolvedValue();
    const sandbox = keepSandbox({ history, api, saveUserMessage });
    await sandbox.keepGoing(history[1]);
    expect(api).toHaveBeenCalledWith('/api/assistant/execute', { continuation: 'c1.old', chat_id: 41, temporary_attachments: [], action_ledger_version: 1 });
    expect(saveUserMessage).toHaveBeenCalledWith('Keep going', [], null, { continuation: true });
    expect(history[1].continuation).toBeNull();
    expect(history[2]).toEqual({ role: 'user', text: 'Keep going', continuation: true });
    expect(history[3]).toMatchObject({ text: 'Now complete.', continuation: 'c1.new', investigation: { rounds: 6, grants: 1 } });
    expect(history[3].meta).toMatch(/continued 1×/);
  });

  test('a refused continuation drops the marker and explains instead of re-offering', async () => {
    const history = [{ role: 'user', text: 'Who?' }, answerAt({ continuation: 'c1.old', continuation_received_at: Date.now(), continuation_chat: 41 })];
    const api = jest.fn().mockRejectedValue(new Error('This investigation can no longer be continued: a continuation lasts 15 minutes and does not survive reopening a saved chat. Ask Casey again.'));
    const sandbox = keepSandbox({ history, api });
    await sandbox.keepGoing(history[1]);
    expect(history).toHaveLength(2);
    expect(history[1].continuation).toBeNull();
    expect(sandbox.keepGoingHtml(history[1], 1)).toMatch(/can no longer be continued[\s\S]*data-reask/);
  });

  test('Ask Casey again re-asks the original question, not the Keep going turn', () => {
    const input = { value: '', focus: jest.fn() };
    const history = [{ role: 'user', text: 'Original question?' }, answerAt(), { role: 'user', text: 'Keep going', continuation: true }, answerAt()];
    keepSandbox({ history, input }).askCaseyAgain(history[3]);
    expect(input.value).toBe('Original question?');
  });
});

// A7 group A: case notes / case alerts / contact notes through the SHARED
// engine. Pinned: the click-time re-read compares the stored text by VALUE and
// refuses BEFORE the ledger claim; the builder sends exactly ONE column, named
// by the KIND (never by the draft), with the complete after-value and no
// Idempotency-Key; the case receipt is the STRING case_id and survives the
// ledger round trip intact (never Number() → NaN); the contact receipt is an
// integer; the card renders a bounded changed region, never a whole 10k note.
describe('A7 record text cards (case.notes / case.alerts / contact.notes)', () => {
  const CASE_ID = '7KQ2M9XA';
  const caseDraft = (over = {}) => ({ action_draft: {
    draft_id: '8c8c8c8c-1b2c-4d3e-8f40-123456789abc', kind: 'case.notes.update.v1', status: 'draft', received_at: Date.now(),
    target: { type: 'case', case_id: CASE_ID, case_number: '25-12345-abc', case_type: 'Chapter 7', clients: ['Dana Client', 'Sam Client'] },
    field: 'case_notes', mode: 'append', before_length: 22, after_length: 33, max: 10000,
    after: 'first line\nsecond line\nthird line', expected: { case_notes: 'first line\nsecond line' }, evidence: [],
    // Model-shaped junk that must never reach a request.
    case_status: 'Closed', changes: { case_stage: 'x' }, value: 'zzz',
    ...over } });
  const contactDraft = (over = {}) => caseDraft({ draft_id: '9d9d9d9d-1b2c-4d3e-8f40-123456789abc', kind: 'contact.notes.update.v1',
    target: { type: 'contact', contact_id: 77, contact_name: 'Dana Client', contact_kind: 'person', case_count: 2 },
    field: 'contact_notes', after: 'Prefers email\nTexts after 5pm', expected: { contact_notes: 'Prefers email' }, ...over });
  const reads = (over = {}) => (path) => {
    if (over.gone) throw Object.assign(new Error('not found'), { status: 404 });
    if (path === `/api/cases/${CASE_ID}`) return { case: { case_id: CASE_ID, case_notes: 'first line\nsecond line', case_alerts: '', ...(over.case || {}) } };
    if (path === '/api/contacts/77') return { contact: { contact_id: 77, contact_notes: 'Prefers email', ...(over.contact || {}) } };
    throw new Error(`unexpected read ${path}`);
  };
  function runText(message, { read = reads(), write = async (path) => (path.startsWith('/api/cases/')
    ? { status: 'success', data: { case_id: CASE_ID, updated_fields: ['case_notes'], changes: {} } }
    : { status: 'success', data: { contact_id: 77, updated_fields: ['contact_notes'], changes: {} } }), confirm = true } = {}) {
    const writes = []; const gets = []; const ledger = [];
    const api = jest.fn(async (path, body, method, headers) => {
      if (method === 'GET') { gets.push(path); return read(path); }
      writes.push({ path, body, method, headers }); return write(path, body);
    });
    const ledgerApi = jest.fn(async (path, body) => { ledger.push(path.endsWith('/claim') ? 'claim' : { receipt: body }); return path.endsWith('/claim') ? { outcome: 'in_flight', claimed: true, claim_token: 'tok-a7' } : { outcome: 'applied' }; });
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: confirm }) } };
    const history = []; const openEntity = jest.fn();
    const sandbox = actionSandbox({ P, api, ledgerApi, history, openEntity, saveAssistantMessage: jest.fn() });
    return sandbox.executeActionDraft(message).then(() => ({ writes, gets, ledger, P, history, openEntity, sandbox }));
  }

  test('case notes append: re-read, ONE PATCH of case_notes only, the STRING case_id receipt, opens the case', async () => {
    const m = caseDraft();
    const { writes, gets, ledger, P, history, openEntity, sandbox } = await runText(m);
    expect(sandbox.actionFamily(m.action_draft).id).toBe('case_text');
    expect(gets).toEqual([`/api/cases/${CASE_ID}`]);
    expect(writes).toEqual([{ path: `/api/cases/${CASE_ID}`, method: 'PATCH', headers: undefined, body: { case_notes: 'first line\nsecond line\nthird line' } }]);
    expect(ledger).toEqual(['claim', { receipt: { claim_token: 'tok-a7', result: { case_id: CASE_ID } } }]);
    expect(m.action_draft).toMatchObject({ status: 'applied', result_text_case_id: CASE_ID });
    expect(history[0].text).toBe(`Update case notes applied to case ${CASE_ID}.`);
    expect(history[0].action_result).toMatchObject({ kind: 'case.notes.update.v1', case_id: CASE_ID });
    expect(history[0].entities).toEqual([{ kind: 'case', id: CASE_ID, label: '25-12345-abc' }]);
    expect(openEntity).toHaveBeenCalledWith('case', CASE_ID, '25-12345-abc');
    const dialog = P.Swal.fire.mock.calls[0][0];
    // A pure addition is not danger-styled.
    expect(dialog).toMatchObject({ icon: 'question', confirmButtonText: 'Update case notes' });
    expect(dialog.text).toContain(`Case: 25-12345-abc (case ${CASE_ID}, Chapter 7)`);
    expect(dialog.text).toContain('Clients: Dana Client, Sam Client');
    expect(dialog.text).toContain('Size: 22 characters → 33 characters');
    expect(dialog.text).toContain('Adds: a new line at the end — the existing 22 characters stay exactly as they are.');
    expect(dialog.text).toContain('Removed: nothing');
    expect(dialog.text).toContain('Added:  ↵ third line');
    expect(dialog.text).toContain('Writes: case_notes only');
  });

  test('the builder names the column by the KIND and sends nothing else; a bad id or over-cap text never reaches the route', async () => {
    // A draft claiming another field still writes the kind's own column.
    const alerts = caseDraft({ kind: 'case.alerts.update.v1', field: 'case_status', after: 'Hard of hearing', expected: { case_alerts: '' } });
    const r = await runText(alerts, { write: async () => ({ status: 'success', data: { case_id: CASE_ID } }) });
    expect(r.writes).toEqual([{ path: `/api/cases/${CASE_ID}`, method: 'PATCH', headers: undefined, body: { case_alerts: 'Hard of hearing' } }]);
    for (const [over, why] of [[{ target: { type: 'case', case_id: 'bad id' } }, 'This card has no usable case id.'],
      [{ after: 'x'.repeat(10001) }, 'longer than the 10,000 characters'],
      [{ kind: 'case.alerts.update.v1', after: 'x'.repeat(5001), expected: { case_alerts: '' } }, 'longer than the 5,000 characters'],
      [{ after: 5 }, 'This card has no usable text.']]) {
      const d = caseDraft(over);
      const x = await runText(d);
      // Refused at the re-check, before any read, claim or write.
      expect({ why, gets: x.gets, ledger: x.ledger, writes: x.writes }).toEqual({ why, gets: [], ledger: [], writes: [] });
      expect(d.action_draft.action_error).toContain(why);
    }
  });

  test('click-time freshness compares by VALUE and refuses BEFORE the claim; a failed read leaves the card retryable', async () => {
    for (const [read, why] of [
      [reads({ case: { case_notes: 'first line\nsecond line ' } }), 'The case notes changed since this card was prepared. Nothing was written. Ask Casey to prepare it again.'],
      [reads({ case: { case_notes: '' } }), 'The case notes changed since this card was prepared.'],
      [reads({ gone: true }), 'Case 25-12345-abc no longer exists. Nothing was written.'],
    ]) {
      const d = caseDraft();
      const x = await runText(d, { read });
      expect({ why, writes: x.writes, ledger: x.ledger }).toEqual({ why, writes: [], ledger: [] });
      expect(d.action_draft.refusal_error).toContain(why);
    }
    // An unrelated column changing is not staleness.
    const ok = await runText(caseDraft(), { read: reads({ case: { case_alerts: 'new alert', case_stage: 'Filed' } }) });
    expect(ok.writes).toHaveLength(1);
    const u = caseDraft();
    const ur = await runText(u, { read: () => ({ status: 'success' }) });
    expect([ur.writes, ur.ledger]).toEqual([[], []]);
    expect(u.action_draft.action_error).toMatch(/^Could not re-check the record before applying \(the case could not be read\)/);
  });

  test('contact notes: the CONTACT is named, the PATCH carries contact_notes only, the receipt is the integer contact_id', async () => {
    const m = contactDraft();
    const r = await runText(m);
    expect(r.sandbox.actionFamily(m.action_draft).id).toBe('contact_text');
    expect(r.gets).toEqual(['/api/contacts/77']);
    expect(r.writes).toEqual([{ path: '/api/contacts/77', method: 'PATCH', headers: undefined, body: { contact_notes: 'Prefers email\nTexts after 5pm' } }]);
    expect(r.ledger).toEqual(['claim', { receipt: { claim_token: 'tok-a7', result: { contact_id: 77 } } }]);
    expect(m.action_draft.result_text_contact_id).toBe(77);
    expect(r.openEntity).toHaveBeenCalledWith('contact', 77, 'Dana Client');
    const text = r.P.Swal.fire.mock.calls[0][0].text;
    expect(text).toContain('Contact: Dana Client (contact #77, person)');
    expect(text).toContain("Scope: the CONTACT's own notes — not a case note. The same text shows wherever this contact appears (2 linked cases).");
    const stale = contactDraft();
    const s = await runText(stale, { read: reads({ contact: { contact_notes: 'Prefers phone' } }) });
    expect([s.writes, s.ledger]).toEqual([[], []]);
    expect(stale.action_draft.refusal_error).toBe('The contact notes changed since this card was prepared. Nothing was written. Ask Casey to prepare it again.');
  });

  test('a clear says so and is danger-styled; a rewrite that drops text is danger-styled; outcomes map like every family', async () => {
    const clear = caseDraft({ kind: 'case.alerts.update.v1', after: '', mode: 'clear', expected: { case_alerts: 'Hard of hearing' } });
    const c = await runText(clear, { read: reads({ case: { case_alerts: 'Hard of hearing' } }), confirm: false });
    const dialog = c.P.Swal.fire.mock.calls[0][0];
    expect(dialog).toMatchObject({ icon: 'warning', focusCancel: true, title: 'Clear case alerts', confirmButtonText: 'Clear case alerts' });
    expect(dialog.text).toContain('Clears: the case alerts — all 15 characters are removed and the field is left empty.');
    expect(dialog.text).toContain('Removed: Hard of hearing');
    expect([c.writes, c.gets, c.ledger]).toEqual([[], [], []]);
    const rewrite = caseDraft({ after: 'first line\n2nd line', mode: 'replace' });
    const rw = await runText(rewrite, { confirm: false });
    expect(rw.P.Swal.fire.mock.calls[0][0]).toMatchObject({ icon: 'warning' });
    expect(rw.P.Swal.fire.mock.calls[0][0].text).toContain('Removed: second');
    expect(rw.P.Swal.fire.mock.calls[0][0].text).toContain('Added: 2nd');
    const refused = caseDraft();
    await runText(refused, { write: async () => { throw Object.assign(new Error('case_notes is 10,001 characters'), { status: 400 }); } });
    expect(refused.action_draft.refusal_error).toBe('Refused — nothing written (case_notes is 10,001 characters). Ask Casey to prepare it again.');
    const lost = caseDraft();
    await runText(lost, { write: async () => { throw Object.assign(new Error('Internal'), { status: 500 }); } });
    expect(lost.action_draft.ambiguous_error).toMatch(/may already have been applied/);
    // A route answering for another case is not this card's receipt.
    const wrong = caseDraft();
    await runText(wrong, { write: async () => ({ status: 'success', data: { case_id: 'OTHER123' } }) });
    expect(wrong.action_draft.ambiguous_error).toMatch(/The case route returned no usable case id/);
    const wrongContact = contactDraft();
    await runText(wrongContact, { write: async () => ({ status: 'success', data: { contact_id: 78 } }) });
    expect(wrongContact.action_draft.ambiguous_error).toMatch(/The contact route returned no usable contact id/);
  });

  test('a 10,000-character note renders only the changed region, bounded', async () => {
    const before = `${'a'.repeat(5000)}MIDDLE${'b'.repeat(4994)}`;
    const after = `${'a'.repeat(5000)}CENTER${'b'.repeat(4994)}`;
    const m = caseDraft({ after, mode: 'replace', expected: { case_notes: before } });
    const r = await runText(m, { read: reads({ case: { case_notes: before } }), confirm: false });
    const text = r.P.Swal.fire.mock.calls[0][0].text;
    expect(text).toContain('Size: 10,000 characters → 10,000 characters');
    expect(text).toContain('Removed: MIDDLE');
    expect(text).toContain('Added: CENTER');
    // Exactly RECORD_TEXT_CONTEXT unchanged characters, then the next line.
    expect(text).toContain(`Unchanged before: …${'a'.repeat(80)}\nRemoved: MIDDLE`);
    expect(text).toContain(`Unchanged after: ${'b'.repeat(80)}…`);
    expect(text.length).toBeLessThan(2000);
    // A whole rewrite keeps each part's head and tail and says how much is not shown.
    const big = caseDraft({ after: 'y'.repeat(9000), mode: 'replace', expected: { case_notes: 'x'.repeat(9000) } });
    const b = await runText(big, { read: reads({ case: { case_notes: 'x'.repeat(9000) } }), confirm: false });
    const bigText = b.P.Swal.fire.mock.calls[0][0].text;
    expect(bigText).toContain(`Removed: ${'x'.repeat(300)} … [8,400 characters not shown] … ${'x'.repeat(300)}`);
    expect(bigText.length).toBeLessThan(3000);
  });

  test('reopened cards restore from the ledger: the string case receipt survives intact, never NaN', () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><div></div>');
    const box = actionSandbox({ document: dom.window.document, navigator: dom.window.navigator });
    for (const [m, result, chip, open] of [[caseDraft(), { case_id: CASE_ID }, 'Applied — case notes saved', 'Open 25-12345-abc'],
      [contactDraft(), { contact_id: 77 }, 'Applied — contact notes saved', 'Open Dana Client']]) {
      box.applyActionResults([m], [{ draft_id: m.action_draft.draft_id, kind: m.action_draft.kind, outcome: 'applied', result }]);
      expect(m.action_draft.status).toBe('applied');
      const host = dom.window.document.createElement('div');
      box.hydrateActionDraft(box.actionFamily(m.action_draft), host, m, m.action_draft);
      expect(host.querySelector('.action-draft-status').textContent).toBe(chip);
      expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual([open, 'Copy details']);
    }
    const restored = caseDraft();
    box.applyActionResults([restored], [{ draft_id: restored.action_draft.draft_id, kind: 'case.notes.update.v1', outcome: 'applied', result: { case_id: CASE_ID } }]);
    expect(restored.action_draft.result_text_case_id).toBe(CASE_ID);
    // The legacy chat-marker path (no ledger row) restores the string too.
    const legacy = caseDraft();
    box.applyActionResults([legacy, { role: 'assistant', action_result: { kind: 'case.notes.update.v1', draft_id: legacy.action_draft.draft_id, case_id: CASE_ID } }], []);
    expect([legacy.action_draft.status, legacy.action_draft.result_text_case_id]).toEqual(['applied', CASE_ID]);
    // Two families, distinct applied keys; only the case family is string-receipted.
    const ct = box.actionFamily({ kind: 'case.alerts.update.v1' }); const kt = box.actionFamily({ kind: 'contact.notes.update.v1' });
    expect([[...ct.kinds], [...kt.kinds]]).toEqual([['case.notes.update.v1', 'case.alerts.update.v1'], ['contact.notes.update.v1']]);
    expect([ct.appliedKey, kt.appliedKey, ct.idField, kt.idField, ct.stringReceipt, !!kt.stringReceipt]).toEqual(['result_text_case_id', 'result_text_contact_id', 'case_id', 'contact_id', true, false]);
    for (const kind of ['case.update.v1', 'case.source.update.v1', 'contact.update.v1']) expect(box.actionFamily({ kind })).toBe(null);
    dom.window.close();
  });
});

// A8: case-contact membership through the SHARED engine. Pinned: the builder
// sends only the route's own fields, named by the KIND (POST {contact_id,
// relate_type}, PATCH {relate_type}, DELETE no body), with no Idempotency-Key;
// the click-time re-read compares the case's WHOLE membership set and the
// contact's portal flag and (change / remove) the list row's portal_used, and
// refuses BEFORE the claim (which is how a contact who used the portal since
// the card was prepared — a demotion that became a portal-user demotion — is
// refused); the
// receipt is the integer case_relate_id; the routes' two before-write refusals
// (add 409 "already linked", change/remove 404) read as refusals, not as
// "may have been applied".
describe('A8 case contact cards (case.contact.add / update / remove)', () => {
  const CASE_ID = '7KQ2M9XA';
  const MEMBERS = [
    { relate_id: 11, contact_id: 77, relate_type: 'Primary', portal_used: 1 },
    { relate_id: 12, contact_id: 78, relate_type: 'Secondary', portal_used: 1 },
    { relate_id: 13, contact_id: 90, relate_type: 'Other', portal_used: 0 },
  ];
  const draft = (over = {}) => ({ action_draft: {
    draft_id: '7a7a7a7a-1b2c-4d3e-8f40-123456789abc', kind: 'case.contact.add.v1', status: 'draft', received_at: Date.now(),
    case: { case_id: CASE_ID, case_number: '25-12345-abc', case_type: 'Chapter 7' },
    contact: { contact_id: 92, contact_name: 'Nora New', contact_kind: 'person', portal_enabled: 1 },
    membership: { case_relate_id: null, from: null, to: 'Secondary' },
    members_after: [{ contact_id: 77, contact_name: 'Dana Client', relate_type: 'Primary' }, { contact_id: 92, contact_name: 'Nora New', relate_type: 'Secondary' }],
    members_after_total: 4,
    effects: ['Trigger event: case.contact_linked fires (relate_type Secondary) — any trigger rule listening for it runs.'],
    warnings: ["CLIENT PORTAL: Nora New has client-portal access, so this case — its documents, messages and status — shows in Nora New's portal from the moment this is saved."],
    expected: { members: MEMBERS.map(({ portal_used, ...m }) => m), portal_enabled: 1, portal_used: null }, evidence: [],
    // Model-shaped junk that must never reach a request.
    relate_type: 'Bystander', case_relate_type: 'Other', contact_id: 1,
    ...over } });
  const change = (over = {}) => draft({ draft_id: '6b6b6b6b-1b2c-4d3e-8f40-123456789abc', kind: 'case.contact.update.v1',
    contact: { contact_id: 90, contact_name: 'Opposing Counsel', contact_kind: 'person', portal_enabled: 0, portal_used: false },
    membership: { case_relate_id: 13, from: 'Other', to: 'Bystander' }, warnings: [],
    expected: { members: MEMBERS.map(({ portal_used, ...m }) => m), portal_enabled: 0, portal_used: false }, ...over });
  const removal = (over = {}) => change({ draft_id: '5c5c5c5c-1b2c-4d3e-8f40-123456789abc', kind: 'case.contact.remove.v1',
    membership: { case_relate_id: 13, from: 'Other', to: null }, ...over });
  const reads = (over = {}) => (path) => {
    if (path === `/api/cases/${CASE_ID}`) { if (over.caseGone) throw Object.assign(new Error('Case not found'), { status: 404 }); return { case: { case_id: CASE_ID } }; }
    if (path === `/api/cases/${CASE_ID}/contacts`) return over.list || { contacts: (over.members || MEMBERS).map((m) => ({ contact_name: 'n', ...m })) };
    if (/^\/api\/contacts\/\d+$/.test(path)) {
      if (over.contactGone) throw Object.assign(new Error('Contact not found'), { status: 404 });
      return { contact: { contact_id: Number(path.split('/').pop()), portal_enabled: 'portal' in over ? over.portal : (path.endsWith('/92') ? 1 : 0) } };
    }
    throw new Error(`unexpected read ${path}`);
  };
  function runMember(message, { read = reads(), write = async (path, body, method) => (method === 'POST'
    ? { status: 'success', case_relate_id: 501 } : { status: 'success', message: 'ok' }), confirm = true } = {}) {
    const writes = []; const gets = []; const ledger = [];
    const api = jest.fn(async (path, body, method, headers) => {
      if (method === 'GET') { gets.push(path); return read(path); }
      writes.push({ path, body, method, headers }); return write(path, body, method);
    });
    const ledgerApi = jest.fn(async (path, body) => { ledger.push(path.endsWith('/claim') ? 'claim' : { receipt: body }); return path.endsWith('/claim') ? { outcome: 'in_flight', claimed: true, claim_token: 'tok-a8' } : { outcome: 'applied' }; });
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: confirm }) } };
    const history = []; const openEntity = jest.fn();
    const sandbox = actionSandbox({ P, api, ledgerApi, history, openEntity, saveAssistantMessage: jest.fn() });
    return sandbox.executeActionDraft(message).then(() => ({ writes, gets, ledger, P, history, openEntity, sandbox }));
  }

  test('add: re-reads case, membership set and portal flag; ONE POST of contact_id + relate_type; integer receipt; opens the case', async () => {
    const m = draft();
    const { writes, gets, ledger, P, history, openEntity, sandbox } = await runMember(m);
    expect(sandbox.actionFamily(m.action_draft).id).toBe('case_contact');
    expect(gets).toEqual([`/api/cases/${CASE_ID}`, `/api/cases/${CASE_ID}/contacts`, '/api/contacts/92']);
    expect(writes).toEqual([{ path: `/api/cases/${CASE_ID}/contacts`, method: 'POST', headers: undefined, body: { contact_id: 92, relate_type: 'Secondary' } }]);
    expect(ledger).toEqual(['claim', { receipt: { claim_token: 'tok-a8', result: { case_relate_id: 501 } } }]);
    expect(m.action_draft).toMatchObject({ status: 'applied', result_case_relate_id: 501 });
    expect(history[0].text).toBe('Add contact to case applied to case membership #501.');
    expect(history[0].entities).toEqual([{ kind: 'case', id: CASE_ID, label: '25-12345-abc' }]);
    expect(openEntity).toHaveBeenCalledWith('case', CASE_ID, '25-12345-abc');
    const dialog = P.Swal.fire.mock.calls[0][0];
    // A portal-exposure warning danger-styles the review.
    expect(dialog).toMatchObject({ icon: 'warning', focusCancel: true, confirmButtonText: 'Add contact to case' });
    for (const line of [`Case: 25-12345-abc (case ${CASE_ID}, Chapter 7)`, 'Contact: Nora New (contact #92, person)',
      'Client portal access: on', 'Role: not on the case → Secondary', 'Warning: CLIENT PORTAL: Nora New has client-portal access',
      'Effect: Trigger event: case.contact_linked fires', 'Contacts after: Dana Client — Primary; Nora New — Secondary (+2 more)',
      'Writes: one new case membership row', 'Stale check: if anyone adds, removes or changes a contact on this case']) {
      expect({ line, shown: dialog.text.includes(line) }).toEqual({ line, shown: true });
    }
  });

  test('change role: PATCH {relate_type} only, receipt = the reviewed row; a warning-free change is not danger-styled', async () => {
    const m = change();
    const r = await runMember(m);
    expect(r.gets).toEqual([`/api/cases/${CASE_ID}/contacts`, '/api/contacts/90']);
    expect(r.writes).toEqual([{ path: `/api/cases/${CASE_ID}/contacts/90`, method: 'PATCH', headers: undefined, body: { relate_type: 'Bystander' } }]);
    expect(r.ledger[1]).toEqual({ receipt: { claim_token: 'tok-a8', result: { case_relate_id: 13 } } });
    const dialog = r.P.Swal.fire.mock.calls[0][0];
    expect(dialog).toMatchObject({ icon: 'question', confirmButtonText: 'Change case role' });
    expect(dialog.text).toContain('Role: Other → Bystander');
    expect(dialog.text).toContain('Client portal access: off (never used)');
    // A route that did not confirm is not a receipt.
    const unconfirmed = change();
    await runMember(unconfirmed, { write: async () => ({ message: 'ok' }) });
    expect(unconfirmed.action_draft.ambiguous_error).toMatch(/did not confirm the change/);
  });

  test('remove: DELETE with no body, always danger-styled, receipt = the removed row', async () => {
    const m = removal();
    const r = await runMember(m);
    expect(r.writes).toEqual([{ path: `/api/cases/${CASE_ID}/contacts/90`, method: 'DELETE', headers: undefined, body: null }]);
    expect(r.ledger[1]).toEqual({ receipt: { claim_token: 'tok-a8', result: { case_relate_id: 13 } } });
    const dialog = r.P.Swal.fire.mock.calls[0][0];
    expect(dialog).toMatchObject({ icon: 'warning', focusCancel: true, confirmButtonText: 'Remove contact from case' });
    expect(dialog.text).toContain('Role: Other → removed from the case');
    expect(dialog.text).toContain('Membership: #13 is deleted');
  });

  test('the builder fixes route, method and body; a bad card never reaches a read, the claim or the route', async () => {
    for (const [message, why] of [
      [draft({ case: { case_id: 'bad id', case_number: 'x' } }), 'This card has no usable case id.'],
      [draft({ contact: { contact_id: 'x', contact_name: 'N' } }), 'This card has no usable contact id.'],
      [draft({ case: { case_id: 'ABCDEFGHJK', case_number: 'x' } }), 'longer than a case membership stores'],
      [draft({ membership: { case_relate_id: null, from: null, to: 'Debtor' } }), 'This card has no usable case role.'],
      [change({ membership: { case_relate_id: 13, from: 'Other', to: 'Other' } }), 'This card has no usable case role.'],
      [change({ membership: { case_relate_id: 0, from: 'Other', to: 'Bystander' } }), 'This card has no usable membership id.'],
      [removal({ membership: { case_relate_id: 'x', from: 'Other', to: null } }), 'This card has no usable membership id.'],
    ]) {
      const x = await runMember(message);
      expect({ why, gets: x.gets, ledger: x.ledger, writes: x.writes }).toEqual({ why, gets: [], ledger: [], writes: [] });
      expect(message.action_draft.action_error).toContain(why);
    }
  });

  test('click-time freshness: any change to the membership set or the portal flag refuses BEFORE the claim', async () => {
    const changed = MEMBERS.map((m) => (m.contact_id === 78 ? { ...m, relate_type: 'Other' } : m));
    for (const [message, read, why] of [
      [change(), reads({ members: changed }), 'The contacts on case 25-12345-abc changed since this card was prepared'],
      [draft(), reads({ members: [...MEMBERS, { relate_id: 20, contact_id: 92, relate_type: 'Other' }] }), 'The contacts on case 25-12345-abc changed'],
      [removal(), reads({ members: MEMBERS.filter((m) => m.relate_id !== 13) }), 'Opposing Counsel is no longer on case 25-12345-abc as membership #13 — already removed. Nothing was written.'],
      [change(), reads({ members: MEMBERS.map((m) => (m.relate_id === 13 ? { ...m, relate_id: 30 } : m)) }), 'is no longer on case 25-12345-abc as membership #13. Nothing was written.'],
      // Portal access turned ON since the card: this demotion would now hide the case from a portal user.
      [change(), reads({ portal: 1 }), "Opposing Counsel's client-portal access changed since this card was prepared. Nothing was written."],
      // Off only when it says so: a null reads as access, so a card baked with access off refuses.
      [removal(), reads({ portal: null }), "client-portal access changed since this card was prepared"],
      [draft(), reads({ portal: 0 }), "Nora New's client-portal access changed"],
      [draft(), reads({ caseGone: true }), 'Case 25-12345-abc no longer exists. Nothing was written.'],
      // Used the portal since the review (a login or a PIN request): the demotion / removal is now a portal user's.
      [change(), reads({ members: MEMBERS.map((m) => (m.relate_id === 13 ? { ...m, portal_used: 1 } : m)) }), "Opposing Counsel's use of the client portal changed since this card was prepared (they have now used it, so Casey will not take this case out of their portal). Nothing was written."],
      [removal(), reads({ members: MEMBERS.map((m) => (m.relate_id === 13 ? { ...m, portal_used: 1 } : m)) }), "use of the client portal changed since this card was prepared"],
      // Off only when it says so: a list row without the field reads as use.
      [removal(), reads({ members: MEMBERS.map((m) => (m.relate_id === 13 ? { relate_id: 13, contact_id: 90, relate_type: 'Other' } : m)) }), "use of the client portal changed"],
      [change(), reads({ contactGone: true }), 'Opposing Counsel (contact #90) no longer exists. Nothing was written.'],
    ]) {
      const x = await runMember(message, { read });
      expect({ why, writes: x.writes, ledger: x.ledger }).toEqual({ why, writes: [], ledger: [] });
      expect(message.action_draft.refusal_error).toContain(why);
    }
    // An unreadable list leaves the card retryable (nothing claimed).
    const u = change();
    const ur = await runMember(u, { read: reads({ list: { status: 'success' } }) });
    expect([ur.writes, ur.ledger]).toEqual([[], []]);
    expect(u.action_draft.action_error).toMatch(/^Could not re-check the record before applying \(the case's contacts could not be read\)/);
  });

  test("outcomes: the add's 409 and a change/remove 404 are refusals written before any row; a 500 stays ambiguous", async () => {
    const dup = draft();
    await runMember(dup, { write: async () => { throw Object.assign(new Error('Contact 92 is already linked to case 7KQ2M9XA as Secondary'), { status: 409 }); } });
    expect(dup.action_draft.refusal_error).toBe('Refused — nothing written: that contact is already on this case in that role (Contact 92 is already linked to case 7KQ2M9XA as Secondary). Ask Casey to read the case again.');
    expect(dup.action_draft.ambiguous_error).toBeUndefined();
    const gone = removal();
    await runMember(gone, { write: async () => { throw Object.assign(new Error('Relationship not found'), { status: 404 }); } });
    expect(gone.action_draft.refusal_error).toBe('Refused — nothing written: that contact is no longer on this case (already removed). Ask Casey to read the case again.');
    // A 409 that is not the route's own refusal stays ambiguous.
    const other409 = draft();
    await runMember(other409, { write: async () => { throw Object.assign(new Error('conflict'), { status: 409 }); } });
    expect(other409.action_draft.ambiguous_error).toMatch(/may already have been applied/);
    const lost = change();
    await runMember(lost, { write: async () => { throw Object.assign(new Error('Internal'), { status: 500 }); } });
    expect(lost.action_draft.ambiguous_error).toMatch(/may already have been applied/);
    const noId = draft();
    await runMember(noId, { write: async () => ({ status: 'success' }) });
    expect(noId.action_draft.ambiguous_error).toMatch(/returned no usable membership id/);
  });

  test('reopened cards restore from the ledger with the integer receipt; the three kinds are one family', () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><div></div>');
    const box = actionSandbox({ document: dom.window.document, navigator: dom.window.navigator });
    for (const [m, result, chip] of [[draft(), { case_relate_id: 501 }, 'Applied — membership #501'],
      [change(), { case_relate_id: 13 }, 'Applied — membership #13'], [removal(), { case_relate_id: 13 }, 'Applied — membership #13 removed']]) {
      box.applyActionResults([m], [{ draft_id: m.action_draft.draft_id, kind: m.action_draft.kind, outcome: 'applied', result }]);
      expect([m.action_draft.status, m.action_draft.result_case_relate_id]).toEqual(['applied', result.case_relate_id]);
      const host = dom.window.document.createElement('div');
      box.hydrateActionDraft(box.actionFamily(m.action_draft), host, m, m.action_draft);
      expect(host.querySelector('.action-draft-status').textContent).toBe(chip);
      expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Open 25-12345-abc', 'Copy details']);
    }
    const fam = box.actionFamily({ kind: 'case.contact.remove.v1' });
    expect([[...fam.kinds], fam.idField, fam.appliedKey, !!fam.stringReceipt])
      .toEqual([['case.contact.add.v1', 'case.contact.update.v1', 'case.contact.remove.v1'], 'case_relate_id', 'result_case_relate_id', false]);
    for (const kind of ['case.contact.set.v1', 'case.contacts.update.v1']) expect(box.actionFamily({ kind })).toBe(null);
    dom.window.close();
  });
});
