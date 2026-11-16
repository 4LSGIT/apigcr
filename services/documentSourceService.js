// services/documentSourceService.js
//
/**
 * Document Source Registry — the storage-provider seam for the documents feature
 * services/documentSourceService.js
 *
 * services/documentService.js owns ROWS and never talks to a storage backend.
 * This module owns the other half: a name → provider map, so `documents.source`
 * ('dropbox' today) selects the code that can actually stat/fetch/move the bytes.
 *
 * Deliberately thin. There is no base class, no lifecycle, no caching — a
 * provider is a plain object of async functions and the built-in Dropbox one
 * is pure delegation to services/dropboxService.js.
 *
 * ── THE EXTERNAL-ID CONTRACT ──────────────────────────────────────────────
 * `externalId` is whatever handle the provider considers STABLE ACROSS MOVE
 * AND RENAME. For Dropbox that is the "id:…" handle (FileMetadata.id), which
 * is exactly why the registry stores it rather than a path: firm staff move
 * and rename freely (Active → Closed at case close being the routine one) and
 * a path-keyed registry would lose every row the moment they did.
 *
 * dropboxService.normalizePath passes "id:" / "rev:" / "ns:" through
 * untouched, so every location-taking dropboxService function accepts an
 * externalId in its `path` slot with no special-casing here.
 *
 * ── PROVIDER INTERFACE (storage-seam D1a; ref/DOCUMENTS_V3_DESIGN.md §4) ──
 * Reads and row-level operations (Documents S1):
 *   stat(db, externalId, opts?)             -> provider metadata object
 *   tempViewUrl(db, externalId, opts?)      -> { url, metadata }   (expiring)
 *   download(db, externalId, opts?)         -> { buffer, metadata }
 *   move(db, externalId, toPath, opts?)     -> provider result
 *   rename(db, externalId, newName, opts?)  -> provider result
 *   remove(db, externalId, opts?)           -> provider result
 *   ensureSharedLink(db, externalId, opts?) -> string (permanent human URL)
 *
 * Writes and folders (D1a — the ops the writers in ref/DOCUMENTS_V3_DESIGN.md
 * §1 will be rerouted onto in D1b–f; NO writer calls them yet):
 *   upload(db, dest, content, opts?)        -> provider entry (post-autorename truth)
 *       dest: { path }                                 a full destination path
 *           | { folder: externalId, name, subfolder? } inside a folder, by its stable handle
 *           | { humanLink, name, subfolder? }          inside the folder a human link opens
 *   ensureFolder(db, dest, opts?)           -> { externalId, path, existed, subfolders, humanLink }
 *       dest: { path } | { parent: externalId, name };  opts: { subfolders?: [names], humanLink?: bool }
 *       Idempotent: an existing folder is adopted, never duplicated.
 *   directUpload(db, dest, opts?)           -> { url, method, headers, path, expiresInSec }
 *       dest: { path, filename } | { folder: externalId, filename, subfolder? }
 *           | { humanLink, filename, subfolder? };  opts: { durationSec? }
 *       A pre-authorized target the BROWSER sends the bytes to; the app never
 *       sees them. The `path` is the destination the commit step verifies.
 *   listChanges(db, { root, cursor?, limit? }, opts?) -> { entries, cursor, hasMore }
 *       One page of a resumable listing: no cursor = the first page of `root`
 *       (recursive), a cursor = the page after it — paging through the initial
 *       listing and delta-ing from it are the SAME call, which is the sync
 *       engine's "one cursor, two questions" (documentSyncService header).
 *       Entries are the provider's own shape until D4 normalizes them with the
 *       attribution strategies; the predicates below classify its errors.
 *   isCursorReset(err) / isNotFound(err) / isTransient(err) -> boolean
 *
 * Per-request context and paths (D1b — learned from the first reroute):
 *   context(db, opts?)                      -> opts' to pass to every later call
 *       Resolves whatever the provider resolves per call ONCE (Dropbox: the
 *       credential id — one app_settings read instead of one per operation,
 *       which is what every writer did by hand with _resolveCredential).
 *   resolveHumanLink(db, humanLink, { expectFolder? }, opts?) -> path
 *       The folder a human link opens, as a provider path. Class A only; it
 *       goes away for the writers once the binding row carries the handle (D3).
 *   joinPath(base, ...segments)             -> path   (pure; the provider's path syntax)
 *   list(db, dest, { recursive?, max? }, opts?) -> { entries, count, truncated }
 *       A folder's children (one level, or the whole subtree with recursive),
 *       bounded by max — a bounded READ for a UI picker or a name comparison,
 *       not the sync engine's resumable listChanges. dest: { path } |
 *       { folder: externalId } | { humanLink }. Entries are the provider's own
 *       shape (D1d2; normalized with the attribution strategies in D4).
 *   move(db, externalId, toPath, { autorename? }) — autorename lets the provider
 *       pick "name (1)" on a collision instead of failing (the refile's contract).
 *   ensureFolder's `externalId` is the handle when the provider learned it for
 *   free (Dropbox: a folder it just CREATED) or when opts.handle === true (one
 *   get_metadata more on an adopted folder); otherwise null. `path` is the
 *   normalized DESTINATION path, never a case-corrected display path — the
 *   writers compose the upload path from it and the provider is case-insensitive.
 *
 * Declarations (data, not calls):
 *   capabilities  frozen { humanManaged, directUpload, humanLink, listChanges, changeNotify }
 *                 — the app CHECKS these; it never assumes a provider can do a thing.
 *   nameRules     frozen { caseSensitive, illegal, trimSegmentEnd, leadingSpaces,
 *                 maxSegmentChars, duplicateNames } + validateName(name) -> { ok, reason? }
 *                 — what a name may be on this provider, as the writers already
 *                 enforce it (the e-sign convention's ILLEGAL_IN_NAME, caseService's
 *                 _trimPathSegments). D4 wires validateName into template save.
 *
 * `opts` is provider-specific passthrough; for Dropbox it carries
 * { credentialId } and nothing else.
 *
 * GCS and Google Drive providers are FUTURE work and are deliberately NOT
 * stubbed here — an empty stub that throws at call time is strictly worse
 * than get() throwing "unknown document source" at registry time.
 */

'use strict';

const dropbox = require('./dropboxService');

// ─────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────

const providers = new Map();

/**
 * Register (or replace) a provider under a source name.
 * @param {string} source   matches documents.source
 * @param {object} provider see PROVIDER INTERFACE above
 */
function register(source, provider) {
  if (!source || typeof source !== 'string') {
    throw new Error('documentSourceService.register: source is required');
  }
  if (!provider || typeof provider !== 'object') {
    throw new Error(`documentSourceService.register: provider for '${source}' must be an object`);
  }
  providers.set(source, provider);
  return provider;
}

/**
 * Look up a provider. Throws (rather than returning undefined) so a bad
 * `source` surfaces at the call site instead of as a TypeError three frames
 * deeper.
 * @param {string} source
 * @returns {object} provider
 */
function get(source) {
  const p = providers.get(source);
  if (!p) throw new Error(`unknown document source '${source}'`);
  return p;
}

/** Registered source names (for admin/debug surfaces). */
function list() {
  return [...providers.keys()];
}

// ─────────────────────────────────────────────────────────────
// Built-in: dropbox
// ─────────────────────────────────────────────────────────────

/** Only { credentialId } is meaningful downstream; keep the shape explicit. */
function _dbxOpts(opts = {}) {
  return opts.credentialId != null ? { credentialId: opts.credentialId } : {};
}

/**
 * The real path of a folder handle. Every location-taking dropboxService
 * function accepts "id:…" for the item ITSELF, but a destination INSIDE a
 * folder needs the folder's path first — the same resolve-then-join the
 * writers do today with a shared link (resolveLocation + joinPath).
 */
async function _folderPath(db, externalId, opts) {
  const meta = await dropboxProvider.stat(db, externalId, opts);
  if (!meta || meta['.tag'] !== 'folder') {
    throw new Error(`document storage: ${externalId} is not a folder`);
  }
  const p = meta.path_display || meta.path_lower;
  if (!p) throw new Error(`document storage: ${externalId} has no resolvable path (shared/team content?)`);
  return p;
}

function _needName(dest, field) {
  const v = dest && dest[field];
  if (!v || typeof v !== 'string') throw new Error(`document storage: ${field} is required`);
  if (v.includes('/')) throw new Error(`document storage: ${field} must not contain "/"`);
  return v;
}

/** The e-sign convention every writer sanitizes with (filePlacementService, uploadTargetService, esignFilingService). */
// eslint-disable-next-line no-control-regex
const ILLEGAL_IN_NAME = /[/\\:*?"<>|\u0000-\u001f]/;
/** caseService._trimPathSegments: a segment may not end in '.' or ' ' (Windows drops both). */
const TRIM_SEGMENT_END = /[. ]+$/;
const MAX_SEGMENT_CHARS = 255;

const dropboxNameRules = Object.freeze({
  caseSensitive: false,              // path_lower is the identity; "Docket" and "docket" collide
  illegal: ILLEGAL_IN_NAME.source,
  trimSegmentEnd: TRIM_SEGMENT_END.source,
  leadingSpaces: 'preserved',        // "  Active Cases" is the firm's sort order — never trimmed
  maxSegmentChars: MAX_SEGMENT_CHARS,
  duplicateNames: 'autorename',      // a second "x.pdf" lands as "x (1).pdf"
  /** @returns {{ok: boolean, reason?: string}} */
  validateName(name) {
    if (typeof name !== 'string' || name === '') return { ok: false, reason: 'empty' };
    if (ILLEGAL_IN_NAME.test(name)) return { ok: false, reason: 'illegal character' };
    if (TRIM_SEGMENT_END.test(name)) return { ok: false, reason: 'ends with a period or a space' };
    if (name.length > MAX_SEGMENT_CHARS) return { ok: false, reason: `longer than ${MAX_SEGMENT_CHARS} characters` };
    return { ok: true };
  },
});

const dropboxProvider = {
  capabilities: Object.freeze({
    humanManaged: true,    // staff live in Dropbox's own UI: the registry MIRRORS it (design §2 class A)
    directUpload: true,    // files/get_temporary_upload_link
    humanLink: true,       // shared links
    listChanges: true,     // files/list_folder + /continue, one cursor
    changeNotify: false,   // no webhook wired; the tick polls the cursor (the baseline)
  }),
  nameRules: dropboxNameRules,

  async stat(db, externalId, opts = {}) {
    return dropbox.getMetadata(db, { path: externalId, ..._dbxOpts(opts) });
  },

  /**
   * Short-lived direct link (~4h). NOT persisted anywhere — that is the whole
   * point of preferring it over a shared link for viewing.
   */
  async tempViewUrl(db, externalId, opts = {}) {
    const r = await dropbox.getTemporaryLink(db, { path: externalId, ..._dbxOpts(opts) });
    return { url: r.link, metadata: r.metadata || null };
  },

  async download(db, externalId, opts = {}) {
    return dropbox.downloadFile(db, { path: externalId, ..._dbxOpts(opts) });
  },

  async move(db, externalId, toPath, opts = {}) {
    return dropbox.movePath(db, {
      fromPath: externalId, toPath,
      ...(opts.autorename === true ? { autorename: true } : {}),
      ..._dbxOpts(opts),
    });
  },

  /**
   * Rename in place.
   *
   * NOT a delegation to dropboxService.renamePath: that function derives the
   * parent folder with `current.lastIndexOf('/')`, which on an "id:" handle
   * (no slash → index -1) silently chops the LAST CHARACTER OFF THE ID and
   * builds "id:<truncated>/<newName>". Dropbox rejects that with
   * path/not_found — loud, not destructive, but useless. Verified live
   * 2026-08-26; see the S1 report.
   *
   * So: resolve the handle to its real path first, compose the sibling path
   * from path_display (leading/embedded spaces intact — never trim), and move.
   */
  async rename(db, externalId, newName, opts = {}) {
    if (!newName || typeof newName !== 'string') {
      throw new Error('document rename requires newName');
    }
    if (newName.includes('/')) {
      throw new Error('document rename: newName must not contain "/" — use move to relocate');
    }

    const meta = await dropboxProvider.stat(db, externalId, opts);
    const current = meta && (meta.path_display || meta.path_lower);
    if (!current) {
      throw new Error(`document rename: ${externalId} has no resolvable path (shared/team content?)`);
    }

    const idx = current.lastIndexOf('/');
    if (idx < 0) throw new Error(`document rename: unexpected path shape for ${externalId}`);
    const parent = current.slice(0, idx); // '' when the item sits at root

    return dropbox.movePath(db, {
      fromPath: externalId,
      toPath: `${parent}/${newName}`,
      ..._dbxOpts(opts),
    });
  },

  async remove(db, externalId, opts = {}) {
    return dropbox.deletePath(db, { path: externalId, ..._dbxOpts(opts) });
  },

  /** Permanent public link (get-or-create). Returns the URL string. */
  async ensureSharedLink(db, externalId, opts = {}) {
    return dropbox.getOrCreateSharedLink(db, { path: externalId, ..._dbxOpts(opts) });
  },

  // ── D1a: writes and folders ──────────────────────────────────────────────

  /**
   * Put bytes. Returns files/upload's metadata — the post-autorename truth
   * the registry is written from (documentIngestService.registerWritten takes
   * it as `entry`). mode 'add' + autorename, exactly as every writer uploads.
   */
  async upload(db, dest = {}, content, opts = {}) {
    if (content == null) throw new Error('document storage: upload requires content');
    const common = { content, mode: 'add', autorename: true, ..._dbxOpts(opts) };
    if (dest.path) {
      if (dest.name || dest.folder || dest.humanLink) throw new Error('document storage: give path OR a folder + name, not both');
      return dropbox.uploadFile(db, { path: dest.path, ...common });
    }
    const name = _needName(dest, 'name');
    if (dest.humanLink) {
      return dropbox.uploadFile(db, { sharedLink: dest.humanLink, filename: name, subfolder: dest.subfolder, ...common });
    }
    if (!dest.folder) throw new Error('document storage: upload needs path, folder or humanLink');
    const folder = await _folderPath(db, dest.folder, opts);
    return dropbox.uploadFile(db, { path: dropbox.joinPath(folder, dest.subfolder, name), ...common });
  },

  /**
   * A folder that exists when this returns, with its stable handle. Creating
   * is idempotent on the provider (create_folder_v2 conflict = adopt); the
   * handle costs one get_metadata because the create reply carries none for
   * an adopted folder.
   */
  async ensureFolder(db, dest = {}, opts = {}) {
    let path;
    if (dest.path) {
      if (dest.parent || dest.name) throw new Error('document storage: give path OR parent + name, not both');
      path = dropbox.joinPath(dest.path);   // = normalizePath; joinPath is the one helper every writer's test mock carries
    } else {
      if (!dest.parent) throw new Error('document storage: ensureFolder needs path or parent + name');
      const name = _needName(dest, 'name');
      path = dropbox.joinPath(await _folderPath(db, dest.parent, opts), name);
    }
    if (!path) throw new Error('document storage: ensureFolder refuses the root');
    const subfolders = Array.isArray(opts.subfolders) ? opts.subfolders : [];
    const plain = !subfolders.length && opts.humanLink !== true;
    // The plain case is files/create_folder_v2 alone — the exact call the
    // placement ladder makes for a case subfolder — and its reply carries the
    // handle when the folder was created.
    const made = plain
      ? await dropbox.createFolder(db, { path, ..._dbxOpts(opts) })
      : await dropbox.createFolderWithOptions(db, { path, subfolders, shareLink: opts.humanLink === true, ..._dbxOpts(opts) });
    let externalId = (made.metadata && made.metadata.id) || null;
    if (!externalId && opts.handle === true) {
      externalId = (await dropbox.getMetadata(db, { path, ..._dbxOpts(opts) })).id;
    }
    return {
      externalId,
      path: made.path,
      existed: made.existed,
      subfolders: made.subfolders_created || [],
      humanLink: made.shared_link || null,
    };
  },

  /**
   * A pre-authorized upload target for the browser (files/get_temporary_upload_link):
   * POST the bytes as the body. The app never handles them; the commit step
   * stats what landed at `path`.
   */
  async directUpload(db, dest = {}, opts = {}) {
    const filename = _needName(dest, 'filename');
    const duration = Number(opts.durationSec) > 0 ? Number(opts.durationSec) : undefined;
    const common = { filename, ...(duration ? { duration } : {}), ..._dbxOpts(opts) };
    let r;
    if (dest.humanLink) {
      r = await dropbox.getTemporaryUploadLink(db, { sharedLink: dest.humanLink, subfolder: dest.subfolder, ...common });
    } else if (dest.folder) {
      const folder = await _folderPath(db, dest.folder, opts);
      r = await dropbox.getTemporaryUploadLink(db, { path: dropbox.joinPath(folder, dest.subfolder), ...common });
    } else if (dest.path) {
      r = await dropbox.getTemporaryUploadLink(db, { path: dropbox.joinPath(dest.path, dest.subfolder), ...common });
    } else {
      throw new Error('document storage: directUpload needs path, folder or humanLink');
    }
    return {
      url: r.link,
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      path: r.path,
      expiresInSec: duration || 7200,     // dropboxService.getTemporaryUploadLink's default
    };
  },

  /** One page of the resumable listing; the cursor is the only state between pages. */
  async listChanges(db, { root, cursor, limit } = {}, opts = {}) {
    const page = cursor
      ? await dropbox.listFolderContinue(db, { cursor, ..._dbxOpts(opts) })
      : await (() => {
          if (root == null) throw new Error('document storage: listChanges needs root or cursor');
          return dropbox.listFolderPage(db, {
            path: root, recursive: true, ...(Number(limit) > 0 ? { limit: Number(limit) } : {}), ..._dbxOpts(opts),
          });
        })();
    return { entries: page.entries || [], cursor: page.cursor, hasMore: Boolean(page.has_more) };
  },

  /** One credential read for a whole operation; every writer did this by hand. */
  async context(db, opts = {}) {
    return { credentialId: await dropbox._resolveCredential(db, _dbxOpts(opts)) };
  },

  async resolveHumanLink(db, humanLink, { expectFolder = false } = {}, opts = {}) {
    if (!humanLink || typeof humanLink !== 'string') throw new Error('document storage: resolveHumanLink requires humanLink');
    const credentialId = opts.credentialId != null
      ? opts.credentialId
      : await dropbox._resolveCredential(db, {});
    return dropbox.resolveLocation(db, credentialId, { sharedLink: humanLink, expectFolder });
  },

  joinPath: dropbox.joinPath,

  /** A bounded read of a folder's children — the exact files/list_folder call the filers make. */
  async list(db, dest = {}, { recursive, max } = {}, opts = {}) {
    const bound = {
      ...(recursive === true ? { recursive: true } : {}),
      ...(Number(max) > 0 ? { maxEntries: Number(max) } : {}),
      ..._dbxOpts(opts),
    };
    if (dest.humanLink) return dropbox.listFolder(db, { sharedLink: dest.humanLink, ...bound });
    if (dest.folder) return dropbox.listFolder(db, { path: await _folderPath(db, dest.folder, opts), ...bound });
    if (dest.path == null) throw new Error('document storage: list needs path, folder or humanLink');
    return dropbox.listFolder(db, { path: dest.path, ...bound });
  },

  isCursorReset: (err) => dropbox.isCursorResetError(err),
  isNotFound:    (err) => dropbox.isPathNotFoundError(err),
  isTransient:   (err) => dropbox.isTransientError(err),
};

register('dropbox', dropboxProvider);

module.exports = {
  register,
  get,
  list,
  // exported for tests / direct reuse
  dropboxProvider,
  dropboxNameRules,
};
