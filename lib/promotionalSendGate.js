'use strict';
// The promotional-send capability gate (C7, review B1), shared by every
// surface that accepts an authored internal-function step: the workflow step
// writers and test-step (routes/workflows.js), Casey's dry-run preview
// (services/stepPreviewService.js), sequence steps (routes/sequences.js),
// scheduled jobs (routes/scheduled_jobs.js), trigger-rule actions
// (routes/api.triggers.js) and hook targets (routes/api.hooks.js). The
// codeStepGate pattern.
//
// WHY: a send_email step with `promotional` truthy is a MARKETING send — it
// goes out from the bulk/SES transport with the compliance footer, outside
// the campaign engine. D13 ruled who may send marketing: the campaigns.bulk
// capability (admin role). Without this gate any staff JWT (or any scoped
// API key) could author (or test-run) such a step and send marketing mail
// with no capability and no audit (found in C7's review, 2026-11-05). A
// NULL-scope machine key passes can() for EVERY capability by design
// (lib/capabilities machine trust) — this gate neither widens nor narrows
// that.
//
// FAIL CLOSED on indirection: only a LITERALLY-falsy `promotional` (absent,
// null, '', false, 'false', '0', 0) passes ungated. Anything else — true in
// any spelling, or a {{placeholder}} that would resolve later, out of this
// gate's sight — needs the capability. send_sms is not gated here: its
// promotional is refused at run time whoever asks (D1).
//
// Returns null when allowed, or { status, error, message }.

const { can } = require('./capabilities');

const LITERAL_FALSY = new Set([undefined, null, '', false, 'false', '0', 0]);

/** The core question, however the writer stores its config. */
function refusePromotionalWithoutCapability(auth, functionName, params) {
  if (functionName !== 'send_email') return null;
  const v = params == null ? undefined : params.promotional;
  if (LITERAL_FALSY.has(v)) return null;
  if (can(auth, 'campaigns.bulk')) return null;
  return {
    status: 403,
    error: 'promotional send_email steps require the campaigns.bulk capability',
    message: 'A promotional step sends MARKETING email from the firm\'s bulk transport (D13: campaigns.bulk, admin role). '
      + 'Leave promotional off for an operational send — or ask an administrator to author this step. '
      + 'A {{placeholder}} in promotional is refused the same way: the gate cannot see what it resolves to.',
  };
}

/**
 * Workflow / sequence step shape: config { function_name, params }. Workflows
 * use type 'internal_function'; SEQUENCES also run their 'sms' / 'email' /
 * 'task' action types through executeJob as internal functions with the same
 * config (lib/internal_functions/index.js SEQUENCE_FUNCTION_ACTION_TYPES) —
 * 'email' is the NORMAL type of a sequence email step, so gating only
 * 'internal_function' left it open (re-review B1a, 2026-11-05).
 */
const FUNCTION_STEP_TYPES = new Set(['internal_function', 'sms', 'email', 'task']);

function refusePromotionalStep(auth, stepType, config) {
  if (!FUNCTION_STEP_TYPES.has(stepType) || config == null || typeof config !== 'object') return null;
  return refusePromotionalWithoutCapability(auth, config.function_name, config.params);
}

/**
 * Trigger-action / hook-target shape: config { function_name, params_mapping }.
 * A mapping's VALUES are dot-paths resolved from the event at dispatch — a
 * save-time gate cannot see what they resolve to, so the PRESENCE of the
 * `promotional` KEY is what needs the capability. An absent key can never
 * become promotional at run time (resolveParamsMapping maps declared keys
 * only).
 */
function refusePromotionalMapping(auth, functionName, paramsMapping) {
  if (functionName !== 'send_email') return null;
  if (paramsMapping == null || typeof paramsMapping !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(paramsMapping, 'promotional')) return null;
  if (can(auth, 'campaigns.bulk')) return null;
  return {
    status: 403,
    error: 'a promotional send_email mapping requires the campaigns.bulk capability',
    message: 'This action maps the promotional param of send_email, which sends MARKETING email from the firm\'s bulk '
      + 'transport (D13: campaigns.bulk, admin role). Drop the promotional key for an operational send — or ask an administrator.',
  };
}

/**
 * Ingest-rule action shape (email + phone ingest, re-review B1b): one action
 * { action_type, config: { function_name, params_mapping } }, or a rule
 * payload carrying an inline `actions` list of them.
 */
function refusePromotionalIngestAction(auth, action) {
  if (!action || action.action_type !== 'internal_function' || !action.config || typeof action.config !== 'object') return null;
  return refusePromotionalMapping(auth, action.config.function_name, action.config.params_mapping);
}
/**
 * An UPDATE gates the EFFECTIVE action — the stored row merged with the body
 * (the ingestCodeGate precedent). Gating the body alone allowed a two-request
 * bypass: smuggle the promotional mapping in under a workflow-type action
 * (extra config keys are stored), then flip action_type with no config
 * (round-3 review, 2026-11-05).
 */
function refusePromotionalIngestActionUpdate(auth, before, body) {
  const b = body || {};
  const prev = before || {};
  const parseStored = (v) => (typeof v === 'string' ? JSON.parse(v) : v);   // stored rows may carry JSON text
  return refusePromotionalIngestAction(auth, {
    action_type: b.action_type !== undefined ? b.action_type : prev.action_type,
    config: b.config !== undefined ? b.config : parseStored(prev.config),
  });
}

function refusePromotionalIngestRule(auth, payload) {
  for (const a of Array.isArray(payload && payload.actions) ? payload.actions : []) {
    const r = refusePromotionalIngestAction(auth, a);
    if (r) return r;
  }
  return null;
}

module.exports = {
  refusePromotionalWithoutCapability, refusePromotionalStep, refusePromotionalMapping,
  refusePromotionalIngestAction, refusePromotionalIngestActionUpdate, refusePromotionalIngestRule, FUNCTION_STEP_TYPES,
};
