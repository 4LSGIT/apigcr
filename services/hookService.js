// services/hookService.js
//
/**
 * Hook Service — Core YisraHook Engine
 * services/hookService.js
 *
 * Orchestrates the full pipeline: authenticate → filter → transform → deliver.
 * Also provides CRUD helpers for hooks and targets. Credential CRUD moved
 * to services/credentialService.js.
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

const crypto = require('crypto');
const { evaluateConditions } = require('./hookFilter');
const { executeMapper, resolveBodyTemplate } = require('./hookMapper');
// NOTE: hookTransforms is deliberately NOT imported here. Transform chains are
// applied INSIDE hookMapper (executeMapper / resolveTemplate); hookService never
// applies one directly. An unused destructured import of applyChain sat on this
// line until MTH-2 and was removed — zero call sites in this file.
const credentialInjection = require('../lib/credentialInjection');
const actionDispatchers = require('../lib/actionDispatchers');

// Slice 2.2: the four per-target delivery functions (http / workflow /
// sequence / internal_function) were extracted verbatim into
// lib/actionDispatchers.js so the email-ingest pipeline can reuse them.
// deliverToTarget now delegates to actionDispatchers.dispatch(). The helper
// functions parseTargetConfig / resolveParamsMapping / getByPath /
// buildAuthHeaders remain HERE because buildDryRunPreview (which stays in
// hookService, untouched) still uses them; actionDispatchers carries its own
// private copies. The four deliver* names are re-exported from the shared
// module at the bottom of this file for backward-compat (testing only — no
// production caller imports them directly).
//
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
    // HMAC verifies the BYTES ON THE WIRE, so it needs the raw body captured by
    // middleware — the verify hooks on the scoped /hooks json/urlencoded
    // parsers, lib/multipartBody, or lib/rawBodyFallback for everything else.
    //
    // Prefer the Buffer: buf.toString() is a UTF-8 DECODE, so an invalid byte
    // sequence becomes U+FFFD and re-encoding the string yields different bytes
    // than the sender signed. (Same reasoning as the /webhooks rawBodyBuf.)
    //
    // `!= null`, not truthiness — a legitimately EMPTY body is signable, and
    // '' is falsy.
    const rawBody = Buffer.isBuffer(req.rawBodyBuf) ? req.rawBodyBuf
                  : (req.rawBody != null ? req.rawBody : null);

    if (rawBody == null) {
      // No middleware captured the bytes for this content-type. This used to
      // fall back to JSON.stringify(req.body), which cannot match a signature
      // over wire bytes — so the sender was told "HMAC signature mismatch" and
      // the operator went hunting for a wrong secret. Name the real cause.
      // (Mirrors esignWebhookService.evaluateHmac's 'raw_body_unavailable'.)
      return {
        valid: false,
        error: `HMAC verification unavailable: raw body was not captured (content-type: ${req.headers['content-type'] || 'none'})`,
      };
    }

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
 * Build auth headers for a delivery target. Async to support oauth2
 * credentials (which need a DB round-trip to load token state and refresh
 * if needed). Pre-checks scope and oauth_status so we can fail the delivery
 * up front with a specific reason rather than letting the upstream server
 * return a generic 401/403 (which retries can't fix and is harder to debug).
 *
 * @param {object} target - hook_targets row (only credential_id is used here;
 *                          the joined cred_* fields are no longer consulted —
 *                          we re-load from the credentials table to pick up
 *                          oauth_status / access_token, which the join didn't
 *                          carry).
 * @param {object} db     - DB pool / req.db, required for credential load
 * @returns {Promise<{ headers: object, error?: string }>}
 *   - headers: auth headers to merge (empty {} if no credential configured)
 *   - error:   human-readable rejection reason if a credential IS configured
 *              but produced no headers; absence of `error` means OK
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
 *   • The exact string '$': the whole targetOutput object itself
 *       "event": "$"                 → params.event = targetOutput
 *     (a literal dollar sign is "'$'"; '$x' etc. are still path lookups —
 *     only the exact single character '$' is special)
 *   • Any non-string value: passed through as-is (number, bool, null, object)
 *       "enabled": true              → params.enabled = true
 *       "timeout_ms": 5000           → params.timeout_ms = 5000
 *
 * Array-index syntax ("items[0].name") is NOT supported — use a transform
 * rule or a code transform to pull array elements into flat fields first.
 *
 * PARITY NOTE: the '$' rule was added to lib/actionDispatchers' copy in
 * Slice 9A but never backfilled here, so buildDryRunPreview (this file's
 * only caller) misrendered '$' mappings as undefined while live delivery
 * sent the whole object. Backfilled verbatim — the two copies are identical
 * again; keep them that way.
 */
function resolveParamsMapping(paramsMapping, targetOutput) {
  const params = {};
  for (const [paramName, source] of Object.entries(paramsMapping || {})) {
    if (typeof source === 'string' && source.length >= 2
        && source.startsWith("'") && source.endsWith("'")) {
      // Literal — strip surrounding single quotes
      params[paramName] = source.slice(1, -1);
    } else if (source === '$') {
      // Whole-object token (Slice 9A) — the full targetOutput itself
      params[paramName] = targetOutput;
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

  // Slice 2.2: per-type dispatch lives in lib/actionDispatchers. We parse the
  // config here (as before) and pass the full target row through context so
  // the HTTP dispatcher can read url/method/headers/body_* off it, and all
  // four can stamp target.id onto the delivery-log row. dispatch() returns
  // { status, result, error }; `result` is the same logData object the old
  // deliver* functions returned, so callers downstream are unaffected — we
  // hand it straight back.
  const targetConfig = parseTargetConfig(target);
  const { result } = await actionDispatchers.dispatch(
    db,
    targetType,
    targetConfig,
    targetOutput,
    { target }
  );
  return result;
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
/**
 * splitPhase (2026-08-24, split-phase dispatch slice): when true, the target
 * loop is partitioned by type. FAST targets ('workflow', 'sequence' — a few
 * small DB writes plus one bounded RPC each) are delivered BEFORE this
 * function returns, i.e. request-bound at full CPU. SLOW targets ('http',
 * 'internal_function' — arbitrary outbound work) run afterwards on a
 * `detached` promise included in the return value, exactly as the whole
 * pipeline used to. Only the webhook receiver's normal path sets this; every
 * other caller (dry-run/test-fire, replay, email router, capture path) keeps
 * the fully-serial behavior and return shape, byte for byte.
 *
 * WHY: the post-deploy report measured the awaited Cloud Tasks enqueue
 * starving in the throttled post-response tail (5.22s on the flip event;
 * ~3% of immediate jobs silently falling back to the 60s cron at idle
 * hours). Running the fast targets pre-response removes the throttled
 * context from the enqueue STRUCTURALLY instead of compensating for it.
 * Cost: the webhook response waits for the fast targets — ~100–300ms
 * typically; worst case is a Cloud Tasks outage where the enqueue's own
 * 15s deadline bounds it, still inside webhook-sender timeouts.
 *
 * Invariants preserved under splitPhase (locked by
 * tests/hookService.splitPhase.test.js):
 *   - `targets` result array keeps ORIGINAL position order (sparse-filled
 *     by index; phase 2 fills its slots later). Delivery-LOG rows for slow
 *     targets are necessarily inserted after fast ones — the UI orders by
 *     target position via join, so display is unaffected.
 *   - successCount/failCount and the final hook_executions status are
 *     computed AFTER phase 2, in the detached continuation.
 *   - A slow target's failure cannot block a fast target (it already ran),
 *     and a fast target's failure doesn't skip slow ones — same as serial.
 */
async function executeHook(db, slug, input, { dryRun = false, hook: preloaded = null, splitPhase = false } = {}) {
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
  //
  // targetResults is POSITION-INDEXED (not push-ordered) so split-phase
  // execution can fill fast and slow slots out of order while the returned
  // array keeps the targets' original order. In serial mode the two are
  // identical.
  const targetResults = new Array(hook.targets.length);
  let successCount = 0;
  let failCount = 0;

  const runTarget = async (target, idx) => {
    // Evaluate target-level conditions (against transform output, not raw input).
    // Applies equally to all target types.
    const targetConditions = typeof target.conditions === 'string'
      ? JSON.parse(target.conditions) : target.conditions;
    const conditionsPassed = evaluateConditions(targetConditions, transformResult.output);

    if (!conditionsPassed) {
      targetResults[idx] = {
        target_id: target.id,
        name: target.name,
        target_type: target.target_type || 'http',
        conditions_passed: false,
        skip_reason: 'condition not met',
      };
      return;
    }

    if (dryRun) {
      const preview = buildDryRunPreview(target, transformResult.output);
      targetResults[idx] = {
        target_id: target.id,
        name: target.name,
        conditions_passed: true,
        ...preview,
      };
      return;
    }

    // Live delivery — pass db so internal targets can reach their engines
    const deliveryLog = await deliverToTarget(target, transformResult.output, db);

    // Log the delivery.
    // `log_status` (§7) lets a dispatcher record a finer-grained persisted
    // outcome than the control-flow `status` it returns — currently only
    // deliverWorkflow, which reports 'success' to callers (the dispatch DID
    // succeed) but persists 'queued' (nothing has run yet). Defaults to
    // `status` for every other target type.
    const persistedStatus = deliveryLog.log_status || deliveryLog.status;

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
        persistedStatus,
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

    targetResults[idx] = {
      target_id: target.id,
      name: target.name,
      target_type: target.target_type || 'http',
      conditions_passed: true,
      delivery: deliveryLog,
    };
  };

  // Fast target types under split-phase: cheap, bounded, and carrying the
  // latency-critical Cloud Tasks enqueue. Everything else is 'slow'
  // (http = third-party outbound; internal_function = arbitrary work).
  const FAST_TARGET_TYPES = new Set(['workflow', 'sequence']);

  // 6. Update execution status — extracted so serial mode runs it inline and
  // split-phase runs it after phase 2 (it needs the COMPLETE tallies).
  const finalize = async () => {
  let finalStatus;
  if (dryRun) {
    finalStatus = 'dry_run';
  } else {
    const activeTargetCount = targetResults.filter((t) => t && t.conditions_passed).length;
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
  }; // end finalize

  // ── Serial mode (every caller except the receiver's normal path) ──
  // Identical to the pre-slice behavior: original order, one at a time,
  // finalize inline. dryRun ALWAYS takes this path — test-fire previews
  // must never partition.
  if (!splitPhase || dryRun) {
    for (let i = 0; i < hook.targets.length; i++) {
      await runTarget(hook.targets[i], i);
    }
    return finalize();
  }

  // ── Split-phase mode ──
  // Phase 1 (request-bound): fast targets, in original relative order.
  const slow = [];
  for (let i = 0; i < hook.targets.length; i++) {
    const t = hook.targets[i];
    if (FAST_TARGET_TYPES.has(t.target_type || 'http')) {
      await runTarget(t, i);
    } else {
      slow.push([t, i]);
    }
  }

  // Phase 2 (detached): slow targets in original relative order, then the
  // finalization UPDATE. The caller owns .catch on this promise — runTarget
  // and finalize handle their own per-target errors, so a rejection here is
  // an infrastructure failure (DB down), same blast radius as the fully
  // detached pipeline had.
  const detached = (async () => {
    for (const [t, i] of slow) {
      await runTarget(t, i);
    }
    return finalize();
  })();

  // status 'accepted': phase 1 done, phase 2 in flight. Only the receiver
  // sees this shape, and it discards everything except `detached`.
  return {
    status: 'accepted',
    executionId,
    filter: filterResult,
    transform: { output: transformResult.output, errors: transformResult.errors },
    targets: targetResults,
    detached,
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

  // Same §7 split as the initial INSERT: a workflow target that re-queues
  // successfully persists 'queued', while `status` stays 'success' for the
  // control-flow re-check below.
  const persistedStatus = deliveryLog.log_status || deliveryLog.status;

  if (existing.length) {
    await db.query(
      `UPDATE hook_delivery_logs
       SET response_status = ?, response_body = ?, status = ?, error = ?, attempts = attempts + 1
       WHERE id = ?`,
      [deliveryLog.response_status, deliveryLog.response_body, persistedStatus, deliveryLog.error, existing[0].id]
    );
  } else {
    await db.query(
      `INSERT INTO hook_delivery_logs
        (execution_id, target_id, request_url, request_method, request_body,
         response_status, response_body, status, error, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2)`,
      [execution_id, target_id, deliveryLog.request_url, deliveryLog.request_method,
       deliveryLog.request_body, deliveryLog.response_status, deliveryLog.response_body,
       persistedStatus, deliveryLog.error]
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
    // T9/WEAK-2: clear `error` when the row goes fully green.
    //
    // This flip used to leave the failed attempt's error text behind, so a
    // recovered execution read `status='delivered'` WITH a populated `error`.
    // Live example before this fix: execution 15312 ("...internal_function
    // delivery failed: Gmail API 400: Invalid To header") whose only delivery
    // log was status='success', attempts=2, error=NULL. The retry worked; the
    // execution row just never said so.
    //
    // Why that mattered enough to fix here: `hook_executions.error IS NOT NULL`
    // is precisely the predicate the T2/F-3/F-8 pattern trains you to reach for
    // when hunting "failure recorded in a side field while status stays green",
    // and a recovered retry made it a guaranteed false positive. Poisoning the
    // detector someone writes next is worse than the stale string itself.
    //
    // Only on 'delivered'. On 'partial' at least one delivery log is still
    // failed, so the row is a live failure that _scanHooks catches on status
    // alone — and the old error text, while possibly naming a target that has
    // since recovered, is not a false positive for "something here is broken".
    // "This needed a retry" is preserved either way by hook_delivery_logs.attempts > 1.
    //
    // NOT fixed here: executeRetry UPDATEs the delivery log IN PLACE, so the
    // failed attempt's response_status/response_body/error are overwritten and
    // the first-attempt detail is gone. That is a schema-shaped problem (an
    // attempts table, or append-only logs) and belongs with the queued
    // stuck-hook-execution work, not in a one-line honesty fix.
    await db.query(
      `UPDATE hook_executions
          SET status = ?${anyFailed ? '' : ', error = NULL'}
        WHERE id = ? AND status IN ('failed','partial')`,
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

/**
 * Deep-copy a hook AND its targets in one transaction.
 *
 * The copy:
 *   - gets a FRESH random slug (createHook's own convention) — slug is UNIQUE
 *     and is the live inbound endpoint (/hooks/:slug), so it can never be
 *     shared, and "<slug>-copy" would collide on a second duplicate
 *   - is created INACTIVE (active=0)
 *   - copies auth_type + auth_config VERBATIM (including api_key/hmac secret) —
 *     duplicating usually means "similar integration"; the copy is inactive on
 *     a virgin slug, so the shared secret is inert until traffic is pointed
 *     at it
 *   - copies captured_sample/captured_at (they power the Test tab against the
 *     clone) but resets capture_mode to 'off' (live state, never copied)
 *   - resets version via column default; last_modified_by = duplicating user
 *
 * Targets copy verbatim, including credential_id (an FK into the shared
 * credentials store — a reference, not a secret copy), per-target conditions,
 * and per-target transforms. Explicit column lists (not `SET ?`) so joined
 * extras from getHookById (cred_name/cred_type) and id/timestamps can never
 * leak into the insert.
 *
 * No validation round-trip — matches the rest of this service's CRUD (there
 * is no hook validator layer; source rows are copied byte-identical).
 *
 * Returns the new hook (getHookById shape, targets included), or null if the
 * source hook is absent.
 */
async function duplicateHook(db, id, userId) {
  const src = await getHookById(db, id);
  if (!src) return null;

  const toJson = (v) => (v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v)));
  const copyName = `${src.name} (copy)`.slice(0, 255);
  const newSlug  = crypto.randomUUID().slice(0, 8);

  const newId = await db.withTransaction(async (conn) => {
    const [r] = await conn.query(
      `INSERT INTO hooks
         (slug, name, description, auth_type, auth_config,
          filter_mode, filter_config, transform_mode, transform_config,
          active, last_modified_by, capture_mode, captured_sample, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'off', ?, ?)`,
      [
        newSlug,
        copyName,
        src.description ?? null,
        src.auth_type ?? 'none',
        toJson(src.auth_config),
        src.filter_mode ?? 'none',
        toJson(src.filter_config),
        src.transform_mode ?? 'passthrough',
        toJson(src.transform_config),
        userId ?? null,
        toJson(src.captured_sample),
        src.captured_at ?? null,
      ]
    );
    const hookId = r.insertId;
    for (const t of (src.targets || [])) {
      await conn.query(
        `INSERT INTO hook_targets
           (hook_id, target_type, name, position, method, url, headers,
            credential_id, body_mode, body_template, config, conditions,
            transform_mode, transform_config, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          hookId,
          t.target_type ?? 'http',
          t.name ?? '',                          // NOT NULL; source always has it
          t.position ?? 0,
          t.method ?? 'POST',                    // NOT NULL enum, default POST
          t.url ?? null,
          toJson(t.headers),
          t.credential_id ?? null,
          t.body_mode ?? 'transform_output',     // NOT NULL enum
          t.body_template ?? null,
          toJson(t.config),
          toJson(t.conditions),
          t.transform_mode ?? 'passthrough',     // NOT NULL enum
          toJson(t.transform_config),
          t.active ? 1 : 0,
        ]
      );
    }
    return hookId;
  });

  return getHookById(db, newId);
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
  duplicateHook,
  // CRUD — Targets
  createTarget,
  updateTarget,
  deleteTarget,
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
  // Slice 2.2: the four delivery functions now live in lib/actionDispatchers.
  // Re-exported here under their historical names so existing test imports of
  // hookService.deliverHttp etc. keep working. No production caller imports
  // these directly (all delivery goes through executeHook → deliverToTarget).
  deliverHttp: actionDispatchers.dispatchHttp,
  deliverWorkflow: actionDispatchers.dispatchWorkflow,
  deliverSequence: actionDispatchers.dispatchSequence,
  deliverInternalFunction: actionDispatchers.dispatchInternalFunction,
};