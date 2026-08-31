// routes/api.temp.ringcentral.js
//
// ⚠️ TEMPORARY ROUTE — delete when the RingCentral call-notes exploration is done. ⚠️
//
// Gives a Claude instance direct HTTP access to the RingCentral API using the
// stored "RingCentral" oauth2 credential (id 9), authenticated by a readonly
// API key (X-Readonly-Api-Key). Sibling of routes/api.temp.dropbox.js and
// routes/api.temp.clio.js, with the differences RingCentral actually warrants:
//
//   1. CONVENTIONAL REST, NOT RPC. Default method is GET (the dropbox sibling
//      defaults POST because Dropbox is RPC-over-POST). RC puts its filters in
//      QUERY STRINGS — `dateFrom`, `dateTo`, `view=Detailed`, `perPage`,
//      `page`, `withRecording` — so this route restores the `query` sugar that
//      the dropbox sibling deliberately dropped.
//   2. TILDE IS LOAD-BEARING. RC paths use `~` to mean "the authenticated
//      account / extension" (…/account/~/extension/~/call-log). `~` is an
//      RFC-3986 unreserved char, so `new URL()` passes it through unescaped —
//      verified. Do NOT percent-encode it; RC 404s on `%7E`.
//   3. TWO HOSTS, ONLY ONE AUTHORIZED. Both /restapi/* (core) and /ai/*
//      (RingSense + Audio AI) live on platform.ringcentral.com, which
//      credential 9's allowed_urls already covers as
//      "https://platform.ringcentral.com/*" — so no credential edit is needed
//      for either. Call-recording `contentUri` values, however, sometimes point
//      at media.ringcentral.com, which is NOT in allowed_urls;
//      buildHeadersForCredential returns {} for those and this route reports it
//      as a credential diagnosis rather than a confusing 401. To enable media
//      pulls, add the host to allowed_urls (see REMOVAL note below).
//   4. RATE LIMITS ARE TIGHT AND BANDED. RC groups endpoints Light (50/min),
//      Medium (40/min), Heavy (10/min). It reports the band and remaining
//      budget in X-Rate-Limit-* headers on every response, and Retry-After on
//      429. Those are surfaced in `rate_limit` — watch them; the call-log and
//      RingSense endpoints are Heavy.
//   5. BINARY MEDIA. Recordings come back as audio/mpeg or audio/wav. Set
//      response_base64:true — the default utf8 decode corrupts binary data
//      irrecoverably (status 200, error null, garbage body). Responses are
//      capped at 10 MB (body_truncated flags it); this route is for
//      exploration, not bulk transfer.
//
// REMOVAL: delete this file (auto-mount handles the rest) and revoke the key.
// If allowed_urls was widened for media pulls, revert that too:
//   UPDATE credentials
//      SET allowed_urls = JSON_ARRAY('https://platform.ringcentral.com/*')
//    WHERE id = 9;
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   POST https://app.4lsg.com/api/temp/ringcentral/request
//   Header: X-Readonly-Api-Key: ycro_…
//   Body: {
//     method?: "GET"|"POST"|...,                    // default GET
//     url?:    "https://platform.ringcentral.com/restapi/v1.0/...", // absolute
//     path?:   "/restapi/v1.0/account/~/call-log",  // shorthand, platform host
//     query?:  { view: "Detailed", perPage: 100 },  // merged into the URL
//     headers?: { ... },                            // auth header is forced
//     body?:        <string or object>,             // objects JSON.stringify'd
//     body_base64?: "<base64 bytes>",               // wins over `body`
//     timeout_ms?: number,                          // default 30000, max 60000
//     response_base64?: true,                       // REQUIRED for audio pulls
//   }
//   Returns: { status, status_text, headers, body, body_json, rate_limit,
//              duration_ms, error, ... }
//
//   Smoke test:
//   GET https://app.4lsg.com/api/temp/ringcentral/whoami   (same header)
//     → /restapi/v1.0/client/info
//
//   Capability probe — answers "can we actually read call notes?" in one call:
//   GET https://app.4lsg.com/api/temp/ringcentral/probe?days=30
//     → runs, in order: client/info → authz-profile (what permissions the app
//       actually holds) → call-log w/ recordings → RingSense record list →
//       RingSense insights for the newest recording id found. Each step
//       reports independently; a failing step does not abort the rest.
//
//   Typical exploration calls:
//   { path: "/restapi/v1.0/account/~/call-log",
//     query: { view: "Detailed", perPage: 50, withRecording: true,
//              dateFrom: "2026-08-01T00:00:00.000Z" } }
//   { path: "/ai/ringsense/v1/public/accounts/~/domains/pbx/records/<id>/insights" }

const express = require('express');
const router = express.Router();

const { readonlyApiKeyAuth } = require('../lib/auth.readonly');
const { buildHeadersForCredential } = require('../lib/credentialInjection');

const PINNED_CREDENTIAL_ID = 9;              // "RingCentral" (oauth2, connected)
const ALLOWED_HOSTS = new Set(['platform.ringcentral.com', 'media.ringcentral.com']);
const API_BASE      = 'https://platform.ringcentral.com';

const VALID_METHOD_RE    = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,32}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS     = 60_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;  // 10 MB — recordings are the reason
const STRIPPED_USER_HEADERS = new Set(['host', 'content-length', 'authorization']);

// RC reports its rate-limit band and budget on EVERY response, not just 429s.
const RATE_LIMIT_HEADER_RE = /^(x-rate-limit-.*|retry-after)$/i;

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
  if (!res.body) return { buffer: Buffer.alloc(0), truncated: false, size: 0 };
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
  return { buffer: Buffer.concat(chunks), truncated, size: total };
}

/**
 * Resolve the target URL from either `url` (absolute) or `path` (platform host
 * implied), merging `query` if supplied. Unlike the dropbox sibling, query
 * sugar IS supported here — RC filters live in the query string.
 * @returns {{url: URL} | {error: string}}
 */
function resolveTargetUrl(body) {
  let raw;

  if (typeof body.url === 'string' && body.url.length) {
    raw = body.url;
  } else if (typeof body.path === 'string' && body.path.length) {
    raw = API_BASE + (body.path.startsWith('/') ? body.path : `/${body.path}`);
  } else {
    return { error: 'Missing url (absolute) or path (e.g. "/restapi/v1.0/client/info")' };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: `Invalid url: ${raw}` };
  }

  // Merge `query` sugar. Values are appended, not replaced, so a caller can
  // pass repeated filters as an array (RC accepts multi-valued query params).
  if (body.query && typeof body.query === 'object' && !Array.isArray(body.query)) {
    for (const [k, v] of Object.entries(body.query)) {
      if (v == null) continue;
      if (Array.isArray(v)) {
        for (const item of v) if (item != null) parsed.searchParams.append(k, String(item));
      } else {
        parsed.searchParams.append(k, String(v));
      }
    }
  }

  // Host pin (defence-in-depth over allowed_urls glob matching — that matcher
  // turns '*' into '.*' without escaping dots, so it is deliberately not the
  // only gate here).
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.host)) {
    return { error: `URL rejected: only https://{${[...ALLOWED_HOSTS].join(', ')}} are allowed.` };
  }

  return { url: parsed };
}

/**
 * Explain an empty header result from buildHeadersForCredential (it fails
 * silently by design — returns {} — which would otherwise surface as a
 * confusing 401 from RingCentral).
 */
async function diagnoseCredential(db, targetUrl) {
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
    // The specific trap this route is most likely to hit: recording contentUri
    // on media.ringcentral.com, which allowed_urls does not cover.
    let host = '';
    try { host = new URL(targetUrl).host; } catch (_) {}
    if (host && host !== 'platform.ringcentral.com') {
      return {
        reason: `Credential ${PINNED_CREDENTIAL_ID} yielded no auth header for host ${host}. ` +
                `allowed_urls covers platform.ringcentral.com only. To pull media, run: ` +
                `UPDATE credentials SET allowed_urls = JSON_ARRAY('https://platform.ringcentral.com/*','https://media.ringcentral.com/*') WHERE id = 9;`,
        credential: row,
      };
    }
    return {
      reason: `Credential ${PINNED_CREDENTIAL_ID} yielded no auth header — token refresh failed or URL fell outside allowed_urls. See server logs for the [credentialInjection] warning.`,
      credential: row,
    };
  } catch (e) {
    return { reason: `Credential lookup failed: ${e.message}` };
  }
}

// ── Core: perform one request, return a plain result object ──────────────────
// Returns { ok:false, http_status, payload } for caller-error cases so the
// route handlers can choose a status code, and { ok:true, payload } otherwise.
async function performRequest(db, body) {
  const started = Date.now();

  // RC is conventional REST; default GET (the dropbox sibling defaults POST).
  const method = String(body.method || 'GET').toUpperCase();
  if (!VALID_METHOD_RE.test(method)) {
    return { ok: false, http_status: 400, payload: { error: `Invalid method: ${method}` } };
  }

  const resolved = resolveTargetUrl(body);
  if (resolved.error) return { ok: false, http_status: 400, payload: { error: resolved.error } };
  const parsedUrl = resolved.url;

  // Body: base64 (binary) wins over string/object.
  let reqBody = null;
  let bodyWasObject = false;
  if (typeof body.body_base64 === 'string' && body.body_base64.length) {
    try {
      reqBody = Buffer.from(body.body_base64, 'base64');
    } catch {
      return { ok: false, http_status: 400, payload: { error: 'body_base64 is not valid base64' } };
    }
  } else if (body.body !== undefined) {
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
    authHeaders = await buildHeadersForCredential(db, PINNED_CREDENTIAL_ID, parsedUrl.toString());
  } catch (e) {
    return { ok: false, http_status: 500, payload: { error: `RingCentral credential injection threw: ${e.message}` } };
  }
  if (!authHeaders || !authHeaders.Authorization) {
    const diag = await diagnoseCredential(db, parsedUrl.toString());
    return { ok: false, http_status: 500, payload: { error: diag.reason, credential: diag.credential || null } };
  }

  const defaults = { Accept: 'application/json' };
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
    return {
      ok: true,
      payload: {
        request_url: parsedUrl.toString(),
        request_method: method,
        status: null, status_text: null, headers: {}, body: '', body_json: null,
        rate_limit: {},
        duration_ms: Date.now() - started,
        error: isAbort ? `Request timed out after ${timeoutMs}ms`
                       : (dispatchError.message || String(dispatchError)),
        error_type: isAbort ? 'timeout' : (dispatchError.code || 'fetch_error'),
      },
    };
  }

  const { buffer: respBuffer, truncated: bodyTruncated, size: respSize } =
    await readBodyCapped(fetchResponse);

  const respHeaders = headersToObject(fetchResponse.headers);

  // Binary-safe path: base64 the raw bytes, skip JSON parsing.
  const wantBase64 = body.response_base64 === true;
  const respBody = respBuffer.toString(wantBase64 ? 'base64' : 'utf8');

  // Auto-parse JSON so callers don't have to double-decode. Never throws.
  let bodyJson = null;
  if (!wantBase64 && !bodyTruncated && /json/i.test(respHeaders['content-type'] || '')) {
    try { bodyJson = JSON.parse(respBody); } catch (_) { bodyJson = null; }
  }

  // redirect:'manual' means a 3xx arrives here unfollowed — RC uses this for
  // recording content. Surface the target so the caller can re-issue.
  const redirectTo = (fetchResponse.status >= 300 && fetchResponse.status < 400)
    ? (respHeaders.location || null)
    : null;

  return {
    ok: true,
    payload: {
      request_url: parsedUrl.toString(),
      request_method: method,
      status: fetchResponse.status,
      status_text: fetchResponse.statusText,
      headers: respHeaders,
      rate_limit: pickRateLimit(respHeaders),
      redirect_to: redirectTo,
      body: respBody,
      body_encoding: wantBase64 ? 'base64' : 'utf8',
      body_json: bodyJson,
      body_truncated: bodyTruncated,
      body_size: respSize,
      duration_ms: Date.now() - started,
      error: null,
    },
  };
}

async function dispatch(req, res, body) {
  const result = await performRequest(req.db, body);
  if (!result.ok) return res.status(result.http_status).json(result.payload);
  return res.json(result.payload);
}

// ── POST /api/temp/ringcentral/request ───────────────────────────────────────
router.post('/api/temp/ringcentral/request', readonlyApiKeyAuth, async (req, res) => {
  return dispatch(req, res, req.body || {});
});

// ── GET /api/temp/ringcentral/whoami — one-call smoke test ───────────────────
router.get('/api/temp/ringcentral/whoami', readonlyApiKeyAuth, async (req, res) => {
  return dispatch(req, res, { method: 'GET', path: '/restapi/v1.0/client/info' });
});

// ── GET /api/temp/ringcentral/probe — capability probe ───────────────────────
//
// Answers "can this credential actually read call notes?" without requiring
// five hand-rolled round trips. Steps run sequentially and independently: a
// 403 on one does not abort the others, because WHICH step fails is the
// diagnosis. Step 5 chains off step 3 to test the community-reported claim
// that RingSense's `sourceRecordId` is the call-log recording id.
router.get('/api/temp/ringcentral/probe', readonlyApiKeyAuth, async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const dateFrom = new Date(Date.now() - days * 86400_000).toISOString();
  const steps = [];

  async function step(name, note, body) {
    const r = await performRequest(req.db, body);
    const p = r.ok ? r.payload : r.payload;
    steps.push({
      step: name,
      note,
      request_url: p.request_url || null,
      status: r.ok ? p.status : (r.http_status || null),
      error: p.error || null,
      rate_limit: p.rate_limit || {},
      body_json: r.ok ? p.body_json : null,
      body_snippet: r.ok && !p.body_json && typeof p.body === 'string'
        ? p.body.slice(0, 800) : null,
    });
    return r.ok ? p : null;
  }

  await step('client_info', 'Who is this token? Confirms auth works at all.',
    { path: '/restapi/v1.0/client/info' });

  await step('authz_profile', 'Which permissions did RC actually grant this app? ReadCallLog / ReadCallRecording / RingSense are the ones that matter.',
    { path: '/restapi/v1.0/account/~/extension/~/authz-profile' });

  const callLog = await step('call_log',
    'Recent account calls with recordings attached. Recording ids feed step 5.',
    { path: '/restapi/v1.0/account/~/call-log',
      query: { view: 'Detailed', perPage: 10, withRecording: true, dateFrom } });

  await step('ringsense_records',
    'Does the RingSense record list answer at all? 403 here = no RingSense app scope; 404 = wrong path; 200 with empty list = scope OK but no licensed/processed records.',
    { path: '/ai/ringsense/v1/public/accounts/~/domains/pbx/records',
      query: { recordFrom: dateFrom, perPage: 10 } });

  // Chain: pull the newest recording id out of the call log, if any.
  let recordingId = null;
  const records = callLog && callLog.body_json && Array.isArray(callLog.body_json.records)
    ? callLog.body_json.records : [];
  for (const rec of records) {
    if (rec && rec.recording && rec.recording.id) { recordingId = String(rec.recording.id); break; }
  }

  if (recordingId) {
    await step('ringsense_insights',
      `Insights for recording id ${recordingId}. Tests whether sourceRecordId == call-log recording.id.`,
      { path: `/ai/ringsense/v1/public/accounts/~/domains/pbx/records/${encodeURIComponent(recordingId)}/insights` });
  } else {
    steps.push({
      step: 'ringsense_insights',
      note: 'SKIPPED — no recording id found in the call-log window. Widen ?days= or confirm call recording is enabled.',
      status: null, error: null, rate_limit: {}, body_json: null, body_snippet: null,
    });
  }

  res.json({
    probe: 'ringcentral-call-notes',
    credential_id: PINNED_CREDENTIAL_ID,
    window_days: days,
    date_from: dateFrom,
    call_log_records: records.length,
    recording_id_used: recordingId,
    steps,
  });
});

module.exports = router;
