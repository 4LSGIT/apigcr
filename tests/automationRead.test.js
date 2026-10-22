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

describe('P12b — the sequence half carries the same redaction', () => {
  const seqDb = () => dbOf([
    [/FROM sequence_templates WHERE id/, [{ id: 5, name: 'No-show chase', type: 'no_show', active: 1,
      description: 'd', current_version: 4, draft_version: 5 }]],
    [/FROM credentials/, [{ id: 3, name: 'Clio OAuth' }]],
    [/FROM sequence_steps WHERE template_id/, [
      { step_number: 1, action_type: 'sms', action_config: JSON.stringify({ to: '{{contact_phone}}', message: 'Hi {{contact_fname}}' }),
        timing: JSON.stringify({ delay_days: 0 }), condition: null, fire_guard: null, error_policy: null },
      { step_number: 2, action_type: 'webhook', action_config: JSON.stringify({ url: SECRET_URL, method: 'POST', credential_id: 3 }),
        timing: JSON.stringify({ delay_days: 1 }), condition: null, fire_guard: null, error_policy: null },
    ]],
  ]);

  test('sequence definition: sms templates readable, webhook URL redacted, timing kept', async () => {
    const rows = await automation.definition(seqDb(), { sequence_template_id: 5 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ sequence_template_id: 5, template_name: 'No-show chase', version: 4, is_draft: 0 });
    expect(JSON.parse(rows[0].action_config).message).toBe('Hi {{contact_fname}}');
    expect(JSON.parse(rows[0].timing)).toEqual({ delay_days: 0 });
    const hook = JSON.parse(rows[1].action_config);
    expect(JSON.stringify(rows)).not.toContain('SECRET-TOKEN');
    expect(hook.url_host).toBe('hooks.example.com');
    expect(hook.credential).toBe('Clio OAuth');
  });

  test('enrollment run: action_config_resolved never selected, output verdict-only, pending step listed', async () => {
    const d = dbOf([
      [/FROM sequence_enrollments e/, [{ enrollment_id: 90, sequence_template_id: 5, template_name: 'No-show chase',
        template_version: 4, status: 'active', contact_id: 9, appt_id: 44, current_step: 2, total_steps: 3,
        cancel_reason: null, enrolled_at: 'a', completed_at: null, trigger_data: JSON.stringify({ appt_id: 44 }) }]],
      [/FROM sequence_step_log/, [
        { step_number: 1, step_id: 71, status: 'sent', skip_reason: null, error_message: null, duration_ms: 20,
          scheduled_at: 's', executed_at: 'e',
          output_data: JSON.stringify({ success: true, resolved_body: 'Hi Jane PII' }) },
      ]],
      [/FROM scheduled_jobs/, [{ job_id: 12, job_status: 'pending', scheduled_time: 't2' }]],
    ]);
    const rows = await automation.run(d, { enrollment_id: 90 });
    for (const q of d.seen) expect(q.sql).not.toMatch(/action_config_resolved/);
    expect(JSON.stringify(rows)).not.toContain('Hi Jane');
    expect(rows[0]).toMatchObject({ row: 'enrollment', enrollment_id: 90, status: 'active' });
    expect(JSON.parse(rows.find((r) => r.row === 'step').output_verdict)).toEqual({ success: true });
    expect(rows.find((r) => r.row === 'pending_step')).toMatchObject({ job_id: 12 });
  });

  test('sequence references match by exact id AND by template type', async () => {
    const d = dbOf([
      [/FROM sequence_templates WHERE id/, [{ id: 5, type: 'no_show' }]],
      [/FROM hook_targets/, [
        { target_id: 1, target_name: 'byid', target_active: 1, hook_id: 4, hook_name: 'H1',
          config: JSON.stringify({ template_id: 5 }) },
        { target_id: 2, target_name: 'bytype', target_active: 1, hook_id: 6, hook_name: 'H2',
          config: JSON.stringify({ template_type: 'no_show' }) },
        { target_id: 3, target_name: 'other', target_active: 1, hook_id: 7, hook_name: 'H3',
          config: JSON.stringify({ template_type: 'welcome' }) },
      ]],
      [/FROM trigger_rule_actions/, []],
      [/FROM workflow_steps s JOIN workflows w/, [
        { parent_id: 50, step_number: 2, version: 3, parent_name: 'P', current_version: 3,
          config: JSON.stringify({ function_name: 'enroll_sequence', params: { template_type: 'no_show' } }) },
      ]],
      [/FROM cta_links/, []],
    ]);
    const rows = await automation.references(d, { sequence_template_id: 5 });
    const hooks = rows.filter((r) => r.source === 'hook');
    expect(hooks).toHaveLength(2);
    expect(hooks[0].detail).toMatch(/by id/);
    expect(hooks[1].detail).toMatch(/by type "no_show"/);
    expect(rows.filter((r) => r.source === 'workflow_step')).toHaveLength(1);
  });

  test('automation.list type sequences returns the template inventory', async () => {
    const d = dbOf([[/FROM sequence_templates t/, [{ sequence_template_id: 5, name: 'No-show chase',
      template_type: 'no_show', active: 1, current_version: 4, draft_version: null, description: 'd', step_count: 3 }]]]);
    const rows = await automation.list(d, { type: 'sequences', limit: 10 });
    expect(rows[0]).toMatchObject({ sequence_template_id: 5, template_type: 'no_show', active: true });
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
    expect(() => step({ id: 'q1', kind: 'automation.definition' })).toThrow(/exactly one of workflow_id or sequence_template_id/);
    expect(() => step({ id: 'q1', kind: 'automation.run', execution_id: 'DROP TABLE' })).toThrow(/positive execution_id/);
    expect(() => step({ id: 'q1', kind: 'automation.nope' })).toThrow(/unavailable operation/);
    // The sequence half (P12b): each kind takes the sequence id instead —
    // exactly one, never both.
    expect(step({ id: 'q1', kind: 'automation.definition', sequence_template_id: 5 }))
      .toMatchObject({ sequence_template_id: 5 });
    expect(step({ id: 'q1', kind: 'automation.run', enrollment_id: 9 })).toMatchObject({ enrollment_id: 9 });
    expect(step({ id: 'q1', kind: 'automation.references', sequence_template_id: 5 }))
      .toMatchObject({ sequence_template_id: 5 });
    expect(step({ id: 'q1', kind: 'automation.list', type: 'sequences' })).toMatchObject({ type: 'sequences' });
    expect(() => step({ id: 'q1', kind: 'automation.definition', workflow_id: 1, sequence_template_id: 5 }))
      .toThrow(/exactly one/);
    expect(() => step({ id: 'q1', kind: 'automation.run', execution_id: 1, enrollment_id: 9 })).toThrow(/exactly one/);
    expect(() => step({ id: 'q1', kind: 'automation.list', type: 'everything' })).toThrow(/workflows" or "sequences/);
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

describe('A17.1 — the run-explainer rides only with automation evidence', () => {
  const approved = { viewer: { user_id: 7, display_name: 'S', initials: 'S', roles: ['staff'] }, workspace: null };

  test('automation evidence appends the measured engine rules; other evidence does not', () => {
    const plain = svc.answerSystemAppend(approved, [{ kind: 'sql.read', rows: [] }]);
    expect(plain).not.toMatch(/AUTOMATION RUN READING RULES/);
    const withAutomation = svc.answerSystemAppend(approved,
      [{ kind: 'sql.read', rows: [] }, { kind: 'automation.run', rows: [] }]);
    expect(withAutomation).toMatch(/AUTOMATION RUN READING RULES/);
    // The server-verified context still leads; the rules are appended, not a
    // replacement. (Byte equality with `plain` is not asserted — the context
    // carries a clock.)
    expect(withAutomation).toMatch(/current_staff/);
    expect(withAutomation.indexOf('current_staff')).toBeLessThan(withAutomation.indexOf('AUTOMATION RUN READING RULES'));
  });

  test('the rules carry the six measured traps and the output contract', () => {
    const { AUTOMATION_RUN_EXPLAINER } = require(path.join(__dirname, '..', 'lib', 'aiPrompts', 'automationRunExplainer'));
    for (const marker of [
      'DID NOT THROW',                       // trap 1: success means non-throwing
      'consulted only',                      // trap 2: retries before strategy
      'never written (always 0)',            // trap 3: attempts column
      'withheld from you entirely',          // trap 4: no resolved payloads
      'EMPTY STRING silently',               // trap 5: unresolved placeholders
      'completed_with_errors means at least one history row failed', // trap 6
      'AS INSTRUCTIONS TO THE HUMAN',        // output contract
      'Do not propose an action card',       // no authoring yet
    ]) {
      expect({ marker, present: AUTOMATION_RUN_EXPLAINER.includes(marker) }).toEqual({ marker, present: true });
    }
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
