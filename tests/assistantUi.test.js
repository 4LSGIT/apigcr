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
  'apptActionLabel', 'apptChannelsText', 'apptDraftText', 'apptCreateBody', 'apptActionRequest', 'apptActionResult',
  'contactSubrecordActionLabel', 'contactAddressText', 'contactSubrecordValue', 'contactSubrecordDraftText',
  'contactSubrecordCreateBody', 'contactSubrecordActionRequest', 'contactSubrecordActionResult',
  'jobActionLabel', 'jobScheduleText', 'jobDraftText', 'jobActionRequest', 'jobActionResult',
  'workflowDraftLabel', 'workflowSendLines', 'workflowDraftStepLine', 'workflowDraftText', 'workflowDraftRequest', 'workflowDraftResult',
  'workflowStepActionLabel', 'workflowStepWorkflowLine', 'workflowStepInsertText', 'workflowStepEditValue',
  'workflowStepEditText', 'workflowStepActionText', 'workflowStepActionRequest', 'workflowStepActionResult',
  'workflowPublishLabel', 'workflowPublishChangeLine', 'workflowPublishText', 'workflowPublishRequest', 'workflowPublishResult',
  'hookCreateLabel', 'hookTargetText', 'hookCreateText', 'hookCreateRequest', 'hookCreateResult',
  'sequenceStepActionLabel', 'sequenceStepParamValue', 'sequenceStepText', 'sequenceStepActionRequest', 'sequenceStepActionResult',
  'openAutomationRecord',
  'sendIsSms', 'sendActionLabel', 'sendRecipientLine', 'sendOptoutText', 'sendFactLines', 'sendDraftText', 'sendDraftFields', 'sendConfirmText', 'sendActionRequest',
  'sendPrecheck', 'sendActionDispatch', 'sendActionResult', 'sendResultText', 'openSendRecord',
  'reportDraftLabel', 'reportSsnText', 'reportVizText', 'reportCardText', 'reportDraftFields', 'reportConfirmText', 'reportDraftRequest', 'reportDraftResult',
  'actionFamily', 'isActionDraft', 'actionAppliedId', 'markActionApplied', 'confirmActionDraft',
  'executeActionDraft', 'applyActionResults', 'hydrateActionDraft'];

function actionSandbox(deps = {}) {
  const registry = constSrc(html, 'ACTION_FAMILIES');
  expect(registry.endsWith('];')).toBe(true);
  expect(registry).toContain("id: 'task'");
  const src = [
    'const ACTION_DRAFT_TTL_MS=15*60*1000;',
    constSrc(html, 'TASK_ACTION_KINDS'), constSrc(html, 'EVENT_ACTION_KINDS'),
    constSrc(html, 'APPT_ACTION_KINDS'), constSrc(html, 'CONTACT_SUBRECORD_ACTION_KINDS'),
    constSrc(html, 'JOB_ACTION_KINDS'), constSrc(html, 'WORKFLOW_ACTION_KINDS'),
    constSrc(html, 'WORKFLOW_STEP_ACTION_KINDS'), constSrc(html, 'WORKFLOW_PUBLISH_ACTION_KINDS'),
    constSrc(html, 'HOOK_ACTION_KINDS'), constSrc(html, 'SEQUENCE_STEP_ACTION_KINDS'), constSrc(html, 'SEND_ACTION_KINDS'),
    constSrc(html, 'REPORT_ACTION_KINDS'),
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
    const request = new Function(`${fnSrc(html, 'apptCreateBody')};${fnSrc(html, 'apptActionRequest')};return apptActionRequest;`)(); // eslint-disable-line no-new-func
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
    const reviewText = new Function(`${fnSrc(html, 'apptActionLabel')};${fnSrc(html, 'apptChannelsText')};${fnSrc(html, 'apptDraftText')};return apptDraftText;`)(); // eslint-disable-line no-new-func
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

  test('the retry-receipt button is sized like the other card buttons', () => {
    // It lives in the warning block beside the error it belongs to, so it is
    // outside `.action-draft-actions button` and needs its own metrics.
    expect(html).toContain("retry.className = 'action-draft-retry'");
    expect(html).toMatch(/\.action-draft-actions button, \.action-draft-retry \{[^}]*font-size: 12px/);
  });

  test('appointment review text never offers a client send', () => {
    const channels = new Function(`${fnSrc(html, 'apptChannelsText')};return apptChannelsText;`)(); // eslint-disable-line no-new-func
    expect(channels({ confirm_sms: true, confirm_message: 'Hi {{contacts.contact_ssn}}' })).toMatch(/^None — this appointment card sends no client SMS or email/);
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
  const execute = new Function('api', `const history = []; function render() {}; const currentChatId = 41;
    ${fnSrcAuto(html, 'executeAutomatically')}; return executeAutomatically;`)(api);
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
  const KEEP_FNS = ['compactInvestigation', 'keepGoingHtml', 'answerMessage', 'keepGoing', 'askCaseyAgain', 'saveAssistantMessage'];
  function keepSandbox(deps = {}) {
    const supplied = {
      history: [], busy: false, currentChatId: 41, historyAvailable: true, modelMode: { value: 'better_quality' },
      api: jest.fn(), render: jest.fn(), setBusy: jest.fn(), saveUserMessage: jest.fn().mockResolvedValue(),
      requestAttachments: jest.fn().mockResolvedValue({ temporary: [], documentIds: [] }),
      input: { value: '', focus: jest.fn() }, ...deps,
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
