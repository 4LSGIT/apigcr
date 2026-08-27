// services/documentIngestService.js
//
/**
 * WRITE-TIME REGISTRATION — files WE put in Dropbox, registered as we put them
 * services/documentIngestService.js
 *
 * Documents S4. The sync engine (services/documentSyncService.js) discovers
 * files by walking Dropbox on a schedule, which means a file this app itself
 * just wrote is invisible to the registry for up to a delta interval — and,
 * worse, arrives with NO attribution beyond whatever its path happens to
 * support. This module closes that: at the moment a write is known good, the
 * file is registered from the metadata already in hand and linked to the
 * context the WRITER knew and the path never will.
 *
 * Pool-first like every other service here: `db` first, no Express, no req/res.
 * It sits above documentService (rows) and dropboxService (bytes) and owns
 * exactly one decision — see RELATION SEMANTICS.
 *
 * ── RELATION SEMANTICS: THE WHOLE POINT OF THIS FILE ──────────────────────
 * documentService.RELATION_PATH ('path') means, precisely, "this link reflects
 * the file's CURRENT LOCATION under the case's cached folder". It is OWNED by
 * the reconcilers: documentService.reconcilePathLinks DELETEs
 *
 *     link_type = 'case' AND relation = 'path' AND created_by IS NULL
 *
 * whenever a file moves somewhere the link no longer supports. That is correct
 * for a link DERIVED from a path, and catastrophic for a link derived from
 * knowledge.
 *
 * A write-time link is derived from knowledge. When a client uploads against
 * case X and the ladder drops the file in Unsorted because case X has no
 * working folder, "this belongs to case X" is TRUE and the path does not say
 * so. Stamped 'path', the next reconcile would look at the file sitting in
 * Unsorted, find no case-folder match, and retract the one correct statement
 * anybody had made about it. So:
 *
 *     RELATION_UPLOAD ('upload')  INTENT.  The writer knew whose file this is.
 *                                 created_by NULL for client/automation
 *                                 writes, the acting user for staff ones.
 *                                 Reconcilers and the attribution sweep touch
 *                                 only 'path' rows, so this survives every
 *                                 later refiling BY CONSTRUCTION rather than
 *                                 by anyone remembering to special-case it.
 *
 *     RELATION_PATH   ('path')    LOCATION. Written ONLY when the file landed
 *                                 directly under that case's cached folder,
 *                                 where 'path' is simply the truth and the
 *                                 engine should own it — a staffer who later
 *                                 drags the file to another case gets the
 *                                 normal retract-and-relink, which is right.
 *
 * Picked PER WRITE by comparing the landing path against case_folder_cache
 * (see _relationFor). When the two coexist — an upload-linked file that staff
 * later move INTO the case folder — the sweep adds the 'path' row alongside
 * and the unique key (document_id, link_type, link_id) collapses them to one
 * if it is the same case. Nothing to clean up.
 *
 * CONTACT LINKS ARE ALWAYS 'upload'. There is no folder convention for
 * contacts, so no path can ever support a contact link; reconcilePathLinks
 * scopes itself to link_type='case' for the same reason.
 *
 * ── EMISSIONS STAY ON ─────────────────────────────────────────────────────
 * S2's backfill passes { emit:false } because 150,000 files that have sat in
 * Dropbox since 2019 are not news. A single file written SECONDS AGO by a flow
 * that knew what it was is the opposite: it is the most genuine document.*
 * signal this system produces. Every registration here emits, and S5's
 * classification triggers are the intended consumer.
 *
 * ── case_folder_cache.path_display IS NULL, ALWAYS. USE path_lower ────────
 * The column exists and refreshCaseFolderCache writes it — from
 * `meta.path_display` on a sharing/get_shared_link_metadata response, which
 * DROPBOX DOES NOT SEND for a shared link. Measured 2026-08-27: 1,005 cached
 * rows, 992 with path_lower, ZERO with path_display. So every prefix test here
 * is lowercase-on-lowercase, which is also what dropboxService.resolveLocation
 * has always returned (`normalizePath(meta.path_lower)`) and therefore what
 * every upload destination in this app has always been built from. Dropbox
 * resolves paths case-insensitively, so a lowercased PARENT lands in the real
 * folder; the filename component is passed separately and keeps its case.
 *
 * Exports:
 *   registerWritten(db, opts)       -> { document, links }        THROWS
 *   registerWrittenSafe(db, opts)   -> { ok, document, links }    NEVER THROWS
 *   registerLandedInFolder(db, o)   -> { registered, documents }  NEVER THROWS
 *   RELATION_UPLOAD
 */

'use strict';

const documents = require('./documentService');

/** documents.source for everything this module registers. */
const SOURCE = 'dropbox';

/**
 * The relation for a link built from KNOWN CONTEXT rather than from a path.
 * See the RELATION SEMANTICS block — this constant is the load-bearing half of
 * it, and the reconcilers' `relation = 'path'` predicate is the other half.
 */
const RELATION_UPLOAD = 'upload';

/**
 * How far back registerLandedInFolder will look for "files from this batch".
 *
 * Pinned to dropboxService.getTemporaryUploadLink's default `duration` (7200s)
 * because that IS the window: a link older than its validity cannot have
 * produced an upload, and one issued inside it can have produced one at any
 * point up to now. Widening this would start claiming files from an earlier
 * batch; narrowing it would miss a client who picked their files, went to
 * lunch, and came back.
 */
const LANDING_WINDOW_MS = 7200 * 1000;

/**
 * Cap on entries considered from one folder listing.
 *
 * A case's Client Uploads folder holds tens of files; the Unsorted bin holds
 * whatever has accumulated since someone last swept it, which is unbounded.
 * The window filter does the real work — this is the guard against a listing
 * that returns thousands and turns one client's upload notification into
 * thousands of upserts inside a post-200 side-effect phase.
 */
const LANDING_MAX_ENTRIES = 200;

// ─────────────────────────────────────────────────────────────
// Relation choice
// ─────────────────────────────────────────────────────────────

/** Is `pathLower` strictly under `folderLower`? Segment-boundary safe. */
function _under(pathLower, folderLower) {
  if (!pathLower || !folderLower) return false;
  return String(pathLower).startsWith(String(folderLower) + '/');
}

/**
 * The relation for ONE link, decided against the file's landing path.
 *
 * 'path' only when the cache can PROVE the file sits under that case's folder.
 * Everything else — contact links, an uncached case, a resolve that failed, a
 * file in Unsorted — is 'upload'. Fails toward 'upload' deliberately: an
 * upload-link that should have been a path-link is redundant (the sweep adds
 * the path row and the unique key dedupes), while a path-link that should have
 * been an upload-link is DESTROYED by the next reconcile. The two errors are
 * not symmetric, so the default is not either.
 *
 * @param {object} db
 * @param {string} linkType
 * @param {string|number} linkId
 * @param {string|null} pathLower  the file's landing path_lower
 * @returns {Promise<string>} 'path' | 'upload'
 */
async function _relationFor(db, linkType, linkId, pathLower) {
  if (linkType !== 'case' || !pathLower) return RELATION_UPLOAD;
  try {
    const [[row]] = await db.query(
      'SELECT path_lower FROM case_folder_cache WHERE case_id = ? LIMIT 1',
      [String(linkId)],
    );
    const folder = row && row.path_lower ? String(row.path_lower) : null;
    return _under(String(pathLower).toLowerCase(), folder) ? documents.RELATION_PATH : RELATION_UPLOAD;
  } catch (err) {
    // A cache read that failed is not evidence of location. Same asymmetry as
    // above: guess 'upload' and lose nothing, guess 'path' and lose the link.
    console.warn(`[DOC INGEST] case_folder_cache lookup failed for ${linkId}: ${err.message}`);
    return RELATION_UPLOAD;
  }
}

// ─────────────────────────────────────────────────────────────
// registerWritten
// ─────────────────────────────────────────────────────────────

/** Normalize the caller's link list, dropping empties. */
function _normalizeLinks(links) {
  const out = [];
  for (const l of Array.isArray(links) ? links : []) {
    if (!l) continue;
    const type = l.type || l.link_type;
    const id   = l.id != null ? l.id : l.link_id;
    if (!type || id == null || id === '') continue;
    out.push({ type: String(type), id: String(id) });
  }
  return out;
}

/**
 * Register one just-written file and link it to what the writer knew.
 *
 * ── PREFER `entry` OVER `path` ────────────────────────────────────────────
 * Dropbox's write endpoints RETURN the file's FileMetadata: files/upload
 * answers with it directly, files/save_url carries it on the completed job,
 * and a temporary-upload-link POST hands it to whoever sent the bytes. That
 * object is exactly the shape upsertFromEntry wants, and it is AUTHORITATIVE
 * in a way a requested path is not — every one of those writes runs
 * `autorename:true`, so the path we asked for is a request and `name` may have
 * come back as "statement (1).pdf". Pass `entry` wherever the call site has
 * one; `path` exists for the writers that genuinely do not (and costs a stat).
 *
 * A file registered here and then seen again by the next delta is a plain
 * no-op upsert — same (source, external_id), same columns, MEANINGFUL_KEYS
 * unchanged, so not even a document.updated. That is by design; there is
 * nothing to special-case.
 *
 * @param {object} db
 * @param {object} o
 * @param {object} [o.entry]        provider FileMetadata (preferred)
 * @param {string} [o.path]         path or "id:" handle to stat when no entry
 * @param {string} [o.source]       documents.source, default 'dropbox'
 * @param {Array}  [o.links]        [{ type, id }] — case/contact context
 * @param {number} [o.createdBy]    acting user id, or null for client/automation
 * @param {string} [o.eventSource]  envelope `source` ('upload', 'automation', …)
 * @param {number} [o.credentialId]
 * @returns {Promise<{document: object, links: Array}>}
 * @throws on a stat failure, a folder, or a malformed entry
 */
async function registerWritten(db, o = {}) {
  const {
    entry: given, path, source = SOURCE, links, createdBy = null,
    eventSource = 'upload', credentialId,
  } = o;

  let entry = given;
  if (!entry) {
    if (!path) throw new Error('documentIngestService.registerWritten requires entry or path');
    const sources  = require('./documentSourceService');   // deferred (convention)
    const provider = sources.get(source);
    entry = await provider.stat(db, path, credentialId != null ? { credentialId } : {});
  }

  // Folder guard, same rule and same reason as POST /api/documents/register:
  // a folder registers as a row with no size/rev/content_hash and pollutes
  // every list. Dropbox-shaped ('.tag') — the one provider specific here.
  if (entry && entry['.tag'] === 'folder') {
    throw new Error('documentIngestService: refusing to register a folder');
  }

  const { row } = await documents.upsertFromEntry(db, source, entry, {
    emit: true,                       // WRITE-TIME EVENTS ARE REAL — see header
    eventSource,
    actorUserId: createdBy,
  });

  const pathLower = row && row.path_lower ? String(row.path_lower) : null;
  const written = [];
  for (const l of _normalizeLinks(links)) {
    const relation = await _relationFor(db, l.type, l.id, pathLower);
    const out = await documents.link(db, row.id, l.type, l.id, {
      relation,
      createdBy,
      eventSource,
    });
    written.push({ link_type: l.type, link_id: l.id, relation, created: out.created });
  }

  return { document: row, links: written };
}

/**
 * registerWritten that CANNOT fail its caller.
 *
 * Every write path this module hooks has already put the bytes in Dropbox by
 * the time it calls here. Losing the registration costs a delay — the sync's
 * delta picks the file up on its next pass and the attribution sweep links it
 * from the path — while THROWING costs the caller's response, its
 * notification, or its whole workflow step for a bookkeeping failure. So
 * every hook in the app calls this, and the throwing twin exists for the two
 * routes where registration IS the request and a failure must be a 4xx/5xx.
 *
 * @returns {Promise<{ok: boolean, document?: object, links?: Array, error?: string}>}
 */
async function registerWrittenSafe(db, o = {}) {
  try {
    const out = await registerWritten(db, o);
    return { ok: true, ...out };
  } catch (err) {
    const where = o && (o.path || (o.entry && (o.entry.path_display || o.entry.id)) || '(unknown)');
    console.error(`[DOC INGEST] registration failed for ${where}: ${err && err.message}`);
    return { ok: false, error: err && err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// registerLandedInFolder — the CLIENT-UPLOAD shape
// ─────────────────────────────────────────────────────────────

/**
 * Register whatever a client's batch just put in a folder.
 *
 * ── WHY THIS IS NOT "STAT THE REPORTED PATH" ──────────────────────────────
 * The brief for S4 says to verify the client's reported path before trusting
 * it. THERE IS NO REPORTED PATH. Both client completion routes take FILENAMES
 * and nothing else:
 *
 *   POST /api/public/upload-complete           { case_id, files: string[], … }
 *   POST /api/portal/…/docs/upload-complete    { files: [{name, item_id?}], … }
 *
 * and uploadTargetService.issueClientUploadLink discards the path it composed
 * on the case rung, returning only { case_id, link, placement }. Worse, the
 * names are stale by CONSTRUCTION: every temporary upload link commits with
 * `mode:'add', autorename:true`, so a second "statement.pdf" lands as
 * "statement (1).pdf" and the reported name matches nothing on disk.
 *
 * So the client's input is not verified here — it is NOT USED here. The
 * destination is re-derived server-side (the callers already do this, for the
 * notification wording, via uploadTargetService.inspectUploadDestination), the
 * folder is listed, and entries modified inside the link-validity window are
 * registered. Nothing an attacker types can steer that: the folder comes from
 * the case row, and the filter is a timestamp.
 *
 * The cost is over-capture — a staffer who dropped a file into the SAME case's
 * folder in the same two hours gets it registered and linked too. That file is
 * that case's file, so the link is true; it would have been made by the sweep
 * anyway, just later. Under-capture (missing an autorenamed file entirely) is
 * the error that would actually lose data, and this shape cannot make it.
 *
 * NEVER THROWS. Called from post-200 side-effect phases.
 *
 * @param {object} db
 * @param {object} o
 * @param {string} o.folderPath      folder to list (path or shared-link-resolved)
 * @param {string} [o.sharedLink]    …or the folder's shared link
 * @param {string} [o.subfolder]     descend into this under the resolved folder
 * @param {Array}  o.links           [{ type, id }] context for every file found
 * @param {number} [o.sinceMs]       window, default LANDING_WINDOW_MS
 * @param {number} [o.createdBy]     null for client uploads
 * @param {string} [o.eventSource]
 * @returns {Promise<{registered: number, scanned: number, documents: Array}>}
 */
async function registerLandedInFolder(db, o = {}) {
  const {
    folderPath, sharedLink, subfolder, links, createdBy = null,
    sinceMs = LANDING_WINDOW_MS, eventSource = 'upload', credentialId,
  } = o;

  const out = { registered: 0, scanned: 0, documents: [] };

  try {
    const dropbox = require('./dropboxService');           // deferred (convention)
    const credId  = await dropbox._resolveCredential(db, credentialId != null ? { credentialId } : {});

    let listPath = folderPath;
    if (listPath == null && sharedLink) {
      listPath = await dropbox.resolveLocation(db, credId, { sharedLink, expectFolder: true });
    }
    if (listPath == null) throw new Error('registerLandedInFolder requires folderPath or sharedLink');
    if (subfolder) listPath = dropbox.joinPath(listPath, subfolder);

    const listing = await dropbox.listFolder(db, {
      path: listPath, credentialId: credId, maxEntries: LANDING_MAX_ENTRIES,
    });

    const cutoff = Date.now() - Math.max(0, Number(sinceMs) || 0);
    const entries = (listing && listing.entries) || [];
    out.scanned = entries.length;

    for (const e of entries) {
      if (!e || e['.tag'] === 'folder') continue;
      const t = Date.parse(e.server_modified || e.client_modified || '');
      // A file with no usable timestamp is NOT claimed. It could be anything
      // in a shared bin, and the sweep will file it from its path if it has a
      // case folder to sit under.
      if (!Number.isFinite(t) || t < cutoff) continue;

      const r = await registerWrittenSafe(db, {
        entry: e, links, createdBy, eventSource, credentialId: credId,
      });
      if (r.ok) {
        out.registered++;
        out.documents.push(r.document);
      }
    }
  } catch (err) {
    // The files are in Dropbox either way. Log and let the delta catch them.
    console.error(`[DOC INGEST] folder registration failed: ${err && err.message}`);
  }

  return out;
}

module.exports = {
  registerWritten,
  registerWrittenSafe,
  registerLandedInFolder,
  RELATION_UPLOAD,
  SOURCE,
  LANDING_WINDOW_MS,
  LANDING_MAX_ENTRIES,
  // exported for tests / reuse
  _relationFor,
  _under,
  _normalizeLinks,
};
