'use strict';
/**
 * tests/caseyWorkflowPublish.test.js
 *
 * A17.6 — Casey publishes a workflow's draft through the reviewed card, and
 * POST /workflows/:id/publish gains the P11 expected_base precondition.
 *
 * The contract pinned here:
 *   1. the card is the impact preview, server-computed: classification,
 *      per-step diff, validation warnings, in-flight/stranded counts, inbound
 *      starters, external effects (webhook URLs reduced to method + host —
 *      chat payloads never carry a secret-bearing URL), and the whole-draft
 *      fingerprint in expected_base;
 *   2. Casey never publishes a version containing ANY custom_code step
 *      (Fred's 2026-10-22 ruling, applied to both modes) and never a draft
 *      with validation errors;
 *   3. the route refuses a publish whose reviewed base moved — draft_version,
 *      step_count, or draftFingerprint — with a structured 409, before any
 *      write; absent expected_base leaves native callers unchanged;
 *   4. end to end, the SHIPPED browser builder's request is the route's shape
 *      (the phone-delivery S2 stub lesson), migrate_in_flight pinned false.
 *
 *   npx jest tests/caseyWorkflowPublish.test.js
 */

const path = require('path');
const express = require('express');
const http = require('http');

let mockAuth = { type: 'jwt', userId: 1, roles: ['admin', 'staff'], username: 'tester' };
jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = mockAuth; next(); }));

const svc = require(path.join(__dirname, '..', 'services', 'assistantService'));
const { draftFingerprint } = require(path.join(__dirname, '..', 'lib', 'versionDiff'));
const { normalizeActionDraft } = svc;

// Workflow 27: published v3 (two steps), draft v4 (three steps: param tweak on
// step 2 + an appended send_email + a webhook). The draft is valid; the diff
// is structural (step added).
const WF_ROW = { id: 27, name: 'Deadline chase', active: 1, current_version: 3, draft_version: 4 };
const CURRENT_STEPS = [
  { step_number: 1, type: 'internal_function', label: 'Find', note: null,
    config: JSON.stringify({ function_name: 'lookup_contact', params: { contact_id: '{{contact_id}}' } }), error_policy: null },
  { step_number: 2, type: 'internal_function', label: 'Branch', note: null,
    config: JSON.stringify({ function_name: 'evaluate_condition', params: { variable: '{{this.found}}', operator: '==', value: 'true', then: 'end' } }),
    error_policy: null },
];
const DRAFT_STEPS = [
  { ...CURRENT_STEPS[0] },
  { step_number: 2, type: 'internal_function', label: 'Branch', note: null,
    config: JSON.stringify({ function_name: 'evaluate_condition', params: { variable: '{{this.found}}', operator: '==', value: 'false', then: 3 } }),
    error_policy: null },
  { step_number: 3, type: 'internal_function', label: 'Notify', note: null,
    config: JSON.stringify({ function_name: 'send_email', params: { to: 'x@example.com' } }), error_policy: null },
];

function makeDb(over = {}) {
  const state = {
    wf: { ...WF_ROW, ...(over.wf || {}) },
    draftSteps: (over.draftSteps || DRAFT_STEPS).map((s) => ({ ...s })),
    currentSteps: (over.currentSteps || CURRENT_STEPS).map((s) => ({ ...s })),
    writes: [],
  };
  const script = async (sql, params = []) => {
    if (/SELECT id, name, active, current_version, draft_version FROM workflows/.test(sql)) {
      return [params[0] === state.wf.id ? [{ ...state.wf }] : []];
    }
    if (/SELECT current_version, draft_version FROM workflows WHERE id = \? FOR UPDATE/.test(sql)) {
      return [[{ current_version: state.wf.current_version, draft_version: state.wf.draft_version }]];
    }
    if (/SELECT \* FROM workflow_steps WHERE workflow_id = \? AND version = \?/.test(sql)) {
      if (params[1] === state.wf.draft_version) return [state.draftSteps.map((s) => ({ ...s }))];
      if (params[1] === state.wf.current_version) return [state.currentSteps.map((s) => ({ ...s }))];
      return [[]];
    }
    if (/SELECT COUNT\(\*\) AS n FROM workflow_executions[\s\S]*workflow_version = \?/.test(sql)) return [[{ n: 2 }]];
    if (/SELECT COUNT\(\*\) AS n FROM workflow_executions[\s\S]*NOT IN/.test(sql)) return [[{ n: 1 }]];
    // automationReadService.references — hooks, triggers, sequence steps, parents, CTAs
    if (/FROM hook_targets/.test(sql)) return [[{ target_id: 9, target_name: 'start', target_active: 1, hook_id: 5, hook_name: 'Intake hook' }]];
    if (/FROM trigger_rule_actions/.test(sql)) return [[]];
    if (/FROM sequence_steps/.test(sql)) return [[]];
    if (/FROM workflow_steps s JOIN workflows w/.test(sql)) return [[]];
    if (/FROM cta_links/.test(sql)) return [[]];
    if (/UPDATE workflow_versions|UPDATE workflows SET current_version|UPDATE workflow_executions/.test(sql)) {
      state.writes.push(sql.trim().split('\n')[0].trim());
      return [{ affectedRows: 1 }];
    }
    throw new Error(`unscripted query: ${sql}`);
  };
  return { state, db: { query: jest.fn(script), withTransaction: async (fn) => fn({ query: script }) } };
}

const EVIDENCE = [{ id: 'q1', label: 'Workflow 27 definition',
  rows: [{ workflow_id: 27, row_number: 1 }] }];
const publishDraft = (over = {}) => ({
  kind: 'workflow.publish.v1', workflow_id: 27,
  evidence: [{ query_id: 'q1', row_number: 1 }], ...over,
});

afterEach(() => { delete process.env.CASEY_WORKFLOW_AUTHORING_ENABLED; });

describe('the workflow-publish normalizer', () => {
  test('a valid publish normalizes into the full impact preview', async () => {
    const { db } = makeDb();
    const out = await normalizeActionDraft(db, publishDraft(), EVIDENCE);
    expect(out).toMatchObject({
      kind: 'workflow.publish.v1', status: 'draft',
      workflow: { workflow_id: 27, name: 'Deadline chase', published: 1, active: 1 },
      publish: { from_version: 3, to_version: 4, step_count: 3 },
      classification: 'structural',
      in_flight_count: 2, stranded_count: 1,
    });
    expect(out.structural_reasons.join(' ')).toMatch(/step 3 added/);
    expect(out.changes.some((c) => c.kind === 'added' && c.step_number === 3)).toBe(true);
    expect(out.starters).toEqual([{ source: 'hook', name: 'Intake hook', active: 1 }]);
    expect(out.effects).toEqual(['step 3: send_email']);
    expect(out.expected_base).toEqual({
      draft_version: 4, step_count: 3, draft_fingerprint: draftFingerprint(DRAFT_STEPS),
    });
  });

  test('a first publish is classified first_publish and compares against nothing', async () => {
    const { db } = makeDb({ wf: { current_version: 0 } });
    const out = await normalizeActionDraft(db, publishDraft(), EVIDENCE);
    expect(out.classification).toBe('first_publish');
    expect(out.publish.from_version).toBe(0);
  });

  test('webhook effects reduce to method + host; a templated URL says so', async () => {
    const withHook = [...DRAFT_STEPS,
      { step_number: 4, type: 'webhook', label: null, note: null,
        config: JSON.stringify({ url: 'https://api.example.com/v1/x?token=SECRET', method: 'post' }), error_policy: null },
      { step_number: 5, type: 'webhook', label: null, note: null,
        config: JSON.stringify({ url: '{{base}}/hook', method: 'POST' }), error_policy: null }];
    const { db } = makeDb({ draftSteps: withHook });
    const out = await normalizeActionDraft(db, publishDraft(), EVIDENCE);
    expect(out.effects).toContain('step 4: webhook POST → api.example.com');
    expect(out.effects).toContain('step 5: webhook POST → templated URL');
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  test('a draft containing a code step is refused by step number — either mode', async () => {
    for (const cfg of [{ code: '1;', input: {} }, { code: '1;', input: {}, code_mode: 'safe' }]) {
      const { db } = makeDb({ draftSteps: [...DRAFT_STEPS,
        { step_number: 4, type: 'custom_code', label: null, note: null, config: JSON.stringify(cfg), error_policy: null }] });
      await expect(normalizeActionDraft(db, publishDraft(), EVIDENCE))
        .rejects.toThrow(/contains code step 4 — Casey does not publish versions with code steps/);
    }
  });

  test('no draft, validation errors, bad evidence, and the off switch all refuse', async () => {
    const { db: noDraft } = makeDb({ wf: { draft_version: null } });
    await expect(normalizeActionDraft(noDraft, publishDraft(), EVIDENCE)).rejects.toThrow(/no unpublished changes/);

    const broken = DRAFT_STEPS.map((s) => ({ ...s }));
    broken[1].config = JSON.stringify({ function_name: 'evaluate_condition',
      params: { variable: 'x', operator: '==', value: 'y', then: 99 } });
    const { db: invalid } = makeDb({ draftSteps: broken });
    await expect(normalizeActionDraft(invalid, publishDraft(), EVIDENCE)).rejects.toThrow(/fails publish validation/);

    const { db } = makeDb();
    await expect(normalizeActionDraft(db, publishDraft(), [{ id: 'q1', rows: [{ task_id: 1, row_number: 1 }] }]))
      .rejects.toThrow(/does not identify the target workflow/);

    process.env.CASEY_WORKFLOW_AUTHORING_ENABLED = '0';
    await expect(normalizeActionDraft(db, publishDraft(), EVIDENCE)).rejects.toThrow(/Action kind is unavailable/);
  });
});

// ── The route precondition, and end to end through the shipped builder ─────
function fnSrc(src, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!match) throw new Error(`function ${name} not found`);
  let parens = 0, body = match.index + match[0].length - 1;
  for (; body < src.length; body++) {
    if (src[body] === '(') parens++;
    else if (src[body] === ')' && --parens === 0) break;
  }
  let depth = 0;
  for (let i = body; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(match.index, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function sendToRoute(db, request) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.db = db; next(); });
  a.use(require('../routes/workflows.js'));
  const data = JSON.stringify(request.body);
  return new Promise((resolve, reject) => {
    const server = a.listen(0, () => {
      const req = http.request({
        port: server.address().port, path: request.path, method: request.method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(data); req.end();
    });
  });
}

describe('POST /workflows/:id/publish expected_base precondition', () => {
  const base = () => ({ draft_version: 4, step_count: 3, draft_fingerprint: draftFingerprint(DRAFT_STEPS) });
  const publish = (db, expected_base) => sendToRoute(db,
    { path: '/workflows/27/publish', method: 'POST', body: expected_base === undefined ? {} : { expected_base } });

  test('absent expected_base publishes as before; a matching base publishes too', async () => {
    const a = makeDb();
    expect((await publish(a.db)).status).toBe(200);
    expect(a.state.writes.some((w) => /UPDATE workflows SET current_version/.test(w))).toBe(true);
    const b = makeDb();
    expect((await publish(b.db, base())).status).toBe(200);
  });

  test('draft_version, step_count and draft_fingerprint mismatches each 409 with nothing written', async () => {
    for (const [field, bad] of [
      ['draft_version', { ...base(), draft_version: 5 }],
      ['step_count', { ...base(), step_count: 2 }],
      ['draft_fingerprint', { ...base(), draft_fingerprint: 'a'.repeat(64) }],
    ]) {
      const { db, state } = makeDb();
      const r = await publish(db, bad);
      expect({ field, status: r.status, changed: r.body.conflict && r.body.conflict.changed })
        .toEqual({ field, status: 409, changed: field });
      expect(state.writes).toEqual([]);
    }
  });

  test('a content edit after the review changes the fingerprint and is refused', async () => {
    const { db, state } = makeDb();
    state.draftSteps[1].config = JSON.stringify({ function_name: 'evaluate_condition',
      params: { variable: '{{this.found}}', operator: '==', value: 'MOVED', then: 3 } });
    const r = await publish(db, base());
    expect(r.status).toBe(409);
    expect(r.body.conflict.changed).toBe('draft_fingerprint');
  });

  test.each([
    ['not an object', 'x'],
    ['unknown key', { ...{ draft_version: 4, step_count: 3 }, step_fingerprint: 'a'.repeat(64) }],
    ['null draft_version', { draft_version: null, step_count: 3 }],
    ['malformed fingerprint', { draft_version: 4, step_count: 3, draft_fingerprint: 'zz' }],
  ])('bad shape (%s) is a 400 before the transaction', async (_n, bad) => {
    const { db, state } = makeDb();
    const r = await publish(db, bad);
    expect(r.status).toBe(400);
    expect(state.writes).toEqual([]);
  });
});

describe('end to end: the shipped publish builder against the real route', () => {
  const fs = require('fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
  // eslint-disable-next-line no-new-func
  const buildRequest = new Function(`${fnSrc(html, 'workflowPublishRequest')}; return workflowPublishRequest;`)();

  test('the card publishes; migrate_in_flight is pinned false by the builder', async () => {
    const norm = makeDb();
    const card = await normalizeActionDraft(norm.db, publishDraft(), EVIDENCE);
    const request = buildRequest(card);
    expect(request.body.migrate_in_flight).toBe(false);
    const route = makeDb();
    const r = await sendToRoute(route.db, request);
    expect({ status: r.status, published: r.body.published_version }).toEqual({ status: 200, published: 4 });
    // The route must not have taken the migrate path (no executions UPDATE).
    expect(route.state.writes.some((w) => /UPDATE workflow_executions/.test(w))).toBe(false);
  });

  test('a stale card — the draft edited after review — is refused by the route', async () => {
    const norm = makeDb();
    const card = await normalizeActionDraft(norm.db, publishDraft(), EVIDENCE);
    const route = makeDb();
    route.state.draftSteps.push({ step_number: 4, type: 'internal_function', label: null, note: null,
      config: JSON.stringify({ function_name: 'noop', params: {} }), error_policy: null });
    const r = await sendToRoute(route.db, buildRequest(card));
    expect(r.status).toBe(409);
    expect(['step_count', 'draft_fingerprint']).toContain(r.body.conflict.changed);
    expect(route.state.writes).toEqual([]);
  });
});
