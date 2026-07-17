// routes/api.assets.js
//
/**
 * Asset API Routes
 * routes/api.assets.js
 *
 * Owns the asset-store HTTP surface: uploads (multipart streaming OR base64),
 * listing, edit, and soft-delete — plus TEMP back-compat shims that preserve the
 * legacy /api/upload and /api/image-library contracts until the comms callers
 * migrate to assetpicker.js (Slice 5).
 *
 * All routes are under jwtOrApiKey; req.auth.userId identifies the uploader and
 * req.db is the mysql2 pool. This file performs NO direct GCS or raw-SQL work:
 *   - object storage  -> services/storageService.js (putStream / putBuffer)
 *   - row registry    -> services/assetService.js  (create / list / update / softDelete)
 *
 * Routes:
 *   POST   /api/assets            — upload (multipart "file" OR base64 JSON), optional register
 *   GET    /api/assets            — list (q, collection, mime, sort, limit, offset, include_deleted)
 *   PATCH  /api/assets/:id        — edit title/tags/collection
 *   DELETE /api/assets/:id        — soft-delete (GCS object intentionally retained)
 *
 *   TEMP back-compat (remove after Slice 5):
 *   POST   /api/upload            — legacy upload contract (collection -> 'comms-images')
 *   GET    /api/image-library     — legacy comms picker list
 *   POST   /api/image-library     — legacy manual URL add
 *   DELETE /api/image-library/:id — legacy remove (now soft-delete)
 *
 * Upload size policy:
 *   maxBytes default 25 MB, hard ceiling 500 MB. busboy's fileSize limit is set to
 *   (effectiveMaxBytes + 1) so storageService.putStream's own byte counter is the
 *   sole size authority — this avoids the busboy quirk where a file truncated AT the
 *   limit emits no error and would otherwise be stored as a (corrupt) "success".
 */

const express        = require('express');
const Busboy         = require('busboy');
const jwtOrApiKey    = require('../lib/auth.jwtOrApiKey');
const storageService = require('../services/storageService');
const assetService   = require('../services/assetService');

const router = express.Router();

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;  //  25 MB
const HARD_MAX_BYTES    = 500 * 1024 * 1024; // 500 MB

// ─────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────

/** First value that is not undefined/null/'' (empty string treated as absent). */
function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}

/** Loose truthy for query/form flags: true|1|'1'|'true' (case-insensitive). */
function truthy(v) {
  return v === true || v === 1 || v === '1' ||
         (typeof v === 'string' && v.trim().toLowerCase() === 'true');
}

/** Parse/clamp maxBytes: default 25 MB, hard ceiling 500 MB, ignore junk. */
function resolveMaxBytes(raw) {
  let n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) n = DEFAULT_MAX_BYTES;
  return Math.min(n, HARD_MAX_BYTES);
}

/**
 * Parse mimeAllow into a lowercased list, or null if none supplied.
 * Accepts a CSV string or an array.
 */
function parseMimeAllow(raw) {
  if (raw == null || raw === '') return null;
  const list = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map(s => String(s).trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : null;
}

/**
 * Is `mime` permitted by `allowList`? Null allowList => everything allowed.
 * An entry ending in '/' is a prefix match (e.g. "image/"); otherwise exact.
 */
function mimeAllowed(mime, allowList) {
  if (!allowList) return true;
  const m = String(mime || '').toLowerCase();
  return allowList.some(entry => (entry.endsWith('/') ? m.startsWith(entry) : m === entry));
}

/** Coerce to a non-negative-ish integer, or undefined when absent/garbage. */
function toIntOrUndef(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** MB string for limit error messages. */
function mbLabel(bytes) {
  return Math.floor(bytes / 1024 / 1024);
}

// ─────────────────────────────────────────────────────────────
// Shared registration
// ─────────────────────────────────────────────────────────────
//
// Decides (per policy) whether to insert a library row for a just-uploaded
// object, and if so delegates to assetService.create. Returns the new/updated
// row id, or null when registration is skipped.

async function registerAsset(req, uploadResult, originalName, merged, policy) {
  if (!policy.resolveRegister(merged)) return null;

  const collection = firstDefined(merged.collection, policy.defaultCollection) ?? null;

  const row = await assetService.create(req.db, {
    url:           uploadResult.url,
    filename:      uploadResult.filename,
    original_name: originalName || null,
    title:         merged.title != null ? merged.title : null,
    tags:          merged.tags  != null ? merged.tags  : null,
    collection,
    mime:          uploadResult.mime,
    size:          uploadResult.size,
    width:         toIntOrUndef(merged.width),
    height:        toIntOrUndef(merged.height),
    uploaded_by:   req.auth.userId,
  });
  return row ? row.id : null;
}

// ─────────────────────────────────────────────────────────────
// Upload dispatch: multipart streaming vs base64 JSON
// ─────────────────────────────────────────────────────────────
//
// `cfg`    = { maxBytes, mimeAllow } resolved up-front from query/body (config
//            flags are read from query for multipart since req.body isn't parsed
//            until busboy runs; from body for the JSON path).
// `policy` = { defaultCollection, resolveRegister(merged), buildResponse(result,id) }

function dispatchUpload(req, res, policy, cfg) {
  const ctype = String(req.headers['content-type'] || '').toLowerCase();

  if (ctype.startsWith('multipart/form-data')) {
    return handleMultipart(req, res, policy, cfg);
  }
  if (req.body && typeof req.body.image === 'string' && req.body.image.length) {
    return handleBase64(req, res, policy, cfg);
  }
  return res.status(400).json({
    error: 'No file provided. Send multipart "file" or JSON "image" (base64)',
  });
}

// ── Multipart streaming path (busboy → storageService.putStream) ──
//
// Two-phase finalize: registration needs the text fields (collection/title/tags
// and, for the /api/upload shim, addToLibrary), which may arrive as multipart
// parts AFTER the file part. So we wait for BOTH the GCS upload to finish AND
// busboy to fully parse ('close') before merging fields and registering. This
// removes any dependence on multipart part ordering. Single-respond guard mirrors
// routes/api.videos.js.
function handleMultipart(req, res, policy, cfg) {
  if (!require('../lib/firmConfig').cfg('gcs_bucket')) {
    return res.status(500).json({ error: 'GCS_BUCKET not configured' });
  }

  let bb;
  try {
    bb = Busboy({
      headers: req.headers,
      // +1 so putStream's counter — not busboy's truncation — is the size authority.
      limits: { fileSize: cfg.maxBytes + 1, files: 1 },
    });
  } catch (err) {
    return res.status(400).json({ error: 'Invalid multipart request: ' + err.message });
  }

  let responded     = false;
  let fileStarted   = false;
  let aborted       = false;
  let uploadDone    = false;
  let parsingDone   = false;
  let uploadResult  = null;
  let originalName  = null;
  const fields      = {}; // collected non-file multipart parts

  function respond(code, body) {
    if (responded) return;
    responded = true;
    res.status(code).json(body);
  }

  async function maybeFinalize() {
    if (responded || aborted) return;
    if (!uploadDone || !parsingDone) return; // wait for both

    const merged = {
      collection:   firstDefined(fields.collection, req.query.collection),
      title:        firstDefined(fields.title, req.query.title),
      tags:         firstDefined(fields.tags, req.query.tags),
      register:     firstDefined(fields.register, req.query.register),
      addToLibrary: firstDefined(fields.addToLibrary, req.query.addToLibrary),
      width:        firstDefined(fields.width, req.query.width),
      height:       firstDefined(fields.height, req.query.height),
    };

    try {
      const id = await registerAsset(req, uploadResult, originalName, merged, policy);
      respond(200, policy.buildResponse(uploadResult, id));
    } catch (err) {
      console.error('[POST asset upload — register]', err);
      respond(500, { error: err.message || 'Registration failed' });
    }
  }

  bb.on('field', (name, val) => { fields[name] = val; });

  bb.on('file', (fieldName, fileStream, info) => {
    fileStarted = true;

    if (fieldName !== 'file') {
      fileStream.resume(); // drain
      respond(400, { error: 'Unexpected field name "' + fieldName + '" — expected "file"' });
      return;
    }

    const { filename, mimeType } = info;

    if (!mimeAllowed(mimeType, cfg.mimeAllow)) {
      fileStream.resume(); // drain
      respond(400, { error: 'File type not allowed: ' + (mimeType || 'unknown') });
      return;
    }

    originalName = filename || null;

    storageService.putStream(fileStream, {
      originalName: filename,
      mime:         mimeType,
      maxBytes:     cfg.maxBytes,
      uploadedBy:   req.auth.userId,
    }).then(result => {
      uploadResult = result;
      uploadDone   = true;
      maybeFinalize();
    }).catch(err => {
      if (err && err.code === 'LIMIT') {
        respond(400, { error: `File exceeds ${mbLabel(cfg.maxBytes)} MB limit` });
      } else {
        console.error('[POST asset upload — putStream]', err);
        respond(500, { error: 'Upload failed: ' + (err.message || 'unknown') });
      }
    });
  });

  bb.on('error', err => {
    respond(400, { error: 'Multipart parse error: ' + err.message });
  });

  // 'close' fires once the whole multipart stream is consumed.
  bb.on('close', () => {
    if (!fileStarted) {
      respond(400, { error: 'No file provided. Use multipart field name "file"' });
      return;
    }
    parsingDone = true;
    maybeFinalize();
  });

  req.on('aborted', () => { aborted = true; });

  req.pipe(bb);
}

// ── Base64 JSON path (buffer → storageService.putBuffer) ──
async function handleBase64(req, res, policy, cfg) {
  if (!require('../lib/firmConfig').cfg('gcs_bucket')) {
    return res.status(500).json({ error: 'GCS_BUCKET not configured' });
  }

  const b            = req.body || {};
  const buffer       = Buffer.from(b.image, 'base64');
  const originalName  = b.filename || 'upload.png';
  const mime         = b.contentType || 'image/png';

  if (!mimeAllowed(mime, cfg.mimeAllow)) {
    return res.status(400).json({ error: 'File type not allowed: ' + mime });
  }

  let result;
  try {
    result = await storageService.putBuffer(buffer, {
      originalName,
      mime,
      maxBytes:   cfg.maxBytes,
      uploadedBy: req.auth.userId,
    });
  } catch (err) {
    if (err && err.code === 'LIMIT') {
      return res.status(400).json({ error: `File exceeds ${mbLabel(cfg.maxBytes)} MB limit` });
    }
    console.error('[POST asset upload — putBuffer]', err);
    return res.status(500).json({ error: err.message || 'Upload failed' });
  }

  const merged = {
    collection:   firstDefined(b.collection, req.query.collection),
    title:        firstDefined(b.title, req.query.title),
    tags:         firstDefined(b.tags, req.query.tags),
    register:     firstDefined(b.register, req.query.register),
    addToLibrary: firstDefined(b.addToLibrary, req.query.addToLibrary),
    width:        firstDefined(b.width, req.query.width),
    height:       firstDefined(b.height, req.query.height),
  };

  try {
    const id = await registerAsset(req, result, originalName, merged, policy);
    return res.json(policy.buildResponse(result, id));
  } catch (err) {
    console.error('[POST asset upload — register]', err);
    return res.status(500).json({ error: err.message || 'Registration failed' });
  }
}

// ─────────────────────────────────────────────────────────────
// POST /api/assets — canonical upload
// ─────────────────────────────────────────────────────────────
router.post('/api/assets', jwtOrApiKey, (req, res) => {
  const body = req.body || {};
  const cfg = {
    maxBytes:  resolveMaxBytes(firstDefined(req.query.maxBytes, body.maxBytes)),
    mimeAllow: parseMimeAllow(firstDefined(req.query.mimeAllow, body.mimeAllow)),
  };
  const policy = {
    defaultCollection: undefined,
    // register defaults true; only an explicit false / 'false' disables it.
    resolveRegister: (m) => !(m.register === false || m.register === 'false'),
    buildResponse: (r, id) => ({
      success:    true,
      url:        r.url,
      filename:   r.filename,
      size:       r.size,
      mime:       r.mime,
      uploadedAt: r.uploadedAt,
      id:         id ?? null,
    }),
  };
  dispatchUpload(req, res, policy, cfg);
});

// ─────────────────────────────────────────────────────────────
// GET /api/assets — list
// ─────────────────────────────────────────────────────────────
router.get('/api/assets', jwtOrApiKey, async (req, res) => {
  try {
    const out = await assetService.list(req.db, {
      q:              req.query.q,
      collection:     req.query.collection,
      mime:           req.query.mime,
      sort:           req.query.sort,
      limit:          req.query.limit,
      offset:         req.query.offset,
      includeDeleted: truthy(req.query.include_deleted),
    });
    res.json(out); // { assets, total, limit, offset }
  } catch (err) {
    console.error('[GET /api/assets]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/assets/collections — distinct live collection names
// ─────────────────────────────────────────────────────────────
//
// MUST be declared BEFORE the '/api/assets/:id' routes below so the literal
// 'collections' segment is never captured as an :id param. (Express matches in
// declaration order; though :id here is only on PATCH/DELETE, keeping this
// above them is the robust, future-proof placement.)
router.get('/api/assets/collections', jwtOrApiKey, async (req, res) => {
  try {
    const collections = await assetService.listCollections(req.db);
    res.json({ collections });
  } catch (err) {
    console.error('[GET /api/assets/collections]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/assets/:id — edit title/tags/collection
// ─────────────────────────────────────────────────────────────
router.patch('/api/assets/:id', jwtOrApiKey, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

    const b   = req.body || {};
    const row = await assetService.update(req.db, id, {
      title:      b.title,
      tags:       b.tags,
      collection: b.collection,
    });
    if (!row) return res.status(404).json({ error: 'Asset not found' });
    res.json({ success: true, asset: row });
  } catch (err) {
    console.error('[PATCH /api/assets/:id]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/assets/:id — soft-delete (GCS object retained for v2 GC)
// ─────────────────────────────────────────────────────────────
router.delete('/api/assets/:id', jwtOrApiKey, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ok = await assetService.softDelete(req.db, id);
    if (!ok) return res.status(404).json({ error: 'Asset not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /api/assets/:id]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;