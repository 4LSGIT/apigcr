// services/dropboxService.js
//
/**
 * Dropbox Service (native — Connections-based)
 * services/dropboxService.js
 *
 * Native Dropbox API v2 client, replacing both:
 *   - services/dropboxServiceLegacy.js (env-var refresh-token auth), and
 *   - the Pabbly 'create_dropbox_folder' bridge (intake case creation).
 *
 * Auth is via the Connections system: an oauth2 credential row. Outbound
 * headers are built with buildHeadersForCredential (the async builder — the
 * sync buildAuthHeaders returns {} for oauth2 and silently breaks; see
 * AI_CONTEXT §21).
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ allowed_urls REQUIREMENT                                          │
 *   │                                                                   │
 *   │ The credential's allowed_urls JSON MUST cover BOTH API hosts:     │
 *   │   "https://api.dropboxapi.com/*"      (RPC endpoints)             │
 *   │   "https://content.dropboxapi.com/*"  (upload/download)           │
 *   │ If a host is missing, checkUrlScope rejects, the injector returns │
 *   │ {}, and every call here fails with a "no Authorization header"    │
 *   │ error. Fix the data, not the code. (Credential 8 already lists    │
 *   │ both, plus notify.dropboxapi.com.)                                │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Credential selection (params-first, app_settings fallback, hard default):
 *   credentialId : opts.credentialId
 *               ?? app_settings 'dropbox_credential_id'
 *               ?? DEFAULT_CREDENTIAL_ID (8 = "DropBox")
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ SPACES IN PATHS ARE SIGNIFICANT — DO NOT TRIM                     │
 *   │                                                                   │
 *   │ The firm's Dropbox uses leading/embedded spaces in folder and     │
 *   │ file names as a manual sort convention, e.g.                      │
 *   │   "/  Law Office/   Cases/  Potential Cases/  Potential - Bk"     │
 *   │   " John Smith - 123 - 2026-06-04 10:00"                          │
 *   │ normalizePath() and joinPath() therefore only fix SLASHES         │
 *   │ (ensure leading, collapse doubles, strip trailing) and never      │
 *   │ trim, collapse, or otherwise touch whitespace. Any future helper  │
 *   │ added here must preserve that invariant.                          │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * SHARED-LINK-AS-HANDLE PATTERN
 *   When a case folder is created, a public shared link is generated and
 *   stored on the case row (cases.case_dropbox). Staff freely move/rename
 *   folders; the shared link keeps resolving to the folder. So every
 *   location-taking operation here accepts EITHER:
 *     opts.path        — a literal Dropbox path, OR
 *     opts.sharedLink  — a dropbox.com shared link, resolved to the live
 *                        path via sharing/get_shared_link_metadata.
 *   Exactly one must be provided. Resolution costs one extra API call.
 *
 * Cloud Run notes:
 *   - No module-level token cache or state — every call builds headers via
 *     the injector (oauthService caches/refreshes against the DB), so
 *     multiple instances behave identically.
 *   - URL-to-Dropbox transfers use files/save_url, which runs ON DROPBOX'S
 *     side (async job) — bytes never transit this instance. Prefer it over
 *     uploadFile for anything fetched from a URL or larger than a few MB.
 *   - uploadFile is single-shot /files/upload (Dropbox cap 150 MB), intended
 *     for small in-memory payloads (generated PDFs etc.). No upload_session
 *     chunking in v1.
 *
 * All functions throw Error on failure. Thrown errors carry .status (HTTP)
 * and .errorSummary (Dropbox error_summary) when available, and messages are
 * shaped "dropbox: POST /2/<endpoint> → <status>: <detail>" so the route's
 * mapErrorStatus can pass client-error codes through (same scheme as gcal).
 */

const { buildHeadersForCredential } = require('../lib/credentialInjection');

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

const RPC_BASE     = 'https://api.dropboxapi.com/2';
const CONTENT_BASE = 'https://content.dropboxapi.com/2';

const RPC_TIMEOUT_MS     = 30000;
const CONTENT_TIMEOUT_MS = 120000;

// Hard fallback if neither opts nor app_settings provide a value.
// Credential 8 = "DropBox" (oauth2, connected). Prefer the app_settings
// binding ('dropbox_credential_id') so this can change without a deploy.
const DEFAULT_CREDENTIAL_ID = 8;

// saveUrl polling defaults (files/save_url is async on Dropbox's side)
const SAVE_URL_POLL_MS    = 1500;
const SAVE_URL_TIMEOUT_MS = 25000;

// ─────────────────────────────────────────────────────────────
// Path helpers — slash-only normalization; SPACES ARE PRESERVED.
// ─────────────────────────────────────────────────────────────

/**
 * Normalize a Dropbox path:
 *   - ensure a leading slash
 *   - collapse runs of slashes ("//" → "/"; safe, "/" is illegal in names)
 *   - strip a single trailing slash
 *   - "/" (root) normalizes to "" — the Dropbox API's root convention
 * NEVER trims or alters whitespace (firm sort-by-spaces convention).
 */
function normalizePath(p) {
  if (p == null) return '';
  let s = String(p);
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (s === '/') return '';
  return s;
}

/**
 * Join a base path with additional segments. Segments may carry leading
 * spaces (preserved). Empty/nullish segments are skipped.
 */
function joinPath(base, ...segments) {
  let out = normalizePath(base);
  for (const seg of segments) {
    if (seg == null || seg === '') continue;
    out = normalizePath(`${out}/${seg}`);
  }
  return out;
}

/**
 * JSON for the Dropbox-API-Arg HTTP header: non-ASCII chars must be
 * \uXXXX-escaped to stay header-safe (Dropbox requirement).
 */
function httpHeaderSafeJson(obj) {
  return JSON.stringify(obj).replace(
    /[\u007f-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  );
}

// ─────────────────────────────────────────────────────────────
// Credential / request core
// ─────────────────────────────────────────────────────────────

/**
 * Resolve the credential id for a call. opts wins, then app_settings
 * 'dropbox_credential_id', then the hard default.
 */
async function _resolveCredential(db, opts = {}) {
  if (opts.credentialId != null) return opts.credentialId;
  try {
    const [[row]] = await db.query(
      "SELECT `value` FROM app_settings WHERE `key` = 'dropbox_credential_id' LIMIT 1"
    );
    if (row?.value != null && row.value !== '') return row.value;
  } catch (err) {
    console.warn(`[DROPBOX] app_settings lookup failed, using default: ${err.message}`);
  }
  return DEFAULT_CREDENTIAL_ID;
}

async function _authHeaders(db, credentialId, url) {
  let headers;
  try {
    headers = await buildHeadersForCredential(db, credentialId, url);
  } catch (err) {
    throw new Error(`dropbox: failed to build auth headers for credential ${credentialId}: ${err.message}`);
  }
  if (!headers || !headers.Authorization) {
    throw new Error(
      `dropbox: no Authorization header for credential ${credentialId} — ` +
      `credential not connected, or URL ${url} is out of allowed_urls scope ` +
      `(needs https://api.dropboxapi.com/* and https://content.dropboxapi.com/*)`
    );
  }
  return headers;
}

function _mkError(method, endpoint, status, detail, parsed) {
  const err = new Error(`dropbox: ${method} /2/${endpoint} → ${status}: ${detail}`);
  err.status = status;
  err.errorSummary = parsed?.error_summary || null;
  err.dropboxError = parsed?.error || null;
  return err;
}

/**
 * RPC-endpoint request (api.dropboxapi.com). JSON in, JSON out.
 * Throws on non-2xx with .status / .errorSummary attached.
 */
async function _rpc(db, credentialId, endpoint, body, { timeoutMs = RPC_TIMEOUT_MS } = {}) {
  const url = `${RPC_BASE}/${endpoint}`;
  const authHeaders = await _authHeaders(db, credentialId, url);

  const controller = new AbortController();
  const tHandle = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? null),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`dropbox: request to /2/${endpoint} failed: ${err.message}`);
  } finally {
    clearTimeout(tHandle);
  }

  const text = await res.text();
  let parsed = null;
  if (text) { try { parsed = JSON.parse(text); } catch { /* non-JSON */ } }

  if (!res.ok) {
    const detail = parsed?.error_summary || (text ? text.slice(0, 500) : '(empty body)');
    throw _mkError('POST', endpoint, res.status, detail, parsed);
  }
  return parsed;
}

/**
 * Content-endpoint request (content.dropboxapi.com). Args travel in the
 * Dropbox-API-Arg header; body is raw bytes (upload) or empty (download).
 * mode: 'upload' → returns parsed JSON metadata.
 *       'download' → returns { buffer, metadata } (metadata from the
 *                    dropbox-api-result response header).
 */
async function _content(db, credentialId, endpoint, arg, { mode, body, timeoutMs = CONTENT_TIMEOUT_MS } = {}) {
  const url = `${CONTENT_BASE}/${endpoint}`;
  const authHeaders = await _authHeaders(db, credentialId, url);

  const headers = { ...authHeaders, 'Dropbox-API-Arg': httpHeaderSafeJson(arg) };
  if (mode === 'upload') headers['Content-Type'] = 'application/octet-stream';
  // download: no Content-Type, no body (Dropbox rejects unexpected types)

  const controller = new AbortController();
  const tHandle = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      ...(mode === 'upload' && { body }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`dropbox: request to /2/${endpoint} failed: ${err.message}`);
  } finally {
    clearTimeout(tHandle);
  }

  if (!res.ok) {
    const text = await res.text();
    let parsed = null;
    if (text) { try { parsed = JSON.parse(text); } catch { /* */ } }
    const detail = parsed?.error_summary || (text ? text.slice(0, 500) : '(empty body)');
    throw _mkError('POST', endpoint, res.status, detail, parsed);
  }

  if (mode === 'download') {
    const buffer = Buffer.from(await res.arrayBuffer());
    let metadata = null;
    const raw = res.headers.get('dropbox-api-result');
    if (raw) { try { metadata = JSON.parse(raw); } catch { /* */ } }
    return { buffer, metadata };
  }

  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────
// Location resolution (path vs shared link)
// ─────────────────────────────────────────────────────────────

/**
 * Resolve { path | sharedLink } to a literal Dropbox path.
 *   - path: normalized and returned (no API call).
 *   - sharedLink: sharing/get_shared_link_metadata → path_lower. Dropbox
 *     paths are case-insensitive, so path_lower is a valid handle; spaces
 *     are preserved in it.
 * expectFolder: when true, a shared link resolving to a file throws —
 * used by operations that compose "<folder>/<filename>".
 *
 * @returns {Promise<string>} resolved path ('' = root)
 */
async function resolveLocation(db, credentialId, { path, sharedLink, expectFolder = false } = {}) {
  const hasPath = typeof path === 'string' && path !== '';
  const hasLink = typeof sharedLink === 'string' && sharedLink !== '';

  if (hasPath && hasLink) throw new Error('dropbox: provide path OR sharedLink, not both');
  if (!hasPath && !hasLink) throw new Error('dropbox: provide path or sharedLink');

  if (hasPath) return normalizePath(path);

  const meta = await _rpc(db, credentialId, 'sharing/get_shared_link_metadata', { url: sharedLink });
  if (expectFolder && meta['.tag'] !== 'folder') {
    throw new Error(`dropbox: shared link resolves to a ${meta['.tag']}, expected a folder`);
  }
  if (!meta.path_lower) {
    throw new Error('dropbox: shared link metadata has no path_lower (link may target content outside this account)');
  }
  return normalizePath(meta.path_lower);
}

/**
 * Compose a destination FILE path from either:
 *   - opts.path        — full destination path including filename, OR
 *   - opts.sharedLink  — folder shared link + opts.filename
 *                        (+ optional opts.subfolder under the folder)
 * Filenames/subfolders keep leading spaces (firm convention).
 */
async function _resolveDestFile(db, credentialId, opts = {}) {
  const { path, sharedLink, filename, subfolder } = opts;
  if (path) {
    if (filename) throw new Error('dropbox: provide a full destination path OR sharedLink+filename, not path+filename');
    return normalizePath(path);
  }
  if (!sharedLink) throw new Error('dropbox: provide path or sharedLink');
  if (!filename)   throw new Error('dropbox: filename is required with sharedLink');
  const folder = await resolveLocation(db, credentialId, { sharedLink, expectFolder: true });
  return joinPath(folder, subfolder, filename);
}

// ─────────────────────────────────────────────────────────────
// Folders & shared links
// ─────────────────────────────────────────────────────────────

/**
 * Create a folder (idempotent). A pre-existing FOLDER at the path is
 * success ({existed:true}); a conflicting FILE at the path throws.
 * (The legacy service treated any 409 as "exists" — this is stricter.)
 *
 * @param {object} db
 * @param {object} opts — { path (required), credentialId? }
 * @returns {Promise<{path:string, existed:boolean, metadata?:object}>}
 */
async function createFolder(db, opts = {}) {
  const credentialId = await _resolveCredential(db, opts);
  const path = normalizePath(opts.path);
  if (!path) throw new Error('dropbox createFolder requires a non-root path');

  try {
    const result = await _rpc(db, credentialId, 'files/create_folder_v2', { path, autorename: false });
    return { path, existed: false, metadata: result?.metadata };
  } catch (err) {
    if (err.status === 409 && String(err.errorSummary || '').startsWith('path/conflict/folder')) {
      return { path, existed: true };
    }
    throw err;
  }
}

/**
 * Create subfolders under a base path. Sequential and idempotent.
 * Subfolder strings may be nested ("Images/Raw") and may carry leading
 * spaces — preserved as-is.
 */
async function createSubfolders(db, opts = {}) {
  const { subfolders = [] } = opts;
  const credentialId = await _resolveCredential(db, opts);
  const base = normalizePath(opts.path);
  if (!base) throw new Error('dropbox createSubfolders requires a non-root path');

  const created = [];
  for (const sub of subfolders) {
    if (!sub || typeof sub !== 'string') continue;
    const r = await createFolder(db, { credentialId, path: joinPath(base, sub) });
    created.push({ path: r.path, existed: r.existed });
  }
  return created;
}

/**
 * Get an existing direct shared link for a path, or create one.
 * Handles the create-race (409 shared_link_already_exists).
 *
 * @returns {Promise<string>} the shared link URL
 */
async function getOrCreateSharedLink(db, opts = {}) {
  const credentialId = await _resolveCredential(db, opts);
  const path = normalizePath(opts.path);
  if (!path) throw new Error('dropbox getOrCreateSharedLink requires a non-root path');

  const listData = await _rpc(db, credentialId, 'sharing/list_shared_links', { path, direct_only: true });
  if (listData?.links?.length) return listData.links[0].url;

  try {
    const created = await _rpc(db, credentialId, 'sharing/create_shared_link_with_settings', {
      path,
      settings: { requested_visibility: 'public' },
    });
    return created.url;
  } catch (err) {
    // Race: link created between our list and create calls. The error
    // payload usually carries the existing link's metadata.
    if (err.status === 409 && String(err.errorSummary || '').startsWith('shared_link_already_exists')) {
      const existing = err.dropboxError?.shared_link_already_exists?.metadata?.url;
      if (existing) return existing;
      const retry = await _rpc(db, credentialId, 'sharing/list_shared_links', { path, direct_only: true });
      if (retry?.links?.length) return retry.links[0].url;
    }
    throw err;
  }
}

/**
 * Resolve a shared link to its metadata (path_lower, .tag, name, ...).
 */
async function getSharedLinkMetadata(db, opts = {}) {
  const credentialId = await _resolveCredential(db, opts);
  if (!opts.url) throw new Error('dropbox getSharedLinkMetadata requires url');
  return _rpc(db, credentialId, 'sharing/get_shared_link_metadata', { url: opts.url });
}

/**
 * One-call case-folder bootstrap: create folder (+ optional subfolders),
 * optionally create/reuse a public shared link. This is the native
 * replacement for the Pabbly 'create_dropbox_folder' flow — the returned
 * shared_link is what gets stored in cases.case_dropbox.
 *
 * @param {object} opts — { path, subfolders?, shareLink?, credentialId? }
 * @returns {Promise<{path, existed, subfolders_created, shared_link}>}
 */
async function createFolderWithOptions(db, opts = {}) {
  const credentialId = await _resolveCredential(db, opts);
  const { subfolders = [], shareLink = false } = opts;
  const path = normalizePath(opts.path);

  const base = await createFolder(db, { credentialId, path });

  let subfolders_created = [];
  if (Array.isArray(subfolders) && subfolders.length) {
    subfolders_created = await createSubfolders(db, { credentialId, path, subfolders });
  }

  let shared_link = null;
  if (shareLink === true) {
    shared_link = await getOrCreateSharedLink(db, { credentialId, path });
  }

  return { path, existed: base.existed, subfolders_created, shared_link };
}

// ─────────────────────────────────────────────────────────────
// Listing
// ─────────────────────────────────────────────────────────────

/**
 * List a folder's entries, auto-paginating via list_folder/continue up to
 * maxEntries (default 2000).
 *
 * @param {object} opts — { path? | sharedLink?, recursive?, maxEntries?, credentialId? }
 *   path '' or '/' = root.
 * @returns {Promise<{entries:object[], count:number, truncated:boolean}>}
 */
async function listFolder(db, opts = {}) {
  const credentialId = await _resolveCredential(db, opts);
  const maxEntries = Number(opts.maxEntries) > 0 ? Number(opts.maxEntries) : 2000;

  // Root listing is legal here (path '' after normalize) — allow path === ''
  // explicitly rather than routing through resolveLocation's non-empty check.
  let path;
  if (opts.sharedLink) {
    path = await resolveLocation(db, credentialId, { sharedLink: opts.sharedLink, expectFolder: true });
  } else {
    path = normalizePath(opts.path ?? '');
  }

  let result = await _rpc(db, credentialId, 'files/list_folder', {
    path,
    recursive: opts.recursive === true,
    limit: Math.min(maxEntries, 2000),
  });

  const entries = [...(result.entries || [])];
  while (result.has_more && entries.length < maxEntries) {
    result = await _rpc(db, credentialId, 'files/list_folder/continue', { cursor: result.cursor });
    entries.push(...(result.entries || []));
  }

  const truncated = Boolean(result.has_more) || entries.length > maxEntries;
  return { entries: entries.slice(0, maxEntries), count: Math.min(entries.length, maxEntries), truncated };
}

// ─────────────────────────────────────────────────────────────
// Move / rename / delete
// ─────────────────────────────────────────────────────────────

/**
 * Move a file/folder. Source addressed by fromPath OR fromSharedLink
 * (the case-folder pattern: link survives prior moves/renames).
 *
 * @param {object} opts — { fromPath? | fromSharedLink?, toPath, autorename?, credentialId? }
 * @returns {Promise<object>} relocation result (.metadata = new entry)
 */
async function movePath(db, opts = {}) {
  const credentialId = await _resolveCredential(db, opts);
  if (!opts.toPath) throw new Error('dropbox movePath requires toPath');

  const from_path = await resolveLocation(db, credentialId, {
    path: opts.fromPath, sharedLink: opts.fromSharedLink,
  });
  if (!from_path) throw new Error('dropbox: refusing to move root');
  const to_path = normalizePath(opts.toPath);
  if (!to_path) throw new Error('dropbox: refusing to move to root path');

  return _rpc(db, credentialId, 'files/move_v2', {
    from_path,
    to_path,
    autorename: opts.autorename === true,
  });
}

/**
 * Rename a file/folder in place (move within the same parent).
 * newName may carry leading spaces — preserved.
 *
 * @param {object} opts — { path? | sharedLink?, newName, credentialId? }
 */
async function renamePath(db, opts = {}) {
  const credentialId = await _resolveCredential(db, opts);
  if (!opts.newName || typeof opts.newName !== 'string') {
    throw new Error('dropbox renamePath requires newName');
  }
  if (opts.newName.includes('/')) {
    throw new Error('dropbox renamePath: newName must not contain "/" — use movePath to relocate');
  }

  const current = await resolveLocation(db, credentialId, {
    path: opts.path, sharedLink: opts.sharedLink,
  });
  if (!current) throw new Error('dropbox: refusing to rename root');

  const idx = current.lastIndexOf('/');
  const parent = current.slice(0, idx); // '' when item sits at root
  const to_path = `${parent}/${opts.newName}`;

  return _rpc(db, credentialId, 'files/move_v2', {
    from_path: current,
    to_path,
    autorename: false,
  });
}

/**
 * Delete a file/folder. Refuses root.
 *
 * @param {object} opts — { path? | sharedLink?, credentialId? }
 * @returns {Promise<{deleted:true, path:string}>}
 */
async function deletePath(db, opts = {}) {
  const credentialId = await _resolveCredential(db, opts);
  const path = await resolveLocation(db, credentialId, {
    path: opts.path, sharedLink: opts.sharedLink,
  });
  if (!path) throw new Error('dropbox: refusing to delete root path');

  await _rpc(db, credentialId, 'files/delete_v2', { path });
  return { deleted: true, path };
}

// ─────────────────────────────────────────────────────────────
// Uploads (client-direct, URL-pull, in-memory) & download
// ─────────────────────────────────────────────────────────────

/**
 * Temporary upload link — lets a browser PUT file bytes straight to
 * Dropbox without transiting our server (Cloud Run friendly). Used by the
 * public docReq flow.
 *
 * Destination = (path | sharedLink-resolved folder) [+ subfolder] + filename.
 * NOTE: unlike the legacy service, "Client Uploads" is NOT hardcoded —
 * pass subfolder:'Client Uploads' at the call site to keep that behavior.
 *
 * @param {object} opts — { path? | sharedLink?, filename, subfolder?,
 *                          duration?, credentialId? }
 *   duration: link validity in seconds, 60–14400 (default 7200).
 * @returns {Promise<{link:string, path:string}>}
 */
async function getTemporaryUploadLink(db, opts = {}) {
  const credentialId = await _resolveCredential(db, opts);
  const { filename, subfolder, duration = 7200 } = opts;
  if (!filename) throw new Error('dropbox getTemporaryUploadLink requires filename');

  const folder = await resolveLocation(db, credentialId, {
    path: opts.path, sharedLink: opts.sharedLink, expectFolder: Boolean(opts.sharedLink),
  });
  const fullPath = joinPath(folder, subfolder, filename);

  const result = await _rpc(db, credentialId, 'files/get_temporary_upload_link', {
    commit_info: { path: fullPath, mode: 'add', autorename: true },
    duration,
  });
  return { link: result.link, path: fullPath };
}

/**
 * Pull a file FROM A URL into Dropbox via files/save_url. The transfer
 * runs on Dropbox's infrastructure — bytes never touch this instance,
 * which is the right shape for Cloud Run. The job is async; by default we
 * poll check_job_status until completion (or ~25s), returning
 * {status:'in_progress', async_job_id} if it's still running at timeout —
 * callers can finish via checkSaveUrlJob.
 *
 * Destination: full opts.path (incl. filename) OR opts.sharedLink +
 * opts.filename (+ optional opts.subfolder).
 *
 * @param {object} opts — { url, path? | sharedLink?+filename, subfolder?,
 *                          wait?, timeoutMs?, credentialId? }
 * @returns {Promise<{status:'complete'|'in_progress', path:string,
 *                    metadata?:object, async_job_id?:string}>}
 */
async function saveUrl(db, opts = {}) {
  const credentialId = await _resolveCredential(db, opts);
  if (!opts.url) throw new Error('dropbox saveUrl requires url');

  const destPath = await _resolveDestFile(db, credentialId, opts);
  const result = await _rpc(db, credentialId, 'files/save_url', { path: destPath, url: opts.url });

  if (result['.tag'] === 'complete') {
    return { status: 'complete', path: destPath, metadata: result };
  }

  const async_job_id = result.async_job_id;
  if (opts.wait === false) return { status: 'in_progress', path: destPath, async_job_id };

  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : SAVE_URL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, SAVE_URL_POLL_MS));
    const job = await checkSaveUrlJob(db, { credentialId, asyncJobId: async_job_id });
    if (job.status === 'complete') return { status: 'complete', path: destPath, metadata: job.metadata };
    if (job.status === 'failed') {
      throw new Error(`dropbox saveUrl failed: ${job.reason || 'unknown reason'} (url=${opts.url})`);
    }
  }
  return { status: 'in_progress', path: destPath, async_job_id };
}

/**
 * Check a files/save_url job.
 * @param {object} opts — { asyncJobId, credentialId? }
 * @returns {Promise<{status:'in_progress'|'complete'|'failed',
 *                    metadata?:object, reason?:string}>}
 */
async function checkSaveUrlJob(db, opts = {}) {
  const credentialId = await _resolveCredential(db, opts);
  if (!opts.asyncJobId) throw new Error('dropbox checkSaveUrlJob requires asyncJobId');

  const result = await _rpc(db, credentialId, 'files/save_url/check_job_status', {
    async_job_id: opts.asyncJobId,
  });
  const tag = result['.tag'];
  if (tag === 'in_progress') return { status: 'in_progress' };
  if (tag === 'complete')    return { status: 'complete', metadata: result };
  if (tag === 'failed') {
    const f = result.failed;
    return { status: 'failed', reason: typeof f === 'object' ? (f['.tag'] || JSON.stringify(f)) : String(f) };
  }
  return { status: tag || 'unknown' };
}

/**
 * Single-shot in-memory upload (≤150 MB API cap; intended for small
 * payloads like generated PDFs). For URL sources or large files use
 * saveUrl instead — it doesn't transit this instance.
 *
 * @param {object} opts — { path? | sharedLink?+filename, subfolder?,
 *                          content (Buffer|string), mode?, autorename?,
 *                          credentialId? }
 *   mode: 'add' (default) | 'overwrite'
 * @returns {Promise<object>} the file metadata
 */
async function uploadFile(db, opts = {}) {
  const credentialId = await _resolveCredential(db, opts);
  const { content, mode = 'add', autorename = true } = opts;
  if (content == null) throw new Error('dropbox uploadFile requires content');

  const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const destPath = await _resolveDestFile(db, credentialId, opts);

  return _content(db, credentialId, 'files/upload',
    { path: destPath, mode, autorename, mute: false },
    { mode: 'upload', body }
  );
}

/**
 * Download a file's bytes.
 *
 * @param {object} opts — { path? | sharedLink?, credentialId? }
 * @returns {Promise<{buffer:Buffer, metadata:object|null}>}
 */
async function downloadFile(db, opts = {}) {
  const credentialId = await _resolveCredential(db, opts);
  const path = await resolveLocation(db, credentialId, {
    path: opts.path, sharedLink: opts.sharedLink,
  });
  if (!path) throw new Error('dropbox downloadFile requires a non-root path');

  return _content(db, credentialId, 'files/download', { path }, { mode: 'download' });
}

module.exports = {
  // path helpers
  normalizePath,
  joinPath,
  // folders & links
  createFolder,
  createSubfolders,
  createFolderWithOptions,
  getOrCreateSharedLink,
  getSharedLinkMetadata,
  resolveLocation,
  // listing
  listFolder,
  // move/rename/delete
  movePath,
  renamePath,
  deletePath,
  // uploads & download
  getTemporaryUploadLink,
  saveUrl,
  checkSaveUrlJob,
  uploadFile,
  downloadFile,
  // exported for testing / reuse
  _resolveCredential,
  httpHeaderSafeJson,
};