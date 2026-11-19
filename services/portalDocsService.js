// services/portalDocsService.js
//
/**
 * portalDocsService.js — Client Portal Slice 3: per-case document checklist
 * + client uploads, behind portal auth.
 *
 * Backs routes/portal.docs.js. The AUTHENTICATED sibling of the public
 * docReq flow in routes/api.checklists.js (GET /api/public/docs/:caseId,
 * POST /api/public/get-upload-link, POST /api/public/upload-complete) —
 * which remains live. Mechanics parity notes:
 *
 *   - Uploads are DROPBOX temporary upload links (NOT GCS): browser POSTs
 *     file bytes straight to Dropbox via files/get_temporary_upload_link.
 *     File bytes never transit this instance (Cloud Run posture).
 *   - WHERE they land is the upload-target ladder, SHARED with the public
 *     flow (services/uploadTargetService.js): the case's folder link
 *     folder (subfolder 'Client Uploads') → an auto-created case folder →
 *     the unsorted client-uploads folder. A client always has a way to
 *     upload; the old "uploads aren't available" dead end is gone.
 *   - Per-file reporting (docs intake S3): the page reports each file as it
 *     lands (recordLanded → services/clientUploadBatchService.landed) under
 *     a batch key minted per run, and sends the key on upload-complete; a
 *     batch the page never finished is reported by the /process-jobs sweep.
 *   - Completion is a NOTIFICATION step (email + case log). It does NOT
 *     mutate checkitem status — checkitems.status is enum
 *     ('incomplete','complete') and 'complete' is a STAFF verdict (staff
 *     verify the uploaded file actually satisfies the item). The portal
 *     mirrors that: uploads never auto-complete items.
 *
 * What S3 ADDS over the public flow (binding slice decisions):
 *   - Real scope: contactId + caseId via case_relate (Primary/Secondary),
 *     not case_id-as-bearer. Out-of-scope == nonexistent (null → route 404).
 *   - Server-side upload limits at LINK ISSUANCE: extension allowlist +
 *     size cap on the DECLARED filename/size. Honest limitation, flagged:
 *     with browser→Dropbox direct upload the server never sees the bytes,
 *     so declared-metadata enforcement at issuance is the strongest gate
 *     available without proxying uploads through this instance. The
 *     extension allowlist is the canonical check (matches docReq.html's
 *     published client-side rules); contentType is accepted but advisory.
 *   - Optional per-item association (itemId): validated to belong to THIS
 *     case's docs checklist (tag='docs_needed'); foreign/unknown itemId on link
 *     issuance → 404-shaped error (no item-id probing oracle). itemId is
 *     OPTIONAL — clients also upload documents that don't map to a listed
 *     item ("Other documents"), same capability the public flow has.
 *
 * Projection whitelists only (portal contract):
 *   - Item payload is EXACTLY { id, name, status } — status mapped to
 *     client vocabulary ('needed'|'received'); the raw enum strings, tag
 *     (staff annotation), position, checklist_id, dates, and every
 *     checklist-level column (created_by is an internal user id, title,
 *     tag, status) stay server-side.
 *   - the case folder link NEVER leaves the server — the client gets a boolean
 *     has_upload; the Dropbox shared link itself is staff-facing.
 *     has_upload is now ALWAYS true (the ladder guarantees a destination);
 *     the field survives for page-contract compatibility.
 *
 * escapeHtml is a deliberate FILE-LOCAL copy — repo convention
 * (routes/api.checklists.js:36-49, services/taskService.js,
 * services/eventService.js each carry their own). Keep in sync.
 *
 * Conventions: every function takes the mysql2 pool (req.db) first; scope
 * failure returns null (route → uniform 404); validation failures throw
 * errors carrying .status (400, or 404 for foreign itemId) and
 * .portalCaseId (canonical casing — the route attributes the access-log
 * row even for rejected requests).
 */

'use strict';

const uploadTarget = require('./uploadTargetService');
// Lazy (convention: the batch service lazy-requires the completion phase).
const uploadBatches = () => require('./clientUploadBatchService');

// ─────────────────────────────────────────────────────────────────────────────
// LIMITS (S3 — proposed values, enforced server-side; see slice report)
// ─────────────────────────────────────────────────────────────────────────────

// Exactly the set docReq.html already promises clients ("Accepted: PDF, Word,
// Excel, images, and text files") — narrowing would reject types the firm
// accepts today (doc/xls creditor letters and statements are routine in BK).
const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt',
  'jpg', 'jpeg', 'png', 'gif', 'tif', 'tiff', 'bmp', 'heic', 'webp',
  'rtf', 'odt', 'ods',
]);

// docReq.html's published "Max 50 MB per file" — well inside the Dropbox
// single-POST cap (150 MB).
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// Caps on complete-step input — same numbers as the public route's
// MAX_UPLOAD_* constants (api.checklists.js:64-66). Keep in sync.
const MAX_UPLOAD_FILES    = 50;
const MAX_UPLOAD_FILENAME = 255;
const MAX_UPLOAD_COMMENT  = 2000;

// Notification recipient: `email_attachments_reviewer` (services/docsReviewerService)
// since 2026-11-19 — the same person every docs door tells. The upload pages'
// own `portal_docs_notify_to` is retired (ref/migrations/2026-11-19_docs_reviewer.sql).
// Unset ⇒ the email is skipped with a console warning; the case-log row still writes.

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** HTML-escape for notification email bodies. File-local by repo convention
 *  (see header). MIME subjects are NOT escaped — HTML bodies only. */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Error carrying an HTTP status + canonical case id for access-log
 *  attribution on rejected requests. */
function httpError(status, message, portalCaseId) {
  const err = new Error(message);
  err.status = status;
  if (portalCaseId) err.portalCaseId = portalCaseId;
  return err;
}

/** Filename sanitizer — same rules as the public get-upload-link route
 *  (api.checklists.js:409-413): strip path separators and leading dots,
 *  cap at 200. Keep in sync. */
function sanitizeFilename(filename) {
  return String(filename).replace(/[\/\\]/g, '_').replace(/^\.+/, '').slice(0, 200)
    || 'upload.dat';
}

/** Lowercased extension of a filename ('' when none). */
function extOf(name) {
  const s = String(name);
  const dot = s.lastIndexOf('.');
  if (dot < 0 || dot === s.length - 1) return '';
  return s.slice(dot + 1).toLowerCase();
}

/** Internal enum → client vocabulary. Server-side so wording can change
 *  without touching the page, and raw enum strings never leave. */
function clientStatus(status) {
  return status === 'complete' ? 'received' : 'needed';
}

// ─────────────────────────────────────────────────────────────────────────────
// SCOPE
// ─────────────────────────────────────────────────────────────────────────────

// Same scope rule as services/portalCaseService.js (S2): the contact's
// cases related as Primary or Secondary (Other/Bystander are staff-side).
// Self-contained here — S3 runs parallel to the E1 slice which owns
// portalCaseService.js; sharing a query constant across the merge window
// would couple the two worktrees. Join is by value equality
// (case_relate_case_id varchar(8) vs cases.case_id varchar(20) —
// historical, works, leave it alone). Projection whitelist ONLY.
async function _scopedCaseRow(db, contactId, caseId) {
  const [[row]] = await db.query(
    `SELECT c.case_id,
            COALESCE(c.case_number_full, c.case_number, c.case_id) AS case_display
       FROM case_relate cr
       JOIN cases c ON c.case_id = cr.case_relate_case_id
      WHERE cr.case_relate_client_id = ?
        AND cr.case_relate_case_id = ?
        AND cr.case_relate_type IN ('Primary','Secondary')
      LIMIT 1`,
    [contactId, caseId]
  );
  return row || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// listDocs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The case's client-facing document checklist.
 *
 * Source scope matches the public docs GET: checklists with
 * link_type='case', link=<case>, tag='docs_needed'. The TAG is the
 * client-facing guarantee — every other checklist on the case is a staff
 * surface and never reaches the client. Do not read the title as identity:
 * it is staff-editable in checklistView.html, so cases legitimately carry many
 * differently-titled checklists, and a docs checklist may be retitled
 * without ceasing to be one. (The title='Docs Needed' arm of the WHERE
 * below is a transition fallback for rows predating tag coverage, not a
 * second identity; drop it once every case checklist has a tag.)
 *
 * UNLIKE the public GET (incomplete-only), the portal shows ALL items with
 * a mapped status so clients see progress — completed items expose nothing
 * new (the client saw those names while they were incomplete) plus a
 * positive status.
 *
 * @returns {Promise<{case_id:string, has_upload:boolean,
 *   items:{id:number, name:string, status:'needed'|'received'}[]} | null>}
 *   null = out of scope / nonexistent (route → uniform 404).
 */
async function listDocs(db, contactId, caseId) {
  const caseRow = await _scopedCaseRow(db, contactId, caseId);
  if (!caseRow) return null;

  const [rows] = await db.query(
    `SELECT ci.id, ci.name, ci.status
       FROM checkitems ci
       JOIN checklists cl ON cl.id = ci.checklist_id
      WHERE cl.link_type = 'case'
        AND cl.link = ?
        AND (cl.tag = 'docs_needed' OR cl.title = 'Docs Needed')
      ORDER BY ci.position ASC, ci.id ASC`,
    [caseRow.case_id]
  );

  return {
    case_id: caseRow.case_id,
    // Always true since the upload-target ladder (uploadTargetService)
    // guarantees a destination. Kept for the page contract.
    has_upload: true,
    items: rows.map(r => ({
      id: r.id,
      name: r.name,
      status: clientStatus(r.status),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// createUploadLink
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Item ids that belong to THIS case's docs checklist(s) (tag='docs_needed'), as a
 * Map(id → name). Used for the belongs-to-case gate and for resolving item
 * names in notifications (names come from the DB, never from the client).
 */
async function _caseItemMap(db, canonicalCaseId, itemIds) {
  const ids = [...new Set(itemIds)].filter(n => Number.isInteger(n) && n > 0);
  if (!ids.length) return new Map();
  const [rows] = await db.query(
    `SELECT ci.id, ci.name
       FROM checkitems ci
       JOIN checklists cl ON cl.id = ci.checklist_id
      WHERE ci.id IN (?)
        AND cl.link_type = 'case'
        AND cl.link = ?
        AND (cl.tag = 'docs_needed' OR cl.title = 'Docs Needed')`,
    [ids, canonicalCaseId]
  );
  return new Map(rows.map(r => [r.id, r.name]));
}

/**
 * Scope + limit gate, then a Dropbox temporary upload link (same mechanics
 * as the public route: sharedLink = the case folder link, subfolder
 * 'Client Uploads'; the browser POSTs the bytes straight to Dropbox).
 *
 * @param {object} opts
 *   itemId       optional int — must belong to this case (404-shaped
 *                error otherwise; no probing oracle).
 *   filename     required — sanitized; extension must be allowlisted.
 *   size         required — declared byte size, 1..MAX_FILE_SIZE.
 *   contentType  optional, advisory (extension is the canonical check).
 * @returns {Promise<{case_id:string, link:string} | null>}
 *   null = out of scope. Throws .status 400/404 errors otherwise.
 */
async function createUploadLink(db, contactId, caseId, opts = {}) {
  const caseRow = await _scopedCaseRow(db, contactId, caseId);
  if (!caseRow) return null;
  const cid = caseRow.case_id;

  const { itemId, filename, size } = opts;

  // ── Server-side limits (declared metadata — see header) ──
  if (!filename || typeof filename !== 'string') {
    throw httpError(400, 'filename is required', cid);
  }
  const safeFilename = sanitizeFilename(filename);
  const ext = extOf(safeFilename);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw httpError(400,
      'That file type isn\u2019t accepted. Please upload PDF, Word, Excel, image, or text files.',
      cid);
  }
  const sizeNum = Number(size);
  if (!Number.isFinite(sizeNum) || !Number.isInteger(sizeNum) || sizeNum <= 0) {
    throw httpError(400, 'size (bytes) is required', cid);
  }
  if (sizeNum > MAX_FILE_SIZE) {
    throw httpError(400, 'Files must be 50 MB or smaller.', cid);
  }

  // ── Item-belongs-to-case gate (optional association) ──
  if (itemId !== undefined && itemId !== null) {
    const idNum = Number(itemId);
    const map = Number.isInteger(idNum) && idNum > 0
      ? await _caseItemMap(db, cid, [idNum])
      : new Map();
    if (!map.has(idNum)) {
      // Foreign / unknown item id — same uniform wording as scope 404s.
      throw httpError(404, 'Not found', cid);
    }
  }

  // ── Upload-target ladder (shared with the public flow) ──
  // Case folder → auto-created folder → unsorted client-uploads folder; a
  // client always has a way to upload. Only a total failure (Dropbox
  // unreachable) still throws — route → 500 'Server error'.
  let link;
  try {
    ({ link } = await uploadTarget.issueClientUploadLink(db, {
      caseId: cid,
      filename: safeFilename,
    }));
  } catch (err) {
    if (err.code === 'CASE_NOT_FOUND') {
      // Scope passed above but the row vanished mid-request — uniform 404.
      throw httpError(404, 'Not found', cid);
    }
    err.portalCaseId = cid;
    throw err;
  }

  return { case_id: cid, link };
}

// ─────────────────────────────────────────────────────────────────────────────
// recordLanded (docs intake S3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One file of a batch landed in Dropbox — append it to the run's batch row
 * (services/clientUploadBatchService.landed). Same scope rule as every other
 * call here. The item association is resolved from the DB now (the name never
 * comes from the client); a foreign/unknown item_id is filed as general, the
 * completeUpload way — the bytes already landed, rejecting would only lose the
 * report.
 *
 * @param {object} opts  { batch, file: { name, item_id? }, comment? }
 * @returns {Promise<{case_id:string, accepted:boolean}|null>} null = out of scope.
 *   Throws .status 400 for a bad body.
 */
async function recordLanded(db, contactId, caseId, { batch, file, comment } = {}) {
  const caseRow = await _scopedCaseRow(db, contactId, caseId);
  if (!caseRow) return null;
  const cid = caseRow.case_id;

  if (!uploadBatches().isBatchKey(batch)) throw httpError(400, 'batch is required', cid);
  const name = file && typeof file === 'object' ? String(file.name ?? '').slice(0, MAX_UPLOAD_FILENAME) : '';
  if (!name.trim()) throw httpError(400, 'file.name is required', cid);

  let itemId = null;
  let itemName = null;
  const idNum = Number(file.item_id);
  if (file.item_id != null && Number.isInteger(idNum) && idNum > 0) {
    const map = await _caseItemMap(db, cid, [idNum]);
    if (map.has(idNum)) { itemId = idNum; itemName = map.get(idNum); }
  }

  const r = await uploadBatches().landed(db, {
    source: 'portal',
    batchKey: batch,
    caseId: cid,
    contactId,
    file: { name, item_id: itemId, item_name: itemName },
    comment: comment == null ? null : String(comment).slice(0, MAX_UPLOAD_COMMENT),
  });
  return { case_id: cid, accepted: !!r.accepted };
}

// ─────────────────────────────────────────────────────────────────────────────
// completeUpload + sendUploadNotifications
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate + resolve a completed upload batch. SPLIT from the side effects
 * so the route can mirror the public flow's respond-first sequencing:
 * route → completeUpload (scope + caps + resolution) → 200 →
 * sendUploadNotifications(ctx) fire-and-forget.
 *
 * files: array of { name, item_id? } (bare strings tolerated as { name }).
 * item_id entries that don't resolve to THIS case's docs-checklist items are
 * grouped as general ("Other documents") rather than rejected — the bytes
 * already landed in Dropbox at this point; failing the notification would
 * only lose the audit trail. Resolved item NAMES come from the DB, never
 * from the client.
 *
 * NO checkitem status mutation — see header (staff verdict).
 *
 * batch (docs intake S3, optional): the run's key from upload-landed; a valid
 * one rides the context so sendUploadNotifications closes the batch row. Absent
 * or malformed → null → the pre-S3 path exactly (old page builds; a notice is
 * never dropped over a bad key).
 *
 * @returns {Promise<object|null>} null = out of scope; else the
 *   notification context for sendUploadNotifications.
 */
async function completeUpload(db, contactId, caseId, { files, comment, batch } = {}) {
  const caseRow = await _scopedCaseRow(db, contactId, caseId);
  if (!caseRow) return null;
  const cid = caseRow.case_id;

  if (!Array.isArray(files) || !files.length) {
    throw httpError(400, 'files array is required', cid);
  }

  // Normalise ONCE before anything reaches the email or the log — same
  // caps as the public route; true count kept for the headline.
  const fileCount = files.length;
  const safeFiles = files.slice(0, MAX_UPLOAD_FILES).map(f => {
    if (f && typeof f === 'object') {
      const idNum = Number(f.item_id);
      return {
        name: String(f.name ?? '').slice(0, MAX_UPLOAD_FILENAME),
        item_id: Number.isInteger(idNum) && idNum > 0 ? idNum : null,
      };
    }
    return { name: String(f ?? '').slice(0, MAX_UPLOAD_FILENAME), item_id: null };
  });
  const omittedCount = fileCount - safeFiles.length;
  const safeComment = comment == null ? '' : String(comment).slice(0, MAX_UPLOAD_COMMENT);

  // Resolve item names for the batch (one query); foreign ids → null.
  const itemMap = await _caseItemMap(db, cid, safeFiles.map(f => f.item_id).filter(Boolean));
  for (const f of safeFiles) {
    f.item_name = f.item_id != null && itemMap.has(f.item_id) ? itemMap.get(f.item_id) : null;
    if (f.item_name === null) f.item_id = null;
  }

  // Uploader = the AUTHENTICATED contact (an improvement over the public
  // flow's Primary-contact guess — a Secondary spouse's upload is
  // attributed to the actual uploader).
  const [[uploader]] = await db.query(
    'SELECT contact_name FROM contacts WHERE contact_id = ?',
    [contactId]
  );

  return {
    case_id: cid,
    contact_id: contactId,
    clientName: uploader?.contact_name || 'Client',
    caseDisplay: caseRow.case_display,
    dropboxLink: (await require('./entityFolderService').caseFolderLink(db, cid)).link || '',   // the binding (the record, D3d-2; deferred require, convention)
    fileCount,
    omittedCount,
    files: safeFiles,             // [{ name, item_id, item_name }]
    comment: safeComment,
    batch: uploadBatches().isBatchKey(batch) ? batch : null,
  };
}

/**
 * The side effects for a validated batch, AFTER the 200 (public-route parity):
 * services/clientUploadCompletionService — the ONE post-upload phase both
 * upload pages share since 2026-11-19 (where the files went, what landed,
 * the reviewer's notice with per-file links + the Docs Needed block, the
 * `docs` case-log row, the unsorted task). Self-catching; the route's .catch
 * is a dead-man's brake only. Returns the service's result for tests.
 *
 * ctx.dropboxLink is no longer read (the service derives the folder itself);
 * it stays on the context for page-contract compatibility.
 *
 * ctx.batch (S3): close the batch row and complete ONCE on the landed list
 * merged with this one (clientUploadBatchService.finishByClient).
 */
async function sendUploadNotifications(db, ctx) {
  const { case_id, contact_id, clientName, fileCount, files, comment } = ctx;
  if (ctx.batch) {
    return uploadBatches().finishByClient(db, {
      source: 'portal',
      batchKey: ctx.batch,
      caseId: case_id,
      contactId: contact_id,
      clientName,
      files,
      fileCount,
      comment: comment || null,
    });
  }
  return require('./clientUploadCompletionService').completeClientUpload(db, {   // lazy (convention)
    source: 'portal',
    caseId: case_id,
    contactId: contact_id,
    clientName,
    files,
    fileCount,
    comment: comment || null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  listDocs,
  createUploadLink,
  recordLanded,
  completeUpload,
  sendUploadNotifications,
  // Limits — exported so the route/tests reference one source of truth.
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_FILENAME,
  MAX_UPLOAD_COMMENT,
  // Exposed for tests (repo pattern).
  _escapeHtml: escapeHtml,
  _sanitizeFilename: sanitizeFilename,
  // Exported (not just for tests) so the PUBLIC docReq route in
  // routes/api.checklists.js can apply the SAME extension rule against
  // ALLOWED_EXTENSIONS rather than forking a second copy of it.
  _extOf: extOf,
  _clientStatus: clientStatus,
};