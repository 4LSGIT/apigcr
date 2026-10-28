/**
 * tests/aiService.stream.test.js
 *
 * Streaming for Ask Casey's answer (aiService opts.onTextDelta, OPT-IN).
 *
 * The guarantees, in order of importance:
 *   1. a caller that passes no onTextDelta sends exactly the body it sent
 *      before (no `stream` key, same keys, same bytes);
 *   2. a streaming call sends the SAME body plus `stream: true` as its last
 *      key — prompt, cache blocks, max_tokens, output_config untouched;
 *   3. a streamed response folds back into the same result and the same
 *      ai_calls row a non-streamed response produces (only latency differs);
 *   4. the error taxonomy holds: HTTP errors log as today; an in-stream error
 *      event or a stream cut before message_stop is api_error; the timeout
 *      covers the whole read.
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
function makeDb() {
  let insertId = 0;
  const rows = [];
  const query = jest.fn(async (sql, params) => {
    if (/FROM credentials/i.test(sql)) return [[CRED_ROW]];
    if (/INSERT INTO ai_calls/i.test(sql)) { rows.push(params); return [{ insertId: ++insertId }]; }
    throw new Error(`unexpected sql in stub: ${sql}`);
  });
  return { query, rows };
}
// ai_calls INSERT positional params (services/aiService.js logCall).
const COL = { status: 6, error: 7, input_tokens: 8, output_tokens: 9, cost_cents: 10, latency_ms: 11, request_excerpt: 12, response: 13 };

const envelope = (text, usage = { input_tokens: 100, output_tokens: 50 }, stop = 'end_turn') => ({
  ok: true, status: 200,
  json: async () => ({ content: [{ type: 'text', text }], stop_reason: stop, usage }),
});

// The SSE byte stream Anthropic sends for a single text block.
function sseEvents(text, { usage = { input_tokens: 100, output_tokens: 50 }, stop = 'end_turn', pieces = null } = {}) {
  const { output_tokens: outTok, ...startUsage } = usage;
  const parts = pieces || [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))].filter(Boolean);
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return [
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { ...startUsage, output_tokens: 1 } } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('ping', {}),
    ...parts.map((p) => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: p } })),
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outTok } }),
    ev('message_stop', {}),
  ].join('');
}
// A Response-like object whose body yields `raw` cut into `chunkSize`-byte
// pieces — so events, lines and multi-byte characters split anywhere.
function streamResponse(raw, { chunkSize = 7 } = {}) {
  const bytes = Buffer.from(raw, 'utf8');
  let at = 0;
  return {
    ok: true, status: 200,
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
let bodies;
beforeEach(() => { bodies = []; });
afterEach(() => { global.fetch = realFetch; jest.useRealTimers(); });
function stubFetch(...responses) {
  global.fetch = jest.fn(async (url, init) => {
    bodies.push(init.body);
    const next = responses.shift();
    return typeof next === 'function' ? next(init) : next;
  });
}

const ANSWER_OPTS = {
  promptKey: 'assistant_answer', systemAppend: 'SERVER CONTEXT\nCURRENT TIME: x', userInput: 'QUESTION:\nq',
  model: 'claude-opus-5', outputType: 'json', timeout_ms: 60000, max_tokens: 8000,
  consumerRef: 'assistant_answer:u7', cacheSystemPrefix: true, logContent: false,
};
const ATTACH = [{ type: 'document', media_type: 'application/pdf', data_base64: 'JVBERi0xLjQK' }];
const CASES = [
  ['the answer call site as Casey builds it', ANSWER_OPTS],
  ['attachments + effort', { promptKey: 'assistant_investigate', systemAppend: 'CTX', userInput: 'q', attachments: ATTACH, outputConfig: { effort: 'low' }, outputType: 'json' }],
  ['inline text call', { inlineSystem: 'Sys {{x}}', vars: { x: 'X' }, userInput: 'u', model: 'claude-opus-5' }],
];

describe('request body', () => {
  test.each(CASES)('no onTextDelta: no stream key, the historical key set (%s)', async (_l, opts) => {
    stubFetch(envelope('{}'));
    await aiService.call(makeDb(), opts);
    const body = JSON.parse(bodies[0]);
    expect(Object.keys(body)).toEqual(['model', 'max_tokens', 'system', 'messages', ...(opts.outputConfig ? ['output_config'] : [])]);
    expect(bodies[0]).not.toMatch(/"stream"/);
  });

  test.each(CASES)('onTextDelta: the same bytes plus stream:true as the last key (%s)', async (_l, opts) => {
    stubFetch(envelope('{}'));
    await aiService.call(makeDb(), opts);
    stubFetch(streamResponse(sseEvents('{}')));
    await aiService.call(makeDb(), { ...opts, onTextDelta: () => {} });
    const [off, on] = bodies;
    const parsed = JSON.parse(on);
    expect(Object.keys(parsed).pop()).toBe('stream');
    expect(parsed.stream).toBe(true);
    expect(on).toBe(`${off.slice(0, -1)},"stream":true}`);
  });
});

describe('a streamed response is the same result and the same ai_calls row', () => {
  const TEXT = '{"answer":"Ms. Lévy\'s case — 3 rows","citations":[{"query_id":"q1","row_number":1}]}';
  const USAGE = { input_tokens: 40, output_tokens: 90, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 };

  test('result, tokens, cost, cache line, status, response text', async () => {
    const offDb = makeDb();
    stubFetch(envelope(TEXT, USAGE));
    const off = await aiService.call(offDb, ANSWER_OPTS);
    const onDb = makeDb();
    const deltas = [];
    stubFetch(streamResponse(sseEvents(TEXT, { usage: USAGE, pieces: [TEXT.slice(0, 5), TEXT.slice(5, 23), TEXT.slice(23)] }), { chunkSize: 3 }));
    const on = await aiService.call(onDb, { ...ANSWER_OPTS, onTextDelta: (t, info) => deltas.push([t, info.attempt]) });

    expect(on).toEqual(off);
    expect(on.ok).toBe(true);
    expect(on.json.answer).toBe('Ms. Lévy\'s case — 3 rows');
    expect(deltas.map((d) => d[0]).join('')).toBe(TEXT);
    expect(deltas).toHaveLength(3);
    expect(deltas.every((d) => d[1] === 1)).toBe(true);
    expect(onDb.rows).toHaveLength(1);
    const strip = (row) => row.filter((_, i) => i !== COL.latency_ms);
    expect(strip(onDb.rows[0])).toEqual(strip(offDb.rows[0]));
    expect(onDb.rows[0][COL.input_tokens]).toBe(5040);
    expect(onDb.rows[0][COL.request_excerpt]).toMatch(/^\[prompt_cache: read=5000 write=0 uncached=40\]/);
  });

  test('a throwing onTextDelta never breaks the call', async () => {
    stubFetch(streamResponse(sseEvents('{"answer":"x"}')));
    const r = await aiService.call(makeDb(), { ...ANSWER_OPTS, onTextDelta: () => { throw new Error('pane gone'); } });
    expect(r.ok).toBe(true);
    expect(r.json).toEqual({ answer: 'x' });
  });

  test('non-text blocks and unknown events are ignored; text blocks join in index order', async () => {
    const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const raw = [
      ev('message_start', { message: { usage: { input_tokens: 3, output_tokens: 1 } } }),
      ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'secret' } }),
      ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '{"a"' } }),
      ev('future_event', { whatever: 1 }),
      ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: ':1}' } }),
      ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
      ev('message_stop', {}),
    ].join('');
    const deltas = [];
    stubFetch(streamResponse(raw, { chunkSize: 1 }));
    const r = await aiService.call(makeDb(), { ...ANSWER_OPTS, onTextDelta: (t) => deltas.push(t) });
    expect(r).toMatchObject({ ok: true, output: '{"a":1}', json: { a: 1 }, stopReason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 } });
    expect(deltas.join('')).toBe('{"a":1}');
  });

  test('the JSON retry streams too, reported as attempt 2', async () => {
    const deltas = [];
    stubFetch(streamResponse(sseEvents('not json')), streamResponse(sseEvents('{"answer":"ok"}')));
    const db = makeDb();
    const r = await aiService.call(db, { ...ANSWER_OPTS, onTextDelta: (t, info) => deltas.push(info.attempt) });
    expect(r.ok).toBe(true);
    expect(r.json).toEqual({ answer: 'ok' });
    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[1]).stream).toBe(true);
    expect(deltas).toContain(1);
    expect(deltas[deltas.length - 1]).toBe(2);
    expect(db.rows.map((row) => [row[COL.status], row[COL.error]])).toEqual([['error', 'json_parse'], ['ok', null]]);
  });
});

describe('error taxonomy', () => {
  test('an HTTP error answers JSON to a stream request and logs exactly as without streaming', async () => {
    const errBody = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
    const http529 = () => ({ ok: false, status: 529, json: async () => errBody, body: null });
    const offDb = makeDb();
    stubFetch(http529());
    const off = await aiService.call(offDb, { ...ANSWER_OPTS, logContent: true });
    const onDb = makeDb();
    stubFetch(http529());
    const on = await aiService.call(onDb, { ...ANSWER_OPTS, logContent: true, onTextDelta: () => {} });
    expect(on).toEqual(off);
    expect(on).toMatchObject({ ok: false, error: 'api_error' });
    const strip = (row) => row.filter((_, i) => i !== COL.latency_ms);
    expect(strip(onDb.rows[0])).toEqual(strip(offDb.rows[0]));
  });

  test('an in-stream error event is a failed transport (api_error), never a retry', async () => {
    const raw = sseEvents('{"answer":"partial').split('event: content_block_stop')[0]
      + `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`;
    const db = makeDb();
    stubFetch(streamResponse(raw));
    const r = await aiService.call(db, { ...ANSWER_OPTS, logContent: true, onTextDelta: () => {} });
    expect(r).toMatchObject({ ok: false, error: 'api_error' });
    expect(r.detail).toMatch(/^stream_error: .*overloaded_error/);
    expect(bodies).toHaveLength(1);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0][COL.status]).toBe('error');
  });

  test('logContent:false logs the stream failure as a fixed code', async () => {
    const raw = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'client name in here' } })}\n\n`;
    const db = makeDb();
    stubFetch(streamResponse(raw));
    const r = await aiService.call(db, { ...ANSWER_OPTS, onTextDelta: () => {} });
    expect(r).toMatchObject({ ok: false, error: 'api_error', detail: 'stream_error' });
    expect(db.rows[0][COL.error]).toBe('stream_error');
    expect(String(db.rows[0][COL.response])).toMatch(/^\[omitted: \d+ chars\]$/);
  });

  test('a stream cut before message_stop is api_error stream_incomplete', async () => {
    const raw = sseEvents('{"answer":"half"}').split('event: message_stop')[0];
    stubFetch(streamResponse(raw));
    const db = makeDb();
    const r = await aiService.call(db, { ...ANSWER_OPTS, onTextDelta: () => {} });
    expect(r).toMatchObject({ ok: false, error: 'api_error', detail: 'stream_incomplete' });
    expect(bodies).toHaveLength(1);
  });

  test('the timeout covers the whole read: a stream that stalls after its headers is a timeout row', async () => {
    // Headers and the first events arrive at once; then the body hangs until
    // the call's own AbortController fires (as undici errors a body on abort).
    stubFetch((init) => {
      const head = Buffer.from(sseEvents('{"answer":"slow"}').split('event: content_block_stop')[0], 'utf8');
      let sent = false;
      return {
        ok: true, status: 200, json: async () => null,
        body: new ReadableStream({
          pull(controller) {
            if (!sent) { sent = true; controller.enqueue(new Uint8Array(head)); return undefined; }
            return new Promise((_, reject) => init.signal.addEventListener('abort', () => {
              controller.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
              reject(new Error('aborted'));
            }));
          },
        }),
      };
    });
    const db = makeDb();
    const deltas = [];
    const started = Date.now();
    const r = await aiService.call(db, { ...ANSWER_OPTS, timeout_ms: 1000, onTextDelta: (t) => deltas.push(t) });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(deltas.join('')).toBe('{"answer":"slow"}');
    expect(r).toMatchObject({ ok: false, error: 'timeout' });
    expect(db.rows[0][COL.status]).toBe('timeout');
  });
});
