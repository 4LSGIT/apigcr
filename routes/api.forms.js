// routes/api.forms.js
//
/**
 * routes/api.forms.js — REST routes for the YisraCase Forms System
 *
 * GET    /api/forms/latest   — latest submitted + draft for a form+entity
 * POST   /api/forms/draft    — upsert autosave draft
 * POST   /api/forms/submit   — record explicit submission
 * DELETE /api/forms/draft     — discard draft
 * GET    /api/forms/history   — submission history
 * GET    /api/forms/submissions      — admin browse (filters + before_id cursor;
 *                                      no data bodies unless with_data=1; unlinked=1
 *                                      filters to the ('','') convention)
 * GET    /api/forms/submissions/:id  — one submission incl. data
 * GET    /api/forms/submissions/:id/render — submission + version-matched
 *                                      definition (render.html view mode, X4)
 * PATCH  /api/forms/submissions/:id/link   — adopt onto a case/contact/appt (X4)
 *
 * All routes require JWT or API key auth. The Slice-4/X4 submissions routes
 * map service `.status` errors to 400/404/409 (the api.formTemplates pattern);
 * the older handlers keep their original 500-everything mapping untouched.
 */

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const formService = require('../services/formService');


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/forms/latest
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/forms/latest', jwtOrApiKey, async (req, res) => {
  const { form_key, link_type, link_id } = req.query;

  if (!form_key || !link_type || !link_id) {
    return res.status(400).json({
      status: 'error',
      message: 'Missing required query params: form_key, link_type, link_id',
    });
  }

  try {
    const result = await formService.getLatest(req.db, form_key, link_type, link_id);
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('[api.forms] getLatest error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/forms/draft
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/forms/draft', jwtOrApiKey, async (req, res) => {
  const { form_key, link_type, link_id, schema_version, data } = req.body;

  if (!form_key || !link_type || !link_id || data == null) {
    return res.status(400).json({
      status: 'error',
      message: 'Missing required fields: form_key, link_type, link_id, data',
    });
  }

  try {
    const result = await formService.upsertDraft(
      req.db, form_key, link_type, link_id,
      schema_version || 1, data, req.auth.userId
    );
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('[api.forms] upsertDraft error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/forms/submit
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/forms/submit', jwtOrApiKey, async (req, res) => {
  const { form_key, link_type, link_id, schema_version, data } = req.body;

  if (!form_key || !link_type || !link_id || data == null) {
    return res.status(400).json({
      status: 'error',
      message: 'Missing required fields: form_key, link_type, link_id, data',
    });
  }

  try {
    const result = await formService.submitForm(
      req.db, form_key, link_type, link_id,
      schema_version || 1, data, req.auth.userId
    );
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('[api.forms] submitForm error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/forms/draft
// ─────────────────────────────────────────────────────────────────────────────

router.delete('/api/forms/draft', jwtOrApiKey, async (req, res) => {
  const { form_key, link_type, link_id } = req.query;

  if (!form_key || !link_type || !link_id) {
    return res.status(400).json({
      status: 'error',
      message: 'Missing required query params: form_key, link_type, link_id',
    });
  }

  try {
    const result = await formService.deleteDraft(req.db, form_key, link_type, link_id);
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('[api.forms] deleteDraft error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/forms/history
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/forms/history', jwtOrApiKey, async (req, res) => {
  const { form_key, link_type, link_id, limit } = req.query;

  if (!form_key || !link_type || !link_id) {
    return res.status(400).json({
      status: 'error',
      message: 'Missing required query params: form_key, link_type, link_id',
    });
  }

  try {
    const rows = await formService.getHistory(
      req.db, form_key, link_type, link_id,
      parseInt(limit, 10) || 10
    );
    res.json({ status: 'success', submissions: rows });
  } catch (err) {
    console.error('[api.forms] getHistory error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// Map a thrown service error to an HTTP response (api.formTemplates pattern —
// used by the Slice-4 routes below only).
function fail(res, tag, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(`[api.forms] ${tag} error:`, err);
  res.status(status).json({ status: 'error', message: err.message });
}


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/forms/submissions — admin browse (Slice 4)
// Filters: form_key, link_type, link_id, status; limit (default 50, max 200)
// + before_id keyset cursor. Summary columns only — no data bodies.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/forms/submissions', jwtOrApiKey, async (req, res) => {
  try {
    const result = await formService.browseSubmissions(req.db, req.query);
    res.json({ status: 'success', ...result });
  } catch (err) {
    fail(res, 'browseSubmissions', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/forms/submissions/:id — one submission incl. data (Slice 4)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/forms/submissions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const submission = await formService.getSubmission(req.db, req.params.id);
    res.json({ status: 'success', submission });
  } catch (err) {
    fail(res, 'getSubmission', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/forms/submissions/:id/render — submission + version-matched
// definition in one payload (X4). Feeds render.html's ?view_submission mode.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/forms/submissions/:id/render', jwtOrApiKey, async (req, res) => {
  try {
    const payload = await formService.getSubmissionForRender(req.db, req.params.id);
    res.json({ status: 'success', ...payload });
  } catch (err) {
    fail(res, 'getSubmissionForRender', err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/forms/submissions/:id/link — adopt an unlinked submission onto a
// case / contact / appt (X4, EXTERNAL_FORMS_DESIGN §8). Body:
// { link_type: 'case'|'contact'|'appt', link_id }. One-way (unlinked → linked
// only); who linked it is stamped from the auth principal, never the body.
// ─────────────────────────────────────────────────────────────────────────────

router.patch('/api/forms/submissions/:id/link', jwtOrApiKey, async (req, res) => {
  try {
    const { link_type, link_id } = req.body || {};
    const result = await formService.linkSubmission(
      req.db, req.params.id, link_type, link_id, req.auth.userId
    );
    res.json({ status: 'success', ...result });
  } catch (err) {
    fail(res, 'linkSubmission', err);
  }
});


module.exports = router;