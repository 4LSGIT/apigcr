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
 * DELETE /api/form-templates/:id              — delete (never-published AND no-submissions only)
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


module.exports = router;