// lib/auth.impersonation.js
//
// Shared handling for IT "View as" JWTs.  The token still carries the
// target user's normal staff identity in its top-level claims, so every read
// follows exactly the target's roles, entitlements and user UI config.  The
// `act` claim records the human who started the session (RFC 8693's actor
// shape), and `view_as` makes the deliberately read-only contract explicit.

'use strict';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function actorFromPayload(payload) {
  if (!payload || payload.view_as !== true || !payload.act || typeof payload.act !== 'object') {
    return null;
  }
  const userId = Number(payload.act.sub);
  const username = typeof payload.act.username === 'string' ? payload.act.username : '';
  if (!Number.isInteger(userId) || userId < 1 || !username) return null;
  return { userId, username };
}

function isViewAsPayload(payload) {
  return actorFromPayload(payload) !== null;
}

function rejectViewAsWrite(req, res, payload, logAttempt) {
  const actor = actorFromPayload(payload);
  if (!actor || SAFE_METHODS.has(String(req.method || '').toUpperCase())) return false;

  if (typeof logAttempt === 'function') {
    logAttempt(req, 'jwt', `${payload.username || payload.sub} via ${actor.username}`,
      'forbidden_view_as_write');
  }
  res.status(403).json({
    error: 'View-as sessions are read-only. Exit View as to make changes.',
    code: 'view_as_read_only',
  });
  return true;
}

module.exports = { actorFromPayload, isViewAsPayload, rejectViewAsWrite, SAFE_METHODS };
