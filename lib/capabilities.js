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
  'firm.settings':      Object.freeze({ root: false, desc: 'Edit firm-level configuration (the Firm tab: firm settings, launcher, entitlements; the YisraCase Config vocabularies) — the admin capability' }),
  // root:true in v2 — admin.users stays superuserOnlyFor('users'). Delegating
  // user management to `admin` later is a registry change here (flip root,
  // add to ROLE_CAPS.admin), not a route change.
  'users.manage':       Object.freeze({ root: true,  desc: 'Manage staff users (create, disable, grant roles)' }),
  'users.impersonate':  Object.freeze({ root: false, desc: 'Open a short-lived View-as session for an ordinary staff user' }),
  'automations.manage': Object.freeze({ root: false, desc: 'Manage workflows, sequences and trigger rules' }),
  'archives.purge':     Object.freeze({ root: false, desc: 'Restrict / purge archived communications' }),
  'comms.read_all':     Object.freeze({ root: false, desc: 'Read every mailbox and phone line without a channel grant (read-only, never manage)' }),
  'templates.code':     Object.freeze({ root: false, desc: 'Author template code' }),
  'tools.author':       Object.freeze({ root: true,  desc: 'Author tools — root within the tenant' }),
  // Settings arc (2026-10-17): the System tab of YisraCase Config — deployment
  // switches, integration wiring, alert thresholds, the comms engine's knobs
  // and read-only runtime state (lib/settingsRegistry.js homes system / comms
  // / cta). Firm-grade, so `it` holds it; deliberately NOT in admin's bundle:
  // a firm admin edits the firm's settings, IT edits the system's.
  'system.settings':    Object.freeze({ root: false, desc: 'Edit system settings (deployment switches, integration wiring, alert thresholds) — the System tab' }),
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

  // Machine keys (ACCESS_CONTROL_DESIGN §5.2, access-control B2): a key whose
  // scopes column is NULL keeps Q3's machine trust (every capability); a
  // SCOPED key passes only the capability names its scopes carry. The
  // internal yci_ key never carries scopes.
  if (auth.type === 'api_key') {
    if (auth.scopes == null) return true;
    return Array.isArray(auth.scopes) && auth.scopes.includes(cap);
  }

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
//   route       'route:/<path>' — a machine key's path prefix (routeAllowed,
//               enforced in lib/auth.jwtOrApiKey since B2)
//   capability  a CAPABILITIES name — a machine key's grant (can(), enforced on
//               requireAuth({ can, allowApiKey }) mounts since B2)
// Every family is validated at mint. Growing the surface list is a deliberate change: the snapshot
// in tests/keyScopes.test.js fails until it is updated.
// `explicit: true` marks a scope a legacy NULL-scopes key does NOT hold (keyAllows): it opens
// something no key could reach before it existed, so "the legacy full surface" never included it.
// sql.ro.sensitive (SEC-3, ACCESS_CONTROL_DESIGN §5.7): /api/readonly/sql may also read
// lib/sqlGuard SENSITIVE_TABLES. Never in the mint default; a mint carrying it is TTL-capped
// (routes/api.readonlyKeys.js) and needs sql.ro beside it.
// keys.mint (D1, ACCESS_CONTROL_DESIGN §5.8): a "manager" key mints its own CHILD session keys
// (routes/api.readonlyKeys.js /children). Delegation adds identities, never power: a child's
// scopes ⊆ CHILD_SCOPES ∩ the parent's, it never holds keys.mint (no chains), and it is refused
// at auth once its parent is revoked or expired (lib/auth.readonly).
const KEY_SCOPES = Object.freeze({
  'sql.ro':           Object.freeze({ desc: 'POST /api/readonly/sql — read-only SQL' }),
  'sql.ro.sensitive': Object.freeze({ desc: 'read-only SQL may also read the sensitive tables (audit logs, AI calls, call transcripts); TTL-capped at mint', explicit: true }),
  'scratch':          Object.freeze({ desc: 'PUT/DELETE /api/scratch — cross-session notes' }),
  'alert':            Object.freeze({ desc: 'POST /api/alert/it — page IT' }),
  'keys.mint':        Object.freeze({ desc: '/api/readonly-keys/children — mint, list and revoke this key\'s own child keys (sql.ro/scratch/alert only, ≤24h, die with it)', explicit: true }),
  'tasks.own':        Object.freeze({ desc: '/api/key-tasks — create tasks for active staff and manage the ones this key created (the first app-table write a session key makes)', explicit: true }),
  'temp.clio':        Object.freeze({ desc: '/api/temp/clio/* — credentialed Clio proxy' }),
  'temp.dropbox':     Object.freeze({ desc: '/api/temp/dropbox/* — credentialed Dropbox proxy' }),
  'temp.ringcentral': Object.freeze({ desc: '/api/temp/ringcentral/* — credentialed RingCentral proxy' }),
  'temp.zohosign':    Object.freeze({ desc: '/api/temp/zohosign/* — credentialed Zoho Sign proxy' }),
});

// tasks.own (D3, ACCESS_CONTROL_DESIGN §5.10): routes/api.keyTasks.js — the key creates tasks
// (owned through tasks.task_session_key_id) and sees / changes only its own. Explicit; never a
// child's (not in CHILD_SCOPES).
// What a child key may ever hold — the documented trio. Never keys.mint, sql.ro.sensitive,
// temp.*, route:/ or capability scopes. Enforced at mint AND at auth (childEffectiveScopes).
const CHILD_SCOPES = Object.freeze(['sql.ro', 'scratch', 'alert']);

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
 *   auth.scopes null / absent        → true  (legacy full surface) — EXCEPT an
 *                                      `explicit` surface scope: false
 *   auth.scopes an array             → membership
 *   auth.scopes anything else        → false (malformed column: fail closed)
 * Exact membership for every family; route scopes are judged by
 * routeAllowed() below (prefix semantics), capability scopes by can().
 */
function keyAllows(auth, scope) {
  if (!isKeyScope(scope)) throw new Error(`keyAllows: unknown scope ${JSON.stringify(scope)}`);
  if (!auth) return false;
  if (auth.scopes == null) return !(Object.prototype.hasOwnProperty.call(KEY_SCOPES, scope) && KEY_SCOPES[scope].explicit);
  return Array.isArray(auth.scopes) && auth.scopes.includes(scope);
}

/**
 * childEffectiveScopes(childColumn, parentColumn) — a child key's scopes for
 * THIS request: its own ∩ CHILD_SCOPES ∩ what the parent holds now (keyAllows,
 * so a legacy NULL parent counts as the legacy surface). Computed per request,
 * so narrowing a parent narrows its children. A child whose own column is NULL
 * or malformed gets [] — a child never falls back to the legacy surface.
 */
function childEffectiveScopes(childColumn, parentColumn) {
  const own = scopesFromColumn(childColumn);
  if (!Array.isArray(own)) return [];
  const parent = { scopes: scopesFromColumn(parentColumn) };
  return [...new Set(own)].filter(s => CHILD_SCOPES.includes(s) && keyAllows(parent, s));
}

/**
 * routeAllowed(auth, path) — may this key-authenticated caller reach `path`?
 * (access-control B2: the route family, enforced in lib/auth.jwtOrApiKey.)
 *   no auth                      → false
 *   auth.scopes null / absent    → true  (legacy full surface; the internal key)
 *   auth.scopes not an array     → false (malformed column: fail closed)
 *   otherwise: some `route:/<p>` scope matches — path === p or path starts
 *   with p + '/'. So route:/process-jobs reaches /process-jobs and
 *   /process-jobs/anything, never /process-jobs-evil. Case-insensitive
 *   (Express routes case-insensitively by default) and a trailing slash on
 *   either side is ignored. The query string is not part of the path. A path
 *   carrying a dot segment (/./ or /../, percent-encoded or not) or a malformed
 *   escape is refused outright. A scoped key
 *   holding no route scope reaches no route here (capability-gated routes
 *   judge it by can() instead — see lib/auth.requireAuth).
 */
function routeAllowed(auth, path) {
  if (!auth) return false;
  if (auth.scopes == null) return true;
  if (!Array.isArray(auth.scopes)) return false;
  const p = String(path || '').split('?')[0].split('#')[0];
  const DOT_SEG = /(^|\/)\.{1,2}(\/|$)/;
  let decoded;
  try { decoded = decodeURIComponent(p); } catch (_) { return false; }   // malformed escape
  if (!p.startsWith('/') || DOT_SEG.test(p) || DOT_SEG.test(decoded)) return false;
  const norm = (x) => { const l = x.toLowerCase(); return l.length > 1 ? l.replace(/\/+$/, '') : l; };
  const target = norm(p);
  return auth.scopes.some((s) => {
    if (typeof s !== 'string' || !s.startsWith('route:/')) return false;
    const pref = norm(s.slice('route:'.length));
    return target === pref || target.startsWith(pref + '/');
  });
}

module.exports = {
  CAPABILITIES, ROLE_CAPS, ROLE_MEMBERS, can, routeAllowed,
  KEY_SCOPES, isKeyScope, normalizeKeyScopes, scopesFromColumn, keyAllows,
  CHILD_SCOPES, childEffectiveScopes,
};
