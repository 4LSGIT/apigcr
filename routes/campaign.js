/**
 * Campaign Routes (redesigned)
 * routes/campaign.js
 *
 * Thin HTTP wrappers around campaignService.
 * All routes use JWT auth via jwtOrApiKey.
 *
 * Replaces the old POST /api/campaigns/trigger route entirely.
 *
 * Routes:
 *   GET    /api/campaigns/contacts      — filter contacts for selection
 *   POST   /api/campaigns/preview       — resolve placeholders for preview
 *   POST   /api/campaigns               — create campaign + jobs
 *   GET    /api/campaigns               — list campaigns (paginated)
 *   GET    /api/campaigns/:id           — single campaign with results summary
 *   GET    /api/campaigns/:id/results   — per-contact result details
 *   PATCH  /api/campaigns/:id           — cancel a campaign
 */

const express       = require('express');
const router        = express.Router();
const jwtOrApiKey   = require('../lib/auth.jwtOrApiKey');
const campaignService = require('../services/campaignService');

// ─────────────────────────────────────────────────────────────
// GET /api/campaigns/contacts — filter contacts for campaign selection
// ─────────────────────────────────────────────────────────────
router.get('/api/campaigns/contacts', jwtOrApiKey, async (req, res) => {
  try {
    const filters = {};

    if (req.query.tags) {
      filters.tags = req.query.tags.split(',').map(t => t.trim()).filter(Boolean);
    }
    if (req.query.case_type)       filters.case_type       = req.query.case_type;
    if (req.query.case_stage)      filters.case_stage       = req.query.case_stage.split(',').map(s => s.trim());
    if (req.query.case_open_after) filters.case_open_after  = req.query.case_open_after;
    if (req.query.case_open_before) filters.case_open_before = req.query.case_open_before;
    if (req.query.channel)         filters.channel          = req.query.channel;

    const result = await campaignService.getFilteredContacts(req.db, filters);
    res.json(result);
  } catch (err) {
    console.error('[GET /api/campaigns/contacts]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/campaigns/preview — resolve placeholders for one contact
// ─────────────────────────────────────────────────────────────
router.post('/api/campaigns/preview', jwtOrApiKey, async (req, res) => {
  const { body, subject, contactId } = req.body;

  if (!body || !contactId) {
    return res.status(400).json({ error: 'body and contactId are required' });
  }

  try {
    const result = await campaignService.previewCampaign(req.db, { body, subject, contactId });
    res.json(result);
  } catch (err) {
    console.error('[POST /api/campaigns/preview]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/campaigns — create a new campaign
// ─────────────────────────────────────────────────────────────
router.post('/api/campaigns', jwtOrApiKey, async (req, res) => {
  const { type, sender, subject, body, contactIds, scheduledTime } = req.body;

  if (!type || !sender || !body) {
    return res.status(400).json({ error: 'type, sender, and body are required' });
  }
  if (!contactIds || !Array.isArray(contactIds) || !contactIds.length) {
    return res.status(400).json({ error: 'contactIds must be a non-empty array' });
  }

  try {
    const result = await campaignService.createCampaign(req.db, {
      type,
      sender,
      subject,
      body,
      contactIds,
      scheduledTime: scheduledTime || null,
      createdBy: req.auth.userId
    });
    res.json(result);
  } catch (err) {
    console.error('[POST /api/campaigns]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/campaigns — list campaigns (paginated)
// ─────────────────────────────────────────────────────────────
router.get('/api/campaigns', jwtOrApiKey, async (req, res) => {
  try {
    const result = await campaignService.listCampaigns(req.db, {
      status: req.query.status || null,
      page:   req.query.page,
      limit:  req.query.limit
    });
    res.json(result);
  } catch (err) {
    console.error('[GET /api/campaigns]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/campaigns/:id — single campaign with results summary
// ─────────────────────────────────────────────────────────────
router.get('/api/campaigns/:id', jwtOrApiKey, async (req, res) => {
  try {
    const campaign = await campaignService.getCampaign(req.db, parseInt(req.params.id));
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json(campaign);
  } catch (err) {
    console.error('[GET /api/campaigns/:id]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/campaigns/:id/results — per-contact result details
// ─────────────────────────────────────────────────────────────
router.get('/api/campaigns/:id/results', jwtOrApiKey, async (req, res) => {
  try {
    const results = await campaignService.getCampaignResults(req.db, parseInt(req.params.id));
    res.json(results);
  } catch (err) {
    console.error('[GET /api/campaigns/:id/results]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/campaigns/:id — cancel a campaign
// ─────────────────────────────────────────────────────────────
router.patch('/api/campaigns/:id', jwtOrApiKey, async (req, res) => {
  const { status } = req.body;

  if (status !== 'canceled') {
    return res.status(400).json({ error: 'Only status: "canceled" is supported' });
  }

  try {
    const result = await campaignService.cancelCampaign(req.db, parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    console.error('[PATCH /api/campaigns/:id]', err);

    const code = err.message.includes('not found') ? 404
               : err.message.includes('Cannot cancel') ? 409
               : 500;
    res.status(code).json({ error: err.message });
  }
});

module.exports = router;