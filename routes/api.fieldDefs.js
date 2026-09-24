// routes/api.fieldDefs.js
//
/**
 * Custom-field definitions API (custom-fields arc S1; audit + reconcile S3)
 * routes/api.fieldDefs.js
 *
 * Backs the settings.html "Custom Fields" editor. Logic, validation and the
 * cache live in services/fieldDefService.js; this file is the HTTP mapper.
 *
 *   GET  /api/field-defs?entity=case|contact    every def incl. inactive (editor list)
 *   POST /api/field-defs                        create { entity, field_key, label,
 *                                               field_type, options?, validation?,
 *                                               show_when?, sort_order?, active? }
 *   PATCH /api/field-defs/:id                   label / field_type / options /
 *                                               validation / show_when / sort_order
 *                                               (entity + field_key IMMUTABLE → 400)
 *   POST /api/field-defs/:id/deactivate         active = 0 — retirement
 *   POST /api/field-defs/:id/reactivate         active = 1
 *   POST /api/field-defs/reconcile              run the column reconciler now
 *                                               { dry_run? } → { result: plan … }
 *   (no DELETE — the Contact Roles type editor this clones offers none, and a
 *    def's key may already have data under it from S2 on; deactivate instead)
 *
 * AUTH: jwtOrApiKey on every route — identical to /api/contact-role-types,
 * the editor this one is cloned from (no superuser gate).
 *
 * AUDIT (S3): every successful mutation writes an admin_audit_log row
 * (tool 'field_defs') — fire-and-forget, an audit failure never breaks the
 * request (api.formTemplates posture). Mutations acquired DDL side effects in
 * S3 (create / deactivate / reactivate / a field_type change reconcile the
 * cf_ columns, services/fieldDefReconciler.js), which is why the roles
 * editor's no-audit parity stopped being the bar. The reconcile that follows
 * writes its OWN row when it runs DDL, carrying the same actor.
 *
 * Envelope: { status:'success', ... } / { status:'error', message }. Service
 * throws carry `.status` (400 validation / immutable, 404 unknown id, 409
 * duplicate key); anything else is a 500 with a generic message — never raw
 * DB text.
 *
 * Auto-mounted from routes/ (server.js readdir loop).
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const svc = require('../services/fieldDefService');
const reconciler = require('../services/fieldDefReconciler');
const { auditAdminAction } = require('../lib/auth.superuser');

const TOOL = 'field_defs';   // admin_audit_log tag

/** Who / where, for this request's audit row and the reconcile it triggers. */
function actorOf(req) {
  return {
    userId:    req.auth?.userId ?? null,
    username:  req.auth?.username ?? (req.auth?.key_label ? `api_key:${req.auth.key_label}` : null),
    route:     req.originalUrl,
    method:    req.method,
    ip:        req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
  };
}

function audit(req, action, details) {
  auditAdminAction(req.db, { tool: TOOL, ...actorOf(req), status: 'success', details: { action, ...details } })
    .catch(err => console.error('[api.fieldDefs] audit log failed:', err.message));
}

function fail(res, tag, err) {
  const status = (typeof err.status === 'number' && err.status >= 400 && err.status < 600) ? err.status : 500;
  if (status >= 500) {
    console.error(`[api.fieldDefs] ${tag} error:`, err);
    return res.status(500).json({ status: 'error', message: 'Field definition request failed' });
  }
  res.status(status).json({ status: 'error', message: err.message });
}

// ─── GET /api/field-defs?entity= ───
router.get('/api/field-defs', jwtOrApiKey, async (req, res) => {
  try {
    const defs = await svc.listAll(req.db, req.query.entity);
    res.json({ status: 'success', defs });
  } catch (err) { fail(res, 'list', err); }
});

// ─── POST /api/field-defs ───
router.post('/api/field-defs', jwtOrApiKey, async (req, res) => {
  try {
    const result = await svc.createDef(req.db, req.body || {}, { actor: actorOf(req) });
    audit(req, 'create', { ...result, body: req.body || {} });
    res.status(201).json({ status: 'success', ...result });
  } catch (err) { fail(res, 'create', err); }
});

// ─── PATCH /api/field-defs/:id ───
router.patch('/api/field-defs/:id', jwtOrApiKey, async (req, res) => {
  try {
    const result = await svc.updateDef(req.db, req.params.id, req.body || {}, { actor: actorOf(req) });
    audit(req, 'update', { ...result, patch: req.body || {} });
    res.json({ status: 'success', ...result });
  } catch (err) { fail(res, 'update', err); }
});

// ─── POST /api/field-defs/:id/deactivate ───
router.post('/api/field-defs/:id/deactivate', jwtOrApiKey, async (req, res) => {
  try {
    const result = await svc.setActive(req.db, req.params.id, false, { actor: actorOf(req) });
    audit(req, 'deactivate', result);
    res.json({ status: 'success', ...result });
  } catch (err) { fail(res, 'deactivate', err); }
});

// ─── POST /api/field-defs/:id/reactivate ───
router.post('/api/field-defs/:id/reactivate', jwtOrApiKey, async (req, res) => {
  try {
    const result = await svc.setActive(req.db, req.params.id, true, { actor: actorOf(req) });
    audit(req, 'reactivate', result);
    res.json({ status: 'success', ...result });
  } catch (err) { fail(res, 'reactivate', err); }
});

// ─── POST /api/field-defs/reconcile ───
// Awaited (unlike the post-mutation runs): the caller gets the plan it caused.
// 200 ok / noop / dry_run · 409 lock still busy after the reconciler's retry ·
// 500 a statement failed — `result.failed` carries the statement and MySQL's
// error code; the full engine message goes to the system alert, not here.
router.post('/api/field-defs/reconcile', jwtOrApiKey, async (req, res) => {
  try {
    const result = await reconciler.reconcile(req.db, {
      trigger: 'manual', actor: actorOf(req), dryRun: !!(req.body && req.body.dry_run),
    });
    const shown = result.failed
      ? { ...result, failed: { sql: result.failed.sql, code: result.failed.code, errno: result.failed.errno } }
      : result;
    if (result.status === 'locked') {
      return res.status(409).json({ status: 'error', message: 'Another reconcile is running — try again shortly', result: shown });
    }
    if (result.status === 'failed') {
      return res.status(500).json({ status: 'error', message: 'Reconcile failed — see the system alert', result: shown });
    }
    res.json({ status: 'success', result: shown });
  } catch (err) { fail(res, 'reconcile', err); }
});

module.exports = router;
