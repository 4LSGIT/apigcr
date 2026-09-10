// routes/api.contactRoles.js
//
/**
 * Contact Roles API (role-forms slice)
 * routes/api.contactRoles.js
 *
 * Role TYPE catalog (backs the settings.html "Contact Roles" editor):
 *   GET    /api/contact-role-types              catalog (?include_inactive=)
 *   POST   /api/contact-role-types              create (role_code immutable after)
 *   PUT    /api/contact-role-types/:code        label / sort_order / active / attrs_schema
 *   (no DELETE — contact_roles rows reference codes with no FK; deactivate instead)
 *
 * Per-contact role rows (backs the contact-form "Roles" section):
 *   GET    /api/contacts/:id/roles              all rows incl. inactive
 *   POST   /api/contacts/:id/roles              attach (attrs schema-validated)
 *   PATCH  /api/contacts/:id/roles/:roleRowId   attrs / active / sort_order
 *   DELETE /api/contacts/:id/roles/:roleRowId   HARD detach — created-in-error only;
 *                                               the form's default "remove" is
 *                                               PATCH active=0 (history-preserving,
 *                                               how m6 retires Namee)
 *
 * The :roleRowId routes are OWNERSHIP-SCOPED: the row must belong to the
 * contact in the URL or the route 404s. contactRelations' flat
 * /api/contact-relations/:id has no such scoping, but these are nested under
 * a contact — a PATCH that silently edited another contact's row through a
 * stale URL would be a data-integrity bug, not a convenience.
 *
 * This file declares routes under /api/contacts/:id/... — Express matches
 * handlers across router files by path pattern (the api.contactRelations.js
 * precedent), no entry-point edit needed.
 */

const express = require('express');
const router  = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const roleSvc = require('../services/contactRoleService');


// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Map service-thrown Error messages to HTTP status codes.
 * Same convention as routes/api.contactRelations.js, extended for the
 * attrs / attrs_schema validator vocabulary.
 */
function mapErrorStatus(message) {
  if (!message) return 500;
  if (message.includes('not found')) return 404;
  if (message.includes('already')        ||
      message.includes('must be')        ||
      message.includes('must not')       ||
      message.includes('required')       ||
      message.includes('invalid')        ||
      message.includes('immutable')      ||
      message.includes('duplicated')     ||
      message.includes('unique')         ||
      message.includes('unknown property') ||
      message.includes('only allowed')   ||
      message.includes('wrong type')     ||
      message.includes('not one of')     ||
      message.includes('at least one')) {
    return 400;
  }
  return 500;
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

/**
 * Resolve :id + :roleRowId to an ownership-checked role row.
 * Sends the 4xx itself and returns null on any miss.
 */
async function ownedRoleRow(req, res) {
  const cid = parseInt(req.params.id, 10);
  if (!Number.isInteger(cid)) {
    res.status(400).json({ status: 'error', message: 'contact id must be an integer' });
    return null;
  }
  let row;
  try {
    row = await roleSvc.getRoleRow(req.db, req.params.roleRowId);
  } catch (err) {
    res.status(mapErrorStatus(err.message)).json({ status: 'error', message: err.message });
    return null;
  }
  if (!row || row.contact_id !== cid) {
    res.status(404).json({ status: 'error', message: 'Role row not found on this contact' });
    return null;
  }
  return row;
}


// ─────────────────────────────────────────────────────────────
// Role types
// ─────────────────────────────────────────────────────────────

// ─── GET /api/contact-role-types ───
router.get('/api/contact-role-types', jwtOrApiKey, async (req, res) => {
  try {
    const includeInactive = parseBool(req.query.include_inactive);
    const result = await roleSvc.listRoleTypes(req.db, { includeInactive });
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('GET /api/contact-role-types error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch role types' });
  }
});

// ─── POST /api/contact-role-types ───
router.post('/api/contact-role-types', jwtOrApiKey, async (req, res) => {
  try {
    const result = await roleSvc.createRoleType(req.db, req.body);
    res.status(201).json({ status: 'success', ...result });
  } catch (err) {
    console.error('POST /api/contact-role-types error:', err);
    const status = mapErrorStatus(err.message);
    res.status(status).json({ status: 'error', message: err.message });
  }
});

// ─── PUT /api/contact-role-types/:code ───
//
// role_code is IMMUTABLE: consumers reference 'judge' and 'trustee' as
// string literals (lib/trusteeRoster, lib/caseRoleResolver, /api/judges,
// /api/trustees) and every contact_roles row carries the code with no FK —
// a rename would orphan all of them at once. A body that tries is a 400
// here AND in the service (defense in depth: the service guard covers any
// future caller that skips this route).
router.put('/api/contact-role-types/:code', jwtOrApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    if (body.role_code !== undefined && String(body.role_code).trim() !== req.params.code) {
      return res.status(400).json({
        status: 'error',
        message: 'role_code is immutable \u2014 deactivate this type and create a new one instead',
      });
    }
    const result = await roleSvc.updateRoleType(req.db, req.params.code, {
      label:        body.label,
      sort_order:   body.sort_order,
      active:       body.active,
      attrs_schema: body.attrs_schema,
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('PUT /api/contact-role-types/:code error:', err);
    const status = mapErrorStatus(err.message);
    res.status(status).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// Per-contact role rows
// ─────────────────────────────────────────────────────────────

// ─── GET /api/contacts/:id/roles ───
//
// activeOnly=false on purpose: the contact form shows inactive rows greyed
// with a reactivate affordance, so it needs them in the payload.
router.get('/api/contacts/:id/roles', jwtOrApiKey, async (req, res) => {
  try {
    const result = await roleSvc.listContactRoles(req.db, req.params.id, { activeOnly: false });
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('GET /api/contacts/:id/roles error:', err);
    const status = mapErrorStatus(err.message);
    res.status(status).json({ status: 'error', message: err.message });
  }
});

// ─── POST /api/contacts/:id/roles ───
router.post('/api/contacts/:id/roles', jwtOrApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await roleSvc.attachRole(req.db, {
      contact_id: req.params.id,
      role:       body.role,
      attrs:      body.attrs !== undefined ? body.attrs : null,
      active:     body.active !== undefined ? body.active : 1,
      sort_order: body.sort_order !== undefined ? body.sort_order : 0,
    });
    res.status(201).json({ status: 'success', ...result });
  } catch (err) {
    console.error('POST /api/contacts/:id/roles error:', err);
    const status = mapErrorStatus(err.message);
    res.status(status).json({ status: 'error', message: err.message });
  }
});

// ─── PATCH /api/contacts/:id/roles/:roleRowId ───
router.patch('/api/contacts/:id/roles/:roleRowId', jwtOrApiKey, async (req, res) => {
  try {
    const row = await ownedRoleRow(req, res);
    if (!row) return;
    const body = req.body || {};
    const result = await roleSvc.updateRole(req.db, row.id, {
      attrs:      body.attrs,
      active:     body.active,
      sort_order: body.sort_order,
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('PATCH /api/contacts/:id/roles/:roleRowId error:', err);
    const status = mapErrorStatus(err.message);
    res.status(status).json({ status: 'error', message: err.message });
  }
});

// ─── DELETE /api/contacts/:id/roles/:roleRowId ───
//
// HARD detach — for rows created in error only. Removing a real role is
// PATCH active=0: history-preserving, and instantly removes the contact
// from every role consumer (roster, filters, pickers) exactly like m6's
// Namee deactivation.
router.delete('/api/contacts/:id/roles/:roleRowId', jwtOrApiKey, async (req, res) => {
  try {
    const row = await ownedRoleRow(req, res);
    if (!row) return;
    const result = await roleSvc.detachRole(req.db, {
      contact_id: row.contact_id,
      role:       row.role,
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('DELETE /api/contacts/:id/roles/:roleRowId error:', err);
    const status = mapErrorStatus(err.message);
    res.status(status).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
