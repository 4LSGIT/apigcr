/**
 * The docket guard on the generic case writers (2026-11-09):
 * caseService.docketWriteRefusal, run by PATCH /api/cases/:id and by the
 * automation `update_case` function.
 *
 * The generic case PATCH is the writer behind the Case Details forms, Casey's
 * case-fields card and every API caller; update_case is the workflow /
 * sequence step's. Both stored a case_number / case_number_full another case
 * already held, and one over 20 characters cut short under the relaxed
 * sql_mode, answering success to both (pinned on a real engine in
 * tests/caseyCaseFields.mysql.test.js until this slice flipped it). Now, when
 * the write carries either docket column, both refuse before any write:
 *   - over 20 code points → the route's 400 / the step's DOCKET_WIDTH error,
 *     worded as /docket's width refusal;
 *   - a value another case holds in EITHER column → the route's 409 {conflict}
 *     / the step's DOCKET_COLLISION error carrying err.conflict, through
 *     caseService.checkCaseNumberCollision (the docket route's own check),
 *     worded as /docket's collision refusal — one builder, so the writers can
 *     never drift apart;
 *   - a null / '' (a clear) runs neither check; a write without a docket
 *     column never runs the collision SELECT at all;
 *   - the fields reach updateCase exactly as given (the guard rewrites nothing).
 * The adopt-only guard (refusing to REPLACE a number the case has) stays on
 * /docket alone — replacing is the generic writers' job — so a replace with a
 * free number passes.
 *
 * The db is a stub dispatching on SQL text (the collision SELECT is answered
 * from `held`; its parameters are asserted); updateCase is spied so nothing is
 * written. The row types and the general_ci + PAD SPACE equality are the
 * real-engine twin's; this file pins the contract.
 */
'use strict';

const http = require('http');
const express = require('express');

jest.mock('../lib/auth.jwtOrApiKey', () => (req, res, next) => next());

const caseService = require('../services/caseService');
const caseFns = require('../lib/internal_functions/cases');

const CONFLICT = { case_id: 'OTHER001', case_number: '25-10001', case_number_full: '25-10001-abc', case_type: 'Bankruptcy' };
const TARGET = { case_id: 'CASE0001', case_number: null, case_number_full: null, case_type: 'Bankruptcy' };
const COLLISION_SQL = /FROM cases\s+WHERE case_id <> \?/;

// held: the row the collision SELECT returns (null = the number is free).
function stubDb() {
  const db = { held: null, collisionCalls: [] };
  db.query = async (sql, params) => {
    if (COLLISION_SQL.test(sql)) { db.collisionCalls.push(params); return [db.held ? [db.held] : [], []]; }
    if (/^\s*SELECT \* FROM cases WHERE case_id = \?/.test(sql)) return [[{ ...TARGET, case_number: '25-10000' }], []];
    return [[TARGET], []];
  };
  return db;
}

describe('PATCH /api/cases/:id docket guard', () => {
  let server; let base; let db; let update;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = db; next(); });
    app.use(require('../routes/api.cases'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  beforeEach(() => {
    db = stubDb();
    update = jest.spyOn(caseService, 'updateCase').mockResolvedValue({ case_id: 'CASE0001', updated_fields: ['case_number'], changes: {} });
  });
  afterEach(() => jest.restoreAllMocks());

  const patch = async (path, body) => {
    const r = await fetch(`${base}${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };

  test('a body without a docket column never runs the collision SELECT and writes as before', async () => {
    const r = await patch('/api/cases/CASE0001', { case_stage: 'Filed', case_notes: 'x' });
    expect(r.status).toBe(200);
    expect(db.collisionCalls).toEqual([]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0].slice(1, 3)).toEqual(['CASE0001', { case_stage: 'Filed', case_notes: 'x' }]);
  });

  test('a free number is checked against the OTHER cases (only the columns sent, trimmed) and written exactly as sent', async () => {
    const r = await patch('/api/cases/CASE0001', { case_number: ' 25-10002 ', case_stage: 'Filed' });
    expect(r.status).toBe(200);
    expect(db.collisionCalls).toEqual([['CASE0001', '25-10002', '25-10002']]);
    expect(update.mock.calls[0][2]).toEqual({ case_number: ' 25-10002 ', case_stage: 'Filed' });
  });

  test('a number another case holds is refused with 409 {conflict} before any write — in either column', async () => {
    db.held = CONFLICT;
    for (const body of [{ case_number: '25-10001' }, { case_number_full: '25-10001-abc' }, { case_number: '25-1', case_number_full: '25-10001-abc' }]) {
      const r = await patch('/api/cases/CASE0001', body);
      expect(r).toEqual({ status: 409, body: { status: 'error', message: 'That docket already belongs to case OTHER001 (25-10001-abc).', conflict: CONFLICT } });
    }
    expect(update).not.toHaveBeenCalled();
    expect(db.collisionCalls).toHaveLength(3);
    expect(db.collisionCalls[2]).toEqual(['CASE0001', '25-1', '25-10001-abc', '25-1', '25-10001-abc']);
  });

  test('the conflict label falls back to the short number, then the case id', async () => {
    db.held = { case_id: 'OTHER002', case_number: '25-7', case_number_full: null, case_type: null };
    expect((await patch('/api/cases/CASE0001', { case_number: '25-7' })).body.message).toBe('That docket already belongs to case OTHER002 (25-7).');
    db.held = { case_id: 'OTHER003', case_number: '', case_number_full: null, case_type: null };
    expect((await patch('/api/cases/CASE0001', { case_number: '25-8' })).body.message).toBe('That docket already belongs to case OTHER003 (OTHER003).');
  });

  test('over 20 code points is refused with 400 (no conflict key) before the collision SELECT; exactly 20 passes (code points, not UTF-16 units)', async () => {
    db.held = CONFLICT;
    const r = await patch('/api/cases/CASE0001', { case_number: '1'.repeat(21), case_number_full: '2'.repeat(25) });
    expect(r).toEqual({ status: 400, body: { status: 'error', message: 'case_number is 21 characters, case_number_full is 25 characters — the column keeps 20' } });
    expect(db.collisionCalls).toEqual([]);
    expect(update).not.toHaveBeenCalled();
    db.held = null;
    const ok = await patch('/api/cases/CASE0001', { case_number_full: '\u{1F4C4}'.repeat(20) });
    expect(ok.status).toBe(200);
    expect(db.collisionCalls).toHaveLength(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  test('a clear (null or "") runs neither check and reaches updateCase untouched', async () => {
    db.held = CONFLICT;
    for (const body of [{ case_number: null }, { case_number_full: '' }, { case_number: null, case_number_full: '  ' }]) {
      update.mockClear();
      const r = await patch('/api/cases/CASE0001', body);
      expect(r.status).toBe(200);
      expect(update.mock.calls[0][2]).toEqual(body);
    }
    expect(db.collisionCalls).toEqual([]);
  });

  test('a clear of one column beside a value in the other checks only the value', async () => {
    const r = await patch('/api/cases/CASE0001', { case_number: '25-10009', case_number_full: null });
    expect(r.status).toBe(200);
    expect(db.collisionCalls).toEqual([['CASE0001', '25-10009', '25-10009']]);
  });

  test('the two routes refuse a collision, and an over-width number, in the same words', async () => {
    db.held = CONFLICT;
    const plain = await patch('/api/cases/CASE0001', { case_number: '25-10001' });
    const adopt = await patch('/api/cases/CASE0001/docket', { case_number: '25-10001' });
    expect([plain.status, adopt.status]).toEqual([409, 409]);
    expect(adopt.body.message).toBe(plain.body.message);
    const wide = await patch('/api/cases/CASE0001', { case_number: '3'.repeat(21) });
    const wideAdopt = await patch('/api/cases/CASE0001/docket', { case_number: '3'.repeat(21) });
    expect([wide.status, wideAdopt.status]).toEqual([400, 400]);
    expect(wideAdopt.body.message).toBe(wide.body.message);
  });

  test('a collision SELECT that throws is the route\'s 500, not a write', async () => {
    db.query = async () => { throw new Error('db down'); };
    const r = await patch('/api/cases/CASE0001', { case_number: '25-10001' });
    expect(r.status).toBe(500);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('update_case (automation) docket guard', () => {
  let db; let update;
  beforeEach(() => {
    db = stubDb();
    update = jest.spyOn(caseService, 'updateCase').mockResolvedValue({ case_id: 'CASE0001', updated_fields: ['case_number'], changes: {} });
  });
  afterEach(() => jest.restoreAllMocks());

  test('a step carrying a number another case holds FAILS with DOCKET_COLLISION and the conflicting case; nothing is written', async () => {
    db.held = CONFLICT;
    let err;
    await caseFns.update_case({ case_id: 'CASE0001', fields: { case_number: '25-10001', case_stage: 'Filed' } }, db).catch((e) => { err = e; });
    expect(err).toBeInstanceOf(Error);
    expect([err.code, err.message, err.conflict]).toEqual(['DOCKET_COLLISION', 'update_case: That docket already belongs to case OTHER001 (25-10001-abc).', CONFLICT]);
    expect(update).not.toHaveBeenCalled();
    expect(db.collisionCalls).toEqual([['CASE0001', '25-10001', '25-10001']]);
  });

  test('a step carrying an over-width number FAILS with DOCKET_WIDTH before the collision SELECT; the full column counts too', async () => {
    db.held = CONFLICT;
    let err;
    await caseFns.update_case({ case_id: 7, fields: { case_number_full: 'x'.repeat(21) } }, db).catch((e) => { err = e; });
    expect([err && err.code, err && err.message, err && err.conflict]).toEqual(['DOCKET_WIDTH', 'update_case: case_number_full is 21 characters — the column keeps 20', undefined]);
    expect(db.collisionCalls).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  test('a free number writes through updateCase exactly as given; a clear and a non-docket write never run the SELECT', async () => {
    const out = await caseFns.update_case({ case_id: 'CASE0001', fields: { case_number: ' 25-10002 ' } }, db);
    expect(out).toEqual({ success: true, output: { case_id: 'CASE0001', updated_fields: ['case_number'] } });
    expect(update.mock.calls[0].slice(1, 4)).toEqual(['CASE0001', { case_number: ' 25-10002 ' }, { userId: 0, source: 'automation' }]);
    expect(db.collisionCalls).toEqual([['CASE0001', '25-10002', '25-10002']]);
    db.held = CONFLICT;
    await caseFns.update_case({ case_id: 'CASE0001', fields: { case_number: null, case_number_full: '' } }, db);
    await caseFns.update_case({ case_id: 'CASE0001', fields: { case_stage: 'Filed' } }, db);
    expect(db.collisionCalls).toHaveLength(1);
    expect(update).toHaveBeenCalledTimes(3);
  });

  test('the guard runs on the EFFECTIVE fields: a docket only_if_empty drops (the case already has one) is not checked', async () => {
    db.held = CONFLICT;
    const out = await caseFns.update_case({ case_id: 'CASE0001', fields: { case_number: '25-10001', case_stage: 'Filed' }, only_if_empty: ['case_number'] }, db);
    expect(out.output).toEqual({ case_id: 'CASE0001', updated_fields: ['case_number'], skipped_only_if_empty: ['case_number'] });
    expect(db.collisionCalls).toEqual([]);
    expect(update.mock.calls[0][2]).toEqual({ case_stage: 'Filed' });
  });
});
