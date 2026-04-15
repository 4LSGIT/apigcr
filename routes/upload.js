/**
 * Upload Route (modernized)
 * routes/upload.js
 *
 * Single upload endpoint supporting two input formats:
 *   1. Multipart file upload (via multer) — for general file uploads
 *   2. Base64 JSON body — for iframe/apiSend contexts (campaign image editor)
 *
 * Auth: jwtOrApiKey (replaces legacy username/password)
 *
 * POST /api/upload
 *
 * Multipart body:
 *   file  {File}   — the file to upload
 *
 * JSON body:
 *   image       {string}  — base64-encoded file content
 *   filename    {string}  — original filename (for extension detection)
 *   contentType {string}  — MIME type (e.g. "image/png")
 *
 * Response:
 *   { success, url, filename, size, mime, uploadedAt }
 *
 * Environment:
 *   GCS_BUCKET — Google Cloud Storage bucket name (e.g. "uploads.4lsg.com")
 *
 * Mount: app.use('/', require('./routes/upload'));
 */

const express     = require('express');
const { Storage } = require('@google-cloud/storage');
const multer      = require('multer');
const crypto      = require('crypto');
const path        = require('path');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

const router = express.Router();

// Max upload size: 25 MB
const MAX_FILE_SIZE = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

function randomFilename(originalName) {
  const ext = path.extname(originalName || '.bin');
  const random = crypto.randomBytes(16).toString('hex');
  return `${random}${ext}`;
}

async function uploadToGcs(buffer, originalName, mimeType, userId) {
  const bucketName = process.env.GCS_BUCKET;
  if (!bucketName) throw new Error('GCS_BUCKET not configured');

  const storage = new Storage();
  const bucket  = storage.bucket(bucketName);
  const gcsName = randomFilename(originalName);
  const file    = bucket.file(gcsName);
  const now     = new Date().toISOString();

  await file.save(buffer, {
    resumable: true,
    timeoutMs: 300000,
    metadata: {
      contentType: mimeType,
      cacheControl: 'public, max-age=31536000',
      metadata: {
        uploadedBy: String(userId || 'unknown'),
        originalName: originalName || 'upload',
        uploadedAt: now,
      },
    },
  });

  return {
    url:        `https://storage.googleapis.com/${bucketName}/${gcsName}`,
    filename:   gcsName,
    size:       buffer.length,
    mime:       mimeType,
    uploadedAt: now,
  };
}

// ─────────────────────────────────────────────────────────────
// POST /api/upload — accepts multipart OR base64 JSON
// ─────────────────────────────────────────────────────────────
// multer.single('file') only processes multipart requests.
// For JSON requests it passes through with req.file = undefined.

router.post('/api/upload', jwtOrApiKey, upload.single('file'), async (req, res) => {
  try {
    let buffer, originalName, mimeType;

    if (req.file) {
      // ── Multipart upload (multer processed it) ──
      buffer       = req.file.buffer;
      originalName = req.file.originalname;
      mimeType     = req.file.mimetype;

    } else if (req.body.image) {
      // ── Base64 JSON upload ──
      buffer       = Buffer.from(req.body.image, 'base64');
      originalName = req.body.filename || 'upload.png';
      mimeType     = req.body.contentType || 'image/png';

      if (buffer.length > MAX_FILE_SIZE) {
        return res.status(400).json({ error: `File exceeds ${MAX_FILE_SIZE / 1024 / 1024} MB limit` });
      }

    } else {
      return res.status(400).json({ error: 'No file provided. Send multipart "file" or JSON "image" (base64)' });
    }

    const result = await uploadToGcs(buffer, originalName, mimeType, req.auth.userId);
    res.json({ success: true, ...result });

  } catch (err) {
    console.error('[UPLOAD]', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

module.exports = router;