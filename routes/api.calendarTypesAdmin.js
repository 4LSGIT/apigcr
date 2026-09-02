// routes/api.calendarTypesAdmin.js
//
/**
 * routes/api.calendarTypesAdmin.js — admin CRUD for the calendar item-type
 * registry (Unified Events U2b). Logic lives in
 * services/calendarTypeAdminService.js; this file is the HTTP mapper, in the
 * routes/api.pipelineAdmin.js shape.
 *
 * GET    /api/calendar-types-admin              — every row (active or not), registry
 *                                                  order, + refs {events, appts,
 *                                                  booking_views, ai_match_types, total}
 * GET    /api/calendar-types-admin/unmapped     — the mint worklist: rows whose
 *                                                  stored type string has no key
 *                                                  ({events[], appts[], no_label:{…}}).
 *                                                  U9 narrowed it to rows with a
 *                                                  NON-BLANK label — see
 *                                                  listUnmapped for why.
 * GET    /api/calendar-types-admin/case-types   — DISTINCT cases.case_type + counts
 *                                                  (checkbox-group options)
 * GET    /api/calendar-types-admin/:type_key    — one row + refs
 * POST   /api/calendar-types-admin              — create { type_key, label, kind, … }
 * PUT    /api/calendar-types-admin/:type_key    — partial update (type_key never;
 *                                                  kind locked once referenced → 409)
 * DELETE /api/calendar-types-admin/:type_key    — hard delete at zero refs → else 409
 *                                                  (cascades the type's option rows)
 * POST   /api/calendar-types-admin/:type_key/adopt-unmapped  { raw_label }  (U9)
 *                                                — stamp this key onto the
 *                                                  unmapped rows carrying that
 *                                                  raw label; returns counts
 *
 * Picker OPTIONS (U2b; presentation rows under a kind=meeting type):
 * POST   /api/calendar-types-admin/:type_key/options — create { length, surfaces[], label?, sort_order?, active? }
 * PUT    /api/calendar-types-admin/options/:id       — partial update (same fields; type_key immutable)
 * DELETE /api/calendar-types-admin/options/:id       — hard delete (nothing references an option)
 *
 * Every write ends in calendarTypeService.invalidate() (inside the service) so
 * the 60s picker cache never serves a stale row after an admin edit.
 *
 * Envelope: { status:'success', ... } / { status:'error', message }. Service
 * throws carry `.status` (400 validation, 404 unknown row, 409 business rule:
 * immutable key, locked kind, referenced row, resolver collision); anything
 * else is a 500 with a generic message.
 *
 * AUTH: jwtOrApiKey — the house norm for admin surfaces (booking views, pages,
 * redirects, pipeline admin all match). No superuser gate: staff with shell
 * access ARE the audience for Case Config. Revisit if the shell grows roles.
 *
 * Auto-mounted from routes/ (server.js readdir loop). Distinct
 * /api/calendar-types-admin prefix; the read route is /api/calendar-types
 * (routes/api.calendarTypes.js). Static sub-paths (unmapped, case-types) are
 * declared BEFORE the :type_key param route so they can never be shadowed —
 * neither is a legal type_key anyway (the regex forbids '-'), but order makes
 * that a non-question.
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const svc = require('../services/calendarTypeAdminService');

function fail(res, tag, err) {
  const status = (typeof err.status === 'number' && err.status >= 400 && err.status < 600) ? err.status : 500;
  if (status >= 500) {
    console.error(`[api.calendarTypesAdmin] ${tag} error:`, err);
    return res.status(500).json({ status: 'error', message: 'Calendar type admin request failed' });
  }
  res.status(status).json({ status: 'error', message: err.message });
}

router.get('/api/calendar-types-admin', jwtOrApiKey, async (req, res) => {
  try {
    const types = await svc.listTypesAdmin(req.db);
    res.json({ status: 'success', types });
  } catch (err) { fail(res, 'list', err); }
});

router.get('/api/calendar-types-admin/unmapped', jwtOrApiKey, async (req, res) => {
  try {
    const data = await svc.listUnmapped(req.db);
    res.json({ status: 'success', ...data, total: data.events.length + data.appts.length });
  } catch (err) { fail(res, 'unmapped', err); }
});

router.get('/api/calendar-types-admin/case-types', jwtOrApiKey, async (req, res) => {
  try {
    const case_types = await svc.listCaseTypes(req.db);
    res.json({ status: 'success', case_types });
  } catch (err) { fail(res, 'caseTypes', err); }
});

router.get('/api/calendar-types-admin/:type_key', jwtOrApiKey, async (req, res) => {
  try {
    const type = await svc.getTypeAdmin(req.db, String(req.params.type_key));
    res.json({ status: 'success', type });
  } catch (err) { fail(res, 'get', err); }
});

router.post('/api/calendar-types-admin', jwtOrApiKey, async (req, res) => {
  try {
    const type = await svc.createType(req.db, req.body || {});
    res.status(201).json({ status: 'success', type });
  } catch (err) { fail(res, 'create', err); }
});

router.put('/api/calendar-types-admin/:type_key', jwtOrApiKey, async (req, res) => {
  try {
    const type = await svc.updateType(req.db, String(req.params.type_key), req.body || {});
    res.json({ status: 'success', type });
  } catch (err) { fail(res, 'update', err); }
});

router.delete('/api/calendar-types-admin/:type_key', jwtOrApiKey, async (req, res) => {
  try {
    const out = await svc.deleteType(req.db, String(req.params.type_key));
    res.json({ status: 'success', ...out });
  } catch (err) { fail(res, 'delete', err); }
});

// ── Adopt unmapped (U9) ──────────────────────────────────────────────────────
//
// POST /api/calendar-types-admin/:type_key/adopt-unmapped  { raw_label }
//
// Stamps this key onto every events/appts row that still carries `raw_label`
// as its raw type string and has no key yet. Declared alongside the options
// sub-paths, after the :type_key routes above — no shadowing either way, since
// those are GET/PUT/DELETE on the bare key and this is a POST on a sub-path.
//
// The only endpoint in this file that writes a table other than the registry.
// See services/calendarTypeAdminService.adoptUnmapped for why it pins
// events.event_updated_at and why it invalidates nothing.
router.post('/api/calendar-types-admin/:type_key/adopt-unmapped', jwtOrApiKey, async (req, res) => {
  try {
    const out = await svc.adoptUnmapped(req.db, String(req.params.type_key), (req.body || {}).raw_label);
    res.json({ status: 'success', ...out });
  } catch (err) { fail(res, 'adoptUnmapped', err); }
});

// ── Options ──────────────────────────────────────────────────────────────────

router.post('/api/calendar-types-admin/:type_key/options', jwtOrApiKey, async (req, res) => {
  try {
    const option = await svc.createOption(req.db, String(req.params.type_key), req.body || {});
    res.status(201).json({ status: 'success', option });
  } catch (err) { fail(res, 'createOption', err); }
});

router.put('/api/calendar-types-admin/options/:id', jwtOrApiKey, async (req, res) => {
  try {
    const option = await svc.updateOption(req.db, req.params.id, req.body || {});
    res.json({ status: 'success', option });
  } catch (err) { fail(res, 'updateOption', err); }
});

router.delete('/api/calendar-types-admin/options/:id', jwtOrApiKey, async (req, res) => {
  try {
    const out = await svc.deleteOption(req.db, req.params.id);
    res.json({ status: 'success', ...out });
  } catch (err) { fail(res, 'deleteOption', err); }
});

module.exports = router;
