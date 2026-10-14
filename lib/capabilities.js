// lib/capabilities.js
//
// Capability registry + can() — access-control arc slice A1
// (ref/ACCESS_CONTROL_DESIGN.md §2.2, §2.3, §3).
//
// Capabilities are the stable vocabulary routes and services cite; roles
// (users.roles SET, minted into the staff JWT's roles claim) are grantable
// bundles of them. Both maps are code, not config — growing either is a
// deliberate change that must also update the snapshot in
// tests/capabilities.test.js (same pattern as CTA_FN_DENYLIST).
//
//   root: true  = root-grade (effectively arbitrary code/SQL within the
//                 tenant) — only `su` passes. `it` never does.
//   root: false = firm-grade — `it` passes every one of these, so a new
//                 capability is it-reachable by default unless flagged root.
//
// Gate expression: requireAuth({ audience:'staff', can:'<capability>' }).

'use strict';

const CAPABILITIES = Object.freeze({
  'firm.settings':      Object.freeze({ root: false, desc: 'Edit firm-level configuration (app settings, entitlements) — the admin capability' }),
  // root:true in v2 — admin.users stays superuserOnlyFor('users'). Delegating
  // user management to `admin` later is a registry change here (flip root,
  // add to ROLE_CAPS.admin), not a route change.
  'users.manage':       Object.freeze({ root: true,  desc: 'Manage staff users (create, disable, grant roles)' }),
  'automations.manage': Object.freeze({ root: false, desc: 'Manage workflows, sequences and trigger rules' }),
  'archives.purge':     Object.freeze({ root: false, desc: 'Restrict / purge archived communications' }),
  'comms.read_all':     Object.freeze({ root: false, desc: 'Read every mailbox and phone line without a channel grant (read-only, never manage)' }),
  'templates.code':     Object.freeze({ root: false, desc: 'Author template code' }),
  'tools.author':       Object.freeze({ root: true,  desc: 'Author tools — root within the tenant' }),
});

// su and it are deliberately ABSENT: they are rule-based, not enumerated
// (su passes everything; it passes every non-root capability — see can()).
// staff and automation hold nothing: staff is the implicit not-gated
// surface; automation exists for attribution/filtering, not grants.
const ROLE_CAPS = Object.freeze({
  admin:      Object.freeze(['firm.settings', 'automations.manage', 'archives.purge']),
  attorney:   Object.freeze(['comms.read_all']),
  form_dev:   Object.freeze(['templates.code']),
  staff:      Object.freeze([]),
  automation: Object.freeze([]),
});

// Mirrors lib/auth.superuser's SU_AUTH.
const LEGACY_SU_AUTH = 'authorized - SU';

function can(auth, cap) {
  // A typo must fail loud — never silently deny or allow.
  if (!Object.prototype.hasOwnProperty.call(CAPABILITIES, cap)) {
    throw new Error(`can: unknown capability ${JSON.stringify(cap)}`);
  }
  if (!auth) return false;

  // Machine trust until Phase B scopes keys (ACCESS_CONTROL_DESIGN §8 Q3,
  // contract §3.6): x-api-key callers bypass capability gates.
  if (auth.type === 'api_key') return true;

  // Portal, readonly_apikey, anything else: no staff capabilities.
  if (auth.type !== 'jwt') return false;

  const roles = Array.isArray(auth.roles) ? auth.roles : [];

  // Legacy SU string accepted until slice A2 migrates SU onto the `su` role
  // — A2 deletes the user_auth branch.
  if (roles.includes('su') || auth.user_auth === LEGACY_SU_AUTH) return true;
  if (roles.includes('it')) return !CAPABILITIES[cap].root;

  return roles.some(r =>
    Object.prototype.hasOwnProperty.call(ROLE_CAPS, r) && ROLE_CAPS[r].includes(cap));
}

module.exports = { CAPABILITIES, ROLE_CAPS, can };
