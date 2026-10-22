'use strict';
// Automation read surface for Ask Casey (plan P12, shape (b): typed read
// kinds, NOT a Reports-manifest widening). Casey could read NO automation
// definition or run before this: the report pool's grants exclude the
// automation tables, deliberately. These projections run on the app pool and
// are the ONLY way automation rows reach the model, so the redaction here is
// the whole control:
//
//   - webhook URLs are secret-bearing (CLAUDE.md): projected as method + host
//     + credential label only, never the full URL or literal header values
//     (header KEY names survive — they are shape, not secret).
//   - custom_code bodies are READABLE (Fred's ruling 9, 2026-10-22 — this is
//     what makes explaining the live code steps possible), capped per cell.
//   - workflow_execution_steps.resolved_config is NEVER selected (resolved
//     headers, client PII, third-party bodies), and output_data is projected
//     to its verdict keys only — which deliberately keeps the engine trap
//     visible where a non-throwing function returned {success:false} and the
//     row still says status='success' (A17.1 trap 1).
//
// Rows alias workflow_id / step_number / execution_id so the evidence rule
// (a citation carries the exact id) works for the later write kinds.
//
// SCOPE: workflows (P12a) and sequences (P12b) — the same four kinds take
// either a workflow_id or a sequence_template_id / enrollment_id, and the
// sequence projections carry the same redaction (webhook action_config → host
// + credential label; sequence_step_log.action_config_resolved is NEVER
// selected — it holds resolved recipients and message bodies; output_data is
// verdict-only). The plan also names form definitions as a possible starter;
// verified 2026-10-22: nothing in the forms code references a workflow, so
// references() has no form source.

const { escapeLike } = require('../lib/escapeLike');

const MAX_LIST = 50;
const CODE_CELL_CHARS = 2000;
const JSON_CELL_CHARS = 1500;

function err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function posInt(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw err(422, `${label} must be a positive integer`);
  return n;
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function capJson(value, max = JSON_CELL_CHARS) {
  if (value === undefined) return null;
  let s;
  try { s = JSON.stringify(value); } catch (_) { s = String(value); }
  if (s == null) return null;
  return s.length > max ? `${s.slice(0, max)}… [truncated ${s.length} chars total]` : s;
}

function hostOf(url) {
  try { return new URL(String(url)).host || null; } catch (_) { return null; }
}

// The one redaction choke point for a stored step/target config.
function projectStepConfig(type, rawConfig, credentialNames) {
  const config = parseJson(rawConfig, {});
  const out = {};
  if (type === 'webhook') {
    out.method = config.method || 'GET';
    out.url_host = hostOf(config.url);
    out.url_redacted = true;
    if (config.credential_id != null) {
      out.credential = credentialNames.get(Number(config.credential_id)) || `credential #${config.credential_id}`;
    }
    if (config.timeout_ms != null) out.timeout_ms = config.timeout_ms;
    if (config.headers && typeof config.headers === 'object') out.header_keys = Object.keys(config.headers);
    if (config.body !== undefined) out.body = capJson(config.body);
  } else if (type === 'custom_code') {
    out.code_mode = config.code_mode === 'safe' ? 'safe' : 'standard';
    const code = String(config.code || '');
    out.code = code.length > CODE_CELL_CHARS
      ? `${code.slice(0, CODE_CELL_CHARS)}… [truncated ${code.length} chars total]` : code;
    if (config.input !== undefined) out.input = capJson(config.input);
    if (config.timeout_ms != null) out.timeout_ms = config.timeout_ms;
  } else {
    out.function_name = config.function_name || null;
    if (config.params !== undefined) out.params = capJson(config.params);
  }
  if (config.set_vars !== undefined) out.set_vars = capJson(config.set_vars);
  if (config.next_step !== undefined) out.next_step = capJson(config.next_step, 200);
  return out;
}

async function credentialNameMap(db) {
  const [rows] = await db.query('SELECT id, name FROM credentials');
  return new Map(rows.map((r) => [Number(r.id), String(r.name)]));
}

async function list(db, { query, limit, type } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || MAX_LIST, MAX_LIST));
  const where = [];
  const params = [];
  if (query != null && String(query).trim()) {
    where.push("name LIKE CONCAT('%', ?, '%')");
    params.push(escapeLike(String(query).trim()));
  }
  if (type === 'sequences') {
    const [rows] = await db.query(
      `SELECT t.id AS sequence_template_id, t.name, t.type AS template_type, t.active,
              t.current_version, t.draft_version,
              LEFT(COALESCE(t.description, ''), 300) AS description,
              (SELECT COUNT(*) FROM sequence_steps s
                WHERE s.template_id = t.id AND s.version = t.current_version) AS step_count
         FROM sequence_templates t
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY t.id LIMIT ${cap}`, params);
    return rows.map((r) => ({ ...r, active: !!r.active }));
  }
  const [rows] = await db.query(
    `SELECT w.id AS workflow_id, w.name, w.active, w.current_version, w.draft_version,
            LEFT(COALESCE(w.description, ''), 300) AS description,
            (SELECT COUNT(*) FROM workflow_steps s
              WHERE s.workflow_id = w.id AND s.version = w.current_version) AS step_count
       FROM workflows w
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY w.id LIMIT ${cap}`, params);
  return rows.map((r) => ({ ...r, active: !!r.active }));
}

// Sequence action_config projection: webhook actions get the URL redaction;
// sms/email keep their templates (staff-authored definition text, capped);
// start_workflow / internal_function keep their target and params.
function projectSequenceActionConfig(actionType, rawConfig, credentialNames) {
  const config = parseJson(rawConfig, {});
  if (actionType === 'webhook') return projectStepConfig('webhook', config, credentialNames);
  const out = {};
  for (const [k, v] of Object.entries(config)) out[k] = typeof v === 'string' && v.length > JSON_CELL_CHARS
    ? `${v.slice(0, JSON_CELL_CHARS)}… [truncated ${v.length} chars total]` : v;
  return out;
}

async function sequenceDefinition(db, { sequence_template_id, version }) {
  const id = posInt(sequence_template_id, 'sequence_template_id');
  const [[tpl]] = await db.query(
    'SELECT id, name, type, active, description, current_version, draft_version FROM sequence_templates WHERE id = ?', [id]);
  if (!tpl) throw err(404, `sequence template ${id} does not exist`);
  let effective = version === undefined ? Number(tpl.current_version) : posIntOrZero(version);
  if (version === undefined && effective === 0 && tpl.draft_version != null) {
    effective = Number(tpl.draft_version);
  }
  const credentialNames = await credentialNameMap(db);
  const [steps] = await db.query(
    `SELECT step_number, action_type, action_config, timing, \`condition\`, fire_guard, error_policy
       FROM sequence_steps WHERE template_id = ? AND version = ? ORDER BY step_number`, [id, effective]);
  if (!steps.length) {
    throw err(404, `sequence template ${id} has no steps at version ${effective}` +
      (effective !== Number(tpl.current_version) ? ` (current is ${tpl.current_version})` : ''));
  }
  return steps.map((s) => ({
    sequence_template_id: id,
    template_name: tpl.name,
    template_type: tpl.type,
    template_active: !!tpl.active,
    version: effective,
    is_draft: tpl.draft_version != null && effective === Number(tpl.draft_version) ? 1 : 0,
    step_number: s.step_number,
    action_type: s.action_type,
    action_config: capJson(projectSequenceActionConfig(s.action_type, s.action_config, credentialNames), 4000),
    timing: capJson(parseJson(s.timing)),
    condition: capJson(parseJson(s.condition)),
    fire_guard: capJson(parseJson(s.fire_guard)),
    error_policy: capJson(parseJson(s.error_policy)),
  }));
}

async function definition(db, { workflow_id, sequence_template_id, version } = {}) {
  if (sequence_template_id !== undefined) return sequenceDefinition(db, { sequence_template_id, version });
  const id = posInt(workflow_id, 'workflow_id');
  const [[wf]] = await db.query(
    'SELECT id, name, active, description, current_version, draft_version FROM workflows WHERE id = ?', [id]);
  if (!wf) throw err(404, `workflow ${id} does not exist`);
  // An UNPUBLISHED workflow has current_version 0 and its steps live at
  // draft_version — reading "version 0" returns nothing and misled a live
  // explanation (chat 41, 2026-10-22: "it has 3 steps! look again"). With no
  // explicit version, fall back to the draft so the definition always shows
  // what exists.
  let effective = version === undefined ? Number(wf.current_version) : posIntOrZero(version);
  if (version === undefined && effective === 0 && wf.draft_version != null) {
    effective = Number(wf.draft_version);
  }
  const credentialNames = await credentialNameMap(db);
  const [steps] = await db.query(
    `SELECT step_number, label, note, type, config, error_policy
       FROM workflow_steps WHERE workflow_id = ? AND version = ? ORDER BY step_number`, [id, effective]);
  if (!steps.length) {
    throw err(404, `workflow ${id} has no steps at version ${effective}` +
      (effective !== Number(wf.current_version) ? ` (current is ${wf.current_version})` : ''));
  }
  return steps.map((s) => ({
    workflow_id: id,
    workflow_name: wf.name,
    workflow_active: !!wf.active,
    version: effective,
    is_draft: wf.draft_version != null && effective === Number(wf.draft_version) ? 1 : 0,
    step_number: s.step_number,
    label: s.label,
    note: s.note,
    type: s.type,
    config: capJson(projectStepConfig(s.type, s.config, credentialNames), 4000),
    error_policy: capJson(parseJson(s.error_policy)),
  }));
}

// version 0 is a real value here (an unpublished workflow's draft steps).
function posIntOrZero(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw err(422, 'version must be a non-negative integer');
  return n;
}

const OUTPUT_VERDICT_KEYS = ['success', 'error', 'message'];

async function enrollmentRun(db, { enrollment_id }) {
  const id = posInt(enrollment_id, 'enrollment_id');
  const [[enr]] = await db.query(
    `SELECT e.id AS enrollment_id, e.template_id AS sequence_template_id, t.name AS template_name,
            e.template_version, e.status, e.contact_id, e.appt_id, e.current_step, e.total_steps,
            e.cancel_reason, e.enrolled_at, e.completed_at, e.trigger_data
       FROM sequence_enrollments e LEFT JOIN sequence_templates t ON t.id = e.template_id
      WHERE e.id = ?`, [id]);
  if (!enr) throw err(404, `enrollment ${id} does not exist`);
  // action_config_resolved deliberately not selected — resolved recipients and
  // message bodies; same rule as workflow resolved_config.
  const [history] = await db.query(
    `SELECT step_number, step_id, status, skip_reason, error_message, duration_ms, scheduled_at, executed_at, output_data
       FROM sequence_step_log WHERE enrollment_id = ? ORDER BY id`, [id]);
  const [pending] = await db.query(
    `SELECT id AS job_id, status AS job_status, scheduled_time
       FROM scheduled_jobs WHERE sequence_enrollment_id = ? AND type = 'sequence_step'
        AND status IN ('pending', 'running')`, [id]);
  const rows = [{
    row: 'enrollment',
    enrollment_id: id,
    sequence_template_id: enr.sequence_template_id,
    template_name: enr.template_name,
    template_version: enr.template_version,
    status: enr.status,
    contact_id: enr.contact_id,
    appt_id: enr.appt_id,
    current_step: enr.current_step,
    total_steps: enr.total_steps,
    cancel_reason: enr.cancel_reason,
    enrolled_at: enr.enrolled_at,
    completed_at: enr.completed_at,
    trigger_data: capJson(parseJson(enr.trigger_data), 2000),
  }];
  for (const h of history) {
    const output = parseJson(h.output_data, null);
    const verdict = {};
    if (output && typeof output === 'object' && !Array.isArray(output)) {
      for (const k of OUTPUT_VERDICT_KEYS) if (output[k] !== undefined) verdict[k] = output[k];
    }
    rows.push({
      row: 'step', enrollment_id: id, step_number: h.step_number, step_id: h.step_id,
      status: h.status, skip_reason: h.skip_reason, error_message: h.error_message,
      duration_ms: h.duration_ms, scheduled_at: h.scheduled_at, executed_at: h.executed_at,
      output_verdict: Object.keys(verdict).length ? capJson(verdict, 600) : null,
      output_redacted: output != null && typeof output === 'object' ? 1 : 0,
    });
  }
  for (const r of pending) {
    rows.push({ row: 'pending_step', enrollment_id: id, job_id: r.job_id, job_status: r.job_status,
      scheduled_time: r.scheduled_time });
  }
  return rows;
}

async function run(db, { execution_id, enrollment_id, workflow_id, sequence_template_id } = {}) {
  // "The latest run of workflow X" is the question a run explanation starts
  // from, and the model has no other way to learn an execution id — the
  // automation tables are outside the curated SQL on purpose. Found live
  // (chat 44, 2026-10-22): asked why the last execution did nothing, the
  // model could not fetch any history and inferred the cause from a task row.
  if (workflow_id !== undefined) {
    const wfId = posInt(workflow_id, 'workflow_id');
    const [[latest]] = await db.query(
      'SELECT id FROM workflow_executions WHERE workflow_id = ? ORDER BY id DESC LIMIT 1', [wfId]);
    if (!latest) throw err(404, `workflow ${wfId} has no executions yet`);
    return run(db, { execution_id: Number(latest.id) });
  }
  if (sequence_template_id !== undefined) {
    const tplId = posInt(sequence_template_id, 'sequence_template_id');
    const [[latest]] = await db.query(
      'SELECT id FROM sequence_enrollments WHERE template_id = ? ORDER BY id DESC LIMIT 1', [tplId]);
    if (!latest) throw err(404, `sequence template ${tplId} has no enrollments yet`);
    return run(db, { enrollment_id: Number(latest.id) });
  }
  if (enrollment_id !== undefined) return enrollmentRun(db, { enrollment_id });
  const id = posInt(execution_id, 'execution_id');
  const [[exec]] = await db.query(
    `SELECT e.id AS execution_id, e.workflow_id, w.name AS workflow_name, e.workflow_version,
            e.status, e.contact_id, e.current_step_number, e.steps_executed_count,
            e.created_at, e.completed_at, e.cancel_reason, e.init_data, e.variables
       FROM workflow_executions e LEFT JOIN workflows w ON w.id = e.workflow_id
      WHERE e.id = ?`, [id]);
  if (!exec) throw err(404, `execution ${id} does not exist`);
  // resolved_config deliberately not selected — see the header.
  const [history] = await db.query(
    `SELECT step_number, step_id, status, error_message, duration_ms, executed_at, output_data
       FROM workflow_execution_steps WHERE workflow_execution_id = ? ORDER BY id`, [id]);
  const [resumes] = await db.query(
    `SELECT id AS job_id, status AS job_status, scheduled_time, data
       FROM scheduled_jobs WHERE workflow_execution_id = ? AND type = 'workflow_resume'
        AND status IN ('pending', 'running')`, [id]);
  const rows = [{
    row: 'execution',
    execution_id: id,
    workflow_id: exec.workflow_id,
    workflow_name: exec.workflow_name,
    workflow_version: exec.workflow_version,
    status: exec.status,
    contact_id: exec.contact_id,
    current_step_number: exec.current_step_number,
    steps_executed_count: exec.steps_executed_count,
    created_at: exec.created_at,
    completed_at: exec.completed_at,
    cancel_reason: exec.cancel_reason,
    init_data: capJson(parseJson(exec.init_data), 2000),
    variables: capJson(parseJson(exec.variables), 2000),
  }];
  for (const h of history) {
    const output = parseJson(h.output_data, null);
    const verdict = {};
    if (output && typeof output === 'object' && !Array.isArray(output)) {
      for (const k of OUTPUT_VERDICT_KEYS) if (output[k] !== undefined) verdict[k] = output[k];
    }
    rows.push({
      row: 'step',
      execution_id: id,
      step_number: h.step_number,
      step_id: h.step_id,
      status: h.status,
      error_message: h.error_message,
      duration_ms: h.duration_ms,
      executed_at: h.executed_at,
      // The verdict keys the engine trap hides inside a 'success' row; the
      // payload itself (resolved emails, third-party bodies) stays out.
      output_verdict: Object.keys(verdict).length ? capJson(verdict, 600) : null,
      output_redacted: output != null && typeof output === 'object' ? 1 : 0,
    });
  }
  for (const r of resumes) {
    const data = parseJson(r.data, {});
    rows.push({
      row: 'pending_resume', execution_id: id, job_id: r.job_id, job_status: r.job_status,
      scheduled_time: r.scheduled_time, next_step: data.nextStep != null ? Number(data.nextStep) : null,
    });
  }
  return rows;
}

// What can ENROLL a sequence template: hook targets and trigger-rule actions
// (config.template_id exact, or config.template_type matching the template's
// type — a type-based starter enrolls whichever template of that type is
// active), workflow enroll_sequence steps, and CTA link plans.
async function sequenceReferences(db, { sequence_template_id }) {
  const id = posInt(sequence_template_id, 'sequence_template_id');
  const [[tpl]] = await db.query('SELECT id, type FROM sequence_templates WHERE id = ?', [id]);
  if (!tpl) throw err(404, `sequence template ${id} does not exist`);
  const idText = String(id);
  const typeText = tpl.type == null ? null : String(tpl.type);
  const rows = [];
  const matches = (config) => {
    const c = parseJson(config, {}) || {};
    if (String(c.template_id) === idText) return 'by id';
    if (typeText != null && c.template_type != null && String(c.template_type) === typeText) return `by type "${typeText}"`;
    return null;
  };

  const [hooks] = await db.query(
    `SELECT ht.id AS target_id, ht.name AS target_name, ht.active AS target_active, ht.config,
            h.id AS hook_id, h.name AS hook_name
       FROM hook_targets ht JOIN hooks h ON h.id = ht.hook_id
      WHERE ht.target_type = 'sequence'`);
  for (const r of hooks) {
    const how = matches(r.config);
    if (!how) continue;
    rows.push({ source: 'hook', sequence_template_id: id, source_id: r.hook_id, source_name: r.hook_name,
      detail: `target #${r.target_id} "${r.target_name}" (${how})`, active: !!r.target_active });
  }

  const [triggers] = await db.query(
    `SELECT a.id AS action_id, a.name AS action_name, a.active AS action_active, a.config,
            tr.id AS rule_id, tr.name AS rule_name, tr.event_type, tr.active AS rule_active
       FROM trigger_rule_actions a JOIN trigger_rules tr ON tr.id = a.rule_id
      WHERE a.action_type = 'sequence'`);
  for (const r of triggers) {
    const how = matches(r.config);
    if (!how) continue;
    rows.push({ source: 'trigger_rule', sequence_template_id: id, source_id: r.rule_id, source_name: r.rule_name,
      detail: `on ${r.event_type}, action "${r.action_name || r.action_id}" (${how})`,
      active: !!(r.rule_active && r.action_active) });
  }

  const [wfSteps] = await db.query(
    `SELECT s.workflow_id AS parent_id, s.step_number, s.version, s.config,
            w.name AS parent_name, w.current_version
       FROM workflow_steps s JOIN workflows w ON w.id = s.workflow_id
      WHERE s.type = 'internal_function'
        AND JSON_UNQUOTE(JSON_EXTRACT(s.config, '$.function_name')) = 'enroll_sequence'`);
  for (const r of wfSteps) {
    const how = matches(JSON.stringify((parseJson(r.config, {}) || {}).params || {}));
    if (!how) continue;
    rows.push({ source: 'workflow_step', sequence_template_id: id, source_id: r.parent_id, source_name: r.parent_name,
      detail: `step ${r.step_number} (version ${r.version}, ${how})`,
      active: Number(r.version) === Number(r.current_version) });
  }

  const [ctas] = await db.query(
    `SELECT id, name, options, expires_at FROM cta_links
      WHERE options LIKE '%enroll_sequence%'`);
  for (const r of ctas) {
    const options = parseJson(r.options, []);
    let how = null;
    for (const o of (Array.isArray(options) ? options : [])) {
      for (const p of (Array.isArray(o && o.plan) ? o.plan : [])) {
        if (p && p.fn === 'enroll_sequence') how = how || matches(JSON.stringify(p.params || {}));
      }
    }
    if (!how) continue;
    rows.push({ source: 'cta_link', sequence_template_id: id, source_id: r.id, source_name: r.name,
      detail: `(${how}) expires ${r.expires_at instanceof Date ? r.expires_at.toISOString() : r.expires_at}`,
      active: !(r.expires_at instanceof Date) || r.expires_at.getTime() > Date.now() });
  }

  if (!rows.length) {
    rows.push({ source: 'none', sequence_template_id: id, source_id: null, source_name: null,
      detail: 'no hook, trigger rule, workflow step or CTA link enrolls this template; enrollments happen only by hand, API, or app-internal callers (e.g. appointment no-show handling)', active: null });
  }
  return rows;
}

async function references(db, { workflow_id, sequence_template_id } = {}) {
  if (sequence_template_id !== undefined) return sequenceReferences(db, { sequence_template_id });
  const id = posInt(workflow_id, 'workflow_id');
  const rows = [];
  // config.workflow_id may be stored as a number or a numeric string; compare
  // both as text. A placeholder target ('{{x}}') can never equal the id, and
  // dynamic targets are deliberately not enumerated — a run-time id matches
  // every workflow, so listing it everywhere would be noise, not evidence.
  const idText = String(id);

  const [hooks] = await db.query(
    `SELECT ht.id AS target_id, ht.name AS target_name, ht.active AS target_active,
            h.id AS hook_id, h.name AS hook_name
       FROM hook_targets ht JOIN hooks h ON h.id = ht.hook_id
      WHERE ht.target_type = 'workflow'
        AND JSON_UNQUOTE(JSON_EXTRACT(ht.config, '$.workflow_id')) = ?`, [idText]);
  for (const r of hooks) {
    rows.push({ source: 'hook', workflow_id: id, source_id: r.hook_id, source_name: r.hook_name,
      detail: `target #${r.target_id} "${r.target_name}"`, active: !!r.target_active });
  }

  const [triggers] = await db.query(
    `SELECT a.id AS action_id, a.name AS action_name, a.active AS action_active,
            tr.id AS rule_id, tr.name AS rule_name, tr.event_type, tr.active AS rule_active
       FROM trigger_rule_actions a JOIN trigger_rules tr ON tr.id = a.rule_id
      WHERE a.action_type = 'workflow'
        AND JSON_UNQUOTE(JSON_EXTRACT(a.config, '$.workflow_id')) = ?`, [idText]);
  for (const r of triggers) {
    rows.push({ source: 'trigger_rule', workflow_id: id, source_id: r.rule_id, source_name: r.rule_name,
      detail: `on ${r.event_type}, action "${r.action_name || r.action_id}"`,
      active: !!(r.rule_active && r.action_active) });
  }

  const [seqSteps] = await db.query(
    `SELECT s.id AS step_id, s.template_id, s.step_number, s.version,
            t.name AS template_name, t.current_version
       FROM sequence_steps s JOIN sequence_templates t ON t.id = s.template_id
      WHERE s.action_type = 'start_workflow'
        AND JSON_UNQUOTE(JSON_EXTRACT(s.action_config, '$.workflow_id')) = ?`, [idText]);
  for (const r of seqSteps) {
    rows.push({ source: 'sequence_step', workflow_id: id, source_id: r.template_id, source_name: r.template_name,
      detail: `step ${r.step_number} (template version ${r.version})`,
      active: Number(r.version) === Number(r.current_version) });
  }

  // Parent workflows: an internal_function step calling start_workflow with
  // this exact id. Matched in JS because params.workflow_id is free-shaped.
  const [parents] = await db.query(
    `SELECT s.workflow_id AS parent_id, s.step_number, s.version, s.config,
            w.name AS parent_name, w.current_version
       FROM workflow_steps s JOIN workflows w ON w.id = s.workflow_id
      WHERE s.type = 'internal_function'
        AND JSON_UNQUOTE(JSON_EXTRACT(s.config, '$.function_name')) = 'start_workflow'`);
  for (const r of parents) {
    const params = (parseJson(r.config, {}) || {}).params || {};
    if (String(params.workflow_id) !== idText) continue;
    rows.push({ source: 'workflow_step', workflow_id: id, source_id: r.parent_id, source_name: r.parent_name,
      detail: `step ${r.step_number} (version ${r.version})`,
      active: Number(r.version) === Number(r.current_version) });
  }

  // CTA links: frozen option plans may hold start_workflow. LIKE narrows,
  // JSON parsing decides.
  const [ctas] = await db.query(
    `SELECT id, name, options, expires_at FROM cta_links
      WHERE options LIKE '%start_workflow%'`);
  for (const r of ctas) {
    const options = parseJson(r.options, []);
    const hit = (Array.isArray(options) ? options : []).some((o) =>
      Array.isArray(o && o.plan) && o.plan.some((p) =>
        p && p.fn === 'start_workflow' && String((p.params || {}).workflow_id) === idText));
    if (!hit) continue;
    rows.push({ source: 'cta_link', workflow_id: id, source_id: r.id, source_name: r.name,
      detail: `expires ${r.expires_at instanceof Date ? r.expires_at.toISOString() : r.expires_at}`,
      active: !(r.expires_at instanceof Date) || r.expires_at.getTime() > Date.now() });
  }

  if (!rows.length) {
    rows.push({ source: 'none', workflow_id: id, source_id: null, source_name: null,
      detail: 'no hook, trigger rule, sequence step, parent workflow or CTA link names this workflow; it starts only by hand or API', active: null });
  }
  return rows;
}

module.exports = { list, definition, run, references, projectStepConfig };
