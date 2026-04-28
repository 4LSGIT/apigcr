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
 *
 * Internal alert slugs (convention — create the hook to opt in):
 *   router-unrouted-alert  — fires when an email matches no route
 *   router-error-alert     — fires when receiver throws, OR resolved hook
 *                            slug is missing/inactive, OR dispatch rejects
 *
 * Both are throttled per-sender (default 1h, env ROUTER_ALERT_THROTTLE_MS).
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const emailRouter = require('../services/emailRouter');
const hookService = require('../services/hookService');


// ─────────────────────────────────────────────────────────────
// INTERNAL ALERT SLUGS — convention, not enforcement
// ─────────────────────────────────────────────────────────────
//
// The router fires these well-known hook slugs on internal failure paths.
// If the hook doesn't exist, executeHook returns { status: 'not_found' }
// and we silently no-op — operators opt in by creating the hook.
//
// Per-sender throttle prevents alert storms from misconfigured forwarders:
// if a Gmail filter loops 1000 emails/min from the same source, we alert
// once per (sender, throttle window) combination instead of 1000 times.
//
// IMPORTANT — Cloud Run multi-instance caveat:
// The throttle map lives in the Node process memory. Each Cloud Run
// instance has its own copy. Under concurrent load that spawns multiple
// instances, the same sender may alert N times within one window (once
// per instance) instead of exactly once. This is a deliberate trade-off:
// the alternative is a DB-backed throttle that adds query latency to
// every event in the alert path. For the firm's volume, in-process is
// fine; revisit if alert noise becomes a real problem in production.
const SLUG_UNROUTED_ALERT = 'router-unrouted-alert';
const SLUG_ERROR_ALERT    = 'router-error-alert';

const ALERT_THROTTLE_MS = parseInt(process.env.ROUTER_ALERT_THROTTLE_MS, 10) || 60 * 60 * 1000; // 1 hour
const _alertThrottle = new Map(); // key: `${slug}|${senderEmail}` → lastFiredMs

// Periodic cleanup so the map can't grow unbounded over time.
// Drops entries older than 2× the throttle window — anything older won't
// suppress a future alert anyway, so it's safe to forget.
setInterval(() => {
  const cutoff = Date.now() - (ALERT_THROTTLE_MS * 2);
  for (const [key, ts] of _alertThrottle) {
    if (ts < cutoff) _alertThrottle.delete(key);
  }
}, 10 * 60 * 1000).unref();
// .unref() so the interval doesn't keep the Node process alive on shutdown.

/**
 * Extract a stable sender key for throttle bucketing. Falls back through
 * progressively less-trusted sources, ending in a single bucket for
 * fully-unparseable inputs (so junk gets ONE bucket, not infinite buckets).
 */
function senderKeyFromInput(input) {
  const b = input?.body || {};
  return (
    (b.from && typeof b.from === 'object' && b.from.email)
      || (b.envelope && b.envelope.sender)
      || '(unknown)'
  ).toString().toLowerCase();
}

/**
 * Fire-and-forget dispatch to a well-known router-internal alert slug.
 * Returns immediately; the alert hook runs async, errors are swallowed
 * (the alerting path must never break the receiver).
 *
 * @param {object} db
 * @param {string} slug                — SLUG_UNROUTED_ALERT or SLUG_ERROR_ALERT
 * @param {object} input               — the wrapped {body, headers, ...} envelope
 * @param {object} [extraMeta]         — merged into input.meta for context
 *                                       (e.g. {kind, error, execution_id})
 */
function fireAlertHook(db, slug, input, extraMeta = {}) {
  try {
    // Throttle by sender.
    const senderKey = senderKeyFromInput(input);
    const throttleKey = `${slug}|${senderKey}`;
    const now = Date.now();
    const last = _alertThrottle.get(throttleKey) || 0;
    if (now - last < ALERT_THROTTLE_MS) return;
    _alertThrottle.set(throttleKey, now);

    // Augment meta so the alert hook's transform/targets can see why
    // it fired without inspecting code. We don't mutate the original
    // input — clone the meta.
    const enrichedInput = {
      ...input,
      meta: { ...(input.meta || {}), ...extraMeta, alert_slug: slug },
    };

    hookService.executeHook(db, slug, enrichedInput)
      .catch(err => console.error(`[email-router] alert hook ${slug} failed:`, err.message));
  } catch (err) {
    // Defensive — alerter must never throw into the receiver.
    console.error('[email-router] fireAlertHook exception:', err.message);
  }
}


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
      // Fire-and-forget unrouted alert. If `router-unrouted-alert` hook
      // doesn't exist, executeHook returns { status: 'not_found' } and
      // we silently no-op. See SLUG_UNROUTED_ALERT comment block above.
      fireAlertHook(db, SLUG_UNROUTED_ALERT, input, {
        kind: 'unrouted',
        execution_id: result.execution_id,
      });
      return res.json({ status: 'unrouted', execution_id: result.execution_id });
    }
    // Routed: respond now, dispatch continues async (hookService handles
    // its own logging). dispatchPromise is fire-and-forget here — the
    // service catches and logs internally and writes an 'error' status to
    // email_router_executions on dispatch failure.
    //
    // We attach handlers to fire SLUG_ERROR_ALERT for two distinct failure
    // modes: (a) the resolved slug isn't an active hook, (b) the dispatch
    // threw. In both cases the service has already written status='error'
    // to email_router_executions; the alert is the operator-visible
    // notification.
    if (result.dispatchPromise) {
      result.dispatchPromise.then(
        (dispatchResult) => {
          if (dispatchResult?.status === 'not_found') {
            fireAlertHook(db, SLUG_ERROR_ALERT, input, {
              kind: 'hook_not_found',
              execution_id: result.execution_id,
              resolved_slug: result.slug,
              error: `Hook not found or inactive: ${result.slug}`,
            });
          }
        },
        (err) => {
          fireAlertHook(db, SLUG_ERROR_ALERT, input, {
            kind: 'dispatch_failed',
            execution_id: result.execution_id,
            resolved_slug: result.slug,
            error: err?.message || 'unknown dispatch error',
          });
        }
      );
    }
    return res.json({
      status: 'routed',
      execution_id: result.execution_id,
      slug: result.slug,
    });
  } catch (err) {
    console.error('[email-router] receiver error:', err);
    // Fire error-alert from the catch-all. We may not have a wrapped
    // `input` here if the failure happened before we built it — guard
    // with an inline minimal envelope so the alerter's senderKey logic
    // still has something to work with.
    const fallbackInput = {
      body: req.body || {},
      headers: req.headers || {},
      query: req.query || {},
      method: req.method,
      meta: { source: 'email', received_at: new Date().toISOString(), remote_ip: req.ip },
    };
    fireAlertHook(db, SLUG_ERROR_ALERT, fallbackInput, {
      kind: 'receiver_exception',
      error: err?.message || 'unknown receiver error',
    });
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