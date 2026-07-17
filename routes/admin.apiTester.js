// routes/admin.apiTester.js
//
// Super-user-only HTTP request tester. Sends arbitrary HTTP requests from
// the YC server and returns the response. Use cases:
//   • Bootstrapping external integrations (Clio webhook registration, etc.)
//   • Debugging YisraHook outbound deliveries (replay from delivery logs)
//   • Ad-hoc admin actions against external systems with stored credentials
//   • Saved requests — reusable named requests (e.g. "Trigger Gmail Ingest")
//     stored server-side in api_saved_requests and executed via /saved/:id/run
//
// Security layering:
//   1. superuserOnlyFor("api_tester") — JWT + SU + 30/min/user rate limit
//   2. lib/ssrfGuard.assertSafeUrl — blocks loopback / RFC1918 / link-local
//      (incl. GCP/AWS metadata 169.254.169.254) / multicast / IPv6 ULA, etc.
//      Applied to BOTH ad-hoc and saved runs (saved URLs are re-gated every run).
//   3. redirect: 'manual' by default — 3xx surfaced with Location for admin to
//      re-run (each re-run goes through the SSRF gate fresh). follow_redirects
//      opts in to 'follow' — needed for e.g. Google Apps Script web apps, which
//      answer POST with a 302 to script.googleusercontent.com; the proxy must
//      follow it to get the real response body.
//   4. Response body cap (5 MB ad-hoc / 256 KB saved-run), hard timeout
//      (default 30s, max 60s)
//   5. Credential injection via lib/credentialInjection — Authorization
//      headers come from the credentials table, never from user input;
//      credential headers WIN over user-supplied/stored headers of the same name
//   6. allowed_urls scope failure is a hard reject (vs silent), so the admin
//      can't be confused about why their auth isn't taking effect
//   7. All request activity audited to admin_audit_log (tool='api_tester');
//      request/response bodies stored only when save_full=true; Authorization /
//      Cookie / x-api-key always redacted before storage. Saved-request CRUD is
//      not audited (matches admin.dbConsole.js saved-queries pattern).
//
// Endpoints:
//   POST   /admin/api-tester/send-request         — ad-hoc (unchanged behavior)
//   GET    /admin/api-tester/history
//   GET    /admin/api-tester/saved                — list saved requests
//   GET    /admin/api-tester/saved/:id            — full saved request
//   POST   /admin/api-tester/saved                — create
//   PUT    /admin/api-tester/saved/:id            — update (full replace)
//   DELETE /admin/api-tester/saved/:id            — delete
//   POST   /admin/api-tester/saved/:id/run        — execute server-side
//
// Credentials list: reuses existing GET /api/credentials.

const express = require('express');
const router = express.Router();

const { superuserOnlyFor, auditAdminAction } = require('../lib/auth.superuser');
const { assertSafeUrl } = require('../lib/ssrfGuard');
const { loadCredential, buildHeadersForCredential, checkUrlScope } = require('../lib/credentialInjection');

const TOOL = 'api_tester';
const su = superuserOnlyFor(TOOL);

// ── constants ───────────────────────────────────────────────────────────────
// RFC 7230 token characters for the method slot. We only sanity-check the
// shape — not the value — because this is an admin debug tool and the
// universe of legitimate HTTP methods is open-ended (PROPFIND, PURGE,
// MKCOL, custom extensions, etc). Real safety comes from the SU gate,
// SSRF gate, credential scoping, and audit log, not from a method list.
const VALID_METHOD_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,32}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS     = 60_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;  // 5 MB — ad-hoc send-request
const SAVED_RUN_RESPONSE_BYTES = 256 * 1024; // 256 KB — saved/:id/run
const MAX_LOGGED_BODY    = 10_000;           // 10 KB per direction when save_full

// Headers we never accept from user input (set by fetch / collide with URL).
const STRIPPED_USER_HEADERS = new Set(['host', 'content-length']);
// Headers always redacted in the audit log (regardless of save_full).
const REDACTED_HEADERS = new Set(['authorization', 'cookie', 'x-api-key']);

// ── helpers ─────────────────────────────────────────────────────────────────
const ipOf = (req) =>
  req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress;

function sanitizeUserHeaders(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof k !== 'string' || !k) continue;
    if (STRIPPED_USER_HEADERS.has(k.toLowerCase())) continue;
    if (v == null) continue;
    out[k] = String(v);
  }
  return out;
}

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = REDACTED_HEADERS.has(k.toLowerCase()) ? '[redacted]' : v;
  }
  return out;
}

// node-fetch v2 returns a Headers object; convert to plain {name: value|[values]}
/*routes/admin.apiTester.js:32 (its headersToObject already falls back to .entries() when .raw is absent; AbortController already enforces timeout. Optional polish: res.body.destroy() → res.body.cancel() since a web stream has no .destroy() — but it's already wrapped in try/catch so it's harmless as-is.) */
function headersToObject(h) {
  if (!h) return {};
  if (typeof h.raw === 'function') {
    const raw = h.raw();
    const out = {};
    for (const k of Object.keys(raw)) {
      out[k] = raw[k].length === 1 ? raw[k][0] : raw[k];
    }
    return out;
  }
  const out = {};
  for (const [k, v] of h.entries()) out[k] = v;
  return out;
}

/**
 * Read response body with a hard size cap. Decoded as UTF-8; binary content
 * comes back with replacement characters — admin can inspect Content-Type
 * from response headers to know what they're looking at.
 */
async function readBodyCapped(res, cap = MAX_RESPONSE_BYTES) {
  if (!res.body) return { body: '', truncated: false, size: 0 };
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of res.body) {
      if (total + chunk.length > cap) {
        const keep = cap - total;
        if (keep > 0) chunks.push(chunk.slice(0, keep));
        total = cap;
        truncated = true;
        try { res.body.destroy(); } catch (_) {}
        break;
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } catch (_) {
    // Stream errored mid-read — return partial with truncated flag set.
    truncated = true;
  }
  return { body: Buffer.concat(chunks).toString('utf8'), truncated, size: total };
}

// Parse the headers JSON column defensively — mysql2 usually auto-parses JSON
// columns to objects, but be tolerant of strings (older drivers, dumps).
function parseHeadersColumn(v) {
  if (v == null) return {};
  if (typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (_) { return {}; }
  }
  return {};
}

// ── lazy schema ensure ──────────────────────────────────────────────────────
// Belt-and-suspenders: production runs the migrations; this protects fresh
// dev environments where someone hits the API tester before /admin/db/*.
let schemaReady = null;
function ensureSchema(db) {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id            BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tool          VARCHAR(32)  NOT NULL,
        user_id       INT          NULL,
        username      VARCHAR(255) NULL,
        route         VARCHAR(255) NOT NULL,
        method        VARCHAR(10)  NOT NULL,
        status        VARCHAR(40)  NOT NULL,
        error_message TEXT         NULL,
        duration_ms   INT          NULL,
        ip_address    VARCHAR(45)  NULL,
        user_agent    VARCHAR(255) NULL,
        details       JSON         NULL,
        created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_admin_audit_tool   (tool, created_at),
        INDEX idx_admin_audit_user   (user_id, created_at),
        INDEX idx_admin_audit_status (status, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS api_saved_requests (
        id               INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name             VARCHAR(255) NOT NULL,
        method           VARCHAR(32)  NOT NULL DEFAULT 'GET',
        url              TEXT         NOT NULL,
        headers          JSON         NULL,
        body             MEDIUMTEXT   NULL,
        content_type     VARCHAR(100) NULL,
        credential_id    INT          NULL,
        follow_redirects TINYINT(1)   NOT NULL DEFAULT 1,
        notes            TEXT         NULL,
        sort_order       INT          NOT NULL DEFAULT 0,
        created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_api_saved_requests_sort (sort_order, name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);
  })().catch(err => { schemaReady = null; throw err; });
  return schemaReady;
}

// Run the schema check on every /admin/api-tester/* request, before SU gate.
// (Cheap after the first call thanks to schemaReady caching.)
router.use('/admin/api-tester', async (req, res, next) => {
  try { await ensureSchema(req.db); next(); }
  catch (err) { next(err); }
});

// ── shared proxy executor ───────────────────────────────────────────────────
// Everything from method-shape check through dispatch, capture, audit, and
// the JSON response. Used by both /send-request (ad-hoc) and /saved/:id/run.
// Behavior (audit statuses, rejection responses, success shape) is identical
// to the pre-saved-requests version of /send-request, with two additive
// fields on every executed response: http_status (status ?? 0) and
// elapsed_ms (alias of duration_ms) — spec'd names for the saved-run
// contract, harmless on the ad-hoc path.
//
// spec = {
//   started, method, url, userHeaders, reqBody, credentialId,
//   followRedirects, saveFull, timeoutMs, respBodyCap, extraDetails
// }
async function executeProxyRequest(req, res, spec) {
  const {
    started, method, url, userHeaders, reqBody, credentialId,
    followRedirects, saveFull, timeoutMs,
    respBodyCap = MAX_RESPONSE_BYTES,
    extraDetails = {},
  } = spec;

  const auditBase = {
    tool: TOOL,
    userId:   req.auth.userId,
    username: req.auth.username,
    route:    req.originalUrl,
    method:   req.method,
    ip:        ipOf(req),
    userAgent: req.headers['user-agent'] || 'unknown',
  };

  // Build the details JSON for the audit row. Adds request snapshots when
  // save_full is on. Always redacts Authorization/Cookie/x-api-key.
  function detailsBase(extra = {}) {
    const d = {
      target_method:    method,
      target_url:       url ?? null,
      credential_id:    credentialId,
      follow_redirects: followRedirects,
      ...extraDetails,
      ...extra,
    };
    if (saveFull) {
      d.request_headers = redactHeaders(userHeaders);
      if (reqBody != null) {
        d.request_body = reqBody.length > MAX_LOGGED_BODY
          ? reqBody.slice(0, MAX_LOGGED_BODY) : reqBody;
        d.request_body_truncated = reqBody.length > MAX_LOGGED_BODY;
      }
    }
    return d;
  }

  // ── Method shape check ───────────────────────────────────────────────────
  // Not an allowlist — just RFC 7230 token shape, to prevent header-injection
  // shenanigans like a method string containing "\r\n" or whitespace.
  if (!VALID_METHOD_RE.test(method)) {
    await auditAdminAction(req.db, {
      ...auditBase, status: 'rejected_bad_method',
      errorMessage: `Invalid method format: ${method}`,
      durationMs: Date.now() - started,
      details: detailsBase(),
    });
    return res.status(400).json({ error: `Invalid method format` });
  }

  // ── SSRF gate ────────────────────────────────────────────────────────────
  let parsedUrl;
  try {
    ({ url: parsedUrl } = await assertSafeUrl(url));
  } catch (e) {
    await auditAdminAction(req.db, {
      ...auditBase, status: 'rejected_ssrf',
      errorMessage: e.message,
      durationMs: Date.now() - started,
      details: detailsBase(),
    });
    return res.status(400).json({ error: e.message });
  }

  // ── Credential injection (with explicit pre-flight checks) ───────────────
  // We pre-check scope (and oauth_status, for oauth2) so we can give the
  // admin a precise rejection reason. If those pass and the dispatcher
  // still returns no headers, the failure is a config problem (oauth refresh
  // failed, missing token in config, etc) — surface that distinctly so the
  // admin doesn't have to guess.
  let credentialInjected = null;
  let authHeaders = {};
  if (credentialId != null && credentialId !== '') {
    let cred;
    try {
      cred = await loadCredential(req.db, credentialId);
    } catch (e) {
      await auditAdminAction(req.db, {
        ...auditBase, status: 'error',
        errorMessage: `Credential load failed: ${e.message}`,
        durationMs: Date.now() - started,
        details: detailsBase(),
      });
      return res.status(500).json({ error: `Credential load failed: ${e.message}` });
    }
    if (!cred) {
      await auditAdminAction(req.db, {
        ...auditBase, status: 'rejected_bad_credential',
        errorMessage: `Credential ${credentialId} not found`,
        durationMs: Date.now() - started,
        details: detailsBase(),
      });
      return res.status(400).json({ error: `Credential ${credentialId} not found` });
    }

    // Pre-flight 1: allowed_urls / APP_URL scope check (all types)
    const scope = checkUrlScope(cred, parsedUrl.toString());
    if (!scope.ok) {
      await auditAdminAction(req.db, {
        ...auditBase, status: 'rejected_credential_scope',
        errorMessage: `Credential ${credentialId} (${cred.name}) scope rejected: ${scope.reason}`,
        durationMs: Date.now() - started,
        details: detailsBase(),
      });
      return res.status(400).json({
        error: `Credential "${cred.name}" rejected for this URL: ${scope.reason}`,
      });
    }

    // Pre-flight 2: oauth2 must be connected before we attempt a refresh
    if (cred.type === 'oauth2' && cred.oauth_status !== 'connected') {
      await auditAdminAction(req.db, {
        ...auditBase, status: 'rejected_oauth_not_connected',
        errorMessage: `Credential ${credentialId} (${cred.name}) oauth_status=${cred.oauth_status}`,
        durationMs: Date.now() - started,
        details: detailsBase(),
      });
      return res.status(400).json({
        error: `Credential "${cred.name}" is not connected (oauth_status=${cred.oauth_status}). Reconnect via the OAuth flow.`,
      });
    }

    // Build headers — async so oauth2 can refresh if needed.
    // buildHeadersForCredential is the ONLY correct injection helper (handles
    // all 5 credential types incl. oauth2). Do NOT swap in buildAuthHeaders —
    // it's sync and silently returns {} for oauth2.
    try {
      authHeaders = await buildHeadersForCredential(req.db, cred.id, parsedUrl.toString());
    } catch (e) {
      await auditAdminAction(req.db, {
        ...auditBase, status: 'error',
        errorMessage: `Credential header build failed: ${e.message}`,
        durationMs: Date.now() - started,
        details: detailsBase(),
      });
      return res.status(500).json({ error: `Credential header build failed: ${e.message}` });
    }

    credentialInjected = Object.keys(authHeaders).length > 0;
    if (!credentialInjected) {
      // Pre-flights passed but no headers came back. For oauth2 this almost
      // always means the token refresh failed inside oauthService (see server
      // logs for the precise provider error). For other types it means the
      // config blob is missing required fields (e.g. bearer with no token).
      await auditAdminAction(req.db, {
        ...auditBase, status: 'rejected_credential_build_failed',
        errorMessage: `Credential ${credentialId} (${cred.name}, type=${cred.type}) produced no auth headers`,
        durationMs: Date.now() - started,
        details: detailsBase(),
      });
      return res.status(500).json({
        error: `Credential "${cred.name}" produced no auth headers — check server logs for the underlying reason (oauth refresh failure, malformed config, etc).`,
      });
    }
  }

  // Credential headers win — admin can't override Authorization to mask
  // where auth came from.
  const finalHeaders = { ...userHeaders, ...authHeaders };

  // ── Dispatch ─────────────────────────────────────────────────────────────
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let fetchResponse;
  let dispatchError = null;
  try {
    const opts = {
      method,
      headers: finalHeaders,
      redirect: followRedirects ? 'follow' : 'manual',
      signal:   controller.signal,
      timeout:  timeoutMs,  // belt-and-suspenders alongside AbortController
    };
    if (reqBody != null && method !== 'GET' && method !== 'HEAD') {
      opts.body = reqBody;
    }
    fetchResponse = await fetch(parsedUrl.toString(), opts);
  } catch (e) {
    dispatchError = e;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (dispatchError) {
    const isAbort = dispatchError.name === 'AbortError';
    const errorType = isAbort ? 'timeout' : (dispatchError.code || 'fetch_error');
    const errorMsg  = isAbort
      ? `Request timed out after ${timeoutMs}ms`
      : (dispatchError.message || String(dispatchError));
    const durationMs = Date.now() - started;
    await auditAdminAction(req.db, {
      ...auditBase, status: isAbort ? 'timeout' : 'error',
      errorMessage: errorMsg,
      durationMs,
      details: detailsBase({ error_type: errorType, credential_injected: credentialInjected }),
    });
    // Never throw raw — network/timeout errors come back as a structured
    // payload with http_status: 0.
    return res.json({
      status: null, status_text: null,
      http_status: 0,
      headers: {}, body: '',
      duration_ms: durationMs,
      elapsed_ms:  durationMs,
      error: errorMsg, error_type: errorType,
      credential_injected: credentialInjected,
    });
  }

  // ── Response capture ─────────────────────────────────────────────────────
  const { body: respBody, truncated: bodyTruncated, size: respSize } =
    await readBodyCapped(fetchResponse, respBodyCap);
  const respHeaders = headersToObject(fetchResponse.headers);
  const durationMs = Date.now() - started;

  // 3xx without follow_redirects: surface Location for admin re-run.
  const redirectLocation =
    (!followRedirects && fetchResponse.status >= 300 && fetchResponse.status < 400)
      ? (respHeaders.location || respHeaders.Location || null)
      : null;

  // ── Audit ────────────────────────────────────────────────────────────────
  const details = detailsBase({
    target_status_code:  fetchResponse.status,
    response_size:       respSize,
    body_truncated:      bodyTruncated,
    redirect_location:   redirectLocation,
    credential_injected: credentialInjected,
  });
  if (saveFull) {
    details.response_headers = respHeaders;
    details.response_body = respBody.length > MAX_LOGGED_BODY
      ? respBody.slice(0, MAX_LOGGED_BODY) : respBody;
    details.response_body_truncated = respBody.length > MAX_LOGGED_BODY || bodyTruncated;
  }

  await auditAdminAction(req.db, {
    ...auditBase, status: 'success',
    durationMs, details,
  });

  // ── Respond ──────────────────────────────────────────────────────────────
  res.json({
    status:      fetchResponse.status,
    status_text: fetchResponse.statusText,
    http_status: fetchResponse.status,
    headers:     respHeaders,
    body:        respBody,
    body_truncated: bodyTruncated,
    body_size:      respSize,
    duration_ms:    durationMs,
    elapsed_ms:     durationMs,
    redirect_location:   redirectLocation,
    credential_injected: credentialInjected,
    error: null,
  });
}

// ── POST /admin/api-tester/send-request ─────────────────────────────────────
// Ad-hoc request — behavior unchanged from the pre-saved-requests version.
router.post('/admin/api-tester/send-request', ...su, async (req, res) => {
  const started = Date.now();
  const body = req.body || {};

  let timeoutMs = Number(body.timeout_ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
  timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);

  await executeProxyRequest(req, res, {
    started,
    method: String(body.method || 'GET').toUpperCase(),
    url:    body.url,
    userHeaders: sanitizeUserHeaders(body.headers),
    reqBody: body.body == null ? null : String(body.body),
    credentialId: body.credential_id ?? null,
    followRedirects: !!body.follow_redirects,
    saveFull: !!body.save_full,
    timeoutMs,
    respBodyCap: MAX_RESPONSE_BYTES,
  });
});

// ── Saved requests: CRUD ────────────────────────────────────────────────────
// Firm-wide (shared across SUs), unlike admin_saved_queries which is per-user.
// CRUD is not audited (matches the dbConsole saved-queries pattern); every
// RUN is audited like any other api_tester request, with saved_request_id
// in details.

// Validate + normalize an incoming create/update payload.
// Returns { ok: true, row } or { ok: false, error }.
function validateSavedPayload(body) {
  const b = body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return { ok: false, error: 'name is required' };

  const url = typeof b.url === 'string' ? b.url.trim() : '';
  if (!url) return { ok: false, error: 'url is required' };

  const method = String(b.method || 'GET').toUpperCase();
  if (!VALID_METHOD_RE.test(method)) {
    return { ok: false, error: 'Invalid method format' };
  }

  const headers = sanitizeUserHeaders(b.headers);

  let credentialId = null;
  if (b.credential_id != null && b.credential_id !== '') {
    const n = Number(b.credential_id);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, error: 'credential_id must be a positive integer or null' };
    }
    credentialId = n;
  }

  let sortOrder = 0;
  if (b.sort_order != null && b.sort_order !== '') {
    const n = Number(b.sort_order);
    if (Number.isFinite(n)) sortOrder = Math.trunc(n);
  }

  return {
    ok: true,
    row: {
      name: name.slice(0, 255),
      method,
      url,
      headers,
      body: b.body == null || b.body === '' ? null : String(b.body),
      content_type: b.content_type ? String(b.content_type).slice(0, 100) : null,
      credential_id: credentialId,
      follow_redirects: b.follow_redirects === undefined ? 1 : (b.follow_redirects ? 1 : 0),
      notes: b.notes ? String(b.notes) : null,
      sort_order: sortOrder,
    },
  };
}

// GET /admin/api-tester/saved — list (light rows for the sidebar)
router.get('/admin/api-tester/saved', ...su, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT id, name, method, url, credential_id, follow_redirects,
              sort_order, updated_at
         FROM api_saved_requests
        ORDER BY sort_order, name`
    );
    res.json({ ok: true, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/api-tester/saved/:id — full row
router.get('/admin/api-tester/saved/:id', ...su, async (req, res) => {
  try {
    const [[row]] = await req.db.query(
      `SELECT id, name, method, url, headers, body, content_type,
              credential_id, follow_redirects, notes, sort_order,
              created_at, updated_at
         FROM api_saved_requests WHERE id = ?`,
      [Number(req.params.id)]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    row.headers = parseHeadersColumn(row.headers);
    row.follow_redirects = !!row.follow_redirects;
    res.json({ ok: true, row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/api-tester/saved — create
router.post('/admin/api-tester/saved', ...su, async (req, res) => {
  const v = validateSavedPayload(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const r0 = v.row;
  try {
    const [r] = await req.db.query(
      `INSERT INTO api_saved_requests
         (name, method, url, headers, body, content_type, credential_id,
          follow_redirects, notes, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r0.name, r0.method, r0.url, JSON.stringify(r0.headers), r0.body,
       r0.content_type, r0.credential_id, r0.follow_redirects, r0.notes,
       r0.sort_order]
    );
    res.json({ ok: true, id: r.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /admin/api-tester/saved/:id — update (full replace)
router.put('/admin/api-tester/saved/:id', ...su, async (req, res) => {
  const v = validateSavedPayload(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const r0 = v.row;
  try {
    const [r] = await req.db.query(
      `UPDATE api_saved_requests
          SET name = ?, method = ?, url = ?, headers = ?, body = ?,
              content_type = ?, credential_id = ?, follow_redirects = ?,
              notes = ?, sort_order = ?
        WHERE id = ?`,
      [r0.name, r0.method, r0.url, JSON.stringify(r0.headers), r0.body,
       r0.content_type, r0.credential_id, r0.follow_redirects, r0.notes,
       r0.sort_order, Number(req.params.id)]
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/api-tester/saved/:id
router.delete('/admin/api-tester/saved/:id', ...su, async (req, res) => {
  try {
    const [r] = await req.db.query(
      `DELETE FROM api_saved_requests WHERE id = ?`,
      [Number(req.params.id)]
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/api-tester/saved/:id/run ────────────────────────────────────
// Execute a saved request server-side.
//
// SECURITY / SECRETS NOTE: saved requests may contain secrets in the URL or
// headers (e.g. query-string API keys for services — like Google Apps Script
// web apps — that can't read auth headers). This is acceptable ONLY because
// api_saved_requests is server-side and every endpoint here is SU-gated
// (superuserOnlyFor). Prefer credential_id + header injection via
// buildHeadersForCredential wherever the target service supports headers —
// that keeps the secret in the encrypted credentials table instead of a
// plaintext row.
//
// Credential resolution happens at RUN time, not save time: if credential_id
// is set, headers are built fresh via buildHeadersForCredential (oauth2
// tokens refresh as needed) and MERGED over the stored headers — injected
// headers win on conflict (same rule as ad-hoc).
//
// follow_redirects is respected: Google Apps Script answers POST with a 302
// to script.googleusercontent.com; with follow_redirects=1 the proxy follows
// it (fetch spec converts the redirected POST to GET, which is what GAS
// expects) and returns the real response body.
router.post('/admin/api-tester/saved/:id/run', ...su, async (req, res) => {
  const started = Date.now();
  const id = Number(req.params.id);

  let row;
  try {
    [[row]] = await req.db.query(
      `SELECT id, name, method, url, headers, body, content_type,
              credential_id, follow_redirects
         FROM api_saved_requests WHERE id = ?`,
      [id]
    );
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!row) return res.status(404).json({ error: 'Saved request not found' });

  // Stored headers + content_type. content_type only applies when no
  // Content-Type header is already stored (stored header wins — it's more
  // specific and visible in the headers editor).
  const userHeaders = sanitizeUserHeaders(parseHeadersColumn(row.headers));
  if (row.content_type &&
      !Object.keys(userHeaders).some(k => k.toLowerCase() === 'content-type')) {
    userHeaders['Content-Type'] = row.content_type;
  }

  // Optional per-run save_full flag from the request body (defaults off,
  // same as ad-hoc).
  const saveFull = !!(req.body && req.body.save_full);

  await executeProxyRequest(req, res, {
    started,
    method: String(row.method || 'GET').toUpperCase(),
    url:    row.url,
    userHeaders,
    reqBody: row.body == null ? null : String(row.body),
    credentialId: row.credential_id,
    followRedirects: !!row.follow_redirects,
    saveFull,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    respBodyCap: SAVED_RUN_RESPONSE_BYTES,
    extraDetails: { saved_request_id: row.id, saved_request_name: row.name },
  });
});

// ── GET /admin/api-tester/history ───────────────────────────────────────────
// Recent api_tester rows. Defaults to the calling SU's own rows;
// pass ?scope=all to see other SUs' activity (still SU-gated).
router.get('/admin/api-tester/history', ...su, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const scope = req.query.scope === 'all' ? 'all' : 'own';
  try {
    const sql =
      scope === 'all'
        ? `SELECT id, user_id, username, route, method, status, error_message,
                  duration_ms, ip_address, user_agent, details, created_at
             FROM admin_audit_log
            WHERE tool = ?
            ORDER BY id DESC
            LIMIT ?`
        : `SELECT id, user_id, username, route, method, status, error_message,
                  duration_ms, ip_address, user_agent, details, created_at
             FROM admin_audit_log
            WHERE tool = ? AND user_id = ?
            ORDER BY id DESC
            LIMIT ?`;
    const params = scope === 'all' ? [TOOL, limit] : [TOOL, req.auth.userId, limit];
    const [rows] = await req.db.query(sql, params);
    res.json({ ok: true, scope, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;