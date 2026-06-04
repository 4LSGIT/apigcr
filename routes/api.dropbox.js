// routes/api.dropbox.js
//
/**
 * Dropbox API (native)
 * routes/api.dropbox.js
 *
 * POST /api/dropbox/create-folder        create folder (+subfolders, +shared link)
 * POST /api/dropbox/shared-link          get-or-create a shared link for a path
 * POST /api/dropbox/shared-link-metadata resolve a shared link → metadata/path
 * POST /api/dropbox/list                 list a folder (path or shared_link)
 * POST /api/dropbox/move                 move (from_path or from_shared_link → to_path)
 * POST /api/dropbox/rename               rename in place (path or shared_link)
 * POST /api/dropbox/delete               delete (path or shared_link)
 * POST /api/dropbox/upload-link          temporary client-direct upload link
 * POST /api/dropbox/save-url             pull a URL into Dropbox (Dropbox-side transfer)
 * POST /api/dropbox/save-url-status      poll a save-url job
 * POST /api/dropbox/upload               upload small in-memory content (base64)
 * POST /api/dropbox/download             download file bytes
 *
 * Thin wrapper over services/dropboxService.js — all logic, credential
 * injection, and Dropbox specifics live in the service. Auto-mounted by the
 * routes loader (no server.js edit).
 *
 * Auth: jwtOrApiKey (same as the other api.* routes).
 *
 * STYLE NOTE: everything is POST-with-JSON-body (mirroring Dropbox's own
 * RPC style) rather than REST-y paths/query strings, because firm paths
 * carry significant leading/embedded spaces — keeping them in JSON bodies
 * avoids any query-encoding/trimming hazards. Spaces in path/filename
 * values are significant and passed through untouched.
 *
 * Location addressing: ops accept `path` OR `shared_link` (the case-folder
 * handle stored in cases.case_dropbox) — see the service header.
 *
 * credential_id is accepted everywhere as an optional override; omit to use
 * the app_settings binding ('dropbox_credential_id') or the service default
 * (credential 8).
 *
 * NOTE: this is the side-by-side native replacement for the legacy
 * routes/dropbox.js (env-var auth) and the Pabbly bridge in
 * routes/internal/dropbox.js. Those stay in place until consumers are
 * migrated and the legacy stack is retired.
 */

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const dropbox     = require('../services/dropboxService');

// ─────────────────────────────────────────────────────────────
// Error → HTTP status mapping. The service throws Error with messages
// shaped "dropbox: POST /2/<endpoint> → <status>: ..." for Dropbox API
// failures; pull that status through when present, otherwise map on
// message shape. (Same scheme as routes/api.gcal.js.)
// ─────────────────────────────────────────────────────────────
function mapErrorStatus(err) {
  const m = (err && err.message) || '';
  if (typeof err?.status === 'number' && err.status >= 400) {
    return err.status < 500 ? err.status : 502;
  }
  const apiStatus = m.match(/→\s(\d{3}):/);
  if (apiStatus) {
    const code = Number(apiStatus[1]);
    if (code >= 400 && code < 500) return code;
    return 502; // upstream 5xx → we are the proxy
  }
  if (m.includes('requires') || m.includes('provide path') ||
      m.includes('not both')  || m.includes('out of allowed_urls')) return 400;
  if (m.includes('not connected')) return 502;
  return 500;
}

function sendError(res, err) {
  const status = mapErrorStatus(err);
  console.error(`[api.dropbox] ${status}:`, err.message);
  res.status(status).json({ status: 'error', message: err.message });
}

/** Coerce a body credential_id to a number when numeric, else pass through. */
function coerceCredId(v) {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : v;
}

// ─── CREATE FOLDER (+ subfolders, + shared link) ───
// Body: { path, subfolders?, share_link?, credential_id? }
router.post('/api/dropbox/create-folder', jwtOrApiKey, async (req, res) => {
  try {
    const { path, subfolders, share_link, credential_id } = req.body || {};
    if (!path) return res.status(400).json({ status: 'error', message: 'path is required' });

    const result = await dropbox.createFolderWithOptions(req.db, {
      path,
      subfolders: Array.isArray(subfolders) ? subfolders : [],
      shareLink: share_link === true,
      credentialId: coerceCredId(credential_id),
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET-OR-CREATE SHARED LINK ───
// Body: { path, credential_id? }
router.post('/api/dropbox/shared-link', jwtOrApiKey, async (req, res) => {
  try {
    const { path, credential_id } = req.body || {};
    if (!path) return res.status(400).json({ status: 'error', message: 'path is required' });

    const url = await dropbox.getOrCreateSharedLink(req.db, {
      path, credentialId: coerceCredId(credential_id),
    });
    res.json({ status: 'success', shared_link: url });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── SHARED LINK → METADATA ───
// Body: { url, credential_id? }
router.post('/api/dropbox/shared-link-metadata', jwtOrApiKey, async (req, res) => {
  try {
    const { url, credential_id } = req.body || {};
    if (!url) return res.status(400).json({ status: 'error', message: 'url is required' });

    const metadata = await dropbox.getSharedLinkMetadata(req.db, {
      url, credentialId: coerceCredId(credential_id),
    });
    res.json({ status: 'success', metadata });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── LIST FOLDER ───
// Body: { path? | shared_link?, recursive?, max_entries?, credential_id? }
// path '' or '/' lists root (when shared_link is not used).
router.post('/api/dropbox/list', jwtOrApiKey, async (req, res) => {
  try {
    const { path, shared_link, recursive, max_entries, credential_id } = req.body || {};
    const result = await dropbox.listFolder(req.db, {
      path,
      sharedLink: shared_link,
      recursive: recursive === true,
      ...(max_entries !== undefined && { maxEntries: Number(max_entries) }),
      credentialId: coerceCredId(credential_id),
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── MOVE ───
// Body: { from_path? | from_shared_link?, to_path, autorename?, credential_id? }
router.post('/api/dropbox/move', jwtOrApiKey, async (req, res) => {
  try {
    const { from_path, from_shared_link, to_path, autorename, credential_id } = req.body || {};
    if (!to_path) return res.status(400).json({ status: 'error', message: 'to_path is required' });

    const result = await dropbox.movePath(req.db, {
      fromPath: from_path,
      fromSharedLink: from_shared_link,
      toPath: to_path,
      autorename: autorename === true,
      credentialId: coerceCredId(credential_id),
    });
    res.json({ status: 'success', result });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── RENAME ───
// Body: { path? | shared_link?, new_name, credential_id? }
router.post('/api/dropbox/rename', jwtOrApiKey, async (req, res) => {
  try {
    const { path, shared_link, new_name, credential_id } = req.body || {};
    if (!new_name) return res.status(400).json({ status: 'error', message: 'new_name is required' });

    const result = await dropbox.renamePath(req.db, {
      path,
      sharedLink: shared_link,
      newName: new_name,
      credentialId: coerceCredId(credential_id),
    });
    res.json({ status: 'success', result });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── DELETE ───
// Body: { path? | shared_link?, credential_id? }
router.post('/api/dropbox/delete', jwtOrApiKey, async (req, res) => {
  try {
    const { path, shared_link, credential_id } = req.body || {};
    const result = await dropbox.deletePath(req.db, {
      path,
      sharedLink: shared_link,
      credentialId: coerceCredId(credential_id),
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── TEMPORARY UPLOAD LINK ───
// Body: { path? | shared_link?, filename, subfolder?, duration?, credential_id? }
// (No hardcoded "Client Uploads" — pass subfolder explicitly.)
router.post('/api/dropbox/upload-link', jwtOrApiKey, async (req, res) => {
  try {
    const { path, shared_link, filename, subfolder, duration, credential_id } = req.body || {};
    if (!filename) return res.status(400).json({ status: 'error', message: 'filename is required' });

    const result = await dropbox.getTemporaryUploadLink(req.db, {
      path,
      sharedLink: shared_link,
      filename,
      subfolder,
      ...(duration !== undefined && { duration: Number(duration) }),
      credentialId: coerceCredId(credential_id),
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── SAVE FROM URL (Dropbox-side transfer) ───
// Body: { url, path? | (shared_link + filename), subfolder?, wait?, credential_id? }
// path = FULL destination path including filename.
router.post('/api/dropbox/save-url', jwtOrApiKey, async (req, res) => {
  try {
    const { url, path, shared_link, filename, subfolder, wait, credential_id } = req.body || {};
    if (!url) return res.status(400).json({ status: 'error', message: 'url is required' });

    const result = await dropbox.saveUrl(req.db, {
      url,
      path,
      sharedLink: shared_link,
      filename,
      subfolder,
      ...(wait !== undefined && { wait: wait === true }),
      credentialId: coerceCredId(credential_id),
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── SAVE-URL JOB STATUS ───
// Body: { async_job_id, credential_id? }
router.post('/api/dropbox/save-url-status', jwtOrApiKey, async (req, res) => {
  try {
    const { async_job_id, credential_id } = req.body || {};
    if (!async_job_id) return res.status(400).json({ status: 'error', message: 'async_job_id is required' });

    const result = await dropbox.checkSaveUrlJob(req.db, {
      asyncJobId: async_job_id,
      credentialId: coerceCredId(credential_id),
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── UPLOAD (small in-memory content) ───
// Body: { path? | (shared_link + filename), subfolder?, content_base64,
//         mode?, autorename?, credential_id? }
// Subject to the global express.json body limit (10mb) — effective payload
// ceiling ≈7 MB of file bytes. Larger files: use save-url or upload-link.
router.post('/api/dropbox/upload', jwtOrApiKey, async (req, res) => {
  try {
    const { path, shared_link, filename, subfolder, content_base64,
            mode, autorename, credential_id } = req.body || {};
    if (!content_base64) {
      return res.status(400).json({ status: 'error', message: 'content_base64 is required' });
    }

    const metadata = await dropbox.uploadFile(req.db, {
      path,
      sharedLink: shared_link,
      filename,
      subfolder,
      content: Buffer.from(content_base64, 'base64'),
      ...(mode       !== undefined && { mode }),
      ...(autorename !== undefined && { autorename: autorename === true }),
      credentialId: coerceCredId(credential_id),
    });
    res.json({ status: 'success', metadata });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── DOWNLOAD ───
// Body: { path? | shared_link?, credential_id? }
// Responds with raw bytes (Content-Disposition from Dropbox metadata name).
router.post('/api/dropbox/download', jwtOrApiKey, async (req, res) => {
  try {
    const { path, shared_link, credential_id } = req.body || {};
    const { buffer, metadata } = await dropbox.downloadFile(req.db, {
      path,
      sharedLink: shared_link,
      credentialId: coerceCredId(credential_id),
    });

    const name = metadata?.name || 'download';
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    if (metadata) res.set('X-Dropbox-Metadata', dropbox.httpHeaderSafeJson(metadata));
    res.send(buffer);
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;