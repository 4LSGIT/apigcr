// routes/admin.elevate.js
//
/**
 * SU step-up — POST /admin/elevate (2026-08-16, origin-separation rider B).
 *
 * A stolen/leaked staff JWT alone must not be enough to run the SU tools
 * (DB console, users, API keys, connections, …). Every superuserOnlyFor()
 * chain now also requires a short-lived ELEVATION token (X-SU-Elevation
 * header — see lib/auth.superuser.js). This route mints it:
 *
 *   POST /admin/elevate   body { password }
 *     → 200 { token, expires_in: 900 }   on bcrypt match against the
 *                                        CALLER's own users.password_hash
 *     → 401 { error, code:'bad_password' }        wrong/empty password
 *     → 403 { error, code:'no_password' }         account has no hash
 *
 * Guard chain: superuserPreElevationFor('elevate') — jwtOrApiKey + the SU
 * check (which rejects API-key auth: elevation is a HUMAN act) + the
 * per-tool rate limit (RATE_BY_TOOL.elevate = 10/min: with a stolen JWT this
 * endpoint is an online oracle for the SU's password, so the ceiling is
 * deliberately low; override via SU_RATE_LIMIT_ELEVATE). It deliberately
 * does NOT include the elevation check itself — that would be circular.
 *
 * A non-SU caller is 403'd by the chain before the password is ever read,
 * and even a hand-forged elevation token never helps a non-SU: the elevation
 * check in superuserOnlyFor runs AFTER the SU check — it ADDS, never
 * substitutes.
 *
 * Every outcome writes admin_audit_log (tool 'elevate'):
 *   elevated / rejected_bad_password / rejected_no_hash
 * (the chain itself audits rejected_not_su / rejected_rate_limit).
 *
 * Kill switch: env SU_STEPUP=0 makes the elevation CHECK a pass-through
 * (lib/auth.superuser.js). This route stays functional either way — minting
 * an unneeded token is harmless.
 *
 * Auto-mounts via the routes/ scan in server.js.
 */

'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();

const {
  superuserPreElevationFor,
  mintElevationToken,
  auditAdminAction,
} = require('../lib/auth.superuser');

const TOOL = 'elevate';
const ELEV_TTL_S = 15 * 60; // keep in sync with lib/auth.superuser.js

function reqIp(req) {
  return req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress;
}

router.post('/admin/elevate', ...superuserPreElevationFor(TOOL), async (req, res) => {
  const started = Date.now();
  const base = {
    tool: TOOL,
    userId: req.auth.userId,
    username: req.auth.username,
    route: req.originalUrl,
    method: req.method,
    ip: reqIp(req),
    userAgent: req.headers['user-agent'] || 'unknown',
  };
  const audit = (row) =>
    auditAdminAction(req.db, { ...base, ...row }).catch((err) =>
      console.error('[elevate] audit log failed:', err.message)
    );

  try {
    const password =
      req.body && typeof req.body.password === 'string' ? req.body.password : '';
    if (!password) {
      audit({ status: 'rejected_bad_password', errorMessage: 'empty password' });
      return res
        .status(401)
        .json({ error: 'Password required', code: 'bad_password' });
    }

    // The CALLER's own hash — elevation never verifies anyone else's
    // credential. users PK column is `user` (routes/auth.login.js).
    const [rows] = await req.db.query(
      'SELECT password_hash FROM users WHERE user = ?',
      [req.auth.userId]
    );
    const hash = rows && rows[0] && rows[0].password_hash;
    if (!hash) {
      audit({ status: 'rejected_no_hash' });
      return res.status(403).json({
        error: 'Account not enabled for password login',
        code: 'no_password',
      });
    }

    const ok = await bcrypt.compare(password, hash);
    if (!ok) {
      audit({ status: 'rejected_bad_password' });
      return res
        .status(401)
        .json({ error: 'Incorrect password', code: 'bad_password' });
    }

    audit({
      status: 'elevated',
      durationMs: Date.now() - started,
      details: { ttl_seconds: ELEV_TTL_S },
    });
    return res.json({
      token: mintElevationToken(req.auth.userId),
      expires_in: ELEV_TTL_S,
    });
  } catch (err) {
    console.error('[elevate] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
