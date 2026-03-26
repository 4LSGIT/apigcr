/**
 * Cases API
 * routes/api.cases.js
 *
 * GET    /api/cases                       list with search/filters
 * GET    /api/cases/:id                   single + sub-entities (?include=)
 * PATCH  /api/cases/:id                   update fields
 * GET    /api/cases/:id/contacts          contacts for case
 * POST   /api/cases/:id/contacts          add contact to case
 * DELETE /api/cases/:id/contacts/:contactId  remove contact from case
 * GET    /api/cases/:id/tasks             tasks for case (preserved from existing)
 * GET    /api/cases/:id/log               log entries for case
 */

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const caseService = require('../services/caseService');

// ─── LIST ───
router.get('/api/cases', jwtOrApiKey, async (req, res) => {
  try {
    const result = await caseService.listCases(req.db, {
      query: req.query.q || req.query.query || "",
      type: req.query.type || "%",
      stage: req.query.stage || "%",
      status: req.query.status || "%",
      sort_by: req.query.sort_by || "c.case_open_date",
      sort_dir: req.query.sort_dir || "DESC",
      limit: req.query.limit || 50,
      offset: req.query.offset || 0,
    });
    res.json(result);
  } catch (err) {
    console.error('GET /api/cases error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch cases' });
  }
});

// ─── GET ONE ───
router.get('/api/cases/:id', jwtOrApiKey, async (req, res) => {
  try {
    const result = await caseService.getCase(req.db, req.params.id, req.query.include);
    if (!result) return res.status(404).json({ status: 'error', message: 'Case not found' });
    res.json(result);
  } catch (err) {
    console.error('GET /api/cases/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch case' });
  }
});

// ─── UPDATE ───
router.patch('/api/cases/:id', jwtOrApiKey, async (req, res) => {
  try {
    const updated = await caseService.updateCase(req.db, req.params.id, req.body);
    res.json({ status: 'success', data: updated });
  } catch (err) {
    console.error('PATCH /api/cases/:id error:', err);
    const status = err.message.includes('cannot update') ? 400 : err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ status: 'error', message: err.message });
  }
});

// ─── CONTACTS (case_relate) ───

router.get('/api/cases/:id/contacts', jwtOrApiKey, async (req, res) => {
  try {
    const contacts = await caseService.getCaseContacts(req.db, req.params.id);
    res.json({ contacts });
  } catch (err) {
    console.error('GET /api/cases/:id/contacts error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch contacts' });
  }
});

router.post('/api/cases/:id/contacts', jwtOrApiKey, async (req, res) => {
  const { contact_id, relate_type } = req.body;
  if (!contact_id) return res.status(400).json({ status: 'error', message: 'contact_id is required' });

  try {
    const result = await caseService.addCaseContact(
      req.db, req.params.id, contact_id, relate_type || 'Primary'
    );
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('POST /api/cases/:id/contacts error:', err);
    const status = err.message.includes('already linked') ? 409 : 500;
    res.status(status).json({ status: 'error', message: err.message });
  }
});

router.delete('/api/cases/:id/contacts/:contactId', jwtOrApiKey, async (req, res) => {
  try {
    const result = await caseService.removeCaseContact(req.db, req.params.id, req.params.contactId);
    if (!result.removed) return res.status(404).json({ status: 'error', message: 'Relationship not found' });
    res.json({ status: 'success', message: 'Contact removed from case' });
  } catch (err) {
    console.error('DELETE /api/cases/:id/contacts/:contactId error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to remove contact' });
  }
});

// ─── SUB-ENTITY SHORTCUTS ───

router.get('/api/cases/:id/tasks', jwtOrApiKey, async (req, res) => {
  try {
    const result = await caseService.getCase(req.db, req.params.id, 'tasks');
    if (!result) return res.status(404).json({ status: 'error', message: 'Case not found' });
    res.json({ tasks: result.tasks });
  } catch (err) {
    console.error('GET /api/cases/:id/tasks error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch tasks' });
  }
});

router.get('/api/cases/:id/log', jwtOrApiKey, async (req, res) => {
  try {
    const result = await caseService.getCase(req.db, req.params.id, 'log');
    if (!result) return res.status(404).json({ status: 'error', message: 'Case not found' });
    res.json({ log: result.log });
  } catch (err) {
    console.error('GET /api/cases/:id/log error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch log' });
  }
});

module.exports = router;