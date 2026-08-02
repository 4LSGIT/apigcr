// routes/api.pipeline.js
//
/**
 * routes/api.pipeline.js — REST routes for the Case Pipeline Engine (Slice B).
 *
 * GET  /api/cases/:id/pipeline          — { template, current, history, upcoming }
 * POST /api/cases/:id/pipeline/advance  — body { stage: <stage_key|numeric stage_id>, note? }
 *                                         → advances + returns fresh pipeline payload.
 *                                         Repeating the current stage → 200 with noop:true.
 *
 * Auto-mounted from routes/ (server.js readdir loop) — distinct sub-paths, no
 * collision with api.cases.js's /api/cases/:id handlers (Express matches by
 * full path shape, and that file is deliberately untouched).
 *
 * Auth + envelope match routes/api.formTemplates.js: jwtOrApiKey on every
 * route; { status: 'success', ... } / { status: 'error', message }; service
 * throws carry `.status` (400 unknown stage, 404 unknown case, 409 lock
 * timeout — retryable), anything else is a 500.
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const svc = require('../services/pipelineService');

// Map a thrown service error to an HTTP response.
function fail(res, tag, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(`[api.pipeline] ${tag} error:`, err);
  res.status(status).json({ status: 'error', message: err.message });
}

// JWT auth carries userId (payload.sub); api-key auth carries none → null.
const userId = (req) => (req.auth && req.auth.userId != null ? req.auth.userId : null);


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cases/:id/pipeline — read model
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/cases/:id/pipeline', jwtOrApiKey, async (req, res) => {
  try {
    const payload = await svc.getPipeline(req.db, req.params.id);
    res.json({ status: 'success', ...payload });
  } catch (err) {
    fail(res, 'get', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cases/:id/pipeline/advance — manual advance
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/cases/:id/pipeline/advance', jwtOrApiKey, async (req, res) => {
  try {
    const { stage, note } = req.body || {};
    const payload = await svc.advanceStage(req.db, req.params.id, stage, {
      userId: userId(req),
      note: note == null ? null : note,
      source: 'manual',
    });
    res.json({ status: 'success', ...payload });
  } catch (err) {
    fail(res, 'advance', err);
  }
});


module.exports = router;