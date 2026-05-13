// routes/api.contactEmails.js
//
/**
 * Contact Emails API
 * routes/api.contactEmails.js
 *
 * GET    /api/contacts/:id/emails[?include_inactive=true]   list rows
 * POST   /api/contact-emails[?force=true]                    create
 * PATCH  /api/contact-emails/:id                             update lifecycle
 * DELETE /api/contact-emails/:id                             hard delete
 *
 * Auto-mounted by the routes loader; no entry-point edits needed.
 *
 * NOTE: this file declares a route under /api/contacts/:id/...; this
 * coexists with routes/api.contacts.js — Express matches handlers across
 * router files by path pattern.
 */

const express      = require('express');
const router       = express.Router();
const jwtOrApiKey  = require('../lib/auth.jwtOrApiKey');
const emailSvc     = require('../services/contactEmailService');


// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function mapErrorStatus(err) {
  if (err && err.conflict) return 409;
  const m = (err && err.message) || '';
  if (!m) return 500;
  if (m.includes('not found')) return 404;
  if (m.includes('already exists') ||
      m.includes('not allowed')    ||
      m.includes('must be')        ||
      m.includes('required')       ||
      m.includes('invalid')        ||
      m.includes('Invalid')        ||
      m.includes('forbidden')      ||
      m.includes('Cannot update')  ||
      m.includes('would violate')  ||
      m.includes('already has')   ||
      m.includes('concurrent')    ||
      m.includes('Concurrent')) {
    return 400;
  }
  return 500;
}

function resolveCreatedBy(req) {
  const raw = req.auth && req.auth.userId;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return parseInt(raw, 10);
  return 0;
}

function parseBool(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  return false;
}


// ─── GET /api/contacts/:id/emails ───
router.get('/api/contacts/:id/emails', jwtOrApiKey, async (req, res) => {
  try {
    const include_inactive = parseBool(req.query.include_inactive);
    const result = await emailSvc.listContactEmails(req.db, req.params.id, { include_inactive });
    if (!result) {
      return res.status(404).json({ status: 'error', message: 'Contact not found' });
    }
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('GET /api/contacts/:id/emails error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch emails' });
  }
});


// ─── POST /api/contact-emails ───
router.post('/api/contact-emails', jwtOrApiKey, async (req, res) => {
  try {
    const createdBy = resolveCreatedBy(req);
    const force     = parseBool(req.query.force);
    const { contact_id, ...fields } = req.body || {};

    if (!contact_id) {
      return res.status(400).json({ status: 'error', message: 'contact_id is required' });
    }

    const result = await emailSvc.createContactEmail(req.db, contact_id, fields, { force, createdBy });
    res.status(201).json({ status: 'success', ...result });
  } catch (err) {
    console.error('POST /api/contact-emails error:', err);
    const status = mapErrorStatus(err);
    const body = { status: 'error', message: err.message };
    if (err.conflict) body.conflict = err.conflict;
    res.status(status).json(body);
  }
});


// ─── PATCH /api/contact-emails/:id ───
router.patch('/api/contact-emails/:id', jwtOrApiKey, async (req, res) => {
  try {
    const updatedBy = resolveCreatedBy(req);
    const result = await emailSvc.updateContactEmail(req.db, req.params.id, req.body, { updatedBy });
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('PATCH /api/contact-emails/:id error:', err);
    const status = mapErrorStatus(err);
    res.status(status).json({ status: 'error', message: err.message });
  }
});


// ─── DELETE /api/contact-emails/:id ───
router.delete('/api/contact-emails/:id', jwtOrApiKey, async (req, res) => {
  try {
    const result = await emailSvc.deleteContactEmail(req.db, req.params.id);
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('DELETE /api/contact-emails/:id error:', err);
    const status = mapErrorStatus(err);
    res.status(status).json({ status: 'error', message: err.message });
  }
});


module.exports = router;