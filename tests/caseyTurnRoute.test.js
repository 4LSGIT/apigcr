// Casey v2 S2 — the loop's routes (routes/api.casey.js) over a real socket,
// end to end: the real router → services/casey/loop → aiService.converse
// against a FAKE Messages API (global.fetch answers the SSE a tool-use turn
// streams) → the real tools → an in-memory casey store (services/casey/chats
// mocked with its API; the real store is tests/caseyChats.mysql.test.js).
//   • the SU chain (superuserOnlyFor('casey'): JWT + su + X-SU-Elevation);
//   • dark while casey_v2_enabled is '0' (403 before anything);
//   • plain-JSON refusals before the stream: 400 text / chat_id, 404 another
//     user's chat, 409 a running chat, 429 the spend cap;
//   • the NDJSON contract: headers, one JSON object per line, the event order
//     chat → tool_call → tool_result → delta → final, the final body;
//   • the chat routes: list (mine only), transcript, delete (404 for others').
'use strict';

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'casey-turn-route-secret';

const flags = { v2: null };
jest.mock('../lib/firmConfig', () => {
  const actual = jest.requireActual('../lib/firmConfig');
  return { ...actual, cfg: jest.fn((k) => (k === 'casey_v2_enabled' ? flags.v2 : k === 'casey_v2_model' ? 'claude-opus-5-5' : k === 'casey_v2_effort' ? null : actual.cfg(k))) };
});
const mockStore = { chats: new Map(), messages: new Map(), nextChat: 1, nextMsg: 1 };
jest.mock('../services/casey/chats', () => {
  const actual = jest.requireActual('../services/casey/chats');
  const clone = (v) => JSON.parse(JSON.stringify(v));
  return {
    ...actual,
    async createChat(db, { userId, text, model, effort, promptVersion }) {
      const id = mockStore.nextChat++;
      mockStore.chats.set(id, { id, user_id: userId, title: actual.titleFrom(text), model, effort, prompt_version: promptVersion, thinking_floor_seq: 0, running_since: null, created_at: 'c', updated_at: 'u' });
      mockStore.messages.set(id, []);
      return id;
    },
    async getChat(db, id, userId) { const c = mockStore.chats.get(Number(id)); return c && c.user_id === userId ? { ...c } : null; },
    async listChats(db, userId) { return [...mockStore.chats.values()].filter((c) => c.user_id === userId).map((c) => ({ ...c, message_count: (mockStore.messages.get(c.id) || []).length })); },
    async deleteChat(db, id, userId) { const c = mockStore.chats.get(Number(id)); if (!c || c.user_id !== userId) return false; mockStore.chats.delete(Number(id)); mockStore.messages.delete(Number(id)); return true; },
    async claimTurn(db, id, userId) { const c = mockStore.chats.get(Number(id)); if (!c || c.user_id !== userId || c.running_since) return false; c.running_since = new Date(); return true; },
    async releaseTurn(db, id, { promptVersion, thinkingFloorSeq } = {}) { const c = mockStore.chats.get(Number(id)); if (c) { c.running_since = null; if (promptVersion) { c.prompt_version = promptVersion; c.thinking_floor_seq = Math.max(c.thinking_floor_seq, Number(thinkingFloorSeq) || 0); } } },
    async loadMessages(db, chatId) { return clone(mockStore.messages.get(Number(chatId)) || []); },
    async appendMessage(db, chatId, role, content, meta) {
      const list = mockStore.messages.get(Number(chatId));
      const row = { id: mockStore.nextMsg++, seq: list.length + 1, role, content: clone(content), meta: meta == null ? null : clone(meta), created_at: 'c' };
      list.push(row);
      return { id: row.id, seq: row.seq };
    },
    async deleteMessages(db, chatId, ids) { const list = mockStore.messages.get(Number(chatId)); mockStore.messages.set(Number(chatId), list.filter((m) => !ids.includes(m.id))); return 1; },
  };
});

const { mintElevationToken } = require('../lib/auth.superuser');
const router = require('../routes/api.casey');

// ── the db stub: credentials, ai_calls, the spend reads ───────────────────
const CRED_ROW = { id: 12, name: 'Claude', type: 'api_key', config: JSON.stringify({ header: 'x-api-key', key: 'test-key' }), allowed_urls: null, access_token: null, oauth_status: null, verbose: 0 };
const spendState = { cap: null, spent: 0 };
const aiRows = [];
const dbStub = {
  query: async (sql, params) => {
    if (/FROM credentials/i.test(sql)) return [[CRED_ROW]];
    if (/INSERT INTO ai_calls/i.test(sql)) { aiRows.push(params); return [{ insertId: aiRows.length }]; }
    if (/FROM app_settings/i.test(sql)) return [spendState.cap == null ? [] : [{ key: 'assistant_ai_monthly_cap_cents', value: spendState.cap }]];
    if (/SUM\(cost_cents\)/i.test(sql)) return [[{ c: spendState.spent }]];
    return [[], []];
  },
  execute: async () => [[], []],
};

// ── the fake Messages API ─────────────────────────────────────────────────
const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
function sse(blocks, stop) {
  const out = [ev('message_start', { message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 1 } } })];
  blocks.forEach((b, i) => {
    if (b.type === 'text') { out.push(ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } })); out.push(ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: b.text } })); }
    else if (b.type === 'thinking') { out.push(ev('content_block_start', { index: i, content_block: { type: 'thinking', thinking: '' } })); out.push(ev('content_block_delta', { index: i, delta: { type: 'thinking_delta', thinking: b.thinking } })); out.push(ev('content_block_delta', { index: i, delta: { type: 'signature_delta', signature: 'SIG' } })); }
    else { out.push(ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })); out.push(ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })); }
    out.push(ev('content_block_stop', { index: i }));
  });
  out.push(ev('message_delta', { delta: { stop_reason: stop }, usage: { output_tokens: 20 } }), ev('message_stop', {}));
  return out.join('');
}
function streamResponse(raw) {
  const bytes = Buffer.from(raw, 'utf8'); let at = 0;
  return { ok: true, status: 200, json: async () => { throw new Error('stream'); }, body: new ReadableStream({ pull(c) { if (at >= bytes.length) { c.close(); return; } c.enqueue(new Uint8Array(bytes.subarray(at, at + 64))); at += 64; } }) };
}
const realFetch = global.fetch;
let apiScript = [];
let apiBodies = [];
beforeAll(() => {
  global.fetch = jest.fn(async (url, init) => {
    if (String(url).startsWith('https://api.anthropic.com/')) { apiBodies.push(JSON.parse(init.body)); const next = apiScript.shift(); if (!next) throw new Error('api script exhausted'); return next; }
    return realFetch(url, init);   // api_get's loopback call
  });
});
afterAll(() => { global.fetch = realFetch; });

// ── the app ───────────────────────────────────────────────────────────────
let server, port;
beforeAll(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use((req, _res, next) => { req.db = dbStub; next(); });
  app.use(router);
  const api = require('../routes/availabilityAdmin'); // GET /api/availability-blocks: one autoGet staff route for api_get
  app.use(api);
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  port = server.address().port;
  process.env.PORT = String(port);    // ctxFromRequest reads it: api_get loops back to THIS app
});
afterAll(async () => { await new Promise((r) => server.close(r)); delete process.env.PORT; });
beforeEach(() => { flags.v2 = null; apiScript = []; apiBodies = []; aiRows.length = 0; spendState.cap = null; spendState.spent = 0; mockStore.chats.clear(); mockStore.messages.clear(); mockStore.nextChat = 1; mockStore.nextMsg = 1; });

const su = jwt.sign({ sub: 6, username: 'IT', user_auth: 'authorized', roles: ['su'], aud: 'staff' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const staff = jwt.sign({ sub: 7, username: 'rena', user_auth: 'authorized', roles: ['admin'], aud: 'staff' }, process.env.JWT_SECRET, { expiresIn: '5m' });

function call(method, p, { token = su, elevate = true, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (elevate && token) headers['x-su-elevation'] = mintElevationToken(jwt.decode(token).sub);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => {
        const ct = res.headers['content-type'] || '';
        if (ct.startsWith('application/x-ndjson')) return resolve({ status: res.statusCode, headers: res.headers, lines: d.split('\n').filter(Boolean).map((l) => JSON.parse(l)), raw: d });
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, headers: res.headers, body: d }); }
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const turn = (body, o) => call('POST', '/api/casey/turn', { body, ...o });

test('the SU chain and the flag, before anything runs', async () => {
  expect((await turn({ text: 'hi' }, { token: null })).status).toBe(401);
  expect((await turn({ text: 'hi' }, { token: staff })).status).toBe(403);
  expect((await turn({ text: 'hi' }, { elevate: false })).status).toBe(401);
  flags.v2 = '0';
  const dark = await turn({ text: 'hi' });
  expect(dark).toMatchObject({ status: 403, body: { status: 'error', message: 'Casey v2 is off (casey_v2_enabled = 0)' } });
  for (const p of ['/api/casey/chats', '/api/casey/chats/1']) {
    expect((await call('GET', p, { token: staff })).status).toBe(403);
    expect((await call('GET', p, { token: null })).status).toBe(401);
  }
  expect((await call('DELETE', '/api/casey/chats/1', { token: staff })).status).toBe(403);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(mockStore.chats.size).toBe(0);
});

test('plain JSON refusals before the stream: 400, 404, 409, 429', async () => {
  expect(await turn({})).toMatchObject({ status: 400, body: { status: 'error', message: 'text is required' } });
  expect(await turn({ text: 7 })).toMatchObject({ status: 400 });
  expect(await turn({ text: '   ' })).toMatchObject({ status: 400, body: { message: 'text is required' } });
  expect(await turn({ text: 'x'.repeat(4001) })).toMatchObject({ status: 400, body: { message: 'text is longer than 4000 characters' } });
  expect(await turn({ text: 'hi', chat_id: 'abc' })).toMatchObject({ status: 400, body: { message: 'chat_id must be a positive integer' } });
  expect(await turn({ text: 'hi', chat_id: 0 })).toMatchObject({ status: 400 });
  expect(await turn({ text: 'hi', chat_id: 55 })).toMatchObject({ status: 404, body: { message: 'No such chat' } });
  mockStore.chats.set(9, { id: 9, user_id: 7, title: 'theirs', model: 'm', effort: 'e', prompt_version: 'v', running_since: null }); mockStore.messages.set(9, []);
  expect(await turn({ text: 'hi', chat_id: 9 })).toMatchObject({ status: 404 });
  mockStore.chats.set(10, { id: 10, user_id: 6, title: 'mine', model: 'm', effort: 'e', prompt_version: 'v', running_since: new Date() }); mockStore.messages.set(10, []);
  expect(await turn({ text: 'hi', chat_id: 10 })).toMatchObject({ status: 409, body: { message: 'A turn is already running in this chat' } });
  spendState.cap = '100'; spendState.spent = 100;
  const capped = await turn({ text: 'hi' });
  expect(capped.status).toBe(429);
  expect(capped.body.message).toMatch(/monthly AI spending limit/);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(mockStore.chats.size).toBe(2);   // no chat created for a refused turn
});

test('a whole turn as NDJSON: headers, event order, tools run as the SU over loopback, the final; then the chat routes', async () => {
  apiScript = [
    streamResponse(sse([{ type: 'thinking', thinking: 'look' }, { type: 'tool_use', id: 'tu1', name: 'whoami', input: {} }, { type: 'tool_use', id: 'tu2', name: 'api_get', input: { path: '/api/availability-blocks' } }], 'tool_use')),
    streamResponse(sse([{ type: 'text', text: 'You are IT; no blocks.' }], 'end_turn')),
  ];
  const r = await turn({ text: 'Who am I and are there availability blocks?' });
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
  expect(r.headers['cache-control']).toBe('no-store, no-transform');
  expect(r.headers['x-content-type-options']).toBe('nosniff');
  expect(r.raw.endsWith('\n')).toBe(true);
  expect(r.lines.map((l) => l.type)).toEqual(['chat', 'thinking', 'tool_call', 'tool_call', 'tool_result', 'tool_result', 'delta', 'final']);
  expect(r.lines[0]).toMatchObject({ type: 'chat', id: 1, title: 'Who am I and are there availability blocks?', model: 'claude-opus-5-5', effort: 'medium', created: true });
  expect(r.lines[1]).toEqual({ type: 'thinking', text: 'look' });
  expect(r.lines.filter((l) => l.type === 'tool_result').map((l) => [l.name, l.ok])).toEqual([['whoami', true], ['api_get', true]]);
  expect(r.lines[6]).toEqual({ type: 'delta', text: 'You are IT; no blocks.' });
  const final = r.lines[7].body;
  expect(final).toMatchObject({ chat_id: 1, text: 'You are IT; no blocks.', calls: 2, limited: false, model: 'claude-opus-5-5', effort: 'medium' });
  expect(final.tool_calls.map((t) => t.name)).toEqual(['whoami', 'api_get']);
  expect(final.cost_cents).toBeGreaterThan(0);
  // What the model was sent: two requests, the second carrying the tool results of the SU's own identity and the loopback GET.
  expect(apiBodies).toHaveLength(2);
  expect(apiBodies[0]).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'medium' }, thinking: { type: 'adaptive' }, stream: true });
  expect(apiBodies[0].tools.map((t) => t.name)).toEqual(['whoami', 'sql_read', 'api_get', 'lookup_routes', 'read_source', 'search_docs']);
  const results = apiBodies[1].messages[2].content;
  expect(JSON.parse(results[0].content).data).toMatchObject({ user_id: 6, username: 'IT', is_superuser: true, elevated: true });
  expect(JSON.parse(results[1].content).data).toMatchObject({ route: '/api/availability-blocks', status: 200 });
  // The ai_calls rows: two, labelled, lengths only.
  expect(aiRows).toHaveLength(2);
  expect(aiRows.map((row) => [row[0], row[5], row[6]])).toEqual([['casey_v2_turn', 'assistant_v2:u6:c1', 'ok'], ['casey_v2_turn', 'assistant_v2:u6:c1', 'ok']]);
  expect(aiRows[0][12]).toMatch(/^\[prompt_cache: read=100 write=0 uncached=10\]\n\[omitted: \d+ chars\]$/);

  // The chat routes.
  const list = await call('GET', '/api/casey/chats');
  expect(list.status).toBe(200);
  expect(list.body.chats.map((c) => [c.id, c.message_count])).toEqual([[1, 4]]);
  expect((await call('GET', '/api/casey/chats', { token: jwt.sign({ sub: 8, username: 'other', user_auth: 'authorized', roles: ['su'], aud: 'staff' }, process.env.JWT_SECRET, { expiresIn: '5m' }) })).body.chats).toEqual([]);
  const t = await call('GET', '/api/casey/chats/1');
  expect(t.status).toBe(200);
  expect(t.body.chat).toMatchObject({ id: 1, running_since: null });
  expect(t.body.messages.map((m) => [m.seq, m.role])).toEqual([[1, 'user'], [2, 'assistant'], [3, 'user'], [4, 'assistant']]);
  expect(t.body.messages[1].content[1]).toEqual({ type: 'tool_use', id: 'tu1', name: 'whoami', input: {} });
  expect((await call('GET', '/api/casey/chats/2')).status).toBe(404);
  expect((await call('GET', '/api/casey/chats/x')).status).toBe(404);
  expect((await call('GET', '/api/casey/chats/1', { token: jwt.sign({ sub: 8, username: 'other', user_auth: 'authorized', roles: ['su'], aud: 'staff' }, process.env.JWT_SECRET, { expiresIn: '5m' }) })).status).toBe(404);   // another SU's transcript is not mine
  // A second turn on the chat continues it.
  apiScript = [streamResponse(sse([{ type: 'text', text: 'Still IT.' }], 'end_turn'))];
  const r2 = await turn({ text: 'Sure?', chat_id: 1 });
  expect(r2.lines[0]).toMatchObject({ type: 'chat', id: 1, created: false });
  expect(apiBodies[2].messages).toHaveLength(5);
  expect(r2.lines[r2.lines.length - 1].body).toMatchObject({ chat_id: 1, seq: 6, text: 'Still IT.' });
  // Delete: mine only; messages go with it.
  expect((await call('DELETE', '/api/casey/chats/1', { token: jwt.sign({ sub: 8, username: 'other', user_auth: 'authorized', roles: ['su'], aud: 'staff' }, process.env.JWT_SECRET, { expiresIn: '5m' }) })).status).toBe(404);
  expect(await call('DELETE', '/api/casey/chats/1')).toMatchObject({ status: 200, body: { status: 'success', deleted: true } });
  expect((await call('GET', '/api/casey/chats/1')).status).toBe(404);
  expect(mockStore.messages.has(1)).toBe(false);
});

test('a model failure after the stream began is an error line, not a broken response; the opening row is rolled back', async () => {
  apiScript = [{ ok: false, status: 529, json: async () => ({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), body: null }];
  const r = await turn({ text: 'hi' });
  expect(r.status).toBe(200);
  expect(r.lines.map((l) => l.type)).toEqual(['chat', 'error']);
  expect(r.lines[1]).toMatchObject({ type: 'error', status: 502, message: 'The model call failed (api_error)', detail: 'http_529' });
  expect(mockStore.chats.size).toBe(0);
});
