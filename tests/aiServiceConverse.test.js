/**
 * tests/aiServiceConverse.test.js — aiService.converse() (Casey v2 S2,
 * ref/CASEY_V2_DESIGN.md §4.6, §8.8) and the per-model cache-read pricing.
 *
 *   1. the request body: key order, one cached system block, cache_control on
 *      a COPY of the last tool (the caller's array untouched), adaptive
 *      thinking, output_config.effort, stream last, never tool_choice;
 *   2. the streamed blocks come back VERBATIM — thinking with its signature,
 *      tool_use with its input parsed from input_json_delta pieces, text — in
 *      index order, with stop_reason and usage; block events in arrival order;
 *   3. one ai_calls row: prompt_key / version / consumer_ref, prompt tokens =
 *      the whole prompt, cost at the model's OWN cache-read rate (Opus 5.5
 *      0.05x), the cache line + the last user text as the excerpt (or lengths
 *      only with logContent:false), the text + a tool line as the response;
 *   4. the error taxonomy: bad_request (no call), no_auth (no call), an HTTP
 *      error with its status, an in-stream error, a cut stream, the timeout;
 *   5. computeCostCents: the existing models' numbers unchanged; Opus 5.5 and
 *      Fable 5.1 priced at their rates; an unknown model null.
 *
 * NO network, NO real DB: global.fetch is a jest mock, db a stub.
 */
'use strict';

const aiService = require('../services/aiService');

const CRED_ROW = {
  id: 12, name: 'Claude', type: 'api_key',
  config: JSON.stringify({ header: 'x-api-key', key: 'test-key' }),
  allowed_urls: null, access_token: null, oauth_status: null, verbose: 0,
};
function makeDb({ cred = true } = {}) {
  let insertId = 0;
  const rows = [];
  const query = jest.fn(async (sql, params) => {
    if (/FROM credentials/i.test(sql)) return [cred ? [CRED_ROW] : []];
    if (/INSERT INTO ai_calls/i.test(sql)) { rows.push(params); return [{ insertId: ++insertId }]; }
    throw new Error(`unexpected sql in stub: ${sql}`);
  });
  return { query, rows };
}
// ai_calls INSERT positional params (services/aiService.js logCall).
const COL = { prompt_key: 0, prompt_version: 1, model: 2, mode: 3, output_type: 4, consumer_ref: 5, status: 6, error: 7, input_tokens: 8, output_tokens: 9, cost_cents: 10, latency_ms: 11, request_excerpt: 12, response: 13 };

const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
/** A tool-use turn as Opus 5.5 streams it: thinking (+signature), a tool_use in pieces, text. */
function toolTurn({ usage = { input_tokens: 40, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 120 }, stop = 'tool_use', pieces = ['{"path":"/api/a', 'vailability-blocks","query":{"a":"1"}}'], withStop = true } = {}) {
  const { output_tokens: outTok, ...startUsage } = usage;
  return [
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-opus-5-5', stop_reason: null, usage: { ...startUsage, output_tokens: 1 } } }),
    ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Look up ' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'the blocks.' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'SIG-A' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'SIG-B' } }),
    ev('content_block_stop', { index: 0 }),
    ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Checking ' } }),
    ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'now.' } }),
    ev('content_block_stop', { index: 1 }),
    ev('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'api_get', input: {} } }),
    ev('ping', {}),
    ...pieces.map((p) => ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: p } })),
    ...(withStop ? [ev('content_block_stop', { index: 2 })] : []),
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outTok } }),
    ev('message_stop', {}),
  ].join('');
}
function streamResponse(raw, { chunkSize = 5, status = 200 } = {}) {
  const bytes = Buffer.from(raw, 'utf8');
  let at = 0;
  return {
    ok: status < 300, status,
    json: async () => { throw new Error('a stream body is not JSON'); },
    body: new ReadableStream({
      pull(controller) {
        if (at >= bytes.length) { controller.close(); return; }
        controller.enqueue(new Uint8Array(bytes.subarray(at, at + chunkSize)));
        at += chunkSize;
      },
    }),
  };
}

const realFetch = global.fetch;
let calls;
beforeEach(() => { calls = []; });
afterEach(() => { global.fetch = realFetch; });
function stubFetch(...responses) {
  global.fetch = jest.fn(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    return typeof next === 'function' ? next(init) : next;
  });
}

const TOOLS = [
  { name: 'whoami', description: 'who', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'api_get', description: 'get', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];
const MESSAGES = [{ role: 'user', content: [{ type: 'text', text: '[context]\nNow: x' }, { type: 'text', text: 'How many availability blocks?' }] }];
const OPTS = { messages: MESSAGES, system: 'SYSTEM PROMPT', tools: TOOLS, model: 'claude-opus-5-5', effort: 'medium', consumerRef: 'assistant_v2:u6:c1', promptKey: 'casey_v2_turn', promptVersion: 'v2.0-abcd1234' };

describe('the request body', () => {
  test('key order, cached system block, cache_control on the last tool only (a copy), adaptive thinking, effort, stream last, no tool_choice', async () => {
    const toolsBefore = JSON.stringify(TOOLS);
    stubFetch(streamResponse(toolTurn()));
    const r = await aiService.converse(makeDb(), OPTS);
    expect(r.ok).toBe(true);
    const { body, init, url } = calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers).toMatchObject({ 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    expect(Object.keys(body)).toEqual(['model', 'max_tokens', 'system', 'tools', 'messages', 'thinking', 'output_config', 'stream']);
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.max_tokens).toBe(16000);
    expect(body.system).toEqual([{ type: 'text', text: 'SYSTEM PROMPT', cache_control: { type: 'ephemeral' } }]);
    expect(body.tools[0]).toEqual(TOOLS[0]);
    expect(body.tools[1]).toEqual({ ...TOOLS[1], cache_control: { type: 'ephemeral' } });
    expect(JSON.stringify(TOOLS)).toBe(toolsBefore);              // the caller's definitions are not mutated
    // The third breakpoint: a COPY of the last block of the last message carries cache_control; the caller's array is untouched.
    expect(body.messages).toEqual([{ role: 'user', content: [MESSAGES[0].content[0], { ...MESSAGES[0].content[1], cache_control: { type: 'ephemeral' } }] }]);
    expect(MESSAGES[0].content[1].cache_control).toBeUndefined();
    expect(JSON.stringify(MESSAGES)).toBe(JSON.stringify([{ role: 'user', content: [{ type: 'text', text: '[context]\nNow: x' }, { type: 'text', text: 'How many availability blocks?' }] }]));
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'medium' });
    expect(body.stream).toBe(true);
    expect(body.tool_choice).toBeUndefined();
    expect(init.body).not.toMatch(/budget_tokens|tool_choice/);
  });

  test('the message breakpoint: on a tool_result tail too; a string content becomes one cached block; an already-cached tail or an empty message is left alone', async () => {
    stubFetch(streamResponse(toolTurn()), streamResponse(toolTurn()), streamResponse(toolTurn()), streamResponse(toolTurn()));
    const results = [...MESSAGES, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'whoami', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }, { type: 'text', text: 'note' }] }];
    await aiService.converse(makeDb(), { ...OPTS, messages: results });
    expect(calls[0].body.messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: '{}' }, { type: 'text', text: 'note', cache_control: { type: 'ephemeral' } }]);
    expect(calls[0].body.messages[1]).toEqual(results[1]);                         // earlier messages carry no marker
    await aiService.converse(makeDb(), { ...OPTS, messages: [{ role: 'user', content: 'plain' }] });
    expect(calls[1].body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'plain', cache_control: { type: 'ephemeral' } }] }]);
    const pre = [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }];
    await aiService.converse(makeDb(), { ...OPTS, messages: pre });
    expect(calls[2].body.messages).toEqual(pre);
    await aiService.converse(makeDb(), { ...OPTS, messages: [{ role: 'user', content: [] }] });
    expect(calls[3].body.messages).toEqual([{ role: 'user', content: [] }]);
  });

  test('no tools → no tools key; a block-array system passes as is; max_tokens and effort honoured', async () => {
    stubFetch(streamResponse(toolTurn()));
    const sys = [{ type: 'text', text: 'A' }, { type: 'text', text: 'B', cache_control: { type: 'ephemeral' } }];
    await aiService.converse(makeDb(), { ...OPTS, tools: [], system: sys, max_tokens: 64000, effort: 'high' });
    const { body } = calls[0];
    expect(Object.keys(body)).toEqual(['model', 'max_tokens', 'system', 'messages', 'thinking', 'output_config', 'stream']);
    expect(body.system).toEqual(sys);
    expect(body.max_tokens).toBe(64000);
    expect(body.output_config).toEqual({ effort: 'high' });
  });
});

describe('the streamed blocks come back verbatim', () => {
  test('thinking + signature, text, tool_use with parsed input; stop_reason; usage; events in order', async () => {
    const events = [];
    stubFetch(streamResponse(toolTurn(), { chunkSize: 3 }));
    const r = await aiService.converse(makeDb(), { ...OPTS, onEvent: (e) => events.push(e) });
    expect(r.ok).toBe(true);
    expect(r.content).toEqual([
      { type: 'thinking', thinking: 'Look up the blocks.', signature: 'SIG-ASIG-B' },
      { type: 'text', text: 'Checking now.' },
      { type: 'tool_use', id: 'toolu_1', name: 'api_get', input: { path: '/api/availability-blocks', query: { a: '1' } } },
    ]);
    expect(r.stop_reason).toBe('tool_use');
    expect(r.usage).toEqual({ input_tokens: 40, output_tokens: 120, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 });
    expect(r.partial).toEqual([]);
    expect(typeof r.callId).toBe('number');
    expect(events).toEqual([
      { type: 'thinking', text: 'Look up ' }, { type: 'thinking', text: 'the blocks.' },
      { type: 'text', text: 'Checking ' }, { type: 'text', text: 'now.' },
      { type: 'tool_use_start', id: 'toolu_1', name: 'api_get' },
      { type: 'tool_use_end', id: 'toolu_1', name: 'api_get', input: { path: '/api/availability-blocks', query: { a: '1' } } },
    ]);
  });

  test('a tool_use cut before its JSON is whole (max_tokens) keeps input {} and is named in partial; a redacted_thinking block passes whole', async () => {
    stubFetch(streamResponse(toolTurn({ stop: 'max_tokens', pieces: ['{"path":"/api/av'], withStop: false })));
    const r = await aiService.converse(makeDb(), OPTS);
    expect(r.ok).toBe(true);
    expect(r.stop_reason).toBe('max_tokens');
    expect(r.content[2]).toEqual({ type: 'tool_use', id: 'toolu_1', name: 'api_get', input: {} });
    expect(r.partial).toEqual([2]);
    // With the stop event but unparseable pieces: also partial.
    stubFetch(streamResponse(toolTurn({ stop: 'max_tokens', pieces: ['{"path":"/api/av'] })));
    const r2 = await aiService.converse(makeDb(), OPTS);
    expect(r2.partial).toEqual([2]);
    const raw = [
      ev('message_start', { message: { usage: { input_tokens: 3, output_tokens: 1 } } }),
      ev('content_block_start', { index: 0, content_block: { type: 'redacted_thinking', data: 'OPAQUE' } }),
      ev('content_block_stop', { index: 0 }),
      ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'ok' } }),
      ev('content_block_stop', { index: 1 }),
      ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
      ev('message_stop', {}),
    ].join('');
    stubFetch(streamResponse(raw, { chunkSize: 1 }));
    const r3 = await aiService.converse(makeDb(), OPTS);
    expect(r3.content).toEqual([{ type: 'redacted_thinking', data: 'OPAQUE' }, { type: 'text', text: 'ok' }]);
    expect(r3.stop_reason).toBe('end_turn');
  });
});

describe('the ai_calls row', () => {
  test('labels, whole-prompt tokens, cost at Opus 5.5\'s 0.05x cache read, excerpt and response', async () => {
    const db = makeDb();
    stubFetch(streamResponse(toolTurn()));
    const r = await aiService.converse(db, OPTS);
    expect(db.rows).toHaveLength(1);
    const row = db.rows[0];
    expect(row[COL.prompt_key]).toBe('casey_v2_turn');
    expect(row[COL.prompt_version]).toBe('v2.0-abcd1234');
    expect(row[COL.model]).toBe('claude-opus-5-5');
    expect(row[COL.consumer_ref]).toBe('assistant_v2:u6:c1');
    expect(row[COL.status]).toBe('ok');
    expect(row[COL.error]).toBeNull();
    expect(row[COL.input_tokens]).toBe(9040);
    expect(row[COL.output_tokens]).toBe(120);
    // 40 × $4 + 120 × $20 + 9000 × $4 × 0.05, per MTok, in cents
    const expected = (40 / 1e6) * 4 * 100 + (120 / 1e6) * 20 * 100 + (9000 / 1e6) * 4 * 0.05 * 100;
    expect(row[COL.cost_cents]).toBeCloseTo(expected, 10);
    expect(r.cost_cents).toBeCloseTo(expected, 10);
    expect(row[COL.request_excerpt]).toBe('[prompt_cache: read=9000 write=0 uncached=40]\n[context]\nNow: x\nHow many availability blocks?');
    expect(row[COL.response]).toBe('Checking now.\n[tool_use api_get toolu_1]');
  });

  test('logContent:false keeps lengths only; a tool_result user message is summarised by count', async () => {
    const db = makeDb();
    stubFetch(streamResponse(toolTurn()));
    const msgs = [...MESSAGES, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'whoami', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' }, { type: 'text', text: '[budget]' }] }];
    await aiService.converse(db, { ...OPTS, messages: msgs, logContent: false });
    const row = db.rows[0];
    expect(row[COL.request_excerpt]).toBe(`[prompt_cache: read=9000 write=0 uncached=40]\n[omitted: ${'[tool_result x1]\n[budget]'.length} chars]`);
    expect(row[COL.response]).toMatch(/^\[omitted: \d+ chars\]$/);
    expect(row[COL.cost_cents]).not.toBeNull();
  });
});

describe('error taxonomy', () => {
  test('bad_request: validated before any call, one error row', async () => {
    const db = makeDb();
    stubFetch();
    for (const [bad, re] of [
      [{ messages: [] }, /messages/], [{ model: '' }, /model/], [{ effort: 'ultra' }, /effort/], [{ tools: 'x' }, /tools/],
      [{ max_tokens: 0 }, /max_tokens/], [{ system: 5 }, /system/],
    ]) {
      const r = await aiService.converse(db, { ...OPTS, ...bad });
      expect(r).toMatchObject({ ok: false, error: 'bad_request' });
      expect(r.detail).toMatch(re);
    }
    expect(global.fetch).not.toHaveBeenCalled();
    expect(db.rows.map((row) => row[COL.status])).toEqual(['error', 'error', 'error', 'error', 'error', 'error']);
    expect(db.rows[0][COL.error]).toMatch(/^bad_request: /);
  });

  test('no_auth: no credential row → no call', async () => {
    const db = makeDb({ cred: false });
    stubFetch();
    const r = await aiService.converse(db, OPTS);
    expect(r).toMatchObject({ ok: false, error: 'no_auth' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(db.rows[0][COL.error]).toBe('no_auth');
  });

  test('an HTTP error answers JSON: api_error with the status and the body in detail (a thinking-binding 400 is legible to the loop)', async () => {
    const db = makeDb();
    const errBody = { type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: thinking block signature does not match the prefix' } };
    stubFetch({ ok: false, status: 400, json: async () => errBody, body: null });
    const r = await aiService.converse(db, OPTS);
    expect(r).toMatchObject({ ok: false, error: 'api_error', status: 400, api: { type: 'invalid_request_error', message: 'messages.1.content.0: thinking block signature does not match the prefix' } });
    expect(r.detail).toMatch(/^http_400: .*thinking block signature/);
    expect(db.rows[0][COL.status]).toBe('error');
    expect(db.rows[0][COL.error]).toBe(r.detail);
    // logContent:false → the ROW keeps the code only, but `api` still carries the provider's own message (the loop reads it).
    const db2 = makeDb();
    stubFetch({ ok: false, status: 400, json: async () => errBody, body: null });
    const r2 = await aiService.converse(db2, { ...OPTS, logContent: false });
    expect(r2).toMatchObject({ ok: false, error: 'api_error', status: 400, detail: 'http_400', api: { type: 'invalid_request_error', message: expect.stringMatching(/thinking block signature/) } });
    expect(db2.rows[0][COL.error]).toBe('http_400');
    expect(JSON.stringify(db2.rows[0])).not.toMatch(/thinking block/);
    stubFetch({ ok: false, status: 529, json: async () => ({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), body: null });
    const r3 = await aiService.converse(makeDb(), { ...OPTS, logContent: false });
    expect(r3).toMatchObject({ ok: false, error: 'api_error', status: 529, detail: 'http_529', api: { type: 'overloaded_error', message: 'Overloaded' } });
    stubFetch({ ok: false, status: 502, json: async () => null, body: null });
    expect((await aiService.converse(makeDb(), OPTS)).api).toEqual({ type: null, message: null });
  });

  test('an in-stream error event and a stream cut before message_stop are api_error', async () => {
    const cut = toolTurn().split('event: message_delta')[0];
    stubFetch(streamResponse(cut));
    const r1 = await aiService.converse(makeDb(), OPTS);
    expect(r1).toMatchObject({ ok: false, error: 'api_error' });
    expect(r1.detail).toMatch(/^stream_incomplete/);
    const errored = cut + ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } });
    stubFetch(streamResponse(errored));
    const r2 = await aiService.converse(makeDb(), OPTS);
    expect(r2).toMatchObject({ ok: false, error: 'api_error' });
    expect(r2.detail).toMatch(/^stream_error: .*Overloaded/);
  });

  test('the timeout aborts the whole read: status timeout, error timeout', async () => {
    const db = makeDb();
    stubFetch((init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    const t0 = Date.now();
    const r = await aiService.converse(db, { ...OPTS, timeout_ms: 1000 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(r).toMatchObject({ ok: false, error: 'timeout' });
    expect(db.rows[0][COL.status]).toBe('timeout');
    expect(db.rows[0][COL.error]).toBe('timeout after 1000ms');
  });
});

describe('computeCostCents: per-model cache-read rates', () => {
  const cache = { cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 };
  test('the existing models are priced exactly as before (flat 0.1x read, 1.25x write)', () => {
    expect(aiService.computeCostCents(1e6, 1e6, 'claude-sonnet-5-5', cache)).toBeCloseTo(200 + 1000 + 20 + 250, 8);
    expect(aiService.computeCostCents(1e6, 1e6, 'claude-opus-5', cache)).toBeCloseTo(500 + 2500 + 50 + 625, 8);
    expect(aiService.computeCostCents(1e6, 1e6, 'claude-sonnet-4-6')).toBeCloseTo(300 + 1500, 8);
    expect(aiService.computeCostCents(1e6, 1e6)).toBeCloseTo(300 + 1500, 8);           // legacy 2-arg → sonnet 4.6
    expect(aiService.computeCostCents(1e6, 1e6, 'claude-haiku-5-5', cache)).toBeCloseTo(10 + 50 + 1 + 12.5, 8);
  });
  test('Opus 5.5 reads at 0.05x, Fable 5.1 at 0.025x; writes stay 1.25x; an unknown model is null', () => {
    expect(aiService.computeCostCents(1e6, 1e6, 'claude-opus-5-5', cache)).toBeCloseTo(400 + 2000 + 20 + 500, 8);
    expect(aiService.computeCostCents(1e6, 1e6, 'claude-fable-5-1', cache)).toBeCloseTo(1000 + 5000 + 25 + 1250, 8);
    expect(aiService.computeCostCents(1e6, 1e6, 'claude-opus-5-5')).toBeCloseTo(2400, 8);
    expect(aiService.computeCostCents(10, 10, 'claude-nope-1')).toBeNull();
    expect(aiService.MODEL_PRICING['claude-opus-5-5']).toEqual({ in: 4, out: 20, cacheRead: 0.05 });
    expect(aiService.MODEL_PRICING['claude-fable-5-1']).toEqual({ in: 10, out: 50, cacheRead: 0.025 });
  });
});
