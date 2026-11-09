'use strict';
/**
 * tests/caseyPipelineRead.test.js
 *
 * A9.2 — the typed read case.pipeline {case_id}: ONE case's resolved pipeline
 * (assistantService.casePipelineRead over caseService.getCase and
 * pipelineService.getPipeline with requirements — the case page's own GET
 * /api/cases/:id/pipeline?requirements=1).
 *
 * Pinned here (no database):
 *   1. the step validator takes ONE exact case_id; the fingerprint is per case;
 *   2. the executor runs the read and its rows reach the answer as citable
 *      evidence;
 *   3. the row cap (MAX_ROWS) is stated, never silent; a latest stage that is
 *      not on the resolved pipeline is said so; a non-404 failure of the
 *      pipeline read is the step's failure, never a "not found";
 *   4. THE PERMISSION POSTURE, behind the REAL lib/auth.jwtOrApiKey: the read
 *      rides POST /api/assistant/execute (jwtOrApiKey + staffOnly), the route
 *      it mirrors is GET /api/cases/:id/pipeline (jwtOrApiKey). Every caller
 *      the route refuses, the assistant refuses too; the assistant also
 *      refuses an API key the route admits — narrower, never wider;
 *
 * The A9 move's "not a stage" refusal pointing at the read is pinned in
 * tests/caseyPipeline.test.js (the refusal's own test).
 *
 * The resolver's statuses, both lanes, the projection, the phase mismatch, the
 * no-pipeline case and the 404 run on a real engine in
 * tests/caseyPipelineRead.mysql.test.js.
 *
 *   npx jest tests/caseyPipelineRead.test.js
 */

const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const caseService = require(path.join(REPO, 'services', 'caseService'));
const pipelineService = require(path.join(REPO, 'services', 'pipelineService'));
const { validateStep, stepFingerprint, casePipelineRead } = svc;

const CASE_ID = '7KQ2M9XA';
const CASE_ROW = { case_id: CASE_ID, case_number: '25-12345', case_number_full: null, case_type: 'Bankruptcy', case_subtype: 'Chapter 7',
  pipeline_phase: 'case', case_stage: 'Open', case_status: 'Docs requested', case_rec: '' };
const stage = (n, key, over = {}) => ({ stage_id: 100 + n, stage_key: key, stage_number: n, internal_label: key.toUpperCase(), client_label: null,
  case_stage: 'Open', is_terminal: 0, lane: 'main', default_rec: '', client_visible: 1, requirements: [], ...over });
const req = (key, over = {}) => ({ requirement_key: key, internal_label: key, client_label: null, client_visible: 1, required: 1, owner: 'client',
  kind: 'task', hint: null, status: 'upcoming', satisfied_at: null, detail: null, progress: null, override: null, ...over });

let spies = [];
function setup({ row = CASE_ROW, pipe }) {
  spies = [
    jest.spyOn(caseService, 'getCase').mockImplementation(async () => (row ? { case: { ...row } } : null)),
    jest.spyOn(pipelineService, 'getPipeline').mockImplementation(async (_db, id, opts) => {
      if (typeof pipe === 'function') return pipe(id, opts);
      return pipe;
    }),
  ];
}
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; });

describe('the step', () => {
  test('validateStep takes ONE exact case_id; the fingerprint is per case', () => {
    expect(validateStep({ id: 'q1', kind: 'case.pipeline', purpose: 'p', case_id: ` ${CASE_ID} ` }, 0))
      .toEqual({ id: 'q1', kind: 'case.pipeline', purpose: 'p', case_id: CASE_ID });
    for (const v of [undefined, '', 'bad id!', 42, 'x'.repeat(21)]) {
      expect(() => validateStep({ id: 'q1', kind: 'case.pipeline', purpose: 'p', case_id: v }, 0)).toThrow('Step q1 needs the case\'s exact case_id');
    }
    expect(stepFingerprint({ kind: 'case.pipeline', case_id: CASE_ID })).toBe(`case.pipeline:${CASE_ID}`);
    expect(() => svc.validatePlan({ action: 'query', steps: [
      { id: 'q1', kind: 'case.pipeline', purpose: 'a', case_id: CASE_ID }, { id: 'q2', kind: 'case.pipeline', purpose: 'b', case_id: CASE_ID }] }))
      .toThrow('A plan cannot repeat the same read operation');
  });
});

describe('the read', () => {
  test('asks the pipeline read for requirements, with the STORED case id', async () => {
    setup({ row: { ...CASE_ROW, case_id: 'ABC123' }, pipe: { template: null, current: null, history: [], upcoming: [], stages: [] } });
    await casePipelineRead({}, 'abc123');
    expect(caseService.getCase.mock.calls.map((c) => c.slice(1))).toEqual([['abc123']]);
    expect(pipelineService.getPipeline.mock.calls.map((c) => c.slice(1))).toEqual([['ABC123', { requirements: true }]]);
  });

  test('the row cap is stated, never silent', async () => {
    const stages = Array.from({ length: 12 }, (_, i) => stage(i + 1, `s${i + 1}`, { requirements: [req(`r${i}a`), req(`r${i}b`), req(`r${i}c`), req(`r${i}d`)] }));
    setup({ pipe: { template: { id: 2, name: 'Chapter 7', role: 'case', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' },
      current: null, history: [], upcoming: stages, stages } });
    const out = await casePipelineRead({}, CASE_ID);
    expect([out.truncated, out.rows.length, out.rows[0].stages, out.rows[0].requirements]).toEqual([true, 50, 12, 48]);
    expect(out.rows[0].note).toMatch(/ MORE ROWS than listed: 61 rows, the read returns 50\.$/);
    // Stage rows come before requirement rows, so a cut never drops a stage.
    expect(out.rows.slice(1, 13).every((r) => r.row_type === 'stage')).toBe(true);
  });

  test('exactly at the cap is not truncated', async () => {
    const stages = [stage(1, 'a', { requirements: Array.from({ length: 48 }, (_, i) => req(`r${i}`)) })];
    setup({ pipe: { template: { id: 2, name: 'P', role: 'case' }, current: null, history: [], upcoming: stages, stages } });
    const out = await casePipelineRead({}, CASE_ID);
    expect([out.truncated, out.rows.length]).toEqual([false, 50]);
    expect(out.rows[0].note).not.toContain('MORE ROWS');
  });

  test('a latest stage that is not on the resolved pipeline is said so; no stage row is current', async () => {
    const stages = [stage(1, 'retained'), stage(2, 'docs')];
    const cur = { stage_id: 9, stage_key: 'contract_sent', case_stage: 'Open', status_label: 'Contract sent', entered_at: new Date('2026-10-01T00:00:00Z'), entered_by: null, source: 'manual', note: null };
    setup({ pipe: { template: { id: 2, name: 'Chapter 7', role: 'case' }, current: cur, history: [cur], upcoming: stages, stages } });
    const out = await casePipelineRead({}, CASE_ID);
    expect(out.rows[0]).toMatchObject({ current_stage_key: 'contract_sent', current_stage_label: 'Contract sent', current_on_pipeline: 0,
      current_lane: null, current_stage_number: null, last_entered_by: null, next_main_stage_key: 'retained' });
    expect(out.rows[0].note).toContain('The case\'s latest stage, Contract sent (contract_sent), is not a stage of the Chapter 7 pipeline.');
    expect(out.rows.filter((r) => r.row_type === 'stage').map((r) => r.is_current)).toEqual([0, 0]);
  });

  test('no stage_id leaves the read: the cards name a stage by key or label', async () => {
    const stages = [stage(1, 'retained', { requirements: [req('fee')] })];
    setup({ pipe: { template: { id: 2, name: 'P', role: 'case' }, current: null, history: [], upcoming: stages, stages } });
    const out = await casePipelineRead({}, CASE_ID);
    expect(out.rows.some((r) => Object.prototype.hasOwnProperty.call(r, 'stage_id'))).toBe(false);
  });

  test('a gone case is the route\'s 404 wording; a 404 from the pipeline read too; any other failure is thrown', async () => {
    setup({ row: null, pipe: null });
    expect(await casePipelineRead({}, 'NOPE1234')).toEqual({ rows: [{ row_type: 'not_found', case_id: 'NOPE1234', note: 'Case NOPE1234 not found' }], truncated: false });
    expect(pipelineService.getPipeline).not.toHaveBeenCalled();
    spies.forEach((s) => s.mockRestore());
    setup({ pipe: () => { const e = new Error('Case 7KQ2M9XA not found'); e.status = 404; throw e; } });
    expect((await casePipelineRead({}, CASE_ID)).rows[0]).toMatchObject({ row_type: 'not_found', note: `Case ${CASE_ID} not found` });
    spies.forEach((s) => s.mockRestore());
    setup({ pipe: () => { throw new Error('connection lost'); } });
    await expect(casePipelineRead({}, CASE_ID)).rejects.toThrow('connection lost');
  });
});

describe('the read runs through the executor', () => {
  const aiService = require(path.join(REPO, 'services', 'aiService'));
  const assistantTicket = require(path.join(REPO, 'lib', 'assistantTicket'));
  test('a case.pipeline step reads the pipeline with requirements and its rows reach the answer as citable evidence', async () => {
    const old = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'casey-pipeline-read-test-secret';
    const stages = [stage(1, 'retained', { requirements: [req('fee', { status: 'na', override: { status: 'na', note: 'Paid', set_by: 6, at: new Date('2026-10-05T11:00:00Z') } })] }), stage(2, 'docs')];
    setup({ pipe: { template: { id: 2, name: 'Chapter 7', role: 'case' }, current: null, history: [], upcoming: stages, stages } });
    const db = { query: jest.fn(async (q) => {
      if (/FROM app_settings/.test(q)) return [[]];
      if (/FROM ai_calls/.test(q)) return [[{ c: 0 }]];
      throw new Error(`Unexpected SQL: ${q}`);
    }) };
    const plan = svc.validatePlan({ action: 'query', summary: 'Pipeline', steps: [
      { id: 'q1', kind: 'case.pipeline', purpose: 'The case\'s pipeline', case_id: CASE_ID }] });
    const signed = assistantTicket.sign({ v: 1, uid: 7, question: 'Where is the Smith case?', history: [], plan: { action: 'query', ...plan } });
    const answer = jest.spyOn(aiService, 'call').mockResolvedValue({ ok: true, callId: 3,
      json: { answer: 'Retainer fee marked N/A.', citations: [{ query_id: 'q1', row_number: 4, label: 'Fee step' }], suggestions: [] } });
    try {
      const out = await svc.execute(db, { signedTicket: signed, userId: 7, auth: { type: 'jwt', userId: 7 } });
      expect(pipelineService.getPipeline.mock.calls.map((c) => c.slice(1))).toEqual([[CASE_ID, { requirements: true }]]);
      expect(out.sources[0]).toMatchObject({ query_id: 'q1', row_number: 4,
        row: { row_type: 'requirement', case_id: CASE_ID, requirement_key: 'fee', status: 'na', override_status: 'na', override_note: 'Paid', override_at: '2026-10-05T11:00:00.000Z' } });
    } finally {
      answer.mockRestore();
      if (old === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = old;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The permission posture — the REAL routers behind the REAL jwtOrApiKey.
// ═══════════════════════════════════════════════════════════════════════════
describe('the permission posture: never wider than GET /api/cases/:id/pipeline', () => {
  const SECRET = 'casey-pipeline-read-posture-secret';
  const KEY = 'yci_test_internal_key_for_posture_only'; // secret-scan: allow
  const saved = {};
  beforeAll(() => {
    for (const k of ['JWT_SECRET', 'INTERNAL_API_KEY', 'JWT_VERSION']) saved[k] = process.env[k];
    process.env.JWT_SECRET = SECRET;
    process.env.INTERNAL_API_KEY = KEY;
    delete process.env.JWT_VERSION;
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  function app() {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.db = { query: async () => [[], []] }; next(); });
    a.use(require(path.join(REPO, 'routes', 'api.pipeline.js')));
    a.use(require(path.join(REPO, 'routes', 'api.assistant.js')));
    return a;
  }
  function call(a, method, urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
      const srv = http.createServer(a).listen(0, () => {
        const payload = method === 'GET' ? '' : '{}';
        const r = http.request({ port: srv.address().port, path: urlPath, method,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } }, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => { srv.close(); let body = {}; try { body = JSON.parse(data || '{}'); } catch (_) { body = { raw: data }; } resolve({ status: res.statusCode, body }); });
        });
        r.on('error', (e) => { srv.close(); reject(e); });
        r.setTimeout(10000, () => r.destroy(new Error('posture call timed out')));
        r.end(payload);
      });
    });
  }
  const token = (over = {}) => jwt.sign({ sub: 2, username: 'plain', user_type: 1, aud: 'staff', user_auth: 'authorized', roles: ['staff'], ...over }, SECRET, { expiresIn: '5m' });
  const both = async (headers) => {
    const a = app();
    const route = await call(a, 'GET', `/api/cases/${CASE_ID}/pipeline?requirements=1`, headers);
    const casey = await call(a, 'POST', '/api/assistant/execute', headers);
    return [route.status, casey.status, casey.body];
  };

  test.each([
    ['no credential', {}],
    ['a contact-audience token', { authorization: `Bearer ${token({ aud: 'contact' })}` }],
    ['a portal-shaped token (no user_auth)', { authorization: `Bearer ${token({ user_auth: undefined })}` }],
    ['a disabled staff token', { authorization: `Bearer ${token({ user_auth: 'disabled' })}` }],
    ['an unknown API key', { 'x-api-key': 'yci_not_the_key' }], // secret-scan: allow
  ])('%s: the route refuses it, and so does the assistant', async (_label, headers) => {
    const [route, casey] = await both(headers);
    expect([route, casey]).toEqual([401, 401]);
  });

  test('an API key the route admits is refused by the assistant (staff only)', async () => {
    const [route, casey, body] = await both({ 'x-api-key': KEY });
    expect(route).toBe(404); // past the gate: the stub db holds no case
    expect([casey, body.message]).toEqual([403, 'The assistant requires a signed-in staff user.']);
  });

  test('a signed-in staff token passes both gates', async () => {
    const [route, casey] = await both({ authorization: `Bearer ${token()}` });
    expect(route).toBe(404);
    expect([401, 403]).not.toContain(casey);
  });
});

