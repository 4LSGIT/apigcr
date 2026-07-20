// routes/api.temp.zohosign.js
//
// ⚠️ TEMPORARY ROUTE — delete WHEN the 9011 diagnosis is DONE. ⚠️
//
// Gives a Claude instance direct HTTP access to the Zoho Sign API using the
// stored Zoho Sign oauth2 credential (id 13), authenticated by a readonly API
// key (X-Readonly-Api-Key). Purpose: empirically bisect the submit-time
// "You have entered too many characters" (Zoho code 9011) failure that only
// afflicts uploaded PDFs — the account is API-only, so Zoho's web UI cannot
// be used to inspect the failed drafts.
//
// This is routes/api.temp.gcal.js adapted, with THREE deliberate differences:
//
//   1. AUTH: does NOT use lib/credentialInjection. Zoho rejects `Bearer`; it
//      requires `Authorization: Zoho-oauthtoken <token>` — the exact reason
//      services/esign/zohoSignProvider.js bypasses credentialInjection too
//      (see its header + AI_CONTEXT §21). We call
//      oauthService.getValidAccessToken(db, 13) directly, same as the provider.
//   2. HOST PIN instead of checkUrlScope: credential 13's allowed_urls is []
//      (the provider never consults it), so scope-checking is meaningless
//      here. The route hard-rejects any host other than sign.zoho.com — this
//      key can talk to Zoho Sign and nothing else.
//   3. body_base64: Zoho's create call is multipart. The caller builds the
//      multipart body itself (own boundary, Content-Type supplied via
//      `headers`) and ships it base64 so binary PDFs survive JSON transport.
//
// REMOVAL: delete this file (auto-mount handles the rest) and revoke the key.
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   POST https://app.4lsg.com/api/temp/zohosign/request
//   Header: X-Readonly-Api-Key: ycro_…
//   Body: {
//     method?: "GET"|"POST"|...,                       // default GET
//     url:     "https://sign.zoho.com/api/v1/...",     // REQUIRED, absolute
//     headers?: { "Content-Type": "..." },             // auth header is forced
//     body?:        "<string or object>",              // objects JSON.stringify'd
//     body_base64?: "<base64 bytes>",                  // wins over `body`
//     timeout_ms?: number,                             // default 30000, max 60000
//   }
//   Returns: { status, status_text, headers, body, duration_ms, error, ... }

const express = require('express');
const router = express.Router();

const { readonlyApiKeyAuth } = require('../lib/auth.readonly');
const { getValidAccessToken } = require('../services/oauthService');

const PINNED_CREDENTIAL_ID = 13;          // Zoho Sign (oauth2, connected)
const ALLOWED_HOST         = 'sign.zoho.com';

const VALID_METHOD_RE    = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,32}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS     = 60_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;   // 5 MB
const STRIPPED_USER_HEADERS = new Set(['host', 'content-length', 'authorization']);

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

// ── POST /api/temp/zohosign/request ──────────────────────────────────────────
router.post('/api/temp/zohosign/request', readonlyApiKeyAuth, async (req, res) => {
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
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: `Invalid url: ${url}` });
  }
  // Host pin: this route talks to Zoho Sign and NOTHING else (see header §2).
  if (parsedUrl.protocol !== 'https:' || parsedUrl.host !== ALLOWED_HOST) {
    return res.status(400).json({ error: `URL rejected: only https://${ALLOWED_HOST} is allowed.` });
  }

  // Body: base64 (binary/multipart) wins over string/object.
  let reqBody = null;
  if (typeof body.body_base64 === 'string' && body.body_base64.length) {
    try {
      reqBody = Buffer.from(body.body_base64, 'base64');
    } catch {
      return res.status(400).json({ error: 'body_base64 is not valid base64' });
    }
  } else if (body.body != null) {
    reqBody = (typeof body.body === 'string') ? body.body : JSON.stringify(body.body);
  }

  const userHeaders = sanitizeUserHeaders(body.headers);

  let timeoutMs = Number(body.timeout_ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
  timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);

  // ── Auth: Zoho-oauthtoken via oauthService (NOT Bearer — see header §1) ────
  let token;
  try {
    token = await getValidAccessToken(req.db, PINNED_CREDENTIAL_ID);
  } catch (e) {
    return res.status(500).json({ error: `Zoho token acquisition failed: ${e.message}` });
  }
  if (!token) {
    return res.status(500).json({ error: `Credential ${PINNED_CREDENTIAL_ID} yielded no access token.` });
  }
  const finalHeaders = { ...userHeaders, Authorization: `Zoho-oauthtoken ${token}` };

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
      status: null, status_text: null, headers: {}, body: '',
      duration_ms: Date.now() - started,
      error: isAbort ? `Request timed out after ${timeoutMs}ms`
                     : (dispatchError.message || String(dispatchError)),
      error_type: isAbort ? 'timeout' : (dispatchError.code || 'fetch_error'),
    });
  }

  const { body: respBody, truncated: bodyTruncated, size: respSize } =
    await readBodyCapped(fetchResponse);

  res.json({
    status: fetchResponse.status,
    status_text: fetchResponse.statusText,
    headers: headersToObject(fetchResponse.headers),
    body: respBody,
    body_truncated: bodyTruncated,
    body_size: respSize,
    duration_ms: Date.now() - started,
    error: null,
  });
});

module.exports = router;