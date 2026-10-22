'use strict';
// A17.2 — validate and preview an authored workflow step WITHOUT saving or
// executing anything. One core serves two consumers:
//
//   - POST /workflows/test-step's dry_run branch (routes/workflows.js), whose
//     response shape is unchanged;
//   - Casey's automation.preview_step read kind, which can ONLY express a dry
//     run — there is no field that selects live execution, by construction.
//     (test-step's live mode stays excluded for Casey permanently: it runs a
//     body-supplied step with nothing persisted, the shortest path to
//     execution in the app.)
//
// Dry run resolves placeholders and validates params; it calls executeJob
// never. Unresolved tokens are detected on the ORIGINAL config, because
// resolution blanks them to '' and they cannot be seen afterwards — and an
// unset variable (null → flagged) is distinguished from one explicitly set to
// the empty string ('' → not flagged).

const { resolvePlaceholders, resolveSingle } = require('../lib/workflow_engine');
const internalFunctions = require('../lib/internal_functions');
const { refuseCodeStepWithoutCapability } = require('../lib/codeStepGate');

const STEP_TYPES = new Set(['webhook', 'internal_function', 'custom_code']);

function previewError(status, error) {
  const e = new Error(error);
  e.status = status;
  return e;
}

// The shared core. `config` must already be the parsed object form. Returns
// { context, resolvedConfig, preview } — the route's live path keeps using
// context/resolvedConfig; preview carries the dry-run fields.
function buildStepPreview({ step, config, variables = {}, env = {} }) {
  const context = {
    variables,
    this: {},
    env: {
      executionId: env.executionId ?? 'test',
      stepNumber: env.stepNumber ?? 1,
      now: new Date().toISOString(),
      ...env,
    },
  };
  const resolvedConfig = resolvePlaceholders(config, context);
  const preview = {
    resolved_config: resolvedConfig,
    unresolved_placeholders: [...new Set(
      [...JSON.stringify(config).matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1].trim())
    )].filter((k) => resolveSingle(k, context) == null).map((k) => `{{${k}}}`),
  };
  if (step.type === 'internal_function') {
    const vErr = internalFunctions.__validateFunctionParams(config.function_name, resolvedConfig.params);
    if (vErr) preview.validation_error = vErr.error;
  }
  // NEVER resolve or echo credential headers — that would leak secrets into
  // the preview. Just note that injection happens at send.
  if (step.type === 'webhook' && (config.credential_id || resolvedConfig.credential_id)) {
    preview.credential_note = 'Credential headers are injected at send time and are not shown in preview.';
  }
  return { context, resolvedConfig, preview };
}

const MAX_PREVIEW_JSON = 20000;

// The read-kind entry: validates shape, applies the SAME capability gate as
// the route (a staff session cannot preview a standard code step it could not
// save), and returns evidence rows. Strips this.* phantom variables exactly
// as the route does — step-output references are never legitimate inputs.
function previewRows({ auth, step_type, config, variables = {} }) {
  if (!STEP_TYPES.has(step_type)) throw previewError(422, `preview step_type must be one of: ${[...STEP_TYPES].join(', ')}`);
  if (config == null || typeof config !== 'object' || Array.isArray(config)) {
    throw previewError(422, 'preview config must be a JSON object');
  }
  if (JSON.stringify(config).length > MAX_PREVIEW_JSON) throw previewError(422, `preview config exceeds ${MAX_PREVIEW_JSON} characters of JSON`);
  if (variables == null || typeof variables !== 'object' || Array.isArray(variables)) {
    throw previewError(422, 'preview variables must be a JSON object');
  }
  const vars = {};
  for (const [k, v] of Object.entries(variables)) {
    if (k === 'this' || k.startsWith('this.')) continue;
    vars[k] = v;
  }
  const refusal = refuseCodeStepWithoutCapability(auth, step_type, config);
  if (refusal) throw previewError(refusal.status, refusal.error);
  const { preview } = buildStepPreview({ step: { type: step_type }, config, variables: vars });
  return [{
    row: 'step_preview',
    step_type,
    dry_run: 1,
    resolved_config: JSON.stringify(preview.resolved_config),
    unresolved_placeholders: preview.unresolved_placeholders.join(' ') || null,
    validation_error: preview.validation_error || null,
    credential_note: preview.credential_note || null,
  }];
}

module.exports = { buildStepPreview, previewRows };
