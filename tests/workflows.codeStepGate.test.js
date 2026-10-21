/**
 * tests/workflows.codeStepGate.test.js
 *
 * custom_code steps are gated on automations.manage, and the step-config
 * `type`-key guard is pinned behaviourally rather than by source assertion.
 *
 * WHY THE GATE EXISTS
 * A custom_code step is arbitrary server-side execution, not a sandboxed
 * expression. lib/job_executor runs it with vm.runInNewContext, and Node's vm
 * is not a security boundary: the host realm is reachable through the
 * sandbox's own `input` object (verified 2026-10-22 —
 * input.constructor.constructor('return process')() yields the real process
 * with a working mainModule.require), and process.env carries the database
 * credentials. So introducing one is gated on the capability that already
 * exists for exactly this ("Manage workflows, sequences and trigger rules").
 *
 * WHAT IS AND IS NOT COVERED, deliberately
 * The gate covers only the paths that take a step type FROM THE REQUEST —
 * the four step writers and POST /workflows/test-step, which is the SHORTEST
 * path to execution in the app (it runs a body-supplied step with dry_run
 * defaulting to false, no workflow, nothing persisted). ensureDraft's draft
 * fork and POST /workflows/:id/duplicate copy stored rows and introduce no new
 * code, so they are not gated; gating the fork would stop a non-holder editing
 * any step of a workflow that merely contains a code step.
 *
 * The gate controls AUTHORING, never execution: POST /workflows/:id/start is
 * jwtOrApiKey, and every trigger, hook and ingest path starts workflows whose
 * code steps already exist. This suite does not pretend otherwise.
 *
 * HARNESS: the real router over a real ephemeral socket (the idiom from
 * tests/trusteesRoute.test.js — supertest is not a dependency). Only
 * jwtOrApiKey is mocked, to vary req.auth. The db stub THROWS on any query, so
 * a passing refusal also proves the gate answers before touching the database;
 * the allow cases are asserted as "not 403", since reaching the next check is
 * the whole claim.
 *
 *   npx jest tests/workflows.codeStepGate.test.js
 */

const express = require('express');
const http = require('http');

let mockAuth = null;
jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = mockAuth; next(); }));

const STAFF   = { type: 'jwt', userId: 2, roles: ['staff'] };
const ADMIN   = { type: 'jwt', userId: 1, roles: ['admin', 'staff', 'attorney'] };
const SU      = { type: 'jwt', userId: 6, roles: ['it', 'admin', 'form_dev', 'su'] };
const INTERNAL_KEY = { type: 'api_key', scopes: null };   // legacy machine trust
const SCOPED_KEY   = { type: 'api_key', scopes: ['route:/workflows'] };

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    // PATCH must load the stored row before it can know the RESULTING step
    // type, so it legitimately reads before the gate; that one SELECT is
    // served. Everything else throws, so a passing refusal still proves the
    // gate answers without doing any further database work.
    const serveStepRow = async (sql) => {
      if (/SELECT id, type, config FROM workflow_steps/.test(sql)) {
        return [[{ id: 1000, type: 'internal_function', config: JSON.stringify({ function_name: 'noop', params: {} }) }]];
      }
      throw new Error(`db touched: ${sql}`);
    };
    req.db = {
      query: serveStepRow,
      // ensureDraft runs inside the transaction and resolves the edit version.
      withTransaction: async (fn) => fn({
        query: async (sql) => {
          if (/FROM workflows WHERE id = \?|SELECT .*current_version|FOR UPDATE/.test(sql)) {
            return [[{ id: 5, current_version: 1, draft_version: 1 }]];
          }
          return serveStepRow(sql);
        },
      }),
    };
    next();
  });
  a.use(require('../routes/workflows.js'));
  return a;
}

/** Real HTTP over an ephemeral socket → { status, body }. */
function send(method, urlPath, payload) {
  const a = app();
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

const CODE_STEP = { type: 'custom_code', config: { code: 'return { ok: 1 };' } };
const FN_STEP   = { type: 'internal_function', config: { function_name: 'noop', params: {} } };

// Every route that takes a step type from the request body.
const WRITERS = [
  ['POST',  '/workflows/5/steps',   (s) => s],
  ['PUT',   '/workflows/5/steps/1', (s) => s],
  ['PATCH', '/workflows/5/steps/1', (s) => s],
  ['POST',  '/workflows/bulk',      (s) => ({ name: 'n', steps: [s] })],
];

describe('custom_code is refused without automations.manage', () => {
  test.each(WRITERS)('%s %s refuses a code step from plain staff', async (m, path, wrap) => {
    mockAuth = STAFF;
    const r = await send(m, path, wrap(CODE_STEP));
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/automations\.manage/);
  });

  test('POST /workflows/test-step refuses it too — the shortest path to execution', async () => {
    mockAuth = STAFF;
    const r = await send('POST', '/workflows/test-step', { step: CODE_STEP, variables: {}, env: {} });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/automations\.manage/);
  });

  test('a scoped machine key without the capability is refused as well', async () => {
    mockAuth = SCOPED_KEY;
    const r = await send('POST', '/workflows/test-step', { step: CODE_STEP });
    expect(r.status).toBe(403);
  });
});

describe('the gate blocks nothing it should not', () => {
  // "Not 403" is the claim: the request got past the gate to the next check,
  // which the throwing db stub then fails. Asserting a 2xx would need a whole
  // fake schema and would not test the gate.
  test.each([['admin', ADMIN], ['su', SU], ['internal key', INTERNAL_KEY]])(
    'a code step from %s is not refused', async (_label, auth) => {
      mockAuth = auth;
      const r = await send('POST', '/workflows/test-step', { step: CODE_STEP });
      expect(r.status).not.toBe(403);
    });

  test.each(WRITERS)('%s %s lets plain staff write a non-code step', async (m, path, wrap) => {
    mockAuth = STAFF;
    const r = await send(m, path, wrap(FN_STEP));
    expect(r.status).not.toBe(403);
  });
});

describe('step.config may not carry a `type` key (behavioural, b087fa5)', () => {
  // Previously pinned only by a source assertion. The defect: executeJob's
  // payload spread config AFTER the type, so a step saved and VALIDATED as
  // internal_function executed as custom_code.
  test('a config `type` key is refused even for a capability holder', async () => {
    mockAuth = SU;
    const r = await send('POST', '/workflows/5/steps', {
      type: 'internal_function',
      config: { function_name: 'noop', params: {}, type: 'custom_code', code: 'x' },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/must not contain a "type" key/);
  });

  test('the same key is refused on PATCH', async () => {
    mockAuth = SU;
    const r = await send('PATCH', '/workflows/5/steps/1', {
      config: { function_name: 'noop', type: 'webhook', url: 'http://x' },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/must not contain a "type" key/);
  });
});
