// routes/api.contactRelations.js
//
/**
 * Contact Relations API (Slice 2)
 * routes/api.contactRelations.js
 *
 * GET    /api/relation-types                 catalog of relation types
 * GET    /api/contacts/:id/relations         list relations for one contact
 * POST   /api/contact-relations              create
 * PATCH  /api/contact-relations/:id          update lifecycle fields
 * DELETE /api/contact-relations/:id          hard delete
 *
 * NOTE: this file declares a route under /api/contacts/:id/...; this
 * coexists with routes/api.contacts.js — Express matches handlers across
 * router files by path pattern, no entry-point edit needed.
 */

const express = require('express');
const router  = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const relSvc = require('../services/contactRelationService');


// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Map service-thrown Error messages to HTTP status codes.
 * Mirrors the convention in routes/api.contacts.js PATCH handler.
 */
function mapErrorStatus(message) {
  if (!message) return 500;
  if (message.includes('not found')) return 404;
  if (message.includes('already exists') ||
      message.includes('not allowed')    ||
      message.includes('must be')        ||
      message.includes('required')       ||
      message.includes('invalid')        ||
      message.includes('forbidden')      ||
      message.includes('Cannot update')) {
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

/** Truthy/falsy from query string for `?include_inactive=` etc. */
function parseBool(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  return false;
}


// ─── GET /api/relation-types ───
router.get('/api/relation-types', jwtOrApiKey, async (req, res) => {
  try {
    const includeInactive = parseBool(req.query.include_inactive);
    const result = await relSvc.listRelationTypes(req.db, { includeInactive });
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('GET /api/relation-types error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch relation types' });
  }
});


// ─── GET /api/contacts/:id/relations ───
router.get('/api/contacts/:id/relations', jwtOrApiKey, async (req, res) => {
  try {
    const opts = {
      active:   req.query.active,
      typeCode: req.query.type_code || null,
      limit:    req.query.limit,
      offset:   req.query.offset,
    };
    const result = await relSvc.listContactRelations(req.db, req.params.id, opts);
    if (!result) {
      return res.status(404).json({ status: 'error', message: 'Contact not found' });
    }
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('GET /api/contacts/:id/relations error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch relations' });
  }
});


// ─── POST /api/contact-relations ───
router.post('/api/contact-relations', jwtOrApiKey, async (req, res) => {
  try {
    const createdBy = resolveCreatedBy(req);
    const result = await relSvc.createRelation(req.db, req.body, { createdBy });
    res.status(201).json({ status: 'success', ...result });
  } catch (err) {
    console.error('POST /api/contact-relations error:', err);
    const status = mapErrorStatus(err.message);
    res.status(status).json({ status: 'error', message: err.message });
  }
});


// ─── PATCH /api/contact-relations/:id ───
router.patch('/api/contact-relations/:id', jwtOrApiKey, async (req, res) => {
  try {
    const result = await relSvc.updateRelation(req.db, req.params.id, req.body);
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('PATCH /api/contact-relations/:id error:', err);
    const status = mapErrorStatus(err.message);
    res.status(status).json({ status: 'error', message: err.message });
  }
});


// ─── DELETE /api/contact-relations/:id ───
router.delete('/api/contact-relations/:id', jwtOrApiKey, async (req, res) => {
  try {
    const result = await relSvc.deleteRelation(req.db, req.params.id);
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('DELETE /api/contact-relations/:id error:', err);
    const status = mapErrorStatus(err.message);
    res.status(status).json({ status: 'error', message: err.message });
  }
});


module.exports = router;