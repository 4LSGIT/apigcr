// services/emailIngestValidator.js
//
/**
 * Email Ingest — CRUD Validation (Phase 3 Slice 3.1)
 * services/emailIngestValidator.js
 *
 * Pure-ish validation helpers for the management API. Two flavors:
 *
 *   - Synchronous shape validators (validateSuppression, validateRule,
 *     validateAction) return { errors: [{field, message}, ...] }. Empty
 *     array == valid. These cover type/enum/required checks only.
 *
 *   - Asynchronous referential validators (validateActionReferences) hit
 *     the DB to confirm that an action's config points at an existing,
 *     active target (workflow / sequence_template / hook / credential)
 *     or a registered internal function. Kept separate so a caller can
 *     run the cheap shape check first and only pay for the round-trips
 *     when the shape is already sound.
 *
 * The route layer translates a non-empty errors array into the structured
 * 400 body documented in the slice prompt:
 *
 *   single field:  { error:'validation_failed', field, message }
 *   multi field:   { error:'validation_failed', errors:[{field,message}] }
 *
 * Internal-function registry: the live `lib/internal_functions` module is a
 * flat object that ALSO carries `__`-prefixed helpers (`__getAllMeta`, etc.).
 * We filter to `typeof fn === 'function' && !name.startsWith('__')` — the
 * naive `Object.keys()` would treat those helpers as callable functions.
 */

const internalFunctions = require('../lib/internal_functions');

const MATCH_MODES     = new Set(['conditions', 'code']);
const TRANSFORM_MODES = new Set(['passthrough', 'mapper', 'code']);
const ACTION_TYPES    = new Set(['workflow', 'sequence', 'hook', 'internal_function', 'http']);
const GROUP_OPERATORS = new Set(['and', 'or']);


// ─────────────────────────────────────────────────────────────
// INTERNAL-FUNCTION REGISTRY (names only, helpers stripped)
// ─────────────────────────────────────────────────────────────

/**
 * @returns {string[]} sorted callable internal-function names
 */
function internalFunctionNames() {
  return Object.keys(internalFunctions)
    .filter((k) => typeof internalFunctions[k] === 'function' && !k.startsWith('__'))
    .sort();
}


// ─────────────────────────────────────────────────────────────
// SHARED FIELD CHECKS
// ─────────────────────────────────────────────────────────────

function _isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function _isNonNegInt(v) {
  return Number.isInteger(v) && v >= 0;
}

function _isBool01(v) {
  return v === 0 || v === 1 || v === true || v === false;
}

/**
 * Validate a match_config against its match_mode. Pushes {field,message}
 * onto `errors`. `field` defaults to 'match_config'.
 */
function _checkMatchConfig(mode, config, errors, field = 'match_config') {
  if (mode === 'conditions') {
    if (!_isPlainObject(config)) {
      errors.push({ field, message: `must be an object when match_mode is 'conditions'` });
      return;
    }
    if (!GROUP_OPERATORS.has(String(config.operator || '').toLowerCase())) {
      errors.push({ field, message: `must have operator 'and' or 'or' when match_mode is 'conditions'` });
    }
    if (!Array.isArray(config.conditions)) {
      // Empty array is allowed (cookbook §3.18 always-match shape); only the
      // type is enforced here.
      errors.push({ field, message: `must have a 'conditions' array when match_mode is 'conditions'` });
    }
    return;
  }

  if (mode === 'code') {
    // Either a bare non-empty string, or { code:'<non-empty>' }.
    const code = typeof config === 'string' ? config : (_isPlainObject(config) ? config.code : null);
    if (typeof code !== 'string' || code.trim() === '') {
      errors.push({ field, message: `must be a non-empty code string or { code:'...' } when match_mode is 'code'` });
    }
  }
}


// ─────────────────────────────────────────────────────────────
// SUPPRESSION
// ─────────────────────────────────────────────────────────────

/**
 * @param {object}  payload
 * @param {boolean} isCreate - true for POST (full required-field set),
 *                             false for PUT (partial; only validate present fields)
 * @returns {{errors: Array<{field,message}>}}
 */
function validateSuppression(payload, isCreate) {
  const errors = [];
  const p = payload || {};

  // name
  if (isCreate || p.name !== undefined) {
    if (typeof p.name !== 'string' || p.name.length < 1 || p.name.length > 255) {
      errors.push({ field: 'name', message: 'required string, length 1-255' });
    }
  }

  // match_mode
  let mode = p.match_mode;
  if (isCreate || p.match_mode !== undefined) {
    if (!MATCH_MODES.has(p.match_mode)) {
      errors.push({ field: 'match_mode', message: 'must be one of conditions|code' });
      mode = undefined; // don't attempt config check against an invalid mode
    }
  }

  // match_config — required on create; on update only when present OR when
  // match_mode is being changed (config must agree with the new mode).
  const configPresent = p.match_config !== undefined;
  if (isCreate) {
    if (!MATCH_MODES.has(mode)) {
      // mode already errored; skip
    } else if (!configPresent || p.match_config === null) {
      if (mode === 'conditions') {
        errors.push({ field: 'match_config', message: `required when match_mode is 'conditions'` });
      } else {
        _checkMatchConfig(mode, p.match_config, errors);
      }
    } else {
      _checkMatchConfig(mode, p.match_config, errors);
    }
  } else if (configPresent && MATCH_MODES.has(mode)) {
    _checkMatchConfig(mode, p.match_config, errors);
  } else if (configPresent && mode === undefined && p.match_mode === undefined) {
    // PUT changing config but not mode: we can't know the effective mode
    // without the existing row. The service performs the merge and re-checks;
    // here we only guard the obvious null-on-conditions footgun cannot be
    // caught without the row, so defer to the service (see update()).
  }

  // active
  if (p.active !== undefined && !_isBool01(p.active)) {
    errors.push({ field: 'active', message: 'must be 0 or 1' });
  }

  return { errors };
}


// ─────────────────────────────────────────────────────────────
// RULE
// ─────────────────────────────────────────────────────────────

function validateRule(payload, isCreate) {
  const errors = [];
  const p = payload || {};

  // name / match_mode / match_config / active — same rules as suppression.
  const base = validateSuppression(p, isCreate);
  errors.push(...base.errors);

  // position
  if (p.position !== undefined && !_isNonNegInt(p.position)) {
    errors.push({ field: 'position', message: 'must be a non-negative integer' });
  }

  // transform_mode
  let tmode = p.transform_mode;
  if (p.transform_mode !== undefined) {
    if (!TRANSFORM_MODES.has(p.transform_mode)) {
      errors.push({ field: 'transform_mode', message: 'must be one of passthrough|mapper|code' });
      tmode = undefined;
    }
  }

  // transform_config (validated against transform_mode when both are known).
  // On create, transform_mode defaults to 'passthrough' if absent.
  const effectiveTMode = tmode !== undefined ? tmode : (isCreate ? 'passthrough' : undefined);
  if (p.transform_config !== undefined && effectiveTMode !== undefined) {
    _checkTransformConfig(effectiveTMode, p.transform_config, errors);
  } else if (isCreate && effectiveTMode && effectiveTMode !== 'passthrough' && p.transform_config === undefined) {
    // mapper/code with no config → invalid
    _checkTransformConfig(effectiveTMode, undefined, errors);
  }

  return { errors };
}

function _checkTransformConfig(mode, config, errors, field = 'transform_config') {
  if (mode === 'passthrough') {
    if (config != null) {
      errors.push({ field, message: `must be null/absent when transform_mode is 'passthrough'` });
    }
    return;
  }
  if (mode === 'mapper') {
    if (!Array.isArray(config)) {
      errors.push({ field, message: `must be an array of mapping rules when transform_mode is 'mapper'` });
    }
    return;
  }
  if (mode === 'code') {
    const code = typeof config === 'string' ? config : (_isPlainObject(config) ? config.code : null);
    if (typeof code !== 'string' || code.trim() === '') {
      errors.push({ field, message: `must be a non-empty code string or { code:'...' } when transform_mode is 'code'` });
    }
  }
}


// ─────────────────────────────────────────────────────────────
// RULE ACTION — shape
// ─────────────────────────────────────────────────────────────

function validateAction(payload, isCreate) {
  const errors = [];
  const p = payload || {};

  if (isCreate || p.action_type !== undefined) {
    if (!ACTION_TYPES.has(p.action_type)) {
      errors.push({ field: 'action_type', message: 'must be one of workflow|sequence|hook|internal_function|http' });
    }
  }

  if (isCreate || p.config !== undefined) {
    if (!_isPlainObject(p.config)) {
      errors.push({ field: 'config', message: 'required object' });
    } else {
      _checkActionConfigShape(p.action_type, p.config, errors);
    }
  }

  if (p.position !== undefined && !_isNonNegInt(p.position)) {
    errors.push({ field: 'position', message: 'must be a non-negative integer' });
  }

  if (p.active !== undefined && !_isBool01(p.active)) {
    errors.push({ field: 'active', message: 'must be 0 or 1' });
  }

  return { errors };
}

/**
 * Per-type config SHAPE checks (cheap, no DB). Field names mirror what the
 * dispatchers in lib/actionDispatchers.js actually read:
 *   workflow          → config.workflow_id
 *   sequence          → config.template_id OR config.template_type
 *   hook              → config.slug
 *   internal_function → config.function_name
 *   http              → config.url
 */
function _checkActionConfigShape(actionType, config, errors) {
  switch (actionType) {
    case 'workflow': {
      const id = config.workflow_id;
      if (!Number.isInteger(id) || id <= 0) {
        errors.push({ field: 'config.workflow_id', message: 'must be a positive integer' });
      }
      break;
    }
    case 'sequence': {
      const hasId   = config.template_id !== undefined && config.template_id !== null && config.template_id !== '';
      const hasType = typeof config.template_type === 'string' && config.template_type.trim() !== '';
      if (!hasId && !hasType) {
        errors.push({ field: 'config.template_id', message: 'one of config.template_id or config.template_type is required' });
      }
      if (hasId) {
        const idInt = Number(config.template_id);
        if (!Number.isInteger(idInt) || idInt <= 0) {
          errors.push({ field: 'config.template_id', message: 'must be a positive integer' });
        }
      }
      break;
    }
    case 'hook': {
      if (typeof config.slug !== 'string' || config.slug.trim() === '') {
        errors.push({ field: 'config.slug', message: 'non-empty string required' });
      }
      break;
    }
    case 'internal_function': {
      if (typeof config.function_name !== 'string' || config.function_name.trim() === '') {
        errors.push({ field: 'config.function_name', message: 'non-empty string required' });
      }
      break;
    }
    case 'http': {
      if (typeof config.url !== 'string' || config.url.trim() === '') {
        errors.push({ field: 'config.url', message: 'non-empty string required' });
      }
      break;
    }
    default:
      // action_type already errored upstream
      break;
  }
}


// ─────────────────────────────────────────────────────────────
// RULE ACTION — referential (async; DB round-trips)
// ─────────────────────────────────────────────────────────────

/**
 * Confirm the action's config references real, active targets. Only call this
 * AFTER validateAction reports no shape errors — it assumes the required keys
 * are present and well-typed.
 *
 * @param {object} db
 * @param {string} actionType
 * @param {object} config
 * @returns {Promise<{errors: Array<{field,message}>}>}
 */
async function validateActionReferences(db, actionType, config) {
  const errors = [];

  if (actionType === 'workflow') {
    const [[row]] = await db.query(
      `SELECT id, active FROM workflows WHERE id = ?`,
      [config.workflow_id]
    );
    if (!row) {
      errors.push({ field: 'config.workflow_id', message: `workflow ${config.workflow_id} does not exist` });
    } else if (!row.active) {
      errors.push({ field: 'config.workflow_id', message: `workflow ${config.workflow_id} is not active` });
    }
  }

  else if (actionType === 'sequence') {
    if (config.template_id !== undefined && config.template_id !== null && config.template_id !== '') {
      const [[row]] = await db.query(
        `SELECT id, active FROM sequence_templates WHERE id = ?`,
        [config.template_id]
      );
      if (!row) {
        errors.push({ field: 'config.template_id', message: `sequence_template ${config.template_id} does not exist` });
      } else if (!row.active) {
        errors.push({ field: 'config.template_id', message: `sequence_template ${config.template_id} is not active` });
      }
    } else if (config.template_type) {
      const [[row]] = await db.query(
        `SELECT id FROM sequence_templates WHERE type = ? AND active = 1 LIMIT 1`,
        [config.template_type]
      );
      if (!row) {
        errors.push({ field: 'config.template_type', message: `no active sequence_template with type '${config.template_type}'` });
      }
    }
  }

  else if (actionType === 'hook') {
    const [[row]] = await db.query(
      `SELECT id, active FROM hooks WHERE slug = ?`,
      [config.slug]
    );
    if (!row) {
      errors.push({ field: 'config.slug', message: `hook '${config.slug}' does not exist` });
    } else if (!row.active) {
      errors.push({ field: 'config.slug', message: `hook '${config.slug}' is not active` });
    }
  }

  else if (actionType === 'internal_function') {
    if (!internalFunctionNames().includes(config.function_name)) {
      errors.push({ field: 'config.function_name', message: `'${config.function_name}' is not a registered internal function` });
    }
  }

  else if (actionType === 'http') {
    if (config.credential_id !== undefined && config.credential_id !== null && config.credential_id !== '') {
      const [[row]] = await db.query(
        `SELECT id FROM credentials WHERE id = ?`,
        [config.credential_id]
      );
      if (!row) {
        errors.push({ field: 'config.credential_id', message: `credential ${config.credential_id} does not exist` });
      }
    }
  }

  return { errors };
}


module.exports = {
  internalFunctionNames,
  validateSuppression,
  validateRule,
  validateAction,
  validateActionReferences,
  // sets exported for the meta service / tests
  MATCH_MODES,
  TRANSFORM_MODES,
  ACTION_TYPES,
};