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
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`function ${name} unbalanced`);
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
    expect(html).toContain('navigator.clipboard.writeText(taskDraftText(draft))');
    expect(html).toContain('delete message.action_draft; render()');
    expect(html).toContain('...(r.action_draft ? { action_draft: r.action_draft } : {})');
    expect(html).toContain('...(message.action_draft ? { action_draft: message.action_draft } : {})');
    expect(html).toContain("return { path: '/api/tasks', method: 'POST', body: taskCreateBody(draft) }");
    expect(html).toContain("P.Swal.fire({");
    expect(html).toContain('if (!await confirmTaskDraft(draft)) return');
    expect(html).not.toContain('window.confirm(');
    expect(route).not.toContain('/api/assistant/actions');
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
    const make = new Function('P', 'api', 'render', 'history', 'saveAssistantMessage',
      `const TASK_ACTION_KINDS=new Set(['task.create.v1']);${fnSrc(html, 'isTaskActionDraft')};${fnSrc(html, 'taskCreateBody')};${fnSrc(html, 'taskUpdateBody')};${fnSrc(html, 'taskActionLabel')};${fnSrc(html, 'taskActionRequest')};${fnSrc(html, 'taskDraftText')};${fnSrc(html, 'taskDraftConfirmation')};async ${fnSrc(html, 'confirmTaskDraft')};async ${fnSrc(html, 'executeTaskDraft')};return executeTaskDraft;` // eslint-disable-line no-new-func
    )(P, api, render, history, saveAssistantMessage);
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
    }, 'POST');
    expect(message.action_draft).toMatchObject({ status: 'applied', result_task_id: 77, executing: false });
    expect(render).toHaveBeenCalled();
    expect(history).toEqual([expect.objectContaining({
      text: 'Create task applied to task #77.',
      action_result: { kind: 'task.create.v1', draft_id: 'draft-123', task_id: 77 },
    })]);
    expect(saveAssistantMessage).toHaveBeenCalledWith(history[0]);
    expect(P.tasksBadgeRefresh).toHaveBeenCalledTimes(1);
    expect(reloadTasks).toHaveBeenCalledTimes(1);

    await make(message);
    expect(api).toHaveBeenCalledTimes(1);
    expect(P.showTask).toHaveBeenCalledWith(77);
  });

  test('a saved action result restores its exact proposal as applied without another write', () => {
    const apply = new Function(`const TASK_ACTION_KINDS=new Set(['task.create.v1','task.cancel.v1']);${fnSrc(html, 'applyTaskActionResults')}; return applyTaskActionResults;`)(); // eslint-disable-line no-new-func
    const messages = [
      { action_draft: { draft_id: 'one', kind: 'task.create.v1', status: 'draft' } },
      { action_draft: { draft_id: 'two', kind: 'task.create.v1', status: 'draft' } },
      { action_result: { kind: 'task.create.v1', draft_id: 'one', task_id: 91 } },
    ];
    expect(apply(messages)).toBe(messages);
    expect(messages[0].action_draft).toMatchObject({ status: 'applied', result_task_id: 91 });
    expect(messages[1].action_draft).toMatchObject({ status: 'draft' });
  });

  test('a task create is single-flight and a failed insert leaves a retryable inline error', async () => {
    let rejectWrite;
    const api = jest.fn(() => new Promise((_resolve, reject) => { rejectWrite = reject; }));
    const render = jest.fn();
    const history = [];
    const saveAssistantMessage = jest.fn();
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) }, showTask: jest.fn() };
    const make = new Function('P', 'api', 'render', 'history', 'saveAssistantMessage',
      `const TASK_ACTION_KINDS=new Set(['task.create.v1']);${fnSrc(html, 'isTaskActionDraft')};${fnSrc(html, 'taskCreateBody')};${fnSrc(html, 'taskUpdateBody')};${fnSrc(html, 'taskActionLabel')};${fnSrc(html, 'taskActionRequest')};${fnSrc(html, 'taskDraftText')};${fnSrc(html, 'taskDraftConfirmation')};async ${fnSrc(html, 'confirmTaskDraft')};async ${fnSrc(html, 'executeTaskDraft')};return executeTaskDraft;` // eslint-disable-line no-new-func
    )(P, api, render, history, saveAssistantMessage);
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
    expect(message.action_draft).toMatchObject({ status: 'draft', executing: false, action_error: 'Task insert failed' });
    expect(history).toEqual([]);
    expect(saveAssistantMessage).not.toHaveBeenCalled();
  });

  test('maps every event action to the canonical route with an exact allowlisted body', () => {
    const request = new Function(`${fnSrc(html, 'eventCreateBody')};${fnSrc(html, 'eventUpdateBody')};${fnSrc(html, 'eventActionRequest')};return eventActionRequest;`)(); // eslint-disable-line no-new-func
    const create = { kind: 'event.create.v1', type: { event_type: 'Hearing', kind: 'hearing' }, event_title: 'Confirmation hearing',
      event_date: '2026-10-27', event_time: '09:30:00', event_all_day: false, event_length: 45,
      event_location: 'Court', event_link: null, event_note: 'Bring order', link: { type: 'case', id: 'C1', label: '26-1' },
      event_with: { user_id: 8, label: 'Provider' }, reminder: { to: 7, date: '2026-10-26', label: 'Fred' }, ignored: 'never send' };
    expect(request(create)).toEqual({ path: '/api/events', method: 'POST', body: {
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
    const make = new Function('P', 'api', 'render', 'history', 'saveAssistantMessage',
      `const EVENT_ACTION_KINDS=new Set(['event.cancel.v1']);${fnSrc(html, 'isEventActionDraft')};${fnSrc(html, 'eventActionLabel')};${fnSrc(html, 'eventTypeText')};${fnSrc(html, 'eventProviderText')};${fnSrc(html, 'eventReminderText')};${fnSrc(html, 'eventDraftText')};${fnSrc(html, 'eventCreateBody')};${fnSrc(html, 'eventUpdateBody')};${fnSrc(html, 'eventActionRequest')};async ${fnSrc(html, 'confirmEventDraft')};async ${fnSrc(html, 'executeEventDraft')};return executeEventDraft;` // eslint-disable-line no-new-func
    )(P, api, render, history, saveAssistantMessage);
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
    expect(saveAssistantMessage).toHaveBeenCalledWith(history[0]);
    expect(P.showEvent).toHaveBeenCalledWith(42);
    await make(message);
    expect(api).toHaveBeenCalledTimes(1);
  });

  test('failed event writes stay retryable and saved results prevent history replay', async () => {
    const apply = new Function('EVENT_ACTION_KINDS', `${fnSrc(html, 'applyEventActionResults')};return applyEventActionResults;`)(new Set(['event.update.v1'])); // eslint-disable-line no-new-func
    const messages = [{ action_draft: { draft_id: 'event-2', kind: 'event.update.v1', status: 'draft' } },
      { action_result: { draft_id: 'event-2', kind: 'event.update.v1', event_id: 42 } }];
    expect(apply(messages)[0].action_draft).toMatchObject({ status: 'applied', result_event_id: 42 });

    const api = jest.fn().mockRejectedValue(new Error('Event update failed')); const render = jest.fn();
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) }, showEvent: jest.fn() };
    const make = new Function('P', 'api', 'render', 'history', 'saveAssistantMessage',
      `const EVENT_ACTION_KINDS=new Set(['event.update.v1']);${fnSrc(html, 'isEventActionDraft')};${fnSrc(html, 'eventActionLabel')};${fnSrc(html, 'eventTypeText')};${fnSrc(html, 'eventProviderText')};${fnSrc(html, 'eventReminderText')};${fnSrc(html, 'eventDraftText')};${fnSrc(html, 'eventCreateBody')};${fnSrc(html, 'eventUpdateBody')};${fnSrc(html, 'eventActionRequest')};async ${fnSrc(html, 'confirmEventDraft')};async ${fnSrc(html, 'executeEventDraft')};return executeEventDraft;` // eslint-disable-line no-new-func
    )(P, api, render, [], jest.fn());
    const message = { action_draft: { draft_id: 'event-fail', kind: 'event.update.v1', status: 'draft',
      event: { event_id: 42, title: 'H', status: 'Scheduled', type: 'Hearing', kind: 'hearing', date: '2026-10-27', time: null, all_day: true },
      changes: { event_note: 'Updated' } } };
    await make(message);
    expect(message.action_draft).toMatchObject({ status: 'draft', executing: false, action_error: 'Event update failed' });
    await make(message);
    expect(api).toHaveBeenCalledTimes(2);
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
