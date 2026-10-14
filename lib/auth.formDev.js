// lib/auth.formDev.js
//
// Form-developer authorization predicate (2026-08-16 decision — see
// ref/EXTERNAL_CODE_CSS_DECISION.md §Q5).
//
// isFormDev(req.auth) answers ONE question: may this caller author executable
// template content (top-level `code` / `hooks` / `css`) or expose a template
// off-internal (visibility 'portal'/'public')? It is a PREDICATE, not
// middleware, because the code-authoring gate is data-dependent (an update
// that leaves code/hooks/css byte-identical is NOT a gated act — field-only
// edits on code-carrying templates stay open to all staff), so a route-level
// middleware cannot express it. The routes compute { formDev } once per
// request and pass it into the service, which enforces fail-closed.
//
// WHO PASSES:
//   - type 'api_key'  — machine trust, matching lib/auth.requireAuth.js's
//     documented allowApiKey semantics ("Internal/automation trust — role
//     check skipped"). No machine caller of /api/form-templates exists today
//     (verified 2026-08-16: repo, GAS, manuals); this keeps effective access
//     unchanged for machines rather than silently breaking a future one.
//   - type 'jwt' that lib/auth.superuser.js isSuperuser accepts (the su
//     role) — SU implies everything.
//   - type 'jwt' whose roles claim includes 'it' or 'form_dev'. Roles ride
//     the 24h JWT (minted by routes/auth.login.js from users.roles), so a
//     grant/revoke takes effect at the user's next login.
//
// Granting: the roles checkboxes in the Users pane (public/users.html →
// PATCH /api/admin/users/:id { roles }, access-control A3).

'use strict';

const { isSuperuser } = require('./auth.superuser'); // single source of truth for "SU" (A2)
const FORM_DEV_ROLES = ['it', 'form_dev'];

function isFormDev(auth) {
  if (!auth) return false;
  if (auth.type === 'api_key') return true;
  if (auth.type !== 'jwt') return false;
  if (isSuperuser(auth)) return true;              // su role
  const roles = Array.isArray(auth.roles) ? auth.roles : [];
  return FORM_DEV_ROLES.some((r) => roles.includes(r));
}

module.exports = { isFormDev, FORM_DEV_ROLES };
