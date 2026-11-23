// Casey v2 S4b — services/casey/tools/flag_for_review.js over a FAKE fetch: the
// POST it makes to the real report route (the body: kind casey, the chat, the
// turn's model and prompt_version, by: casey; the headers: the caller's
// Authorization forwarded, x-casey-via, the client IP), the 201 → report_id,
// once per turn (the shared ctx.turn holder), the dry run without a chat, the
// refusals (no Authorization; a 429 / 400 / non-JSON answer; a timeout). The
// real route end to end: tests/caseyLoop.test.js (a scripted model flags).
'use strict';

const tools = require('../services/casey/tools');

const STAFF = { type: 'jwt', userId: 7, username: 'rena', roles: ['admin'] };
function ctx({ fetch, turn = { chatId: 23, model: 'claude-sonnet-5-5', promptVersion: 'v2.5-abc', flagged: null, flagging: null }, card = { chatId: 23, toolUseId: 'tu9' }, headers = { authorization: 'Bearer T', 'user-agent': 'jest', 'x-forwarded-for': '203.0.113.9' } } = {}) {
  return { db: {}, auth: STAFF, app: {}, headers, ip: '10.0.0.1', port: 4321, via: 'casey:c23', fetch, turn, card };
}
const okFetch = (id = 41, emailed = true) => jest.fn(async () => ({ status: 201, text: async () => JSON.stringify({ id, emailed }) }));

test('registered with the schema the checker supports; the description tells the model when and that it never changes a record', () => {
  const t = tools.TOOLS.find((x) => x.name === 'flag_for_review');
  expect(t.untrusted).toBe(false);
  expect(t.input_schema.required).toEqual(['note']);
  expect(t.input_schema.properties.note.maxLength).toBe(1000);
  expect(t.description).toMatch(/once per turn/i);
  expect(t.description).toMatch(/never changes any record/);
  expect(tools.checkInput(t.input_schema, {})).toMatch(/note/);
  expect(tools.checkInput(t.input_schema, { note: 'x', extra: 1 })).toMatch(/extra/);
});

test('files through the real route as the user: the POST\'s URL, headers and body; 201 → report_id; the turn holder records it', async () => {
  const fetch = okFetch(41);
  const c = ctx({ fetch });
  const r = await tools.runTool('flag_for_review', c, { note: '  the route refused twice  ' });
  expect(r.ok).toBe(true);
  expect(r.data).toEqual({ report_id: 41, emailed: true, message: 'filed for review' });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('http://127.0.0.1:4321/api/issue-reports');
  expect(init.method).toBe('POST');
  expect(init.redirect).toBe('manual');
  expect(init.headers).toMatchObject({ authorization: 'Bearer T', 'content-type': 'application/json', 'x-casey-via': 'casey:c23', 'x-forwarded-for': '203.0.113.9', 'user-agent': 'jest' });
  expect(JSON.parse(init.body)).toEqual({
    kind: 'casey', note: '[flagged by Casey] the route refused twice', page_url: null,
    context: { casey: { chat_id: 23, seq: null, model: 'claude-sonnet-5-5', prompt_version: 'v2.5-abc', by: 'casey', tool_use_id: 'tu9' } },
  });
  expect(c.turn.flagged).toBe(41);
  // once per turn: the second call answers the first id and makes no request — also when the two run in PARALLEL (one round)
  const again = await tools.runTool('flag_for_review', c, { note: 'again' });
  expect(again.ok).toBe(true);
  expect(again.data).toMatchObject({ report_id: 41, already: true });
  expect(fetch).toHaveBeenCalledTimes(1);
  const slow = jest.fn(() => new Promise((r) => setTimeout(() => r({ status: 201, text: async () => JSON.stringify({ id: 55, emailed: true }) }), 20)));
  const c2 = ctx({ fetch: slow });
  const [p1, p2] = await Promise.all([tools.runTool('flag_for_review', c2, { note: 'one' }), tools.runTool('flag_for_review', c2, { note: 'two' })]);
  expect(slow).toHaveBeenCalledTimes(1);
  expect([p1.data.report_id, p2.data.report_id, p1.data.already || p2.data.already]).toEqual([55, 55, true]);
});

test('without a chat (the SU test route) nothing is filed: a dry run; a blank note is BAD_INPUT', async () => {
  const fetch = okFetch();
  const r = await tools.runTool('flag_for_review', ctx({ fetch, card: null, turn: null }), { note: 'hm' });
  expect(r.ok).toBe(true);
  expect(r.data).toMatchObject({ dry_run: true, note: 'hm' });
  expect(fetch).not.toHaveBeenCalled();
  const blank = await tools.runTool('flag_for_review', ctx({ fetch }), { note: '   ' });
  expect(blank.ok).toBe(false);
  expect(blank.error.code).toBe('BAD_INPUT');
});

test('refusals: no Authorization → NO_AUTH; a 429 / 400 / non-JSON answer → FLAG_FAILED naming the status; a hung route → TIMEOUT; the turn is not marked', async () => {
  const noAuth = await tools.runTool('flag_for_review', ctx({ fetch: okFetch(), headers: {} }), { note: 'x' });
  expect(noAuth).toMatchObject({ ok: false, error: { code: 'NO_AUTH' } });
  for (const [status, body] of [[429, JSON.stringify({ error: 'Too many reports in a short window' })], [400, JSON.stringify({ error: 'a casey report names its chat' })], [200, 'not json'], [200, JSON.stringify({ id: 9 })]]) {   // a 200 with an id is not the route's 201: not filed
    const c = ctx({ fetch: jest.fn(async () => ({ status, text: async () => body })) });
    const r = await tools.runTool('flag_for_review', c, { note: 'x' });
    expect([status, r.ok, r.error.code]).toEqual([status, false, 'FLAG_FAILED']);
    expect(r.error.message).toContain(String(status));
    expect(c.turn.flagged).toBeNull();
    const retry = await tools.runTool('flag_for_review', c, { note: 'retry' });   // the same turn: not retried
    expect(retry).toMatchObject({ ok: false, error: { code: 'FLAG_FAILED', message: expect.stringMatching(/already failed/) } });
  }
  const hung = jest.fn((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
  const c = ctx({ fetch: hung }); c.timeoutMs = 30;
  const r = await tools.runTool('flag_for_review', c, { note: 'x' });
  expect(r).toMatchObject({ ok: false, error: { code: 'TIMEOUT', message: expect.stringMatching(/MAY have been filed.*do not flag again/) } });   // the route emails IT before answering: a slow relay is not a failure
});

test('the route\'s `emailed` rides the answer per call (no module state): a 201 with emailed:false says so', async () => {
  const c = ctx({ fetch: okFetch(77, false) });
  const r = await tools.runTool('flag_for_review', c, { note: 'x' });
  expect(r.data).toEqual({ report_id: 77, emailed: false, message: 'filed for review' });
  const c2 = ctx({ fetch: okFetch(78, true) });
  expect((await tools.runTool('flag_for_review', c2, { note: 'y' })).data.emailed).toBe(true);
});
