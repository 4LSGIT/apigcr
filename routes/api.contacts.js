/**
 * Contacts API
 * routes/api.contacts.js
 *
 * GET    /api/contacts            list with search/filters
 * GET    /api/contacts/:id        single + sub-entities (?include=)
 * POST   /api/contacts            create
 * PATCH  /api/contacts/:id        update fields
 * GET    /api/contacts/:id/cases  cases for contact
 * GET    /api/contacts/:id/appts  appointments for contact
 * GET    /api/contacts/:id/tasks  tasks for contact
 * GET    /api/contacts/:id/log    log entries for contact
 * GET    /api/contacts/:id/sequences  sequence enrollments
 */

const express        = require('express');
const router         = express.Router();
const jwtOrApiKey    = require('../lib/auth.jwtOrApiKey');
const contactService = require('../services/contactService');

// ─── LIST ───
router.get("/api/contacts", jwtOrApiKey, async (req, res) => {
  try {
    const result = await contactService.listContacts(req.db, {
      query: req.query.q || req.query.query || "",
      type: req.query.type,
      tags: req.query.tags,
      sort_by: req.query.sort_by || "contact_lname",
      sort_dir: req.query.sort_dir || "ASC",
      limit: req.query.limit || 50,
      offset: req.query.offset || 0,
    });
    res.json(result);
  } catch (err) {
    console.error("GET /api/contacts error:", err);
    res
      .status(500)
      .json({ status: "error", message: "Failed to fetch contacts" });
  }
});

// ─── GET ONE ───
router.get('/api/contacts/:id', jwtOrApiKey, async (req, res) => {
  try {
    const result = await contactService.getContact(req.db, req.params.id, req.query.include);
    if (!result) return res.status(404).json({ status: 'error', message: 'Contact not found' });
    res.json(result);
  } catch (err) {
    console.error('GET /api/contacts/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch contact' });
  }
});

// ─── CREATE ───
router.post('/api/contacts', jwtOrApiKey, async (req, res) => {
  const { fname, lname } = req.body;
  if (!fname || !lname) {
    return res.status(400).json({ status: 'error', message: 'fname and lname are required' });
  }

  try {
    const result = await contactService.createContact(req.db, req.body);
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('POST /api/contacts error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── UPDATE ───
router.patch('/api/contacts/:id', jwtOrApiKey, async (req, res) => {
  try {
    const updated = await contactService.updateContact(req.db, req.params.id, req.body);
    res.json({ status: 'success', data: updated });
  } catch (err) {
    console.error('PATCH /api/contacts/:id error:', err);
    const status = err.message.includes('blocked') ? 400 : err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ status: 'error', message: err.message });
  }
});

// ─── SUB-ENTITY SHORTCUTS ───
// These are convenience routes that call getContact with a specific include.
// Useful when the frontend only needs one sub-entity.

router.get('/api/contacts/:id/cases', jwtOrApiKey, async (req, res) => {
  try {
    const result = await contactService.getContact(req.db, req.params.id, 'cases');
    if (!result) return res.status(404).json({ status: 'error', message: 'Contact not found' });
    res.json({ cases: result.cases });
  } catch (err) {
    console.error('GET /api/contacts/:id/cases error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch cases' });
  }
});

router.get('/api/contacts/:id/appts', jwtOrApiKey, async (req, res) => {
  try {
    const result = await contactService.getContact(req.db, req.params.id, 'appts');
    if (!result) return res.status(404).json({ status: 'error', message: 'Contact not found' });
    res.json({ appts: result.appts });
  } catch (err) {
    console.error('GET /api/contacts/:id/appts error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch appointments' });
  }
});

router.get('/api/contacts/:id/tasks', jwtOrApiKey, async (req, res) => {
  try {
    const result = await contactService.getContact(req.db, req.params.id, 'tasks');
    if (!result) return res.status(404).json({ status: 'error', message: 'Contact not found' });
    res.json({ tasks: result.tasks });
  } catch (err) {
    console.error('GET /api/contacts/:id/tasks error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch tasks' });
  }
});

router.get('/api/contacts/:id/log', jwtOrApiKey, async (req, res) => {
  try {
    const result = await contactService.getContact(req.db, req.params.id, 'log');
    if (!result) return res.status(404).json({ status: 'error', message: 'Contact not found' });
    res.json({ log: result.log });
  } catch (err) {
    console.error('GET /api/contacts/:id/log error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch log' });
  }
});

router.get('/api/contacts/:id/sequences', jwtOrApiKey, async (req, res) => {
  try {
    const result = await contactService.getContact(req.db, req.params.id, 'sequences');
    if (!result) return res.status(404).json({ status: 'error', message: 'Contact not found' });
    res.json({ sequences: result.sequences });
  } catch (err) {
    console.error('GET /api/contacts/:id/sequences error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch sequences' });
  }
});

module.exports = router;