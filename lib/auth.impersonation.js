// lib/auth.impersonation.js
//
// Shared handling for IT "View as" JWTs.  The token still carries the
// target user's normal staff identity in its top-level claims, so every read
// follows exactly the target's roles, entitlements and user UI config.  The
// `act` claim records the human who started the session (RFC 8693's actor
// shape), while the target remains the effective user for authorization and
// application attribution. Read-only mode is enforced here so it applies to
// both staff-auth middleware stacks, not only to controls in the browser.
//
// Fail closed: ANY signed token carrying view_as === true is read-only unless
// it holds an explicit Live claim AND a well-formed actor. Live tokens are
// minted only on demand by POST /api/impersonation/mode, for an actor whose
// DB row holds `su` (Fred's ruling 2026-10-21: it = read-only View-as only).

'use strict';

function isViewAsPayload(payload) {
  return !!payload && payload.view_as === true;
}

function actorFromPayload(payload) {
  if (!isViewAsPayload(payload) || !payload.act || typeof payload.act !== 'object') {
    return null;
  }
  const userId = Number(payload.act.sub);
  const username = typeof payload.act.username === 'string' ? payload.act.username : '';
  if (!Number.isInteger(userId) || userId < 1 || !username) return null;
  return { userId, username };
}

function isLiveViewAs(payload) {
  return isViewAsPayload(payload) && payload.view_as_mode === 'live' && !!actorFromPayload(payload);
}

// jwt_api_audit_log identity for a verified staff payload. App-level
// attribution (created_by, log_by …) stays on the target by design; the
// gateway log is where the real actor is recorded. auth_type is varchar(20).
function auditIdentity(payload) {
  const target = (payload && (payload.username || payload.sub)) || null;
  if (!isViewAsPayload(payload)) return { authType: 'jwt', username: target };
  const actor = actorFromPayload(payload);
  return {
    authType: isLiveViewAs(payload) ? 'jwt_view_as_live' : 'jwt_view_as',
    username: `${target} [by ${actor ? `${actor.username}#${actor.userId}` : 'unknown'}]`,
  };
}

// Mounted BEFORE the auth middleware on the View-as control routes only
// (mode switch, exit): they must accept a POST from a read-only View-as
// token. Same marker pattern as req._keyCapabilityGate.
function markViewAsControl(req, _res, next) {
  req._viewAsControl = true;
  next();
}

function rejectReadonlyViewAsWrite(req, res, payload, logAttempt) {
  if (!isViewAsPayload(payload) || isLiveViewAs(payload)) return false;
  if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())) return false;
  if (req._viewAsControl === true) return false;

  if (typeof logAttempt === 'function') {
    const who = auditIdentity(payload);
    logAttempt(req, who.authType, who.username, 'forbidden_view_as_write');
  }
  res.status(403).json({
    error: 'View-as is in read-only mode.',
    code: 'view_as_read_only',
  });
  return true;
}

module.exports = {
  isViewAsPayload, actorFromPayload, isLiveViewAs, auditIdentity,
  markViewAsControl, rejectReadonlyViewAsWrite,
};
