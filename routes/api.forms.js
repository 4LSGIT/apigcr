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
 * GET    /api/forms/submissions      — admin browse (filters + before_id cursor; no data bodies)
 * GET    /api/forms/submissions/:id  — one submission incl. data
 *
 * All routes require JWT or API key auth. The two Slice-4 submissions routes
 * map service `.status` errors to 400/404 (the api.formTemplates pattern);
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


module.exports = router;