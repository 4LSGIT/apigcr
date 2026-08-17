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
 * POST   /api/triggers/test-draft            — evaluate an UNSAVED match/transform config vs one envelope ({ envelope | execution_id, match_mode, match_config, transform_mode, transform_config }); NOTHING dispatches
 * POST   /api/triggers/replay                — LIVE re-processing of a RECORDED envelope ({ execution_id } only); actions DO dispatch, a new execution row is written
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
    // Review S17c: validate like /test does — arbitrary strings just probe.
    if (!triggerService.EVENT_TYPES[req.params.event_type]) {
      const e = new Error(`unknown event_type '${req.params.event_type}'`);
      e.status = 400; throw e;
    }
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

// ── Draft test (T2 round 2) ──────────────────────────────────
//
// Evaluates an UNSAVED editor state (match + transform only) against one
// envelope — pasted or loaded from an execution row. Ingest test-match
// precedent. Nothing dispatches, nothing is written.

router.post('/api/triggers/test-draft', jwtOrApiKey, async (req, res) => {
  try {
    const { envelope, execution_id, match_mode, match_config, transform_mode, transform_config } = req.body || {};
    let env = (envelope && typeof envelope === 'object') ? envelope : null;
    if (!env && execution_id) {
      const row = await triggerService.getExecution(req.db, execution_id);
      env = typeof row.envelope === 'string' ? JSON.parse(row.envelope) : row.envelope;
    }
    if (!env || typeof env !== 'object') {
      const e = new Error('test-draft requires envelope or execution_id');
      e.status = 400; throw e;
    }
    const result = triggerService.evaluateDraft(
      { match_mode, match_config, transform_mode, transform_config }, env
    );
    res.json({ status: 'success', result, envelope: env });
  } catch (err) { fail(res, err); }
});

// ── Live replay (T2 round 2; locked down round 3 per Review S10) ────
//
// Runs a RECORDED envelope through the full engine — saved active rules,
// real action dispatch, a new trigger_executions row. The UI confirms
// before calling.
//
// execution_id ONLY. The raw-envelope form was removed: it let any staff
// JWT/API key synthesise e.g. a case.stage_advanced for an arbitrary
// case_id and drive its rules while bypassing the real mutation route's
// authorisation. Replaying a recorded envelope is the actual use case, and
// a recorded envelope cannot be forged. Chain scope resets (depth 0, empty
// chain): a replay is a fresh manual invocation. Provenance is tagged into
// extra.replayed_from / replayed_at, and the loaded event is validated
// against the registry defensively.

router.post('/api/triggers/replay', jwtOrApiKey, async (req, res) => {
  try {
    const { execution_id } = req.body || {};
    if (!execution_id) {
      const e = new Error('replay requires execution_id (raw envelopes are not accepted)');
      e.status = 400; throw e;
    }
    const row = await triggerService.getExecution(req.db, execution_id);
    const env = typeof row.envelope === 'string' ? JSON.parse(row.envelope) : row.envelope;
    if (!env || !env.event || !triggerService.EVENT_TYPES[env.event]) {
      const e = new Error('recorded envelope is missing or carries an unknown event');
      e.status = 400; throw e;
    }
    env.depth = 0;
    env.chain = [];
    env.extra = { ...(env.extra || {}), replayed_from: row.id, replayed_at: new Date().toISOString() };
    const out = await triggerService.processEvent(req.db, env);
    res.json({ status: 'success', ...out });
  } catch (err) { fail(res, err); }
});

module.exports = router;