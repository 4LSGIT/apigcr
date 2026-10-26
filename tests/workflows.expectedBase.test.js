/**
 * tests/workflows.expectedBase.test.js
 *
 * P11 (A17.4): the expected_base precondition on the step-mutating workflow
 * routes, and the save-time closures that landed with it.
 *
 * WHY THE PRECONDITION EXISTS
 * Steps are addressed by POSITION. A write prepared against a stale view of
 * the draft lands on whichever step now occupies the slot — the wf27 scar
 * (a "PUT 1–31, POST-append 32–39" script run against a 39-step base shipped
 * a duplicated block and a runaway loop). The precondition turns that into a
 * route property: the caller states the base it read (draft_version,
 * step_count, optionally the target step's content fingerprint) and the route
 * refuses with a structured 409 when the base no longer holds. Optional for
 * native callers — the editors are unchanged — and required on every Casey
 * step proposal.
 *
 * The fingerprint is lib/versionDiff.stepFingerprint: sha256 over canonical()
 * (keys sorted recursively), because MySQL re-orders JSON object keys on
 * write (the wf50 scar) so byte-comparison of what you sent never matches
 * what you read back.
 *
 * SAVE-TIME CLOSURES pinned here (P11, measured clean against live data
 * 2026-10-24 — nothing grandfathered):
 *   · unknown function_name → 400 (used to pass save, fail at run time);
 *   · params null/absent no longer skips required-param validation;
 *   · an undeclared param key → 400 (the engine ignores or overwrites it,
 *     so a typo'd name read as "ran but did nothing");
 *   · error_policy.strategy outside the engine's four values → 400 (the
 *     engine silently treats anything else as "ignore");
 *   · error_policy must be an object or null.
 *
 * HARNESS: the real router over a real ephemeral socket with a scripted db
 * (the tests/workflows.codeStepGate.test.js idiom). The db script holds a
 * concrete step table so count and fingerprint checks run against real rows.
 *
 *   npx jest tests/workflows.expectedBase.test.js
 */

const express = require('express');
const http = require('http');

let mockAuth = { type: 'jwt', userId: 1, roles: ['admin', 'staff'] };
jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = mockAuth; next(); }));

const { stepFingerprint } = require('../lib/versionDiff');

// ── A concrete workflow: id 5, published v1, draft v2 with three steps ───
const STEP_ROWS = [
  { step_number: 1, type: 'internal_function', label: 'find',
    config: { function_name: 'find_contact', params: { phone: '{{phone}}' } }, error_policy: null },
  { step_number: 2, type: 'internal_function', label: 'branch',
    config: { function_name: 'evaluate_condition', params: { variable: '{{this.found}}', operator: '==', value: 'true', then: 3 } },
    error_policy: { strategy: 'abort' } },
  { step_number: 3, type: 'internal_function', label: 'task',
    config: { function_name: 'create_task', params: { title: 'Call', description: 'Call them', assigned_to: 2, assigned_by: 2 } },
    error_policy: null },
];

function makeDb(state) {
  const rowsFor = (version) => (version === state.readVersion ? state.steps : []);
  const script = async (sql, params = []) => {
    if (/SELECT current_version, draft_version FROM workflows WHERE id = \? FOR UPDATE/.test(sql)) {
      state.lockReads++;
      return [[{ current_version: state.current_version, draft_version: state.draft_version }]];
    }
    if (/SELECT COUNT\(\*\) AS n FROM workflow_steps/.test(sql)) {
      return [[{ n: rowsFor(params[1]).length }]];
    }
    if (/SELECT type, config, error_policy, label, note FROM workflow_steps/.test(sql)) {
      const row = rowsFor(params[1]).find((r) => r.step_number === params[2]);
      return [row ? [{ type: row.type, config: JSON.stringify(row.config),
        error_policy: row.error_policy == null ? null : JSON.stringify(row.error_policy),
        label: row.label || null, note: row.note || null }] : []];
    }
    if (/SELECT id FROM workflow_steps WHERE workflow_id = \? AND version = \? AND step_number = \?/.test(sql)) {
      const row = rowsFor(params[1]).find((r) => r.step_number === params[2]);
      return [row ? [{ id: 900 + row.step_number }] : []];
    }
    if (/SELECT id, type, config FROM workflow_steps/.test(sql)) {
      const row = rowsFor(params[1]).find((r) => r.step_number === params[2]);
      return [row ? [{ id: 900 + row.step_number, type: row.type, config: JSON.stringify(row.config) }] : []];
    }
    if (/SELECT MAX\(step_number\) as max FROM workflow_steps/.test(sql)) {
      return [[{ max: rowsFor(params[1]).length }]];
    }
    if (/SELECT id, step_number, type, config FROM workflow_steps/.test(sql)) {
      return [rowsFor(params[1]).map((r) => ({ id: 900 + r.step_number, step_number: r.step_number, type: r.type, config: JSON.stringify(r.config) }))];
    }
    if (/^\s*UPDATE workflow_steps|^\s*INSERT INTO workflow_steps|^\s*DELETE FROM workflow_steps/.test(sql.trim())) {
      // ensureDraft's fork copies the published rows to the new draft version
      // (its number is the first param) — mirror that so later reads see them.
      if (/INSERT INTO workflow_steps[\s\S]*SELECT workflow_id/.test(sql)) {
        state.readVersion = params[0];
      }
      state.writes.push(sql.trim().split('\n')[0]);
      return [{ affectedRows: 1 }];
    }
    // ensureDraft's lazy fork (draft_version null → copy published rows)
    if (/SELECT COALESCE\(MAX\(version\), 0\) AS mx FROM workflow_versions/.test(sql)) {
      return [[{ mx: state.current_version }]];
    }
    if (/INSERT INTO workflow_versions/.test(sql) || /UPDATE workflows SET draft_version/.test(sql)) {
      return [{ affectedRows: 1 }];
    }
    if (/SELECT current_version, draft_version FROM workflows WHERE id = \?/.test(sql)) {
      return [[{ current_version: state.current_version, draft_version: state.draft_version }]];
    }
    throw new Error(`unscripted query: ${sql}`);
  };
  return {
    query: script,
    withTransaction: async (fn) => fn({ query: script }),
  };
}

function app(state) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.db = makeDb(state); next(); });
  a.use(require('../routes/workflows.js'));
  return a;
}

function send(state, method, urlPath, payload) {
  const a = app(state);
  const data = payload === undefined ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const server = a.listen(0, () => {
      const req = http.request({
        port: server.address().port, path: urlPath, method,
        headers: data
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
          : {},
      }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          server.close();
          let body = {};
          try { body = JSON.parse(out || '{}'); } catch { body = { raw: out }; }
          resolve({ status: res.statusCode, body });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (data) req.write(data);
      req.end();
    });
  });
}

// Fresh state per call: workflow 5 has a live draft v2 holding STEP_ROWS.
function draftState() {
  return {
    current_version: 1, draft_version: 2, readVersion: 2,
    steps: STEP_ROWS.map((r) => ({ ...r })), writes: [], lockReads: 0,
  };
}

const GOOD_BASE = () => ({
  draft_version: 2,
  step_count: 3,
  step_fingerprint: stepFingerprint({
    type: STEP_ROWS[1].type, config: STEP_ROWS[1].config,
    error_policy: STEP_ROWS[1].error_policy, label: STEP_ROWS[1].label, note: null,
  }),
});

const EDIT_BODY = {
  type: 'internal_function',
  config: { function_name: 'evaluate_condition', params: { variable: '{{this.found}}', operator: '==', value: 'false', then: 3 } },
  error_policy: { strategy: 'abort' },
};

describe('stepFingerprint', () => {
  test('is key-order-insensitive (the wf50 scar)', () => {
    const a = stepFingerprint({ type: 'internal_function', label: 'x', note: null,
      config: { function_name: 'noop', params: { b: 1, a: 2 } }, error_policy: { strategy: 'abort', max_retries: 1 } });
    const b = stepFingerprint({ type: 'internal_function', label: 'x', note: null,
      config: { params: { a: 2, b: 1 }, function_name: 'noop' }, error_policy: { max_retries: 1, strategy: 'abort' } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('accepts JSON strings as the DB returns them and objects as callers hold them', () => {
    const fromObjects = stepFingerprint({ type: 'internal_function', label: 'x', note: null,
      config: { function_name: 'noop', params: {} }, error_policy: null });
    const fromStrings = stepFingerprint({ type: 'internal_function', label: 'x', note: null,
      config: '{"function_name":"noop","params":{}}', error_policy: null });
    expect(fromObjects).toBe(fromStrings);
  });

  test('changes when content changes', () => {
    const base = { type: 'internal_function', label: 'x', note: null,
      config: { function_name: 'noop', params: {} }, error_policy: null };
    const a = stepFingerprint(base);
    expect(stepFingerprint({ ...base, label: 'y' })).not.toBe(a);
    expect(stepFingerprint({ ...base, config: { function_name: 'noop', params: { extra: 1 } } })).not.toBe(a);
  });
});

describe('expected_base precondition', () => {
  test('absent expected_base leaves the routes exactly as they were', async () => {
    const state = draftState();
    const r = await send(state, 'PUT', '/workflows/5/steps/2', EDIT_BODY);
    expect(r.status).toBe(200);
    expect(state.writes.some((w) => /UPDATE workflow_steps/.test(w))).toBe(true);
  });

  test('a matching base lets the write through', async () => {
    const state = draftState();
    const r = await send(state, 'PUT', '/workflows/5/steps/2', { ...EDIT_BODY, expected_base: GOOD_BASE() });
    expect(r.status).toBe(200);
    expect(state.writes.length).toBeGreaterThan(0);
  });

  test('a draft_version mismatch is a structured 409 and writes nothing', async () => {
    const state = draftState();
    const base = { ...GOOD_BASE(), draft_version: 3 };
    const r = await send(state, 'PUT', '/workflows/5/steps/2', { ...EDIT_BODY, expected_base: base });
    expect(r.status).toBe(409);
    expect(r.body.conflict).toEqual({ changed: 'draft_version', expected: 3, actual: 2 });
    expect(state.writes).toEqual([]);
  });

  test('a proposer who read the published steps (draft_version null) is refused once a draft exists', async () => {
    const state = draftState();
    const r = await send(state, 'PUT', '/workflows/5/steps/2',
      { ...EDIT_BODY, expected_base: { draft_version: null, step_count: 3 } });
    expect(r.status).toBe(409);
    expect(r.body.conflict.changed).toBe('draft_version');
    expect(state.writes).toEqual([]);
  });

  test('draft_version null checks the base against the published version when no draft exists', async () => {
    const state = draftState();
    state.draft_version = null;
    state.readVersion = 1;            // the published rows are what the proposer read
    const r = await send(state, 'PUT', '/workflows/5/steps/2',
      { ...EDIT_BODY, expected_base: { ...GOOD_BASE(), draft_version: null } });
    // ensureDraft then forks a new draft and the write proceeds on it.
    expect(r.status).toBe(200);
  });

  test('a step_count mismatch is a structured 409', async () => {
    const state = draftState();
    const base = { ...GOOD_BASE(), step_count: 4 };
    const r = await send(state, 'PUT', '/workflows/5/steps/2', { ...EDIT_BODY, expected_base: base });
    expect(r.status).toBe(409);
    expect(r.body.conflict).toEqual({ changed: 'step_count', expected: 4, actual: 3 });
  });

  test('a content change under the reviewer is a fingerprint 409 — the wf27 scar as a route property', async () => {
    const state = draftState();
    // Someone edited step 2 after the proposal was prepared.
    state.steps[1].config = { ...state.steps[1].config, params: { ...state.steps[1].config.params, value: 'CHANGED' } };
    const r = await send(state, 'PUT', '/workflows/5/steps/2', { ...EDIT_BODY, expected_base: GOOD_BASE() });
    expect(r.status).toBe(409);
    expect(r.body.conflict.changed).toBe('step_fingerprint');
    expect(state.writes).toEqual([]);
  });

  test('MySQL key re-ordering alone does NOT trip the fingerprint (the wf50 scar)', async () => {
    const state = draftState();
    // Same content, different stored key order — as after a MySQL JSON round trip.
    const cfg = state.steps[1].config;
    state.steps[1].config = { params: cfg.params, function_name: cfg.function_name };
    const r = await send(state, 'PUT', '/workflows/5/steps/2', { ...EDIT_BODY, expected_base: GOOD_BASE() });
    expect(r.status).toBe(200);
  });

  test('the precondition guards DELETE and insert-at-position too', async () => {
    const state = draftState();
    const del = await send(state, 'DELETE', '/workflows/5/steps/2',
      { expected_base: { ...GOOD_BASE(), step_count: 4 } });
    expect(del.status).toBe(409);

    const ins = await send(draftState(), 'POST', '/workflows/5/steps', {
      stepNumber: 2, type: 'internal_function',
      config: { function_name: 'noop', params: {} },
      expected_base: { ...GOOD_BASE(), draft_version: 3 },
    });
    expect(ins.status).toBe(409);
  });

  test('reorder takes draft_version + step_count but refuses a fingerprint (no target position)', async () => {
    const ok = await send(draftState(), 'PATCH', '/workflows/5/steps/reorder',
      { fromStep: 1, toStep: 2, expected_base: { draft_version: 2, step_count: 3 } });
    expect(ok.status).toBe(200);

    const bad = await send(draftState(), 'PATCH', '/workflows/5/steps/reorder',
      { fromStep: 1, toStep: 2, expected_base: GOOD_BASE() });
    expect(bad.status).toBe(400);
  });

  test('an append (no stepNumber) refuses a fingerprint — there is no displaced step to check', async () => {
    const r = await send(draftState(), 'POST', '/workflows/5/steps', {
      type: 'internal_function', config: { function_name: 'noop', params: {} },
      expected_base: GOOD_BASE(),
    });
    expect(r.status).toBe(400);
  });

  test.each([
    ['not an object', 'nope'],
    ['unknown key', { draft_version: 2, step_count: 3, extra: 1 }],
    ['missing step_count', { draft_version: 2 }],
    ['float draft_version', { draft_version: 2.5, step_count: 3 }],
    ['negative step_count', { draft_version: 2, step_count: -1 }],
    ['malformed fingerprint', { draft_version: 2, step_count: 3, step_fingerprint: 'abc' }],
  ])('bad shape (%s) is a 400, not a silent pass', async (_name, bad) => {
    const state = draftState();
    const r = await send(state, 'PUT', '/workflows/5/steps/2', { ...EDIT_BODY, expected_base: bad });
    expect(r.status).toBe(400);
    expect(state.writes).toEqual([]);
  });
});

describe('save-time closures (P11)', () => {
  const put = (body) => send(draftState(), 'PUT', '/workflows/5/steps/2', body);

  test('an unknown function_name is refused at save', async () => {
    const r = await put({ type: 'internal_function', config: { function_name: 'create_tsak', params: {} } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Unknown function_name "create_tsak"/);
  });

  // A18.2: an Object.prototype member or a `__` registry helper is callable
  // off the registry object but is not an internal function. Each used to
  // reach the meta-less permissive branch and save clean.
  test('a registry helper or an Object.prototype member is refused as a function_name', async () => {
    for (const name of ['toString', 'constructor', 'hasOwnProperty', '__getAllMeta', '__validateFunctionParams']) {
      const r = await put({ type: 'internal_function', config: { function_name: name, params: {} } });
      expect({ name, status: r.status }).toEqual({ name, status: 400 });
      expect(r.body.error).toMatch(/Unknown function_name/);
    }
    const internalFunctions = require('../lib/internal_functions');
    for (const name of ['toString', 'constructor', '__getAllMeta', '__getMeta']) {
      expect(internalFunctions.__validateFunctionParams(name, {}))
        .toMatchObject({ status: 400, error: expect.stringMatching(/Unknown function_name/) });
    }
    expect(internalFunctions.__validateFunctionParams('noop', {})).toBeNull();
  });

  test('params: null no longer skips required-param validation', async () => {
    const r = await put({ type: 'internal_function', config: { function_name: 'create_task', params: null } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/required/);
  });

  test('params: null stays valid for a function with no required params', async () => {
    const r = await put({ type: 'internal_function', config: { function_name: 'noop', params: null } });
    expect(r.status).toBe(200);
  });

  test('an undeclared param key is refused by name', async () => {
    const r = await put({ type: 'internal_function',
      config: { function_name: 'set_next', params: { value: 'end', vlaue: 'oops' } } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/undeclared key/);
    expect(r.body.error).toMatch(/vlaue/);
  });

  test('error_policy.strategy outside the engine enum is refused; the four real values pass', async () => {
    const bad = await put({ ...EDIT_BODY, error_policy: { strategy: 'retry' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/error_policy\.strategy/);

    for (const strategy of ['ignore', 'abort', 'retry_then_abort', 'retry_then_ignore']) {
      const ok = await put({ ...EDIT_BODY, error_policy: { strategy } });
      expect({ strategy, status: ok.status }).toEqual({ strategy, status: 200 });
    }
  });

  test('a non-object error_policy is refused instead of stringifying into the column', async () => {
    const r = await put({ ...EDIT_BODY, error_policy: 'abort' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/error_policy must be a JSON object/);
  });
});
