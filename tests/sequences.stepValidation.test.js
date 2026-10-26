/**
 * tests/sequences.stepValidation.test.js
 *
 * P11 sequence half: save-time validation of sms / email / task /
 * internal_function sequence steps, and the optional expected_base
 * precondition on the five step-mutating sequence routes.
 *
 * THE CONTRACT BEING VALIDATED (traced, not assumed): all four action types
 * dispatch identically at run time — lib/sequenceEngine executeStep hands
 * `{ ...resolvedConfig, type: 'internal_function' }` to lib/job_executor
 * executeJob, which calls internalFunctions[function_name](params, db). So a
 * step with a missing / unknown / workflow-only function_name, an undeclared
 * param key, or a missing required param used to save clean and fail (or
 * silently do nothing) at fire time. Measured 2026-10-26: all 155 live
 * steps of these types pass every new check — nothing grandfathered.
 *
 * Fred's ruling (P11): validate only the fields being written. PUT / POST
 * carry the whole step and are validated whole; a PATCH that does not touch
 * action_type / action_config (timing, condition, error_policy) still saves
 * on a step whose function was since renamed.
 *
 * expected_base: same shape and optionality as the workflow half
 * (tests/workflows.expectedBase.test.js); the fingerprint is
 * lib/versionDiff.sequenceStepFingerprint. The real-SQL behaviour (JSON
 * columns re-ordered by MySQL, the draft fork, the 409s) is pinned on a real
 * engine in tests/sequences.expectedBase.mysql.test.js; this file runs in
 * every jest run.
 *
 * HARNESS: the real router over a real ephemeral socket with a scripted db
 * holding a concrete step table (the workflows.expectedBase idiom).
 *
 *   npx jest tests/sequences.stepValidation.test.js
 */

const express = require('express');
const http = require('http');

jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = { type: 'jwt', userId: 1, roles: ['staff'] }; next(); }));

const internalFunctions = require('../lib/internal_functions');
const { sequenceStepFingerprint } = require('../lib/versionDiff');

const validate = internalFunctions.__validateSequenceFunctionStep;

// The shapes public/automation/sequences.html seqGatherStep() sends
// (seqGatherActionConfig + timing + condition/fire_guard null + the
// always-present error_policy object).
const EDITOR_EP = { strategy: 'ignore', max_retries: 0, backoff_seconds: 5 };
const EDITOR_PAYLOADS = {
  sms: {
    action_type: 'sms',
    action_config: { function_name: 'send_sms', params: { from: '2485550100', to: '{{contacts.contact_phone}}', message: 'Hi {{contacts.contact_fname}}' } },
    timing: { type: 'delay', value: 5, unit: 'minutes' }, condition: null, fire_guard: null, error_policy: EDITOR_EP,
  },
  email: {
    action_type: 'email',
    action_config: { function_name: 'send_email', params: { from: 'info@example.com', to: '{{contacts.contact_email}}', subject: 'Hello', text: 'Body', include_signature: true } },
    timing: { type: 'next_business_day', timeOfDay: '09:00', randomizeMinutes: 0 }, condition: null, fire_guard: null, error_policy: EDITOR_EP,
  },
  task: {
    action_type: 'task',
    action_config: { function_name: 'create_task', params: { title: 'Call {{contacts.contact_name}}', assigned_to: '{{trigger_data.user_id}}', link_type: 'contact', link_id: '{{contacts.contact_id}}' } },
    timing: { type: 'immediate' }, condition: null, fire_guard: null, error_policy: EDITOR_EP,
  },
  internal_function: {
    action_type: 'internal_function',
    // set_vars + _comment: top-level keys the editor carries over; executeJob
    // never reads them, so they are not refused.
    action_config: { function_name: 'noop', params: {}, set_vars: { x: '1' }, _comment: 'kept' },
    timing: { type: 'immediate' }, condition: null, fire_guard: null,
    error_policy: { strategy: 'retry_then_ignore', max_retries: 2, backoff_seconds: 5 },
  },
};

describe('__validateSequenceFunctionStep', () => {
  test.each(Object.keys(EDITOR_PAYLOADS))('the editor %s shape passes', (t) => {
    expect(validate(t, EDITOR_PAYLOADS[t].action_config)).toBeNull();
  });

  test.each(['sms', 'email', 'task', 'internal_function'])('%s: a missing function_name is refused', (t) => {
    expect(validate(t, { params: {} })).toMatchObject({ status: 400, error: expect.stringMatching(/function_name is required/) });
    expect(validate(t, { function_name: '  ', params: {} })).toMatchObject({ status: 400 });
    expect(validate(t, {})).toMatchObject({ status: 400 });
  });

  test.each(['sms', 'email', 'task', 'internal_function'])('%s: an unknown function_name is refused', (t) => {
    expect(validate(t, { function_name: 'send_smss', params: {} }))
      .toMatchObject({ status: 400, error: expect.stringMatching(/Unknown function_name "send_smss"/) });
  });

  test('a registry helper or an Object.prototype member is not an internal function', () => {
    for (const name of ['__getAllMeta', '__validateFunctionParams', 'toString', 'constructor', 'hasOwnProperty']) {
      expect(validate('internal_function', { function_name: name, params: {} }))
        .toMatchObject({ status: 400, error: expect.stringMatching(/Unknown function_name/) });
    }
  });

  test('a workflow-only function is refused (the sequence picker never offers it)', () => {
    expect(internalFunctions.__getMeta('set_next').workflowOnly).toBe(true);
    expect(validate('internal_function', { function_name: 'set_next', params: { value: 3 } }))
      .toMatchObject({ status: 400, error: expect.stringMatching(/workflow-only/) });
  });

  test('an undeclared param key is refused by name', () => {
    const r = validate('sms', { function_name: 'send_sms', params: { from: '2485550100', to: 'x', message: 'm', mesage: 'typo' } });
    expect(r).toMatchObject({ status: 400 });
    expect(r.error).toMatch(/undeclared key: mesage/);
  });

  test('params null / absent is validated as {} — required params fail at save', () => {
    expect(validate('sms', { function_name: 'send_sms', params: null }))
      .toMatchObject({ status: 400, error: expect.stringMatching(/is required/) });
    expect(validate('task', { function_name: 'create_task' }))
      .toMatchObject({ status: 400, error: expect.stringMatching(/is required/) });
    // a function with no required params saves with params null
    expect(validate('internal_function', { function_name: 'noop', params: null })).toBeNull();
  });

  test('params must be an object', () => {
    expect(validate('internal_function', { function_name: 'noop', params: [1] }))
      .toMatchObject({ status: 400, error: expect.stringMatching(/params must be a JSON object/) });
  });

  test('webhook / start_workflow are not this validator\'s concern', () => {
    expect(validate('webhook', { url: 'https://example.com' })).toBeNull();
    expect(validate('start_workflow', { workflow_id: 1 })).toBeNull();
  });
});

// ── Route harness ──────────────────────────────────────────────────────────
// Template 7: published v1, live draft v2 holding STEPS. Step 3's stored
// function was since renamed out of the registry (the ruling's case).
const STEPS = [
  { step_number: 1, ...EDITOR_PAYLOADS.sms },
  { step_number: 2, ...EDITOR_PAYLOADS.task },
  { step_number: 3, action_type: 'internal_function', action_config: { function_name: 'retired_fn', params: { a: 1 } },
    timing: { type: 'immediate' }, condition: null, fire_guard: null, error_policy: null },
];
const j = (v) => (v == null ? null : JSON.stringify(v));

function makeDb(state) {
  const rows = (version) => (version === state.readVersion ? state.steps : []);
  const script = async (sql, params = []) => {
    if (/SELECT current_version, draft_version FROM sequence_templates WHERE id = \?/.test(sql)) {
      if (/FOR UPDATE/.test(sql)) state.lockReads++;
      return [[{ current_version: state.current_version, draft_version: state.draft_version }]];
    }
    if (/SELECT COUNT\(\*\) AS n FROM sequence_steps/.test(sql)) return [[{ n: rows(params[1]).length }]];
    if (/SELECT action_type, action_config, timing, `condition`, fire_guard, error_policy\s+FROM sequence_steps/.test(sql)) {
      const r = rows(params[1]).find((s) => s.step_number === params[2]);
      return [r ? [{ action_type: r.action_type, action_config: j(r.action_config), timing: j(r.timing),
        condition: j(r.condition), fire_guard: j(r.fire_guard), error_policy: j(r.error_policy) }] : []];
    }
    if (/SELECT action_type, action_config FROM sequence_steps/.test(sql)) {
      const r = rows(params[1]).find((s) => s.step_number === params[2]);
      return [r ? [{ action_type: r.action_type, action_config: j(r.action_config) }] : []];
    }
    if (/SELECT id FROM sequence_steps WHERE template_id = \? AND version = \? AND step_number = \?/.test(sql)) {
      const r = rows(params[1]).find((s) => s.step_number === params[2]);
      return [r ? [{ id: 900 + r.step_number }] : []];
    }
    if (/SELECT MAX\(step_number\) as max FROM sequence_steps/.test(sql)) return [[{ max: rows(params[1]).length }]];
    if (/SELECT COALESCE\(MAX\(version\), 0\) AS mx FROM sequence_template_versions/.test(sql)) return [[{ mx: state.current_version }]];
    if (/^\s*(UPDATE|INSERT INTO|DELETE FROM) (sequence_steps|sequence_template_versions|sequence_templates)/.test(sql)) {
      if (/INSERT INTO sequence_steps[\s\S]*SELECT template_id/.test(sql)) state.readVersion = params[0];
      state.writes.push(sql.trim().split('\n')[0]);
      return [{ affectedRows: 1, insertId: 4242 }];
    }
    throw new Error(`unscripted query: ${sql}`);
  };
  return { query: script, withTransaction: async (fn) => fn({ query: script }) };
}

function send(state, method, urlPath, payload) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.db = makeDb(state); next(); });
  a.use(require('../routes/sequences.js'));
  const data = payload === undefined ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const server = a.listen(0, () => {
      const req = http.request({
        port: server.address().port, path: urlPath, method,
        headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
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

const draftState = () => ({
  current_version: 1, draft_version: 2, readVersion: 2,
  steps: STEPS.map((s) => ({ ...s })), writes: [], lockReads: 0,
});
const stepWrites = (state) => state.writes.filter((w) => /sequence_steps/.test(w));
const fp = (n) => sequenceStepFingerprint(STEPS[n - 1]);
const BASE = (extra = {}) => ({ draft_version: 2, step_count: 3, ...extra });

describe('save-time validation on the step routes', () => {
  test.each(Object.keys(EDITOR_PAYLOADS))('native editor %s payload saves via POST and PUT unchanged (no expected_base)', async (t) => {
    const s1 = draftState();
    const post = await send(s1, 'POST', '/sequences/templates/7/steps', EDITOR_PAYLOADS[t]);
    expect(post.status).toBe(201);
    expect(s1.lockReads).toBe(1);             // ensureDraft only — no precondition ran
    const s2 = draftState();
    const put = await send(s2, 'PUT', '/sequences/templates/7/steps/1', EDITOR_PAYLOADS[t]);
    expect(put.status).toBe(200);
    expect(stepWrites(s2)).toHaveLength(1);
  });

  test('POST refuses an unknown function before any write', async () => {
    const s = draftState();
    const r = await send(s, 'POST', '/sequences/templates/7/steps',
      { ...EDITOR_PAYLOADS.sms, action_config: { function_name: 'send_smss', params: {} } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Unknown function_name "send_smss"/);
    expect(s.writes).toEqual([]);
  });

  test('PUT validates the whole step: an undeclared key is refused by name', async () => {
    const s = draftState();
    const cfg = { function_name: 'send_sms', params: { ...EDITOR_PAYLOADS.sms.action_config.params, extra_key: 1 } };
    const r = await send(s, 'PUT', '/sequences/templates/7/steps/1', { ...EDITOR_PAYLOADS.sms, action_config: cfg });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/undeclared key: extra_key/);
    expect(s.writes).toEqual([]);
  });

  test('PUT refuses a missing required param (params null)', async () => {
    const s = draftState();
    const r = await send(s, 'PUT', '/sequences/templates/7/steps/2',
      { ...EDITOR_PAYLOADS.task, action_config: { function_name: 'create_task', params: null } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/is required/);
  });

  test('PATCH of action_config alone validates it against the stored action_type', async () => {
    const s = draftState();
    const r = await send(s, 'PATCH', '/sequences/templates/7/steps/1',
      { action_config: { function_name: 'set_next', params: { value: 2 } } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/workflow-only/);
    expect(s.writes).toEqual([]);
  });

  test('Fred\'s ruling: a PATCH that does not write the action still saves on a step whose function was renamed', async () => {
    expect(validate('internal_function', STEPS[2].action_config)).toMatchObject({ status: 400 });
    for (const body of [{ timing: { type: 'delay', value: 2, unit: 'hours' } },
      { error_policy: { strategy: 'ignore' } }, { condition: null }]) {
      const s = draftState();
      const r = await send(s, 'PATCH', '/sequences/templates/7/steps/3', body);
      expect(r.status).toBe(200);
      expect(stepWrites(s)).toHaveLength(1);
    }
  });

  test('the action_type the editor switches to is validated with the stored config', async () => {
    const s = draftState();
    const r = await send(s, 'PATCH', '/sequences/templates/7/steps/3', { action_type: 'task' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Unknown function_name "retired_fn"/);
  });
});

describe('expected_base precondition', () => {
  test('omitted: every route behaves as before (native callers)', async () => {
    const cases = [
      ['PATCH', '/sequences/templates/7/steps/reorder', { fromStep: 1, toStep: 2 }],
      ['DELETE', '/sequences/templates/7/steps/2', undefined],
      ['PATCH', '/sequences/templates/7/steps/1', { timing: { type: 'immediate' } }],
    ];
    for (const [m, u, b] of cases) {
      const s = draftState();
      const r = await send(s, m, u, b);
      expect(r.status).toBe(200);
      expect(s.lockReads).toBe(1);
    }
  });

  test('a matching base passes on all five routes', async () => {
    const cases = [
      ['POST', '/sequences/templates/7/steps', { ...EDITOR_PAYLOADS.sms, step_number: 2, expected_base: BASE({ step_fingerprint: fp(2) }) }, 201],
      ['POST', '/sequences/templates/7/steps', { ...EDITOR_PAYLOADS.sms, expected_base: BASE() }, 201],
      ['PUT', '/sequences/templates/7/steps/1', { ...EDITOR_PAYLOADS.email, expected_base: BASE({ step_fingerprint: fp(1) }) }, 200],
      ['PATCH', '/sequences/templates/7/steps/3', { timing: { type: 'immediate' }, expected_base: BASE({ step_fingerprint: fp(3) }) }, 200],
      ['DELETE', '/sequences/templates/7/steps/2', { expected_base: BASE({ step_fingerprint: fp(2) }) }, 200],
      ['PATCH', '/sequences/templates/7/steps/reorder', { fromStep: 1, toStep: 3, expected_base: BASE() }, 200],
    ];
    for (const [m, u, b, code] of cases) {
      const s = draftState();
      const r = await send(s, m, u, b);
      expect([m, u, r.status]).toEqual([m, u, code]);
      expect(s.lockReads).toBe(2);            // precondition + ensureDraft, same parent row
      expect(stepWrites(s).length).toBeGreaterThan(0);
    }
  });

  test('a stale draft_version is a structured 409 and writes nothing', async () => {
    const s = draftState();
    const r = await send(s, 'PUT', '/sequences/templates/7/steps/1', { ...EDITOR_PAYLOADS.sms, expected_base: { draft_version: 1, step_count: 3 } });
    expect(r.status).toBe(409);
    expect(r.body.conflict).toEqual({ changed: 'draft_version', expected: 1, actual: 2 });
    expect(s.writes).toEqual([]);
  });

  test('a null draft_version base against a live draft is a 409 (the proposer read the published steps)', async () => {
    const s = draftState();
    const r = await send(s, 'PATCH', '/sequences/templates/7/steps/reorder', { order: [2, 1, 3], expected_base: { draft_version: null, step_count: 3 } });
    expect(r.status).toBe(409);
    expect(r.body.conflict).toEqual({ changed: 'draft_version', expected: null, actual: 2 });
  });

  test('a stale step_count is a 409', async () => {
    const s = draftState();
    const r = await send(s, 'DELETE', '/sequences/templates/7/steps/2', { expected_base: BASE({ step_count: 4 }) });
    expect(r.status).toBe(409);
    expect(r.body.conflict).toEqual({ changed: 'step_count', expected: 4, actual: 3 });
    expect(s.writes).toEqual([]);
  });

  test('a changed target step is a 409 naming the fingerprint', async () => {
    const s = draftState();
    const r = await send(s, 'PUT', '/sequences/templates/7/steps/1', { ...EDITOR_PAYLOADS.sms, expected_base: BASE({ step_fingerprint: fp(2) }) });
    expect(r.status).toBe(409);
    expect(r.body.conflict).toMatchObject({ changed: 'step_fingerprint', expected: fp(2), actual: fp(1) });
    expect(s.writes).toEqual([]);
  });

  test('a fingerprint on an empty slot is step_missing', async () => {
    const s = draftState();
    const r = await send(s, 'POST', '/sequences/templates/7/steps', { ...EDITOR_PAYLOADS.sms, step_number: 9, expected_base: BASE({ step_fingerprint: fp(1) }) });
    expect(r.status).toBe(409);
    expect(r.body.conflict).toMatchObject({ changed: 'step_missing', actual: null });
  });

  test('shape errors are 400s', async () => {
    const bad = [
      [{ step_count: 3 }, /needs draft_version/],
      [{ draft_version: 2, step_count: 3, extra: 1 }, /unknown keys: extra/],
      [{ draft_version: 0, step_count: 3 }, /positive integer or null/],
      [{ draft_version: 2, step_count: -1 }, /non-negative integer/],
      [{ draft_version: 2, step_count: 3, step_fingerprint: 'ABC' }, /sha256 hex/],
      [[1], /must be a JSON object/],
      [null, /must be a JSON object/],
    ];
    for (const [eb, re] of bad) {
      const s = draftState();
      const r = await send(s, 'PUT', '/sequences/templates/7/steps/1', { ...EDITOR_PAYLOADS.sms, expected_base: eb });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(re);
      expect(s.writes).toEqual([]);
    }
  });

  test('a fingerprint on a route with no target position is a 400 (append, reorder)', async () => {
    for (const [m, u, b] of [
      ['POST', '/sequences/templates/7/steps', { ...EDITOR_PAYLOADS.sms }],
      ['PATCH', '/sequences/templates/7/steps/reorder', { fromStep: 1, toStep: 2 }],
    ]) {
      const s = draftState();
      const r = await send(s, m, u, { ...b, expected_base: BASE({ step_fingerprint: fp(1) }) });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/requires a target step position/);
      expect(s.writes).toEqual([]);
    }
  });

  test('expected_base alone on PATCH is not an edit', async () => {
    const s = draftState();
    const r = await send(s, 'PATCH', '/sequences/templates/7/steps/1', { expected_base: BASE() });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Nothing to update');
  });

  test('no draft yet: a null-draft base is checked against the published rows, then the fork proceeds', async () => {
    const s = { current_version: 1, draft_version: null, readVersion: 1, steps: STEPS.map((x) => ({ ...x })), writes: [], lockReads: 0 };
    const r = await send(s, 'PUT', '/sequences/templates/7/steps/2',
      { ...EDITOR_PAYLOADS.task, expected_base: { draft_version: null, step_count: 3, step_fingerprint: fp(2) } });
    expect(r.status).toBe(200);
    expect(s.writes.some((w) => /INSERT INTO sequence_steps/.test(w))).toBe(true);   // the fork
  });
});

describe('sequenceStepFingerprint', () => {
  const step = STEPS[0];
  test('is key-order-insensitive and accepts JSON strings or objects', () => {
    const reordered = {
      error_policy: { backoff_seconds: 5, max_retries: 0, strategy: 'ignore' },
      timing: { unit: 'minutes', value: 5, type: 'delay' },
      action_config: { params: { message: step.action_config.params.message, to: step.action_config.params.to, from: step.action_config.params.from }, function_name: 'send_sms' },
      action_type: 'sms',
    };
    expect(sequenceStepFingerprint(reordered)).toBe(sequenceStepFingerprint(step));
    expect(sequenceStepFingerprint({ ...step, action_config: JSON.stringify(step.action_config), timing: JSON.stringify(step.timing) }))
      .toBe(sequenceStepFingerprint(step));
    expect(sequenceStepFingerprint(step)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('changes with each content column', () => {
    const a = sequenceStepFingerprint(step);
    expect(sequenceStepFingerprint({ ...step, action_type: 'internal_function' })).not.toBe(a);
    expect(sequenceStepFingerprint({ ...step, action_config: { ...step.action_config, params: { ...step.action_config.params, message: 'x' } } })).not.toBe(a);
    expect(sequenceStepFingerprint({ ...step, timing: { type: 'immediate' } })).not.toBe(a);
    expect(sequenceStepFingerprint({ ...step, condition: { query: 'SELECT 1', params: {}, assert: {} } })).not.toBe(a);
    expect(sequenceStepFingerprint({ ...step, fire_guard: { min_hours_before_appt: 2 } })).not.toBe(a);
    expect(sequenceStepFingerprint({ ...step, error_policy: null })).not.toBe(a);
  });

  test('absent and null nullable columns hash the same (the routes store a falsy value as NULL)', () => {
    const { condition, fire_guard, ...rest } = step;
    expect(sequenceStepFingerprint(rest)).toBe(sequenceStepFingerprint(step));
  });
});
