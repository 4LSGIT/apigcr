// routes/api.impersonation.js
//
// IT diagnostic "View as" sessions.  These are intentionally not password
// resets and do not reuse a target's credentials.  The server mints a fresh,
// short-lived JWT carrying the target identity plus an `act` claim naming the
// initiating IT/SU. The server returns paired read-only/live tokens so the
// top-bar toggle remains server-enforced. Sessions start read-only.

'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const requireAuth = require('../lib/auth.requireAuth');
const { auditAdminAction } = require('../lib/auth.superuser');

const router = express.Router();
const canViewAs = requireAuth({ audience: 'staff', can: 'users.impersonate' });
const VIEW_AS_TTL = '30m';
const BLOCKED_TARGET_ROLES = new Set(['it', 'su']);

function rolesOf(csv) {
  return String(csv || '').split(',').map(s => s.trim()).filter(Boolean);
}

function eligibleTarget(row) {
  if (!row || Number(row.user) === 0) return false;
  if (!String(row.user_auth || '').startsWith('authorized')) return false;
  return !rolesOf(row.roles).some(r => BLOCKED_TARGET_ROLES.has(r));
}

function audit(req, status, details) {
  return auditAdminAction(req.db, {
    tool: 'view_as',
    userId: req.auth?.userId ?? null,
    username: req.auth?.username ?? null,
    route: req.originalUrl,
    method: req.method,
    status,
    ip: req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
    details,
  });
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
  if (req.auth.impersonator) {
    return res.status(400).json({ status: 'error', message: 'Exit the current View-as session first' });
  }
  if (id === Number(req.auth.userId)) {
    return res.status(400).json({ status: 'error', message: 'You are already logged in as this user' });
  }

  try {
    const [[target]] = await req.db.query(
      `SELECT user, username, user_name, user_type, user_auth, roles
         FROM users
        WHERE user = ?
        LIMIT 1`,
      [id]
    );
    if (!target) return res.status(404).json({ status: 'error', message: 'User not found' });
    if (!eligibleTarget(target)) {
      await audit(req, 'view_as_rejected_target', { target_user_id: id });
      return res.status(403).json({
        status: 'error',
        message: 'Only active, non-privileged human users can be viewed as',
      });
    }

    const claims = {
      sub: target.user, username: target.username,
      user_type: target.user_type, user_auth: target.user_auth,
      aud: 'staff', roles: rolesOf(target.roles),
      ver: parseInt(process.env.JWT_VERSION || 1),
      view_as: true,
      act: { sub: String(req.auth.userId), username: req.auth.username },
      iat: Math.floor(Date.now() / 1000),
    };
    const readonlyToken = jwt.sign({ ...claims, view_as_mode: 'readonly' }, process.env.JWT_SECRET, { expiresIn: VIEW_AS_TTL });
    const liveToken = jwt.sign({ ...claims, view_as_mode: 'live' }, process.env.JWT_SECRET, { expiresIn: VIEW_AS_TTL });

    await audit(req, 'view_as_started', {
      target_user_id: target.user,
      target_username: target.username,
      ttl: VIEW_AS_TTL,
      initial_mode: 'readonly',
    });
    res.json({
      status: 'success', token: readonlyToken,
      readonly_token: readonlyToken, live_token: liveToken,
      initial_mode: 'readonly',
      target: { user: target.user, username: target.username, user_name: target.user_name },
      expires_in_seconds: 30 * 60,
    });
  } catch (err) {
    console.error(`POST /api/impersonation/users/${id}/start error:`, err);
    res.status(500).json({ status: 'error', message: 'Failed to start View as' });
  }
});

module.exports = router;
module.exports._test = { rolesOf, eligibleTarget, VIEW_AS_TTL, BLOCKED_TARGET_ROLES };
