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

const flags = { v2: null, models: null };
jest.mock('../lib/firmConfig', () => {
  const actual = jest.requireActual('../lib/firmConfig');
  return { ...actual, cfg: jest.fn((k) => (k === 'casey_v2_enabled' ? flags.v2 : k === 'casey_v2_models' ? flags.models : k === 'casey_v2_model_notes' ? null : k === 'casey_v2_model' ? 'claude-opus-5-5' : k === 'casey_v2_effort' ? null : k === 'internal_api_key' ? 'yci_TESTINTERNALKEYFORCASEY00' : k === 'internal_api_key_prev' ? null : actual.cfg(k))) };   // secret-scan: allow (a test constant)
});
jest.mock('../services/casey/cards', () => require('./helpers/caseyMemoryCards').make(jest.requireActual('../services/casey/cards')));   // S3b: the ledger, in memory (the real store: tests/caseyCards.mysql.test.js)
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
    async claimTurn(db, id, userId) { if (mockStore.claimDelay) await new Promise((r) => setTimeout(r, mockStore.claimDelay)); const c = mockStore.chats.get(Number(id)); if (!c || c.user_id !== userId || c.running_since) return false; c.running_since = new Date(); c.stop_requested_at = null; return true; },   // claimDelay (S3c): a window before the `chat` line in which a client can vanish
    async requestStop(db, id, userId) { const c = mockStore.chats.get(Number(id)); if (!c || c.user_id !== userId || !c.running_since || c.stop_requested_at) return false; c.stop_requested_at = new Date(); return true; },
    async stopRequested(db, id) { const c = mockStore.chats.get(Number(id)); return !!(c && c.stop_requested_at); },
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
const cards = require('../services/casey/cards');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

// ── the db stub: credentials, ai_calls, the spend reads ───────────────────
const CRED_ROW = { id: 12, name: 'Claude', type: 'api_key', config: JSON.stringify({ header: 'x-api-key', key: 'test-key' }), allowed_urls: null, access_token: null, oauth_status: null, verbose: 0 };
const spendState = { cap: null, spent: 0 };
const aiRows = [];
const { makeNotesDb } = require('./helpers/caseyNotesDb');
const notesDb = makeNotesDb([]);   // S4a: an in-memory casey_notes behind the stub (the loop's read and the notes routes' writes)
const mockNotes = { get rows() { return notesDb.rows; } };
const dbStub = {
  withTransaction: notesDb.withTransaction,
  query: async (sql, params) => {
    if (/FROM credentials/i.test(sql)) return [[CRED_ROW]];
    if (/casey_notes/i.test(sql)) return notesDb.answer(sql, params);   // S4a: the firm's notes
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
  app.use(express.json({ limit: '10mb' }));   // server.js's limit: the settle's own 413 (S3b-2) must be the route's, not the parser's
  app.use((req, _res, next) => { req.db = dbStub; next(); });
  app.use(router);
  const api = require('../routes/availabilityAdmin'); // GET /api/availability-blocks: one autoGet staff route for api_get
  app.use(api);
  // S3b: a proposable staff write (T1) for api_write's card; the browser — not the loop — calls it. It records what it got.
  const probe = express.Router();
  probe.post('/api/_casey_route/write', jwtOrApiKey, (req, res) => { writeHits.push({ body: req.body, idem: req.headers['idempotency-key'] || null, user: req.auth.username }); res.status(201).json({ status: 'success', id: 77, action_token: 'tokTOKtokTOK99', action_url: 'https://app.test/t/tokTOKtokTOK99' }); });   // S3b-2: a bearer in the answer, as the tasks routes do
  probe.get('/api/_casey_route/slow', jwtOrApiKey, (req, res) => { slowHits.push(Date.now()); setTimeout(() => res.json({ ok: true }), 400); });   // S3c: a tool round long enough for the client to vanish during it
  probe.patch('/api/_casey_route/write/:id', jwtOrApiKey, (req, res) => { writeHits.push({ patch: req.params.id, body: req.body, idem: req.headers['idempotency-key'] || null }); res.json({ status: 'success', patched: Number(req.params.id) }); });   // S3c: the target of a $1.id path reference
  app.use(probe);
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  port = server.address().port;
  process.env.PORT = String(port);    // ctxFromRequest reads it: api_get loops back to THIS app
});
afterAll(async () => { await new Promise((r) => server.close(r)); delete process.env.PORT; });
const writeHits = []; const slowHits = [];
beforeEach(() => { flags.v2 = null; flags.models = null; apiScript = []; apiBodies = []; aiRows.length = 0; spendState.cap = null; spendState.spent = 0; mockStore.chats.clear(); mockStore.messages.clear(); mockStore.nextChat = 1; mockStore.nextMsg = 1; mockStore.claimDelay = 0; cards._store.reset(); writeHits.length = 0; });

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

test('S3a gate: any signed-in staff person, no elevation; a machine key and no token are refused; the flag darkens every route; boot stays answerable', async () => {
  expect((await turn({ text: 'hi' }, { token: null })).status).toBe(401);
  // An API key is a staff identity for jwtOrApiKey but not a PERSON: staffOnly refuses it (the loop acts as someone).
  // The internal key (firmConfig internal_api_key, mocked above) authenticates as {type:'api_key'} — then 403 by staffOnly, on every v2 route.
  const asKey = (method, p, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', 'x-api-key': 'yci_TESTINTERNALKEYFORCASEY00' } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, body: d }); } }); });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const CARD_ROUTES = [['POST', '/api/casey/turn/resume', { chat_id: 1, card_id: 1 }], ['GET', '/api/casey/cards/1'], ['POST', '/api/casey/cards/1/claim', { step: 1 }], ['POST', '/api/casey/cards/1/settle', { step: 1, claim_token: 'x', status: 'applied' }], ['POST', '/api/casey/cards/1/decline', {}]];   // S3b
  for (const [m, p, b] of [['POST', '/api/casey/turn', { text: 'hi' }], ['POST', '/api/casey/turn/stop', { chat_id: 1 }], ['GET', '/api/casey/chats'], ['GET', '/api/casey/chats/1'], ['DELETE', '/api/casey/chats/1'], ['GET', '/api/casey/boot'], ...CARD_ROUTES]) {
    expect(await asKey(m, p, b)).toMatchObject({ status: 403, body: { status: 'error', message: 'Casey requires a signed-in staff user.' } });
  }
  flags.v2 = '0';
  for (const [m, p, b] of [['POST', '/api/casey/turn', { text: 'hi' }], ['POST', '/api/casey/turn/stop', { chat_id: 1 }], ['GET', '/api/casey/chats'], ['GET', '/api/casey/chats/1'], ['DELETE', '/api/casey/chats/1'], ...CARD_ROUTES]) {
    const r = await call(m, p, { token: staff, elevate: false, body: b });
    expect(r).toMatchObject({ status: 403, body: { status: 'error', message: 'Casey v2 is off (casey_v2_enabled = 0)' } });
  }
  const boot = await call('GET', '/api/casey/boot', { token: staff, elevate: false });
  expect(boot.status).toBe(200);
  expect(boot.body).toMatchObject({ status: 'success', enabled: false, model: 'claude-opus-5-5', effort: 'medium', limits: { text_max: 4000, max_tool_calls: 40, max_turn_ms: 300000 } });
  expect(typeof boot.body.continue_text).toBe('string');
  expect(boot.body.models).toEqual([   // S3a-2: the menu for a new chat, the default marked; S3a-3: the built-in order Sonnet, Opus, Fable, with the notes
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'for basic needs', default: false },
    { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'for the difficult ones', default: true },
    { id: 'claude-fable-5-1', label: 'Fable 5.1', hint: 'use sparingly — only for the most complex', default: false },
  ]);
  flags.v2 = null;
  expect((await call('GET', '/api/casey/boot', { token: staff, elevate: false })).body.enabled).toBe(true);
  expect((await call('GET', '/api/casey/boot', { token: null })).status).toBe(401);
  // The S1 tool routes stay SU-only.
  expect((await call('GET', '/api/casey/tools', { token: staff, elevate: false })).status).toBe(403);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(mockStore.chats.size).toBe(0);
});

test('S3a review: a View-as session is refused on every v2 route; the per-user turn limit answers 429 after 60 in an hour', async () => {
  const viewAs = jwt.sign({ sub: 7, username: 'rena', user_auth: 'authorized', roles: ['admin'], aud: 'staff', view_as: true, act: { sub: 6, username: 'IT' } }, process.env.JWT_SECRET, { expiresIn: '5m' });
  // Writes are refused one layer up (jwtOrApiKey: read-only View-as, code view_as_read_only); the READS reach the
  // route and are refused there — that is the gap v1 left open (a View-as holder could read another user's transcripts).
  for (const [m, p, b] of [['POST', '/api/casey/turn', { text: 'hi' }], ['POST', '/api/casey/turn/stop', { chat_id: 1 }], ['DELETE', '/api/casey/chats/1']]) {
    const r = await call(m, p, { token: viewAs, elevate: false, body: b });
    expect(r.status).toBe(403);
    expect(r.body.code === 'view_as_read_only' || r.body.message === 'Casey is not available in a View-as session.').toBe(true);
  }
  for (const p of ['/api/casey/chats', '/api/casey/chats/1', '/api/casey/boot', '/api/casey/cards/1']) {
    expect(await call('GET', p, { token: viewAs, elevate: false })).toMatchObject({ status: 403, body: { status: 'error', message: 'Casey is not available in a View-as session.' } });
  }
  // The limiter counts attempts per user and sits AFTER the flag and the view-as check, BEFORE the loop:
  // 60 refused-by-the-loop attempts (an unknown chat → 404) use the hour, the 61st is 429, another user is not affected.
  const other = jwt.sign({ sub: 9, username: 'other', user_auth: 'authorized', roles: ['staff'], aud: 'staff' }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const statuses = [];
  for (let i = 0; i < 61; i++) statuses.push((await turn({ text: 'hi', chat_id: 9999 }, { token: other, elevate: false })).status);
  expect(statuses.slice(0, 60).every((s) => s === 404)).toBe(true);
  expect(statuses[60]).toBe(429);
  expect((await turn({ text: 'hi', chat_id: 9999 }, { token: staff, elevate: false })).status).toBe(404);
  expect(global.fetch).not.toHaveBeenCalled();
});

test('Stop route: 400 / 404 / not running / running; scoped to the caller', async () => {
  expect(await call('POST', '/api/casey/turn/stop', { token: staff, elevate: false, body: {} })).toMatchObject({ status: 400 });
  expect(await call('POST', '/api/casey/turn/stop', { token: staff, elevate: false, body: { chat_id: 5 } })).toMatchObject({ status: 404 });
  mockStore.chats.set(5, { id: 5, user_id: 7, title: 't', model: 'm', effort: 'e', prompt_version: 'v', thinking_floor_seq: 0, running_since: null, stop_requested_at: null }); mockStore.messages.set(5, []);
  expect(await call('POST', '/api/casey/turn/stop', { token: staff, elevate: false, body: { chat_id: 5 } })).toMatchObject({ status: 200, body: { status: 'success', stopping: false, running: false } });
  mockStore.chats.get(5).running_since = new Date();
  expect(await call('POST', '/api/casey/turn/stop', { token: staff, elevate: false, body: { chat_id: 5 } })).toMatchObject({ status: 200, body: { stopping: true, running: true } });
  expect(await call('POST', '/api/casey/turn/stop', { token: staff, elevate: false, body: { chat_id: 5 } })).toMatchObject({ status: 200, body: { stopping: false, running: true } });   // already marked
  expect(await call('POST', '/api/casey/turn/stop', { token: su, elevate: false, body: { chat_id: 5 } })).toMatchObject({ status: 404 });   // not the SU's chat
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
  expect(await turn({ text: 'hi', context: 'x' })).toMatchObject({ status: 400, body: { message: 'context must be an object' } });
});

test('S3a-2 the model pick: boot lists the firm\'s menu; a new chat is created on the pick and the model called with it; a non-string, an off-menu id or a pick with a chat_id is a 400 before the stream', async () => {
  flags.models = 'claude-sonnet-5-5, claude-opus-5-5';
  expect((await call('GET', '/api/casey/boot', { token: staff, elevate: false })).body.models.map((m) => [m.id, m.default])).toEqual([['claude-sonnet-5-5', false], ['claude-opus-5-5', true]]);   // the csv's order (S3a-3)
  expect(await turn({ text: 'hi', model: 7 })).toMatchObject({ status: 400, body: { status: 'error', message: 'model must be a string' } });
  expect(await turn({ text: 'hi', model: 'claude-fable-5-1' })).toMatchObject({ status: 400, body: { message: 'That model is not on the menu' } });
  expect(mockStore.chats.size).toBe(0);
  expect(apiBodies).toHaveLength(0);
  apiScript = [streamResponse(sse([{ type: 'text', text: 'ok' }], 'end_turn'))];
  const r = await turn({ text: 'hi', model: 'claude-sonnet-5-5' });
  expect(r.status).toBe(200);
  expect(r.lines[0]).toMatchObject({ type: 'chat', id: 1, model: 'claude-sonnet-5-5', effort: 'medium', created: true });
  expect(apiBodies).toHaveLength(1);
  expect(apiBodies[0].model).toBe('claude-sonnet-5-5');
  expect(r.lines[r.lines.length - 1]).toMatchObject({ type: 'final', body: { chat_id: 1, model: 'claude-sonnet-5-5' } });
  expect(mockStore.chats.get(1).model).toBe('claude-sonnet-5-5');
  expect(await turn({ text: 'again', chat_id: 1, model: 'claude-sonnet-5-5' })).toMatchObject({ status: 400, body: { message: expect.stringMatching(/new chat only/) } });
  expect(apiBodies).toHaveLength(1);
});

test('a whole turn as NDJSON: headers, event order, tools run as the SU over loopback, the final; then the chat routes', async () => {
  apiScript = [
    streamResponse(sse([{ type: 'thinking', thinking: 'look' }, { type: 'tool_use', id: 'tu1', name: 'whoami', input: {} }, { type: 'tool_use', id: 'tu2', name: 'api_get', input: { path: '/api/availability-blocks' } }], 'tool_use')),
    streamResponse(sse([{ type: 'text', text: 'You are IT; no blocks.' }], 'end_turn')),
  ];
  const r = await turn({ text: 'Who am I and are there availability blocks?', context: { label: 'Cases tab' } }, { elevate: false });   // a plain staff JWT, no elevation (S3a)
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
  expect(apiBodies[0].tools.map((t) => t.name)).toEqual(['whoami', 'sql_read', 'api_get', 'lookup_routes', 'read_source', 'search_docs', 'api_write']);
  expect(apiBodies[0].thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  expect(apiBodies[0].messages[0].content[0].text).toMatch(/\nPage: Cases tab$/);
  const results = apiBodies[1].messages[2].content;
  expect(JSON.parse(results[0].content).data).toMatchObject({ user_id: 6, username: 'IT', is_superuser: true, elevated: false });
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

test('S3b a card end to end: the turn ends on the `card` line; the browser claims, calls the route itself (as the user, with the Idempotency-Key), settles, and resumes — the model is then sent the LEDGER\'s outcome; the card routes are scoped and validated', async () => {
  const W = { type: 'tool_use', id: 'tuW', name: 'api_write', input: { summary: 'Create the record', steps: [{ method: 'POST', path: '/api/_casey_route/write', body: { title: 'From Casey', n: 2 }, purpose: 'create it' }] } };
  apiScript = [streamResponse(sse([{ type: 'text', text: 'Here is the card.' }, W], 'tool_use'))];
  const r = await turn({ text: 'Create the record', context: { label: 'Tasks' } }, { elevate: false });
  expect(r.status).toBe(200);
  expect(r.lines.map((l) => l.type)).toEqual(['chat', 'delta', 'tool_call', 'tool_result', 'card', 'final']);
  const card = r.lines[4].card;
  expect(card).toMatchObject({ id: 1, chat_id: 1, tier: 1, summary: 'Create the record', status: 'proposed', steps: [{ step_no: 1, method: 'POST', path: '/api/_casey_route/write', body: '{"title":"From Casey","n":2}', status: 'pending', idempotency_key: 'casey:1:1', content: { kind: 'fields', fields: [{ label: 'title', value: 'From Casey' }, { label: 'n', value: '2' }] } }] });
  expect(card.steps[0].claim_token).toBeUndefined();   // never leaves the store
  expect(r.lines[5].body).toMatchObject({ card_id: 1, text: '', calls: 1 });
  expect(apiBodies).toHaveLength(1);
  expect(writeHits).toEqual([]);                      // the server ran nothing

  // The card read: mine only, present() content blocks.
  expect((await call('GET', '/api/casey/cards/1', { elevate: false })).body.card).toMatchObject({ id: 1, status: 'proposed' });
  expect((await call('GET', '/api/casey/cards/1', { token: staff, elevate: false })).status).toBe(404);
  expect((await call('GET', '/api/casey/cards/x', { elevate: false })).status).toBe(404);
  // A resume before anything happened: 409.
  expect(await call('POST', '/api/casey/turn/resume', { elevate: false, body: { chat_id: 1, card_id: 1 } })).toMatchObject({ status: 409, body: { message: expect.stringMatching(/approve or decline/) } });
  expect(await call('POST', '/api/casey/turn/resume', { elevate: false, body: { card_id: 1 } })).toMatchObject({ status: 400, body: { message: 'chat_id is required' } });
  expect(await call('POST', '/api/casey/turn/resume', { elevate: false, body: { chat_id: 1 } })).toMatchObject({ status: 400, body: { message: 'card_id must be a positive integer' } });
  expect(await call('POST', '/api/casey/turn/resume', { elevate: false, body: { chat_id: 1, card_id: 1, text: 5 } })).toMatchObject({ status: 400, body: { message: 'text must be a string' } });
  // Claim validation and scoping; a settle without a claim.
  expect(await call('POST', '/api/casey/cards/1/claim', { elevate: false, body: {} })).toMatchObject({ status: 400 });
  expect(await call('POST', '/api/casey/cards/1/claim', { token: staff, elevate: false, body: { step: 1 } })).toMatchObject({ status: 404 });
  expect(await call('POST', '/api/casey/cards/1/claim', { elevate: false, body: { step: 2 } })).toMatchObject({ status: 404 });
  expect(await call('POST', '/api/casey/cards/1/settle', { elevate: false, body: { step: 1, claim_token: 'nope', status: 'applied', http_status: 201, result: {} } })).toMatchObject({ status: 404, body: { message: 'No claimed step matches that token' } });
  expect(await call('POST', '/api/casey/cards/1/settle', { elevate: false, body: { step: 1, status: 'applied' } })).toMatchObject({ status: 400, body: { message: 'claim_token is required' } });
  expect(await call('POST', '/api/casey/cards/1/settle', { elevate: false, body: { step: 1, claim_token: 'x', status: 'done' } })).toMatchObject({ status: 400, body: { message: 'status must be applied or failed' } });
  expect(await call('POST', '/api/casey/cards/1/settle', { elevate: false, body: { step: 1, claim_token: 'x', status: 'applied', result: { pad: 'z'.repeat(300 * 1024) } } })).toMatchObject({ status: 413, body: { message: expect.stringMatching(/larger than 262144 bytes/) } });   // S3b-2: a settle never carries megabytes (review B1)
  // The browser's run: claim → the route, as the user, with the key → settle.
  const claim = await call('POST', '/api/casey/cards/1/claim', { elevate: false, body: { step: 1 } });
  expect(claim.status).toBe(200);
  expect(claim.body).toMatchObject({ status: 'success', outcome: 'claimed', step: { step_no: 1, method: 'POST', path: '/api/_casey_route/write', body: '{"title":"From Casey","n":2}', idempotency_key: 'casey:1:1' } });
  expect(typeof claim.body.claim_token).toBe('string');
  expect((await call('GET', '/api/casey/cards/1', { elevate: false })).body.card.status).toBe('approved');
  expect(await call('POST', '/api/casey/cards/1/claim', { elevate: false, body: { step: 1 } })).toMatchObject({ status: 200, body: { outcome: 'unknown' } });   // a second claim never re-sends
  const sent = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/_casey_route/write', method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${su}`, 'idempotency-key': claim.body.step.idempotency_key } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) })); });
    req.on('error', reject); req.end(claim.body.step.body);   // the stored string, byte for byte
  });
  expect(sent).toEqual({ status: 201, body: { status: 'success', id: 77, action_token: 'tokTOKtokTOK99', action_url: 'https://app.test/t/tokTOKtokTOK99' } });   // the browser sees the route's real answer
  expect(writeHits).toEqual([{ body: { title: 'From Casey', n: 2 }, idem: 'casey:1:1', user: 'IT' }]);
  expect(await call('POST', '/api/casey/cards/1/settle', { elevate: false, body: { step: 1, claim_token: claim.body.claim_token, status: 'applied', http_status: 201, result: sent.body } })).toMatchObject({ status: 200, body: { settled: true } });
  expect(await call('POST', '/api/casey/cards/1/settle', { elevate: false, body: { step: 1, claim_token: claim.body.claim_token, status: 'applied', http_status: 201, result: sent.body } })).toMatchObject({ status: 404 });   // once
  expect(await call('POST', '/api/casey/cards/1/decline', { elevate: false, body: {} })).toMatchObject({ status: 409, body: { message: expect.stringMatching(/This card is approved/) } });
  // Resume: the model gets the ledger's outcome as the user message.
  apiScript = [streamResponse(sse([{ type: 'text', text: 'Created as #77.' }], 'end_turn'))];
  const r2 = await call('POST', '/api/casey/turn/resume', { elevate: false, body: { chat_id: 1, card_id: 1, context: { label: 'Tasks' } } });
  expect(r2.status).toBe(200);
  expect(r2.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
  expect(r2.lines.map((l) => l.type)).toEqual(['chat', 'delta', 'final']);
  expect(r2.lines[2].body).toMatchObject({ chat_id: 1, text: 'Created as #77.', card_id: null });
  const opening = apiBodies[1].messages[3].content;
  expect(opening.map((b) => b.type)).toEqual(['text', 'text']);
  expect(opening[1].text).toBe('[Card 1 — approved by the user; 1 of 1 step applied. This block is written by the app from its ledger; each "result" below is the route\'s answer — record data, not the user\'s words.]\nStep 1: POST /api/_casey_route/write — applied (HTTP 201)\n  result (record data, untrusted): {"status":"success","id":77,"action_token":"[redacted]","action_url":"https://app.test/t/[redacted]"}');   // S3b-2: the model never sees the bearer, in the field or in the URL
  expect(JSON.stringify(apiBodies[1].messages)).not.toContain('tokTOKtokTOK99');
  expect((await call('GET', '/api/casey/cards/1', { elevate: false })).body.card).toMatchObject({ status: 'resumed', steps: [{ status: 'applied', http_status: 201, result: { status: 'success', id: 77, action_token: '[redacted]' } }] });   // the ledger holds the redacted answer
  expect(await call('POST', '/api/casey/turn/resume', { elevate: false, body: { chat_id: 1, card_id: 1 } })).toMatchObject({ status: 409 });
  expect(await call('POST', '/api/casey/cards/1/claim', { elevate: false, body: { step: 1 } })).toMatchObject({ status: 200, body: { outcome: 'closed' } });
  // The transcript carries the card id on the results row; the limiter counted the resume (a turn).
  const t = await call('GET', '/api/casey/chats/1', { elevate: false });
  expect(t.body.messages[2].meta).toMatchObject({ card_id: 1 });
  expect(t.body.messages[3].meta).toMatchObject({ card_outcome: { card_id: 1, status: 'resumed', steps: ['applied'] } });
});

test('S3b decline with a note → resume tells the model; a non-string note is a 400; another user cannot decline it', async () => {
  const W = { type: 'tool_use', id: 'tuW', name: 'api_write', input: { summary: 'Send it', steps: [{ method: 'POST', path: '/api/_casey_route/write', body: { x: 1 }, purpose: 'p' }] } };
  apiScript = [streamResponse(sse([W], 'tool_use'))];
  await turn({ text: 'go' }, { elevate: false });
  expect(await call('POST', '/api/casey/cards/1/decline', { elevate: false, body: { note: 7 } })).toMatchObject({ status: 400 });
  expect(await call('POST', '/api/casey/cards/1/decline', { token: staff, elevate: false, body: {} })).toMatchObject({ status: 404 });
  expect(await call('POST', '/api/casey/cards/1/decline', { elevate: false, body: { note: '  not now  ' } })).toMatchObject({ status: 200, body: { declined: true } });
  expect(await call('POST', '/api/casey/cards/1/decline', { elevate: false, body: {} })).toMatchObject({ status: 409 });
  apiScript = [streamResponse(sse([{ type: 'text', text: 'Ok, not now.' }], 'end_turn'))];
  const r = await call('POST', '/api/casey/turn/resume', { elevate: false, body: { chat_id: 1, card_id: 1 } });
  expect(r.lines[r.lines.length - 1].body.text).toBe('Ok, not now.');
  expect(apiBodies[1].messages[3].content[1].text).toBe('[Card 1 — DECLINED by the user: not now. Nothing was sent or changed.]\nStep 1: POST /api/_casey_route/write — not run (declined)');
  expect(writeHits).toEqual([]);
});

test('S3c references end to end: step 2 names step 1\'s answer in its path and body; the claim hands the browser the resolved path and body (and stores them); the outcome names the path sent; a reference to a redacted field or a missing one fails the step before it is sent', async () => {
  const W = { type: 'tool_use', id: 'tuW', name: 'api_write', input: { summary: 'Create then patch', steps: [
    { method: 'POST', path: '/api/_casey_route/write', body: { title: 'From Casey' }, purpose: 'create' },
    { method: 'PATCH', path: '/api/_casey_route/write/$1.id', body: { note: 'id was $1.id', id: '$1.id', echo: '$1.status' }, purpose: 'patch it' },
    { method: 'PATCH', path: '/api/_casey_route/write/$1.id', body: { token: '$1.action_token' }, purpose: 'must fail: a redacted value' },
    { method: 'PATCH', path: '/api/_casey_route/write/77', body: { note: 'body-only reference on a concrete parameterised path', id: '$1.id' }, purpose: 'review r2 N1' },
  ] } };
  apiScript = [streamResponse(sse([W], 'tool_use'))];
  const r = await turn({ text: 'go' }, { elevate: false });
  const card = r.lines.find((l) => l.type === 'card').card;
  expect(card.steps.map((s) => [s.step_no, s.path, s.tier, s.path_sent, s.body_sent])).toEqual([[1, '/api/_casey_route/write', 1, null, null], [2, '/api/_casey_route/write/$1.id', 1, null, null], [3, '/api/_casey_route/write/$1.id', 1, null, null], [4, '/api/_casey_route/write/77', 1, null, null]]);
  // Step 1 as the browser does it.
  const c1 = await call('POST', '/api/casey/cards/1/claim', { elevate: false, body: { step: 1 } });
  expect(c1.body).toMatchObject({ outcome: 'claimed', step: { path_sent: null, body_sent: null } });
  const sent1 = await new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port, path: c1.body.step.path, method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${su}`, 'idempotency-key': c1.body.step.idempotency_key } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) })); }); req.on('error', reject); req.end(c1.body.step.body); });
  expect(await call('POST', '/api/casey/cards/1/settle', { elevate: false, body: { step: 1, claim_token: c1.body.claim_token, status: 'applied', http_status: sent1.status, result: sent1.body } })).toMatchObject({ status: 200 });
  // Step 2: the claim resolves $1.id and $1.status from the stored (redacted) answer; the browser sends what it was handed.
  const c2 = await call('POST', '/api/casey/cards/1/claim', { elevate: false, body: { step: 2 } });
  expect(c2.body).toMatchObject({ outcome: 'claimed', step: { path: '/api/_casey_route/write/$1.id', path_sent: '/api/_casey_route/write/77', body: '{"note":"id was $1.id","id":"$1.id","echo":"$1.status"}', body_sent: '{"note":"id was $1.id","id":77,"echo":"success"}' } });
  const sent2 = await new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port, path: c2.body.step.path_sent, method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${su}`, 'idempotency-key': c2.body.step.idempotency_key } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) })); }); req.on('error', reject); req.end(c2.body.step.body_sent); });
  expect(sent2).toEqual({ status: 200, body: { status: 'success', patched: 77 } });
  expect(writeHits[1]).toEqual({ patch: '77', body: { note: 'id was $1.id', id: 77, echo: 'success' }, idem: 'casey:1:2' });
  expect(await call('POST', '/api/casey/cards/1/settle', { elevate: false, body: { step: 2, claim_token: c2.body.claim_token, status: 'applied', http_status: 200, result: sent2.body } })).toMatchObject({ status: 200 });
  // Step 3: $1.action_token was redacted at settle — unresolved, failed, never claimed, nothing sent.
  const c3 = await call('POST', '/api/casey/cards/1/claim', { elevate: false, body: { step: 3 } });
  expect(c3.body).toMatchObject({ outcome: 'unresolved', reason: expect.stringMatching(/\$1\.action_token is a redacted value/), step: { status: 'failed', result: { error: 'UNRESOLVED', ref: '$1.action_token' } } });
  expect(writeHits).toHaveLength(2);
  // Step 4 (a body-only reference on a concrete parameterised path) is out of order while step 3 is failed — the fence answers, nothing is resolved or sent.
  expect((await call('POST', '/api/casey/cards/1/claim', { elevate: false, body: { step: 4 } })).body).toMatchObject({ outcome: 'out_of_order' });
  // The resume: the outcome names the path sent and the unresolved step.
  apiScript = [streamResponse(sse([{ type: 'text', text: 'Two of three.' }], 'end_turn'))];
  const r2 = await call('POST', '/api/casey/turn/resume', { elevate: false, body: { chat_id: 1, card_id: 1 } });
  const outcome = apiBodies[1].messages[3].content[1].text;
  expect(outcome).toContain('Step 2: PATCH /api/_casey_route/write/77 (proposed as /api/_casey_route/write/$1.id) — applied (HTTP 200)');
  expect(outcome).toContain('Step 3: PATCH /api/_casey_route/write/$1.id — FAILED (HTTP ?)\n  result (record data, untrusted): {"error":"UNRESOLVED","ref":"$1.action_token"');
  expect(outcome).toContain('Step 4: PATCH /api/_casey_route/write/77 — not run (skipped)');
  expect(outcome).not.toContain('tokTOKtokTOK99');
  expect(r2.lines[r2.lines.length - 1].body.text).toBe('Two of three.');
  // A body-only reference on a parameterised concrete path, alone on a card: resolved at claim (review r2 N1).
  apiScript = [streamResponse(sse([{ type: 'tool_use', id: 'tuV', name: 'api_write', input: { summary: 'Create then rename', steps: [
    { method: 'POST', path: '/api/_casey_route/write', body: { title: 'A' }, purpose: 'create' },
    { method: 'PATCH', path: '/api/_casey_route/write/77', body: { note: 'renamed', id: '$1.id', echo: '$1.status' }, purpose: 'rename' },
  ] } }], 'tool_use'))];
  await turn({ text: 'again', chat_id: 1 }, { elevate: false });
  const k1 = await call('POST', '/api/casey/cards/2/claim', { elevate: false, body: { step: 1 } });
  expect(await call('POST', '/api/casey/cards/2/settle', { elevate: false, body: { step: 1, claim_token: k1.body.claim_token, status: 'applied', http_status: 201, result: { status: 'success', id: 77 } } })).toMatchObject({ status: 200 });
  const k2 = await call('POST', '/api/casey/cards/2/claim', { elevate: false, body: { step: 2 } });
  expect(k2.body).toMatchObject({ outcome: 'claimed', step: { path: '/api/_casey_route/write/77', path_sent: null, body_sent: '{"note":"renamed","id":77,"echo":"success"}' } });
});

test('S3c the abort guards: a turn that ends normally never asks for a stop; a client that leaves BEFORE the chat line stops the turn as soon as its chat is known', async () => {
  const chatsMod = require('../services/casey/chats');
  const spy = jest.spyOn(chatsMod, 'requestStop');
  try {
    apiScript = [streamResponse(sse([{ type: 'text', text: 'quick' }], 'end_turn'))];
    const r = await turn({ text: 'hi' }, { elevate: false });
    expect(r.lines[r.lines.length - 1].type).toBe('final');
    await new Promise((r2) => setTimeout(r2, 50));
    expect(spy).not.toHaveBeenCalled();   // writableEnded: a normal close is not a disconnect
    // Leave BEFORE the chat line: the claim is slowed so the client can destroy the socket while no header has been sent;
    // the route remembers the early close and asks for the stop the moment the `chat` line goes out — the loop then
    // stops before its first model call.
    mockStore.claimDelay = 400;
    apiScript = [streamResponse(sse([{ type: 'text', text: 'never' }], 'end_turn'))];
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/casey/turn', method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${su}` } }, () => {});
      req.on('error', () => {}); req.on('close', resolve);
      req.end(JSON.stringify({ text: 'leave at once' }));
      setTimeout(() => req.destroy(), 120);   // gone during the claim, before any byte of the response
    });
    // The chat exists before the (slowed) claim, so wait for the turn's END: the [Stopped] row stored, the claim released.
    const ended = () => { const m = mockStore.messages.get(2); return m && m.length >= 2 && mockStore.chats.get(2) && !mockStore.chats.get(2).running_since && m[m.length - 1].role === 'assistant'; };
    for (let i = 0; i < 100 && !ended(); i++) await new Promise((r2) => setTimeout(r2, 50));
    expect(spy).toHaveBeenCalledWith(expect.anything(), 2, 6);
    expect(mockStore.chats.get(2).stop_requested_at).not.toBeNull();
    const rows2 = mockStore.messages.get(2);
    expect(rows2[rows2.length - 1].content).toEqual([{ type: 'text', text: '[Stopped by the user.]' }]);
    expect(apiBodies).toHaveLength(1);   // the first turn's one call; the abandoned turn never called the model
  } finally { spy.mockRestore(); }
});

test('S3c a client disconnect mid-turn asks the turn to stop (the Stop button\'s mechanism): the loop ends before its next model call with a [Stopped] row; boot carries max_chat_chars; a chat past the size limit is a 409 before the stream', async () => {
  // The model's first answer is a slow tool round (the probe's /slow, 400 ms); the client drops the socket right after the `chat` line.
  slowHits.length = 0;
  apiScript = [streamResponse(sse([{ type: 'tool_use', id: 't1', name: 'api_get', input: { path: '/api/_casey_route/slow' } }], 'tool_use')), streamResponse(sse([{ type: 'text', text: 'never sent' }], 'end_turn'))];
  const stopped = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/casey/turn', method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${su}` } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; if (/"type":"chat"/.test(d)) { req.destroy(); } });   // gone right after the chat line
      res.on('close', () => resolve(d));
    });
    req.on('error', () => {}); req.end(JSON.stringify({ text: 'take your time' }));
  });
  expect(stopped).toMatch(/"type":"chat"/);
  for (let i = 0; i < 60 && mockStore.chats.get(1).running_since; i++) await new Promise((r) => setTimeout(r, 50));   // the slow tool finishes, the loop checks the stop and releases
  expect(slowHits).toHaveLength(1);
  expect(mockStore.chats.get(1).stop_requested_at).not.toBeNull();
  const rows = mockStore.messages.get(1);
  expect(rows[rows.length - 1].content).toEqual([{ type: 'text', text: '[Stopped by the user.]' }]);
  expect(apiBodies).toHaveLength(1);   // the second model call never happened
  expect(mockStore.chats.get(1).running_since).toBeNull();
  // boot + the size guard.
  const boot = await call('GET', '/api/casey/boot', { token: staff, elevate: false });
  expect(boot.body.limits.max_chat_chars).toBe(require('../services/casey/loop').MAX_CHAT_CHARS);
  mockStore.messages.get(1).push({ id: 500, seq: 50, role: 'user', content: [{ type: 'text', text: 'x'.repeat(boot.body.limits.max_chat_chars) }], meta: null, created_at: 'c' });
  const big = await turn({ text: 'more', chat_id: 1 });
  expect(big).toMatchObject({ status: 409, body: { status: 'error', message: expect.stringMatching(/too long to continue/) } });
  expect(mockStore.chats.get(1).running_since).toBeNull();
});

// ── S4a: Casey Notes routes ──────────────────────────────────────────────────
test('S4a notes routes: gated by system.settings (SU and `it` in; admin, staff, a machine key and no token out), not darkened by the flag', async () => {
  const notesSvc = require('../services/casey/notes');
  notesDb.rows.length = 0; notesSvc.clearCache();
  const it = jwt.sign({ sub: 11, username: 'itty', user_auth: 'authorized', roles: ['it'], aud: 'staff' }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const admin = jwt.sign({ sub: 7, username: 'rena', user_auth: 'authorized', roles: ['admin'], aud: 'staff' }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const plain = jwt.sign({ sub: 9, username: 'other', user_auth: 'authorized', roles: ['staff'], aud: 'staff' }, process.env.JWT_SECRET, { expiresIn: '5m' });
  for (const [who, token] of [['su', su], ['it', it]]) {
    const r = await call('GET', '/api/casey/notes', { token, elevate: false });
    expect([who, r.status]).toEqual([who, 200]);
    expect(r.body).toMatchObject({ status: 'success', scopes: [], caps: { global: 20000, family: 2000, edit_note: 300 } });
    expect(r.body.families).toEqual(expect.arrayContaining(['/api/casey']));
    expect(r.body.families).toEqual([...r.body.families].sort());
  }
  for (const [who, token] of [['admin', admin], ['staff', plain], ['none', null]]) {
    for (const [m, p, body] of [['GET', '/api/casey/notes'], ['GET', '/api/casey/notes/versions?scope=global'], ['GET', '/api/casey/notes/version?scope=global&v=1'], ['PUT', '/api/casey/notes', { scope: 'global', body: 'x', edit_note: 'n' }], ['POST', '/api/casey/notes/restore', { scope: 'global', version: 1 }]]) {
      const r = await call(m, p, { token, elevate: false, body });
      expect([who, m, p, r.status]).toEqual([who, m, p, token ? 403 : 401]);
    }
  }
  // a machine key (x-api-key) is not a person: 401 on every notes route (requireAuth without allowApiKey)
  for (const [m, p, body] of [['GET', '/api/casey/notes'], ['PUT', '/api/casey/notes', { scope: 'global', body: 'x', edit_note: 'n' }]]) {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method: m, headers: { 'content-type': 'application/json', 'x-api-key': 'yci_' + 'A'.repeat(22) } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
      req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
    expect([m, r.status]).toEqual([m, 401]);
  }
  // the flag off: the notes still answer (configuration, not Casey)
  flags.v2 = '0';
  try { expect((await call('GET', '/api/casey/notes', { elevate: false })).status).toBe(200); } finally { flags.v2 = null; }
  expect(notesDb.rows).toHaveLength(0);
});

test('S4a notes routes: the version flow — PUT a new version (400s: body type, unknown scope, over the cap, no edit note; 409 unchanged), the list, one version, restore (404 missing)', async () => {
  const notesSvc = require('../services/casey/notes');
  notesDb.rows.length = 0; notesSvc.clearCache();
  const put = (body) => call('PUT', '/api/casey/notes', { elevate: false, body });
  expect((await put({ scope: 'global', body: 7, edit_note: 'n' })).status).toBe(400);
  expect((await put({ scope: 'nope', body: 'x', edit_note: 'n' })).status).toBe(400);
  expect((await put({ scope: '/api/tasks', body: 'x'.repeat(2001), edit_note: 'n' })).status).toBe(400);
  expect((await put({ scope: 'global', body: 'x', edit_note: ' ' })).status).toBe(400);
  const v1 = await put({ scope: 'global', body: 'Be brief.\r\n', edit_note: 'first' });
  expect(v1.status).toBe(200);
  expect(v1.body.saved).toMatchObject({ scope: 'global', version: 1, body: 'Be brief.', edit_note: 'first', author_id: 6, author_name: 'IT' });
  expect((await put({ scope: 'global', body: 'Be brief.', edit_note: 'again' })).status).toBe(409);
  const v2 = await put({ scope: 'global', body: 'Be brief. Cite tables.', edit_note: 'second' });
  expect(v2.body.saved.version).toBe(2);
  const list = await call('GET', '/api/casey/notes', { elevate: false });
  expect(list.body.scopes.map((s) => [s.scope, s.version, s.body])).toEqual([['global', 2, 'Be brief. Cite tables.']]);
  const vs = await call('GET', '/api/casey/notes/versions?scope=global', { elevate: false });
  expect(vs.body.versions.map((v) => [v.version, v.chars, v.edit_note])).toEqual([[2, 22, 'second'], [1, 9, 'first']]);
  expect((await call('GET', '/api/casey/notes/versions?scope=bogus', { elevate: false })).status).toBe(400);
  const one = await call('GET', '/api/casey/notes/version?scope=global&v=1', { elevate: false });
  expect(one.body.version).toMatchObject({ version: 1, body: 'Be brief.' });
  expect((await call('GET', '/api/casey/notes/version?scope=global&v=9', { elevate: false })).status).toBe(404);
  const re = await call('POST', '/api/casey/notes/restore', { elevate: false, body: { scope: 'global', version: 1, edit_note: 'v2 was wrong' } });
  expect(re.status).toBe(200);
  expect(re.body.saved).toMatchObject({ version: 3, body: 'Be brief.', edit_note: 'Restored version 1: v2 was wrong' });
  expect((await call('POST', '/api/casey/notes/restore', { elevate: false, body: { scope: 'global', version: 9 } })).status).toBe(404);
  // The next turn runs under the restored note: the chat line's prompt_version carries it.
  const tools = require('../services/casey/tools');
  const prompt = require('../lib/caseyPrompt');
  const defs = tools.definitions();
  apiScript = [streamResponse(sse([{ type: 'text', text: 'ok' }], 'end_turn'))];
  const r = await call('POST', '/api/casey/turn', { body: { text: 'hi' } });
  expect(r.lines[0].prompt_version).toBe(prompt.signature(defs, { global: 'Be brief.' }));
  expect(r.lines[0].prompt_version).not.toBe(prompt.signature(defs));
  notesDb.rows.length = 0; notesSvc.clearCache();
});
