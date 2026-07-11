// routes/api.ai.js
//
/**
 * routes/api.ai.js
 *
 * POST /api/ai/file — send a file (or point at one) plus a prompt and get
 * Claude's read of it. Ad-hoc use for UI/API clients; automations should
 * use the query_ai workflow action instead (same capability, plus workflow
 * variable plumbing).
 *
 * This route is a thin WRAPPER over services/aiService: it only acquires
 * the file bytes and shapes the request. All attachment validation, guard
 * prompts, retry logic, and ai_calls logging live in aiService.
 *
 * Auth: jwtOrApiKey
 * Content-Type: multipart/form-data OR application/json.
 *
 * File source (priority url > file > base64; none provided → 400):
 *   url         {string}  https URL to a PUBLIC PDF/image. Sent as a url
 *                         source — Anthropic fetches it directly. This
 *                         route never fetches the URL server-side, so
 *                         there is no SSRF surface here.
 *   file        {File}    multipart upload (20MB cap — matches aiService's
 *                         decoded base64 cap)
 *   base64      {string}  base64 file bytes (JSON body). NOTE: server.js's
 *                         global express.json limit (10mb) caps this path
 *                         at ~7.5MB decoded (413 before this route runs).
 *                         Use multipart for anything bigger (20MB cap).
 *
 * AI params (form fields or JSON keys; form values are coerced):
 *   prompt      {string}  REQUIRED — instructions for the model
 *   input       {string?} optional untrusted text; passed as aiService
 *                         userInput (wrapped in <untrusted_user_input>)
 *   file_type   {string?} 'document' | 'image' — overrides the INFERRED
 *                         block type only, never the media_type. Required
 *                         for an extension-less url.
 *   media_type  {string?} REQUIRED for base64 sources (application/pdf or
 *                         image/jpeg|png|gif|webp); ignored otherwise
 *   model       {string?} 'claude-sonnet-4-6' (default)
 *                         | 'claude-haiku-4-5-20251001'
 *   output_type {string?} 'text' (default) | 'json'
 *   max_tokens  {number?} default 1024, clamped 1–8192
 *   timeout_ms  {number?} passthrough — aiService clamps to 1s–120s
 *                         (default 20s; raise it for large/scanned PDFs)
 *
 * Supported file types: .pdf, .jpg/.jpeg, .png, .gif, .webp — nothing
 * else (.docx etc. → 400, never forwarded).
 *
 * COST NOTE: attached PDFs bill ~1.5–3k input tokens PER PAGE. A
 * json output_type call that fails to parse retries once and RE-SENDS
 * the attachment (double billing on retry — see aiService).
 *
 * Responses:
 *   200 { ok:true, output, json?, usage, callId }   (json when output_type=json)
 *   400 { error }                                   route-level validation,
 *                                                   before any aiService call
 *   400 { ok:false, error:'bad_attachments', detail?, callId }
 *   502 { ok:false, error, detail?, callId }        no_auth / api_error / json_parse
 *   504 { ok:false, error:'timeout', detail?, callId }
 */

const express     = require('express');
const multer      = require('multer');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const aiService   = require('../services/aiService');

const router = express.Router();

// Matches aiService's ATTACHMENT_BASE64_CAP (20MB decoded). The route must
// not accept what the service will reject.
const MAX_FILE_SIZE = 20 * 1024 * 1024;

const ALLOWED_MODELS = new Set([
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]);
const DEFAULT_MODEL = 'claude-sonnet-4-6';

// ext / mime → { blockType, mediaType }. Values duplicated from
// lib/internal_functions/ai.js (FILE_EXT_MAP / FILE_MIME_MAP) by design —
// this route deliberately does NOT import from lib/internal_functions/.
const EXT_MAP = {
  '.pdf':  { blockType: 'document', mediaType: 'application/pdf' },
  '.jpg':  { blockType: 'image',    mediaType: 'image/jpeg' },
  '.jpeg': { blockType: 'image',    mediaType: 'image/jpeg' },
  '.png':  { blockType: 'image',    mediaType: 'image/png' },
  '.gif':  { blockType: 'image',    mediaType: 'image/gif' },
  '.webp': { blockType: 'image',    mediaType: 'image/webp' },
};
const MIME_MAP = {
  'application/pdf': { blockType: 'document', mediaType: 'application/pdf' },
  'image/jpeg':      { blockType: 'image',    mediaType: 'image/jpeg' },
  'image/png':       { blockType: 'image',    mediaType: 'image/png' },
  'image/gif':       { blockType: 'image',    mediaType: 'image/gif' },
  'image/webp':      { blockType: 'image',    mediaType: 'image/webp' },
};
const SUPPORTED_SET = 'PDF (.pdf) and images (.jpg/.jpeg/.png/.gif/.webp)';

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_FILE_SIZE },
});

// ─── coercion helpers (multipart values are always strings) ──

function asInt(v, def = null) {
  if (v === undefined || v === null || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function asPositiveInt(v, def = null) {
  const n = asInt(v, null);
  return n != null && n > 0 ? n : def;
}

// ─── inference helpers ───────────────────────────────────────

/** Lowercased ".ext" off a filename / URL pathname; query/fragment stripped. */
function extOf(name) {
  if (!name) return null;
  const base = String(name).split(/[?#]/)[0];
  const m = base.match(/\.([a-z0-9]+)$/i);
  return m ? '.' + m[1].toLowerCase() : null;
}

/** 'document' | 'image' | null; 400s handled by caller when invalid. */
function normalizedFileType(v) {
  if (v === undefined || v === null || v === '') return null;
  const t = String(v).toLowerCase();
  return t === 'document' || t === 'image' ? t : undefined; // undefined = invalid
}

// ─── aiService error → HTTP status mapping ───────────────────
// (api.pdf.js maps service error CODES; aiService returns error STRINGS —
// same idea, keyed on the string.)

function aiErrorToStatus(error) {
  switch (error) {
    case 'bad_attachments': return 400;
    case 'timeout':         return 504;
    case 'no_auth':         return 502;
    default:                return 502; // api_error, json_parse, anything else
  }
}

// ─── multer wrapper ──────────────────────────────────────────
// api.pdf.js does not catch MulterErrors (they bypass the handler's
// try/catch — multer runs as middleware). Standard check added in THIS
// route only, per slice scope: fileSize violations and other multer
// complaints become clean 400s instead of falling into errorMiddleware.

function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `File exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`
        : `Upload error: ${err.message}`;
      return res.status(400).json({ error: msg });
    }
    if (err) return next(err);
    next();
  });
}

// ─── POST /api/ai/file ───────────────────────────────────────

router.post('/api/ai/file', jwtOrApiKey, uploadSingle, async (req, res) => {
  try {
    const body = req.body || {};

    // ---- prompt (required) ----
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    // ---- AI params ----
    const model = body.model || DEFAULT_MODEL;
    if (!ALLOWED_MODELS.has(model)) {
      return res.status(400).json({
        error: `model must be one of: ${[...ALLOWED_MODELS].join(', ')}`,
      });
    }

    const outputType = body.output_type || 'text';
    if (outputType !== 'text' && outputType !== 'json') {
      return res.status(400).json({ error: "output_type must be 'text' or 'json'" });
    }

    let maxTokens = asPositiveInt(body.max_tokens, 1024);
    if (maxTokens < 1) maxTokens = 1;
    if (maxTokens > 8192) maxTokens = 8192;

    const timeoutMs = asPositiveInt(body.timeout_ms, null); // aiService clamps 1s–120s

    const fileType = normalizedFileType(body.file_type);
    if (fileType === undefined) {
      return res.status(400).json({ error: "file_type must be 'document' or 'image'" });
    }

    // ---- File source → aiService attachment element ----
    // Priority url > file > base64, mirroring api.pdf.js. None → 400.
    let element;

    if (body.url) {
      // Url source: Anthropic fetches the URL itself — this route performs
      // NO server-side fetch, so there is no SSRF surface here. aiService
      // enforces https://.
      if (typeof body.url !== 'string') {
        return res.status(400).json({ error: 'url must be a string' });
      }
      const ext = extOf(body.url); // URL pathname; query/fragment stripped
      if (ext) {
        const mapped = EXT_MAP[ext];
        if (!mapped) {
          return res.status(400).json({
            error: `Unsupported file type "${ext}" — supported: ${SUPPORTED_SET}`,
          });
        }
        // file_type overrides the block type only; url sources need no media_type.
        element = { type: fileType || mapped.blockType, url: body.url };
      } else {
        if (!fileType) {
          return res.status(400).json({
            error: 'file_type required — URL has no recognizable extension',
          });
        }
        element = { type: fileType, url: body.url };
      }

    } else if (req.file) {
      // Multipart upload: prefer the declared mimetype; fall back to the
      // original filename's extension.
      const byMime = MIME_MAP[req.file.mimetype];
      const ext    = extOf(req.file.originalname);
      const byExt  = ext ? EXT_MAP[ext] : null;
      const mapped = byMime || byExt;
      if (!mapped) {
        return res.status(400).json({
          error: `Unsupported file — supported: ${SUPPORTED_SET}`,
        });
      }
      element = {
        type: fileType || mapped.blockType,
        media_type: mapped.mediaType,
        data_base64: req.file.buffer.toString('base64'),
      };

    } else if (body.base64) {
      if (typeof body.base64 !== 'string') {
        return res.status(400).json({ error: 'base64 must be a string' });
      }
      // Decoded size from string length — never actually decoded here.
      const pad = body.base64.endsWith('==') ? 2 : body.base64.endsWith('=') ? 1 : 0;
      const decodedBytes = Math.floor((body.base64.length * 3) / 4) - pad;
      if (decodedBytes > MAX_FILE_SIZE) {
        return res.status(400).json({
          error: `Decoded file exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`,
        });
      }
      const mediaType = body.media_type;
      if (!mediaType) {
        return res.status(400).json({ error: 'media_type required for base64' });
      }
      const mapped = MIME_MAP[mediaType];
      if (!mapped) {
        return res.status(400).json({
          error: `Unsupported media_type "${mediaType}" — supported: ${Object.keys(MIME_MAP).join(', ')}`,
        });
      }
      element = {
        type: fileType || mapped.blockType,
        media_type: mediaType,
        data_base64: body.base64,
      };

    } else {
      return res.status(400).json({
        error: 'No file provided. Send url, multipart "file", or base64.',
      });
    }

    // ---- Call aiService (all guards/logging live there) ----
    const result = await aiService.call(req.db, {
      inlineSystem: prompt,
      userInput: body.input != null && body.input !== ''
        ? (typeof body.input === 'string' ? body.input : JSON.stringify(body.input))
        : null,
      attachments: [element],
      model,
      outputType,
      max_tokens: maxTokens,
      timeout_ms: timeoutMs ?? undefined,
      consumerRef: 'api_ai_file',
    });

    if (result.ok) {
      const out = {
        ok: true,
        output: result.output,
        usage: result.usage,
        callId: result.callId,
      };
      if (outputType === 'json') out.json = result.json;
      return res.json(out);
    }

    const status = aiErrorToStatus(result.error);
    const errBody = { ok: false, error: result.error, callId: result.callId };
    if (result.detail) errBody.detail = result.detail;
    return res.status(status).json(errBody);

  } catch (e) {
    console.error('[api.ai.file]', e.message);
    return res.status(502).json({ ok: false, error: 'api_error', detail: e.message });
  }
});

module.exports = router;