// routes/api.esign.actions.js
//
/**
 * E-Sign ACTION API — the endpoints staff and the UI drive.
 * routes/api.esign.actions.js
 *
 * Phase 2A.
 *
 *   POST /api/esign/send                     create + send (or retry a draft)
 *   POST /api/esign/:id/recall               pull it back
 *   POST /api/esign/:id/remind               nudge the signer(s)
 *   POST /api/esign/:id/resend               after a bounce, or after a terminal end
 *   POST /api/esign/:id/satisfied-external   they signed on paper
 *   GET  /api/esign                          list
 *   GET  /api/esign/:id                      one, with its full audit trail
 *
 * ── WHY A SEPARATE FILE FROM api.esign.js ───────────────────────────────────
 * routes/api.esign.js holds the PUBLIC Zoho webhook receiver, whose entire
 * security posture is \"no auth middleware, a token in the query string\".
 * Everything here is the opposite. Keeping them apart means no future edit can
 * accidentally hang jwtOrApiKey off the webhook (breaking inbound delivery) or
 * leave it off an action route (opening a send endpoint to the internet).
 * routes/ auto-mounts every file, so the split costs nothing — and the repo
 * already does exactly this with api.intake.js / api.intake.petition.js.
 *
 * ── AUTH ────────────────────────────────────────────────────────────────────
 * There is no global auth middleware in this app; each route opts in by naming
 * jwtOrApiKey. Every route below names it. See resolveCreatedBy for why the
 * user id needs coercing rather than reading straight off req.auth.
 *
 * ── HOW THE PDF ARRIVES ─────────────────────────────────────────────────────
 * TWO accepted shapes, and the reason is a constraint in server.js rather than
 * a preference:
 *
 *   multipart/form-data with a `file` part   — PREFERRED, up to MAX_UPLOAD_BYTES
 *   application/json with `pdf_base64`       — capped at roughly 7.5MB of PDF
 *
 * server.js mounts a global express.json({limit:'10mb'}) BEFORE the route
 * loop. A router-scoped parser cannot raise that ceiling — the global one has
 * already rejected the body by the time this router is reached — and base64
 * inflates by a third, so the JSON path tops out well below the 20MB the
 * service allows. Multipart bypasses express.json entirely (wrong content
 * type), which is why it is the path the UI should use. multer with
 * memoryStorage is the established pattern here: routes/api.pdf.js and
 * routes/api.ai.js both do it.
 */

const express     = require('express');
const multer      = require('multer');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const esignService = require('../services/esignService');
const esignSendService = require('../services/esignSendService');

const router = express.Router();

/**
 * Above the service's own 20MB ceiling on purpose. multer rejecting first
 * would produce a generic \"file too large\"; letting the service reject gives
 * the caller the message that names the real limit and what to do about it.
 */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_UPLOAD_BYTES },
});

/**
 * multer errors bypass a handler's try/catch — it runs as middleware — so they
 * are caught here and turned into clean 400s rather than falling through to
 * errorMiddleware as a 500. Copied from routes/api.ai.js's uploadSingle.
 *
 * A JSON request passes straight through with req.file undefined.
 */
function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB upload limit`
        : `Upload error: ${err.message}`;
      return res.status(400).json({ error: msg, code: 'ESIGN_UPLOAD_ERROR' });
    }
    if (err) return next(err);
    next();
  });
}

// ─── helpers ─────────────────────────────────────────────────

/**
 * Resolve req.auth.userId to a numeric users.user value, or 0.
 *
 * jwtOrApiKey sets userId ONLY for JWT auth; an api_key caller has no user at
 * all. 0 is the automations user, which is exactly what an api_key call is.
 * esignService.createRequest refuses to guess this, so the coercion has to
 * happen somewhere explicit — here. Mirrors routes/api.contactPhones.js.
 */
function resolveCreatedBy(req) {
  const raw = req.auth && req.auth.userId;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return parseInt(raw, 10);
  return 0;
}

/**
 * Multipart field values are ALWAYS strings, so `recipients` arrives as JSON
 * text from a multipart caller and as a real array from a JSON caller. Accept
 * both rather than making the UI care which transport it used.
 */
function asJson(v, label) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    const e = new Error(`${label} is not valid JSON.`);
    e.code = 'ESIGN_BAD_JSON';
    throw e;
  }
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

/**
 * The PDF, from whichever transport carried it. Returns null when none was
 * supplied — several endpoints treat the document as optional.
 */
function resolvePdfBuffer(req) {
  if (req.file && req.file.buffer && req.file.buffer.length) return req.file.buffer;

  const b64 = req.body && req.body.pdf_base64;
  if (!b64 || typeof b64 !== 'string') return null;

  // Tolerate a data: URL prefix — browsers produce them and stripping it here
  // is cheaper than making every caller remember.
  const clean = b64.replace(/^data:application\/pdf;base64,/, '').trim();
  const buf = Buffer.from(clean, 'base64');
  if (!buf.length) {
    const e = new Error('pdf_base64 did not decode to any data.');
    e.code = 'ESIGN_BAD_PDF';
    throw e;
  }
  return buf;
}

/**
 * Typed service error → HTTP status.
 *
 * Anything unrecognized is a 500 and is logged with its stack SERVER-SIDE only;
 * the response carries a generic message. A stack trace in an API response
 * tells an attacker the file layout and tells the user nothing.
 */
function errorToStatus(code) {
  switch (code) {
    // caller got the input wrong
    case 'ESIGN_BAD_NAME':
    case 'ESIGN_BAD_RECIPIENTS':
    case 'ESIGN_BAD_KIND':
    case 'ESIGN_BAD_EXPIRATION':
    case 'ESIGN_BAD_LINKABLE':
    case 'ESIGN_BAD_PLACEMENTS':
    case 'ESIGN_BAD_STATUS':
    case 'ESIGN_BAD_REASON':
    case 'ESIGN_BAD_JSON':
    case 'ESIGN_BAD_PDF':
    case 'ESIGN_UPLOAD_ERROR':
    case 'ESIGN_INVALID_INPUT':       // from the provider / placements validator
    case 'INVALID_RECIPIENTS':
    case 'INVALID_LINKABLE_TYPE':
    case 'INVALID_ESIGN_KIND':
    case 'ESIGN_CREATED_BY_REQUIRED':
    case 'ESIGN_FIELD_TOO_LONG':
      return 400;

    // right shape, wrong size
    case 'ESIGN_PDF_TOO_LARGE':
      return 413;

    case 'ESIGN_NOT_FOUND':
      return 404;

    // the request exists but is in the wrong state for this action
    case 'ESIGN_NOT_DRAFT':
    case 'ESIGN_RESEND_INVALID_STATE':
    case 'ESIGN_REMIND_INVALID_STATE':
    case 'ESIGN_RECALL_INVALID_STATE':
    case 'ESIGN_SATISFY_INVALID_STATE':
    case 'INVALID_ESIGN_TRANSITION':
      return 409;

    // the vendor said no, or we could not reach it
    case 'ESIGN_PROVIDER_ERROR':
    case 'ESIGN_AUTH_ERROR':
      return 502;

    // we are not set up to send at all — an admin problem, not a caller problem
    case 'ESIGN_NOT_CONFIGURED':
    case 'ESIGN_UNKNOWN_PROVIDER':
      return 503;

    default:
      return 500;
  }
}

/** Send one error response. Never leaks a stack. */
function fail(res, err, route) {
  const status = errorToStatus(err && err.code);

  if (status >= 500) {
    console.error(`[ESIGN API] ${route} failed:`, err && err.stack ? err.stack : err);
  } else {
    console.warn(`[ESIGN API] ${route} → ${status} ${err && err.code}: ${err && err.message}`);
  }

  const body = {
    error: status >= 500 && !err.code
      ? 'Something went wrong handling this request.'
      : (err && err.message) || 'Request failed.',
    code: (err && err.code) || 'ESIGN_ERROR',
  };
  // Present after a failed provider send: lets the caller retry the SAME row
  // rather than orphaning it and minting a second tracking id.
  if (err && err.draftId != null) body.draft_id = err.draftId;

  return res.status(status).json(body);
}

// ─── POST /api/esign/send ────────────────────────────────────

router.post('/api/esign/send', jwtOrApiKey, uploadSingle, async (req, res) => {
  try {
    const body = req.body || {};

    const pdfBuffer = resolvePdfBuffer(req);
    if (!pdfBuffer) {
      return res.status(400).json({
        error: 'No document was supplied. Attach a PDF as the `file` part of a multipart ' +
               'upload, or send it as `pdf_base64`.',
        code: 'ESIGN_BAD_PDF',
      });
    }

    const out = await esignSendService.sendPipeline(req.db, {
      linkableType:   body.linkable_type,
      linkableId:     body.linkable_id,
      kind:           body.kind,
      documentName:   body.document_name,
      recipients:     asJson(body.recipients, 'recipients'),
      placements:     asJson(body.placements, 'placements'),
      textValues:     asJson(body.text_values, 'text_values'),
      expirationDays: asInt(body.expiration_days),
      createdBy:      resolveCreatedBy(req),
      draftId:        asInt(body.draft_id),
      pdfBuffer,
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
    return fail(res, err, 'POST /api/esign/send');
  }
});

// ─── POST /api/esign/:id/recall ──────────────────────────────

router.post('/api/esign/:id/recall', jwtOrApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    const out = await esignSendService.recallPipeline(req.db, asInt(req.params.id), {
      reason:    body.reason,
      createdBy: resolveCreatedBy(req),
    });
    return res.json({ status: 'recalled', changed: out.changed, request: out.row });
  } catch (err) {
    return fail(res, err, 'POST /api/esign/:id/recall');
  }
});

// ─── POST /api/esign/:id/remind ──────────────────────────────

router.post('/api/esign/:id/remind', jwtOrApiKey, async (req, res) => {
  try {
    const out = await esignSendService.remindPipeline(req.db, asInt(req.params.id), {
      createdBy: resolveCreatedBy(req),
    });
    return res.json({
      status: 'reminded',
      // Surfaced because the UI must not claim it nudged one person: Zoho
      // reminds every pending recipient and offers no way to target one.
      reminded_all: out.remindedAll,
    });
  } catch (err) {
    return fail(res, err, 'POST /api/esign/:id/remind');
  }
});

// ─── POST /api/esign/:id/resend ──────────────────────────────

router.post('/api/esign/:id/resend', jwtOrApiKey, uploadSingle, async (req, res) => {
  try {
    const body = req.body || {};

    // Phase 2E: the PDF is OPTIONAL — sends store their unsigned source, and
    // resendPipeline falls back to it (an explicit upload still wins as a
    // deliberate replacement). Rows that predate storage get the service's
    // ESIGN_BAD_PDF explaining exactly that.
    const pdfBuffer = resolvePdfBuffer(req) || undefined;

    const out = await esignSendService.resendPipeline(req.db, asInt(req.params.id), {
      recipients: asJson(body.recipients, 'recipients'),
      createdBy:  resolveCreatedBy(req),
      pdfBuffer,
    });

    return res.status(201).json({
      status:  'sent',
      mode:    out.mode,                       // 'same_row' | 'duplicated'
      testing: out.testing,
      superseded_id: out.supersededId ?? null,
      request: {
        id:          out.row.id,
        tracking_id: out.row.tracking_id,
        status:      out.row.status,
        sent_at:     out.row.sent_at,
        expires_at:  out.row.expires_at,
      },
    });
  } catch (err) {
    return fail(res, err, 'POST /api/esign/:id/resend');
  }
});

// ─── POST /api/esign/:id/satisfied-external ──────────────────

router.post('/api/esign/:id/satisfied-external', jwtOrApiKey, uploadSingle, async (req, res) => {
  try {
    const body = req.body || {};

    const out = await esignSendService.markSatisfiedExternal(req.db, asInt(req.params.id), {
      note:      body.note || null,
      pdfBuffer: resolvePdfBuffer(req),        // optional here
      createdBy: resolveCreatedBy(req),
    });

    return res.json({
      status:          'satisfied_external',
      changed:         out.changed,
      filed:           out.filed,
      signed_pdf_path: out.signedPdfPath,
      // Partial-success detail. The status change ALWAYS stuck; these say what
      // else did or did not happen, and the UI should show them.
      warnings:        out.warnings,
      request:         out.row,
    });
  } catch (err) {
    return fail(res, err, 'POST /api/esign/:id/satisfied-external');
  }
});

// ─── GET /api/esign ──────────────────────────────────────────

router.get('/api/esign', jwtOrApiKey, async (req, res) => {
  try {
    const rows = await esignSendService.listRequests(req.db, {
      linkableType: req.query.linkable_type || null,
      linkableId:   req.query.linkable_id   || null,
      status:       req.query.status        || null,
      outstanding:  parseBool(req.query.outstanding),
    });
    return res.json({ requests: rows });
  } catch (err) {
    return fail(res, err, 'GET /api/esign');
  }
});

// ─── GET /api/esign/:id ──────────────────────────────────────
//
// :id is constrained to DIGITS (2B). routes/ auto-mounts alphabetically, so
// this router registers before api.esign.templates.js — an unconstrained :id
// would swallow GET /api/esign/templates as id='templates' and 404 it. With
// the constraint, non-numeric paths fall through to the templates router.

router.get('/api/esign/:id(\\d+)', jwtOrApiKey, async (req, res) => {
  try {
    const out = await esignSendService.getRequestDetail(req.db, asInt(req.params.id));
    return res.json(out);
  } catch (err) {
    return fail(res, err, 'GET /api/esign/:id');
  }
});

// ─── GET /api/esign/:id/source ───────────────────────────────
//
// Phase 2E. The stored UNSIGNED source of a send — "what did we send", minus
// the deterministic tracking footer. Binary response, so the UI fetches it
// raw with a Bearer token (esignUpload's sibling), not via the JSON relay.

router.get('/api/esign/:id(\\d+)/source', jwtOrApiKey, async (req, res) => {
  try {
    const id  = asInt(req.params.id);
    const row = await esignService.getById(req.db, id);
    if (!row) return res.status(404).json({ error: `Signing request ${id} not found.`, code: 'ESIGN_NOT_FOUND' });

    const stored = await esignService.getSourcePdf(req.db, id);
    if (!stored) {
      return res.status(404).json({
        error: 'No stored copy of this document exists (it predates source storage, ' +
               'or storing it failed at send time).',
        code: 'ESIGN_NO_SOURCE',
      });
    }

    // document_name is staff-authored free text: strip anything a filename or
    // header would choke on rather than trusting it into Content-Disposition.
    const safeName = String(row.document_name || `signing-request-${id}`)
      .replace(/[^A-Za-z0-9 ._\-]/g, '').trim() || `signing-request-${id}`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName} (unsigned).pdf"`);
    return res.send(stored.buffer);
  } catch (err) {
    return fail(res, err, 'GET /api/esign/:id/source');
  }
});

module.exports = router;
module.exports.MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES;
module.exports._resolveCreatedBy = resolveCreatedBy;
module.exports._errorToStatus = errorToStatus;