// routes/api.shared.js
//
/**
 * Shared values API — staff-created namespaces of staff-written key/value
 * pairs (settings-access arc, 2026-10-28). The rules live in
 * services/sharedValuesService.js (read its header); this file is the HTTP
 * shape. NOT configuration — that is app_settings (routes/api.appSettings.js).
 *
 * AUTH: requireAuth({ audience:'staff' }) on every route — a staff JWT only.
 * No API keys (allowApiKey is off: a machine key gets 401), no portal tokens.
 * A read-only View-as session is refused on every write by the middleware
 * (lib/auth.impersonation); a live one writes as its target, and the human
 * behind it is stamped in updated_act.
 *
 *   GET    /api/shared                      namespaces + key counts
 *   POST   /api/shared                      create { ns, description?, write_mode?,
 *                                           max_value_bytes?, max_keys? } — any staff
 *   GET    /api/shared/:ns                  { namespace, values, next, limit, trimmed } — ?limit
 *                                           (1-1000, default 200) & ?after=<k> page by key; a page
 *                                           holds at most 8 MB of values (limit ≤ 8 MB / the
 *                                           namespace's max_value_bytes; trimmed = it was cut)
 *   PATCH  /api/shared/:ns                  { description?, write_mode?, max_value_bytes?,
 *                                           max_keys? } — its creator or firm.settings
 *   DELETE /api/shared/:ns                  the namespace and every value — creator or firm.settings
 *   GET    /api/shared/:ns/:k               { value: { ns, k, v, rev, updated_by, updated_act, … } }
 *   PUT    /api/shared/:ns/:k               { v: string, rev: null | n } — compare-and-set:
 *                                           rev null creates (409 code 'exists' when taken),
 *                                           rev n updates only from rev n (409 code
 *                                           'rev_conflict' with `current`)
 *   DELETE /api/shared/:ns/:k[?rev=n]       one key; ?rev makes it compare-and-delete
 *
 * Responses: { status:'success', … } | { status:'error', message, code?, current? }.
 * 400 bad input · 403 not allowed · 404 no such namespace / key · 409 conflict
 * (exists / rev_conflict / full) · 413 value over the namespace's size limit.
 *
 * Values are UNTRUSTED staff-written text: render with textContent only.
 */

'use strict';

const express = require('express');
const router = express.Router();
const requireAuth = require('../lib/auth.requireAuth');
const svc = require('../services/sharedValuesService');

const staff = requireAuth({ audience: 'staff' });

function send(res, label, err) {
  if (err && err.httpStatus) {
    const body = { status: 'error', message: err.message };
    if (err.code && typeof err.code === 'string' && !err.code.startsWith('ER_')) body.code = err.code;
    if (err.current !== undefined) body.current = err.current;
    return res.status(err.httpStatus).json(body);
  }
  console.error(`${label} error:`, err);
  return res.status(500).json({ status: 'error', message: 'Shared values request failed' });
}

router.get('/api/shared', staff, async (req, res) => {
  try {
    res.json({ status: 'success', namespaces: await svc.listNamespaces(req.db) });
  } catch (err) { send(res, 'GET /api/shared', err); }
});

router.post('/api/shared', staff, async (req, res) => {
  try {
    res.status(201).json({ status: 'success', namespace: await svc.createNamespace(req.db, req.body, req.auth) });
  } catch (err) { send(res, 'POST /api/shared', err); }
});

router.get('/api/shared/:ns', staff, async (req, res) => {
  try {
    const out = await svc.listValues(req.db, req.params.ns, { limit: req.query.limit, after: req.query.after });
    res.json({ status: 'success', ...out });
  } catch (err) { send(res, 'GET /api/shared/:ns', err); }
});

router.patch('/api/shared/:ns', staff, async (req, res) => {
  try {
    res.json({ status: 'success', namespace: await svc.updateNamespace(req.db, req.params.ns, req.body, req.auth) });
  } catch (err) { send(res, 'PATCH /api/shared/:ns', err); }
});

router.delete('/api/shared/:ns', staff, async (req, res) => {
  try {
    res.json({ status: 'success', ...(await svc.deleteNamespace(req.db, req.params.ns, req.auth)) });
  } catch (err) { send(res, 'DELETE /api/shared/:ns', err); }
});

router.get('/api/shared/:ns/:k', staff, async (req, res) => {
  try {
    res.json({ status: 'success', value: await svc.getValue(req.db, req.params.ns, req.params.k) });
  } catch (err) { send(res, 'GET /api/shared/:ns/:k', err); }
});

router.put('/api/shared/:ns/:k', staff, async (req, res) => {
  try {
    res.json({ status: 'success', value: await svc.putValue(req.db, req.params.ns, req.params.k, req.body, req.auth) });
  } catch (err) { send(res, 'PUT /api/shared/:ns/:k', err); }
});

router.delete('/api/shared/:ns/:k', staff, async (req, res) => {
  try {
    res.json({ status: 'success', ...(await svc.deleteValue(req.db, req.params.ns, req.params.k, req.query.rev, req.auth)) });
  } catch (err) { send(res, 'DELETE /api/shared/:ns/:k', err); }
});

module.exports = router;
