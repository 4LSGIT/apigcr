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
 *   POST /api/esign/templates/:id/prefills    resolve values only (2C, no render)
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
const esignInlineImageService = require('../services/esignInlineImageService');

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
    case 'ESIGN_INLINE_BAD_INPUT':
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
  // ESIGN_RENDER_EXTERNAL_REF carries the blocked urls (.urls) — forwarded so
  // templateAdmin's error-flow can offer the authoring-time image inliner.
  // Same class of forwarding as `missing`; nothing sensitive rides here (the
  // urls came out of the caller's own template body).
  if (err && err.urls) body.urls = err.urls;
  // Present after a failed provider send (sendPipeline attaches it): lets the
  // send form retry the SAME draft row — preview-render the PDF and POST
  // /api/esign/send with draft_id — rather than orphaning it and minting a
  // second tracking id. Mirrors the actions router's fail(); its absence here
  // was an oversight — sendFromTemplate flows through the same sendPipeline.
  if (err && err.draftId != null) body.draft_id = err.draftId;
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
    template_type:   'templateType',
  };
  for (const [wire, svc] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(b, wire)) out[svc] = b[wire];
  }
  return out;
}

// ─── GET /api/esign/template-meta ────────────────────────────
//
// Phase 2D. The template editor's dropdown fodder, sourced from the REAL
// exported constants — never a hand-copied list:
//   resolvers  esignPrefillService.RESOLVER_NAMES (the literal whitelist)
//   kinds      esignSendService.legalKinds(db) — static KINDS ∪ kinds on
//              active templates, the same union validateSendInput enforces
//   types      esignTemplateService.PREFILL_TYPES
// Path note: the actions router's GET /api/esign/:id is digit-constrained,
// so 'template-meta' falls through to this router (same reason /templates
// does — see ROUTE ORDER in the header).

router.get('/api/esign/template-meta', jwtOrApiKey, async (req, res) => {
  try {
    const kinds = await esignSendService.legalKinds(req.db);
    return res.json({
      resolvers: [...esignPrefillService.RESOLVER_NAMES].sort(),
      kinds,
      types: [...esignTemplateService.PREFILL_TYPES],
    });
  } catch (err) {
    return fail(res, err, 'GET /api/esign/template-meta');
  }
});

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

// ─── POST /api/esign/templates/:id/prefills ──────────────────
//
// Phase 2C. Resolve a template's prefill_schema against a linkable and return
// the values WITHOUT rendering anything — the send form seeds its input fields
// from this, then previews/sends with staff edits layered on top. A thin
// auth'd wrapper over esignPrefillService.resolvePrefills; no rows, no
// provider, no chromium, no credits.
//
// Deliberately returns ONLY {values, missing}. resolvePrefills also returns
// `context` — the raw case + debtor contact rows, SSN and DOB included. That
// object exists for the SERVER (document-name derivation); shipping it to the
// browser would leak every column of two contacts to any authed caller who
// only asked for prefill strings. Do not add it.

router.post('/api/esign/templates/:id/prefills', jwtOrApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    const out = await esignPrefillService.resolvePrefills(
      req.db,
      asInt(req.params.id),
      // No linkable → authoring-time resolution (defaults only) — same
      // degradation previewFromTemplate uses, so the form still works if a
      // caller omits the case.
      body.linkable_id != null && body.linkable_id !== ''
        ? { linkableType: body.linkable_type, linkableId: body.linkable_id }
        : null
    );
    return res.json({ values: out.values, missing: out.missing });
  } catch (err) {
    return fail(res, err, 'POST /api/esign/templates/:id/prefills');
  }
});

// ─── POST /api/esign/inline-images (2026-07-22) ──────────────
//
// The authoring-time external-image inliner: templateAdmin sends the external
// <img> URLs from a template body, gets data URIs back, and freezes the bytes
// into the body — the render pipeline's network lockdown stays untouched.
// Per-URL results ({url, ok, ...}); only malformed input is a request-level
// error. Full guard rationale in services/esignInlineImageService.js —
// including why an authed fetch-me-this-URL endpoint is an SSRF surface and
// how it is screened.
//
// Path safety: 3 literal segments — the actions router's POSTs are either
// literal (/api/esign/send) or 4-segment (/api/esign/:id/recall), so nothing
// there shadows this.

router.post('/api/esign/inline-images', jwtOrApiKey, async (req, res) => {
  try {
    const out = await esignInlineImageService.inlineImages((req.body || {}).urls);
    return res.json({ images: out.images, total_bytes: out.totalBytes });
  } catch (err) {
    return fail(res, err, 'POST /api/esign/inline-images');
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

// ─── POST /api/esign/resolve-prefills (2E, one-time uploads) ──
//
// The template-free twin of /templates/:id/prefills: the caller supplies the
// schema inline (key/type/resolver/default per text field the staff placed on
// an uploaded PDF) and gets resolved values back. resolvePrefills accepts a
// template-shaped OBJECT, so this is the same engine — including the same
// LEAK GUARD: {values, missing} ONLY; resolvePrefills' context carries raw
// contact rows (SSN included) and must never reach the browser.
// Resolver safety needs no pre-filtering here: unknown bespoke names throw
// ESIGN_BAD_RESOLVER (→ clean 400), and expressions run through
// resolverService, whose ALLOWED_TABLES / BLOCKED_COLUMNS scan turns any
// policy violation into a '' value, never data.

router.post('/api/esign/resolve-prefills', jwtOrApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    const schema = Array.isArray(body.schema) ? body.schema : [];
    const out = await esignPrefillService.resolvePrefills(
      req.db,
      { prefill_schema: schema },
      body.linkable_id != null && body.linkable_id !== ''
        ? { linkableType: body.linkable_type, linkableId: body.linkable_id }
        : null
    );
    return res.json({ values: out.values, missing: out.missing });
  } catch (err) {
    return fail(res, err, 'POST /api/esign/resolve-prefills');
  }
});

// ─── template source PDF (Phase 2E) ──────────────────────────
//
// pdf-type templates store their blank source PDF in contract_template_pdfs
// (DB blob — see the migration's rationale). Upload is MULTIPART (`file`
// part): the global express.json 10mb ceiling makes base64 pointless here,
// and multer-with-memoryStorage is the established pattern (this mirrors
// routes/api.esign.actions.js's uploadSingle, sized to the template cap).

const multer = require('multer');
const _tplUpload = multer({
  storage: multer.memoryStorage(),
  // Slightly above the service's own MAX_TEMPLATE_PDF_BYTES so the service's
  // named-limit message wins over multer's generic one (actions-file idiom).
  limits: { fileSize: esignTemplateService.MAX_TEMPLATE_PDF_BYTES + 1024 * 1024 },
});
function tplUploadSingle(req, res, next) {
  _tplUpload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'File exceeds the template PDF upload limit'
        : `Upload error: ${err.message}`;
      return res.status(400).json({ error: msg, code: 'ESIGN_UPLOAD_ERROR' });
    }
    if (err) return next(err);
    next();
  });
}

router.post('/api/esign/templates/:id/pdf', jwtOrApiKey, tplUploadSingle, async (req, res) => {
  try {
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({
        error: 'No document was supplied. Attach the PDF as the `file` part of a multipart upload.',
        code: 'ESIGN_BAD_PDF',
      });
    }
    const out = await esignTemplateService.setTemplatePdf(
      req.db, asInt(req.params.id), req.file.buffer, req.file.originalname || null
    );
    return res.status(201).json({ ok: true, ...out });
  } catch (err) {
    return fail(res, err, 'POST /api/esign/templates/:id/pdf');
  }
});

// The editor loads this to render pages for placement; binary, Bearer-fetched.
router.get('/api/esign/templates/:id/pdf', jwtOrApiKey, async (req, res) => {
  try {
    const stored = await esignTemplateService.getTemplatePdf(req.db, asInt(req.params.id));
    if (!stored) {
      return res.status(404).json({
        error: 'This template has no source PDF attached.',
        code: 'ESIGN_TEMPLATE_NO_PDF',
      });
    }
    res.setHeader('Content-Type', 'application/pdf');
    return res.send(stored.buffer);
  } catch (err) {
    return fail(res, err, 'GET /api/esign/templates/:id/pdf');
  }
});

module.exports = router;
module.exports._errorToStatus = errorToStatus;