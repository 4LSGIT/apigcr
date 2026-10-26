'use strict';
/**
 * tests/caseyWorkflowDraft.test.js
 *
 * A17.3 — Casey drafts a complete, NEVER-PUBLISHED workflow. The pieces
 * pinned here:
 *   1. the normalizer: the authoring allowlist is the law (a function off it
 *      is refused BY NAME), code steps are forced safe, webhooks and bad
 *      policies are refused, the name-collision read runs at proposal time;
 *   2. the allowlist snapshot: adding a function is a deliberate review, the
 *      CTA-denylist pattern;
 *   3. POST /workflows/bulk honours an Idempotency-Key, because the card's
 *      draft_id must not create the workflow twice;
 *   4. the settings pair for the family's off switch.
 */

const path = require('path');
const { normalizeActionDraft } = require(path.join(__dirname, '..', 'services', 'assistantService'));
const { CASEY_AUTHORABLE_FUNCTIONS } = require(path.join(__dirname, '..', 'lib', 'caseyAutomationAllowlist'));

// The collision SELECT is the only query the normalizer runs.
const dbNoCollision = { query: jest.fn(async (sql) => {
  if (/SELECT id FROM workflows WHERE name/.test(sql)) return [[]];
  throw new Error(`db touched: ${sql}`);
}) };

const draft = (over = {}) => ({
  kind: 'workflow.draft.v1',
  name: 'Deadline chase',
  description: 'Looks up the contact, computes a deadline, creates a task.',
  steps: [
    { type: 'internal_function', label: 'Find contact',
      config: { function_name: 'lookup_contact', params: { contact_id: '{{contact_id}}' } } },
    { type: 'custom_code', config: { code: 'const d = new Date(input.filed); d.setDate(d.getDate() + 30); d.toISOString();', input: {} } },
    { type: 'internal_function', config: { function_name: 'create_task', params: { assigned_to: 1, title: 'Chase the deadline' } },
      error_policy: { strategy: 'retry_then_ignore', max_retries: 2, backoff_seconds: 10 } },
  ],
  evidence: [],
  ...over,
});

afterEach(() => { delete process.env.CASEY_WORKFLOW_AUTHORING_ENABLED; });

describe('the workflow-draft normalizer', () => {
  test('a valid draft normalizes with side-effect classes and forced safe mode', async () => {
    const out = await normalizeActionDraft(dbNoCollision, draft(), []);
    expect(out).toMatchObject({ kind: 'workflow.draft.v1', status: 'draft', name: 'Deadline chase' });
    expect(out.steps).toHaveLength(3);
    expect(out.steps[0]).toMatchObject({ type: 'internal_function', side_effect: 'read', label: 'Find contact' });
    expect(out.steps[1]).toMatchObject({ type: 'custom_code', side_effect: 'safe-code' });
    expect(out.steps[1].config.code_mode).toBe('safe');
    expect(out.steps[2]).toMatchObject({ side_effect: 'internal-record' });
    expect(typeof out.draft_id).toBe('string');
  });

  test('the family off switch (ruling 4) makes the kind not exist', async () => {
    process.env.CASEY_WORKFLOW_AUTHORING_ENABLED = '0';
    await expect(normalizeActionDraft(dbNoCollision, draft(), [])).rejects.toThrow(/Action kind is unavailable/);
  });

  test('a function off the allowlist is refused BY NAME; senders and writes are off it', async () => {
    for (const fn of ['send_sms', 'update_db', 'start_workflow', 'enroll_sequence', 'create_cta', 'query_db']) {
      expect(CASEY_AUTHORABLE_FUNCTIONS.has(fn)).toBe(false);
      await expect(normalizeActionDraft(dbNoCollision, draft({
        steps: [{ type: 'internal_function', config: { function_name: fn, params: {} } }],
      }), [])).rejects.toThrow(new RegExp(`"${fn}" is outside Casey's authoring allowlist`));
    }
  });

  test('standard code, webhook steps, bad policies and ladder blowouts are refused', async () => {
    await expect(normalizeActionDraft(dbNoCollision, draft({
      steps: [{ type: 'custom_code', config: { code: '1;', code_mode: 'standard' } }],
    }), [])).rejects.toThrow(/only safe-mode code/);
    await expect(normalizeActionDraft(dbNoCollision, draft({
      steps: [{ type: 'webhook', config: { url: 'https://x.example.com' } }],
    }), [])).rejects.toThrow(/does not author webhook steps yet/);
    await expect(normalizeActionDraft(dbNoCollision, draft({
      steps: [{ type: 'internal_function', config: { function_name: 'noop', params: {} },
        error_policy: { strategy: 'explode' } }],
    }), [])).rejects.toThrow(/invalid error_policy/);
    await expect(normalizeActionDraft(dbNoCollision, draft({
      steps: [{ type: 'internal_function', config: { function_name: 'noop', params: {} },
        error_policy: { strategy: 'retry_then_abort', max_retries: 5, backoff_seconds: 300 } }],
    }), [])).rejects.toThrow(/retry ladder exceeds/);
    await expect(normalizeActionDraft(dbNoCollision, draft({
      steps: [{ type: 'internal_function', config: { function_name: 'noop', params: {}, type: 'custom_code' } }],
    }), [])).rejects.toThrow(/must not contain a "type" key/);
  });

  test('step_number is accepted and ignored; other unknown keys are refused BY NAME', async () => {
    // P12 evidence rows carry step_number, so models copy it in — live
    // no-card failure, 2026-10-22. Array order stays authoritative.
    const out = await normalizeActionDraft(dbNoCollision, draft({
      steps: [{ step_number: 1, type: 'internal_function',
        config: { function_name: 'noop', params: {} } }],
    }), []);
    expect(out.steps[0]).toMatchObject({ type: 'internal_function' });
    expect('step_number' in out.steps[0]).toBe(false);
    await expect(normalizeActionDraft(dbNoCollision, draft({
      steps: [{ type: 'internal_function', mystery_key: 1,
        config: { function_name: 'noop', params: {} } }],
    }), [])).rejects.toThrow(/unsupported fields: mystery_key/);
  });

  test('the answer prompt teaches the real validator params — generated, not hand-written', () => {
    // wait_for's nextStep and schedule_resume's resumeAt are camelCase params
    // no model can guess; the reference is generated from __meta so it cannot
    // drift from the validators.
    const system = require(path.join(__dirname, '..', 'lib', 'aiPrompts', 'assistantAnswer')).system;
    expect(system).toMatch(/AUTHORABLE FUNCTION PARAMS/);
    expect(system).toMatch(/wait_for \(none\).*nextStep!:integer/);
    expect(system).toMatch(/schedule_resume \(none\).*resumeAt!:/);
    for (const name of CASEY_AUTHORABLE_FUNCTIONS.keys()) {
      expect({ name, taught: new RegExp(`\\n  ${name} \\(`).test(system) }).toEqual({ name, taught: true });
    }
  });

  test('a name collision is refused at proposal time, naming the existing workflow', async () => {
    const dbCollision = { query: async () => [[{ id: 27 }]] };
    await expect(normalizeActionDraft(dbCollision, draft(), []))
      .rejects.toThrow(/already exists \(#27\)/);
  });
});

describe('the allowlist snapshot — adding a function is a deliberate review', () => {
  test('every entry, exactly as reviewed', () => {
    expect(Object.fromEntries(CASEY_AUTHORABLE_FUNCTIONS)).toEqual({
      noop: 'none', set_var: 'none', format_string: 'none', set_next: 'none',
      evaluate_condition: 'none', foreach: 'none', wait_for: 'none', schedule_resume: 'none',
      wait_until_time: 'none', business_deadline: 'none',
      lookup_contact: 'read', find_contact: 'read', lookup_appointment: 'read',
      get_appointments: 'read', find_live_calendar_item: 'read', lookup_event: 'read',
      get_events: 'read', lookup_user: 'read', list_users: 'read',
      request_decision: 'internal-record', create_task: 'internal-record',
      create_event: 'internal-record', create_log: 'internal-record',
    });
  });

  test('every allowlisted name is a real registry function', () => {
    const fns = require(path.join(__dirname, '..', 'lib', 'internal_functions'));
    for (const name of CASEY_AUTHORABLE_FUNCTIONS.keys()) {
      expect({ name, real: typeof fns[name] === 'function' }).toEqual({ name, real: true });
    }
  });

  // A18.2 / ruling 14: the SEQUENCE list is separate, keyed by action_type
  // with the function pinned per type, and admits the two senders under the
  // 'external-send' class. The workflow list above stays sender-free.
  test('the sequence allowlist, exactly as reviewed — and it never leaks into the workflow list', () => {
    const { CASEY_SEQUENCE_AUTHORABLE } = require(path.join(__dirname, '..', 'lib', 'caseyAutomationAllowlist'));
    expect(Object.fromEntries(CASEY_SEQUENCE_AUTHORABLE)).toEqual({
      sms: { function_name: 'send_sms', side_effect: 'external-send' },
      email: { function_name: 'send_email', side_effect: 'external-send' },
      task: { function_name: 'create_task', side_effect: 'internal-record' },
    });
    const fns = require(path.join(__dirname, '..', 'lib', 'internal_functions'));
    for (const [type, { function_name: name }] of CASEY_SEQUENCE_AUTHORABLE) {
      // Empty params fail on their own required params — never on the
      // function itself being unknown or workflow-only for a sequence.
      const v = fns.__validateSequenceFunctionStep(type, { function_name: name, params: {} });
      expect({ type, name, real: typeof fns[name] === 'function', seqOk: !v || !/Unknown function_name|workflow-only/.test(v.error) })
        .toEqual({ type, name, real: true, seqOk: true });
    }
    expect(CASEY_AUTHORABLE_FUNCTIONS.has('send_sms')).toBe(false);
    expect(CASEY_AUTHORABLE_FUNCTIONS.has('send_email')).toBe(false);
  });
});

describe('POST /workflows/bulk honours the Idempotency-Key the card sends', () => {
  const express = require('express');
  const http = require('http');

  let mockAuth = null;
  jest.mock('../lib/auth.jwtOrApiKey', () =>
    jest.fn((req, _res, next) => { req.auth = mockAuth; next(); }));

  const { SQL } = require('../lib/requestIdempotency');

  function makeDb() {
    const idemRows = [];
    let nextId = 1;
    let creates = 0;
    const db = {
      getConnection: async () => { throw new Error('no connections'); },
      withTransaction: async (fn) => {
        creates += 1;
        return fn({ query: async (sql) => [{ insertId: 70 + creates }] });
      },
      async query(sql, params) {
        if (sql === SQL.claim) {
          const [user_id, scope, idem_key] = params;
          if (idemRows.some((r) => r.user_id === user_id && r.scope === scope && r.idem_key === idem_key)) {
            const err = new Error('dup'); err.code = 'ER_DUP_ENTRY'; throw err;
          }
          const row = { id: nextId++, user_id, scope, idem_key, status: 'in_flight', result: null };
          idemRows.push(row);
          return [{ insertId: row.id, affectedRows: 1 }];
        }
        if (sql === SQL.read) {
          const [user_id, scope, idem_key] = params;
          const row = idemRows.find((r) => r.user_id === user_id && r.scope === scope && r.idem_key === idem_key);
          return row ? [[{ id: row.id, status: row.status, result: row.result, age_s: 0 }]] : [[]];
        }
        if (sql === SQL.settle) {
          const [json, id] = params;
          const row = idemRows.find((r) => r.id === id && r.status === 'in_flight');
          if (!row) return [{ affectedRows: 0 }];
          row.status = 'applied'; row.result = JSON.parse(json);
          return [{ affectedRows: 1 }];
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };
    db.counts = () => ({ creates, idemRows: idemRows.length });
    return db;
  }

  function send(db, headers, payload) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.db = db; next(); });
    a.use(require('../routes/workflows.js'));
    const data = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const srv = a.listen(0, () => {
        const req = http.request({
          port: srv.address().port, path: '/workflows/bulk', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
        }, (res) => {
          let out = '';
          res.on('data', (c) => (out += c));
          res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }); });
        });
        req.on('error', (e) => { srv.close(); reject(e); });
        req.write(data); req.end();
      });
    });
  }

  const BODY = { name: 'Idem test', steps: [{ type: 'internal_function', config: { function_name: 'noop', params: {} } }] };

  test('the same key twice creates ONE workflow and replays the first result', async () => {
    mockAuth = { type: 'jwt', userId: 2, roles: ['staff'] };
    const db = makeDb();
    const first = await send(db, { 'idempotency-key': 'wf-draft-uuid-1' }, BODY);
    expect(first.status).toBe(201);
    expect(first.body.workflowId).toBe(71);
    const second = await send(db, { 'idempotency-key': 'wf-draft-uuid-1' }, BODY);
    expect(second.status).toBe(201);
    expect(second.body.workflowId).toBe(71);
    expect(second.body.replayed).toBe(true);
    expect(db.counts().creates).toBe(1);
  });
});

describe('the settings pair', () => {
  test('the flag is registered in BOTH places', () => {
    const { cfg } = require(path.join(__dirname, '..', 'lib', 'firmConfig'));
    expect(() => cfg('casey_workflow_authoring_enabled')).not.toThrow();
    const { SETTINGS } = require(path.join(__dirname, '..', 'lib', 'settingsRegistry'));
    expect(SETTINGS.casey_workflow_authoring_enabled).toMatchObject({ kind: 'system', type: 'bool' });
  });
});
