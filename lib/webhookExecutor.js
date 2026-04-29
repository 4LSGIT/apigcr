// lib/webhookExecutor.js
//
// Shared outbound HTTP webhook helper. Single source of truth used by:
//   - lib/job_executor.js     → workflow `webhook` step + scheduled-job `webhook` flavor
//   - lib/sequenceEngine.js   → sequence `webhook` step (via executeWebhookAction wrapper)
//
// What this owns:
//   - credential injection via lib/credentialInjection (allowed_urls scope check
//     happens there)
//   - configurable timeout, capped at 120 s
//   - JSON body serialization
//   - JSON-or-text response parsing
//   - response truncation (10000 bytes) for log-friendliness
//   - throwing on non-2xx with err.status_code attached, so caller's
//     error_policy / retry layer can branch on transient vs permanent
//
// What this does NOT own:
//   - placeholder resolution — caller is expected to pass a fully-resolved
//     url / headers / body
//   - retry policy — caller's surrounding loop decides retry behavior
//   - logging — caller decides what (if anything) to persist
//
// Per-engine quirks deliberately preserved by callers:
//   - executeJob defaults method to 'GET' (legacy); helper default is 'POST'.
//     executeJob passes method explicitly so its old default is preserved.
//   - sequence's executeWebhookAction always sends '{}' body when no body
//     is supplied. The wrapper enforces that before calling this helper;
//     this helper itself sends no body when `body` is null/undefined,
//     matching the old axios-with-`data: undefined` behavior.

const fetch = require('node-fetch');
const { buildHeadersForCredential } = require('./credentialInjection');

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS     = 120000;
const MAX_RESPONSE_BODY_BYTES = 10000;
const ALLOWED_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Execute an outbound HTTP webhook with optional credential injection.
 *
 * @param {object} db
 * @param {object} opts
 *   @param {string} opts.url             — required, absolute URL
 *   @param {string} [opts.method]        — default 'POST'; one of GET/POST/PUT/PATCH/DELETE
 *   @param {number} [opts.credential_id] — FK into credentials table; null/missing = no auth header
 *   @param {object} [opts.headers]       — extra static request headers; merged AFTER auth headers,
 *                                           so callers can override Content-Type but not the auth
 *                                           header that came from the credential
 *   @param {*}      [opts.body]          — request body; objects → JSON.stringify, strings → raw,
 *                                           null/undefined → no body. Ignored for GET/DELETE.
 *   @param {number} [opts.timeout_ms]    — default 30000, capped at 120000. Non-positive / NaN →
 *                                           default.
 *
 * @returns {Promise<{status_code:number, headers:object, data:*, response_body_truncated:string}>}
 *   On 2xx: resolves with response details.
 *     - `data` is the parsed JSON when the response body parses as JSON OR the Content-Type
 *       indicates JSON; otherwise the raw text. (axios-style heuristic.)
 *     - `response_body_truncated` is the raw text body, truncated at 10000 bytes.
 *
 * @throws Error on non-2xx response or network/transport error.
 *   - HTTP errors: `err.status_code` is the response status; message is `webhook HTTP X: <500-char body>`
 *   - Network errors: vanilla Error from node-fetch (no `.status_code`)
 */
async function executeWebhook(db, opts) {
  const url = opts && opts.url;
  if (!url || typeof url !== 'string') {
    throw new Error('webhook: url is required');
  }

  const rawMethod = opts.method || 'POST';
  const method = String(rawMethod).toUpperCase();
  if (!ALLOWED_HTTP_METHODS.includes(method)) {
    throw new Error(`webhook: method must be one of ${ALLOWED_HTTP_METHODS.join(', ')} (got ${rawMethod})`);
  }

  // Static headers from caller — must be plain object; arrays/null/undefined → empty.
  const staticHeaders = (opts.headers && typeof opts.headers === 'object' && !Array.isArray(opts.headers))
    ? opts.headers
    : {};

  // Auth headers via credential injection. Pass URL so allowed_urls scope check runs.
  const authHeaders = await buildHeadersForCredential(db, opts.credential_id, url);

  // Header merge order: defaults < caller-provided static < auth.
  // Auth wins because (a) the credential's header is the whole point of using
  // it, and (b) protects against caller accidentally overriding it.
  const headers = {
    'Content-Type': 'application/json',
    ...staticHeaders,
    ...authHeaders,
  };

  // Timeout: positive integer up to 120 s; default otherwise.
  const rawTimeout = Number(opts.timeout_ms);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? Math.min(rawTimeout, MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;

  const fetchOptions = { method, headers, timeout: timeoutMs };

  // Body — only for body-bearing methods.  null/undefined → no body sent
  // (preserves executeJob/axios's old "data: undefined" semantics).  Sequence
  // wrapper coerces null→{} before calling so its old behavior is preserved.
  if (!['GET', 'DELETE'].includes(method)) {
    const b = opts.body;
    if (b == null) {
      // omit
    } else if (typeof b === 'object') {
      fetchOptions.body = JSON.stringify(b);
    } else {
      fetchOptions.body = String(b);
    }
  }

  const response = await fetch(url, fetchOptions);
  const responseText = await response.text();
  const truncated = responseText.slice(0, MAX_RESPONSE_BODY_BYTES);

  if (!response.ok) {
    const err = new Error(`webhook HTTP ${response.status}: ${truncated.slice(0, 500)}`);
    err.status_code = response.status;
    throw err;
  }

  // Best-effort JSON parse so the helper's `data` field is useful as an
  // axios-style structured response. Two signals trigger the parse attempt:
  //   1. Content-Type indicates JSON (application/json or *+json)
  //   2. Body starts with '{' or '[' — covers servers that omit Content-Type
  // Falls back to raw text on any parse error.
  let parsedData = responseText;
  const ct = (response.headers && response.headers.get && response.headers.get('content-type')) || '';
  const looksJsonByCt = ct.includes('application/json') || ct.includes('+json');
  const looksJsonByBody = !!responseText && (responseText[0] === '{' || responseText[0] === '[');
  if (looksJsonByCt || looksJsonByBody) {
    try { parsedData = JSON.parse(responseText); } catch { /* leave as raw text */ }
  }

  // Headers as plain object for downstream consumers.  node-fetch's Headers
  // exposes .raw() (multi-value array per key) but most callers want a flat
  // string; use entries() for the flat shape.
  const headersOut = {};
  if (response.headers && typeof response.headers.entries === 'function') {
    for (const [k, v] of response.headers.entries()) headersOut[k] = v;
  }

  return {
    status_code: response.status,
    headers: headersOut,
    data: parsedData,
    response_body_truncated: truncated,
  };
}

module.exports = {
  executeWebhook,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  ALLOWED_HTTP_METHODS,
};