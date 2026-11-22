// Casey v2 S3a — public/casey.html, the pane, in JSDOM with a FAKE parent:
// the script runs as shipped (its `const P = window.parent` is pointed at the
// fake by one anchored substitution — the only edit), so this covers the boot,
// the chat list, the transcript rendering of stored block arrays (the context
// block hidden, tool_use + tool_result paired into trail rows, markdown
// answers), a live NDJSON turn (trail rows → results → deltas → final with the
// meta line; `limited` → Keep going; `error` lines; Stop shown while running
// and the stop call), the context chip from the shell's ycAssistantContext,
// delete, and the markdown renderer's escaping. No network, no server.
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'casey.html'), 'utf8');
const SCRIPT = /<script>([\s\S]*)<\/script>/.exec(HTML)[1];
const ANCHOR = 'const P = window.parent;';
if (SCRIPT.split(ANCHOR).length !== 2) throw new Error('casey.html: the parent anchor moved');
// Two anchored edits for the test window only: the parent, and the strict-mode
// directive (an indirect eval of strict code keeps its functions to itself; sloppy
// puts the declared functions on the window, where the tests reach them).
const STRICT = "'use strict';";
if (SCRIPT.split(STRICT).length !== 2) throw new Error('casey.html: the strict directive moved');
const PATCHED = SCRIPT.replace(ANCHOR, 'const P = window.__parent;').replace(STRICT, '');

/** An NDJSON Response-like whose body streams the given events one line at a time. */
function ndjson(events) {
  const enc = new TextEncoder();
  const lines = events.map((e) => JSON.stringify(e) + '\n');
  let i = 0;
  return { ok: true, status: 200, body: new ReadableStream({ pull(c) { if (i >= lines.length) { c.close(); return; } c.enqueue(enc.encode(lines[i++])); } }) };
}

/** A pane with a fake parent: apiSend dispatches on method + path; `calls` records them. */
async function pane({ boot = { status: 'success', enabled: true, model: 'claude-sonnet-5-5', effort: 'medium', limits: { text_max: 4000 }, continue_text: 'Keep going from where you stopped.' }, chats = [], transcripts = {}, turn = null, context = null } = {}) {
  const dom = new JSDOM(HTML.replace('<script src="/themeSync.js"></script>', ''), { runScripts: 'outside-only', url: 'https://app.test/casey.html', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder; w.ReadableStream = ReadableStream;
  w.__parent = {
    apiSend: async (p, method = 'GET', body, headers, opts) => {
      calls.push({ p, method, body, opts });
      if (p === '/api/casey/boot') return boot;
      if (p === '/api/casey/chats' && method === 'GET') return { status: 'success', chats };
      if (/^\/api\/casey\/chats\/\d+$/.test(p) && method === 'GET') { const id = Number(p.split('/').pop()); return transcripts[id] || { status: 'success', chat: { id, title: 't', model: 'm' }, messages: [] }; }
      if (/^\/api\/casey\/chats\/\d+$/.test(p) && method === 'DELETE') return { status: 'success', deleted: true };
      if (p === '/api/casey/turn/stop') return { status: 'success', stopping: true, running: true };
      if (p === '/api/casey/turn') { if (!turn) throw new Error('no turn scripted'); return typeof turn === 'function' ? turn(body) : ndjson(turn); }
      throw new Error('unexpected ' + method + ' ' + p);
    },
    ycAssistantContext: context ? () => context : undefined,
  };
  w.eval(PATCHED);
  await new Promise((r) => setTimeout(r, 150));   // waitForParent polls every 100 ms
  return { w, d: w.document, calls, E: (id) => w.document.getElementById(id), tick: () => new Promise((r) => setTimeout(r, 30)) };
}
const T = (text) => ({ type: 'text', text });

test('the inline script is what runs: two anchored substitutions, nothing else differs', () => {
  expect(PATCHED.length).toBe(SCRIPT.length + 'window.__parent'.length - 'window.parent'.length - STRICT.length);
  expect(HTML).toMatch(/<script>\s*'use strict';/);   // production keeps strict mode
});

test('boot: the chip shows the model, the chat list fills, the composer is live; a dark boot disables sending', async () => {
  const p = await pane({ chats: [{ id: 3, title: 'How many contacts?' }, { id: 2, title: 'x'.repeat(80) }] });
  expect(p.E('modelChip').textContent).toBe('claude-sonnet-5-5');
  expect([...p.E('chatPick').options].map((o) => o.value)).toEqual(['', '3', '2']);
  expect(p.E('chatPick').options[2].textContent.endsWith('…')).toBe(true);
  expect(p.E('send').disabled).toBe(false);
  expect(p.E('stop').hidden).toBe(true);
  expect(p.E('delChat').hidden).toBe(true);
  expect(p.calls.map((c) => c.p)).toEqual(['/api/casey/boot', '/api/casey/chats']);
  const dark = await pane({ boot: { status: 'success', enabled: false } });
  expect(dark.E('send').disabled).toBe(true);
  expect(dark.E('log').textContent).toMatch(/Casey v2 is off/);
});

test('a stored transcript renders: the context block hidden, tool_use + tool_result paired into trail rows, markdown answers with the cost', async () => {
  const transcripts = { 7: { status: 'success', chat: { id: 7, title: 'Overdue tasks', model: 'claude-opus-5-5' }, messages: [
    { seq: 1, role: 'user', content: [T('[context — refreshed each turn]\nNow: x\nActing as: IT\nPage: (none)'), T('Which tasks are overdue?')] },
    { seq: 2, role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'S' }, { type: 'tool_use', id: 'tu1', name: 'sql_read', input: { sql: 'SELECT 1 LIMIT 1', purpose: 'count' } }, { type: 'tool_use', id: 'tu2', name: 'api_get', input: { path: '/api/casey/catalog' } }], meta: { stop_reason: 'tool_use' } },
    { seq: 3, role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: JSON.stringify({ ok: true, tool: 'sql_read', bytes: 40, ms: 12 }) }, { type: 'tool_result', tool_use_id: 'tu2', content: JSON.stringify({ ok: false, tool: 'api_get', error: { code: 'NOT_AUTO_GET' }, ms: 1 }), is_error: true }] },
    { seq: 4, role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'S' }, T('**113** tasks are overdue.\n\n| # | Task |\n|---|---|\n| 1013 | Husband <b>x</b> |\n\n- one\n- two')], meta: { stop_reason: 'end_turn', cost_cents: 9.61 } },
  ] } };
  const p = await pane({ chats: [{ id: 7, title: 'Overdue tasks' }], transcripts });
  p.E('chatPick').value = '7'; p.E('chatPick').dispatchEvent(new p.w.Event('change'));
  await p.tick();
  const users = [...p.d.querySelectorAll('.msg.user')].map((n) => n.textContent);
  expect(users).toEqual(['Which tasks are overdue?']);          // the context block never shows
  const steps = [...p.d.querySelectorAll('.trail .step')];
  expect(steps.map((s) => s.className)).toEqual(['step ok', 'step err']);
  expect(steps[0].querySelector('button').textContent).toMatch(/^sql_read \{"sql":"SELECT 1 LIMIT 1"/);
  expect(steps[1].querySelector('.ms').textContent).toBe('NOT_AUTO_GET · 1 ms');
  const pre = steps[0].nextElementSibling; expect(pre.tagName).toBe('PRE'); expect(pre.hidden).toBe(true);
  steps[0].querySelector('button').click(); expect(pre.hidden).toBe(false);
  const ans = p.d.querySelector('.msg.assistant.md');
  expect(ans.querySelector('strong').textContent).toBe('113');
  expect(ans.querySelector('table td').innerHTML).toBe('1013');
  expect(ans.innerHTML).toContain('&lt;b&gt;x&lt;/b&gt;');                 // escaped, not markup
  expect([...ans.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['one', 'two']);
  expect(ans.querySelector('.meta').textContent).toBe('2 tool calls · 9.6¢');   // the TURN's calls and cost, as the live final shows
  expect(p.E('modelChip').textContent).toBe('claude-opus-5-5');
  expect(p.E('title').textContent).toBe('Overdue tasks');
  expect(p.E('delChat').hidden).toBe(false);
});

test('a live turn: user bubble, trail rows as calls run, deltas, the final meta, Keep going on limited; Stop shown while running and posted', async () => {
  let stopWhileRunning = null;
  const p = await pane({ turn: (body) => {
    stopWhileRunning = { stopHidden: p.E('stop').hidden, sendDisabled: p.E('send').disabled, body };
    return ndjson([
      { type: 'chat', id: 9, title: 'Count', model: 'claude-sonnet-5-5', effort: 'medium', created: true },
      { type: 'thinking', text: 'Looking up ' }, { type: 'thinking', text: 'the count.' },
      { type: 'tool_call', id: 'a', name: 'sql_read', input: { sql: 'SELECT COUNT(*) FROM contacts LIMIT 1' } },
      { type: 'tool_result', id: 'a', name: 'sql_read', ok: true, code: null, bytes: 30, ms: 25, truncated: false },
      { type: 'heartbeat' },
      { type: 'delta', text: 'We have ' }, { type: 'delta', text: '**3,337** contacts.' },
      { type: 'final', body: { chat_id: 9, text: 'We have **3,337** contacts.', calls: 1, cost_cents: 0.42, ms: 8300, limited: true, stopped: false } },
    ]);
  }, chats: [{ id: 9, title: 'Count' }], context: { snapshot: { active: { kind: 'file', entity: { kind: 'case', id: 'ABC12' } } }, display_label: 'Jones, Mary' } });
  expect(p.E('ctx').textContent).toContain('Jones, Mary');
  p.E('text').value = 'How many contacts?';
  p.E('send').click();
  await new Promise((r) => setTimeout(r, 200));
  expect(stopWhileRunning).toMatchObject({ stopHidden: false, sendDisabled: true });
  expect(stopWhileRunning.body).toEqual({ text: 'How many contacts?', context: { label: 'Jones, Mary', case_id: 'ABC12' } });
  expect(p.d.querySelector('.msg.user').textContent).toBe('How many contacts?');
  const step = p.d.querySelector('.trail .step');
  expect(step.className).toBe('step ok');
  expect(step.querySelector('.ms').textContent).toBe('25 ms');
  expect(p.d.querySelector('.trail .think').textContent).toBe('Looking up the count.');
  const ans = p.d.querySelector('.msg.assistant');
  expect(ans.classList.contains('streaming')).toBe(false);
  expect(ans.querySelector('strong').textContent).toBe('3,337');
  expect(ans.querySelector('.meta').textContent).toBe('1 tool call · 8.3 s · 0.42¢ · tool budget reached');
  expect(p.E('stop').hidden).toBe(true); expect(p.E('send').disabled).toBe(false);
  expect(p.E('delChat').hidden).toBe(false); expect(p.E('title').textContent).toBe('Count');
  // Keep going sends the boot's continuation text on the same chat.
  const keep = ans.querySelector('button.keep'); expect(keep.textContent).toBe('Keep going');
  p.w.__parent.apiSend = async (path, method, body) => { p.calls.push({ p: path, method, body }); if (path === '/api/casey/turn') return ndjson([{ type: 'chat', id: 9, created: false, model: 'claude-sonnet-5-5' }, { type: 'final', body: { chat_id: 9, text: 'Done.', calls: 0, cost_cents: 0.1, ms: 900, limited: false, stopped: false } }]); return { status: 'success', chats: [] }; };
  keep.click();
  await new Promise((r) => setTimeout(r, 150));
  const kg = p.calls.filter((c) => c.p === '/api/casey/turn').pop();
  expect(kg.body).toMatchObject({ chat_id: 9, text: 'Keep going from where you stopped.' });
  const last = [...p.d.querySelectorAll('.msg.assistant')].pop();
  expect(last.textContent).toContain('Done.');
  expect(last.querySelector('button.keep')).toBeNull();                // not limited → no Keep going
  expect(last.querySelector('.meta').textContent).toBe('0 tool calls · 900 ms · 0.10¢');
});

test('Stop posts the chat id; an error line renders as an error bubble; a thrown apiSend too', async () => {
  let release;
  const p = await pane({ turn: () => ({ ok: true, body: new ReadableStream({ start(c) { release = () => { c.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'chat', id: 4, model: 'm', created: true }) + '\n' + JSON.stringify({ type: 'error', status: 502, message: 'The model call failed (api_error)', detail: 'http_529' }) + '\n')); c.close(); }; } }) }) });
  p.E('text').value = 'q'; p.E('send').click();
  await p.tick();
  expect(p.E('stop').hidden).toBe(false);
  p.E('stop').click();
  await p.tick();
  release();
  await new Promise((r) => setTimeout(r, 150));
  expect(p.calls.find((c) => c.p === '/api/casey/turn/stop').body).toEqual({ chat_id: 4 });
  const err = p.d.querySelector('.msg.assistant.error');
  expect(err.textContent).toBe('The model call failed (api_error) — http_529');
  const q = await pane({ turn: () => { const e = new Error('A turn is already running in this chat'); e.status = 409; throw e; } });
  q.E('text').value = 'q'; q.E('send').click();
  await new Promise((r) => setTimeout(r, 150));
  expect(q.d.querySelector('.msg.assistant.error').textContent).toBe('A turn is already running in this chat');
  expect(q.E('send').disabled).toBe(false);
});

test('delete removes the chat and returns to a new one; the context chip can be removed and re-added', async () => {
  const p = await pane({ chats: [{ id: 2, title: 'two' }], transcripts: { 2: { status: 'success', chat: { id: 2, title: 'two', model: 'm' }, messages: [{ seq: 1, role: 'user', content: [T('hi')] }, { seq: 2, role: 'assistant', content: [T('hello')] }] } }, context: { snapshot: { active: { kind: 'workspace', tab: 'tabCases' } }, display_label: 'Cases' } });
  p.E('chatPick').value = '2'; p.E('chatPick').dispatchEvent(new p.w.Event('change'));
  await p.tick();
  expect(p.d.querySelectorAll('.msg').length).toBe(2);
  p.E('delChat').click();
  await new Promise((r) => setTimeout(r, 100));
  expect(p.calls.some((c) => c.p === '/api/casey/chats/2' && c.method === 'DELETE')).toBe(true);
  expect(p.E('empty')).not.toBeNull();
  expect(p.E('delChat').hidden).toBe(true);
  expect(p.E('ctx').textContent).toContain('Cases');
  p.E('rmCtx').click();
  expect(p.E('ctx').textContent).toContain('Add current view');
  p.E('addCtx').click();
  expect(p.E('ctx').textContent).toContain('Cases');
});

test('B1: a new chat whose opening turn fails is forgotten — the next Send carries no chat_id (the server rolled the chat back)', async () => {
  const bodies = [];
  // The list the server shows after the first turn: chat 4 was rolled back before its stream ended (the
  // loop's rollbackIfOpening), so the awaited reload in sendTurn's finally forgets it; chat 5 exists.
  // The list answers SLOWLY, and the second Send is clicked the moment the error bubble shows: Send must
  // still be off (the reload not yet back), so no request can carry the dead id.
  const p = await pane({ chats: [{ id: 5, title: 'q' }], turn: (body) => { bodies.push(body); return bodies.length === 1
    ? ndjson([{ type: 'chat', id: 4, title: 'q', model: 'm', created: true }, { type: 'error', status: 502, message: 'The model call failed (api_error)', detail: 'http_529' }])
    : ndjson([{ type: 'chat', id: 5, title: 'q', model: 'm', created: true }, { type: 'final', body: { chat_id: 5, text: 'ok', calls: 0, cost_cents: 0.1, ms: 10, limited: false, stopped: false } }]); } });
  const baseSend = p.w.__parent.apiSend;
  p.w.__parent.apiSend = async (path, method, body, h, o) => { if (path === '/api/casey/chats' && (method || 'GET') === 'GET') await new Promise((r) => setTimeout(r, 120)); return baseSend(path, method, body, h, o); };
  p.E('text').value = 'q'; p.E('send').click();
  await new Promise((r) => { const i = setInterval(() => { if (p.d.querySelector('.msg.assistant.error')) { clearInterval(i); r(); } }, 5); });
  expect(p.E('send').disabled).toBe(true);                        // the list is not back yet
  p.E('text').value = 'again'; p.E('send').click();              // ignored while off
  await new Promise((r) => setTimeout(r, 20));
  expect(bodies).toHaveLength(1);
  await new Promise((r) => setTimeout(r, 250));
  expect(p.E('send').disabled).toBe(false);
  expect(p.E('delChat').hidden).toBe(true);
  expect(p.E('title').textContent).toBe('Casey');
  p.E('text').value = 'again'; p.E('send').click();
  await new Promise((r) => setTimeout(r, 400));
  expect(bodies[1].chat_id).toBeUndefined();                      // not chat 4
  expect(p.E('delChat').hidden).toBe(false);
  // An EXISTING chat whose turn fails keeps its id (the server keeps the rows that were sent).
  const q = await pane({ chats: [{ id: 2, title: 'two' }], turn: (body) => { bodies.push(body); return ndjson([{ type: 'chat', id: 2, created: false, model: 'm' }, { type: 'error', status: 502, message: 'x' }]); } });
  q.E('chatPick').value = '2'; q.E('chatPick').dispatchEvent(new q.w.Event('change'));
  await q.tick();
  q.E('text').value = 'q'; q.E('send').click();
  await new Promise((r) => setTimeout(r, 200));
  q.E('text').value = 'q2'; q.E('send').click();
  await new Promise((r) => setTimeout(r, 200));
  expect(bodies.slice(-2).map((b) => b.chat_id)).toEqual([2, 2]);
  // The list reload is the general guard: a chat deleted elsewhere (gone from the list) is forgotten too.
  const lists = [[{ id: 3, title: 'three' }], []];
  const r = await pane({ chats: lists[0], turn: (body) => { bodies.push(body); return ndjson([{ type: 'chat', id: body.chat_id || 8, created: !body.chat_id, model: 'm' }, { type: 'final', body: { chat_id: body.chat_id || 8, text: 'ok', calls: 0, cost_cents: 0, ms: 1, limited: false, stopped: false } }]); } });
  r.E('chatPick').value = '3'; r.E('chatPick').dispatchEvent(new r.w.Event('change'));
  await r.tick();
  const base = r.w.__parent.apiSend; r.w.__parent.apiSend = async (path, method, body, h, o) => (path === '/api/casey/chats' && (method || 'GET') === 'GET') ? { status: 'success', chats: [] } : base(path, method, body, h, o);
  r.E('text').value = 'q'; r.E('send').click();                      // the turn runs on chat 3; the list afterwards no longer has it
  await new Promise((res) => setTimeout(res, 200));
  expect(bodies[bodies.length - 1].chat_id).toBe(3);
  expect(r.E('delChat').hidden).toBe(true);
  r.E('text').value = 'q2'; r.E('send').click();
  await new Promise((res) => setTimeout(res, 200));
  expect(bodies[bodies.length - 1].chat_id).toBeUndefined();
});

test('S1: a ?ask= draft the shell holds is taken into the composer at boot', async () => {
  const p = await pane();
  expect(p.E('text').value).toBe('');
  const dom = await (async () => { const taken = []; const q = await pane(); q.w.__parent.ycTakeAssistantDraft = () => { taken.push(1); return 'Which 341 meetings are next week?'; }; return { q, taken }; })();
  // boot already ran for `q` without the hook; a fresh pane with the hook present takes the draft
  const calls = [];
  const r = await (async () => {
    const jsdom = require('jsdom');
    const w = new jsdom.JSDOM(HTML.replace('<script src="/themeSync.js"></script>', ''), { runScripts: 'outside-only', url: 'https://app.test/casey.html' }).window;
    w.TextDecoder = TextDecoder; w.ReadableStream = ReadableStream;
    w.__parent = { apiSend: async (path) => { calls.push(path); if (path === '/api/casey/boot') return { status: 'success', enabled: true, model: 'm', effort: 'medium', limits: { text_max: 20 } }; return { status: 'success', chats: [] }; }, ycTakeAssistantDraft: () => 'Which 341 meetings are next week, and where?' };
    w.eval(PATCHED); await new Promise((res) => setTimeout(res, 150)); return w;
  })();
  expect(r.document.getElementById('text').value).toBe('Which 341 meetings a');   // cut to the boot's text_max (20)
  expect(dom.taken).toEqual([]);                                                // the hook is read at boot only
});

test('S4: results pair by id across rows (an assistant row with text AND tool_use); the loop\'s budget note is a trail note, not the user\'s words', async () => {
  const transcripts = { 3: { status: 'success', chat: { id: 3, title: 't', model: 'm' }, messages: [
    { seq: 1, role: 'user', content: [T('[context — refreshed each turn]\nx'), T('q')] },
    { seq: 2, role: 'assistant', content: [T('Let me check.'), { type: 'tool_use', id: 'a1', name: 'whoami', input: {} }], meta: { cost_cents: 1 } },
    { seq: 3, role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: JSON.stringify({ ok: true, ms: 5 }) }, T('[This turn\'s tool budget is spent: 1 tool calls, 3 s. Answer the user now.]')] },
    { seq: 4, role: 'assistant', content: [T('Done under the note.')], meta: { cost_cents: 2 } },
  ] } };
  const p = await pane({ chats: [{ id: 3, title: 't' }], transcripts });
  p.E('chatPick').value = '3'; p.E('chatPick').dispatchEvent(new p.w.Event('change'));
  await p.tick();
  const steps = [...p.d.querySelectorAll('.trail .step')];
  expect(steps.map((s) => s.className)).toEqual(['step ok']);                 // paired although the text came first
  expect([...p.d.querySelectorAll('.msg.user')].map((n) => n.textContent)).toEqual(['q']);   // the budget note is not a user bubble
  expect(p.d.querySelector('.trail .note').textContent).toMatch(/tool budget is spent/);
  const answers = [...p.d.querySelectorAll('.msg.assistant')];
  expect(answers[0].textContent).toContain('Let me check.');
  expect(answers[1].querySelector('.meta').textContent).toBe('1 tool call · 3.0¢');   // the turn's sum, not the row's
});

test('a reopened chat whose turn repaired an interrupted round: the repair results pair, the context block is hidden, the question is the user\'s bubble, counters reset', async () => {
  const transcripts = { 6: { status: 'success', chat: { id: 6, title: 't', model: 'm' }, messages: [
    { seq: 1, role: 'user', content: [T('[context — refreshed each turn]\nx'), T('first')] },
    { seq: 2, role: 'assistant', content: [{ type: 'tool_use', id: 'z1', name: 'whoami', input: {} }], meta: { cost_cents: 4 } },
    // the instance died here: no results row. The next turn opens with the repair.
    { seq: 3, role: 'user', content: [{ type: 'tool_result', tool_use_id: 'z1', content: JSON.stringify({ ok: false, error: { code: 'INTERRUPTED' } }), is_error: true }, T('[context — refreshed each turn]\ny'), T('second')] },
    { seq: 4, role: 'assistant', content: [T('Answer two.')], meta: { cost_cents: 1 } },
  ] } };
  const p = await pane({ chats: [{ id: 6, title: 't' }], transcripts });
  p.E('chatPick').value = '6'; p.E('chatPick').dispatchEvent(new p.w.Event('change'));
  await p.tick();
  expect([...p.d.querySelectorAll('.msg.user')].map((n) => n.textContent)).toEqual(['first', 'second']);
  expect(p.d.querySelectorAll('.trail .note').length).toBe(0);                     // no context block, no question as a note
  expect([...p.d.querySelectorAll('.trail .step')].map((s) => s.className)).toEqual(['step err']);
  expect(p.d.querySelector('.trail .step .ms').textContent).toBe('INTERRUPTED · ');
  const answers = [...p.d.querySelectorAll('.msg.assistant')];
  expect(answers).toHaveLength(1);
  expect(answers[0].querySelector('.meta').textContent).toBe('1.0¢');               // the second turn alone: no calls, 1¢
});

test('N2/N3: Stop on an existing chat waits for the turn\'s chat line; a 404 on open is an error bubble, not a stuck chat', async () => {
  let release;
  const p = await pane({ chats: [{ id: 2, title: 'two' }], turn: () => ({ ok: true, body: new ReadableStream({ start(c) { release = () => { c.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'chat', id: 2, created: false, model: 'm' }) + '\n' + JSON.stringify({ type: 'final', body: { chat_id: 2, text: 'ok', calls: 0, cost_cents: 0, ms: 1, limited: false, stopped: true } }) + '\n')); c.close(); }; } }) }) });
  p.E('chatPick').value = '2'; p.E('chatPick').dispatchEvent(new p.w.Event('change'));
  await p.tick();
  p.E('text').value = 'q'; p.E('send').click();
  await p.tick();
  p.E('stop').click();
  await p.tick();
  expect(p.calls.some((c) => c.p === '/api/casey/turn/stop')).toBe(false);     // not before the claim is known
  release();
  await new Promise((r) => setTimeout(r, 150));
  expect(p.calls.find((c) => c.p === '/api/casey/turn/stop').body).toEqual({ chat_id: 2 });
  expect([...p.d.querySelectorAll('.msg.assistant')].pop().querySelector('.meta').textContent).toBe('0 tool calls · 1 ms · 0.00¢ · stopped');
  const sent = [];
  const q = await pane({ chats: [{ id: 7, title: 'gone' }] });
  // The list STILL shows 7 (stale), so only openChat's own catch can forget it.
  q.w.__parent.apiSend = async (path, method, body) => { if (path === '/api/casey/chats/7') { const e = new Error('No such chat'); e.status = 404; throw e; } if (path === '/api/casey/turn') { sent.push(body); return ndjson([{ type: 'chat', id: 11, created: true, model: 'm' }, { type: 'final', body: { chat_id: 11, text: 'ok', calls: 0, cost_cents: 0, ms: 1, limited: false, stopped: false } }]); } return { status: 'success', chats: [{ id: 7, title: 'gone' }, { id: 11, title: 'q' }] }; };
  q.E('chatPick').value = '7'; q.E('chatPick').dispatchEvent(new q.w.Event('change'));
  await new Promise((r) => setTimeout(r, 100));
  expect(q.d.querySelector('.msg.assistant.error').textContent).toBe('That chat is gone.');
  expect(q.E('delChat').hidden).toBe(true);
  q.E('text').value = 'q'; q.E('send').click();
  await new Promise((r) => setTimeout(r, 200));
  expect(sent[0].chat_id).toBeUndefined();                           // a new chat, not 7
});

test('renderMd: escaping first, then headings, bold, code, fences, lists, tables; no HTML passes through', async () => {
  const p = await pane();
  const md = p.w.renderMd;
  expect(md('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  expect(md('# Title\ntext **b** `c<d>`')).toBe('<h1>Title</h1><p>text <strong>b</strong> <code>c&lt;d&gt;</code></p>');
  expect(md('```\nx < y\n```')).toBe('<pre><code>x &lt; y</code></pre>');
  expect(md('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  expect(md('| a | b |\n|---|---|\n| 1 | **2** |')).toBe('<div class="tbl"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td><strong>2</strong></td></tr></tbody></table></div>');
  expect(md('line one\nline two\n\npara')).toBe('<p>line one<br>line two</p><p>para</p>');
  expect(md('')).toBe('');
});
