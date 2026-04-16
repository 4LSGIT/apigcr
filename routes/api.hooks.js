/**
 * Hook Routes
 * routes/api.hooks.js
 *
 * POST /hooks/:slug         — public receiver endpoint (auth per-hook config)
 * GET/POST/PUT/DELETE /api/hooks/*      — management CRUD (JWT protected)
 * GET/POST/PUT/DELETE /api/credentials/* — credential management (JWT protected)
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

// ─────────────────────────────────────────────────────────────
// RECEIVER — the catch-all webhook endpoint
// ─────────────────────────────────────────────────────────────

/**
 * POST /hooks/:slug
 *
 * Receives external webhooks. Authentication is per-hook (not JWT).
 * Always returns 200 to the sender — errors are logged internally.
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

    // Return 200 immediately, execute pipeline async
    res.json({ status: 'received', slug });

    // Execute pipeline (fire-and-forget from the sender's perspective)
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
  // Return available transforms and operators for the UI
  res.json({
    status: 'success',
    transforms: listTransforms(),
    operators: listOperators(),
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
    const { name, position, method, url, headers, credential_id,
            body_mode, body_template, conditions,
            transform_mode, transform_config } = req.body;
    if (!name || !url) {
      return res.status(400).json({ status: 'error', message: 'name and url are required' });
    }

    const data = { name, url };
    if (position !== undefined) data.position = position;
    if (method) data.method = method;
    if (headers !== undefined) data.headers = JSON.stringify(headers);
    if (credential_id !== undefined) data.credential_id = credential_id;
    if (body_mode) data.body_mode = body_mode;
    if (body_template !== undefined) data.body_template = body_template;
    if (conditions !== undefined) data.conditions = JSON.stringify(conditions);
    if (transform_mode) data.transform_mode = transform_mode;
    if (transform_config !== undefined) data.transform_config = JSON.stringify(transform_config);

    const id = await hookService.createTarget(req.db, req.params.hookId, data);
    res.json({ status: 'success', id });
  } catch (err) {
    console.error('[hook] create target error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.put('/api/hooks/targets/:id', jwtOrApiKey, async (req, res) => {
  try {
    const data = {};
    const allowed = ['name', 'position', 'method', 'url', 'headers', 'credential_id',
                     'body_mode', 'body_template', 'conditions',
                     'transform_mode', 'transform_config', 'active'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        if (['headers', 'conditions', 'transform_config'].includes(key) && typeof req.body[key] === 'object') {
          data[key] = JSON.stringify(req.body[key]);
        } else {
          data[key] = req.body[key];
        }
      }
    }
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