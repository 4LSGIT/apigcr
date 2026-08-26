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
 * ── PROVIDER INTERFACE ────────────────────────────────────────────────────
 *   stat(db, externalId, opts?)             -> provider metadata object
 *   tempViewUrl(db, externalId, opts?)      -> { url, metadata }   (expiring)
 *   download(db, externalId, opts?)         -> { buffer, metadata }
 *   move(db, externalId, toPath, opts?)     -> provider result
 *   rename(db, externalId, newName, opts?)  -> provider result
 *   remove(db, externalId, opts?)           -> provider result
 *   ensureSharedLink(db, externalId, opts?) -> string (permanent URL)
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

const dropboxProvider = {
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
    return dropbox.movePath(db, { fromPath: externalId, toPath, ..._dbxOpts(opts) });
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
};

register('dropbox', dropboxProvider);

module.exports = {
  register,
  get,
  list,
  // exported for tests / direct reuse
  dropboxProvider,
};
