// routes/api.formTemplates.js
//
/**
 * routes/api.formTemplates.js — REST routes for the YisraForm template system.
 *
 * GET    /api/form-templates                  — list (summary columns)
 * GET    /api/form-templates/render/:form_key — published projection render.html consumes
 * GET    /api/form-templates/:id              — full row (draft + published definitions)
 * POST   /api/form-templates                  — create { form_key, title, link_type, draft_definition }
 * PUT    /api/form-templates/:id              — update { title?, draft_definition?, form_key? }
 * POST   /api/form-templates/:id/publish      — publish (§6): { schema_version, bumped }
 *                                               (+ external_refusals[] advisory when the
 *                                               template is externally visible — X1)
 * POST   /api/form-templates/:id/visibility   — X1 (EXTERNAL_FORMS_DESIGN §3): set
 *                                               { visibility: internal|portal|public };
 *                                               refused off-internal while the published
 *                                               definition carries code/css/hooks/embed
 * DELETE /api/form-templates/:id              — delete (never-published AND no-submissions only)
 * GET    /api/form-templates/:id/versions             — publish history (no definitions; computed schema_changed)
 * GET    /api/form-templates/:id/versions/:versionId  — one version row incl. definition
 * POST   /api/form-templates/:id/versions/:versionId/restore — copy version definition → draft_definition
 *
 * Auto-mounted from routes/ (server.js readdir loop). All routes require JWT or
 * API key. Response envelope { status: 'success', ... } / on error
 * { status: 'error', message }. Service throws carry `.status` (400/404);
 * anything else is a 500.
 *
 * Contract: ref/FORM_TEMPLATE_SCHEMA_V1.md §2.
 */

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const svc = require('../services/formTemplateService');

// Map a thrown service error to an HTTP response.
function fail(res, tag, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(`[api.formTemplates] ${tag} error:`, err);
  res.status(status).json({ status: 'error', message: err.message });
}

const userId = (req) => (req.auth && req.auth.userId != null ? req.auth.userId : null);


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/form-templates — list
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/form-templates', jwtOrApiKey, async (req, res) => {
  try {
    const templates = await svc.listTemplates(req.db);
    res.json({ status: 'success', templates });
  } catch (err) {
    fail(res, 'list', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/form-templates/render/:form_key — published projection (render.html)
// (Registered before /:id so the literal "render" segment can never be read as an id.)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/form-templates/render/:form_key', jwtOrApiKey, async (req, res) => {
  try {
    const published = await svc.getPublishedByKey(req.db, req.params.form_key);
    if (!published) {
      return res.status(404).json({
        status: 'error',
        message: `No published template for form_key "${req.params.form_key}"`,
      });
    }
    res.json({ status: 'success', ...published });
  } catch (err) {
    fail(res, 'render', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/form-templates/:id — full row
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/form-templates/:id', jwtOrApiKey, async (req, res) => {
  try {
    const template = await svc.getTemplate(req.db, req.params.id);
    res.json({ status: 'success', template });
  } catch (err) {
    fail(res, 'get', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/form-templates — create
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/form-templates', jwtOrApiKey, async (req, res) => {
  try {
    const template = await svc.createTemplate(req.db, req.body, userId(req));
    res.status(201).json({ status: 'success', template });
  } catch (err) {
    fail(res, 'create', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/form-templates/:id — update
// ─────────────────────────────────────────────────────────────────────────────

router.put('/api/form-templates/:id', jwtOrApiKey, async (req, res) => {
  try {
    const template = await svc.updateTemplate(req.db, req.params.id, req.body, userId(req));
    res.json({ status: 'success', template });
  } catch (err) {
    fail(res, 'update', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/form-templates/:id/publish — publish
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/form-templates/:id/publish', jwtOrApiKey, async (req, res) => {
  try {
    const result = await svc.publishTemplate(req.db, req.params.id, userId(req));
    res.json({ status: 'success', ...result });
  } catch (err) {
    fail(res, 'publish', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/form-templates/:id/visibility — X1 (EXTERNAL_FORMS_DESIGN §3)
// Explicit act, separate from publish. The service refuses off-internal flips
// while the PUBLISHED definition carries any externally-refused key (§4) —
// the 400 message names them (authed surface; no-oracle governs the external
// routes only). Flipping back to internal always succeeds.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/form-templates/:id/visibility', jwtOrApiKey, async (req, res) => {
  try {
    const out = await svc.setVisibility(
      req.db, req.params.id, req.body && req.body.visibility, userId(req)
    );
    res.json({ status: 'success', ...out });
  } catch (err) {
    fail(res, 'visibility', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/form-templates/:id — delete
// ─────────────────────────────────────────────────────────────────────────────

router.delete('/api/form-templates/:id', jwtOrApiKey, async (req, res) => {
  try {
    const result = await svc.deleteTemplate(req.db, req.params.id);
    res.json({ status: 'success', ...result });
  } catch (err) {
    fail(res, 'delete', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/form-templates/:id/versions — publish history (Slice 4)
// (An extra path segment, so /:id above can never shadow these.)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/form-templates/:id/versions', jwtOrApiKey, async (req, res) => {
  try {
    const versions = await svc.listVersions(req.db, req.params.id);
    res.json({ status: 'success', versions });
  } catch (err) {
    fail(res, 'listVersions', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/form-templates/:id/versions/:versionId — one version incl. definition
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/form-templates/:id/versions/:versionId', jwtOrApiKey, async (req, res) => {
  try {
    const version = await svc.getVersion(req.db, req.params.id, req.params.versionId);
    res.json({ status: 'success', version });
  } catch (err) {
    fail(res, 'getVersion', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/form-templates/:id/versions/:versionId/restore — version → draft
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/form-templates/:id/versions/:versionId/restore', jwtOrApiKey, async (req, res) => {
  try {
    const result = await svc.restoreVersion(req.db, req.params.id, req.params.versionId, userId(req));
    res.json({ status: 'success', ...result });
  } catch (err) {
    fail(res, 'restoreVersion', err);
  }
});


module.exports = router;