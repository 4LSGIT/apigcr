/**
 * Hook Routes
 * routes/api.hooks.js
 *
 * POST /hooks/:slug         — public receiver endpoint (auth per-hook config)
 * GET/POST/PUT/DELETE /api/hooks/*      — management CRUD (JWT protected)
 * GET/POST/PUT/DELETE /api/credentials/* — credential management (JWT protected)
 *
 * v1.2 — target CRUD now accepts `target_type` and `config` for internal
 * automation targets (workflow / sequence / internal_function). HTTP targets
 * continue to work exactly as before (target_type defaults to 'http').
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const hookService = require('../services/hookService');
const { listTransforms } = require('../services/hookTransforms');
const { listOperators } = require('../services/hookFilter');

// Rate limit the public receiver endpoint: 120 req/min per slug+IP
const hookReceiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => `${req.params.slug}:${req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many requests' },
  validate: false,
});

// Allowed target types — kept in one place so we can validate and expose
// them via /api/hooks/meta for the UI.
const VALID_TARGET_TYPES = ['http', 'workflow', 'sequence', 'internal_function'];

// ─────────────────────────────────────────────────────────────
// RECEIVER — the catch-all webhook endpoint
// ─────────────────────────────────────────────────────────────

/**
 * POST /hooks/:slug
 *
 * Receives external webhooks. Authentication is per-hook (not JWT).
 * Always returns 200 to the sender — errors are logged internally.
 *
 * Capture-mode branch: when hook.capture_mode === 'capturing', we await the
 * pipeline synchronously so we can report {status:'captured',execution_id}
 * back to the sender. The guarded UPDATE inside executeHook is the race-free
 * primitive — concurrent events during a capture window result in exactly
 * one capture; the others fall through to the normal pipeline.
 */
router.post('/hooks/:slug', hookReceiveLimiter, async (req, res) => {
  const { slug } = req.params;
  const db = req.db;

  try {
    // Look up hook for auth check, then pass it through to avoid double lookup
    const hook = await hookService.getHookBySlug(db, slug);
    if (!hook) {
      return res.status(404).json({ status: 'error', message: 'Hook not found' });
    }

    // Authenticate
    const auth = hookService.authenticateRequest(hook, req);
    if (!auth.valid) {
      return res.status(401).json({ status: 'error', message: auth.error });
    }

    // Build unified event shape
    const input = {
      body: req.body || {},
      headers: req.headers || {},
      query: req.query || {},
      method: req.method,
      meta: {
        source: 'http',
        received_at: new Date().toISOString(),
        slug,
        remote_ip: req.ip,
      },
    };

    // Capture mode: synchronous so we can respond with the captured status.
    if (hook.capture_mode === 'capturing') {
      try {
        const result = await hookService.executeHook(db, slug, input, { hook });
        if (result && result.status === 'captured') {
          return res.json({ status: 'captured', execution_id: result.execution_id });
        }
        // Race-loser: pipeline ran normally. Respond with the same shape the
        // sender would see outside capture mode — external API surface stays
        // consistent for webhook senders.
        return res.json({ status: 'received', slug });
      } catch (err) {
        console.error(`[hook] Capture-mode pipeline error for ${slug}:`, err);
        return res.status(200).json({ status: 'received', slug });
      }
    }

    // Normal path: return 200 immediately, execute pipeline async
    res.json({ status: 'received', slug });

    hookService.executeHook(db, slug, input, { hook }).catch((err) => {
      console.error(`[hook] Pipeline error for ${slug}:`, err);
    });

  } catch (err) {
    console.error(`[hook] Receiver error for ${slug}:`, err);
    // Still return 200 to avoid sender retries on our errors
    res.status(200).json({ status: 'received', slug });
  }
});


// ─────────────────────────────────────────────────────────────
// MANAGEMENT API — Hooks
// ─────────────────────────────────────────────────────────────

router.get('/api/hooks', jwtOrApiKey, async (req, res) => {
  try {
    const hooks = await hookService.listHooks(req.db);
    res.json({ status: 'success', hooks });
  } catch (err) {
    console.error('[hook] list error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/api/hooks/meta', jwtOrApiKey, async (req, res) => {
  // Return available transforms, operators, and target types for the UI
  res.json({
    status: 'success',
    transforms: listTransforms(),
    operators: listOperators(),
    target_types: VALID_TARGET_TYPES,
  });
});

router.get('/api/hooks/:id', jwtOrApiKey, async (req, res) => {
  try {
    const hook = await hookService.getHookById(req.db, req.params.id);
    if (!hook) return res.status(404).json({ status: 'error', message: 'Hook not found' });
    res.json({ status: 'success', hook });
  } catch (err) {
    console.error('[hook] get error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/api/hooks', jwtOrApiKey, async (req, res) => {
  try {
    const { slug, name, description, auth_type, auth_config,
            filter_mode, filter_config, transform_mode, transform_config } = req.body;
    if (!name) return res.status(400).json({ status: 'error', message: 'name is required' });

    const data = {};
    if (slug) data.slug = slug;
    data.name = name;
    if (description !== undefined) data.description = description;
    if (auth_type) data.auth_type = auth_type;
    if (auth_config !== undefined) data.auth_config = JSON.stringify(auth_config);
    if (filter_mode) data.filter_mode = filter_mode;
    if (filter_config !== undefined) data.filter_config = JSON.stringify(filter_config);
    if (transform_mode) data.transform_mode = transform_mode;
    if (transform_config !== undefined) data.transform_config = JSON.stringify(transform_config);
    data.last_modified_by = req.auth.userId;

    const id = await hookService.createHook(req.db, data);
    res.json({ status: 'success', id });
  } catch (err) {
    console.error('[hook] create error:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ status: 'error', message: 'A hook with this slug already exists' });
    }
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.put('/api/hooks/:id', jwtOrApiKey, async (req, res) => {
  try {
    const data = {};
    const allowed = ['slug', 'name', 'description', 'auth_type', 'auth_config',
                     'filter_mode', 'filter_config', 'transform_mode', 'transform_config', 'active'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        // JSON-stringify object fields
        if (['auth_config', 'filter_config', 'transform_config'].includes(key) && typeof req.body[key] === 'object') {
          data[key] = JSON.stringify(req.body[key]);
        } else {
          data[key] = req.body[key];
        }
      }
    }
    data.last_modified_by = req.auth.userId;
    await hookService.updateHook(req.db, req.params.id, data);
    res.json({ status: 'success' });
  } catch (err) {
    console.error('[hook] update error:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ status: 'error', message: 'A hook with this slug already exists' });
    }
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/api/hooks/:id', jwtOrApiKey, async (req, res) => {
  try {
    await hookService.deleteHook(req.db, req.params.id);
    res.json({ status: 'success' });
  } catch (err) {
    console.error('[hook] delete error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// MANAGEMENT API — Targets
// ─────────────────────────────────────────────────────────────

/**
 * Validate a target payload based on its target_type.
 * @returns {string|null} error message, or null if valid
 */
function validateTargetPayload(body, { isUpdate = false } = {}) {
  const type = body.target_type || 'http';

  if (!VALID_TARGET_TYPES.includes(type)) {
    return `Unknown target_type: "${type}" (allowed: ${VALID_TARGET_TYPES.join(', ')})`;
  }

  // On create, name is required. On update, only validate if provided.
  if (!isUpdate && !body.name) return 'name is required';

  if (type === 'http') {
    // HTTP targets require a URL (on create; on update only if the type is being set)
    if (!isUpdate && !body.url) {
      return 'HTTP targets require url';
    }
    return null;
  }

  // Internal target types require config with type-specific fields
  const cfg = body.config;
  const missingConfig = !cfg || typeof cfg !== 'object';

  if (type === 'workflow') {
    if (!isUpdate && (missingConfig || cfg.workflow_id == null || cfg.workflow_id === '')) {
      return 'workflow targets require config.workflow_id (number)';
    }
    if (cfg && cfg.workflow_id !== undefined && cfg.workflow_id !== null && cfg.workflow_id !== '') {
      const wfId = Number(cfg.workflow_id);
      if (!Number.isInteger(wfId) || wfId <= 0) {
        return 'config.workflow_id must be a positive integer';
      }
    }
    return null;
  }

if (type === 'sequence') {
    // Exactly one of template_type or template_id must be present.
    const hasType = cfg && cfg.template_type !== undefined && cfg.template_type !== null && cfg.template_type !== '';
    const hasId   = cfg && cfg.template_id   !== undefined && cfg.template_id   !== null && cfg.template_id   !== '';

    if (!isUpdate) {
      if (missingConfig) {
        return 'sequence targets require config with template_type or template_id';
      }
      if (hasType && hasId) {
        return 'sequence targets must set exactly one of config.template_type or config.template_id, not both';
      }
      if (!hasType && !hasId) {
        return 'sequence targets require config.template_type (string) or config.template_id (positive integer)';
      }
    } else if (cfg) {
      // On update, if config is provided, still enforce "not both" (but don't
      // require one of them to be set — matches the existing lenient update
      // policy for sequence/template_type-only updates).
      if (hasType && hasId) {
        return 'sequence targets must set exactly one of config.template_type or config.template_id, not both';
      }
    }

    // Type checks on whichever value is present
    if (hasId) {
      const idInt = Number(cfg.template_id);
      if (!Number.isInteger(idInt) || idInt <= 0) {
        return 'config.template_id must be a positive integer';
      }
      // Cascade filters are cascade-mode only
      if ((cfg.appt_type_filter != null && cfg.appt_type_filter !== '') ||
          (cfg.appt_with_filter != null && cfg.appt_with_filter !== '')) {
        return 'config.appt_type_filter and config.appt_with_filter are only valid alongside config.template_type (cascade mode); omit them when using config.template_id';
      }
    }

    if (cfg && cfg.trigger_data_fields !== undefined && !Array.isArray(cfg.trigger_data_fields)) {
      return 'config.trigger_data_fields must be an array of field names';
    }
    return null;
  }

  if (type === 'internal_function') {
    if (!isUpdate && (missingConfig || !cfg.function_name)) {
      return 'internal_function targets require config.function_name (string)';
    }
    if (cfg && cfg.params_mapping !== undefined
        && (typeof cfg.params_mapping !== 'object' || Array.isArray(cfg.params_mapping))) {
      return 'config.params_mapping must be an object of { paramName: "source" }';
    }
    return null;
  }

  return null;
}

router.get('/api/hooks/:hookId/targets', jwtOrApiKey, async (req, res) => {
  try {
    const hook = await hookService.getHookById(req.db, req.params.hookId);
    if (!hook) return res.status(404).json({ status: 'error', message: 'Hook not found' });
    res.json({ status: 'success', targets: hook.targets });
  } catch (err) {
    console.error('[hook] list targets error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/api/hooks/:hookId/targets', jwtOrApiKey, async (req, res) => {
  try {
    const validationError = validateTargetPayload(req.body, { isUpdate: false });
    if (validationError) {
      return res.status(400).json({ status: 'error', message: validationError });
    }

    const { name, position, target_type, method, url, headers, credential_id,
            body_mode, body_template, config, conditions,
            transform_mode, transform_config, active } = req.body;

    const data = { name };
    data.target_type = target_type || 'http';

    // HTTP fields
    if (url !== undefined && url !== null && url !== '') data.url = url;
    if (method) data.method = method;
    if (headers !== undefined) data.headers = JSON.stringify(headers);
    if (credential_id !== undefined && credential_id !== null && credential_id !== '') {
      data.credential_id = credential_id;
    }
    if (body_mode) data.body_mode = body_mode;
    if (body_template !== undefined) data.body_template = body_template;

    // Internal-target config (single JSON column)
    if (config !== undefined) {
      data.config = config == null ? null : JSON.stringify(config);
    }

    // Shared fields
    if (position !== undefined) data.position = position;
    if (conditions !== undefined) data.conditions = JSON.stringify(conditions);
    if (transform_mode) data.transform_mode = transform_mode;
    if (transform_config !== undefined) data.transform_config = JSON.stringify(transform_config);
    if (active !== undefined) data.active = active ? 1 : 0;

    const id = await hookService.createTarget(req.db, req.params.hookId, data);
    res.json({ status: 'success', id });
  } catch (err) {
    console.error('[hook] create target error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.put('/api/hooks/targets/:id', jwtOrApiKey, async (req, res) => {
  try {
    const validationError = validateTargetPayload(req.body, { isUpdate: true });
    if (validationError) {
      return res.status(400).json({ status: 'error', message: validationError });
    }

    const data = {};
    const allowed = ['name', 'position', 'target_type', 'method', 'url', 'headers', 'credential_id',
                     'body_mode', 'body_template', 'config', 'conditions',
                     'transform_mode', 'transform_config', 'active'];
    const jsonFields = new Set(['headers', 'conditions', 'transform_config', 'config']);

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        const val = req.body[key];
        if (jsonFields.has(key)) {
          // Allow explicit null to clear the column
          data[key] = val == null ? null : JSON.stringify(val);
        } else {
          data[key] = val;
        }
      }
    }

    if (data.active !== undefined) data.active = data.active ? 1 : 0;

    await hookService.updateTarget(req.db, req.params.id, data);
    res.json({ status: 'success' });
  } catch (err) {
    console.error('[hook] update target error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/api/hooks/targets/:id', jwtOrApiKey, async (req, res) => {
  try {
    await hookService.deleteTarget(req.db, req.params.id);
    res.json({ status: 'success' });
  } catch (err) {
    console.error('[hook] delete target error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// MANAGEMENT API — Test
// ─────────────────────────────────────────────────────────────

/**
 * POST /api/hooks/:id/test
 * Dry-run test: runs the full pipeline without delivery.
 */
router.post('/api/hooks/:id/test', jwtOrApiKey, async (req, res) => {
  try {
    const hook = await hookService.getHookById(req.db, req.params.id);
    if (!hook) return res.status(404).json({ status: 'error', message: 'Hook not found' });

    const sampleInput = req.body.input || req.body;

    // Wrap in unified shape if not already
    const input = sampleInput.meta ? sampleInput : {
      body: sampleInput,
      headers: {},
      query: {},
      method: 'POST',
      meta: { source: 'test', received_at: new Date().toISOString(), slug: hook.slug },
    };

    const result = await hookService.executeHook(req.db, hook.slug, input, { dryRun: true });
    res.json({ status: 'success', result });
  } catch (err) {
    console.error('[hook] test error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// CAPTURE MODE CONTROL (slice 2.2)
// Start/stop do NOT clear captured_sample — it's preserved until a
// new capture replaces it.
// ─────────────────────────────────────────────────────────────

router.post('/api/hooks/:id/capture/start', jwtOrApiKey, async (req, res) => {
  try {
    const [result] = await req.db.query(
      `UPDATE hooks SET capture_mode = 'capturing' WHERE id = ?`,
      [req.params.id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ status: 'error', message: 'Hook not found' });
    }
    res.json({ status: 'success', capture_mode: 'capturing' });
  } catch (err) {
    console.error('[hook] capture start error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/api/hooks/:id/capture/stop', jwtOrApiKey, async (req, res) => {
  try {
    const [result] = await req.db.query(
      `UPDATE hooks SET capture_mode = 'off' WHERE id = ?`,
      [req.params.id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ status: 'error', message: 'Hook not found' });
    }
    res.json({ status: 'success', capture_mode: 'off' });
  } catch (err) {
    console.error('[hook] capture stop error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// MANAGEMENT API — Executions / Logs
// ─────────────────────────────────────────────────────────────

router.get('/api/hooks/:hookId/executions', jwtOrApiKey, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const result = await hookService.listExecutions(req.db, req.params.hookId, { limit, offset });
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('[hook] list executions error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/api/hooks/executions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const execution = await hookService.getExecution(req.db, req.params.id);
    if (!execution) return res.status(404).json({ status: 'error', message: 'Execution not found' });
    res.json({ status: 'success', execution });
  } catch (err) {
    console.error('[hook] get execution error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// MANAGEMENT API — Credentials
// ─────────────────────────────────────────────────────────────

router.get('/api/credentials', jwtOrApiKey, async (req, res) => {
  try {
    const credentials = await hookService.listCredentials(req.db);
    res.json({ status: 'success', credentials });
  } catch (err) {
    console.error('[hook] list credentials error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/api/credentials', jwtOrApiKey, async (req, res) => {
  try {
    const { name, type, config, allowed_urls } = req.body;
    if (!name || !type) {
      return res.status(400).json({ status: 'error', message: 'name and type are required' });
    }
    const data = { name, type };
    if (config !== undefined) data.config = JSON.stringify(config);
    if (allowed_urls !== undefined) data.allowed_urls = JSON.stringify(allowed_urls);

    const id = await hookService.createCredential(req.db, data);
    res.json({ status: 'success', id });
  } catch (err) {
    console.error('[hook] create credential error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.put('/api/credentials/:id', jwtOrApiKey, async (req, res) => {
  try {
    const data = {};
    const allowed = ['name', 'type', 'config', 'allowed_urls'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        if (['config', 'allowed_urls'].includes(key) && typeof req.body[key] === 'object') {
          data[key] = JSON.stringify(req.body[key]);
        } else {
          data[key] = req.body[key];
        }
      }
    }
    await hookService.updateCredential(req.db, req.params.id, data);
    res.json({ status: 'success' });
  } catch (err) {
    console.error('[hook] update credential error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/api/credentials/:id', jwtOrApiKey, async (req, res) => {
  try {
    await hookService.deleteCredential(req.db, req.params.id);
    res.json({ status: 'success' });
  } catch (err) {
    console.error('[hook] delete credential error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


module.exports = router;