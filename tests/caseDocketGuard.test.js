/**
 * PATCH /api/cases/:id — the docket guard (2026-11-09).
 *
 * The generic case PATCH is the writer behind the Case Details forms, Casey's
 * case-fields card and every API caller. It stored a case_number /
 * case_number_full another case already held, and one over 20 characters cut
 * short under the relaxed sql_mode, answering 200 to both (pinned on a real
 * engine in tests/caseyCaseFields.mysql.test.js until this slice flipped it).
 * Now, when the body carries either docket column, the route refuses before
 * any write:
 *   - over 20 code points → 400, worded as /docket's width refusal;
 *   - a value another case holds in EITHER column → 409 {conflict}, through
 *     caseService.checkCaseNumberCollision (the docket route's own check),
 *     worded as /docket's collision refusal — one builder, so the two routes
 *     can never drift apart;
 *   - a null / '' (a clear) runs neither check; a body without a docket column
 *     never calls the collision check at all;
 *   - the body reaches updateCase exactly as sent (the guard rewrites nothing).
 * The adopt-only guard (refusing to REPLACE a number the case has) stays on
 * /docket alone — replacing is this route's job — so a replace with a free
 * number passes.
 *
 * The services are mocked here (the row types and the general_ci + PAD SPACE
 * equality are the real-engine twin's); this file pins the route's contract.
 */
'use strict';

const http = require('http');
const express = require('express');

jest.mock('../lib/auth.jwtOrApiKey', () => (req, res, next) => next());

const caseService = require('../services/caseService');

const CONFLICT = { case_id: 'OTHER001', case_number: '25-10001', case_number_full: '25-10001-abc', case_type: 'Bankruptcy' };

describe('PATCH /api/cases/:id docket guard', () => {
  let server; let base; let collision; let update; let dbCalls;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    dbCalls = [];
    // The docket route reads its target through req.db; the guard itself only reaches the service.
    app.use((req, _res, next) => {
      req.db = { query: async (sql, params) => { dbCalls.push([sql, params]); return [[{ case_id: 'CASE0001', case_number: null, case_number_full: null, case_type: 'Bankruptcy' }], []]; } };
      next();
    });
    app.use(require('../routes/api.cases'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  beforeEach(() => {
    dbCalls.length = 0;
    collision = jest.spyOn(caseService, 'checkCaseNumberCollision').mockResolvedValue(null);
    update = jest.spyOn(caseService, 'updateCase').mockResolvedValue({ case_id: 'CASE0001', updated_fields: ['case_number'], changes: {} });
  });
  afterEach(() => jest.restoreAllMocks());

  const patch = async (path, body) => {
    const r = await fetch(`${base}${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };

  test('a body without a docket column never reaches the collision check and writes as before', async () => {
    const r = await patch('/api/cases/CASE0001', { case_stage: 'Filed', case_notes: 'x' });
    expect(r.status).toBe(200);
    expect(collision).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0].slice(1, 3)).toEqual(['CASE0001', { case_stage: 'Filed', case_notes: 'x' }]);
  });

  test('a free number is checked against the other cases (only the columns sent, trimmed) and written exactly as sent', async () => {
    const r = await patch('/api/cases/CASE0001', { case_number: ' 25-10002 ', case_stage: 'Filed' });
    expect(r.status).toBe(200);
    expect(collision).toHaveBeenCalledTimes(1);
    expect(collision.mock.calls[0].slice(1)).toEqual(['CASE0001', { case_number: '25-10002' }]);
    expect(update.mock.calls[0][2]).toEqual({ case_number: ' 25-10002 ', case_stage: 'Filed' });
  });

  test('a number another case holds is refused with 409 {conflict} before any write — in either column', async () => {
    collision.mockResolvedValue(CONFLICT);
    for (const body of [{ case_number: '25-10001' }, { case_number_full: '25-10001-abc' }, { case_number: '25-1', case_number_full: '25-10001-abc' }]) {
      const r = await patch('/api/cases/CASE0001', body);
      expect(r).toEqual({ status: 409, body: { status: 'error', message: 'That docket already belongs to case OTHER001 (25-10001-abc).', conflict: CONFLICT } });
    }
    expect(update).not.toHaveBeenCalled();
    expect(collision).toHaveBeenCalledTimes(3);
    expect(collision.mock.calls[2].slice(1)).toEqual(['CASE0001', { case_number: '25-1', case_number_full: '25-10001-abc' }]);
  });

  test('the conflict label falls back to the short number, then the case id', async () => {
    collision.mockResolvedValue({ case_id: 'OTHER002', case_number: '25-7', case_number_full: null, case_type: null });
    expect((await patch('/api/cases/CASE0001', { case_number: '25-7' })).body.message).toBe('That docket already belongs to case OTHER002 (25-7).');
    collision.mockResolvedValue({ case_id: 'OTHER003', case_number: '', case_number_full: null, case_type: null });
    expect((await patch('/api/cases/CASE0001', { case_number: '25-8' })).body.message).toBe('That docket already belongs to case OTHER003 (OTHER003).');
  });

  test('over 20 code points is refused with 400 before the collision check; exactly 20 passes (code points, not UTF-16 units)', async () => {
    const r = await patch('/api/cases/CASE0001', { case_number: '1'.repeat(21), case_number_full: '2'.repeat(25) });
    expect(r).toEqual({ status: 400, body: { status: 'error', message: 'case_number is 21 characters, case_number_full is 25 characters — the column keeps 20' } });
    expect(collision).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    const ok = await patch('/api/cases/CASE0001', { case_number_full: '\u{1F4C4}'.repeat(20) });
    expect(ok.status).toBe(200);
    expect(collision).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  test('a clear (null or "") runs neither check and reaches updateCase untouched', async () => {
    for (const body of [{ case_number: null }, { case_number_full: '' }, { case_number: null, case_number_full: '  ' }]) {
      update.mockClear();
      const r = await patch('/api/cases/CASE0001', body);
      expect(r.status).toBe(200);
      expect(update.mock.calls[0][2]).toEqual(body);
    }
    expect(collision).not.toHaveBeenCalled();
  });

  test('a clear of one column beside a value in the other checks only the value', async () => {
    const r = await patch('/api/cases/CASE0001', { case_number: '25-10009', case_number_full: null });
    expect(r.status).toBe(200);
    expect(collision.mock.calls[0][2]).toEqual({ case_number: '25-10009', case_number_full: null });
  });

  test('the two routes refuse a collision in the same words', async () => {
    collision.mockResolvedValue(CONFLICT);
    const plain = await patch('/api/cases/CASE0001', { case_number: '25-10001' });
    const adopt = await patch('/api/cases/CASE0001/docket', { case_number: '25-10001' });
    expect(adopt.status).toBe(409);
    expect(adopt.body.message).toBe(plain.body.message);
    const wide = await patch('/api/cases/CASE0001', { case_number: '3'.repeat(21) });
    const wideAdopt = await patch('/api/cases/CASE0001/docket', { case_number: '3'.repeat(21) });
    expect([wide.status, wideAdopt.status]).toEqual([400, 400]);
    expect(wideAdopt.body.message).toBe(wide.body.message);
  });

  test('a collision check that throws is the route\'s 500, not a write', async () => {
    collision.mockRejectedValue(new Error('db down'));
    const r = await patch('/api/cases/CASE0001', { case_number: '25-10001' });
    expect(r.status).toBe(500);
    expect(update).not.toHaveBeenCalled();
  });
});
