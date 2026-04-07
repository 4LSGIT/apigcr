/**
 * routes/api.forms.js — REST routes for the YisraCase Forms System
 *
 * GET    /api/forms/latest   — latest submitted + draft for a form+entity
 * POST   /api/forms/draft    — upsert autosave draft
 * POST   /api/forms/submit   — record explicit submission
 * DELETE /api/forms/draft     — discard draft
 * GET    /api/forms/history   — submission history
 *
 * All routes require JWT or API key auth.
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


module.exports = router;