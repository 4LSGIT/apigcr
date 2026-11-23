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

/** A pane with a fake parent: apiSend dispatches on method + path; `calls` records them (headers too — the Idempotency-Key, S3b).
 *  S3b: `cardsApi` is a map card id → card state the fake serves on GET /api/casey/cards/:id; claim / settle / decline mutate it like
 *  the store would (in order, a token per claim); `resume` scripts POST /api/casey/turn/resume; `routes` answers a card step's own
 *  request (path → value, or a function; a thrown {status, body} is the route's error). */
const MENU = [{ id: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'deeper', default: false }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'fast', default: true }, { id: 'claude-fable-5-1', label: 'Fable 5.1', hint: 'dearest', default: false }];
async function pane({ boot = { status: 'success', enabled: true, model: 'claude-sonnet-5-5', effort: 'medium', limits: { text_max: 4000 }, continue_text: 'Keep going from where you stopped.', models: MENU }, chats = [], transcripts = {}, turn = null, context = null, cardsApi = {}, resume = null, routes = {}, claimOverride = {} } = {}) {
  const dom = new JSDOM(HTML.replace('<script src="/themeSync.js"></script>', ''), { runScripts: 'outside-only', url: 'https://app.test/casey.html', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder; w.ReadableStream = ReadableStream;
  w.__parent = {
    apiSend: async (p, method = 'GET', body, headers, opts) => {
      calls.push({ p, method, body, headers, opts });
      if (p === '/api/casey/boot') return boot;
      let m;
      if ((m = /^\/api\/casey\/cards\/(\d+)$/.exec(p)) && method === 'GET') { const c = cardsApi[m[1]]; if (!c) { const e = new Error('No such card'); e.status = 404; throw e; } return { status: 'success', card: JSON.parse(JSON.stringify(c)) }; }
      if ((m = /^\/api\/casey\/cards\/(\d+)\/claim$/.exec(p))) {
        const c = cardsApi[m[1]]; const s = c.steps.find((x) => x.step_no === body.step);
        if (claimOverride[body.step]) return { status: 'success', outcome: claimOverride[body.step], step: s };   // another tab got there first
        if (!['proposed', 'approved'].includes(c.status)) return { status: 'success', outcome: 'closed', step: s };
        if (s.status === 'applied') return { status: 'success', outcome: 'applied', step: s };
        if (s.status === 'claimed') return { status: 'success', outcome: 'unknown', step: s };
        if (c.steps.some((x) => x.step_no < s.step_no && x.status !== 'applied')) return { status: 'success', outcome: 'out_of_order', step: s };
        s.status = 'claimed'; s.__token = 'tok-' + s.step_no; c.status = 'approved';
        return { status: 'success', outcome: 'claimed', claim_token: s.__token, step: { ...s, __token: undefined } };
      }
      if ((m = /^\/api\/casey\/cards\/(\d+)\/settle$/.exec(p))) {
        const c = cardsApi[m[1]]; const s = c.steps.find((x) => x.step_no === body.step);
        if (!s || s.status !== 'claimed' || s.__token !== body.claim_token) { const e = new Error('No claimed step matches that token'); e.status = 404; throw e; }
        s.status = body.status; s.http_status = body.http_status; s.result = body.result; return { status: 'success', settled: true };
      }
      if ((m = /^\/api\/casey\/cards\/(\d+)\/decline$/.exec(p))) {
        const c = cardsApi[m[1]]; if (c.status !== 'proposed') { const e = new Error('only a proposed card can be declined'); e.status = 409; throw e; }
        c.status = 'declined'; c.decline_note = body && body.note || null; for (const s of c.steps) if (s.status === 'pending') s.status = 'declined'; return { status: 'success', declined: true };
      }
      if (p === '/api/casey/turn/resume') { if (!resume) throw new Error('no resume scripted'); const c = cardsApi[body.card_id]; if (c) { c.status = 'resumed'; for (const s of c.steps) if (s.status === 'pending') s.status = 'skipped'; } return typeof resume === 'function' ? resume(body) : ndjson(resume); }
      if (Object.prototype.hasOwnProperty.call(routes, p)) {   // a card step's own route: the page asks for the raw Response ({status, text()}); a 204 is apiSend's null; {__throw} is the route's error (no status = a network failure)
        const r = routes[p]; const v = typeof r === 'function' ? await r(method, body, headers) : r;
        if (v && v.__throw) { const e = new Error(v.__throw.message || 'route error'); if (v.__throw.status !== undefined) e.status = v.__throw.status; if (v.__throw.body !== undefined) e.body = v.__throw.body; throw e; }
        if (v === null) return null;
        expect(opts).toEqual({ responseType: 'response' });
        const status = v && v.__status || 200; const payload = v && v.__status ? v.body : v;
        return { ok: true, status, text: async () => (payload === undefined ? '' : JSON.stringify(payload)) };
      }
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
  expect(p.E('modelChip').textContent).toBe('Sonnet 5.5'); expect(p.E('modelChip').title).toBe('Model this chat runs on: claude-sonnet-5-5');   // the menu's label, the id in the tooltip
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
  expect(p.E('modelChip').textContent).toBe('Opus 5.5');
  expect(p.E('title').textContent).toBe('Overdue tasks');
  expect(p.E('delChat').hidden).toBe(false);
});

test('S3a-2 the model picker: shown for a new chat with the menu and the default preselected; the pick rides the opening turn only; the chip takes over once the chat exists; an open chat shows its own model; a new chat starts at the default again; one model → the chip; no menu → nothing sent', async () => {
  const bodies = [];
  const scripted = (body) => { bodies.push(body); return ndjson([{ type: 'chat', id: body.chat_id || 8, title: 'q', model: body.model || 'claude-fable-5-1', created: !body.chat_id }, { type: 'final', body: { chat_id: body.chat_id || 8, text: 'ok', calls: 0, cost_cents: 0, ms: 1, limited: false, stopped: false } }]); };
  const list = [{ id: 2, title: 'two' }];   // the list the server would show — the pane forgets a chat it does not list (S3a), so a created chat joins it
  const p = await pane({ chats: list, transcripts: { 2: { status: 'success', chat: { id: 2, title: 'two', model: 'claude-fable-5-1' }, messages: [] } }, turn: (body) => { if (!body.chat_id && !list.some((c) => c.id === 8)) list.unshift({ id: 8, title: 'q' }); return scripted(body); } });
  const mp = p.E('modelPick'), chip = p.E('modelChip');
  expect(mp.hidden).toBe(false); expect(chip.hidden).toBe(true);
  expect([...mp.options].map((o) => [o.value, o.textContent, o.selected])).toEqual([['claude-opus-5-5', 'Opus 5.5 — deeper', false], ['claude-sonnet-5-5', 'Sonnet 5.5 — fast', true], ['claude-fable-5-1', 'Fable 5.1 — dearest', false]]);   // the note in the option text (S3a-3), the menu's order kept
  expect(mp.options[0].title).toBe('deeper');
  p.E('chatPick').value = '2'; p.E('chatPick').dispatchEvent(new p.w.Event('change'));   // from the picker-visible state, opening an existing chat hides it and the chip shows that chat's model
  await new Promise((r) => setTimeout(r, 100));
  expect(mp.hidden).toBe(true); expect(chip.hidden).toBe(false); expect(chip.textContent).toBe('Fable 5.1'); expect(chip.title).toBe('Model this chat runs on: claude-fable-5-1');
  p.E('newChat').click(); await p.tick();
  expect(mp.hidden).toBe(false); expect(chip.hidden).toBe(true);
  mp.value = 'claude-opus-5-5';
  p.E('text').value = 'q'; p.E('send').click();
  await new Promise((r) => setTimeout(r, 200));
  expect(bodies[0]).toEqual({ text: 'q', model: 'claude-opus-5-5' });
  expect(mp.hidden).toBe(true); expect(chip.hidden).toBe(false); expect(chip.textContent).toBe('Opus 5.5');
  p.E('text').value = 'more'; p.E('send').click();   // the next turn on the same chat: no model
  await new Promise((r) => setTimeout(r, 200));
  expect(bodies[1]).toEqual({ chat_id: 8, text: 'more' });
  p.E('chatPick').value = '2'; p.E('chatPick').dispatchEvent(new p.w.Event('change'));   // an existing chat: its own model, no picker
  await new Promise((r) => setTimeout(r, 100));
  expect(mp.hidden).toBe(true); expect(chip.hidden).toBe(false); expect(chip.textContent).toBe('Fable 5.1');
  p.E('newChat').click(); await p.tick();              // a new chat: the picker is back at the DEFAULT, not the last pick
  expect(mp.hidden).toBe(false); expect(chip.hidden).toBe(true); expect(mp.value).toBe('claude-sonnet-5-5');
  const one = await pane({ boot: { status: 'success', enabled: true, model: 'claude-sonnet-5-5', effort: 'medium', limits: { text_max: 4000 }, continue_text: 'k', models: [{ ...MENU[1], hint: '' }] }, turn: scripted });
  expect(one.E('modelPick').hidden).toBe(true); expect(one.E('modelChip').hidden).toBe(false); expect(one.E('modelChip').textContent).toBe('Sonnet 5.5');
  expect(one.E('modelPick').options[0].textContent).toBe('Sonnet 5.5'); expect(one.E('modelPick').options[0].title).toBe('');   // no note: the label alone
  one.E('text').value = 'q'; one.E('send').click(); await new Promise((r) => setTimeout(r, 200));
  expect(bodies[2]).toEqual({ text: 'q' });   // one model: no choice shown, nothing sent — the server's CURRENT default decides, so a menu change never strands this pane
  const none = await pane({ boot: { status: 'success', enabled: true, model: 'm', effort: 'medium', limits: { text_max: 4000 }, continue_text: 'k' }, turn: scripted });
  expect(none.E('modelPick').hidden).toBe(true); expect(none.E('modelChip').hidden).toBe(false);
  none.E('text').value = 'q'; none.E('send').click(); await new Promise((r) => setTimeout(r, 200));
  expect(bodies[3]).toEqual({ text: 'q' });
});

test('S3a-2 the picker after failures: a 404 on open → a new chat at the default; an opening turn the server rolled back → the picker is back with the pick kept; a pick refused as off the menu → boot re-read, the menu rebuilt and shown', async () => {
  const bodies = [];
  const p = await pane({ chats: [{ id: 7, title: 'gone' }, { id: 2, title: 'two' }], transcripts: { 2: { status: 'success', chat: { id: 2, title: 'two', model: 'claude-fable-5-1' }, messages: [] } } });
  const orig = p.w.__parent.apiSend;
  p.w.__parent.apiSend = async (path, method, body, h, o) => { if (path === '/api/casey/chats/7') { const e = new Error('No such chat'); e.status = 404; throw e; } return orig(path, method, body, h, o); };
  const mp = p.E('modelPick'), chip = p.E('modelChip');
  mp.value = 'claude-fable-5-1';
  p.E('chatPick').value = '2'; p.E('chatPick').dispatchEvent(new p.w.Event('change'));   // from an OPEN chat (picker hidden, chip Fable) …
  await new Promise((r) => setTimeout(r, 100));
  expect(mp.hidden).toBe(true); expect(chip.textContent).toBe('Fable 5.1');
  p.E('chatPick').value = '7'; p.E('chatPick').dispatchEvent(new p.w.Event('change'));
  await new Promise((r) => setTimeout(r, 100));
  expect(p.d.querySelector('.msg.assistant.error').textContent).toBe('That chat is gone.');
  expect(mp.hidden).toBe(false); expect(mp.value).toBe('claude-sonnet-5-5'); expect(chip.hidden).toBe(true); expect(chip.textContent).toBe('Sonnet 5.5');   // a new chat again, at the firm's default
  const q = await pane({ chats: [], turn: (body) => { bodies.push(body); return ndjson([{ type: 'chat', id: 4, title: 'q', model: body.model, created: true }, { type: 'error', status: 502, message: 'The model call failed (api_error)' }]); } });
  q.E('modelPick').value = 'claude-opus-5-5';
  q.E('text').value = 'q'; q.E('send').click(); await new Promise((r) => setTimeout(r, 200));
  expect(bodies[0]).toEqual({ text: 'q', model: 'claude-opus-5-5' });
  expect(q.E('modelPick').hidden).toBe(false); expect(q.E('modelPick').value).toBe('claude-opus-5-5');   // the list never showed chat 4: a new chat again, the pick kept for the retry
  expect(q.E('modelChip').hidden).toBe(true); expect(q.E('modelChip').textContent).toBe('Sonnet 5.5');
  q.E('text').value = 'again'; q.E('send').click(); await new Promise((r) => setTimeout(r, 200));
  expect(bodies[1]).toEqual({ text: 'again', model: 'claude-opus-5-5' });
  let boots = 0;
  // The pane booted with Opus preselected; the firm then narrowed the menu to Sonnet alone.
  const wide = { status: 'success', enabled: true, model: 'claude-opus-5-5', effort: 'medium', limits: { text_max: 4000 }, continue_text: 'k', models: [{ ...MENU[0], default: true }, { ...MENU[1], default: false }, MENU[2]] };
  const narrow = { status: 'success', enabled: true, model: 'claude-sonnet-5-5', effort: 'medium', limits: { text_max: 4000 }, continue_text: 'k', models: [MENU[1]] };
  const r = await pane({ boot: wide, chats: [], turn: () => { const e = new Error('That model is not on the menu'); e.status = 400; throw e; } });
  expect(r.E('modelChip').textContent).toBe('Opus 5.5');
  const orig2 = r.w.__parent.apiSend;
  r.w.__parent.apiSend = async (path, method, body, h, o) => { if (path === '/api/casey/boot') { boots++; return narrow; } return orig2(path, method, body, h, o); };
  r.E('modelPick').value = 'claude-fable-5-1';
  r.E('text').value = 'q'; r.E('send').click(); await new Promise((r2) => setTimeout(r2, 200));
  expect(r.d.querySelector('.msg.assistant.error').textContent).toMatch(/menu changed/);
  expect(boots).toBe(1);
  expect([...r.E('modelPick').options].map((o) => o.value)).toEqual(['claude-sonnet-5-5']);
  expect(r.E('modelPick').hidden).toBe(true); expect(r.E('modelChip').hidden).toBe(false); expect(r.E('modelChip').textContent).toBe('Sonnet 5.5');   // one entry now: the chip, reset to the NEW default
  expect(r.E('send').disabled).toBe(false);
  // Any OTHER 400 on a new chat is just an error bubble: no re-boot, the menu untouched.
  let boots2 = 0;
  const s = await pane({ chats: [], turn: () => { const e = new Error('text is longer than 4000 characters'); e.status = 400; throw e; } });
  const orig3 = s.w.__parent.apiSend;
  s.w.__parent.apiSend = async (path, method, body, h, o) => { if (path === '/api/casey/boot') boots2++; return orig3(path, method, body, h, o); };
  s.E('modelPick').value = 'claude-fable-5-1';
  s.E('text').value = 'q'; s.E('send').click(); await new Promise((r2) => setTimeout(r2, 200));
  expect(s.d.querySelector('.msg.assistant.error').textContent).toBe('text is longer than 4000 characters');
  expect(boots2).toBe(0); expect(s.E('modelPick').value).toBe('claude-fable-5-1');
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
  expect(stopWhileRunning.body).toEqual({ text: 'How many contacts?', context: { label: 'Jones, Mary', case_id: 'ABC12' }, model: 'claude-sonnet-5-5' });   // a new chat carries the menu's default pick (S3a-2)
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

// ── S3b: cards ─────────────────────────────────────────────────────────────
const STEP = (o) => ({ step_no: 1, method: 'POST', path: '/api/tasks', body: '{"title":"Call","n":1}', tier: 1, purpose: 'create the task', status: 'pending', http_status: null, result: null, idempotency_key: 'casey:5:1', content: { kind: 'fields', fields: [{ label: 'title', value: 'Call' }, { label: 'n', value: '1' }] }, ...o });
const CARD = (o) => ({ id: 5, chat_id: 8, user_id: 6, tool_use_id: 'tu', tier: 1, summary: 'Create a task for the trustee call', status: 'proposed', decline_note: null, steps: [STEP()], ...o });
const cardTurn = (card) => (body) => ndjson([{ type: 'chat', id: body.chat_id || 8, title: 'q', model: 'claude-sonnet-5-5', created: !body.chat_id }, { type: 'tool_call', id: 'tu', name: 'api_write', input: { summary: card.summary } }, { type: 'tool_result', id: 'tu', name: 'api_write', ok: true, code: null, ms: 3 }, { type: 'card', card }, { type: 'final', body: { chat_id: body.chat_id || 8, text: '', calls: 1, cost_cents: 0.2, ms: 900, limited: false, stopped: false, card_id: card.id } }]);
const answer = (text) => (body) => ndjson([{ type: 'chat', id: body.chat_id, title: 'q', model: 'claude-sonnet-5-5', created: false }, { type: 'delta', text }, { type: 'final', body: { chat_id: body.chat_id, text, calls: 0, cost_cents: 0.1, ms: 500, limited: false, stopped: false, card_id: null } }]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('S3b a card arrives: T1 renders collapsed (summary, badge, step line, purpose, Details with the content and the exact JSON), no empty answer bubble, Approve / Decline live once the stream closes; T2 shows the content open with a warning; T3 is labelled Superuser action', async () => {
  const card = CARD();
  const p = await pane({ chats: [{ id: 8, title: 'q' }], turn: cardTurn(card), cardsApi: { 5: card } });
  p.E('text').value = 'Create the task'; p.E('send').click(); await wait(250);
  const el = p.d.querySelector('.card');
  expect(el.className).toBe('card t1'); expect(el.dataset.cardId).toBe('5'); expect(el.dataset.status).toBe('proposed');
  expect(el.querySelector('.summary').textContent).toBe('Create a task for the trustee call');
  expect(el.querySelector('.badge').textContent).toBe('Write');
  expect(el.querySelector('.warn')).toBeNull();
  expect(el.querySelector('.cstep .m').textContent).toBe('POST /api/tasks');     // one step: no number
  expect(el.querySelector('.cstep .why').textContent).toBe('create the task');
  const det = el.querySelector('details'); expect(det.open).toBe(false); expect(det.querySelector('summary').textContent).toBe('Details');
  expect([...det.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['title', 'n']);
  expect(det.querySelector('pre').textContent).toBe('{"title":"Call","n":1}');  // the stored text, as it will be sent
  expect(p.d.querySelectorAll('.msg.assistant').length).toBe(0);                 // the card is the answer
  expect([...el.querySelectorAll('.actions button')].map((b) => b.textContent)).toEqual(['Approve', 'Decline']);
  expect(p.E('send').disabled).toBe(false);
  // T2: content open, the warning; T3: the superuser label and the password note.
  const t2 = await pane({ chats: [{ id: 8, title: 'q' }], turn: cardTurn(CARD({ id: 6, tier: 2, steps: [STEP({ path: '/api/mail/send', body: '{"to":["a@x.test"],"subject":"Hi"}', tier: 2, content: { kind: 'mail', fields: [{ label: 'To', value: 'a@x.test' }, { label: 'Subject', value: 'Hi' }] } })] })) });
  t2.E('text').value = 'send'; t2.E('send').click(); await wait(250);
  const e2 = t2.d.querySelector('.card');
  expect(e2.className).toBe('card t2'); expect(e2.querySelector('.badge').textContent).toBe('Sensitive');
  expect(e2.querySelector('.warn').textContent).toMatch(/Check the exact content below before approving/);
  expect(e2.querySelector('.warn').textContent).not.toMatch(/password/);
  expect(e2.querySelector('.cstep > dl.fields')).not.toBeNull();                 // open, not inside details
  expect([...e2.querySelectorAll('.cstep > dl.fields dd')].map((d) => d.textContent)).toEqual(['a@x.test', 'Hi']);
  expect(e2.querySelector('details summary').textContent).toMatch(/Request JSON/);
  const t3 = await pane({ chats: [{ id: 8, title: 'q' }], turn: cardTurn(CARD({ id: 7, tier: 3, steps: [STEP({ path: '/admin/system-alerts/ack', tier: 3 }), STEP({ step_no: 2, path: '/admin/system-alerts/resolve', tier: 3, idempotency_key: 'casey:7:2' })] })) });
  t3.E('text').value = 'ack'; t3.E('send').click(); await wait(250);
  const e3 = t3.d.querySelector('.card');
  expect(e3.className).toBe('card t3'); expect(e3.querySelector('.badge.su').textContent).toMatch(/Superuser action/);
  expect(e3.querySelector('.warn').textContent).toMatch(/A superuser route: your password may be asked for/);
  expect([...e3.querySelectorAll('.cstep .m')].map((m) => m.textContent)).toEqual(['1. POST /admin/system-alerts/ack', '2. POST /admin/system-alerts/resolve']);
  expect(e3.querySelector('.actions button').title).toBe('Run the steps, in order, as you');
});

test('S3b Approve: claim → the route called through apiSend with the stored body STRING and the Idempotency-Key → settle applied → resume streams the answer; the card then shows done; a second card step after a failure is not run', async () => {
  const card = CARD({ steps: [STEP(), STEP({ step_no: 2, path: '/api/events', body: '{"when":"x"}', idempotency_key: 'casey:5:2' })] });
  const routeCalls = [];
  const p = await pane({ chats: [{ id: 8, title: 'q' }], turn: cardTurn(card), cardsApi: { 5: card }, resume: answer('Task 77 is created.'),
    routes: { '/api/tasks': (method, body, headers) => { routeCalls.push({ method, body, headers }); return { __status: 201, body: { status: 'success', task: { id: 77 } } }; }, '/api/events': (method, body, headers) => { routeCalls.push({ method, body, headers }); return { __throw: { status: 409, message: 'Overlaps', body: { status: 'error', message: 'Overlaps' } } }; } } });
  p.E('text').value = 'go'; p.E('send').click(); await wait(250);
  const el = p.d.querySelector('.card');
  [...el.querySelectorAll('.actions button')].find((b) => b.textContent === 'Approve').click();
  await wait(400);
  // The route saw the exact string body and the key, as the user (apiSend is the parent's).
  expect(routeCalls).toEqual([
    { method: 'POST', body: '{"title":"Call","n":1}', headers: { 'Idempotency-Key': 'casey:5:1' } },
    { method: 'POST', body: '{"when":"x"}', headers: { 'Idempotency-Key': 'casey:5:2' } },
  ]);
  const seq = p.calls.filter((c) => /cards\/5|turn\/resume|\/api\/tasks|\/api\/events/.test(c.p)).map((c) => `${c.method} ${c.p}${c.body && c.body.step ? ' s' + c.body.step : ''}${c.body && c.body.status ? ' ' + c.body.status : ''}`);
  expect(seq).toEqual(['POST /api/casey/cards/5/claim s1', 'POST /api/tasks', 'POST /api/casey/cards/5/settle s1 applied', 'POST /api/casey/cards/5/claim s2', 'POST /api/events', 'POST /api/casey/cards/5/settle s2 failed', 'GET /api/casey/cards/5', 'POST /api/casey/turn/resume', 'GET /api/casey/cards/5']);   // re-read after the run (buttons by state) and after the resume (resumed: no buttons)
  const settle1 = p.calls.find((c) => /settle/.test(c.p) && c.body.step === 1).body;
  expect(settle1).toEqual({ step: 1, claim_token: 'tok-1', status: 'applied', http_status: 201, result: { status: 'success', task: { id: 77 } } });   // the route's REAL status (N1)
  const settle2 = p.calls.find((c) => /settle/.test(c.p) && c.body.step === 2).body;
  expect(settle2).toEqual({ step: 2, claim_token: 'tok-2', status: 'failed', http_status: 409, result: { status: 'error', message: 'Overlaps' } });
  const resume = p.calls.find((c) => c.p === '/api/casey/turn/resume').body;
  expect(resume).toEqual({ chat_id: 8, card_id: 5 });
  // Rendered: step 1 applied, step 2 failed with the route's message, the card resumed, the answer streamed, no buttons.
  const steps = [...el.querySelectorAll('.cstep')];
  expect(steps.map((s) => s.className)).toEqual(['cstep applied', 'cstep failed']);
  expect(steps[0].querySelector('.outcome').textContent).toBe('applied (HTTP 201)');
  expect(steps[1].querySelector('.outcome').textContent).toBe('failed (HTTP 409) — Overlaps');
  expect(el.dataset.status).toBe('resumed'); expect(el.querySelector('.actions')).toBeNull();
  expect(el.querySelector('.state').textContent).toBe('Done — Casey was told the result.');
  expect(p.d.querySelector('.msg.assistant.md').textContent).toMatch(/^Task 77 is created\./);
});

test('S3b Decline: the note field appears, the decline posts the trimmed note, then the resume; Cancel restores the buttons; an unknown claim (a step already claimed elsewhere) stops the run and shows as unknown', async () => {
  const card = CARD();
  const p = await pane({ chats: [{ id: 8, title: 'q' }], turn: cardTurn(card), cardsApi: { 5: card }, resume: answer('Ok, I will not.') });
  p.E('text').value = 'go'; p.E('send').click(); await wait(250);
  const el = p.d.querySelector('.card');
  [...el.querySelectorAll('.actions button')].find((b) => b.textContent === 'Decline').click(); await wait(80);
  expect([...el.querySelectorAll('.actions button')].map((b) => b.textContent)).toEqual(['Decline', 'Cancel']);
  const input = el.querySelector('.actions input'); expect(input.placeholder).toBe('Tell Casey why (optional)');
  [...el.querySelectorAll('.actions button')].find((b) => b.textContent === 'Cancel').click(); await wait(80);
  expect([...el.querySelectorAll('.actions button')].map((b) => b.textContent)).toEqual(['Approve', 'Decline']);
  [...el.querySelectorAll('.actions button')].find((b) => b.textContent === 'Decline').click(); await wait(80);
  el.querySelector('.actions input').value = '  wrong client ';
  [...el.querySelectorAll('.actions button')].find((b) => b.textContent === 'Decline').click(); await wait(300);
  expect(p.calls.find((c) => /decline/.test(c.p)).body).toEqual({ note: 'wrong client' });
  expect(p.calls.find((c) => c.p === '/api/casey/turn/resume').body).toEqual({ chat_id: 8, card_id: 5 });
  expect(el.dataset.status).toBe('resumed');
  expect(el.querySelector('.state').textContent).toBe('Declined — wrong client. Casey was told.');
  expect(p.d.querySelector('.msg.assistant.md').textContent).toMatch(/^Ok, I will not\./);
  // Unknown: the step was claimed by another tab (the fake answers 'unknown'); nothing is sent; the card says so.
  const stale = CARD({ id: 9, steps: [STEP({ status: 'claimed', idempotency_key: 'casey:9:1' })], status: 'approved' });
  const p2 = await pane({ chats: [{ id: 8, title: 'q' }], transcripts: { 8: { status: 'success', chat: { id: 8, title: 'q', model: 'm' }, messages: [
    { seq: 1, role: 'user', content: [T('[context — refreshed each turn]\nx'), T('go')] },
    { seq: 2, role: 'assistant', content: [{ type: 'tool_use', id: 'tu', name: 'api_write', input: {} }] },
    { seq: 3, role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu', content: JSON.stringify({ ok: true, tool: 'api_write', ms: 2 }) }], meta: { card_id: 9 } },
  ] } }, cardsApi: { 9: stale }, routes: { '/api/tasks': () => { throw new Error('must not be sent'); } } });
  p2.E('chatPick').value = '8'; p2.E('chatPick').dispatchEvent(new p2.w.Event('change')); await wait(200);
  const e9 = p2.d.querySelector('.card');
  expect(e9.dataset.status).toBe('approved');
  expect(e9.querySelector('.cstep').className).toBe('cstep unknown');
  expect(e9.querySelector('.outcome').textContent).toMatch(/^unknown — the request was sent but no answer was recorded/);
  expect([...e9.querySelectorAll('.actions button')].map((b) => b.textContent)).toEqual(['Tell Casey']);   // nothing to continue: only the report
  expect(e9.querySelector('.state').textContent).toBe('A step is in an unknown state.');
});

test('S3b a stored transcript: the results row\'s card_id fetches the card live (proposed → buttons; approved with pending steps → Continue / Stop here); the outcome block of a resume turn is a trail note, not the user\'s bubble; a plain Send while a card is proposed marks it declined', async () => {
  const proposed = CARD({ id: 11, steps: [STEP({ idempotency_key: 'casey:11:1' })] });
  const partial = CARD({ id: 12, status: 'approved', steps: [STEP({ status: 'applied', http_status: 200, result: { ok: true }, idempotency_key: 'casey:12:1' }), STEP({ step_no: 2, path: '/api/events', idempotency_key: 'casey:12:2' })] });
  const messages = [
    { seq: 1, role: 'user', content: [T('[context — refreshed each turn]\nx'), T('Create it')] },
    { seq: 2, role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'api_write', input: { summary: 's' } }] },
    { seq: 3, role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: JSON.stringify({ ok: true, tool: 'api_write', ms: 2 }) }], meta: { card_id: 12 } },
    { seq: 4, role: 'user', content: [T('[context — refreshed each turn]\nx'), T('[Card 12 — approved by the user; 1 of 2 steps applied.]\nStep 1: POST /api/tasks — applied (HTTP 200)'), T('and then?')], meta: { card_outcome: { card_id: 12, status: 'resumed', steps: ['applied', 'skipped'] } } },
    { seq: 5, role: 'assistant', content: [T('Step one is done.')], meta: { cost_cents: 0.3 } },
    { seq: 6, role: 'user', content: [T('[context — refreshed each turn]\nx'), T('try the other one')] },
    { seq: 7, role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'api_write', input: { summary: 's2' } }] },
    { seq: 8, role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: JSON.stringify({ ok: true, tool: 'api_write', ms: 2 }) }], meta: { card_id: 11 } },
  ];
  const p = await pane({ chats: [{ id: 8, title: 'q' }], transcripts: { 8: { status: 'success', chat: { id: 8, title: 'q', model: 'm' }, messages } }, cardsApi: { 11: proposed, 12: partial }, turn: answer('Noted.'), resume: answer('r') });
  p.E('chatPick').value = '8'; p.E('chatPick').dispatchEvent(new p.w.Event('change')); await wait(250);
  expect(p.calls.filter((c) => /^\/api\/casey\/cards\/\d+$/.test(c.p)).map((c) => c.p).sort()).toEqual(['/api/casey/cards/11', '/api/casey/cards/12']);
  const els = [...p.d.querySelectorAll('.card')];
  expect(els.map((e) => e.dataset.cardId)).toEqual(['12', '11']);               // in transcript order, each after its round's trail
  expect([...els[0].querySelectorAll('.actions button')].map((b) => b.textContent)).toEqual(['Continue', 'Stop here']);
  expect(els[0].querySelector('.state').textContent).toBe('Partly run.');
  expect([...els[1].querySelectorAll('.actions button')].map((b) => b.textContent)).toEqual(['Approve', 'Decline']);
  expect([...p.d.querySelectorAll('.msg.user')].map((n) => n.textContent)).toEqual(['Create it', 'and then?', 'try the other one']);   // the outcome block is not a user bubble
  expect([...p.d.querySelectorAll('.trail .note')].map((n) => n.textContent)).toEqual(['[Card 12 — approved by the user; 1 of 2 steps applied.]']);   // its first line, as a note
  // The order in the log: user, trail(+card 12), note-trail, answer, user, trail(+card 11).
  expect([...p.E('log').children].map((n) => n.className.split(' ')[0])).toEqual(['msg', 'trail', 'card', 'trail', 'msg', 'msg', 'msg', 'trail', 'card']);   // question, round + card 12, the outcome note, "and then?", the answer, the next question, round + card 11
  // A plain Send while card 11 is proposed: the page marks it declined (the server resolves it the same way).
  p.E('text').value = 'never mind'; p.E('send').click(); await wait(250);
  expect(els[1].dataset.status).toBe('resumed'); expect(els[1].querySelector('.actions')).toBeNull();
  expect(els[1].querySelector('.state').textContent).toBe('Not acted on — you continued the conversation instead. Casey was told.');
  expect(els[0].dataset.status).toBe('resumed');   // the approved one too: reported as it stands
  expect(p.calls.find((c) => c.p === '/api/casey/turn').body).toEqual({ chat_id: 8, text: 'never mind' });
});

test('S3b Continue runs only the pending steps of an approved card, then resumes; Stop here resumes at once (pending → skipped server-side); a failing resume leaves the buttons for a retry', async () => {
  const partial = CARD({ id: 12, status: 'approved', steps: [STEP({ status: 'applied', http_status: 200, result: 1, idempotency_key: 'casey:12:1' }), STEP({ step_no: 2, path: '/api/events', body: '{"e":1}', idempotency_key: 'casey:12:2' })] });
  const routeCalls = [];
  const transcript = { status: 'success', chat: { id: 8, title: 'q', model: 'm' }, messages: [
    { seq: 1, role: 'user', content: [T('[context — refreshed each turn]\nx'), T('go')] },
    { seq: 2, role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'api_write', input: {} }] },
    { seq: 3, role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '{"ok":true}' }], meta: { card_id: 12 } },
  ] };
  const p = await pane({ chats: [{ id: 8, title: 'q' }], transcripts: { 8: transcript }, cardsApi: { 12: partial }, resume: answer('Both done.'), routes: { '/api/events': (m, body, h) => { routeCalls.push({ body, h }); return { id: 2 }; } } });
  p.E('chatPick').value = '8'; p.E('chatPick').dispatchEvent(new p.w.Event('change')); await wait(200);
  let el = p.d.querySelector('.card');
  [...el.querySelectorAll('.actions button')].find((b) => b.textContent === 'Continue').click(); await wait(400);
  expect(routeCalls).toEqual([{ body: '{"e":1}', h: { 'Idempotency-Key': 'casey:12:2' } }]);   // step 1 was not re-sent
  expect(p.calls.filter((c) => /claim/.test(c.p)).map((c) => c.body.step)).toEqual([2]);
  expect(el.dataset.status).toBe('resumed');
  expect(p.d.querySelector('.msg.assistant.md').textContent).toMatch(/^Both done\./);
  // Stop here: resume at once; the fake marks pending → skipped; a failing resume keeps the card actionable.
  const again = CARD({ id: 13, status: 'approved', steps: [STEP({ status: 'applied', http_status: 200, result: 1, idempotency_key: 'casey:13:1' }), STEP({ step_no: 2, idempotency_key: 'casey:13:2' })] });
  let fail = true;
  const p2 = await pane({ chats: [{ id: 8, title: 'q' }], transcripts: { 8: { ...transcript, messages: transcript.messages.map((m) => (m.meta ? { ...m, meta: { card_id: 13 } } : m)) } }, cardsApi: { 13: again }, resume: (body) => { if (fail) { again.status = 'approved'; for (const s of again.steps) if (s.status === 'skipped') s.status = 'pending'; const e = new Error('Turn failed'); e.status = 500; throw e; } return answer('Stopped there.')(body); } });
  p2.E('chatPick').value = '8'; p2.E('chatPick').dispatchEvent(new p2.w.Event('change')); await wait(200);
  el = p2.d.querySelector('.card');
  [...el.querySelectorAll('.actions button')].find((b) => b.textContent === 'Stop here').click(); await wait(300);
  expect(p2.d.querySelector('.msg.assistant.error').textContent).toBe('Turn failed');
  expect([...el.querySelectorAll('.actions button')].map((b) => b.textContent)).toEqual(['Continue', 'Stop here']);   // retryable
  fail = false;
  [...el.querySelectorAll('.actions button')].find((b) => b.textContent === 'Stop here').click(); await wait(300);
  expect(p2.calls.filter((c) => c.p === '/api/casey/turn/resume').length).toBe(2);
  expect(el.dataset.status).toBe('resumed');
  expect([...el.querySelectorAll('.cstep')].map((s) => s.className)).toEqual(['cstep applied', 'cstep skipped']);
  expect(el.querySelector('.cstep.skipped .outcome').textContent).toBe('not run');
  expect([...p2.d.querySelectorAll('.msg.assistant.md:not(.error)')].pop().textContent).toMatch(/^Stopped there\./);
});

test('S3b the run stops: a FAILED middle step leaves the later steps untouched (no claim, no request); a claim answered unknown (another tab) stops before anything is sent', async () => {
  const three = CARD({ id: 20, steps: [STEP({ idempotency_key: 'casey:20:1' }), STEP({ step_no: 2, path: '/api/events', body: '{"e":1}', idempotency_key: 'casey:20:2' }), STEP({ step_no: 3, path: '/api/notes', body: '{"n":1}', idempotency_key: 'casey:20:3' })] });
  const routeCalls = [];
  const p = await pane({ chats: [{ id: 8, title: 'q' }], turn: cardTurn(three), cardsApi: { 20: three }, resume: answer('Stopped after step 2.'),
    routes: { '/api/tasks': () => { routeCalls.push('tasks'); return { ok: 1 }; }, '/api/events': () => { routeCalls.push('events'); return { __throw: { status: 500, message: 'boom', body: { message: 'boom' } } }; }, '/api/notes': () => { routeCalls.push('notes'); return { ok: 3 }; } } });
  p.E('text').value = 'go'; p.E('send').click(); await wait(250);
  [...p.d.querySelector('.card').querySelectorAll('.actions button')].find((b) => b.textContent === 'Approve').click(); await wait(400);
  expect(routeCalls).toEqual(['tasks', 'events']);                                                     // step 3 never sent
  expect(p.calls.filter((c) => /cards\/20\/claim/.test(c.p)).map((c) => c.body.step)).toEqual([1, 2]);   // never claimed either
  expect([...p.d.querySelectorAll('.cstep')].map((s) => s.className)).toEqual(['cstep applied', 'cstep failed', 'cstep skipped']);
  expect(p.calls.filter((c) => c.p === '/api/casey/turn/resume').length).toBe(1);
  // A claim another tab took first: 'unknown' at claim time → nothing sent for it, nothing after it; the card is re-read and NOT resumed
  // (the other tab is mid-flight) — on an APPROVED card, where a resume would otherwise follow: Continue / Stop here come back.
  const two = CARD({ id: 21, status: 'approved', steps: [STEP({ idempotency_key: 'casey:21:1' }), STEP({ step_no: 2, path: '/api/events', idempotency_key: 'casey:21:2' })] });
  const sent = [];
  const p2 = await pane({ chats: [{ id: 8, title: 'q' }], turn: cardTurn(two), cardsApi: { 21: two }, resume: answer('Unknown.'), claimOverride: { 1: 'unknown' },
    routes: { '/api/tasks': () => { sent.push('tasks'); return {}; }, '/api/events': () => { sent.push('events'); return {}; } } });
  p2.E('text').value = 'go'; p2.E('send').click(); await wait(250);
  [...p2.d.querySelector('.card').querySelectorAll('.actions button')].find((b) => b.textContent === 'Continue').click(); await wait(400);
  expect(sent).toEqual([]);
  expect(p2.calls.filter((c) => /cards\/21\/claim/.test(c.p)).map((c) => c.body.step)).toEqual([1]);
  expect(p2.calls.filter((c) => /cards\/21\/settle/.test(c.p)).length).toBe(0);
  expect(p2.calls.filter((c) => c.p === '/api/casey/turn/resume').length).toBe(0);
  expect([...p2.d.querySelector('.card').querySelectorAll('.actions button')].map((b) => b.textContent)).toEqual(['Continue', 'Stop here']);
});

test('S3b B1: a request with NO answer (a network failure, no status) is NOT settled as failed — the step stays claimed (unknown), nothing after it runs, the resume tells Casey; a 502 the same; a 204 settles applied; the composer is locked while a card runs; a settle that fails once is retried', async () => {
  // No status at all.
  const c1 = CARD({ id: 30, steps: [STEP({ idempotency_key: 'casey:30:1' }), STEP({ step_no: 2, path: '/api/events', idempotency_key: 'casey:30:2' })] });
  const p = await pane({ chats: [{ id: 8, title: 'q' }], turn: cardTurn(c1), cardsApi: { 30: c1 }, resume: answer('I cannot tell whether it landed.'),
    routes: { '/api/tasks': () => ({ __throw: { message: 'Failed to fetch' } }), '/api/events': () => { throw new Error('must not run'); } } });
  p.E('text').value = 'go'; p.E('send').click(); await wait(250);
  const el = p.d.querySelector('.card');
  [...el.querySelectorAll('.actions button')].find((b) => b.textContent === 'Approve').click(); await wait(400);
  expect(p.calls.filter((c) => /cards\/30\/settle/.test(c.p)).length).toBe(0);                 // never settled: unknown, not failed
  expect(p.calls.filter((c) => /cards\/30\/claim/.test(c.p)).map((c) => c.body.step)).toEqual([1]);
  expect(c1.steps[0].status).toBe('claimed');
  expect(el.querySelector('.state.err').textContent).toMatch(/^Step 1: no answer came back \(Failed to fetch\)\. It may or may not have been applied/);
  expect(p.calls.filter((c) => c.p === '/api/casey/turn/resume').length).toBe(1);               // Casey is told (UNKNOWN in the outcome)
  expect([...el.querySelectorAll('.cstep')].map((s) => s.className)).toEqual(['cstep unknown', 'cstep skipped']);
  // A 502 from the edge: the same; a 500 FROM the route is a failure.
  for (const [status, settled] of [[502, 0], [504, 0], [500, 1], [422, 1]]) {
    const c = CARD({ id: 40 + status, steps: [STEP({ idempotency_key: `casey:${40 + status}:1` })] });
    const q = await pane({ chats: [{ id: 8, title: 'q' }], turn: cardTurn(c), cardsApi: { [40 + status]: c }, resume: answer('ok'), routes: { '/api/tasks': () => ({ __throw: { status, message: 'x', body: { message: 'x' } } }) } });
    q.E('text').value = 'go'; q.E('send').click(); await wait(250);
    [...q.d.querySelector('.card').querySelectorAll('.actions button')].find((b) => b.textContent === 'Approve').click(); await wait(300);
    expect([status, q.calls.filter((x) => /settle/.test(x.p)).length]).toEqual([status, settled]);
    if (settled) expect(q.calls.find((x) => /settle/.test(x.p)).body).toMatchObject({ status: 'failed', http_status: status });
  }
  // A 204 (apiSend's null) settles applied with 204; the composer is disabled while the step is in flight; a settle failing once is retried.
  const c2 = CARD({ id: 31, steps: [STEP({ method: 'DELETE', path: '/api/tasks/5', body: null, idempotency_key: 'casey:31:1' })] });
  let settleFails = 1; let sendDisabledMidRun = null;
  const p2 = await pane({ chats: [{ id: 8, title: 'q' }], turn: cardTurn(c2), cardsApi: { 31: c2 }, resume: answer('Deleted.'),
    routes: { '/api/tasks/5': async () => { await wait(120); return null; } } });
  const realSend = p2.w.__parent.apiSend;
  p2.w.__parent.apiSend = async (path, method, body, headers, opts) => { if (/settle/.test(path) && settleFails-- > 0) { const e = new Error('blip'); throw e; } return realSend(path, method, body, headers, opts); };
  p2.E('text').value = 'go'; p2.E('send').click(); await wait(250);
  [...p2.d.querySelector('.card').querySelectorAll('.actions button')].find((b) => b.textContent === 'Approve').click();
  await wait(60); sendDisabledMidRun = p2.E('send').disabled;
  await wait(500);
  expect(sendDisabledMidRun).toBe(true);
  expect(p2.calls.filter((c) => /cards\/31\/settle/.test(c.p)).length).toBe(1);                 // the recorded one (the failed attempt threw before the fake recorded it)
  expect(p2.calls.find((c) => /cards\/31\/settle/.test(c.p)).body).toMatchObject({ status: 'applied', http_status: 204, result: null });
  expect(p2.calls.filter((c) => c.p === '/api/casey/turn/resume').length).toBe(1);
  expect(p2.E('send').disabled).toBe(false);
});

test('S3b N5/N6/N7: a plain turn the server refuses leaves an open card untouched; a preamble streamed before the card is kept as the answer above it; the outcome note is keyed by the row\'s meta, not by its text', async () => {
  // N5: the 409 arrives before any `chat` line → the card keeps its buttons.
  const card = CARD({ id: 50, steps: [STEP({ idempotency_key: 'casey:50:1' })] });
  let first = true;
  const p = await pane({ chats: [{ id: 8, title: 'q' }], cardsApi: { 50: card }, turn: (body) => { if (first) { first = false; return cardTurn(card)(body); } const e = new Error('A turn is already running in this chat'); e.status = 409; throw e; } });
  p.E('text').value = 'go'; p.E('send').click(); await wait(250);
  p.E('text').value = 'and?'; p.E('send').click(); await wait(250);
  const el = p.d.querySelector('.card');
  expect(el.dataset.status).toBe('proposed');
  expect([...el.querySelectorAll('.actions button')].map((b) => b.textContent)).toEqual(['Approve', 'Decline']);
  expect(p.d.querySelector('.msg.assistant.error').textContent).toBe('A turn is already running in this chat');
  // N6: a preamble before the card.
  const pre = CARD({ id: 51, steps: [STEP({ idempotency_key: 'casey:51:1' })] });
  const p2 = await pane({ chats: [{ id: 8, title: 'q' }], cardsApi: { 51: pre }, turn: (body) => ndjson([{ type: 'chat', id: 8, title: 'q', model: 'm', created: false }, { type: 'delta', text: 'I will **create** it:' }, { type: 'card', card: pre }, { type: 'final', body: { chat_id: 8, text: '', calls: 1, cost_cents: 0, ms: 1, limited: false, stopped: false, card_id: 51 } }]) });
  p2.E('text').value = 'go'; p2.E('send').click(); await wait(250);
  const bubble = p2.d.querySelector('.msg.assistant.md');
  expect(bubble.classList.contains('streaming')).toBe(false);
  expect(bubble.querySelector('strong').textContent).toBe('create');
  expect(bubble.querySelector('.meta')).toBeNull();
  expect(p2.d.querySelector('.card').dataset.cardId).toBe('51');
  // N7: a user message that starts with "[Card " is the user's words unless the row's meta says it is an outcome.
  const messages = [
    { seq: 1, role: 'user', content: [T('[context — refreshed each turn]\nx'), T('[Card games] are fun, right?')] },
    { seq: 2, role: 'assistant', content: [T('Sure.')] },
    { seq: 3, role: 'user', content: [T('[context — refreshed each turn]\nx'), T('[Card 9 — approved by the user; 1 of 1 step applied.]\nStep 1: …')], meta: { card_outcome: { card_id: 9, status: 'resumed', steps: ['applied'] } } },
    { seq: 4, role: 'assistant', content: [T('Done.')] },
  ];
  const p3 = await pane({ chats: [{ id: 8, title: 'q' }], transcripts: { 8: { status: 'success', chat: { id: 8, title: 'q', model: 'm' }, messages } } });
  p3.E('chatPick').value = '8'; p3.E('chatPick').dispatchEvent(new p3.w.Event('change')); await wait(200);
  expect([...p3.d.querySelectorAll('.msg.user')].map((n) => n.textContent)).toEqual(['[Card games] are fun, right?']);
  expect([...p3.d.querySelectorAll('.trail .note')].map((n) => n.textContent)).toEqual(['[Card 9 — approved by the user; 1 of 1 step applied.]']);
});

test('S3b SF1/N-b/N-d: a successful step announces itself on the parent\'s sync bus (the response path skips the shell\'s own sniff); a 404 on the settle retry counts as recorded; a plain turn accepted then rolled back re-reads the cards it painted', async () => {
  // SF1: the sniff gets the method, the path and the parsed result.
  const card = CARD({ id: 60, steps: [STEP({ method: 'PATCH', path: '/api/contacts/12?x=1', body: '{"first_name":"Ann"}', idempotency_key: 'casey:60:1' })] });
  const sniffed = [];
  const p = await pane({ chats: [{ id: 8, title: 'q' }], turn: cardTurn(card), cardsApi: { 60: card }, resume: answer('Renamed.'), routes: { '/api/contacts/12?x=1': () => ({ status: 'success', changes: { first_name: 'Ann' } }) } });
  p.w.__parent.YC = { _sniff: (m, e, b) => sniffed.push([m, e, b]) };
  p.E('text').value = 'go'; p.E('send').click(); await wait(250);
  [...p.d.querySelector('.card').querySelectorAll('.actions button')].find((b) => b.textContent === 'Approve').click(); await wait(400);
  expect(sniffed).toEqual([['PATCH', '/api/contacts/12?x=1', { status: 'success', changes: { first_name: 'Ann' } }]]);
  expect(p.calls.find((c) => /cards\/60\/settle/.test(c.p)).body).toMatchObject({ status: 'applied', http_status: 200 });
  // N-b: the first settle landed but its answer was lost → the retry 404s → recorded, no note, the run goes on to the resume.
  const c2 = CARD({ id: 61, steps: [STEP({ idempotency_key: 'casey:61:1' })] });
  const p2 = await pane({ chats: [{ id: 8, title: 'q' }], turn: cardTurn(c2), cardsApi: { 61: c2 }, resume: answer('ok'), routes: { '/api/tasks': () => ({ ok: 1 }) } });
  const real = p2.w.__parent.apiSend; let first = true;
  p2.w.__parent.apiSend = async (path, method, body, headers, opts) => { if (/settle/.test(path) && first) { first = false; await real(path, method, body, headers, opts); const e = new Error('lost'); throw e; } return real(path, method, body, headers, opts); };   // recorded server-side, answer lost
  p2.E('text').value = 'go'; p2.E('send').click(); await wait(250);
  [...p2.d.querySelector('.card').querySelectorAll('.actions button')].find((b) => b.textContent === 'Approve').click(); await wait(400);
  expect(p2.d.querySelector('.card .state.err')).toBeNull();
  expect(p2.d.querySelector('.card').dataset.status).toBe('resumed');
  expect(p2.calls.filter((c) => c.p === '/api/casey/turn/resume').length).toBe(1);
  // N-d: a plain turn the server accepts (chat line) then rolls back (error, no final) → the card is re-read and its buttons are back.
  const c3 = CARD({ id: 62, steps: [STEP({ idempotency_key: 'casey:62:1' })] });
  let n = 0;
  const p3 = await pane({ chats: [{ id: 8, title: 'q' }], cardsApi: { 62: c3 }, turn: (body) => (++n === 1 ? cardTurn(c3)(body) : ndjson([{ type: 'chat', id: 8, title: 'q', model: 'm', created: false }, { type: 'error', status: 502, message: 'The model call failed (api_error)' }])) });
  p3.E('text').value = 'go'; p3.E('send').click(); await wait(250);
  p3.E('text').value = 'never mind'; p3.E('send').click(); await wait(300);
  const el3 = p3.d.querySelector('.card');
  expect(el3.dataset.status).toBe('proposed');                                                      // re-read from the (unchanged) fake: open again
  expect([...el3.querySelectorAll('.actions button')].map((b) => b.textContent)).toEqual(['Approve', 'Decline']);
  expect(el3.textContent).not.toMatch(/Not acted on/);
});

test('S3b-2: a route answer over 200 KB is trimmed by the page before the settle — STRUCTURALLY (keys kept, so the server still redacts a token deep inside), measured in bytes, and only AFTER the sync bus got the whole answer', async () => {
  const card = CARD({ id: 70, steps: [STEP({ idempotency_key: 'casey:70:1' })] });
  const sniffed = [];
  const answerBody = { status: 'success', task: { id: 9, action_token: 'uUUZoVRSabcd', note: 'n'.repeat(5000) }, rows: Array.from({ length: 6000 }, (_, i) => ({ i, pad: 'p'.repeat(40) })) };
  const p = await pane({ chats: [{ id: 8, title: 'q' }], turn: cardTurn(card), cardsApi: { 70: card }, resume: answer('ok'), routes: { '/api/tasks': () => answerBody } });
  p.w.__parent.YC = { _sniff: (m, e, b) => sniffed.push(b) };
  p.E('text').value = 'go'; p.E('send').click(); await wait(250);
  [...p.d.querySelector('.card').querySelectorAll('.actions button')].find((b) => b.textContent === 'Approve').click(); await wait(600);
  expect(sniffed).toHaveLength(1); expect(sniffed[0].rows).toHaveLength(6000);   // the bus got the route's whole answer (review S2)
  const settle = p.calls.find((c) => /cards\/70\/settle/.test(c.p)).body;
  expect(settle.status).toBe('applied');
  expect(settle.result.truncated_by_page).toBe(true);
  expect(settle.result.result.task.action_token).toBe('uUUZoVRSabcd');          // the key survives: the server's redaction fires on it (review S1)
  expect(settle.result.result.task.note.endsWith('…[cut]')).toBe(true);
  expect(settle.result.result.rows.length).toBeLessThanOrEqual(51);
  expect(String(settle.result.result.rows[settle.result.result.rows.length - 1])).toMatch(/more items cut by the page/);
  expect(new TextEncoder().encode(JSON.stringify(settle.result)).length).toBeLessThan(150001);
  // Bytes, not characters: a Hebrew-heavy answer of 110k characters is ~220 KB in bytes — it must be trimmed although its length is under 200,000 (review S3).
  const he = { status: 'success', lines: Array.from({ length: 1100 }, () => 'שלום עולם '.repeat(10)) };
  expect(JSON.stringify(he).length).toBeLessThan(200000); expect(new TextEncoder().encode(JSON.stringify(he)).length).toBeGreaterThan(200000);
  const c2 = CARD({ id: 71, steps: [STEP({ idempotency_key: 'casey:71:1' })] });
  const p2 = await pane({ chats: [{ id: 8, title: 'q' }], turn: cardTurn(c2), cardsApi: { 71: c2 }, resume: answer('ok'), routes: { '/api/tasks': () => he } });
  p2.E('text').value = 'go'; p2.E('send').click(); await wait(250);
  [...p2.d.querySelector('.card').querySelectorAll('.actions button')].find((b) => b.textContent === 'Approve').click(); await wait(600);
  const s2 = p2.calls.find((c) => /cards\/71\/settle/.test(c.p)).body;
  expect(s2.result.truncated_by_page).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(s2.result)).length).toBeLessThan(150001);
  // A small answer goes as it is.
  const c3 = CARD({ id: 72, steps: [STEP({ idempotency_key: 'casey:72:1' })] });
  const p3 = await pane({ chats: [{ id: 8, title: 'q' }], turn: cardTurn(c3), cardsApi: { 72: c3 }, resume: answer('ok'), routes: { '/api/tasks': () => ({ ok: 1 }) } });
  p3.E('text').value = 'go'; p3.E('send').click(); await wait(250);
  [...p3.d.querySelector('.card').querySelectorAll('.actions button')].find((b) => b.textContent === 'Approve').click(); await wait(400);
  expect(p3.calls.find((c) => /cards\/72\/settle/.test(c.p)).body.result).toEqual({ ok: 1 });
});

test('S3b-2: a route ERROR body over 200 KB is trimmed too, so the failed settle is not refused and the step reads failed, not unknown', async () => {
  const card = CARD({ id: 73, steps: [STEP({ idempotency_key: 'casey:73:1' })] });
  const p = await pane({ chats: [{ id: 8, title: 'q' }], turn: cardTurn(card), cardsApi: { 73: card }, resume: answer('ok'), routes: { '/api/tasks': () => ({ __throw: { status: 422, message: 'bad', body: { status: 'error', message: 'bad', details: Array.from({ length: 6000 }, (_, i) => ({ i, pad: 'p'.repeat(40) })) } } }) } });
  p.E('text').value = 'go'; p.E('send').click(); await wait(250);
  [...p.d.querySelector('.card').querySelectorAll('.actions button')].find((b) => b.textContent === 'Approve').click(); await wait(600);
  const settle = p.calls.find((c) => /cards\/73\/settle/.test(c.p)).body;
  expect(settle).toMatchObject({ status: 'failed', http_status: 422 });
  expect(settle.result.truncated_by_page).toBe(true);
  expect(settle.result.result.message).toBe('bad');
  expect(new TextEncoder().encode(JSON.stringify(settle.result)).length).toBeLessThan(150001);
});
