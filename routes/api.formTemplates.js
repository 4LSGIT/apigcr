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
 *                                               (+ external_executes[] notice when the
 *                                               template is externally visible)
 * POST   /api/form-templates/:id/visibility   — X1 (EXTERNAL_FORMS_DESIGN §3): set
 *                                               { visibility: internal|portal|public };
 *                                               off-internal flips are form_dev-gated
 *                                               (content refusal retired 2026-08-16)
 * DELETE /api/form-templates/:id              — delete (never-published AND no-submissions only)
 * GET    /api/form-templates/:id/versions             — publish history (no definitions; computed schema_changed)
 * GET    /api/form-templates/:id/versions/:versionId  — one version row incl. definition
 * POST   /api/form-templates/:id/versions/:versionId/restore — copy version definition → draft_definition
 *
 * Auto-mounted from routes/ (server.js readdir loop). All routes require JWT or
 * API key. Response envelope { status: 'success', ... } / on error
 * { status: 'error', message }. Service throws carry `.status` (400/403/404);
 * anything else is a 500.
 *
 * FORM-DEV GATE (2026-08-16 — ref/EXTERNAL_CODE_CSS_DECISION.md §Q5): the
 * service refuses (403, legible message) any write that introduces/changes/
 * removes top-level code/hooks/css, and any visibility flip off-internal,
 * unless the caller is a form developer (lib/auth.formDev.js: SU, roles
 * it/form_dev, or api_key). Field-only edits, publish, delete, reads, and
 * flip-to-internal stay open to all staff. Publishes, visibility changes,
 * and gate rejections write admin_audit_log rows (tool 'form_templates').
 *
 * Contract: ref/FORM_TEMPLATE_SCHEMA_V1.md §2.
 */

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { isFormDev } = require('../lib/auth.formDev');
const { auditAdminAction } = require('../lib/auth.superuser');
const svc = require('../services/formTemplateService');

const TOOL = 'form_templates';   // admin_audit_log tag

// Fire-and-forget audit row (same posture as lib/auth.superuser.js
// makeSuperuserCheck — an audit failure never breaks the request).
function audit(req, status, details) {
  auditAdminAction(req.db, {
    tool: TOOL,
    userId:   req.auth?.userId   ?? null,
    username: req.auth?.username ?? (req.auth?.key_label ? `api_key:${req.auth.key_label}` : null),
    route:    req.originalUrl,
    method:   req.method,
    status,
    ip:        req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
    ...(details ? { details } : {}),
  }).catch((err) => console.error('[api.formTemplates] audit log failed:', err.message));
}

// Map a thrown service error to an HTTP response. Form-dev rejections
// (err.code === 'form_dev_required', a 403 from the service gate) are
// audited — they are attempted privilege use, same class as
// auth.superuser's rejected_not_su rows.
function fail(req, res, tag, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(`[api.formTemplates] ${tag} error:`, err);
  if (err.code === 'form_dev_required') {
    audit(req, 'rejected_not_form_dev', { action: tag, message: err.message });
  }
  res.status(status).json({ status: 'error', message: err.message });
}

const userId = (req) => (req.auth && req.auth.userId != null ? req.auth.userId : null);

// Per-request form-dev authorization, passed into the service gates
// (lib/auth.formDev.js — SU / roles it,form_dev / api_key).
const authzOf = (req) => ({ formDev: isFormDev(req.auth) });


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/form-templates — list
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/form-templates', jwtOrApiKey, async (req, res) => {
  try {
    const templates = await svc.listTemplates(req.db);
    res.json({ status: 'success', templates });
  } catch (err) {
    fail(req, res, 'list', err);
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
    fail(req, res, 'render', err);
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
    fail(req, res, 'get', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/form-templates — create
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/form-templates', jwtOrApiKey, async (req, res) => {
  try {
    const template = await svc.createTemplate(req.db, req.body, userId(req), authzOf(req));
    res.status(201).json({ status: 'success', template });
  } catch (err) {
    fail(req, res, 'create', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/form-templates/:id — update
// ─────────────────────────────────────────────────────────────────────────────

router.put('/api/form-templates/:id', jwtOrApiKey, async (req, res) => {
  try {
    const template = await svc.updateTemplate(req.db, req.params.id, req.body, userId(req), authzOf(req));
    res.json({ status: 'success', template });
  } catch (err) {
    fail(req, res, 'update', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/form-templates/:id/publish — publish
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/form-templates/:id/publish', jwtOrApiKey, async (req, res) => {
  try {
    const result = await svc.publishTemplate(req.db, req.params.id, userId(req));
    audit(req, 'published', {
      template_id: Number(req.params.id),
      schema_version: result.schema_version,
      bumped: result.bumped,
      ...(result.external_refusals ? { external_refusals: result.external_refusals } : {}),
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    fail(req, res, 'publish', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/form-templates/:id/visibility — X1 (EXTERNAL_FORMS_DESIGN §3)
// Explicit act, separate from publish. Off-internal flips are form_dev-gated;
// the §4 content refusal is retired (2026-08-16 reversal — the builder's
// expose-confirm warns instead). Flipping back to internal always succeeds.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/form-templates/:id/visibility', jwtOrApiKey, async (req, res) => {
  try {
    const out = await svc.setVisibility(
      req.db, req.params.id, req.body && req.body.visibility, userId(req), authzOf(req)
    );
    audit(req, 'visibility_changed', {
      template_id: Number(req.params.id),
      visibility: out.visibility,
    });
    res.json({ status: 'success', ...out });
  } catch (err) {
    fail(req, res, 'visibility', err);
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
    fail(req, res, 'delete', err);
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
    fail(req, res, 'listVersions', err);
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
    fail(req, res, 'getVersion', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/form-templates/:id/versions/:versionId/restore — version → draft
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/form-templates/:id/versions/:versionId/restore', jwtOrApiKey, async (req, res) => {
  try {
    const result = await svc.restoreVersion(req.db, req.params.id, req.params.versionId, userId(req), authzOf(req));
    res.json({ status: 'success', ...result });
  } catch (err) {
    fail(req, res, 'restoreVersion', err);
  }
});


module.exports = router;