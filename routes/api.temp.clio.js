// routes/api.temp.clio.js
//
// ⚠️ TEMPORARY ROUTE — delete when the Clio exploration is done. ⚠️
//
// Gives a Claude instance direct HTTP access to the Clio Manage API using the
// stored "Clio YisraCase" oauth2 credential (id 7), authenticated by a readonly
// API key (X-Readonly-Api-Key). Sibling of routes/api.temp.zohosign.js, with
// the differences Clio's API actually warrants:
//
//   1. AUTH: Clio uses standard `Authorization: Bearer <token>`, so this route
//      goes through lib/credentialInjection.buildHeadersForCredential() — the
//      SAME path production code uses. (Zoho needed a bypass because it demands
//      `Zoho-oauthtoken`; Clio does not.) That means allowed_urls on credential
//      7 (`https://app.clio.com/*`) is enforced for free. buildHeadersForCredential
//      returns {} on any failure, so this route detects the empty result and
//      reports WHY (oauth_status, scope) instead of letting Clio answer 401.
//   2. HOST PIN as defence-in-depth: allowed_urls patterns are glob→regex
//      converted WITHOUT escaping `.`, so `https://app.clio.com/*` also matches
//      e.g. `https://appXclioYcom/…`. The explicit host pin closes that.
//   3. PATH SUGAR: Clio URLs are long and query-heavy (`fields=`, `limit=`,
//      `order=`). Callers may pass `path` + `query` instead of a full `url`.
//   4. body_json: response body is auto-parsed when Clio returns JSON, so the
//      caller doesn't have to re-parse a string. Raw `body` is always present.
//   5. rate_limit: Clio's X-RateLimit-* / Retry-After headers are surfaced in a
//      dedicated field — they're the first thing that matters when a burst of
//      exploratory calls starts failing.
//
// NOTE: Clio document *uploads* PUT to an AWS S3 URL returned by Clio, not to
// app.clio.com. The host pin blocks that second leg on purpose — this key talks
// to Clio and nothing else.
//
// REMOVAL: delete this file (auto-mount handles the rest) and revoke the key.
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   POST https://app.4lsg.com/api/temp/clio/request
//   Header: X-Readonly-Api-Key: ycro_…
//   Body: {
//     method?: "GET"|"POST"|"PATCH"|"DELETE"|...,      // default GET
//     url?:    "https://app.clio.com/api/v4/...",      // absolute; OR use path
//     path?:   "/api/v4/matters",                      // shorthand, host implied
//     query?:  { limit: 5, fields: "id,display_number" },
//     headers?: { "Content-Type": "..." },             // auth header is forced
//     body?:        <string or object>,                // objects JSON.stringify'd
//     body_base64?: "<base64 bytes>",                  // wins over `body`
//     timeout_ms?: number,                             // default 30000, max 60000
//   }
//   Returns: { status, status_text, headers, body, body_json, rate_limit,
//              duration_ms, error, ... }
//
//   Smoke test:
//   GET https://app.4lsg.com/api/temp/clio/whoami   (same header)
//     → equivalent to /api/v4/users/who_am_i?fields=id,name,email

const express = require('express');
const router = express.Router();

const { readonlyApiKeyAuth } = require('../lib/auth.readonly');
const { buildHeadersForCredential } = require('../lib/credentialInjection');

const PINNED_CREDENTIAL_ID = 7;              // "Clio YisraCase" (oauth2, connected)
const ALLOWED_HOST         = 'app.clio.com';
const API_BASE             = `https://${ALLOWED_HOST}`;

const VALID_METHOD_RE    = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,32}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS     = 60_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;   // 5 MB
const STRIPPED_USER_HEADERS = new Set(['host', 'content-length', 'authorization']);

const RATE_LIMIT_HEADER_RE = /^(x-ratelimit-|retry-after$)/i;

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
 * Resolve the target URL from either `url` (absolute) or `path` + `query`.
 * @returns {{url: URL} | {error: string}}
 */
function resolveTargetUrl(body) {
  let raw;

  if (typeof body.url === 'string' && body.url.length) {
    raw = body.url;
  } else if (typeof body.path === 'string' && body.path.length) {
    raw = API_BASE + (body.path.startsWith('/') ? body.path : `/${body.path}`);
  } else {
    return { error: 'Missing url (absolute) or path (e.g. "/api/v4/matters")' };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: `Invalid url: ${raw}` };
  }

  // Host pin: this route talks to Clio Manage and NOTHING else (header §2).
  if (parsed.protocol !== 'https:' || parsed.host !== ALLOWED_HOST) {
    return { error: `URL rejected: only https://${ALLOWED_HOST} is allowed.` };
  }

  // Merge `query` on top of anything already in the URL's search string.
  if (body.query && typeof body.query === 'object' && !Array.isArray(body.query)) {
    for (const [k, v] of Object.entries(body.query)) {
      if (v == null) continue;
      if (Array.isArray(v)) {
        // Clio takes repeated params for array filters (e.g. id[]=1&id[]=2).
        parsed.searchParams.delete(k);
        for (const item of v) parsed.searchParams.append(k, String(item));
      } else {
        parsed.searchParams.set(k, String(v));
      }
    }
  }

  return { url: parsed };
}

/**
 * Explain an empty header result from buildHeadersForCredential. That helper
 * fails silently by design (returns {}), which would otherwise surface as a
 * confusing 401 from Clio. Read the row directly and say what's actually wrong.
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

  const method = String(body.method || 'GET').toUpperCase();
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
  } else if (body.body != null) {
    bodyWasObject = (typeof body.body === 'object');
    reqBody = bodyWasObject ? JSON.stringify(body.body) : String(body.body);
  }

  const userHeaders = sanitizeUserHeaders(body.headers);

  let timeoutMs = Number(body.timeout_ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
  timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);

  // ── Auth: production path (Bearer via credentialInjection — header §1) ─────
  let authHeaders;
  try {
    authHeaders = await buildHeadersForCredential(req.db, PINNED_CREDENTIAL_ID, parsedUrl.toString());
  } catch (e) {
    return res.status(500).json({ error: `Clio credential injection threw: ${e.message}` });
  }
  if (!authHeaders || !authHeaders.Authorization) {
    const diag = await diagnoseCredential(req.db);
    return res.status(500).json({ error: diag.reason, credential: diag.credential || null });
  }

  // Sensible Clio defaults, overridable by the caller's headers.
  const defaults = { Accept: 'application/json' };
  if (reqBody != null && bodyWasObject) defaults['Content-Type'] = 'application/json';

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

// ── POST /api/temp/clio/request ──────────────────────────────────────────────
router.post('/api/temp/clio/request', readonlyApiKeyAuth, async (req, res) => {
  return dispatch(req, res, req.body || {});
});

// ── GET /api/temp/clio/whoami — one-call smoke test ──────────────────────────
router.get('/api/temp/clio/whoami', readonlyApiKeyAuth, async (req, res) => {
  return dispatch(req, res, {
    method: 'GET',
    path: '/api/v4/users/who_am_i',
    query: { fields: 'id,name,email,enabled,subscription_type' },
  });
});

module.exports = router;