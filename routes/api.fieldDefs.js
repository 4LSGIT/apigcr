// routes/api.fieldDefs.js
//
/**
 * Custom-field definitions API (custom-fields arc S1)
 * routes/api.fieldDefs.js
 *
 * Backs the settings.html "Custom Fields" editor. Logic, validation and the
 * cache live in services/fieldDefService.js; this file is the HTTP mapper.
 *
 *   GET  /api/field-defs?entity=case|contact    every def incl. inactive (editor list)
 *   POST /api/field-defs                        create { entity, field_key, label,
 *                                               field_type, options?, validation?,
 *                                               show_when?, sort_order?, active? }
 *   PATCH /api/field-defs/:id                   label / field_type / options /
 *                                               validation / show_when / sort_order
 *                                               (entity + field_key IMMUTABLE → 400)
 *   POST /api/field-defs/:id/deactivate         active = 0 — retirement
 *   POST /api/field-defs/:id/reactivate         active = 1
 *   (no DELETE — the Contact Roles type editor this clones offers none, and a
 *    def's key may already have data under it from S2 on; deactivate instead)
 *
 * AUTH: jwtOrApiKey on every route — identical to /api/contact-role-types,
 * the editor this one is cloned from (no superuser gate, no admin_audit_log
 * rows; the roles routes write neither).
 *
 * Envelope: { status:'success', ... } / { status:'error', message }. Service
 * throws carry `.status` (400 validation / immutable, 404 unknown id, 409
 * duplicate key); anything else is a 500 with a generic message — never raw
 * DB text.
 *
 * Auto-mounted from routes/ (server.js readdir loop).
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const svc = require('../services/fieldDefService');

function fail(res, tag, err) {
  const status = (typeof err.status === 'number' && err.status >= 400 && err.status < 600) ? err.status : 500;
  if (status >= 500) {
    console.error(`[api.fieldDefs] ${tag} error:`, err);
    return res.status(500).json({ status: 'error', message: 'Field definition request failed' });
  }
  res.status(status).json({ status: 'error', message: err.message });
}

// ─── GET /api/field-defs?entity= ───
router.get('/api/field-defs', jwtOrApiKey, async (req, res) => {
  try {
    const defs = await svc.listAll(req.db, req.query.entity);
    res.json({ status: 'success', defs });
  } catch (err) { fail(res, 'list', err); }
});

// ─── POST /api/field-defs ───
router.post('/api/field-defs', jwtOrApiKey, async (req, res) => {
  try {
    const result = await svc.createDef(req.db, req.body || {});
    res.status(201).json({ status: 'success', ...result });
  } catch (err) { fail(res, 'create', err); }
});

// ─── PATCH /api/field-defs/:id ───
router.patch('/api/field-defs/:id', jwtOrApiKey, async (req, res) => {
  try {
    const result = await svc.updateDef(req.db, req.params.id, req.body || {});
    res.json({ status: 'success', ...result });
  } catch (err) { fail(res, 'update', err); }
});

// ─── POST /api/field-defs/:id/deactivate ───
router.post('/api/field-defs/:id/deactivate', jwtOrApiKey, async (req, res) => {
  try {
    const result = await svc.setActive(req.db, req.params.id, false);
    res.json({ status: 'success', ...result });
  } catch (err) { fail(res, 'deactivate', err); }
});

// ─── POST /api/field-defs/:id/reactivate ───
router.post('/api/field-defs/:id/reactivate', jwtOrApiKey, async (req, res) => {
  try {
    const result = await svc.setActive(req.db, req.params.id, true);
    res.json({ status: 'success', ...result });
  } catch (err) { fail(res, 'reactivate', err); }
});

module.exports = router;
