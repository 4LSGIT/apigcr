// Casey v2 S3b-2 — services/casey/cards.js settleStep over a db STUB (the
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
