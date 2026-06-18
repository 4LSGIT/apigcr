// routes/api.temp_gcal.js
//
// ⚠️ TEMPORARY ROUTE — move to local WHEN DONE. ⚠️
//
// Gives a Claude instance free-reign HTTP access to the Google APIs using
// the stored Google Workspace oauth2 credential (id 11), authenticated by a
// readonly API key (X-Readonly-Api-Key) instead of the SU JWT gate.
//
// It is a stripped-down clone of routes/admin.apiTester.js's send-request
// handler: same SSRF gate, same credential injection, same response-cap /
// timeout logic — but:
//   • auth is readonlyApiKeyAuth (DB-backed temp key), not superuserOnlyFor
//   • the credential is HARD-PINNED to id 11 (caller cannot pick another)
//   • no admin_audit_log writes (the readonly key's own usage counter +
//     server logs are enough for a throwaway tool)
//
// Credential 11 is type=oauth2, oauth_status=connected, with allowed_urls:
//   https://gmail.googleapis.com/*, https://oauth2.googleapis.com/*,
//   https://www.googleapis.com/*
// Google Calendar v3 lives under https://www.googleapis.com/calendar/v3/...
// so it satisfies the credential's allowed_urls scope. Requests to hosts
// outside allowed_urls are hard-rejected by checkUrlScope (good).
//
// REMOVAL: delete this file and revoke the temp readonly key.
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   POST https://app.4lsg.com/api/temp/gcal/request
//   Header: X-Readonly-Api-Key: ycro_…
//   Body: {
//     method?: "GET"|"POST"|"PUT"|"PATCH"|"DELETE"|...,   // default GET
//     url:     "https://www.googleapis.com/calendar/v3/...",  // REQUIRED, absolute
//     headers?: { ... },          // optional extra headers (auth header is forced)
//     body?:    "<string or object>",  // objects are JSON.stringify'd
//     timeout_ms?: number,        // default 30000, max 60000
//     follow_redirects?: bool     // default false
//   }
//   Returns: { status, status_text, headers, body, duration_ms,
//              credential_injected, error, error_type }

const express = require('express');
const fetch = require('node-fetch');
const router = express.Router();

const { readonlyApiKeyAuth } = require('../lib/auth.readonly');
const { assertSafeUrl } = require('../lib/ssrfGuard');
const {
  loadCredential,
  buildHeadersForCredential,
  checkUrlScope,
} = require('../lib/credentialInjection');

const PINNED_CREDENTIAL_ID = 11;

const VALID_METHOD_RE     = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,32}$/;
const DEFAULT_TIMEOUT_MS  = 30_000;
const MAX_TIMEOUT_MS      = 60_000;
const MAX_RESPONSE_BYTES  = 5 * 1024 * 1024;  // 5 MB
const STRIPPED_USER_HEADERS = new Set(['host', 'content-length']);

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

// ── POST /api/temp/gcal/request ──────────────────────────────────────────────
router.post('/api/temp/gcal/request', readonlyApiKeyAuth, async (req, res) => {
  const started = Date.now();
  const body = req.body || {};

  const method = String(body.method || 'GET').toUpperCase();
  if (!VALID_METHOD_RE.test(method)) {
    return res.status(400).json({ error: `Invalid method: ${method}` });
  }

  const url = body.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing url (absolute URL required)' });
  }

  // Parse + SSRF gate (blocks loopback / RFC1918 / metadata / etc).
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: `Invalid url: ${url}` });
  }
  try {
    await assertSafeUrl(parsedUrl.toString());
  } catch (e) {
    return res.status(400).json({ error: `URL rejected by SSRF guard: ${e.message}` });
  }

  // Normalize body: allow objects (auto-JSON) or strings.
  let reqBody = null;
  if (body.body != null) {
    reqBody = (typeof body.body === 'string') ? body.body : JSON.stringify(body.body);
  }

  const userHeaders = sanitizeUserHeaders(body.headers);
  const followRedirects = !!body.follow_redirects;

  let timeoutMs = Number(body.timeout_ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
  timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);

  // ── Credential (hard-pinned to id 11) ──────────────────────────────────────
  let cred;
  try {
    cred = await loadCredential(req.db, PINNED_CREDENTIAL_ID);
  } catch (e) {
    return res.status(500).json({ error: `Credential load failed: ${e.message}` });
  }
  if (!cred) {
    return res.status(500).json({ error: `Pinned credential ${PINNED_CREDENTIAL_ID} not found` });
  }

  // allowed_urls / scope enforcement (will reject hosts outside the cred's list).
  const scope = checkUrlScope(cred, parsedUrl.toString());
  if (!scope.ok) {
    return res.status(400).json({
      error: `Credential "${cred.name}" rejected for this URL: ${scope.reason}`,
    });
  }
  if (cred.type === 'oauth2' && cred.oauth_status !== 'connected') {
    return res.status(400).json({
      error: `Credential "${cred.name}" not connected (oauth_status=${cred.oauth_status}).`,
    });
  }

  let authHeaders;
  try {
    authHeaders = await buildHeadersForCredential(req.db, cred.id, parsedUrl.toString());
  } catch (e) {
    return res.status(500).json({ error: `Credential header build failed: ${e.message}` });
  }
  const credentialInjected = Object.keys(authHeaders).length > 0;
  if (!credentialInjected) {
    return res.status(500).json({
      error: `Credential "${cred.name}" produced no auth headers — check server logs (oauth refresh failure, etc).`,
    });
  }

  // Credential headers win over user-supplied.
  const finalHeaders = { ...userHeaders, ...authHeaders };

  // ── Dispatch ───────────────────────────────────────────────────────────────
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let fetchResponse;
  let dispatchError = null;
  try {
    const opts = {
      method,
      headers: finalHeaders,
      redirect: followRedirects ? 'follow' : 'manual',
      signal: controller.signal,
      timeout: timeoutMs,
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
    const errorMsg = isAbort
      ? `Request timed out after ${timeoutMs}ms`
      : (dispatchError.message || String(dispatchError));
    return res.json({
      status: null, status_text: null, headers: {}, body: '',
      duration_ms: Date.now() - started,
      error: errorMsg, error_type: errorType,
      credential_injected: credentialInjected,
    });
  }

  const { body: respBody, truncated: bodyTruncated, size: respSize } =
    await readBodyCapped(fetchResponse);
  const respHeaders = headersToObject(fetchResponse.headers);
  const durationMs = Date.now() - started;

  const redirectLocation =
    (!followRedirects && fetchResponse.status >= 300 && fetchResponse.status < 400)
      ? (respHeaders.location || respHeaders.Location || null)
      : null;

  res.json({
    status: fetchResponse.status,
    status_text: fetchResponse.statusText,
    headers: respHeaders,
    body: respBody,
    body_truncated: bodyTruncated,
    body_size: respSize,
    duration_ms: durationMs,
    redirect_location: redirectLocation,
    credential_injected: credentialInjected,
    error: null,
  });
});

module.exports = router;