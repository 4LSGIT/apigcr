// routes/api.credentials.js
//
/**
 * Credential Routes — Connections
 * routes/api.credentials.js
 *
 * GET    /api/credentials       — list (any authenticated user; secrets scrubbed)
 * GET    /api/credentials/:id   — single (admin only; secret config fields nulled)
 * POST   /api/credentials       — create (admin only)
 * PUT    /api/credentials/:id   — update (admin only)
 * DELETE /api/credentials/:id   — delete (admin only)
 *
 * Extracted verbatim from routes/api.hooks.js, where this CRUD had lived
 * since YisraHook v1 because credentials started out as hook-target auth.
 * The Connections refactor (slices 3-5) made them app-wide — OAuth2, Dropbox,
 * phone lines, sequences, alerting and internal_functions all resolve
 * credentials — so the routes moved out of the hook router. Behavior is
 * unchanged; only the `[hook]` console prefixes became `[credentials]`.
 *
 * The OAuth *actions* on the same resource — /:id/authorize, /:id/refresh,
 * /:id/revoke, /:id/reveal — stay in routes/api.oauth.js alongside the
 * /auth/oauth/callback handler and the oauthService plumbing they share.
 * All three files audit under the same CONN_TOOL ('connections') tag.
 */

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { superuserOnlyFor, auditAdminAction } = require('../lib/auth.superuser');
const credentialCrypto = require('../lib/credentialCrypto');
const credentialService = require('../services/credentialService');

// Tool name for admin-audit-log entries on credential CRUD (Slice 3 of
// the Connections refactor). Same value as routes/api.oauth.js and
// routes/api.emailCredentials.js so all credential-management actions
// live under one tool tag.
const CONN_TOOL = 'connections';

// Fields that hold (or have held) a secret in `config` per credential type.
// Used by GET /api/credentials/:id to strip secrets before returning.
const SECRET_FIELDS_BY_TYPE = {
  oauth2:  ['client_secret'],
  bearer:  ['token'],
  api_key: ['key'],
  basic:   ['username', 'password'],
  internal: [],
};


// ─────────────────────────────────────────────────────────────
// MANAGEMENT API — Credentials (Slice 3 of the Connections refactor)
//
// Access split:
//   - LIST stays on jwtOrApiKey — needed for hook/sequence/workflow dropdowns,
//     but secrets and config are scrubbed.
//   - GET single, POST, PUT, DELETE, and the OAuth/reveal endpoints (in
//     routes/api.oauth.js) are admin-only via superuserOnlyFor('connections').
//
// Encryption-on-write for oauth2 client_secret: when type='oauth2' on POST,
// or when the resulting type is oauth2 on PUT, any non-empty plaintext
// client_secret in `config` is encrypted before being persisted. The
// isEncrypted() heuristic makes the route idempotent — if the admin saves
// a form that re-submits an already-encrypted value (because they didn't
// edit the secret field), we don't double-encrypt.
//
// Type changes on PUT clear all OAuth state columns (tokens, status, errors,
// timestamps, refresh_failure_count) so the credential starts clean.
// ─────────────────────────────────────────────────────────────

function reqMetaForConn(req) {
  return {
    ip:        req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
  };
}

function auditConn(db, row) {
  return auditAdminAction(db, row).catch(err =>
    console.error('[credentials] audit log failed:', err.message)
  );
}

// Parse a possibly-stringified JSON column value into an object/array, or
// fall through to null on parse error so we never throw mid-handler.
function parseJsonColumn(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); }
  catch (_) { return null; }
}

// Encrypt config.client_secret in place, but only if it's a non-empty string
// AND not already encrypted. Mutates and returns the same config object.
// Use only when the credential type is 'oauth2'.
function encryptOauth2ClientSecret(config) {
  if (!config || typeof config !== 'object') return config;
  const v = config.client_secret;
  if (typeof v === 'string' && v.length > 0 && !credentialCrypto.isEncrypted(v)) {
    config.client_secret = credentialCrypto.encrypt(v);
  }
  return config;
}

// LIST — any authenticated user (dropdown source).
// Returns id/name/type/allowed_urls/timestamps + non-secret oauth status
// fields. NEVER returns config, access_token, refresh_token, oauth_state,
// oauth_pkce_verifier — those are admin-only.
router.get('/api/credentials', jwtOrApiKey, async function listCredentials(req, res) {
  try {
    const [rows] = await req.db.query(
      `SELECT id, name, type, allowed_urls,
              created_at, updated_at,
              oauth_status, last_refreshed_at, refresh_failure_count,
              access_token_expires_at, refresh_token_expires_at,
              verbose
         FROM credentials
        ORDER BY name ASC`
    );
    for (const r of rows) {
      r.allowed_urls = parseJsonColumn(r.allowed_urls);
    }
    res.json({ status: 'success', credentials: rows });
  } catch (err) {
    console.error('[credentials] list credentials error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET single — admin only. Returns full row with secret-bearing fields in
// `config` stripped (set to null), plus oauth_state/oauth_pkce_verifier
// suppressed. Encrypted token columns are also not returned — those go
// through GET /:id/reveal in routes/api.oauth.js.
router.get('/api/credentials/:id', superuserOnlyFor(CONN_TOOL), async function getCredential(req, res) {
  const id = req.params.id;
  const meta = reqMetaForConn(req);
  try {
    const [[row]] = await req.db.query(
      `SELECT id, name, type, config, allowed_urls,
              created_at, updated_at,
              oauth_status, last_refreshed_at, refresh_failure_count,
              access_token_expires_at, refresh_token_expires_at,
              oauth_last_error, oauth_last_error_at,
              verbose
         FROM credentials WHERE id = ?`,
      [id]
    );
    if (!row) {
      return res.status(404).json({ status: 'error', message: 'Credential not found' });
    }

    row.config       = parseJsonColumn(row.config);
    row.allowed_urls = parseJsonColumn(row.allowed_urls);

    // Strip secret fields from config based on type
    if (row.config && typeof row.config === 'object') {
      const fields = SECRET_FIELDS_BY_TYPE[row.type] || [];
      for (const f of fields) {
        if (f in row.config) row.config[f] = null;
      }
    }

    auditConn(req.db, {
      tool: CONN_TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'success',
      ...meta,
      details: { credential_id: row.id, credential_name: row.name, credential_type: row.type },
    });

    res.json({ status: 'success', credential: row });
  } catch (err) {
    console.error('[credentials] get credential error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST — admin only. Encrypts oauth2 client_secret on the way in.
router.post('/api/credentials', superuserOnlyFor(CONN_TOOL), async function createCredential(req, res) {
  const meta = reqMetaForConn(req);
  try {
    const { name, type, config, allowed_urls, verbose } = req.body;
    if (!name || !type) {
      return res.status(400).json({ status: 'error', message: 'name and type are required' });
    }

    let effectiveConfig = config;
    if (type === 'oauth2' && config && typeof config === 'object') {
      effectiveConfig = encryptOauth2ClientSecret({ ...config });
    }

    const data = { name, type };
    if (effectiveConfig !== undefined) {
      data.config = effectiveConfig === null ? null : JSON.stringify(effectiveConfig);
    }
    if (allowed_urls !== undefined) {
      data.allowed_urls = allowed_urls === null ? null : JSON.stringify(allowed_urls);
    }
    if (verbose !== undefined) {
      data.verbose = verbose ? 1 : 0;
    }

    const id = await credentialService.createCredential(req.db, data);

    auditConn(req.db, {
      tool: CONN_TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'success',
      ...meta,
      details: { credential_id: id, credential_name: name, credential_type: type },
    });

    res.json({ status: 'success', id });
  } catch (err) {
    console.error('[credentials] create credential error:', err);
    auditConn(req.db, {
      tool: CONN_TOOL,
      userId: req.auth?.userId, username: req.auth?.username,
      route: req.originalUrl, method: req.method,
      status: 'failed', errorMessage: err.message,
      ...meta,
      details: { credential_name: req.body?.name ?? null, credential_type: req.body?.type ?? null, error: err.message },
    });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// PUT — admin only. Handles four things beyond the obvious update:
//   1. Deep-merge config (Slice 5 fix): when type is unchanged and
//      `req.body.config` is provided, we shallow-merge it into the existing
//      config rather than replacing wholesale. The Slice 4 admin UI sends
//      partial config objects when the user edits a single field — without
//      this merge, saving any one field (e.g. just auth_url) would silently
//      wipe every other key (client_id, scopes, token_url, etc.). The merge
//      is one level deep, which matches the schema's flat config shape.
//   2. For oauth2 credentials, encrypts client_secret on the way in. With
//      deep merge, "preserve existing" happens automatically (the existing
//      encrypted value survives the merge when admin omits the field). The
//      isEncrypted() heuristic keeps repeat submissions idempotent. Explicit
//      null or empty string clears the field.
//   3. Type-change: replaces config wholesale (the old type's shape is
//      meaningless for the new type) and clears all oauth-related columns
//      so the row is clean (no orphan tokens, status, errors, etc.).
//   4. If body has no `config` and type is unchanged, the existing config
//      stays untouched.
router.put('/api/credentials/:id', superuserOnlyFor(CONN_TOOL), async function updateCredential(req, res) {
  const id = req.params.id;
  const meta = reqMetaForConn(req);
  try {
    const [[existing]] = await req.db.query(
      `SELECT id, name, type, config FROM credentials WHERE id = ?`,
      [id]
    );
    if (!existing) {
      return res.status(404).json({ status: 'error', message: 'Credential not found' });
    }

    const existingConfig = parseJsonColumn(existing.config) || {};
    const newType        = req.body.type !== undefined ? req.body.type : existing.type;
    const typeChanging   = req.body.type !== undefined && req.body.type !== existing.type;

    const data = {};
    const fieldsChanged = [];

    if (req.body.name !== undefined) {
      data.name = req.body.name;
      fieldsChanged.push('name');
    }
    if (req.body.type !== undefined) {
      data.type = req.body.type;
      fieldsChanged.push('type');
    }
    if (req.body.allowed_urls !== undefined) {
      data.allowed_urls = req.body.allowed_urls === null
        ? null
        : JSON.stringify(req.body.allowed_urls);
      fieldsChanged.push('allowed_urls');
    }
    if (req.body.verbose !== undefined) {
      data.verbose = req.body.verbose ? 1 : 0;
      fieldsChanged.push('verbose');
    }

    // Config handling (Slice 5):
    //   (a) Body included config + type unchanged → deep-merge incoming
    //       into existing (one level deep — matches flat schema). This is
    //       the fix for the Slice-4-bug where saving any single config
    //       field wiped the others.
    //   (b) Body included config + type changing → replace wholesale.
    //       The old config shape is meaningless to the new type.
    //   (c) Body included config === null → clear it explicitly.
    //   (d) Body did NOT include config but type is changing → wipe config
    //       (the existing one is for the wrong type).
    //   (e) Body did NOT include config and type isn't changing → leave
    //       config alone (don't touch).
    //
    // OAuth2 client_secret encryption-on-write applies to (a)/(b)/(c)
    // whenever the resulting type is oauth2. With merge semantics, the
    // "preserve existing encrypted secret when admin didn't touch the
    // field" behavior happens automatically — the existing value lives
    // in `existingConfig` and survives the merge.
    if (req.body.config !== undefined) {
      let effectiveConfig;
      if (req.body.config === null) {
        // Explicit null: caller wants to clear config entirely.
        effectiveConfig = null;
      } else if (typeof req.body.config !== 'object' || Array.isArray(req.body.config)) {
        return res.status(400).json({ status: 'error', message: 'config must be a JSON object or null' });
      } else if (typeChanging) {
        // Wholesale replace on type change — old shape is meaningless.
        effectiveConfig = { ...req.body.config };
      } else {
        // Deep-merge incoming into existing (one-level shallow merge).
        effectiveConfig = { ...existingConfig, ...req.body.config };
      }

      if (newType === 'oauth2' && effectiveConfig && typeof effectiveConfig === 'object') {
        const cs = effectiveConfig.client_secret;
        if (cs === null || cs === '') {
          // Explicit clear.
          effectiveConfig.client_secret = null;
        } else if (typeof cs === 'string' && cs.length > 0) {
          // Encrypt plaintext; idempotent if already encrypted.
          encryptOauth2ClientSecret(effectiveConfig);
        } else if (cs !== undefined) {
          return res.status(400).json({ status: 'error', message: 'client_secret must be a string' });
        }
        // cs === undefined: not present in merged config (e.g. type
        // change with no secret in incoming) — leave alone.
      }

      data.config = effectiveConfig === null ? null : JSON.stringify(effectiveConfig);
      fieldsChanged.push('config');
    } else if (typeChanging) {
      // Type changed but no new config supplied — old config is for old type.
      // Wipe it; admin can re-PUT with the right shape.
      data.config = null;
      fieldsChanged.push('config');
    }

    await credentialService.updateCredential(req.db, id, data);

    // Type change: clear all oauth columns so the row is clean for whatever
    // type it now is. Done as a follow-up UPDATE to avoid widening the
    // credentialService.updateCredential surface (Slice 3 doesn't touch services).
    if (typeChanging) {
      await req.db.query(
        `UPDATE credentials SET
           access_token = NULL,
           refresh_token = NULL,
           access_token_expires_at = NULL,
           refresh_token_expires_at = NULL,
           last_refreshed_at = NULL,
           oauth_status = NULL,
           oauth_state = NULL,
           oauth_pkce_verifier = NULL,
           oauth_last_error = NULL,
           oauth_last_error_at = NULL,
           refresh_failure_count = 0
         WHERE id = ?`,
        [id]
      );
      fieldsChanged.push('oauth_state_cleared');
    }

    auditConn(req.db, {
      tool: CONN_TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'success',
      ...meta,
      details: {
        credential_id: Number(id),
        credential_name: data.name ?? existing.name,
        credential_type: newType,
        fields_changed: fieldsChanged,
      },
    });

    res.json({ status: 'success' });
  } catch (err) {
    console.error('[credentials] update credential error:', err);
    auditConn(req.db, {
      tool: CONN_TOOL,
      userId: req.auth?.userId, username: req.auth?.username,
      route: req.originalUrl, method: req.method,
      status: 'failed', errorMessage: err.message,
      ...meta,
      details: { credential_id: Number(id), error: err.message },
    });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// DELETE — admin only.
router.delete('/api/credentials/:id', superuserOnlyFor(CONN_TOOL), async function deleteCredential(req, res) {
  const id = req.params.id;
  const meta = reqMetaForConn(req);
  try {
    const [[existing]] = await req.db.query(
      `SELECT id, name, type FROM credentials WHERE id = ?`,
      [id]
    );
    if (!existing) {
      return res.status(404).json({ status: 'error', message: 'Credential not found' });
    }

    await credentialService.deleteCredential(req.db, id);

    auditConn(req.db, {
      tool: CONN_TOOL,
      userId: req.auth.userId, username: req.auth.username,
      route: req.originalUrl, method: req.method,
      status: 'success',
      ...meta,
      details: { credential_id: existing.id, credential_name: existing.name, credential_type: existing.type },
    });

    res.json({ status: 'success' });
  } catch (err) {
    console.error('[credentials] delete credential error:', err);
    auditConn(req.db, {
      tool: CONN_TOOL,
      userId: req.auth?.userId, username: req.auth?.username,
      route: req.originalUrl, method: req.method,
      status: 'failed', errorMessage: err.message,
      ...meta,
      details: { credential_id: Number(id), error: err.message },
    });
    res.status(500).json({ status: 'error', message: err.message });
  }
});


module.exports = router;
