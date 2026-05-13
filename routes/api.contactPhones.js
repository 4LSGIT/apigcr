// routes/api.contactPhones.js
//
/**
 * Contact Phones API
 * routes/api.contactPhones.js
 *
 * GET    /api/contacts/:id/phones[?include_inactive=true]   list rows
 * POST   /api/contact-phones[?force=true]                    create
 * PATCH  /api/contact-phones/:id                             update lifecycle
 * DELETE /api/contact-phones/:id                             hard delete
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
const phoneSvc     = require('../services/contactPhoneService');


// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Map service-thrown Error messages (and optional .conflict marker) to
 * HTTP status codes. Mirrors api.contactRelations.js with a 409 path for
 * global active-uniqueness collisions.
 */
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

/** Resolve req.auth.userId to a numeric users.user value, or 0. */
function resolveCreatedBy(req) {
  const raw = req.auth && req.auth.userId;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return parseInt(raw, 10);
  return 0;
}

/** Truthy/falsy from query string for `?include_inactive=` / `?force=`. */
function parseBool(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  return false;
}


// ─── GET /api/contacts/:id/phones ───
router.get('/api/contacts/:id/phones', jwtOrApiKey, async (req, res) => {
  try {
    const include_inactive = parseBool(req.query.include_inactive);
    const result = await phoneSvc.listContactPhones(req.db, req.params.id, { include_inactive });
    if (!result) {
      return res.status(404).json({ status: 'error', message: 'Contact not found' });
    }
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('GET /api/contacts/:id/phones error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch phones' });
  }
});


// ─── POST /api/contact-phones ───
router.post('/api/contact-phones', jwtOrApiKey, async (req, res) => {
  try {
    const createdBy = resolveCreatedBy(req);
    const force     = parseBool(req.query.force);
    const { contact_id, ...fields } = req.body || {};

    if (!contact_id) {
      return res.status(400).json({ status: 'error', message: 'contact_id is required' });
    }

    const result = await phoneSvc.createContactPhone(req.db, contact_id, fields, { force, createdBy });
    res.status(201).json({ status: 'success', ...result });
  } catch (err) {
    console.error('POST /api/contact-phones error:', err);
    const status = mapErrorStatus(err);
    const body = { status: 'error', message: err.message };
    if (err.conflict) body.conflict = err.conflict;
    res.status(status).json(body);
  }
});


// ─── PATCH /api/contact-phones/:id ───
router.patch('/api/contact-phones/:id', jwtOrApiKey, async (req, res) => {
  try {
    const updatedBy = resolveCreatedBy(req);
    const result = await phoneSvc.updateContactPhone(req.db, req.params.id, req.body, { updatedBy });
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('PATCH /api/contact-phones/:id error:', err);
    const status = mapErrorStatus(err);
    res.status(status).json({ status: 'error', message: err.message });
  }
});


// ─── DELETE /api/contact-phones/:id ───
router.delete('/api/contact-phones/:id', jwtOrApiKey, async (req, res) => {
  try {
    const result = await phoneSvc.deleteContactPhone(req.db, req.params.id);
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('DELETE /api/contact-phones/:id error:', err);
    const status = mapErrorStatus(err);
    res.status(status).json({ status: 'error', message: err.message });
  }
});


module.exports = router;