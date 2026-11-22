// whoami — who Casey is acting as, from ctx.auth (Casey v2 S1, design §4.2).
//
// No DB read: the JWT's claims are the identity every route judges by, and
// every capability is a pure function of them (lib/capabilities.can). The
// elevation flag reads the caller's X-SU-Elevation header the same way
// makeElevationCheck does — a live token for THIS user id — so Casey can say
// "this needs the password prompt" before proposing an SU card (S3).
'use strict';

const { CAPABILITIES, can } = require('../../../lib/capabilities');
const { isSuperuser, verifyElevationToken, stepupEnabled } = require('../../../lib/auth.superuser');

module.exports = {
  name: 'whoami',
  description: 'Who you are acting as: user id, username, roles, every capability this identity holds, whether it is a superuser, and whether a superuser elevation is live right now. Call it before deciding what a user may do; never guess roles.',
  input_schema: { type: 'object', properties: {}, required: [] },
  untrusted: false,
  async run(ctx) {
    const auth = ctx.auth || null;
    if (!auth) return { authenticated: false };
    const caps = Object.keys(CAPABILITIES).filter((c) => { try { return can(auth, c); } catch (_) { return false; } }).sort();
    if (auth.type === 'api_key') {
      return {
        authenticated: true, kind: 'api_key', key_label: auth.key_label || null,
        scopes: auth.scopes == null ? null : [...auth.scopes],
        capabilities: caps, is_superuser: false, elevated: false,
        note: 'A machine key: routes that require a signed-in person (jwtOnly) and every superuser route are closed to it.',
      };
    }
    const su = isSuperuser(auth);
    const elevated = su && (!stepupEnabled() || verifyElevationToken((ctx.headers || {})['x-su-elevation'], auth.userId));
    return {
      authenticated: true, kind: auth.type || null,
      user_id: auth.userId ?? null, username: auth.username ?? null,
      roles: Array.isArray(auth.roles) ? [...auth.roles] : [],
      capabilities: caps,
      is_superuser: su,
      elevated,
      ...(auth.impersonator ? { view_as: true, impersonator: auth.impersonator } : {}),
      note: su
        ? (elevated ? 'Superuser with a live elevation: superuser (T3) routes run without a password prompt.'
                    : 'Superuser without a live elevation: a superuser (T3) action will raise the password prompt first.')
        : 'Not a superuser: superuser (T3) routes are closed to this user; say who can do it instead.',
    };
  },
};
