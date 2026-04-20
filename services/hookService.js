/**
 * Hook Service — Core YisraHook Engine
 * services/hookService.js
 *
 * Orchestrates the full pipeline: authenticate → filter → transform → deliver.
 * Also provides CRUD helpers for hooks, targets, and credentials.
 *
 * v1.2 — Internal Automation Targets
 *   Targets can now be one of four types:
 *     • http               — fetch() to a URL (legacy behavior, default)
 *     • workflow           — start a workflow execution
 *     • sequence           — enroll a contact in a sequence
 *     • internal_function  — call a registered internal function
 *   All internal types still log to hook_delivery_logs using synthetic URLs
 *   (internal://workflow/N, internal://function/name, etc.) and share the
 *   same filter/transform/condition/retry pipeline as HTTP targets.
 *
 * Usage:
 *   const hookService = require('./hookService');
 *   await hookService.executeHook(db, 'calendly-new-lead', input);
 *   await hookService.executeHook(db, 'calendly-new-lead', input, { dryRun: true });
 */

const fetch = require('node-fetch');
const crypto = require('crypto');
const { evaluateConditions } = require('./hookFilter');
const { executeMapper, resolveBodyTemplate } = require('./hookMapper');
const { applyChain } = require('./hookTransforms');

// Lazy requires for the three delivery engines. These modules transitively
// require hookService in rare paths (e.g. an internal function that itself
// emits a webhook), so keep the require() calls inside the handlers.

// ─────────────────────────────────────────────────────────────
// HOOK LOOKUP
// ─────────────────────────────────────────────────────────────

/**
 * Look up a hook by slug, including its active targets (ordered by position).
 * `ht.*` pulls in target_type and config automatically — no query changes needed.
 */
async function getHookBySlug(db, slug) {
  const [[hook]] = await db.query(
    `SELECT * FROM hooks WHERE slug = ? AND active = 1 LIMIT 1`,
    [slug]
  );
  if (!hook) return null;

  const [targets] = await db.query(
    `SELECT ht.*, c.type AS cred_type, c.config AS cred_config, c.allowed_urls AS cred_allowed_urls
     FROM hook_targets ht
     LEFT JOIN credentials c ON ht.credential_id = c.id
     WHERE ht.hook_id = ? AND ht.active = 1
     ORDER BY ht.position ASC`,
    [hook.id]
  );

  hook.targets = targets;
  return hook;
}


// ─────────────────────────────────────────────────────────────
// AUTHENTICATION
// ─────────────────────────────────────────────────────────────

/**
 * Validate inbound request authentication.
 * @returns {{ valid: boolean, error?: string }}
 */
function authenticateRequest(hook, req) {
  const authType = hook.auth_type;
  const config = typeof hook.auth_config === 'string'
    ? JSON.parse(hook.auth_config) : hook.auth_config;

  if (authType === 'none') return { valid: true };

  if (authType === 'api_key') {
    const headerName = (config?.header || 'x-hook-key').toLowerCase();
    const expected = config?.key;
    const actual = req.headers[headerName];
    if (!expected || actual !== expected) {
      return { valid: false, error: 'Invalid or missing API key' };
    }
    return { valid: true };
  }

  if (authType === 'hmac') {
    const headerName = (config?.header || 'x-signature').toLowerCase();
    const secret = config?.secret;
    const algorithm = config?.algorithm || 'sha256';
    const signature = req.headers[headerName];
    if (!signature || !secret) {
      return { valid: false, error: 'Missing HMAC signature' };
    }
    // rawBody MUST be populated by middleware (see INTEGRATION_NOTES.md).
    // The JSON.stringify fallback is a safety net but will produce different
    // bytes than the original request if Express re-serializes — HMAC will
    // fail in that case, which is the safe/correct outcome.
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const expected = crypto.createHmac(algorithm, secret).update(rawBody).digest('hex');

    // Strip common prefixes: some providers send "sha256=abc123..." format
    const sigHex = signature.replace(/^(sha\d+=|v1=)/, '');

    // Length check first — timingSafeEqual throws on mismatched lengths
    const expectedBuf = Buffer.from(expected, 'hex');
    const signatureBuf = Buffer.from(sigHex, 'hex');
    if (expectedBuf.length !== signatureBuf.length) {
      return { valid: false, error: 'HMAC signature mismatch' };
    }

    const valid = crypto.timingSafeEqual(signatureBuf, expectedBuf);
    return valid ? { valid: true } : { valid: false, error: 'HMAC signature mismatch' };
  }

  return { valid: false, error: `Unknown auth type: ${authType}` };
}


// ─────────────────────────────────────────────────────────────
// FILTER EXECUTION
// ─────────────────────────────────────────────────────────────

/**
 * Run the hook-level filter.
 * @returns {{ passed: boolean, error?: string }}
 */
function runFilter(hook, input) {
  const mode = hook.filter_mode;
  if (mode === 'none') return { passed: true };

  const config = typeof hook.filter_config === 'string'
    ? JSON.parse(hook.filter_config) : hook.filter_config;

  if (mode === 'conditions') {
    try {
      const passed = evaluateConditions(config, input);
      return { passed };
    } catch (err) {
      return { passed: false, error: `Filter error: ${err.message}` };
    }
  }

  if (mode === 'code') {
    try {
      const fn = new Function('input', config?.code || config);
      const result = fn(input);
      return { passed: !!result };
    } catch (err) {
      return { passed: false, error: `Filter code error: ${err.message}` };
    }
  }

  return { passed: false, error: `Unknown filter mode: ${mode}` };
}


// ─────────────────────────────────────────────────────────────
// TRANSFORM EXECUTION
// ─────────────────────────────────────────────────────────────

/**
 * Run a transform (hook-level or target-level).
 * @param {string} mode          - 'passthrough', 'mapper', 'code'
 * @param {*}      config        - the transform config (rules array, code string, or object with .code)
 * @param {object} input         - data to transform
 * @returns {{ output: object, errors: string[] }}
 */
function runTransform(mode, config, input) {
  if (mode === 'passthrough' || !mode) {
    return { output: input, errors: [] };
  }

  // Parse config if stored as JSON string
  const parsed = typeof config === 'string' ? JSON.parse(config) : config;

  if (mode === 'mapper') {
    const rules = Array.isArray(parsed) ? parsed : (parsed?.rules || []);
    return executeMapper(rules, input);
  }

  if (mode === 'code') {
    try {
      const code = typeof parsed === 'string' ? parsed : parsed?.code;
      const fn = new Function('input', code);
      const output = fn(input);
      return { output: output ?? {}, errors: [] };
    } catch (err) {
      return { output: {}, errors: [`Transform code error: ${err.message}`] };
    }
  }

  return { output: input, errors: [`Unknown transform mode: ${mode}`] };
}


// ─────────────────────────────────────────────────────────────
// CREDENTIAL INJECTION
// ─────────────────────────────────────────────────────────────

/**
 * Build auth headers for a delivery target.
 * Validates that the target URL matches the credential's allowed_urls.
 * Only used by HTTP targets.
 */
function buildAuthHeaders(target) {
  if (!target.credential_id) return {};

  const credType = target.cred_type;
  const credConfig = typeof target.cred_config === 'string'
    ? JSON.parse(target.cred_config) : target.cred_config;
  const allowedUrls = typeof target.cred_allowed_urls === 'string'
    ? JSON.parse(target.cred_allowed_urls) : target.cred_allowed_urls;

  // Validate URL scope (skip for internal — always allowed for own server)
  if (credType !== 'internal' && Array.isArray(allowedUrls) && allowedUrls.length) {
    const matches = allowedUrls.some((pattern) => {
      // Simple wildcard matching: "https://api.example.com/*"
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return regex.test(target.url);
    });
    if (!matches) {
      console.warn(`[hook] Credential ${target.credential_id} not allowed for URL ${target.url}`);
      return {};
    }
  }

  if (credType === 'internal') {
    return { 'x-api-key': process.env.INTERNAL_API_KEY };
  }

  if (credType === 'bearer') {
    return { 'Authorization': `Bearer ${credConfig?.token}` };
  }

  if (credType === 'api_key') {
    const header = credConfig?.header || 'x-api-key';
    return { [header]: credConfig?.key };
  }

  if (credType === 'basic') {
    const b64 = Buffer.from(`${credConfig?.username}:${credConfig?.password}`).toString('base64');
    return { 'Authorization': `Basic ${b64}` };
  }

  return {};
}


// ─────────────────────────────────────────────────────────────
// HELPERS FOR INTERNAL TARGETS
// ─────────────────────────────────────────────────────────────

/**
 * Parse the target.config JSON column into an object.
 * Returns {} (not null) so downstream code can safely read properties.
 */
function parseTargetConfig(target) {
  if (target.config == null) return {};
  if (typeof target.config === 'object') return target.config;
  try {
    return JSON.parse(target.config) || {};
  } catch (err) {
    return {};
  }
}

/**
 * Resolve a dot-path against an object. Returns undefined for any missing
 * segment or null traversal. Top-level (no dot) is a plain property lookup.
 *
 *   getByPath({contact: {id: 123}}, 'contact.id')     // → 123
 *   getByPath({contact: {id: 123}}, 'contact')        // → {id: 123}
 *   getByPath({contact: {id: 123}}, 'contact.missing') // → undefined
 *   getByPath(null, 'anything')                       // → undefined
 *
 * Consistent with how hookMapper resolves `from` paths and `{{template}}`
 * expressions — the whole pipeline uses dot-paths, so params_mapping does too.
 */
function getByPath(obj, path) {
  if (obj == null || typeof path !== 'string' || path.length === 0) return undefined;
  if (!path.includes('.')) return obj[path];
  return path.split('.').reduce((cur, p) => (cur == null ? undefined : cur[p]), obj);
}

/**
 * Resolve a params_mapping into actual param values.
 *
 * Mapping rules:
 *   • String wrapped in single quotes: literal value (quotes stripped)
 *       "log_type": "'SMS'"          → params.log_type = "SMS"
 *   • Plain string: dot-path lookup on targetOutput
 *       "contact_id": "contact_id"    → targetOutput.contact_id
 *       "contact_id": "contact.id"    → targetOutput.contact.id
 *       "contact_obj": "contact"      → targetOutput.contact  (whole object)
 *   • Any non-string value: passed through as-is (number, bool, null, object)
 *       "enabled": true              → params.enabled = true
 *       "timeout_ms": 5000           → params.timeout_ms = 5000
 *
 * Array-index syntax ("items[0].name") is NOT supported — use a transform
 * rule or a code transform to pull array elements into flat fields first.
 */
function resolveParamsMapping(paramsMapping, targetOutput) {
  const params = {};
  for (const [paramName, source] of Object.entries(paramsMapping || {})) {
    if (typeof source === 'string' && source.length >= 2
        && source.startsWith("'") && source.endsWith("'")) {
      // Literal — strip surrounding single quotes
      params[paramName] = source.slice(1, -1);
    } else if (typeof source === 'string') {
      // Dot-path lookup on targetOutput
      params[paramName] = getByPath(targetOutput, source);
    } else {
      // Non-string: use as-is (number, bool, object, null)
      params[paramName] = source;
    }
  }
  return params;
}


// ─────────────────────────────────────────────────────────────
// DELIVERY — HTTP (the original behavior)
// ─────────────────────────────────────────────────────────────

async function deliverHttp(target, targetOutput) {
  // Build request body
  let requestBody;
  if (target.body_mode === 'template' && target.body_template) {
    requestBody = resolveBodyTemplate(target.body_template, targetOutput);
  } else {
    requestBody = JSON.stringify(targetOutput);
  }

  // Build headers
  const staticHeaders = typeof target.headers === 'string'
    ? JSON.parse(target.headers) : (target.headers || {});
  const authHeaders = buildAuthHeaders(target);

  const headers = {
    'Content-Type': 'application/json',
    ...staticHeaders,
    ...authHeaders,
  };

  const fetchOptions = {
    method: target.method || 'POST',
    headers,
    timeout: 30000,
  };

  // GET/DELETE don't typically have bodies
  if (!['GET', 'DELETE'].includes(target.method)) {
    fetchOptions.body = requestBody;
  }

  const logData = {
    target_id: target.id,
    request_url: target.url,
    request_method: target.method || 'POST',
    request_body: requestBody,
  };

  try {
    const response = await fetch(target.url, fetchOptions);
    const responseText = await response.text();

    logData.response_status = response.status;
    logData.response_body = responseText.slice(0, 10000); // Truncate large responses
    logData.status = response.ok ? 'success' : 'failed';
    if (!response.ok) {
      logData.error = `HTTP ${response.status}`;
    }
  } catch (err) {
    logData.response_status = null;
    logData.response_body = null;
    logData.status = 'failed';
    logData.error = err.message;
  }

  return logData;
}


// ─────────────────────────────────────────────────────────────
// DELIVERY — WORKFLOW
// ─────────────────────────────────────────────────────────────

/**
 * Start a workflow execution. Transform output becomes both init_data and
 * the initial variables. Advance is fire-and-forget — hook delivery doesn't
 * wait for the workflow to complete. Mirrors apptService.createAppt step 7.
 */
async function deliverWorkflow(target, targetConfig, targetOutput, db) {
  const workflowId = targetConfig.workflow_id;
  const initData = targetOutput;

  const logData = {
    target_id: target.id,
    request_url: `internal://workflow/${workflowId != null ? workflowId : '?'}`,
    request_method: 'INTERNAL',
    request_body: JSON.stringify(initData),
  };

  if (workflowId == null) {
    logData.response_status = 500;
    logData.response_body = null;
    logData.status = 'failed';
    logData.error = 'workflow target missing config.workflow_id';
    return logData;
  }

  try {
    const { advanceWorkflow } = require('../lib/workflow_engine');

    const [result] = await db.query(
      `INSERT INTO workflow_executions
       (workflow_id, status, init_data, variables, current_step_number)
       VALUES (?, 'active', ?, ?, 1)`,
      [workflowId, JSON.stringify(initData), JSON.stringify(initData)]
    );
    const executionId = result.insertId;

    // Non-blocking advance — mirrors apptService.createAppt pattern.
    // A background failure here does NOT cause the hook delivery to retry;
    // the execution row itself will be marked 'failed' by markExecutionCompleted.
    advanceWorkflow(executionId, db)
      .then((r) => console.log(`[HOOK→WF] execution ${executionId}: ${r?.status || 'unknown'}`))
      .catch((err) => console.error(`[HOOK→WF] execution ${executionId} failed:`, err.message));

    logData.request_url = `internal://workflow/${workflowId}/execution/${executionId}`;
    logData.response_status = 200;
    logData.response_body = JSON.stringify({ executionId, workflowId, status: 'started' });
    logData.status = 'success';
    return logData;
  } catch (err) {
    logData.response_status = 500;
    logData.response_body = null;
    logData.status = 'failed';
    logData.error = `workflow delivery failed: ${err.message}`;
    return logData;
  }
}


// ─────────────────────────────────────────────────────────────
// DELIVERY — SEQUENCE
// ─────────────────────────────────────────────────────────────

/**
 * Enroll a contact in a sequence. Synchronous — enrollContact* just inserts
 * the enrollment row and schedules the first step job.
 *
 * Two modes, determined by targetConfig:
 *   - template_id set → enrollContactByTemplateId (direct), no cascade filters
 *   - template_type set → enrollContact (cascade), honors appt_type/appt_with filters
 *
 * contact_id_field and trigger_data_fields entries support dot-paths — e.g.
 * "body.contactId" on a passthrough hook — so users don't need a mapper just
 * to flatten the shape. Consistent with how internal_function params_mapping
 * resolves sources.
 */
async function deliverSequence(target, targetConfig, targetOutput, db) {
  const templateId = targetConfig.template_id;
  const templateType = targetConfig.template_type;
  const contactIdField = targetConfig.contact_id_field || 'contact_id';
  const triggerDataFields = Array.isArray(targetConfig.trigger_data_fields)
    ? targetConfig.trigger_data_fields : [];

  // Dot-path aware — handles both flat keys ("contactId") and nested paths
  // ("body.contactId"), matching how hookMapper and resolveParamsMapping work.
  const contactId = targetOutput == null ? undefined : getByPath(targetOutput, contactIdField);

  // Build trigger_data from specified fields. Each field is resolved via
  // getByPath and stored under the last path segment — so "body.appt_id"
  // becomes triggerData.appt_id, which is what sequenceEngine expects.
  const triggerData = {};
  for (const field of triggerDataFields) {
    const val = targetOutput == null ? undefined : getByPath(targetOutput, field);
    if (val !== undefined) {
      const key = field.includes('.') ? field.split('.').pop() : field;
      triggerData[key] = val;
    }
  }

  // Determine mode. Validation (api.hooks validateTargetPayload) already
  // rejects "both set" at save time, so at delivery time at most one is live.
  const useById = templateId !== undefined && templateId !== null && templateId !== '';

  let callPayload;
  let requestUrl;
  if (useById) {
    callPayload = {
      contact_id: contactId,
      template_id: templateId,
      trigger_data: triggerData,
    };
    requestUrl = `internal://sequence/id/${templateId}`;
  } else {
    callPayload = {
      contact_id: contactId,
      template_type: templateType,
      trigger_data: triggerData,
      appt_type: targetConfig.appt_type_filter || null,
      appt_with: targetConfig.appt_with_filter || null,
    };
    requestUrl = `internal://sequence/${templateType || '?'}`;
  }

  const logData = {
    target_id: target.id,
    request_url: requestUrl,
    request_method: 'INTERNAL',
    request_body: JSON.stringify(callPayload),
  };

  if (!useById && !templateType) {
    logData.response_status = 500;
    logData.response_body = null;
    logData.status = 'failed';
    logData.error = 'sequence target missing config.template_type or config.template_id';
    return logData;
  }

  if (contactId == null || contactId === '') {
    logData.response_status = 500;
    logData.response_body = null;
    logData.status = 'failed';
    logData.error = `sequence target: missing contact_id from transform field "${contactIdField}"`;
    return logData;
  }

  try {
    const sequenceEngine = require('../lib/sequenceEngine');
    let result;
    if (useById) {
      const idInt = parseInt(templateId, 10);
      if (!Number.isInteger(idInt) || idInt <= 0) {
        throw new Error(`config.template_id must be a positive integer (got ${templateId})`);
      }
      result = await sequenceEngine.enrollContactByTemplateId(
        db,
        contactId,
        idInt,
        triggerData
      );
    } else {
      result = await sequenceEngine.enrollContact(
        db,
        contactId,
        templateType,
        triggerData,
        { appt_type: callPayload.appt_type, appt_with: callPayload.appt_with }
      );
    }

    logData.response_status = 200;
    logData.response_body = JSON.stringify(result);
    logData.status = 'success';
    return logData;
  } catch (err) {
    logData.response_status = 500;
    logData.response_body = null;
    logData.status = 'failed';
    logData.error = `sequence delivery failed: ${err.message}`;
    return logData;
  }
}


// ─────────────────────────────────────────────────────────────
// DELIVERY — INTERNAL FUNCTION
// ─────────────────────────────────────────────────────────────

/**
 * Call a registered internal function directly. Synchronous — await the
 * function and capture its return value as the delivery response.
 */
async function deliverInternalFunction(target, targetConfig, targetOutput, db) {
  const functionName = targetConfig.function_name;
  const paramsMapping = targetConfig.params_mapping || {};

  const logData = {
    target_id: target.id,
    request_url: `internal://function/${functionName || '?'}`,
    request_method: 'INTERNAL',
    request_body: null,
  };

  if (!functionName) {
    logData.request_body = JSON.stringify(targetOutput);
    logData.response_status = 500;
    logData.response_body = null;
    logData.status = 'failed';
    logData.error = 'internal_function target missing config.function_name';
    return logData;
  }

  // Resolve params_mapping against targetOutput
  const params = resolveParamsMapping(paramsMapping, targetOutput);
  logData.request_body = JSON.stringify(params);

  try {
    const internalFunctions = require('../lib/internal_functions');
    const fn = internalFunctions[functionName];
    if (typeof fn !== 'function') {
      logData.response_status = 500;
      logData.response_body = null;
      logData.status = 'failed';
      logData.error = `Unknown internal function: ${functionName}`;
      return logData;
    }

    const result = await fn(params, db);

    logData.response_status = 200;
    logData.response_body = JSON.stringify(result).slice(0, 10000);
    logData.status = 'success';
    return logData;
  } catch (err) {
    logData.response_status = 500;
    logData.response_body = null;
    logData.status = 'failed';
    logData.error = `internal_function delivery failed: ${err.message}`;
    return logData;
  }
}


// ─────────────────────────────────────────────────────────────
// DELIVERY — DISPATCHER
// ─────────────────────────────────────────────────────────────

/**
 * Deliver to a single target. Returns the delivery log data.
 *
 * Routes on target.target_type:
 *   • http (default)      → HTTP fetch
 *   • workflow            → start a workflow execution
 *   • sequence            → enroll a contact in a sequence
 *   • internal_function   → call a registered internal function
 *
 * @param {object} target                 - hook_targets row (with joined cred_* fields)
 * @param {object} hookTransformOutput    - output of the hook-level transform
 * @param {object} db                     - DB pool / req.db (required for internal targets)
 */
async function deliverToTarget(target, hookTransformOutput, db) {
  // Target-level transform applies to ALL target types — refines the data
  // before it's shaped for the specific delivery mechanism.
  const { output: targetOutput } = runTransform(
    target.transform_mode,
    target.transform_config,
    hookTransformOutput
  );

  const targetType = target.target_type || 'http';

  if (targetType === 'http') {
    return deliverHttp(target, targetOutput);
  }

  const targetConfig = parseTargetConfig(target);

  if (targetType === 'workflow') {
    return deliverWorkflow(target, targetConfig, targetOutput, db);
  }

  if (targetType === 'sequence') {
    return deliverSequence(target, targetConfig, targetOutput, db);
  }

  if (targetType === 'internal_function') {
    return deliverInternalFunction(target, targetConfig, targetOutput, db);
  }

  // Unknown type — fail explicitly so the operator sees it in the logs
  return {
    target_id: target.id,
    request_url: `unknown://${targetType}`,
    request_method: 'UNKNOWN',
    request_body: JSON.stringify(targetOutput),
    response_status: 500,
    response_body: null,
    status: 'failed',
    error: `Unknown target_type: ${targetType}`,
  };
}


// ─────────────────────────────────────────────────────────────
// DRY-RUN PREVIEW
// ─────────────────────────────────────────────────────────────

/**
 * Build a non-executing preview of what a target WOULD do.
 * Returned under `would_send` in the dry-run target result.
 * Handles all four target types.
 */
function buildDryRunPreview(target, hookTransformOutput) {
  const { output: targetOutput } = runTransform(
    target.transform_mode, target.transform_config, hookTransformOutput
  );
  const targetType = target.target_type || 'http';
  const targetConfig = parseTargetConfig(target);

  if (targetType === 'http') {
    let previewBody;
    if (target.body_mode === 'template' && target.body_template) {
      previewBody = resolveBodyTemplate(target.body_template, targetOutput);
    } else {
      previewBody = targetOutput;
    }
    return {
      target_type: 'http',
      transform_output: targetOutput,
      would_send: {
        method: target.method || 'POST',
        url: target.url,
        headers: {
          'Content-Type': 'application/json',
          ...(typeof target.headers === 'string' ? JSON.parse(target.headers) : (target.headers || {})),
          ...(target.credential_id
            ? { '(auth)': `credential #${target.credential_id} (${target.cred_type})` }
            : {}),
        },
        body: previewBody,
      },
    };
  }

  if (targetType === 'workflow') {
    const workflowId = targetConfig.workflow_id;
    return {
      target_type: 'workflow',
      transform_output: targetOutput,
      would_send: {
        method: 'INTERNAL',
        url: `internal://workflow/${workflowId != null ? workflowId : '?'}`,
        action: 'start_workflow',
        workflow_id: workflowId != null ? workflowId : null,
        init_data: targetOutput,
      },
    };
  }
  if (targetType === 'sequence') {
    const contactIdField = targetConfig.contact_id_field || 'contact_id';
    const contactId = targetOutput == null ? undefined : getByPath(targetOutput, contactIdField);
    const triggerData = {};
    for (const field of (targetConfig.trigger_data_fields || [])) {
      const val = targetOutput == null ? undefined : getByPath(targetOutput, field);
      if (val !== undefined) {
        const key = field.includes('.') ? field.split('.').pop() : field;
        triggerData[key] = val;
      }
    }

    const templateId = targetConfig.template_id;
    const useById = templateId !== undefined && templateId !== null && templateId !== '';

    if (useById) {
      return {
        target_type: 'sequence',
        transform_output: targetOutput,
        would_send: {
          method: 'INTERNAL',
          url: `internal://sequence/id/${templateId}`,
          action: 'enroll_contact_by_id',
          contact_id: contactId == null ? null : contactId,
          contact_id_field: contactIdField,
          template_id: templateId,
          trigger_data: triggerData,
        },
      };
    }

    return {
      target_type: 'sequence',
      transform_output: targetOutput,
      would_send: {
        method: 'INTERNAL',
        url: `internal://sequence/${targetConfig.template_type || '?'}`,
        action: 'enroll_contact',
        contact_id: contactId == null ? null : contactId,
        contact_id_field: contactIdField,
        template_type: targetConfig.template_type || null,
        trigger_data: triggerData,
        appt_type: targetConfig.appt_type_filter || null,
        appt_with: targetConfig.appt_with_filter || null,
      },
    };
  }

  if (targetType === 'internal_function') {
    const params = resolveParamsMapping(targetConfig.params_mapping || {}, targetOutput);
    return {
      target_type: 'internal_function',
      transform_output: targetOutput,
      would_send: {
        method: 'INTERNAL',
        url: `internal://function/${targetConfig.function_name || '?'}`,
        action: 'call_function',
        function_name: targetConfig.function_name || null,
        params,
      },
    };
  }

  return {
    target_type: targetType,
    transform_output: targetOutput,
    would_send: { error: `Unknown target_type: ${targetType}` },
  };
}


// ─────────────────────────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────────────────────────

/**
 * Execute a hook's full pipeline.
 *
 * @param {object} db
 * @param {string} slug
 * @param {object} input    - unified event shape { body, headers, query, method, meta }
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] - if true, skip delivery and return preview
 * @param {object}  [opts.hook=null]    - pre-loaded hook object (skips DB lookup if provided)
 * @returns {object} execution result
 */
async function executeHook(db, slug, input, { dryRun = false, hook: preloaded = null } = {}) {
  // 1. Look up hook (skip if caller already loaded it, e.g. the receiver route)
  const hook = preloaded || await getHookBySlug(db, slug);
  if (!hook) {
    return { status: 'not_found', error: `No active hook with slug: ${slug}` };
  }

  // ────────────────────────────────────────────────────────────
  // CAPTURE MODE INTERCEPT (slice 2.2)
  // If capture_mode === 'capturing', store the raw input as a sample,
  // atomically flip the mode off, and halt the pipeline. No filter/
  // transform/delivery runs for the captured event.
  //
  // The guarded UPDATE (WHERE capture_mode='capturing') is the race-free
  // primitive. If two events arrive within the same poll window, only one
  // wins; the other falls through to the normal pipeline.
  //
  // Dry-run never triggers capture — the !dryRun guard enforces that.
  // ────────────────────────────────────────────────────────────
  if (!dryRun && hook.capture_mode === 'capturing') {
    const rawInputStrForCapture = JSON.stringify(input);
    const captureTruncated = rawInputStrForCapture.length > 512 * 1024;
    const storedSample = captureTruncated
      ? rawInputStrForCapture.slice(0, 512 * 1024)
      : rawInputStrForCapture;

    const [upd] = await db.query(
      `UPDATE hooks
         SET captured_sample = ?,
             captured_at     = NOW(),
             capture_mode    = 'off'
       WHERE id = ? AND capture_mode = 'capturing'`,
      [storedSample, hook.id]
    );

    if (upd.affectedRows > 0) {
      // Won the race — record the captured execution and halt the pipeline.
      const [execResult] = await db.query(
        `INSERT INTO hook_executions
           (hook_id, slug, raw_input, filter_passed, status)
         VALUES (?, ?, ?, NULL, 'captured')`,
        [hook.id, hook.slug, storedSample]
      );

      return {
        status: 'captured',
        execution_id: execResult.insertId,
        truncated: captureTruncated,
      };
    }
    // Lost the race (extremely narrow window) — fall through to the normal
    // pipeline below. We deliberately do NOT insert a 'received' execution
    // row here because the normal pipeline at step 2 will insert its own;
    // double-inserting would produce two hook_executions rows per event.
  }

  // Guard against oversized payloads (512 KB limit)
  const rawInputStr = JSON.stringify(input);
  const inputTruncated = rawInputStr.length > 512 * 1024;
  const storedInput = inputTruncated ? rawInputStr.slice(0, 512 * 1024) : rawInputStr;

  // 2. Insert execution row (skip for dry run)
  let executionId = null;
  if (!dryRun) {
    const [execResult] = await db.query(
      `INSERT INTO hook_executions (hook_id, slug, raw_input, status, error) VALUES (?, ?, ?, 'received', ?)`,
      [hook.id, slug, storedInput, inputTruncated ? 'raw_input truncated (>512KB)' : null]
    );
    executionId = execResult.insertId;
  }

  // 3. Filter
  const filterResult = runFilter(hook, input);

  if (!filterResult.passed) {
    if (!dryRun && executionId) {
      await db.query(
        `UPDATE hook_executions SET filter_passed = 0, status = 'filtered', error = ? WHERE id = ?`,
        [filterResult.error || null, executionId]
      );
    }
    return {
      status: 'filtered',
      executionId,
      filter: filterResult,
    };
  }

  // 4. Transform
  const transformResult = runTransform(hook.transform_mode, hook.transform_config, input);

  if (!dryRun && executionId) {
    await db.query(
      `UPDATE hook_executions SET filter_passed = 1, transform_output = ?, status = 'processing' WHERE id = ?`,
      [JSON.stringify(transformResult.output), executionId]
    );
  }

  // 5. Deliver to each matching target
  const targetResults = [];
  let successCount = 0;
  let failCount = 0;

  for (const target of hook.targets) {
    // Evaluate target-level conditions (against transform output, not raw input).
    // Applies equally to all target types.
    const targetConditions = typeof target.conditions === 'string'
      ? JSON.parse(target.conditions) : target.conditions;
    const conditionsPassed = evaluateConditions(targetConditions, transformResult.output);

    if (!conditionsPassed) {
      targetResults.push({
        target_id: target.id,
        name: target.name,
        target_type: target.target_type || 'http',
        conditions_passed: false,
        skip_reason: 'condition not met',
      });
      continue;
    }

    if (dryRun) {
      const preview = buildDryRunPreview(target, transformResult.output);
      targetResults.push({
        target_id: target.id,
        name: target.name,
        conditions_passed: true,
        ...preview,
      });
      continue;
    }

    // Live delivery — pass db so internal targets can reach their engines
    const deliveryLog = await deliverToTarget(target, transformResult.output, db);

    // Log the delivery
    await db.query(
      `INSERT INTO hook_delivery_logs
        (execution_id, target_id, request_url, request_method, request_body,
         response_status, response_body, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        executionId,
        deliveryLog.target_id,
        deliveryLog.request_url,
        deliveryLog.request_method,
        deliveryLog.request_body,
        deliveryLog.response_status,
        deliveryLog.response_body,
        deliveryLog.status,
        deliveryLog.error || null,
      ]
    );

    if (deliveryLog.status === 'success') {
      successCount++;
    } else {
      failCount++;
      // Queue retry job (applies to all target types, including internal)
      await queueRetryJob(db, executionId, target.id);
    }

    targetResults.push({
      target_id: target.id,
      name: target.name,
      target_type: target.target_type || 'http',
      conditions_passed: true,
      delivery: deliveryLog,
    });
  }

  // 6. Update execution status
  let finalStatus;
  if (dryRun) {
    finalStatus = 'dry_run';
  } else {
    const activeTargetCount = targetResults.filter((t) => t.conditions_passed).length;
    // Status semantics:
    //   delivered — all active targets succeeded (or no targets matched conditions,
    //               meaning the pipeline itself completed successfully)
    //   partial   — some targets succeeded, some failed (retries queued)
    //   failed    — all active targets failed
    if (activeTargetCount === 0) finalStatus = 'delivered';
    else if (failCount === 0) finalStatus = 'delivered';
    else if (successCount === 0) finalStatus = 'failed';
    else finalStatus = 'partial';

    if (executionId) {
      const allErrors = [
        ...transformResult.errors,
        ...targetResults.filter((t) => t.delivery?.error).map((t) => `${t.name}: ${t.delivery.error}`),
      ].join('; ');

      await db.query(
        `UPDATE hook_executions SET status = ?, error = ? WHERE id = ?`,
        [finalStatus, allErrors || null, executionId]
      );
    }
  }

  return {
    status: finalStatus,
    executionId,
    filter: filterResult,
    transform: { output: transformResult.output, errors: transformResult.errors },
    targets: targetResults,
  };
}


// ─────────────────────────────────────────────────────────────
// RETRY JOB
// ─────────────────────────────────────────────────────────────

/**
 * Queue a retry job for a failed delivery.
 */
async function queueRetryJob(db, executionId, targetId) {
  try {
    await db.query(
      `INSERT INTO scheduled_jobs (type, scheduled_time, status, name, data, max_attempts, backoff_seconds)
       VALUES ('hook_retry', DATE_ADD(NOW(), INTERVAL 60 SECOND), 'pending', ?, ?, 3, 120)`,
      [
        `Hook retry: exec ${executionId} → target ${targetId}`,
        JSON.stringify({ execution_id: executionId, target_id: targetId }),
      ]
    );
  } catch (err) {
    console.error(`[hook] Failed to queue retry job: ${err.message}`);
  }
}

/**
 * Execute a retry delivery (called by process_jobs.js).
 *
 * NOTE on retry semantics for internal targets:
 *   • workflow  — INSERT failure retries cleanly. Async advance failures do
 *                 NOT trigger hook retries (we already returned success); the
 *                 workflow_executions row gets marked 'failed' instead.
 *   • sequence  — enrollContact is guarded against duplicate active enrollments,
 *                 so retries on a previously-successful enrollment will throw
 *                 "already enrolled" (captured as failure, bounded by max_attempts).
 *   • internal_function — NOT inherently idempotent. Functions with side effects
 *                 (create_task, send_sms) will be invoked again on retry.
 *                 Design internal-function hooks to be safe-to-retry, or accept
 *                 that transient failures may cause duplicate actions.
 */
async function executeRetry(db, { execution_id, target_id }) {
  // Fetch execution and target
  const [[execution]] = await db.query(
    `SELECT * FROM hook_executions WHERE id = ?`,
    [execution_id]
  );
  if (!execution) {
    console.error(`[hook] Retry: execution ${execution_id} not found`);
    return;
  }

  const [[target]] = await db.query(
    `SELECT ht.*, c.type AS cred_type, c.config AS cred_config, c.allowed_urls AS cred_allowed_urls
     FROM hook_targets ht
     LEFT JOIN credentials c ON ht.credential_id = c.id
     WHERE ht.id = ?`,
    [target_id]
  );
  if (!target) {
    console.error(`[hook] Retry: target ${target_id} not found`);
    return;
  }

  const transformOutput = typeof execution.transform_output === 'string'
    ? JSON.parse(execution.transform_output) : execution.transform_output;

  // Pass db so internal targets can route correctly
  const deliveryLog = await deliverToTarget(target, transformOutput, db);

  // Update existing delivery log (increment attempts) or insert new
  const [existing] = await db.query(
    `SELECT id, attempts FROM hook_delivery_logs WHERE execution_id = ? AND target_id = ? ORDER BY id DESC LIMIT 1`,
    [execution_id, target_id]
  );

  if (existing.length) {
    await db.query(
      `UPDATE hook_delivery_logs
       SET response_status = ?, response_body = ?, status = ?, error = ?, attempts = attempts + 1
       WHERE id = ?`,
      [deliveryLog.response_status, deliveryLog.response_body, deliveryLog.status, deliveryLog.error, existing[0].id]
    );
  } else {
    await db.query(
      `INSERT INTO hook_delivery_logs
        (execution_id, target_id, request_url, request_method, request_body,
         response_status, response_body, status, error, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2)`,
      [execution_id, target_id, deliveryLog.request_url, deliveryLog.request_method,
       deliveryLog.request_body, deliveryLog.response_status, deliveryLog.response_body,
       deliveryLog.status, deliveryLog.error]
    );
  }

  // If this delivery succeeded and execution was partial/failed, re-check
  if (deliveryLog.status === 'success') {
    const [allLogs] = await db.query(
      `SELECT status FROM hook_delivery_logs WHERE execution_id = ?`,
      [execution_id]
    );
    const anyFailed = allLogs.some((l) => l.status === 'failed');
    const newStatus = anyFailed ? 'partial' : 'delivered';
    await db.query(
      `UPDATE hook_executions SET status = ? WHERE id = ? AND status IN ('failed','partial')`,
      [newStatus, execution_id]
    );
  }
}


// ─────────────────────────────────────────────────────────────
// CRUD HELPERS
// ─────────────────────────────────────────────────────────────

// -- Hooks --

async function listHooks(db) {
  const [rows] = await db.query(
    `SELECT h.*, COUNT(ht.id) AS target_count, u.user_name AS modified_by_name
     FROM hooks h
     LEFT JOIN hook_targets ht ON ht.hook_id = h.id AND ht.active = 1
     LEFT JOIN users u ON h.last_modified_by = u.user
     GROUP BY h.id
     ORDER BY h.name ASC`
  );
  return rows;
}

async function getHookById(db, id) {
  const [[hook]] = await db.query(
    `SELECT h.*, u.user_name AS modified_by_name
     FROM hooks h
     LEFT JOIN users u ON h.last_modified_by = u.user
     WHERE h.id = ?`,
    [id]
  );
  if (!hook) return null;

  const [targets] = await db.query(
    `SELECT ht.*, c.name AS cred_name, c.type AS cred_type
     FROM hook_targets ht
     LEFT JOIN credentials c ON ht.credential_id = c.id
     WHERE ht.hook_id = ?
     ORDER BY ht.position ASC`,
    [id]
  );
  hook.targets = targets;
  return hook;
}

async function createHook(db, data) {
  // Auto-generate slug if not provided
  if (!data.slug) {
    data.slug = require('crypto').randomUUID().slice(0, 8);
  }
  const [result] = await db.query(`INSERT INTO hooks SET ?`, [data]);
  return result.insertId;
}

async function updateHook(db, id, data) {
  // Auto-increment version on every update
  await db.query(`UPDATE hooks SET ?, version = version + 1 WHERE id = ?`, [data, id]);
}

async function deleteHook(db, id) {
  await db.query(`DELETE FROM hooks WHERE id = ?`, [id]);
}

// -- Targets --

async function createTarget(db, hookId, data) {
  data.hook_id = hookId;
  const [result] = await db.query(`INSERT INTO hook_targets SET ?`, [data]);
  return result.insertId;
}

async function updateTarget(db, targetId, data) {
  await db.query(`UPDATE hook_targets SET ? WHERE id = ?`, [data, targetId]);
}

async function deleteTarget(db, targetId) {
  await db.query(`DELETE FROM hook_targets WHERE id = ?`, [targetId]);
}

// -- Credentials --

async function listCredentials(db) {
  const [rows] = await db.query(
    `SELECT id, name, type, allowed_urls, created_at, updated_at FROM credentials ORDER BY name ASC`
  );
  // Never return config (contains secrets)
  return rows;
}

async function getCredentialById(db, id) {
  const [[row]] = await db.query(`SELECT * FROM credentials WHERE id = ?`, [id]);
  return row || null;
}

async function createCredential(db, data) {
  const [result] = await db.query(`INSERT INTO credentials SET ?`, [data]);
  return result.insertId;
}

async function updateCredential(db, id, data) {
  await db.query(`UPDATE credentials SET ? WHERE id = ?`, [data, id]);
}

async function deleteCredential(db, id) {
  await db.query(`DELETE FROM credentials WHERE id = ?`, [id]);
}

// -- Executions --

async function listExecutions(db, hookId, { limit = 50, offset = 0 } = {}) {
  const [rows] = await db.query(
    `SELECT he.*,
            (SELECT COUNT(*) FROM hook_delivery_logs hdl WHERE hdl.execution_id = he.id) AS delivery_count
     FROM hook_executions he
     WHERE he.hook_id = ?
     ORDER BY he.created_at DESC
     LIMIT ? OFFSET ?`,
    [hookId, parseInt(limit), parseInt(offset)]
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM hook_executions WHERE hook_id = ?`,
    [hookId]
  );

  return { executions: rows, total };
}

async function getExecution(db, executionId) {
  const [[execution]] = await db.query(
    `SELECT * FROM hook_executions WHERE id = ?`,
    [executionId]
  );
  if (!execution) return null;

  const [deliveryLogs] = await db.query(
    `SELECT hdl.*, ht.name AS target_name, ht.target_type AS target_type
     FROM hook_delivery_logs hdl
     LEFT JOIN hook_targets ht ON hdl.target_id = ht.id
     WHERE hdl.execution_id = ?
     ORDER BY hdl.created_at ASC`,
    [executionId]
  );

  execution.delivery_logs = deliveryLogs;
  return execution;
}


module.exports = {
  // Pipeline
  executeHook,
  executeRetry,
  authenticateRequest,
  // CRUD — Hooks
  listHooks,
  getHookById,
  getHookBySlug,
  createHook,
  updateHook,
  deleteHook,
  // CRUD — Targets
  createTarget,
  updateTarget,
  deleteTarget,
  // CRUD — Credentials
  listCredentials,
  getCredentialById,
  createCredential,
  updateCredential,
  deleteCredential,
  // CRUD — Executions
  listExecutions,
  getExecution,
  // Internals (exported for testing)
  runFilter,
  runTransform,
  buildAuthHeaders,
  buildDryRunPreview,
  parseTargetConfig,
  resolveParamsMapping,
  getByPath,
  deliverHttp,
  deliverWorkflow,
  deliverSequence,
  deliverInternalFunction,
};