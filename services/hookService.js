/**
 * Hook Service — Core YisraHook Engine
 * services/hookService.js
 *
 * Orchestrates the full pipeline: authenticate → filter → transform → deliver.
 * Also provides CRUD helpers for hooks, targets, and credentials.
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

// ─────────────────────────────────────────────────────────────
// HOOK LOOKUP
// ─────────────────────────────────────────────────────────────

/**
 * Look up a hook by slug, including its active targets (ordered by position).
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
 *
 * @param {object} target - target row with cred_type, cred_config, cred_allowed_urls joined
 * @returns {object} headers to inject
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
// DELIVERY
// ─────────────────────────────────────────────────────────────

/**
 * Deliver to a single target. Returns the delivery log data.
 */
async function deliverToTarget(target, hookTransformOutput) {
  // Run target-level transform if configured
  const { output: targetOutput } = runTransform(
    target.transform_mode,
    target.transform_config,
    hookTransformOutput
  );

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
    // Evaluate target-level conditions (against transform output, not raw input)
    const targetConditions = typeof target.conditions === 'string'
      ? JSON.parse(target.conditions) : target.conditions;
    const conditionsPassed = evaluateConditions(targetConditions, transformResult.output);

    if (!conditionsPassed) {
      targetResults.push({
        target_id: target.id,
        name: target.name,
        conditions_passed: false,
        skip_reason: 'condition not met',
      });
      continue;
    }

    if (dryRun) {
      // Preview what would be sent without actually sending
      const { output: targetOutput } = runTransform(
        target.transform_mode, target.transform_config, transformResult.output
      );

      let previewBody;
      if (target.body_mode === 'template' && target.body_template) {
        previewBody = resolveBodyTemplate(target.body_template, targetOutput);
      } else {
        previewBody = targetOutput;
      }

      targetResults.push({
        target_id: target.id,
        name: target.name,
        conditions_passed: true,
        transform_output: targetOutput,
        would_send: {
          method: target.method || 'POST',
          url: target.url,
          headers: {
            'Content-Type': 'application/json',
            ...(typeof target.headers === 'string' ? JSON.parse(target.headers) : (target.headers || {})),
            // Show that auth would be injected, but don't reveal the actual credential
            ...(target.credential_id ? { '(auth)': `credential #${target.credential_id} (${target.cred_type})` } : {}),
          },
          body: previewBody,
        },
      });
      continue;
    }

    // Live delivery
    const deliveryLog = await deliverToTarget(target, transformResult.output);

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
      // Queue retry job
      await queueRetryJob(db, executionId, target.id);
    }

    targetResults.push({
      target_id: target.id,
      name: target.name,
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

  const deliveryLog = await deliverToTarget(target, transformOutput);

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
    `SELECT hdl.*, ht.name AS target_name
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
};