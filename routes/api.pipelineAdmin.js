// routes/api.pipelineAdmin.js
//
/**
 * routes/api.pipelineAdmin.js — Admin REST routes for the Case Pipeline
 * Engine (Slice C2: Case Config manager).
 *
 * GET    /api/pipeline-admin/templates                     — list (+ stage/log counts)
 * POST   /api/pipeline-admin/templates                     — create { name, case_type?, case_subtype?, role?, is_default?, description?, active?, force? }
 * PUT    /api/pipeline-admin/templates/:id                 — partial update (same fields + force)
 * DELETE /api/pipeline-admin/templates/:id                 — hard delete (zero log refs only → else 409, deactivate instead)
 * GET    /api/pipeline-admin/templates/:id/stages          — { template, stages[] } (stages carry log_count)
 * POST   /api/pipeline-admin/templates/:id/stages          — create stage
 * PUT    /api/pipeline-admin/stages/:id                    — partial update (stage_key immutable once referenced → 409)
 * DELETE /api/pipeline-admin/stages/:id                    — hard delete (zero log refs only → else 409)
 * POST   /api/pipeline-admin/templates/:id/stages/reorder  — { stage_ids: [...] } → rewrites stage_number 1..N
 * GET    /api/pipeline-admin/usage?case_type=&case_subtype= — { cases, templates } reference counts
 *
 * Auto-mounted from routes/ (server.js readdir loop). Distinct /api/pipeline-admin
 * prefix — no collision with routes/api.pipeline.js (the frozen Slice B
 * read/advance routes) or anything else in routes/.
 *
 * Auth + envelope match routes/api.formTemplates.js: jwtOrApiKey on every
 * route; { status: 'success', ... } / { status: 'error', message }; service
 * throws carry `.status` (400 validation, 404 unknown row, 409 business-rule
 * conflict — locked key, referenced row, duplicate-active template), anything
 * else is a 500.
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const svc = require('../services/pipelineAdminService');

// Map a thrown service error to an HTTP response.
function fail(res, tag, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(`[api.pipelineAdmin] ${tag} error:`, err);
  res.status(status).json({ status: 'error', message: err.message });
}


// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/pipeline-admin/templates', jwtOrApiKey, async (req, res) => {
  try {
    const templates = await svc.listTemplates(req.db);
    res.json({ status: 'success', templates });
  } catch (err) {
    fail(res, 'listTemplates', err);
  }
});

router.post('/api/pipeline-admin/templates', jwtOrApiKey, async (req, res) => {
  try {
    const template = await svc.createTemplate(req.db, req.body || {});
    res.status(201).json({ status: 'success', template });
  } catch (err) {
    fail(res, 'createTemplate', err);
  }
});

router.put('/api/pipeline-admin/templates/:id', jwtOrApiKey, async (req, res) => {
  try {
    const template = await svc.updateTemplate(req.db, req.params.id, req.body || {});
    res.json({ status: 'success', template });
  } catch (err) {
    fail(res, 'updateTemplate', err);
  }
});

router.delete('/api/pipeline-admin/templates/:id', jwtOrApiKey, async (req, res) => {
  try {
    const result = await svc.deleteTemplate(req.db, req.params.id);
    res.json({ status: 'success', ...result });
  } catch (err) {
    fail(res, 'deleteTemplate', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// STAGES
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/pipeline-admin/templates/:id/stages', jwtOrApiKey, async (req, res) => {
  try {
    const payload = await svc.listStages(req.db, req.params.id);
    res.json({ status: 'success', ...payload });
  } catch (err) {
    fail(res, 'listStages', err);
  }
});

router.post('/api/pipeline-admin/templates/:id/stages', jwtOrApiKey, async (req, res) => {
  try {
    const stage = await svc.createStage(req.db, req.params.id, req.body || {});
    res.status(201).json({ status: 'success', stage });
  } catch (err) {
    fail(res, 'createStage', err);
  }
});

// Registered before the bare /stages/:id verbs would matter if the paths could
// shadow; they can't (extra literal segment), but keep reorder grouped here.
router.post('/api/pipeline-admin/templates/:id/stages/reorder', jwtOrApiKey, async (req, res) => {
  try {
    const { stage_ids } = req.body || {};
    const payload = await svc.reorderStages(req.db, req.params.id, stage_ids);
    res.json({ status: 'success', ...payload });
  } catch (err) {
    fail(res, 'reorderStages', err);
  }
});

router.put('/api/pipeline-admin/stages/:id', jwtOrApiKey, async (req, res) => {
  try {
    const stage = await svc.updateStage(req.db, req.params.id, req.body || {});
    res.json({ status: 'success', stage });
  } catch (err) {
    fail(res, 'updateStage', err);
  }
});

router.delete('/api/pipeline-admin/stages/:id', jwtOrApiKey, async (req, res) => {
  try {
    const result = await svc.deleteStage(req.db, req.params.id);
    res.json({ status: 'success', ...result });
  } catch (err) {
    fail(res, 'deleteStage', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// USAGE — Types/Subtypes editor warnings
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/pipeline-admin/usage', jwtOrApiKey, async (req, res) => {
  try {
    const counts = await svc.usageCounts(req.db, req.query.case_type, req.query.case_subtype);
    res.json({ status: 'success', ...counts });
  } catch (err) {
    fail(res, 'usage', err);
  }
});


module.exports = router;