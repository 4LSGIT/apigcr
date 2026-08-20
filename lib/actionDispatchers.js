// lib/actionDispatchers.js
//
// Shared action dispatchers — extracted verbatim from services/hookService.js
// (Slice 2.2). The four per-target delivery functions used to live as
// module-private functions in hookService; they now live here so that the
// email-ingest pipeline (Slice 2.3+) can fire the same action types without
// duplicating the logic.
//
// CONSERVATIVE EXTRACTION CONTRACT
// --------------------------------
// These bodies are copied from hookService with the MINIMUM changes required
// to stand alone:
//   - helpers that were hookService-private (parseTargetConfig,
//     resolveParamsMapping, getByPath, buildAuthHeaders, runTransform) and the
//     hookMapper/credentialInjection requires are now required/defined here.
//   - NO behavior change. Same return shape (a `logData`-style object), same
//     "never throw — catch internally and return {status:'failed', error}"
//     semantics, same synthetic internal:// URLs, same truncation limits.
//
// IMPORTANT — the dispatchers consume more than a `config` blob. The HTTP
// dispatcher in particular reads target.url / target.method / target.headers /
// target.body_mode / target.body_template / target.credential_id directly off
// the hook_targets row. To keep the extraction faithful WITHOUT inventing a
// new normalized shape (that would be an "improvement", out of scope here),
// the public dispatch() contract carries the original row through
// `context.target`. See the dispatch() JSDoc.
//
// Slice 2.3 will pass a synthesized `target`-shaped object built from an
// email_ingest_rule_actions row; that's deferred and not this module's concern.

const { resolveBodyTemplate } = require('../services/hookMapper');
const credentialInjection = require('./credentialInjection');

// ─────────────────────────────────────────────────────────────
// LOCAL HELPERS (extracted verbatim from hookService)
// ─────────────────────────────────────────────────────────────

/**
 * Parse the target.config JSON column into an object.
 * Returns {} (not null) so downstream code can safely read properties.
 * [verbatim from hookService.parseTargetConfig]
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
 * [verbatim from hookService.getByPath]
 */
function getByPath(obj, path) {
  if (obj == null || typeof path !== 'string' || path.length === 0) return undefined;
  if (!path.includes('.')) return obj[path];
  return path.split('.').reduce((cur, p) => (cur == null ? undefined : cur[p]), obj);
}

/**
 * Resolve a params_mapping into actual param values.
 * [extended from hookService.resolveParamsMapping — '$' rule added Slice 9A;
 *  since backfilled into hookService's copy, so the two are identical again]
 *
 * Mapping rules:
 *   • String wrapped in single quotes: literal value (quotes stripped) —
 *     so a literal dollar sign is "'$'"
 *   • The exact string '$': the whole targetOutput object itself
 *     (used by forwarding functions to receive the full event envelope)
 *   • Plain string: dot-path lookup on targetOutput ('$x' etc. are still
 *     path lookups — only the exact single character '$' is special)
 *   • Any non-string value: passed through as-is
 */
function resolveParamsMapping(paramsMapping, targetOutput) {
  const params = {};
  for (const [paramName, source] of Object.entries(paramsMapping || {})) {
    if (typeof source === 'string' && source.length >= 2
        && source.startsWith("'") && source.endsWith("'")) {
      params[paramName] = source.slice(1, -1);
    } else if (source === '$') {
      params[paramName] = targetOutput;
    } else if (typeof source === 'string') {
      params[paramName] = getByPath(targetOutput, source);
    } else {
      params[paramName] = source;
    }
  }
  return params;
}

/**
 * Build auth headers for a delivery target. Async to support oauth2.
 * [verbatim from hookService.buildAuthHeaders]
 *
 * @param {object} target - hook_targets row (only credential_id + url used)
 * @param {object} db
 * @returns {Promise<{ headers: object, error?: string }>}
 */
async function buildAuthHeaders(target, db) {
  if (!target.credential_id) return { headers: {} };
  const cred = await credentialInjection.loadCredential(db, target.credential_id);
  if (!cred) {
    return { headers: {}, error: `Credential ${target.credential_id} not found` };
  }
  const scope = credentialInjection.checkUrlScope(cred, target.url);
  if (!scope.ok) {
    return {
      headers: {},
      error: `Credential "${cred.name}" rejected for URL: ${scope.reason}`,
    };
  }
  if (cred.type === 'oauth2' && cred.oauth_status !== 'connected') {
    return {
      headers: {},
      error: `Credential "${cred.name}" not connected (oauth_status=${cred.oauth_status}). Reconnect via the OAuth flow.`,
    };
  }
  const headers = await credentialInjection.buildHeadersForCredential(
    db, target.credential_id, target.url
  );
  if (Object.keys(headers).length === 0) {
    return {
      headers: {},
      error: `Credential "${cred.name}" produced no auth headers — check server logs (oauth refresh failure or malformed config).`,
    };
  }
  return { headers };
}


// ─────────────────────────────────────────────────────────────
// DELIVERY — HTTP  [verbatim body from hookService.deliverHttp]
// ─────────────────────────────────────────────────────────────

async function deliverHttp(target, targetOutput, db) {
  // Build request body
  let requestBody;
  if (target.body_mode === 'template' && target.body_template) {
    requestBody = resolveBodyTemplate(target.body_template, targetOutput);
  } else {
    requestBody = JSON.stringify(targetOutput);
  }

  // Build headers (oauth2 credentials may refresh tokens here)
  const staticHeaders = typeof target.headers === 'string'
    ? JSON.parse(target.headers) : (target.headers || {});
  const authResult = await buildAuthHeaders(target, db);

  if (authResult.error) {
    return {
      target_id: target.id,
      request_url: target.url,
      request_method: target.method || 'POST',
      request_body: requestBody,
      response_status: null,
      response_body: null,
      status: 'failed',
      error: `Auth setup failed: ${authResult.error}`,
    };
  }

  const headers = {
    'Content-Type': 'application/json',
    ...staticHeaders,
    ...authResult.headers,
  };

  const fetchOptions = {
    method: target.method || 'POST',
    headers,
    signal: AbortSignal.timeout(30000),
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
// DELIVERY — WORKFLOW  [verbatim body from hookService.deliverWorkflow]
// ─────────────────────────────────────────────────────────────

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
    const { scheduleResume, resolveExecutionContactId, captureWorkflowInput } = require('./workflow_engine');

    const [[wfRow]] = await db.query(
      `SELECT active, default_contact_id_from, capture_mode, current_version FROM workflows WHERE id = ?`,
      [workflowId]
    );

    // Inactive workflows are not started from a hook. A hook target pointing at
    // an inactive workflow is a misconfiguration → log as failed so it surfaces
    // in delivery metrics rather than silently no-op'ing.
    if (wfRow && !wfRow.active) {
      logData.response_status = 409;
      logData.response_body = null;
      logData.status = 'failed';
      logData.error = `workflow #${workflowId} is inactive`;
      return logData;
    }

    // Versioning (S3, review D4a): a never-published workflow
    // (current_version = 0) has nothing to run. Pre-versioning this silently
    // created a zero-step execution and marked it 'completed'; refuse loudly
    // instead so it surfaces in delivery metrics.
    if (wfRow && !wfRow.current_version) {
      logData.response_status = 409;
      logData.response_body = null;
      logData.status = 'failed';
      logData.error = `workflow #${workflowId} has never been published`;
      return logData;
    }

    // Capture slice — one-shot init_data capture when armed (guarded UPDATE
    // inside the helper; race-free across the four creation sites).
    if (wfRow && wfRow.capture_mode === 'capturing') {
      await captureWorkflowInput(db, workflowId, initData);
    }

    const defaultKey = wfRow ? wfRow.default_contact_id_from : null;

    let contactId = null;
    try {
      contactId = resolveExecutionContactId({
        explicitContactId: undefined,
        initData,
        defaultKey,
      });
    } catch (e) {
      console.warn(`[HOOK→WF] contact_id resolution error, falling back to NULL:`, e.message);
      contactId = null;
    }

    const [result] = await db.query(
      `INSERT INTO workflow_executions
       (workflow_id, contact_id, status, init_data, variables, current_step_number, workflow_version)
       VALUES (?, ?, 'active', ?, ?, 1, ?)`,
      [workflowId, contactId, JSON.stringify(initData), JSON.stringify(initData),
       // Read-once-bind (review D3): stamp the current_version fetched above.
       // A missing wfRow keeps failing on the FK exactly as before.
       wfRow?.current_version ?? 1]
    );
    const executionId = result.insertId;

    // Queued start (background-CPU slice, 2026-08). Previously this fired a
    // DETACHED advanceWorkflow — which then ran after the HTTP response under
    // Cloud Run's request-based CPU throttling, at a small fraction of a vCPU
    // (observed 20–45× slowdowns; vm-watchdog aborts on trivial scripts).
    // Now the start is handed to the job queue: the next /process-jobs
    // heartbeat (≤60s) advances it INSIDE a request at full CPU
    // (routes/process_jobs.js awaits workflow_resume work before responding).
    //
    // Durability bonus: the scheduled job IS the crash record. The old shape
    // stranded executions as 'active' with no job when the instance died
    // between INSERT and advance (7 observed 2026-03→08); a pending job
    // survives the crash and runs on the next tick.
    //
    // Failure window: if this INSERT throws, the execution row exists but
    // unqueued — the outer catch marks the delivery failed, and hookService
    // queues a hook_retry, which re-runs this dispatcher and creates a NEW
    // execution. Duplicate-start over silent-drop: accepted for
    // notification-shaped workflows.
    await scheduleResume(executionId, new Date(), 1, db);

    logData.request_url = `internal://workflow/${workflowId}/execution/${executionId}`;
    logData.response_status = 200;
    logData.response_body = JSON.stringify({
      executionId,
      workflowId,
      contactId,
      status: 'queued',
    });
    logData.status = 'success';
    // §7 (2026-08): the PERSISTED delivery-log status is 'queued', not
    // 'success'. Nothing has executed yet — only the execution row and its
    // workflow_resume job exist. Writing 'success' here (the pre-§7 behavior)
    // made hook_delivery_logs claim a delivered outcome for work that could
    // still abort at step 1, which is exactly how the 2026-08-19 dropped lead
    // read as green (delivery log 9354).
    //
    // Why two fields instead of renaming `status`: `status` is the CONTROL-FLOW
    // result that dispatch() returns to callers, and six of them branch on
    // `=== 'success'` — hookService's retry gate (a false 'failed' there queues
    // a hook_retry and mints a DUPLICATE execution), esignService's completion
    // trigger (throws + files a staff task), and the trigger / phone-ingest /
    // email-ingest rule outcome mappers. Widening all six is a large blast
    // radius for a logging-honesty fix, and every future consumer would have
    // to remember the new value. `log_status` is optional and defaults to
    // `status`, so only the two writers of hook_delivery_logs care.
    //
    // NOTE: requires the enum migration (adds 'queued'). Without it, under
    // this deployment's non-strict sql_mode, MySQL silently coerces the write
    // to '' instead of erroring. Migration strictly before code.
    logData.log_status = 'queued';
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
// DELIVERY — SEQUENCE  [verbatim body from hookService.deliverSequence]
// ─────────────────────────────────────────────────────────────

async function deliverSequence(target, targetConfig, targetOutput, db) {
  const templateId = targetConfig.template_id;
  const templateType = targetConfig.template_type;
  const contactIdField = targetConfig.contact_id_field || 'contact_id';
  const triggerDataFields = Array.isArray(targetConfig.trigger_data_fields)
    ? targetConfig.trigger_data_fields : [];

  const contactId = targetOutput == null ? undefined : getByPath(targetOutput, contactIdField);

  const triggerData = {};
  for (const field of triggerDataFields) {
    const val = targetOutput == null ? undefined : getByPath(targetOutput, field);
    if (val !== undefined) {
      const key = field.includes('.') ? field.split('.').pop() : field;
      triggerData[key] = val;
    }
  }

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
    const sequenceEngine = require('./sequenceEngine');
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
        triggerData
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
// DELIVERY — INTERNAL FUNCTION  [verbatim body from hookService.deliverInternalFunction]
// ─────────────────────────────────────────────────────────────

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

  const params = resolveParamsMapping(paramsMapping, targetOutput);
  logData.request_body = JSON.stringify(params);

  try {
    const internalFunctions = require('./internal_functions');
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
// PUBLIC DISPATCH ENTRY POINT
// ─────────────────────────────────────────────────────────────

/**
 * Dispatch a single action by type. Used by hookService (today) and
 * emailIngestService (Slice 2.3+).
 *
 * This is a thin router that maps actionType → the matching dispatcher. It
 * preserves the dispatchers' native call signatures (which take the full
 * `target` row + a parsed config) by reading them from `context`:
 *
 *   - context.target : the hook_targets row (REQUIRED). The HTTP dispatcher
 *                      reads url/method/headers/body_mode/body_template/
 *                      credential_id off it; all four read target.id for the
 *                      delivery-log row. Slice 2.3 will synthesize a
 *                      target-shaped object from an email_ingest_rule_actions
 *                      row and pass it here.
 *
 * `config` is the parsed per-target config blob (already parsed — the caller
 * is responsible for parsing target.config, exactly as hookService.deliverToTarget
 * did via parseTargetConfig before calling the workflow/sequence/internal_function
 * dispatchers). For http, `config` is unused (the HTTP dispatcher reads
 * everything off the target row) and may be passed as {} or null.
 *
 * `input` is the per-target transform output (what hookService computes before
 * dispatch and passes as `targetOutput`).
 *
 * RETURN SHAPE — matches the prompt's documented contract, derived from the
 * dispatchers' native `logData` return:
 *   { status, result, error, attempts? }
 *     status:  'success' | 'failed'   (passthrough of logData.status)
 *     result:  the full logData object (carries request_url/request_method/
 *              request_body/response_status/response_body for the caller's
 *              delivery-log write)
 *     error:   logData.error || null
 *
 * NOTE: the native dispatchers NEVER throw — every failure path is caught
 * internally and returned as logData.status='failed'. dispatch() therefore
 * also does not throw for dispatch failures; it only throws for a programming
 * error (missing context.target, or an unknown actionType — matching
 * hookService.deliverToTarget's explicit unknown-type handling, which returned
 * a failed logData rather than throwing).
 *
 * @param {object} db
 * @param {string} actionType  'http' | 'workflow' | 'sequence' | 'internal_function'
 * @param {object} config       parsed type-specific config blob
 * @param {object} input        per-target transform output
 * @param {object} context      { target } at minimum; may also carry
 *                              hookExecutionId / sourceLabel / parentTrace (unused today)
 * @returns {Promise<{status:string, result:object, error:(string|null)}>}
 */
async function dispatch(db, actionType, config, input, context) {
  const target = context && context.target;
  if (!target) {
    // Programming error — the dispatchers cannot build a delivery-log row
    // without at least target.id. Surface it loudly rather than writing a
    // malformed log. (hookService always has a target, so this never fires
    // on the existing path.)
    throw new Error('actionDispatchers.dispatch: context.target is required');
  }

  let logData;
  const type = actionType || 'http';

  if (type === 'http') {
    logData = await deliverHttp(target, input, db);
  } else if (type === 'workflow') {
    logData = await deliverWorkflow(target, config || {}, input, db);
  } else if (type === 'sequence') {
    logData = await deliverSequence(target, config || {}, input, db);
  } else if (type === 'internal_function') {
    logData = await deliverInternalFunction(target, config || {}, input, db);
  } else {
    // Unknown type — mirror hookService.deliverToTarget's explicit failure
    // log (it did NOT throw; it returned a failed logData).
    logData = {
      target_id: target.id,
      request_url: `unknown://${type}`,
      request_method: 'UNKNOWN',
      request_body: JSON.stringify(input),
      response_status: 500,
      response_body: null,
      status: 'failed',
      error: `Unknown target_type: ${type}`,
    };
  }

  return {
    status: logData.status,
    result: logData,
    error: logData.error || null,
  };
}


module.exports = {
  dispatch,
  dispatchHttp: deliverHttp,
  dispatchWorkflow: deliverWorkflow,
  dispatchSequence: deliverSequence,
  dispatchInternalFunction: deliverInternalFunction,
  // also export the local helpers the dispatchers depend on, so a future
  // caller (Slice 2.3) and tests can reuse them without re-importing hookService.
  parseTargetConfig,
  resolveParamsMapping,
  getByPath,
  buildAuthHeaders,
};