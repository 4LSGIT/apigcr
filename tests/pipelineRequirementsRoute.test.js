// tests/pipelineRequirementsRoute.test.js
//
// R3 — GET /api/cases/:id/pipeline/requirements (routes/api.pipeline.js) and
// the service function behind it (requirementService.getCaseRequirements).
//
// WHY THIS ROUTE EXISTS, AND THEREFORE WHAT THIS SUITE MUST PROVE
//
// getPipeline's payload is STAGE-ANCHORED: requirements attach to the stages
// of the RESOLVED template, so once a case is phase='case' the INTAKE
// template's work items have nowhere in that payload to live. The resolver has
// resolved them correctly since R2 — a filed case's intake questionnaire reads
// `done` (submitted in March) or `skipped` — but the behaviour was CORRECT AND
// UNOBSERVABLE. This route is the surface that makes it observable, and the
// first test below is that finding's pin: a case-phase case must return its
// intake rows, with their skipped/done states intact.
//
// It also pins the thing that made the service function necessary at all:
// resolveRequirements is BATCH-shaped and short-circuits to an empty map when
// nothing is authored, so `map.has(caseId)` cannot distinguish "no such case"
// from "no requirements yet". A route that inferred 404 from an absent key
// would 404 every real case in the firm until Fred authored a requirement.
// Hence the explicit case read — and hence the "real case, nothing authored →
// 200 []" test.
//
// The service function itself (getCaseRequirements — the existence check and
// the empty-vs-absent distinction) is pinned in tests/requirementService.test.js,
// alongside the resolver it wraps and against the REAL pipelineService whose
// _pickTemplate it reuses.
//
// DRIVEN OVER REAL HTTP (tests/portalDocsRoutes.js pattern): api.pipeline.js
// exports only the router, so mounting it in a real express app on an
// ephemeral port is the honest way to exercise the envelope, the status
// mapping and the query-param plumbing. jwtOrApiKey is mocked to a
// passthrough — its own semantics are covered elsewhere; what THIS route owns
// is that it mounts it at all, asserted below.
//
// Run:
//   npx jest tests/pipelineRequirementsRoute.test.js

'use strict';

jest.mock('../lib/auth.jwtOrApiKey', () => {
  const mw = jest.fn((req, res, next) => { req.auth = { userId: 7 }; next(); });
  return mw;
});
jest.mock('../services/pipelineService', () => ({
  getPipeline: jest.fn(),
  advanceStage: jest.fn(),
}));
jest.mock('../services/requirementService', () => ({
  resolveRequirements: jest.fn(),
  getCaseRequirements: jest.fn(),
  setOverride: jest.fn(),
  clearOverride: jest.fn(),
}));

const express = require('express');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const reqSvc = require('../services/requirementService');
const router = require('../routes/api.pipeline');

const DB = { marker: 'pool' };          // identity-checked, never queried

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = DB; next(); });
app.use(router);

let server, base;
beforeAll(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => jest.clearAllMocks());

const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
};

/** resolvedRequirement — requirementService's frozen shape. */
function req(over = {}) {
  return Object.assign({
    requirement_key: 'submit_questionnaire',
    stage_id: 2,
    stage_key: 'consult_booked',
    internal_label: 'Submit intake questionnaire',
    client_label: 'Complete your questionnaire',
    client_visible: 1,
    required: 1,
    owner: 'client',
    kind: 'task',
    hint: 'Initial Bankruptcy Questionnaire',
    effort: '~25 min',
    group_label: 'Intake',
    sort_order: 1,
    status: 'skipped',
    satisfied_at: null,
    detail: null,
    progress: null,
    override: null,
  }, over);
}

// ─────────────────────────────────────────────────────────────────────────────
// The route
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/cases/:id/pipeline/requirements', () => {
  test('THE F2 CASE: a phase-`case` case returns its INTAKE requirements, states intact', async () => {
    // Live shape (TYL6KJN8, 2026-08-27): a retained Ch 7 whose latest log row
    // is on template 2. Its three intake work items resolve done/skipped by
    // rule 3b and appear NOWHERE ELSE over HTTP.
    reqSvc.getCaseRequirements.mockResolvedValue([
      req({ requirement_key: 'submit_questionnaire', status: 'done',
            satisfied_at: '2026-03-04 15:00:00', detail: 'Submitted' }),
      req({ requirement_key: 'iss_held', kind: 'event', status: 'skipped', sort_order: 2 }),
      req({ requirement_key: 'sign_retainer', stage_id: 18, stage_key: 'contract_sent',
            status: 'done', satisfied_at: '2026-08-27 18:47:05', detail: 'Signed' }),
      req({ requirement_key: 'upload_docs', stage_id: 5, stage_key: 'docs',
            internal_label: 'Upload requested documents', status: 'active',
            group_label: 'Documents', progress: '4 of 7 received' }),
    ]);

    const { status, body } = await get('/api/cases/TYL6KJN8/pipeline/requirements');
    expect(status).toBe(200);
    expect(body.status).toBe('success');
    expect(body.requirements.map(r => [r.requirement_key, r.status])).toEqual([
      ['submit_questionnaire', 'done'],
      ['iss_held', 'skipped'],
      ['sign_retainer', 'done'],
      ['upload_docs', 'active'],
    ]);
    // The resolver's own fields ride through untouched — the route projects
    // nothing (that is the panel's job, and it needs detail/progress/override).
    expect(body.requirements[3].progress).toBe('4 of 7 received');
    expect(body.requirements[0].detail).toBe('Submitted');
  });

  test('default is the FULL set; ?client_only=1 passes the clientOnly opt through', async () => {
    reqSvc.getCaseRequirements.mockResolvedValue([]);

    await get('/api/cases/TYL6KJN8/pipeline/requirements');
    expect(reqSvc.getCaseRequirements).toHaveBeenLastCalledWith(
      DB, 'TYL6KJN8', { clientOnly: false });

    await get('/api/cases/TYL6KJN8/pipeline/requirements?client_only=1');
    expect(reqSvc.getCaseRequirements).toHaveBeenLastCalledWith(
      DB, 'TYL6KJN8', { clientOnly: true });

    await get('/api/cases/TYL6KJN8/pipeline/requirements?client_only=true');
    expect(reqSvc.getCaseRequirements).toHaveBeenLastCalledWith(
      DB, 'TYL6KJN8', { clientOnly: true });

    // Anything else is NOT truthy — same '1'|'true' gate the sibling
    // ?requirements= flag uses; no accidental opt-in from ?client_only=0.
    await get('/api/cases/TYL6KJN8/pipeline/requirements?client_only=0');
    expect(reqSvc.getCaseRequirements).toHaveBeenLastCalledWith(
      DB, 'TYL6KJN8', { clientOnly: false });
  });

  test('a real case with nothing authored → 200 and an EMPTY array, never 404', async () => {
    // The deploy gate: empty requirement tables must be a valid answer, not an
    // error. (This is exactly the case `map.has()` could not distinguish.)
    reqSvc.getCaseRequirements.mockResolvedValue([]);
    const { status, body } = await get('/api/cases/TYL6KJN8/pipeline/requirements');
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'success', requirements: [] });
  });

  test('unknown case → 404 with the service message (sibling convention)', async () => {
    const err = new Error('Case NOPE not found');
    err.status = 404;
    reqSvc.getCaseRequirements.mockRejectedValue(err);

    const { status, body } = await get('/api/cases/NOPE/pipeline/requirements');
    expect(status).toBe(404);
    expect(body).toEqual({ status: 'error', message: 'Case NOPE not found' });
  });

  test('an unflagged throw is a 500 (fail(), like every sibling route)', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    reqSvc.getCaseRequirements.mockRejectedValue(new Error('boom'));
    const { status, body } = await get('/api/cases/TYL6KJN8/pipeline/requirements');
    expect(status).toBe(500);
    expect(body.status).toBe('error');
    spy.mockRestore();
  });

  test('authed like its siblings — jwtOrApiKey runs on the way in', async () => {
    reqSvc.getCaseRequirements.mockResolvedValue([]);
    await get('/api/cases/TYL6KJN8/pipeline/requirements');
    expect(jwtOrApiKey).toHaveBeenCalled();
  });

  test('does NOT shadow the override sub-path (POST/DELETE .../:key/override)', async () => {
    // Express matches by full path shape, but the two routes share a prefix and
    // a regression here would silently break the panel's write path.
    reqSvc.setOverride.mockResolvedValue({ case_id: 'X', requirement_key: 'k', status: 'na', note: null });
    const res = await fetch(`${base}/api/cases/X/pipeline/requirements/k/override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'na' }),
    });
    expect(res.status).toBe(200);
    expect(reqSvc.setOverride).toHaveBeenCalled();
    expect(reqSvc.getCaseRequirements).not.toHaveBeenCalled();
  });
});
