/**
 * routes/api.pdf.js
 *
 * POST /api/pdf/parse — extract text from a PDF.
 *
 * Auth: jwtOrApiKey
 *
 * Input (any one of, priority url > file > base64):
 *   url         {string}  HTTPS URL to a PDF (SSRF-guarded)
 *   file        {File}    multipart upload
 *   base64      {string}  base64-encoded PDF bytes
 *
 * Selection / extraction options (form-encoded values are coerced):
 *   pages              "2-4,6"
 *   fromText           string anchor — slice begins here
 *   toText             string anchor — slice ends here
 *   includeFrom        bool (default true)
 *   includeTo          bool (default false)
 *   output             "concatenated" (default) | "per-page"
 *   includeMetadata    bool (default false)
 *   maxLength          int — truncate returned text
 *   normalizeWhitespace  bool (default true)
 *   removeEmptyLines     bool (default true)
 *   minLineLength        int (default 0)
 *   maxPages           int (default 200, server-capped at 500)
 *
 */

const express     = require('express');
const multer      = require('multer');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const pdfService  = require('../services/pdfService');

const router = express.Router();

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const SERVER_MAX_PAGES = 500;

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_FILE_SIZE },
});

// ─── coercion helpers (multipart values are always strings) ──

function asBool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  return /^(true|1|yes|on)$/i.test(String(v));
}

function asInt(v, def = null) {
  if (v === undefined || v === null || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function asPositiveInt(v, def = null) {
  const n = asInt(v, null);
  return n != null && n > 0 ? n : def;
}

// ─── error → HTTP status mapping ─────────────────────────────

function errorToStatus(e) {
  switch (e.code) {
    case 'NOT_A_PDF':
    case 'ENCRYPTED_PDF':
      return 415;
    case 'FILE_TOO_LARGE':
    case 'TOO_MANY_PAGES':
      return 413;
    case 'FETCH_TIMEOUT':
      return 504;
    case 'FETCH_FAILED':
    case 'FETCH_HTTP_ERROR':
      return 502;
    case 'SSRF_BLOCKED':
    case 'BAD_PAGES':
    case 'BAD_OPTION':
    case 'INCOMPATIBLE_OPTIONS':
      return 400;
    case 'PARSE_FAILED':
      return 500;
    default:
      return 500;
  }
}

// ─── POST /parse ─────────────────────────────────────────────

router.post('/api/pdf/parse', jwtOrApiKey, upload.single('file'), async (req, res) => {
  try {
    const body = req.body || {};
    let buffer;

    if (body.url) {
      try {
        buffer = await pdfService.fetchPdfFromUrl(body.url, { maxBytes: MAX_FILE_SIZE });
      } catch (e) {
        return res.status(errorToStatus(e)).json({ error: e.message, code: e.code || null });
      }
    } else if (req.file) {
      buffer = req.file.buffer;
    } else if (body.base64) {
      try { buffer = Buffer.from(body.base64, 'base64'); }
      catch { return res.status(400).json({ error: 'Invalid base64' }); }
      if (buffer.length > MAX_FILE_SIZE) {
        return res.status(413).json({ error: `File exceeds ${MAX_FILE_SIZE} bytes`, code: 'FILE_TOO_LARGE' });
      }
    } else {
      return res.status(400).json({ error: 'No input provided. Send url, multipart "file", or base64.' });
    }

    let maxPages = asInt(body.maxPages, 200);
    if (maxPages < 1) maxPages = 1;
    if (maxPages > SERVER_MAX_PAGES) maxPages = SERVER_MAX_PAGES;

    const opts = {
      pages:               body.pages || null,
      fromText:            body.fromText || null,
      toText:              body.toText   || null,
      includeFrom:         asBool(body.includeFrom, true),
      includeTo:           asBool(body.includeTo,   false),
      output:              body.output || 'concatenated',
      includeMetadata:     asBool(body.includeMetadata, false),
      maxLength:           asPositiveInt(body.maxLength, null),
      normalizeWhitespace: asBool(body.normalizeWhitespace, true),
      removeEmptyLines:    asBool(body.removeEmptyLines,    true),
      minLineLength:       asInt(body.minLineLength, 0),
      maxPages,
    };

    const result = await pdfService.parsePdf(buffer, opts);
    res.json({ success: true, ...result });

  } catch (e) {
    const status = errorToStatus(e);
    if (status >= 500) console.error('[PDF parse]', e.code || e.name, e.message);
    res.status(status).json({ error: e.message, code: e.code || null });
  }
});

module.exports = router;