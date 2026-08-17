// routes/api.triggers.js
//
/**
 * routes/api.triggers.js — REST routes for the Trigger System (Slice T1)
 *
 * GET    /api/triggers/events                — event-type registry (+ field catalogs)
 * GET    /api/triggers/rules?event_type=     — list rules (actions nested)
 * GET    /api/triggers/rules/:id             — one rule (actions nested)
 * POST   /api/triggers/rules                 — create { event_type, name, …, actions?: [] }
 * PUT    /api/triggers/rules/:id             — partial update; `actions` array (if present) REPLACES the set
 * DELETE /api/triggers/rules/:id             — hard delete rule + actions
 * GET    /api/triggers/executions            — list (?event_type&status&case_id&contact_id&limit&before_id)
 * GET    /api/triggers/executions/:id        — full row (envelope + outcomes)
 * GET    /api/triggers/samples/:event_type   — recent envelopes for the field-discovery panel (?limit)
 * POST   /api/triggers/test                  — dry run { event_type, envelope? | payload? } → match/transform report; NOTHING dispatches
 *
 * Auto-mounted from routes/ (server.js readdir loop). Auth + envelope match
 * routes/api.pipelineAdmin.js: jwtOrApiKey on every route;
 * { status:'success', ... } / { status:'error', message }; service throws
 * carry `.status` (400 validation, 404 unknown row), anything else 500.
 */

'use strict';

const express = require('express');
const router  = express.Router();

const jwtOrApiKey    = require('../lib/auth.jwtOrApiKey');
const triggerService = require('../services/triggerService');
const domainEvents   = require('../lib/domainEvents');

function fail(res, err) {
  const status = err.status || 500;
  if (status === 500) console.error('[api.triggers]', err);
  res.status(status).json({ status: 'error', message: err.message });
}

function actingUserId(req) {
  // jwtOrApiKey sets req.auth = { type, userId, … } for JWT callers;
  // API-key callers carry no user identity → null.
  const uid = req.auth && req.auth.type === 'jwt' ? req.auth.userId : null;
  const n = parseInt(uid, 10);
  return Number.isFinite(n) ? n : null;
}

// ── Registry ─────────────────────────────────────────────────

router.get('/api/triggers/events', jwtOrApiKey, (req, res) => {
  res.json({ status: 'success', events: triggerService.EVENT_TYPES });
});

// ── Meta (T2 UI) ─────────────────────────────────────────────
//
// One payload for the triggers tab: event registry + operators + action-type
// schema hints + live target lists (workflows / sequences / hooks /
// internal_functions + meta / credentials). Operators, action_types and
// targets are REUSED from emailIngestMetaService.getMeta — one source of
// truth for the shared automation vocabulary; the email-specific parts of
// that payload (match_fields, execution_statuses) are simply not forwarded.

router.get('/api/triggers/meta', jwtOrApiKey, async (req, res) => {
  try {
    const ingestMeta = await require('../services/emailIngestMetaService').getMeta(req.db);
    res.json({
      status:          'success',
      events:          triggerService.EVENT_TYPES,
      match_operators: ingestMeta.match_operators,
      action_types:    ingestMeta.action_types,
      targets:         ingestMeta.targets,
      transform_modes: ['passthrough', 'mapper', 'code'],
      execution_statuses: ['matched', 'no_match', 'no_rules', 'depth_capped', 'error'],
    });
  } catch (err) { fail(res, err); }
});

// ── Rules CRUD ───────────────────────────────────────────────

router.get('/api/triggers/rules', jwtOrApiKey, async (req, res) => {
  try {
    const rules = await triggerService.listRules(req.db, {
      event_type: req.query.event_type || null,
    });
    res.json({ status: 'success', rules });
  } catch (err) { fail(res, err); }
});

router.get('/api/triggers/rules/:id', jwtOrApiKey, async (req, res) => {
  try {
    const rule = await triggerService.getRule(req.db, req.params.id);
    res.json({ status: 'success', rule });
  } catch (err) { fail(res, err); }
});

router.post('/api/triggers/rules', jwtOrApiKey, async (req, res) => {
  try {
    const rule = await triggerService.createRule(req.db, req.body || {}, {
      userId: actingUserId(req),
    });
    res.json({ status: 'success', rule });
  } catch (err) { fail(res, err); }
});

router.put('/api/triggers/rules/:id', jwtOrApiKey, async (req, res) => {
  try {
    const rule = await triggerService.updateRule(req.db, req.params.id, req.body || {}, {
      userId: actingUserId(req),
    });
    res.json({ status: 'success', rule });
  } catch (err) { fail(res, err); }
});

router.delete('/api/triggers/rules/:id', jwtOrApiKey, async (req, res) => {
  try {
    const out = await triggerService.deleteRule(req.db, req.params.id);
    res.json({ status: 'success', ...out });
  } catch (err) { fail(res, err); }
});

// ── Executions ───────────────────────────────────────────────

router.get('/api/triggers/executions', jwtOrApiKey, async (req, res) => {
  try {
    const rows = await triggerService.listExecutions(req.db, {
      event_type: req.query.event_type || null,
      status:     req.query.status || null,
      case_id:    req.query.case_id || null,
      contact_id: req.query.contact_id ? parseInt(req.query.contact_id, 10) : null,
      limit:      req.query.limit,
      before_id:  req.query.before_id ? parseInt(req.query.before_id, 10) : null,
    });
    res.json({ status: 'success', executions: rows });
  } catch (err) { fail(res, err); }
});

router.get('/api/triggers/executions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const row = await triggerService.getExecution(req.db, req.params.id);
    res.json({ status: 'success', execution: row });
  } catch (err) { fail(res, err); }
});

router.get('/api/triggers/samples/:event_type', jwtOrApiKey, async (req, res) => {
  try {
    const rows = await triggerService.listRecentEnvelopes(req.db, req.params.event_type, {
      limit: req.query.limit,
    });
    res.json({ status: 'success', samples: rows });
  } catch (err) { fail(res, err); }
});

// ── Dry run ──────────────────────────────────────────────────
//
// Body: { event_type, envelope } — envelope is a FULL envelope (e.g. pasted
// from an execution row), OR { event_type, payload } — a bare payload
// ({data, extra, contact_id, ...}) that gets wrapped by the real envelope
// builder. Match + transform only; no actions fire, no rows are written.

router.post('/api/triggers/test', jwtOrApiKey, async (req, res) => {
  try {
    const { event_type, envelope, payload } = req.body || {};
    if (!event_type || !triggerService.EVENT_TYPES[event_type]) {
      const e = new Error(
        `event_type must be one of: ${Object.keys(triggerService.EVENT_TYPES).join(', ')}`
      );
      e.status = 400;
      throw e;
    }
    const env = (envelope && typeof envelope === 'object')
      ? { ...envelope, event: event_type }
      : domainEvents.buildEnvelope(event_type, payload || {});
    const out = await triggerService.evaluateDryRun(req.db, env);
    res.json({ status: 'success', envelope: env, ...out });
  } catch (err) { fail(res, err); }
});

module.exports = router;
