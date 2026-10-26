// routes/api.hooks.js
//
/**
 * Hook Routes
 * routes/api.hooks.js
 *
 * POST /hooks/:slug         — public receiver endpoint (auth per-hook config;
 *                             no session auth — untouched by the gate below)
 * GET/POST/PUT/DELETE /api/hooks/*      — management (access-control B5):
 *   requireAuth({ audience:'staff', can:'automations.manage', allowApiKey:true })
 *   — roles admin / it / su; x-api-key callers pass (machine trust until B2).
 *   Two reads stay on jwtOrApiKey for every staff user, by ruling:
 *     GET /api/hooks            the list — other pages' pickers (booking views)
 *                               read it. Non-holders get each row WITHOUT
 *                               auth_config / filter_config / transform_config
 *                               / captured_sample (the keys are absent, not
 *                               null); holders get full rows, secrets decrypted
 *                               for the editor (B4 ruling H1).
 *     GET /api/hooks/executions the global feed of the Automation Activity tab —
 *                               explicit columns, no payloads, no configs.
 *
 * Credential CRUD used to live here too (credentials began as hook-target
 * auth). It moved to routes/api.credentials.js once Connections made
 * credentials an app-wide concept.
 *
 * v1.2 — target CRUD now accepts `target_type` and `config` for internal
 * automation targets (workflow / sequence / internal_function). HTTP targets
 * continue to work exactly as before (target_type defaults to 'http').
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const requireAuth = require('../lib/auth.requireAuth');
const { can } = require('../lib/capabilities');
const hookService = require('../services/hookService');
const { idempotentRequest, sendIdempotencyError } = require('../lib/requestIdempotency');
const actionDispatchers = require('../lib/actionDispatchers');
const internalFunctions = require('../lib/internal_functions'); // __validateParamsMapping
const { listTransforms } = require('../services/hookTransforms');
const { listOperators } = require('../services/hookFilter');
const maintenance = require('../lib/maintenance');
const hookSpool = require('../lib/hookSpool');


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
// SENSITIVE HEADER STRIPPING
//
// The hook receiver puts `req.headers` verbatim into `input.headers`, which
// is then passed to filter / transform / target-delivery code. Transforms
// in 'code' mode get full access to that input (the guest engine hands the
// body the whole input), which means a hook author with code-mode privileges could
// otherwise read any auth header from an inbound request and exfil it via
// an HTTP target.
//
// The specific motivating attack: a workflow webhook step uses an
// 'internal' credential to call /hooks/<slug> on this app's host. The
// internal-cred URL-scope check (lib/credentialInjection) approves the
// call (URL matches APP_URL host), so x-api-key: <INTERNAL_API_KEY>
// reaches the receiver. Without this strip, the configured transform on
// that hook can pull the key out of input.headers and a configured HTTP
// target can POST it to an external URL like webhook.site.
//
// Defense-in-depth: this strip closes the chain even if the URL-scope
// check is misconfigured (e.g., APP_URL env var unset → fails open in
// some future bug).
//
// Denylist rationale:
//   - 'x-api-key'      — our internal cred header; never a legitimate
//                        external-webhook payload field
//   - 'authorization'  — bearer/basic from any other internal auth path
//   - 'cookie'         — session cookies; never a legitimate external
//                        webhook payload field
// External webhook senders (Stripe, Calendly, GitHub, etc.) put their
// signatures in vendor-specific headers (Stripe-Signature, X-Hub-Signature,
// etc.) that are NOT in the denylist, so legitimate use is unaffected.
//
// Express normalizes header keys to lowercase, so the comparison is
// straightforward — but we lowercase explicitly anyway in case middleware
// upstream did something different.
// ─────────────────────────────────────────────────────────────

const SENSITIVE_HEADER_DENYLIST = new Set(['x-api-key', 'authorization', 'cookie']);

function stripSensitiveHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const k of Object.keys(headers)) {
    if (SENSITIVE_HEADER_DENYLIST.has(String(k).toLowerCase())) continue;
    out[k] = headers[k];
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// CATCH-ALL — reserved slug for unmatched webhooks
//
// If a POST arrives for a slug with no active hook, the receiver falls back
// to the hook with this slug (if it exists and is active) instead of 404ing.
// The execution row records the ATTEMPTED slug (executeHook inserts the slug
// argument, not hook.slug), so unmatched traffic is reviewable per-slug in
// the executions views, and raw_input preserves the full payload even when
// the catch-all's filter suppresses its alert targets.
//
// Keep the catch-all hook's auth_type = 'none' — senders aimed at a real
// slug won't carry the catch-all's credentials, and a 401 here would drop
// exactly the data this exists to preserve.
// ─────────────────────────────────────────────────────────────

const CATCHALL_SLUG = '_catchall';

// ─────────────────────────────────────────────────────────────
// RECEIVER — the catch-all webhook endpoint
// ─────────────────────────────────────────────────────────────

/**
 * POST /hooks/:slug
 *
 * Receives external webhooks. Authentication is per-hook (not JWT).
 * Always returns 200 to the sender — errors are logged internally.
 *
 * ONE EXCEPTION — MAINTENANCE_MODE=1 (lib/maintenance.js). The pipeline must
 * not run (the database is write-frozen), and "200 no matter what" would then
 * mean "acknowledged and lost". So after the usual lookup + authentication the
 * event is CAPTURED to the hook spool (lib/hookSpool.js) and replayed later
 * through /internal/hook-replay. The 200 body is unchanged when capture
 * succeeds; if the event could NOT be stored — or the hook could not even be
 * looked up — the answer is 503, because for once the honest reply to the
 * sender is "send it again".
 *
 * Capture-mode branch: when hook.capture_mode === 'capturing', we await the
 * pipeline synchronously so we can report {status:'captured',execution_id}
 * back to the sender. The guarded UPDATE inside executeHook is the race-free
 * primitive — concurrent events during a capture window result in exactly
 * one capture; the others fall through to the normal pipeline.
 */
router.post('/hooks/:slug', hookReceiveLimiter, async (req, res) => {
  const validationToken = req.get('Validation-Token');
  // RC subscription validation handshake — echo Validation-Token and return before any DB / auth work. Empty body required; fires once at subscription create. See manual/03-YisraFlow/09-yisrahook.md.
  if (validationToken) {
    res.set('Validation-Token', validationToken);
    return res.status(200).end();
  }

  const { slug } = req.params;
  const db = req.db;

  try {
    // Look up hook for auth check, then pass it through to avoid double lookup
    let hook = await hookService.getHookBySlug(db, slug);
    let unmatched = false;

    // Catch-all fallback: unknown slug → route to the reserved '_catchall'
    // hook so the payload is stored and reviewable instead of dropped.
    // See the CATCHALL_SLUG block above for rationale.
    if (!hook) {
      hook = await hookService.getHookBySlug(db, CATCHALL_SLUG);
      if (!hook) {
        return res.status(404).json({ status: 'error', message: 'Hook not found' });
      }
      unmatched = true;
    }

    // Authenticate
    const auth = hookService.authenticateRequest(hook, req);
    if (!auth.valid) {
      // Auth failures deliberately leave NO hook_executions row (junk stays
      // out of the table), which makes a MISCONFIGURED secret invisible —
      // real deliveries just vanish. Log the rejection so a wrong signing
      // key shows up in Cloud Run logs instead of as silent lead loss.
      // (2026-09-06, added alongside the Calendly timestamped-HMAC flip.)
      console.warn(`[hook] auth failed for ${slug} from ${req.ip}: ${auth.error}`);
      return res.status(401).json({ status: 'error', message: auth.error });
    }

    // Build unified event shape.  Headers are stripped of auth-bearing
    // entries (x-api-key, authorization, cookie) BEFORE being placed into
    // input.headers — see SENSITIVE_HEADER_DENYLIST above for rationale.
    // Authentication ran on the raw req above, so per-hook HMAC/header
    // auth still works against the unscrubbed headers.
    const input = {
      body: req.body || {},
      headers: stripSensitiveHeaders(req.headers),
      query: req.query || {},
      method: req.method,
      meta: {
        source: 'http',
        received_at: new Date().toISOString(),
        slug,
        remote_ip: req.ip,
        ...(unmatched ? { unmatched: true } : {}),
      },
    };

    // Maintenance: capture, do not execute. Sits AFTER authentication (so the
    // spool only ever holds events the hook would have accepted, and a
    // timestamped-HMAC sender is judged now, not at replay) and BEFORE the
    // capture-mode branch below, which writes to `hooks`.
    if (maintenance.isOn()) {
      const spoolId = hookSpool.newSpoolId();
      input.meta.spooled = true;
      input.meta.spool_id = spoolId;
      try {
        const stored = await hookSpool.put({ slug, input, spoolId });
        console.log(`[hook] maintenance: spooled ${slug} as ${spoolId} (${stored.bytes} bytes)`);
        return res.json({ status: 'received', slug });
      } catch (err) {
        console.error(`[hook] maintenance: could NOT spool ${slug} — answering 503 so the sender retries: ${err.message}`);
        return maintenanceUnavailable(res);
      }
    }

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

    // Normal path — SPLIT-PHASE dispatch (2026-08-24). Previously this
    // responded 200 first and ran the whole pipeline detached, which put
    // every workflow start — including the Cloud Tasks enqueue whose entire
    // job is latency — in Cloud Run's throttled post-response tail (measured:
    // the awaited createTask RPC starved for 5.22s on the flip event, and
    // ~3% of immediate jobs silently fell back to the 60s cron at idle
    // hours). Now the FAST targets (workflow/sequence — the latency-critical
    // ones, and today 100% of live hook traffic) are delivered BEFORE the
    // response, request-bound at full CPU; http/internal_function targets
    // stay detached exactly as before via the returned `detached` promise.
    // The response body is byte-identical to the old contract, and the
    // catch keeps the old guarantee: our pipeline errors never turn into
    // sender-side retries. Filtered/captured results carry no `detached`.
    try {
      const result = await hookService.executeHook(db, slug, input, { hook, splitPhase: true });
      res.json({ status: 'received', slug });
      if (result && result.detached) {
        result.detached.catch((err) => {
          console.error(`[hook] Detached-phase pipeline error for ${slug}:`, err);
        });
      }
    } catch (err) {
      console.error(`[hook] Pipeline error for ${slug}:`, err);
      if (!res.headersSent) res.status(200).json({ status: 'received', slug });
    }

  } catch (err) {
    console.error(`[hook] Receiver error for ${slug}:`, err);
    // In maintenance nothing was stored (the hook lookup itself failed), so a
    // 200 here would be a silent drop — see the route header.
    if (maintenance.isOn()) return maintenanceUnavailable(res);
    // Still return 200 to avoid sender retries on our errors
    res.status(200).json({ status: 'received', slug });
  }
});

// 503 for a hook event that could not be captured during maintenance. Short
// Retry-After: unlike the gate's page-level 503, this is a transient storage
// failure and the sender should come back soon.
function maintenanceUnavailable(res) {
  return res.status(503).set('Retry-After', '60').json({
    status: 'error',
    message: 'Temporarily unavailable — retry shortly',
  });
}


// ─────────────────────────────────────────────────────────────
// MANAGEMENT API — Hooks
// ─────────────────────────────────────────────────────────────

// The management gate (B5) — every /api/hooks route below except the list
// and the global executions feed (see the header).
const manageHooks = requireAuth({ audience: 'staff', can: 'automations.manage', allowApiKey: true });

// Row keys a non-holder never receives from the list: the per-hook secret,
// the filter/transform logic, and the captured raw payload.
const LIST_HOLDER_ONLY_KEYS = ['auth_config', 'filter_config', 'transform_config', 'captured_sample'];

router.get('/api/hooks', jwtOrApiKey, async (req, res) => {
  try {
    const rows = await hookService.listHooks(req.db);
    const hooks = can(req.auth, 'automations.manage')
      // Secrets decrypted for the editor's display (B4 ruling H1).
      ? rows.map(hookService.withReadableAuth)
      : rows.map((r) => {
          const out = { ...r };
          for (const k of LIST_HOLDER_ONLY_KEYS) delete out[k];
          return out;
        });
    res.json({ status: 'success', hooks });
  } catch (err) {
    console.error('[hook] list error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/api/hooks/meta', manageHooks, async (req, res) => {
  // Return available transforms, operators, and target types for the UI
  res.json({
    status: 'success',
    transforms: listTransforms(),
    operators: listOperators(),
    target_types: VALID_TARGET_TYPES,
  });
});

// ─────────────────────────────────────────────────────────────
// GET /api/hooks/executions — GLOBAL executions list (Slice 7,
// cross-automation Activity tab).
//
// ROUTE-ORDER CRITICAL: this must be registered BEFORE
// GET /api/hooks/:id below, or Express matches '/api/hooks/executions'
// with :id = 'executions' and the handler 404s ("Hook not found").
// /api/hooks/meta above sits before :id for the same reason. The
// existing detail route GET /api/hooks/executions/:id (further down,
// ~L615 in baseline) is unaffected by :id — it has two path segments
// after /api/hooks, which the one-segment :id pattern can't capture —
// and it doesn't conflict with this route either (different segment
// counts).
//
// Query params:
//   status — optional. Single value or comma-separated list drawn from
//            the hook_executions enum: received | filtered | processing |
//            delivered | partial | failed | captured.
//            (Failure statuses for the Activity view: failed, partial.)
//   since  — optional ISO datetime; filters created_at >= since.
//   until  — optional ISO datetime; filters created_at < until (EXCLUSIVE,
//            T7 — a time-cursor pager passes the oldest row it already
//            holds and must not get it back on the next page).
//   limit  — default 50, capped at 200.
//
// Returns { status: 'success', executions: [...] } — each row carries
// the hook name (LEFT JOIN so orphaned executions still list) and a
// delivery_count subquery mirroring the per-hook listExecutions shape.
// ─────────────────────────────────────────────────────────────
router.get('/api/hooks/executions', jwtOrApiKey, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const where = ['1=1'];
    const params = [];

    if (req.query.status) {
      const statuses = String(req.query.status)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (statuses.length) {
        where.push(`he.status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }
    }

    if (req.query.since) {
      const d = new Date(req.query.since);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ status: 'error', message: 'Invalid since datetime' });
      }
      // Server and DB both run in UTC (TZ=UTC); format the cutoff as a
      // UTC 'YYYY-MM-DD HH:MM:SS' literal so a 'Z'-suffixed ISO string
      // from the client never trips MySQL's datetime parsing.
      where.push('he.created_at >= ?');
      params.push(d.toISOString().slice(0, 19).replace('T', ' '));
    }

    // T7: exclusive upper bound — see the param comment above.
    if (req.query.until) {
      const d = new Date(req.query.until);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ status: 'error', message: 'Invalid until datetime' });
      }
      where.push('he.created_at < ?');
      params.push(d.toISOString().slice(0, 19).replace('T', ' '));
    }

    const [rows] = await req.db.query(
      `SELECT he.id, he.hook_id, he.slug, he.status, he.error, he.created_at,
              h.name AS hook_name,
              (SELECT COUNT(*) FROM hook_delivery_logs hdl WHERE hdl.execution_id = he.id) AS delivery_count
       FROM hook_executions he
       LEFT JOIN hooks h ON h.id = he.hook_id
       WHERE ${where.join(' AND ')}
       ORDER BY he.created_at DESC
       LIMIT ?`,
      [...params, limit]
    );

    res.json({ status: 'success', executions: rows });
  } catch (err) {
    console.error('[hook] global executions list error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/api/hooks/:id', manageHooks, async (req, res) => {
  try {
    const hook = await hookService.getHookById(req.db, req.params.id);
    if (!hook) return res.status(404).json({ status: 'error', message: 'Hook not found' });
    // Secrets decrypted for the editor's display (B4 ruling H1).
    res.json({ status: 'success', hook: hookService.withReadableAuth(hook) });
  } catch (err) {
    console.error('[hook] get error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/api/hooks', manageHooks, async (req, res) => {
  try {
    const { slug, name, description, auth_type, auth_config,
            filter_mode, filter_config, transform_mode, transform_config,
            active, targets } = req.body;
    if (!name) return res.status(400).json({ status: 'error', message: 'name is required' });

    // Optional inline targets (A19.0): validated UP FRONT with the same rules
    // as POST /api/hooks/:hookId/targets, created in the same transaction as
    // the hook — one idempotent request births the whole thing (Casey's hook
    // card sends its draft_id as the Idempotency-Key, so a retry cannot mint
    // a second inbound endpoint).
    const inlineTargets = targets === undefined ? [] : targets;
    if (!Array.isArray(inlineTargets) || inlineTargets.length > 5) {
      return res.status(400).json({ status: 'error', message: 'targets must be an array of at most 5' });
    }
    for (let i = 0; i < inlineTargets.length; i++) {
      const vErr = validateTargetPayload(inlineTargets[i], { isUpdate: false });
      if (vErr) return res.status(400).json({ status: 'error', message: `targets[${i}]: ${vErr}` });
    }

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
    // active is accepted explicitly so a caller can create a hook DARK
    // (Casey's card always does; the human activates in the editor).
    if (active !== undefined) data.active = active ? 1 : 0;
    data.last_modified_by = req.auth.userId;

    const { value: created, replayed } = await idempotentRequest(req, 'hooks.create', async () => {
      if (!inlineTargets.length) {
        const id = await hookService.createHook(req.db, data);
        return { id, target_ids: [] };
      }
      return req.db.withTransaction(async (conn) => {
        const id = await hookService.createHook(conn, data);
        const target_ids = [];
        for (let i = 0; i < inlineTargets.length; i++) {
          const t = inlineTargets[i];
          const tData = { name: t.name, target_type: t.target_type || 'http' };
          if (t.url !== undefined && t.url !== null && t.url !== '') tData.url = t.url;
          if (t.method) tData.method = t.method;
          if (t.headers !== undefined) tData.headers = JSON.stringify(t.headers);
          if (t.credential_id !== undefined && t.credential_id !== null && t.credential_id !== '') tData.credential_id = t.credential_id;
          if (t.body_mode) tData.body_mode = t.body_mode;
          if (t.body_template !== undefined) tData.body_template = t.body_template;
          if (t.config !== undefined) tData.config = t.config == null ? null : JSON.stringify(t.config);
          if (t.position !== undefined) tData.position = t.position; else tData.position = i;
          if (t.conditions !== undefined) tData.conditions = JSON.stringify(t.conditions);
          if (t.transform_mode) tData.transform_mode = t.transform_mode;
          if (t.transform_config !== undefined) tData.transform_config = JSON.stringify(t.transform_config);
          if (t.active !== undefined) tData.active = t.active ? 1 : 0;
          target_ids.push(await hookService.createTarget(conn, id, tData));
        }
        return { id, target_ids };
      });
    });
    res.json({ status: 'success', ...created, ...(replayed ? { replayed: true } : {}) });
  } catch (err) {
    if (sendIdempotencyError(res, err)) return;
    console.error('[hook] create error:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ status: 'error', message: 'A hook with this slug already exists' });
    }
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.put('/api/hooks/:id', manageHooks, async (req, res) => {
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

// Deep-copy a hook + its targets. The copy gets a fresh random slug, is
// created INACTIVE, and copies auth verbatim — see hookService.duplicateHook.
// Body is ignored.
router.post('/api/hooks/:id/duplicate', manageHooks, async (req, res) => {
  try {
    const hook = await hookService.duplicateHook(req.db, req.params.id, req.auth.userId);
    if (!hook) return res.status(404).json({ status: 'error', message: 'Hook not found' });
    res.status(201).json({ status: 'success', hook });
  } catch (err) {
    console.error('[hook] duplicate error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/api/hooks/:id', manageHooks, async (req, res) => {
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
    // params_mapping literal-form checks — currently csvList params
    // (advance_stage guards). See the CSV LIST PARAMS block in
    // lib/internal_functions/index.js. Returns null when function_name is
    // absent or unregistered, so this adds no new failure mode to updates that
    // legitimately omit it.
    if (cfg && typeof cfg.function_name === 'string' && cfg.function_name.trim() !== '') {
      const pmErr = internalFunctions.__validateParamsMapping(
        cfg.function_name.trim(), cfg.params_mapping
      );
      if (pmErr) return pmErr.error;
    }
    return null;
  }

  return null;
}

router.get('/api/hooks/:hookId/targets', manageHooks, async (req, res) => {
  try {
    const hook = await hookService.getHookById(req.db, req.params.hookId);
    if (!hook) return res.status(404).json({ status: 'error', message: 'Hook not found' });
    res.json({ status: 'success', targets: hook.targets });
  } catch (err) {
    console.error('[hook] list targets error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/api/hooks/:hookId/targets', manageHooks, async (req, res) => {
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

router.put('/api/hooks/targets/:id', manageHooks, async (req, res) => {
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

router.delete('/api/hooks/targets/:id', manageHooks, async (req, res) => {
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
router.post('/api/hooks/:id/test', manageHooks, async (req, res) => {
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

/**
 * POST /api/hooks/:id/live-test
 * Full pipeline with real delivery, against a sample input.
 * Mirrors the dry-run endpoint's smart-unwrap so feeding a captured_sample
 * round-trips cleanly (no double-wrap). JWT-protected; bypasses per-hook
 * auth and rate limiting (management-side test, not an external webhook).
 */
router.post('/api/hooks/:id/live-test', manageHooks, async (req, res) => {
  try {
    const hook = await hookService.getHookById(req.db, req.params.id);
    if (!hook) return res.status(404).json({ status: 'error', message: 'Hook not found' });

    const sampleInput = req.body.input || req.body;

    // Wrap in unified shape if not already — same detection as the dry-run route.
    //
    // The already-wrapped branch STAMPS meta rather than passing it through. A
    // captured_sample carries the ORIGINAL meta (source:'http', the original
    // received_at, and the slug of whichever hook captured it), so replaying one
    // landed in hook_executions indistinguishable from a real delivery —
    // including under a DIFFERENT hook's slug. That cost real debugging time
    // (2026-09-06: a hook-32 capture replayed through hook 40 read as a genuine
    // misrouted Calendly invitee.created, and the only tell was that its
    // meta.received_at matched another execution's to the millisecond).
    // body/headers/query/method stay verbatim — only the envelope is corrected,
    // because it must describe THIS fire, not the one that produced the sample.
    const input = sampleInput.meta
      ? {
          ...sampleInput,
          meta: {
            ...sampleInput.meta,
            source:      'live_test',
            slug:        hook.slug,
            replayed_at: new Date().toISOString(),
          },
        }
      : {
          body: sampleInput,
          headers: {},
          query: {},
          method: 'POST',
          meta: { source: 'live_test', received_at: new Date().toISOString(), slug: hook.slug },
        };

    const result = await hookService.executeHook(req.db, hook.slug, input);
    res.json({ status: 'success', result });
  } catch (err) {
    console.error('[hook] live-test error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// MANAGEMENT API — Transform test (stateless)
//
// POST /api/hooks/test-transform
//
// Tests a transform config against sample input WITHOUT loading, saving, or
// executing any hook — the editor's current (unsaved) state is testable.
// Complements /api/hooks/:id/test, which dry-runs the SAVED pipeline.
//
// Body:
//   transform_mode / transform_config — the transform under test
//   input          — sample event; smart-wrapped into the unified
//                    {body,headers,query,method,meta} envelope exactly like
//                    /test and /live-test when not already wrapped
//   slug?          — carried into meta.slug of the wrap (fidelity for
//                    transforms that read it); no lookup is performed
//   pre_transform? — {transform_mode, transform_config} run FIRST; its output
//                    feeds the main transform. Used by the target editor to
//                    chain hook-level transform → target-level transform so
//                    params previews see realistic input.
//   params_mapping? — resolved against the FINAL transform output.
//                    Deliberately resolved with actionDispatchers'
//                    resolveParamsMapping — the copy carrying the Slice 9A
//                    '$' whole-object rule that live delivery runs.
//                    (hookService's local copy, which buildDryRunPreview
//                    uses, lacks the '$' rule — a known preview divergence
//                    this endpoint does not inherit.)
//
// Transform failures are RESULTS (errors[] in a 200), mirroring
// runTransform's own posture; only request-shape problems 400. runTransform
// can THROW on an unparseable string config (its JSON.parse is unguarded —
// impossible live, where configs come from JSON columns as objects); the
// safeRun wrapper converts that throw into the same errors[] shape.
//
// Response: { status:'success', result: { input, pre?, transform:
//   {output, errors}, resolved_params? } }
// ─────────────────────────────────────────────────────────────

router.post('/api/hooks/test-transform', manageHooks, async (req, res) => {
  try {
    const body = req.body || {};
    const { transform_mode, transform_config, pre_transform, params_mapping, slug } = body;

    if (typeof transform_mode !== 'string' || !transform_mode) {
      return res.status(400).json({ status: 'error', message: 'transform_mode is required' });
    }
    const rawInput = body.input;
    if (rawInput == null || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
      return res.status(400).json({ status: 'error', message: 'input must be a JSON object (the sample event to transform)' });
    }
    if (pre_transform != null && (typeof pre_transform !== 'object' || Array.isArray(pre_transform)
        || typeof pre_transform.transform_mode !== 'string' || !pre_transform.transform_mode)) {
      return res.status(400).json({ status: 'error', message: 'pre_transform must be an object with transform_mode/transform_config' });
    }
    if (params_mapping != null && (typeof params_mapping !== 'object' || Array.isArray(params_mapping))) {
      return res.status(400).json({ status: 'error', message: 'params_mapping must be an object' });
    }

    // Smart-wrap — same detection as /test and /live-test
    const input = rawInput.meta ? rawInput : {
      body: rawInput,
      headers: {},
      query: {},
      method: 'POST',
      meta: {
        source: 'transform_test',
        received_at: new Date().toISOString(),
        ...(typeof slug === 'string' && slug ? { slug } : {}),
      },
    };

    const safeRun = async (mode, config, data) => {
      // An editor test: the guest-code preview lane, never the live hooks lane.
      try { return await hookService.runTransform(mode, config, data, { lane: 'preview' }); }
      catch (err) { return { output: {}, errors: [`Transform failed: ${err.message}`] }; }
    };

    let stageInput = input;
    let pre;
    if (pre_transform) {
      pre = await safeRun(pre_transform.transform_mode, pre_transform.transform_config, input);
      stageInput = pre.output;
    }

    const transform = await safeRun(transform_mode, transform_config, stageInput);

    const result = { input, ...(pre ? { pre } : {}), transform };

    if (params_mapping) {
      result.resolved_params = actionDispatchers.resolveParamsMapping(params_mapping, transform.output);
    }

    res.json({ status: 'success', result });
  } catch (err) {
    console.error('[hook] test-transform error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// CAPTURE MODE CONTROL (slice 2.2)
// Start/stop do NOT clear captured_sample — it's preserved until a
// new capture replaces it.
// ─────────────────────────────────────────────────────────────

router.post('/api/hooks/:id/capture/start', manageHooks, async (req, res) => {
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

router.post('/api/hooks/:id/capture/stop', manageHooks, async (req, res) => {
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

router.get('/api/hooks/:hookId/executions', manageHooks, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const result = await hookService.listExecutions(req.db, req.params.hookId, { limit, offset });
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('[hook] list executions error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/api/hooks/executions/:id', manageHooks, async (req, res) => {
  try {
    const execution = await hookService.getExecution(req.db, req.params.id);
    if (!execution) return res.status(404).json({ status: 'error', message: 'Execution not found' });
    res.json({ status: 'success', execution });
  } catch (err) {
    console.error('[hook] get execution error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


module.exports = router;