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

  test('an UNPUBLISHED workflow (current_version 0) falls back to its draft steps', async () => {
    // Live failure (chat 41): reading version 0 returned "no steps" and the
    // model argued the workflow was empty when its draft had three steps.
    const d = dbOf([
      [/FROM workflows WHERE id/, [{ id: 56, name: 'Chase', active: 1, description: 'd', current_version: 0, draft_version: 1 }]],
      [/FROM credentials/, []],
      [/FROM workflow_steps WHERE workflow_id/, (sql, params) => params[1] === 1
        ? [{ step_number: 1, label: null, note: null, type: 'internal_function',
            config: JSON.stringify({ function_name: 'noop', params: {} }), error_policy: null }]
        : []],
    ]);
    const rows = await automation.definition(d, { workflow_id: 56 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 1, is_draft: 1 });
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

  test('P12c: workflow_id resolves the LATEST execution — "why did the last run do nothing" needs no known id', async () => {
    // Live confusion (chat 44): with only id-keyed runs and the automation
    // tables outside the curated SQL, the model had no path to the latest
    // execution and inferred the cause from a task row.
    const d = dbOf([
      [/SELECT id FROM workflow_executions WHERE workflow_id/, [{ id: 15209 }]],
      [/FROM workflow_executions e/, [{ execution_id: 15209, workflow_id: 57, workflow_name: 'Chase',
        workflow_version: 1, status: 'delayed', contact_id: null, current_step_number: 2,
        steps_executed_count: 1, created_at: 'c', completed_at: null, cancel_reason: null,
        init_data: '{}', variables: '{}' }]],
      [/FROM workflow_execution_steps/, []],
      [/FROM scheduled_jobs/, []],
    ]);
    const rows = await automation.run(d, { workflow_id: 57 });
    expect(rows[0]).toMatchObject({ row: 'execution', execution_id: 15209, status: 'delayed' });
    const none = dbOf([[/SELECT id FROM workflow_executions WHERE workflow_id/, []]]);
    await expect(automation.run(none, { workflow_id: 99 })).rejects.toThrow(/no executions yet/);
    // The validator takes exactly one selector; fingerprints keep them apart.
    expect(svc.validateStep({ id: 'q1', kind: 'automation.run', purpose: 'p', workflow_id: 57 }, 0))
      .toMatchObject({ workflow_id: 57 });
    expect(() => svc.validateStep({ id: 'q1', kind: 'automation.run', purpose: 'p', workflow_id: 57, execution_id: 1 }, 0))
      .toThrow(/exactly one/);
    expect(svc.stepFingerprint({ kind: 'automation.run', workflow_id: 57 }))
      .not.toBe(svc.stepFingerprint({ kind: 'automation.run', execution_id: 57 }));
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
    // A20.0: ingest-rule workflow actions are starters too (email rule 15's
    // action names workflow 27; the phone one names another workflow).
    [/FROM email_ingest_rule_actions a JOIN email_ingest_rules r/, [
      { action_id: 14, action_name: 'start intake', action_active: 1, rule_id: 15, rule_name: 'court emails', rule_active: 1,
        config: { workflow_id: 27 } },
      { action_id: 15, action_name: null, action_active: 1, rule_id: 16, rule_name: 'other', rule_active: 1,
        config: { workflow_id: '270' } },
    ]],
    [/FROM phone_ingest_rule_actions a JOIN phone_ingest_rules r/, [
      { action_id: 2, action_name: null, action_active: 0, rule_id: 2, rule_name: 'texts', rule_active: 1,
        config: JSON.stringify({ workflow_id: '27' }) },
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
    // A20.0: ingest rule actions start workflows too — exact id (number or
    // numeric string), carrying the rule's own id key; 270 is not 27.
    expect(by('email_ingest_rule')).toEqual([expect.objectContaining({ email_ingest_rule_id: 15, source_name: 'court emails', active: true })]);
    expect(by('phone_ingest_rule')).toEqual([expect.objectContaining({ phone_ingest_rule_id: 2, active: false })]);
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
      [/FROM email_ingest_rule_actions a JOIN/, [
        { action_id: 30, action_name: 'enroll', action_active: 1, rule_id: 21, rule_name: 'clio payment failed', rule_active: 1,
          config: { template_type: 'no_show', contact_id_field: 'contact_id' } },
        { action_id: 31, action_name: 'other', action_active: 1, rule_id: 22, rule_name: 'x', rule_active: 1,
          config: { template_id: 6 } },
      ]],
      [/FROM phone_ingest_rule_actions a JOIN/, []],
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
    // A20.0: an ingest rule's sequence action enrolls by type here; template 6 is another template.
    expect(rows.filter((r) => r.source === 'email_ingest_rule')).toEqual([
      expect.objectContaining({ email_ingest_rule_id: 21, sequence_template_id: 5, detail: expect.stringMatching(/by type "no_show"/) })]);
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

describe('A17.2 — automation.preview_step is a dry run by construction', () => {
  const preview = require(path.join(__dirname, '..', 'services', 'stepPreviewService'));
  const STAFF = { type: 'jwt', userId: 2, roles: ['staff'] };
  const ADMIN = { type: 'jwt', userId: 1, roles: ['admin', 'staff'] };

  test('resolves placeholders, flags unresolved ones, and validates params — executing nothing', () => {
    const rows = preview.previewRows({ auth: STAFF, step_type: 'internal_function',
      config: { function_name: 'send_sms', params: { to: '{{contact_phone}}', message: 'Hi {{contact_fname}}' } },
      variables: { contact_phone: '2485550100' } });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.dry_run).toBe(1);
    expect(JSON.parse(r.resolved_config).params.to).toBe('2485550100');
    expect(r.unresolved_placeholders).toBe('{{contact_fname}}');
    // An explicitly-empty variable is NOT flagged; an unset one is.
    const empty = preview.previewRows({ auth: STAFF, step_type: 'internal_function',
      config: { function_name: 'send_sms', params: { to: '{{x}}' } }, variables: { x: '' } });
    expect(empty[0].unresolved_placeholders).toBeNull();
  });

  test('the capability gate holds: staff cannot preview a standard code step; safe is open', () => {
    expect(() => preview.previewRows({ auth: STAFF, step_type: 'custom_code', config: { code: '1;' } }))
      .toThrow(/automations\.manage/);
    expect(preview.previewRows({ auth: STAFF, step_type: 'custom_code',
      config: { code: '1;', code_mode: 'safe' } })[0].dry_run).toBe(1);
    expect(preview.previewRows({ auth: ADMIN, step_type: 'custom_code', config: { code: '1;' } })[0].dry_run).toBe(1);
  });

  test('a webhook preview notes credential injection without resolving it, and this.* variables are stripped', () => {
    const rows = preview.previewRows({ auth: STAFF, step_type: 'webhook',
      config: { url: 'https://x.example.com', method: 'POST', credential_id: 3, body: { v: '{{this.output.x}}' } },
      variables: { 'this.output.x': 'phantom' } });
    expect(rows[0].credential_note).toMatch(/injected at send time/);
    // The phantom this.* variable was stripped, so the token stays unresolved.
    expect(rows[0].unresolved_placeholders).toContain('{{this.output.x}}');
  });

  test('the validator caps and shapes the kind; the fingerprint distinguishes configs', () => {
    const step = (over) => svc.validateStep({ id: 'q1', purpose: 'p', kind: 'automation.preview_step', ...over }, 0);
    expect(step({ step_type: 'webhook', config: { url: 'x' } })).toMatchObject({ kind: 'automation.preview_step' });
    expect(() => step({ step_type: 'trigger', config: {} })).toThrow(/step_type must be/);
    expect(() => step({ step_type: 'webhook' })).toThrow(/needs a config object/);
    expect(() => step({ step_type: 'webhook', config: { big: 'x'.repeat(20001) } })).toThrow(/exceeds 20000/);
    expect(svc.stepFingerprint({ kind: 'automation.preview_step', step_type: 'webhook', config: { a: 1 } }))
      .not.toBe(svc.stepFingerprint({ kind: 'automation.preview_step', step_type: 'webhook', config: { a: 2 } }));
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

  test('automation evidence raises the answer output ceiling — a workflow card cannot fit in 2500 tokens', () => {
    // Live failure 2026-10-22 15:11 UTC (alert 2008): the answer prompt's
    // registered cap truncated a workflow.draft.v1 card's JSON mid-stream,
    // aiService stamped json_parse, and the user saw the generic 502 twice.
    expect(svc.answerMaxTokens([{ kind: 'sql.read', rows: [] }])).toBeUndefined();
    expect(svc.answerMaxTokens([{ kind: 'automation.definition', rows: [] }])).toBeGreaterThanOrEqual(8000);
  });

  test('the raised ceiling is WIRED into the answer call (plan → execute, automation carrier)', async () => {
    const aiService = require(path.join(__dirname, '..', 'services', 'aiService'));
    const OLD_SECRET = process.env.JWT_SECRET;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'automation-read-test-secret';
    const db = {
      query: jest.fn(async (sql) => {
        if (/FROM users WHERE user/.test(sql)) return [[{ user: 7, user_name: 'S S', user_initials: 'SS', roles: 'staff' }]];
        if (/FROM workflows w/.test(sql)) return [[{ workflow_id: 1, name: 'W', active: 1, current_version: 1, draft_version: null, description: '', step_count: 1 }]];
        return [[]];
      }),
    };
    const spy = jest.spyOn(aiService, 'call')
      // plan(): direct answer to an action request → server backstop makes the
      // automation.list carrier plan.
      .mockResolvedValueOnce({ ok: true, callId: 1, json: { action: 'answer', answer: 'Card on the way.' } })
      // execute(): the investigate controller finishes...
      .mockResolvedValueOnce({ ok: true, callId: 2, json: { action: 'finish', reason: 'enough' } })
      // ...and the answer call returns a minimal valid answer.
      .mockResolvedValueOnce({ ok: true, callId: 3, json: { answer: 'Done.', suggestions: [], action_draft: null } });
    try {
      const made = await svc.plan(db, { question: 'Build a workflow that chases missing documents', history: [], userId: 7 });
      expect(made.outcome).toBe('plan');
      await svc.execute(db, { signedTicket: made.ticket, userId: 7, auth: { type: 'jwt', userId: 7, roles: ['staff'] } });
      const answerCall = spy.mock.calls.find(([, opts]) => opts.promptKey === 'assistant_answer');
      expect(answerCall).toBeDefined();
      expect(answerCall[1].max_tokens).toBe(8000);
    } finally {
      process.env.JWT_SECRET = OLD_SECRET;
      spy.mockRestore();
    }
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
    'automation.list', 'automation.definition', 'automation.run', 'automation.references',
    'automation.preview_step', 'automation.preview_ingest_rule'];

  test('the inventory matches the validator', () => {
    // Per-kind minimal params — automation.run takes exactly ONE selector, so
    // a shared bag with several ids would itself be invalid.
    const PARAMS = {
      'manual.search': { query: 'xx' }, 'comms.search': { query: 'xx' }, 'weather.lookup': { location: 'xx' },
      'automation.list': {}, 'automation.definition': { workflow_id: 1 },
      'automation.run': { execution_id: 1 }, 'automation.references': { workflow_id: 1 },
      'automation.preview_step': { step_type: 'internal_function', config: { function_name: 'noop' } },
      'automation.preview_ingest_rule': { email_ingest_rule_id: 1, email_ingest_execution_id: 1 },
    };
    for (const kind of READ_KINDS.filter((k) => k !== 'sql.read')) {
      expect(() => svc.validateStep({ id: 'q1', kind, purpose: 'p', ...PARAMS[kind] }, 0)).not.toThrow();
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

describe('A20.0/A20.1 — the ingest-rule family rides the same kinds', () => {
  const step = (over) => svc.validateStep({ id: 'q1', purpose: 'p', ...over }, 0);

  test('list takes the six ingest types; since/until only on the executions finder', () => {
    for (const type of ['email_ingest_rules', 'phone_ingest_rules', 'email_ingest_suppressions',
      'phone_ingest_suppressions', 'email_ingest_executions', 'phone_ingest_executions']) {
      expect(step({ kind: 'automation.list', type })).toMatchObject({ type });
    }
    expect(step({ kind: 'automation.list', type: 'email_ingest_executions', query: 'mieb', since: '2026-10-25', until: '2026-10-25 18:00' }))
      .toMatchObject({ since: '2026-10-25', until: '2026-10-25 18:00' });
    expect(() => step({ kind: 'automation.list', type: 'email_ingest_rules', since: '2026-10-25' })).toThrow(/apply only to the email_ingest_executions/);
    expect(() => step({ kind: 'automation.list', since: '2026-10-25' })).toThrow(/apply only to/);
    expect(() => step({ kind: 'automation.list', type: 'email_ingest_executions', since: 'yesterday' })).toThrow(/firm-local date/);
    expect(() => step({ kind: 'automation.list', type: 'email_ingest_executions', since: '2026-10-26', until: '2026-10-25' })).toThrow(/until is before since/);
    expect(() => step({ kind: 'automation.list', type: 'email_ingest_sources' })).toThrow(/automation.list type must be/);
  });

  test('definition / run / references take the ingest id keys — exactly one, and ingest rules are unversioned', () => {
    expect(step({ kind: 'automation.definition', email_ingest_rule_id: 15 })).toMatchObject({ email_ingest_rule_id: 15 });
    expect(step({ kind: 'automation.definition', phone_ingest_rule_id: 3 })).toMatchObject({ phone_ingest_rule_id: 3 });
    expect(() => step({ kind: 'automation.definition', email_ingest_rule_id: 15, version: 1 })).toThrow(/unversioned/);
    expect(() => step({ kind: 'automation.definition', email_ingest_rule_id: 15, workflow_id: 2 })).toThrow(/exactly one/);
    expect(() => step({ kind: 'automation.definition', email_ingest_rule_id: 'x' })).toThrow(/positive email_ingest_rule_id/);
    for (const key of ['email_ingest_execution_id', 'phone_ingest_execution_id', 'email_ingest_rule_id', 'phone_ingest_rule_id']) {
      expect(step({ kind: 'automation.run', [key]: 9 })).toMatchObject({ [key]: 9 });
    }
    expect(() => step({ kind: 'automation.run', email_ingest_execution_id: 9, email_ingest_rule_id: 1 })).toThrow(/exactly one/);
    expect(step({ kind: 'automation.references', phone_ingest_rule_id: 2 })).toMatchObject({ phone_ingest_rule_id: 2 });
  });

  test('preview_ingest_rule names a STORED rule only and can express nothing but a message source', () => {
    const base = { kind: 'automation.preview_ingest_rule', email_ingest_rule_id: 15 };
    expect(step({ ...base, email_ingest_execution_id: 28500 }))
      .toEqual({ id: 'q1', purpose: 'p', kind: 'automation.preview_ingest_rule', channel: 'email', email_ingest_rule_id: 15, email_ingest_execution_id: 28500 });
    expect(step({ kind: 'automation.preview_ingest_rule', phone_ingest_rule_id: 3, sample: { type: 'sms', message: 'hi' } }))
      .toMatchObject({ channel: 'phone', sample: { type: 'sms' } });
    expect(step({ ...base, window: { since: '2026-10-25' } })).toMatchObject({ window: { limit: 20, since: '2026-10-25' } });
    // A supplied rule body is refused — every native body field.
    for (const k of ['match_mode', 'match_config', 'transform_mode', 'transform_config', 'code', 'rule', 'params_mappings']) {
      expect(() => step({ ...base, email_ingest_execution_id: 1, [k]: k === 'match_mode' ? 'code' : { code: 'return process.env' } }))
        .toThrow(/STORED ingest rule only/);
    }
    expect(() => step({ kind: 'automation.preview_ingest_rule', email_ingest_execution_id: 1 })).toThrow(/exactly one of email_ingest_rule_id or phone_ingest_rule_id/);
    expect(() => step({ ...base, phone_ingest_rule_id: 2, email_ingest_execution_id: 1 })).toThrow(/exactly one of email_ingest_rule_id/);
    expect(() => step({ ...base, phone_ingest_execution_id: 1 })).toThrow(/cannot preview a email rule against a phone execution/);
    expect(() => step(base)).toThrow(/exactly one message source/);
    expect(() => step({ ...base, email_ingest_execution_id: 1, sample: {} })).toThrow(/exactly one message source/);
    expect(() => step({ ...base, sample: [1] })).toThrow(/sample must be a JSON object/);
    expect(() => step({ ...base, sample: { text: 'x'.repeat(8001) } })).toThrow(/exceeds 8000/);
    expect(() => step({ ...base, window: { limit: 41 } })).toThrow(/window limit must be 1-40/);
    expect(() => step({ ...base, window: { limit: 5, match_config: {} } })).toThrow(/window takes only limit, since, until/);
    expect(() => step({ ...base, window: { since: 'last week' } })).toThrow(/firm-local date/);
  });

  test('fingerprints keep ingest reads apart from workflow / sequence reads of the same number', () => {
    const fp = svc.stepFingerprint;
    expect(fp({ kind: 'automation.definition', email_ingest_rule_id: 5 })).not.toBe(fp({ kind: 'automation.definition', workflow_id: 5 }));
    expect(fp({ kind: 'automation.definition', email_ingest_rule_id: 5 })).not.toBe(fp({ kind: 'automation.definition', phone_ingest_rule_id: 5 }));
    expect(fp({ kind: 'automation.definition', email_ingest_rule_id: 5 })).not.toBe(fp({ kind: 'automation.definition', email_ingest_rule_id: 6 }));
    expect(fp({ kind: 'automation.references', phone_ingest_rule_id: 5 })).not.toBe(fp({ kind: 'automation.references', phone_ingest_rule_id: 6 }));
    expect(fp({ kind: 'automation.definition', phone_ingest_rule_id: 5 })).not.toBe(fp({ kind: 'automation.definition', sequence_template_id: 5 }));
    expect(fp({ kind: 'automation.run', email_ingest_execution_id: 5 })).not.toBe(fp({ kind: 'automation.run', execution_id: 5 }));
    expect(fp({ kind: 'automation.run', email_ingest_rule_id: 5 })).not.toBe(fp({ kind: 'automation.run', email_ingest_execution_id: 5 }));
    expect(fp({ kind: 'automation.list', type: 'email_ingest_executions', since: '2026-10-01' }))
      .not.toBe(fp({ kind: 'automation.list', type: 'email_ingest_executions', since: '2026-10-02' }));
    expect(fp({ kind: 'automation.preview_ingest_rule', email_ingest_rule_id: 5, email_ingest_execution_id: 1 }))
      .not.toBe(fp({ kind: 'automation.preview_ingest_rule', email_ingest_rule_id: 5, email_ingest_execution_id: 2 }));
  });

  test('http action configs are redacted to method + host + credential label; other types keep their keys minus url/headers', () => {
    const creds = new Map([[3, 'Clio OAuth']]);
    const http = automation.projectIngestActionConfig('http',
      { url: SECRET_URL, method: 'put', credential_id: 3, headers: { 'X-Static-Secret': 'shh' }, body_mode: 'template', body_template: '{"a":1}' }, creds);
    const text = JSON.stringify(http);
    expect(text).not.toContain('SECRET-TOKEN');
    expect(text).not.toContain('/t/');
    expect(text).not.toContain('shh');
    expect(http).toMatchObject({ method: 'put', url_host: 'hooks.example.com', url_redacted: true, credential: 'Clio OAuth',
      header_keys: ['X-Static-Secret'], body_mode: 'template' });
    const fn = automation.projectIngestActionConfig('internal_function',
      { function_name: 'court_extract', params_mapping: { body: 'body' }, url: SECRET_URL, headers: { a: 'shh' } }, creds);
    expect(fn).toEqual({ function_name: 'court_extract', params_mapping: { body: 'body' } });
  });

  test('code bodies are readable in parts under the cell cap; JSON configs are one capped cell', () => {
    const short = automation.ingestConfigCell('code', { code: 'return 1;' });
    expect(short).toEqual({ cell: 'return 1;', parts: [] });
    const long = 'x'.repeat(10775);
    const cut = automation.ingestConfigCell('code', { code: long });
    expect(cut.parts).toHaveLength(5);
    expect(cut.parts.join('')).toBe(long);
    for (const p of cut.parts) expect(p.length).toBeLessThanOrEqual(automation.CODE_PART_CHARS);
    expect(cut.cell).toMatch(/10775 chars in 5 code_part rows/);
    const huge = automation.ingestConfigCell('code', { code: 'y'.repeat(automation.CODE_PART_CHARS * automation.CODE_PARTS_MAX + 7) });
    expect(huge.cell).toMatch(/the last 7 chars are not shown/);
    expect(automation.ingestConfigCell('conditions', null)).toEqual({ cell: null, parts: [] });
    expect(automation.ingestConfigCell('conditions', { operator: 'and', conditions: [] }).cell).toBe('{"operator":"and","conditions":[]}');
  });

  test('the ingest reading rules ride only with ingest evidence, after the run rules', () => {
    const approved = { viewer: { user_id: 7, display_name: 'S', initials: 'S', roles: ['staff'] }, workspace: null };
    const wfOnly = svc.answerSystemAppend(approved, [{ kind: 'automation.definition', rows: [{ workflow_id: 27 }] }]);
    expect(wfOnly).toMatch(/AUTOMATION RUN READING RULES/);
    expect(wfOnly).not.toMatch(/INGEST RULE READING RULES/);
    for (const ev of [
      [{ kind: 'automation.run', rows: [{ row: 'execution', email_ingest_execution_id: 1 }] }],
      [{ kind: 'automation.list', rows: [{ phone_ingest_rule_id: 2 }] }],
      [{ kind: 'automation.preview_ingest_rule', rows: [] }],
    ]) {
      const text = svc.answerSystemAppend(approved, ev);
      expect(text).toMatch(/INGEST RULE READING RULES/);
      expect(text.indexOf('AUTOMATION RUN READING RULES')).toBeLessThan(text.indexOf('INGEST RULE READING RULES'));
    }
    // An ingest-looking key in NON-automation evidence does not count.
    expect(svc.answerSystemAppend(approved, [{ kind: 'sql.read', rows: [{ email_ingest_rule_id: 1 }] }])).not.toMatch(/INGEST RULE/);
  });

  test('the ingest rules carry the code-verified semantics and the authoring contract', () => {
    const { INGEST_RULE_EXPLAINER } = require(path.join(__dirname, '..', 'lib', 'aiPrompts', 'automationRunExplainer'));
    for (const marker of [
      'suppression hides, it does not cancel',
      'dedupe is PER SOURCE',
      'skipped_firm_to_firm\n   = Layer 3 DID run',
      'EVERY matching rule fires',
      'is NOT recorded on the execution\n   row',
      'NULL match_config in conditions mode is a NON-match, not match-all',
      'NONE of\n   its actions fire',
      'Action failures are isolated',
      'updated_at is\n   NOT "last edited"',
      'definition_updated_at IS',
      'ONE reviewed ingest_rule.* card',
    ]) {
      expect({ marker, present: INGEST_RULE_EXPLAINER.includes(marker) }).toEqual({ marker, present: true });
    }
  });
});

describe('A20 — the ingest reads are WIRED through plan → execute → answer', () => {
  const aiService = require(path.join(__dirname, '..', 'services', 'aiService'));

  test('a planned ingest run + preview reach the answer as evidence, with the ingest rules appended', async () => {
    const OLD_SECRET = process.env.JWT_SECRET;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'automation-read-test-secret';
    const seen = [];
    const db = {
      query: jest.fn(async (sql, params) => {
        seen.push({ sql: String(sql), params });
        const s = String(sql);
        if (/FROM users WHERE user/.test(s)) return [[{ user: 7, user_name: 'S S', user_initials: 'SS', roles: 'staff' }]];
        if (/FROM email_ingest_rules WHERE id = \?/.test(s)) return [[{ id: 15, name: 'court emails', active: 1, position: 0,
          match_mode: 'conditions', match_config: { operator: 'and', conditions: [] }, transform_mode: 'passthrough', transform_config: null }]];
        if (/FROM email_ingest_rule_actions WHERE rule_id = \?/.test(s)) return [[]];
        if (/FROM email_ingest_executions eie/.test(s)) return [[{ exec_id: 28500, created_at: new Date('2026-10-26T08:52:16Z'), status: 'logged',
          raw_input: { kind: 'email', from: { email: 'ecf@mieb.uscourts.gov' }, subject: 'Notice', text: 't' }, el_id: 1 }]];
        if (/SELECT message_id FROM email_ingest_executions/.test(s)) return [[{ message_id: 'm-1' }]];
        if (/FROM email_ingest_executions e LEFT JOIN email_log/.test(s)) return [[{ id: 28500, status: 'logged',
          created_at: new Date('2026-10-26T08:52:16Z'), metadata: { matched_rules: [15], action_outcomes: [] }, action_failure_count: 0 }]];
        if (/FROM email_ingest_rules WHERE id IN/.test(s)) return [[{ id: 15, name: 'court emails', active: 1 }]];
        return [[]];
      }),
    };
    const steps = [
      { id: 'q1', kind: 'automation.run', purpose: 'the message', email_ingest_execution_id: 28500 },
      { id: 'q2', kind: 'automation.preview_ingest_rule', purpose: 'dry run', email_ingest_rule_id: 15, email_ingest_execution_id: 28500 },
    ];
    const spy = jest.spyOn(aiService, 'call')
      .mockResolvedValueOnce({ ok: true, callId: 1, json: { action: 'query', summary: 's', steps } })
      .mockResolvedValueOnce({ ok: true, callId: 2, json: { action: 'finish', reason: 'enough' } })
      .mockResolvedValueOnce({ ok: true, callId: 3, json: { answer: 'It matched.', citations: [], suggestions: [], action_draft: null } });
    try {
      const made = await svc.plan(db, { question: 'Why did the court email rule fire on execution 28500?', history: [], userId: 7 });
      expect(made.outcome).toBe('plan');
      // The widened automation budget applies to an ingest plan too.
      await svc.execute(db, { signedTicket: made.ticket, userId: 7, auth: { type: 'jwt', userId: 7, roles: ['staff'] } });
      const answerCall = spy.mock.calls.find(([, opts]) => opts.promptKey === 'assistant_answer');
      expect(answerCall[1].systemAppend).toMatch(/INGEST RULE READING RULES/);
      const input = answerCall[1].userInput;
      expect(input).toContain('"email_ingest_execution_id":"28500"');
      expect(input).toMatch(/"row":"preview".*"email_ingest_execution_id":"28500","message_source":"email execution #28500".*"matched":"1"/);
      // The run read hit the execution projection, never the sources table.
      expect(seen.some((q) => /FROM email_ingest_executions e LEFT JOIN email_log/.test(q.sql) && q.params[0] === 28500)).toBe(true);
      expect(seen.filter((q) => /email_ingest_sources/.test(q.sql))).toEqual([]);
    } finally {
      process.env.JWT_SECRET = OLD_SECRET;
      spy.mockRestore();
    }
  });
});
