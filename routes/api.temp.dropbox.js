// routes/api.temp.dropbox.js
//
// ⚠️ TEMPORARY ROUTE — delete when the Dropbox docs-feature exploration is done. ⚠️
//
// Gives a Claude instance direct HTTP access to the Dropbox API v2 using the
// stored "DropBox" oauth2 credential (id 8), authenticated by a readonly API
// key (X-Readonly-Api-Key). Sibling of routes/api.temp.clio.js, with the
// differences Dropbox's API actually warrants:
//
//   1. TWO HOSTS: Dropbox splits RPC (api.dropboxapi.com) from content
//      (content.dropboxapi.com). Both are pinned-allowed; nothing else is.
//      `path` shorthand implies the RPC host. Credential 8's allowed_urls
//      already covers both, so buildHeadersForCredential injects for free.
//   2. RPC STYLE: every Dropbox endpoint is POST-with-JSON-body. Endpoints
//      that take no arguments still demand `Content-Type: application/json`
//      with the literal body `null` — the whoami smoke test shows the shape.
//   3. SPACES ARE SIGNIFICANT in firm paths ("/  Law Office/   Cases/…").
//      Keep paths inside JSON bodies (this route's contract) and they pass
//      through untouched. Never move them into query strings.
//   4. Content-endpoint calls (files/download etc.) put args in the
//      `Dropbox-API-Arg` header — pass it via `headers`; non-ASCII chars in
//      that header must be \uXXXX-escaped (see dropboxService.httpHeaderSafeJson).
//      Responses are capped at 5 MB (body_truncated flags it) — this route is
//      for exploration, not bulk transfer.
//
// REMOVAL: delete this file (auto-mount handles the rest) and revoke the key.
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   POST https://app.4lsg.com/api/temp/dropbox/request
//   Header: X-Readonly-Api-Key: ycro_…
//   Body: {
//     method?: "GET"|"POST"|...,                       // default POST (RPC style)
//     url?:    "https://api.dropboxapi.com/2/...",     // absolute; OR use path
//     path?:   "/2/files/list_folder",                 // shorthand, RPC host implied
//     headers?: { "Dropbox-API-Arg": "..." },          // auth header is forced
//     body?:        <string or object>,                // objects JSON.stringify'd
//     body_base64?: "<base64 bytes>",                  // wins over `body`
//     timeout_ms?: number,                             // default 30000, max 60000
//   }
//   Returns: { status, status_text, headers, body, body_json, rate_limit,
//              duration_ms, error, ... }
//
//   Smoke test:
//   GET https://app.4lsg.com/api/temp/dropbox/whoami   (same header)
//     → users/get_current_account
//
//   Typical exploration calls:
//   { path: "/2/files/list_folder",
//     body: { path: "/  Law Office/   Cases", recursive: false, limit: 200 } }
//   { path: "/2/files/list_folder/continue", body: { cursor: "..." } }
//   { path: "/2/files/get_metadata", body: { path: "id:xxxx" } }
//   { path: "/2/sharing/get_shared_link_metadata", body: { url: "<case_dropbox>" } }

const express = require('express');
const router = express.Router();

const { readonlyApiKeyAuth } = require('../lib/auth.readonly');
const { buildHeadersForCredential } = require('../lib/credentialInjection');

const PINNED_CREDENTIAL_ID = 8;              // "DropBox" (oauth2, connected)
const ALLOWED_HOSTS = new Set(['api.dropboxapi.com', 'content.dropboxapi.com']);
const RPC_BASE      = 'https://api.dropboxapi.com';

const VALID_METHOD_RE    = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,32}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS     = 60_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;   // 5 MB
const STRIPPED_USER_HEADERS = new Set(['host', 'content-length', 'authorization']);

const RATE_LIMIT_HEADER_RE = /^(x-dropbox-|retry-after$)/i;

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

function headersToObject(h) {
  if (!h) return {};
  const out = {};
  for (const [k, v] of h.entries()) out[k] = v;
  return out;
}

function pickRateLimit(headerObj) {
  const out = {};
  for (const [k, v] of Object.entries(headerObj)) {
    if (RATE_LIMIT_HEADER_RE.test(k)) out[k] = v;
  }
  return out;
}

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
    truncated = true;
  }
  return { body: Buffer.concat(chunks).toString('utf8'), truncated, size: total };
}

/**
 * Resolve the target URL from either `url` (absolute) or `path` (RPC host
 * implied). No `query` sugar — Dropbox args travel in JSON bodies, and firm
 * paths carry significant spaces that must never touch a query string.
 * @returns {{url: URL} | {error: string}}
 */
function resolveTargetUrl(body) {
  let raw;

  if (typeof body.url === 'string' && body.url.length) {
    raw = body.url;
  } else if (typeof body.path === 'string' && body.path.length) {
    raw = RPC_BASE + (body.path.startsWith('/') ? body.path : `/${body.path}`);
  } else {
    return { error: 'Missing url (absolute) or path (e.g. "/2/files/list_folder")' };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: `Invalid url: ${raw}` };
  }

  // Host pin (defence-in-depth over allowed_urls glob matching — see the
  // clio sibling's header §2 for why the pin is not redundant).
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.host)) {
    return { error: `URL rejected: only https://{${[...ALLOWED_HOSTS].join(', ')}} are allowed.` };
  }

  return { url: parsed };
}

/**
 * Explain an empty header result from buildHeadersForCredential (it fails
 * silently by design — returns {} — which would otherwise surface as a
 * confusing 401 from Dropbox).
 */
async function diagnoseCredential(db) {
  try {
    const [[row]] = await db.query(
      `SELECT id, name, type, oauth_status, allowed_urls,
              access_token_expires_at, refresh_failure_count, oauth_last_error
         FROM credentials WHERE id = ?`,
      [PINNED_CREDENTIAL_ID]
    );
    if (!row) return { reason: `Credential ${PINNED_CREDENTIAL_ID} not found.` };
    if (row.type !== 'oauth2') {
      return { reason: `Credential ${PINNED_CREDENTIAL_ID} is type=${row.type}, expected oauth2.`, credential: row };
    }
    if (row.oauth_status !== 'connected') {
      return { reason: `Credential ${PINNED_CREDENTIAL_ID} oauth_status=${row.oauth_status}. Re-authorize at /connections.html.`, credential: row };
    }
    return {
      reason: `Credential ${PINNED_CREDENTIAL_ID} yielded no auth header — token refresh failed or URL fell outside allowed_urls. See server logs for the [credentialInjection] warning.`,
      credential: row,
    };
  } catch (e) {
    return { reason: `Credential lookup failed: ${e.message}` };
  }
}

// ── Core dispatcher (shared by /request and /whoami) ─────────────────────────
async function dispatch(req, res, body) {
  const started = Date.now();

  // Dropbox is RPC-over-POST; default POST (the clio sibling defaults GET).
  const method = String(body.method || 'POST').toUpperCase();
  if (!VALID_METHOD_RE.test(method)) {
    return res.status(400).json({ error: `Invalid method: ${method}` });
  }

  const resolved = resolveTargetUrl(body);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  const parsedUrl = resolved.url;

  // Body: base64 (binary) wins over string/object.
  let reqBody = null;
  let bodyWasObject = false;
  if (typeof body.body_base64 === 'string' && body.body_base64.length) {
    try {
      reqBody = Buffer.from(body.body_base64, 'base64');
    } catch {
      return res.status(400).json({ error: 'body_base64 is not valid base64' });
    }
  } else if (body.body !== undefined) {
    // NOTE: body:null is meaningful to Dropbox no-arg RPC endpoints — callers
    // send body:"null" (string) with Content-Type application/json.
    bodyWasObject = (body.body !== null && typeof body.body === 'object');
    reqBody = bodyWasObject ? JSON.stringify(body.body)
            : body.body === null ? null
            : String(body.body);
  }

  const userHeaders = sanitizeUserHeaders(body.headers);

  let timeoutMs = Number(body.timeout_ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
  timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);

  // ── Auth: production path (Bearer via credentialInjection) ─────────────────
  let authHeaders;
  try {
    authHeaders = await buildHeadersForCredential(req.db, PINNED_CREDENTIAL_ID, parsedUrl.toString());
  } catch (e) {
    return res.status(500).json({ error: `Dropbox credential injection threw: ${e.message}` });
  }
  if (!authHeaders || !authHeaders.Authorization) {
    const diag = await diagnoseCredential(req.db);
    return res.status(500).json({ error: diag.reason, credential: diag.credential || null });
  }

  // Sensible RPC defaults, overridable by the caller's headers. Content
  // endpoints need the caller to set Dropbox-API-Arg (and usually
  // application/octet-stream) themselves.
  const defaults = {};
  if (bodyWasObject) defaults['Content-Type'] = 'application/json';

  const finalHeaders = { ...defaults, ...userHeaders, ...authHeaders };

  // ── Dispatch ───────────────────────────────────────────────────────────────
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let fetchResponse;
  let dispatchError = null;
  try {
    const opts = {
      method,
      headers: finalHeaders,
      redirect: 'manual',
      signal: controller.signal,
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
    return res.json({
      request_url: parsedUrl.toString(),
      status: null, status_text: null, headers: {}, body: '', body_json: null,
      rate_limit: {},
      duration_ms: Date.now() - started,
      error: isAbort ? `Request timed out after ${timeoutMs}ms`
                     : (dispatchError.message || String(dispatchError)),
      error_type: isAbort ? 'timeout' : (dispatchError.code || 'fetch_error'),
    });
  }

  const { body: respBody, truncated: bodyTruncated, size: respSize } =
    await readBodyCapped(fetchResponse);

  const respHeaders = headersToObject(fetchResponse.headers);

  // Auto-parse JSON so callers don't have to double-decode. Never throws.
  let bodyJson = null;
  if (!bodyTruncated && /json/i.test(respHeaders['content-type'] || '')) {
    try { bodyJson = JSON.parse(respBody); } catch (_) { bodyJson = null; }
  }

  res.json({
    request_url: parsedUrl.toString(),
    request_method: method,
    status: fetchResponse.status,
    status_text: fetchResponse.statusText,
    headers: respHeaders,
    rate_limit: pickRateLimit(respHeaders),
    body: respBody,
    body_json: bodyJson,
    body_truncated: bodyTruncated,
    body_size: respSize,
    duration_ms: Date.now() - started,
    error: null,
  });
}

// ── POST /api/temp/dropbox/request ───────────────────────────────────────────
router.post('/api/temp/dropbox/request', readonlyApiKeyAuth, async (req, res) => {
  return dispatch(req, res, req.body || {});
});

// ── GET /api/temp/dropbox/whoami — one-call smoke test ───────────────────────
router.get('/api/temp/dropbox/whoami', readonlyApiKeyAuth, async (req, res) => {
  return dispatch(req, res, {
    method: 'POST',
    path: '/2/users/get_current_account',
    headers: { 'Content-Type': 'application/json' },
    body: 'null',
  });
});

module.exports = router;
