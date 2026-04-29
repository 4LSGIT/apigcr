/**
 * OAuth + reveal routes for the Connections system.
 * routes/api.oauth.js
 *
 * Built as Slice 3 of the Connections refactor.
 *
 * POST /api/credentials/:id/authorize  — admin: build auth URL
 * GET  /auth/oauth/callback            — PUBLIC: provider redirect target
 * POST /api/credentials/:id/refresh    — admin: manual refresh
 * POST /api/credentials/:id/revoke     — admin: revoke + clear tokens
 * GET  /api/credentials/:id/reveal     — admin: decrypt and return secrets
 *
 * The callback endpoint is the only public route. CSRF protection comes from
 * the unguessable `state` value generated in buildAuthorizationUrl (admin-only)
 * and looked up in exchangeCodeForTokens. No JWT possible — provider redirects
 * the user's browser here.
 *
 * All admin endpoints write a row to admin_audit_log with tool='connections'.
 * Audit details NEVER include actual secret values, only metadata (id, name,
 * type) about which credential was touched.
 */

const express = require('express');
const router = express.Router();
const { superuserOnlyFor, auditAdminAction } = require('../lib/auth.superuser');
const oauthService = require('../services/oauthService');
const credentialCrypto = require('../lib/credentialCrypto');

const TOOL = 'connections';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function reqMeta(req) {
  return {
    ip:        req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
  };
}

function audit(db, row) {
  return auditAdminAction(db, row).catch(err =>
    console.error('[oauth] audit log failed:', err.message)
  );
}

async function loadCredentialBasics(db, id) {
  const [[row]] = await db.query(
    `SELECT id, name, type FROM credentials WHERE id = ?`,
    [id]
  );
  return row || null;
}

function getRedirectUri() {
  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    const err = new Error(
      'APP_URL env var is not set — set to e.g. https://app.4lsg.com (no path, ' +
      'no trailing slash). OAuth callback URL is APP_URL + /auth/oauth/callback ' +
      'and that full URL must be registered with each OAuth provider.'
    );
    err.code = 'MISSING_APP_URL';
    throw err;
  }
  const base = appUrl.replace(/\/+$/, '');
  return `${base}/auth/oauth/callback`;
}

// HTML escape for callback rendering
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// JSON-for-script: prevent </script> breakout via untrusted credential names
function safeJson(v) {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/'/g, '\\u0027');
}

const REFRESH_TOKEN_WARNING =
  'Connection succeeded, but no refresh token was returned. Without a ' +
  'refresh token, this connection will stop working when the access token ' +
  'expires (often within 1 hour). For Google: you may need to add ' +
  'access_type=offline and prompt=consent to extra_authorize_params, then ' +
  'revoke and re-authorize. Contact your admin.';

function renderCallbackHtml({ kind, message, credentialId, credentialName, warning }) {
  const isSuccess = kind === 'success';
  const title  = isSuccess ? 'Connection successful' : 'Connection failed';
  const heading = isSuccess
    ? `<h1 class="ok">✓ ${escapeHtml(title)}</h1>`
    : `<h1 class="err">✗ ${escapeHtml(title)}</h1>`;

  let bodyMsg;
  if (isSuccess) {
    bodyMsg =
      `<p>"${escapeHtml(credentialName)}" is connected. You can close this window.</p>` +
      (warning ? `<div class="warn"><strong>Warning:</strong><br>${escapeHtml(warning)}</div>` : '');
  } else {
    bodyMsg = `<p>${escapeHtml(message)}</p>`;
  }

  const postMessageScript = isSuccess
    ? `
        try {
          if (window.opener) {
            window.opener.postMessage({
              type: 'oauth_success',
              credentialId: ${safeJson(credentialId)},
              name: ${safeJson(credentialName)}
            }, window.location.origin);
            ${warning
              ? `window.opener.postMessage({ type: 'oauth_warning', credentialId: ${safeJson(credentialId)}, message: ${safeJson(warning)} }, window.location.origin);`
              : ''}
          }
        } catch (e) {}
        setTimeout(function () { try { window.close(); } catch (e) {} }, 2000);
      `
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #f5f5f5; margin: 0; padding: 2rem; color: #222; }
  .card { max-width: 540px; margin: 4rem auto; background: #fff; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  h1 { margin: 0 0 1rem 0; font-size: 1.4rem; }
  .ok { color: #0a7c2c; }
  .err { color: #a00; }
  .warn { background: #fffbe6; border: 1px solid #f0d020; border-left: 4px solid #f0a020; padding: 1rem; border-radius: 4px; margin: 1rem 0; line-height: 1.45; }
  button { background: #1a73e8; color: #fff; border: 0; padding: 0.6rem 1.2rem; border-radius: 4px; cursor: pointer; font-size: 14px; margin-top: 0.5rem; }
  button:hover { background: #155cb8; }
  p { line-height: 1.5; }
</style>
</head>
<body>
<div class="card">
${heading}
${bodyMsg}
<button onclick="window.close()">Close window</button>
</div>
<script>${postMessageScript}</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────
// POST /api/credentials/:id/authorize
// ─────────────────────────────────────────────────────────────

router.post('/api/credentials/:id/authorize', superuserOnlyFor(TOOL), async (req, res) => {
  const id = req.params.id;
  const meta = reqMeta(req);

  let cred;
  try {
    cred = await loadCredentialBasics(req.db, id);
    if (!cred) {
      return res.status(404).json({ status: 'error', message: 'Credential not found' });
    }

    let redirectUri;
    try {
      redirectUri = getRedirectUri();
    } catch (err) {
      audit(req.db, {
        tool: TOOL,
        userId: req.auth.userId, username: req.auth.username,
        route: req.originalUrl, method: req.method,
        status: 'failed', errorMessage: err.message,
        ...meta,
        details: { credential_id: cred.id, credential_name: cred.name, error: 'missing_redirect_uri' },
      });
      return res.status(500).json({ status: 'error', message: err.message });
    }

    const authUrl = await oauthService.buildAuthorizationUrl(req.db, id, redirectUri);

    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'success',
      ...meta,
      details: { credential_id: cred.id, credential_name: cred.name },
    });

    res.json({ status: 'success', auth_url: authUrl });
  } catch (err) {
    console.error('[oauth] authorize error:', err);
    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'failed', errorMessage: err.message,
      ...meta,
      details: { credential_id: cred?.id ?? Number(id), credential_name: cred?.name ?? null, error: err.message },
    });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /auth/oauth/callback   — PUBLIC, no auth middleware
// ─────────────────────────────────────────────────────────────
//
// Security model:
//   - state is 32 random bytes hex from buildAuthorizationUrl, stored on the
//     credentials row. Lookup by state returns null for any unknown value.
//   - state is only ever generated in /authorize (admin-only), so only an
//     admin can have caused the state to be in the DB.
//   - State is single-use: exchangeCodeForTokens clears oauth_state on success.
//
// We always render HTML (this is browser-facing) and audit every outcome.
// userId is null in audit rows because there's no JWT context here.

router.get('/auth/oauth/callback', async (req, res) => {
  const meta = reqMeta(req);
  const { state, code, error, error_description } = req.query;

  // Best-effort credential lookup by state for audit context, even when the
  // provider returned an error.
  let credentialId = null;
  let credentialName = null;
  if (typeof state === 'string' && state) {
    try {
      const [[row]] = await req.db.query(
        `SELECT id, name FROM credentials WHERE oauth_state = ? AND type = 'oauth2'`,
        [state]
      );
      if (row) { credentialId = row.id; credentialName = row.name; }
    } catch (lookupErr) {
      console.error('[oauth] callback state lookup failed:', lookupErr);
    }
  }

  // Provider returned an error (most often: user denied)
  if (error) {
    const message = error_description || error;
    audit(req.db, {
      tool: TOOL,
      userId: null, username: null,
      route: req.originalUrl, method: req.method,
      status: 'denied', errorMessage: String(message).slice(0, 1000),
      ...meta,
      details: { credential_id: credentialId, credential_name: credentialName, error, error_description: error_description ?? null },
    });
    return res.status(400).send(renderCallbackHtml({
      kind: 'error',
      message: `Authorization denied or failed: ${message}`,
    }));
  }

  // No state, or state didn't match a credential
  if (!state || !credentialId) {
    audit(req.db, {
      tool: TOOL,
      userId: null, username: null,
      route: req.originalUrl, method: req.method,
      status: 'failed', errorMessage: 'invalid_or_expired_state',
      ...meta,
      details: { credential_id: null, credential_name: null, error: 'invalid_or_expired_state' },
    });
    return res.status(400).send(renderCallbackHtml({
      kind: 'error',
      message: 'Invalid or expired authorization request — close this window and try again.',
    }));
  }

  if (!code) {
    audit(req.db, {
      tool: TOOL,
      userId: null, username: null,
      route: req.originalUrl, method: req.method,
      status: 'failed', errorMessage: 'missing_code',
      ...meta,
      details: { credential_id: credentialId, credential_name: credentialName, error: 'missing_code' },
    });
    return res.status(400).send(renderCallbackHtml({
      kind: 'error',
      message: 'Authorization code is missing from the callback. Try again.',
    }));
  }

  // Get redirect URI (fail loud if missing — the URL must match what was sent
  // to the provider during /authorize, otherwise the exchange will reject).
  let redirectUri;
  try {
    redirectUri = getRedirectUri();
  } catch (err) {
    audit(req.db, {
      tool: TOOL,
      userId: null, username: null,
      route: req.originalUrl, method: req.method,
      status: 'failed', errorMessage: err.message,
      ...meta,
      details: { credential_id: credentialId, credential_name: credentialName, error: 'missing_redirect_uri' },
    });
    return res.status(500).send(renderCallbackHtml({
      kind: 'error',
      message: 'Server configuration error: OAUTH_REDIRECT_URI is not set.',
    }));
  }

  let result;
  try {
    result = await oauthService.exchangeCodeForTokens(req.db, state, code, redirectUri);
  } catch (err) {
    console.error('[oauth] exchange failed:', err);
    audit(req.db, {
      tool: TOOL,
      userId: null, username: null,
      route: req.originalUrl, method: req.method,
      status: 'failed', errorMessage: err.message,
      ...meta,
      details: { credential_id: credentialId, credential_name: credentialName, error: err.message },
    });
    return res.status(500).send(renderCallbackHtml({
      kind: 'error',
      message: `Connection failed: ${err.message}`,
    }));
  }

  // Detect missing refresh_token (warn the user prominently)
  let hadRefreshToken = false;
  try {
    const [[fresh]] = await req.db.query(
      `SELECT refresh_token FROM credentials WHERE id = ?`,
      [result.credentialId]
    );
    hadRefreshToken = !!fresh?.refresh_token;
  } catch (postCheckErr) {
    console.error('[oauth] post-exchange refresh_token check failed:', postCheckErr);
  }

  audit(req.db, {
    tool: TOOL,
    userId: null, username: null,
    route: req.originalUrl, method: req.method,
    status: 'success',
    ...meta,
    details: {
      credential_id: result.credentialId,
      credential_name: result.name,
      had_refresh_token: hadRefreshToken,
    },
  });

  return res.send(renderCallbackHtml({
    kind: 'success',
    credentialId: result.credentialId,
    credentialName: result.name,
    warning: hadRefreshToken ? null : REFRESH_TOKEN_WARNING,
  }));
});

// ─────────────────────────────────────────────────────────────
// POST /api/credentials/:id/refresh
// ─────────────────────────────────────────────────────────────

router.post('/api/credentials/:id/refresh', superuserOnlyFor(TOOL), async (req, res) => {
  const id = req.params.id;
  const meta = reqMeta(req);
  let cred;
  try {
    cred = await loadCredentialBasics(req.db, id);
    if (!cred) {
      return res.status(404).json({ status: 'error', message: 'Credential not found' });
    }
    await oauthService.refreshTokens(req.db, id);

    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'success',
      ...meta,
      details: { credential_id: cred.id, credential_name: cred.name },
    });

    res.json({ status: 'success' });
  } catch (err) {
    console.error('[oauth] refresh error:', err);
    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'failed', errorMessage: err.message,
      ...meta,
      details: { credential_id: cred?.id ?? Number(id), credential_name: cred?.name ?? null, error: err.message },
    });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/credentials/:id/revoke
// ─────────────────────────────────────────────────────────────

router.post('/api/credentials/:id/revoke', superuserOnlyFor(TOOL), async (req, res) => {
  const id = req.params.id;
  const meta = reqMeta(req);
  let cred;
  try {
    cred = await loadCredentialBasics(req.db, id);
    if (!cred) {
      return res.status(404).json({ status: 'error', message: 'Credential not found' });
    }
    const result = await oauthService.revokeTokens(req.db, id);

    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'success',
      ...meta,
      details: {
        credential_id: cred.id,
        credential_name: cred.name,
        revoked_at_provider: result.revokedAtProvider,
        provider_error: result.providerError ?? null,
      },
    });

    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('[oauth] revoke error:', err);
    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'failed', errorMessage: err.message,
      ...meta,
      details: { credential_id: cred?.id ?? Number(id), credential_name: cred?.name ?? null, error: err.message },
    });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/credentials/:id/reveal   — admin: decrypt and return secrets
// ─────────────────────────────────────────────────────────────
//
// Audit log records that the action happened (id, name, type) but NEVER
// the actual secret values — that's the whole point of this audit chain.

router.get('/api/credentials/:id/reveal', superuserOnlyFor(TOOL), async (req, res) => {
  const id = req.params.id;
  const meta = reqMeta(req);
  try {
    const [[row]] = await req.db.query(
      `SELECT id, name, type, config, access_token, refresh_token
         FROM credentials WHERE id = ?`,
      [id]
    );
    if (!row) {
      return res.status(404).json({ status: 'error', message: 'Credential not found' });
    }

    const config = row.config
      ? (typeof row.config === 'string' ? JSON.parse(row.config) : row.config)
      : {};

    let revealed;
    try {
      switch (row.type) {
        case 'oauth2':
          revealed = {
            access_token:  row.access_token  ? credentialCrypto.decrypt(row.access_token)  : null,
            refresh_token: row.refresh_token ? credentialCrypto.decrypt(row.refresh_token) : null,
            client_secret: config.client_secret ? credentialCrypto.decrypt(config.client_secret) : null,
          };
          break;
        case 'bearer':
          revealed = { token: config.token ?? null };
          break;
        case 'api_key':
          revealed = { key: config.key ?? null, header: config.header ?? null };
          break;
        case 'basic':
          revealed = { username: config.username ?? null, password: config.password ?? null };
          break;
        case 'internal':
          revealed = {};
          break;
        default:
          revealed = {};
      }
    } catch (decryptErr) {
      console.error('[oauth] reveal decrypt failed:', decryptErr);
      audit(req.db, {
        tool: TOOL,
        userId: req.auth.userId, username: req.auth.username,
        route: req.originalUrl, method: req.method,
        status: 'failed', errorMessage: `decrypt failed: ${decryptErr.message}`,
        ...meta,
        details: { credential_id: row.id, credential_name: row.name, credential_type: row.type, error: 'decrypt_failed' },
      });
      return res.status(500).json({
        status: 'error',
        message: 'Decryption failed (corrupt data or wrong CREDENTIALS_ENCRYPTION_KEY)',
      });
    }

    audit(req.db, {
      tool: TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'success',
      ...meta,
      details: { credential_id: row.id, credential_name: row.name, credential_type: row.type },
    });

    res.json({ status: 'success', revealed });
  } catch (err) {
    console.error('[oauth] reveal error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;