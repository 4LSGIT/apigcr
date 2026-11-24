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
// (Casey v1's assistantService — its read-step validator, fingerprints and prompts — was retired at Casey v2 S6, 2026-11-24; this file keeps the automationReadService and stepPreviewService halves.)

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
    [/FROM workflows WHERE id/, [{ id: 27, name: 'Intake', active: 1, description: 'd', current_version: 6, draft_version: 7,
      default_contact_id_from: ' contact_id ', test_input: JSON.stringify({ source: 'daily', contact_id: 1309, phone: '+15555550100' }) }]],
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

  test('A17.7c: every row carries the start card\'s input contract — test_input KEYS (sorted, never the values) and default_contact_id_from (trimmed)', async () => {
    // A17.7b's allowed init_data set is the unstored placeholders ∪ these keys;
    // before this the model met them only in the card's refusal message.
    const rows = await automation.definition(db(), { workflow_id: 27 });
    for (const r of rows) {
      expect(r.test_input_keys).toEqual(['contact_id', 'phone', 'source']);
      expect(r.default_contact_id_from).toBe('contact_id');
    }
    expect(JSON.stringify(rows)).not.toContain('+15555550100'); // the sample's values stay home
    // The JSON column arrives parsed from mysql2; a string shape is a mock or an older driver.
    expect(automation.testInputKeysOf({ b: 1, a: 2 })).toEqual(['a', 'b']);
    expect(automation.testInputKeysOf('{"z":1}')).toEqual(['z']);
    for (const bad of [null, undefined, '', 'not json', '[1,2]', [1], 7, 'null']) expect(automation.testInputKeysOf(bad)).toEqual([]);
  });

  test('A17.7c: a workflow with no sample and no default key reads null / [] — never undefined', async () => {
    const d = dbOf([
      [/FROM workflows WHERE id/, [{ id: 56, name: 'Chase', active: 1, description: 'd', current_version: 1, draft_version: null, default_contact_id_from: null, test_input: null }]],
      [/FROM credentials/, []],
      [/FROM workflow_steps WHERE workflow_id/, [{ step_number: 1, label: null, note: null, type: 'internal_function',
        config: JSON.stringify({ function_name: 'noop', params: {} }), error_policy: null }]],
    ]);
    const rows = await automation.definition(d, { workflow_id: 56 });
    expect(rows[0].default_contact_id_from).toBeNull();
    expect(rows[0].test_input_keys).toEqual([]);
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

});

describe('A20.0 — the ingest-rule projections (the read kinds went with Casey v1 at S6; the projections stay for the executions services)', () => {
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
});
