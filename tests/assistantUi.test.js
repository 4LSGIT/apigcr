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
    expect(html).toContain(": draft.executing ? 'Applying…' : 'Proposal — not applied'");
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
    expect(html).toContain('window.confirm(taskDraftConfirmation(draft))');
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
      notify: true, link_type: 'contact', link_id: '1001',
    });
  });

  test('cancellation writes nothing; confirmation creates once and turns the control into Open task', async () => {
    const api = jest.fn().mockResolvedValue({ status: 'success', task_id: 77 });
    const render = jest.fn();
    const reloadTasks = jest.fn();
    const P = { showTask: jest.fn(), tasksBadgeRefresh: jest.fn(), document: { getElementById: jest.fn(() => ({ contentWindow: { reloadTasks } })) } };
    const window = { confirm: jest.fn().mockReturnValue(false) };
    const history = [];
    const saveAssistantMessage = jest.fn().mockResolvedValue();
    const make = new Function('window', 'P', 'api', 'render', 'history', 'saveAssistantMessage',
      `const TASK_ACTION_KINDS=new Set(['task.create.v1']);${fnSrc(html, 'isTaskActionDraft')};${fnSrc(html, 'taskCreateBody')};${fnSrc(html, 'taskUpdateBody')};${fnSrc(html, 'taskActionLabel')};${fnSrc(html, 'taskActionRequest')};${fnSrc(html, 'taskDraftText')};${fnSrc(html, 'taskDraftConfirmation')};async ${fnSrc(html, 'executeTaskDraft')};return executeTaskDraft;` // eslint-disable-line no-new-func
    )(window, P, api, render, history, saveAssistantMessage);
    const message = { action_draft: {
      draft_id: 'draft-123', kind: 'task.create.v1', status: 'draft', title: 'Review Ask Casey', description: 'Try it.',
      assignee: { user_id: 1, label: 'Stuart' }, link: { type: 'contact', id: '1001', label: 'Fred' },
      start_date: '2026-10-20', due_date: '2026-10-27', notify_assigner_on_completion: false,
    } };

    await make(message);
    expect(api).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();

    window.confirm.mockReturnValue(true);
    await make(message);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/api/tasks', {
      to: 1, title: 'Review Ask Casey', desc: 'Try it.', start: '2026-10-20', due: '2026-10-27',
      notify: false, link_type: 'contact', link_id: '1001',
    }, 'POST');
    expect(message.action_draft).toMatchObject({ status: 'applied', result_task_id: 77, executing: false });
    expect(render).toHaveBeenCalledTimes(2);
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
    const window = { confirm: jest.fn().mockReturnValue(true) };
    const make = new Function('window', 'P', 'api', 'render', 'history', 'saveAssistantMessage',
      `const TASK_ACTION_KINDS=new Set(['task.create.v1']);${fnSrc(html, 'isTaskActionDraft')};${fnSrc(html, 'taskCreateBody')};${fnSrc(html, 'taskUpdateBody')};${fnSrc(html, 'taskActionLabel')};${fnSrc(html, 'taskActionRequest')};${fnSrc(html, 'taskDraftText')};${fnSrc(html, 'taskDraftConfirmation')};async ${fnSrc(html, 'executeTaskDraft')};return executeTaskDraft;` // eslint-disable-line no-new-func
    )(window, { showTask: jest.fn() }, api, render, history, saveAssistantMessage);
    const message = { action_draft: {
      draft_id: 'draft-fail', kind: 'task.create.v1', status: 'draft', title: 'Try Casey', description: 'Review it.',
      assignee: { user_id: 1, label: 'Stuart' }, link: null, start_date: null, due_date: null,
      notify_assigner_on_completion: false,
    } };

    const first = make(message);
    expect(message.action_draft.executing).toBe(true);
    await make(message);
    expect(api).toHaveBeenCalledTimes(1);
    rejectWrite(new Error('Task insert failed'));
    await first;
    expect(message.action_draft).toMatchObject({ status: 'draft', executing: false, action_error: 'Task insert failed' });
    expect(history).toEqual([]);
    expect(saveAssistantMessage).not.toHaveBeenCalled();
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
