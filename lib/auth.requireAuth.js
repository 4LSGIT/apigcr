// lib/auth.requireAuth.js
//
// Unified auth middleware factory — Client Portal Slice 1.
//
//   requireAuth({ audience, roles, allowApiKey }) → Express middleware
//
//   audience:    'contact' | 'staff'   (required)
//   roles:       string[]              staff only; default []. Non-empty ⇒
//                                      caller must hold ≥1 listed role
//                                      ('it' bypasses the role check —
//                                      ONLY the role check, never the
//                                      audience gate).
//   allowApiKey: boolean               staff only; default false. When true,
//                                      an x-api-key header delegates
//                                      wholesale to lib/auth.jwtOrApiKey.
//
// MOUNTING STATUS THIS SLICE: only the CONTACT path is mounted (portal
// routes). The STAFF path ships complete but is mounted NOWHERE — all staff
// routes stay on jwtOrApiKey (phased coexistence; later M-slices migrate
// them route-by-route). The staff path deliberately mirrors jwtOrApiKey's
// JWT semantics exactly and writes the SAME jwt_api_audit_log rows via the
// reused logJwtApiAttempt — a route migrated to requireAuth must not vanish
// from the audit trail.
//
// Design note: opts.audience is a switch, not a boolean — future audiences
// (e.g. a referral-partner portal) slot in as new cases without reshaping
// the opts.
//
// CONTACT path per request:
//   1. res.on('finish') hook installed FIRST → one portal_access_log row per
//      request (even failures). contact_id filled once known; case_id from
//      req.portalCaseId (S2 hook — nothing sets it yet); event from
//      req.portalLogEvent (routes may set it, e.g. logout).
//   2. Bearer JWT, aud === 'contact', integer sub.
//   3. One indexed contacts read: portal_enabled must be 1 and token ver
//      must equal portal_session_version (bump = all-device revoke).
//   4. req.auth = { type: 'portal', contactId }.
//   EVERY failure → uniform 401 { error: 'Unauthorized' } — no branch
//   distinguishability (no oracle for token-vs-disabled-vs-revoked).
//   Portal requests are logged to portal_access_log, NOT jwt_api_audit_log.

'use strict';

const jwt = require('jsonwebtoken');
const jwtOrApiKey = require('./auth.jwtOrApiKey');
const { logJwtApiAttempt } = jwtOrApiKey;
const { getClientIp } = require('./rateLimiter');

// ── portal access log (fire-and-forget) ─────────────────────────────────────

function insertPortalAccessLog(db, row) {
  // Returns the promise (testability) but self-catches — callers never await.
  return db.query(
    `INSERT INTO portal_access_log
       (contact_id, case_id, route, method, status, event, meta, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.contact_id ?? null,
      row.case_id ?? null,
      row.route,
      row.method ?? '',
      row.status ?? null,
      row.event ?? null,
      row.meta != null ? JSON.stringify(row.meta) : null,
      row.ip ?? null,
    ]
  ).catch(err => console.error('[portal] access log insert failed:', err.message));
}

// ── contact path ────────────────────────────────────────────────────────────

function contactMiddleware(req, res, next) {
  // 1. Log hook FIRST — installed before any check so failures log too.
  const logRef = { contactId: null };
  res.on('finish', () => {
    insertPortalAccessLog(req.db, {
      contact_id: logRef.contactId,
      case_id: req.portalCaseId || null,        // S2 hook — unset this slice
      route: req.originalUrl,
      method: req.method,
      status: res.statusCode,
      event: req.portalLogEvent || null,        // routes may set (e.g. logout)
      ip: getClientIp(req),
    });
  });

  const fail = () => res.status(401).json({ error: 'Unauthorized' });

  (async () => {
    // 2. Bearer JWT with contact audience.
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return fail();

    let payload;
    try {
      payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    } catch (_) {
      return fail();
    }
    if (payload.aud !== 'contact' || !Number.isInteger(payload.sub)) return fail();

    // 3. Enabled + session-version check (one indexed PK read).
    const [[contact]] = await req.db.query(
      'SELECT portal_enabled, portal_session_version FROM contacts WHERE contact_id = ?',
      [payload.sub]
    );
    if (!contact) return fail();
    if (contact.portal_enabled !== 1) return fail();
    if (payload.ver !== contact.portal_session_version) return fail();

    // 4. Success.
    req.auth = { type: 'portal', contactId: payload.sub };
    logRef.contactId = payload.sub;
    next();
  })().catch(err => {
    // DB error etc. — same uniform 401 (a distinguishable 500 here would be
    // a partial oracle and leaks nothing useful to a legitimate client).
    console.error('[portal] requireAuth(contact) error:', err.message);
    fail();
  });
}

// ── staff path ──────────────────────────────────────────────────────────────

function roleCheckPasses(roles, required) {
  if (!required.length) return true;
  if (roles.includes('it')) return true;           // bypasses ONLY the role check
  return required.some(r => roles.includes(r));
}

function makeStaffMiddleware(opts) {
  const required = Array.isArray(opts.roles) ? opts.roles : [];
  const allowApiKey = !!opts.allowApiKey;

  return function staffAuth(req, res, next) {
    // 1. API-key delegation — wholesale to jwtOrApiKey (its own audit rows,
    //    dual-slot internal key, external api_keys, refresh-on-miss, and its
    //    JWT fallthrough all apply unchanged).
    if (allowApiKey && req.headers['x-api-key']) {
      return jwtOrApiKey(req, res, () => {
        if (req.auth?.type === 'api_key') {
          // Internal/automation trust — role check skipped (current reality:
          // api keys are the app's own credential or named integrations).
          return next();
        }
        // jwtOrApiKey fell through to its JWT branch (unrecognized key +
        // Bearer header) and authenticated a staff JWT — req.auth.roles is
        // present via the D3 change. Apply the role gate.
        const roles = Array.isArray(req.auth?.roles) ? req.auth.roles : [];
        if (!roleCheckPasses(roles, required)) {
          return res.status(403).json({ error: 'Forbidden' });
        }
        next();
      });
    }

    // 2. Bearer JWT — mirrors jwtOrApiKey's JWT branch semantics exactly,
    //    including identical jwt_api_audit_log rows via the shared logger.
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        logJwtApiAttempt(req, 'none', null, 'unauthorized');
        return res.status(401).json({ error: 'Unauthorized' });
      }

      let payload;
      try {
        payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
      } catch (_) {
        logJwtApiAttempt(req, 'none', null, 'invalid_token');
        return res.status(401).json({ error: 'Invalid token or API key' });
      }

      // Audience guard — same as jwtOrApiKey's D1 guard: legacy no-aud
      // tokens pass, aud:"staff" passes, anything else (portal) rejected.
      if (payload.aud && payload.aud !== 'staff') {
        logJwtApiAttempt(req, 'jwt', payload.username || payload.sub, 'unauthorized');
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!payload.sub || !payload.user_auth || !payload.user_auth.startsWith('authorized')) {
        logJwtApiAttempt(req, 'jwt', payload.username || payload.sub, 'unauthorized');
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (process.env.JWT_VERSION && payload.ver !== parseInt(process.env.JWT_VERSION)) {
        logJwtApiAttempt(req, 'jwt', payload.username || payload.sub, 'unauthorized');
        return res.status(401).json({ error: 'Token expired (version mismatch)' });
      }

      const roles = Array.isArray(payload.roles) ? payload.roles : [];

      // 3. Role gate — AFTER the audience/auth gates. Legacy tokens without
      //    a roles claim ⇒ [] ⇒ fail closed on roles-required routes.
      //    403 (authz failure, matching auth.superuser's status choice) vs
      //    the 401s above (authn failures).
      if (!roleCheckPasses(roles, required)) {
        logJwtApiAttempt(req, 'jwt', payload.username || payload.sub, 'unauthorized');
        return res.status(403).json({ error: 'Forbidden' });
      }

      // 4. Success — jwtOrApiKey's req.auth shape + roles.
      req.auth = {
        type: 'jwt',
        userId: payload.sub,
        username: payload.username,
        user_type: payload.user_type,
        user_auth: payload.user_auth,
        roles,
      };
      logJwtApiAttempt(req, 'jwt', payload.username, 'authorized');
      next();
    } catch (err) {
      console.error('[requireAuth] staff path error:', err.message);
      logJwtApiAttempt(req, 'none', null, 'invalid_token');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  };
}

// ── factory ─────────────────────────────────────────────────────────────────

function requireAuth(opts = {}) {
  switch (opts.audience) {
    case 'contact':
      return contactMiddleware;
    case 'staff':
      return makeStaffMiddleware(opts);
    default:
      // Config error, not a request error — fail at mount time, loudly.
      throw new Error(`requireAuth: unknown audience ${JSON.stringify(opts.audience)}`);
  }
}

module.exports = requireAuth;
module.exports._insertPortalAccessLog = insertPortalAccessLog; // shared with portalAuthService
