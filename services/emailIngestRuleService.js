// services/emailIngestRuleService.js
//
/**
 * Email Ingest — Layer 3 Automation Rule Service
 * services/emailIngestRuleService.js
 *
 * Phase 2 Slice 2.3.
 *
 * Evaluates active rows in `email_ingest_rules` against the canonical
 * envelope. Each matching rule may carry an ordered list of actions in
 * `email_ingest_rule_actions`; those actions fire through the SAME action
 * dispatch path the YisraHook system uses (`lib/actionDispatchers.js`),
 * plus a fifth `hook` action type that re-enters the hook pipeline via
 * `hookService.executeHook`.
 *
 * LAYER INDEPENDENCE (core architectural principle — do not change)
 *   Layer 2 (suppression, services/emailIngestSuppressionService) decides
 *   whether the DEFAULT structured log row gets written.
 *   Layer 3 (this file) decides which ACTIONS fire.
 *   BOTH layers always run against the same envelope. A rule's actions fire
 *   whether or not the default log was suppressed. Suppression does NOT gate
 *   automation. The caller (emailIngestService.ingestEmail) runs both and
 *   records each layer's outcome independently in executions.metadata.
 *
 * Pipeline position (set by emailIngestService.ingestEmail):
 *   ...firm-to-firm check → Layer 2 suppression eval → conditional default log
 *      → evaluateRules(db, envelope)  ← THIS MODULE (always runs)
 *      → write executions row (status = logging-layer outcome) + metadata
 *
 * Duplicates and firm-to-firm hits short-circuit BEFORE either layer runs,
 * so neither suppression nor automation evaluates for emails we never process.
 *
 * Match grammar (mirrors Slice 2.1's suppression service exactly)
 *   - 'conditions' mode reuses services/hookFilter.evaluateConditions.
 *   - 'code' mode evaluates the rule's code body in
 *     `new Function('input', code)(envelope)`.
 *   - Throwing match rules log a warning and count as NON-match (fail-safe:
 *     a broken rule never fires actions).
 *   - NULL match_config on conditions mode is treated as NON-match, NOT
 *     match-all. (hookFilter.evaluateConditions(null, …) returns TRUE — for
 *     an automation rule that would silently fire every email's actions,
 *     almost certainly a mistake. Same defensive call as Slice 2.1.)
 *
 * Transform grammar (inlined here, NOT extracted to a shared module per
 * Slice 2.3 scope — mirrors how Slice 2.1 inlined match-eval)
 *   - 'passthrough' → envelope unchanged.
 *   - 'mapper'      → hookMapper.executeMapper(transform_config, envelope).output
 *   - 'code'        → new Function('input', code)(envelope)
 *   A throwing/failed transform → log warning, treat the rule as NON-firing
 *   (don't feed garbage to actions). The warning text is collected and
 *   surfaced to the caller so it can land in executions.metadata.
 *
 * Action dispatch
 *   workflow | sequence | internal_function | http
 *     → actionDispatchers.dispatch(db, action_type, config, transformedInput,
 *         { target: <synthesized>, source:'email_ingest_rule', rule_id, rule_action_id })
 *     The dispatchers read the full hook_targets row off context.target, so we
 *     synthesize a target-shaped object from the action's config (see
 *     _synthesizeTarget). target.id is set to the rule_action_id so the
 *     returned logData.target_id is a meaningful audit handle.
 *   hook
 *     → hookService.executeHook(db, config.slug, wrappedInput) — cross-service
 *       call. The hook re-runs its OWN filter/transform against the unified
 *       event shape { body, headers, query, method, meta }, so we WRAP the
 *       transformed envelope as `body` (Fred's ruling — keeps one convention
 *       across webhook- and ingest-invoked hooks). Result normalized to the
 *       actionDispatchers {status, error?, result?} shape.
 *
 *   Action failures are isolated: one action throwing/failing does NOT abort
 *   the remaining actions in the same rule. Each outcome is captured.
 *
 * No caching — every ingest hits the DB. ~100 emails/day forever = trivial.
 * Live SQL rule edits propagate immediately. (Slice 2.1 precedent.)
 *
 * CRUD for these tables is Phase 3. Rules are managed via SQL until then.
 */

const { evaluateConditions } = require('./hookFilter');
const hookMapper = require('./hookMapper');
const actionDispatchers = require('../lib/actionDispatchers');
// hookService is required for the 'hook' action type (cross-service call).
// Circular-require check (Slice 2.3): hookService → lib/actionDispatchers →
// {hookMapper, credentialInjection, lazy: workflow_engine/sequenceEngine/
// internal_functions}. None of those require emailIngestService or this file.
// emailIngestService requires THIS file; hookService does not. No cycle.
const hookService = require('./hookService');


// ─────────────────────────────────────────────────────────────
// LOADER
// ─────────────────────────────────────────────────────────────

/**
 * Load active rules with their (active) actions joined in.
 *
 * Two queries (rules, then actions) rather than one JOIN, to avoid
 * row-fan-out duplication of the rule columns and to keep the in-memory
 * assembly trivial. Volume is tiny.
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
       FROM email_ingest_rules
      WHERE active = 1
      ORDER BY position ASC, id ASC`
  );
  if (!rules.length) return [];

  const ruleIds = rules.map(r => r.id);
  const placeholders = ruleIds.map(() => '?').join(',');
  const [actions] = await db.query(
    `SELECT id, rule_id, action_type, config, position
       FROM email_ingest_rule_actions
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
// MATCH EVALUATION  (mirrors Slice 2.1 suppression service)
// ─────────────────────────────────────────────────────────────

/**
 * @returns {boolean} true if the rule matches the envelope.
 */
function _evaluateMatch(rule, envelope) {
  // Defensive JSON parse — mysql2 returns json columns as objects, but a
  // pre-stringified value can sneak in. Same guard as the suppression service.
  let config = rule.match_config;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch (e) {
      console.warn(
        `[emailIngestRule] rule ${rule.id} (${rule.name}): ` +
        `match_config is not parseable JSON — treating as non-match`
      );
      return false;
    }
  }

  if (rule.match_mode === 'conditions') {
    // NULL → non-match (NOT match-all). See module header + Slice 2.1.
    if (config == null) {
      console.warn(
        `[emailIngestRule] rule ${rule.id} (${rule.name}): ` +
        `NULL match_config on conditions mode — treating as non-match. ` +
        `For an explicit always-match, use {operator:'and', conditions:[]}.`
      );
      return false;
    }
    try {
      return !!evaluateConditions(config, envelope);
    } catch (err) {
      console.warn(
        `[emailIngestRule] rule ${rule.id} (${rule.name}) ` +
        `conditions error: ${err.message}`
      );
      return false;
    }
  }

  if (rule.match_mode === 'code') {
    const code = typeof config === 'string' ? config : config?.code;
    if (!code) {
      console.warn(
        `[emailIngestRule] rule ${rule.id} (${rule.name}): ` +
        `empty code on code mode — treating as non-match`
      );
      return false;
    }
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('input', code);
      return !!fn(envelope);
    } catch (err) {
      console.warn(
        `[emailIngestRule] rule ${rule.id} (${rule.name}) ` +
        `code error: ${err.message}`
      );
      return false;
    }
  }

  console.warn(
    `[emailIngestRule] rule ${rule.id} (${rule.name}): ` +
    `unknown match_mode '${rule.match_mode}' — treating as non-match`
  );
  return false;
}


// ─────────────────────────────────────────────────────────────
// TRANSFORM EVALUATION  (inlined — not a shared module, per scope)
// ─────────────────────────────────────────────────────────────

/**
 * Run the rule's transform against the envelope.
 *
 * @returns {{ ok:true, output:object } | { ok:false, error:string }}
 *   ok:false means the transform threw / failed — the caller treats the rule
 *   as non-firing and records the warning. (passthrough always succeeds.)
 */
function _runTransform(rule, envelope) {
  const mode = rule.transform_mode || 'passthrough';

  if (mode === 'passthrough') {
    return { ok: true, output: envelope };
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
      const { output, errors } = hookMapper.executeMapper(config, envelope);
      // Per-rule mapper errors are non-fatal in the hook system (it still
      // delivers the partial output). We mirror that: errors are surfaced as
      // a warning string but do NOT fail the transform — the actions get the
      // partial output, same as a hook target would.
      if (errors && errors.length) {
        console.warn(
          `[emailIngestRule] rule ${rule.id} (${rule.name}) mapper warnings: ` +
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
      const output = fn(envelope);
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
  // For http, the dispatcher reads these off the target row. For the other
  // types they're ignored. Setting them unconditionally is harmless.
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
// { body, headers, query, method, meta }. Hook authors write filter/transform
// paths against that shape (body.from.email, etc.). Wrap the transformed
// envelope as `body` so ingest-invoked hooks use the identical convention as
// webhook-invoked hooks. (Fred's ruling, Slice 2.3.)
// ─────────────────────────────────────────────────────────────

function _wrapForHook(transformedInput, rule, action) {
  return {
    body:    transformedInput,
    headers: {},
    query:   {},
    method:  'POST',
    meta: {
      source:         'email_ingest',
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
 *   - 'filtered'  → success (the hook ran; filtering is a normal outcome, not
 *                    an error — the hook author chose to gate it)
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
// METRICS BUMP (fire-and-forget)  — mirrors Slice 2.1
// ─────────────────────────────────────────────────────────────

async function _bumpMetrics(db, ruleIds) {
  if (!Array.isArray(ruleIds) || !ruleIds.length) return;
  const placeholders = ruleIds.map(() => '?').join(',');
  await db.query(
    `UPDATE email_ingest_rules
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
 * outcome. (actionDispatchers never throws for dispatch failures; the hook
 * cross-call and any programming error are wrapped in try/catch.)
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
        source:         'email_ingest_rule',
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
 * for the audit trail. The shape is intentionally NOT uniform across types —
 * downstream audit unpacks whatever's present.
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
        // enrollContact* return shapes vary; surface whatever id-ish field exists.
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
 * Evaluate all active Layer 3 rules against the envelope and fire the actions
 * of every matching rule.
 *
 * @param {object} db
 * @param {object} envelope  - canonical envelope (top level)
 * @returns {Promise<{
 *   matchedRuleIds: number[],
 *   actionOutcomes: Array<{rule_id, rule_action_id, action_type, status, error?, result?}>,
 *   parseWarnings:  string[]   // transform failures / non-firing diagnostics
 * }>}
 */
async function evaluateRules(db, envelope) {
  const rules = await listActiveRules(db);

  const matchedRuleIds = [];
  const actionOutcomes = [];
  const parseWarnings  = [];
  const bumpIds        = [];

  for (const rule of rules) {
    // 1. Match.
    if (!_evaluateMatch(rule, envelope)) continue;

    // Rule matched (regardless of whether it has actions or its transform
    // succeeds). matched_rules reflects MATCH, so record it now and bump.
    matchedRuleIds.push(rule.id);
    bumpIds.push(rule.id);

    // 2. Transform. A failed transform means the rule does NOT fire its
    //    actions (they'd get garbage input) — but the rule still counts as
    //    matched. Record a diagnostic.
    const tr = _runTransform(rule, envelope);
    if (!tr.ok) {
      const w = `rule ${rule.id} (${rule.name}) transform failed: ${tr.error} — actions skipped`;
      console.warn(`[emailIngestRule] ${w}`);
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
        `[emailIngestRule] match-count bump failed for [${bumpIds.join(',')}]: ${err.message}`
      )
    );
  }

  return { matchedRuleIds, actionOutcomes, parseWarnings };
}


// ─────────────────────────────────────────────────────────────
// CRUD (Phase 3 Slice 3.1 — management API)
//
// Rule listing uses the same two-query (rules + actions IN (...)) join shape
// as listActiveRules to avoid JOIN fan-out, but returns ALL rows (active +
// inactive) with the full column set, and ALL actions (active + inactive).
//
// json columns (match_config / transform_config / action.config) are
// stringified on write. match_count / last_matched_at are pipeline-owned and
// never accepted from the client. Actions are managed via their own
// endpoints — createRule/updateRule never touch them.
// ─────────────────────────────────────────────────────────────

// CIRCULAR-DEPENDENCY NOTE: emailIngestValidator requires
// ../lib/internal_functions, and the phone-log pipeline lives inside
// internal_functions and pulls in the phone ingest services. Today nothing in
// that load graph requires this service back, so a top-level
// `const validator = require('./emailIngestValidator')` happens to work — but
// any future edge from the internal_functions graph into the email ingest
// services would turn it into a partial-exports capture (the default empty {}
// mid-load), with validator.* coming back undefined at runtime. Resolve it
// lazily, matching phoneIngestMetaService / phoneIngestRuleService /
// phoneIngestSuppressionService, so the email and phone sides carry the same
// convention and the landmine class is closed.
function _validator() {
  // Lazy require — see CIRCULAR-DEPENDENCY NOTE above. Node caches the module,
  // so this is a cheap registry lookup after first load, not a re-parse.
  return require('./emailIngestValidator');
}

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
 * All rules (active + inactive), each with an `actions` array (all actions
 * for the rule, active + inactive), ordered by position.
 */
async function listAll(db) {
  const [rules] = await db.query(
    `SELECT ${_RULE_COLS} FROM email_ingest_rules ORDER BY position ASC, id ASC`
  );
  if (!rules.length) return [];

  const ruleIds = rules.map(r => r.id);
  const placeholders = ruleIds.map(() => '?').join(',');
  const [actions] = await db.query(
    `SELECT ${_ACTION_COLS}
       FROM email_ingest_rule_actions
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
    `SELECT ${_RULE_COLS} FROM email_ingest_rules WHERE id = ?`,
    [id]
  );
  if (!rule) return null;
  const [actions] = await db.query(
    `SELECT ${_ACTION_COLS}
       FROM email_ingest_rule_actions
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
  const { errors } = _validator().validateRule(payload, true);
  if (errors.length) throw new ValidationError(errors);

  const transformMode = payload.transform_mode ?? 'passthrough';
  const [r] = await db.query(
    `INSERT INTO email_ingest_rules
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
  const { errors } = _validator().validateRule(merged, true);
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
    `UPDATE email_ingest_rules SET ${sets.join(', ')} WHERE id = ?`,
    vals
  );
  return getById(db, id);
}

/**
 * Hard delete a rule. Actions cascade via FK. Returns true if removed.
 */
async function deleteRule(db, id) {
  const [r] = await db.query(`DELETE FROM email_ingest_rules WHERE id = ?`, [id]);
  return r.affectedRows > 0;
}

/**
 * Single action by id (+ rule_id), or null.
 */
async function getActionById(db, actionId) {
  const [[row]] = await db.query(
    `SELECT ${_ACTION_COLS} FROM email_ingest_rule_actions WHERE id = ?`,
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
  const [[rule]] = await db.query(`SELECT id FROM email_ingest_rules WHERE id = ?`, [ruleId]);
  if (!rule) return null;

  const { errors } = _validator().validateAction(payload, true);
  if (errors.length) throw new ValidationError(errors);
  const ref = await _validator().validateActionReferences(db, payload.action_type, payload.config);
  if (ref.errors.length) throw new ValidationError(ref.errors);

  const [r] = await db.query(
    `INSERT INTO email_ingest_rule_actions
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
  const { errors } = _validator().validateAction(merged, true);
  if (errors.length) throw new ValidationError(errors);
  const ref = await _validator().validateActionReferences(db, merged.action_type, merged.config);
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
    `UPDATE email_ingest_rule_actions SET ${sets.join(', ')} WHERE id = ?`,
    vals
  );
  return getActionById(db, actionId);
}

/**
 * Hard delete an action. Returns true if removed.
 */
async function deleteAction(db, actionId) {
  const [r] = await db.query(`DELETE FROM email_ingest_rule_actions WHERE id = ?`, [actionId]);
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