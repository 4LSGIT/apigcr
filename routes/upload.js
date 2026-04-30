/**
 * Upload Route (modernized - but not extracted to a service yet)
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

    // Optionally add to image library for reuse
    //if (req.body.addToLibrary || req.file?.fieldname === 'file') {
    if (req.body.addToLibrary) {
      try {
        await req.db.query(
          `INSERT IGNORE INTO image_library (url, filename, original_name, mime, uploaded_by)
           VALUES (?, ?, ?, ?, ?)`,
          [result.url, result.filename, originalName, mimeType, req.auth.userId]
        );
      } catch (libErr) {
        console.error('[UPLOAD] Library insert failed (non-fatal):', libErr.message);
      }
    }

    res.json({ success: true, ...result });

  } catch (err) {
    console.error('[UPLOAD]', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/image-library — list all saved images
// ─────────────────────────────────────────────────────────────
router.get('/api/image-library', jwtOrApiKey, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT il.id, il.url, il.filename, il.original_name, il.mime, il.created_at,
              u.user_name AS uploaded_by_name
       FROM image_library il
       LEFT JOIN users u ON il.uploaded_by = u.user
       ORDER BY il.created_at DESC`
    );
    res.json({ images: rows });
  } catch (err) {
    console.error('[GET /api/image-library]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/image-library — add a URL to the library manually
// ─────────────────────────────────────────────────────────────
router.post('/api/image-library', jwtOrApiKey, async (req, res) => {
  const { url, original_name } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const filename = url.split('/').pop() || 'image';
    const [result] = await req.db.query(
      `INSERT IGNORE INTO image_library (url, filename, original_name, uploaded_by)
       VALUES (?, ?, ?, ?)`,
      [url, filename, original_name || filename, req.auth.userId]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error('[POST /api/image-library]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/image-library/:id — remove from library (keeps file in bucket)
// ─────────────────────────────────────────────────────────────
router.delete('/api/image-library/:id', jwtOrApiKey, async (req, res) => {
  try {
    const [result] = await req.db.query(
      'DELETE FROM image_library WHERE id = ?',
      [parseInt(req.params.id)]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Image not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /api/image-library]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;