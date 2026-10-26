'use strict';
/**
 * tests/triggerCodeGate.routes.test.js
 *
 * Trigger rule CODE bodies are gated on automations.manage
 * (lib/triggerCodeGate.js).
 *
 * WHY THIS SUITE EXISTS: a trigger rule's code match / code transform runs IN
 * THIS PROCESS under node:vm (triggerService._runCode), and vm is not a
 * boundary — `input` is a host object, so the constructor walk-back reaches
 * the real `process` and process.env (DB credentials, JWT_SECRET,
 * CREDENTIALS_ENCRYPTION_KEY). Every trigger route was plain jwtOrApiKey, so
 * any staff JWT could POST a code transform to /api/triggers/test-draft and
 * read process.env back in the response, or save one that runs on every
 * domain event. The admin cases below run that exact walk-back and get the
 * host's `process` — the hole is real, not theoretical. A gate on one writer
 * is a gate on none (scheduledJobs.codeGate.test.js), so every code-accepting
 * route is here.
 *
 * HARNESS (mirrors tests/ingestCodeGate.routes.test.js): the REAL router and
 * service on an ephemeral socket. Only jwtOrApiKey is mocked (to set
 * req.auth). req.db is a scripted stub that serves the rows the routes read
 * and RECORDS every statement, so a refusal proves "nothing written".
 * "Nothing executed" is proven directly: the code bodies walk out of the vm to
 * the host global and bump a counter there, which a refused request must leave
 * untouched and an allowed one must bump. No route exercised here dispatches
 * an action; the dispatch modules are mocked to FAIL the suite if anything
 * ever reaches them (the .env these suites load points at production).
 */

process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY || 'x'.repeat(64);

let mockAuth = null;
jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = mockAuth; next(); }));

// Any touch of a dispatcher is a test failure: nothing here may dispatch.
const mockDispatchTouches = [];
jest.mock('../lib/actionDispatchers', () => new Proxy({}, {
  get(_t, k) {
    if (k === '__esModule' || typeof k === 'symbol') return undefined;
    return (...args) => { mockDispatchTouches.push(String(k)); throw new Error(`dispatch reached in test: ${String(k)}`); };
  },
}));
jest.mock('../services/hookService', () => ({
  executeHook: jest.fn(async () => { mockDispatchTouches.push('hookService.executeHook'); throw new Error('hook reached in test'); }),
}));

const http = require('http');
const express = require('express');

const STAFF = { type: 'jwt', userId: 2, username: 'staff', roles: ['staff'] };
const ADMIN = { type: 'jwt', userId: 1, username: 'admin', roles: ['admin', 'staff', 'attorney'] };
const IT    = { type: 'jwt', userId: 6, username: 'it', roles: ['it'] };
const LEGACY_KEY = { type: 'api_key', scopes: null };
const ROUTE_KEY  = { type: 'api_key', scopes: ['route:/mailbox-ingest'] };

const HIT = '__triggerCodeGateHit';
// Walks out of the vm to the HOST global (the escape this gate exists for),
// so the counter lives where the test can read it.
const BUMP = `var __g = input.constructor.constructor("return globalThis")(); __g.${HIT} = (__g.${HIT} || 0) + 1;`;
const MATCH_CODE = { code: `${BUMP} return true;` };
const TRANSFORM_CODE = { code: `${BUMP} return { leaked: typeof input.constructor.constructor("return process")() };` };
const COND = { operator: 'and', conditions: [{ path: 'data.stage', op: 'equals', value: 'filed' }] };
const MAPPER = [{ from: 'data.stage', to: 'stage' }];
const ENVELOPE = { event: 'case.stage_advanced', case_id: 'C1', data: { stage: 'filed' }, extra: {} };
const ACTIONS = [{ name: 'wf', action_type: 'workflow', config: { workflow_id: 7 }, position: 0 }];

const TS = new Date('2026-10-20T14:05:00Z');

// The stored rows the update route reads. Rule 1 is the live shape (6 rules:
// conditions match + code transform); rule 2 is plain conditions/passthrough;
// rule 3 is a code match.
function storedRule(id) {
  const base = {
    id, event_type: 'case.stage_advanced', name: `rule ${id}`, description: null, active: 1, position: 0,
    min_interval_s: 0, match_count: 0, last_matched_at: null, last_modified_by: 6,
    created_at: TS, updated_at: TS, error_count: 0, last_error_at: null,
  };
  if (id === 1) return { ...base, match_mode: 'conditions', match_config: COND, transform_mode: 'code', transform_config: { code: 'return input;' } };
  if (id === 3) return { ...base, match_mode: 'code', match_config: { code: 'return true;' }, transform_mode: 'passthrough', transform_config: null };
  return { ...base, match_mode: 'conditions', match_config: COND, transform_mode: 'passthrough', transform_config: null };
}

function scriptedDb() {
  const seen = [];
  const db = {
    seen,
    writes: () => seen.filter((s) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s.sql)),
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ');
      seen.push({ sql: String(sql), params });
      if (/^\s*INSERT/i.test(s)) return [{ insertId: 2, affectedRows: 1 }];
      if (/^\s*(UPDATE|DELETE)/i.test(s)) return [{ affectedRows: 1 }];
      if (/SELECT \* FROM trigger_rules WHERE id = \?/.test(s)) {
        const id = Number(params[0]);
        return [[id >= 1 && id <= 3 ? storedRule(id) : undefined].filter(Boolean)];
      }
      if (/FROM trigger_rule_actions/.test(s)) return [[]];
      if (/FROM trigger_rules WHERE active = 1 AND event_type = \?/.test(s)) return [[]];
      if (/FROM trigger_executions WHERE id = \?/.test(s)) return [[{ id: 55, envelope: ENVELOPE }]];
      throw new Error(`unscripted SQL: ${s}`);
    },
  };
  db.withTransaction = async (fn) => fn(db);
  return db;
}

async function send(method, urlPath, payload) {
  const db = scriptedDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use(require('../routes/api.triggers'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const data = JSON.stringify(payload);
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (r) => {
        let raw = '';
        r.on('data', (c) => { raw += c; });
        r.on('end', () => {
          let body = null;
          try { body = JSON.parse(raw || 'null'); } catch (_) { body = { __raw: raw }; }
          resolve({ status: r.statusCode, body });
        });
      });
      req.on('error', reject);
      req.end(data);
    });
    return { ...res, db };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const hits = () => globalThis[HIT] || 0;

function expectRefused(r) {
  expect(r.status).toBe(403);
  expect(r.body.status).toBe('error');
  expect(r.body.missingCapability).toBe('automations.manage');
  expect(r.body.error).toMatch(/automations\.manage/);
  expect(typeof r.body.message).toBe('string');
  expect(r.db.writes()).toEqual([]);
}

beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => { delete globalThis[HIT]; });
afterEach(() => { expect(mockDispatchTouches).toEqual([]); });

describe('POST /api/triggers/test-draft', () => {
  const codeTransform = { envelope: ENVELOPE, match_mode: 'conditions', match_config: COND,
    transform_mode: 'code', transform_config: TRANSFORM_CODE };
  const codeMatch = { envelope: ENVELOPE, match_mode: 'code', match_config: MATCH_CODE, transform_mode: 'passthrough' };

  test('staff + code transform or code match: 403 and the body never runs, nothing read', async () => {
    mockAuth = STAFF;
    for (const body of [codeTransform, codeMatch, { ...codeTransform, envelope: undefined, execution_id: 55 }]) {
      const r = await send('POST', '/api/triggers/test-draft', body);
      expectRefused(r);
      expect(r.db.seen).toEqual([]); // not even the execution-row fetch
    }
    expect(hits()).toBe(0);
  });

  test('admin + code transform: runs — and the walk-back reaches the host process (the hole)', async () => {
    mockAuth = ADMIN;
    const r = await send('POST', '/api/triggers/test-draft', codeTransform);
    expect(r.status).toBe(200);
    expect(r.body.result).toEqual({ matched: true, transform_ok: true, transformed: { leaked: 'object' } });
    expect(hits()).toBe(1);
    const m = await send('POST', '/api/triggers/test-draft', codeMatch);
    expect([m.status, m.body.result.matched]).toEqual([200, true]);
    expect(hits()).toBe(2);
  });

  test('it role and a NULL-scopes machine key hold it; a route-scoped key does not', async () => {
    for (const [auth, status] of [[IT, 200], [LEGACY_KEY, 200], [ROUTE_KEY, 403]]) {
      mockAuth = auth;
      const r = await send('POST', '/api/triggers/test-draft', codeTransform);
      expect([auth, r.status]).toEqual([auth, status]);
    }
    expect(hits()).toBe(2);
  });

  test('staff + conditions / mapper / passthrough: not gated', async () => {
    mockAuth = STAFF;
    const m = await send('POST', '/api/triggers/test-draft',
      { envelope: ENVELOPE, match_mode: 'conditions', match_config: COND, transform_mode: 'mapper', transform_config: MAPPER });
    expect(m.status).toBe(200);
    expect(m.body.result).toEqual({ matched: true, transform_ok: true, transformed: { stage: 'filed' } });
    const p = await send('POST', '/api/triggers/test-draft',
      { execution_id: 55, match_mode: 'conditions', match_config: COND, transform_mode: 'passthrough', transform_config: null });
    expect(p.status).toBe(200);
    expect(p.body.result.matched).toBe(true);
  });

  test('fails closed: an absent, falsy, case-variant, array or unknown mode on EITHER side is gated for staff', async () => {
    const bodies = [
      { envelope: ENVELOPE },                                                                   // both absent
      { envelope: ENVELOPE, match_mode: 'conditions', match_config: COND },                    // transform absent
      { envelope: ENVELOPE, transform_mode: 'passthrough' },                                   // match absent
      { envelope: ENVELOPE, match_mode: '', transform_mode: 'passthrough' },
      { envelope: ENVELOPE, match_mode: 'Code', match_config: MATCH_CODE, transform_mode: 'passthrough' },
      { envelope: ENVELOPE, match_mode: ['code'], match_config: MATCH_CODE, transform_mode: 'passthrough' },
      { envelope: ENVELOPE, match_mode: 'conditions', match_config: COND, transform_mode: 'CODE', transform_config: TRANSFORM_CODE },
      { envelope: ENVELOPE, match_mode: 'regex', match_config: {}, transform_mode: 'xslt' },
    ];
    for (const body of bodies) {
      mockAuth = STAFF;
      expectRefused(await send('POST', '/api/triggers/test-draft', body));
      mockAuth = ADMIN; // past the gate: a result, never a code run
      expect((await send('POST', '/api/triggers/test-draft', body)).status).toBe(200);
    }
    expect(hits()).toBe(0);
  });
});

describe('POST /api/triggers/rules (create)', () => {
  const base = { event_type: 'case.stage_advanced', name: 'x', actions: ACTIONS };

  test('staff + code match or code transform: 403, nothing written', async () => {
    mockAuth = STAFF;
    expectRefused(await send('POST', '/api/triggers/rules', { ...base, match_mode: 'code', match_config: MATCH_CODE }));
    expectRefused(await send('POST', '/api/triggers/rules',
      { ...base, match_mode: 'conditions', match_config: COND, transform_mode: 'code', transform_config: TRANSFORM_CODE }));
  });

  test('admin + code: created', async () => {
    mockAuth = ADMIN;
    const r = await send('POST', '/api/triggers/rules',
      { ...base, match_mode: 'conditions', match_config: COND, transform_mode: 'code', transform_config: TRANSFORM_CODE });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('success');
    expect(r.db.writes().filter((w) => /^\s*INSERT INTO trigger_rules\b/.test(w.sql))).toHaveLength(1);
  });

  test('staff + conditions/mapper: created; absent transform_mode = passthrough, not code', async () => {
    mockAuth = STAFF;
    const r = await send('POST', '/api/triggers/rules',
      { ...base, match_mode: 'conditions', match_config: COND, transform_mode: 'mapper', transform_config: MAPPER });
    expect(r.status).toBe(200);
    const a = await send('POST', '/api/triggers/rules', { ...base, match_mode: 'conditions', match_config: COND });
    expect(a.status).toBe(200);
    const bare = await send('POST', '/api/triggers/rules', base); // neither side touched
    expect(bare.status).toBe(200);
  });

  test('fails closed: a code-shaped config under a non-code mode is gated', async () => {
    mockAuth = STAFF;
    expectRefused(await send('POST', '/api/triggers/rules',
      { ...base, match_mode: 'conditions', match_config: { ...COND, code: 'return true;' } }));
    expectRefused(await send('POST', '/api/triggers/rules',
      { ...base, match_mode: 'conditions', match_config: COND, transform_mode: 'mapper', transform_config: 'return {}' }));
    expectRefused(await send('POST', '/api/triggers/rules',
      { ...base, match_mode: 'conditions', match_config: COND, transform_config: { code: 'return {};' } })); // mode absent → passthrough, config code-shaped
    expectRefused(await send('POST', '/api/triggers/rules', { ...base, match_mode: 'Code', match_config: MATCH_CODE }));
  });

  test('fails closed: an absent or unknown mode with a config is gated (admin: created as conditions, or the validator 400s it)', async () => {
    mockAuth = STAFF;
    expectRefused(await send('POST', '/api/triggers/rules', { ...base, match_config: COND })); // createRule would default to conditions
    for (const body of [
      { ...base, match_mode: 'regex', match_config: COND },
      { ...base, match_mode: 'conditions', match_config: COND, transform_mode: 'xslt', transform_config: MAPPER },
      { ...base, match_mode: null, match_config: COND },
    ]) {
      mockAuth = STAFF;
      expectRefused(await send('POST', '/api/triggers/rules', body));
      mockAuth = ADMIN;
      expect((await send('POST', '/api/triggers/rules', body)).status).toBe(400);
    }
  });
});

describe('PUT /api/triggers/rules/:id (update)', () => {
  test('staff switching a rule to code, or editing code: 403, nothing written', async () => {
    mockAuth = STAFF;
    expectRefused(await send('PUT', '/api/triggers/rules/2', { transform_mode: 'code', transform_config: TRANSFORM_CODE }));
    expectRefused(await send('PUT', '/api/triggers/rules/2', { match_mode: 'code', match_config: MATCH_CODE }));
    // config-only edit of a rule whose STORED transform / match is code
    expectRefused(await send('PUT', '/api/triggers/rules/1', { transform_config: TRANSFORM_CODE }));
    expectRefused(await send('PUT', '/api/triggers/rules/3', { match_config: MATCH_CODE }));
  });

  test('fails closed on the STORED mode: a config-only edit of a code rule is gated even when the config is not code-shaped', async () => {
    mockAuth = STAFF;
    expectRefused(await send('PUT', '/api/triggers/rules/1', { transform_config: MAPPER }));
    expectRefused(await send('PUT', '/api/triggers/rules/3', { match_config: COND }));
    mockAuth = ADMIN; // past the gate the service writes it (it would run as empty code → non-match)
    expect((await send('PUT', '/api/triggers/rules/3', { match_config: COND })).status).toBe(200);
  });

  test('staff config-only edit with a code-shaped config on a non-code rule: 403 (the mode-flip race)', async () => {
    mockAuth = STAFF;
    expectRefused(await send('PUT', '/api/triggers/rules/2', { transform_config: { code: 'return {};' } }));
    expectRefused(await send('PUT', '/api/triggers/rules/2', { match_config: 'return true' }));
  });

  test('admin editing code: updated', async () => {
    mockAuth = ADMIN;
    const r = await send('PUT', '/api/triggers/rules/1', { transform_config: TRANSFORM_CODE });
    expect(r.status).toBe(200);
    expect(r.db.writes().filter((w) => /^\s*UPDATE trigger_rules\b/.test(w.sql))).toHaveLength(1);
    expect(hits()).toBe(0); // saving runs nothing
  });

  test('staff edit that leaves the code side untouched: allowed (name / active / actions on a code rule)', async () => {
    mockAuth = STAFF;
    const r = await send('PUT', '/api/triggers/rules/1', { name: 'renamed', active: 0, actions: ACTIONS });
    expect(r.status).toBe(200);
    expect(r.db.writes().filter((w) => /^\s*UPDATE trigger_rules\b/.test(w.sql))).toHaveLength(1);
  });

  test('staff re-sending the WHOLE code rule (the native editor\'s real payload): refused — documented interaction', async () => {
    mockAuth = STAFF;
    const rule = storedRule(1);
    expectRefused(await send('PUT', '/api/triggers/rules/1', {
      event_type: rule.event_type, name: 'renamed', description: null, active: 1, position: 0, min_interval_s: 0,
      match_mode: rule.match_mode, match_config: rule.match_config,
      transform_mode: rule.transform_mode, transform_config: rule.transform_config,
      actions: ACTIONS,
    }));
  });

  test('staff re-sending the WHOLE non-code rule (the native editor\'s real payload): allowed', async () => {
    mockAuth = STAFF;
    const rule = storedRule(2);
    const r = await send('PUT', '/api/triggers/rules/2', {
      event_type: rule.event_type, name: 'renamed', description: null, active: 1, position: 0, min_interval_s: 0,
      match_mode: 'conditions', match_config: COND, transform_mode: 'mapper', transform_config: MAPPER,
      actions: ACTIONS,
    });
    expect(r.status).toBe(200);
  });

  test('staff switching a code transform AWAY from code: allowed', async () => {
    mockAuth = STAFF;
    const r = await send('PUT', '/api/triggers/rules/1', { transform_mode: 'passthrough', transform_config: null });
    expect(r.status).toBe(200);
  });

  test('an unknown rule id is a 404 before any judgement (staff and admin alike)', async () => {
    for (const auth of [STAFF, ADMIN]) {
      mockAuth = auth;
      const r = await send('PUT', '/api/triggers/rules/99', { transform_mode: 'code', transform_config: TRANSFORM_CODE });
      expect(r.status).toBe(404);
      expect(r.db.writes()).toEqual([]);
    }
  });
});

describe('left open on purpose: routes that take no code body', () => {
  test('POST /api/triggers/test runs STORED rules only — a code body riding it is ignored', async () => {
    mockAuth = STAFF;
    const r = await send('POST', '/api/triggers/test', {
      event_type: 'case.stage_advanced', envelope: ENVELOPE,
      match_mode: 'code', match_config: MATCH_CODE, transform_mode: 'code', transform_config: TRANSFORM_CODE,
    });
    expect(r.status).toBe(200);
    expect(r.body.rules_evaluated).toBe(0);
    expect(hits()).toBe(0);
    expect(r.db.writes()).toEqual([]);
  });
});
