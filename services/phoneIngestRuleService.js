// services/phoneIngestRuleService.js
//
/**
 * Phone Ingest — Layer 3 Automation Rule Service
 * services/phoneIngestRuleService.js
 *
 * Port of services/emailIngestRuleService.js against `phone_ingest_rules` +
 * `phone_ingest_rule_actions`. Structure, match/transform grammar, dispatch
 * path, and CRUD are identical to the email reference — the only differences
 * are the table names, the log prefix, and the match input (a phone event vs
 * an email envelope).
 *
 * Evaluates active rows in `phone_ingest_rules` against the phone event (the
 * create_log params object that phone_log receives from the workflow step).
 * Each matching rule may carry an ordered list of actions in
 * `phone_ingest_rule_actions`; those actions fire through the SAME action
 * dispatch path the YisraHook system uses (`lib/actionDispatchers.js`), plus a
 * fifth `hook` action type that re-enters the hook pipeline via
 * `hookService.executeHook`.
 *
 * LAYER INDEPENDENCE (core architectural principle — do not change)
 *   Layer 2 (suppression, services/phoneIngestSuppressionService) decides
 *   whether the DEFAULT structured `log` row gets written.
 *   Layer 3 (this file) decides which ACTIONS fire.
 *   BOTH layers always run against the same event. A rule's actions fire
 *   whether or not the default log was suppressed. Suppression does NOT gate
 *   automation. The caller (phoneIngestService.ingestPhoneEvent — wired by the
 *   NEXT worker) runs both and records each layer's outcome independently in
 *   executions.metadata.
 *
 *   NOTE (phone-specific): unlike email, phone suppression runs mid-workflow
 *   and the workflow's downstream steps run regardless. Layer 3 here is the
 *   same independent-layer design — it is NOT yet wired into
 *   ingestPhoneEvent. The dispatch integration is the next worker's task.
 *   This module is complete and testable on its own.
 *
 * Match grammar (mirrors the suppression service exactly)
 *   - 'conditions' mode reuses services/hookFilter.evaluateConditions.
 *   - 'code' mode evaluates the rule's code body in
 *     `new Function('input', code)(event)`.
 *   - Throwing match rules log a warning and count as NON-match (fail-safe:
 *     a broken rule never fires actions).
 *   - NULL match_config on conditions mode is treated as NON-match, NOT
 *     match-all. (hookFilter.evaluateConditions(null, …) returns TRUE — for
 *     an automation rule that would silently fire every event's actions,
 *     almost certainly a mistake. Same defensive call as the suppression
 *     service.)
 *
 * Transform grammar (inlined here, mirrors the email reference)
 *   - 'passthrough' → event unchanged.
 *   - 'mapper'      → hookMapper.executeMapper(transform_config, event).output
 *   - 'code'        → new Function('input', code)(event)
 *   A throwing/failed transform → log warning, treat the rule as NON-firing
 *   (don't feed garbage to actions). The warning text is collected and
 *   surfaced to the caller so it can land in executions.metadata.
 *
 * Action dispatch
 *   workflow | sequence | internal_function | http
 *     → actionDispatchers.dispatch(db, action_type, config, transformedInput,
 *         { target: <synthesized>, source:'phone_ingest_rule', rule_id, rule_action_id })
 *   hook
 *     → hookService.executeHook(db, config.slug, wrappedInput) — the transformed
 *       event is wrapped as `body` in the unified event shape.
 *
 *   Action failures are isolated: one action throwing/failing does NOT abort
 *   the remaining actions in the same rule. Each outcome is captured.
 *
 * No caching — every event hits the DB. Live SQL rule edits propagate
 * immediately. (Suppression-service precedent.)
 *
 * CRUD reuses services/emailIngestValidator (table-agnostic — same validator
 * the email rule service and both suppression services use).
 */

const { evaluateConditions } = require('./hookFilter');
const hookMapper = require('./hookMapper');
const actionDispatchers = require('../lib/actionDispatchers');
// hookService is required for the 'hook' action type (cross-service call).
// Same no-cycle reasoning as emailIngestRuleService: hookService →
// lib/actionDispatchers → {hookMapper, credentialInjection, lazy engines}.
// None of those require phoneIngestService or this file.
const hookService = require('./hookService');


// ─────────────────────────────────────────────────────────────
// LOADER
// ─────────────────────────────────────────────────────────────

/**
 * Load active rules with their (active) actions joined in.
 *
 * Two queries (rules, then actions) rather than one JOIN, to avoid row
 * fan-out duplication of the rule columns. Volume is tiny.
 *
 * Rules ordered by position ASC, id ASC. Actions ordered by position ASC,
 * id ASC within each rule.
 *
 * @param {object} db
 * @returns {Promise<Array<{
 *   id:number, name:string, match_mode:string, match_config:any,
 *   transform_mode:string, transform_config:any,
 *   actions: Array<{id:number, action_type:string, config:any, position:number}>
 * }>>}
 */
async function listActiveRules(db) {
  const [rules] = await db.query(
    `SELECT id, name, match_mode, match_config, transform_mode, transform_config
       FROM phone_ingest_rules
      WHERE active = 1
      ORDER BY position ASC, id ASC`
  );
  if (!rules.length) return [];

  const ruleIds = rules.map(r => r.id);
  const placeholders = ruleIds.map(() => '?').join(',');
  const [actions] = await db.query(
    `SELECT id, rule_id, action_type, config, position
       FROM phone_ingest_rule_actions
      WHERE active = 1
        AND rule_id IN (${placeholders})
      ORDER BY rule_id ASC, position ASC, id ASC`,
    ruleIds
  );

  const actionsByRule = new Map();
  for (const a of actions) {
    if (!actionsByRule.has(a.rule_id)) actionsByRule.set(a.rule_id, []);
    actionsByRule.get(a.rule_id).push({
      id:          a.id,
      action_type: a.action_type,
      config:      a.config,
      position:    a.position,
    });
  }

  for (const r of rules) {
    r.actions = actionsByRule.get(r.id) || [];
  }
  return rules;
}


// ─────────────────────────────────────────────────────────────
// MATCH EVALUATION  (mirrors the suppression service)
// ─────────────────────────────────────────────────────────────

/**
 * @returns {boolean} true if the rule matches the event.
 */
function _evaluateMatch(rule, event) {
  // Defensive JSON parse — mysql2 returns json columns as objects, but a
  // pre-stringified value can sneak in. Same guard as the suppression service.
  let config = rule.match_config;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch (e) {
      console.warn(
        `[phoneIngestRule] rule ${rule.id} (${rule.name}): ` +
        `match_config is not parseable JSON — treating as non-match`
      );
      return false;
    }
  }

  if (rule.match_mode === 'conditions') {
    // NULL → non-match (NOT match-all). See module header.
    if (config == null) {
      console.warn(
        `[phoneIngestRule] rule ${rule.id} (${rule.name}): ` +
        `NULL match_config on conditions mode — treating as non-match. ` +
        `For an explicit always-match, use {operator:'and', conditions:[]}.`
      );
      return false;
    }
    try {
      return !!evaluateConditions(config, event);
    } catch (err) {
      console.warn(
        `[phoneIngestRule] rule ${rule.id} (${rule.name}) ` +
        `conditions error: ${err.message}`
      );
      return false;
    }
  }

  if (rule.match_mode === 'code') {
    const code = typeof config === 'string' ? config : config?.code;
    if (!code) {
      console.warn(
        `[phoneIngestRule] rule ${rule.id} (${rule.name}): ` +
        `empty code on code mode — treating as non-match`
      );
      return false;
    }
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('input', code);
      return !!fn(event);
    } catch (err) {
      console.warn(
        `[phoneIngestRule] rule ${rule.id} (${rule.name}) ` +
        `code error: ${err.message}`
      );
      return false;
    }
  }

  console.warn(
    `[phoneIngestRule] rule ${rule.id} (${rule.name}): ` +
    `unknown match_mode '${rule.match_mode}' — treating as non-match`
  );
  return false;
}


// ─────────────────────────────────────────────────────────────
// TRANSFORM EVALUATION  (inlined — not a shared module)
// ─────────────────────────────────────────────────────────────

/**
 * Run the rule's transform against the event.
 *
 * @returns {{ ok:true, output:object } | { ok:false, error:string }}
 *   ok:false means the transform threw / failed — the caller treats the rule
 *   as non-firing and records the warning. (passthrough always succeeds.)
 */
function _runTransform(rule, event) {
  const mode = rule.transform_mode || 'passthrough';

  if (mode === 'passthrough') {
    return { ok: true, output: event };
  }

  // Defensive parse of transform_config (json column; may arrive stringified).
  let config = rule.transform_config;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch (e) {
      return {
        ok: false,
        error: `transform_config is not parseable JSON: ${e.message}`,
      };
    }
  }

  if (mode === 'mapper') {
    // hookMapper.executeMapper(rules, input) → { output, errors }.
    // executeMapper expects an ARRAY of mapping rules. transform_config IS
    // that array. If it isn't an array, executeMapper returns {output:{},
    // errors:[]} (empty), which would silently produce {} — guard explicitly.
    if (!Array.isArray(config)) {
      return {
        ok: false,
        error: `mapper transform_config must be an array of mapping rules`,
      };
    }
    try {
      const { output, errors } = hookMapper.executeMapper(config, event);
      // Per-rule mapper errors are non-fatal in the hook system (it still
      // delivers the partial output). We mirror that: errors are surfaced as
      // a warning string but do NOT fail the transform.
      if (errors && errors.length) {
        console.warn(
          `[phoneIngestRule] rule ${rule.id} (${rule.name}) mapper warnings: ` +
          errors.join('; ')
        );
      }
      return { ok: true, output };
    } catch (err) {
      return { ok: false, error: `mapper transform threw: ${err.message}` };
    }
  }

  if (mode === 'code') {
    const code = typeof config === 'string' ? config : config?.code;
    if (!code) {
      return { ok: false, error: `empty code on code transform mode` };
    }
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('input', code);
      const output = fn(event);
      if (output == null || typeof output !== 'object') {
        return {
          ok: false,
          error: `code transform must return an object (got ${typeof output})`,
        };
      }
      return { ok: true, output };
    } catch (err) {
      return { ok: false, error: `code transform threw: ${err.message}` };
    }
  }

  return { ok: false, error: `unknown transform_mode '${mode}'` };
}


// ─────────────────────────────────────────────────────────────
// TARGET SYNTHESIS for actionDispatchers
//
// The dispatchers read a full hook_targets row off context.target:
//   - all four stamp logData.target_id = target.id
//   - http reads url / method / headers / body_mode / body_template /
//     credential_id directly off the row (config is unused for http)
//   - workflow/sequence/internal_function read their settings off the parsed
//     `config` arg, NOT the target row.
//
// So we synthesize a target whose id is the rule_action_id (meaningful audit
// handle) and, for http, whose delivery fields come from the action config.
// ─────────────────────────────────────────────────────────────

function _synthesizeTarget(action) {
  const cfg = (action.config && typeof action.config === 'object') ? action.config : {};
  return {
    id:            action.id,
    url:           cfg.url || null,
    method:        cfg.method || 'POST',
    headers:       cfg.headers || {},
    body_mode:     cfg.body_mode || null,
    body_template: cfg.body_template || null,
    credential_id: cfg.credential_id || null,
  };
}


// ─────────────────────────────────────────────────────────────
// HOOK ACTION — input wrapping
//
// hookService.executeHook treats `input` as the unified event shape
// { body, headers, query, method, meta }. Wrap the transformed event as
// `body` so ingest-invoked hooks use the identical convention as
// webhook-invoked hooks. (Same convention as the email rule service.)
// ─────────────────────────────────────────────────────────────

function _wrapForHook(transformedInput, rule, action) {
  return {
    body:    transformedInput,
    headers: {},
    query:   {},
    method:  'POST',
    meta: {
      source:         'phone_ingest',
      rule_id:        rule.id,
      rule_action_id: action.id,
      received_at:    new Date().toISOString(),
    },
  };
}

/**
 * Normalize hookService.executeHook's return into the action-outcome shape.
 *
 * executeHook returns one of:
 *   { status:'not_found', error }                         (no active hook)
 *   { status:'filtered', executionId, filter }            (filter rejected)
 *   { status:'captured', execution_id, truncated }        (capture mode)
 *   { status:'delivered'|'partial'|'failed'|'dry_run', executionId, ... }
 *
 * We map:
 *   - 'delivered' → success
 *   - 'filtered'  → success (the hook ran; filtering is a normal outcome)
 *   - 'captured'  → success (capture is a deliberate mode)
 *   - 'partial'   → failed (at least one target failed)
 *   - 'failed'    → failed
 *   - 'not_found' → failed
 *   - anything else → failed (defensive)
 *
 * result carries hook_execution_id for audit-join to hook_executions.id.
 */
function _normalizeHookResult(hookRet) {
  const status = hookRet && hookRet.status;
  const execId = (hookRet && (hookRet.executionId ?? hookRet.execution_id)) ?? null;

  const SUCCESS = new Set(['delivered', 'filtered', 'captured']);
  const isSuccess = SUCCESS.has(status);

  const out = {
    status: isSuccess ? 'success' : 'failed',
    result: { hook_execution_id: execId, hook_status: status || null },
  };
  if (!isSuccess) {
    out.error =
      (hookRet && hookRet.error) ||
      `hook returned status '${status || 'unknown'}'`;
  }
  return out;
}


// ─────────────────────────────────────────────────────────────
// METRICS BUMP (fire-and-forget)
// ─────────────────────────────────────────────────────────────

async function _bumpMetrics(db, ruleIds) {
  if (!Array.isArray(ruleIds) || !ruleIds.length) return;
  const placeholders = ruleIds.map(() => '?').join(',');
  await db.query(
    `UPDATE phone_ingest_rules
        SET match_count     = match_count + 1,
            last_matched_at = NOW()
      WHERE id IN (${placeholders})`,
    ruleIds
  );
}


// ─────────────────────────────────────────────────────────────
// ACTION DISPATCH
// ─────────────────────────────────────────────────────────────

/**
 * Dispatch one action. Never throws — failures are captured into the returned
 * outcome.
 *
 * @returns {{rule_id:number, rule_action_id:number, action_type:string,
 *            status:'success'|'failed', error?:string, result?:object}}
 */
async function _dispatchAction(db, rule, action, transformedInput) {
  const base = {
    rule_id:        rule.id,
    rule_action_id: action.id,
    action_type:    action.action_type,
  };

  // Parse action.config defensively (json column).
  let config = action.config;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch (e) {
      return { ...base, status: 'failed', error: `config not parseable JSON: ${e.message}` };
    }
  }
  if (config == null || typeof config !== 'object') config = {};

  try {
    if (action.action_type === 'hook') {
      const slug = config.slug;
      if (!slug) {
        return { ...base, status: 'failed', error: `hook action missing config.slug` };
      }
      const wrapped = _wrapForHook(transformedInput, rule, action);
      const hookRet = await hookService.executeHook(db, slug, wrapped);
      const norm = _normalizeHookResult(hookRet);
      return { ...base, status: norm.status, ...(norm.error ? { error: norm.error } : {}), result: norm.result };
    }

    // workflow | sequence | internal_function | http (+ unknown → dispatcher's
    // own failed-logData branch).
    const target = _synthesizeTarget({ ...action, config });
    const ret = await actionDispatchers.dispatch(
      db,
      action.action_type,
      config,
      transformedInput,
      {
        target,
        source:         'phone_ingest_rule',
        rule_id:        rule.id,
        rule_action_id: action.id,
      }
    );
    // ret = { status, result(logData), error }
    return {
      ...base,
      status: ret.status === 'success' ? 'success' : 'failed',
      ...(ret.error ? { error: ret.error } : {}),
      result: _extractActionResult(action.action_type, ret.result),
    };
  } catch (err) {
    // Programming error (e.g. dispatch threw on missing target — shouldn't
    // happen, we always synthesize one) or the hook cross-call threw.
    return { ...base, status: 'failed', error: err.message };
  }
}

/**
 * Pull a compact, type-appropriate identifier out of the dispatcher's logData
 * for the audit trail. The shape is intentionally NOT uniform across types.
 */
function _extractActionResult(actionType, logData) {
  if (!logData || typeof logData !== 'object') return null;

  // logData.response_body is a JSON string for the internal types; parse it
  // best-effort to lift the identifier.
  let body = null;
  if (typeof logData.response_body === 'string' && logData.response_body) {
    try { body = JSON.parse(logData.response_body); } catch { body = null; }
  }

  switch (actionType) {
    case 'workflow':
      return {
        workflow_execution_id: body?.executionId ?? null,
        workflow_id:           body?.workflowId ?? null,
      };
    case 'sequence':
      return {
        enrollment_id: body?.enrollmentId ?? body?.enrollment_id ?? null,
      };
    case 'internal_function':
      return { response_status: logData.response_status ?? null };
    case 'http':
      return { response_status: logData.response_status ?? null };
    default:
      return { response_status: logData.response_status ?? null };
  }
}


// ─────────────────────────────────────────────────────────────
// ORCHESTRATOR
// ─────────────────────────────────────────────────────────────

/**
 * Evaluate all active Layer 3 rules against the event and fire the actions of
 * every matching rule.
 *
 * @param {object} db
 * @param {object} event  - phone event (create_log params object, top level)
 * @returns {Promise<{
 *   matchedRuleIds: number[],
 *   actionOutcomes: Array<{rule_id, rule_action_id, action_type, status, error?, result?}>,
 *   parseWarnings:  string[]   // transform failures / non-firing diagnostics
 * }>}
 */
async function evaluateRules(db, event) {
  const rules = await listActiveRules(db);

  const matchedRuleIds = [];
  const actionOutcomes = [];
  const parseWarnings  = [];
  const bumpIds        = [];

  for (const rule of rules) {
    // 1. Match.
    if (!_evaluateMatch(rule, event)) continue;

    // Rule matched (regardless of whether it has actions or its transform
    // succeeds). matched_rules reflects MATCH, so record it now and bump.
    matchedRuleIds.push(rule.id);
    bumpIds.push(rule.id);

    // 2. Transform. A failed transform means the rule does NOT fire its
    //    actions (they'd get garbage input) — but the rule still counts as
    //    matched. Record a diagnostic.
    const tr = _runTransform(rule, event);
    if (!tr.ok) {
      const w = `rule ${rule.id} (${rule.name}) transform failed: ${tr.error} — actions skipped`;
      console.warn(`[phoneIngestRule] ${w}`);
      parseWarnings.push(w);
      continue;
    }
    const transformedInput = tr.output;

    // 3. Actions, in position order. Each isolated; one failure does not
    //    abort the rest.
    for (const action of rule.actions) {
      const outcome = await _dispatchAction(db, rule, action, transformedInput);
      actionOutcomes.push(outcome);
    }
  }

  // Fire-and-forget metrics bump for all matched rules.
  if (bumpIds.length) {
    _bumpMetrics(db, bumpIds).catch(err =>
      console.warn(
        `[phoneIngestRule] match-count bump failed for [${bumpIds.join(',')}]: ${err.message}`
      )
    );
  }

  return { matchedRuleIds, actionOutcomes, parseWarnings };
}


// ─────────────────────────────────────────────────────────────
// CRUD (management API)
//
// Identical shape to emailIngestRuleService CRUD. json columns
// (match_config / transform_config / action.config) are stringified on write.
// match_count / last_matched_at are pipeline-owned and never accepted from the
// client. Actions are managed via their own endpoints — createRule/updateRule
// never touch them. Validation reuses services/emailIngestValidator (table-
// agnostic).
// ─────────────────────────────────────────────────────────────

const validator = require('./emailIngestValidator');

class ValidationError extends Error {
  constructor(errors) {
    super('validation_failed');
    this.name = 'ValidationError';
    this.validationErrors = errors;
  }
}

function _toJsonColumn(v) {
  if (v == null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

const _RULE_COLS =
  `id, name, description, active, position, match_mode, match_config,
   transform_mode, transform_config, match_count, last_matched_at,
   last_modified_by, created_at, updated_at`;

const _ACTION_COLS = `id, rule_id, position, active, action_type, config`;

/**
 * All rules (active + inactive), each with an `actions` array (all actions for
 * the rule, active + inactive), ordered by position.
 */
async function listAll(db) {
  const [rules] = await db.query(
    `SELECT ${_RULE_COLS} FROM phone_ingest_rules ORDER BY position ASC, id ASC`
  );
  if (!rules.length) return [];

  const ruleIds = rules.map(r => r.id);
  const placeholders = ruleIds.map(() => '?').join(',');
  const [actions] = await db.query(
    `SELECT ${_ACTION_COLS}
       FROM phone_ingest_rule_actions
      WHERE rule_id IN (${placeholders})
      ORDER BY rule_id ASC, position ASC, id ASC`,
    ruleIds
  );

  const byRule = new Map();
  for (const a of actions) {
    if (!byRule.has(a.rule_id)) byRule.set(a.rule_id, []);
    byRule.get(a.rule_id).push(a);
  }
  for (const r of rules) r.actions = byRule.get(r.id) || [];
  return rules;
}

/**
 * One rule + its actions, or null if absent.
 */
async function getById(db, id) {
  const [[rule]] = await db.query(
    `SELECT ${_RULE_COLS} FROM phone_ingest_rules WHERE id = ?`,
    [id]
  );
  if (!rule) return null;
  const [actions] = await db.query(
    `SELECT ${_ACTION_COLS}
       FROM phone_ingest_rule_actions
      WHERE rule_id = ?
      ORDER BY position ASC, id ASC`,
    [id]
  );
  rule.actions = actions;
  return rule;
}

/**
 * Validate + INSERT a rule (no actions). Returns the row with actions: [].
 * @throws {ValidationError}
 */
async function createRule(db, payload, userId) {
  const { errors } = validator.validateRule(payload, true);
  if (errors.length) throw new ValidationError(errors);

  const transformMode = payload.transform_mode ?? 'passthrough';
  const [r] = await db.query(
    `INSERT INTO phone_ingest_rules
       (name, description, active, position, match_mode, match_config,
        transform_mode, transform_config, last_modified_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.name,
      payload.description ?? null,
      payload.active !== undefined ? (payload.active ? 1 : 0) : 1,
      payload.position ?? 0,
      payload.match_mode,
      _toJsonColumn(payload.match_config),
      transformMode,
      transformMode === 'passthrough' ? null : _toJsonColumn(payload.transform_config),
      userId ?? null,
    ]
  );
  return getById(db, r.insertId);
}

/**
 * Partial rule update. Validates the merged record. Does NOT touch actions.
 * Returns the updated row, or null if absent.
 * @throws {ValidationError}
 */
async function updateRule(db, id, payload, userId) {
  const existing = await getById(db, id);
  if (!existing) return null;

  const merged = {
    name:             payload.name             !== undefined ? payload.name             : existing.name,
    description:      payload.description      !== undefined ? payload.description      : existing.description,
    active:           payload.active           !== undefined ? payload.active           : existing.active,
    position:         payload.position         !== undefined ? payload.position         : existing.position,
    match_mode:       payload.match_mode       !== undefined ? payload.match_mode       : existing.match_mode,
    match_config:     payload.match_config     !== undefined ? payload.match_config     : existing.match_config,
    transform_mode:   payload.transform_mode   !== undefined ? payload.transform_mode   : existing.transform_mode,
    transform_config: payload.transform_config !== undefined ? payload.transform_config : existing.transform_config,
  };
  const { errors } = validator.validateRule(merged, true);
  if (errors.length) throw new ValidationError(errors);

  const sets = [];
  const vals = [];
  if (payload.name             !== undefined) { sets.push('name = ?');             vals.push(payload.name); }
  if (payload.description      !== undefined) { sets.push('description = ?');      vals.push(payload.description ?? null); }
  if (payload.active           !== undefined) { sets.push('active = ?');           vals.push(payload.active ? 1 : 0); }
  if (payload.position         !== undefined) { sets.push('position = ?');         vals.push(payload.position); }
  if (payload.match_mode       !== undefined) { sets.push('match_mode = ?');       vals.push(payload.match_mode); }
  if (payload.match_config     !== undefined) { sets.push('match_config = ?');     vals.push(_toJsonColumn(payload.match_config)); }
  if (payload.transform_mode   !== undefined) { sets.push('transform_mode = ?');   vals.push(payload.transform_mode); }
  if (payload.transform_config !== undefined) {
    // passthrough forces NULL regardless of supplied value (validator already
    // rejects a non-null config on passthrough, but be defensive).
    const tmode = merged.transform_mode;
    sets.push('transform_config = ?');
    vals.push(tmode === 'passthrough' ? null : _toJsonColumn(payload.transform_config));
  }
  sets.push('last_modified_by = ?'); vals.push(userId ?? null);

  vals.push(id);
  await db.query(
    `UPDATE phone_ingest_rules SET ${sets.join(', ')} WHERE id = ?`,
    vals
  );
  return getById(db, id);
}

/**
 * Hard delete a rule. Actions cascade via FK. Returns true if removed.
 */
async function deleteRule(db, id) {
  const [r] = await db.query(`DELETE FROM phone_ingest_rules WHERE id = ?`, [id]);
  return r.affectedRows > 0;
}

/**
 * Single action by id, or null.
 */
async function getActionById(db, actionId) {
  const [[row]] = await db.query(
    `SELECT ${_ACTION_COLS} FROM phone_ingest_rule_actions WHERE id = ?`,
    [actionId]
  );
  return row || null;
}

/**
 * Add an action to a rule. Validates shape AND references (target exists +
 * active). Returns the created action, or null if the parent rule is absent.
 * @throws {ValidationError}
 */
async function addAction(db, ruleId, payload) {
  const [[rule]] = await db.query(`SELECT id FROM phone_ingest_rules WHERE id = ?`, [ruleId]);
  if (!rule) return null;

  const { errors } = validator.validateAction(payload, true);
  if (errors.length) throw new ValidationError(errors);
  const ref = await validator.validateActionReferences(db, payload.action_type, payload.config);
  if (ref.errors.length) throw new ValidationError(ref.errors);

  const [r] = await db.query(
    `INSERT INTO phone_ingest_rule_actions
       (rule_id, position, active, action_type, config)
     VALUES (?, ?, ?, ?, ?)`,
    [
      ruleId,
      payload.position ?? 0,
      payload.active !== undefined ? (payload.active ? 1 : 0) : 1,
      payload.action_type,
      _toJsonColumn(payload.config),
    ]
  );
  return getActionById(db, r.insertId);
}

/**
 * Partial action update. Validates the merged record (shape + references).
 * Returns the updated action, or null if absent.
 * @throws {ValidationError}
 */
async function updateAction(db, actionId, payload) {
  const existing = await getActionById(db, actionId);
  if (!existing) return null;

  const merged = {
    action_type: payload.action_type !== undefined ? payload.action_type : existing.action_type,
    config:      payload.config      !== undefined ? payload.config      : existing.config,
    position:    payload.position    !== undefined ? payload.position    : existing.position,
    active:      payload.active      !== undefined ? payload.active      : existing.active,
  };
  const { errors } = validator.validateAction(merged, true);
  if (errors.length) throw new ValidationError(errors);
  const ref = await validator.validateActionReferences(db, merged.action_type, merged.config);
  if (ref.errors.length) throw new ValidationError(ref.errors);

  const sets = [];
  const vals = [];
  if (payload.action_type !== undefined) { sets.push('action_type = ?'); vals.push(payload.action_type); }
  if (payload.config      !== undefined) { sets.push('config = ?');      vals.push(_toJsonColumn(payload.config)); }
  if (payload.position    !== undefined) { sets.push('position = ?');    vals.push(payload.position); }
  if (payload.active      !== undefined) { sets.push('active = ?');      vals.push(payload.active ? 1 : 0); }

  if (!sets.length) return existing; // nothing to change

  vals.push(actionId);
  await db.query(
    `UPDATE phone_ingest_rule_actions SET ${sets.join(', ')} WHERE id = ?`,
    vals
  );
  return getActionById(db, actionId);
}

/**
 * Hard delete an action. Returns true if removed.
 */
async function deleteAction(db, actionId) {
  const [r] = await db.query(`DELETE FROM phone_ingest_rule_actions WHERE id = ?`, [actionId]);
  return r.affectedRows > 0;
}


module.exports = {
  listActiveRules,
  evaluateRules,
  // CRUD
  listAll,
  getById,
  createRule,
  updateRule,
  deleteRule,
  addAction,
  updateAction,
  deleteAction,
  getActionById,
  ValidationError,
  // Exported for testing
  _evaluateMatch,
  _runTransform,
  _dispatchAction,
  _normalizeHookResult,
  _synthesizeTarget,
  _wrapForHook,
  _bumpMetrics,
};