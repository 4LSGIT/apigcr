// services/oauthService.js
//
// Generic OAuth 2.0 client for the YisraCase Connections credential system.
// Built in Slice 2 of the Connections refactor. Consumed by:
//   - lib/credentialInjection.js  — getValidAccessToken() for outbound HTTP
//   - routes/auth/oauth.js (Slice 3, not yet built)  — buildAuthorizationUrl,
//                                                       exchangeCodeForTokens
//   - the Connections admin UI (Slice 3)             — refreshTokens, revokeTokens
//
// All state lives in the credentials table plus a small in-process refresh
// dedup map. No module-level token cache (unlike services/ringcentralService.js,
// which is single-tenant); credentials here are multi-tenant.
//
// Concurrency model — TWO layers:
//   1. Cross-instance: MySQL GET_LOCK('oauth_refresh_<id>', 10) — Cloud Run runs
//      multiple instances, without this you get thundering-herd refreshes that
//      race on refresh-token rotation and cause the provider to invalidate all
//      but one. Pattern lifted from services/ringcentralService.js.
//   2. In-process: Map<credentialId, Promise> — within a single instance,
//      multiple concurrent getValidAccessToken() calls share one refresh attempt
//      rather than serializing on the SQL lock.
//
// Refresh-failure alerting: at exactly the alert threshold (1 → 2 transition)
// we flip oauth_status to 'refresh_failed' AND fire one Pabbly alert. The
// status flip naturally dedups subsequent failures in the same chain — count > 2
// won't refire because the threshold check is `=== ALERT_THRESHOLD`. A
// successful refresh resets count to 0, so a future failure run gets a fresh
// alert.
//
// Logging: never log access_token, refresh_token, code, code_verifier, or
// client_secret values. Verbose mode (per-credential `verbose` flag) logs
// metadata only — endpoints, grant_type, status, token presence + prefix/length.

const crypto = require('crypto');
const fetch = require('node-fetch');
const { encrypt, decrypt } = require('../lib/credentialCrypto');

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

// Reuse the same Pabbly endpoint as services/ringcentralService.js. Inlined
// rather than imported from RC so this module stands alone, and not factored
// into a shared lib/pabblyAlert.js because the slice deliverable is exactly
// two files. Decision noted in slice report.
const PABBLY_ALERT_URL =
  'https://connect.pabbly.com/workflow/sendwebhookdata/IjU3NjYwNTZhMDYzMTA0M2Q1MjY5NTUzNjUxMzUi_pc';

const REFRESH_WINDOW_SECONDS = 120;     // refresh if expiry within this window
const SECONDARY_OK_SECONDS   = 60;      // post-lock recheck threshold
const LOCK_TIMEOUT_SECONDS   = 10;      // GET_LOCK wait
const ALERT_THRESHOLD        = 2;       // consecutive failures → alert + status flip

// In-process dedup of in-flight refresh promises. Cleared on settle.
const inFlightRefreshes = new Map();

// ─────────────────────────────────────────────────────────────
// Pabbly alert (best-effort; failures swallowed, never block)
// ─────────────────────────────────────────────────────────────

async function sendAlert(type, message, extra = {}) {
  try {
    await fetch(PABBLY_ALERT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error_type: type,
        alert: message,
        environment: process.env.ENVIRONMENT || 'unknown',
        timestamp: new Date().toISOString(),
        ...extra,
      }),
    });
  } catch (_) { /* best-effort */ }
}

// ─────────────────────────────────────────────────────────────
// Logging helpers
// ─────────────────────────────────────────────────────────────

function tokenInfo(token) {
  if (!token || typeof token !== 'string') return 'absent';
  return `<${token.length} chars, starts "${token.slice(0, 8)}">`;
}

function vlog(verbose, ...args) {
  if (verbose) console.log('[oauthService]', ...args);
}

// ─────────────────────────────────────────────────────────────
// PKCE (RFC 7636)
// ─────────────────────────────────────────────────────────────

function base64UrlEncode(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generate a 128-character base64url verifier (RFC 7636 allows 43-128).
 * 96 random bytes → 128 base64url chars (no padding).
 */
function generatePkceVerifier() {
  return base64UrlEncode(crypto.randomBytes(96)).slice(0, 128);
}

/**
 * S256 challenge: base64url(sha256(verifier))
 */
function pkceChallenge(verifier) {
  return base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
}

// ─────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────

async function loadCredentialRow(db, credentialId) {
  const [[row]] = await db.query(
    `SELECT id, name, type, config, allowed_urls,
            access_token, refresh_token,
            access_token_expires_at, refresh_token_expires_at,
            last_refreshed_at, oauth_status, oauth_state,
            oauth_pkce_verifier, oauth_last_error, oauth_last_error_at,
            refresh_failure_count, verbose
       FROM credentials WHERE id = ?`,
    [credentialId]
  );
  return row || null;
}

function parseConfig(cred) {
  if (!cred?.config) return null;
  return typeof cred.config === 'string' ? JSON.parse(cred.config) : cred.config;
}

/**
 * client_secret is stored encrypted within the config JSON (Slice 1
 * convention). Returns plaintext or null if absent.
 */
function decryptedClientSecret(config) {
  if (!config?.client_secret) return null;
  return decrypt(config.client_secret);
}

/**
 * True iff cred.access_token_expires_at is more than `seconds` in the future.
 * Treats null expiry as "expired" (forces refresh).
 */
function expiresInMoreThan(cred, seconds) {
  if (!cred?.access_token) return false;
  if (!cred?.access_token_expires_at) return false;
  const expiry = new Date(cred.access_token_expires_at).getTime();
  return expiry - Date.now() > seconds * 1000;
}

// ─────────────────────────────────────────────────────────────
// Token endpoint POST
// ─────────────────────────────────────────────────────────────

/**
 * Build the body and headers for a token endpoint POST. Honors
 * config.client_auth_method ('basic' default, or 'body').
 */
function buildTokenRequest(config, clientSecret, params) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' };
  const body = new URLSearchParams(params);
  const method = config.client_auth_method || 'basic';
  if (method === 'basic') {
    const b64 = Buffer.from(`${config.client_id}:${clientSecret ?? ''}`).toString('base64');
    headers['Authorization'] = `Basic ${b64}`;
  } else {
    body.append('client_id', config.client_id);
    if (clientSecret) body.append('client_secret', clientSecret);
  }
  return { headers, body };
}

/**
 * POST to token endpoint and parse response. Throws on non-2xx with HTTP
 * status + truncated body in the message. Never includes the request body
 * in errors (would leak code/refresh_token/secret).
 */
async function postToken(config, clientSecret, params, verbose) {
  const { headers, body } = buildTokenRequest(config, clientSecret, params);
  vlog(verbose, `POST ${config.token_url} grant_type=${params.grant_type} auth_method=${config.client_auth_method || 'basic'}`);

  const res = await fetch(config.token_url, { method: 'POST', headers, body });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  vlog(verbose,
    `← status=${res.status}`,
    `access_token=${json?.access_token ? tokenInfo(json.access_token) : 'absent'}`,
    `refresh_token=${json?.refresh_token ? tokenInfo(json.refresh_token) : 'absent'}`,
    `expires_in=${json?.expires_in}`,
    `scope=${json?.scope}`,
    `token_type=${json?.token_type}`
  );

  if (!res.ok) {
    const truncated = text.slice(0, 500);
    const err = new Error(`Token endpoint returned ${res.status}: ${truncated}`);
    err.status = res.status;
    err.body = truncated;
    throw err;
  }
  if (!json || !json.access_token) {
    throw new Error(`Token endpoint returned 2xx but no access_token in response: ${text.slice(0, 500)}`);
  }
  return json;
}

// ─────────────────────────────────────────────────────────────
// Apply token response to DB
// ─────────────────────────────────────────────────────────────

/**
 * Encrypt new tokens, compute expiry timestamps, write to row. Honors
 * refresh-token rotation: keeps existing encrypted refresh_token if the
 * provider didn't return a new one. Resets failure tracking on success.
 *
 * @param {object} db
 * @param {number} credentialId
 * @param {object} response       — token endpoint JSON
 * @param {string|null} existingRefreshToken — already-encrypted from DB
 */
async function applyTokenResponse(db, credentialId, response, existingRefreshToken) {
  const accessToken = encrypt(response.access_token);

  // Refresh-token rotation: providers split into two camps. Some (Google,
  // RingCentral) return a new refresh_token on every refresh; some (others)
  // return only on the initial exchange. If response omits it, keep what we
  // have — DO NOT overwrite with null (this is the bug ref the slice spec
  // calls out).
  const refreshToken = response.refresh_token
    ? encrypt(response.refresh_token)
    : (existingRefreshToken || null);

  const accessExpiresAt = response.expires_in
    ? new Date(Date.now() + Number(response.expires_in) * 1000)
    : null;

  const hasRefreshExpiry = response.refresh_token_expires_in != null;
  const refreshExpiresAt = hasRefreshExpiry
    ? new Date(Date.now() + Number(response.refresh_token_expires_in) * 1000)
    : null;

  const sql = hasRefreshExpiry
    ? `UPDATE credentials SET
         access_token = ?, refresh_token = ?,
         access_token_expires_at = ?, refresh_token_expires_at = ?,
         last_refreshed_at = NOW(), oauth_status = 'connected',
         oauth_last_error = NULL, oauth_last_error_at = NULL,
         refresh_failure_count = 0
       WHERE id = ?`
    : `UPDATE credentials SET
         access_token = ?, refresh_token = ?,
         access_token_expires_at = ?,
         last_refreshed_at = NOW(), oauth_status = 'connected',
         oauth_last_error = NULL, oauth_last_error_at = NULL,
         refresh_failure_count = 0
       WHERE id = ?`;

  const params = hasRefreshExpiry
    ? [accessToken, refreshToken, accessExpiresAt, refreshExpiresAt, credentialId]
    : [accessToken, refreshToken, accessExpiresAt, credentialId];

  await db.query(sql, params);
}

// ─────────────────────────────────────────────────────────────
// Refresh failure tracking
// ─────────────────────────────────────────────────────────────

/**
 * Increment failure counter, stamp oauth_last_error, and at exactly the
 * alert threshold flip status to 'refresh_failed' and fire one Pabbly alert.
 * The threshold check is `=== ALERT_THRESHOLD` so subsequent failures in
 * the same chain don't refire — the status flip naturally dedups, and a
 * successful refresh resets count to 0 for fresh alerting later.
 */
async function recordRefreshFailure(db, credentialId, credentialName, error) {
  const errMsg = String(error?.message || error).slice(0, 1000);

  await db.query(
    `UPDATE credentials SET
       refresh_failure_count = refresh_failure_count + 1,
       oauth_last_error = ?,
       oauth_last_error_at = NOW()
     WHERE id = ?`,
    [errMsg, credentialId]
  );

  const [[row]] = await db.query(
    `SELECT refresh_failure_count FROM credentials WHERE id = ?`,
    [credentialId]
  );
  const newCount = row?.refresh_failure_count ?? 0;

  if (newCount === ALERT_THRESHOLD) {
    await db.query(
      `UPDATE credentials SET oauth_status = 'refresh_failed' WHERE id = ?`,
      [credentialId]
    );
    sendAlert(
      'oauth_refresh_failed',
      `OAuth credential "${credentialName}" (id=${credentialId}) failed to refresh ${ALERT_THRESHOLD} times consecutively — manual reauthorization may be required`,
      { credential_id: credentialId, credential_name: credentialName, last_error: errMsg }
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Build the authorization URL the user is redirected to. Generates a fresh
 * 32-byte hex CSRF state and (if config.use_pkce) a 128-char PKCE verifier,
 * persists both on the credential row, and sets oauth_status='pending_auth'.
 *
 * @param {object} db
 * @param {number} credentialId
 * @param {string} redirectUri
 * @returns {Promise<string>} the URL to redirect the user to
 */
async function buildAuthorizationUrl(db, credentialId, redirectUri) {
  const cred = await loadCredentialRow(db, credentialId);
  if (!cred) throw new Error(`Credential ${credentialId} not found`);
  if (cred.type !== 'oauth2') {
    throw new Error(`Credential ${credentialId} is not type oauth2 (got ${cred.type})`);
  }
  const config = parseConfig(cred);
  if (!config.auth_url) throw new Error(`Credential ${id} config missing auth_url`);
  if (!config.client_id) throw new Error(`Credential ${id} config missing client_id`);

  const state = crypto.randomBytes(32).toString('hex');
  let verifier = null;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.client_id,
    redirect_uri: redirectUri,
    state,
  });
  if (Array.isArray(config.scopes) && config.scopes.length) {
    params.set('scope', config.scopes.join(' '));
  }
  if (config.use_pkce) {
    verifier = generatePkceVerifier();
    params.set('code_challenge', pkceChallenge(verifier));
    params.set('code_challenge_method', 'S256');
  }
  if (config.extra_authorize_params && typeof config.extra_authorize_params === 'object') {
    for (const [k, v] of Object.entries(config.extra_authorize_params)) {
      params.set(k, String(v));
    }
  }

  await db.query(
    `UPDATE credentials SET
       oauth_state = ?,
       oauth_pkce_verifier = ?,
       oauth_status = 'pending_auth'
     WHERE id = ?`,
    [state, verifier, credentialId]
  );

  // Preserve any pre-existing query params on auth_url.
  const url = new URL(config.auth_url);
  for (const [k, v] of params) url.searchParams.set(k, v);

  vlog(cred.verbose, `Authorization URL built for credential ${credentialId}, state=${state.slice(0, 8)}…, pkce=${!!verifier}`);
  return url.toString();
}

/**
 * Exchange an authorization code for tokens. Caller (Slice 3 callback route)
 * passes the `state` and `code` query params from the redirect. We look up
 * the credential by stored oauth_state (CSRF check), POST to token_url,
 * encrypt + store tokens, set oauth_status='connected', clear state/verifier.
 *
 * @param {object} db
 * @param {string} state
 * @param {string} code
 * @param {string} redirectUri
 * @returns {Promise<{credentialId: number, name: string}>}
 */
async function exchangeCodeForTokens(db, state, code, redirectUri) {
  if (!state || !code) throw new Error('state and code are required');

  const [[row]] = await db.query(
    `SELECT id, name FROM credentials WHERE oauth_state = ? AND type = 'oauth2'`,
    [state]
  );
  if (!row) throw new Error('No credential matches this state token (expired, replay, or never issued)');
  const credentialId = row.id;

  const cred = await loadCredentialRow(db, credentialId);
  const config = parseConfig(cred);
  if (!config?.token_url) {
    throw new Error(`Credential ${credentialId} config missing token_url`);
  }
  const clientSecret = decryptedClientSecret(config);

  const params = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  };
  if (cred.oauth_pkce_verifier) params.code_verifier = cred.oauth_pkce_verifier;
  if (config.extra_token_params && typeof config.extra_token_params === 'object') {
    Object.assign(params, config.extra_token_params);
  }

  let response;
  try {
    response = await postToken(config, clientSecret, params, cred.verbose);
  } catch (err) {
    // Stamp the error so the UI (Slice 3) can surface it. Don't flip status
    // to refresh_failed here — this is the initial connect, not a refresh.
    await db.query(
      `UPDATE credentials SET oauth_last_error = ?, oauth_last_error_at = NOW() WHERE id = ?`,
      [String(err?.message || err).slice(0, 1000), credentialId]
    );
    throw err;
  }

  await applyTokenResponse(db, credentialId, response, cred.refresh_token);
  await db.query(
    `UPDATE credentials SET oauth_state = NULL, oauth_pkce_verifier = NULL WHERE id = ?`,
    [credentialId]
  );

  vlog(cred.verbose, `Credential ${credentialId} (${cred.name}) connected`);
  return { credentialId, name: cred.name };
}

/**
 * Internal: perform a refresh under both layers of dedup. Caller wraps via
 * refreshTokens() which adds the in-process Map dedup.
 */
async function _refreshUnderLock(db, credentialId) {
  const lockKey = `oauth_refresh_${credentialId}`;
  const [[lockRes]] = await db.query(
    `SELECT GET_LOCK(?, ?) AS lockAcquired`,
    [lockKey, LOCK_TIMEOUT_SECONDS]
  );

  if (lockRes?.lockAcquired !== 1) {
    // Another instance held the lock for the full timeout. Re-check the row;
    // they may have finished a successful refresh in that window.
    const fresh = await loadCredentialRow(db, credentialId);
    if (fresh && expiresInMoreThan(fresh, SECONDARY_OK_SECONDS)) return;
    throw new Error(`Could not acquire refresh lock for credential ${credentialId}`);
  }

  try {
    // Re-load AFTER lock acquired — another instance may have refreshed
    // between our initial check and our lock acquisition. If they did, bail.
    const cred = await loadCredentialRow(db, credentialId);
    if (!cred) throw new Error(`Credential ${credentialId} not found`);
    if (cred.type !== 'oauth2') throw new Error(`Credential ${credentialId} not oauth2`);
    if (expiresInMoreThan(cred, SECONDARY_OK_SECONDS)) {
      vlog(cred.verbose, `Credential ${credentialId} already refreshed by another instance`);
      return;
    }
    if (!cred.refresh_token) {
      throw new Error(`Credential ${credentialId} has no refresh_token to refresh with`);
    }

    const config = parseConfig(cred);
    if (!config?.token_url) {
      throw new Error(`Credential ${credentialId} config missing token_url`);
    }
    const clientSecret = decryptedClientSecret(config);
    const refreshToken = decrypt(cred.refresh_token);

    const params = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    };
    if (config.extra_refresh_params && typeof config.extra_refresh_params === 'object') {
      Object.assign(params, config.extra_refresh_params);
    }

    try {
      const response = await postToken(config, clientSecret, params, cred.verbose);
      await applyTokenResponse(db, credentialId, response, cred.refresh_token);
      vlog(cred.verbose, `Credential ${credentialId} refreshed`);
    } catch (err) {
      await recordRefreshFailure(db, credentialId, cred.name, err);
      throw err;
    }
  } finally {
    // ALWAYS release lock, even on error — never skip.
    await db.query(`SELECT RELEASE_LOCK(?)`, [lockKey]);
  }
}

/**
 * Refresh the access token. Multi-instance safe via MySQL GET_LOCK,
 * in-process safe via inFlightRefreshes Map.
 *
 * On success: stores new tokens, last_refreshed_at = NOW(),
 * refresh_failure_count = 0, oauth_status = 'connected'.
 *
 * On failure: increments refresh_failure_count, stamps oauth_last_error.
 * At exactly ALERT_THRESHOLD consecutive failures, sets
 * oauth_status = 'refresh_failed' and fires one Pabbly alert. Re-throws.
 *
 * @param {object} db
 * @param {number} credentialId
 * @returns {Promise<void>}
 */
async function refreshTokens(db, credentialId) {
  if (inFlightRefreshes.has(credentialId)) {
    return inFlightRefreshes.get(credentialId);
  }
  const promise = _refreshUnderLock(db, credentialId)
    .finally(() => { inFlightRefreshes.delete(credentialId); });
  inFlightRefreshes.set(credentialId, promise);
  return promise;
}

/**
 * Revoke at the provider (if revoke_url configured) and clear locally.
 * Best-effort: if the provider call fails we still clear local tokens and
 * return the provider error in the result rather than throwing — the user's
 * intent is "disconnect this", and leaving stale tokens around defeats that.
 *
 * @param {object} db
 * @param {number} credentialId
 * @returns {Promise<{revokedAtProvider: boolean, providerError?: string}>}
 */
async function revokeTokens(db, credentialId) {
  const cred = await loadCredentialRow(db, credentialId);
  if (!cred) throw new Error(`Credential ${credentialId} not found`);
  if (cred.type !== 'oauth2') throw new Error(`Credential ${credentialId} not oauth2`);
  const config = parseConfig(cred);

  let revokedAtProvider = false;
  let providerError;

  if (config?.revoke_url && cred.access_token) {
    try {
      const clientSecret = decryptedClientSecret(config);
      const accessToken = decrypt(cred.access_token);
      const { headers, body } = buildTokenRequest(config, clientSecret, { token: accessToken });
      vlog(cred.verbose, `POST ${config.revoke_url} (revoke)`);
      const res = await fetch(config.revoke_url, { method: 'POST', headers, body });
      vlog(cred.verbose, `← revoke status=${res.status}`);
      if (res.ok) {
        revokedAtProvider = true;
      } else {
        const text = await res.text();
        providerError = `Revoke endpoint returned ${res.status}: ${text.slice(0, 500)}`;
      }
    } catch (err) {
      providerError = String(err?.message || err).slice(0, 500);
    }
  }

  await db.query(
    `UPDATE credentials SET
       access_token = NULL,
       refresh_token = NULL,
       access_token_expires_at = NULL,
       refresh_token_expires_at = NULL,
       oauth_status = 'revoked',
       oauth_state = NULL,
       oauth_pkce_verifier = NULL
     WHERE id = ?`,
    [credentialId]
  );

  return providerError
    ? { revokedAtProvider, providerError }
    : { revokedAtProvider };
}

/**
 * Return a fresh, decrypted access token. Refreshes if expiring within
 * REFRESH_WINDOW_SECONDS (or already expired). Multi-instance + in-process
 * safe. This is the function lib/credentialInjection.js calls.
 *
 * @param {object} db
 * @param {number} credentialId
 * @returns {Promise<string>} decrypted access token
 */
async function getValidAccessToken(db, credentialId) {
  const cred = await loadCredentialRow(db, credentialId);
  if (!cred) throw new Error(`Credential ${credentialId} not found`);
  if (cred.type !== 'oauth2') throw new Error(`Credential ${credentialId} not oauth2`);
  if (cred.oauth_status !== 'connected') {
    throw new Error(`Credential ${credentialId} not connected (status=${cred.oauth_status})`);
  }

  if (expiresInMoreThan(cred, REFRESH_WINDOW_SECONDS)) {
    return decrypt(cred.access_token);
  }

  await refreshTokens(db, credentialId);
  const fresh = await loadCredentialRow(db, credentialId);
  if (!fresh?.access_token) {
    throw new Error(`Credential ${credentialId} has no access_token after refresh`);
  }
  return decrypt(fresh.access_token);
}

// ─────────────────────────────────────────────────────────────
// Test helpers (NOT exported — accessed via private internals object
// only from this slice's test files. Keeps the public surface clean.)
// ─────────────────────────────────────────────────────────────

const _internals = {
  generatePkceVerifier,
  pkceChallenge,
  base64UrlEncode,
  buildTokenRequest,
  applyTokenResponse,
  recordRefreshFailure,
  expiresInMoreThan,
  inFlightRefreshes,
  ALERT_THRESHOLD,
  REFRESH_WINDOW_SECONDS,
};

module.exports = {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  refreshTokens,
  revokeTokens,
  getValidAccessToken,
  _internals,
};