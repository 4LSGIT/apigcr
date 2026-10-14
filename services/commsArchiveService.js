// services/commsArchiveService.js
//
/**
 * Comms archive — the PRIVATE bucket's primitive layer.
 * ref/COMMS_ARCHIVE_DESIGN.md §4 (storage), §6.1 step 3 (store), §7 (bytes).
 *
 * NOT services/storageService.js. That module's bucket (gcs_bucket) is
 * WORLD-READABLE and its objects carry public URLs; archive content (call
 * recordings, MMS, mail) is privileged and is served only through V4 signed
 * URLs issued after a grant check. This file borrows storageService's shape
 * and nothing else — never point either one at the other's bucket.
 *
 * Pure I/O: no DB, no req/res. The sweeper (services/commsArchiveSweep.js)
 * owns rows and states; this file owns bytes.
 *
 * ── ERRORS: WHOSE SIDE FAILED ──────────────────────────────────────────────
 * Every failure here is OURS (config, permissions, GCS itself, a GCS call
 * that outlived its time bound), thrown as an Error with `ourSide: true` —
 * the sweeper ends its tick on those instead of charging a row's attempts
 * (one bucket misconfiguration must not walk every pending row to retry
 * exhaustion). The exceptions are explicit codes, all about the SOURCE bytes:
 *   EXISTS          put lost to an existing object (ifGenerationMatch:0) →
 *                   the caller adopts it.
 *   LENGTH_MISMATCH the source delivered a byte count different from its
 *                   Content-Length;
 *   EMPTY           the source delivered 0 bytes;
 *   SOURCE          the source stream itself errored (provider socket).
 *   The last three are provider-side transients and abort the upload before
 *   GCS commits the object (a non-resumable upload whose body errors or ends
 *   short commits NOTHING — verified against the real @google-cloud/storage
 *   8.1.0 by the S1a review), so adopt only ever sees complete objects.
 *
 * ── TIME BOUNDS ────────────────────────────────────────────────────────────
 * Every GCS call takes `timeoutMs` (default IO_TIMEOUT_MS). The library's
 * simple-upload path has NO timeout of its own unless one is passed: a stalled
 * GCS response would hold the sweeper's tick lock indefinitely. So uploads
 * pass `timeout` to the library AND race a local timer that destroys both
 * streams; list / permission calls race the same timer.
 *
 * Exports:
 *   bucketName()                              -> string (throws ourSide)
 *   recordingPrefix({capturedAt, sourceId, part}) -> 'phone/rec/yyyy/mm/<id>-<part>.'
 *   extForMime(mime) / canonicalAudioMime(mime)
 *   checkBucket({timeoutMs})                  -> Promise<void> (throws ourSide)
 *   findByPrefix(prefix, {timeoutMs})         -> Promise<[{name,size,contentType,generation}]>
 *   putStream(readable, {objectName, mime, expectedBytes, timeoutMs})
 *                                             -> Promise<{bytes, sha256, generation}>
 *   rehash(objectName, {timeoutMs})           -> Promise<{bytes, sha256, contentType}>
 *   signedUrl(objectName, {mime, filename?})  -> Promise<string>  (V4, 5 min)
 */

'use strict';

const crypto = require('crypto');
const { Transform, Writable, pipeline } = require('stream');
const { promisify } = require('util');

const pipelineP = promisify(pipeline);

const SIGNED_URL_TTL_MS = 5 * 60 * 1000;
const IO_TIMEOUT_MS = 60_000;

/**
 * What the sweep needs on the bucket, proven by checkBucket WITHOUT writing
 * anything (a probe object would carry Archive class's 365-day minimum and
 * soft-delete). Delete is not in S1a.
 */
const REQUIRED_PERMISSIONS = Object.freeze([
  'storage.objects.create',   // put
  'storage.objects.get',      // re-hash on adopt
  'storage.objects.list',     // stat-first by prefix
]);

/**
 * Audio types a recording may be stored as, → [canonical mime, extension].
 * RingCentral serves audio/mpeg (and, per its docs, sometimes audio/wav).
 * Anything else on a 200 — JSON, HTML, an error page — is a provider error,
 * never an archived "recording".
 */
const AUDIO_TYPES = Object.freeze({
  'audio/mpeg':     ['audio/mpeg', 'mp3'],
  'audio/mp3':      ['audio/mpeg', 'mp3'],
  'audio/wav':      ['audio/wav', 'wav'],
  'audio/x-wav':    ['audio/wav', 'wav'],
  'audio/wave':     ['audio/wav', 'wav'],
  'audio/vnd.wave': ['audio/wav', 'wav'],
});

/**
 * Types a signed URL may render INLINE (design §7, C6). Everything else is
 * served as an attachment; SVG / HTML never render inline.
 */
const INLINE_TYPES = new Set([
  'audio/mpeg', 'audio/wav', 'audio/mp4',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
]);

// ─────────────────────────────────────────────────────────────
// Storage client (injectable at the GCS boundary for tests)
// ─────────────────────────────────────────────────────────────

let _storageOverride = null;

function _storage() {
  if (_storageOverride) return _storageOverride;
  const { Storage } = require('@google-cloud/storage'); // lazy require (convention)
  return new Storage();
}

function _ourSide(err, what) {
  const e = new Error(`archive storage: ${what}: ${err && err.message ? err.message : err}`);
  e.ourSide = true;
  e.code = 'ARCHIVE_STORAGE';
  e.status = err && (err.code || err.status);
  return e;
}

function _gcsStatus(err) {
  const c = err && (err.code ?? err.status ?? (err.response && err.response.status));
  return Number(c) || null;
}

function _timeoutMs(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : IO_TIMEOUT_MS;
}

/**
 * Race `promise` against a timer. On expiry: run `onTimeout(err)` (to destroy
 * streams) and reject ourSide. The losing promise is caught so it can never
 * surface as an unhandled rejection.
 */
function _bounded(promise, ms, what, onTimeout) {
  let timer;
  promise.catch(() => {});
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`timed out after ${ms} ms`);
      e.code = 'ARCHIVE_TIMEOUT';
      try { if (onTimeout) onTimeout(e); } catch (_) { /* best effort */ }
      reject(_ourSide(e, what));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

// ─────────────────────────────────────────────────────────────
// Names
// ─────────────────────────────────────────────────────────────

/** The configured archive bucket. Unset → ourSide throw (fail-closed). */
function bucketName() {
  // comms_archive_bucket setting → COMMS_ARCHIVE_BUCKET env.
  const name = require('../lib/firmConfig').cfg('comms_archive_bucket');
  if (!name || !String(name).trim()) {
    const e = new Error('comms_archive_bucket not configured (COMMS_ARCHIVE_BUCKET)');
    e.ourSide = true;
    e.code = 'ARCHIVE_CONFIG';
    throw e;
  }
  return String(name).trim();
}

/**
 * Deterministic name prefix for a call recording, up to and including the
 * dot before the extension (design §4: ids only, year/month of the CALL).
 * The extension depends on the content-type, which is unknown until the
 * fetch — so stat-first looks the object up by THIS prefix, and yyyy/mm come
 * from captured_at, which never changes once the row exists.
 */
function recordingPrefix({ capturedAt, sourceId, part }) {
  const d = capturedAt instanceof Date ? capturedAt : new Date(capturedAt);
  if (Number.isNaN(d.getTime())) throw new Error(`recordingPrefix: bad capturedAt ${capturedAt}`);
  if (!part) throw new Error('recordingPrefix: part is required (placeholders have no object)');
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `phone/rec/${yyyy}/${mm}/${sourceId}-${part}.`;
}

function _baseMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

/** Canonical stored mime for an allowlisted audio type, else null. */
function canonicalAudioMime(mime) {
  const hit = AUDIO_TYPES[_baseMime(mime)];
  return hit ? hit[0] : null;
}

/** Extension for an allowlisted audio type, else null. */
function extForMime(mime) {
  const hit = AUDIO_TYPES[_baseMime(mime)];
  return hit ? hit[1] : null;
}

// ─────────────────────────────────────────────────────────────
// Bucket I/O
// ─────────────────────────────────────────────────────────────

/**
 * Pre-flight, run BEFORE any row is claimed: config present, and the runtime
 * identity holds every permission the tick uses (testIamPermissions — one
 * call, no write). A create-denied bucket fails HERE, before any RC Heavy
 * call is spent on a recording that could not be stored.
 */
async function checkBucket({ timeoutMs } = {}) {
  const bucket = bucketName();
  const ms = _timeoutMs(timeoutMs);
  let granted;
  try {
    [granted] = await _bounded(
      _storage().bucket(bucket).iam.testPermissions([...REQUIRED_PERMISSIONS]),
      ms, `permissions on ${bucket}`);
  } catch (err) {
    if (err.ourSide) throw err;
    throw _ourSide(err, `permissions on ${bucket}`);
  }
  const missing = REQUIRED_PERMISSIONS.filter(p => !(granted && granted[p] === true));
  if (missing.length) {
    throw _ourSide(new Error(`missing ${missing.join(', ')}`), `bucket ${bucket}`);
  }
}

/** Objects whose name starts with `prefix` (stat-first / adopt-after-crash). */
async function findByPrefix(prefix, { timeoutMs } = {}) {
  const bucket = bucketName();
  let files;
  try {
    [files] = await _bounded(
      _storage().bucket(bucket).getFiles({ prefix, autoPaginate: false, maxResults: 10 }),
      _timeoutMs(timeoutMs), `list ${prefix}`);
  } catch (err) {
    if (err.ourSide) throw err;
    throw _ourSide(err, `list ${prefix}`);
  }
  return (files || []).map(f => ({
    name: f.name,
    size: Number(f.metadata && f.metadata.size) || 0,
    contentType: (f.metadata && f.metadata.contentType) || null,
    generation: f.metadata && f.metadata.generation != null ? String(f.metadata.generation) : null,
  }));
}

/**
 * Pass-through that hashes and counts. On end, 0 bytes, or a known expected
 * length that does not match, fails the stream — which aborts the upload
 * before GCS commits the object, so a short download is never stored (and so
 * can never be adopted later).
 */
function _hasher(expectedBytes) {
  const h = crypto.createHash('sha256');
  let n = 0;
  const t = new Transform({
    transform(chunk, _enc, cb) { h.update(chunk); n += chunk.length; cb(null, chunk); },
    flush(cb) {
      if (n === 0) {
        const e = new Error('empty body (0 bytes)');
        e.code = 'EMPTY';
        return cb(e);
      }
      if (Number.isFinite(expectedBytes) && expectedBytes >= 0 && n !== expectedBytes) {
        const e = new Error(`length mismatch: got ${n} bytes, Content-Length ${expectedBytes}`);
        e.code = 'LENGTH_MISMATCH';
        return cb(e);
      }
      t.result = { bytes: n, sha256: h.digest('hex') };
      cb();
    },
  });
  return t;
}

/**
 * Stream `readable` into the archive under `objectName`, NEVER overwriting
 * (ifGenerationMatch: 0). sha256 + byte count computed in flight.
 *
 * WHOSE FAULT is decided by which stream errored FIRST. pipeline() destroys
 * every stream with the first error — so after a GCS failure the SOURCE
 * re-emits that same error object, and "did the source emit an error?" would
 * blame the provider for a GCS 403 or socket reset (the S1a review reproduced
 * exactly that with the real library). The first 'error' event wins; the
 * echoes that follow are ignored.
 */
async function putStream(readable, { objectName, mime, expectedBytes, timeoutMs } = {}) {
  if (!objectName) throw new Error('putStream: objectName required');
  const bucket = bucketName();
  const ms = _timeoutMs(timeoutMs);
  const file = _storage().bucket(bucket).file(objectName);
  const hasher = _hasher(expectedBytes);
  const out = file.createWriteStream({
    resumable: false,
    timeout: ms,
    preconditionOpts: { ifGenerationMatch: 0 },
    metadata: { contentType: mime || 'application/octet-stream' },
  });

  let first = null;
  const mark = (side) => (e) => { if (!first) first = { side, e }; };
  readable.on('error', mark('source'));
  hasher.on('error', mark('hasher'));
  out.on('error', mark('gcs'));

  try {
    await _bounded(pipelineP(readable, hasher, out), ms, `put ${objectName}`, (e) => {
      if (!first) first = { side: 'timeout', e };
      out.destroy(e);
      readable.destroy(e);
    });
  } catch (err) {
    const side = first ? first.side : (err.ourSide ? 'timeout' : 'gcs');
    const e0 = first ? first.e : err;
    if (side === 'hasher') throw e0;                       // EMPTY / LENGTH_MISMATCH
    if (side === 'source') {
      const e = new Error(`source stream failed: ${e0 && e0.message}`);
      e.code = 'SOURCE';
      throw e;
    }
    if (side === 'timeout') throw err.ourSide ? err : _ourSide(e0, `put ${objectName}`);
    if (_gcsStatus(e0) === 412) {
      const e = new Error(`object exists: ${objectName}`);
      e.code = 'EXISTS';
      throw e;
    }
    throw _ourSide(e0, `put ${objectName}`);
  }
  const meta = file.metadata || {};
  return {
    bytes: hasher.result.bytes,
    sha256: hasher.result.sha256,
    generation: meta.generation != null ? String(meta.generation) : null,
  };
}

/** Download an existing object and hash it (adopt-after-crash). 0 bytes is returned as such — the caller refuses it. */
async function rehash(objectName, { timeoutMs } = {}) {
  const bucket = bucketName();
  const file = _storage().bucket(bucket).file(objectName);
  const h = crypto.createHash('sha256');
  let n = 0;
  const counter = new Transform({
    transform(chunk, _e, cb) { h.update(chunk); n += chunk.length; cb(null, chunk); },
  });
  const sink = new Writable({ write(_c, _e, cb) { cb(); } });
  const src = file.createReadStream({ validation: false });
  try {
    await _bounded(pipelineP(src, counter, sink), _timeoutMs(timeoutMs), `re-hash ${objectName}`,
      (e) => { src.destroy(e); });
  } catch (err) {
    if (err.ourSide) throw err;
    throw _ourSide(err, `re-hash ${objectName}`);
  }
  return { bytes: n, sha256: h.digest('hex'), contentType: (file.metadata && file.metadata.contentType) || null };
}

/**
 * V4 read URL, 5 minutes. Issue ONLY after the caller's grant check (§7).
 * Inline for the allowlist; everything else downloads as an attachment.
 */
async function signedUrl(objectName, { mime, filename } = {}) {
  const bucket = bucketName();
  const type = _baseMime(mime) || 'application/octet-stream';
  const inline = INLINE_TYPES.has(type);
  const safeName = String(filename || objectName.split('/').pop() || 'file').replace(/[^A-Za-z0-9._-]/g, '_');
  try {
    const [url] = await _storage().bucket(bucket).file(objectName).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + SIGNED_URL_TTL_MS,
      responseType: inline ? type : 'application/octet-stream',
      responseDisposition: inline ? 'inline' : `attachment; filename="${safeName}"`,
    });
    return url;
  } catch (err) {
    throw _ourSide(err, `sign ${objectName}`);
  }
}

module.exports = {
  bucketName,
  recordingPrefix,
  extForMime,
  canonicalAudioMime,
  checkBucket,
  findByPrefix,
  putStream,
  rehash,
  signedUrl,
  AUDIO_TYPES,
  INLINE_TYPES,
  REQUIRED_PERMISSIONS,
  SIGNED_URL_TTL_MS,
  IO_TIMEOUT_MS,
  _test: { setStorage(s) { _storageOverride = s; } },
};
