/**
 * Email Router Service
 * services/emailRouter.js
 *
 * Routing layer in front of YisraHook for inbound email. The adapter
 * (Apps Script / SiteGround PHP / SES inbound parse) POSTs the
 * standardized email JSON to /email-router. We match against email_routes
 * (using the same hookFilter conditions engine), pick a slug, and
 * dispatch to hookService.executeHook.
 *
 * Pipeline (one event):
 *   POST /email-router
 *     → authenticate (api_key against email_router_config.auth_config)
 *     → CAPTURE-MODE INTERCEPT (atomic flip; halts pipeline on win)
 *     → 200 immediately
 *     → insert email_router_executions row
 *     → find first matching active route (ascending position)
 *     → if no match: status='unrouted', done
 *     → if match: bump last_matched_at + match_count, dispatch via
 *       hookService.executeHook(db, slug, input)
 *     → on dispatch: update email_router_executions with hook_execution_id
 *
 * Reuses:
 *   - hookFilter.evaluateConditions (same JSON shape as hooks.filter_config)
 *   - hookService.executeHook (the existing four-target dispatcher)
 *
 * Capture mode mirrors hooks: single slot on email_router_config (singleton
 * row id=1), atomic guarded UPDATE for race safety, dry-run never triggers.
 */

const crypto = require('crypto');
const { evaluateConditions } = require('./hookFilter');
const hookService = require('./hookService');

const RAW_INPUT_LIMIT = 512 * 1024; // 512 KB, same as hooks


// ─────────────────────────────────────────────────────────────
// CONFIG (singleton)
// ─────────────────────────────────────────────────────────────

/**
 * Load the singleton config row. Always returns a populated object —
 * the migration seeds row id=1 on creation.
 */
async function getConfig(db) {
  const [[row]] = await db.query(
    `SELECT * FROM email_router_config WHERE id = 1 LIMIT 1`
  );
  if (!row) {
    throw new Error('email_router_config singleton row missing — run the migration');
  }
  return row;
}

async function updateConfig(db, data) {
  // Allow updating auth fields. capture_mode is updated via dedicated
  // arm/cancel routes for atomicity guarantees; refuse here to avoid
  // racing with the receiver's atomic flip.
  const allowed = ['auth_type', 'auth_config'];
  const fields = [];
  const values = [];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${key} = ?`);
      // JSON columns: stringify if caller passed an object
      const val = (key === 'auth_config' && data[key] && typeof data[key] === 'object')
        ? JSON.stringify(data[key])
        : data[key];
      values.push(val);
    }
  }
  if (!fields.length) return;
  values.push(1);
  await db.query(
    `UPDATE email_router_config SET ${fields.join(', ')} WHERE id = ?`,
    values
  );
}


// ─────────────────────────────────────────────────────────────
// AUTHENTICATION
// ─────────────────────────────────────────────────────────────

/**
 * Validate inbound auth against the singleton config.
 * Mirrors hookService.authenticateRequest but for the global router.
 */
function authenticateRequest(config, req) {
  const authType = config.auth_type || 'api_key';
  const authConfig = typeof config.auth_config === 'string'
    ? (config.auth_config ? JSON.parse(config.auth_config) : null)
    : config.auth_config;

  if (authType === 'none') return { valid: true };

  if (authType === 'api_key') {
    const headerName = (authConfig?.header || 'x-router-key').toLowerCase();
    const expected = authConfig?.key;
    const actual = req.headers[headerName];
    if (!expected) {
      return { valid: false, error: 'Router api_key not configured' };
    }
    // Constant-time compare. Buffer.compare on mismatched lengths returns
    // immediately, so we lose timing-attack resistance only on length —
    // which is not a meaningful info leak for an api_key.
    const a = Buffer.from(String(actual || ''));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length) return { valid: false, error: 'Invalid api key' };
    const ok = crypto.timingSafeEqual(a, b);
    return ok ? { valid: true } : { valid: false, error: 'Invalid api key' };
  }

  return { valid: false, error: `Unknown auth type: ${authType}` };
}


// ─────────────────────────────────────────────────────────────
// MATCHING
// ─────────────────────────────────────────────────────────────

/**
 * Run a single route's match logic against an input.
 * Returns { matched: bool, error?: string }.
 */
function evaluateRoute(route, input) {
  const mode = route.match_mode || 'conditions';
  const config = typeof route.match_config === 'string'
    ? JSON.parse(route.match_config)
    : route.match_config;

  if (mode === 'conditions') {
    try {
      return { matched: evaluateConditions(config, input) };
    } catch (err) {
      return { matched: false, error: `Match error: ${err.message}` };
    }
  }
  if (mode === 'code') {
    try {
      const code = typeof config === 'string' ? config : (config?.code || '');
      const fn = new Function('input', code);
      return { matched: !!fn(input) };
    } catch (err) {
      return { matched: false, error: `Match code error: ${err.message}` };
    }
  }
  return { matched: false, error: `Unknown match mode: ${mode}` };
}

/**
 * Iterate active routes in ascending position; return the first match
 * along with all matches (for previewMatch debugging — first-wins is
 * still the live behavior).
 */
async function findMatches(db, input) {
  const [routes] = await db.query(
    `SELECT * FROM email_routes WHERE active = 1 ORDER BY position ASC, id ASC`
  );
  const all = [];
  let firstMatch = null;
  for (const route of routes) {
    const r = evaluateRoute(route, input);
    if (r.matched) {
      all.push({ id: route.id, name: route.name, slug: route.slug, position: route.position });
      if (!firstMatch) firstMatch = route;
    }
  }
  return { firstMatch, allMatches: all };
}


// ─────────────────────────────────────────────────────────────
// EXECUTION LOG
// ─────────────────────────────────────────────────────────────

async function recordExecution(db, fields) {
  const cols = [];
  const placeholders = [];
  const values = [];
  for (const [k, v] of Object.entries(fields)) {
    cols.push(k);
    placeholders.push('?');
    values.push(v);
  }
  const [r] = await db.query(
    `INSERT INTO email_router_executions (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
    values
  );
  return r.insertId;
}

async function setHookExecutionId(db, executionId, hookExecutionId) {
  if (!executionId || !hookExecutionId) return;
  await db.query(
    `UPDATE email_router_executions SET hook_execution_id = ? WHERE id = ?`,
    [hookExecutionId, executionId]
  );
}

async function setError(db, executionId, errMessage) {
  if (!executionId) return;
  await db.query(
    `UPDATE email_router_executions SET status = 'error', error = ? WHERE id = ?`,
    [String(errMessage || '').slice(0, 1000), executionId]
  );
}


// ─────────────────────────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────────────────────────

/**
 * Route and dispatch one inbound email.
 *
 * @param {object} db
 * @param {object} input    - unified event shape { body, headers, query, method, meta }
 * @param {object} [opts]
 * @param {object} [opts.config=null] - pre-loaded config (skips DB lookup)
 * @returns {object}
 *   { status:'captured', execution_id, truncated }
 *   { status:'unrouted', execution_id }
 *   { status:'routed',   execution_id, route, slug, dispatchPromise }
 *
 *   `dispatchPromise` resolves once hookService.executeHook returns and
 *   the email_router_executions row has been updated with the
 *   hook_execution_id. Receiver routes can await it (capture-mode-style)
 *   or fire-and-forget (normal respond-first style).
 */
async function routeAndDispatch(db, input, { config: preloaded = null } = {}) {
  const config = preloaded || await getConfig(db);

  // Truncate raw_input to 512 KB for storage
  const rawInputStr = JSON.stringify(input);
  const inputTruncated = rawInputStr.length > RAW_INPUT_LIMIT;
  const storedInput = inputTruncated ? rawInputStr.slice(0, RAW_INPUT_LIMIT) : rawInputStr;

  // ──────────────────────────────────────────────────────────
  // CAPTURE-MODE INTERCEPT
  // Atomic guarded UPDATE; race-safe. If two events arrive while armed,
  // exactly one wins; the other falls through to normal routing.
  // ──────────────────────────────────────────────────────────
  if (config.capture_mode === 'capturing') {
    const [upd] = await db.query(
      `UPDATE email_router_config
          SET captured_sample = ?,
              captured_at     = NOW(),
              capture_mode    = 'off'
        WHERE id = 1 AND capture_mode = 'capturing'`,
      [storedInput]
    );

    if (upd.affectedRows > 0) {
      // Won the race — record and halt
      const execId = await recordExecution(db, {
        raw_input: storedInput,
        status: 'captured',
        error: inputTruncated ? 'raw_input truncated (>512KB)' : null,
      });
      return { status: 'captured', execution_id: execId, truncated: inputTruncated };
    }
    // Lost the race — fall through to normal routing.
  }

  // ──────────────────────────────────────────────────────────
  // FIND ROUTE
  // ──────────────────────────────────────────────────────────
  const { firstMatch } = await findMatches(db, input);

  if (!firstMatch) {
    const execId = await recordExecution(db, {
      raw_input: storedInput,
      status: 'unrouted',
      error: inputTruncated ? 'raw_input truncated (>512KB)' : null,
    });
    return { status: 'unrouted', execution_id: execId };
  }

  // Bump match counters BEFORE dispatch — once we've decided on a route
  // it counts as a match even if downstream dispatch fails.
  await db.query(
    `UPDATE email_routes SET last_matched_at = NOW(), match_count = match_count + 1 WHERE id = ?`,
    [firstMatch.id]
  );

  const execId = await recordExecution(db, {
    raw_input: storedInput,
    matched_route_id: firstMatch.id,
    resolved_slug: firstMatch.slug,
    status: 'routed',
    error: inputTruncated ? 'raw_input truncated (>512KB)' : null,
  });

  // Dispatch to the resolved hook. Returns a promise the caller can
  // await or ignore — see receiver for both patterns.
  const dispatchPromise = (async () => {
    try {
      const result = await hookService.executeHook(db, firstMatch.slug, input);

      // hookService returns { executionId } on normal paths and
      // { execution_id } on the capture path. Handle both.
      const hookExecutionId = result?.executionId ?? result?.execution_id ?? null;

      if (result?.status === 'not_found') {
        // Slug exists in our route table but not as an active hook —
        // mark the email_router_execution as error so the operator
        // sees it in the log. The route was matched, but dispatch failed.
        await setError(db, execId, `Hook not found or inactive: ${firstMatch.slug}`);
      } else if (hookExecutionId) {
        await setHookExecutionId(db, execId, hookExecutionId);
      }
      return result;
    } catch (err) {
      console.error('[email-router] dispatch error:', err);
      await setError(db, execId, err.message);
      throw err;
    }
  })();

  return {
    status: 'routed',
    execution_id: execId,
    route: { id: firstMatch.id, name: firstMatch.name, slug: firstMatch.slug, position: firstMatch.position },
    slug: firstMatch.slug,
    dispatchPromise,
  };
}


// ─────────────────────────────────────────────────────────────
// PREVIEW (no dispatch — for the UI's preview-from-captured feature)
// ─────────────────────────────────────────────────────────────

/**
 * Match-only preview. Returns the first-match (live behavior) plus all
 * matches (for debugging route ordering). Does NOT dispatch and does
 * NOT log to email_router_executions.
 */
async function previewMatch(db, input) {
  const { firstMatch, allMatches } = await findMatches(db, input);
  return {
    matched: !!firstMatch,
    first_match: firstMatch
      ? { id: firstMatch.id, name: firstMatch.name, slug: firstMatch.slug, position: firstMatch.position }
      : null,
    all_matches: allMatches,
  };
}

/**
 * Full preview: match a route, then run the matched hook's dry-run
 * pipeline against the same input. Returns both pieces so the UI can
 * show "this email would route to <slug>" alongside the would-be
 * transform output.
 */
async function previewWithHook(db, input) {
  const matchPreview = await previewMatch(db, input);
  if (!matchPreview.matched) {
    return { ...matchPreview, hook_preview: null };
  }
  const slug = matchPreview.first_match.slug;
  const hookPreview = await hookService.executeHook(db, slug, input, { dryRun: true });
  return { ...matchPreview, hook_preview: hookPreview };
}


// ─────────────────────────────────────────────────────────────
// ROUTE CRUD
// ─────────────────────────────────────────────────────────────

async function listRoutes(db) {
  const [rows] = await db.query(
    `SELECT * FROM email_routes ORDER BY position ASC, id ASC`
  );
  return rows;
}

async function getRoute(db, id) {
  const [[row]] = await db.query(
    `SELECT * FROM email_routes WHERE id = ? LIMIT 1`,
    [id]
  );
  return row || null;
}

async function createRoute(db, data) {
  // Required fields
  if (!data.name) throw new Error('name is required');
  if (!data.slug) throw new Error('slug is required');
  if (data.match_config === undefined || data.match_config === null) {
    throw new Error('match_config is required');
  }

  const cols = ['name', 'slug', 'match_mode', 'match_config'];
  const values = [
    data.name,
    data.slug,
    data.match_mode || 'conditions',
    typeof data.match_config === 'object' ? JSON.stringify(data.match_config) : data.match_config,
  ];

  if (data.description !== undefined)      { cols.push('description');      values.push(data.description); }
  if (data.position !== undefined)         { cols.push('position');         values.push(data.position); }
  if (data.active !== undefined)           { cols.push('active');           values.push(data.active ? 1 : 0); }
  if (data.last_modified_by !== undefined) { cols.push('last_modified_by'); values.push(data.last_modified_by); }

  const placeholders = cols.map(() => '?').join(', ');
  const [r] = await db.query(
    `INSERT INTO email_routes (${cols.join(', ')}) VALUES (${placeholders})`,
    values
  );
  return r.insertId;
}

async function updateRoute(db, id, data) {
  const allowed = [
    'name', 'description', 'slug', 'match_mode', 'match_config',
    'position', 'active', 'last_modified_by',
  ];
  const fields = [];
  const values = [];
  for (const key of allowed) {
    if (data[key] === undefined) continue;
    fields.push(`${key} = ?`);
    if (key === 'match_config' && typeof data[key] === 'object' && data[key] !== null) {
      values.push(JSON.stringify(data[key]));
    } else if (key === 'active') {
      values.push(data[key] ? 1 : 0);
    } else {
      values.push(data[key]);
    }
  }
  if (!fields.length) return;
  values.push(id);
  await db.query(
    `UPDATE email_routes SET ${fields.join(', ')} WHERE id = ?`,
    values
  );
}

async function deleteRoute(db, id) {
  await db.query(`DELETE FROM email_routes WHERE id = ?`, [id]);
}


// ─────────────────────────────────────────────────────────────
// EXECUTIONS LOG
// ─────────────────────────────────────────────────────────────

async function listExecutions(db, { limit = 50, offset = 0, status = null } = {}) {
  const params = [];
  let where = '';
  if (status) {
    where = 'WHERE status = ?';
    params.push(status);
  }
  const [[count]] = await db.query(
    `SELECT COUNT(*) AS total FROM email_router_executions ${where}`,
    params
  );
  const [rows] = await db.query(
    `SELECT er.id, er.matched_route_id, er.resolved_slug, er.hook_execution_id,
            er.status, er.error, er.created_at,
            r.name AS route_name
       FROM email_router_executions er
       LEFT JOIN email_routes r ON er.matched_route_id = r.id
       ${where}
       ORDER BY er.id DESC
       LIMIT ? OFFSET ?`,
    [...params, Number(limit), Number(offset)]
  );
  return { executions: rows, total: count.total };
}

async function getExecution(db, id) {
  const [[row]] = await db.query(
    `SELECT er.*, r.name AS route_name
       FROM email_router_executions er
       LEFT JOIN email_routes r ON er.matched_route_id = r.id
      WHERE er.id = ?
      LIMIT 1`,
    [id]
  );
  if (!row) return null;

  // Pull the linked hook execution if any
  let hook_execution = null;
  let hook_delivery_logs = [];
  if (row.hook_execution_id) {
    const [[he]] = await db.query(
      `SELECT * FROM hook_executions WHERE id = ? LIMIT 1`,
      [row.hook_execution_id]
    );
    hook_execution = he || null;
    if (hook_execution) {
      const [logs] = await db.query(
        `SELECT * FROM hook_delivery_logs WHERE execution_id = ? ORDER BY id ASC`,
        [hook_execution.id]
      );
      hook_delivery_logs = logs;
    }
  }
  return { ...row, hook_execution, hook_delivery_logs };
}


// ─────────────────────────────────────────────────────────────
// CAPTURE MODE
// ─────────────────────────────────────────────────────────────

async function armCapture(db) {
  await db.query(
    `UPDATE email_router_config SET capture_mode = 'capturing' WHERE id = 1`
  );
}

async function cancelCapture(db) {
  // Does NOT clear captured_sample — same lifecycle as hooks.
  await db.query(
    `UPDATE email_router_config SET capture_mode = 'off' WHERE id = 1`
  );
}


module.exports = {
  // Pipeline
  routeAndDispatch,
  authenticateRequest,
  // Preview
  previewMatch,
  previewWithHook,
  // Config
  getConfig,
  updateConfig,
  // Capture
  armCapture,
  cancelCapture,
  // Routes CRUD
  listRoutes,
  getRoute,
  createRoute,
  updateRoute,
  deleteRoute,
  // Executions log
  listExecutions,
  getExecution,
  // Internals exposed for testing
  evaluateRoute,
  findMatches,
};