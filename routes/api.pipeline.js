// routes/api.pipeline.js
//
/**
 * routes/api.pipeline.js — REST routes for the Case Pipeline Engine (Slice B).
 *
 * GET  /api/cases/:id/pipeline          — { template, current, history, upcoming }
 *                                         (R2) ?requirements=1 → each stage in
 *                                         `stages` gains `requirements: [...]`
 *                                         (resolved work items). Default payload
 *                                         unchanged — C1 contract.
 * POST /api/cases/:id/pipeline/advance  — body { stage: <stage_key|numeric stage_id>, note? }
 *                                         → advances + returns fresh pipeline payload.
 *                                         Repeating the current stage → 200 with noop:true.
 * GET  /api/cases/:id/pipeline/requirements
 *                                       — (R3) the FULL resolveRequirements output for
 *                                         the case: BOTH applicable templates, so a
 *                                         phase='case' case's INTAKE requirements are
 *                                         visible here and nowhere else.
 *                                         ?client_only=1 → client_visible rows only.
 * POST   /api/cases/:id/pipeline/requirements/:key/override
 *                                       — body { status: 'na'|'done', note? } → set/replace
 *                                         the per-case override on requirement :key.
 * DELETE /api/cases/:id/pipeline/requirements/:key/override
 *                                       — clear it (derived state takes back over).
 *                                         Both write a type='status' case log row —
 *                                         the same case-log convention a stage
 *                                         advance lands in.
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
    const wantReqs = req.query.requirements === '1' || req.query.requirements === 'true';
    const payload = await svc.getPipeline(req.db, req.params.id,
      wantReqs ? { requirements: true } : undefined);
    res.json({ status: 'success', ...payload });
  } catch (err) {
    fail(res, 'get', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// Requirement overrides (R2) — the two states derivation cannot express
// ─────────────────────────────────────────────────────────────────────────────

const reqSvc = require('../services/requirementService');

// ── GET /api/cases/:id/pipeline/requirements — the FULL resolver output ──────
//
// (R3) BOTH applicable templates, not just the resolved one. This is the ONLY
// HTTP surface on which a phase='case' case's INTAKE-template requirements are
// visible: getPipeline's payload is stage-anchored to the resolved template, so
// the intake questionnaire a filed case submitted in March — correctly resolved
// `done` (or `skipped`) by requirementService since R2 — had nowhere to appear.
// The staff Steps panel's "Intake history" section is that finding's consumer.
//
// ?client_only=1 → the portal's clientOnly filter (client_visible=1 only). The
// SAME resolver, one flag; there is no second read model.
//
// Ordering, statuses and precedence are the resolver's — this route projects
// nothing and re-derives nothing.
router.get('/api/cases/:id/pipeline/requirements', jwtOrApiKey, async (req, res) => {
  try {
    const clientOnly = req.query.client_only === '1' || req.query.client_only === 'true';
    const requirements = await reqSvc.getCaseRequirements(req.db, req.params.id, { clientOnly });
    res.json({ status: 'success', requirements });
  } catch (err) {
    fail(res, 'requirements', err);
  }
});

router.post('/api/cases/:id/pipeline/requirements/:key/override', jwtOrApiKey, async (req, res) => {
  try {
    const { status, note } = req.body || {};
    const result = await reqSvc.setOverride(req.db, req.params.id, req.params.key, {
      status,
      note: note == null ? null : note,
      userId: userId(req),
    });
    res.json({ status: 'success', override: result });
  } catch (err) {
    fail(res, 'setOverride', err);
  }
});

router.delete('/api/cases/:id/pipeline/requirements/:key/override', jwtOrApiKey, async (req, res) => {
  try {
    const result = await reqSvc.clearOverride(req.db, req.params.id, req.params.key, {
      userId: userId(req),
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    fail(res, 'clearOverride', err);
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