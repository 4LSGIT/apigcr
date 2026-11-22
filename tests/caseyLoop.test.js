// Casey v2 S2 — services/casey/loop.js with a SCRIPTED model (converse
// injected) over the REAL S1 tools against a small listening app, and an
// in-memory casey mockStore (services/casey/chats mocked with the same API; the
// real mockStore is proven by tests/caseyChats.mysql.test.js, which also runs one
// turn end to end on MySQL). What this file proves:
//   • the request to the model: the system text and tool definitions are the
//     same bytes on every call; the model and effort come from the settings
//     and are frozen on the chat; consumer_ref / prompt_key / prompt_version;
//   • tool_use blocks run AS THE USER (whoami, lookup_routes, api_get over
//     loopback, read_source), results come back as tool_result blocks with
//     the envelope JSON, is_error on a refusal, in the model's order;
//   • every stored message equals what was sent — the replay is byte-exact,
//     and the next turn sends the stored history verbatim plus one new user
//     message whose first block is the turn's context (the only volatile text);
//   • the stops: end_turn, refusal (no tool runs), max_tokens (one retry at
//     the larger cap, then text-only), the call budget (the note, then a
//     text-only stop when ignored), a model error (rolled back when only the
//     opening row exists, kept otherwise), a 400 naming thinking (one retry
//     with the history's thinking blocks dropped), an older prompt_version
//     (thinking dropped up front, re-stamped on release);
//   • the spend cap refuses before the first call (no chat) and mid-turn;
//   • 400 / 404 / 409 before the stream; heartbeat lines under a slow model.
'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'casey-loop-test-secret';

// ── the in-memory mockStore ───────────────────────────────────────────────────
const mockStore = { chats: new Map(), messages: new Map(), nextChat: 1, nextMsg: 1, claimFails: false, released: [] };
jest.mock('../services/casey/chats', () => {
  const actual = jest.requireActual('../services/casey/chats');
  const clone = (v) => JSON.parse(JSON.stringify(v));
  return {
    ...actual,
    async createChat(db, { userId, text, model, effort, promptVersion }) {
      const id = mockStore.nextChat++;
      mockStore.chats.set(id, { id, user_id: userId, title: actual.titleFrom(text), model, effort, prompt_version: promptVersion, thinking_floor_seq: 0, running_since: null });
      mockStore.messages.set(id, []);
      return id;
    },
    async getChat(db, id, userId) { const c = mockStore.chats.get(Number(id)); return c && c.user_id === userId ? { ...c } : null; },
    async listChats(db, userId) { return [...mockStore.chats.values()].filter((c) => c.user_id === userId); },
    async deleteChat(db, id, userId) { const c = mockStore.chats.get(Number(id)); if (!c || c.user_id !== userId) return false; mockStore.chats.delete(Number(id)); mockStore.messages.delete(Number(id)); return true; },
    async claimTurn(db, id, userId) { const c = mockStore.chats.get(Number(id)); if (!c || c.user_id !== userId || mockStore.claimFails || c.running_since) return false; c.running_since = new Date(); c.stop_requested_at = null; return true; },
    async requestStop(db, id, userId) { const c = mockStore.chats.get(Number(id)); if (!c || c.user_id !== userId || !c.running_since || c.stop_requested_at) return false; c.stop_requested_at = new Date(); return true; },
    async stopRequested(db, id) { const c = mockStore.chats.get(Number(id)); mockStore.stopChecks = (mockStore.stopChecks || 0) + 1; return !!(c && c.stop_requested_at); },
    async releaseTurn(db, id, { promptVersion, thinkingFloorSeq } = {}) { const c = mockStore.chats.get(Number(id)); mockStore.released.push([Number(id), promptVersion, thinkingFloorSeq]); if (c) { c.running_since = null; if (promptVersion) { c.prompt_version = promptVersion; c.thinking_floor_seq = Math.max(c.thinking_floor_seq, Number(thinkingFloorSeq) || 0); } } },
    // The real store strips below the floor on load (tests/caseyChats.mysql.test.js proves it); mirrored here so the loop's floor logic is observable.
    async loadMessages(db, chatId, { thinkingFloorSeq = 0 } = {}) { return clone(mockStore.messages.get(Number(chatId)) || []).map((m) => (m.role === 'assistant' && m.seq < thinkingFloorSeq ? { ...m, content: actual.stripThinkingBlocks(m.content) } : m)); },
    async appendMessage(db, chatId, role, content, meta) {
      const list = mockStore.messages.get(Number(chatId));
      const row = { id: mockStore.nextMsg++, seq: list.length + 1, role, content: clone(content), meta: meta == null ? null : clone(meta) };
      list.push(row);
      return { id: row.id, seq: row.seq };
    },
    async deleteMessages(db, chatId, ids) { const list = mockStore.messages.get(Number(chatId)); const n = list.length; mockStore.messages.set(Number(chatId), list.filter((m) => !ids.includes(m.id))); return n - list.length; },
  };
});
const mockSettings = { model: null, models: null, effort: null };
jest.mock('../lib/firmConfig', () => {
  const actual = jest.requireActual('../lib/firmConfig');
  return { ...actual, cfg: jest.fn((k) => (k === 'casey_v2_model' ? mockSettings.model : k === 'casey_v2_models' ? mockSettings.models : k === 'casey_v2_effort' ? mockSettings.effort : actual.cfg(k))) };
});

const loop = require('../services/casey/loop');
const chats = require('../services/casey/chats');
const aiService = require('../services/aiService');
const tools = require('../services/casey/tools');
const prompt = require('../lib/caseyPrompt');
const { mintElevationToken } = require('../lib/auth.superuser');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

// ── the db stub: spend reads only (the mockStore is mocked) ───────────────────
const spendState = { cap: null, spent: 0 };
const CRED_ROW = { id: 12, name: 'Claude', type: 'api_key', config: JSON.stringify({ header: 'x-api-key', key: 'test-key' }), allowed_urls: null, access_token: null, oauth_status: null, verbose: 0 };
const aiRows = [];
const db = { query: jest.fn(async (sql, params) => {
  if (/FROM app_settings/i.test(sql)) return [spendState.cap == null ? [] : [{ key: 'assistant_ai_monthly_cap_cents', value: spendState.cap }]];
  if (/SUM\(cost_cents\)/i.test(sql)) return [[{ c: spendState.spent }]];
  if (/FROM credentials/i.test(sql)) return [[CRED_ROW]];                          // the seam test's REAL converse
  if (/INSERT INTO ai_calls/i.test(sql)) { aiRows.push(params); return [{ insertId: aiRows.length }]; }
  throw new Error(`unexpected sql: ${sql}`);
}) };

// ── the listening app (probe + the casey routes, so the catalog has them) ──
let app, server, port;
const probe = express.Router();
probe.get('/api/_casey_loop/echo', jwtOrApiKey, (req, res) => res.json({ user: req.auth.username, via: req.headers['x-casey-via'], q: req.query }));
beforeAll(async () => {
  app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use(probe);
  app.use(require('../routes/api.casey'));
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  port = server.address().port;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => {
  mockStore.chats.clear(); mockStore.messages.clear(); mockStore.nextChat = 1; mockStore.nextMsg = 1; mockStore.claimFails = false; mockStore.released.length = 0;
  spendState.cap = null; spendState.spent = 0; mockSettings.model = null; mockSettings.models = null; mockSettings.effort = null; call = 0;
});

const SU = { type: 'jwt', userId: 6, username: 'IT', roles: ['su'] };
const token = jwt.sign({ sub: 6, username: 'IT', user_auth: 'authorized', roles: ['su'], aud: 'staff' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const ctx = (extra = {}) => ({ db, auth: SU, app, port, via: 'casey', ip: '203.0.113.9', headers: { authorization: `Bearer ${token}`, 'user-agent': 'jest' }, ...extra });

// ── the scripted model ────────────────────────────────────────────────────
const T = (text) => ({ type: 'text', text });
const TH = (t, sig = 'SIG') => ({ type: 'thinking', thinking: t, signature: sig });
const TU = (id, name, input) => ({ type: 'tool_use', id, name, input });
let call = 0;
const reply = (content, stop = 'end_turn', extra = {}) => ({
  ok: true, content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 },
  cost_cents: 0.5, callId: 100 + (++call), latency_ms: 7, partial: [], ...extra,
});
/** A converse stub fed by a script: each entry is a reply object or a function(opts) → reply. Records every request. */
function model(script) {
  const requests = [];
  const fn = jest.fn(async (dbArg, opts) => {
    requests.push(JSON.parse(JSON.stringify({ messages: opts.messages, system: opts.system, tools: opts.tools, model: opts.model, effort: opts.effort, max_tokens: opts.max_tokens, consumerRef: opts.consumerRef, promptKey: opts.promptKey, promptVersion: opts.promptVersion, logContent: opts.logContent, thinkingDisplay: opts.thinkingDisplay, timeout_ms: opts.timeout_ms })));
    const next = script.shift();
    if (!next) throw new Error('script exhausted');
    const out = typeof next === 'function' ? await next(opts) : next;
    return JSON.parse(JSON.stringify(out));
  });
  fn.requests = requests;
  return fn;
}
async function turn(opts) {
  const events = [];
  const res = await loop.runTurn(db, { ctx: ctx(), text: 'q', send: (e) => events.push(e), heartbeatMs: 0, ...opts });
  return { events, res, types: events.map((e) => e.type) };
}
const stored = (id) => mockStore.messages.get(id).map((m) => ({ role: m.role, content: m.content }));
const sig = () => prompt.signature(tools.definitions());

// ─────────────────────────────────────────────────────────────────────────────
describe('a turn with tools', () => {
  test('runs tool_use blocks as the user, feeds the envelopes back, streams the events, stores exactly what was sent', async () => {
    mockSettings.model = 'claude-sonnet-5-5'; mockSettings.effort = 'low';
    const converse = model([
      (o) => { expect(o.onEvent).toBeInstanceOf(Function); o.onEvent({ type: 'thinking', text: 'hm' }); return reply([TH('who?'), TU('t1', 'whoami', {})], 'tool_use'); },
      reply([TH('two reads', 'S2'), T('Reading.'), TU('t2', 'api_get', { path: '/api/_casey_loop/echo', query: { a: '1' } }), TU('t3', 'api_get', { path: '/api/casey/catalog' }), TU('t4', 'read_source', { path: 'lib/caseyPrompt.js', lines: 3 })], 'tool_use'),
      (o) => { o.onEvent({ type: 'text', text: 'Done' }); o.onEvent({ type: 'text', text: '.' }); return reply([TH('answer'), T('Done.')]); },
    ]);
    const { events, res, types } = await turn({ converse, text: '  How are things?  ' });
    expect(res.ok).toBe(true);
    expect(types).toEqual(['chat', 'thinking', 'tool_call', 'tool_result', 'tool_call', 'tool_call', 'tool_call', 'tool_result', 'tool_result', 'tool_result', 'delta', 'delta', 'final']);
    expect(events[0]).toEqual({ type: 'chat', id: 1, title: 'How are things?', model: 'claude-sonnet-5-5', effort: 'low', created: true, prompt_version: sig() });

    // The requests: same system bytes and tools every call; labels; the chat's model + effort; logContent false.
    const reqs = converse.requests;
    expect(reqs).toHaveLength(3);
    for (const r of reqs) {
      expect(r.system).toBe(prompt.systemText());
      expect(r.tools).toEqual(tools.definitions());
      expect(r).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low', max_tokens: 16000, consumerRef: 'assistant_v2:u6:c1', promptKey: 'casey_v2_turn', promptVersion: sig(), logContent: false, thinkingDisplay: 'summarized' });
    }
    // The first user message: the context block, then the text (trimmed).
    const u0 = reqs[0].messages[0];
    expect(reqs[0].messages).toHaveLength(1);
    expect(u0.role).toBe('user');
    expect(u0.content[0].text).toMatch(/^\[context — refreshed each turn\]\nNow: .* \(America\/Detroit\); UTC \d{4}-.*Z\nActing as: IT \(user_id 6\); roles: su; superuser: yes; elevation live: no\nPage: /);
    expect(u0.content[1]).toEqual(T('How are things?'));
    // The tool results: whoami ran as IT; the echo saw the forwarded token and X-Casey-Via casey:c1; the SU catalog route was refused; read_source read the file.
    const r1 = reqs[1].messages;
    expect(r1).toHaveLength(3);
    expect(r1[1]).toEqual({ role: 'assistant', content: [TH('who?'), TU('t1', 'whoami', {})] });
    expect(r1[2].role).toBe('user');
    expect(r1[2].content).toHaveLength(1);
    const env1 = JSON.parse(r1[2].content[0].content);
    expect(r1[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    expect(r1[2].content[0].is_error).toBeUndefined();
    expect(env1).toMatchObject({ ok: true, tool: 'whoami', data: { user_id: 6, username: 'IT', is_superuser: true, elevated: false } });
    const r2 = reqs[2].messages;
    expect(r2).toHaveLength(5);
    const results = r2[4].content;
    expect(results.map((b) => b.tool_use_id)).toEqual(['t2', 't3', 't4']);          // the model's order, whatever finished first
    const echo = JSON.parse(results[0].content);
    expect(echo).toMatchObject({ ok: true, tool: 'api_get', untrusted: true, data: { status: 200, body: { user: 'IT', via: 'casey:c1', q: { a: '1' } } } });
    const refused = JSON.parse(results[1].content);
    expect(results[1].is_error).toBe(true);
    expect(refused).toMatchObject({ ok: false, tool: 'api_get', error: { code: 'NOT_AUTO_GET' } });
    const src = JSON.parse(results[2].content);
    expect(src.data.text || src.data.lines || JSON.stringify(src.data)).toMatch(/caseyPrompt/);
    // Events carry the summaries; the final sums.
    expect(events.filter((e) => e.type === 'tool_call').map((e) => e.name)).toEqual(['whoami', 'api_get', 'api_get', 'read_source']);
    expect(events.find((e) => e.type === 'tool_result' && e.id === 't3')).toMatchObject({ ok: false, code: 'NOT_AUTO_GET', name: 'api_get', truncated: false });
    const final = events[events.length - 1].body;
    expect(final).toMatchObject({ chat_id: 1, seq: 6, text: 'Done.', calls: 4, limited: false, model: 'claude-sonnet-5-5', effort: 'low', prompt_version: sig(), cost_cents: 1.5,
      usage: { input_tokens: 30, output_tokens: 60, cache_read_input_tokens: 27000, cache_creation_input_tokens: 0 } });
    expect(final.tool_calls.map((t) => [t.name, t.ok])).toEqual([['whoami', true], ['api_get', true], ['api_get', false], ['read_source', true]]);
    expect(res.final).toEqual(final);
    // Stored = sent: the six rows are the last request's messages plus the final assistant message, byte for byte.
    const rows = stored(1);
    expect(rows).toHaveLength(6);
    expect(JSON.stringify(rows.slice(0, 5))).toBe(JSON.stringify(reqs[2].messages));
    expect(rows[5]).toEqual({ role: 'assistant', content: [TH('answer'), T('Done.')] });
    const metas = mockStore.messages.get(1).map((m) => m.meta);
    expect(metas[0].context).toMatchObject({ user_id: 6, username: 'IT', superuser: true, elevated: false, zone: 'America/Detroit' });
    expect(metas[1]).toMatchObject({ ai_call_id: expect.any(Number), stop_reason: 'tool_use', cost_cents: 0.5, ms: 7 });
    expect(metas[2].tool_calls.map((t) => t.id)).toEqual(['t1']);
    expect(metas[4].tool_calls.map((t) => t.id)).toEqual(['t2', 't3', 't4']);
    expect(mockStore.released).toEqual([[1, sig(), 0]]);
    expect(mockStore.chats.get(1).running_since).toBeNull();
  });

  test('the next turn replays the stored history verbatim and adds one user message; only its context block is new', async () => {
    const c1 = model([reply([TH('a'), TU('t1', 'whoami', {})], 'tool_use'), reply([TH('b'), T('One.')])]);
    const t1 = await turn({ converse: c1, text: 'first', now: () => new Date('2026-11-22T20:00:00Z') });
    expect(t1.res.ok).toBe(true);
    const c2 = model([reply([T('Two.')])]);
    const elev = mintElevationToken(6);
    const t2 = await turn({ converse: c2, chatId: 1, text: 'second', now: () => new Date('2026-11-23T01:30:00Z'), ctx: ctx({ headers: { authorization: `Bearer ${token}`, 'x-su-elevation': elev } }) });
    expect(t2.res.ok).toBe(true);
    expect(t2.events[0]).toMatchObject({ type: 'chat', id: 1, created: false });
    const sent = c2.requests[0].messages;
    const history = stored(1).slice(0, 4);
    expect(JSON.stringify(sent.slice(0, 4))).toBe(JSON.stringify(history));
    expect(sent).toHaveLength(5);
    expect(sent[4].role).toBe('user');
    expect(sent[4].content[0].text).toMatch(/^\[context — refreshed each turn\]\nNow: Sunday 2026-11-22 20:30 EST \(America\/Detroit\); UTC 2026-11-23T01:30:00Z\nActing as: IT \(user_id 6\); roles: su; superuser: yes; elevation live: yes\n/);
    expect(sent[0].content[0].text).toMatch(/Now: Sunday 2026-11-22 15:00 EST/);
    expect(sent[4].content[1]).toEqual(T('second'));
    expect(c2.requests[0].system).toBe(c1.requests[0].system);
    expect(stored(1)).toHaveLength(6);
    expect(t2.events[t2.events.length - 1].body).toMatchObject({ chat_id: 1, seq: 6, text: 'Two.', calls: 0 });
  });

  test('a chat built under another prompt_version has its thinking blocks dropped before the call and is re-stamped on release', async () => {
    const c1 = model([reply([TH('a'), TU('t1', 'whoami', {})], 'tool_use'), reply([TH('b'), T('One.')])]);
    await turn({ converse: c1, text: 'first' });
    mockStore.chats.get(1).prompt_version = 'v2.0-00000000';
    const c2 = model([reply([T('Two.')])]);
    const t2 = await turn({ converse: c2, chatId: 1, text: 'second' });
    expect(t2.res.ok).toBe(true);
    const sent = c2.requests[0].messages;
    expect(sent[1]).toEqual({ role: 'assistant', content: [TU('t1', 'whoami', {})] });
    expect(sent[3]).toEqual({ role: 'assistant', content: [T('One.')] });
    expect(JSON.stringify(sent).includes('"thinking"')).toBe(false);
    expect(mockStore.chats.get(1).prompt_version).toBe(sig());
    expect(stored(1)[1].content[0]).toEqual(TH('a'));   // the stored rows are never edited
    // The drop is PERMANENT: the floor is the opening row of turn 2 (seq 5), so turn 3 — now under the current
    // signature — still sends turn 1 without its thinking, and turn 2's own blocks with theirs.
    expect(mockStore.chats.get(1).thinking_floor_seq).toBe(5);
    expect(mockStore.released[mockStore.released.length - 1]).toEqual([1, sig(), 5]);
    const c3 = model([reply([T('Three.')])]);
    const t3 = await turn({ converse: c3, chatId: 1, text: 'third' });
    expect(t3.res.ok).toBe(true);
    const sent3 = c3.requests[0].messages;
    expect(sent3[1]).toEqual({ role: 'assistant', content: [TU('t1', 'whoami', {})] });
    expect(sent3[3]).toEqual({ role: 'assistant', content: [T('One.')] });
    expect(sent3[5]).toEqual({ role: 'assistant', content: [T('Two.')] });   // turn 2's reply had no thinking in this script
    expect(mockStore.chats.get(1).thinking_floor_seq).toBe(5);              // unchanged: nothing new was stripped
    // A floor is never lowered: a later release with a smaller value keeps 5.
    await chats.releaseTurn(db, 1, { promptVersion: sig(), thinkingFloorSeq: 2 });
    expect(mockStore.chats.get(1).thinking_floor_seq).toBe(5);
  });

  test('a 400 naming thinking (in the provider\'s `api` message — the logged detail is only http_400): one retry with the history\'s thinking dropped, the floor raised to the request\'s last message', async () => {
    const c1 = model([reply([TH('a'), T('One.')])]);
    await turn({ converse: c1, text: 'first' });
    const binding = (callId) => ({ ok: false, error: 'api_error', status: 400, detail: 'http_400', api: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid signature in thinking block' }, callId });
    const c2 = model([binding(9), reply([T('Two.')])]);
    const t2 = await turn({ converse: c2, chatId: 1, text: 'second' });
    expect(t2.res.ok).toBe(true);
    expect(c2.requests).toHaveLength(2);
    expect(c2.requests[0].messages[1].content).toEqual([TH('a'), T('One.')]);
    expect(c2.requests[1].messages[1].content).toEqual([T('One.')]);
    expect(c2.requests[1].messages[2]).toEqual(c2.requests[0].messages[2]);
    expect(mockStore.chats.get(1).thinking_floor_seq).toBe(3);   // the request's last message = turn 2's opening row (seq 3)
    // A second 400 is the turn's failure, not another retry; a 400 with another message is never retried.
    const c3 = model([binding(9), binding(10)]);
    const t3 = await turn({ converse: c3, chatId: 1, text: 'third' });
    expect(t3.res.ok).toBe(false);
    expect(c3.requests).toHaveLength(2);
    expect(t3.events[t3.events.length - 1]).toMatchObject({ type: 'error', status: 502, message: 'The model call failed (api_error)', detail: 'http_400' });
    const c4 = model([{ ok: false, error: 'api_error', status: 400, detail: 'http_400', api: { type: 'invalid_request_error', message: 'max_tokens too large' }, callId: 11 }]);
    const t4 = await turn({ converse: c4, chatId: 1, text: 'fourth' });
    expect(t4.res.ok).toBe(false);
    expect(c4.requests).toHaveLength(1);
  });

  test('the seam: the REAL converse with logContent:false still lets the loop see the binding 400 and retry', async () => {
    const c1 = model([reply([TH('a'), T('One.')])]);
    await turn({ converse: c1, text: 'first' });
    const realFetch = global.fetch;
    const bodies = [];
    const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const sse = [ev('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }), ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }), ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Two.' } }), ev('content_block_stop', { index: 0 }), ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }), ev('message_stop', {})].join('');
    const responses = [
      { ok: false, status: 400, json: async () => ({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid signature in thinking block' } }), body: null },
      { ok: true, status: 200, json: async () => { throw new Error('stream'); }, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }) },
    ];
    global.fetch = jest.fn(async (url, init) => { bodies.push(JSON.parse(init.body)); return responses.shift(); });
    try {
      const t2 = await turn({ converse: aiService.converse, chatId: 1, text: 'second' });
      expect(t2.res.ok).toBe(true);
      expect(bodies).toHaveLength(2);
      expect(bodies[0].messages[1].content[0].type).toBe('thinking');
      expect(bodies[1].messages[1].content).toEqual([T('One.')]);
      expect(t2.events[t2.events.length - 1].body.text).toBe('Two.');
      expect(aiRows.slice(-2).map((r) => r[7])).toEqual(['http_400', null]);   // the row kept the code only
      expect(mockStore.chats.get(1).thinking_floor_seq).toBe(3);
    } finally { global.fetch = realFetch; }
  });
});

describe('the stops', () => {
  test('refusal: no tool runs, a text-only assistant row, the declined note', async () => {
    const converse = model([reply([TH('x'), TU('t1', 'whoami', {})], 'refusal')]);
    const { events, res, types } = await turn({ converse });
    expect(res.ok).toBe(true);
    expect(types).toEqual(['chat', 'final']);
    expect(stored(1)[1]).toEqual({ role: 'assistant', content: [T(loop.DECLINED_NOTE)] });
    expect(mockStore.messages.get(1)[1].meta).toMatchObject({ altered: 'refusal', stop_reason: 'refusal' });
    expect(events[1].body).toMatchObject({ text: loop.DECLINED_NOTE, calls: 0, limited: false });
  });

  test('max_tokens: the same request once more at the larger cap (nothing stored, a reset line); a second cut stores text-only and is limited', async () => {
    const converse = model([reply([TH('x'), T('partial'), TU('t1', 'whoami', {})], 'max_tokens', { partial: [2] }), reply([T('Whole answer.')])]);
    const { events, res, types } = await turn({ converse });
    expect(res.ok).toBe(true);
    expect(types).toEqual(['chat', 'reset', 'final']);
    expect(converse.requests.map((r) => r.max_tokens)).toEqual([16000, 64000]);
    expect(JSON.stringify(converse.requests[0].messages)).toBe(JSON.stringify(converse.requests[1].messages));
    expect(stored(1)).toHaveLength(2);
    expect(events[2].body).toMatchObject({ text: 'Whole answer.', limited: false });
    const twice = model([reply([T('cut')], 'max_tokens'), reply([T('still cut')], 'max_tokens')]);
    const t2 = await turn({ converse: twice });
    expect(t2.res.ok).toBe(true);
    expect(stored(2)[1]).toEqual({ role: 'assistant', content: [T('still cut')] });
    expect(mockStore.messages.get(2)[1].meta.altered).toBe('max_tokens');
    expect(t2.events[t2.events.length - 1].body).toMatchObject({ text: 'still cut', limited: true });
    const empty = model([reply([TU('t1', 'whoami', {})], 'max_tokens', { partial: [0] }), reply([TU('t1', 'whoami', {})], 'max_tokens', { partial: [0] })]);
    const t3 = await turn({ converse: empty });
    expect(stored(3)[1]).toEqual({ role: 'assistant', content: [T(loop.CUT_NOTE)] });
    expect(t3.types).not.toContain('tool_call');
  });

  test('the call budget: after the round that reaches it the results carry the note; the model\'s answer is limited; a tool_use instead is stored text-only', async () => {
    const converse = model([
      reply([TU('t1', 'whoami', {}), TU('t2', 'whoami', {})], 'tool_use'),
      reply([TU('t3', 'whoami', {})], 'tool_use'),
      reply([T('Answered under the note.')]),
    ]);
    const { events, res } = await turn({ converse, maxCalls: 3 });
    expect(res.ok).toBe(true);
    expect(converse.requests).toHaveLength(3);
    const noteMsg = converse.requests[2].messages[4];
    expect(noteMsg.content.map((b) => b.type)).toEqual(['tool_result', 'text']);
    expect(noteMsg.content[1].text).toBe(loop.BUDGET_NOTE(3, 0));
    expect(converse.requests[1].messages[2].content.map((b) => b.type)).toEqual(['tool_result', 'tool_result']);   // no note before the budget
    expect(mockStore.messages.get(1)[4].meta).toMatchObject({ budget_note: true });
    expect(events[events.length - 1].body).toMatchObject({ text: 'Answered under the note.', calls: 3, limited: true });
    // Ignored: a tool_use after the note is not run; the assistant row is text-only.
    const ignores = model([reply([TU('t1', 'whoami', {})], 'tool_use'), reply([TH('more'), TU('t2', 'whoami', {})], 'tool_use')]);
    const t2 = await turn({ converse: ignores, maxCalls: 1 });
    expect(t2.res.ok).toBe(true);
    expect(ignores.requests).toHaveLength(2);
    expect(t2.events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
    expect(stored(2)[3]).toEqual({ role: 'assistant', content: [T(loop.BUDGET_STOP_NOTE)] });
    expect(mockStore.messages.get(2)[3].meta.altered).toBe('budget');
    expect(t2.events[t2.events.length - 1].body).toMatchObject({ text: loop.BUDGET_STOP_NOTE, limited: true, calls: 1 });
  });

  test('the time budget works the same way (maxMs 0: the first round of tools spends it); every call still gets the deadline floor', async () => {
    const seen = [];
    const converse = model([(o) => { seen.push(o.timeout_ms); return reply([TU('t1', 'whoami', {})], 'tool_use'); }, (o) => { seen.push(o.timeout_ms); return reply([T('ok')]); }]);
    const { events } = await turn({ converse, maxMs: 0 });
    expect(converse.requests[1].messages[2].content[1].text).toMatch(/^\[This turn's tool budget is spent: 1 tool calls/);
    expect(events[events.length - 1].body.limited).toBe(true);
    expect(seen.every((t) => t >= loop.CALL_TIMEOUT_FLOOR_MS)).toBe(true);   // the closing "answer now" call is not starved
    expect(loop.CALL_TIMEOUT_FLOOR_MS).toBe(120000);
  });

  test('an interrupted round (a stored assistant tool_use with no result) is repaired: the next turn opens with is_error tool_results', async () => {
    const c1 = model([reply([TU('t1', 'whoami', {}), TU('t2', 'whoami', {})], 'tool_use'), { ok: false, error: 'api_error', status: 500, detail: 'http_500', callId: 1 }]);
    await turn({ converse: c1, text: 'first' });
    // Simulate the instance dying between the assistant row and the results row: drop the results row.
    mockStore.messages.get(1).pop();
    expect(stored(1)).toHaveLength(2);
    const c2 = model([reply([T('Recovered.')])]);
    const t2 = await turn({ converse: c2, chatId: 1, text: 'second' });
    expect(t2.res.ok).toBe(true);
    const opening = c2.requests[0].messages[2];
    expect(opening.role).toBe('user');
    expect(opening.content.map((b) => b.type)).toEqual(['tool_result', 'tool_result', 'text', 'text']);
    expect(opening.content[0]).toEqual({ type: 'tool_result', tool_use_id: 't1', content: loop.INTERRUPTED_RESULT, is_error: true });
    expect(opening.content[1].tool_use_id).toBe('t2');
    expect(JSON.parse(loop.INTERRUPTED_RESULT)).toMatchObject({ ok: false, error: { code: 'INTERRUPTED' } });
    expect(mockStore.messages.get(1)[2].meta).toMatchObject({ repaired_tool_uses: ['t1', 't2'] });
    expect(stored(1)[2]).toEqual(opening);
    // No repair when the last row is a user row or an assistant text.
    const c3 = model([reply([T('Again.')])]);
    const t3 = await turn({ converse: c3, chatId: 1, text: 'third' });
    expect(c3.requests[0].messages[4].content.map((b) => b.type)).toEqual(['text', 'text']);
    expect(t3.res.ok).toBe(true);
    expect(loop.orphanToolUses([{ role: 'user', content: [T('x')] }])).toEqual([]);
    expect(loop.orphanToolUses([])).toEqual([]);
  });

  test('an unstorable answer (empty blocks, thinking-only, blank text, or tool_use under a non-tool stop) is stored text-only', async () => {
    const c1 = model([reply([])]);
    const t1 = await turn({ converse: c1 });
    expect(t1.res.ok).toBe(true);
    expect(stored(1)[1]).toEqual({ role: 'assistant', content: [T(loop.EMPTY_NOTE)] });
    expect(mockStore.messages.get(1)[1].meta.altered).toBe('unstorable');
    expect(t1.events[t1.events.length - 1].body.text).toBe(loop.EMPTY_NOTE);
    const c0 = model([reply([TH('only thinking')])]);
    const t0 = await turn({ converse: c0 });
    expect(stored(2)[1]).toEqual({ role: 'assistant', content: [T(loop.EMPTY_NOTE)] });
    expect(t0.events[t0.events.length - 1].body.text).toBe(loop.EMPTY_NOTE);
    const cb = model([reply([TH('x'), T('   ')])]);
    await turn({ converse: cb });
    expect(stored(3)[1]).toEqual({ role: 'assistant', content: [T(loop.EMPTY_NOTE)] });
    const cok = model([reply([TH('x'), T('Real.')])]);
    await turn({ converse: cok });
    expect(stored(4)[1]).toEqual({ role: 'assistant', content: [TH('x'), T('Real.')] });   // a normal answer is verbatim
    const c2 = model([reply([T('Partial'), TU('t9', 'whoami', {})], 'end_turn')]);
    const t2 = await turn({ converse: c2 });
    expect(t2.types).not.toContain('tool_call');
    expect(stored(5)[1]).toEqual({ role: 'assistant', content: [T('Partial')] });
    expect(t2.events[t2.events.length - 1].body.text).toBe('Partial');
  });

  test('a partial tool_use (input never arrived whole) with stop tool_use is answered BAD_INPUT, not run', async () => {
    // t2 is whoami, which would SUCCEED on an empty input — so a run shows.
    const converse = model([reply([TU('t1', 'whoami', {}), TU('t2', 'whoami', {})], 'tool_use', { partial: [1] }), reply([T('ok')])]);
    const { events } = await turn({ converse });
    const results = converse.requests[1].messages[2].content;
    expect(JSON.parse(results[0].content).ok).toBe(true);
    expect(JSON.parse(results[1].content)).toMatchObject({ ok: false, error: { code: 'BAD_INPUT', message: expect.stringMatching(/did not arrive whole/) } });
    expect(results[1].is_error).toBe(true);
    expect(events.find((e) => e.type === 'tool_result' && e.id === 't2')).toMatchObject({ ok: false, code: 'BAD_INPUT' });
  });

  test('an unknown tool name from the model is an UNKNOWN_TOOL error result, and the turn goes on', async () => {
    const converse = model([reply([TU('t1', 'make_coffee', { size: 'L' })], 'tool_use'), reply([T('No such tool.')])]);
    const { res } = await turn({ converse });
    expect(res.ok).toBe(true);
    expect(JSON.parse(converse.requests[1].messages[2].content[0].content)).toMatchObject({ ok: false, tool: 'make_coffee', error: { code: 'UNKNOWN_TOOL' } });
  });
});

describe('failures and refusals before / during the stream', () => {
  test('a model error on the first call: error line, the opening row and the new chat rolled back, the claim released', async () => {
    const converse = model([{ ok: false, error: 'timeout', detail: 'timeout after 300000ms', callId: 5 }]);
    const { events, res, types } = await turn({ converse });
    expect(res.ok).toBe(false);
    expect(res.rolled_back).toBe(true);
    expect(types).toEqual(['chat', 'error']);
    expect(events[1]).toEqual({ type: 'error', status: 504, message: 'The model call failed (timeout)', detail: 'timeout after 300000ms' });
    expect(mockStore.chats.size).toBe(0);
    expect(mockStore.released).toEqual([[1, sig(), 0]]);
    // On an existing chat only the opening row goes.
    const ok = model([reply([T('One.')])]);
    await turn({ converse: ok });
    const bad = model([{ ok: false, error: 'api_error', status: 529, detail: 'http_529', callId: 6 }]);
    const t3 = await turn({ converse: bad, chatId: 2 });
    expect(t3.res).toMatchObject({ ok: false, rolled_back: true });
    expect(stored(2)).toHaveLength(2);
    expect(mockStore.chats.has(2)).toBe(true);
  });

  test('a turn under a changed signature that fails before its first write is NOT re-stamped (the next turn strips again)', async () => {
    const c1 = model([reply([TH('a'), T('One.')])]);
    await turn({ converse: c1, text: 'first' });
    mockStore.chats.get(1).prompt_version = 'v2.0-00000000';
    const realAppend = chats.appendMessage;
    chats.appendMessage = jest.fn(async () => { throw new Error('db down'); });
    try {
      const t2 = await turn({ converse: model([]), chatId: 1, text: 'second' });
      expect(t2.res.ok).toBe(false);
    } finally { chats.appendMessage = realAppend; }
    expect(mockStore.chats.get(1)).toMatchObject({ prompt_version: 'v2.0-00000000', thinking_floor_seq: 0, running_since: null });
    // Next turn: strips, raises the floor to its opening row (seq 3), re-stamps.
    const c3 = model([reply([T('Three.')])]);
    const t3 = await turn({ converse: c3, chatId: 1, text: 'third' });
    expect(t3.res.ok).toBe(true);
    expect(c3.requests[0].messages[1].content).toEqual([T('One.')]);
    expect(mockStore.chats.get(1)).toMatchObject({ prompt_version: sig(), thinking_floor_seq: 3 });
  });

  test('Stop: a stop requested during a round ends the turn before the next model call with a text-only [Stopped] row; the claim clears a stale stop', async () => {
    const converse = model([(o) => { mockStore.chats.get(1).stop_requested_at = new Date(); return reply([TU('t1', 'whoami', {})], 'tool_use'); }, reply([T('never sent')])]);
    const { events, res, types } = await turn({ converse });
    expect(res.ok).toBe(true);
    expect(converse.requests).toHaveLength(1);                           // the round ran, the next call did not
    expect(types).toEqual(['chat', 'tool_call', 'tool_result', 'final']);
    expect(stored(1).map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(stored(1)[3]).toEqual({ role: 'assistant', content: [T(loop.STOPPED_NOTE)] });
    expect(mockStore.messages.get(1)[3].meta.altered).toBe('stopped');
    expect(events[3].body).toMatchObject({ stopped: true, limited: false, text: loop.STOPPED_NOTE, calls: 1 });
    // The next turn's claim clears the stale request, so it runs.
    const c2 = model([reply([T('Two.')])]);
    const t2 = await turn({ converse: c2, chatId: 1, text: 'again' });
    expect(t2.res.ok).toBe(true);
    expect(t2.events[t2.events.length - 1].body).toMatchObject({ stopped: false, text: 'Two.' });
    expect(mockStore.chats.get(1).stop_requested_at).toBeNull();
    // A normal final says stopped:false; the page's Keep-going text is exported for the boot route.
    expect(typeof loop.CONTINUE_TEXT).toBe('string');
    expect(loop.CONTINUE_TEXT.length).toBeGreaterThan(20);
  });

  test('the page context rides in the user message\'s context block (never the system prompt) and in the row meta', async () => {
    const converse = model([reply([T('ok')])]);
    const { res } = await turn({ converse, context: { label: 'Cases', case_id: 'C1', nope: 'x' } });
    expect(res.ok).toBe(true);
    const u0 = converse.requests[0].messages[0];
    expect(u0.content[0].text.split('\n').pop()).toBe('Page: Cases; case C1');
    expect(converse.requests[0].system).toBe(prompt.systemText());
    expect(mockStore.messages.get(1)[0].meta.context.page).toEqual({ label: 'Cases', case_id: 'C1' });
    const c2 = model([reply([T('ok')])]);
    await turn({ converse: c2, context: 'garbage' });
    expect(c2.requests[0].messages[0].content[0].text).toMatch(/\nPage: \(none\)$/);
  });

  test('a chat created by the turn whose first store throws is removed (no empty chat lingers)', async () => {
    const realAppend = chats.appendMessage;
    chats.appendMessage = jest.fn(async () => { throw new Error('db down'); });
    try {
      const { res, types } = await turn({ converse: model([]) });
      expect(res.ok).toBe(false);
      expect(res.rolled_back).toBe(true);
      expect(types).toEqual(['chat', 'error']);
      expect(mockStore.chats.size).toBe(0);
    } finally { chats.appendMessage = realAppend; }
  });

  test('a model error after tools ran keeps the stored rows (they were sent); the chat is released', async () => {
    const converse = model([reply([TU('t1', 'whoami', {})], 'tool_use'), { ok: false, error: 'api_error', status: 500, detail: 'http_500', callId: 7 }]);
    const { res, types } = await turn({ converse });
    expect(res.ok).toBe(false);
    expect(res.rolled_back).toBeUndefined();
    expect(types).toEqual(['chat', 'tool_call', 'tool_result', 'error']);
    expect(stored(1)).toHaveLength(3);
    expect(mockStore.chats.get(1).running_since).toBeNull();
  });

  test('a throwing tool run never kills the turn: TOOL_FAILED is a result', async () => {
    const converse = model([reply([TU('t1', 'read_source', { grep: 'x', dir: 'lib' })], 'tool_use'), reply([T('ok')])]);
    const { res } = await turn({ converse, ctx: ctx({ sourceRoot: '/nonexistent/root/for/casey' }) });
    expect(res.ok).toBe(true);
    const env = JSON.parse(converse.requests[1].messages[2].content[0].content);
    expect(env.ok).toBe(false);
  });

  test('the spend cap: at the cap nothing starts (no chat, a 429 thrown); reached mid-turn it ends the turn with a 429 line', async () => {
    spendState.cap = '1000'; spendState.spent = 1000;
    const converse = model([]);
    await expect(loop.runTurn(db, { ctx: ctx(), text: 'q', send: () => {}, converse, heartbeatMs: 0 })).rejects.toMatchObject({ status: 429, message: /monthly AI spending limit/ });
    expect(mockStore.chats.size).toBe(0);
    expect(converse).not.toHaveBeenCalled();
    // One firm cap: the month-to-date sum is over the whole assistant_ family (v1's rows and v2's assistant_v2:… rows).
    expect(db.query.mock.calls.some((c) => /SUM\(cost_cents\)/.test(c[0]) && /consumer_ref LIKE 'assistant\\_%'/.test(c[0]))).toBe(true);
    spendState.spent = 999;
    const c2 = model([(o) => { spendState.spent = 1000; return reply([TU('t1', 'whoami', {})], 'tool_use'); }]);
    const { res, types, events } = await turn({ converse: c2 });
    expect(res.ok).toBe(false);
    expect(types).toEqual(['chat', 'tool_call', 'tool_result', 'error']);
    expect(events[3]).toMatchObject({ type: 'error', status: 429 });
    expect(stored(1)).toHaveLength(3);
    // The cap setting: blank → the 20000-cent default; junk → 0 (closed).
    spendState.cap = ''; spendState.spent = 19999;
    expect((await turn({ converse: model([reply([T('ok')])]) })).res.ok).toBe(true);
    spendState.cap = 'lots'; spendState.spent = 0;
    await expect(loop.runTurn(db, { ctx: ctx(), text: 'q', send: () => {}, converse: model([]), heartbeatMs: 0 })).rejects.toMatchObject({ status: 429 });
  });

  test('400 (text), 404 (not my chat), 409 (busy), 401 (no user) are thrown before begin(), nothing streams', async () => {
    const begin = jest.fn();
    const bad = (o, status, re) => expect(loop.runTurn(db, { ctx: ctx(), text: 'q', send: () => { throw new Error('must not stream'); }, begin, converse: model([]), heartbeatMs: 0, ...o })).rejects.toMatchObject({ status, message: re });
    await bad({ text: '   ' }, 400, /text is required/);
    await bad({ text: 'x'.repeat(4001) }, 400, /longer than 4000/);
    await bad({ chatId: 77 }, 404, /No such chat/);
    await turn({ converse: model([reply([T('ok')])]) });
    mockStore.chats.get(1).user_id = 7;
    await bad({ chatId: 1 }, 404, /No such chat/);
    mockStore.chats.get(1).user_id = 6;
    mockStore.claimFails = true;
    await bad({ chatId: 1 }, 409, /already running/);
    mockStore.claimFails = false;
    await bad({ ctx: ctx({ auth: null }) }, 401, /signed-in user/);
    expect(begin).not.toHaveBeenCalled();
  });

  test('heartbeat lines appear while the model is slow; begin() runs once before the first event', async () => {
    const order = [];
    const converse = model([async () => { await new Promise((r) => setTimeout(r, 120)); return reply([T('slow')]); }]);
    const events = [];
    const res = await loop.runTurn(db, { ctx: ctx(), text: 'q', converse, heartbeatMs: 25, begin: () => order.push('begin'), send: (e) => { order.push(e.type); events.push(e); } });
    expect(res.ok).toBe(true);
    expect(order[0]).toBe('begin');
    expect(order[1]).toBe('chat');
    expect(events.filter((e) => e.type === 'heartbeat').length).toBeGreaterThanOrEqual(2);
    expect(order[order.length - 1]).toBe('final');
  });
});

describe('settings and context', () => {
  test('the model and effort come from the settings, with the list as the guard', () => {
    mockSettings.model = 'claude-fable-5-1'; mockSettings.effort = 'high';
    expect([loop.settingModel(), loop.settingEffort()]).toEqual(['claude-fable-5-1', 'high']);
    mockSettings.model = 'claude-opus-4-1'; mockSettings.effort = 'max';
    expect([loop.settingModel(), loop.settingEffort()]).toEqual(['claude-sonnet-5-5', 'medium']);
    mockSettings.model = null; mockSettings.effort = '';
    expect([loop.settingModel(), loop.settingEffort()]).toEqual(['claude-sonnet-5-5', 'medium']);
    expect(loop.DEFAULT_MODEL).toBe('claude-sonnet-5-5');   // the S2 checkpoint's pick (2026-11-22)
  });

  test('S3a-2 the menu: casey_v2_models narrows MODELS (MODELS order, junk dropped, blank or all-junk = all); the default follows the menu; modelMenu labels every model and marks the default', () => {
    const all = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'];
    expect(loop.settingModels()).toEqual(all);
    mockSettings.models = ' claude-fable-5-1, claude-opus-4-1 ,claude-sonnet-5-5';
    expect(loop.settingModels()).toEqual(['claude-sonnet-5-5', 'claude-fable-5-1']);
    mockSettings.models = 'claude-opus-4-1, nope';
    expect(loop.settingModels()).toEqual(['claude-sonnet-5-5']);          // a non-blank list with nothing valid fails CLOSED to the default, never to all three
    expect(loop.settingModel()).toBe('claude-sonnet-5-5');
    mockSettings.models = ' , ';
    expect(loop.settingModels()).toEqual(all);                            // blank-ish is blank
    mockSettings.models = 'claude-opus-5-5'; mockSettings.model = 'claude-sonnet-5-5';
    expect(loop.settingModel()).toBe('claude-opus-5-5');                 // neither the setting nor Sonnet is on the menu → its first
    mockSettings.models = 'claude-opus-5-5,claude-fable-5-1'; mockSettings.model = 'claude-fable-5-1';
    expect(loop.settingModel()).toBe('claude-fable-5-1');
    mockSettings.model = null;
    expect(loop.settingModel()).toBe('claude-opus-5-5');
    mockSettings.models = 'claude-sonnet-5-5,claude-opus-5-5'; mockSettings.model = 'claude-fable-5-1';
    expect(loop.settingModel()).toBe('claude-sonnet-5-5');               // the setting is off the menu, Sonnet is on it
    mockSettings.models = null; mockSettings.model = 'claude-fable-5-1';
    expect(loop.modelMenu()).toEqual([
      { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: expect.any(String), default: false },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: expect.any(String), default: false },
      { id: 'claude-fable-5-1', label: 'Fable 5.1', hint: expect.any(String), default: true },
    ]);
    expect(loop.modelMenu().filter((m) => m.default)).toHaveLength(1);
    expect(Object.keys(loop.MODEL_LABELS).sort()).toEqual([...loop.MODELS].sort());   // every model has a label
  });

  test('S3a-2 the pick: a new chat is created on the model the user picked when it is on the menu, and the model is called with it; off the menu, or on an existing chat, a 400 before begin(); no pick = the setting default', async () => {
    mockSettings.models = 'claude-sonnet-5-5,claude-opus-5-5';
    const cv = model([reply([T('ok')])]);
    const r = await turn({ model: 'claude-opus-5-5', converse: cv });
    expect(r.events[0]).toMatchObject({ type: 'chat', id: 1, model: 'claude-opus-5-5', created: true });
    expect(mockStore.chats.get(1).model).toBe('claude-opus-5-5');
    expect(cv.requests[0].model).toBe('claude-opus-5-5');
    expect(r.res.ok).toBe(true);
    const begin = jest.fn();
    const bad = (o, re) => expect(loop.runTurn(db, { ctx: ctx(), text: 'q', send: () => { throw new Error('must not stream'); }, begin, converse: model([]), heartbeatMs: 0, ...o })).rejects.toMatchObject({ status: 400, message: re });
    await bad({ model: 'claude-fable-5-1' }, 'That model is not on the menu');   // a real model, off this firm's menu — the EXACT words: public/casey.html compares against them (MENU_REFUSAL)
    await bad({ model: 'gpt-5' }, /not on the menu/);
    await bad({ model: 'claude-sonnet-5-5', chatId: 1 }, /new chat only/);
    expect(begin).not.toHaveBeenCalled();
    expect(mockStore.chats.size).toBe(1);                                 // no chat for a refused pick
    mockSettings.model = 'claude-opus-5-5';
    const r2 = await turn({ converse: model([reply([T('ok')])]) });
    expect(r2.events[0]).toMatchObject({ type: 'chat', id: 2, model: 'claude-opus-5-5' });
    const r3 = await turn({ chatId: 2, converse: model([reply([T('ok')])]) });   // the next turn on it: no model, keeps its own
    expect(r3.events[0]).toMatchObject({ type: 'chat', id: 2, model: 'claude-opus-5-5', created: false });
  });

  test('contextBlock: firm-local time, UTC, identity, elevation; a machine key is named as one', () => {
    const now = new Date('2026-07-04T16:05:00Z');
    const a = loop.contextBlock({ auth: { type: 'jwt', userId: 7, username: 'rena', roles: ['staff', 'intake'] }, headers: {}, now });
    expect(a.text).toBe('[context — refreshed each turn]\nNow: Saturday 2026-07-04 12:05 EDT (America/Detroit); UTC 2026-07-04T16:05:00Z\nActing as: rena (user_id 7); roles: staff, intake; superuser: no; elevation live: no\nPage: (none)');
    // The page's context → the Page line, bounded and sanitised; meta carries it.
    const p = loop.contextBlock({ auth: SU, headers: {}, now, context: { label: 'Case 123 — Jones', case_id: 'ABC', contact_id: 44, path: 'x', junk: 'dropped' } });
    expect(p.text.split('\n').pop()).toBe('Page: Case 123 — Jones; case ABC; contact 44');   // only the three known keys; `path` is not one
    expect(loop.pageLine(null)).toBe('Page: (none)');
    expect(loop.pageLine({ label: 'a\nb\tc' })).toBe('Page: a b c');
    expect(loop.sanitizeContext({ label: 'L', case_id: 7, nope: 1 })).toEqual({ label: 'L', case_id: '7' });
    expect(loop.sanitizeContext({ label: 'x'.repeat(500) }).label.length).toBe(loop.CONTEXT_MAX);
    expect(loop.sanitizeContext('str')).toBeNull();
    expect(loop.sanitizeContext({ junk: 1 })).toBeNull();
    expect(a.meta).toEqual({ now: '2026-07-04T16:05:00.000Z', zone: 'America/Detroit', user_id: 7, username: 'rena', roles: ['staff', 'intake'], superuser: false, elevated: false });
    const b = loop.contextBlock({ auth: SU, headers: { 'x-su-elevation': mintElevationToken(6) }, now });
    expect(b.text).toContain('superuser: yes; elevation live: yes');
    const c = loop.contextBlock({ auth: SU, headers: { 'x-su-elevation': mintElevationToken(7) }, now });
    expect(c.text).toContain('superuser: yes; elevation live: no');
    const k = loop.contextBlock({ auth: { type: 'api_key', key_label: 'pabbly', scopes: null }, headers: {}, now });
    expect(k.text).toContain('Acting as: machine key pabbly; roles: none; superuser: no; elevation live: no');
  });

  test('stripThinking: assistant rows lose thinking / redacted_thinking; an emptied row keeps one text block; user rows untouched', () => {
    const msgs = [
      { role: 'user', content: [T('q')] },
      { role: 'assistant', content: [TH('a'), { type: 'redacted_thinking', data: 'X' }, TU('t', 'whoami', {})] },
      { role: 'assistant', content: [TH('only')] },
    ];
    expect(loop.stripThinking(msgs)).toEqual([
      { role: 'user', content: [T('q')] },
      { role: 'assistant', content: [TU('t', 'whoami', {})] },
      { role: 'assistant', content: [T('[reasoning omitted]')] },
    ]);
  });
});
