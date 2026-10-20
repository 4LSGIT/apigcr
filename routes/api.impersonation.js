// routes/api.impersonation.js
//
// IT diagnostic "View as" sessions.  These are intentionally not password
// resets and do not reuse a target's credentials.  The server mints a fresh,
// short-lived JWT carrying the target identity plus an `act` claim naming the
// initiating IT/SU. Sessions start read-only; start returns ONLY the
// read-only token.
//
// Live mode is SU-only (Fred's ruling 2026-10-21): POST /api/impersonation/mode
// mints a Live token on demand, authenticated by the current View-as token,
// and only when the REAL actor's DB row (not the token) holds `su` and the
// target is still eligible. Every mode switch and every exit writes an
// admin_audit_log row attributed to the actor. A switch never extends the
// session: the new token keeps the current token's exp (30-minute ceiling
// from start, hardcoded VIEW_AS_TTL).

'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const requireAuth = require('../lib/auth.requireAuth');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { auditAdminAction, rowIsSuperuser } = require('../lib/auth.superuser');
const { markViewAsControl } = require('../lib/auth.impersonation');

const router = express.Router();
const canViewAs = requireAuth({ audience: 'staff', can: 'users.impersonate' });
const VIEW_AS_TTL = '30m';
const BLOCKED_TARGET_ROLES = new Set(['it', 'su', 'automation']);
const MODES = new Set(['readonly', 'live']);

function rolesOf(csv) {
  return String(csv || '').split(',').map(s => s.trim()).filter(Boolean);
}

function eligibleTarget(row) {
  if (!row || Number(row.user) === 0) return false;
  if (!String(row.user_auth || '').startsWith('authorized')) return false;
  return !rolesOf(row.roles).some(r => BLOCKED_TARGET_ROLES.has(r));
}

// `who` defaults to the authenticated caller (the IT/SU at start). On the
// control routes the caller is the TARGET, so they pass the actor explicitly.
function audit(req, status, details, who = { userId: req.auth?.userId ?? null, username: req.auth?.username ?? null }) {
  return auditAdminAction(req.db, {
    tool: 'view_as',
    userId: who.userId,
    username: who.username,
    route: req.originalUrl,
    method: req.method,
    status,
    ip: req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
    details,
  });
}

function loadUser(db, id) {
  return db.query(
    `SELECT user, username, user_name, user_type, user_auth, roles
       FROM users
      WHERE user = ?
      LIMIT 1`,
    [id]
  ).then(([[row]]) => row || null);
}

// The control routes accept only a well-formed View-as session (a token
// whose act claim is malformed carries no impersonator — refused).
function requireViewAsSession(req, res, next) {
  if (!req.auth?.impersonator) {
    return res.status(403).json({ status: 'error', message: 'No active View-as session' });
  }
  next();
}
const viewAsControl = [markViewAsControl, jwtOrApiKey, requireViewAsSession];

function bearerPayload(req) {
  // Already verified by jwtOrApiKey; decode only to read exp and claims.
  return jwt.decode(String(req.headers.authorization || '').slice(7)) || {};
}

// Minimal list for the Users pane.  IT does not gain users.manage or see the
// password/reset metadata returned by /api/admin/users.
router.get('/api/impersonation/users', canViewAs, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT user, username, user_name, user_initials, user_auth, roles, user_type,
              email, phone, does_appts, allow_sms, ringcentral
         FROM users
        ORDER BY user ASC`
    );
    res.json({
      status: 'success',
      users: rows.map(row => ({ ...row, can_view_as: eligibleTarget(row) && Number(row.user) !== Number(req.auth.userId) })),
      can_manage: Array.isArray(req.auth.roles) && req.auth.roles.includes('su'),
    });
  } catch (err) {
    console.error('GET /api/impersonation/users error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch users' });
  }
});

router.post('/api/impersonation/users/:id/start', canViewAs, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ status: 'error', message: 'Invalid user id' });
  }
  if (req.auth.impersonator || req.auth.viewAs) {
    return res.status(400).json({ status: 'error', message: 'Exit the current View-as session first' });
  }
  if (id === Number(req.auth.userId)) {
    return res.status(400).json({ status: 'error', message: 'You are already logged in as this user' });
  }

  try {
    const target = await loadUser(req.db, id);
    if (!target) return res.status(404).json({ status: 'error', message: 'User not found' });
    if (!eligibleTarget(target)) {
      await audit(req, 'view_as_rejected_target', { target_user_id: id });
      return res.status(403).json({
        status: 'error',
        message: 'Only active, non-privileged human users can be viewed as',
      });
    }

    // Cosmetic hint for the shell's Live toggle; POST /mode re-reads the DB.
    const liveAllowed = Array.isArray(req.auth.roles) && req.auth.roles.includes('su');
    const token = jwt.sign({
      sub: target.user, username: target.username,
      user_type: target.user_type, user_auth: target.user_auth,
      aud: 'staff', roles: rolesOf(target.roles),
      ver: parseInt(process.env.JWT_VERSION || 1),
      view_as: true,
      view_as_mode: 'readonly',
      view_as_live_allowed: liveAllowed,
      act: { sub: String(req.auth.userId), username: req.auth.username },
      iat: Math.floor(Date.now() / 1000),
    }, process.env.JWT_SECRET, { expiresIn: VIEW_AS_TTL });

    await audit(req, 'view_as_started', {
      target_user_id: target.user,
      target_username: target.username,
      ttl: VIEW_AS_TTL,
      initial_mode: 'readonly',
      live_allowed: liveAllowed,
    });
    res.json({
      status: 'success', token,
      initial_mode: 'readonly',
      live_allowed: liveAllowed,
      target: { user: target.user, username: target.username, user_name: target.user_name },
      expires_in_seconds: 30 * 60,
    });
  } catch (err) {
    console.error(`POST /api/impersonation/users/${id}/start error:`, err);
    res.status(500).json({ status: 'error', message: 'Failed to start View as' });
  }
});

// Switch the current View-as session's mode. Body: { mode: 'live'|'readonly' }.
router.post('/api/impersonation/mode', ...viewAsControl, async (req, res) => {
  const mode = req.body?.mode;
  const actor = req.auth.impersonator;
  if (!MODES.has(mode)) {
    return res.status(400).json({ status: 'error', message: "mode must be 'readonly' or 'live'" });
  }
  try {
    const current = bearerPayload(req);
    // jwt.sign without exp mints a token that never expires: fail closed.
    if (!Number.isInteger(current.exp)) {
      return res.status(401).json({ status: 'error', message: 'View-as session has no expiry' });
    }
    const details = { target_user_id: Number(req.auth.userId), target_username: req.auth.username, mode };

    // The Live gate reads the actor's row at decision time (freshness rule,
    // ACCESS_CONTROL_DESIGN §2.3), never the token: a demoted or disabled
    // SU gets nothing, and an `it` actor never reaches Live.
    if (mode === 'live') {
      const actorRow = await loadUser(req.db, actor.userId);
      if (!rowIsSuperuser(actorRow)) {
        await audit(req, 'view_as_live_rejected', details, actor);
        return res.status(403).json({ status: 'error', message: 'Live View-as is superuser-only', code: 'view_as_live_forbidden' });
      }
    }
    const target = await loadUser(req.db, req.auth.userId);
    if (!eligibleTarget(target)) {
      await audit(req, 'view_as_rejected_target', details, actor);
      return res.status(403).json({ status: 'error', message: 'This user can no longer be viewed as' });
    }

    const token = jwt.sign({
      sub: target.user, username: target.username,
      user_type: target.user_type, user_auth: target.user_auth,
      aud: 'staff', roles: rolesOf(target.roles),
      ver: parseInt(process.env.JWT_VERSION || 1),
      view_as: true,
      view_as_mode: mode,
      view_as_live_allowed: current.view_as_live_allowed === true,
      act: { sub: String(actor.userId), username: actor.username },
      iat: Math.floor(Date.now() / 1000),
      exp: current.exp,
    }, process.env.JWT_SECRET);

    await audit(req, mode === 'live' ? 'view_as_live' : 'view_as_readonly', details, actor);
    res.json({ status: 'success', token, mode });
  } catch (err) {
    console.error('POST /api/impersonation/mode error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to switch View-as mode' });
  }
});

// Best-effort exit record; the shell drops the View-as token whatever this returns.
router.post('/api/impersonation/exit', ...viewAsControl, async (req, res) => {
  try {
    await audit(req, 'view_as_exited', {
      target_user_id: Number(req.auth.userId),
      target_username: req.auth.username,
      mode: bearerPayload(req).view_as_mode === 'live' ? 'live' : 'readonly',
    }, req.auth.impersonator);
    res.json({ status: 'success' });
  } catch (err) {
    console.error('POST /api/impersonation/exit error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to record View-as exit' });
  }
});

module.exports = router;
module.exports._test = { rolesOf, eligibleTarget, VIEW_AS_TTL, BLOCKED_TARGET_ROLES };
