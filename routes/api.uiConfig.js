// routes/api.uiConfig.js
//
/**
 * Launcher config documents — ui-customization arc S3.1 (local/ui-custom/PLAN.md
 * §6–§8). Auto-mounts (routes/). Storage + rules: services/uiConfigService.js;
 * document grammar: lib/uiConfigShape.js; DDL: ref/migrations/2026-10-16_ui_custom_s31_ui_config.sql.
 *
 *   GET /api/ui-config  → { status, firm: { <config_key>: config }, user: { … } }
 *       for the caller. Staff JWT only — no API keys: a user layer needs a user.
 *       (The shell boots from /api/firm-data `ui`, built by the same
 *       uiConfigService.readFor; this route is for editors.)
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
 * Not a sync-bus entity: nothing in public/js/yc-sync.js watches ui_config.
 *
 * Error shape: { status:'error', message } — house standard.
 */

'use strict';

const express = require('express');
const router = express.Router();
const requireAuth = require('../lib/auth.requireAuth');
const svc = require('../services/uiConfigService');

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
    res.json({ status: 'success', ...(await svc.readFor(req.db, req.auth.userId)) });
  } catch (err) { fail(res, 'GET /api/ui-config', err); }
});

router.put('/api/ui-config', gateByScope, async (req, res) => {
  try {
    res.json({ status: 'success', ...(await svc.write(req.db, req.body, req.auth)) });
  } catch (err) { fail(res, 'PUT /api/ui-config', err); }
});

module.exports = router;
