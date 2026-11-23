// Casey v2 S3b-2 / S3c — services/casey/cards.js settleStep and claimStep over a db STUB (the
// engine twin is gated; CI must still see the real site): the claim is checked
// FIRST, so a junk token costs one SELECT and never touches the result (review
// B1 — the route is open to every staff JWT); a good token redacts, cuts and
// writes the stored text; storedResult is the one function (the in-memory test
// store calls it, so it cannot drift from the real store).
'use strict';

jest.mock('../lib/caseyRedact', () => { const actual = jest.requireActual('../lib/caseyRedact'); return { ...actual, redact: jest.fn(actual.redact) }; });
const { redact } = require('../lib/caseyRedact');
const cards = require('../services/casey/cards');

function stubDb(claimed) {
  const queries = [];
  return { queries, query: jest.fn(async (sql, params) => {
    queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (/^SELECT 1 AS ok/.test(sql.trim())) return [claimed ? [{ ok: 1 }] : []];
    if (/^UPDATE casey_card_steps/.test(sql.trim())) return [{ affectedRows: 1 }];
    throw new Error('unexpected sql ' + sql);
  }) };
}
beforeEach(() => redact.mockClear());

test('a junk claim token: one SELECT bound to card / step / user / token, no UPDATE, the result never redacted (no CPU spent for a stranger)', async () => {
  const db = stubDb(false);
  const big = { pad: 'x'.repeat(100000), api_token: 'tokentokentoken' };
  expect(await cards.settleStep(db, 5, 6, 1, 'junk', { status: 'applied', httpStatus: 200, result: big })).toBe(false);
  expect(db.queries).toHaveLength(1);
  expect(db.queries[0].sql).toMatch(/^SELECT 1 AS ok FROM casey_card_steps s JOIN casey_cards c ON c\.id = s\.card_id WHERE s\.card_id = \? AND s\.step_no = \? AND c\.user_id = \? AND s\.status = 'claimed' AND s\.claim_token = \? LIMIT 1$/);
  expect(db.queries[0].params).toEqual([5, 1, 6, 'junk']);
  expect(redact).not.toHaveBeenCalled();
});

test('a good token: the SELECT, then the UPDATE whose result parameter is the REDACTED, cut text; storedResult is what both stores write', async () => {
  const db = stubDb(true);
  const result = { status: 'success', id: 77, action_token: 'tokTOKtokTOK99', action_url: 'https://app.test/t/tokTOKtokTOK99', pad: 'y'.repeat(cards.RESULT_MAX) };
  expect(await cards.settleStep(db, 5, 6, 1, 'good', { status: 'failed', httpStatus: 409, result })).toBe(true);
  expect(db.queries.map((q) => q.sql.split(' ')[0])).toEqual(['SELECT', 'UPDATE']);
  const [status, http, stored, cardId, step, user, token] = db.queries[1].params;
  expect([status, http, cardId, step, user, token]).toEqual(['failed', 409, 5, 1, 6, 'good']);
  expect(stored).toContain('"action_token":"[redacted]","action_url":"https://app.test/t/[redacted]"');
  expect(stored).not.toContain('tokTOKtokTOK99');
  expect(stored).toMatch(/…\[truncated: \d+ bytes, cap 16384\]$/);
  expect(stored).toBe(cards.storedResult(result));
  expect(redact).toHaveBeenCalledTimes(2);   // once in settleStep, once in the storedResult call above
  expect(cards.storedResult(undefined)).toBeNull();
  expect(cards.storedResult(null)).toBe('null');
  await expect(cards.settleStep(db, 5, 6, 1, 'good', { status: 'done', result: {} })).rejects.toThrow(/applied or failed/);
});

describe('S3c claimStep with a resolver (the real store over a stub)', () => {
  const card = (stepStatus) => ({ id: 5, chat_id: 1, user_id: 6, tool_use_id: 't', tier: 1, summary: 's', status: 'approved', decline_note: null, resumed_at: null, created_at: 'c' });
  const stepRows = (s2status) => [
    { id: 1, card_id: 5, step_no: 1, method: 'POST', path: '/api/tasks', body: '{"t":1}', path_sent: null, body_sent: null, tier: 1, purpose: 'p', status: 'applied', http_status: 200, result: '{"task_id":77}', idempotency_key: 'casey:5:1', claimed_at: 'a', settled_at: 'b' },
    { id: 2, card_id: 5, step_no: 2, method: 'PATCH', path: '/api/tasks/$1.task_id', body: '{"title":"$1.missing"}', path_sent: null, body_sent: null, tier: 1, purpose: 'q', status: s2status, http_status: null, result: null, idempotency_key: 'casey:5:2', claimed_at: null, settled_at: null },
  ];
  function claimDb(s2status) {
    const queries = []; let steps = stepRows(s2status);
    return { queries, steps: () => steps, query: jest.fn(async (sql, params) => {
      const q = sql.replace(/\s+/g, ' ').trim(); queries.push({ q, params });
      if (/^SELECT id, chat_id/.test(q)) return [[card()]];
      if (/^SELECT id, card_id, step_no/.test(q)) return [steps];
      if (/^UPDATE casey_card_steps s JOIN casey_cards c .* SET s\.status = 'failed'/.test(q)) { steps = steps.map((s) => (s.step_no === params[2] ? { ...s, status: 'failed', result: params[0] } : s)); return [{ affectedRows: 1 }]; }
      if (/^UPDATE casey_card_steps s JOIN casey_cards c .* SET s\.status = 'claimed'/.test(q)) { const t = steps.find((s) => s.step_no === params[4]); if (!t || t.status !== 'pending' || steps.some((s) => s.step_no < params[4] && s.status !== 'applied')) return [{ affectedRows: 0 }]; /* the fence: pending, and every earlier step applied */ steps = steps.map((s) => (s.step_no === params[4] ? { ...s, status: 'claimed', path_sent: params[1], body_sent: params[2] } : s)); return [{ affectedRows: 2 }]; }   // the fence: only a pending step claims
      throw new Error('unexpected sql ' + q);
    }) };
  }
  test('an unresolvable reference marks the step FAILED with UNRESOLVED before any claim; the resolver saw the earlier steps\' stored results', async () => {
    const db = claimDb('pending');
    const seen = [];
    const out = await cards.claimStep(db, 5, 6, 2, { resolve: async (step, earlier, c) => { seen.push({ step: step.step_no, earlier: [...earlier.entries()], tier: c.tier }); return { ok: false, ref: '$1.missing', reason: "step 1's result has no missing" }; } });
    expect(seen).toEqual([{ step: 2, earlier: [[1, { status: 'applied', result: { task_id: 77 } }]], tier: 1 }]);
    expect(out).toMatchObject({ outcome: 'unresolved', reason: "step 1's result has no missing", step: { step_no: 2, status: 'failed', result: { error: 'UNRESOLVED', ref: '$1.missing', reason: "step 1's result has no missing" } } });
    expect(db.queries.filter((x) => /SET s\.status = 'claimed'/.test(x.q))).toHaveLength(0);   // never claimed
    const failed = db.queries.find((x) => /SET s\.status = 'failed'/.test(x.q));
    expect(failed.params).toEqual([JSON.stringify({ error: 'UNRESOLVED', ref: '$1.missing', reason: "step 1's result has no missing" }), 5, 2, 6]);
  });
  test('a resolved reference is claimed with path_sent / body_sent in the SAME statement as the claim; a step without a reference claims with NULLs; a non-pending step is never resolved', async () => {
    const db = claimDb('pending');
    const out = await cards.claimStep(db, 5, 6, 2, { resolve: async () => ({ ok: true, path: '/api/tasks/77', body: '{"title":"T"}', route: '/api/tasks/:id(\\d+)' }) });
    expect(out).toMatchObject({ outcome: 'claimed', step: { step_no: 2, status: 'claimed', path: '/api/tasks/$1.task_id', path_sent: '/api/tasks/77', body: '{"title":"$1.missing"}', body_sent: '{"title":"T"}' } });
    const claim = db.queries.find((x) => /SET s\.status = 'claimed'/.test(x.q));
    expect(claim.q).toMatch(/s\.path_sent = \?, s\.body_sent = \?, c\.status = 'approved'/);
    expect(claim.params.slice(1, 3)).toEqual(['/api/tasks/77', '{"title":"T"}']);
    const db2 = claimDb('pending');
    const plain = await cards.claimStep(db2, 5, 6, 2, { resolve: async () => ({ ok: true, path: null, body: null, route: null }) });
    expect(db2.queries.find((x) => /SET s\.status = 'claimed'/.test(x.q)).params.slice(1, 3)).toEqual([null, null]);
    expect(plain.step).toMatchObject({ path_sent: null, body_sent: null });
    const db3 = claimDb('claimed'); const resolver = jest.fn();
    expect(await cards.claimStep(db3, 5, 6, 2, { resolve: resolver })).toMatchObject({ outcome: 'unknown' });
    expect(resolver).not.toHaveBeenCalled();
  });
  test('an out-of-order claim is answered out_of_order by the claim fence — the resolver never runs, so the step is not failed for a result that is not there yet (review S3)', async () => {
    const db = claimDb('pending');
    // step 1 is still pending: nothing earlier is applied
    const rows = db.steps(); rows[0].status = 'pending'; rows[0].result = null;
    const resolver = jest.fn(async () => ({ ok: false, ref: '$1.task_id', reason: 'would have failed the step' }));
    const out = await cards.claimStep(db, 5, 6, 2, { resolve: resolver });
    expect(resolver).not.toHaveBeenCalled();
    expect(out).toMatchObject({ outcome: 'out_of_order', step: { step_no: 2, status: 'pending' } });
    expect(db.queries.filter((x) => /SET s\.status = 'failed'/.test(x.q))).toHaveLength(0);
  });
});
