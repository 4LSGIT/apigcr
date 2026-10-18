// lib/auth.impersonation.js
//
// Shared handling for IT "View as" JWTs.  The token still carries the
// target user's normal staff identity in its top-level claims, so every read
// follows exactly the target's roles, entitlements and user UI config.  The
// `act` claim records the human who started the session (RFC 8693's actor
// shape), while the target remains the effective user for authorization and
// application attribution. Read-only mode is enforced here so it applies to
// both staff-auth middleware stacks, not only to controls in the browser.

'use strict';

function actorFromPayload(payload) {
  if (!payload || payload.view_as !== true || !payload.act || typeof payload.act !== 'object') {
    return null;
  }
  const userId = Number(payload.act.sub);
  const username = typeof payload.act.username === 'string' ? payload.act.username : '';
  if (!Number.isInteger(userId) || userId < 1 || !username) return null;
  return { userId, username };
}

function rejectReadonlyViewAsWrite(req, res, payload, logAttempt) {
  // Fail closed for tokens minted before modes existed: only an explicit Live
  // claim may write.
  if (!actorFromPayload(payload) || payload.view_as_mode === 'live') return false;
  if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())) return false;

  if (typeof logAttempt === 'function') {
    logAttempt(req, 'jwt', payload.username || payload.sub, 'forbidden_view_as_write');
  }
  res.status(403).json({
    error: 'View-as is in read-only mode. Switch to Live to make changes.',
    code: 'view_as_read_only',
  });
  return true;
}

module.exports = { actorFromPayload, rejectReadonlyViewAsWrite };
