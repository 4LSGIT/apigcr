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

// users.roles SET members, in column order (ref/database.sql). Append-only,
// like the SET itself. The one list of role NAMES — the Users pane validates
// grants against it, entitlement role-scope denies validate scope_ref.
const ROLE_MEMBERS = Object.freeze(['it', 'admin', 'staff', 'attorney', 'automation', 'form_dev', 'su']);

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

  // SU is the `su` role only — user_auth is authn status, never authz (A2b).
  if (roles.includes('su')) return true;
  if (roles.includes('it')) return !CAPABILITIES[cap].root;

  return roles.some(r =>
    Object.prototype.hasOwnProperty.call(ROLE_CAPS, r) && ROLE_CAPS[r].includes(cap));
}

// ── Key scopes (access-control Phase B, ACCESS_CONTROL_DESIGN §5.2) ──────────
// readonly_api_keys.scopes / api_keys.scopes: a JSON array of scope strings,
// or NULL = the legacy full surface (rollout is per key, no flag day). One
// flat namespace, three families:
//   surface     the closed list below — what a session key (ycro_) may touch;
//               each auth.readonly-mounted route declares its one surface
//   route       'route:/<path>' — a machine key's path prefix (B2 enforces)
//   capability  a CAPABILITIES name — a machine key's grant (B2 enforces)
// Mints validate every family now, so B2 keys can be minted before B2
// enforcement. Growing the surface list is a deliberate change: the snapshot
// in tests/keyScopes.test.js fails until it is updated.
const KEY_SCOPES = Object.freeze({
  'sql.ro':           Object.freeze({ desc: 'POST /api/readonly/sql — read-only SQL' }),
  'scratch':          Object.freeze({ desc: 'PUT/DELETE /api/scratch — cross-session notes' }),
  'alert':            Object.freeze({ desc: 'POST /api/alert/it — page IT' }),
  'temp.clio':        Object.freeze({ desc: '/api/temp/clio/* — credentialed Clio proxy' }),
  'temp.dropbox':     Object.freeze({ desc: '/api/temp/dropbox/* — credentialed Dropbox proxy' }),
  'temp.ringcentral': Object.freeze({ desc: '/api/temp/ringcentral/* — credentialed RingCentral proxy' }),
  'temp.zohosign':    Object.freeze({ desc: '/api/temp/zohosign/* — credentialed Zoho Sign proxy' }),
});

// route:/<path> — at least one path character after the slash (a bare
// 'route:/' would match every path), URL-path characters only, no '..'
// or '//'.
const ROUTE_SCOPE_RE = /^route:\/[A-Za-z0-9._~-][A-Za-z0-9._~\/-]*$/;

/** Is s a well-formed scope of any family? */
function isKeyScope(s) {
  if (typeof s !== 'string') return false;
  if (Object.prototype.hasOwnProperty.call(KEY_SCOPES, s)) return true;
  if (Object.prototype.hasOwnProperty.call(CAPABILITIES, s)) return true;
  return ROUTE_SCOPE_RE.test(s) && !s.includes('..') && !s.includes('//');
}

/**
 * Validate a scopes list for a mint: a non-empty array of well-formed scopes.
 * Returns the de-duplicated list (first-seen order); THROWS on anything else —
 * an unknown scope at mint fails loud, never fails open (design §5.2).
 */
function normalizeKeyScopes(list) {
  if (!Array.isArray(list) || !list.length) {
    throw new Error('scopes must be a non-empty array (omit it for the default)');
  }
  const bad = list.filter(s => !isKeyScope(s));
  if (bad.length) throw new Error(`unknown scope(s): ${bad.map(b => JSON.stringify(b)).join(', ')}`);
  return [...new Set(list)];
}

/**
 * A scopes column value (mysql2 parses JSON columns; a string is tolerated)
 * → null (legacy: NULL column) or an array. Anything malformed → [] so the
 * key fails CLOSED rather than falling back to the legacy full surface.
 */
function scopesFromColumn(v) {
  if (v == null) return null;
  let x = v;
  if (typeof x === 'string') {
    try { x = JSON.parse(x); } catch (_) { return []; }
  }
  return Array.isArray(x) ? x.filter(s => typeof s === 'string') : [];
}

/**
 * keyAllows(auth, scope) — may this key-authenticated caller use `scope`?
 *   scope not well-formed            → THROW (a typo must fail loud, like can())
 *   no auth                          → false
 *   auth.scopes null / absent        → true  (legacy full surface)
 *   auth.scopes an array             → membership
 *   auth.scopes anything else        → false (malformed column: fail closed)
 * Exact membership for every family in B1; B2 decides route-prefix matching.
 */
function keyAllows(auth, scope) {
  if (!isKeyScope(scope)) throw new Error(`keyAllows: unknown scope ${JSON.stringify(scope)}`);
  if (!auth) return false;
  if (auth.scopes == null) return true;
  return Array.isArray(auth.scopes) && auth.scopes.includes(scope);
}

module.exports = {
  CAPABILITIES, ROLE_CAPS, ROLE_MEMBERS, can,
  KEY_SCOPES, isKeyScope, normalizeKeyScopes, scopesFromColumn, keyAllows,
};
