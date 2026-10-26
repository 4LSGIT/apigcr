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
//
// A20.0 — email and phone INGEST RULES ride the same four kinds with their own
// id keys (email_ingest_rule_id / phone_ingest_rule_id, email_ingest_execution_id
// / phone_ingest_execution_id): definition = the rule + its action rows; run =
// one execution's layer-by-layer outcome; list = rules, suppressions, or an
// execution finder; references = what the rule's actions START (and the
// workflow / sequence references gained ingest-rule actions as starters).
// Same redaction: an `http` action is method + host + credential label (never
// the URL or a header value); `code` match/transform bodies are readable
// (ruling 9), split into ≤ CODE_PART_CHARS parts so a long one is not lost to
// the per-cell cap. email_ingest_sources (live keys) is never touched — no
// join, no column: the source NAME comes from email_log.source. raw_input is
// never selected here (the preview kind reads envelopes through the sample
// fetchers, services/ingestRulePreviewService.js).

const { DateTime } = require('luxon');
const { escapeLike } = require('../lib/escapeLike');
const { FIRM_TZ } = require('./timezoneService');

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

async function list(db, { query, limit, type, since, until } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || MAX_LIST, MAX_LIST));
  const where = [];
  const params = [];
  if (query != null && String(query).trim()) {
    where.push("name LIKE CONCAT('%', ?, '%')");
    params.push(escapeLike(String(query).trim()));
  }
  const ingest = INGEST_LIST_TYPES[type];
  if (ingest) return ingestList(db, ingest, { query, cap, since, until });
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

async function definition(db, { workflow_id, sequence_template_id, email_ingest_rule_id, phone_ingest_rule_id, version } = {}) {
  if (email_ingest_rule_id !== undefined) return ingestDefinition(db, INGEST.email, email_ingest_rule_id);
  if (phone_ingest_rule_id !== undefined) return ingestDefinition(db, INGEST.phone, phone_ingest_rule_id);
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

async function run(db, {
  execution_id, enrollment_id, workflow_id, sequence_template_id,
  email_ingest_execution_id, phone_ingest_execution_id, email_ingest_rule_id, phone_ingest_rule_id,
} = {}) {
  // A20.0: an ingest execution by id, or a rule's LATEST matching execution.
  if (email_ingest_execution_id !== undefined) return ingestRun(db, INGEST.email, email_ingest_execution_id);
  if (phone_ingest_execution_id !== undefined) return ingestRun(db, INGEST.phone, phone_ingest_execution_id);
  if (email_ingest_rule_id !== undefined) return ingestLatestMatch(db, INGEST.email, email_ingest_rule_id);
  if (phone_ingest_rule_id !== undefined) return ingestLatestMatch(db, INGEST.phone, phone_ingest_rule_id);
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

  // A20.0: email / phone ingest-rule sequence actions enroll by the same
  // template_id / template_type keys.
  for (const r of await ingestStarters(db, 'sequence', matches)) rows.push({ ...r, sequence_template_id: id });

  if (!rows.length) {
    rows.push({ source: 'none', sequence_template_id: id, source_id: null, source_name: null,
      detail: 'no hook, trigger rule, ingest rule, workflow step or CTA link enrolls this template; enrollments happen only by hand, API, or app-internal callers (e.g. appointment no-show handling)', active: null });
  }
  return rows;
}

async function references(db, { workflow_id, sequence_template_id, email_ingest_rule_id, phone_ingest_rule_id } = {}) {
  if (email_ingest_rule_id !== undefined) return ingestReferences(db, INGEST.email, email_ingest_rule_id);
  if (phone_ingest_rule_id !== undefined) return ingestReferences(db, INGEST.phone, phone_ingest_rule_id);
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

  // A20.0: email / phone ingest-rule workflow actions (config.workflow_id,
  // number or numeric string — compared as text like the sources above).
  const byWorkflowId = (config) => String((parseJson(config, {}) || {}).workflow_id) === idText;
  for (const r of await ingestStarters(db, 'workflow', byWorkflowId)) rows.push({ ...r, workflow_id: id });

  if (!rows.length) {
    rows.push({ source: 'none', workflow_id: id, source_id: null, source_name: null,
      detail: 'no hook, trigger rule, ingest rule, sequence step, parent workflow or CTA link names this workflow; it starts only by hand or API', active: null });
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────
// A20.0 — email and phone ingest rules (see the header)
// ─────────────────────────────────────────────────────────────

const INGEST = {
  email: {
    channel: 'email', rules: 'email_ingest_rules', actions: 'email_ingest_rule_actions',
    executions: 'email_ingest_executions', suppressions: 'email_ingest_log_suppressions',
    ruleKey: 'email_ingest_rule_id', execKey: 'email_ingest_execution_id', suppKey: 'email_ingest_suppression_id',
    execService: () => require('./emailIngestExecutionsService'),
  },
  phone: {
    channel: 'phone', rules: 'phone_ingest_rules', actions: 'phone_ingest_rule_actions',
    executions: 'phone_ingest_executions', suppressions: 'phone_log_suppressions',
    ruleKey: 'phone_ingest_rule_id', execKey: 'phone_ingest_execution_id', suppKey: 'phone_ingest_suppression_id',
    execService: () => require('./phoneIngestExecutionsService'),
  },
};

const INGEST_LIST_TYPES = {
  email_ingest_rules: { ch: INGEST.email, what: 'rules' },
  phone_ingest_rules: { ch: INGEST.phone, what: 'rules' },
  email_ingest_suppressions: { ch: INGEST.email, what: 'suppressions' },
  phone_ingest_suppressions: { ch: INGEST.phone, what: 'suppressions' },
  email_ingest_executions: { ch: INGEST.email, what: 'executions' },
  phone_ingest_executions: { ch: INGEST.phone, what: 'executions' },
};

// Live 2026-10-26: the largest stored code transform is 10,775 chars (rule 24);
// 4 of the 8 code transforms exceed P12's 2,000-char cell. Parts keep each
// cell under the 3,000-char evidence cap and the whole body readable.
const CODE_PART_CHARS = 2500;
const CODE_PARTS_MAX = 6;
const INGEST_CONFIG_CHARS = 2500;

function utcLiteral(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function firmLocal(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return `${DateTime.fromJSDate(value, { zone: 'utc' }).setZone(FIRM_TZ).toFormat('yyyy-LL-dd HH:mm:ss')} (${FIRM_TZ})`;
}

// since/until from the validated step: firm-local unless an offset is given;
// a date-only `until` means the END of that firm-local day.
function windowBound(value, end) {
  if (value == null || value === '') return undefined;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const day = DateTime.fromISO(text, { zone: FIRM_TZ });
    if (!day.isValid) throw err(422, `invalid date ${text}`);
    return (end ? day.endOf('day') : day.startOf('day')).toUTC().toJSDate();
  }
  return require('./timezoneService').parseUserDateTime(text);
}

// A stored match/transform config → one readable cell, plus code parts.
function ingestConfigCell(mode, raw) {
  const config = parseJson(raw, typeof raw === 'string' ? raw : null);
  if (mode === 'code') {
    const code = typeof config === 'string' ? config : (config && typeof config.code === 'string' ? config.code : null);
    if (code != null) {
      if (code.length <= CODE_PART_CHARS) return { cell: code, parts: [] };
      const parts = [];
      for (let i = 0; i < code.length && parts.length < CODE_PARTS_MAX; i += CODE_PART_CHARS) parts.push(code.slice(i, i + CODE_PART_CHARS));
      const shown = parts.join('').length;
      return {
        cell: `[code body: ${code.length} chars in ${parts.length} code_part rows${shown < code.length ? `; the last ${code.length - shown} chars are not shown` : ''}]`,
        parts,
      };
    }
  }
  return { cell: config == null ? null : capJson(config, INGEST_CONFIG_CHARS), parts: [] };
}

// An ingest action's stored config with the P12 redaction: `http` is a
// WHITELIST (method, host, credential label, header KEY names, body mode and
// template — never the URL or a header value); every other type keeps its keys
// minus any url/headers (never read by those dispatchers, and possibly secret).
function projectIngestActionConfig(actionType, rawConfig, credentialNames) {
  const config = parseJson(rawConfig, {}) || {};
  if (actionType === 'http') {
    const out = projectStepConfig('webhook', {
      url: config.url, method: config.method || 'POST', credential_id: config.credential_id,
      headers: config.headers, timeout_ms: config.timeout_ms, body: config.body_template,
    }, credentialNames);
    if (config.body_mode !== undefined) out.body_mode = config.body_mode;
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(config)) {
    if (k === 'url' || k === 'headers') continue;
    out[k] = v;
  }
  return out;
}

// What each action starts — names and live state of its target, batch-loaded.
async function ingestTargets(db, actions, credentialNames) {
  const cfg = new Map(actions.map((a) => [Number(a.id), parseJson(a.config, {}) || {}]));
  const pick = (type, key) => [...new Set(actions.filter((a) => a.action_type === type)
    .map((a) => cfg.get(Number(a.id))[key]).filter((v) => v != null && v !== ''))];
  const inList = async (sql, list) => (list.length
    ? (await db.query(sql.replace('(?)', `(${list.map(() => '?').join(',')})`), list))[0] : []);
  const wfIds = pick('workflow', 'workflow_id').map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  const tplIds = pick('sequence', 'template_id').map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  const tplTypes = pick('sequence', 'template_type').map(String);
  const slugs = pick('hook', 'slug').map(String);
  const workflows = new Map((await inList('SELECT id, name, active, current_version FROM workflows WHERE id IN (?)', wfIds)).map((r) => [Number(r.id), r]));
  const templates = new Map((await inList('SELECT id, name, active FROM sequence_templates WHERE id IN (?)', tplIds)).map((r) => [Number(r.id), r]));
  const byType = new Map();
  for (const r of await inList('SELECT id, name, type, active FROM sequence_templates WHERE type IN (?)', tplTypes)) {
    if (!byType.has(String(r.type))) byType.set(String(r.type), []);
    byType.get(String(r.type)).push(r);
  }
  const hooks = new Map((await inList('SELECT id, slug, name, active FROM hooks WHERE slug IN (?)', slugs)).map((r) => [String(r.slug), r]));

  const out = new Map();
  for (const a of actions) {
    const c = cfg.get(Number(a.id));
    let t;
    if (a.action_type === 'workflow') {
      const wf = workflows.get(Number(c.workflow_id));
      t = wf
        ? { target_kind: 'workflow', target_id: Number(wf.id), target_name: wf.name, target_active: !!wf.active,
          detail: `starts workflow ${wf.id} "${wf.name}" (${wf.active ? 'active' : 'INACTIVE — dispatch is refused'}${Number(wf.current_version) ? `, published v${wf.current_version}` : ', never published — dispatch is refused'})` }
        : { target_kind: 'workflow', target_id: c.workflow_id ?? null, target_name: null, target_active: false,
          detail: `names workflow ${c.workflow_id}, which does not exist` };
    } else if (a.action_type === 'sequence') {
      if (c.template_id != null && c.template_id !== '') {
        const tpl = templates.get(Number(c.template_id));
        t = { target_kind: 'sequence_template', target_id: tpl ? Number(tpl.id) : c.template_id, target_name: tpl ? tpl.name : null,
          target_active: !!(tpl && tpl.active),
          detail: tpl ? `enrolls in sequence template ${tpl.id} "${tpl.name}" by id${tpl.active ? '' : ' (INACTIVE)'}` : `names sequence template ${c.template_id}, which does not exist` };
      } else {
        const list = byType.get(String(c.template_type)) || [];
        const active = list.filter((r) => r.active);
        t = { target_kind: 'sequence_type', target_id: null, target_name: String(c.template_type || ''), target_active: active.length > 0,
          detail: `enrolls in the active template of type "${c.template_type}" (${active.length ? active.map((r) => `${r.id} "${r.name}"`).join(', ') : 'none active'})` };
      }
      t.detail += `; contact id read from the transform output at "${c.contact_id_field || 'contact_id'}"`;
    } else if (a.action_type === 'hook') {
      const h = hooks.get(String(c.slug || ''));
      t = { target_kind: 'hook', target_id: h ? Number(h.id) : null, target_name: h ? h.name : String(c.slug || ''),
        target_active: !!(h && h.active),
        detail: h ? `re-enters hook ${h.id} "${h.name}" (slug ${h.slug}${h.active ? '' : ', INACTIVE'}) with the transform output as body` : `names hook slug "${c.slug}", which does not exist` };
    } else if (a.action_type === 'internal_function') {
      t = { target_kind: 'internal_function', target_id: null, target_name: c.function_name || null, target_active: null,
        detail: `calls internal function ${c.function_name || '(none)'} with params mapped from the transform output` };
    } else if (a.action_type === 'http') {
      const cred = c.credential_id != null ? (credentialNames.get(Number(c.credential_id)) || `credential #${c.credential_id}`) : 'no credential';
      t = { target_kind: 'http', target_id: null, target_name: hostOf(c.url), target_active: null,
        detail: `sends ${String(c.method || 'POST').toUpperCase()} to host ${hostOf(c.url) || '(unparseable)'} [URL redacted] using ${cred}` };
    } else {
      t = { target_kind: String(a.action_type), target_id: null, target_name: null, target_active: null, detail: 'unknown action type' };
    }
    out.set(Number(a.id), t);
  }
  return out;
}

async function loadIngestRule(db, ch, id) {
  const [[rule]] = await db.query(
    `SELECT id, name, description, active, position, match_mode, match_config, transform_mode, transform_config,
            match_count, last_matched_at, last_modified_by, created_at, updated_at
       FROM ${ch.rules} WHERE id = ?`, [id]);
  if (!rule) throw err(404, `${ch.channel} ingest rule ${id} does not exist`);
  const [actions] = await db.query(
    `SELECT id, name, position, active, action_type, config
       FROM ${ch.actions} WHERE rule_id = ? ORDER BY position ASC, id ASC`, [id]);
  return { rule, actions };
}

async function ingestDefinition(db, ch, ruleId) {
  const id = posInt(ruleId, ch.ruleKey);
  const { rule, actions } = await loadIngestRule(db, ch, id);
  const [[order]] = await db.query(
    `SELECT COUNT(*) AS n FROM ${ch.rules}
      WHERE active = 1 AND (position < ? OR (position = ? AND id < ?))`, [rule.position, rule.position, id]);
  const credentialNames = await credentialNameMap(db);
  const targets = await ingestTargets(db, actions, credentialNames);
  const match = ingestConfigCell(rule.match_mode, rule.match_config);
  const transform = rule.transform_mode === 'passthrough' ? { cell: null, parts: [] } : ingestConfigCell(rule.transform_mode, rule.transform_config);
  const notes = [];
  if (!rule.active) notes.push('INACTIVE: live ingest never evaluates this rule');
  if (rule.match_mode === 'conditions' && rule.match_config == null) notes.push('NULL match_config in conditions mode never matches (it is NOT match-all)');
  if (!actions.some((a) => a.active)) notes.push('no active actions: a match is recorded but nothing fires');
  const rows = [{
    row: 'rule', channel: ch.channel, [ch.ruleKey]: id, name: rule.name,
    description: rule.description == null ? null : String(rule.description).slice(0, 500),
    active: !!rule.active, position: rule.position,
    evaluation_order: rule.active ? Number(order.n) + 1 : null,
    match_mode: rule.match_mode, match_config: match.cell,
    transform_mode: rule.transform_mode, transform_config: transform.cell,
    match_count: rule.match_count, last_matched_at: rule.last_matched_at,
    updated_at: rule.updated_at, last_modified_by: rule.last_modified_by,
    action_count: actions.length, active_action_count: actions.filter((a) => a.active).length,
    notes: notes.length ? notes.join('; ') : null,
  }];
  for (const [field, cell] of [['match_config', match], ['transform_config', transform]]) {
    cell.parts.forEach((part, i) => rows.push({
      row: 'code_part', [ch.ruleKey]: id, field, part: i + 1, of: cell.parts.length, code: part,
    }));
  }
  for (const a of actions) {
    const t = targets.get(Number(a.id));
    rows.push({
      row: 'action', [ch.ruleKey]: id, rule_action_id: Number(a.id), name: a.name, position: a.position,
      active: !!a.active, action_type: a.action_type,
      config: capJson(projectIngestActionConfig(a.action_type, a.config, credentialNames), 2000),
      target: t.detail,
    });
  }
  return rows;
}

async function ingestReferences(db, ch, ruleId) {
  const id = posInt(ruleId, ch.ruleKey);
  const { rule, actions } = await loadIngestRule(db, ch, id);
  const targets = await ingestTargets(db, actions, await credentialNameMap(db));
  if (!actions.length) {
    return [{ source: 'none', [ch.ruleKey]: id, rule_action_id: null, action_type: null, target_kind: null,
      target_id: null, target_name: null, active: null,
      detail: 'this rule has no actions — a match is recorded on the execution row and nothing starts' }];
  }
  return actions.map((a) => {
    const t = targets.get(Number(a.id));
    return {
      source: 'ingest_rule_action', [ch.ruleKey]: id, rule_action_id: Number(a.id), action_type: a.action_type,
      target_kind: t.target_kind, target_id: t.target_id, target_name: t.target_name,
      target_active: t.target_active, active: !!(rule.active && a.active), detail: t.detail,
    };
  });
}

// Ingest-rule actions as STARTERS of a workflow / sequence template.
async function ingestStarters(db, actionType, matches) {
  const rows = [];
  for (const ch of [INGEST.email, INGEST.phone]) {
    const [found] = await db.query(
      `SELECT a.id AS action_id, a.name AS action_name, a.active AS action_active, a.config,
              r.id AS rule_id, r.name AS rule_name, r.active AS rule_active
         FROM ${ch.actions} a JOIN ${ch.rules} r ON r.id = a.rule_id
        WHERE a.action_type = ?`, [actionType]);
    for (const r of found) {
      const how = matches(r.config);
      if (!how) continue;
      rows.push({ source: `${ch.channel}_ingest_rule`, [ch.ruleKey]: Number(r.rule_id), source_id: Number(r.rule_id),
        source_name: r.rule_name,
        detail: `${ch.channel} ingest rule action #${r.action_id}${r.action_name ? ` "${r.action_name}"` : ''}${how === true ? '' : ` (${how})`}`,
        active: !!(r.rule_active && r.action_active) });
    }
  }
  return rows;
}

function ingestMeta(row) {
  const m = parseJson(row.metadata, {});
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

function idList(v) {
  return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n)) : [];
}

function namedIds(ids, names) {
  return ids.length ? ids.map((i) => `${i} "${names[i] ?? '(deleted)'}"`).join(', ') : null;
}

// Where a message stopped, by status — verified against
// emailIngestService.ingestEmail / phoneIngestService.ingestPhoneEvent.
function ingestPipeline(ch, row, meta) {
  const status = row.status;
  const ran = 'Layer 3 automation RAN (independent of suppression)';
  if (ch.channel === 'email') {
    switch (status) {
      case 'auth_failed': return { layer3: 'did not run', pipeline: 'refused at the receiver (bad or missing source key): no forensic row, no layer ran' };
      case 'validation_failed': return { layer3: 'did not run', pipeline: 'the envelope failed validation: no email_log row, no layer ran' };
      case 'duplicate': return { layer3: 'did not run', pipeline: 'duplicate of an already-received (source, message_id): stopped at the forensic dedupe — suppression and automation did NOT run, so no rule could fire' };
      case 'skipped_firm_to_firm': return { layer3: 'ran', pipeline: `firm-to-firm (every address on a firm domain): ${ran}; suppression was not evaluated and no structured log row was written` };
      case 'skipped_suppression': return { layer3: 'ran', pipeline: `${ran}; a suppression rule matched, so the structured log row was NOT written (suppression hides, it does not cancel)` };
      case 'logged': return { layer3: 'ran', pipeline: `${ran}; the structured log row was written` };
      case 'error':
        return Object.keys(meta).length
          ? { layer3: 'ran', pipeline: `${ran}; the structured log write failed (see error) — the layer-3 outcomes below still stand` }
          : { layer3: 'unknown', pipeline: 'errored without recording layer-3 outcomes: either before automation (email_log insert) or after it on an unexpected log failure, where actions may have fired unrecorded — see error' };
      default: return { layer3: 'unknown', pipeline: `unrecognized status ${status}` };
    }
  }
  if (meta.automation && meta.automation.skipped) {
    return { layer3: `skipped by the caller (${meta.automation.skipped})`, pipeline: `layer 3 was deliberately not consulted (${meta.automation.skipped}) — not "no rule matched"; status ${status}` };
  }
  switch (status) {
    case 'duplicate': return { layer3: 'did not run', pipeline: 'a true provider redelivery of an already-terminal event: suppression and automation did NOT re-run' };
    case 'suppressed': return { layer3: 'ran', pipeline: `${ran}; a suppression rule matched, so no structured log row (firm-to-firm on phone is a suppression match field, not a status)` };
    case 'logged': return { layer3: 'ran', pipeline: `${ran}; the structured log row was written` };
    case 'error':
      return Object.keys(meta).length
        ? { layer3: 'ran', pipeline: `${ran}; the structured log write failed (see error)` }
        : { layer3: 'unknown', pipeline: 'errored without recording layer-3 outcomes — see error' };
    default: return { layer3: 'unknown', pipeline: `unrecognized status ${status}` };
  }
}

async function ingestRun(db, ch, execId) {
  const id = posInt(execId, ch.execKey);
  const [[row]] = ch.channel === 'email'
    ? await db.query(
      `SELECT e.id, e.status, e.created_at, e.message_id, e.email_log_id, e.log_id, e.error, e.metadata,
              e.action_failure_count, (e.remote_ip IS NULL) AS no_remote_ip,
              el.source AS source_name, el.from_email, el.to_email, LEFT(el.subject, 300) AS subject
         FROM email_ingest_executions e LEFT JOIN email_log el ON el.id = e.email_log_id
        WHERE e.id = ?`, [id])
    : await db.query(
      `SELECT e.id, e.status, e.created_at, e.event_log_id, e.log_id, e.error, e.metadata, e.action_failure_count,
              pel.provider, pel.event_type, pel.direction, pel.from_number, pel.to_number, pel.other_party, pel.line_number
         FROM phone_ingest_executions e LEFT JOIN phone_event_log pel ON pel.id = e.event_log_id
        WHERE e.id = ?`, [id]);
  if (!row) throw err(404, `${ch.channel} ingest execution ${id} does not exist`);
  const meta = ingestMeta(row);
  const names = await ch.execService()._hydrateNames(db, [row]);
  const matched = idList(meta.matched_rules);
  const suppressed = idList(meta.suppressed_by);
  const { layer3, pipeline } = ingestPipeline(ch, row, meta);
  const head = {
    row: 'execution', channel: ch.channel, [ch.execKey]: id, status: row.status,
    created_at: row.created_at, created_local: firmLocal(row.created_at),
    layer3, pipeline,
    matched_rules: namedIds(matched, names.rules),
    suppressed_by: namedIds(suppressed, names.suppressions),
    action_failure_count: Number(row.action_failure_count) || 0,
    parse_warnings: meta._parse_warnings ? capJson(meta._parse_warnings, 1000) : null,
    log_id: row.log_id, error: row.error == null ? null : String(row.error).slice(0, 500),
  };
  if (ch.channel === 'email') {
    Object.assign(head, {
      email_log_id: row.email_log_id, source_name: row.source_name,
      feeder: row.no_remote_ip ? 'in-process mailbox worker' : 'HTTP adapter',
      message_id: row.message_id == null ? null : String(row.message_id).slice(0, 200),
      is_test_replay: meta.is_test ? 1 : 0,
      from_email: row.from_email, to_email: row.to_email, subject: row.subject,
    });
  } else {
    Object.assign(head, {
      event_log_id: row.event_log_id, provider: row.provider, event_type: row.event_type, direction: row.direction,
      from_number: row.from_number, to_number: row.to_number, other_party: row.other_party, line_number: row.line_number,
    });
  }
  if (row.status === 'duplicate') {
    const [[orig]] = ch.channel === 'email'
      ? await db.query(`SELECT id FROM email_ingest_executions WHERE email_log_id = ? AND status <> 'duplicate' ORDER BY id ASC LIMIT 1`, [row.email_log_id])
      : await db.query(`SELECT id FROM phone_ingest_executions WHERE event_log_id = ? AND status <> 'duplicate' ORDER BY id ASC LIMIT 1`, [row.event_log_id]);
    head.original_execution_id = orig ? Number(orig.id) : null;
  }
  const rows = [head];

  const outcomes = Array.isArray(meta.action_outcomes) ? meta.action_outcomes : [];
  let liveRules = new Map();
  if (matched.length) {
    const [found] = await db.query(
      `SELECT id, active FROM ${ch.rules} WHERE id IN (${matched.map(() => '?').join(',')})`, matched);
    liveRules = new Map(found.map((r) => [Number(r.id), !!r.active]));
  }
  for (const rid of matched) {
    const own = outcomes.filter((o) => o && Number(o.rule_id) === rid);
    const transformFailed = own.some((o) => o.action_type === 'transform');
    rows.push({
      row: 'matched_rule', [ch.execKey]: id, [ch.ruleKey]: rid, rule_name: names.rules[rid] ?? '(deleted)',
      rule_active_now: liveRules.has(rid) ? liveRules.get(rid) : null,
      result: transformFailed ? 'matched, but its transform FAILED — none of its actions ran'
        : (own.length ? `matched; ${own.length} action outcome(s) below` : 'matched; it had no active actions, so nothing was dispatched'),
    });
  }
  for (const o of outcomes) {
    if (!o || typeof o !== 'object') continue;
    const aid = o.rule_action_id == null ? null : Number(o.rule_action_id);
    let meaning = null;
    if (o.action_type === 'transform') meaning = 'synthetic outcome: the rule matched but its transform failed, so its actions were skipped';
    else if (o.action_type === 'rule_evaluation') meaning = 'synthetic outcome: the rule evaluator itself threw (rule load / DB failure) — no rule was evaluated';
    else if (o.status === 'skipped_test_envelope') meaning = 'a "-test-" replay envelope: workflow actions are deliberately not dispatched';
    rows.push({
      row: 'action_outcome', [ch.execKey]: id,
      [ch.ruleKey]: o.rule_id == null ? null : Number(o.rule_id),
      rule_action_id: aid, action_name: aid != null ? (names.rule_actions[aid] ?? null) : null,
      action_type: o.action_type, status: o.status,
      error: o.error == null ? null : String(o.error).slice(0, 500),
      result: o.result === undefined ? null : capJson(o.result, 400),
      meaning,
    });
  }
  for (const sid of suppressed) {
    rows.push({ row: 'suppression', [ch.execKey]: id, [ch.suppKey]: sid, name: names.suppressions[sid] ?? '(deleted)',
      effect: 'Layer 2: decided only that the structured log row is not written; it never gates automation' });
  }
  return rows;
}

async function ingestLatestMatch(db, ch, ruleId) {
  const id = posInt(ruleId, ch.ruleKey);
  // Bound as a NUMBER: matched_rules holds JSON numbers, and a string param
  // compares string-to-number and matches nothing (executionsService T8 note).
  const [[latest]] = await db.query(
    `SELECT id FROM ${ch.executions} WHERE ? MEMBER OF (metadata->'$.matched_rules') ORDER BY id DESC LIMIT 1`, [id]);
  if (!latest) throw err(404, `${ch.channel} ingest rule ${id} has not matched any recorded execution`);
  return ingestRun(db, ch, Number(latest.id));
}

async function ingestList(db, { ch, what }, { query, cap, since, until }) {
  const search = query != null && String(query).trim() ? escapeLike(String(query).trim()) : null;
  if (what === 'rules') {
    const [rows] = await db.query(
      `SELECT r.id AS ${ch.ruleKey}, r.name, r.active, r.position, r.match_mode, r.transform_mode,
              r.match_count, r.last_matched_at, r.updated_at, LEFT(COALESCE(r.description, ''), 300) AS description,
              (SELECT COUNT(*) FROM ${ch.actions} a WHERE a.rule_id = r.id) AS action_count,
              (SELECT COUNT(*) FROM ${ch.actions} a WHERE a.rule_id = r.id AND a.active = 1) AS active_action_count
         FROM ${ch.rules} r
         ${search ? "WHERE r.name LIKE CONCAT('%', ?, '%')" : ''}
        ORDER BY r.position ASC, r.id ASC LIMIT ${cap}`, search ? [search] : []);
    return rows.map((r) => ({ ...r, channel: ch.channel, active: !!r.active }));
  }
  if (what === 'suppressions') {
    const [rows] = await db.query(
      `SELECT id, name, active, match_mode, match_config, match_count, last_matched_at,
              LEFT(COALESCE(description, ''), 300) AS description
         FROM ${ch.suppressions}
         ${search ? "WHERE name LIKE CONCAT('%', ?, '%')" : ''}
        ORDER BY id ASC LIMIT ${cap}`, search ? [search] : []);
    return rows.map((r) => ({
      channel: ch.channel, [ch.suppKey]: Number(r.id), name: r.name, active: !!r.active, match_mode: r.match_mode,
      match_config: ingestConfigCell(r.match_mode, r.match_config).cell, match_count: r.match_count,
      last_matched_at: r.last_matched_at, description: r.description,
      effect: 'Layer 2: decides only whether the structured log row is written; it never gates automation',
    }));
  }
  // Execution finder: newest first, optionally windowed (firm-local bounds)
  // and searched (email: sender/subject via email_log; phone: other party).
  const where = [];
  const params = [];
  const lo = windowBound(since, false);
  const hi = windowBound(until, true);
  if (lo) { where.push('e.created_at >= ?'); params.push(utcLiteral(lo)); }
  if (hi) { where.push('e.created_at <= ?'); params.push(utcLiteral(hi)); }
  if (ch.channel === 'email') {
    if (search) {
      where.push("(el.subject LIKE CONCAT('%', ?, '%') OR el.from_email LIKE CONCAT('%', ?, '%') OR el.to_email LIKE CONCAT('%', ?, '%'))");
      params.push(search, search, search);
    }
    const [rows] = await db.query(
      `SELECT e.id, e.created_at, e.status, e.email_log_id, e.metadata, e.action_failure_count,
              el.source AS source_name, el.from_email, el.to_email, LEFT(el.subject, 200) AS subject
         FROM email_ingest_executions e LEFT JOIN email_log el ON el.id = e.email_log_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY e.id DESC LIMIT ${cap}`, params);
    const names = await ch.execService()._hydrateNames(db, rows);
    return rows.map((r) => {
      const m = ingestMeta(r);
      return {
        channel: 'email', [ch.execKey]: Number(r.id), created_at: r.created_at, created_local: firmLocal(r.created_at),
        status: r.status, source_name: r.source_name, from_email: r.from_email, to_email: r.to_email, subject: r.subject,
        matched_rules: namedIds(idList(m.matched_rules), names.rules),
        suppressed_by: namedIds(idList(m.suppressed_by), names.suppressions),
        action_failure_count: Number(r.action_failure_count) || 0, is_test_replay: m.is_test ? 1 : 0,
      };
    });
  }
  if (search) {
    where.push("(pel.other_party LIKE CONCAT('%', ?, '%') OR pel.from_number LIKE CONCAT('%', ?, '%') OR pel.to_number LIKE CONCAT('%', ?, '%'))");
    params.push(search, search, search);
  }
  const [rows] = await db.query(
    `SELECT e.id, e.created_at, e.status, e.event_log_id, e.metadata, e.action_failure_count,
            pel.event_type, pel.direction, pel.other_party, pel.line_number
       FROM phone_ingest_executions e LEFT JOIN phone_event_log pel ON pel.id = e.event_log_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.id DESC LIMIT ${cap}`, params);
  const names = await ch.execService()._hydrateNames(db, rows);
  return rows.map((r) => {
    const m = ingestMeta(r);
    return {
      channel: 'phone', [ch.execKey]: Number(r.id), created_at: r.created_at, created_local: firmLocal(r.created_at),
      status: r.status, event_type: r.event_type, direction: r.direction, other_party: r.other_party, line_number: r.line_number,
      matched_rules: namedIds(idList(m.matched_rules), names.rules),
      suppressed_by: namedIds(idList(m.suppressed_by), names.suppressions),
      action_failure_count: Number(r.action_failure_count) || 0,
      layer3_skipped: m.automation && m.automation.skipped ? String(m.automation.skipped) : null,
    };
  });
}

module.exports = {
  list, definition, run, references, projectStepConfig,
  projectIngestActionConfig, ingestConfigCell, windowBound, INGEST_LIST_TYPES, CODE_PART_CHARS, CODE_PARTS_MAX,
};
