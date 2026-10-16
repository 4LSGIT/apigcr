// routes/api.entitlements.js
//
/**
 * Launcher entitlement DENIES — CRUD (access-control A5,
 * ref/ACCESS_CONTROL_DESIGN.md §2.6, contract §3.2–5). Auto-mounts (routes/).
 *
 *   GET    /api/entitlements        — every deny row
 *   POST   /api/entitlements        — add one deny { scope, scope_ref, item_key }
 *   DELETE /api/entitlements/:id    — remove one deny
 *
 * Gate: the firm.settings capability — the same expression as the
 * app-settings writes (A4): roles admin / it / su; x-api-key callers pass
 * (machine trust until Phase B, §8 Q3) and are recorded as created_by 0.
 * The editor UI is the CFG-3 firm tab's "Who sees what" section
 * (public/caseconfig/firm.html, ui-custom S3.4): per-USER denies only — role
 * scoping is ui_config's visible_to, and role / firm scopes stay API-only.
 *
 * POST body:
 *   scope      'firm' | 'role' | 'user'
 *   scope_ref  firm: omit, null or '' — all normalized to '' at this boundary
 *              (the column's firm sentinel); role: a users.roles member;
 *              user: a users.user id (number or digits; must exist)
 *   item_key   a public/js/featureRegistry.js key, or a firm launcher item id
 *              firm:<slug> (ui-custom S3.4); moreSettings / helpSupport are
 *              undeniable and refused
 * 400 bad input · 409 duplicate · 404 unknown id (services/entitlementService).
 *
 * Visibility-only: a deny hides a launcher item via /api/firm-data `denied`;
 * it never 403s a route (v2).
 */

'use strict';

const express = require('express');
const router = express.Router();
const requireAuth = require('../lib/auth.requireAuth');
const svc = require('../services/entitlementService');

const firmSettings = requireAuth({ audience: 'staff', can: 'firm.settings', allowApiKey: true });

function fail(res, label, err) {
  if (err && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ status: 'error', message: err.message });
  }
  console.error(`${label} error:`, err);
  return res.status(500).json({ status: 'error', message: 'Entitlements request failed' });
}

router.get('/api/entitlements', firmSettings, async (req, res) => {
  try {
    res.json({ status: 'success', denies: await svc.listDenies(req.db), undeniable: svc.UNDENIABLE });
  } catch (err) { fail(res, 'GET /api/entitlements', err); }
});

router.post('/api/entitlements', firmSettings, async (req, res) => {
  try {
    const createdBy = req.auth.type === 'jwt' ? req.auth.userId : 0;
    const deny = await svc.createDeny(req.db, req.body, createdBy);
    res.status(201).json({ status: 'success', deny });
  } catch (err) { fail(res, 'POST /api/entitlements', err); }
});

router.delete('/api/entitlements/:id', firmSettings, async (req, res) => {
  try {
    res.json({ status: 'success', ...(await svc.deleteDeny(req.db, req.params.id)) });
  } catch (err) { fail(res, 'DELETE /api/entitlements', err); }
});

module.exports = router;
