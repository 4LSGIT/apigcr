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
// SCOPE: workflows only (P12a). The sequence half (sequence_templates /
// sequence_enrollments / sequence_step_log) is P12b. The plan also names form
// definitions as a possible starter; verified 2026-10-22: nothing in the
// forms code references a workflow, so references() has no form source.

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

async function list(db, { query, limit } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || MAX_LIST, MAX_LIST));
  const where = [];
  const params = [];
  if (query != null && String(query).trim()) {
    where.push("name LIKE CONCAT('%', ?, '%')");
    params.push(escapeLike(String(query).trim()));
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

async function definition(db, { workflow_id, version } = {}) {
  const id = posInt(workflow_id, 'workflow_id');
  const [[wf]] = await db.query(
    'SELECT id, name, active, description, current_version, draft_version FROM workflows WHERE id = ?', [id]);
  if (!wf) throw err(404, `workflow ${id} does not exist`);
  const effective = version === undefined ? Number(wf.current_version) : posIntOrZero(version);
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

async function run(db, { execution_id } = {}) {
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

async function references(db, { workflow_id } = {}) {
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
