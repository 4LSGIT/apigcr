// routes/api.contactAddresses.js
//
/**
 * Contact Addresses API
 * routes/api.contactAddresses.js
 *
 * GET    /api/contacts/:id/addresses[?include_inactive=true]   list rows
 * POST   /api/contact-addresses                                  create
 * PATCH  /api/contact-addresses/:id                              update
 * DELETE /api/contact-addresses/:id                              hard delete
 *
 * No `?force=true` query param and no 409 path — addresses do not have
 * active-uniqueness across contacts (spouses, children, co-tenants
 * legitimately share addresses).
 *
 * Auto-mounted by the routes loader; no entry-point edits needed.
 */

const express      = require('express');
const router       = express.Router();
const jwtOrApiKey  = require('../lib/auth.jwtOrApiKey');
const addrSvc      = require('../services/contactAddressService');


// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Map service-thrown Error messages to HTTP status codes.
 * Mirrors api.contactPhones.js minus the 409 (.conflict) branch —
 * addresses never produce collisions.
 */
function mapErrorStatus(err) {
  const m = (err && err.message) || '';
  if (!m) return 500;
  if (m.includes('not found')) return 404;
  if (m.includes('already exists') ||
      m.includes('not allowed')    ||
      m.includes('must be')        ||
      m.includes('required')       ||
      m.includes('requires')       ||
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


// ─── GET /api/contacts/:id/addresses ───
router.get('/api/contacts/:id/addresses', jwtOrApiKey, async (req, res) => {
  try {
    const include_inactive = parseBool(req.query.include_inactive);
    const result = await addrSvc.listContactAddresses(req.db, req.params.id, { include_inactive });
    if (!result) {
      return res.status(404).json({ status: 'error', message: 'Contact not found' });
    }
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('GET /api/contacts/:id/addresses error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch addresses' });
  }
});


// ─── POST /api/contact-addresses ───
router.post('/api/contact-addresses', jwtOrApiKey, async (req, res) => {
  try {
    const createdBy = resolveCreatedBy(req);
    const { contact_id, ...fields } = req.body || {};

    if (!contact_id) {
      return res.status(400).json({ status: 'error', message: 'contact_id is required' });
    }

    const result = await addrSvc.createContactAddress(req.db, contact_id, fields, { createdBy });
    res.status(201).json({ status: 'success', ...result });
  } catch (err) {
    console.error('POST /api/contact-addresses error:', err);
    const status = mapErrorStatus(err);
    res.status(status).json({ status: 'error', message: err.message });
  }
});


// ─── PATCH /api/contact-addresses/:id ───
router.patch('/api/contact-addresses/:id', jwtOrApiKey, async (req, res) => {
  try {
    const updatedBy = resolveCreatedBy(req);
    const result = await addrSvc.updateContactAddress(req.db, req.params.id, req.body, { updatedBy });
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('PATCH /api/contact-addresses/:id error:', err);
    const status = mapErrorStatus(err);
    res.status(status).json({ status: 'error', message: err.message });
  }
});


// ─── DELETE /api/contact-addresses/:id ───
router.delete('/api/contact-addresses/:id', jwtOrApiKey, async (req, res) => {
  try {
    const result = await addrSvc.deleteContactAddress(req.db, req.params.id);
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('DELETE /api/contact-addresses/:id error:', err);
    const status = mapErrorStatus(err);
    res.status(status).json({ status: 'error', message: err.message });
  }
});


module.exports = router;