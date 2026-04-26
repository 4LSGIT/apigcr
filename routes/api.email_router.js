/**
 * Email Router Routes
 * routes/api.email_router.js
 *
 * POST  /email-router                          — public receiver, api_key auth
 * GET   /api/email-router/routes               — list rules
 * GET   /api/email-router/routes/:id           — single rule
 * POST  /api/email-router/routes               — create rule
 * PUT   /api/email-router/routes/:id           — update rule
 * DELETE /api/email-router/routes/:id          — delete rule
 *
 * GET   /api/email-router/config               — global config (api key masked on read)
 * PUT   /api/email-router/config               — update auth config
 *
 * POST  /api/email-router/capture/start        — arm capture mode
 * POST  /api/email-router/capture/stop         — cancel capture (preserves sample)
 *
 * POST  /api/email-router/preview              — match + hook dry-run against input
 *                                                (or against captured_sample if no input)
 * POST  /api/email-router/match-test           — match-only preview, returns all matches
 *
 * GET   /api/email-router/executions           — paginated log
 * GET   /api/email-router/executions/:id       — single execution + linked hook execution
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const emailRouter = require('../services/emailRouter');


// ─────────────────────────────────────────────────────────────
// RECEIVER
// ─────────────────────────────────────────────────────────────

// 60 req/min per IP — adapter is ours, but we still want a runaway-loop
// guardrail. Lower than hooks' 120/min/slug+IP because there's only one
// route here and the adapter has full bandwidth to it.
const receiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many requests' },
  validate: false,
});

/**
 * POST /email-router
 *
 * The adapter (Apps Script / SiteGround PHP / SES inbound parse) POSTs
 * the standardized email JSON here. We authenticate, normalize into the
 * unified hook event shape, and dispatch through the routing pipeline.
 *
 * Response shapes:
 *   200 { status: 'routed',   execution_id, slug }
 *   200 { status: 'unrouted', execution_id }
 *   200 { status: 'captured', execution_id }   ← capture-mode hit
 *   401 { status: 'error', message: '...' }    ← bad api key
 *
 * Always 200 on routing/dispatch errors (matches hook receiver convention
 * — sender shouldn't retry on our internal failures).
 */
router.post('/email-router', receiveLimiter, async (req, res) => {
  const db = req.db;

  try {
    const config = await emailRouter.getConfig(db);

    const auth = emailRouter.authenticateRequest(config, req);
    if (!auth.valid) {
      return res.status(401).json({ status: 'error', message: auth.error });
    }

    // Wrap into the unified event shape that hookService.executeHook
    // expects. The adapter posts a body containing the email JSON; we
    // build the same { body, headers, query, method, meta } envelope.
    const input = {
      body: req.body || {},
      headers: req.headers || {},
      query: req.query || {},
      method: req.method,
      meta: {
        source: 'email',
        received_at: new Date().toISOString(),
        remote_ip: req.ip,
      },
    };

    const result = await emailRouter.routeAndDispatch(db, input, { config });

    if (result.status === 'captured') {
      return res.json({ status: 'captured', execution_id: result.execution_id });
    }
    if (result.status === 'unrouted') {
      return res.json({ status: 'unrouted', execution_id: result.execution_id });
    }
    // Routed: respond now, dispatch continues async (hookService handles
    // its own logging). dispatchPromise is fire-and-forget here — the
    // service catches and logs internally and writes an 'error' status to
    // email_router_executions on dispatch failure.
    if (result.dispatchPromise) {
      result.dispatchPromise.catch(() => {}); // already logged inside service
    }
    return res.json({
      status: 'routed',
      execution_id: result.execution_id,
      slug: result.slug,
    });
  } catch (err) {
    console.error('[email-router] receiver error:', err);
    // 200 to avoid sender retries on our errors. The execution log will
    // not have a row in this case (failure happened before log write) —
    // the operator sees this only in server logs.
    return res.status(200).json({ status: 'error', message: 'Internal error' });
  }
});


// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

/**
 * Mask the api_key on read so it doesn't leak through the management
 * UI. Operators see "configured" / "not configured" plus the header
 * name; the actual key is write-only after creation.
 */
function maskConfig(row) {
  const ac = typeof row.auth_config === 'string'
    ? (row.auth_config ? JSON.parse(row.auth_config) : null)
    : row.auth_config;
  const masked = ac ? { header: ac.header || 'x-router-key', key_set: !!ac.key } : null;
  return {
    auth_type: row.auth_type,
    auth_config: masked,
    capture_mode: row.capture_mode,
    captured_at: row.captured_at,
    has_captured_sample: !!row.captured_sample,
    updated_at: row.updated_at,
  };
}

router.get('/api/email-router/config', jwtOrApiKey, async (req, res) => {
  try {
    const config = await emailRouter.getConfig(req.db);
    res.json({ status: 'success', config: maskConfig(config) });
  } catch (err) {
    console.error('[email-router] get config error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.put('/api/email-router/config', jwtOrApiKey, async (req, res) => {
  try {
    const { auth_type, auth_config } = req.body;
    const data = {};
    if (auth_type !== undefined) data.auth_type = auth_type;
    if (auth_config !== undefined) data.auth_config = auth_config;
    await emailRouter.updateConfig(req.db, data);
    const config = await emailRouter.getConfig(req.db);
    res.json({ status: 'success', config: maskConfig(config) });
  } catch (err) {
    console.error('[email-router] update config error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// CAPTURE
// ─────────────────────────────────────────────────────────────

router.post('/api/email-router/capture/start', jwtOrApiKey, async (req, res) => {
  try {
    await emailRouter.armCapture(req.db);
    res.json({ status: 'success', capture_mode: 'capturing' });
  } catch (err) {
    console.error('[email-router] capture start error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/api/email-router/capture/stop', jwtOrApiKey, async (req, res) => {
  try {
    await emailRouter.cancelCapture(req.db);
    res.json({ status: 'success', capture_mode: 'off' });
  } catch (err) {
    console.error('[email-router] capture stop error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * Returns the most recently captured sample (full payload — unmasked).
 * Useful for the UI's "preview" flow: fetch sample, edit, run preview.
 */
router.get('/api/email-router/captured-sample', jwtOrApiKey, async (req, res) => {
  try {
    const config = await emailRouter.getConfig(req.db);
    const sample = typeof config.captured_sample === 'string'
      ? (config.captured_sample ? JSON.parse(config.captured_sample) : null)
      : config.captured_sample;
    res.json({
      status: 'success',
      captured_sample: sample,
      captured_at: config.captured_at,
    });
  } catch (err) {
    console.error('[email-router] get captured sample error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// ROUTES (rules) CRUD
// ─────────────────────────────────────────────────────────────

router.get('/api/email-router/routes', jwtOrApiKey, async (req, res) => {
  try {
    const routes = await emailRouter.listRoutes(req.db);
    res.json({ status: 'success', routes });
  } catch (err) {
    console.error('[email-router] list routes error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/api/email-router/routes/:id', jwtOrApiKey, async (req, res) => {
  try {
    const route = await emailRouter.getRoute(req.db, req.params.id);
    if (!route) return res.status(404).json({ status: 'error', message: 'Route not found' });
    res.json({ status: 'success', route });
  } catch (err) {
    console.error('[email-router] get route error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/api/email-router/routes', jwtOrApiKey, async (req, res) => {
  try {
    // req.auth?.userId is undefined under api_key auth (jwtOrApiKey allows
    // both); the service's `!== undefined` guard filters it out cleanly.
    const data = { ...req.body, last_modified_by: req.auth?.userId };
    const id = await emailRouter.createRoute(req.db, data);
    res.json({ status: 'success', id });
  } catch (err) {
    console.error('[email-router] create route error:', err);
    res.status(400).json({ status: 'error', message: err.message });
  }
});

router.put('/api/email-router/routes/:id', jwtOrApiKey, async (req, res) => {
  try {
    const data = { ...req.body, last_modified_by: req.auth?.userId };
    await emailRouter.updateRoute(req.db, req.params.id, data);
    res.json({ status: 'success' });
  } catch (err) {
    console.error('[email-router] update route error:', err);
    res.status(400).json({ status: 'error', message: err.message });
  }
});

router.delete('/api/email-router/routes/:id', jwtOrApiKey, async (req, res) => {
  try {
    await emailRouter.deleteRoute(req.db, req.params.id);
    res.json({ status: 'success' });
  } catch (err) {
    console.error('[email-router] delete route error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// PREVIEW (no dispatch)
// ─────────────────────────────────────────────────────────────

/**
 * Smart-unwrap helper: callers may post the unified hook envelope
 * { body, headers, query, method, meta } OR the raw email JSON.
 * If `meta` is present we treat as already-wrapped; otherwise wrap.
 *
 * Mirrors the same pattern hooks' /test endpoint uses. Lets the UI
 * pass either a captured_sample (which is already wrapped) or a
 * pasted raw email payload without juggling envelopes.
 */
function wrapInput(raw) {
  if (raw && typeof raw === 'object' && raw.meta) return raw;
  return {
    body: raw || {},
    headers: {},
    query: {},
    method: 'POST',
    meta: { source: 'email', received_at: new Date().toISOString() },
  };
}

/**
 * POST /api/email-router/preview
 *
 * Body shapes:
 *   { input: <unified or raw> }                — explicit input
 *   { use_captured_sample: true }              — fall back to stored sample
 *   {}                                         — same as use_captured_sample
 *
 * Returns:
 *   {
 *     status: 'success',
 *     preview: {
 *       matched: bool,
 *       first_match: { id, name, slug, position } | null,
 *       all_matches: [...],
 *       hook_preview: { ... } | null   ← hook dry-run output if matched
 *     }
 *   }
 *
 * Never dispatches and never triggers capture — pure read-only against
 * route configs and hook configs.
 */
router.post('/api/email-router/preview', jwtOrApiKey, async (req, res) => {
  try {
    let raw = req.body?.input;
    if (raw === undefined || req.body?.use_captured_sample === true) {
      const config = await emailRouter.getConfig(req.db);
      const sample = typeof config.captured_sample === 'string'
        ? (config.captured_sample ? JSON.parse(config.captured_sample) : null)
        : config.captured_sample;
      if (!sample) {
        return res.status(400).json({
          status: 'error',
          message: 'No captured sample available; arm capture and send a test email, or pass `input` explicitly.',
        });
      }
      raw = sample;
    }
    const input = wrapInput(raw);
    const preview = await emailRouter.previewWithHook(req.db, input);
    res.json({ status: 'success', preview });
  } catch (err) {
    console.error('[email-router] preview error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/email-router/match-test
 *
 * Match-only preview. Returns all matching routes (not just the first)
 * so the operator can see overlapping rules and reorder by position.
 * Useful when authoring new routes against a captured sample.
 */
router.post('/api/email-router/match-test', jwtOrApiKey, async (req, res) => {
  try {
    let raw = req.body?.input;
    if (raw === undefined || req.body?.use_captured_sample === true) {
      const config = await emailRouter.getConfig(req.db);
      const sample = typeof config.captured_sample === 'string'
        ? (config.captured_sample ? JSON.parse(config.captured_sample) : null)
        : config.captured_sample;
      if (!sample) {
        return res.status(400).json({
          status: 'error',
          message: 'No captured sample available.',
        });
      }
      raw = sample;
    }
    const input = wrapInput(raw);
    const result = await emailRouter.previewMatch(req.db, input);
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('[email-router] match-test error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// EXECUTIONS LOG
// ─────────────────────────────────────────────────────────────

router.get('/api/email-router/executions', jwtOrApiKey, async (req, res) => {
  try {
    const { limit = 50, offset = 0, status = null } = req.query;
    const result = await emailRouter.listExecutions(req.db, {
      limit: Math.min(Number(limit) || 50, 200),
      offset: Number(offset) || 0,
      status: status || null,
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('[email-router] list executions error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/api/email-router/executions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const execution = await emailRouter.getExecution(req.db, req.params.id);
    if (!execution) {
      return res.status(404).json({ status: 'error', message: 'Execution not found' });
    }
    res.json({ status: 'success', execution });
  } catch (err) {
    console.error('[email-router] get execution error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


module.exports = router;