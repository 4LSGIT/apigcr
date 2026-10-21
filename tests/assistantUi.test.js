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
    expect(html).toContain('...(r.action_draft ? { action_draft: { ...r.action_draft, received_at: Date.now() } } : {})');
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
      `const TASK_ACTION_KINDS=new Set(['task.create.v1']);${fnSrc(html, 'isTaskActionDraft')};${fnSrc(html, 'taskCreateBody')};${fnSrc(html, 'taskUpdateBody')};${fnSrc(html, 'taskActionLabel')};${fnSrc(html, 'taskActionRequest')};${fnSrc(html, 'taskDraftText')};${fnSrc(html, 'taskDraftConfirmation')};async ${fnSrc(html, 'confirmTaskDraft')};const ACTION_DRAFT_TTL_MS=15*60*1000;${fnSrc(html, 'actionDraftStale')};async ${fnSrc(html, 'recordActionResult')};async ${fnSrc(html, 'executeTaskDraft')};return executeTaskDraft;` // eslint-disable-line no-new-func
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
    expect(saveAssistantMessage).toHaveBeenCalledWith(history[0], { required: true });
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
      `const TASK_ACTION_KINDS=new Set(['task.create.v1']);${fnSrc(html, 'isTaskActionDraft')};${fnSrc(html, 'taskCreateBody')};${fnSrc(html, 'taskUpdateBody')};${fnSrc(html, 'taskActionLabel')};${fnSrc(html, 'taskActionRequest')};${fnSrc(html, 'taskDraftText')};${fnSrc(html, 'taskDraftConfirmation')};async ${fnSrc(html, 'confirmTaskDraft')};const ACTION_DRAFT_TTL_MS=15*60*1000;${fnSrc(html, 'actionDraftStale')};async ${fnSrc(html, 'recordActionResult')};async ${fnSrc(html, 'executeTaskDraft')};return executeTaskDraft;` // eslint-disable-line no-new-func
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
      `const EVENT_ACTION_KINDS=new Set(['event.cancel.v1']);${fnSrc(html, 'isEventActionDraft')};${fnSrc(html, 'eventActionLabel')};${fnSrc(html, 'eventTypeText')};${fnSrc(html, 'eventProviderText')};${fnSrc(html, 'eventReminderText')};${fnSrc(html, 'eventDraftText')};${fnSrc(html, 'eventCreateBody')};${fnSrc(html, 'eventUpdateBody')};${fnSrc(html, 'eventActionRequest')};async ${fnSrc(html, 'confirmEventDraft')};const ACTION_DRAFT_TTL_MS=15*60*1000;${fnSrc(html, 'actionDraftStale')};async ${fnSrc(html, 'recordActionResult')};async ${fnSrc(html, 'executeEventDraft')};return executeEventDraft;` // eslint-disable-line no-new-func
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
    expect(saveAssistantMessage).toHaveBeenCalledWith(history[0], { required: true });
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
      `const EVENT_ACTION_KINDS=new Set(['event.update.v1']);${fnSrc(html, 'isEventActionDraft')};${fnSrc(html, 'eventActionLabel')};${fnSrc(html, 'eventTypeText')};${fnSrc(html, 'eventProviderText')};${fnSrc(html, 'eventReminderText')};${fnSrc(html, 'eventDraftText')};${fnSrc(html, 'eventCreateBody')};${fnSrc(html, 'eventUpdateBody')};${fnSrc(html, 'eventActionRequest')};async ${fnSrc(html, 'confirmEventDraft')};const ACTION_DRAFT_TTL_MS=15*60*1000;${fnSrc(html, 'actionDraftStale')};async ${fnSrc(html, 'recordActionResult')};async ${fnSrc(html, 'executeEventDraft')};return executeEventDraft;` // eslint-disable-line no-new-func
    )(P, api, render, [], jest.fn());
    const message = { action_draft: { draft_id: 'event-fail', kind: 'event.update.v1', status: 'draft',
      event: { event_id: 42, title: 'H', status: 'Scheduled', type: 'Hearing', kind: 'hearing', date: '2026-10-27', time: null, all_day: true },
      changes: { event_note: 'Updated' } } };
    await make(message);
    expect(message.action_draft).toMatchObject({ status: 'draft', executing: false, action_error: 'Event update failed' });
    await make(message);
    expect(api).toHaveBeenCalledTimes(2);
  });

  test('maps every appointment action to one canonical route and exact allowlisted body', () => {
    const request = new Function(`${fnSrc(html, 'apptCreateBody')};${fnSrc(html, 'apptActionRequest')};return apptActionRequest;`)(); // eslint-disable-line no-new-func
    const create = { kind: 'appt.create.v1', contact: { contact_id: 1309 }, case: { case_id: 'C1' },
      type: { appt_type: 'Consultation', type_key: 'consult' }, appt_length: 60, appt_platform: 'Telephone',
      appt_date: '2026-10-27 09:30:00', provider: { user_id: 7 }, note: 'Bring documents', confirm_sms: true,
      confirm_email: false, confirm_message: 'Confirmed', ignored: 'never send' };
    expect(request(create)).toEqual({ path: '/api/appts', method: 'POST', body: { contact_id: 1309, case_id: 'C1',
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
    const execute = new Function('P', 'api', 'render', 'history', 'saveAssistantMessage',
      `const APPT_ACTION_KINDS=new Set(['appt.reschedule.v1']);${fnSrc(html, 'isApptActionDraft')};${fnSrc(html, 'apptActionLabel')};${fnSrc(html, 'apptChannelsText')};${fnSrc(html, 'apptDraftText')};${fnSrc(html, 'apptCreateBody')};${fnSrc(html, 'apptActionRequest')};async ${fnSrc(html, 'confirmApptDraft')};const ACTION_DRAFT_TTL_MS=15*60*1000;${fnSrc(html, 'actionDraftStale')};async ${fnSrc(html, 'recordActionResult')};async ${fnSrc(html, 'executeApptDraft')};return executeApptDraft;` // eslint-disable-line no-new-func
    )(P, api, render, history, saveAssistantMessage);
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

  test('failed appointment writes stay retryable and saved results prevent replay', async () => {
    const apply = new Function('APPT_ACTION_KINDS', `${fnSrc(html, 'applyApptActionResults')};return applyApptActionResults;`)(new Set(['appt.cancel.v1'])); // eslint-disable-line no-new-func
    const messages = [{ action_draft: { draft_id: 'appt-2', kind: 'appt.cancel.v1', status: 'draft' } },
      { action_result: { draft_id: 'appt-2', kind: 'appt.cancel.v1', appt_id: 55 } }];
    expect(apply(messages)[0].action_draft).toMatchObject({ status: 'applied', result_appt_id: 55 });

    const api = jest.fn().mockRejectedValue(new Error('Appointment cancel failed')); const render = jest.fn();
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) }, showAppt: jest.fn() };
    const execute = new Function('P', 'api', 'render', 'history', 'saveAssistantMessage',
      `const APPT_ACTION_KINDS=new Set(['appt.cancel.v1']);${fnSrc(html, 'isApptActionDraft')};${fnSrc(html, 'apptActionLabel')};${fnSrc(html, 'apptChannelsText')};${fnSrc(html, 'apptDraftText')};${fnSrc(html, 'apptCreateBody')};${fnSrc(html, 'apptActionRequest')};async ${fnSrc(html, 'confirmApptDraft')};const ACTION_DRAFT_TTL_MS=15*60*1000;${fnSrc(html, 'actionDraftStale')};async ${fnSrc(html, 'recordActionResult')};async ${fnSrc(html, 'executeApptDraft')};return executeApptDraft;` // eslint-disable-line no-new-func
    )(P, api, render, [], jest.fn());
    const message = { action_draft: { draft_id: 'appt-fail', kind: 'appt.cancel.v1', status: 'draft',
      appt: { appt_id: 55, type: 'Consultation', status: 'Scheduled', date: '2026-10-27 09:30:00', contact: { label: 'Client' }, case: null,
        provider: { label: 'Fred' }, google_calendar: { firm: true, provider: false } }, note: '', sms: false, email: false,
      confirm_message: '', cancel_gcal: true, create_task: false } };
    await execute(message);
    expect(message.action_draft).toMatchObject({ status: 'draft', executing: false, action_error: 'Appointment cancel failed' });
    await execute(message);
    expect(api).toHaveBeenCalledTimes(2);
  });

  test('maps every contact subrecord action to one canonical route and exact allowlisted body', () => {
    const request = new Function(`${fnSrc(html, 'contactSubrecordCreateBody')};${fnSrc(html, 'contactSubrecordActionRequest')};return contactSubrecordActionRequest;`)(); // eslint-disable-line no-new-func
    const contact = { contact_id: 1309, label: 'Client' };
    expect(request({ kind: 'contact.phone.create.v1', family: 'phone', contact, fields: { phone: '2485550100', label: 'Mobile', is_primary: true,
      sms_optout: false, mms_capable: true, start_date: null, notes: '', verified: 1 } })).toEqual({ path: '/api/contact-phones', method: 'POST', body: {
      contact_id: 1309, phone: '2485550100', label: 'Mobile', is_primary: true, sms_optout: false, mms_capable: true, start_date: null, notes: '', expected_primary_id: null } });
    expect(request({ kind: 'contact.email.create.v1', family: 'email', contact, fields: { email: 'client@example.com', label: 'Personal', is_primary: false,
      email_optout: true, start_date: '2026-01-01', notes: 'n' } })).toEqual({ path: '/api/contact-emails', method: 'POST', body: {
      contact_id: 1309, email: 'client@example.com', label: 'Personal', is_primary: false, email_optout: true, start_date: '2026-01-01', notes: 'n' } });
    expect(request({ kind: 'contact.address.create.v1', family: 'address', contact, fields: { address1: '1 Main', address2: '', city: 'Detroit', state: 'MI', zip: '48201',
      country: 'US', label: 'Home', is_primary: true, start_date: null, notes: '' } })).toEqual({ path: '/api/contact-addresses', method: 'POST', body: {
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
    const execute = new Function('P', 'api', 'render', 'history', 'saveAssistantMessage', 'openEntity',
      `const CONTACT_SUBRECORD_ACTION_KINDS=new Set(['contact.phone.end.v1']);${fnSrc(html, 'isContactSubrecordActionDraft')};${fnSrc(html, 'contactSubrecordActionLabel')};${fnSrc(html, 'contactAddressText')};${fnSrc(html, 'contactSubrecordValue')};${fnSrc(html, 'contactSubrecordDraftText')};${fnSrc(html, 'contactSubrecordCreateBody')};${fnSrc(html, 'contactSubrecordActionRequest')};async ${fnSrc(html, 'confirmContactSubrecordDraft')};const ACTION_DRAFT_TTL_MS=15*60*1000;${fnSrc(html, 'actionDraftStale')};async ${fnSrc(html, 'recordActionResult')};async ${fnSrc(html, 'executeContactSubrecordDraft')};return executeContactSubrecordDraft;` // eslint-disable-line no-new-func
    )(P, api, render, history, saveAssistantMessage, openEntity);
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

  test('failed contact writes stay retryable and saved results prevent replay', async () => {
    const apply = new Function('CONTACT_SUBRECORD_ACTION_KINDS', `${fnSrc(html, 'applyContactSubrecordActionResults')};return applyContactSubrecordActionResults;`)(new Set(['contact.email.update.v1'])); // eslint-disable-line no-new-func
    const messages = [{ action_draft: { draft_id: 'contact-2', kind: 'contact.email.update.v1', status: 'draft' } },
      { action_result: { draft_id: 'contact-2', kind: 'contact.email.update.v1', contact_id: 1309, contact_label: 'Client' } }];
    expect(apply(messages)[0].action_draft).toMatchObject({ status: 'applied', result_contact_id: 1309, result_contact_label: 'Client' });

    const api = jest.fn().mockRejectedValue(new Error('Contact update failed')); const render = jest.fn();
    const P = { Swal: { fire: jest.fn().mockResolvedValue({ isConfirmed: true }) } };
    const execute = new Function('P', 'api', 'render', 'history', 'saveAssistantMessage', 'openEntity',
      `const CONTACT_SUBRECORD_ACTION_KINDS=new Set(['contact.email.update.v1']);${fnSrc(html, 'isContactSubrecordActionDraft')};${fnSrc(html, 'contactSubrecordActionLabel')};${fnSrc(html, 'contactAddressText')};${fnSrc(html, 'contactSubrecordValue')};${fnSrc(html, 'contactSubrecordDraftText')};${fnSrc(html, 'contactSubrecordCreateBody')};${fnSrc(html, 'contactSubrecordActionRequest')};async ${fnSrc(html, 'confirmContactSubrecordDraft')};const ACTION_DRAFT_TTL_MS=15*60*1000;${fnSrc(html, 'actionDraftStale')};async ${fnSrc(html, 'recordActionResult')};async ${fnSrc(html, 'executeContactSubrecordDraft')};return executeContactSubrecordDraft;` // eslint-disable-line no-new-func
    )(P, api, render, [], jest.fn(), jest.fn());
    const message = { action_draft: { draft_id: 'contact-fail', kind: 'contact.email.update.v1', family: 'email', status: 'draft',
      target: { id: 22, contact: { contact_id: 1309, label: 'Client' }, email: 'client@example.com', label: 'Personal', is_primary: false,
        start_date: '2026-01-01', notes: '', email_optout: false, expected_updated_at: '2026-10-20T10:00:00.000Z' }, changes: { label: 'Work' } } };
    await execute(message);
    expect(message.action_draft).toMatchObject({ status: 'draft', executing: false, action_error: 'Contact update failed' });
    await execute(message); expect(api).toHaveBeenCalledTimes(2);
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
  const H = (kinds) => `const TASK_ACTION_KINDS=new Set(${JSON.stringify(kinds)});const ACTION_DRAFT_TTL_MS=15*60*1000;${fnSrc(html, 'actionDraftStale')};async ${fnSrc(html, 'recordActionResult')};${fnSrc(html, 'isTaskActionDraft')};${fnSrc(html, 'taskCreateBody')};${fnSrc(html, 'taskUpdateBody')};${fnSrc(html, 'taskActionLabel')};${fnSrc(html, 'taskActionRequest')};${fnSrc(html, 'taskDraftText')};${fnSrc(html, 'taskDraftConfirmation')};async ${fnSrc(html, 'confirmTaskDraft')};async ${fnSrc(html, 'executeTaskDraft')};return executeTaskDraft;`;
  const draft = (extra = {}) => ({ action_draft: { draft_id: 'd-1', kind: 'task.create.v1', status: 'draft', title: 'Call', description: 'Call the client.',
    assignee: { user_id: 1, label: 'Stuart' }, link: null, start_date: null, due_date: null, notify_assigner_on_completion: false, ...extra } });
  const harness = (P, api, saveAssistantMessage) => new Function('P', 'api', 'render', 'history', 'saveAssistantMessage', H(['task.create.v1']))( // eslint-disable-line no-new-func
    P, api, jest.fn(), [], saveAssistantMessage);

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

  test('appointment review text never offers a client send', () => {
    const channels = new Function(`${fnSrc(html, 'apptChannelsText')};return apptChannelsText;`)(); // eslint-disable-line no-new-func
    expect(channels({ confirm_sms: true, confirm_message: 'Hi {{contacts.contact_ssn}}' })).toMatch(/^None — Ask Casey does not send/);
  });
});
