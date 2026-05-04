/**
 * Video API Routes
 * routes/api.videos.js
 *
 * CRUD endpoints + a streaming multipart asset upload endpoint.
 * All under jwtOrApiKey. No SU gating. No admin_audit_log writes — videos are
 * normal CRUD content (matches the campaign/task pattern).
 *
 * Routes:
 *   GET    /api/videos                — list (?published=1, ?tag=foo)
 *   GET    /api/videos/:id            — single (includes `aliases` and
 *                                         `related_videos` arrays)
 *   POST   /api/videos                — create (slug optional, server gens if absent)
 *   PATCH  /api/videos/:id            — partial update (slug editable; old slug archived)
 *   DELETE /api/videos/:id            — DB delete; GCS objects orphaned
 *   POST   /api/videos/upload-asset   — multipart streaming upload to GCS
 *
 * `related_videos` on GET/PATCH responses contains ONLY the resolved
 * hand-picked entries (not auto-fill, which is render-time only). Capped at 3.
 *
 * Asset upload contract matches routes/upload.js's response shape:
 *   { success, url, filename, size, mime, uploadedAt }
 */

const express      = require('express');
const path         = require('path');
const crypto       = require('crypto');
const { Storage }  = require('@google-cloud/storage');
const Busboy       = require('busboy');
const jwtOrApiKey  = require('../lib/auth.jwtOrApiKey');
const videoService = require('../services/videoService');

const router = express.Router();

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Resolve hand-picked related videos to the API response shape:
 *   [{ id, slug, title, gcs_poster_url, gcs_gif_url }, ...]
 * Auto-fill is intentionally not included — it's a render-time concern
 * for the landing page only, and the editor only cares about user picks.
 */
async function resolveHandPickedRelated(db, videoId) {
  const rows = await videoService.getRelatedVideos(db, videoId, {
    autoFill: false,
    limit:    3,
  });
  return rows.map(r => ({
    id:             r.id,
    slug:           r.slug,
    title:          r.title,
    gcs_poster_url: r.gcs_poster_url,
    gcs_gif_url:    r.gcs_gif_url,
  }));
}

// ─────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────

router.get('/api/videos', jwtOrApiKey, async (req, res) => {
  try {
    const videos = await videoService.listVideos(req.db, {
      published: req.query.published,
      tag:       req.query.tag,
    });
    // listVideos does SELECT * so view_count rides along automatically.
    res.json({ videos });
  } catch (err) {
    console.error('[GET /api/videos]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/videos/:id', jwtOrApiKey, async (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    const video = await videoService.getVideoById(req.db, id);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    video.aliases        = await videoService.listAliasesForVideo(req.db, id);
    video.related_videos = await resolveHandPickedRelated(req.db, id);
    res.json(video);
  } catch (err) {
    console.error('[GET /api/videos/:id]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/videos', jwtOrApiKey, async (req, res) => {
  try {
    const video = await videoService.createVideo(req.db, req.body || {});
    // Newly-created videos rarely have related picks set yet, but the
    // editor will rely on the field being present in the response shape.
    video.aliases        = await videoService.listAliasesForVideo(req.db, video.id);
    video.related_videos = await resolveHandPickedRelated(req.db, video.id);
    res.json(video);
  } catch (err) {
    console.error('[POST /api/videos]', err);
    const code = err.statusCode || (err.message.includes('required') ? 400 : 500);
    res.status(code).json({ error: err.message });
  }
});

router.patch('/api/videos/:id', jwtOrApiKey, async (req, res) => {
  try {
    const video = await videoService.updateVideo(
      req.db,
      parseInt(req.params.id, 10),
      req.body || {},
    );
    if (!video) return res.status(404).json({ error: 'Video not found' });
    video.aliases        = await videoService.listAliasesForVideo(req.db, video.id);
    video.related_videos = await resolveHandPickedRelated(req.db, video.id);
    res.json(video);
  } catch (err) {
    console.error('[PATCH /api/videos/:id]', err);
    const code = err.statusCode || 500;
    res.status(code).json({ error: err.message });
  }
});

router.delete('/api/videos/:id', jwtOrApiKey, async (req, res) => {
  try {
    const ok = await videoService.deleteVideo(req.db, parseInt(req.params.id, 10));
    if (!ok) return res.status(404).json({ error: 'Video not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /api/videos/:id]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/videos/upload-asset — streaming multipart → GCS
// ─────────────────────────────────────────────────────────────
//
// Why busboy directly (not multer):
//   - 500 MB cap. multer.memoryStorage() would buffer the entire file in RAM
//     and OOM under concurrent uploads on Cloud Run.
//   - multer.diskStorage() works but adds a temp-file lifecycle (write +
//     read + unlink) for no benefit when the destination is also a stream.
//   - busboy lets us pipe req → file part → GCS write stream with no
//     intermediate buffering or disk I/O.
//
// `?kind=video|poster|gif` is logging-only and does not affect handling.

router.post('/api/videos/upload-asset', jwtOrApiKey, (req, res) => {
  const userId     = req.auth?.userId;
  const bucketName = process.env.GCS_BUCKET;
  const kind       = req.query.kind || 'unknown';

  if (!bucketName) {
    return res.status(500).json({ error: 'GCS_BUCKET not configured' });
  }

  // content-type must be multipart/form-data
  const ctype = String(req.headers['content-type'] || '').toLowerCase();
  if (!ctype.startsWith('multipart/form-data')) {
    return res.status(400).json({ error: 'Content-Type must be multipart/form-data' });
  }

  const storage = new Storage();
  const bucket  = storage.bucket(bucketName);

  let bb;
  try {
    bb = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_FILE_SIZE, files: 1 },
    });
  } catch (err) {
    return res.status(400).json({ error: 'Invalid multipart request: ' + err.message });
  }

  // Single-respond guard: many error paths can race. First-write wins.
  let responded   = false;
  let fileStarted = false;
  let writeStream = null;
  let pendingGcsName = null; // for cleanup on size-limit / error

  function respond(statusCode, body) {
    if (responded) return;
    responded = true;
    res.status(statusCode).json(body);
  }

  // Best-effort cleanup of a partial GCS object. Never throws.
  function cleanupPartialUpload() {
    if (!pendingGcsName) return;
    bucket.file(pendingGcsName).delete().catch(() => {});
    pendingGcsName = null;
  }

  bb.on('file', (fieldName, fileStream, info) => {
    fileStarted = true;

    // Reject if the field name isn't 'file' — keep the contract narrow.
    if (fieldName !== 'file') {
      fileStream.resume(); // drain
      respond(400, { error: 'Unexpected field name "' + fieldName + '" — expected "file"' });
      return;
    }

    const { filename, mimeType } = info;
    const ext     = path.extname(filename || '.bin');
    const gcsName = crypto.randomBytes(16).toString('hex') + ext;
    const now     = new Date().toISOString();

    pendingGcsName = gcsName;

    writeStream = bucket.file(gcsName).createWriteStream({
      resumable:  true,
      timeout:    600000, // 10 min — big videos
      metadata: {
        contentType:  mimeType,
        cacheControl: 'public, max-age=31536000',
        metadata: {
          uploadedBy:   String(userId || 'unknown'),
          originalName: filename || 'upload',
          uploadedAt:   now,
          kind:         String(kind),
        },
      },
    });

    let bytes          = 0;
    let limitExceeded  = false;

    fileStream.on('data', chunk => { bytes += chunk.length; });

    // Busboy fires 'limit' on the file stream when fileSize cap is hit.
    fileStream.on('limit', () => {
      limitExceeded = true;
      // Stop accepting data and tear down the GCS write stream.
      fileStream.unpipe(writeStream);
      writeStream.destroy(new Error('size limit exceeded'));
      cleanupPartialUpload();
      respond(400, {
        error: `File exceeds ${MAX_FILE_SIZE / 1024 / 1024} MB limit`,
      });
    });

    fileStream.on('error', err => {
      if (writeStream && !writeStream.destroyed) writeStream.destroy(err);
      cleanupPartialUpload();
      respond(500, { error: 'File stream error: ' + err.message });
    });

    writeStream.on('error', err => {
      if (limitExceeded) return; // already responded
      cleanupPartialUpload();
      respond(500, { error: 'GCS upload failed: ' + err.message });
    });

    writeStream.on('finish', () => {
      if (limitExceeded) return;
      // Success: clear the pending-cleanup marker so we don't delete
      // the very file we just uploaded.
      pendingGcsName = null;
      respond(200, {
        success:    true,
        url:        `https://storage.googleapis.com/${bucketName}/${gcsName}`,
        filename:   gcsName,
        size:       bytes,
        mime:       mimeType,
        uploadedAt: now,
      });
    });

    fileStream.pipe(writeStream);
  });

  bb.on('error', err => {
    if (writeStream && !writeStream.destroyed) writeStream.destroy(err);
    cleanupPartialUpload();
    respond(400, { error: 'Multipart parse error: ' + err.message });
  });

  // 'close' fires after the multipart stream is fully consumed (success or
  // not). If no file part was ever seen, the request was empty/malformed.
  bb.on('close', () => {
    if (!fileStarted) {
      respond(400, { error: 'No file provided. Use multipart field name "file"' });
    }
  });

  // Client disconnect mid-upload.
  req.on('aborted', () => {
    if (writeStream && !writeStream.destroyed) {
      writeStream.destroy(new Error('client aborted'));
    }
    cleanupPartialUpload();
    // No respond() — connection's gone.
  });

  req.pipe(bb);
});

module.exports = router;