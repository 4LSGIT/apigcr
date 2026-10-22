'use strict';
/**
 * tests/automationRead.test.js
 *
 * P12a — the typed automation read surface for Ask Casey (workflows half).
 * Casey could read no automation definition or run before this; these
 * projections are the ONLY path automation rows take to the model, so the
 * redaction IS the control being tested:
 *   - a webhook URL never leaves the projection (host + credential label do);
 *   - custom_code bodies are readable (ruling 9) and capped;
 *   - workflow_execution_steps.resolved_config is never even SELECTed, and
 *     output_data is projected to verdict keys only — keeping visible the
 *     engine trap where a 'success' row hides {success:false} (A17.1 trap 1).
 *
 * All on stub dbs: the projection's queries are inspected as they run.
 */

const path = require('path');
const automation = require(path.join(__dirname, '..', 'services', 'automationReadService'));
const svc = require(path.join(__dirname, '..', 'services', 'assistantService'));

const SECRET_URL = 'https://hooks.example.com/t/SECRET-TOKEN-abc123';

function dbOf(handlers) {
  const seen = [];
  return {
    seen,
    query: async (sql, params = []) => {
      seen.push({ sql, params });
      for (const [pattern, rows] of handlers) {
        if (pattern.test(sql)) return [typeof rows === 'function' ? rows(sql, params) : rows];
      }
      throw new Error(`unhandled SQL: ${sql}`);
    },
  };
}

describe('automation.definition — the step projection and its redaction', () => {
  const db = () => dbOf([
    [/FROM workflows WHERE id/, [{ id: 27, name: 'Intake', active: 1, description: 'd', current_version: 6, draft_version: 7 }]],
    [/FROM credentials/, [{ id: 3, name: 'Clio OAuth' }]],
    [/FROM workflow_steps WHERE workflow_id/, [
      { step_number: 1, label: 'Call out', note: null, type: 'webhook',
        config: JSON.stringify({ url: SECRET_URL, method: 'POST', credential_id: 3,
          headers: { 'X-Static-Secret': 'shh', Accept: 'json' }, body: { a: 1 }, timeout_ms: 20000 }),
        error_policy: JSON.stringify({ strategy: 'abort' }) },
      { step_number: 2, label: 'Shape', note: 'n', type: 'custom_code',
        config: JSON.stringify({ code: 'input.a + 1;', code_mode: 'safe', input: { a: 1 }, set_vars: { out: '{{this}}' } }),
        error_policy: null },
      { step_number: 3, label: 'Fn', note: null, type: 'internal_function',
        config: JSON.stringify({ function_name: 'send_sms', params: { to: '{{phone}}' } }), error_policy: null },
    ]],
  ]);

  test('a webhook URL never leaves the projection; host and credential label do', async () => {
    const rows = await automation.definition(db(), { workflow_id: 27 });
    const all = JSON.stringify(rows);
    expect(all).not.toContain('SECRET-TOKEN');
    expect(all).not.toContain('/t/');
    expect(all).not.toContain('shh');                   // literal header value
    const hook = JSON.parse(rows[0].config);
    expect(hook.url_host).toBe('hooks.example.com');
    expect(hook.credential).toBe('Clio OAuth');
    expect(hook.header_keys).toEqual(['X-Static-Secret', 'Accept']);
  });

  test('a code body is readable (ruling 9), with its mode, and long code is capped', async () => {
    const rows = await automation.definition(db(), { workflow_id: 27 });
    const code = JSON.parse(rows[1].config);
    expect(code.code).toBe('input.a + 1;');
    expect(code.code_mode).toBe('safe');
    expect(automation.projectStepConfig('custom_code', { code: 'x'.repeat(5000) }, new Map()).code)
      .toMatch(/truncated 5000 chars total/);
  });

  test('rows carry the evidence ids and version facts the write kinds will cite', async () => {
    const rows = await automation.definition(db(), { workflow_id: 27 });
    expect(rows[0]).toMatchObject({ workflow_id: 27, workflow_name: 'Intake', version: 6, is_draft: 0, step_number: 1 });
    expect(rows).toHaveLength(3);
  });

  test('a missing workflow or empty version is a shaped error, not an empty success', async () => {
    const empty = dbOf([
      [/FROM workflows WHERE id/, []],
    ]);
    await expect(automation.definition(empty, { workflow_id: 9999 })).rejects.toThrow(/does not exist/);
    await expect(automation.definition(db(), { workflow_id: 0 })).rejects.toThrow(/positive integer/);
  });
});

describe('automation.run — history without payloads', () => {
  const db = () => dbOf([
    [/FROM workflow_executions e/, [{ execution_id: 500, workflow_id: 27, workflow_name: 'Intake',
      workflow_version: 6, status: 'completed_with_errors', contact_id: 9, current_step_number: 4,
      steps_executed_count: 3, created_at: 'c', completed_at: 'f', cancel_reason: null,
      init_data: JSON.stringify({ case_id: 'C1' }), variables: JSON.stringify({ x: 1 }) }]],
    [/FROM workflow_execution_steps/, [
      { step_number: 1, step_id: 11, status: 'success', error_message: null, duration_ms: 5, executed_at: 'e1',
        output_data: JSON.stringify({ success: false, error: 'quota', giant_payload: 'PII'.repeat(10) }) },
      { step_number: 2, step_id: 12, status: 'failed', error_message: 'boom', duration_ms: 9, executed_at: 'e2',
        output_data: null },
    ]],
    [/FROM scheduled_jobs/, [{ job_id: 7, job_status: 'pending', scheduled_time: 't', data: JSON.stringify({ nextStep: 5 }) }]],
  ]);

  test('resolved_config is never selected and output_data is verdict-only', async () => {
    const d = db();
    const rows = await automation.run(d, { execution_id: 500 });
    for (const q of d.seen) expect(q.sql).not.toMatch(/resolved_config/);
    const all = JSON.stringify(rows);
    expect(all).not.toContain('giant_payload');
    expect(all).not.toContain('PII');
    // The engine trap stays visible: a success row whose verdict says failure.
    const step1 = rows.find((r) => r.row === 'step' && r.step_number === 1);
    expect(step1.status).toBe('success');
    expect(JSON.parse(step1.output_verdict)).toEqual({ success: false, error: 'quota' });
    expect(step1.output_redacted).toBe(1);
  });

  test('the execution summary and a pending resume are rows of their own', async () => {
    const rows = await automation.run(db(), { execution_id: 500 });
    expect(rows[0]).toMatchObject({ row: 'execution', execution_id: 500, status: 'completed_with_errors' });
    expect(JSON.parse(rows[0].init_data)).toEqual({ case_id: 'C1' });
    const resume = rows.find((r) => r.row === 'pending_resume');
    expect(resume).toMatchObject({ job_id: 7, next_step: 5 });
  });
});

describe('automation.references — every starter source', () => {
  const db = () => dbOf([
    [/FROM hook_targets/, [{ target_id: 1, target_name: 'to intake', target_active: 1, hook_id: 4, hook_name: 'Gmail hook' }]],
    [/FROM trigger_rule_actions/, [{ action_id: 2, action_name: 'start', action_active: 1,
      rule_id: 8, rule_name: 'On new case', event_type: 'case.created', rule_active: 1 }]],
    [/FROM sequence_steps/, [{ step_id: 3, template_id: 5, step_number: 2, version: 4, template_name: 'Onboarding', current_version: 4 }]],
    [/FROM workflow_steps s JOIN workflows w/, [
      { parent_id: 50, step_number: 3, version: 2, parent_name: 'Parent', current_version: 2,
        config: JSON.stringify({ function_name: 'start_workflow', params: { workflow_id: '27' } }) },
      { parent_id: 51, step_number: 1, version: 1, parent_name: 'Other', current_version: 1,
        config: JSON.stringify({ function_name: 'start_workflow', params: { workflow_id: '{{dynamic}}' } }) },
    ]],
    [/FROM cta_links/, [
      { id: 60, name: 'Re-run intake', expires_at: new Date(Date.now() + 86400000),
        options: JSON.stringify([{ value: 'go', plan: [{ fn: 'start_workflow', params: { workflow_id: '27' } }] }]) },
      { id: 61, name: 'Other CTA', expires_at: new Date(),
        options: JSON.stringify([{ value: 'go', plan: [{ fn: 'start_workflow', params: { workflow_id: '99' } }] }]) },
    ]],
  ]);

  test('hooks, trigger rules, sequence steps, exact parent steps and matching CTAs are found; dynamic and non-matching are not', async () => {
    const rows = await automation.references(db(), { workflow_id: 27 });
    const by = (source) => rows.filter((r) => r.source === source);
    expect(by('hook')).toHaveLength(1);
    expect(by('trigger_rule')[0]).toMatchObject({ source_name: 'On new case', detail: expect.stringContaining('case.created') });
    expect(by('sequence_step')[0]).toMatchObject({ source_name: 'Onboarding', active: true });
    expect(by('workflow_step')).toHaveLength(1);        // the '{{dynamic}}' parent is not listed
    expect(by('workflow_step')[0].source_id).toBe(50);
    expect(by('cta_link')).toHaveLength(1);             // workflow 99's CTA is not
    expect(by('cta_link')[0].source_id).toBe(60);
  });

  test('no starters at all is said plainly, not returned empty', async () => {
    const empty = dbOf([[/FROM/, []]]);
    const rows = await automation.references(empty, { workflow_id: 27 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'none' });
    expect(rows[0].detail).toMatch(/only by hand or API/);
  });
});

describe('the read-step validator and fingerprints know the four kinds', () => {
  const step = (over) => svc.validateStep({ purpose: 'p', ...over }, 0);

  test('each kind validates its own shape and rejects bad ids', () => {
    expect(step({ id: 'q1', kind: 'automation.list', query: 'intake' }))
      .toMatchObject({ kind: 'automation.list', query: 'intake', limit: 50 });
    expect(step({ id: 'q1', kind: 'automation.definition', workflow_id: 27 }))
      .toMatchObject({ kind: 'automation.definition', workflow_id: 27 });
    expect(step({ id: 'q1', kind: 'automation.definition', workflow_id: 27, version: 0 }))
      .toMatchObject({ version: 0 });
    expect(step({ id: 'q1', kind: 'automation.run', execution_id: 500 }))
      .toMatchObject({ execution_id: 500 });
    expect(step({ id: 'q1', kind: 'automation.references', workflow_id: 27 }))
      .toMatchObject({ workflow_id: 27 });
    expect(() => step({ id: 'q1', kind: 'automation.definition' })).toThrow(/positive workflow_id/);
    expect(() => step({ id: 'q1', kind: 'automation.run', execution_id: 'DROP TABLE' })).toThrow(/positive execution_id/);
    expect(() => step({ id: 'q1', kind: 'automation.nope' })).toThrow(/unavailable operation/);
  });

  test('fingerprints distinguish targets so a plan cannot repeat one read', () => {
    const fp = svc.stepFingerprint;
    expect(fp({ kind: 'automation.definition', workflow_id: 27 }))
      .not.toBe(fp({ kind: 'automation.definition', workflow_id: 28 }));
    expect(fp({ kind: 'automation.definition', workflow_id: 27 }))
      .not.toBe(fp({ kind: 'automation.definition', workflow_id: 27, version: 3 }));
    expect(fp({ kind: 'automation.run', execution_id: 1 })).toBe(fp({ kind: 'automation.run', execution_id: 1 }));
  });
});

describe('both read-planning prompts teach every read kind (the S3b lesson, read side)', () => {
  const fs = require('fs');
  const planPrompt = fs.readFileSync(path.join(__dirname, '..', 'lib', 'aiPrompts', 'assistantPlan.js'), 'utf8');
  const investigatePrompt = fs.readFileSync(path.join(__dirname, '..', 'lib', 'aiPrompts', 'assistantInvestigate.js'), 'utf8');

  // The validator is the authority on which kinds exist; both prompts must
  // name each one, or the stage that is blind will refuse what the other runs.
  const READ_KINDS = ['sql.read', 'manual.search', 'comms.search', 'weather.lookup',
    'automation.list', 'automation.definition', 'automation.run', 'automation.references'];

  test('the inventory matches the validator', () => {
    for (const kind of READ_KINDS.filter((k) => k !== 'sql.read')) {
      expect(() => svc.validateStep({ id: 'q1', kind, purpose: 'p', query: 'xx', location: 'xx',
        workflow_id: 1, execution_id: 1 }, 0)).not.toThrow();
    }
    expect(() => svc.validateStep({ id: 'q1', kind: 'automation.unknown', purpose: 'p' }, 0))
      .toThrow(/unavailable operation/);
  });

  test('every kind is named in BOTH the plan and investigate prompts', () => {
    for (const kind of READ_KINDS) {
      expect({ kind, plan: planPrompt.includes(kind) }).toEqual({ kind, plan: true });
      expect({ kind, investigate: investigatePrompt.includes(kind) }).toEqual({ kind, investigate: true });
    }
  });
});
