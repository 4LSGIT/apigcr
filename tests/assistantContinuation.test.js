'use strict';
/**
 * tests/assistantContinuation.test.js — R1 read-loop continuation.
 *
 * An investigation that stops on a budget hands the browser a SEALED
 * continuation; the user's "Keep going" click spends it for one more budget
 * and the loop resumes from the accumulated evidence. The evidence is what
 * authorizes action cards, so the three refusals pinned here are the security
 * boundary: a forged / tampered / wrong-key continuation, another user's
 * continuation, and a continuation spent in another chat. Every model call is
 * stubbed at aiService.call and every read at reportService.execute; the db is
 * a fake that answers only the spend-cap and chat-ownership reads.
 */

jest.mock('../startup/dbReadonly', () => ({}));

const fs = require('fs');
const path = require('path');
const svc = require('../services/assistantService');
const aiService = require('../services/aiService');
const reportService = require('../services/reportService');
const assistantTicket = require('../lib/assistantTicket');
const continuation = require('../lib/assistantContinuation');

const SECRET = 'assistant-continuation-test-secret';
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

// Spend-cap reads plus chat ownership: chats maps chat id -> owning user id.
function fakeDb({ chats = {}, mtd = 0 } = {}) {
  return { query: jest.fn(async (q, params = []) => {
    if (/FROM app_settings/.test(q)) return [[]];
    if (/FROM ai_calls/.test(q)) return [[{ c: mtd }]];
    if (/FROM assistant_chats/.test(q)) {
      const [id, uid] = params;
      return [chats[id] === uid ? [{ id, title: 'chat', model_mode: 'better_quality' }] : []];
    }
    throw new Error(`Unexpected SQL: ${q}`);
  }) };
}

function planTicket(uid = 7, steps = [sql(contactSql(1))], question = 'Who is contact one and what happened next?') {
  const plan = svc.validatePlan({ action: 'query', summary: 'First pass', steps });
  return assistantTicket.sign({ v: 1, uid, question, history: [], plan: { action: 'query', ...plan } });
}

// aiService.call scripted per prompt stage; every call is recorded.
function scriptAi({ investigate = [], answer = [] } = {}) {
  const queues = { assistant_investigate: [...investigate], assistant_answer: [...answer] };
  return jest.spyOn(aiService, 'call').mockImplementation(async (_db, opts) => {
    const next = (queues[opts.promptKey] || []).shift();
    if (!next) throw new Error(`unscripted ${opts.promptKey} call`);
    return { usage: { input_tokens: 1000, output_tokens: 100 }, callId: 1, ...next };
  });
}
const query = (n) => ({ ok: true, json: { action: 'query', summary: `Pass for ${n}`, steps: [sql(contactSql(n))] } });
const finish = { ok: true, json: { action: 'finish', reason: 'Enough' } };
const answerOf = (text, citations = []) => ({ ok: true, json: { answer: text, citations } });

function rows() {
  let n = 0;
  return jest.spyOn(reportService, 'execute').mockImplementation(async () => {
    n += 1;
    return { rows: [{ contact_id: 100 + n, contact_name: `Person ${n}` }], rowCount: 1, truncated: false };
  });
}

// One full first segment that stops on the round budget (3 rounds), in chat
// 41 by default; chatId null = the browser had no saved chat.
async function firstSegment(chatId = 41) {
  rows();
  scriptAi({ investigate: [query(2), query(3)], answer: [answerOf('Stopped early.')] });
  const out = await svc.execute(fakeDb({ chats: { 41: 7 } }), { signedTicket: planTicket(), chatId, userId: 7, auth: AUTH7 });
  jest.restoreAllMocks();
  return out;
}

describe('the sealed continuation (lib/assistantContinuation)', () => {
  test('round-trips and stamps an expiry', () => {
    const token = continuation.seal({ v: 1, uid: 7, evidence: [{ id: 'q1', rows: [{ a: 1 }] }] });
    expect(token).toMatch(/^c1\./);
    expect(continuation.open(token)).toMatchObject({ v: 1, uid: 7, evidence: [{ id: 'q1' }] });
  });

  test('is opaque: the evidence is not readable from the token', () => {
    const token = continuation.seal({ evidence: [{ rows: [{ secret_marker: 'PLAINTEXT-EVIDENCE-MARKER' }] }] });
    const decoded = token.split('.').slice(1).map((p) => Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1')).join('');
    expect(decoded).not.toMatch(/PLAINTEXT-EVIDENCE-MARKER/);
  });

  // The refusal must come from the AUTHENTICATION tag ('bad seal'), not from
  // garbage failing to inflate: without the tag check a crafted body would be
  // decrypted and trusted.
  const detailOf = (fn) => { try { fn(); } catch (e) { return [e.status, e.detail]; } return null; };

  test('refuses a token sealed under another key — at the authentication tag', () => {
    process.env.JWT_SECRET = 'attacker-guess';
    const forged = continuation.seal({ v: 1, uid: 7 });
    process.env.JWT_SECRET = SECRET;
    expect(detailOf(() => continuation.open(forged))).toEqual([400, 'bad seal']);
  });

  test('refuses a token whose authentication tag was swapped from another token', () => {
    const a = continuation.seal({ v: 1, uid: 7 }).split('.');
    const b = continuation.seal({ v: 1, uid: 8 }).split('.');
    expect(detailOf(() => continuation.open([a[0], a[1], a[2], b[3]].join('.')))).toEqual([400, 'bad seal']);
  });

  test('refuses an expired token', () => {
    expect(() => continuation.open(continuation.seal({ v: 1 }, -1))).toThrow(/can no longer be continued/);
  });

  test('is domain-separated from plan tickets in both directions', () => {
    const planned = assistantTicket.sign({ v: 1, uid: 7 });
    expect(() => continuation.open(planned)).toThrow(/can no longer be continued/);
    expect(() => assistantTicket.verify(continuation.seal({ v: 1, uid: 7 }))).toThrow(/invalid or has expired/);
  });
});

describe('a budget stop offers a continuation; other stops do not', () => {
  test('round_budget: the answer is told, and a sealed continuation comes back', async () => {
    rows();
    const ai = scriptAi({ investigate: [query(2), query(3)], answer: [answerOf('Stopped early.')] });
    const out = await svc.execute(fakeDb({ chats: { 41: 7 } }), { signedTicket: planTicket(), chatId: 41, userId: 7, auth: AUTH7 });
    expect(out.investigation).toMatchObject({ stop_reason: 'round_budget', rounds: 3, continuable: true, grants: 0 });
    expect(typeof out.continuation).toBe('string');
    expect(out.investigation.approx_cost_cents).toBeGreaterThan(0);
    const answerCall = ai.mock.calls.find((c) => c[1].promptKey === 'assistant_answer')[1];
    expect(answerCall.userInput).toMatch(/"keep_going_offered":true/);
    // The response never carries the evidence in the clear.
    expect(JSON.stringify(out)).not.toMatch(/"rows":\[/);
  });

  test('model_finished offers none', async () => {
    rows();
    scriptAi({ investigate: [finish], answer: [answerOf('Done.')] });
    const out = await svc.execute(fakeDb(), { signedTicket: planTicket(), userId: 7, auth: AUTH7 });
    expect(out.investigation).toMatchObject({ stop_reason: 'model_finished', continuable: false });
    expect(out.continuation).toBeUndefined();
  });

  test('repeated_query offers none', async () => {
    rows();
    scriptAi({ investigate: [query(1)], answer: [answerOf('Repeated.')] });
    const out = await svc.execute(fakeDb(), { signedTicket: planTicket(), userId: 7, auth: AUTH7 });
    expect(out.investigation).toMatchObject({ stop_reason: 'repeated_query', continuable: false });
    expect(out.continuation).toBeUndefined();
  });

  test('a controller cut off at its output ceiling is a token_budget stop, not model_finished', async () => {
    rows();
    scriptAi({ investigate: [{ ok: false, error: 'json_parse', stopReason: 'max_tokens' }], answer: [answerOf('Partial.')] });
    const out = await svc.execute(fakeDb(), { signedTicket: planTicket(), userId: 7, auth: AUTH7 });
    expect(out.investigation).toMatchObject({ stop_reason: 'token_budget', continuable: true });
  });

  test('any other controller failure is named, not reported as model_finished', async () => {
    rows();
    scriptAi({ investigate: [{ ok: false, error: 'api_error' }], answer: [answerOf('Partial.')] });
    const out = await svc.execute(fakeDb(), { signedTicket: planTicket(), userId: 7, auth: AUTH7 });
    expect(out.investigation).toMatchObject({ stop_reason: 'controller_unavailable', continuable: false });
  });
});

describe('Keep going resumes the same investigation', () => {
  test('a fresh budget, global numbering, prior evidence in context, citations spanning both segments', async () => {
    const first = await firstSegment();
    const run = rows();
    const ai = scriptAi({ investigate: [query(4), finish], answer: [answerOf('Contact one, then four.', [
      { query_id: 'q1', row_number: 1, label: 'First segment' },
      { query_id: 'q4', row_number: 1, label: 'Continued segment' },
    ])] });
    const out = await svc.execute(fakeDb({ chats: { 41: 7 } }), { continuation: first.continuation, chatId: 41, userId: 7, auth: AUTH7 });
    expect(run).toHaveBeenCalledTimes(1); // only the new read ran; nothing was re-read
    // The controller moves first, knows it is continuing, and sees the old evidence.
    const control = ai.mock.calls[0][1];
    expect(control.promptKey).toBe('assistant_investigate');
    const budget = JSON.parse(/<investigation_budget[^>]*>\n([\s\S]*?)\n<\/investigation_budget>/.exec(control.userInput)[1]);
    expect(budget).toMatchObject({ round: 3, remaining_rounds: svc.MAX_INVESTIGATION_ROUNDS, remaining_steps: svc.MAX_INVESTIGATION_STEPS,
      continuation: { grant: 1, resumed_after_round: 3, prior_stop_reason: 'round_budget' } });
    expect(control.userInput).toMatch(/Person 1/);
    expect(out.steps.map((s) => [s.id, s.round])).toEqual([['q1', 1], ['q2', 2], ['q3', 3], ['q4', 4]]);
    expect(out.sources.map((s) => s.query_id)).toEqual(['q1', 'q4']);
    expect(out.investigation).toMatchObject({ rounds: 4, total_steps: 4, grants: 1, stop_reason: 'model_finished', continuable: false,
      segment: { rounds: 1, steps: 1, rows: 1 } });
    const answerCall = ai.mock.calls.find((c) => c[1].promptKey === 'assistant_answer')[1];
    expect(answerCall.userInput).toMatch(/"continuation_grants":1/);
    // Cost visibility is cumulative across grants.
    expect(out.investigation.approx_cost_cents).toBeGreaterThan(first.investigation.approx_cost_cents);
  });

  test('every grant is a full budget: a continuation can itself stop on a budget and be continued again', async () => {
    const first = await firstSegment();
    rows();
    scriptAi({ investigate: [query(4), query(5), query(6)], answer: [answerOf('Still going.')] });
    const second = await svc.execute(fakeDb({ chats: { 41: 7 } }), { continuation: first.continuation, chatId: 41, userId: 7, auth: AUTH7 });
    expect(second.investigation).toMatchObject({ rounds: 6, stop_reason: 'round_budget', continuable: true, grants: 1 });
    rows();
    scriptAi({ investigate: [finish], answer: [answerOf('Done.')] });
    const third = await svc.execute(fakeDb({ chats: { 41: 7 } }), { continuation: second.continuation, chatId: 41, userId: 7, auth: AUTH7 });
    expect(third.investigation).toMatchObject({ rounds: 6, grants: 2, stop_reason: 'model_finished' });
  });

  test('an operation already run in an earlier grant is never run again', async () => {
    const first = await firstSegment();
    const run = rows();
    scriptAi({ investigate: [query(2)], answer: [answerOf('Nothing new.')] });
    const out = await svc.execute(fakeDb({ chats: { 41: 7 } }), { continuation: first.continuation, chatId: 41, userId: 7, auth: AUTH7 });
    expect(run).not.toHaveBeenCalled();
    expect(out.investigation).toMatchObject({ stop_reason: 'repeated_query', total_steps: 3 });
  });

  test('steps a budget left unrun are run first, without re-asking the controller', async () => {
    rows();
    const big = Array.from({ length: 4 }, (_, i) => sql(contactSql(20 + i), `q${i + 1}`));
    const firstSteps = Array.from({ length: 5 }, (_, i) => sql(contactSql(10 + i), `q${i + 1}`));
    scriptAi({ investigate: [{ ok: true, json: { action: 'query', summary: 'Too many for the rest', steps: big } }], answer: [answerOf('Step limit.')] });
    const first = await svc.execute(fakeDb(), { signedTicket: planTicket(7, firstSteps), userId: 7, auth: AUTH7 });
    expect(first.investigation).toMatchObject({ stop_reason: 'step_budget', total_steps: 5, continuable: true });
    jest.restoreAllMocks();
    const run = rows();
    const ai = scriptAi({ investigate: [finish], answer: [answerOf('All nine read.')] });
    const out = await svc.execute(fakeDb(), { continuation: first.continuation, userId: 7, auth: AUTH7 });
    expect(run).toHaveBeenCalledTimes(4);
    expect(ai.mock.calls[0][1].promptKey).toBe('assistant_investigate'); // only AFTER the pending round
    expect(out.steps.slice(5).map((s) => s.id)).toEqual(['q6', 'q7', 'q8', 'q9']);
    expect(run.mock.calls[0][1].sql).toMatch(/contact_id = 20/);
  });

  test('the evidence ceiling grows with each grant', async () => {
    const wide = (n, count) => Array.from({ length: count }, (_, i) => ({ contact_id: n * 100 + i, note: 'x'.repeat(2500) }));
    jest.spyOn(reportService, 'execute').mockResolvedValueOnce({ rows: wide(1, 20), rowCount: 20, truncated: false });
    scriptAi({ investigate: [{ ok: false, error: 'json_parse', stopReason: 'max_tokens' }], answer: [answerOf('Partial.')] });
    const first = await svc.execute(fakeDb(), { signedTicket: planTicket(), userId: 7, auth: AUTH7 });
    expect(first.continuation).toBeTruthy();
    jest.restoreAllMocks();
    jest.spyOn(reportService, 'execute').mockResolvedValueOnce({ rows: wide(2, 12), rowCount: 12, truncated: false });
    scriptAi({ investigate: [query(2), finish], answer: [answerOf('More.')] });
    const out = await svc.execute(fakeDb(), { continuation: first.continuation, userId: 7, auth: AUTH7 });
    // ~80k characters of evidence: over one grant's 60k, inside two grants' 120k.
    expect(out.steps.map((s) => [s.id, s.returned, s.truncated])).toEqual([['q1', 20, false], ['q2', 12, false]]);
    expect(svc.MAX_CONTINUED_EVIDENCE_CHARS).toBeGreaterThan(2 * svc.MAX_EVIDENCE_CHARS);
  });

  test('a continuation round still passes the read validator (no PII read slips in)', async () => {
    const first = await firstSegment();
    const run = rows();
    scriptAi({ investigate: [{ ok: true, json: { action: 'query', summary: 'SSN', steps: [sql('SELECT contact_id, contact_ssn FROM contacts LIMIT 5')] } }],
      answer: [answerOf('Refused read.')] });
    const out = await svc.execute(fakeDb({ chats: { 41: 7 } }), { continuation: first.continuation, chatId: 41, userId: 7, auth: AUTH7 });
    expect(run).not.toHaveBeenCalled();
    expect(out.investigation.stop_reason).toBe('model_finished');
  });

  test('a continuation counts against the firm monthly spend cap', async () => {
    const first = await firstSegment();
    const ai = scriptAi();
    await expect(svc.execute(fakeDb({ chats: { 41: 7 }, mtd: 999999 }), { continuation: first.continuation, chatId: 41, userId: 7, auth: AUTH7 }))
      .rejects.toMatchObject({ status: 429 });
    expect(ai).not.toHaveBeenCalled();
  });
});

describe('security bindings: refused before any model call or read', () => {
  async function refused(promise, status, pattern, detail) {
    const ai = jest.spyOn(aiService, 'call');
    const run = jest.spyOn(reportService, 'execute');
    await expect(promise).rejects.toMatchObject({ status, message: expect.stringMatching(pattern), ...(detail ? { detail } : {}) });
    expect(ai).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  }

  test('forged evidence: a state sealed under any other key is refused', async () => {
    const first = await firstSegment();
    const real = continuation.open(first.continuation);
    process.env.JWT_SECRET = 'attacker-guess';
    const forged = continuation.seal({ ...real, evidence: [{ id: 'q1', kind: 'sql.read', purpose: 'forged', row_count: 1, truncated: false,
      round: 1, rows: [{ contact_id: '999', contact_name: 'Anyone' }] }] });
    process.env.JWT_SECRET = SECRET;
    await refused(svc.execute(fakeDb({ chats: { 41: 7 } }), { continuation: forged, chatId: 41, userId: 7, auth: AUTH7 }), 400, /can no longer be continued/, 'bad seal');
  });

  test('a tampered token (one byte of the sealed body) is refused', async () => {
    const first = await firstSegment();
    const parts = first.continuation.split('.');
    const body = parts[2];
    parts[2] = `${body.slice(0, 10)}${body[10] === 'A' ? 'B' : 'A'}${body.slice(11)}`;
    await refused(svc.execute(fakeDb({ chats: { 41: 7 } }), { continuation: parts.join('.'), chatId: 41, userId: 7, auth: AUTH7 }), 400, /can no longer be continued/, 'bad seal');
  });

  test('a plan ticket cannot be spent as a continuation', async () => {
    await refused(svc.execute(fakeDb(), { continuation: planTicket(), userId: 7, auth: AUTH7 }), 400, /can no longer be continued/);
  });

  test("another user's continuation is refused", async () => {
    const first = await firstSegment(null);
    await refused(svc.execute(fakeDb(), { continuation: first.continuation, userId: 8, auth: { type: 'jwt', userId: 8 } }), 403, /^This investigation belongs to a different signed-in user$/);
  });

  test("another user's continuation is refused even when they name the bound chat", async () => {
    const first = await firstSegment();
    await refused(svc.execute(fakeDb({ chats: { 41: 7 } }), { continuation: first.continuation, chatId: 41, userId: 8, auth: { type: 'jwt', userId: 8 } }), 404, /Chat not found/);
  });

  test('a continuation spent in a different chat of the same user is refused', async () => {
    const first = await firstSegment();
    await refused(svc.execute(fakeDb({ chats: { 41: 7, 42: 7 } }), { continuation: first.continuation, chatId: 42, userId: 7, auth: AUTH7 }), 403, /different chat/);
  });

  test('a chat-bound continuation spent with no chat named is refused', async () => {
    const first = await firstSegment();
    await refused(svc.execute(fakeDb({ chats: { 41: 7 } }), { continuation: first.continuation, userId: 7, auth: AUTH7 }), 403, /different chat/);
  });

  test('the bound chat must still be the caller\'s (deleted chat)', async () => {
    const first = await firstSegment();
    await refused(svc.execute(fakeDb({ chats: {} }), { continuation: first.continuation, chatId: 41, userId: 7, auth: AUTH7 }), 404, /Chat not found/);
  });

  test('an initial execute naming a chat that is not the caller\'s is refused', async () => {
    await refused(svc.execute(fakeDb({ chats: { 41: 8 } }), { signedTicket: planTicket(), chatId: 41, userId: 7, auth: AUTH7 }), 404, /Chat not found/);
  });

  test('an expired continuation is refused (15 minutes, the action-card freshness window)', async () => {
    const first = await firstSegment();
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + continuation.DEFAULT_TTL_MS + 1000);
    await refused(svc.execute(fakeDb({ chats: { 41: 7 } }), { continuation: first.continuation, chatId: 41, userId: 7, auth: AUTH7 }), 400, /can no longer be continued/);
  });

  test('a ticket and a continuation together are refused', async () => {
    const first = await firstSegment(null);
    await refused(svc.execute(fakeDb(), { signedTicket: planTicket(), continuation: first.continuation, userId: 7, auth: AUTH7 }), 400, /not both/);
  });
});

describe('route wiring', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'api.assistant.js'), 'utf8');
  const handler = route.slice(route.indexOf("router.post('/api/assistant/execute'"), route.indexOf("router.get('/api/assistant/chats'"));

  test('the continuation rides the execute route: same per-user rate limit, same ledger issue', () => {
    expect(handler).toMatch(/executeLimited\(`u\$\{req\.auth\.userId\}`\)/);
    expect(handler).toMatch(/continuation: req\.body && req\.body\.continuation/);
    expect(handler).toMatch(/chatId: req\.body && req\.body\.chat_id/);
    expect(handler).toMatch(/ledger\.issue/);
  });

  test('the route never reads evidence or plans from the request body', () => {
    expect(handler).not.toMatch(/req\.body(?:\s*&&\s*req\.body)?\.(?:evidence|plans|seen|pending)/);
  });
});

describe('the prompts are taught the continuation', () => {
  const prompts = require('../lib/aiPrompts');
  test('answer: name the budget, never present starved work as complete, point at Keep going', () => {
    const system = prompts.getPrompt('assistant_answer').system;
    expect(system).toMatch(/say in one plain sentence WHICH budget stopped the work/);
    expect(system).toMatch(/never present a budget-starved answer as\s+complete/);
    expect(system).toMatch(/keep_going_offered is true[\s\S]*Keep going button/);
    expect(system).toMatch(/continuation_grants above 0[\s\S]*citations may point to rows from any pass/);
  });
  test('investigate: a continuation round is round N+1 of the same investigation', () => {
    const system = prompts.getPrompt('assistant_investigate').system;
    expect(system).toMatch(/carries "continuation"[\s\S]*round round\+1 of the SAME investigation[\s\S]*never restart it/);
  });
  test('plan: broad questions are not refused or shrunk for fear of the budget', () => {
    expect(prompts.getPrompt('assistant_plan').system).toMatch(/the user can grant more \("Keep going"\)[\s\S]*never refuse or shrink/);
  });
});
