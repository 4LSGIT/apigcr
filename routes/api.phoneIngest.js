// routes/api.phoneIngest.js
//
/**
 * Phone Ingest — Management API (Stage 1)
 * routes/api.phoneIngest.js
 *
 * Suppression CRUD + meta for the phone log-suppression layer. Auto-mounted by
 * the routes/ loader (dropping this file in wires it; no server.js edit).
 *
 * Mirrors the management half of routes/api.emailIngest.js. There is NO public
 * receiver route here — phone events arrive via YisraHooks → workflows →
 * phone_log (lib/internal_functions.js), not over HTTP. This file is
 * management-only.
 *
 * All endpoints gated by jwtOrApiKey (same as api.hooks.js / api.emailIngest.js).
 * Writes emit an admin_audit_log row via auditAdminAction. tool = 'phone_ingest'.
 * last_modified_by is set server-side from req.auth.userId in the service.
 *
 * Validation errors thrown by the service (ValidationError, carrying a
 * .validationErrors array) are translated to a structured 400 here. The
 * service reuses emailIngestValidator.validateSuppression (table-agnostic).
 */

const express = require('express');
const router  = express.Router();

const jwtOrApiKey          = require('../lib/auth.jwtOrApiKey');
const { auditAdminAction } = require('../lib/auth.superuser');
const suppressionService   = require('../services/phoneIngestSuppressionService');
const ruleService          = require('../services/phoneIngestRuleService');
const executionsService    = require('../services/phoneIngestExecutionsService');
const metaService          = require('../services/phoneIngestMetaService');
const sampleService        = require('../services/phoneIngestSampleService');


// ─────────────────────────────────────────────────────────────
// AUDIT + VALIDATION HELPERS (parallel to api.emailIngest.js)
// ─────────────────────────────────────────────────────────────

const PI_TOOL = 'phone_ingest';

function _reqMeta(req) {
  return {
    ip:        req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
  };
}

function auditPI(req, { status = 'success', errorMessage, details }) {
  const meta = _reqMeta(req);
  return auditAdminAction(req.db, {
    tool:     PI_TOOL,
    userId:   req.auth?.userId,
    username: req.auth?.username,
    route:    req.originalUrl,
    method:   req.method,
    status,
    ...(errorMessage ? { errorMessage } : {}),
    ...meta,
    details: details || {},
  }).catch((err) => console.error('[phone-ingest] audit log failed:', err.message));
}

// Translate a thrown ValidationError into the structured 400 body. Returns
// true if it handled the error (response sent), false otherwise.
function _handleValidationError(err, res) {
  if (err && err.name === 'ValidationError' && Array.isArray(err.validationErrors)) {
    const errs = err.validationErrors;
    if (errs.length === 1) {
      res.status(400).json({
        error:   'validation_failed',
        field:   errs[0].field,
        message: errs[0].message,
      });
    } else {
      res.status(400).json({ error: 'validation_failed', errors: errs });
    }
    return true;
  }
  return false;
}


// ─────────────────────────────────────────────────────────────
// SUPPRESSIONS
// ─────────────────────────────────────────────────────────────

router.get('/api/phone-ingest/suppressions', jwtOrApiKey, async (req, res) => {
  try {
    const suppressions = await suppressionService.listAll(req.db);
    res.json({ status: 'success', suppressions });
  } catch (err) {
    console.error('[phone-ingest] list suppressions error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/api/phone-ingest/suppressions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const row = await suppressionService.getById(req.db, req.params.id);
    if (!row) return res.status(404).json({ status: 'error', message: 'Suppression not found' });
    res.json({ status: 'success', suppression: row });
  } catch (err) {
    console.error('[phone-ingest] get suppression error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/api/phone-ingest/suppressions', jwtOrApiKey, async (req, res) => {
  try {
    const row = await suppressionService.create(req.db, req.body, req.auth.userId);
    auditPI(req, { details: { entity: 'suppression', entity_id: row.id, after: row } });
    res.status(201).json({ status: 'success', suppression: row });
  } catch (err) {
    if (_handleValidationError(err, res)) return;
    console.error('[phone-ingest] create suppression error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.put('/api/phone-ingest/suppressions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const before = await suppressionService.getById(req.db, req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Suppression not found' });

    const after = await suppressionService.update(req.db, req.params.id, req.body, req.auth.userId);
    auditPI(req, { details: { entity: 'suppression', entity_id: Number(req.params.id), before, after } });
    res.json({ status: 'success', suppression: after });
  } catch (err) {
    if (_handleValidationError(err, res)) return;
    console.error('[phone-ingest] update suppression error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/api/phone-ingest/suppressions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const before = await suppressionService.getById(req.db, req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Suppression not found' });

    await suppressionService.remove(req.db, req.params.id);
    auditPI(req, { details: { entity: 'suppression', entity_id: Number(req.params.id), before } });
    res.status(204).end();
  } catch (err) {
    console.error('[phone-ingest] delete suppression error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// RULES
// ─────────────────────────────────────────────────────────────

router.get('/api/phone-ingest/rules', jwtOrApiKey, async (req, res) => {
  try {
    const rules = await ruleService.listAll(req.db);
    res.json({ status: 'success', rules });
  } catch (err) {
    console.error('[phone-ingest] list rules error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/api/phone-ingest/rules/:id', jwtOrApiKey, async (req, res) => {
  try {
    const rule = await ruleService.getById(req.db, req.params.id);
    if (!rule) return res.status(404).json({ status: 'error', message: 'Rule not found' });
    res.json({ status: 'success', rule });
  } catch (err) {
    console.error('[phone-ingest] get rule error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/api/phone-ingest/rules', jwtOrApiKey, async (req, res) => {
  try {
    const rule = await ruleService.createRule(req.db, req.body, req.auth.userId);
    auditPI(req, { details: { entity: 'rule', entity_id: rule.id, after: rule } });
    res.status(201).json({ status: 'success', rule });
  } catch (err) {
    if (_handleValidationError(err, res)) return;
    console.error('[phone-ingest] create rule error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.put('/api/phone-ingest/rules/:id', jwtOrApiKey, async (req, res) => {
  try {
    const before = await ruleService.getById(req.db, req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Rule not found' });

    const after = await ruleService.updateRule(req.db, req.params.id, req.body, req.auth.userId);
    auditPI(req, { details: { entity: 'rule', entity_id: Number(req.params.id), before, after } });
    res.json({ status: 'success', rule: after });
  } catch (err) {
    if (_handleValidationError(err, res)) return;
    console.error('[phone-ingest] update rule error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/api/phone-ingest/rules/:id', jwtOrApiKey, async (req, res) => {
  try {
    const before = await ruleService.getById(req.db, req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Rule not found' });

    await ruleService.deleteRule(req.db, req.params.id);
    auditPI(req, { details: { entity: 'rule', entity_id: Number(req.params.id), before } });
    res.status(204).end();
  } catch (err) {
    console.error('[phone-ingest] delete rule error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// RULE ACTIONS
// ─────────────────────────────────────────────────────────────

router.post('/api/phone-ingest/rules/:id/actions', jwtOrApiKey, async (req, res) => {
  try {
    const action = await ruleService.addAction(req.db, req.params.id, req.body);
    if (action === null) return res.status(404).json({ status: 'error', message: 'Rule not found' });
    auditPI(req, { details: { entity: 'rule_action', entity_id: action.id, rule_id: Number(req.params.id), after: action } });
    res.status(201).json({ status: 'success', action });
  } catch (err) {
    if (_handleValidationError(err, res)) return;
    console.error('[phone-ingest] add action error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.put('/api/phone-ingest/rule-actions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const before = await ruleService.getActionById(req.db, req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Action not found' });

    const after = await ruleService.updateAction(req.db, req.params.id, req.body);
    auditPI(req, { details: { entity: 'rule_action', entity_id: Number(req.params.id), before, after } });
    res.json({ status: 'success', action: after });
  } catch (err) {
    if (_handleValidationError(err, res)) return;
    console.error('[phone-ingest] update action error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/api/phone-ingest/rule-actions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const before = await ruleService.getActionById(req.db, req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Action not found' });

    await ruleService.deleteAction(req.db, req.params.id);
    auditPI(req, { details: { entity: 'rule_action', entity_id: Number(req.params.id), before } });
    res.status(204).end();
  } catch (err) {
    console.error('[phone-ingest] delete action error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// EXECUTIONS (read-only)
//
// Phone-specific: NO `source` filter (phone has no sources table — events
// arrive via YisraHooks→workflows, not multi-source HTTP receivers). Otherwise
// identical to the email executions endpoints, including the flat list shape
// and the flat {execution, linked} detail shape.
// ─────────────────────────────────────────────────────────────

router.get('/api/phone-ingest/executions', jwtOrApiKey, async (req, res) => {
  try {
    const hasMatch = req.query.has_match === 'true' ? true
                   : req.query.has_match === 'false' ? false
                   : undefined;
    const { rows, total, page, page_size } = await executionsService.list(req.db, {
      page:      req.query.page,
      page_size: req.query.page_size,
      status:    req.query.status,
      since:     req.query.since,
      until:     req.query.until,
      has_match: hasMatch,
    });
    res.json({ executions: rows, page, page_size, total });
  } catch (err) {
    console.error('[phone-ingest] list executions error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/api/phone-ingest/executions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const result = await executionsService.getById(req.db, req.params.id);
    if (!result) return res.status(404).json({ status: 'error', message: 'Execution not found' });
    res.json(result); // { execution, linked }
  } catch (err) {
    console.error('[phone-ingest] get execution error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// META
// ─────────────────────────────────────────────────────────────

router.get('/api/phone-ingest/meta', jwtOrApiKey, async (req, res) => {
  try {
    // Returned FLAT (not wrapped under {status, meta}) to match
    // /api/email-ingest/meta — the phone UI is copied from the email UI and
    // expects the meta object at the top level. getMeta(db) is async (it now
    // queries the live target lists for the L3 action builder, mirroring email).
    const meta = await metaService.getMeta(req.db);
    res.json(meta);
  } catch (err) {
    console.error('[phone-ingest] meta error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// SAMPLE EVENTS (read-only, UI field-discovery aid)
//
// Returns the newest-N captured phone events (across all types), each PROJECTED
// to the match-field catalog — newest first, so the rule / suppression editor
// can let operators page through real events and see shape variation (e.g.
// data.duration_seconds present on some calls, absent on others). No value
// redaction; the projection is limited to catalog paths for correctness, not
// privacy. See services/phoneIngestSampleService.js + lib/ingestSampleProjection.js.
// ─────────────────────────────────────────────────────────────

router.get('/api/phone-ingest/sample-events', jwtOrApiKey, async (req, res) => {
  try {
    const result = await sampleService.getSampleEvents(req.db);
    res.json(result); // { samples: [{ exec_id, type, ts, label, fields:[...] }] }
  } catch (err) {
    console.error('[phone-ingest] sample-events error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


module.exports = router;