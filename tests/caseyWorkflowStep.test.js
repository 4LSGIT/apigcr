'use strict';
/**
 * tests/caseyWorkflowStep.test.js
 *
 * A17.4 — Casey inserts or narrowly edits ONE step in an EXISTING workflow's
 * draft, plus P13 (the workspace context names the open automation record).
 *
 * The contract pinned here:
 *   1. evidence must carry the exact workflow_id (a row from
 *      automation.definition) — an id from the model's memory is refused;
 *   2. the normalizer re-reads the workflow and bakes expected_base
 *      (draft_version, step_count, and the target step's key-order-insensitive
 *      fingerprint) into the card, so the route's P11 precondition can refuse
 *      a stale write;
 *   3. edit is NARROW: label, note, params of an allowlisted function, or a
 *      safe-mode code body. Never type/function_name, never a branch target
 *      (then/else/next-step values compare canonically, branches[].then
 *      included), never error_policy, never webhook or STANDARD-code steps;
 *   4. insert steps obey the same allowlist as workflow.draft.v1 (shared
 *      normalizeAuthoredStep);
 *   5. P13: tabMore~moreAutomations~workflows~N in the canonical URL becomes
 *      a server-verified workspace.automation field; a dead id is refused the
 *      way a dead case file is.
 *
 *   npx jest tests/caseyWorkflowStep.test.js
 */

const path = require('path');
const svc = require(path.join(__dirname, '..', 'services', 'assistantService'));
const { stepFingerprint } = require(path.join(__dirname, '..', 'lib', 'versionDiff'));
const { normalizeActionDraft, normalizeWorkspaceContext, validateWorkspaceContext } = svc;

// Workflow 27: published v3, draft v4 with four steps (the draft is what the
// proposer reads). Step 2 is an allowlisted branch; step 3 a safe code step;
// step 4 send_mms (a sender still off the allowlist — its attachment_url is
// fetched at send time; send_sms / send_email joined it under ruling 15).
const WF_ROW = { id: 27, name: 'Deadline chase', active: 1, current_version: 3, draft_version: 4 };
const STEP_ROWS = [
  { step_number: 1, type: 'internal_function', label: 'Find', note: null,
    config: JSON.stringify({ function_name: 'lookup_contact', params: { contact_id: '{{contact_id}}' } }), error_policy: null },
  { step_number: 2, type: 'internal_function', label: 'Branch', note: null,
    config: JSON.stringify({ function_name: 'evaluate_condition', params: { variable: '{{this.found}}', operator: '==', value: 'true', then: 3 } }),
    error_policy: JSON.stringify({ strategy: 'abort' }) },
  { step_number: 3, type: 'custom_code', label: 'Compute', note: null,
    config: JSON.stringify({ code: 'input.a + input.b;', input: { a: 1, b: 2 }, code_mode: 'safe' }), error_policy: null },
  { step_number: 4, type: 'internal_function', label: 'Send', note: null,
    config: JSON.stringify({ function_name: 'send_mms', params: { to: '2485550100' } }), error_policy: null },
];

function stepDb(over = {}) {
  const wf = { ...WF_ROW, ...over };
  return { query: jest.fn(async (sql, params) => {
    if (/SELECT id, name, active, current_version, draft_version FROM workflows/.test(sql)) {
      return [params[0] === wf.id ? [wf] : []];
    }
    if (/FROM workflow_steps WHERE workflow_id = \? AND version = \?/.test(sql)) {
      return [params[0] === wf.id && params[1] === (wf.draft_version != null ? wf.draft_version : wf.current_version)
        ? STEP_ROWS.map((r) => ({ ...r })) : []];
    }
    throw new Error(`db touched: ${sql}`);
  }) };
}

// Evidence as automation.definition produces it: each row carries workflow_id.
const EVIDENCE = [{ id: 'q1', label: 'Workflow 27 definition',
  rows: STEP_ROWS.map((r) => ({ workflow_id: 27, step_number: r.step_number, type: r.type })) }];
EVIDENCE[0].rows.forEach((row, i) => { row.row_number = i + 1; });

const CITE = [{ query_id: 'q1', row_number: 1 }];

const insertDraft = (over = {}) => ({
  kind: 'workflow.step_insert.v1', workflow_id: 27,
  step: { type: 'internal_function', label: 'Task it',
    config: { function_name: 'create_task', params: { assigned_to: 1, title: 'Chase the deadline' } } },
  evidence: CITE,
  ...over,
});

const editDraft = (over = {}) => ({
  kind: 'workflow.step_edit.v1', workflow_id: 27, step_number: 2,
  changes: { params: { variable: '{{this.found}}', operator: '==', value: 'false', then: 3 } },
  evidence: CITE,
  ...over,
});

afterEach(() => { delete process.env.CASEY_WORKFLOW_AUTHORING_ENABLED; });

describe('workflow.step_insert.v1', () => {
  test('an append normalizes with the expected_base and no fingerprint', async () => {
    const out = await normalizeActionDraft(stepDb(), insertDraft(), EVIDENCE);
    expect(out).toMatchObject({ kind: 'workflow.step_insert.v1', status: 'draft', position: null, displaces: null });
    expect(out.workflow).toEqual({ workflow_id: 27, name: 'Deadline chase', published: 1, active: 1, has_draft: 1 });
    expect(out.expected_base).toEqual({ draft_version: 4, step_count: 4 });
    expect(out.step).toMatchObject({ type: 'internal_function', side_effect: 'internal-record' });
    expect(typeof out.draft_id).toBe('string');
  });

  test('inserting at an occupied position fingerprints the displaced step', async () => {
    const out = await normalizeActionDraft(stepDb(), insertDraft({ step_number: 2 }), EVIDENCE);
    expect(out.position).toBe(2);
    expect(out.displaces).toEqual({ step_number: 2, summary: 'Branch' });
    expect(out.expected_base.step_fingerprint).toBe(stepFingerprint(STEP_ROWS[1]));
  });

  test('position count+1 is an append; beyond that is refused', async () => {
    const out = await normalizeActionDraft(stepDb(), insertDraft({ step_number: 5 }), EVIDENCE);
    expect(out.position).toBeNull();
    await expect(normalizeActionDraft(stepDb(), insertDraft({ step_number: 6 }), EVIDENCE))
      .rejects.toThrow(/position must be 1-5/);
  });

  test('a workflow with no draft bakes draft_version null and reads the published steps', async () => {
    const out = await normalizeActionDraft(stepDb({ draft_version: null }), insertDraft(), EVIDENCE);
    expect(out.expected_base).toEqual({ draft_version: null, step_count: 4 });
  });

  test('evidence that does not carry the workflow_id is refused', async () => {
    const foreign = [{ id: 'q1', label: 'Some task', rows: [{ task_id: 9, row_number: 1 }] }];
    await expect(normalizeActionDraft(stepDb(), insertDraft(), foreign))
      .rejects.toThrow(/does not identify the target workflow/);
    await expect(normalizeActionDraft(stepDb(), insertDraft({ evidence: [] }), EVIDENCE))
      .rejects.toThrow(/does not identify the target workflow/);
  });

  test('the inserted step rides the shared allowlist — send_mms is refused by name', async () => {
    await expect(normalizeActionDraft(stepDb(), insertDraft({
      step: { type: 'internal_function', config: { function_name: 'send_mms', params: {} } },
    }), EVIDENCE)).rejects.toThrow(/"send_mms" is outside Casey's authoring allowlist/);
  });

  test('the family off switch covers the step kinds too', async () => {
    process.env.CASEY_WORKFLOW_AUTHORING_ENABLED = '0';
    await expect(normalizeActionDraft(stepDb(), insertDraft(), EVIDENCE)).rejects.toThrow(/Action kind is unavailable/);
    await expect(normalizeActionDraft(stepDb(), editDraft(), EVIDENCE)).rejects.toThrow(/Action kind is unavailable/);
  });
});

describe('workflow.step_edit.v1', () => {
  test('a value-only param edit normalizes with merged config, before/after and the target fingerprint', async () => {
    const out = await normalizeActionDraft(stepDb(), editDraft(), EVIDENCE);
    expect(out).toMatchObject({ kind: 'workflow.step_edit.v1', step_number: 2 });
    expect(out.target).toEqual({ step_number: 2, type: 'internal_function', label: 'Branch', function_name: 'evaluate_condition' });
    expect(out.changes.params.value).toBe('false');
    expect(out.before.params.value).toBe('true');
    expect(out.new_config).toEqual({
      function_name: 'evaluate_condition',
      params: { variable: '{{this.found}}', operator: '==', value: 'false', then: 3 },
    });
    expect(out.expected_base).toEqual({
      draft_version: 4, step_count: 4, step_fingerprint: stepFingerprint(STEP_ROWS[1]),
    });
  });

  test('a branch-target change is refused — then, else, and set_next values are control flow', async () => {
    await expect(normalizeActionDraft(stepDb(), editDraft({
      changes: { params: { variable: '{{this.found}}', operator: '==', value: 'true', then: 4 } },
    }), EVIDENCE)).rejects.toThrow(/may not change a branch target/);
    await expect(normalizeActionDraft(stepDb(), editDraft({
      changes: { params: { variable: '{{this.found}}', operator: '==', value: 'true', then: 3, else: 5 } },
    }), EVIDENCE)).rejects.toThrow(/may not change a branch target/);
  });

  test('params must still satisfy the function meta — an undeclared key is refused', async () => {
    await expect(normalizeActionDraft(stepDb(), editDraft({
      changes: { params: { variable: 'x', operator: '==', value: 'y', then: 3, vlaue: 'typo' } },
    }), EVIDENCE)).rejects.toThrow(/undeclared key/);
  });

  test('label/note-only edits carry no new_config', async () => {
    const out = await normalizeActionDraft(stepDb(), editDraft({ changes: { label: 'Branch on found', note: 'Edited by Casey' } }), EVIDENCE);
    expect(out.new_config).toBeUndefined();
    expect(out.changes).toEqual({ label: 'Branch on found', note: 'Edited by Casey' });
    expect(out.before).toEqual({ label: 'Branch', note: null });
  });

  test('a safe-mode code body edit normalizes and keeps safe mode pinned', async () => {
    const out = await normalizeActionDraft(stepDb(), editDraft({
      step_number: 3, changes: { code: 'input.a * input.b;' },
    }), EVIDENCE);
    expect(out.target).toEqual({ step_number: 3, type: 'custom_code', label: 'Compute', code_mode: 'safe' });
    expect(out.new_config).toMatchObject({ code: 'input.a * input.b;', code_mode: 'safe' });
    expect(out.before.code).toBe('input.a + input.b;');
  });

  test('ineligible targets are refused by name: off-allowlist functions, standard code, webhooks', async () => {
    await expect(normalizeActionDraft(stepDb(), editDraft({ step_number: 4, changes: { label: 'x' } }), EVIDENCE))
      .rejects.toThrow(/"send_mms", which is outside Casey's authoring allowlist/);

    const standardCodeDb = stepDb();
    const rows = STEP_ROWS.map((r) => r.step_number === 3
      ? { ...r, config: JSON.stringify({ code: '1;', input: {} }) } : { ...r });
    standardCodeDb.query = jest.fn(async (sql, params) => {
      if (/SELECT id, name, active, current_version, draft_version FROM workflows/.test(sql)) return [[{ ...WF_ROW }]];
      if (/FROM workflow_steps/.test(sql)) return [rows];
      throw new Error(`db touched: ${sql}`);
    });
    await expect(normalizeActionDraft(standardCodeDb, editDraft({ step_number: 3, changes: { code: '2;' } }), EVIDENCE))
      .rejects.toThrow(/STANDARD-mode code step/);

    const webhookDb = stepDb();
    const whRows = STEP_ROWS.map((r) => r.step_number === 4
      ? { ...r, type: 'webhook', config: JSON.stringify({ url: 'https://x.example.com', method: 'POST' }) } : { ...r });
    webhookDb.query = jest.fn(async (sql) => {
      if (/SELECT id, name, active, current_version, draft_version FROM workflows/.test(sql)) return [[{ ...WF_ROW }]];
      if (/FROM workflow_steps/.test(sql)) return [whRows];
      throw new Error(`db touched: ${sql}`);
    });
    await expect(normalizeActionDraft(webhookDb, editDraft({ step_number: 4, changes: { label: 'x' } }), EVIDENCE))
      .rejects.toThrow(/webhook step — Casey does not edit those/);
  });

  test('shape refusals: cross-type changes, empty changes, unknown change keys, bad step_number', async () => {
    await expect(normalizeActionDraft(stepDb(), editDraft({ step_number: 2, changes: { code: '1;' } }), EVIDENCE))
      .rejects.toThrow(/not a code step/);
    await expect(normalizeActionDraft(stepDb(), editDraft({ step_number: 3, changes: { params: { a: 1 } } }), EVIDENCE))
      .rejects.toThrow(/has no params/);
    await expect(normalizeActionDraft(stepDb(), editDraft({ changes: {} }), EVIDENCE))
      .rejects.toThrow(/at least one change/);
    await expect(normalizeActionDraft(stepDb(), editDraft({ changes: { function_name: 'noop' } }), EVIDENCE))
      .rejects.toThrow(/only label, note, params, code, and input are editable/);
    await expect(normalizeActionDraft(stepDb(), editDraft({ step_number: 9 }), EVIDENCE))
      .rejects.toThrow(/the draft has 4 steps/);
  });
});

describe('P13 — the workspace context names the open automation record', () => {
  const ctx = (open) => {
    const url = `/?open=${open}`;
    const raw = { v: 1, canonical_url: url, files: [], active: null };
    // The browser builds `active` itself; mirror what normalize derives so the
    // byte-compare passes, exactly as assistant.html does.
    const parts = open.split('~');
    raw.active = { kind: 'workspace', tab: parts[0], rest: parts.slice(1).join('~') };
    return raw;
  };

  test('tabMore~moreAutomations~workflows~27 derives a deterministic automation field', () => {
    const out = normalizeWorkspaceContext(ctx('tabMore~moreAutomations~workflows~27'));
    expect(out.automation).toEqual({ kind: 'workflow', id: 27 });
    const seq = normalizeWorkspaceContext(ctx('tabMore~moreAutomations~sequences~5'));
    expect(seq.automation).toEqual({ kind: 'sequence_template', id: 5 });
  });

  test('no record segment, other sub-tabs, and other tabs derive nothing', () => {
    expect(normalizeWorkspaceContext(ctx('tabMore~moreAutomations~workflows')).automation).toBeUndefined();
    expect(normalizeWorkspaceContext(ctx('tabMore~moreAutomations~triggers~9')).automation).toBeUndefined();
    expect(normalizeWorkspaceContext(ctx('tabTasks')).automation).toBeUndefined();
  });

  test('the ticket round trip reproduces the field from the canonical URL alone', () => {
    const first = normalizeWorkspaceContext(ctx('tabMore~moreAutomations~workflows~27'));
    const again = normalizeWorkspaceContext(JSON.parse(JSON.stringify(first)));
    expect(again.automation).toEqual({ kind: 'workflow', id: 27 });
  });

  test('validateWorkspaceContext verifies the record and attaches its label; a dead id is refused', async () => {
    const db = { query: jest.fn(async (sql, params) => {
      expect(sql).toMatch(/SELECT id, name FROM workflows WHERE id = \?/);
      return [params[0] === 27 ? [{ id: 27, name: 'Deadline chase' }] : []];
    }) };
    const ok = await validateWorkspaceContext(db, ctx('tabMore~moreAutomations~workflows~27'));
    expect(ok.automation).toEqual({ kind: 'workflow', id: 27, label: 'Deadline chase' });
    await expect(validateWorkspaceContext(db, ctx('tabMore~moreAutomations~workflows~999')))
      .rejects.toThrow(/automation record that is unavailable/);
  });

  test('sequence ids verify against sequence_templates', async () => {
    const db = { query: jest.fn(async (sql, params) => {
      expect(sql).toMatch(/SELECT id, name FROM sequence_templates WHERE id = \?/);
      return [[{ id: Number(params[0]), name: 'Reminders' }]];
    }) };
    const ok = await validateWorkspaceContext(db, ctx('tabMore~moreAutomations~sequences~5'));
    expect(ok.automation).toEqual({ kind: 'sequence_template', id: 5, label: 'Reminders' });
  });
});

// ── End to end: normalizer → the SHIPPED browser builder → the REAL route ──
// The phone-delivery S2 scar: a stub modelled on the author's own assumption
// mirrors the author's bug (the SU console takes {query}, the readonly
// endpoint {sql}; 4/4 dry-runs green, live run 400). So the request shapes
// here come from public/assistant.html's actual builder and are accepted by
// the actual routes/workflows.js router — not by a harness that encodes what
// I think the route takes.
describe('end to end: card request shapes are the route\'s shapes', () => {
  jest.mock('../lib/auth.jwtOrApiKey', () =>
    jest.fn((req, _res, next) => { req.auth = { type: 'jwt', userId: 1, roles: ['admin', 'staff'] }; next(); }));
  const fs = require('fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');

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
  // eslint-disable-next-line no-new-func
  const buildRequest = new Function(`${fnSrc(html, 'workflowStepActionRequest')}; return workflowStepActionRequest;`)();

  function routeDb() {
    // Workflow 27 with draft v4 holding STEP_ROWS — the same world the
    // normalizer read, served to the real router.
    const rows = () => STEP_ROWS.map((r) => ({ ...r }));
    const script = async (sql, params = []) => {
      if (/SELECT current_version, draft_version FROM workflows WHERE id = \? FOR UPDATE/.test(sql)) {
        return [[{ current_version: 3, draft_version: 4 }]];
      }
      if (/SELECT COUNT\(\*\) AS n FROM workflow_steps/.test(sql)) return [[{ n: rows().length }]];
      if (/SELECT type, config, error_policy, label, note FROM workflow_steps/.test(sql)) {
        const row = rows().find((r) => r.step_number === params[2]);
        return [row ? [row] : []];
      }
      if (/SELECT id FROM workflow_steps WHERE workflow_id = \? AND version = \? AND step_number = \?/.test(sql)) {
        const row = rows().find((r) => r.step_number === params[2]);
        return [row ? [{ id: 900 + row.step_number }] : []];
      }
      if (/SELECT id, type, config FROM workflow_steps/.test(sql)) {
        const row = rows().find((r) => r.step_number === params[2]);
        return [row ? [{ id: 900 + row.step_number, type: row.type, config: row.config }] : []];
      }
      if (/SELECT MAX\(step_number\) as max FROM workflow_steps/.test(sql)) return [[{ max: rows().length }]];
      if (/SELECT id, step_number, type, config FROM workflow_steps/.test(sql)) {
        return [rows().map((r) => ({ id: 900 + r.step_number, step_number: r.step_number, type: r.type, config: r.config }))];
      }
      if (/UPDATE workflow_steps|INSERT INTO workflow_steps|DELETE FROM workflow_steps/.test(sql)) return [{ affectedRows: 1 }];
      throw new Error(`route db unscripted: ${sql}`);
    };
    return { query: script, withTransaction: async (fn) => fn({ query: script }) };
  }

  function sendToRoute(request) {
    const express = require('express');
    const http = require('http');
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.db = routeDb(); next(); });
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

  test('an insert card applies through the real route (append and at-position)', async () => {
    const appended = await normalizeActionDraft(stepDb(), insertDraft(), EVIDENCE);
    const r1 = await sendToRoute(buildRequest(appended));
    expect({ status: r1.status, stepNumber: r1.body.stepNumber }).toEqual({ status: 201, stepNumber: 5 });

    const positioned = await normalizeActionDraft(stepDb(), insertDraft({ step_number: 2 }), EVIDENCE);
    const r2 = await sendToRoute(buildRequest(positioned));
    expect({ status: r2.status, stepNumber: r2.body.stepNumber }).toEqual({ status: 201, stepNumber: 2 });
  });

  test('an edit card applies through the real route; a stale card is refused with the conflict shape', async () => {
    const edit = await normalizeActionDraft(stepDb(), editDraft(), EVIDENCE);
    const ok = await sendToRoute(buildRequest(edit));
    expect(ok.status).toBe(200);

    // Someone edits step 2 between proposal and click.
    const stale = await normalizeActionDraft(stepDb(), editDraft(), EVIDENCE);
    STEP_ROWS[1].config = JSON.stringify({ ...JSON.parse(STEP_ROWS[1].config),
      params: { variable: '{{this.found}}', operator: '==', value: 'MOVED', then: 3 } });
    try {
      const refused = await sendToRoute(buildRequest(stale));
      expect(refused.status).toBe(409);
      expect(refused.body.conflict.changed).toBe('step_fingerprint');
    } finally {
      STEP_ROWS[1].config = JSON.stringify({ function_name: 'evaluate_condition',
        params: { variable: '{{this.found}}', operator: '==', value: 'true', then: 3 } });
    }
  });

  test('a label-only edit card sends no config and still applies', async () => {
    const edit = await normalizeActionDraft(stepDb(), editDraft({ changes: { label: 'Branch on found' } }), EVIDENCE);
    const request = buildRequest(edit);
    expect(request.body.config).toBeUndefined();
    expect(request.method).toBe('PATCH');
    const ok = await sendToRoute(request);
    expect(ok.status).toBe(200);
  });
});

// Ruling 15 (Fred, 2026-10-27): Casey authors sends. The sender is a literal
// active firm line / configured mailbox, or a placeholder the WORKFLOW
// resolver can resolve: a variable the NEAREST earlier writer stored from a
// firm sender setting (get_setting → {{V}}, get_settings → {{V.key}}). The
// live forms: {{settings.email_automations}} ×7, {{automationsFrom}} ×4.
describe('ruling 15 — workflow send steps (insert / edit)', () => {
  const SEND_ROWS = [
    { step_number: 1, type: 'internal_function', label: 'Settings', note: null,
      config: { function_name: 'get_settings', params: { keys: 'billing_tasks_to, email_automations, sms_default_from', output_var: 'settings' } }, error_policy: null },
    { step_number: 2, type: 'internal_function', label: 'One setting', note: null,
      config: { function_name: 'get_setting', params: { key: 'email_automations', output_var: 'automationsFrom' } }, error_policy: null },
    { step_number: 3, type: 'internal_function', label: 'Not a sender', note: null,
      config: { function_name: 'get_settings', params: { keys: 'email_it', output_var: 'routing' } }, error_policy: null },
    { step_number: 4, type: 'internal_function', label: 'Mail the client', note: null,
      config: { function_name: 'send_email', params: { from: '{{settings.email_automations}}', to: '{{client_email}}', subject: 'Filed', text: 'Hi',
        attachment_urls: ['https://storage.example.com/notice.pdf'] } }, error_policy: null },
    { step_number: 5, type: 'internal_function', label: 'Overwrite', note: null,
      config: { function_name: 'set_var', params: { name: 'settings', value: 'x' } }, error_policy: null },
  ];
  function sendDb(rows = SEND_ROWS) {
    return { query: jest.fn(async (sql, params) => {
      if (/SELECT id, name, active, current_version, draft_version FROM workflows/.test(sql)) return [[{ ...WF_ROW }]];
      if (/FROM workflow_steps WHERE workflow_id = \? AND version = \?/.test(sql)) return [rows.map((r) => ({ ...r }))];
      if (/FROM phone_lines/.test(sql)) return [params[0] === '2484179800' ? [{ phone_number: '2484179800', display_name: 'office' }] : []];
      if (/FROM email_credentials/.test(sql)) return [params[0] === 'office@4lsg.com' ? [{ email: 'office@4lsg.com', from_name: '4LSG' }] : []];
      if (/SELECT `key`, is_secret FROM app_settings/.test(sql)) {
        return [[{ key: 'email_automations', is_secret: 0 }, { key: 'billing_tasks_to', is_secret: 0 }, { key: 'sms_default_from', is_secret: 0 }]
          .filter((r) => params[0].includes(r.key))];
      }
      throw new Error(`db touched: ${sql}`);
    }) };
  }
  const EVID = [{ id: 'q1', label: 'Workflow 27 definition', rows: [{ workflow_id: 27, row_number: 1 }] }];
  const email = (from, extra = {}) => ({ type: 'internal_function', label: 'Mail',
    config: { function_name: 'send_email', params: { from, to: '{{billingUser.email}}', subject: 'S', text: 'T', ...extra } } });
  const sms = (from) => ({ type: 'internal_function', config: { function_name: 'send_sms', params: { from, to: '{{phone}}', message: 'Hi' } } });
  const insert = (step, over = {}) => normalizeActionDraft(sendDb(), { kind: 'workflow.step_insert.v1', workflow_id: 27, step, evidence: CITE, ...over }, EVID);

  test('a literal sender is looked up: active line / configured mailbox, annotated with the recipient', async () => {
    const out = await insert(sms('2484179800'));
    expect(out.step).toMatchObject({ side_effect: 'external-send', sender: 'office (2484179800)', recipient: '{{phone}}' });
    expect(out.step.sender_note).toBeUndefined();
    await expect(insert(sms('2485550100'))).rejects.toThrow(/not an active firm phone line/);
    expect((await insert(email('office@4lsg.com'))).step.sender).toBe('4LSG <office@4lsg.com>');
    await expect(insert(email('nobody@example.com'))).rejects.toThrow(/not a configured firm mailbox/);
  });

  test('{{V.key}} after get_settings and {{V}} after get_setting resolve — the live forms', async () => {
    const a = await insert(email('{{settings.email_automations}}'), { step_number: 4 });
    expect(a.step).toMatchObject({ sender: '{{settings.email_automations}}', recipient: '{{billingUser.email}}' });
    expect(a.step.sender_note).toMatch(/firm sender setting "email_automations", read by step 1 \(get_settings\)/);
    const b = await insert(email('{{automationsFrom}}'), { step_number: 4 });
    expect(b.step.sender_note).toMatch(/"email_automations", read by step 2 \(get_setting\)/);
    expect((await insert(sms('{{settings.sms_default_from}}'), { step_number: 4 })).step.sender_note).toMatch(/"sms_default_from"/);
  });

  test('a placeholder sender that would not resolve is refused', async () => {
    const refused = /would not resolve — workflow placeholders are variables only/;
    // No earlier writer: inserting BEFORE the get_settings step.
    await expect(insert(email('{{settings.email_automations}}'), { step_number: 1 })).rejects.toThrow(refused);
    // The nearest writer is set_var (step 5 overwrites `settings`), appended after it.
    await expect(insert(email('{{settings.email_automations}}'))).rejects.toThrow(refused);
    // A key the get_settings step does not read.
    await expect(insert(email('{{settings.email_default_from}}'), { step_number: 4 })).rejects.toThrow(refused);
    // A setting outside the registry's senders section (routing).
    await expect(insert(email('{{routing.email_it}}'), { step_number: 4 })).rejects.toThrow(refused);
    // The wrong channel: an email setting as an SMS sender.
    await expect(insert(sms('{{settings.email_automations}}'), { step_number: 4 })).rejects.toThrow(refused);
    // Shape mismatches: get_setting needs {{V}}, get_settings needs {{V.key}}.
    await expect(insert(email('{{automationsFrom.email_automations}}'), { step_number: 4 })).rejects.toThrow(refused);
    await expect(insert(email('{{settings}}'), { step_number: 4 })).rejects.toThrow(refused);
    // Tables / modifiers / env — the sequence resolver's forms do not exist here.
    for (const f of ['{{users.default_email}}', '{{settings.email_automations|default:x}}', 'x{{automationsFrom}}', '{{env.now}}']) {
      await expect(insert(email(f), { step_number: 4 })).rejects.toThrow(refused);
    }
  });

  test('the writer must store the setting through its OWN output_var — a set_vars alias is not the setting', async () => {
    const rows = [{ step_number: 1, type: 'internal_function', label: 'Settings', note: null,
      config: { function_name: 'get_settings', params: { keys: 'email_automations', output_var: 'raw' },
        set_vars: { settings: '{{this.output}}' } }, error_policy: null }];
    await expect(normalizeActionDraft(sendDb(rows), { kind: 'workflow.step_insert.v1', workflow_id: 27,
      step: email('{{settings.email_automations}}'), evidence: CITE }, EVID)).rejects.toThrow(/would not resolve/);
    expect((await normalizeActionDraft(sendDb(rows), { kind: 'workflow.step_insert.v1', workflow_id: 27,
      step: email('{{raw.email_automations}}'), evidence: CITE }, EVID)).step.sender_note).toMatch(/read by step 1/);
  });

  test('email attachment_urls are never authored', async () => {
    await expect(insert(email('office@4lsg.com', { attachment_urls: ['https://x.example.com/a.pdf'] })))
      .rejects.toThrow(/does not author email attachments/);
  });

  test('edit: a send step discloses the send; a stored sender / attachment list may be kept, a changed one is held to the rule', async () => {
    const edit = (changes) => normalizeActionDraft(sendDb(), { kind: 'workflow.step_edit.v1', workflow_id: 27, step_number: 4, changes, evidence: CITE }, EVID);
    const stored = SEND_ROWS[3].config.params;
    const labelOnly = await edit({ label: 'Mail them' });
    expect(labelOnly.send).toEqual({ side_effect: 'external-send', sender: '{{settings.email_automations}} (unchanged — as stored on this step)', recipient: '{{client_email}}' });
    const keep = await edit({ params: { ...stored, subject: 'Your case was filed' } });
    expect(keep.send.sender).toMatch(/unchanged/);
    expect(keep.new_config.params.attachment_urls).toEqual(stored.attachment_urls);
    await expect(edit({ params: { ...stored, attachment_urls: ['https://evil.example.com/x.pdf'] } }))
      .rejects.toThrow(/does not author email attachments/);
    await expect(edit({ params: { ...stored, from: '{{settings.email_default_from}}' } })).rejects.toThrow(/would not resolve/);
    const moved = await edit({ params: { ...stored, from: '{{automationsFrom}}' } });
    expect(moved.send).toMatchObject({ sender: '{{automationsFrom}}', recipient: '{{client_email}}' });
    expect(moved.send.sender_note).toMatch(/read by step 2/);
    await expect(edit({ params: { ...stored, from: 'nobody@example.com' } })).rejects.toThrow(/not a configured firm mailbox/);
  });

  test('editing a stored get_settings step re-checks its keys; a secret is refused', async () => {
    const edit = (params) => normalizeActionDraft(sendDb(), { kind: 'workflow.step_edit.v1', workflow_id: 27, step_number: 1,
      changes: { params }, evidence: CITE }, EVID);
    const ok = await edit({ keys: 'email_automations, billing_tasks_to', output_var: 'settings' });
    expect(ok.new_config.params.keys).toBe('email_automations, billing_tasks_to');
    expect(ok.send).toBeUndefined();
    await expect(edit({ keys: 'email_automations, quo_api_key', output_var: 'settings' })).rejects.toThrow(/quo_api_key is a secret/);
  });

  test('a non-send edit carries no send disclosure', async () => {
    const out = await normalizeActionDraft(stepDb(), editDraft(), EVIDENCE);
    expect(out.send).toBeUndefined();
  });
});
