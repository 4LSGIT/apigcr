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
const metaService          = require('../services/phoneIngestMetaService');


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
// META
// ─────────────────────────────────────────────────────────────

router.get('/api/phone-ingest/meta', jwtOrApiKey, async (req, res) => {
  try {
    // Returned FLAT (not wrapped under {status, meta}) to match
    // /api/email-ingest/meta — the phone UI is copied from the email UI and
    // expects the meta object at the top level. getMeta() is synchronous (no
    // target-list queries, unlike email's).
    res.json(metaService.getMeta());
  } catch (err) {
    console.error('[phone-ingest] meta error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


module.exports = router;