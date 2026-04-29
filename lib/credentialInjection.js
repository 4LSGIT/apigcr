// lib/credentialInjection.js
//
// Shared HTTP credential injection for outbound requests. Used by:
//   - services/hookService.js    — YisraHook HTTP targets
//   - lib/sequenceEngine.js      — sequence 'webhook' step type
//   - lib/webhookExecutor.js     — workflow webhook step + scheduled-job webhook
//
// Slice 2 added oauth2 support. The synchronous buildAuthHeaders() can't
// handle oauth2 (which may need a DB round-trip to refresh tokens), so the
// dispatcher path differs:
//   - internal / bearer / api_key / basic — synchronous, via buildAuthHeaders.
//   - oauth2                              — async, via buildHeadersForCredential
//                                           which calls oauthService.getValidAccessToken().
//
// Call sites all use buildHeadersForCredential(db, credentialId, url) — that
// contract is unchanged. buildAuthHeaders is kept exported for backward
// compat (any direct callers remain on the sync path), but it returns {} +
// warns if handed an oauth2 credential.
//
// URL-scope check (allowed_urls / APP_URL host equality for internal) was
// previously inline in buildAuthHeaders; Slice 2 hoisted it into checkUrlScope
// so oauth2 inherits the same enforcement without duplication.

// ─────────────────────────────────────────────────────────────
// Internal-credential URL-scope check (unchanged from prior slice)
//
// See prior commit for the full rationale on fail-closed behavior for
// 'internal' type and the bypass-defeating URL parser comparison.
// ─────────────────────────────────────────────────────────────

/**
 * Check if `targetUrl` resolves to the same origin as APP_URL.
 *
 * Rules:
 *   - protocol must match (http vs https)
 *   - hostname must match exactly
 *   - port must match IF APP_URL pins one explicitly; otherwise port is
 *     not enforced
 *   - path is NOT considered
 *
 * Returns false on any parse failure or env misconfiguration.
 */
function targetMatchesAppUrl(targetUrl) {
  const appUrl = process.env.APP_URL;
  if (!appUrl || typeof appUrl !== 'string') return false;
  if (!targetUrl || typeof targetUrl !== 'string') return false;

  let target, app;
  try { target = new URL(targetUrl); } catch { return false; }
  try { app    = new URL(appUrl);    } catch { return false; }

  if (target.protocol !== app.protocol) return false;
  if (target.hostname !== app.hostname) return false;
  if (app.port && target.port !== app.port) return false;

  return true;
}

function parseAllowedUrls(credential) {
  return typeof credential.allowed_urls === 'string'
    ? JSON.parse(credential.allowed_urls)
    : credential.allowed_urls;
}

function matchesAnyPattern(url, patterns) {
  return patterns.some((pattern) => {
    const regex = new RegExp('^' + String(pattern).replace(/\*/g, '.*') + '$');
    return regex.test(url);
  });
}

/**
 * Centralized URL-scope check shared by the sync (buildAuthHeaders) and
 * async (buildHeadersForCredential — for oauth2) paths.
 *
 * Behavior matches the pre-Slice-2 logic in buildAuthHeaders exactly:
 *   - 'internal': fail closed. Enforce allowed_urls if populated; else
 *     require APP_URL host equality. Empty URL → reject.
 *   - 'bearer' / 'api_key' / 'basic' / 'oauth2': enforce when allowed_urls
 *     is populated (operator opted in); permissive when empty.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function checkUrlScope(credential, url) {
  const allowedUrls = parseAllowedUrls(credential);

  if (credential.type === 'internal') {
    if (typeof url !== 'string' || !url.length) {
      return { ok: false, reason: 'no URL provided' };
    }
    if (Array.isArray(allowedUrls) && allowedUrls.length) {
      return matchesAnyPattern(url, allowedUrls)
        ? { ok: true }
        : { ok: false, reason: `not in allowed_urls for ${url}` };
    }
    if (!process.env.APP_URL) {
      return { ok: false, reason: `APP_URL env var not set, cannot verify ${url} is self-targeted` };
    }
    return targetMatchesAppUrl(url)
      ? { ok: true }
      : { ok: false, reason: `${url} does not match APP_URL (${process.env.APP_URL})` };
  }

  // Non-internal types: enforce when allowed_urls populated.
  if (Array.isArray(allowedUrls) && allowedUrls.length) {
    if (typeof url !== 'string' || !url.length) {
      return { ok: false, reason: 'allowed_urls set but no URL provided' };
    }
    return matchesAnyPattern(url, allowedUrls)
      ? { ok: true }
      : { ok: false, reason: `not allowed for URL ${url}` };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// Sync header builder for non-oauth2 types
// ─────────────────────────────────────────────────────────────

/**
 * Build HTTP auth headers from a credentials table row. Synchronous —
 * does NOT support the oauth2 type (which requires DB access for refresh).
 * For oauth2, callers must use buildHeadersForCredential.
 *
 * @param {object|null} credential — row from credentials table
 * @param {string}      [url]      — destination URL, for allowed_urls check
 * @returns {object} headers, or {} on miss/invalid/out-of-scope/oauth2
 */
function buildAuthHeaders(credential, url) {
  if (!credential) return {};

  // oauth2 cannot be handled synchronously. Return {} + warn rather than
  // throw, so any legacy direct caller degrades gracefully.
  if (credential.type === 'oauth2') {
    console.warn(`[credentialInjection] buildAuthHeaders called for oauth2 credential ${credential.id || '?'} — use buildHeadersForCredential instead`);
    return {};
  }

  const credConfig = typeof credential.config === 'string'
    ? JSON.parse(credential.config)
    : credential.config;

  const scope = checkUrlScope(credential, url);
  if (!scope.ok) {
    console.warn(`[credentialInjection] Credential ${credential.id || '?'} (type=${credential.type}) rejected — ${scope.reason}`);
    return {};
  }

  if (credential.type === 'internal') {
    return { 'x-api-key': process.env.INTERNAL_API_KEY };
  }
  if (credential.type === 'bearer') {
    return { 'Authorization': `Bearer ${credConfig?.token}` };
  }
  if (credential.type === 'api_key') {
    const header = credConfig?.header || 'x-api-key';
    return { [header]: credConfig?.key };
  }
  if (credential.type === 'basic') {
    const b64 = Buffer.from(`${credConfig?.username}:${credConfig?.password}`).toString('base64');
    return { 'Authorization': `Basic ${b64}` };
  }

  return {};
}

// ─────────────────────────────────────────────────────────────
// DB load
// ─────────────────────────────────────────────────────────────

/**
 * Load a credential row by ID. Returns null for missing/invalid IDs.
 *
 * Slice 2 added oauth2 columns to the SELECT (access_token, oauth_status,
 * verbose). access_token is left ENCRYPTED — decryption only happens in
 * oauthService when a plaintext value is actually needed, which keeps
 * secrets out of memory longer than necessary.
 *
 * @param {object} db
 * @param {number|string|null|undefined} credentialId
 * @returns {Promise<object|null>}
 */
async function loadCredential(db, credentialId) {
  if (credentialId == null || credentialId === '') return null;
  const n = Number(credentialId);
  if (!Number.isInteger(n) || n <= 0) return null;

  const [[row]] = await db.query(
    `SELECT id, name, type, config, allowed_urls,
            access_token, oauth_status, verbose
       FROM credentials WHERE id = ?`,
    [n]
  );
  return row || null;
}

// ─────────────────────────────────────────────────────────────
// Async dispatcher — handles all types including oauth2
// ─────────────────────────────────────────────────────────────

/**
 * Convenience: load + build in one call. Handles all credential types
 * including oauth2 (which requires DB access for token refresh).
 *
 * Returns {} on any miss / invalid / out-of-scope / disconnected condition
 * — callers can merge unconditionally without extra null checks.
 *
 * @param {object} db
 * @param {number|null} credentialId
 * @param {string}      [url]      — destination URL, for allowed_urls check
 * @returns {Promise<object>} headers
 */
async function buildHeadersForCredential(db, credentialId, url) {
  const cred = await loadCredential(db, credentialId);
  if (!cred) return {};

  if (cred.type === 'oauth2') {
    const scope = checkUrlScope(cred, url);
    if (!scope.ok) {
      console.warn(`[credentialInjection] oauth2 credential ${cred.id} rejected — ${scope.reason}`);
      return {};
    }
    if (cred.oauth_status !== 'connected') {
      console.warn(`[credentialInjection] oauth2 credential ${cred.id} status=${cred.oauth_status} — skipping injection`);
      return {};
    }

    // Lazy require to avoid any circular-dep risk (oauthService doesn't
    // import this file today, but matching codebase pattern is cheap
    // insurance — see project memory note on circular deps).
    const oauthService = require('../services/oauthService');
    try {
      const token = await oauthService.getValidAccessToken(db, cred.id);
      return { 'Authorization': `Bearer ${token}` };
    } catch (err) {
      console.warn(`[credentialInjection] oauth2 credential ${cred.id} token fetch failed: ${err.message}`);
      return {};
    }
  }

  return buildAuthHeaders(cred, url);
}

module.exports = {
  buildAuthHeaders,
  loadCredential,
  buildHeadersForCredential,
};