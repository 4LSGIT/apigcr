// routes/api.emailDesigns.js
//
/**
 * YisraMail C3a — the designs library API (ref/YISRAMAIL_DESIGN.md §6.3
 * "As built (C3a)"). Thin wrappers around services/emailDesignService.js.
 *
 * Routes (all jwtOrApiKey — plain staff, no capability: see the §6.3 block):
 *   GET   /api/email-designs        — list (?q=, ?include_archived=) → { designs:[{id,name,builder,updated_at,archived}] }
 *   GET   /api/email-designs/:id    — one design, full row → { design }
 *   POST  /api/email-designs        — { name, design_json, html, text } → { success, id, warning? }
 *   PUT   /api/email-designs/:id    — same body → { success, id, warning? }
 *   PATCH /api/email-designs/:id    — { archived: true|false } → { success }
 *
 * A save whose design_json or html fails a rule → 400
 * { error, code:'design_rejected', rule, detail } (refused, never stripped);
 * other bad input → 400 { error, code:'invalid_input' }; a missing id → 404
 * { error, code:'not_found' }. The contract is FIXED (C3b builds against it).
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const emailDesignService = require('../services/emailDesignService');

/** Loose truthy for a query flag: true|1|'1'|'true' (case-insensitive) — the api.assets idiom. */
function truthy(v) {
  return v === true || v === 1 || v === '1' || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
}

function fail(res, err, where) {
  const known = emailDesignService.designErrorBody(err);
  if (known) return res.status(known.status).json(known.body);
  console.error(`[${where}]`, err);
  return res.status(500).json({ error: err.message });
}

router.get('/api/email-designs', jwtOrApiKey, async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : null;
    const designs = await emailDesignService.listDesigns(req.db, { q, includeArchived: truthy(req.query.include_archived) });
    res.json({ designs });
  } catch (err) { fail(res, err, 'GET /api/email-designs'); }
});

router.get('/api/email-designs/:id', jwtOrApiKey, async (req, res) => {
  try {
    res.json({ design: await emailDesignService.getDesign(req.db, req.params.id) });
  } catch (err) { fail(res, err, 'GET /api/email-designs/:id'); }
});

router.post('/api/email-designs', jwtOrApiKey, async (req, res) => {
  try {
    const { id, warning } = await emailDesignService.createDesign(req.db, req.body || {}, { userId: req.auth?.userId ?? null });
    res.json({ success: true, id, ...(warning ? { warning } : {}) });
  } catch (err) { fail(res, err, 'POST /api/email-designs'); }
});

router.put('/api/email-designs/:id', jwtOrApiKey, async (req, res) => {
  try {
    const { id, warning } = await emailDesignService.updateDesign(req.db, req.params.id, req.body || {});
    res.json({ success: true, id, ...(warning ? { warning } : {}) });
  } catch (err) { fail(res, err, 'PUT /api/email-designs/:id'); }
});

router.patch('/api/email-designs/:id', jwtOrApiKey, async (req, res) => {
  try {
    await emailDesignService.setArchived(req.db, req.params.id, (req.body || {}).archived);
    res.json({ success: true });
  } catch (err) { fail(res, err, 'PATCH /api/email-designs/:id'); }
});

module.exports = router;
