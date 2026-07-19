// routes/api.esign.templates.js
//
/**
 * E-Sign TEMPLATE API — CRUD, preview, and the template send branch.
 * routes/api.esign.templates.js
 *
 * Phase 2B.
 *
 *   GET  /api/esign/templates                 list (no bodies)
 *   GET  /api/esign/templates/:id             one, full
 *   POST /api/esign/templates                 create
 *   PUT  /api/esign/templates/:id             update (partial)
 *   POST /api/esign/templates/:id/deactivate  soft off (never DELETE)
 *   POST /api/esign/templates/:id/preview     resolve+render → application/pdf
 *   POST /api/esign/send-from-template        the real thing
 *
 * ── ROUTE ORDER ─────────────────────────────────────────────────────────────
 * routes/ auto-mounts alphabetically, so api.esign.actions.js registers first.
 * Its GET /api/esign/:id is digit-constrained (2B edit) precisely so
 * /api/esign/templates falls through to this router. Nothing here shadows
 * anything there: every other actions path is either literal or 3+ segments.
 *
 * ── AUTH / TRANSPORT ────────────────────────────────────────────────────────
 * Every route: jwtOrApiKey, JSON bodies only. No multipart — no file ever
 * arrives here; the whole point of the template branch is that the PDF is
 * MANUFACTURED. Template bodies fit comfortably under the global 10mb
 * express.json ceiling (a big HTML contract is ~100KB), so no parser games.
 *
 * ── SNAKE ↔ CAMEL ───────────────────────────────────────────────────────────
 * The wire is snake_case (repo API convention); services take camelCase.
 * Mapped here, once, at the boundary.
 */

const express     = require('express');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

const esignTemplateService = require('../services/esignTemplateService');
const esignPrefillService  = require('../services/esignPrefillService');
const esignSendService     = require('../services/esignSendService');

// The 2A router's code→status map is the baseline; only 2B's new codes are
// added here. One source of truth for the shared codes.
const { _errorToStatus: actionsErrorToStatus, _resolveCreatedBy } =
  require('./api.esign.actions');

const router = express.Router();

// ─── helpers ─────────────────────────────────────────────────

function errorToStatus(code) {
  switch (code) {
    case 'ESIGN_BAD_TEMPLATE':
    case 'ESIGN_BAD_PREFILL_SCHEMA':
    case 'ESIGN_BAD_RESOLVER':
    case 'ESIGN_UNDECLARED_PLACEHOLDER':
    case 'ESIGN_MISSING_PREFILL':
    case 'ESIGN_RENDER_EXTERNAL_REF':
      return 400;
    case 'ESIGN_TEMPLATE_INACTIVE':
      return 409;
    // Render machinery: the caller's request was fine; the box is not.
    case 'ESIGN_RENDER_NO_BROWSER':
    case 'ESIGN_RENDER_FAILED':
      return 502;
    default:
      return actionsErrorToStatus(code);
  }
}

/** Mirror of the actions router's fail(): status mapping, no stack leakage. */
function fail(res, err, route) {
  const status = errorToStatus(err && err.code);
  if (status >= 500) {
    console.error(`[ESIGN TEMPLATES API] ${route} failed:`, err && err.stack ? err.stack : err);
  } else {
    console.warn(`[ESIGN TEMPLATES API] ${route} → ${status} ${err && err.code}: ${err && err.message}`);
  }
  const body = {
    error: status >= 500 && !(err && err.code)
      ? 'Something went wrong handling this request.'
      : (err && err.message) || 'Request failed.',
    code: (err && err.code) || 'ESIGN_ERROR',
  };
  if (err && err.missing) body.missing = err.missing;
  return res.status(status).json(body);
}

function asInt(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function parseBool(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  return false;
}

/** Wire (snake) → service (camel) for a template body. Absent keys stay absent. */
function templateInputFromBody(body) {
  const b = body || {};
  const out = {};
  const map = {
    name:            'name',
    kind:            'kind',
    body:            'body',
    prefill_schema:  'prefillSchema',
    placement_json:  'placementJson',
    expiration_days: 'expirationDays',
    reminders_off:   'remindersOff',
    reminder_seq_id: 'reminderSeqId',
    static_body:     'staticBody',
  };
  for (const [wire, svc] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(b, wire)) out[svc] = b[wire];
  }
  return out;
}

// ─── GET /api/esign/templates ────────────────────────────────

router.get('/api/esign/templates', jwtOrApiKey, async (req, res) => {
  try {
    const templates = await esignTemplateService.listTemplates(req.db, {
      // ?all=1 → include inactive (the manager view); default is picker-shaped.
      activeOnly: !parseBool(req.query.all),
    });
    return res.json({ templates });
  } catch (err) {
    return fail(res, err, 'GET /api/esign/templates');
  }
});

// ─── GET /api/esign/templates/:id ────────────────────────────

router.get('/api/esign/templates/:id', jwtOrApiKey, async (req, res) => {
  try {
    const template = await esignTemplateService.getTemplate(req.db, asInt(req.params.id));
    if (!template) {
      return res.status(404).json({ error: `Template ${req.params.id} not found.`, code: 'ESIGN_NOT_FOUND' });
    }
    return res.json({ template });
  } catch (err) {
    return fail(res, err, 'GET /api/esign/templates/:id');
  }
});

// ─── POST /api/esign/templates ───────────────────────────────

router.post('/api/esign/templates', jwtOrApiKey, async (req, res) => {
  try {
    const out = await esignTemplateService.createTemplate(
      req.db,
      templateInputFromBody(req.body),
      esignPrefillService.RESOLVER_NAMES
    );
    return res.status(201).json({ template: out.template, warnings: out.warnings });
  } catch (err) {
    return fail(res, err, 'POST /api/esign/templates');
  }
});

// ─── PUT /api/esign/templates/:id ────────────────────────────

router.put('/api/esign/templates/:id', jwtOrApiKey, async (req, res) => {
  try {
    const out = await esignTemplateService.updateTemplate(
      req.db,
      asInt(req.params.id),
      templateInputFromBody(req.body),
      esignPrefillService.RESOLVER_NAMES
    );
    return res.json({ template: out.template, warnings: out.warnings });
  } catch (err) {
    return fail(res, err, 'PUT /api/esign/templates/:id');
  }
});

// ─── POST /api/esign/templates/:id/deactivate ────────────────

router.post('/api/esign/templates/:id/deactivate', jwtOrApiKey, async (req, res) => {
  try {
    const template = await esignTemplateService.deactivateTemplate(req.db, asInt(req.params.id));
    return res.json({ template });
  } catch (err) {
    return fail(res, err, 'POST /api/esign/templates/:id/deactivate');
  }
});

// ─── POST /api/esign/templates/:id/preview ───────────────────
//
// Resolves + interpolates + renders, responds application/pdf INLINE. Creates
// no rows, calls no provider, spends no credits — previewFromTemplate touches
// nothing but the template, the prefill resolvers, and chromium. With no
// linkable, resolvers are skipped (authoring-time preview: defaults + supplied
// values only). The X-Esign-Missing header carries the still-empty keys so a
// UI can show "3 blanks" next to the rendered document.

router.post('/api/esign/templates/:id/preview', jwtOrApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    const out = await esignSendService.previewFromTemplate(req.db, {
      templateId:   asInt(req.params.id),
      linkableType: body.linkable_type || null,
      linkableId:   body.linkable_id != null ? body.linkable_id : null,
      values:       body.values || null,
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="template-${out.template.id}-preview.pdf"`,
      'X-Esign-Missing': out.missing.join(','),
    });
    return res.send(out.pdfBuffer);
  } catch (err) {
    return fail(res, err, 'POST /api/esign/templates/:id/preview');
  }
});

// ─── POST /api/esign/send-from-template ──────────────────────
//
// JSON only — no file part, because there is no file: the PDF is manufactured
// from the template. Response shape mirrors POST /api/esign/send so the UI's
// send-result handling is one code path.

router.post('/api/esign/send-from-template', jwtOrApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    const out = await esignSendService.sendFromTemplate(req.db, {
      templateId:     asInt(body.template_id),
      linkableType:   body.linkable_type,
      linkableId:     body.linkable_id,
      values:         body.values || null,
      recipients:     body.recipients,
      documentName:   body.document_name || null,
      expirationDays: asInt(body.expiration_days),
      createdBy:      _resolveCreatedBy(req),
    });

    return res.status(201).json({
      status:  'sent',
      testing: out.testing,
      request: {
        id:            out.row.id,
        tracking_id:   out.row.tracking_id,
        status:        out.row.status,
        document_name: out.row.document_name,
        sent_at:       out.row.sent_at,
        expires_at:    out.row.expires_at,
      },
    });
  } catch (err) {
    return fail(res, err, 'POST /api/esign/send-from-template');
  }
});

module.exports = router;
module.exports._errorToStatus = errorToStatus;
