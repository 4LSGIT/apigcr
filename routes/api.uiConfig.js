// routes/api.uiConfig.js
//
/**
 * Launcher config documents — ui-customization arc S3.1 (local/ui-custom/PLAN.md
 * §6–§8). Auto-mounts (routes/). Storage + rules: services/uiConfigService.js;
 * document grammar: lib/uiConfigShape.js; DDL: ref/migrations/2026-10-16_ui_custom_s31_ui_config.sql.
 *
 *   GET /api/ui-config  → { status, firm: { <config_key>: config }, user: { … },
 *                           can_edit_firm, can_edit_system [, firm_versions] }
 *       for the caller. Staff JWT only — no API keys: a user layer needs a user.
 *       (The shell boots from /api/firm-data `ui`, built by the same
 *       uiConfigService.readFor; this route is for editors.) can_edit_firm =
 *       lib/capabilities can(req.auth, 'firm.settings') — the SAME function the
 *       firm gates below use. The Config shell shows its Firm tab from it; a
 *       client never re-derives a capability from roles. firm_versions (only
 *       when can_edit_firm) = { <firm config_key>: newest version id | null } —
 *       the `base` the editor sends back. can_edit_system = can(req.auth,
 *       'system.settings') (settings arc, 2026-10): the Config shell reveals its
 *       System tab from it, as it does the Firm tab from can_edit_firm (it / su
 *       hold system.settings; admin does not).
 *   PUT /api/ui-config  body { scope, config_key, config, role? }
 *       → { status, scope, config_key, config (the stored, normalized document),
 *           changed, versioned }
 *       scope 'firm'  needs the firm.settings capability (admin / it / su —
 *                     lib/capabilities); writes the firm row (user_id 0) and
 *                     appends a ui_config_versions row when the document changed.
 *       scope 'user'  any staff user; writes ONLY the caller's own row (the JWT's
 *                     user). A body user_id is rejected (400), never honoured.
 *       scope 'system' / anything else, role other than '', an unknown
 *       config_key or body field, or a document that fails the grammar → 400
 *       { status:'error', message, errors[] }.
 *       base (firm scope, OPTIONAL — S3.2): the newest firm version id the
 *       editor loaded, or null. Present and stale → 409, nothing written; absent
 *       → no check (the S3.1 contract). Firm responses carry version_id.
 *
 * Gate shape: ONE route, the gate picked by the body's scope — 'firm' runs
 * requireAuth({ audience:'staff', can:'firm.settings' }), everything else
 * requireAuth({ audience:'staff' }). Both are requireAuth, built at mount, so
 * the capability check is lib/capabilities can() exactly as on every other
 * firm.settings route, and the jwt_api_audit_log rows are the usual ones. The
 * body is only READ to choose the gate; it is validated after auth, and
 * uiConfigService.write re-checks firm.settings against the VALIDATED scope
 * (defence in depth: the gate reads the raw body.scope).
 *
 * The firm editor (ui-custom S3.2, public/caseconfig/firm.html) — every route
 * below is requireAuth({ audience:'staff', can:'firm.settings' }), except
 * pickers (see there); firm scope only (user rows are never versioned):
 *   GET  /api/ui-config/versions?config_key=registry_overrides
 *        → { status, versions: [{ id, saved_by, saved_by_name, saved_at, size,
 *            is_current }] } newest first
 *   GET  /api/ui-config/versions/:id → { status, version: { id, config_key,
 *            config, saved_by, saved_by_name, saved_at } }   404 if not a firm row's
 *   POST /api/ui-config/versions/:id/restore  body { base? }
 *        → the PUT response + restored_from.
 *        Copies the version back through uiConfigService.write — validation,
 *        the capability re-check, the base check (stale → 409), the version
 *        append, into the version's parent row's config_key. Restoring the current
 *        document appends nothing (changed:false). A version the validator now
 *        refuses → 400 with errors[]; nothing is written.
 *   GET  /api/ui-config/pickers → { status, tools: [{ key, title }],
 *            views: [{ key, title }] } — live tools, active saved views; keys
 *        and titles only (never tool html). GET /api/tools is SU + step-up, so
 *        firm admins need this lean read to place tool items.
 *        Gate: requireAuth({ audience:'staff' }) — ANY staff user (ui-custom
 *        S5a), because every user's own buttons ("My buttons") pick a tool or
 *        a saved view the same way. Safe to show staff: keys and titles only,
 *        never tool html or a view's definition, and /tool/<key> and saved
 *        views are already reachable by staff. If a picker list ever must stay
 *        admin-only, split it into its own route then — don't re-gate this one.
 *
 * Not a sync-bus entity: nothing in public/js/yc-sync.js watches ui_config.
 *
 * Error shape: { status:'error', message } — house standard.
 */

'use strict';

const express = require('express');
const router = express.Router();
const requireAuth = require('../lib/auth.requireAuth');
const svc = require('../services/uiConfigService');
const { can } = require('../lib/capabilities');

const staff = requireAuth({ audience: 'staff' });
const firmSettings = requireAuth({ audience: 'staff', can: 'firm.settings' });

function gateByScope(req, res, next) {
  const scope = req.body && typeof req.body === 'object' ? req.body.scope : undefined;
  return (scope === 'firm' ? firmSettings : staff)(req, res, next);
}

function fail(res, label, err) {
  if (err && err.status >= 400 && err.status < 500) {
    const body = { status: 'error', message: err.message };
    if (err.errors) body.errors = err.errors;
    return res.status(err.status).json(body);
  }
  console.error(`${label} error:`, err);
  return res.status(500).json({ status: 'error', message: 'UI config request failed' });
}

router.get('/api/ui-config', staff, async (req, res) => {
  try {
    const canEditFirm = can(req.auth, 'firm.settings');
    // The version ids BEFORE the documents (ui-custom S6c-3 review SF1): a firm
    // save committing between the two reads then pairs a NEWER document with an
    // older base — a spurious 409 on the next save. The other order paired an
    // older document with the newer base, and that save silently overwrote.
    const firmVersions = canEditFirm ? await svc.firmVersionIds(req.db) : null;
    const out = { status: 'success', ...(await svc.readFor(req.db, req.auth.userId)), can_edit_firm: canEditFirm,
      can_edit_system: can(req.auth, 'system.settings') };
    if (canEditFirm) out.firm_versions = firmVersions;
    res.json(out);
  } catch (err) { fail(res, 'GET /api/ui-config', err); }
});

router.get('/api/ui-config/versions', firmSettings, async (req, res) => {
  try {
    res.json({ status: 'success', versions: await svc.listVersions(req.db, req.query.config_key) });
  } catch (err) { fail(res, 'GET /api/ui-config/versions', err); }
});

router.get('/api/ui-config/versions/:id', firmSettings, async (req, res) => {
  try {
    const v = await svc.getVersion(req.db, req.params.id);
    if (!v) return res.status(404).json({ status: 'error', message: 'Version not found' });
    const { row_config_key: _rowKey, ...version } = v;
    res.json({ status: 'success', version });
  } catch (err) { fail(res, 'GET /api/ui-config/versions/:id', err); }
});

router.post('/api/ui-config/versions/:id/restore', firmSettings, async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' && Object.prototype.hasOwnProperty.call(req.body, 'base') ? req.body.base : undefined;
    res.json({ status: 'success', ...(await svc.restoreVersion(req.db, req.params.id, req.auth, b)) });
  } catch (err) { fail(res, 'POST /api/ui-config/versions/:id/restore', err); }
});

// Pickers: any staff user since ui-custom S5a (their own buttons pick a tool
// or a saved view too) — see the header. Was firm.settings (S3.2).
router.get('/api/ui-config/pickers', staff, async (req, res) => {
  try {
    res.json({ status: 'success', ...(await svc.pickers(req.db)) });
  } catch (err) { fail(res, 'GET /api/ui-config/pickers', err); }
});

router.put('/api/ui-config', gateByScope, async (req, res) => {
  try {
    res.json({ status: 'success', ...(await svc.write(req.db, req.body, req.auth)) });
  } catch (err) { fail(res, 'PUT /api/ui-config', err); }
});

module.exports = router;
