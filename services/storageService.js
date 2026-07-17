// services/storageService.js
//
/**
 * Storage Service — GCS primitive layer.
 * services/storageService.js
 *
 * The ONLY module that talks to @google-cloud/storage going forward. Routes and
 * higher-level services should depend on this, never on `new Storage()` directly.
 *
 * Pure I/O over Google Cloud Storage — no DB, no req/res, no Express. Objects are
 * world-readable; public URLs are of the form:
 *   https://storage.googleapis.com/<bucket>/<objectName>
 *
 * Environment:
 *   GCS_BUCKET — bucket name (e.g. "uploads.4lsg.com"). Read on every call so a
 *                late-loading env doesn't bake a stale/undefined bucket at require
 *                time (mirrors routes/upload.js + routes/api.videos.js, which both
 *                `new Storage()` per request).
 *
 * Exports:
 *   randomName(originalName)                         -> string
 *   publicUrl(objectName)                            -> string
 *   putBuffer(buffer, opts)                          -> Promise<result>
 *   putStream(readable, opts)                        -> Promise<result>
 *   deleteObject(objectName)                         -> Promise<boolean>
 *
 * `result` shape (matches routes/upload.js + api.videos.js upload contract):
 *   { url, filename, size, mime, uploadedAt }
 */

const path        = require('path');
const crypto      = require('crypto');
const { Storage } = require('@google-cloud/storage');

const CACHE_CONTROL = 'public, max-age=31536000';

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

/**
 * Resolve the configured bucket name, throwing a consistent error if absent.
 * @returns {string}
 */
function requireBucketName() {
  // gcs_bucket setting → GCS_BUCKET env.
  const bucketName = require('../lib/firmConfig').cfg('gcs_bucket');
  if (!bucketName) throw new Error('GCS_BUCKET not configured');
  return bucketName;
}

/**
 * Build the GCS object metadata block shared by buffer + stream uploads.
 */
function buildMetadata({ mime, originalName, uploadedAt, uploadedBy }) {
  return {
    contentType:  mime,
    cacheControl: CACHE_CONTROL,
    metadata: {
      uploadedBy:   String(uploadedBy != null ? uploadedBy : 'unknown'),
      originalName: originalName || 'upload',
      uploadedAt,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Generate a collision-resistant object name preserving the original extension.
 * Matches routes/upload.js's randomFilename exactly, including the quirk that a
 * falsy originalName yields NO extension (path.extname('.bin') === '').
 * @param {string} [originalName]
 * @returns {string}
 */
function randomName(originalName) {
  const ext    = path.extname(originalName || '.bin');
  const random = crypto.randomBytes(16).toString('hex');
  return `${random}${ext}`;
}

/**
 * Public, world-readable URL for an object in the configured bucket.
 * @param {string} objectName
 * @returns {string}
 */
function publicUrl(objectName) {
  const bucketName = requireBucketName();
  return `https://storage.googleapis.com/${bucketName}/${objectName}`;
}

/**
 * Upload a fully-buffered payload to GCS.
 *
 * @param {Buffer} buffer
 * @param {object} opts
 * @param {string}  [opts.originalName]
 * @param {string}  [opts.mime]
 * @param {number}  [opts.maxBytes]    enforced when finite; omit/Infinity = no cap
 * @param {*}       [opts.uploadedBy]  stored in object metadata only
 * @returns {Promise<{url,filename,size,mime,uploadedAt}>}
 * @throws {Error} err.code === 'LIMIT' if buffer.length > maxBytes
 */
async function putBuffer(buffer, opts = {}) {
  const { originalName, mime, maxBytes, uploadedBy } = opts;
  const bucketName = requireBucketName();

  if (Number.isFinite(maxBytes) && buffer.length > maxBytes) {
    const err = new Error(`File exceeds ${maxBytes} byte limit`);
    err.code = 'LIMIT';
    throw err;
  }

  const storage = new Storage();
  const gcsName = randomName(originalName);
  const now     = new Date().toISOString();

  await storage.bucket(bucketName).file(gcsName).save(buffer, {
    resumable: true,
    timeout:   300000, // 5 min
    metadata:  buildMetadata({ mime, originalName, uploadedAt: now, uploadedBy }),
  });

  return {
    url:        publicUrl(gcsName),
    filename:   gcsName,
    size:       buffer.length,
    mime:       mime || null,
    uploadedAt: now,
  };
}

/**
 * Stream a readable (e.g. a busboy file part) straight into GCS with no
 * intermediate buffering. Counts bytes and enforces maxBytes itself.
 *
 * Cleanup discipline mirrors routes/api.videos.js:
 *   - on size limit: unpipe, destroy the write stream, best-effort delete the
 *     partial object, reject with err.code === 'LIMIT'
 *   - on write-stream / readable error: best-effort delete partial, reject
 *   - on finish: resolve the result object
 *
 * Does NOT touch req/res — purely stream ↔ GCS.
 *
 * @param {import('stream').Readable} readable
 * @param {object} opts
 * @param {string}  [opts.originalName]
 * @param {string}  [opts.mime]
 * @param {number}  [opts.maxBytes]    enforced when finite; omit/Infinity = no cap
 * @param {*}       [opts.uploadedBy]
 * @returns {Promise<{url,filename,size,mime,uploadedAt}>}
 */
function putStream(readable, opts = {}) {
  const { originalName, mime, maxBytes, uploadedBy } = opts;

  return new Promise((resolve, reject) => {
    let bucketName;
    try {
      bucketName = requireBucketName();
    } catch (err) {
      return reject(err);
    }

    const storage = new Storage();
    const bucket  = storage.bucket(bucketName);
    const gcsName = randomName(originalName);
    const now     = new Date().toISOString();

    const writeStream = bucket.file(gcsName).createWriteStream({
      resumable: true,
      timeout:   600000, // 10 min — this primitive may carry large files
      metadata:  buildMetadata({ mime, originalName, uploadedAt: now, uploadedBy }),
    });

    let bytes         = 0;
    let settled       = false;       // single-settle guard; many paths can race
    let limitExceeded = false;
    let pendingName   = gcsName;     // cleared on success so we don't nuke a good upload

    // Best-effort delete of a partial object. Never throws.
    function cleanupPartial() {
      if (!pendingName) return;
      bucket.file(pendingName).delete().catch(() => {});
      pendingName = null;
    }

    function settleResolve(value) {
      if (settled) return;
      settled = true;
      pendingName = null; // success — keep the object
      resolve(value);
    }

    function settleReject(err) {
      if (settled) return;
      settled = true;
      cleanupPartial();
      reject(err);
    }

    readable.on('data', (chunk) => {
      if (settled || limitExceeded) return;
      bytes += chunk.length;
      if (Number.isFinite(maxBytes) && bytes > maxBytes) {
        limitExceeded = true;
        // Stop the firehose and tear down the GCS write stream.
        readable.unpipe(writeStream);
        readable.pause();
        if (!writeStream.destroyed) writeStream.destroy(new Error('size limit exceeded'));
        const err = new Error(`File exceeds ${maxBytes} byte limit`);
        err.code = 'LIMIT';
        settleReject(err);
      }
    });

    readable.on('error', (err) => {
      if (writeStream && !writeStream.destroyed) writeStream.destroy(err);
      settleReject(err);
    });

    writeStream.on('error', (err) => {
      if (limitExceeded) return; // already settled via the limit path
      settleReject(err);
    });

    writeStream.on('finish', () => {
      if (limitExceeded) return;
      settleResolve({
        url:        publicUrl(gcsName),
        filename:   gcsName,
        size:       bytes,
        mime:       mime || null,
        uploadedAt: now,
      });
    });

    readable.pipe(writeStream);
  });
}

/**
 * Delete an object from the configured bucket.
 * @param {string} objectName
 * @returns {Promise<boolean>} true if deleted, false if it was already gone (404).
 * @throws on any non-404 error.
 */
async function deleteObject(objectName) {
  const bucketName = requireBucketName();
  const storage    = new Storage();
  try {
    await storage.bucket(bucketName).file(objectName).delete();
    return true;
  } catch (err) {
    if (err && err.code === 404) return false; // already gone
    throw err;
  }
}

module.exports = {
  randomName,
  publicUrl,
  putBuffer,
  putStream,
  deleteObject,
};