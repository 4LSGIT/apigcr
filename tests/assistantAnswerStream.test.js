'use strict';
/**
 * tests/assistantAnswerStream.test.js — Ask Casey answer streaming.
 *
 * The answer call rides the SAME execute request through the shell's apiSend
 * (responseType 'response'): at the answer stage the route switches to NDJSON
 * (answer_retry → delta… → final). Pinned here, in three layers:
 *
 *   service  the streamed answer call is content-identical to the unstreamed
 *            one (only the onTextDelta callback is added, so aiService adds
 *            only stream:true — tests/aiService.stream.test.js pins that); the
 *            final payload is the unstreamed payload; the sealed answer-retry
 *            token answers ONCE, unstreamed, from the sealed evidence with no
 *            re-investigation, for the same user and chat only.
 *   route    real HTTP through compression(): the first words reach the client
 *            BEFORE the answer finishes; pre-answer failures stay ordinary JSON
 *            errors; the kill switch turns all of it off.
 *   pane     the page's own functions: off = execute exactly as before; a
 *            parsed answer that differs from the streamed text replaces it; a
 *            dropped stream retries once and the chat saves once.
 *
 * No network, no pool: aiService.call / reportService.execute are stubbed,
 * the db is a fake that answers only spend-cap and chat-ownership reads.
 */

jest.mock('../startup/dbReadonly', () => ({}));
jest.mock('../lib/auth.jwtOrApiKey', () => (req, res, next) => {
  req.auth = { type: 'jwt', userId: Number(req.headers['x-test-user'] || 7) };
  next();
});

const fs = require('fs');
const path = require('path');
const express = require('express');
const svc = require('../services/assistantService');
const aiService = require('../services/aiService');
const reportService = require('../services/reportService');
const assistantTicket = require('../lib/assistantTicket');
const continuation = require('../lib/assistantContinuation');
const firmConfig = require('../lib/firmConfig');

const SECRET = 'assistant-answer-stream-test-secret';
const OLD_SECRET = process.env.JWT_SECRET;
beforeEach(() => { process.env.JWT_SECRET = SECRET; });
afterEach(() => { jest.restoreAllMocks(); });
afterAll(() => {
  if (OLD_SECRET === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = OLD_SECRET;
});

const AUTH7 = { type: 'jwt', userId: 7 };
const sql = (text, id = 'q1') => ({ id, kind: 'sql.read', purpose: `Read ${id}`, sql: text });
const contactSql = (n) => `SELECT contact_id, contact_name FROM contacts WHERE contact_id = ${n} LIMIT 5`;

function fakeDb({ chats = { 41: 7 } } = {}) {
  return { query: jest.fn(async (q, params = []) => {
    if (/FROM app_settings/.test(q)) return [[]];
    if (/FROM ai_calls/.test(q)) return [[{ c: 0 }]];
    if (/FROM assistant_chats/.test(q)) {
      const [id, uid] = params;
      return [chats[id] === uid ? [{ id, title: 'chat', model_mode: 'better_quality' }] : []];
    }
    throw new Error(`Unexpected SQL: ${q}`);
  }) };
}
function planTicket(uid = 7, steps = [sql(contactSql(1))], question = 'Who is contact one?') {
  const plan = svc.validatePlan({ action: 'query', summary: 'First pass', steps });
  return assistantTicket.sign({ v: 1, uid, question, history: [], plan: { action: 'query', ...plan } });
}
function rows() {
  return jest.spyOn(reportService, 'execute').mockImplementation(async () => (
    { rows: [{ contact_id: 101, contact_name: 'Person 1' }], rowCount: 1, truncated: false }));
}

const ANSWER_JSON = { answer: 'Person 1 is contact one.\nShe "called" twice.', citations: [{ query_id: 'q1', row_number: 1 }], suggestions: ['What next?'] };
// aiService.call stub: the investigate stage finishes at once; the answer
// stage writes `text` in `pieces` through onTextDelta when one is passed.
function scriptAi({ answers = [ANSWER_JSON], pieces = 4, beforeEach: hook } = {}) {
  const queue = [...answers];
  return jest.spyOn(aiService, 'call').mockImplementation(async (_db, opts) => {
    if (opts.promptKey === 'assistant_investigate') {
      return { ok: true, json: { action: 'finish', reason: 'Enough' }, usage: { input_tokens: 10, output_tokens: 5 }, callId: 1 };
    }
    if (opts.promptKey !== 'assistant_answer') throw new Error(`unscripted ${opts.promptKey}`);
    const next = queue.shift();
    if (!next) throw new Error('unscripted answer call');
    if (next.fail) return { ok: false, error: 'api_error', detail: 'stream_error' };
    const attempts = next.attempts || [JSON.stringify(next)];
    if (opts.onTextDelta) {
      for (let a = 0; a < attempts.length; a++) {
        const text = attempts[a];
        const size = Math.ceil(text.length / pieces);
        for (let i = 0; i < text.length; i += size) {
          if (hook) await hook();
          opts.onTextDelta(text.slice(i, i + size), { attempt: a + 1 });
        }
      }
    }
    return { ok: true, json: JSON.parse(attempts[attempts.length - 1]), output: attempts[attempts.length - 1], usage: { input_tokens: 100, output_tokens: 50 }, callId: 9 };
  });
}
function recorder() {
  const events = [];
  return { events, stream: {
    begin: (token) => events.push({ type: 'answer_retry', token }),
    delta: (text) => events.push({ type: 'delta', text }),
    reset: () => events.push({ type: 'reset' }),
  } };
}
const answerOpts = (ai) => ai.mock.calls.filter((c) => c[1].promptKey === 'assistant_answer').map((c) => c[1]);
const deltaText = (events) => events.reduce((acc, e) => (e.type === 'reset' ? '' : e.type === 'delta' ? acc + e.text : acc), '');

// ─────────────────────────────────────────────────────────────── service ──

describe('service: the streamed answer is the unstreamed answer', () => {
  test('same answer-call content (only onTextDelta added), same payload, prose streamed after the retry token', async () => {
    // Date frozen (timers real) so the CURRENT TIME line is the same in both.
    jest.useFakeTimers({ now: new Date('2026-10-28T12:00:00.000Z'),
      doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'hrtime', 'performance'] });
    rows();
    let ai = scriptAi();
    const off = await svc.execute(fakeDb(), { signedTicket: planTicket(), chatId: 41, userId: 7, auth: AUTH7 });
    const [offOpts] = answerOpts(ai);
    jest.restoreAllMocks();
    rows();
    ai = scriptAi();
    const { events, stream } = recorder();
    const on = await svc.execute(fakeDb(), { signedTicket: planTicket(), chatId: 41, userId: 7, auth: AUTH7, stream });
    const [onOpts] = answerOpts(ai);

    expect(typeof onOpts.onTextDelta).toBe('function');
    expect(offOpts.onTextDelta).toBeUndefined();
    const { onTextDelta, ...onRest } = onOpts;
    expect(Object.keys(onRest)).toEqual(Object.keys(offOpts));
    expect(JSON.stringify(onRest)).toBe(JSON.stringify(offOpts));
    expect(on).toEqual(off);
    jest.useRealTimers();
    expect(events[0].type).toBe('answer_retry');
    expect(events.filter((e) => e.type === 'answer_retry')).toHaveLength(1);
    expect(deltaText(events)).toBe(ANSWER_JSON.answer);
  });

  test('no stream: the answer call carries no callback and nothing is sealed for a retry', async () => {
    rows();
    const ai = scriptAi();
    const seal = jest.spyOn(continuation, 'seal');
    await svc.execute(fakeDb(), { signedTicket: planTicket(), chatId: 41, userId: 7, auth: AUTH7 });
    expect('onTextDelta' in answerOpts(ai)[0]).toBe(false);
    expect(seal).not.toHaveBeenCalled();
  });

  test("the model's JSON retry resets the streamed text; the final answer is the retry's", async () => {
    rows();
    scriptAi({ answers: [{ attempts: ['{"answer":"garbled', JSON.stringify({ answer: 'Clean answer.' })] }] });
    const { events, stream } = recorder();
    const out = await svc.execute(fakeDb(), { signedTicket: planTicket(), chatId: 41, userId: 7, auth: AUTH7, stream });
    expect(events.map((e) => e.type)).toContain('reset');
    expect(deltaText(events)).toBe('Clean answer.');
    expect(out.answer).toBe('Clean answer.');
  });

  test('a state too large to seal is answered unstreamed (begin never called)', async () => {
    rows();
    const ai = scriptAi();
    jest.spyOn(continuation, 'seal').mockImplementation(() => { throw Object.assign(new Error('state is too large'), { status: 413 }); });
    const { events, stream } = recorder();
    const out = await svc.execute(fakeDb(), { signedTicket: planTicket(), chatId: 41, userId: 7, auth: AUTH7, stream });
    expect(events).toEqual([]);
    expect('onTextDelta' in answerOpts(ai)[0]).toBe(false);
    expect(out.answer).toBe(ANSWER_JSON.answer);
  });
});

describe('service: the answer-retry token', () => {
  // A streamed first attempt whose answer call fails after the token went out.
  async function brokenStream({ chatId = 41 } = {}) {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    rows();
    scriptAi({ answers: [{ fail: true }] });
    const { events, stream } = recorder();
    await expect(svc.execute(fakeDb(), { signedTicket: planTicket(), chatId, userId: 7, auth: AUTH7, stream }))
      .rejects.toMatchObject({ status: 502 });
    jest.restoreAllMocks();
    return events[0].token;
  }

  test('answers once, unstreamed, from the sealed evidence — no re-investigation, no reads', async () => {
    const token = await brokenStream();
    const reads = rows();
    const ai = scriptAi();
    const out = await svc.execute(fakeDb(), { answerRetry: token, chatId: 41, userId: 7, auth: AUTH7, stream: recorder().stream });
    expect(reads).not.toHaveBeenCalled();
    expect(ai.mock.calls.map((c) => c[1].promptKey)).toEqual(['assistant_answer']);
    expect('onTextDelta' in ai.mock.calls[0][1]).toBe(false);
    expect(ai.mock.calls[0][1].userInput).toMatch(/Person 1/);
    expect(out.answer).toBe(ANSWER_JSON.answer);
    expect(out.sources).toHaveLength(1);
  });

  test('is single-use: a replay is 410', async () => {
    const token = await brokenStream();
    scriptAi({ answers: [ANSWER_JSON, ANSWER_JSON] });
    await svc.execute(fakeDb(), { answerRetry: token, chatId: 41, userId: 7, auth: AUTH7 });
    await expect(svc.execute(fakeDb(), { answerRetry: token, chatId: 41, userId: 7, auth: AUTH7 }))
      .rejects.toMatchObject({ status: 410, message: 'This answer can no longer be retried. Ask Casey again.' });
  });

  test('another user or another chat is 403, naming nothing from the token — and does not burn it', async () => {
    const token = await brokenStream();
    const ai = scriptAi();
    const db = fakeDb({ chats: { 41: 7, 42: 7, 43: 8 } });
    const other = await svc.execute(db, { answerRetry: token, chatId: 43, userId: 8, auth: { type: 'jwt', userId: 8 } }).catch((e) => e);
    const chat = await svc.execute(db, { answerRetry: token, chatId: 42, userId: 7, auth: AUTH7 }).catch((e) => e);
    for (const e of [other, chat]) {
      expect(e.status).toBe(403);
      expect(e.message).toBe('This answer cannot be retried from this session.');
      expect(e.detail).toBeUndefined();
    }
    expect(ai).not.toHaveBeenCalled();
    const out = await svc.execute(db, { answerRetry: token, chatId: 41, userId: 7, auth: AUTH7 });
    expect(out.answer).toBe(ANSWER_JSON.answer);
  });

  test('expired is 410; a continuation is not an answer retry, and an answer retry is not a continuation', async () => {
    const token = await brokenStream();
    const expired = continuation.seal({ ...continuation.open(token), exp: undefined }, -1);
    await expect(svc.execute(fakeDb(), { answerRetry: expired, chatId: 41, userId: 7, auth: AUTH7 })).rejects.toMatchObject({ status: 410 });
    const cont = continuation.seal({ ...continuation.open(token), kind: 'assistant_continuation' });
    await expect(svc.execute(fakeDb(), { answerRetry: cont, chatId: 41, userId: 7, auth: AUTH7 })).rejects.toMatchObject({ status: 410 });
    await expect(svc.execute(fakeDb(), { continuation: token, chatId: 41, userId: 7, auth: AUTH7 }))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/can no longer be continued/) });
    await expect(svc.execute(fakeDb(), { answerRetry: token, signedTicket: planTicket(), chatId: 41, userId: 7, auth: AUTH7 }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('a budget-stopped investigation still offers Keep going from the retried answer', async () => {
    rows();
    jest.spyOn(aiService, 'call').mockImplementation(async (_db, opts) => {
      if (opts.promptKey === 'assistant_investigate') {
        const n = 2 + aiService.call.mock.calls.filter((c) => c[1].promptKey === 'assistant_investigate').length;
        return { ok: true, json: { action: 'query', summary: `Pass ${n}`, steps: [sql(contactSql(n))] }, usage: { input_tokens: 1, output_tokens: 1 } };
      }
      return { ok: false, error: 'api_error' };
    });
    const { events, stream } = recorder();
    await expect(svc.execute(fakeDb(), { signedTicket: planTicket(), chatId: 41, userId: 7, auth: AUTH7, stream })).rejects.toMatchObject({ status: 502 });
    jest.restoreAllMocks();
    scriptAi();
    const out = await svc.execute(fakeDb(), { answerRetry: events[0].token, chatId: 41, userId: 7, auth: AUTH7 });
    expect(out.investigation).toMatchObject({ stop_reason: 'round_budget', rounds: 3, continuable: true });
    expect(continuation.open(out.continuation)).toMatchObject({ kind: 'assistant_continuation', uid: 7, chat: 41 });
  });
});

// ───────────────────────────────────────────────────────────────── route ──

describe('route: real HTTP through compression()', () => {
  let server;
  let base;
  let flag;
  beforeAll(async () => {
    const app = express();
    app.use(require('compression')());
    app.use(express.json({ limit: '5mb' }));
    app.use((req, _res, next) => { req.db = fakeDb(); next(); });
    app.use(require('../routes/api.assistant'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    flag = undefined;
    const real = firmConfig.cfg;
    jest.spyOn(firmConfig, 'cfg').mockImplementation((k) => (k === 'casey_answer_streaming_enabled' ? flag : real(k)));
  });

  const post = (p, body, headers = {}) => fetch(`${base}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip, br', ...headers }, body: JSON.stringify(body),
  });
  async function lines(res, onLine = () => {}) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const out = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { const ev = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1); out.push(ev); onLine(ev); }
    }
    return out;
  }

  test('the first words arrive before the answer is finished, uncompressed, then the final body', async () => {
    rows();
    let sawDelta;
    const deltaSeen = new Promise((resolve) => { sawDelta = resolve; });
    let gate = 0;
    // The model's 3rd piece waits until the CLIENT has read a delta: a
    // buffered (e.g. compressed) response would never get there.
    scriptAi({ pieces: 6, beforeEach: async () => {
      if (++gate !== 3) return;
      let timer;
      try {
        await Promise.race([deltaSeen, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('no delta reached the client before the answer finished')), 3000); })]);
      } finally { clearTimeout(timer); }
    } });
    const res = await post('/api/assistant/execute', { ticket: planTicket(), chat_id: 41, stream: true, action_ledger_version: 1 });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/x-ndjson/);
    expect(res.headers.get('cache-control')).toMatch(/no-transform/);
    expect(res.headers.get('content-encoding')).toBeNull();
    const events = await lines(res, (ev) => { if (ev.type === 'delta') sawDelta(); });
    expect(events[0].type).toBe('answer_retry');
    expect(events[events.length - 1].type).toBe('final');
    expect(events[events.length - 1].body).toMatchObject({ status: 'success', outcome: 'answer', answer: ANSWER_JSON.answer });
    expect(deltaText(events)).toBe(ANSWER_JSON.answer);
  });

  test('the streamed final body equals the unstreamed JSON body', async () => {
    rows();
    scriptAi({ answers: [ANSWER_JSON, ANSWER_JSON] });
    const plain = await (await post('/api/assistant/execute', { ticket: planTicket(), chat_id: 41 })).json();
    const streamed = (await lines(await post('/api/assistant/execute', { ticket: planTicket(), chat_id: 41, stream: true }))).pop().body;
    expect(streamed).toEqual(plain);
  });

  test('a failure in the answer stage is an in-stream error event after the retry token', async () => {
    rows();
    scriptAi({ answers: [{ fail: true }] });
    const events = await lines(await post('/api/assistant/execute', { ticket: planTicket(), chat_id: 41, stream: true }));
    expect(events.map((e) => e.type)).toEqual(['answer_retry', 'error']);
    expect(events[1]).toEqual({ type: 'error', status: 502, message: 'The assistant request failed' });
  });

  test('a failure before the answer stage is the ordinary JSON error', async () => {
    const res = await post('/api/assistant/execute', { ticket: 'not-a-ticket', chat_id: 41, stream: true });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toMatchObject({ status: 'error' });
  });

  test("flag '0': the plan offers nothing and stream:true is answered as plain JSON; unset or '1' offers it", async () => {
    const plan = (obj) => jest.spyOn(svc, 'plan').mockResolvedValue(obj);
    plan({ outcome: 'plan', ticket: 't' });
    flag = '0';
    expect(await (await post('/api/assistant/plan', { question: 'q' })).json()).toEqual({ status: 'success', outcome: 'plan', ticket: 't' });
    for (const on of [undefined, '1']) {
      flag = on;
      expect(await (await post('/api/assistant/plan', { question: 'q' })).json()).toEqual({ status: 'success', outcome: 'plan', ticket: 't', answer_streaming: true });
    }
    flag = undefined;
    plan({ outcome: 'refused', reason: 'no' });
    expect(await (await post('/api/assistant/plan', { question: 'q' })).json()).toEqual({ status: 'success', outcome: 'refused', reason: 'no' });

    flag = '0';
    rows();
    const ai = scriptAi();
    const res = await post('/api/assistant/execute', { ticket: planTicket(), chat_id: 41, stream: true });
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect((await res.json()).answer).toBe(ANSWER_JSON.answer);
    expect('onTextDelta' in answerOpts(ai)[0]).toBe(false);
  });

  test('an answer_retry request is never streamed, even when it asks', async () => {
    rows();
    scriptAi({ answers: [{ fail: true }] });
    const [first] = await lines(await post('/api/assistant/execute', { ticket: planTicket(), chat_id: 41, stream: true }));
    jest.restoreAllMocks();
    const real = firmConfig.cfg;
    jest.spyOn(firmConfig, 'cfg').mockImplementation((k) => (k === 'casey_answer_streaming_enabled' ? undefined : real(k)));
    const ai = scriptAi();
    const realExecute = svc.execute;
    const exec = jest.spyOn(svc, 'execute').mockImplementation((...args) => realExecute(...args));
    const res = await post('/api/assistant/execute', { answer_retry: first.token, chat_id: 41, stream: true });
    // Both layers refuse: the route passes no stream, the service ignores one.
    expect('stream' in exec.mock.calls[0][1]).toBe(false);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect((await res.json()).answer).toBe(ANSWER_JSON.answer);
    expect('onTextDelta' in answerOpts(ai)[0]).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────── pane ──

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
function fnSrc(name) {
  const m = new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`).exec(html);
  if (!m) throw new Error(`function ${name} not found`);
  let parens = 0;
  let i = m.index + m[0].length - 1;
  for (; i < html.length; i++) {
    if (html[i] === '(') parens++;
    else if (html[i] === ')' && --parens === 0) break;
  }
  let depth = 0;
  for (let j = html.indexOf('{', i); j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}' && --depth === 0) return html.slice(m.index, j + 1);
  }
  throw new Error(`function ${name} unbalanced`);
}

// The page's own ask() → executeAutomatically() → executeAnswer() chain,
// with the shell (P.apiSend), the plan/history api() and the DOM stubbed.
function pane({ apiSend, api, streamingOffered = true }) {
  const names = ['ask', 'executeAutomatically', 'executeAnswer', 'readAnswerStream', 'streamingTurn', 'answerMessage', 'compactInvestigation', 'publicHistory'];
  const src = [
    'let history = []; let busy = false; let currentChatId = 41; let pendingAttachments = []; let answerStreaming = false;',
    ...names.map(fnSrc),
    'return { ask, executeAnswer, get history() { return history; }, setHistory(h) { history = h; }, setStreaming(v) { answerStreaming = v; } };',
  ].join('\n');
  const streamEl = { textContent: '' };
  const deps = {
    P: { apiSend },
    api: jest.fn(async (p, body) => (p === '/api/assistant/plan'
      ? { status: 'success', outcome: 'plan', ticket: 'T', ...(streamingOffered ? { answer_streaming: true } : {}) }
      : api(p, body))),
    input: { value: 'Who is contact one?' },
    modelMode: { value: 'better_quality' },
    chat: { querySelector: (sel) => (sel === '[data-streaming]' ? streamEl : null), scrollTop: 0, scrollHeight: 0 },
    render: jest.fn(), setBusy: jest.fn(), renderPendingAttachments: jest.fn(), refreshWorkspaceContext: jest.fn(),
    freezeWorkspaceContextForTurn: () => null,
    requestAttachments: async () => ({ temporary: [], documentIds: [] }),
    saveUserMessage: jest.fn(async () => {}),
    saveAssistantMessage: jest.fn(async () => {}),
  };
  const keys = Object.keys(deps);
  const page = new Function(...keys, src)(...keys.map((k) => deps[k])); // eslint-disable-line no-new-func
  return { page, deps, streamEl };
}
const FINAL = { status: 'success', outcome: 'answer', answer: 'Parsed answer.', entities: [], sources: [], suggestions: [] };
// A Response the way the shell's fetch hands it back; `cut` drops the
// connection after that many lines.
function ndjsonResponse(events, { cut = null } = {}) {
  const lines = events.map((e) => `${JSON.stringify(e)}\n`);
  let i = 0;
  return new Response(new ReadableStream({
    pull(c) {
      if (cut != null && i >= cut) { c.error(new TypeError('network error')); return; }
      if (i >= lines.length) { c.close(); return; }
      c.enqueue(new TextEncoder().encode(lines[i++]));
    },
  }), { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
}

describe('pane', () => {
  test('streaming not offered: execute goes through api() with exactly the historical body, never the raw transport', async () => {
    const apiSend = jest.fn();
    const { page, deps } = pane({ apiSend, streamingOffered: false, api: async () => FINAL });
    await page.ask();
    expect(apiSend).not.toHaveBeenCalled();
    const exec = deps.api.mock.calls.filter((c) => c[0] === '/api/assistant/execute');
    expect(exec).toHaveLength(1);
    expect(exec[0].length).toBe(2);
    expect(JSON.stringify(exec[0][1])).toBe(JSON.stringify({ ticket: 'T', temporary_attachments: [], action_ledger_version: 1, chat_id: 41 }));
    expect(page.history[page.history.length - 1].text).toBe('Parsed answer.');
  });

  test('streamed: the request is the historical body plus stream:true over responseType response; the parsed answer replaces the streamed text; saved once', async () => {
    const apiSend = jest.fn(async () => ndjsonResponse([
      { type: 'answer_retry', token: 'R' }, { type: 'delta', text: 'Streamed ' }, { type: 'delta', text: 'prose.' }, { type: 'final', body: FINAL },
    ]));
    const { page, deps, streamEl } = pane({ apiSend, api: async () => { throw new Error('no retry expected'); } });
    await page.ask();
    expect(apiSend).toHaveBeenCalledTimes(1);
    const [p, method, body, headers, opts] = apiSend.mock.calls[0];
    expect([p, method, headers, opts]).toEqual(['/api/assistant/execute', 'POST', {}, { responseType: 'response' }]);
    expect(JSON.stringify(body)).toBe(JSON.stringify({ ticket: 'T', temporary_attachments: [], action_ledger_version: 1, chat_id: 41, stream: true }));
    expect(streamEl.textContent).toBe('Streamed prose.');
    const last = page.history[page.history.length - 1];
    expect(last.text).toBe('Parsed answer.');
    expect(last.type).toBeUndefined();
    expect(page.history.some((m) => m.type === 'streaming' || m.type === 'thinking')).toBe(false);
    expect(deps.saveAssistantMessage).toHaveBeenCalledTimes(1);
    expect(deps.saveAssistantMessage.mock.calls[0][0].text).toBe('Parsed answer.');
  });

  test('a stream dropped mid-answer retries ONCE with the token, unstreamed; the chat saves once', async () => {
    // Only the first stream drops; a second streamed request (which must never
    // happen) would succeed, so a retry that streamed again fails the count
    // below instead of looping.
    const apiSend = jest.fn(async () => ndjsonResponse([{ type: 'answer_retry', token: 'R9' }, { type: 'final', body: FINAL }]));
    apiSend.mockImplementationOnce(async () => ndjsonResponse([
      { type: 'answer_retry', token: 'R1' }, { type: 'delta', text: 'Half an ans' }, { type: 'final', body: FINAL },
    ], { cut: 2 }));
    const retried = jest.fn(async () => ({ ...FINAL, answer: 'Retried answer.' }));
    const { page, deps } = pane({ apiSend, api: retried });
    await page.ask();
    expect(apiSend).toHaveBeenCalledTimes(1);
    expect(retried).toHaveBeenCalledTimes(1);
    expect(retried.mock.calls[0]).toEqual(['/api/assistant/execute', { answer_retry: 'R1', chat_id: 41, temporary_attachments: [], action_ledger_version: 1 }]);
    expect(deps.render.mock.calls.length).toBeGreaterThan(0);
    expect(page.history[page.history.length - 1].text).toBe('Retried answer.');
    expect(deps.saveAssistantMessage).toHaveBeenCalledTimes(1);
  });

  test('an in-stream error event retries once; a second failure is the ordinary error and saves nothing', async () => {
    const apiSend = jest.fn(async () => ndjsonResponse([{ type: 'answer_retry', token: 'R2' }, { type: 'error', status: 502, message: 'The assistant request failed' }]));
    const retried = jest.fn(async () => { throw new Error('The assistant request failed'); });
    const { page, deps } = pane({ apiSend, api: retried });
    await page.ask();
    expect(retried).toHaveBeenCalledTimes(1);
    const last = page.history[page.history.length - 1];
    expect(last).toMatchObject({ error: true, text: 'The assistant request failed' });
    expect(deps.saveAssistantMessage).not.toHaveBeenCalled();
  });

  test('a stream that broke before any retry token is the ordinary error, no retry', async () => {
    const apiSend = jest.fn(async () => ndjsonResponse([{ type: 'answer_retry', token: 'R3' }], { cut: 0 }));
    const retried = jest.fn();
    const { page } = pane({ apiSend, api: retried });
    await page.ask();
    expect(retried).not.toHaveBeenCalled();
    expect(page.history[page.history.length - 1]).toMatchObject({ error: true, text: 'The answer was interrupted' });
  });

  test('an unstreamed JSON reply to a stream request (state too large to seal) is used as-is', async () => {
    const apiSend = jest.fn(async () => new Response(JSON.stringify(FINAL), { headers: { 'content-type': 'application/json; charset=utf-8' } }));
    const { page, deps } = pane({ apiSend, api: jest.fn() });
    await page.ask();
    expect(page.history[page.history.length - 1].text).toBe('Parsed answer.');
    expect(deps.saveAssistantMessage).toHaveBeenCalledTimes(1);
  });

  test('a reset starts the streamed text over', async () => {
    const apiSend = jest.fn(async () => ndjsonResponse([
      { type: 'answer_retry', token: 'R' }, { type: 'delta', text: 'garbled' }, { type: 'reset' }, { type: 'delta', text: 'Clean' }, { type: 'final', body: FINAL },
    ]));
    const { page, streamEl } = pane({ apiSend, api: jest.fn() });
    await page.ask();
    expect(streamEl.textContent).toBe('Clean');
  });
});

describe('pane: Keep going streams too', () => {
  test('a continued answer streams; a drop retries once in the continuation\'s chat and saves once', async () => {
    const names = ['compactInvestigation', 'answerMessage', 'executeAnswer', 'readAnswerStream', 'streamingTurn', 'keepGoing'];
    const src = [
      'const CONTINUATION_TTL_MS = 15 * 60 * 1000; let history = []; let busy = false; let currentChatId = 41; let historyAvailable = true; let answerStreaming = true;',
      ...names.map(fnSrc),
      'return { keepGoing, get history() { return history; }, setHistory(h) { history = h; } };',
    ].join('\n');
    const apiSend = jest.fn(async () => ndjsonResponse([{ type: 'answer_retry', token: 'RK' }, { type: 'delta', text: 'Contin' }], { cut: 2 }));
    const api = jest.fn(async () => ({ ...FINAL, answer: 'Continued answer.' }));
    const deps = {
      P: { apiSend }, api, render: jest.fn(), setBusy: jest.fn(),
      chat: { querySelector: () => ({ textContent: '' }), scrollTop: 0, scrollHeight: 0 },
      requestAttachments: async () => ({ temporary: [], documentIds: [] }),
      saveUserMessage: jest.fn(async () => {}), saveAssistantMessage: jest.fn(async () => {}),
    };
    const keys = Object.keys(deps);
    const page = new Function(...keys, src)(...keys.map((k) => deps[k])); // eslint-disable-line no-new-func
    const msg = { role: 'assistant', text: 'Stopped early.', continuation: 'c1.tok', continuation_received_at: Date.now(), continuation_chat: 41 };
    page.setHistory([msg]);
    await page.keepGoing(msg);
    expect(JSON.stringify(apiSend.mock.calls[0][2])).toBe(JSON.stringify({ continuation: 'c1.tok', chat_id: 41, temporary_attachments: [], action_ledger_version: 1, stream: true }));
    expect(api.mock.calls).toEqual([['/api/assistant/execute', { answer_retry: 'RK', chat_id: 41, temporary_attachments: [], action_ledger_version: 1 }]]);
    expect(page.history[page.history.length - 1].text).toBe('Continued answer.');
    expect(deps.saveAssistantMessage).toHaveBeenCalledTimes(1);
  });
});
